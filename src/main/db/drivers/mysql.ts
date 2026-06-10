import mysql from 'mysql2/promise'
import type { Connection, FieldPacket, ResultSetHeader } from 'mysql2/promise'
import { Types } from 'mysql2'
import type {
  ApplyEditsRequest,
  CellValue,
  ConnectionProfile,
  DbUserInfo,
  UserDesign,
  UserPrivileges,
  DbObjectInfo,
  QueryResultSet,
  TableColumnInfo,
  TableDataRequest,
  TableDataResponse,
  TableMeta,
  TestConnectionResult
} from '@shared/types'
import {
  buildOrderBy,
  buildWhere,
  fromCellValue,
  safeInt,
  toCellValue,
  type DatabaseDriver
} from '../driver'
import { buildSslOption } from '../ssl'
import { MYSQL_PRIVILEGES, mysqlDropUser, mysqlUserStatements } from '../userSql'

const TYPE_NAMES: Record<number, string> = {
  [Types.DECIMAL]: 'decimal',
  [Types.TINY]: 'tinyint',
  [Types.SHORT]: 'smallint',
  [Types.LONG]: 'int',
  [Types.FLOAT]: 'float',
  [Types.DOUBLE]: 'double',
  [Types.NULL]: 'null',
  [Types.TIMESTAMP]: 'timestamp',
  [Types.LONGLONG]: 'bigint',
  [Types.INT24]: 'mediumint',
  [Types.DATE]: 'date',
  [Types.TIME]: 'time',
  [Types.DATETIME]: 'datetime',
  [Types.YEAR]: 'year',
  [Types.NEWDATE]: 'date',
  [Types.VARCHAR]: 'varchar',
  [Types.BIT]: 'bit',
  [Types.JSON]: 'json',
  [Types.NEWDECIMAL]: 'decimal',
  [Types.ENUM]: 'enum',
  [Types.SET]: 'set',
  [Types.TINY_BLOB]: 'tinyblob',
  [Types.MEDIUM_BLOB]: 'mediumblob',
  [Types.LONG_BLOB]: 'longblob',
  [Types.BLOB]: 'blob',
  [Types.VAR_STRING]: 'varchar',
  [Types.STRING]: 'char',
  [Types.GEOMETRY]: 'geometry'
}

function connectOptions(profile: Partial<ConnectionProfile>): mysql.ConnectionOptions {
  return {
    host: profile.host || '127.0.0.1',
    port: profile.port || 3306,
    user: profile.user || 'root',
    password: profile.password || '',
    multipleStatements: true,
    dateStrings: true,
    ssl: buildSslOption(profile),
    connectTimeout: 10000
  }
}

export async function testMySql(profile: Partial<ConnectionProfile>): Promise<TestConnectionResult> {
  let conn: Connection | null = null
  try {
    conn = await mysql.createConnection(connectOptions(profile))
    const [rows] = await conn.query('SELECT VERSION() AS v')
    const version = (rows as { v: string }[])[0]?.v ?? 'unknown'
    return { ok: true, message: '连接成功', serverVersion: version }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    await conn?.end().catch(() => undefined)
  }
}

export class MySqlDriver implements DatabaseDriver {
  private conn: Connection | null = null
  private currentDb: string | null = null

  constructor(readonly profile: ConnectionProfile) {}

