import type { DbType, TableColumnInfo, TableMeta } from '@shared/types'

/** 数据库类型族（mysql 与 mariadb 同族） */
export function familyOf(dbType: DbType): 'mysql' | 'postgresql' | 'sqlite' | 'sqlserver' {
  return dbType === 'mariadb' ? 'mysql' : dbType
}

export function quoteIdent(dbType: DbType, name: string): string {
  const fam = familyOf(dbType)
  if (fam === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  if (fam === 'sqlserver') return '[' + name.replace(/]/g, ']]') + ']'
  return '"' + name.replace(/"/g, '""') + '"'
}

/** 是否带 schema 前缀的表名（PG 的 schema.table / SQL Server 的 dbo.table） */
function hasSchemaPrefix(dbType: DbType): boolean {
  const fam = familyOf(dbType)
  return fam === 'postgresql' || fam === 'sqlserver'
}

/** 表引用：PG / SQL Server 的 "schema.table" 按第一个点分段引用，其余整体引用 */
export function qualifyTable(dbType: DbType, table: string): string {
  if (hasSchemaPrefix(dbType) && table.includes('.')) {
    const i = table.indexOf('.')
    return `${quoteIdent(dbType, table.slice(0, i))}.${quoteIdent(dbType, table.slice(i + 1))}`
  }
  return quoteIdent(dbType, table)
}

/**
 * 分页后缀：SQL Server 用 OFFSET/FETCH（必须有 ORDER BY，没有时补常量排序），
 * 其余方言用 LIMIT/OFFSET。
 */
export function pageClause(dbType: DbType, limit: number, offset: number, hasOrderBy = false): string {
  if (familyOf(dbType) === 'sqlserver') {
    return `${hasOrderBy ? '' : ' ORDER BY (SELECT NULL)'} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
  }
  return ` LIMIT ${limit} OFFSET ${offset}`
}

/** 解析 "varchar(255)" / "decimal(10,2)" / "nvarchar(max)" */
function parseType(columnType: string): { base: string; len?: string; scale?: string; max?: boolean } {
  const t = columnType.trim()
  // 基础类型名可含数字（datetime2 / float8 等）
  const mMax = /^([a-zA-Z_][a-zA-Z_0-9 ]*?)\s*\(\s*max\s*\)$/i.exec(t)
  if (mMax) return { base: mMax[1].trim().toLowerCase(), max: true }
  const m = /^([a-zA-Z_][a-zA-Z_0-9 ]*?)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/.exec(t)
  if (!m) return { base: t.toLowerCase() }
  return { base: m[1].trim().toLowerCase(), len: m[2], scale: m[3] }
}

/**
 * 跨库种类型映射。同族原样返回；异构按规则转换，未知类型回退 text。
 */
export function mapColumnType(srcType: DbType, tgtType: DbType, column: TableColumnInfo): string {
  const srcFam = familyOf(srcType)
  const tgtFam = familyOf(tgtType)
  const columnType = column.columnType ?? column.dataType
  if (srcFam === tgtFam) return columnType

  const parsed = parseType(columnType)
  let { base, len, scale } = parsed
  // SQL Server 源类型先归一化为通用类型名，再走目标方言映射
  if (srcFam === 'sqlserver') {
    if (base === 'nvarchar' || base === 'varchar') base = parsed.max ? 'text' : 'varchar'
    else if (base === 'nchar') base = 'char'
    else if (base === 'ntext') base = 'text'
    else if (base === 'image') base = 'blob'
    else if (base === 'varbinary' || base === 'binary') base = parsed.max ? 'blob' : 'binary'
    else if (base === 'datetime2' || base === 'smalldatetime') base = 'datetime'
    else if (base === 'datetimeoffset') base = 'timestamptz'
    else if (base === 'uniqueidentifier') base = 'uuid'
    else if (base === 'money') {
      base = 'decimal'
      len = '19'
      scale = '4'
    } else if (base === 'smallmoney') {
      base = 'decimal'
      len = '10'
      scale = '4'
    } else if (base === 'float') base = 'double' // SQL Server float 是 8 字节
    else if (base === 'real') base = 'float'
    else if (base === 'bit') base = 'boolean'
  }
  const withLen = (t: string): string =>
    len ? `${t}(${len}${scale ? `,${scale}` : ''})` : t

  if (tgtFam === 'sqlserver') {
    if ((base === 'tinyint' && len === '1') || base === 'boolean' || base === 'bool') return 'bit'
    if (base === 'tinyint') return 'tinyint'
    if (/^(smallint|year|int2)$/.test(base)) return 'smallint'
    if (/^(int|integer|mediumint|serial|int4)$/.test(base)) return 'int'
    if (/^(bigint|int8|bigserial)$/.test(base)) return 'bigint'
    if (/^(decimal|numeric)$/.test(base)) return withLen('decimal')
    if (/^(float|real|float4)$/.test(base)) return 'real'
    if (/^(double|double precision|float8)$/.test(base)) return 'float'
    if (/^(varchar|character varying)$/.test(base)) return len ? `nvarchar(${len})` : 'nvarchar(255)'
    if (/^(char|character|bpchar)$/.test(base)) return len ? `nchar(${len})` : 'nchar(1)'
    if (/text$/.test(base)) return 'nvarchar(max)'
    if (/blob|bytea|binary/.test(base)) return 'varbinary(max)'
    if (/^(datetime|timestamp|timestamptz)$/.test(base)) return 'datetime2'
    if (base === 'date') return 'date'
    if (/^time/.test(base)) return 'time'
    if (/^json/.test(base)) return 'nvarchar(max)'
    if (/^(enum|set)$/.test(base)) return 'nvarchar(255)'
    if (base === 'uuid') return 'uniqueidentifier'
    if (base === 'bit') return len && len !== '1' ? 'varbinary(8)' : 'bit'
    if (base === 'interval') return 'nvarchar(64)'
    return 'nvarchar(max)'
  }

  if (tgtFam === 'sqlite') {
    if (/int|serial|year|bool|bit/.test(base)) return 'INTEGER'
    if (/float|double|real|decimal|numeric/.test(base)) return 'REAL'
    if (/blob|bytea|binary/.test(base)) return 'BLOB'
    return 'TEXT'
  }

  if (tgtFam === 'postgresql') {
    // mysql/sqlite → pg
    if (base === 'tinyint' && len === '1') return 'boolean'
    if (/^(tinyint|smallint)$/.test(base)) return 'smallint'
    if (/^(int|integer|mediumint)$/.test(base)) return 'integer'
    if (base === 'bigint') return 'bigint'
    if (/^(decimal|numeric)$/.test(base)) return withLen('numeric')
    if (base === 'float') return 'real'
    if (/^(double|real)$/.test(base)) return 'double precision'
    if (/^(varchar|character varying)$/.test(base)) return withLen('character varying')
    if (base === 'char') return withLen('character')
    if (/text$/.test(base)) return 'text'
    if (/blob|binary/.test(base)) return 'bytea'
    if (base === 'datetime' || base === 'timestamp') return 'timestamp'
    if (base === 'timestamptz') return 'timestamptz'
    if (base === 'uuid') return 'uuid'
    if (base === 'date') return 'date'
    if (base === 'time') return 'time'
    if (base === 'year') return 'smallint'
    if (base === 'json') return 'jsonb'
    if (/^(enum|set)$/.test(base)) return 'text'
    if (base === 'bit') return len === '1' || !len ? 'boolean' : 'bit varying'
    if (base === 'boolean' || base === 'bool') return 'boolean'
    return 'text'
  }

  // → mysql
  if (base === 'boolean' || base === 'bool') return 'tinyint(1)'
  if (base === 'smallint') return 'smallint'
  if (/^(integer|int|int4)$/.test(base)) return 'int'
  if (/^(bigint|int8|bigserial)$/.test(base)) return 'bigint'
  if (base === 'serial') return 'int'
  if (/^(numeric|decimal)$/.test(base)) return withLen('decimal')
  if (base === 'real' || base === 'float4') return 'float'
  if (/^(double precision|float8)$/.test(base)) return 'double'
  if (/^(character varying|varchar)$/.test(base)) return withLen('varchar')
  if (/^(character|bpchar|char)$/.test(base)) return withLen('char')
  if (base === 'text') return 'text'
  if (base === 'bytea' || base === 'blob') return 'longblob'
  if (/^(timestamp|datetime)/.test(base)) return 'datetime'
  if (base === 'date') return 'date'
  if (/^time/.test(base)) return 'time'
  if (/^json/.test(base)) return 'json'
  if (base === 'uuid') return 'char(36)'
  if (base === 'interval') return 'varchar(64)'
  return 'text'
}

const RAW_DEFAULT = /^(NULL|TRUE|FALSE|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i

function defaultLiteral(v: string): string {
  const t = v.trim()
  if (t === '') return ''
  if (/^-?\d+(\.\d+)?$/.test(t)) return t
  if (RAW_DEFAULT.test(t)) return t.toUpperCase()
  if (t.includes('(') && t.endsWith(')')) return ''
  if (t.startsWith("'") && t.endsWith("'")) return t
  return `'${t.replace(/'/g, "''")}'`
}

