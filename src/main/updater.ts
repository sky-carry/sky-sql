import { app, dialog, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

// electron-updater 是 CJS，ESM 下用默认导入再解构
const { autoUpdater } = electronUpdater

let initialized = false
let manualCheck = false

function parentWin(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

function notesText(notes: unknown): string {
  return typeof notes === 'string' ? notes.replace(/<[^>]+>/g, '').trim() : ''
}

/** 启动时挂上自动更新（仅打包后生效）：发现新版 → 询问下载 → 下载完成 → 询问重启安装。 */
export function setupAutoUpdate(): void {
  if (initialized) return
  initialized = true
  if (!app.isPackaged) return // 开发模式不检查更新

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', async (info) => {
    const notes = notesText(info.releaseNotes)
    const r = await dialog.showMessageBox(parentWin()!, {
      type: 'info',
      buttons: ['立即更新', '以后再说'],
      defaultId: 0,
      cancelId: 1,
      title: '发现新版本',
      message: `发现新版本 v${info.version}`,
      detail: (notes ? notes + '\n\n' : '') + '点「立即更新」开始下载，下载完成后会提示重启安装。'
    })
    if (r.response === 0) void autoUpdater.downloadUpdate()
  })

  autoUpdater.on('update-not-available', () => {
    if (!manualCheck) return
    manualCheck = false
    void dialog.showMessageBox(parentWin()!, {
      type: 'info',
      title: '检查更新',
      message: `当前已是最新版本（v${app.getVersion()}）。`,
      buttons: ['好']
    })
  })

  autoUpdater.on('update-downloaded', async (info) => {
    const r = await dialog.showMessageBox(parentWin()!, {
      type: 'info',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '更新已就绪',
      message: `新版本 v${info.version} 已下载完成`,
      detail: '点「立即重启安装」即可完成更新。'
    })
    if (r.response === 0) autoUpdater.quitAndInstall()
  })

  autoUpdater.on('error', (err) => {
    if (!manualCheck) return // 自动检查失败不打扰
    manualCheck = false
    void dialog.showMessageBox(parentWin()!, {
      type: 'warning',
      title: '检查更新',
      message: '检查更新失败，请检查网络后再试。',
      detail: String(err?.message ?? err),
      buttons: ['好']
    })
  })

  void autoUpdater.checkForUpdates()
}

/** 手动触发检查更新（无新版/失败都会有反馈）。 */
export function checkForUpdatesManually(): void {
  if (!app.isPackaged) {
    void dialog.showMessageBox(parentWin()!, {
      type: 'info',
      title: '检查更新',
      message: '开发模式下不检查更新（仅打包后的版本可用）。',
      buttons: ['好']
    })
    return
  }
  manualCheck = true
  void autoUpdater.checkForUpdates()
}
