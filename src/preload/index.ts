import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type IpcResponse, type SkySqlApi } from '@shared/ipc'
import type { TransferProgress } from '@shared/types'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>
  if (!res.ok) throw new Error(res.error)
  return res.data
}

const api: SkySqlApi = {
  profiles: {
    list: () => call(IPC.PROFILES_LIST),
    save: (profile) => call(IPC.PROFILES_SAVE, profile),
    remove: (id) => call(IPC.PROFILES_REMOVE, id),
    test: (profile) => call(IPC.PROFILES_TEST, profile)
  },
  conn: {
    open: (profileId) => call(IPC.CONN_OPEN, profileId),
    close: (profileId) => call(IPC.CONN_CLOSE, profileId),
    listObjects: (profileId, database) => call(IPC.CONN_LIST_OBJECTS, profileId, database),
    tableColumns: (profileId, database, table) =>
      call(IPC.CONN_TABLE_COLUMNS, profileId, database, table),
    tableMeta: (profileId, database, table) => call(IPC.CONN_TABLE_META, profileId, database, table),
    tableData: (req) => call(IPC.CONN_TABLE_DATA, req),
    query: (profileId, database, sql) => call(IPC.CONN_QUERY, profileId, database, sql),
    applyEdits: (req) => call(IPC.CONN_APPLY_EDITS, req),
    listUsers: (profileId) => call(IPC.CONN_LIST_USERS, profileId),
    userPrivileges: (profileId, name, host) => call(IPC.CONN_USER_PRIVILEGES, profileId, name, host),
    saveUser: (profileId, design) => call(IPC.CONN_SAVE_USER, profileId, design),
    dropUser: (profileId, name, host) => call(IPC.CONN_DROP_USER, profileId, name, host)
  },
  dialog: {
    openFile: (filters) => call(IPC.DIALOG_OPEN_FILE, filters),
    saveFile: (defaultName, filters) => call(IPC.DIALOG_SAVE_FILE, defaultName, filters)
  },
  transfer: {
    export: (req) => call(IPC.TRANSFER_EXPORT, req),
    import: (req) => call(IPC.TRANSFER_IMPORT, req),
    previewFile: (filePath, format, options) =>
      call(IPC.TRANSFER_PREVIEW, filePath, format, options),
    cancel: (jobId) => call(IPC.TRANSFER_CANCEL, jobId),
    onProgress: (cb) => {
      const listener = (_e: IpcRendererEvent, p: TransferProgress): void => cb(p)
      ipcRenderer.on(IPC.TRANSFER_PROGRESS_EVENT, listener)
      return () => ipcRenderer.removeListener(IPC.TRANSFER_PROGRESS_EVENT, listener)
    }
  },
  backup: {
    run: (req) => call(IPC.BACKUP_RUN, req),
    restore: (req) => call(IPC.BACKUP_RESTORE, req)
  },
  dataTransfer: {
    run: (req) => call(IPC.TRANSFER_DATA, req)
  },
  dataSync: {
    compare: (req) => call(IPC.SYNC_DATA_COMPARE, req),
    deploy: (req) => call(IPC.SYNC_DATA_DEPLOY, req),
    release: (jobId) => call(IPC.SYNC_DATA_RELEASE, jobId)
  }
}

contextBridge.exposeInMainWorld('skysql', api)
