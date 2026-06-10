import { createWriteStream, readFileSync, type WriteStream } from 'fs'
import { once } from 'events'
import type { BackupRequest, CellValue, RestoreRequest, RestoreResult, TransferResult } from '@shared/types'
import { getDriver } from '../db/connectionManager'
import { isCommentOnly, splitStatements } from '../db/sqlSplit'
import { finishJob, isCancelled, reportProgress } from './jobs'

const DATA_BATCH = 1000
const INSERT_ROWS_PER_STMT = 100

function sqlLiteral(v: CellValue): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'object' && '__type' in v) {
    return `X'${Buffer.from(v.base64, 'base64').toString('hex')}'`
  }
  return `'${String(v).replace(/'/g, "''")}'`
}

async function write(stream: WriteStream, chunk: string): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, 'drain')
  }
}

export async function runBackup(req: BackupRequest): Promise<TransferResult> {
  const start = Date.now()
  const driver = getDriver(req.profileId)
  const q = driver.quoteIdent.bind(driver)
  const dbType = driver.profile.dbType
  const isMySql = dbType === 'mysql' || dbType === 'mariadb'
  // PG 的表名可能带 schema 前缀，需分段引用
  const qt = (name: string): string => {
    if (dbType === 'postgresql' && name.includes('.')) {
      const i = name.indexOf('.')
      return `${q(name.slice(0, i))}.${q(name.slice(i + 1))}`
    }
    return q(name)
  }

  const objects = await driver.listObjects(req.database)
  const allTables = objects.filter((o) => o.objectType === 'table').map((o) => o.name)
  const allViews = objects.filter((o) => o.objectType === 'view').map((o) => o.name)
  const tables = req.tables.length ? allTables.filter((t) => req.tables.includes(t)) : allTables
  const views = req.tables.length ? allViews.filter((v) => req.tables.includes(v)) : allViews

  const total = tables.length + views.length
  let processed = 0

  const stream = createWriteStream(req.filePath, { encoding: 'utf-8' })
  try {
    await write(
      stream,
      `-- ----------------------------------------------------------\n` +
        `-- SkySQL 备份\n` +
        `-- 连接: ${driver.profile.name}    数据库: ${req.database}\n` +
        `-- 时间: ${new Date().toLocaleString('zh-CN')}\n` +
        `-- ----------------------------------------------------------\n\n`
    )
    if (isMySql) await write(stream, 'SET FOREIGN_KEY_CHECKS = 0;\n\n')
    if (dbType === 'sqlite') await write(stream, 'PRAGMA foreign_keys = OFF;\n\n')

    // PG 外键集中放末尾，避免建表顺序问题
    const deferredFks: string[] = []

    for (const table of tables) {
      if (isCancelled(req.jobId)) throw new Error('已取消')
      await write(stream, `-- ----------------------------\n-- 表结构 ${table}\n-- ----------------------------\n`)
      if (req.includeDrop) {
        await write(stream, `DROP TABLE IF EXISTS ${qt(table)};\n`)
      }
      const ddl = await driver.getObjectDDL(req.database, 'table', table)
      await write(stream, ddl.trimEnd().replace(/;?$/, ';') + '\n\n')

      if (dbType === 'postgresql') {
        const meta = await driver.getTableMeta(req.database, table)
        for (const fk of meta.foreignKeys) {
          deferredFks.push(
            `ALTER TABLE ${qt(table)} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) ` +
              `REFERENCES ${qt(fk.refTable)} (${fk.refColumns.map(q).join(', ')})` +
              (fk.onDelete && fk.onDelete !== 'NO ACTION' ? ` ON DELETE ${fk.onDelete}` : '') +
              (fk.onUpdate && fk.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${fk.onUpdate}` : '') +
              ';'
          )
        }
      }

      if (req.includeData) {
        const cols = await driver.getTableColumns(req.database, table)
        const colList = cols.map((c) => q(c.name)).join(', ')
        await write(stream, `-- 表数据 ${table}\n`)
        for (let offset = 0; ; offset += DATA_BATCH) {
          if (isCancelled(req.jobId)) throw new Error('已取消')
          const res = await driver.query(
            `SELECT ${colList} FROM ${qt(table)} LIMIT ${DATA_BATCH} OFFSET ${offset}`,
            req.database
          )
          const rows = res[0]?.rows ?? []
          for (let i = 0; i < rows.length; i += INSERT_ROWS_PER_STMT) {
            const chunk = rows.slice(i, i + INSERT_ROWS_PER_STMT)
            const values = chunk.map((r) => `(${r.map(sqlLiteral).join(', ')})`).join(',\n  ')
            await write(stream, `INSERT INTO ${qt(table)} (${colList}) VALUES\n  ${values};\n`)
          }
          if (rows.length < DATA_BATCH) break
        }
        await write(stream, '\n')
      }

      processed++
      reportProgress({ jobId: req.jobId, processed, total, done: false })
    }

    for (const view of views) {
      if (isCancelled(req.jobId)) throw new Error('已取消')
      await write(stream, `-- ----------------------------\n-- 视图 ${view}\n-- ----------------------------\n`)
      if (req.includeDrop) {
        await write(stream, `DROP VIEW IF EXISTS ${qt(view)};\n`)
      }
      const ddl = await driver.getObjectDDL(req.database, 'view', view)
      await write(stream, ddl.trimEnd().replace(/;?$/, ';') + '\n\n')
      processed++
      reportProgress({ jobId: req.jobId, processed, total, done: false })
    }

    if (deferredFks.length > 0) {
      await write(stream, `-- ----------------------------\n-- 外键约束\n-- ----------------------------\n`)
      await write(stream, deferredFks.join('\n') + '\n\n')
    }

    if (isMySql) await write(stream, 'SET FOREIGN_KEY_CHECKS = 1;\n')
    if (dbType === 'sqlite') await write(stream, 'PRAGMA foreign_keys = ON;\n')

    reportProgress({ jobId: req.jobId, processed, total, done: true })
    return { rows: processed, durationMs: Date.now() - start }
  } catch (e) {
    reportProgress({
      jobId: req.jobId,
      processed,
      total,
      done: true,
      error: e instanceof Error ? e.message : String(e)
    })
    throw e
  } finally {
    stream.end()
    await once(stream, 'close').catch(() => undefined)
    finishJob(req.jobId)
  }
}

export async function runRestore(req: RestoreRequest): Promise<RestoreResult> {
  const start = Date.now()
  const driver = getDriver(req.profileId)
  const content = readFileSync(req.filePath, 'utf-8').replace(/^\u{FEFF}/u, '')
  const statements = splitStatements(content).filter((s) => !isCommentOnly(s))
  const total = statements.length
  const errors: string[] = []
  let processed = 0

  try {
    for (const stmt of statements) {
      if (isCancelled(req.jobId)) throw new Error('已取消')
      try {
        await driver.query(stmt, req.database)
      } catch (e) {
        const msg = `第 ${processed + 1} 条语句失败: ${e instanceof Error ? e.message : String(e)}`
        if (!req.continueOnError) {
          throw new Error(msg)
        }
        errors.push(msg)
      }
      processed++
      if (processed % 10 === 0 || processed === total) {
        reportProgress({ jobId: req.jobId, processed, total, done: false })
      }
    }
    reportProgress({ jobId: req.jobId, processed, total, done: true })
    return { rows: processed, durationMs: Date.now() - start, errors }
  } catch (e) {
    reportProgress({
      jobId: req.jobId,
      processed,
      total,
      done: true,
      error: e instanceof Error ? e.message : String(e)
    })
    throw e
  } finally {
    finishJob(req.jobId)
  }
}
