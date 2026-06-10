import Database from 'better-sqlite3'
import { existsSync } from 'fs'
import type {
  ApplyEditsRequest,
  CellValue,
  ConnectionProfile,
  DbUserInfo,
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
// better-sqlite3 的 prepare 仅支持单条语句，需先拆分
import { splitStatements } from '../sqlSplit'

export async function testSqlite(profile: Partial<ConnectionProfile>): Promise<TestConnectionResult> {
  try {
    if (!profile.filePath) return { ok: false, message: '请填写数据库文件路径' }
    const db = new Database(profile.filePath, { fileMustExist: existsSync(profile.filePath) })
    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
    db.close()
    return { ok: true, message: '连接成功', serverVersion: `SQLite ${row.v}` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}


export class SqliteDriver implements DatabaseDriver {
  private db: Database.Database | null = null

  constructor(readonly profile: ConnectionProfile) {}

  quoteIdent(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"'
  }

  private get database(): Database.Database {
    if (!this.db) throw new Error('连接未打开')
    return this.db
  }

  async connect(): Promise<void> {
    if (!this.profile.filePath) throw new Error('SQLite 连接需要数据库文件路径')
    this.db = new Database(this.profile.filePath)
    this.db.pragma('journal_mode = WAL')
  }

  async disconnect(): Promise<void> {
    this.db?.close()
    this.db = null
  }

  async getServerVersion(): Promise<string> {
    const row = this.database.prepare('SELECT sqlite_version() AS v').get() as { v: string }
    return `SQLite ${row.v}`
  }

  async listDatabases(): Promise<string[]> {
    return ['main']
  }

  async listObjects(_database: string): Promise<DbObjectInfo[]> {
    const rows = this.database
      .prepare(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`
      )
      .all() as { name: string; type: string }[]
    return rows.map((r) => {
      let rowCount: number | null = null
      if (r.type === 'table') {
        try {
          const c = this.database
            .prepare(`SELECT COUNT(*) AS c FROM ${this.quoteIdent(r.name)}`)
            .get() as { c: number }
          rowCount = c.c
        } catch {
          rowCount = null
        }
      }
      return {
        name: r.name,
        objectType: r.type === 'view' ? ('view' as const) : ('table' as const),
        rowCount
      }
    })
  }

  async getTableColumns(_database: string, table: string): Promise<TableColumnInfo[]> {
    const rows = this.database
      .prepare(`PRAGMA table_info(${this.quoteIdent(table)})`)
      .all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[]
    return rows.map((r) => ({
      name: r.name,
      dataType: r.type || 'text',
      columnType: r.type || 'text',
      nullable: r.notnull === 0,
      defaultValue: r.dflt_value,
      isPrimaryKey: r.pk > 0,
      // INTEGER PRIMARY KEY 即 rowid 别名，行为等同自增
      isAutoIncrement: r.pk > 0 && (r.type || '').toUpperCase() === 'INTEGER'
    }))
  }

  async getTableMeta(_database: string, table: string): Promise<TableMeta> {
    const columns = await this.getTableColumns(_database, table)

    const idxList = this.database
      .prepare(`PRAGMA index_list(${this.quoteIdent(table)})`)
      .all() as { name: string; unique: number; origin: string }[]
    const indexes = idxList
      // origin: c = CREATE INDEX 创建；pk/u 为约束自动生成，不在索引页展示
      .filter((i) => i.origin === 'c')
      .map((i) => {
        const cols = this.database
          .prepare(`PRAGMA index_info(${this.quoteIdent(i.name)})`)
          .all() as { name: string | null; seqno: number }[]
        return {
          name: i.name,
          unique: i.unique === 1,
          columns: cols
            .sort((a, b) => a.seqno - b.seqno)
            .map((c) => c.name ?? '')
            .filter(Boolean)
        }
      })

    const fkList = this.database
      .prepare(`PRAGMA foreign_key_list(${this.quoteIdent(table)})`)
      .all() as {
      id: number
      seq: number
      table: string
      from: string
      to: string | null
      on_update: string
      on_delete: string
    }[]
    const fkMap = new Map<
      number,
      { columns: string[]; refTable: string; refColumns: string[]; onUpdate: string; onDelete: string }
    >()
    for (const fk of fkList.sort((a, b) => a.id - b.id || a.seq - b.seq)) {
      const entry = fkMap.get(fk.id) ?? {
        columns: [],
        refTable: fk.table,
        refColumns: [],
        onUpdate: fk.on_update,
        onDelete: fk.on_delete
      }
      entry.columns.push(fk.from)
      if (fk.to) entry.refColumns.push(fk.to)
      fkMap.set(fk.id, entry)
    }

    return {
      columns,
      indexes,
      foreignKeys: [...fkMap.entries()].map(([id, f]) => ({ name: `fk_${table}_${id}`, ...f }))
    }
  }

  async query(sql: string, _database?: string): Promise<QueryResultSet[]> {
    const results: QueryResultSet[] = []
    for (const statement of splitStatements(sql)) {
      const start = performance.now()
      const stmt = this.database.prepare(statement)
      if (stmt.reader) {
        const cols = stmt.columns()
        const rows = stmt.raw(true).all() as unknown[][]
        results.push({
          columns: cols.map((c) => ({ name: c.name, dataType: c.type ?? 'unknown' })),
          rows: rows.map((row) => row.map(toCellValue)),
          affectedRows: null,
          durationMs: Math.round(performance.now() - start),
          statement
        })
      } else {
        const info = stmt.run()
        results.push({
          columns: [],
          rows: [],
          affectedRows: info.changes,
          durationMs: Math.round(performance.now() - start),
          statement
        })
      }
    }
    return results
  }

  async getTableData(req: TableDataRequest): Promise<TableDataResponse> {
    const q = this.quoteIdent.bind(this)
    const table = q(req.table)
    const { clause, params } = buildWhere(req.filters, q, () => '?')
    const orderBy = buildOrderBy(req.sorts, q)
    const limit = safeInt(req.limit, 1000)
    const offset = safeInt(req.offset, 0)

    const start = performance.now()
    const stmt = this.database.prepare(
      `SELECT * FROM ${table}${clause}${orderBy} LIMIT ${limit} OFFSET ${offset}`
    )
    const cols = stmt.columns()
    const rows = stmt.raw(true).all(...params) as unknown[][]
    const durationMs = Math.round(performance.now() - start)

    const countRow = this.database
      .prepare(`SELECT COUNT(*) AS c FROM ${table}${clause}`)
      .get(...params) as { c: number }

    const columns = await this.getTableColumns(req.database, req.table)
    return {
      result: {
        columns: cols.map((c) => ({ name: c.name, dataType: c.type ?? 'unknown' })),
        rows: rows.map((row) => row.map(toCellValue)),
        affectedRows: null,
        durationMs
      },
      totalRows: countRow.c,
      columns
    }
  }

  async getObjectDDL(_database: string, _objectType: 'table' | 'view', name: string): Promise<string> {
    const rows = this.database
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE (name = ? OR (type = 'index' AND tbl_name = ?)) AND sql IS NOT NULL
         ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 ELSE 2 END`
      )
      .all(name, name) as { sql: string }[]
    return rows.map((r) => r.sql).join(';\n')
  }

  async listUsers(): Promise<DbUserInfo[]> {
    throw new Error('SQLite 不支持用户管理')
  }

  async getUserPrivileges(): Promise<UserPrivileges> {
    throw new Error('SQLite 不支持用户管理')
  }

  async saveUser(): Promise<void> {
    throw new Error('SQLite 不支持用户管理')
  }

  async dropUser(): Promise<void> {
    throw new Error('SQLite 不支持用户管理')
  }

  async insertRows(
    _database: string,
    table: string,
    columns: string[],
    rows: CellValue[][]
  ): Promise<number> {
    if (rows.length === 0) return 0
    const q = this.quoteIdent.bind(this)
    const fv = (v: CellValue): unknown => {
      const x = fromCellValue(v)
      return typeof x === 'boolean' ? (x ? 1 : 0) : x
    }
    const sql = `INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${columns
      .map(() => '?')
      .join(', ')})`
    const stmt = this.database.prepare(sql)
    let count = 0
    const run = this.database.transaction(() => {
      for (const row of rows) {
        stmt.run(...row.map(fv))
        count++
      }
    })
    run()
    return count
  }

  async truncateTable(_database: string, table: string): Promise<void> {
    this.database.prepare(`DELETE FROM ${this.quoteIdent(table)}`).run()
  }

  async applyEdits(req: ApplyEditsRequest): Promise<number> {
    const q = this.quoteIdent.bind(this)
    const table = q(req.table)
    // better-sqlite3 不接受 boolean 绑定参数
    const fv = (v: Parameters<typeof fromCellValue>[0]): unknown => {
      const x = fromCellValue(v)
      return typeof x === 'boolean' ? (x ? 1 : 0) : x
    }
    let affected = 0
    const run = this.database.transaction(() => {
      for (const change of req.changes) {
        if (change.kind === 'update') {
          const setCols = Object.keys(change.values)
          const keyCols = Object.keys(change.keys)
          if (setCols.length === 0) continue
          const sql = `UPDATE ${table} SET ${setCols.map((c) => `${q(c)} = ?`).join(', ')} WHERE ${keyCols.map((c) => `${q(c)} IS ?`).join(' AND ')}`
          const info = this.database
            .prepare(sql)
            .run(
              ...setCols.map((c) => fv(change.values[c])),
              ...keyCols.map((c) => fv(change.keys[c]))
            )
          affected += info.changes
        } else if (change.kind === 'insert') {
          const cols = Object.keys(change.values)
          const sql = cols.length
            ? `INSERT INTO ${table} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
            : `INSERT INTO ${table} DEFAULT VALUES`
          const info = this.database.prepare(sql).run(...cols.map((c) => fv(change.values[c])))
          affected += info.changes
        } else {
          const keyCols = Object.keys(change.keys)
          const sql = `DELETE FROM ${table} WHERE ${keyCols.map((c) => `${q(c)} IS ?`).join(' AND ')}`
          const info = this.database.prepare(sql).run(...keyCols.map((c) => fv(change.keys[c])))
          affected += info.changes
        }
      }
    })
    run()
    return affected
  }
}
