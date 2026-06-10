import type {
  ApplyEditsRequest,
  BackupRequest,
  ConnectionProfile,
  DataSyncCompareRequest,
  DataSyncDeployRequest,
  DataSyncDeployResult,
  DataTransferRequest,
  DataTransferResult,
  TableSyncDiff,
  DbObjectInfo,
  ExportRequest,
  RestoreRequest,
  RestoreResult,
  FilePreview,
  ImportFormat,
  ImportRequest,
  OpenConnectionResult,
  QueryResultSet,
  TableColumnInfo,
  TableMeta,
  TableDataRequest,
  TableDataResponse,
  TestConnectionResult,
  TransferProgress,
  TransferResult,
  DbUserInfo,
  UserDesign,
  UserPrivileges
} from './types'

/** IPC 通道名 */
export const IPC = {
  PROFILES_LIST: 'profiles:list',
  PROFILES_SAVE: 'profiles:save',
  PROFILES_REMOVE: 'profiles:remove',
  PROFILES_TEST: 'profiles:test',
  CONN_OPEN: 'conn:open',
  CONN_CLOSE: 'conn:close',
  CONN_LIST_OBJECTS: 'conn:listObjects',
  CONN_TABLE_COLUMNS: 'conn:tableColumns',
  CONN_TABLE_META: 'conn:tableMeta',
  CONN_TABLE_DATA: 'conn:tableData',
  CONN_QUERY: 'conn:query',
  CONN_APPLY_EDITS: 'conn:applyEdits',
  CONN_LIST_USERS: 'conn:listUsers',
  CONN_USER_PRIVILEGES: 'conn:userPrivileges',
  CONN_SAVE_USER: 'conn:saveUser',
  CONN_DROP_USER: 'conn:dropUser',
  DIALOG_OPEN_FILE: 'dialog:openFile',
  DIALOG_SAVE_FILE: 'dialog:saveFile',
  TRANSFER_EXPORT: 'transfer:export',
  TRANSFER_IMPORT: 'transfer:import',
  TRANSFER_PREVIEW: 'transfer:previewFile',
  TRANSFER_CANCEL: 'transfer:cancel',
  BACKUP_RUN: 'backup:run',
  BACKUP_RESTORE: 'backup:restore',
  TRANSFER_DATA: 'transfer:data',
  SYNC_DATA_COMPARE: 'syncData:compare',
  SYNC_DATA_DEPLOY: 'syncData:deploy',
  SYNC_DATA_RELEASE: 'syncData:release',
  /** 主进程 → 渲染进程的进度事件 */
  TRANSFER_PROGRESS_EVENT: 'transfer:progress'
} as const

/** IPC 应答包装：主进程捕获异常后以统一结构返回 */
export type IpcResponse<T> = { ok: true; data: T } | { ok: false; error: string }

/** 渲染进程可用的完整 API（preload 通过 contextBridge 暴露为 window.skysql） */
export interface SkySqlApi {
  profiles: {
    list(): Promise<ConnectionProfile[]>
    save(profile: Partial<ConnectionProfile>): Promise<ConnectionProfile>
    remove(id: string): Promise<void>
    test(profile: Partial<ConnectionProfile>): Promise<TestConnectionResult>
  }
  conn: {
    open(profileId: string): Promise<OpenConnectionResult>
    close(profileId: string): Promise<void>
    listObjects(profileId: string, database: string): Promise<DbObjectInfo[]>
    tableColumns(profileId: string, database: string, table: string): Promise<TableColumnInfo[]>
    tableMeta(profileId: string, database: string, table: string): Promise<TableMeta>
    tableData(req: TableDataRequest): Promise<TableDataResponse>
    query(profileId: string, database: string, sql: string): Promise<QueryResultSet[]>
    applyEdits(req: ApplyEditsRequest): Promise<number>
    listUsers(profileId: string): Promise<DbUserInfo[]>
    userPrivileges(profileId: string, name: string, host?: string): Promise<UserPrivileges>
    saveUser(profileId: string, design: UserDesign): Promise<void>
    dropUser(profileId: string, name: string, host?: string): Promise<void>
  }
  dialog: {
    openFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>
    saveFile(defaultName?: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null>
  }
  transfer: {
    export(req: ExportRequest): Promise<TransferResult>
    import(req: ImportRequest): Promise<TransferResult>
    previewFile(
      filePath: string,
      format: ImportFormat,
      options: { delimiter: string; hasHeader: boolean; sheet?: string }
    ): Promise<FilePreview>
    cancel(jobId: string): Promise<void>
    /** 订阅进度事件，返回取消订阅函数 */
    onProgress(cb: (p: TransferProgress) => void): () => void
  }
  backup: {
    run(req: BackupRequest): Promise<TransferResult>
    restore(req: RestoreRequest): Promise<RestoreResult>
  }
  dataTransfer: {
    run(req: DataTransferRequest): Promise<DataTransferResult>
  }
  dataSync: {
    compare(req: DataSyncCompareRequest): Promise<TableSyncDiff[]>
    deploy(req: DataSyncDeployRequest): Promise<DataSyncDeployResult>
    release(jobId: string): Promise<void>
  }
}
