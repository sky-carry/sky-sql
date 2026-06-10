import { useCallback, useEffect, useRef, useState } from 'react'
import {
  App,
  Button,
  Checkbox,
  Input,
  Modal,
  Progress,
  Radio,
  Select,
  Steps,
  Table as AntTable
} from 'antd'
import type {
  FilePreview,
  ImportColumnMapping,
  ImportFormat,
  TableColumnInfo,
  TransferProgress
} from '@shared/types'
import { useAppStore } from '@/stores/appStore'

const FORMAT_META: Record<ImportFormat, { label: string; exts: string[] }> = {
  csv: { label: 'CSV / 文本文件', exts: ['csv', 'txt'] },
  xlsx: { label: 'Excel 文件', exts: ['xlsx', 'xls'] },
  json: { label: 'JSON 文件', exts: ['json'] }
}

export function ImportDialog(): React.JSX.Element {
  const { message } = App.useApp()
  const dialog = useAppStore((s) => s.importDialog)
  const close = useAppStore((s) => s.closeImportDialog)
  const connections = useAppStore((s) => s.connections)
  const loadObjects = useAppStore((s) => s.loadObjects)

  const [step, setStep] = useState(0)
  const [format, setFormat] = useState<ImportFormat>('csv')
  const [filePath, setFilePath] = useState('')
  const [delimiter, setDelimiter] = useState(',')
  const [hasHeader, setHasHeader] = useState(true)
  const [sheet, setSheet] = useState<string>()
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [targetTable, setTargetTable] = useState<string>()
  const [targetCols, setTargetCols] = useState<TableColumnInfo[]>([])
  const [mapping, setMapping] = useState<ImportColumnMapping[]>([])
  const [mode, setMode] = useState<'append' | 'truncate'>('append')
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
    setDelimiter(',')
    setHasHeader(true)
    setSheet(undefined)
    setPreview(null)
    setTargetTable(table)
    setMapping([])
    setMode('append')
    setProgress(null)
    setResultText('')
    setRunning(false)
    if (profileId && database) void loadObjects(profileId, database)
  }, [open, profileId, database, table, loadObjects])

  useEffect(() => {
    if (!open) return
    return window.skysql.transfer.onProgress((p) => {
      if (p.jobId === jobIdRef.current) setProgress(p)
    })
  }, [open])

  const tables = (profileId && database ? (connections[profileId]?.objects[database] ?? []) : [])
    .filter((o) => o.objectType === 'table')
    .map((o) => o.name)

  const doPreview = useCallback(
    async (fp?: string, fmt?: ImportFormat, opts?: { delimiter?: string; hasHeader?: boolean; sheet?: string }): Promise<void> => {
      const path = fp ?? filePath
      if (!path) return
      try {
        const p = await window.skysql.transfer.previewFile(path, fmt ?? format, {
          delimiter: opts?.delimiter ?? delimiter,
          hasHeader: opts?.hasHeader ?? hasHeader,
          sheet: opts?.sheet ?? sheet
        })
        setPreview(p)
        if (p.sheets && !sheet) setSheet(p.sheets[0])
      } catch (e) {
        setPreview(null)
        message.error(`解析文件失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [filePath, format, delimiter, hasHeader, sheet, message]
  )

  const browse = async (): Promise<void> => {
    const meta = FORMAT_META[format]
    const file = await window.skysql.dialog.openFile([
      { name: meta.label, extensions: meta.exts },
      { name: '所有文件', extensions: ['*'] }
    ])
    if (file) {
      setFilePath(file)
      const lower = file.toLowerCase()
      let fmt = format
      if (lower.endsWith('.json')) fmt = 'json'
      else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) fmt = 'xlsx'
      else if (lower.endsWith('.csv') || lower.endsWith('.txt')) fmt = 'csv'
      setFormat(fmt)
      await doPreview(file, fmt)
    }
  }

  // 进入映射步骤时加载目标表结构并自动按名称匹配
  const prepareMapping = async (): Promise<void> => {
    if (!profileId || !database || !targetTable || !preview) return
    try {
      const cols = await window.skysql.conn.tableColumns(profileId, database, targetTable)
      setTargetCols(cols)
      setMapping(
        preview.headers.map((h) => {
          const match = cols.find((c) => c.name.toLowerCase() === h.toLowerCase())
          return { source: h, target: match?.name ?? '' }
        })
      )
    } catch (e) {
      message.error(`读取目标表结构失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const run = async (): Promise<void> => {
    if (!profileId || !database || !targetTable) return
    const jobId = crypto.randomUUID()
    jobIdRef.current = jobId
    setRunning(true)
    setResultText('')
    try {
      const res = await window.skysql.transfer.import({
        jobId,
        profileId,
        database,
        table: targetTable,
        filePath,
        format,
        options: { delimiter, hasHeader, sheet },
        mapping: mapping.filter((m) => m.target),
        mode
      })
      setResultText(`导入完成：${res.rows.toLocaleString()} 行，耗时 ${res.durationMs} ms`)
      message.success('导入完成')
    } catch (e) {
      setResultText(`导入失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRunning(false)
    }
  }

  const percent =
    progress && progress.total ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0

  const steps = [
    {
      title: '选择文件',
      content: (
        <div className="wizard-pane">
          <div className="wizard-row">
            <label>格式</label>
            <Radio.Group
              value={format}
              onChange={(e) => {
                setFormat(e.target.value as ImportFormat)
                if (filePath) void doPreview(filePath, e.target.value as ImportFormat)
              }}
              options={(Object.keys(FORMAT_META) as ImportFormat[]).map((f) => ({
                value: f,
                label: FORMAT_META[f].label
              }))}
            />
          </div>
          <div className="wizard-row">
            <label>文件</label>
            <Input
              style={{ width: 380 }}
              value={filePath}
              placeholder="选择要导入的文件"
              onChange={(e) => setFilePath(e.target.value)}
              onBlur={() => void doPreview()}
              addonAfter={<a onClick={() => void browse()}>浏览...</a>}
            />
          </div>
          {format === 'csv' && (
            <div className="wizard-row">
              <label>分隔符</label>
              <Input
                style={{ width: 60 }}
                value={delimiter}
                maxLength={1}
                onChange={(e) => setDelimiter(e.target.value)}
                onBlur={() => void doPreview(undefined, undefined, { delimiter })}
              />
              <Checkbox
                style={{ marginLeft: 16 }}
                checked={hasHeader}
                onChange={(e) => {
                  setHasHeader(e.target.checked)
                  void doPreview(undefined, undefined, { hasHeader: e.target.checked })
                }}
              >
                首行是列名
              </Checkbox>
            </div>
          )}
          {format === 'xlsx' && preview?.sheets && (
            <div className="wizard-row">
              <label>工作表</label>
              <Select
                size="small"
                style={{ width: 200 }}
                value={sheet}
                onChange={(v) => {
                  setSheet(v)
                  void doPreview(undefined, undefined, { sheet: v })
                }}
                options={preview.sheets.map((s) => ({ value: s, label: s }))}
              />
              <Checkbox
                style={{ marginLeft: 16 }}
                checked={hasHeader}
                onChange={(e) => {
                  setHasHeader(e.target.checked)
                  void doPreview(undefined, undefined, { hasHeader: e.target.checked })
                }}
              >
                首行是列名
              </Checkbox>
            </div>
          )}
          {preview && (
            <div className="wizard-preview">
              <AntTable
                size="small"
                rowKey={(_, i) => String(i)}
                dataSource={preview.rows.slice(0, 10).map((r) => Object.fromEntries(r.map((v, i) => [i, v])))}
                pagination={false}
                scroll={{ x: 'max-content', y: 180 }}
                columns={preview.headers.map((h, i) => ({
                  title: h,
                  dataIndex: String(i),
                  ellipsis: true,
                  width: 120
                }))}
              />
              <div className="wizard-hint">
                预览前 10 行，共约 {preview.totalRowsHint?.toLocaleString() ?? '?'} 行
              </div>
            </div>
          )}
        </div>
      )
    },
    {
      title: '目标与映射',
      content: (
        <div className="wizard-pane">
          <div className="wizard-row">
            <label>目标表</label>
            <Select
              showSearch
              style={{ width: 280 }}
              value={targetTable}
              placeholder="选择目标表"
              onChange={(v) => {
                setTargetTable(v)
                setMapping([])
              }}
              options={tables.map((t) => ({ value: t, label: t }))}
            />
            <Button size="small" style={{ marginLeft: 8 }} onClick={() => void prepareMapping()}>
              自动映射
            </Button>
          </div>
          <AntTable
            size="small"
            rowKey="source"
            dataSource={mapping}
            pagination={false}
            scroll={{ y: 240 }}
            columns={[
              { title: '源字段', dataIndex: 'source', width: 220 },
              {
                title: '目标字段',
                dataIndex: 'target',
                render: (_, r) => (
                  <Select
                    size="small"
                    style={{ width: '100%' }}
                    allowClear
                    placeholder="不导入"
                    value={r.target || undefined}
                    onChange={(v) =>
                      setMapping((prev) =>
                        prev.map((m) => (m.source === r.source ? { ...m, target: v ?? '' } : m))
                      )
                    }
                    options={targetCols.map((c) => ({
                      value: c.name,
                      label: `${c.name} (${c.columnType})`
                    }))}
                  />
                )
              }
            ]}
          />
        </div>
      )
    },
    {
      title: '导入模式与执行',
      content: (
        <div className="wizard-pane">
          <div className="wizard-row">
            <label>导入模式</label>
            <Radio.Group
              value={mode}
              onChange={(e) => setMode(e.target.value as 'append' | 'truncate')}
              options={[
                { value: 'append', label: '追加：在目标表末尾插入记录' },
                { value: 'truncate', label: '复制：先清空目标表，再插入记录' }
              ]}
            />
          </div>
          <p>
            将 <b>{filePath.split(/[\\/]/).pop()}</b> 导入到表 <b>{targetTable}</b>（
            {mapping.filter((m) => m.target).length} 个字段映射）
          </p>
          {mode === 'truncate' && <p className="wizard-error">注意：复制模式会先清空目标表中的所有数据！</p>}
          {(running || progress) && (
            <Progress percent={percent} status={progress?.error ? 'exception' : running ? 'active' : 'success'} />
          )}
          {progress && !progress.done && (
            <p>
              已导入 {progress.processed.toLocaleString()} / {progress.total?.toLocaleString() ?? '?'} 行
            </p>
          )}
          {resultText && <p className={resultText.includes('失败') ? 'wizard-error' : ''}>{resultText}</p>}
        </div>
      )
    }
  ]

  return (
    <Modal
      title="导入向导"
      open={open}
      onCancel={() => {
        if (running) void window.skysql.transfer.cancel(jobIdRef.current)
        close()
      }}
      width={680}
      footer={
        <div className="wizard-footer">
          <Button disabled={step === 0 || running} onClick={() => setStep((s) => s - 1)}>
            上一步
          </Button>
          {step < steps.length - 1 ? (
            <Button
              type="primary"
              disabled={(step === 0 && !preview) || (step === 1 && !targetTable)}
              onClick={() => {
                if (step === 0 && targetTable && mapping.length === 0) void prepareMapping()
                setStep((s) => s + 1)
              }}
            >
              下一步
            </Button>
          ) : (
            <Button
              type="primary"
              loading={running}
              disabled={mapping.filter((m) => m.target).length === 0}
              onClick={() => void run()}
            >
              开始导入
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
