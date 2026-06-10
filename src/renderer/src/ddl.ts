import type { DbType, TableColumnInfo, TableMeta } from '@shared/types'
import { quoteIdentFor } from './utils'

/** 表设计器的编辑模型 */
export interface DesignColumn {
  key: string
  /** 已存在列的原名（diff 用），新列为 undefined */
  originalName?: string
  name: string
  type: string
  length: string
  scale: string
  notNull: boolean
  pk: boolean
  autoIncrement: boolean
  defaultValue: string
  comment: string
}

export interface DesignIndex {
  key: string
  originalName?: string
  name: string
  columns: string[]
  unique: boolean
  method?: string
}

export interface DesignFk {
  key: string
  originalName?: string
  name: string
  columns: string[]
  refTable: string
  refColumns: string[]
  onUpdate: string
  onDelete: string
}

export interface TableDesign {
  name: string
  columns: DesignColumn[]
  indexes: DesignIndex[]
  foreignKeys: DesignFk[]
  comment: string
  engine?: string
  charset?: string
  collation?: string
}

let keyCounter = 0
export function nextKey(): string {
  return `k${++keyCounter}`
}

export function emptyColumn(): DesignColumn {
  return {
    key: nextKey(),
    name: '',
    type: '',
    length: '',
    scale: '',
    notNull: false,
    pk: false,
    autoIncrement: false,
    defaultValue: '',
    comment: ''
  }
}

/** 把 "varchar(255)" / "decimal(10,2) unsigned" 解析为 type/length/scale */
function parseColumnType(columnType: string): { type: string; length: string; scale: string } {
  const m = /^([a-zA-Z_ ]+?)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)\s*(.*)$/.exec(columnType.trim())
  if (!m) return { type: columnType.trim(), length: '', scale: '' }
  const suffix = m[4] ? ` ${m[4].trim()}` : ''
  return { type: (m[1].trim() + suffix).trim(), length: m[2], scale: m[3] ?? '' }
}

function columnInfoToDesign(c: TableColumnInfo): DesignColumn {
  const parsed = parseColumnType(c.columnType ?? c.dataType)
  return {
    key: nextKey(),
    originalName: c.name,
    name: c.name,
    type: parsed.type,
    length: parsed.length,
    scale: parsed.scale,
    notNull: !c.nullable,
    pk: c.isPrimaryKey,
    autoIncrement: c.isAutoIncrement,
    defaultValue: c.defaultValue ?? '',
    comment: c.comment ?? ''
  }
}

export function metaToDesign(table: string, meta: TableMeta): TableDesign {
  return {
    name: table,
    columns: meta.columns.map(columnInfoToDesign),
    indexes: meta.indexes.map((i) => ({
      key: nextKey(),
      originalName: i.name,
      name: i.name,
      columns: [...i.columns],
      unique: i.unique,
      method: i.method
    })),
    foreignKeys: meta.foreignKeys.map((f) => ({
      key: nextKey(),
      originalName: f.name,
      name: f.name,
      columns: [...f.columns],
      refTable: f.refTable,
      refColumns: [...f.refColumns],
      onUpdate: f.onUpdate || 'NO ACTION',
      onDelete: f.onDelete || 'NO ACTION'
    })),
    comment: meta.comment ?? '',
    engine: meta.engine,
    charset: meta.charset,
    collation: meta.collation
  }
}

export function newTableDesign(): TableDesign {
  return {
    name: '',
    columns: [emptyColumn()],
    indexes: [],
    foreignKeys: [],
    comment: '',
    engine: 'InnoDB',
    charset: 'utf8mb4'
  }
}

/**
 * 结构同步：把"源"设计与"目标"设计按名称对齐。
 * 与目标同名的列/索引/外键标记为既有（originalName=名称，走 MODIFY/重建 diff），
 * 仅源端存在的标记为新增（originalName=undefined，走 ADD/CREATE）；
 * 目标独有的元素会被 generateAlterTable 视为已删除（生成 DROP）。
 */
export function alignDesignForSync(source: TableDesign, target: TableDesign): TableDesign {
  const targetCols = new Set(target.columns.map((c) => c.name))
  const targetIdx = new Set(target.indexes.map((i) => i.name))
  const targetFks = new Set(target.foreignKeys.map((f) => f.name))
  return {
    ...source,
    name: target.name,
    columns: source.columns.map((c) => ({
      ...c,
      originalName: targetCols.has(c.name) ? c.name : undefined
    })),
    indexes: source.indexes.map((i) => ({
      ...i,
      originalName: targetIdx.has(i.name) ? i.name : undefined
    })),
    foreignKeys: source.foreignKeys.map((f) => ({
      ...f,
      originalName: targetFks.has(f.name) ? f.name : undefined
    }))
  }
}

