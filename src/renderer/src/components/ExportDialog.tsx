import { useEffect, useRef, useState } from 'react'
import { App, Button, Checkbox, Input, Modal, Progress, Radio, Steps } from 'antd'
import type { ExportFormat, TableColumnInfo, TransferProgress } from '@shared/types'
import { useAppStore } from '@/stores/appStore'

const FORMAT_META: Record<ExportFormat, { label: string; ext: string }> = {
  csv: { label: 'CSV 文件 (*.csv)', ext: 'csv' },
  xlsx: { label: 'Excel 文件 (*.xlsx)', ext: 'xlsx' },
  json: { label: 'JSON 文件 (*.json)', ext: 'json' },
  sql: { label: 'SQL 脚本文件 (*.sql)', ext: 'sql' }
}

export function ExportDialog(): React.JSX.Element {
  const { message } = App.useApp()
  const dialog = useAppStore((s) => s.exportDialog)
  const close = useAppStore((s) => s.closeExportDialog)

  const [step, setStep] = useState(0)
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [filePath, setFilePath] = useState('')
  const [includeHeaders, setIncludeHeaders] = useState(true)
  const [delimiter, setDelimiter] = useState(',')
  const [columns, setColumns] = useState<TableColumnInfo[]>([])
  const [selectedCols, setSelectedCols] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<TransferProgress | null>(null)
  const [resultText, setResultText] = useState('')
  const jobIdRef = useRef('')

  const { open, profileId, database, table } = dialog

  useEffect(() => {
    if (!open) return
    setStep(0)
    setFormat('csv')
    setFilePath('')
    setIncludeHeaders(true)
    setDelimiter(',')
    setProgress(null)
    setResultText('')
    setRunning(false)
    if (profileId && database && table) {
      window.skysql.conn
        .tableColumns(profileId, database, table)
        .then((cols) => {
          setColumns(cols)
          setSelectedCols(cols.map((c) => c.name))
        })
        .catch((e) => message.error(`读取表结构失败: ${e instanceof Error ? e.message : e}`))
    }
  }, [open, profileId, database, table, message])

  useEffect(() => {
    if (!open) return
    return window.skysql.transfer.onProgress((p) => {
      if (p.jobId === jobIdRef.current) setProgress(p)
    })
  }, [open])

  const browse = async (): Promise<void> => {
    const meta = FORMAT_META[format]
    const file = await window.skysql.dialog.saveFile(`${table}.${meta.ext}`, [
      { name: meta.label, extensions: [meta.ext] }
    ])
    if (file) setFilePath(file)
  }

  const run = async (): Promise<void> => {
    if (!profileId || !database || !table) return
    const jobId = crypto.randomUUID()
    jobIdRef.current = jobId
    setRunning(true)
    setResultText('')
    try {
      const res = await window.skysql.transfer.export({
        jobId,
        profileId,
        database,
        table,
        filePath,
        format,
        columns: selectedCols,
        options: { includeHeaders, delimiter }
      })
      setResultText(`导出完成：${res.rows.toLocaleString()} 行，耗时 ${res.durationMs} ms`)
      message.success('导出完成')
    } catch (e) {
      setResultText(`导出失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRunning(false)
    }
  }

  const percent =
    progress && progress.total ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0

  const steps = [
    {
      title: '格式与文件',
      content: (
        <div className="wizard-pane">
          <div className="wizard-row">
            <label>导出格式</label>
            <Radio.Group
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
              options={(Object.keys(FORMAT_META) as ExportFormat[]).map((f) => ({
                value: f,
                label: FORMAT_META[f].label
              }))}
            />
          </div>
          <div className="wizard-row">
            <label>导出到</label>
            <Input
              style={{ width: 380 }}
              value={filePath}
              placeholder="选择导出文件路径"
              onChange={(e) => setFilePath(e.target.value)}
              addonAfter={<a onClick={() => void browse()}>浏览...</a>}
            />
          </div>
          {(format === 'csv' || format === 'xlsx') && (
            <div className="wizard-row">
              <label>选项</label>
              <Checkbox checked={includeHeaders} onChange={(e) => setIncludeHeaders(e.target.checked)}>
                包含列标题
              </Checkbox>
              {format === 'csv' && (
                <>
                  <span style={{ marginLeft: 16 }}>分隔符</span>
                  <Input
                    style={{ width: 60 }}
                    value={delimiter}
                    maxLength={1}
                    onChange={(e) => setDelimiter(e.target.value || ',')}
                  />
                </>
              )}
            </div>
          )}
        </div>
      )
    },
    {
      title: '选择字段',
      content: (
        <div className="wizard-pane">
          <div className="wizard-row">
            <Checkbox
              checked={selectedCols.length === columns.length}
              indeterminate={selectedCols.length > 0 && selectedCols.length < columns.length}
              onChange={(e) => setSelectedCols(e.target.checked ? columns.map((c) => c.name) : [])}
            >
              全选
            </Checkbox>
          </div>
          <div className="wizard-columns">
            {columns.map((c) => (
              <Checkbox
                key={c.name}
                checked={selectedCols.includes(c.name)}
                onChange={(e) =>
                  setSelectedCols((prev) =>
                    e.target.checked ? [...prev, c.name] : prev.filter((x) => x !== c.name)
                  )
                }
              >
                {c.name} <span className="wizard-col-type">{c.columnType}</span>
              </Checkbox>
            ))}
          </div>
        </div>
      )
    },
    {
      title: '执行',
      content: (
        <div className="wizard-pane">
          <p>
            将表 <b>{table}</b> 的 {selectedCols.length} 个字段导出为{' '}
            {FORMAT_META[format].label.split(' ')[0]}：
          </p>
          <p className="wizard-path">{filePath}</p>
          {(running || progress) && (
            <Progress percent={percent} status={progress?.error ? 'exception' : running ? 'active' : 'success'} />
          )}
          {progress && !progress.done && (
            <p>
              已处理 {progress.processed.toLocaleString()} / {progress.total?.toLocaleString() ?? '?'} 行
            </p>
          )}
          {resultText && <p className={resultText.includes('失败') ? 'wizard-error' : ''}>{resultText}</p>}
        </div>
      )
    }
  ]

  return (
    <Modal
      title={`导出向导 - ${table ?? ''}`}
      open={open}
      onCancel={() => {
        if (running) void window.skysql.transfer.cancel(jobIdRef.current)
        close()
      }}
      width={640}
      footer={
        <div className="wizard-footer">
          <Button disabled={step === 0 || running} onClick={() => setStep((s) => s - 1)}>
            上一步
          </Button>
          {step < steps.length - 1 ? (
            <Button
              type="primary"
              disabled={step === 0 && !filePath}
              onClick={() => setStep((s) => s + 1)}
            >
              下一步
            </Button>
          ) : (
            <Button
              type="primary"
              loading={running}
              disabled={!filePath || selectedCols.length === 0}
              onClick={() => void run()}
            >
              开始
            </Button>
          )}
        </div>
      }
    >
      <Steps size="small" current={step} items={steps.map((s) => ({ title: s.title }))} />
      <div className="wizard-body">{steps[step].content}</div>
    </Modal>
  )
}
