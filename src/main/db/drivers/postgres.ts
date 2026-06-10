import pg from 'pg'
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
import { PG_ATTRIBUTES, pgDropUser, pgUserStatements } from '../userSql'

const { Client } = pg

/** 常见 PG 类型 OID → 名称 */
const OID_NAMES: Record<number, string> = {
  16: 'bool',
  17: 'bytea',
  18: 'char',
  19: 'name',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  114: 'json',
  142: 'xml',
  700: 'float4',
  701: 'float8',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb'
}

function clientConfig(profile: Partial<ConnectionProfile>, database?: string): pg.ClientConfig {
  return {
    host: profile.host || '127.0.0.1',
    port: profile.port || 5432,
    user: profile.user || 'postgres',
    password: profile.password || '',
    database: database || profile.database || 'postgres',
    ssl: buildSslOption(profile),
    connectionTimeoutMillis: 10000
  }
}

export async function testPostgres(profile: Partial<ConnectionProfile>): Promise<TestConnectionResult> {
  const client = new Client(clientConfig(profile))
  try {
    await client.connect()
    const res = await client.query('SELECT version() AS v')
    return { ok: true, message: '连接成功', serverVersion: res.rows[0]?.v ?? 'unknown' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    await client.end().catch(() => undefined)
  }
}

/** 拆分 "schema.table"，无 schema 时默认 public */
function splitTable(table: string): { schema: string; name: string } {
  const idx = table.indexOf('.')
  return idx === -1
    ? { schema: 'public', name: table }
    : { schema: table.slice(0, idx), name: table.slice(idx + 1) }
}

export class PostgresDriver implements DatabaseDriver {
  /** PG 的 database 与连接绑定，每个库一个 Client */
  private clients = new Map<string, pg.Client>()

  constructor(readonly profile: ConnectionProfile) {}

  quoteIdent(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"'
  }

  private quoteTable(table: string): string {
    const { schema, name } = splitTable(table)
    return `${this.quoteIdent(schema)}.${this.quoteIdent(name)}`
  }

  private async getClient(database?: string): Promise<pg.Client> {
    const db = database || this.profile.database || 'postgres'
    const existing = this.clients.get(db)
    if (existing) return existing
    const client = new Client(clientConfig(this.profile, db))
    await client.connect()
    client.on('error', () => this.clients.delete(db))
    this.clients.set(db, client)
    return client
  }

  async connect(): Promise<void> {
    await this.getClient()
  }

  async disconnect(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.end().catch(() => undefined)
    }
    this.clients.clear()
  }

  async getServerVersion(): Promise<string> {
    const client = await this.getClient()
    const res = await client.query('SHOW server_version')
    return `PostgreSQL ${res.rows[0]?.server_version ?? ''}`.trim()
  }

  async listDatabases(): Promise<string[]> {
    const client = await this.getClient()
    const res = await client.query(
      'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname'
    )
    return res.rows.map((r: { datname: string }) => r.datname)
  }

  async listObjects(database: string): Promise<DbObjectInfo[]> {
    const client = await this.getClient(database)
    const tables = await client.query(`
      SELECT n.nspname AS schema, c.relname AS name,
             CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'view' ELSE 'table' END AS type,
             c.reltuples::bigint AS row_estimate,
             obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY n.nspname, c.relname`)
    const funcs = await client.query(`
      SELECT n.nspname AS schema, p.proname AS name
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY n.nspname, p.proname`)

    const qualify = (schema: string, name: string): string =>
      schema === 'public' ? name : `${schema}.${name}`

    const objects: DbObjectInfo[] = tables.rows.map(
      (r: { schema: string; name: string; type: string; row_estimate: string; comment: string | null }) => ({
        name: qualify(r.schema, r.name),
        objectType: r.type as 'table' | 'view',
        rowCount: Number(r.row_estimate) < 0 ? null : Number(r.row_estimate),
        comment: r.comment
      })
    )
    for (const r of funcs.rows as { schema: string; name: string }[]) {
      objects.push({ name: qualify(r.schema, r.name), objectType: 'function' })
    }
    return objects
  }

  async getTableColumns(database: string, table: string): Promise<TableColumnInfo[]> {
    const client = await this.getClient(database)
    const { schema, name } = splitTable(table)
    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default,
              COALESCE(character_maximum_length, numeric_precision) AS len
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, name]
    )
    const pks = await client.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schema, name]
    )
    const pkSet = new Set(pks.rows.map((r: { column_name: string }) => r.column_name))
    return cols.rows.map(
      (r: {
        column_name: string
        data_type: string
        is_nullable: string
        column_default: string | null
        len: number | null
      }) => ({
        name: r.column_name,
        dataType: r.data_type,
        columnType: r.len ? `${r.data_type}(${r.len})` : r.data_type,
        nullable: r.is_nullable === 'YES',
        defaultValue: r.column_default,
        isPrimaryKey: pkSet.has(r.column_name),
        isAutoIncrement: (r.column_default ?? '').startsWith('nextval(')
      })
    )
  }

  async getTableMeta(database: string, table: string): Promise<TableMeta> {
    const client = await this.getClient(database)
    const { schema, name } = splitTable(table)
    const columns = await this.getTableColumns(database, table)

    const idxRes = await client.query(
      `SELECT i.relname AS name, ix.indisunique AS is_unique, am.amname AS method,
              ix.indisprimary AS is_primary,
              array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) AS columns
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_am am ON am.oid = i.relam
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
       WHERE n.nspname = $1 AND t.relname = $2
       GROUP BY i.relname, ix.indisunique, am.amname, ix.indisprimary`,
      [schema, name]
    )

    const fkRes = await client.query(
      `SELECT con.conname AS name,
              (SELECT array_agg(att.attname ORDER BY u.ord)
                 FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
                 JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum) AS columns,
              rt.relname AS ref_table, rn.nspname AS ref_schema,
              (SELECT array_agg(att.attname ORDER BY u.ord)
                 FROM unnest(con.confkey) WITH ORDINALITY AS u(attnum, ord)
                 JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = u.attnum) AS ref_columns,
              con.confupdtype AS upd, con.confdeltype AS del
       FROM pg_constraint con
       JOIN pg_class t ON t.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_class rt ON rt.oid = con.confrelid
       JOIN pg_namespace rn ON rn.oid = rt.relnamespace
       WHERE con.contype = 'f' AND n.nspname = $1 AND t.relname = $2`,
      [schema, name]
    )
    const ruleMap: Record<string, string> = {
      a: 'NO ACTION',
      r: 'RESTRICT',
      c: 'CASCADE',
      n: 'SET NULL',
      d: 'SET DEFAULT'
    }

    const pkRes = await client.query(
      `SELECT con.conname AS name FROM pg_constraint con
       JOIN pg_class t ON t.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE con.contype = 'p' AND n.nspname = $1 AND t.relname = $2`,
      [schema, name]
    )

    const commentRes = await client.query(
      `SELECT obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, name]
    )

    return {
      columns,
      indexes: idxRes.rows
        .filter((r: { is_primary: boolean }) => !r.is_primary)
        .map((r: { name: string; is_unique: boolean; method: string; columns: string[] }) => ({
          name: r.name,
          columns: r.columns,
          unique: r.is_unique,
          method: r.method
        })),
      foreignKeys: fkRes.rows.map(
        (r: {
          name: string
          columns: string[]
          ref_table: string
          ref_schema: string
          ref_columns: string[]
          upd: string
          del: string
        }) => ({
          name: r.name,
          columns: r.columns,
          refTable: r.ref_schema === 'public' ? r.ref_table : `${r.ref_schema}.${r.ref_table}`,
          refColumns: r.ref_columns,
          onUpdate: ruleMap[r.upd] ?? 'NO ACTION',
          onDelete: ruleMap[r.del] ?? 'NO ACTION'
        })
      ),
      comment: commentRes.rows[0]?.comment ?? undefined,
      pkConstraint: pkRes.rows[0]?.name ?? undefined
    }
  }

  async query(sql: string, database?: string): Promise<QueryResultSet[]> {
    const client = await this.getClient(database)
    const start = performance.now()
    // 无参数时 pg 走 simple query 协议，天然支持多语句，多语句时返回 Result 数组
    const res = await client.query({ text: sql, rowMode: 'array' })
    const durationMs = Math.round(performance.now() - start)
    const list = Array.isArray(res) ? res : [res]
    return list.map((r) => this.toResultSet(r, durationMs))
  }

  private toResultSet(r: pg.QueryArrayResult, durationMs: number): QueryResultSet {
    if (r.fields && r.fields.length > 0) {
      return {
        columns: r.fields.map((f) => ({
          name: f.name,
          dataType: OID_NAMES[f.dataTypeID] ?? `oid:${f.dataTypeID}`
        })),
        rows: (r.rows as unknown[][]).map((row) => row.map(toCellValue)),
        affectedRows: null,
        durationMs
      }
    }
    return { columns: [], rows: [], affectedRows: r.rowCount ?? 0, durationMs }
  }

  async getTableData(req: TableDataRequest): Promise<TableDataResponse> {
    const client = await this.getClient(req.database)
    const q = this.quoteIdent.bind(this)
    const table = this.quoteTable(req.table)
    const { clause, params } = buildWhere(req.filters, q, (i) => `$${i}`)
    const orderBy = buildOrderBy(req.sorts, q)
    const limit = safeInt(req.limit, 1000)
    const offset = safeInt(req.offset, 0)

    const start = performance.now()
    const res = await client.query({
      text: `SELECT * FROM ${table}${clause}${orderBy} LIMIT ${limit} OFFSET ${offset}`,
      values: params,
      rowMode: 'array'
    })
    const durationMs = Math.round(performance.now() - start)

    const countRes = await client.query({
      text: `SELECT COUNT(*) AS c FROM ${table}${clause}`,
      values: params
    })
    const totalRows = Number(countRes.rows[0]?.c ?? 0)

    const columns = await this.getTableColumns(req.database, req.table)
    return { result: this.toResultSet(res, durationMs), totalRows, columns }
  }

  async getObjectDDL(database: string, objectType: 'table' | 'view', name: string): Promise<string> {
    const client = await this.getClient(database)
    const q = this.quoteIdent.bind(this)
    const { schema, name: bare } = splitTable(name)
    const table = this.quoteTable(name)

    if (objectType === 'view') {
      const res = await client.query('SELECT pg_get_viewdef($1::regclass, true) AS def', [
        `${q(schema)}.${q(bare)}`
      ])
      return `CREATE OR REPLACE VIEW ${table} AS\n${String(res.rows[0]?.def ?? '').trim()}`
    }

    // 表 DDL 从元数据组装（不含外键，外键由备份流程统一后置）
    const meta = await this.getTableMeta(database, name)
    const lines: string[] = []
    for (const c of meta.columns) {
      let line = `  ${q(c.name)} ${c.columnType ?? c.dataType}`
      if (c.isAutoIncrement && /int/.test(c.dataType)) {
        line = `  ${q(c.name)} ${c.dataType} GENERATED BY DEFAULT AS IDENTITY`
      } else if (c.defaultValue !== null) {
        line += ` DEFAULT ${c.defaultValue}`
      }
      if (!c.nullable) line += ' NOT NULL'
      lines.push(line)
    }
    const pk = meta.columns.filter((c) => c.isPrimaryKey)
    if (pk.length > 0) {
      lines.push(`  PRIMARY KEY (${pk.map((c) => q(c.name)).join(', ')})`)
    }
    const statements = [`CREATE TABLE ${table} (\n${lines.join(',\n')}\n)`]
    for (const i of meta.indexes) {
      statements.push(
        `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${table}` +
          (i.method ? ` USING ${i.method}` : '') +
          ` (${i.columns.map(q).join(', ')})`
      )
    }
    if (meta.comment) {
      statements.push(`COMMENT ON TABLE ${table} IS '${meta.comment.replace(/'/g, "''")}'`)
    }
    for (const c of meta.columns.filter((x) => x.comment)) {
      statements.push(`COMMENT ON COLUMN ${table}.${q(c.name)} IS '${c.comment!.replace(/'/g, "''")}'`)
    }
    return statements.join(';\n')
  }

  private static readonly ATTR_COLUMNS: [string, string][] = [
    ['rolcanlogin', 'LOGIN'],
    ['rolsuper', 'SUPERUSER'],
    ['rolcreatedb', 'CREATEDB'],
    ['rolcreaterole', 'CREATEROLE'],
    ['rolreplication', 'REPLICATION'],
    ['rolbypassrls', 'BYPASSRLS']
  ]

  async listUsers(): Promise<DbUserInfo[]> {
    const client = await this.getClient()
    const res = await client.query(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname`
    )
    return res.rows.map((r: Record<string, unknown>) => ({
      name: String(r.rolname),
      attributes: PostgresDriver.ATTR_COLUMNS.filter(([col]) => r[col] === true).map(([, label]) => label)
    }))
  }

  async getUserPrivileges(name: string): Promise<UserPrivileges> {
    const client = await this.getClient()
    const res = await client.query(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = $1`,
      [name]
    )
    const row = (res.rows[0] ?? {}) as Record<string, unknown>
    return {
      granted: PostgresDriver.ATTR_COLUMNS.filter(([col]) => row[col] === true).map(([, label]) => label),
      available: PG_ATTRIBUTES
    }
  }

  async saveUser(design: UserDesign): Promise<void> {
    const client = await this.getClient()
    let currentAttrs: string[] | null = null
    if (design.originalName) {
      currentAttrs = (await this.getUserPrivileges(design.originalName)).granted
    }
    for (const stmt of pgUserStatements(design, currentAttrs)) {
      await client.query(stmt)
    }
  }

  async dropUser(name: string): Promise<void> {
    const client = await this.getClient()
    await client.query(pgDropUser(name))
  }

  async insertRows(
    database: string,
    table: string,
    columns: string[],
    rows: CellValue[][]
  ): Promise<number> {
    if (rows.length === 0) return 0
    const client = await this.getClient(database)
    const q = this.quoteIdent.bind(this)
    const target = this.quoteTable(table)
    let i = 0
    const values = rows.map((r) => `(${r.map(() => `$${++i}`).join(', ')})`).join(', ')
    const sql = `INSERT INTO ${target} (${columns.map(q).join(', ')}) VALUES ${values}`
    const res = await client.query(
      sql,
      rows.flat().map((v) => fromCellValue(v))
    )
    return res.rowCount ?? rows.length
  }

  async truncateTable(database: string, table: string): Promise<void> {
    const client = await this.getClient(database)
    await client.query(`TRUNCATE TABLE ${this.quoteTable(table)}`)
  }

  async applyEdits(req: ApplyEditsRequest): Promise<number> {
    const client = await this.getClient(req.database)
    const q = this.quoteIdent.bind(this)
    const table = this.quoteTable(req.table)
    let affected = 0
    await client.query('BEGIN')
    try {
      for (const change of req.changes) {
        if (change.kind === 'update') {
          const setCols = Object.keys(change.values)
          const keyCols = Object.keys(change.keys)
          if (setCols.length === 0) continue
          let i = 0
          const sql = `UPDATE ${table} SET ${setCols.map((c) => `${q(c)} = $${++i}`).join(', ')} WHERE ${keyCols.map((c) => `${q(c)} IS NOT DISTINCT FROM $${++i}`).join(' AND ')}`
          const res = await client.query(sql, [
            ...setCols.map((c) => fromCellValue(change.values[c])),
            ...keyCols.map((c) => fromCellValue(change.keys[c]))
          ])
          affected += res.rowCount ?? 0
        } else if (change.kind === 'insert') {
          const cols = Object.keys(change.values)
          const sql = cols.length
            ? `INSERT INTO ${table} (${cols.map(q).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`
            : `INSERT INTO ${table} DEFAULT VALUES`
          const res = await client.query(
            sql,
            cols.map((c) => fromCellValue(change.values[c]))
          )
          affected += res.rowCount ?? 0
        } else {
          const keyCols = Object.keys(change.keys)
          const sql = `DELETE FROM ${table} WHERE ${keyCols.map((c, i) => `${q(c)} IS NOT DISTINCT FROM $${i + 1}`).join(' AND ')}`
          const res = await client.query(
            sql,
            keyCols.map((c) => fromCellValue(change.keys[c]))
          )
          affected += res.rowCount ?? 0
        }
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw e
    }
    return affected
  }
}
