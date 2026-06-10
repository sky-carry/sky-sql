import { readFileSync } from 'fs'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import type { FilePreview, ImportFormat } from '@shared/types'

const PREVIEW_ROWS = 50

export interface ParsedFile {
  headers: string[]
  rows: unknown[][]
  sheets?: string[]
}

export interface ParseOptions {
  delimiter: string
  hasHeader: boolean
  sheet?: string
}

function parseCsv(filePath: string, delimiter: string, hasHeader: boolean): ParsedFile {
  const content = readFileSync(filePath, 'utf-8').replace(/^\u{FEFF}/u, '')
  const result = Papa.parse<string[]>(content, {
    delimiter: delimiter || ',',
    skipEmptyLines: true
  })
  const data = result.data
  if (data.length === 0) return { headers: [], rows: [] }
  if (hasHeader) {
    return { headers: data[0].map((h, i) => h || `列${i + 1}`), rows: data.slice(1) }
  }
  return { headers: data[0].map((_, i) => `列${i + 1}`), rows: data }
}

function parseJson(filePath: string): ParsedFile {
  const content = readFileSync(filePath, 'utf-8').replace(/^\u{FEFF}/u, '')
  const parsed: unknown = JSON.parse(content)
  if (!Array.isArray(parsed)) throw new Error('JSON 文件必须是对象数组（[{...}, {...}]）')
  const headers: string[] = []
  for (const item of parsed.slice(0, 200)) {
    if (item && typeof item === 'object') {
      for (const k of Object.keys(item as Record<string, unknown>)) {
        if (!headers.includes(k)) headers.push(k)
      }
    }
  }
  const rows = parsed.map((item) =>
    headers.map((h) => {
      const v = (item as Record<string, unknown>)[h]
      if (v !== null && typeof v === 'object') return JSON.stringify(v)
      return v as unknown
    })
  )
  return { headers, rows }
}

function parseXlsx(filePath: string, sheet?: string, hasHeader = true): ParsedFile {
  const wb = XLSX.readFile(filePath)
  const sheets = wb.SheetNames
  const target = sheet && sheets.includes(sheet) ? sheet : sheets[0]
  if (!target) throw new Error('Excel 文件中没有工作表')
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[target], {
    header: 1,
    raw: true,
    defval: null
  })
  if (aoa.length === 0) return { headers: [], rows: [], sheets }
  const width = Math.max(...aoa.map((r) => r.length))
  const norm = aoa.map((r) => {
    const row = [...r]
    while (row.length < width) row.push(null)
    return row
  })
  if (hasHeader) {
    return {
      headers: norm[0].map((h, i) => (h == null || h === '' ? `列${i + 1}` : String(h))),
      rows: norm.slice(1),
      sheets
    }
  }
  return { headers: norm[0].map((_, i) => `列${i + 1}`), rows: norm, sheets }
}

export function parseFile(filePath: string, format: ImportFormat, options: ParseOptions): ParsedFile {
  switch (format) {
    case 'csv':
      return parseCsv(filePath, options.delimiter, options.hasHeader)
    case 'json':
      return parseJson(filePath)
    case 'xlsx':
      return parseXlsx(filePath, options.sheet, options.hasHeader)
  }
}

export function previewFile(filePath: string, format: ImportFormat, options: ParseOptions): FilePreview {
  const parsed = parseFile(filePath, format, options)
  return {
    headers: parsed.headers,
    rows: parsed.rows.slice(0, PREVIEW_ROWS).map((r) => r.map((v) => (v == null ? '' : String(v)))),
    sheets: parsed.sheets,
    totalRowsHint: parsed.rows.length
  }
}
