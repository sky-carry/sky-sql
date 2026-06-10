import type { CellValue, ImportRequest, TransferResult } from '@shared/types'
import { getDriver } from '../db/connectionManager'
import { finishJob, isCancelled, reportProgress } from './jobs'
import { parseFile } from './parsers'

export { previewFile } from './parsers'

const BATCH_SIZE = 500

function toCell(v: unknown): CellValue {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
  return String(v)
}

export async function importFile(req: ImportRequest): Promise<TransferResult> {
  const start = Date.now()
  const driver = getDriver(req.profileId)
  if (req.mapping.length === 0) throw new Error('请至少映射一个字段')

  const parsed = parseFile(req.filePath, req.format, req.options)
  const sourceIndex = new Map(parsed.headers.map((h, i) => [h, i]))
  const mapping = req.mapping.filter((m) => sourceIndex.has(m.source) && m.target)
  if (mapping.length === 0) throw new Error('字段映射无效')

  const targetCols = mapping.map((m) => m.target)
  const total = parsed.rows.length
  let processed = 0

  try {
    if (req.mode === 'truncate') {
      await driver.truncateTable(req.database, req.table)
    }

    for (let i = 0; i < parsed.rows.length; i += BATCH_SIZE) {
      if (isCancelled(req.jobId)) throw new Error('已取消')
      const batch = parsed.rows
        .slice(i, i + BATCH_SIZE)
        .map((row) => mapping.map((m) => toCell(row[sourceIndex.get(m.source)!])))
      await driver.insertRows(req.database, req.table, targetCols, batch)
      processed += batch.length
      reportProgress({ jobId: req.jobId, processed, total, done: false })
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