/* ===================== SQL 生成 ===================== */

const RAW_DEFAULT = /^(NULL|TRUE|FALSE|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i

/** 默认值的字面量处理：数字/函数/关键字原样，其余按字符串加引号 */
function formatDefault(v: string): string {
  const t = v.trim()
  if (t === '') return ''
  if (/^-?\d+(\.\d+)?$/.test(t)) return t
  if (RAW_DEFAULT.test(t)) return t.toUpperCase()
  if (t.includes('(') && t.endsWith(')')) return t
  if (t.startsWith("'") && t.endsWith("'")) return t
  return `'${t.replace(/'/g, "''")}'`
}

function fullType(c: DesignColumn): string {
  if (!c.length) return c.type
  // 仅 unsigned/zerofill 视为后缀修饰词；多词类型（character varying 等）整体作为基础类型
  const m = /^(.+?)((?:\s+(?:unsigned|zerofill))+)?$/i.exec(c.type.trim())
  const base = m ? m[1] : c.type
  const suffix = m?.[2] ?? ''
  const len = c.scale ? `(${c.length},${c.scale})` : `(${c.length})`
  return `${base}${len}${suffix}`
}

/** 表名（PG 支持 schema.name，MySQL 加库名前缀） */
function quoteTable(dbType: DbType, database: string, name: string): string {
  const q = (s: string): string => quoteIdentFor(dbType, s)
  if (dbType === 'mysql' || dbType === 'mariadb') return `${q(database)}.${q(name)}`
  if (dbType === 'postgresql') {
    const idx = name.indexOf('.')
    return idx === -1 ? `"public".${q(name)}` : `${q(name.slice(0, idx))}.${q(name.slice(idx + 1))}`
  }
  return q(name)
}

function isIntType(type: string): boolean {
  return /^(tiny|small|medium|big)?int(eger)?(\s|$)/i.test(type)
}

function columnDef(dbType: DbType, c: DesignColumn, opts: { inlinePk?: boolean } = {}): string {
  const q = (s: string): string => quoteIdentFor(dbType, s)
  const parts: string[] = [q(c.name)]

  if (dbType === 'sqlite' && opts.inlinePk) {
    // SQLite 单列整数主键：INTEGER PRIMARY KEY [AUTOINCREMENT]
    parts.push('INTEGER PRIMARY KEY')
    if (c.autoIncrement) parts.push('AUTOINCREMENT')
    return parts.join(' ')
  }

  parts.push(fullType(c))
  if (c.notNull) parts.push('NOT NULL')

  if (dbType === 'mysql' || dbType === 'mariadb') {
    if (c.autoIncrement) parts.push('AUTO_INCREMENT')
  } else if (dbType === 'postgresql' && c.autoIncrement && isIntType(c.type)) {
    parts.push('GENERATED BY DEFAULT AS IDENTITY')
  }

  const def = formatDefault(c.defaultValue)
  // 自增列与 PG identity 列不生成 DEFAULT（nextval 由系统管理）
  if (def && !c.autoIncrement && !def.startsWith('nextval(')) parts.push(`DEFAULT ${def}`)

  if ((dbType === 'mysql' || dbType === 'mariadb') && c.comment) {
    parts.push(`COMMENT '${c.comment.replace(/'/g, "''")}'`)
  }
  return parts.join(' ')
}

function fkClause(dbType: DbType, database: string, f: DesignFk): string {
  const q = (s: string): string => quoteIdentFor(dbType, s)
  return (
    `CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(', ')}) ` +
    `REFERENCES ${quoteTable(dbType, database, f.refTable)} (${f.refColumns.map(q).join(', ')})` +
    (f.onDelete && f.onDelete !== 'NO ACTION' ? ` ON DELETE ${f.onDelete}` : '') +
    (f.onUpdate && f.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${f.onUpdate}` : '')
  )
}

export function generateCreateTable(dbType: DbType, database: string, d: TableDesign): string[] {
  const q = (s: string): string => quoteIdentFor(dbType, s)
  const table = quoteTable(dbType, database, d.name)
  const statements: string[] = []
  const lines: string[] = []
  const validCols = d.columns.filter((c) => c.name && c.type)
  const pkCols = validCols.filter((c) => c.pk)
  const sqliteInlinePk =
    dbType === 'sqlite' && pkCols.length === 1 && isIntType(pkCols[0].type)

  for (const c of validCols) {
    lines.push('  ' + columnDef(dbType, c, { inlinePk: sqliteInlinePk && c.pk }))
  }
  if (pkCols.length > 0 && !sqliteInlinePk) {
    lines.push(`  PRIMARY KEY (${pkCols.map((c) => q(c.name)).join(', ')})`)
  }

  if (dbType === 'mysql' || dbType === 'mariadb') {
    for (const i of d.indexes.filter((x) => x.name && x.columns.length)) {
      lines.push(
        `  ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} (${i.columns.map(q).join(', ')})` +
          (i.method ? ` USING ${i.method}` : '')
      )
    }
  }
  for (const f of d.foreignKeys.filter((x) => x.name && x.columns.length && x.refTable)) {
    lines.push('  ' + fkClause(dbType, database, f))
  }

  let create = `CREATE TABLE ${table} (\n${lines.join(',\n')}\n)`
  if (dbType === 'mysql' || dbType === 'mariadb') {
    if (d.engine) create += ` ENGINE=${d.engine}`
    if (d.charset) create += ` DEFAULT CHARSET=${d.charset}`
    if (d.collation) create += ` COLLATE=${d.collation}`
    if (d.comment) create += ` COMMENT='${d.comment.replace(/'/g, "''")}'`
  }
  statements.push(create)

  // PG / SQLite 的二级索引独立建
  if (dbType === 'postgresql' || dbType === 'sqlite') {
    for (const i of d.indexes.filter((x) => x.name && x.columns.length)) {
      statements.push(
        `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${table}` +
          (dbType === 'postgresql' && i.method ? ` USING ${i.method}` : '') +
          ` (${i.columns.map(q).join(', ')})`
      )
    }
  }

  if (dbType === 'postgresql') {
    if (d.comment) {
      statements.push(`COMMENT ON TABLE ${table} IS '${d.comment.replace(/'/g, "''")}'`)
    }
    for (const c of validCols.filter((x) => x.comment)) {
      statements.push(
        `COMMENT ON COLUMN ${table}.${q(c.name)} IS '${c.comment.replace(/'/g, "''")}'`
      )
    }
  }
  return statements
}

