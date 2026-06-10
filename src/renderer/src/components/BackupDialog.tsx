import { useEffect, useRef, useState } from 'react'
import { App, Button, Checkbox, Input, Modal, Progress } from 'antd'
import type { DbObjectInfo, TransferProgress } from '@shared/types'
import { useAppStore } from '@/stores/appStore'

export function BackupDialog(): React.JSX.Element {
  const { message } = App.useApp()
  const dialog = useAppStore((s) => s.backupDialog)
  const close = useAppStore((s) => s.closeBackupDialog)
  const connections = useAppStore((s) => s.connections)
  const loadObjects = useAppStore((s) => s.loadObjects)

  const [filePath, setFilePath] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [includeData, setIncludeData] = useState(true)
  const [includeDrop, setIncludeDrop] = useState(true)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<TransferProgress | null>(null)
  const [resultText, setResultText] = useState('')
  const jobIdRef = useRef('')

  const { open, profileId, database } = dialog
  const objects: DbObjectInfo[] =
    profileId && database ? (connections[profileId]?.objects[database] ?? []) : []
  const backupable = objects.filter((o) => o.objectType === 'table' || o.objectType === 'view')

  useEffect(() => {
    if (!open) return
    setFilePath('')
    setIncludeData(true)
    setIncludeDrop(true)
    setProgress(null)
    setResultText('')
    setRunning(false)
    if (profileId && database) {
      void loadObjects(profileId, database).then(() => {
        const conn = useAppStore.getState().connections[profileId]
        const objs = conn?.objects[database] ?? []
        setSelected(
          objs.filter((o) => o.objectType === 'table' || o.objectType === 'view').map((o) => o.name)
        )
      })
    }
  }, [open, profileId, database, loadObjects])

  useEffect(() => {
    if (!open) return
    return window.skysql.transfer.onProgress((p) => {
      if (p.jobId === jobIdRef.current) setProgress(p)
    })
  }, [open])

  const browse = async (): Promise<void> => {
    const stamp = new Date().toISOString().slice(0, 10)
    const file = await window.skysql.dialog.saveFile(`${database}_${stamp}.sql`, [
      { name: 'SQL 脚本文件', extensions: ['sql'] }
    ])
    if (file) setFilePath(file)
  }

  const run = async (): Promise<void> => {
    if (!profileId || !database || !filePath) return
    const jobId = crypto.randomUUID()
    jobIdRef.current = jobId
    setRunning(true)
    setResultText('')
    try {
      const res = await window.skysql.backup.run({
        jobId,
        profileId,
        database,
        filePath,
        tables: selected.length === backupable.length ? [] : selected,
        includeData,
        includeDrop
      })
      setResultText(`备份完成：${res.rows} 个对象，耗时 ${res.durationMs} ms`)
      message.success('备份完成')
    } catch (e) {
      setResultText(`备份失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRunning(false)
    }
  }

  const percent =
    progress && progress.total ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0

  return (
    <Modal
      title={`备份数据库 - ${database ?? ''}`}
      open={open}
      onCancel={() => {
        if (running) void window.skysql.transfer.cancel(jobIdRef.current)
        close()
      }}
      width={600}
      footer={
        <div className="wizard-footer">
          <Button onClick={close}>关闭</Button>
          <Button
            type="primary"
            loading={running}
            disabled={!filePath || selected.length === 0}
            onClick={() => void run()}
          >
            开始备份
          </Button>
        </div>
      }
    >
      <div className="wizard-pane">
        <div className="wizard-row">
          <label>备份到</label>
          <Input
            style={{ width: 400 }}
            value={filePath}
            placeholder="选择备份文件路径（.sql）"
            onChange={(e) => setFilePath(e.target.value)}
            addonAfter={<a onClick={() => void browse()}>浏览...</a>}
          />
        </div>
        <div className="wizard-row">
          <label>选项</label>
          <Checkbox checked={includeData} onChange={(e) => setIncludeData(e.target.checked)}>
            包含数据
          </Checkbox>
          <Checkbox checked={includeDrop} onChange={(e) => setIncludeDrop(e.target.checked)}>
            包含 DROP 语句
          </Checkbox>
        </div>
        <div className="wizard-row" style={{ alignItems: 'flex-start' }}>
          <label>对象</label>
          <div style={{ flex: 1 }}>
            <Checkbox
              checked={selected.length === backupable.length && backupable.length > 0}
              indeterminate={selected.length > 0 && selected.length < backupable.length}
              onChange={(e) => setSelected(e.target.checked ? backupable.map((o) => o.name) : [])}
            >
              全选（{backupable.length} 个表/视图）
            </Checkbox>
            <div className="wizard-columns" style={{ marginTop: 6 }}>
              {backupable.map((o) => (
                <Checkbox
                  key={o.name}
                  checked={selected.includes(o.name)}
                  onChange={(e) =>
                    setSelected((prev) =>
                      e.target.checked ? [...prev, o.name] : prev.filter((x) => x !== o.name)
                    )
                  }
                >
                  {o.name}
                  {o.objectType === 'view' && <span className="wizard-col-type">（视图）</span>}
                </Checkbox>
              ))}
            </div>
          </div>
        </div>
        {(running || progress) && (
          <Progress percent={percent} status={progress?.error ? 'exception' : running ? 'active' : 'success'} />
        )}
        {resultText && <p className={resultText.includes('失败') ? 'wizard-error' : ''}>{resultText}</p>}
      </div>
    </Modal>
  )
}
