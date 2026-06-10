import { useEffect, useRef, useState } from 'react'
import { App, Button, Checkbox, Input, Modal, Progress } from 'antd'
import type { TransferProgress } from '@shared/types'
import { useAppStore } from '@/stores/appStore'

export function RestoreDialog(): React.JSX.Element {
  const { message } = App.useApp()
  const dialog = useAppStore((s) => s.restoreDialog)
  const close = useAppStore((s) => s.closeRestoreDialog)
  const loadObjects = useAppStore((s) => s.loadObjects)

  const [filePath, setFilePath] = useState('')
  const [continueOnError, setContinueOnError] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<TransferProgress | null>(null)
  const [resultText, setResultText] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const jobIdRef = useRef('')

  const { open, profileId, database } = dialog

  useEffect(() => {
    if (!open) return
    setFilePath('')
    setContinueOnError(false)
    setProgress(null)
    setResultText('')
    setErrors([])
    setRunning(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    return window.skysql.transfer.onProgress((p) => {
      if (p.jobId === jobIdRef.current) setProgress(p)
    })
  }, [open])

  const browse = async (): Promise<void> => {
    const file = await window.skysql.dialog.openFile([
      { name: 'SQL 脚本文件', extensions: ['sql'] },
      { name: '所有文件', extensions: ['*'] }
    ])
    if (file) setFilePath(file)
  }

  const run = async (): Promise<void> => {
    if (!profileId || !database || !filePath) return
    const jobId = crypto.randomUUID()
    jobIdRef.current = jobId
    setRunning(true)
    setResultText('')
    setErrors([])
    try {
      const res = await window.skysql.backup.restore({
        jobId,
        profileId,
        database,
        filePath,
        continueOnError
      })
      setErrors(res.errors)
      setResultText(
        `执行完成：${res.rows} 条语句，耗时 ${res.durationMs} ms` +
          (res.errors.length ? `，${res.errors.length} 条失败` : '')
      )
      if (res.errors.length === 0) message.success('还原完成')
      else message.warning(`完成但有 ${res.errors.length} 条语句失败`)
      await loadObjects(profileId, database, true)
    } catch (e) {
      setResultText(`还原失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRunning(false)
    }
  }

  const percent =
    progress && progress.total ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0

  return (
    <Modal
      title={`还原 / 运行 SQL 文件 - ${database ?? ''}`}
      open={open}
      onCancel={() => {
        if (running) void window.skysql.transfer.cancel(jobIdRef.current)
        close()
      }}
      width={600}
      footer={
        <div className="wizard-footer">
          <Button onClick={close}>关闭</Button>
          <Button type="primary" loading={running} disabled={!filePath} onClick={() => void run()}>
            开始执行
          </Button>
        </div>
      }
    >
      <div className="wizard-pane">
        <div className="wizard-row">
          <label>SQL 文件</label>
          <Input
            style={{ width: 400 }}
            value={filePath}
            placeholder="选择要执行的 .sql 文件"
            onChange={(e) => setFilePath(e.target.value)}
            addonAfter={<a onClick={() => void browse()}>浏览...</a>}
          />
        </div>
        <div className="wizard-row">
          <label>选项</label>
          <Checkbox checked={continueOnError} onChange={(e) => setContinueOnError(e.target.checked)}>
            遇到错误继续执行
          </Checkbox>
        </div>
        <p className="wizard-error">
          注意：文件中的语句会直接在目标数据库「{database}」上执行，包含 DROP 的备份会覆盖同名表！
        </p>
        {(running || progress) && (
          <>
            <Progress percent={percent} status={progress?.error ? 'exception' : running ? 'active' : 'success'} />
            {progress && !progress.done && (
              <p>
                已执行 {progress.processed.toLocaleString()} / {progress.total?.toLocaleString() ?? '?'} 条语句
              </p>
            )}
          </>
        )}
        {resultText && <p className={resultText.includes('失败:') ? 'wizard-error' : ''}>{resultText}</p>}
        {errors.length > 0 && (
          <pre className="restore-errors">{errors.slice(0, 50).join('\n')}</pre>
        )}
      </div>
    </Modal>
  )
}
