import mssql from 'mssql'
import type {
  ApplyEditsRequest,
  CellValue,
  ConnectionProfile,
  DbObjectInfo,
  DbUserInfo,
  QueryResultSet,
  TableColumnInfo,
  TableDataRequest,
  TableDataResponse,
  TableForeignKeyInfo,
  TableIndexInfo,
  TableMeta,
  TestConnectionResult,
  UserDesign,
  UserPrivileges
} from '@shared/types'
import {
  buildOrderBy,
  buildWhere,
  fromCellValue,
  safeInt,
  toCellValue,
  type DatabaseDriver,
  type SqlParam
} from '../driver'
import { buildSslOption } from '../ssl'
import { MSSQL_SERVER_ROLES, mssqlDropUser, mssqlUserStatements } from '../userSql'

/** SQL Server 单条语句最多 2100 个绑定参数，留余量 */
const MAX_PARAMS = 2000
/** 表值构造器（VALUES 多行）上限 */
const MAX_VALUES_ROWS = 1000

function poolConfig(profile: Partial<ConnectionProfile>, database?: string): mssql.config {
  const ssl = buildSslOption(profile)
  return {
    server: profile.host || '127.0.0.1',
    port: profile.port || 1433,
    user: profile.user || 'sa',
    password: profile.password || '',
    database: database || profile.database || 'master',
    connectionTimeout: 10000,
    requestTimeout: 120000,
    pool: { max: 4, min: 0 },
    arrayRowMode: true,
    options: {
      encrypt: ssl !== undefined,
      // 未启用证书校验时信任服务器证书（自签名场景）
      trustServerCertificate: !(ssl?.rejectUnauthorized ?? false),
      cryptoCredentialsDetails: ssl?.ca ? { ca: ssl.ca } : undefined,
      // 保持 datetime 为服务器本地语义，避免时区偏移
      useUTC: false,
      enableArithAbort: true
    }
  }
}

export async function testSqlServer(profile: Partial<ConnectionProfile>): Promise<TestConnectionResult> {
  const pool = new mssql.ConnectionPool(poolConfig(profile))
  try {
    await pool.connect()
    const res = await pool.request().query('SELECT @@VERSION AS v')
    const version = String(res.recordset?.[0]?.[0] ?? '').split('\n')[0].trim()
    return { ok: true, message: '连接成功', serverVersion: version || 'unknown' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    await pool.close().catch(() => undefined)
  }
}

/** 拆分 "schema.table"，无 schema 时默认 dbo */
function splitTable(table: string): { schema: string; name: string } {
  const idx = table.indexOf('.')
  return idx === -1
    ? { schema: 'dbo', name: table }
    : { schema: table.slice(0, idx), name: table.slice(idx + 1) }
}

/** 由 sys.columns 元数据组装完整类型名，如 nvarchar(50) / decimal(10,2) / varbinary(max) */
function fullTypeName(type: string, maxLength: number, precision: number, scale: number): string {
  if (type === 'varchar' || type === 'char' || type === 'varbinary' || type === 'binary') {
    return `${type}(${maxLength === -1 ? 'max' : maxLength})`
  }
  if (type === 'nvarchar' || type === 'nchar') {
    return `${type}(${maxLength === -1 ? 'max' : maxLength / 2})`
  }
  if (type === 'decimal' || type === 'numeric') {
    return `${type}(${precision},${scale})`
  }
  if (type === 'datetime2' || type === 'datetimeoffset' || type === 'time') {
    return scale === 7 ? type : `${type}(${scale})`
  }
  return type
}

/** 去掉 SQL Server 默认值定义的外层括号：((0)) → 0，(getdate()) → getdate() */
function stripDefault(def: string | null): string | null {
  if (def === null || def === undefined) return null
  let s = def.trim()
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0
    let balanced = true
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === '(') depth++
      else if (s[i] === ')') depth--
      if (depth === 0) {
        balanced = false
        break
      }
    }
    if (!balanced) break
    s = s.slice(1, -1).trim()
  }
  return s
}

