/** 数据库类型（后续扩展：oracle / mongodb / redis） */
export type DbType = 'mysql' | 'mariadb' | 'postgresql' | 'sqlite' | 'sqlserver'

export const DB_TYPE_LABELS: Record<DbType, string> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgresql: 'PostgreSQL',
  sqlite: 'SQLite',
  sqlserver: 'SQL Server'
}

export const DB_DEFAULT_PORTS: Partial<Record<DbType, number>> = {
  mysql: 3306,
  mariadb: 3306,
  postgresql: 5432,
  sqlserver: 1433
}

/** SSH 隧道配置（密码与私钥口令加密存储） */
export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  user: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

/** SSL/TLS 配置 */
export interface SslConfig {
  enabled: boolean
  /** 验证服务器证书 */
  rejectUnauthorized: boolean
  caPath?: string
  certPath?: string
  keyPath?: string
}

/** 连接配置（持久化到本地，密码加密存储） */
export interface ConnectionProfile {
  id: string
  name: string
  dbType: DbType
  /** 分组名，对应导航树中的文件夹 */
  group?: string
  /** 连接颜色标记，防止误操作生产库 */
  color?: string
  host?: string
  port?: number
  user?: string
  password?: string
  /** PostgreSQL / SQL Server 的初始数据库（默认 postgres / master） */
  database?: string
  /** SQLite 数据库文件路径 */
  filePath?: string
  /** 旧版简单 SSL 开关（兼容保留，新配置用 sslConfig） */
  ssl?: boolean
  sslConfig?: SslConfig
  sshConfig?: SshConfig
  createdAt?: string
  updatedAt?: string
}

/** 单元格值：Buffer 等二进制在主进程转为标记对象，Date 转 ISO 字符串 */
export type CellValue =
  | string
  | number
  | boolean
  | null
  | { __type: 'binary'; base64: string; length: number }

export interface ColumnMeta {
  name: string
  dataType: string
}

/** 一条 SQL 语句的执行结果（SELECT 返回 rows，DML 返回 affectedRows） */
export interface QueryResultSet {
  columns: ColumnMeta[]
  rows: CellValue[][]
  /** 非 SELECT 语句的受影响行数；SELECT 为 null */
  affectedRows: number | null
  durationMs: number
  statement?: string
  error?: string
}

export type DbObjectType = 'table' | 'view' | 'function' | 'procedure'

export interface DbObjectInfo {
  name: string
  objectType: DbObjectType
  /** 估算行数（information_schema），可能为 null */
  rowCount?: number | null
  engine?: string | null
  comment?: string | null
  modifiedAt?: string | null
}

export interface TableColumnInfo {
  name: string
  /** 基础类型，如 varchar */
  dataType: string
  /** 完整类型，如 varchar(255) */
  columnType?: string
  nullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  isAutoIncrement: boolean
  comment?: string
}

export interface TableIndexInfo {
  name: string
  columns: string[]
  unique: boolean
  /** BTREE / HASH / gin / gist 等 */
  method?: string
}

export interface TableForeignKeyInfo {
  name: string
  columns: string[]
  refTable: string
  refColumns: string[]
  onUpdate: string
  onDelete: string
}

/** 表设计器所需的完整表结构元数据 */
export interface TableMeta {
  columns: TableColumnInfo[]
  indexes: TableIndexInfo[]
  foreignKeys: TableForeignKeyInfo[]
  comment?: string
  /** MySQL 专属 */
  engine?: string
  charset?: string
  collation?: string
  /** PG 主键约束名（生成 DROP CONSTRAINT 用） */
  pkConstraint?: string
}

export type FilterOp =
  | '='
  | '<>'
  | '>'
  | '>='
  | '<'
  | '<='
  | 'LIKE'
  | 'NOT LIKE'
  | 'IS NULL'
  | 'IS NOT NULL'

export interface TableFilter {
  column: string
  op: FilterOp
  value?: string
}

export interface TableSort {
  column: string
  dir: 'asc' | 'desc'
}

export interface TableDataRequest {
  profileId: string
  database: string
  table: string
  limit: number
  offset: number
  sorts?: TableSort[]
  filters?: TableFilter[]
}

export interface TableDataResponse {
  result: QueryResultSet
  /** 满足筛选条件的总行数（用于分页） */
  totalRows: number | null
  columns: TableColumnInfo[]
}

/** 数据网格的行级变更，由主键定位 */
export type RowChange =
  | { kind: 'update'; keys: Record<string, CellValue>; values: Record<string, CellValue> }
  | { kind: 'insert'; values: Record<string, CellValue> }
  | { kind: 'delete'; keys: Record<string, CellValue> }

