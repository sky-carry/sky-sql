import type {
  ApplyEditsRequest,
  CellValue,
  ConnectionProfile,
  DbObjectInfo,
  QueryResultSet,
  TableColumnInfo,
  TableDataRequest,
  TableDataResponse,
  TableMeta,
  DbUserInfo,
  UserDesign,
  UserPrivileges
} from '@shared/types'

/**
 * 数据库驱动统一接口。
 * 新增数据库类型时实现此接口并在 registry.ts 中注册即可。
 */
export interface DatabaseDriver {
  readonly profile: ConnectionProfile

  connect(): Promise<void>
  disconnect(): Promise<void>
  getServerVersion(): Promise<string>

  listDatabases(): Promise<string[]>
  listObjects(database: string): Promise<DbObjectInfo[]>
  getTableColumns(database: string, table: string): Promise<TableColumnInfo[]>

  /** 表设计器：列 + 索引 + 外键 + 表选项 */
  getTableMeta(database: string, table: string): Promise<TableMeta>

  /** 执行任意 SQL（可能包含多条语句），返回每条语句的结果集 */
  query(sql: string, database?: string): Promise<QueryResultSet[]>

  /** 分页读取表数据（带筛选/排序），并返回表结构与总行数 */
  getTableData(req: TableDataRequest): Promise<TableDataResponse>

  /** 应用数据网格中的行级变更（事务中执行），返回受影响行数 */
  applyEdits(req: ApplyEditsRequest): Promise<number>

  /** 批量插入（导入向导用），参数化执行，返回插入行数 */
  insertRows(database: string, table: string, columns: string[], rows: CellValue[][]): Promise<number>

  /** 清空表（导入向导的"复制"模式） */
  truncateTable(database: string, table: string): Promise<void>

  /**
   * 获取对象的 CREATE DDL（备份用）。
   * PG 的表 DDL 不含外键，备份流程会基于 getTableMeta 把外键统一放到文件末尾。
   */
  getObjectDDL(database: string, objectType: 'table' | 'view', name: string): Promise<string>

  /* ===== 用户与权限（SQLite 不支持，抛出异常） ===== */
  listUsers(): Promise<DbUserInfo[]>
  getUserPrivileges(name: string, host?: string): Promise<UserPrivileges>
  saveUser(design: UserDesign): Promise<void>
  dropUser(name: string, host?: string): Promise<void>

  /** 标识符引用，如 MySQL 的反引号 / PG 的双引号 */
  quoteIdent(name: string): string
}

/** 把驱动返回的原始值转为可经 IPC 序列化的 CellValue */
export function toCellValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'bigint') {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v.toString()
  }
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
  if (Buffer.isBuffer(v)) {
    return { __type: 'binary', base64: v.toString('base64'), length: v.length }
  }
  if (v instanceof Uint8Array) {
    const buf = Buffer.from(v)
    return { __type: 'binary', base64: buf.toString('base64'), length: buf.length }
  }
  // json / 数组等复杂对象
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** SQL 绑定参数允许的值类型 */
export type SqlParam = string | number | boolean | null | Buffer

/** 把 CellValue 还原为驱动可用的参数值 */
export function fromCellValue(v: CellValue): SqlParam {
  // CellValue 中唯一的对象形态是二进制标记
  if (v !== null && typeof v === 'object') {
    return Buffer.from(v.base64, 'base64')
  }
  return v
}

/** 构建 WHERE 子句（使用占位符），返回 SQL 片段和参数列表 */
export function buildWhere(
  filters: TableDataRequest['filters'],
  quote: (s: string) => string,
  placeholder: (index: number) => string
): { clause: string; params: unknown[] } {
  if (!filters || filters.length === 0) return { clause: '', params: [] }
  const parts: string[] = []
  const params: unknown[] = []
  for (const f of filters) {
    if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') {
      parts.push(`${quote(f.column)} ${f.op}`)
    } else {
      params.push(f.value ?? '')
      parts.push(`${quote(f.column)} ${f.op} ${placeholder(params.length)}`)
    }
  }
  return { clause: ` WHERE ${parts.join(' AND ')}`, params }
}

/** 构建 ORDER BY 子句 */
export function buildOrderBy(sorts: TableDataRequest['sorts'], quote: (s: string) => string): string {
  if (!sorts || sorts.length === 0) return ''
  return ` ORDER BY ${sorts.map((s) => `${quote(s.column)} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`
}

/** 校验 limit/offset 为非负整数，防注入 */
export function safeInt(n: number, fallback: number): number {
  return Number.isInteger(n) && n >= 0 ? n : fallback
}