/** arrayRowMode 下 recordset.columns 是元数据数组；type 对象带 declaration */
function columnMetas(recordset: mssql.IRecordSet<unknown>): { name: string; dataType: string }[] {
  const cols = recordset.columns as unknown
  const list = Array.isArray(cols) ? cols : Object.values(cols ?? {})
  return (list as { index: number; name: string; type?: unknown }[])
    .sort((a, b) => a.index - b.index)
    .map((c) => ({
      name: c.name,
      dataType: ((c.type as { declaration?: string })?.declaration ?? '').toLowerCase()
    }))
}

export class SqlServerDriver implements DatabaseDriver {
  /** database 与连接绑定，每个库一个连接池（同 PG 模式） */
  private pools = new Map<string, mssql.ConnectionPool>()

  constructor(readonly profile: ConnectionProfile) {}

  quoteIdent(name: string): string {
    return '[' + name.replace(/]/g, ']]') + ']'
  }

  private quoteTable(table: string): string {
    const { schema, name } = splitTable(table)
    return `${this.quoteIdent(schema)}.${this.quoteIdent(name)}`
  }

  private async getPool(database?: string): Promise<mssql.ConnectionPool> {
    const db = database || this.profile.database || 'master'
    const existing = this.pools.get(db)
    if (existing?.connected) return existing
    const pool = new mssql.ConnectionPool(poolConfig(this.profile, db))
    await pool.connect()
    pool.on('error', () => this.pools.delete(db))
    this.pools.set(db, pool)
    return pool
  }

  /** 参数化查询：params 依序绑定为 @p1, @p2 ...；null 用 NVarChar 占位 */
  private async run(
    database: string | undefined,
    sqlText: string,
    params: SqlParam[] = []
  ): Promise<mssql.IResult<unknown[][]>> {
    const pool = await this.getPool(database)
    const request = pool.request()
    params.forEach((v, i) => {
      if (v === null) request.input(`p${i + 1}`, mssql.NVarChar, null)
      else request.input(`p${i + 1}`, v)
    })
    // 泛型为 unknown[][]：recordsets 是结果集数组，每行是 unknown[]（arrayRowMode）
    return request.query<unknown[][]>(sqlText)
  }

  async connect(): Promise<void> {
    await this.getPool()
  }

  async disconnect(): Promise<void> {
    for (const pool of this.pools.values()) {
      await pool.close().catch(() => undefined)
    }
    this.pools.clear()
  }

  async getServerVersion(): Promise<string> {
    const res = await this.run(undefined, 'SELECT @@VERSION AS v')
    return String(res.recordset?.[0]?.[0] ?? '').split('\n')[0].trim()
  }

  async listDatabases(): Promise<string[]> {
    const res = await this.run(
      undefined,
      `SELECT name FROM sys.databases WHERE state = 0
       ORDER BY CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, name`
    )
    return (res.recordset as unknown as unknown[][]).map((r) => String(r[0]))
  }

  /** schema 为 dbo 时省略前缀，其余用 schema.name（同 PG 的 public 约定） */
  private qualify(schema: string, name: string): string {
    return schema === 'dbo' ? name : `${schema}.${name}`
  }

  async listObjects(database: string): Promise<DbObjectInfo[]> {
    const res = await this.run(
      database,
      `SELECT s.name, o.name, CASE o.type
                WHEN 'V' THEN 'view'
                WHEN 'P' THEN 'procedure'
                WHEN 'FN' THEN 'function' WHEN 'IF' THEN 'function' WHEN 'TF' THEN 'function'
                ELSE 'table' END AS obj_type,
              p.rows, CAST(ep.value AS nvarchar(4000)) AS comment, o.modify_date
       FROM sys.objects o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       LEFT JOIN (SELECT object_id, SUM(rows) AS rows FROM sys.partitions
                  WHERE index_id IN (0, 1) GROUP BY object_id) p ON p.object_id = o.object_id
       LEFT JOIN sys.extended_properties ep
         ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description' AND ep.class = 1
       WHERE o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0
       ORDER BY s.name, o.name`
    )
    return (res.recordset as unknown as unknown[][]).map((r) => ({
      name: this.qualify(String(r[0]), String(r[1])),
      objectType: String(r[2]) as DbObjectInfo['objectType'],
      rowCount: r[3] === null ? null : Number(r[3]),
      comment: r[4] === null ? null : String(r[4]),
      modifiedAt: r[5] instanceof Date ? r[5].toISOString() : null
    }))
  }

  async getTableColumns(database: string, table: string): Promise<TableColumnInfo[]> {
    const { schema, name } = splitTable(table)
    const res = await this.run(
      database,
      `SELECT c.name, tp.name AS type_name, c.max_length, c.precision, c.scale,
              c.is_nullable, c.is_identity, dc.definition AS default_def,
              CAST(ep.value AS nvarchar(4000)) AS comment,
              CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS is_pk
       FROM sys.columns c
       JOIN sys.objects o ON o.object_id = c.object_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       JOIN sys.types tp ON tp.user_type_id = c.user_type_id
       LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
       LEFT JOIN sys.extended_properties ep
         ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' AND ep.class = 1
       LEFT JOIN (
         SELECT ic.object_id, ic.column_id
         FROM sys.indexes i
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         WHERE i.is_primary_key = 1
       ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
       WHERE s.name = @p1 AND o.name = @p2
       ORDER BY c.column_id`,
      [schema, name]
    )
    return (res.recordset as unknown as unknown[][]).map((r) => {
      const dataType = String(r[1])
      return {
        name: String(r[0]),
        dataType,
        columnType: fullTypeName(dataType, Number(r[2]), Number(r[3]), Number(r[4])),
        nullable: Boolean(r[5]),
        defaultValue: stripDefault(r[7] === null ? null : String(r[7])),
        isPrimaryKey: Boolean(r[9]),
        isAutoIncrement: Boolean(r[6]),
        comment: r[8] === null ? undefined : String(r[8])
      }
    })
  }

  async getTableMeta(database: string, table: string): Promise<TableMeta> {
    const { schema, name } = splitTable(table)
    const columns = await this.getTableColumns(database, table)

    const idxRes = await this.run(
      database,
      `SELECT i.name, i.is_unique, i.type_desc, col.name AS col_name
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
       JOIN sys.objects o ON o.object_id = i.object_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE s.name = @p1 AND o.name = @p2
         AND i.is_primary_key = 0 AND i.is_unique_constraint = 0
         AND i.type > 0 AND i.name IS NOT NULL AND ic.is_included_column = 0
       ORDER BY i.name, ic.key_ordinal`,
      [schema, name]
    )
    const idxMap = new Map<string, TableIndexInfo>()
    for (const r of idxRes.recordset as unknown as unknown[][]) {
      const idxName = String(r[0])
      let idx = idxMap.get(idxName)
      if (!idx) {
        idx = { name: idxName, columns: [], unique: Boolean(r[1]), method: String(r[2]) }
        idxMap.set(idxName, idx)
      }
      idx.columns.push(String(r[3]))
    }

    const fkRes = await this.run(
      database,
      `SELECT fk.name, pc.name AS col, rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_col,
              fk.update_referential_action_desc AS upd, fk.delete_referential_action_desc AS del
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
       JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
       JOIN sys.objects o ON o.object_id = fk.parent_object_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id
       JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
       WHERE s.name = @p1 AND o.name = @p2
       ORDER BY fk.name, fkc.constraint_column_id`,
      [schema, name]
    )
    const fkMap = new Map<string, TableForeignKeyInfo>()
    for (const r of fkRes.recordset as unknown as unknown[][]) {
      const fkName = String(r[0])
      let fk = fkMap.get(fkName)
      if (!fk) {
        fk = {
          name: fkName,
          columns: [],
          refTable: this.qualify(String(r[2]), String(r[3])),
          refColumns: [],
          onUpdate: String(r[5]).replace(/_/g, ' '),
          onDelete: String(r[6]).replace(/_/g, ' ')
        }
        fkMap.set(fkName, fk)
      }
      fk.columns.push(String(r[1]))
      fk.refColumns.push(String(r[4]))
    }

    const extraRes = await this.run(
      database,
      `SELECT CAST(ep.value AS nvarchar(4000)) AS comment,
              (SELECT TOP 1 kc.name FROM sys.key_constraints kc
               WHERE kc.parent_object_id = o.object_id AND kc.type = 'PK') AS pk_name
       FROM sys.objects o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       LEFT JOIN sys.extended_properties ep
         ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description' AND ep.class = 1
       WHERE s.name = @p1 AND o.name = @p2`,
      [schema, name]
    )
    const extra = (extraRes.recordset as unknown as unknown[][])[0]

    return {
      columns,
      indexes: [...idxMap.values()],
      foreignKeys: [...fkMap.values()],
      comment: extra?.[0] === null || extra?.[0] === undefined ? undefined : String(extra[0]),
      pkConstraint: extra?.[1] === null || extra?.[1] === undefined ? undefined : String(extra[1])
    }
  }

  async query(sql: string, database?: string): Promise<QueryResultSet[]> {
    const pool = await this.getPool(database)
    const start = performance.now()
    const res = await pool.request().query<unknown[][]>(sql)
    const durationMs = Math.round(performance.now() - start)

    const recordsets = (res.recordsets ?? []) as mssql.IRecordSet<unknown[]>[]
    if (recordsets.length === 0) {
      const affected = (res.rowsAffected ?? []).reduce((a, b) => a + b, 0)
      return [{ columns: [], rows: [], affectedRows: affected, durationMs }]
    }
    return recordsets.map((rs) => ({
      columns: columnMetas(rs),
      rows: (rs as unknown as unknown[][]).map((row) => row.map(toCellValue)),
      affectedRows: null,
      durationMs
    }))
  }

  private toResultSet(rs: mssql.IRecordSet<unknown[]> | undefined, durationMs: number): QueryResultSet {
    if (!rs) return { columns: [], rows: [], affectedRows: 0, durationMs }
    return {
      columns: columnMetas(rs),
      rows: (rs as unknown as unknown[][]).map((row) => row.map(toCellValue)),
      affectedRows: null,
      durationMs
    }
  }

  async getTableData(req: TableDataRequest): Promise<TableDataResponse> {
    const q = this.quoteIdent.bind(this)
    const table = this.quoteTable(req.table)
    const { clause, params } = buildWhere(req.filters, q, (i) => `@p${i}`)
    // OFFSET/FETCH 必须有 ORDER BY，无排序时用常量排序
    const orderBy = buildOrderBy(req.sorts, q) || ' ORDER BY (SELECT NULL)'
    const limit = safeInt(req.limit, 1000)
    const offset = safeInt(req.offset, 0)

    const start = performance.now()
    const res = await this.run(
      req.database,
      `SELECT * FROM ${table}${clause}${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
      params as SqlParam[]
    )
    const durationMs = Math.round(performance.now() - start)

    const countRes = await this.run(
      req.database,
      `SELECT COUNT_BIG(*) AS c FROM ${table}${clause}`,
      params as SqlParam[]
    )
    const totalRows = Number((countRes.recordset as unknown as unknown[][])[0]?.[0] ?? 0)

    const columns = await this.getTableColumns(req.database, req.table)
    return {
      result: this.toResultSet(res.recordsets?.[0] as mssql.IRecordSet<unknown[]>, durationMs),
      totalRows,
      columns
    }
  }

  async getObjectDDL(database: string, objectType: 'table' | 'view', name: string): Promise<string> {
    const { schema, name: bare } = splitTable(name)
    const q = this.quoteIdent.bind(this)
    const table = this.quoteTable(name)

    if (objectType === 'view') {
      const res = await this.run(
        database,
        `SELECT m.definition FROM sys.sql_modules m
         JOIN sys.objects o ON o.object_id = m.object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         WHERE s.name = @p1 AND o.name = @p2`,
        [schema, bare]
      )
      const def = String((res.recordset as unknown as unknown[][])[0]?.[0] ?? '')
      return def.trim() || `-- 未找到视图 ${name} 的定义`
    }

    // 表 DDL 从元数据组装（不含外键，外键由备份流程统一后置）
    const meta = await this.getTableMeta(database, name)
    const lines: string[] = []
    for (const c of meta.columns) {
      let line = `  ${q(c.name)} ${c.columnType ?? c.dataType}`
      if (c.isAutoIncrement) {
        line += ' IDENTITY(1,1)'
      } else if (c.defaultValue !== null) {
        line += ` DEFAULT ${c.defaultValue}`
      }
      line += c.nullable ? ' NULL' : ' NOT NULL'
      lines.push(line)
    }
    const pk = meta.columns.filter((c) => c.isPrimaryKey)
    if (pk.length > 0) {
      lines.push(`  PRIMARY KEY (${pk.map((c) => q(c.name)).join(', ')})`)
    }
    const statements = [`CREATE TABLE ${table} (\n${lines.join(',\n')}\n)`]
    for (const i of meta.indexes) {
      statements.push(
        `CREATE ${i.unique ? 'UNIQUE ' : ''}${i.method === 'CLUSTERED' ? 'CLUSTERED ' : ''}INDEX ${q(i.name)} ` +
          `ON ${table} (${i.columns.map(q).join(', ')})`
      )
    }
    return statements.join(';\n')
  }

  /** 返回参与插入的自增（identity）列，决定是否需要 IDENTITY_INSERT 包裹 */
  private async identityColumns(database: string, table: string, columns: string[]): Promise<string[]> {
    const meta = await this.getTableColumns(database, table)
    const set = new Set(columns)
    return meta.filter((c) => c.isAutoIncrement && set.has(c.name)).map((c) => c.name)
  }

  async insertRows(
    database: string,
    table: string,
    columns: string[],
    rows: CellValue[][]
  ): Promise<number> {
    if (rows.length === 0) return 0
    const q = this.quoteIdent.bind(this)
    const target = this.quoteTable(table)
    const needIdentityInsert = (await this.identityColumns(database, table, columns)).length > 0
    const chunkSize = Math.max(1, Math.min(MAX_VALUES_ROWS, Math.floor(MAX_PARAMS / columns.length)))

    let inserted = 0
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize)
      let p = 0
      const values = chunk.map((r) => `(${r.map(() => `@p${++p}`).join(', ')})`).join(', ')
      let sqlText = `INSERT INTO ${target} (${columns.map(q).join(', ')}) VALUES ${values}`
      if (needIdentityInsert) {
        // 同一批次内开关，保证与 INSERT 在同一会话
        sqlText = `SET IDENTITY_INSERT ${target} ON;\n${sqlText};\nSET IDENTITY_INSERT ${target} OFF;`
      }
      const res = await this.run(database, sqlText, chunk.flat().map(fromCellValue))
      inserted += res.rowsAffected.reduce((a, b) => a + b, 0) || chunk.length
    }
    return inserted
  }

  async truncateTable(database: string, table: string): Promise<void> {
    await this.run(database, `TRUNCATE TABLE ${this.quoteTable(table)}`)
  }

  async applyEdits(req: ApplyEditsRequest): Promise<number> {
    const pool = await this.getPool(req.database)
    const q = this.quoteIdent.bind(this)
    const table = this.quoteTable(req.table)
    let affected = 0

    const tx = pool.transaction()
    await tx.begin()
    try {
      for (const change of req.changes) {
        const request = tx.request()
        let p = 0
        const bind = (v: CellValue): string => {
          const param = fromCellValue(v)
          p++
          if (param === null) request.input(`p${p}`, mssql.NVarChar, null)
          else request.input(`p${p}`, param)
          return `@p${p}`
        }
        // NULL 键直接写 IS NULL，避免参数化 NULL 的比较语义问题
        const keyCond = (keys: Record<string, CellValue>): string =>
          Object.keys(keys)
            .map((c) => (keys[c] === null ? `${q(c)} IS NULL` : `${q(c)} = ${bind(keys[c])}`))
            .join(' AND ')

        if (change.kind === 'update') {
          const setCols = Object.keys(change.values)
          if (setCols.length === 0) continue
          const setClause = setCols.map((c) => `${q(c)} = ${bind(change.values[c])}`).join(', ')
          const res = await request.query(`UPDATE ${table} SET ${setClause} WHERE ${keyCond(change.keys)}`)
          affected += res.rowsAffected.reduce((a, b) => a + b, 0)
        } else if (change.kind === 'insert') {
          const cols = Object.keys(change.values)
          const sqlText = cols.length
            ? `INSERT INTO ${table} (${cols.map(q).join(', ')}) VALUES (${cols.map((c) => bind(change.values[c])).join(', ')})`
            : `INSERT INTO ${table} DEFAULT VALUES`
          const res = await request.query(sqlText)
          affected += res.rowsAffected.reduce((a, b) => a + b, 0)
        } else {
          const res = await request.query(`DELETE FROM ${table} WHERE ${keyCond(change.keys)}`)
          affected += res.rowsAffected.reduce((a, b) => a + b, 0)
        }
      }
      await tx.commit()
    } catch (e) {
      await tx.rollback().catch(() => undefined)
      throw e
    }
    return affected
  }

  /* ===== 用户与权限：SQL Server 登录名 + 固定服务器角色 ===== */

  private async roleMembers(): Promise<Map<string, string[]>> {
    const res = await this.run(
      undefined,
      `SELECT r.name AS role_name, m.name AS member_name
       FROM sys.server_role_members rm
       JOIN sys.server_principals r ON r.principal_id = rm.role_principal_id
       JOIN sys.server_principals m ON m.principal_id = rm.member_principal_id`
    )
    const map = new Map<string, string[]>()
    for (const r of res.recordset as unknown as unknown[][]) {
      const member = String(r[1])
      const list = map.get(member) ?? []
      list.push(String(r[0]))
      map.set(member, list)
    }
    return map
  }

  async listUsers(): Promise<DbUserInfo[]> {
    const res = await this.run(
      undefined,
      `SELECT name, type_desc, is_disabled FROM sys.server_principals
       WHERE type IN ('S', 'U') AND name NOT LIKE '##%' ORDER BY name`
    )
    const roles = await this.roleMembers()
    return (res.recordset as unknown as unknown[][]).map((r) => {
      const name = String(r[0])
      const attrs = [...(roles.get(name) ?? [])]
      if (String(r[1]) === 'WINDOWS_LOGIN') attrs.unshift('WINDOWS')
      if (Boolean(r[2])) attrs.push('DISABLED')
      return { name, attributes: attrs }
    })
  }

  async getUserPrivileges(name: string): Promise<UserPrivileges> {
    const roles = await this.roleMembers()
    return {
      granted: (roles.get(name) ?? []).filter((r) => MSSQL_SERVER_ROLES.includes(r)),
      available: MSSQL_SERVER_ROLES
    }
  }

  async saveUser(design: UserDesign): Promise<void> {
    let currentRoles: string[] | null = null
    if (design.originalName) {
      currentRoles = (await this.getUserPrivileges(design.originalName)).granted
    }
    for (const stmt of mssqlUserStatements(design, currentRoles)) {
      await this.run(undefined, stmt)
    }
  }

  async dropUser(name: string): Promise<void> {
    await this.run(undefined, mssqlDropUser(name))
  }
}