interface OriginalState {
  name: string
  design: TableDesign
  pkConstraint?: string
}

function sameArr(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function columnChanged(a: DesignColumn, b: DesignColumn): boolean {
  return (
    fullType(a).toLowerCase() !== fullType(b).toLowerCase() ||
    a.notNull !== b.notNull ||
    a.autoIncrement !== b.autoIncrement ||
    (a.defaultValue ?? '') !== (b.defaultValue ?? '') ||
    (a.comment ?? '') !== (b.comment ?? '')
  )
}

export function generateAlterTable(
  dbType: DbType,
  database: string,
  original: OriginalState,
  d: TableDesign
): string[] {
  const q = (s: string): string => quoteIdentFor(dbType, s)
  const table = quoteTable(dbType, database, original.name)
  const statements: string[] = []
  const warnings: string[] = []

  const origCols = original.design.columns
  const origByName = new Map(origCols.map((c) => [c.originalName ?? c.name, c]))
  const currentByOrig = new Map(
    d.columns.filter((c) => c.originalName).map((c) => [c.originalName!, c])
  )

  const droppedCols = origCols.filter((c) => !currentByOrig.has(c.originalName ?? c.name))
  const addedCols = d.columns.filter((c) => !c.originalName && c.name && c.type)
  const keptCols = d.columns.filter((c) => c.originalName && origByName.has(c.originalName))

  const origPk = origCols.filter((c) => c.pk).map((c) => c.originalName ?? c.name)
  const newPk = d.columns.filter((c) => c.pk && c.name).map((c) => c.name)
  // 以原始列名为基准比较，避免仅重命名主键列时误判为主键变更
  const newPkAsOrig = d.columns.filter((c) => c.pk).map((c) => c.originalName ?? c.name)
  const pkChanged = !sameArr(origPk, newPkAsOrig)

  const origIdxByName = new Map(original.design.indexes.map((i) => [i.originalName ?? i.name, i]))
  const curIdxByOrig = new Map(
    d.indexes.filter((i) => i.originalName).map((i) => [i.originalName!, i])
  )
  const droppedIdx = original.design.indexes.filter((i) => !curIdxByOrig.has(i.originalName ?? i.name))
  const addedIdx = d.indexes.filter((i) => !i.originalName && i.name && i.columns.length)
  const changedIdx = d.indexes.filter((i) => {
    if (!i.originalName) return false
    const o = origIdxByName.get(i.originalName)
    if (!o) return false
    return (
      o.name !== i.name ||
      o.unique !== i.unique ||
      (o.method ?? '') !== (i.method ?? '') ||
      !sameArr(o.columns, i.columns)
    )
  })

  const origFkByName = new Map(original.design.foreignKeys.map((f) => [f.originalName ?? f.name, f]))
  const curFkByOrig = new Map(
    d.foreignKeys.filter((f) => f.originalName).map((f) => [f.originalName!, f])
  )
  const droppedFk = original.design.foreignKeys.filter((f) => !curFkByOrig.has(f.originalName ?? f.name))
  const addedFk = d.foreignKeys.filter((f) => !f.originalName && f.name && f.columns.length && f.refTable)
  const changedFk = d.foreignKeys.filter((f) => {
    if (!f.originalName) return false
    const o = origFkByName.get(f.originalName)
    if (!o) return false
    return (
      o.name !== f.name ||
      o.refTable !== f.refTable ||
      o.onUpdate !== f.onUpdate ||
      o.onDelete !== f.onDelete ||
      !sameArr(o.columns, f.columns) ||
      !sameArr(o.refColumns, f.refColumns)
    )
  })

  if (dbType === 'mysql' || dbType === 'mariadb') {
    const clauses: string[] = []
    for (const f of [...droppedFk, ...changedFk.map((f) => origFkByName.get(f.originalName!)!)]) {
      clauses.push(`DROP FOREIGN KEY ${q(f.originalName ?? f.name)}`)
    }
    for (const i of [...droppedIdx, ...changedIdx]) {
      clauses.push(`DROP INDEX ${q(i.originalName ?? i.name)}`)
    }
    for (const c of droppedCols) {
      clauses.push(`DROP COLUMN ${q(c.originalName ?? c.name)}`)
    }
    for (const c of keptCols) {
      const o = origByName.get(c.originalName!)!
      if (c.name !== c.originalName) {
        clauses.push(`CHANGE ${q(c.originalName!)} ${columnDef(dbType, c)}`)
      } else if (columnChanged(o, c)) {
        clauses.push(`MODIFY ${columnDef(dbType, c)}`)
      }
    }
    for (const c of addedCols) {
      clauses.push(`ADD COLUMN ${columnDef(dbType, c)}`)
    }
    if (pkChanged) {
      if (origPk.length > 0) clauses.push('DROP PRIMARY KEY')
      if (newPk.length > 0) clauses.push(`ADD PRIMARY KEY (${newPk.map(q).join(', ')})`)
    }
    for (const i of [...changedIdx, ...addedIdx]) {
      clauses.push(
        `ADD ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} (${i.columns.map(q).join(', ')})` +
          (i.method ? ` USING ${i.method}` : '')
      )
    }
    for (const f of [...changedFk, ...addedFk]) {
      clauses.push(`ADD ${fkClause(dbType, database, f)}`)
    }
    if ((d.engine ?? '') !== (original.design.engine ?? '') && d.engine) {
      clauses.push(`ENGINE=${d.engine}`)
    }
    if ((d.comment ?? '') !== (original.design.comment ?? '')) {
      clauses.push(`COMMENT='${(d.comment ?? '').replace(/'/g, "''")}'`)
    }
    if (clauses.length > 0) {
      statements.push(`ALTER TABLE ${table}\n  ${clauses.join(',\n  ')}`)
    }
    if (d.name !== original.name && d.name) {
      statements.push(`RENAME TABLE ${table} TO ${quoteTable(dbType, database, d.name)}`)
    }
    return statements
  }

  if (dbType === 'postgresql') {
    for (const f of [...droppedFk, ...changedFk.map((f) => origFkByName.get(f.originalName!)!)]) {
      statements.push(`ALTER TABLE ${table} DROP CONSTRAINT ${q(f.originalName ?? f.name)}`)
    }
    for (const i of [...droppedIdx, ...changedIdx]) {
      const idxName = i.originalName ?? i.name
      const schema = original.name.includes('.') ? original.name.split('.')[0] : 'public'
      statements.push(`DROP INDEX ${q(schema)}.${q(idxName)}`)
    }
    for (const c of droppedCols) {
      statements.push(`ALTER TABLE ${table} DROP COLUMN ${q(c.originalName ?? c.name)}`)
    }
    for (const c of keptCols) {
      const o = origByName.get(c.originalName!)!
      if (fullType(o).toLowerCase() !== fullType(c).toLowerCase()) {
        statements.push(`ALTER TABLE ${table} ALTER COLUMN ${q(c.originalName!)} TYPE ${fullType(c)}`)
      }
      if (o.notNull !== c.notNull) {
        statements.push(
          `ALTER TABLE ${table} ALTER COLUMN ${q(c.originalName!)} ${c.notNull ? 'SET' : 'DROP'} NOT NULL`
        )
      }
      if ((o.defaultValue ?? '') !== (c.defaultValue ?? '')) {
        const def = formatDefault(c.defaultValue)
        statements.push(
          def
            ? `ALTER TABLE ${table} ALTER COLUMN ${q(c.originalName!)} SET DEFAULT ${def}`
            : `ALTER TABLE ${table} ALTER COLUMN ${q(c.originalName!)} DROP DEFAULT`
        )
      }
      if ((o.comment ?? '') !== (c.comment ?? '')) {
        statements.push(
          `COMMENT ON COLUMN ${table}.${q(c.originalName!)} IS '${(c.comment ?? '').replace(/'/g, "''")}'`
        )
      }
      if (c.name !== c.originalName) {
        statements.push(`ALTER TABLE ${table} RENAME COLUMN ${q(c.originalName!)} TO ${q(c.name)}`)
      }
      if (o.autoIncrement !== c.autoIncrement) {
        warnings.push(`-- 警告: PostgreSQL 不支持直接切换自增（identity），列 ${c.name} 的该项变更已忽略`)
      }
    }
    for (const c of addedCols) {
      statements.push(`ALTER TABLE ${table} ADD COLUMN ${columnDef(dbType, c)}`)
      if (c.comment) {
        statements.push(
          `COMMENT ON COLUMN ${table}.${q(c.name)} IS '${c.comment.replace(/'/g, "''")}'`
        )
      }
    }
    if (pkChanged) {
      if (origPk.length > 0 && original.pkConstraint) {
        statements.push(`ALTER TABLE ${table} DROP CONSTRAINT ${q(original.pkConstraint)}`)
      }
      if (newPk.length > 0) {
        statements.push(`ALTER TABLE ${table} ADD PRIMARY KEY (${newPk.map(q).join(', ')})`)
      }
    }
    for (const i of [...changedIdx, ...addedIdx]) {
      statements.push(
        `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${table}` +
          (i.method ? ` USING ${i.method}` : '') +
          ` (${i.columns.map(q).join(', ')})`
      )
    }
    for (const f of [...changedFk, ...addedFk]) {
      statements.push(`ALTER TABLE ${table} ADD ${fkClause(dbType, database, f)}`)
    }
    if ((d.comment ?? '') !== (original.design.comment ?? '')) {
      statements.push(`COMMENT ON TABLE ${table} IS '${(d.comment ?? '').replace(/'/g, "''")}'`)
    }
    if (d.name !== original.name && d.name) {
      const newName = d.name.includes('.') ? d.name.split('.').pop()! : d.name
      statements.push(`ALTER TABLE ${table} RENAME TO ${q(newName)}`)
    }
    return [...warnings, ...statements]
  }

  // SQLite：仅支持 ADD/DROP/RENAME COLUMN、改表名、增删索引
  for (const c of droppedCols) {
    statements.push(`ALTER TABLE ${table} DROP COLUMN ${q(c.originalName ?? c.name)}`)
  }
  for (const c of keptCols) {
    const o = origByName.get(c.originalName!)!
    if (c.name !== c.originalName) {
      statements.push(`ALTER TABLE ${table} RENAME COLUMN ${q(c.originalName!)} TO ${q(c.name)}`)
    }
    if (columnChanged(o, c) || o.pk !== c.pk) {
      warnings.push(`-- 警告: SQLite 不支持修改列定义（${c.name}），该项变更已忽略；如需修改请重建表`)
    }
  }
  for (const c of addedCols) {
    statements.push(`ALTER TABLE ${table} ADD COLUMN ${columnDef(dbType, c)}`)
  }
  for (const i of [...droppedIdx, ...changedIdx]) {
    statements.push(`DROP INDEX ${q(i.originalName ?? i.name)}`)
  }
  for (const i of [...changedIdx, ...addedIdx]) {
    statements.push(
      `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${q(d.name || original.name)} (${i.columns.map(q).join(', ')})`
    )
  }
  if (droppedFk.length || addedFk.length || changedFk.length) {
    warnings.push('-- 警告: SQLite 不支持对已有表增删外键，相关变更已忽略；如需修改请重建表')
  }
  if (d.name !== original.name && d.name) {
    statements.push(`ALTER TABLE ${table} RENAME TO ${q(d.name)}`)
  }
  return [...warnings, ...statements]
}