  quoteIdent(name: string): string {
    return '`' + name.replace(/`/g, '``') + '`'
  }

  private get connection(): Connection {
    if (!this.conn) throw new Error('连接未打开')
    return this.conn
  }

  async connect(): Promise<void> {
    this.conn = await mysql.createConnection(connectOptions(this.profile))
  }

  async disconnect(): Promise<void> {
    await this.conn?.end().catch(() => undefined)
    this.conn = null
    this.currentDb = null
  }

  async getServerVersion(): Promise<string> {
    const [rows] = await this.connection.query('SELECT VERSION() AS v')
    return (rows as { v: string }[])[0]?.v ?? 'unknown'
  }

  private async useDatabase(database?: string): Promise<void> {
    if (database && database !== this.currentDb) {
      await this.connection.query(`USE ${this.quoteIdent(database)}`)
      this.currentDb = database
    }
  }

  async listDatabases(): Promise<string[]> {
    const [rows] = await this.connection.query('SHOW DATABASES')
    return (rows as { Database: string }[]).map((r) => r.Database).sort((a, b) => a.localeCompare(b))
  }

  async listObjects(database: string): Promise<DbObjectInfo[]> {
    const [tables] = await this.connection.query(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS rowCount,
              TABLE_COMMENT AS comment, COALESCE(UPDATE_TIME, CREATE_TIME) AS modifiedAt
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [database]
    )
    const [routines] = await this.connection.query(
      `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, LAST_ALTERED AS modifiedAt
       FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`,
      [database]
    )
    const objects: DbObjectInfo[] = []
    for (const t of tables as Record<string, unknown>[]) {
      objects.push({
        name: String(t.name),
        objectType: t.type === 'VIEW' ? 'view' : 'table',
        rowCount: t.rowCount === null ? null : Number(t.rowCount),
        engine: (t.engine as string) ?? null,
        comment: (t.comment as string) || null,
        modifiedAt: t.modifiedAt ? String(t.modifiedAt) : null
      })
    }
    for (const r of routines as Record<string, unknown>[]) {
      objects.push({
        name: String(r.name),
        objectType: r.type === 'PROCEDURE' ? 'procedure' : 'function',
        modifiedAt: r.modifiedAt ? String(r.modifiedAt) : null
      })
    }
    return objects
  }

  async getTableColumns(database: string, table: string): Promise<TableColumnInfo[]> {
    const [rows] = await this.connection.query(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
              IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue,
              COLUMN_KEY AS columnKey, EXTRA AS extra, COLUMN_COMMENT AS comment
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [database, table]
    )
    return (rows as Record<string, unknown>[]).map((r) => ({
      name: String(r.name),
      dataType: String(r.dataType),
      columnType: String(r.columnType),
      nullable: r.nullable === 'YES',
      defaultValue: r.defaultValue === null ? null : String(r.defaultValue),
      isPrimaryKey: r.columnKey === 'PRI',
      isAutoIncrement: String(r.extra ?? '').includes('auto_increment'),
      comment: String(r.comment ?? '')
    }))
  }

  async getTableMeta(database: string, table: string): Promise<TableMeta> {
    const columns = await this.getTableColumns(database, table)

    const [idxRows] = await this.connection.query(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, INDEX_TYPE AS method,
              COLUMN_NAME AS columnName, SEQ_IN_INDEX AS seq
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [database, table]
    )
    const idxMap = new Map<string, { unique: boolean; method?: string; columns: string[] }>()
    for (const r of idxRows as Record<string, unknown>[]) {
      const name = String(r.name)
      if (name === 'PRIMARY') continue
      const entry = idxMap.get(name) ?? {
        unique: Number(r.nonUnique) === 0,
        method: r.method ? String(r.method) : undefined,
        columns: []
      }
      entry.columns.push(String(r.columnName))
      idxMap.set(name, entry)
    }

    const [fkRows] = await this.connection.query(
      `SELECT kcu.CONSTRAINT_NAME AS name, kcu.COLUMN_NAME AS columnName,
              kcu.REFERENCED_TABLE_NAME AS refTable, kcu.REFERENCED_COLUMN_NAME AS refColumn,
              rc.UPDATE_RULE AS onUpdate, rc.DELETE_RULE AS onDelete, kcu.ORDINAL_POSITION AS seq
       FROM information_schema.KEY_COLUMN_USAGE kcu
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
       WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
      [database, table]
    )
    const fkMap = new Map<
      string,
      { columns: string[]; refTable: string; refColumns: string[]; onUpdate: string; onDelete: string }
    >()
    for (const r of fkRows as Record<string, unknown>[]) {
      const name = String(r.name)
      const entry = fkMap.get(name) ?? {
        columns: [],
        refTable: String(r.refTable),
        refColumns: [],
        onUpdate: String(r.onUpdate),
        onDelete: String(r.onDelete)
      }
      entry.columns.push(String(r.columnName))
      entry.refColumns.push(String(r.refColumn))
      fkMap.set(name, entry)
    }

    const [tblRows] = await this.connection.query(
      `SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_COMMENT AS comment
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, table]
    )
    const tbl = (tblRows as Record<string, unknown>[])[0] ?? {}
    const collation = tbl.collation ? String(tbl.collation) : undefined

    return {
      columns,
      indexes: [...idxMap.entries()].map(([name, i]) => ({ name, ...i })),
      foreignKeys: [...fkMap.entries()].map(([name, f]) => ({ name, ...f })),
      comment: tbl.comment ? String(tbl.comment) : undefined,
      engine: tbl.engine ? String(tbl.engine) : undefined,
      collation,
      charset: collation ? collation.split('_')[0] : undefined
    }
  }

