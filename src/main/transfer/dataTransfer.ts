import type { DataTransferRequest, DataTransferResult } from '@shared/types'
import { getDriver } from '../db/connectionManager'
import { finishJob, isCancelled, reportProgress } from './jobs'
import { buildCreateTable, buildFkStatements, pageClause, qualifyTable, quoteIdent } from './ddlBuild'

const READ_BATCH = 1000
const INSERT_BATCH = 500

export async function runDataTransfer(req: DataTransferRequest): Promise<DataTransferResult> {
  const start = Date.now()
  const src = getDriver(req.source.profileId)
  const tgt = getDriver(req.target.profileId)
  const srcType = src.profile.dbType
  const tgtType = tgt.profile.dbType
  const errors: string[] = []
  let totalRows = 0
  let tablesDone = 0

  const fail = (msg: string): void => {
    if (!req.options.continueOnError) throw new Error(msg)
    errors.push(msg)
  }

  const report = (note: string): void =>
    reportProgress({
      jobId: req.jobId,
      processed: totalRows,
      total: null,
      done: false,
      note
    })

  try {
    const deferredFks: string[] = []

    for (let t = 0; t < req.tables.length; t++) {
      if (isCancelled(req.jobId)) throw new Error('已取消')
      const table = req.tables[t]
      const tableLabel = `${table}（${t + 1}/${req.tables.length}）`
      report(`读取结构: ${tableLabel}`)

      let meta
      try {
        meta = await src.getTableMeta(req.source.database, table)
      } catch (e) {
        fail(`读取 ${table} 结构失败: ${e instanceof Error ? e.message : String(e)}`)
        continue
      }

      if (req.options.includeStructure) {
        const statements: string[] = []
        if (req.options.dropTarget) {
          statements.push(`DROP TABLE IF EXISTS ${qualifyTable(tgtType, table)}`)
        }
        statements.push(
          ...buildCreateTable(tgtType, table, meta, {
            includeIndexes: req.options.includeIndexes,
            srcType
          })
        )
        if (req.options.includeFks) {
          deferredFks.push(...buildFkStatements(tgtType, table, meta))
        }
        report(`创建结构: ${tableLabel}`)
        let structureOk = true
        for (const stmt of statements) {
          try {
            await tgt.query(stmt, req.target.database)
          } catch (e) {
            fail(`${table} 建表失败: ${e instanceof Error ? e.message : String(e)}`)
            if (stmt.startsWith('CREATE TABLE')) structureOk = false
          }
        }
        if (!structureOk) continue
      } else if (req.options.truncateBeforeInsert) {
        try {
          await tgt.truncateTable(req.target.database, table)
        } catch (e) {
          fail(`清空 ${table} 失败: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      if (req.options.includeData) {
        const sq = (s: string): string => quoteIdent(srcType, s)
        // PG / SQL Server 源的表名可能带 schema
        const srcTable = qualifyTable(srcType, table)
        const columns = meta.columns.map((c) => c.name)
        const colList = columns.map(sq).join(', ')

        for (let offset = 0; ; offset += READ_BATCH) {
          if (isCancelled(req.jobId)) throw new Error('已取消')
          let rows
          try {
            const res = await src.query(
              `SELECT ${colList} FROM ${srcTable}${pageClause(srcType, READ_BATCH, offset)}`,
              req.source.database
            )
            rows = res[0]?.rows ?? []
          } catch (e) {
            fail(`读取 ${table} 数据失败: ${e instanceof Error ? e.message : String(e)}`)
            break
          }
          for (let i = 0; i < rows.length; i += INSERT_BATCH) {
            const batch = rows.slice(i, i + INSERT_BATCH)
            try {
              await tgt.insertRows(req.target.database, table, columns, batch)
              totalRows += batch.length
            } catch (e) {
              fail(`写入 ${table} 失败: ${e instanceof Error ? e.message : String(e)}`)
            }
            report(`传输数据: ${tableLabel}`)
          }
          if (rows.length < READ_BATCH) break
        }
      }
      tablesDone++
    }

    if (deferredFks.length > 0) {
      report('创建外键约束')
      for (const stmt of deferredFks) {
        try {
          await tgt.query(stmt, req.target.database)
        } catch (e) {
          fail(`外键创建失败: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }

    reportProgress({ jobId: req.jobId, processed: totalRows, total: null, done: true })
    return { tables: tablesDone, rows: totalRows, durationMs: Date.now() - start, errors }
  } catch (e) {
    reportProgress({
      jobId: req.jobId,
      processed: totalRows,
      total: null,
      done: true,
      error: e instanceof Error ? e.message : String(e)
    })
    throw e
  } finally {
    finishJob(req.jobId)
  }
}
