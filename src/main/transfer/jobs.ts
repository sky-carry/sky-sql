import { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { TransferProgress } from '@shared/types'

const cancelled = new Set<string>()

export function cancelJob(jobId: string): void {
  cancelled.add(jobId)
}

export function isCancelled(jobId: string): boolean {
  return cancelled.has(jobId)
}

export function finishJob(jobId: string): void {
  cancelled.delete(jobId)
}

export function reportProgress(p: TransferProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.TRANSFER_PROGRESS_EVENT, p)
  }
}