  async query(sql: string, database?: string): Promise<QueryResultSet[]> {
    await this.useDatabase(database)
    const start = performance.now()
    const [results, fields] = await this.connection.query({ sql, rowsAsArray: true })
    const durationMs = Math.round(performance.now() - start)

    // multipleStatements 时 results / fields 为按语句的数组
    const isMulti = Array.isArray(fields) && fields.some((f) => Array.isArray(f))
    const resultList = (isMulti ? results : [results]) as unknown[]
    const fieldList = (isMulti ? fields : [fields]) as (FieldPacket[] | undefined)[]

    return resultList.map((res, i) => {
      const f = fieldList[i]
      if (Array.isArray(res) && f) {
        return {
          columns: f.map((fp) => ({
            name: fp.name,
            dataType: TYPE_NAMES[fp.type ?? -1] ?? 'unknown'
          })),
          rows: (res as unknown[][]).map((row) => row.map(toCellValue)),
          affectedRows: null,
          durationMs
        }
      }
      const header = res as ResultSetHeader
      return {
        columns: [],
        rows: [],
        affectedRows: header?.affectedRows ?? 0,
        durationMs
      }
    })
  }

  async getTableData(req: TableDataRequest): Promise<TableDataResponse> {
    const q = this.quoteIdent.bind(this)
    const table = `${q(req.database)}.${q(req.table)}`
    const { clause, params } = buildWhere(req.filters, q, () => '?')
    const orderBy = buildOrderBy(req.sorts, q)
    const limit = safeInt(req.limit, 1000)
    const offset = safeInt(req.offset, 0)

    const start = performance.now()
    const [rows, fields] = await this.connection.query({
      sql: `SELECT * FROM ${table}${clause}${orderBy} LIMIT ${limit} OFFSET ${offset}`,
      values: params,
      rowsAsArray: true
    })
    const durationMs = Math.round(performance.now() - start)

    const [countRows] = await this.connection.query({
      sql: `SELECT COUNT(*) AS c FROM ${table}${clause}`,
      values: params
    })
    const totalRows = Number((countRows as { c: unknown }[])[0]?.c ?? 0)

    const columns = await this.getTableColumns(req.database, req.table)
    return {
      result: {
        columns: (fields as FieldPacket[]).map((fp) => ({
          name: fp.name,
          dataType: TYPE_NAMES[fp.type ?? -1] ?? 'unknown'
        })),
        rows: (rows as unknown[][]).map((row) => row.map(toCellValue)),
        affectedRows: null,
        durationMs
      },
      totalRows,
      columns
    }
  }

  async getObjectDDL(database: string, objectType: 'table' | 'view', name: string): Promise<string> {
    const q = this.quoteIdent.bind(this)
    const kind = objectType === 'view' ? 'VIEW' : 'TABLE'
    const [rows] = await this.connection.query(`SHOW CREATE ${kind} ${q(database)}.${q(name)}`)
    const row = (rows as Record<string, string>[])[0] ?? {}
    return row['Create Table'] ?? row['Create View'] ?? ''
  }