export interface BuildCreateOptions {
  includeIndexes: boolean
  srcType: DbType
}

/**
 * 由源表元数据生成目标方言的 CREATE TABLE（+ 可选索引）语句。
 * 跨库种时进行类型映射；默认值仅保留可移植的字面量；不含外键（由 buildFkStatements 单独生成）。
 */
export function buildCreateTable(
  tgtType: DbType,
  table: string,
  meta: TableMeta,
  opts: BuildCreateOptions
): string[] {
  const q = (s: string): string => quoteIdent(tgtType, s)
  const tgtFam = familyOf(tgtType)
  const crossDialect = familyOf(opts.srcType) !== tgtFam
  const lines: string[] = []
  const pk = meta.columns.filter((c) => c.isPrimaryKey)
  const sqliteInlinePk =
    tgtFam === 'sqlite' && pk.length === 1 && /int/i.test(mapColumnType(opts.srcType, tgtType, pk[0]))

  for (const c of meta.columns) {
    if (tgtFam === 'sqlite' && sqliteInlinePk && c.isPrimaryKey) {
      lines.push(`  ${q(c.name)} INTEGER PRIMARY KEY${c.isAutoIncrement ? ' AUTOINCREMENT' : ''}`)
      continue
    }
    let line = `  ${q(c.name)} ${mapColumnType(opts.srcType, tgtType, c)}`
    if (c.isAutoIncrement) {
      if (tgtFam === 'mysql') line += ' AUTO_INCREMENT'
      else if (tgtFam === 'postgresql') line += ' GENERATED BY DEFAULT AS IDENTITY'
      else if (tgtFam === 'sqlserver') line += ' IDENTITY(1,1)'
    } else if (c.defaultValue !== null && c.defaultValue !== undefined) {
      // 跨库种时函数型默认值不可移植，直接丢弃
      let def = crossDialect
        ? defaultLiteral(c.defaultValue)
        : c.defaultValue.includes('(') || RAW_DEFAULT.test(c.defaultValue) || /^-?\d/.test(c.defaultValue)
          ? c.defaultValue
          : `'${c.defaultValue.replace(/'/g, "''")}'`
      // SQL Server 没有 TRUE/FALSE 字面量与 CURRENT_TIMESTAMP 之外的别名
      if (def && crossDialect && tgtFam === 'sqlserver') {
        def = def.replace(/^TRUE$/i, '1').replace(/^FALSE$/i, '0')
      }
      if (def) line += ` DEFAULT ${def}`
    }
    if (!c.nullable) line += ' NOT NULL'
    if (tgtFam === 'mysql' && c.comment) line += ` COMMENT '${c.comment.replace(/'/g, "''")}'`
    lines.push(line)
  }
  if (pk.length > 0 && !sqliteInlinePk) {
    lines.push(`  PRIMARY KEY (${pk.map((c) => q(c.name)).join(', ')})`)
  }

  const statements = [`CREATE TABLE ${qualifyTable(tgtType, table)} (\n${lines.join(',\n')}\n)`]

  if (opts.includeIndexes) {
    for (const i of meta.indexes) {
      // 跨库种不携带索引方法（BTREE/HASH 等不通用）
      const method = !crossDialect && familyOf(tgtType) === 'postgresql' && i.method ? ` USING ${i.method}` : ''
      statements.push(
        `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(`${table}_${i.name}`.slice(0, 60))} ON ${qualifyTable(tgtType, table)}${method} (${i.columns.map(q).join(', ')})`
      )
    }
  }
  return statements
}

/** 生成外键约束语句（建表后统一执行；SQLite 不支持，返回空） */
export function buildFkStatements(tgtType: DbType, table: string, meta: TableMeta): string[] {
  if (familyOf(tgtType) === 'sqlite') return []
  const q = (s: string): string => quoteIdent(tgtType, s)
  return meta.foreignKeys.map(
    (fk) =>
      `ALTER TABLE ${qualifyTable(tgtType, table)} ADD CONSTRAINT ${q(fk.name.slice(0, 60))} FOREIGN KEY (${fk.columns.map(q).join(', ')}) ` +
      `REFERENCES ${qualifyTable(tgtType, fk.refTable)} (${fk.refColumns.map(q).join(', ')})` +
      (fk.onDelete && fk.onDelete !== 'NO ACTION' ? ` ON DELETE ${fk.onDelete}` : '') +
      (fk.onUpdate && fk.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${fk.onUpdate}` : '')
  )
}
