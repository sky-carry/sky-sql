import { createWriteStream, type WriteStream } from 'fs'
import { once } from 'events'
import * as XLSX from 'xlsx'
import type { CellValue, ExportRequest, TransferResult } from '@shared/types'
import { getDriver } from '../db/connectionManager'
import { finishJob, isCancelled, reportProgress } from './jobs'

const BATCH_SIZE = 1000

function cellToExportValue(v: CellValue): string | number | boolean | null {
  if (v === null) return null
  if (typeof v === 'object' && '__type' in v) return `0x${Buffer.from(v.base64, 'base64').toString('hex')}`
  return v
}

function csvEscape(v: string | number | boolean | null, delimiter: string): string {
  if (v === null) return ''
  const s = String(v)
  if (s.includes('"') || s.includes(delimiter) || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

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

export async function exportTable(req: ExportRequest): Promise<TransferResult> {
  const start = Date.now()
  const driver = getDriver(req.profileId)
  const q = driver.quoteIdent.bind(driver)

  const allColumns = await driver.getTableColumns(req.database, req.table)
  const columns = req.columns.length
    ? allColumns.filter((c) => req.columns.includes(c.name)).map((c) => c.name)
    : allColumns.map((c) => c.name)
  if (columns.length === 0) throw new Error('没有可导出的列')

  // PG 的表名可能带 schema 前缀
  const tableRef =
    driver.profile.dbType === 'postgresql'
      ? req.table.includes('.')
        ? `${q(req.table.split('.')[0])}.${q(req.table.split('.').slice(1).join('.'))}`
        : q(req.table)
      : driver.profile.dbType === 'sqlite'
        ? q(req.table)
        : `${q(req.database)}.${q(req.table)}`
  const selectCols = columns.map(q).join(', ')

  const countRes = await driver.query(`SELECT COUNT(*) AS c FROM ${tableRef}`, req.database)
  const total = Number(countRes[0]?.rows[0]?.[0] ?? 0)

  let processed = 0
  const delimiter = req.options.delimiter || ','

  try {
    if (req.format === 'xlsx') {
      // SheetJS 不支持流式写，整表载入内存
      const aoa: (string | number | boolean | null)[][] = []
      if (req.options.includeHeaders) aoa.push([...columns])
      for (let offset = 0; ; offset += BATCH_SIZE) {
        if (isCancelled(req.jobId)) throw new Error('已取消')
        const res = await driver.query(
          `SELECT ${selectCols} FROM ${tableRef} LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
          req.database
        )
        const rows = res[0]?.rows ?? []
        for (const row of rows) aoa.push(row.map(cellToExportValue))
        processed += rows.length
        reportProgress({ jobId: req.jobId, processed, total, done: false })
        if (rows.length < BATCH_SIZE) break
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, req.table.slice(0, 31) || 'Sheet1')
      XLSX.writeFile(wb, req.filePath)
    } else {
      const stream = createWriteStream(req.filePath, { encoding: 'utf-8' })
      try {
        if (req.format === 'csv') {
          // BOM 让 Excel 正确识别 UTF-8
          await write(stream, '\u{FEFF}')
          if (req.options.includeHeaders) {
            await write(stream, columns.map((c) => csvEscape(c, delimiter)).join(delimiter) + '\r\n')
          }
        } else if (req.format === 'json') {
          await write(stream, '[\n')
        }

        let first = true
        for (let offset = 0; ; offset += BATCH_SIZE) {
          if (isCancelled(req.jobId)) throw new Error('已取消')
          const res = await driver.query(
            `SELECT ${selectCols} FROM ${tableRef} LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
            req.database
          )
          const rows = res[0]?.rows ?? []
          let chunk = ''
          for (const row of rows) {
            if (req.format === 'csv') {
              chunk += row.map((v) => csvEscape(cellToExportValue(v), delimiter)).join(delimiter) + '\r\n'
            } else if (req.format === 'json') {
              const obj: Record<string, unknown> = {}
              columns.forEach((c, i) => {
                obj[c] = cellToExportValue(row[i])
              })
              chunk += (first ? '' : ',\n') + '  ' + JSON.stringify(obj)
              first = false
            } else {
              chunk += `INSERT INTO ${tableRef} (${selectCols}) VALUES (${row.map(sqlLiteral).join(', ')});\n`
            }
          }
          if (chunk) await write(stream, chunk)
          processed += rows.length
          reportProgress({ jobId: req.jobId, processed, total, done: false })
          if (rows.length < BATCH_SIZE) break
        }

        if (req.format === 'json') await write(stream, '\n]\n')
      } finally {
        stream.end()
        await once(stream, 'close')
      }
    }

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
    finishJob(req.jobId)
  }
}
