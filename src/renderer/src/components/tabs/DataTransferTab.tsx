import { useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Checkbox, Select, Spin } from 'antd'
import { ArrowRight, Send } from 'lucide-react'
import type { TransferProgress } from '@shared/types'
import { useAppStore } from '@/stores/appStore'

export function DataTransferTab(): React.JSX.Element {
  const { message, modal } = App.useApp()
  const profiles = useAppStore((s) => s.profiles)
  const connections = useAppStore((s) => s.connections)
  const loadObjects = useAppStore((s) => s.loadObjects)
  const setStatus = useAppStore((s) => s.setStatus)

  const [srcPid, setSrcPid] = useState<string>()
  const [srcDb, setSrcDb] = useState<string>()
  const [tgtPid, setTgtPid] = useState<string>()
  const [tgtDb, setTgtDb] = useState<string>()
  const [selected, setSelected] = useState<string[]>([])

  const [includeStructure, setIncludeStructure] = useState(true)
  const [dropTarget, setDropTarget] = useState(false)
  const [includeData, setIncludeData] = useState(true)
  const [includeIndexes, setIncludeIndexes] = useState(true)
  const [includeFks, setIncludeFks] = useState(false)
  const [truncateBeforeInsert, setTruncateBeforeInsert] = useState(false)
  const [continueOnError, setContinueOnError] = useState(true)

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<TransferProgress | null>(null)
  const [resultText, setResultText] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const jobIdRef = useRef('')

  const connOptions = useMemo(
    () =>
      Object.keys(connections).map((id) => ({
        value: id,
        label: profiles.find((p) => p.id === id)?.name ?? id
      })),
    [connections, profiles]
  )
  const dbOptions = (pid?: string): { value: string; label: string }[] =>
    (pid ? (connections[pid]?.databases ?? []) : []).map((db) => ({ value: db, label: db }))

  const srcTables = useMemo(
    () =>
      (srcPid && srcDb ? (connections[srcPid]?.objects[srcDb] ?? []) : [])
        .filter((o) => o.objectType === 'table')
        .map((o) => o.name),
    [connections, srcPid, srcDb]
  )

  useEffect(() => {
    if (srcPid && srcDb) {
      void loadObjects(srcPid, srcDb).then(() => {
        const state = useAppStore.getState()
        const tables = (state.connections[srcPid]?.objects[srcDb] ?? [])
          .filter((o) => o.objectType === 'table')
          .map((o) => o.name)
        setSelected(tables)
      })
    } else {
      setSelected([])
    }
  }, [srcPid, srcDb, loadObjects])

  useEffect(() => {
    return window.skysql.transfer.onProgress((p) => {
      if (p.jobId === jobIdRef.current) setProgress(p)
    })
  }, [])

  const samePair = srcPid === tgtPid && srcDb === tgtDb
  const canRun = Boolean(
    srcPid && srcDb && tgtPid && tgtDb && !samePair && selected.length > 0 && (includeStructure || includeData)
  )

  const run = (): void => {
    if (!srcPid || !srcDb || !tgtPid || !tgtDb) return
    const tgtName = profiles.find((p) => p.id === tgtPid)?.name ?? ''
    modal.confirm({
      title: '开始数据传输？',
      content: (
        <div>
          <p>
            {selected.length} 张表：{srcDb} → {tgtName} / {tgtDb}
          </p>
          {dropTarget && <p style={{ color: '#e05252' }}>目标中的同名表会被 DROP 后重建！</p>}
          {truncateBeforeInsert && !includeStructure && (
            <p style={{ color: '#e05252' }}>目标表会先被清空！</p>
          )}
        </div>
      ),
      okText: '开始',
      cancelText: '取消',
      onOk: async () => {
        const jobId = crypto.randomUUID()
        jobIdRef.current = jobId
        setRunning(true)
        setResultText('')
        setErrors([])
        setProgress(null)
        try {
          const res = await window.skysql.dataTransfer.run({
            jobId,
            source: { profileId: srcPid, database: srcDb },
            target: { profileId: tgtPid, database: tgtDb },
            tables: selected,
            options: {
              includeStructure,
              dropTarget,
              includeData,
              includeIndexes,
              includeFks,
              truncateBeforeInsert,
              continueOnError
            }
          })
          setErrors(res.errors)
          setResultText(
            `传输完成：${res.tables} 张表，${res.rows.toLocaleString()} 行，耗时 ${(res.durationMs / 1000).toFixed(1)} s` +
              (res.errors.length ? `，${res.errors.length} 个错误` : '')
          )
          if (res.errors.length === 0) message.success('数据传输完成')
          else message.warning(`完成但有 ${res.errors.length} 个错误`)
          setStatus('数据传输完成')
          await loadObjects(tgtPid, tgtDb, true)
        } catch (e) {
          setResultText(`传输失败: ${e instanceof Error ? e.message : String(e)}`)
          message.error(resultText || '传输失败')
        } finally {
          setRunning(false)
        }
      }
    })
  }

  return (
    <div className="sync-tab">
      <div className="sync-config">
        <span className="sync-label">源</span>
        <Select
          size="small"
          style={{ width: 150 }}
          placeholder="连接"
          value={srcPid}
          onChange={(v) => {
            setSrcPid(v)
            setSrcDb(undefined)
          }}
          options={connOptions}
        />
        <Select
          size="small"
          style={{ width: 150 }}
          placeholder="数据库"
          value={srcDb}
          onChange={setSrcDb}
          options={dbOptions(srcPid)}
        />
        <ArrowRight size={16} className="sync-arrow" />
        <span className="sync-label">目标</span>
        <Select
          size="small"
          style={{ width: 150 }}
          placeholder="连接"
          value={tgtPid}
          onChange={(v) => {
            setTgtPid(v)
            setTgtDb(undefined)
          }}
          options={connOptions}
        />
        <Select
          size="small"
          style={{ width: 150 }}
          placeholder="数据库"
          value={tgtDb}
          onChange={setTgtDb}
          options={dbOptions(tgtPid)}
        />
        <Button
          size="small"
          type="primary"
          icon={<Send size={14} />}
          loading={running}
          disabled={!canRun}
          onClick={run}
        >
          开始传输
        </Button>
        {samePair && srcPid && <span className="wizard-error">源与目标不能是同一个库</span>}
      </div>

      <div className="transfer-options">
        <Checkbox checked={includeStructure} onChange={(e) => setIncludeStructure(e.target.checked)}>
          传输结构（建表）
        </Checkbox>
        <Checkbox
          checked={dropTarget}
          disabled={!includeStructure}
          onChange={(e) => setDropTarget(e.target.checked)}
        >
          先 DROP 目标同名表
        </Checkbox>
        <Checkbox
          checked={includeIndexes}
          disabled={!includeStructure}
          onChange={(e) => setIncludeIndexes(e.target.checked)}
        >
          包含索引
        </Checkbox>
        <Checkbox
          checked={includeFks}
          disabled={!includeStructure}
          onChange={(e) => setIncludeFks(e.target.checked)}
        >
          包含外键
        </Checkbox>
        <Checkbox checked={includeData} onChange={(e) => setIncludeData(e.target.checked)}>
          传输数据
        </Checkbox>
        <Checkbox
          checked={truncateBeforeInsert}
          disabled={includeStructure || !includeData}
          onChange={(e) => setTruncateBeforeInsert(e.target.checked)}
        >
          插入前清空目标表
        </Checkbox>
        <Checkbox checked={continueOnError} onChange={(e) => setContinueOnError(e.target.checked)}>
          遇到错误继续
        </Checkbox>
      </div>
      <div className="sync-hint">
        支持异构传输（MySQL ↔ PostgreSQL ↔ SQLite），跨库种时自动做类型映射；目标表名与源一致。
      </div>

      <div className="transfer-body">
        <div className="transfer-tables">
          <Checkbox
            checked={selected.length === srcTables.length && srcTables.length > 0}
            indeterminate={selected.length > 0 && selected.length < srcTables.length}
            onChange={(e) => setSelected(e.target.checked ? [...srcTables] : [])}
          >
            全选（{srcTables.length} 张表）
          </Checkbox>
          <div className="wizard-columns" style={{ marginTop: 6, maxHeight: 'none', flex: 1 }}>
            {srcTables.map((t) => (
              <Checkbox
                key={t}
                checked={selected.includes(t)}
                onChange={(e) =>
                  setSelected((prev) => (e.target.checked ? [...prev, t] : prev.filter((x) => x !== t)))
                }
              >
                {t}
              </Checkbox>
            ))}
            {srcTables.length === 0 && (
              <span className="wizard-hint">选择源连接和数据库后显示表清单</span>
            )}
          </div>
        </div>
        <div className="transfer-status">
          {running && (
            <div className="transfer-running">
              <Spin size="small" />
              <span>{progress?.note ?? '准备中...'}</span>
              <span>已传输 {(progress?.processed ?? 0).toLocaleString()} 行</span>
            </div>
          )}
          {resultText && <p className={resultText.includes('失败:') ? 'wizard-error' : ''}>{resultText}</p>}
          {errors.length > 0 && <pre className="restore-errors">{errors.slice(0, 50).join('\n')}</pre>}
        </div>
      </div>
    </div>
  )
}