  async listUsers(): Promise<DbUserInfo[]> {
    const [rows] = await this.connection.query(
      'SELECT User AS name, Host AS host FROM mysql.user ORDER BY User, Host'
    )
    return (rows as { name: string; host: string }[]).map((r) => ({ name: r.name, host: r.host }))
  }

  async getUserPrivileges(name: string, host?: string): Promise<UserPrivileges> {
    const grantee = `'${name.replace(/\\/g, '\\\\').replace(/'/g, "''")}'@'${(host || '%').replace(/'/g, "''")}'`
    const [rows] = await this.connection.query(
      'SELECT PRIVILEGE_TYPE AS p FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ?',
      [grantee]
    )
    const granted = (rows as { p: string }[]).map((r) => r.p).filter((p) => p !== 'USAGE')
    return { granted, available: MYSQL_PRIVILEGES }
  }

  async saveUser(design: UserDesign): Promise<void> {
    let currentPrivs: string[] | null = null
    if (design.originalName) {
      currentPrivs = (await this.getUserPrivileges(design.originalName, design.originalHost)).granted
    }
    for (const stmt of mysqlUserStatements(design, currentPrivs)) {
      await this.connection.query(stmt)
    }
    await this.connection.query('FLUSH PRIVILEGES')
  }

  async dropUser(name: string, host?: string): Promise<void> {
    await this.connection.query(mysqlDropUser(name, host))
  }

  async insertRows(
    database: string,
    table: string,
    columns: string[],
    rows: CellValue[][]
  ): Promise<number> {
    if (rows.length === 0) return 0
    const q = this.quoteIdent.bind(this)
    const target = `${q(database)}.${q(table)}`
    const placeholders = `(${columns.map(() => '?').join(', ')})`
    const sql = `INSERT INTO ${target} (${columns.map(q).join(', ')}) VALUES ${rows
      .map(() => placeholders)
      .join(', ')}`
    const params = rows.flat().map(fromCellValue)
    const [res] = await this.connection.query(sql, params)
    return (res as ResultSetHeader).affectedRows
  }

  async truncateTable(database: string, table: string): Promise<void> {
    const q = this.quoteIdent.bind(this)
    await this.connection.query(`TRUNCATE TABLE ${q(database)}.${q(table)}`)
  }

  async applyEdits(req: ApplyEditsRequest): Promise<number> {
    const q = this.quoteIdent.bind(this)
    const table = `${q(req.database)}.${q(req.table)}`
    let affected = 0
    await this.connection.beginTransaction()
    try {
      for (const change of req.changes) {
        if (change.kind === 'update') {
          const setCols = Object.keys(change.values)
          const keyCols = Object.keys(change.keys)
          if (setCols.length === 0) continue
          const sql = `UPDATE ${table} SET ${setCols.map((c) => `${q(c)} = ?`).join(', ')} WHERE ${keyCols.map((c) => `${q(c)} <=> ?`).join(' AND ')}`
          const params = [
            ...setCols.map((c) => fromCellValue(change.values[c])),
            ...keyCols.map((c) => fromCellValue(change.keys[c]))
          ]
          const [res] = await this.connection.execute(sql, params)
          affected += (res as ResultSetHeader).affectedRows
        } else if (change.kind === 'insert') {
          const cols = Object.keys(change.values)
          const sql = cols.length
            ? `INSERT INTO ${table} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
            : `INSERT INTO ${table} () VALUES ()`
          const [res] = await this.connection.execute(
            sql,
            cols.map((c) => fromCellValue(change.values[c]))
          )
          affected += (res as ResultSetHeader).affectedRows
        } else {
          const keyCols = Object.keys(change.keys)
          const sql = `DELETE FROM ${table} WHERE ${keyCols.map((c) => `${q(c)} <=> ?`).join(' AND ')}`
          const [res] = await this.connection.execute(
            sql,
            keyCols.map((c) => fromCellValue(change.keys[c]))
          )
          affected += (res as ResultSetHeader).affectedRows
        }
      }
      await this.connection.commit()
    } catch (e) {
      await this.connection.rollback().catch(() => undefined)
      throw e
    }
    return affected
  }
}