export interface ApplyEditsRequest {
  profileId: string
  database: string
  table: string
  changes: RowChange[]
}

/* ===== 用户与权限 ===== */

export interface DbUserInfo {
  name: string
  /** MySQL 的 host 部分；PG/SQLite 无 */
  host?: string
  /** 概要信息（PG 角色属性等） */
  attributes?: string[]
}

export interface UserPrivileges {
  /** 当前已授予的权限/属性 */
  granted: string[]
  /** 该数据库类型可配置的全部权限/属性 */
  available: string[]
}

/** 用户编辑模型：originalName 存在表示编辑已有用户 */
export interface UserDesign {
  originalName?: string
  originalHost?: string
  name: string
  host?: string
  /** undefined = 不修改密码 */
  password?: string
  privileges: string[]
}

/* ===== 导入导出 ===== */

export type ExportFormat = 'csv' | 'json' | 'sql' | 'xlsx'
export type ImportFormat = 'csv' | 'json' | 'xlsx'

export interface ExportRequest {
  jobId: string
  profileId: string
  database: string
  table: string
  filePath: string
  format: ExportFormat
  /** 要导出的列，空 = 全部 */
  columns: string[]
  options: {
    includeHeaders: boolean
    /** CSV 分隔符 */
    delimiter: string
  }
}

export interface ImportColumnMapping {
  /** 源文件列名（或 CSV 无表头时的列序号字符串） */
  source: string
  /** 目标表列名 */
  target: string
}

export interface ImportRequest {
  jobId: string
  profileId: string
  database: string
  table: string
  filePath: string
  format: ImportFormat
  options: {
    delimiter: string
    /** 首行是列名 */
    hasHeader: boolean
    /** Excel 工作表名 */
    sheet?: string
  }
  mapping: ImportColumnMapping[]
  /** append=追加；truncate=清空后插入 */
  mode: 'append' | 'truncate'
}

/** 文件预览（导入向导第一步） */
export interface FilePreview {
  /** 源列名（无表头时为 "列1"... ） */
  headers: string[]
  rows: string[][]
  /** Excel 的工作表列表 */
  sheets?: string[]
  totalRowsHint?: number
}

export interface BackupRequest {
  jobId: string
  profileId: string
  database: string
  filePath: string
  /** 要备份的表，空 = 全部表和视图 */
  tables: string[]
  includeData: boolean
  includeDrop: boolean
}

export interface RestoreRequest {
  jobId: string
  profileId: string
  database: string
  filePath: string
  /** 遇到错误继续执行后续语句 */
  continueOnError: boolean
}

export interface RestoreResult extends TransferResult {
  errors: string[]
}

export interface TransferProgress {
  jobId: string
  processed: number
  total: number | null
  done: boolean
  /** 附加说明（如数据传输的当前表） */
  note?: string
  error?: string
}

/* ===== 数据传输 ===== */

export interface DataTransferRequest {
  jobId: string
  source: { profileId: string; database: string }
  target: { profileId: string; database: string }
  tables: string[]
  options: {
    includeStructure: boolean
    /** 建表前先 DROP TABLE IF EXISTS */
    dropTarget: boolean
    includeData: boolean
    includeIndexes: boolean
    includeFks: boolean
    /** 不建结构时，插入前清空目标表 */
    truncateBeforeInsert: boolean
    continueOnError: boolean
  }
}

export interface DataTransferResult {
  tables: number
  rows: number
  durationMs: number
  errors: string[]
}

/* ===== 数据同步（行级 diff） ===== */

export interface DataSyncCompareRequest {
  jobId: string
  source: { profileId: string; database: string }
  target: { profileId: string; database: string }
  tables: string[]
  /** 单表行数上限，超过则跳过（内存内 diff 的保护） */
  maxRowsPerTable: number
}

export interface TableSyncDiff {
  table: string
  inserts: number
  updates: number
  deletes: number
  /** 跳过原因（无主键 / 目标表不存在 / 行数超限等） */
  skipped?: string
}

export type SyncKind = 'insert' | 'update' | 'delete'

export interface DataSyncDeployRequest {
  jobId: string
  targetProfileId: string
  targetDatabase: string
  selections: { table: string; kinds: SyncKind[] }[]
  continueOnError: boolean
}

export interface DataSyncDeployResult {
  inserted: number
  updated: number
  deleted: number
  errors: string[]
}

export interface TransferResult {
  rows: number
  durationMs: number
}

export interface TestConnectionResult {
  ok: boolean
  message: string
  serverVersion?: string
}

export interface OpenConnectionResult {
  databases: string[]
  serverVersion: string
}
