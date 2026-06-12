import type { DbType, FilterOp } from '@shared/types'
import { quoteIdentFor } from './utils'

export interface QbJoin {
  key: string
  type: 'INNER' | 'LEFT' | 'RIGHT'
  table: string
  /** ON 左侧：已有表（主表或更早加入的表） */
  leftTable: string
  leftCol: string
  /** ON 右侧：本次 JOIN 的表的列 */
  rightCol: string
}

export interface QbCondition {
  key: string
  /** 限定列名 table.column */
  column: string
  op: FilterOp
  value: string
}

export interface QbOrder {
  key: string
  column: string
  dir: 'ASC' | 'DESC'
}

export interface QueryBuilderState {
  baseTable: string
  joins: QbJoin[]
  /** 选中字段（限定名 table.column），空 = SELECT * */
  fields: string[]
  conditions: QbCondition[]
  groupBy: string[]
  orderBy: QbOrder[]
  limit?: number
}

export function emptyBuilderState(): QueryBuilderState {
  return { baseTable: '', joins: [], fields: [], conditions: [], groupBy: [], orderBy: [] }
}

/** 表名引用（PG / SQL Server 的 schema.table 分段引用） */
function quoteTable(dbType: DbType, table: string): string {
  const q = (s: string): string => quoteIdentFor(dbType, s)
  if ((dbType === 'postgresql' || dbType === 'sqlserver') && table.includes('.')) {
    const i = table.indexOf('.')
    return `${q(table.slice(0, i))}.${q(table.slice(i + 1))}`
  }
  return q(table)
}

/** 限定列引用：最后一个点之前是表（可能含 schema），之后是列 */
function quoteColumn(dbType: DbType, qualified: string): string {
  const i = qualified.lastIndexOf('.')
  if (i === -1) return quoteIdentFor(dbType, qualified)
  return `${quoteTable(dbType, qualified.slice(0, i))}.${quoteIdentFor(dbType, qualified.slice(i + 1))}`
}

function literal(value: string): string {
  const t = value.trim()
  if (/^-?\d+(\.\d+)?$/.test(t)) return t
  if (/^(TRUE|FALSE|NULL)$/i.test(t)) return t.toUpperCase()
  return `'${t.replace(/'/g, "''")}'`
}

/** 由构建器状态生成 SELECT 语句 */
export function generateQuery(dbType: DbType, s: QueryBuilderState): string {
  if (!s.baseTable) return ''
  const qc = (col: string): string => quoteColumn(dbType, col)
  const lines: string[] = []

  const hasLimit = s.limit !== undefined && Number.isInteger(s.limit) && s.limit > 0
  // SQL Server 不支持 LIMIT，用 SELECT TOP n
  const top = dbType === 'sqlserver' && hasLimit ? `TOP ${s.limit} ` : ''
  lines.push(`SELECT ${top}${s.fields.length > 0 ? s.fields.map(qc).join(', ') : '*'}`)
  lines.push(`FROM ${quoteTable(dbType, s.baseTable)}`)

  for (const j of s.joins) {
    if (!j.table || !j.leftTable || !j.leftCol || !j.rightCol) continue
    lines.push(
      `${j.type} JOIN ${quoteTable(dbType, j.table)} ON ${qc(`${j.leftTable}.${j.leftCol}`)} = ${qc(`${j.table}.${j.rightCol}`)}`
    )
  }

  const conds = s.conditions.filter((c) => c.column && (c.op === 'IS NULL' || c.op === 'IS NOT NULL' || c.value !== ''))
  if (conds.length > 0) {
    const parts = conds.map((c) =>
      c.op === 'IS NULL' || c.op === 'IS NOT NULL' ? `${qc(c.column)} ${c.op}` : `${qc(c.column)} ${c.op} ${literal(c.value)}`
    )
    lines.push(`WHERE ${parts.join('\n  AND ')}`)
  }

  if (s.groupBy.length > 0) {
    lines.push(`GROUP BY ${s.groupBy.map(qc).join(', ')}`)
  }

  const orders = s.orderBy.filter((o) => o.column)
  if (orders.length > 0) {
    lines.push(`ORDER BY ${orders.map((o) => `${qc(o.column)} ${o.dir}`).join(', ')}`)
  }

  if (hasLimit && dbType !== 'sqlserver') {
    lines.push(`LIMIT ${s.limit}`)
  }

  return lines.join('\n')
}
