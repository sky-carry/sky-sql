import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC, type IpcResponse } from '@shared/ipc'
import type {
  ApplyEditsRequest,
  BackupRequest,
  ConnectionProfile,
  DataSyncCompareRequest,
  DataSyncDeployRequest,
  DataTransferRequest,
  ExportRequest,
  RestoreRequest,
  ImportFormat,
  ImportRequest,
  TableDataRequest,
  UserDesign
} from '@shared/types'
import { closeConnection, getDriver, openConnection } from './db/connectionManager'
import { testProfile } from './db/registry'
import { getProfile, listProfiles, removeProfile, saveProfile } from './profileStore'
import { exportTable } from './transfer/exporter'
import { importFile, previewFile } from './transfer/importer'
import { runBackup, runRestore } from './transfer/backup'
import { runDataTransfer } from './transfer/dataTransfer'
import { compareData, deployDataSync, releaseSyncJob } from './transfer/dataSync'
import { cancelJob } from './transfer/jobs'
import { checkForUpdatesManually } from './updater'

/** 统一包装：异常转为 { ok: false, error } 返回，避免 invoke 抛出带前缀的错误 */
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResponse<T>> => {
    try {
      const data = await fn(...(args as never[]))
      return { ok: true, data }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

export function registerIpcHandlers(): void {
  handle(IPC.APP_VERSION, () => app.getVersion())
  handle(IPC.APP_CHECK_UPDATE, () => {
    checkForUpdatesManually()
  })
  handle(IPC.PROFILES_LIST, () => listProfiles())
  handle(IPC.PROFILES_SAVE, (profile: Partial<ConnectionProfile>) => saveProfile(profile))
  handle(IPC.PROFILES_REMOVE, async (id: string) => {
    await closeConnection(id)
    removeProfile(id)
  })
  handle(IPC.PROFILES_TEST, (profile: Partial<ConnectionProfile>) => {
    // 编辑已有连接但未改密码时，用存储中的密码测试（含 SSH 凭据）
    if (profile.id) {
      const saved = getProfile(profile.id)
      if (profile.password === undefined) {
        profile = { ...profile, password: saved.password }
      }
      if (profile.sshConfig && saved.sshConfig) {
        profile = {
          ...profile,
          sshConfig: {
            ...profile.sshConfig,
            password: profile.sshConfig.password ?? saved.sshConfig.password,
            passphrase: profile.sshConfig.passphrase ?? saved.sshConfig.passphrase
          }
        }
      }
    }
    return testProfile(profile)
  })

  handle(IPC.CONN_OPEN, async (profileId: string) => {
    const profile = getProfile(profileId)
    const driver = await openConnection(profile)
    const [databases, serverVersion] = await Promise.all([
      driver.listDatabases(),
      driver.getServerVersion()
    ])
    return { databases, serverVersion }
  })
  handle(IPC.CONN_CLOSE, (profileId: string) => closeConnection(profileId))
  handle(IPC.CONN_LIST_OBJECTS, (profileId: string, database: string) =>
    getDriver(profileId).listObjects(database)
  )
  handle(IPC.CONN_TABLE_COLUMNS, (profileId: string, database: string, table: string) =>
    getDriver(profileId).getTableColumns(database, table)
  )
  handle(IPC.CONN_TABLE_META, (profileId: string, database: string, table: string) =>
    getDriver(profileId).getTableMeta(database, table)
  )
  handle(IPC.CONN_TABLE_DATA, (req: TableDataRequest) => getDriver(req.profileId).getTableData(req))
  handle(IPC.CONN_QUERY, (profileId: string, database: string, sql: string) =>
    getDriver(profileId).query(sql, database || undefined)
  )
  handle(IPC.CONN_APPLY_EDITS, (req: ApplyEditsRequest) => getDriver(req.profileId).applyEdits(req))
  handle(IPC.CONN_LIST_USERS, (profileId: string) => getDriver(profileId).listUsers())
  handle(IPC.CONN_USER_PRIVILEGES, (profileId: string, name: string, host?: string) =>
    getDriver(profileId).getUserPrivileges(name, host)
  )
  handle(IPC.CONN_SAVE_USER, (profileId: string, design: UserDesign) =>
    getDriver(profileId).saveUser(design)
  )
  handle(IPC.CONN_DROP_USER, (profileId: string, name: string, host?: string) =>
    getDriver(profileId).dropUser(name, host)
  )

  handle(IPC.TRANSFER_EXPORT, (req: ExportRequest) => exportTable(req))
  handle(IPC.TRANSFER_IMPORT, (req: ImportRequest) => importFile(req))
  handle(
    IPC.TRANSFER_PREVIEW,
    (filePath: string, format: ImportFormat, options: { delimiter: string; hasHeader: boolean; sheet?: string }) =>
      previewFile(filePath, format, options)
  )
  handle(IPC.TRANSFER_CANCEL, (jobId: string) => cancelJob(jobId))
  handle(IPC.BACKUP_RUN, (req: BackupRequest) => runBackup(req))
  handle(IPC.BACKUP_RESTORE, (req: RestoreRequest) => runRestore(req))
  handle(IPC.TRANSFER_DATA, (req: DataTransferRequest) => runDataTransfer(req))
  handle(IPC.SYNC_DATA_COMPARE, (req: DataSyncCompareRequest) => compareData(req))
  handle(IPC.SYNC_DATA_DEPLOY, (req: DataSyncDeployRequest) => deployDataSync(req))
  handle(IPC.SYNC_DATA_RELEASE, (jobId: string) => releaseSyncJob(jobId))

  handle(IPC.DIALOG_OPEN_FILE, async (filters?: { name: string; extensions: string[] }[]) => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      properties: ['openFile', 'promptToCreate'],
      filters: filters ?? [{ name: '所有文件', extensions: ['*'] }]
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  handle(
    IPC.DIALOG_SAVE_FILE,
    async (defaultName?: string, filters?: { name: string; extensions: string[] }[]) => {
      const win = BrowserWindow.getFocusedWindow()
      const result = await dialog.showSaveDialog(win ?? new BrowserWindow({ show: false }), {
        defaultPath: defaultName,
        filters: filters ?? [{ name: '所有文件', extensions: ['*'] }]
      })
      return result.canceled || !result.filePath ? null : result.filePath
    }
  )
}
