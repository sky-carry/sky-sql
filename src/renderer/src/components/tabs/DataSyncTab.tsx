import { useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Checkbox, Select, Table as AntTable, Tag } from 'antd'
import { ArrowRight, GitCompareArrows, Play } from 'lucide-react'
import type { DbType, SyncKind, TableSyncDiff, TransferProgress } from '@shared/types'
import { useAppStore } from '@/stores/appStore'

const MAX_ROWS_PER_TABLE = 200000

function familyOf(dbType?: DbType): string {
  return dbType === 'mariadb' ? 'mysql' : (dbType ?? '')
}

export function DataSyncTab(): React.JSX.Element {
  const { message, modal } = App.useApp()
  const profiles = useAppStore((s) => s.profiles)
  const connections = useAppStore((s) => s.connections)
  const loadObjects = useAppStore((s) => s.loadObjects)
  const setStatus = useAppStore((s) => s.setStatus)

  const [srcPid, setSrcPid] = useState<string>()
  const [srcDb, setSrcDb] = useState<string>()
  const [tgtPid, setTgtPid] = useState<string>()
  const [tgtDb, setTgtDb] = useState<string>()
  const [comparing, setComparing] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [diffs, setDiffs] = useState<TableSyncDiff[]>([])
  const [compared, setCompared] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([])
  const [applyInsert, setApplyInsert] = useState(true)
  const [applyUpdate, setApplyUpdate] = useState(true)
  const [applyDelete, setApplyDelete] = useState(false)
  const [progress, setProgress] = useState<TransferProgress | null>(null)
  const jobIdRef = useRef('')

  useEffect(() => {
    const unsubscribe = window.skysql.transfer.onProgress((p) => {
      if (p.jobId === jobIdRef.current) setProgress(p)
    })
    return () => {
      unsubscribe()
      // 关闭标签页时释放主进程中的比对缓存
      if (jobIdRef.current) void window.skysql.dataSync.release(jobIdRef.current)
    }
  }, [])

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

  const srcProfile = profiles.find((p) => p.id === srcPid)
  const tgtProfile = profiles.find((p) => p.id === tgtPid)
  const sameFamily =
    srcProfile && tgtProfile && familyOf(srcProfile.dbType) === familyOf(tgtProfile.dbType)
  const samePair = srcPid === tgtPid && srcDb === tgtDb
  const canCompare = Boolean(srcPid && srcDb && tgtPid && tgtDb && sameFamily && !samePair)

  const compare = async (): Promise<void> => {
    if (!srcPid || !srcDb || !tgtPid || !tgtDb) return
    if (jobIdRef.current) void window.skysql.dataSync.release(jobIdRef.current)
    const jobId = crypto.randomUUID()
    jobIdRef.current = jobId
    setComparing(true)
    setCompared(false)
    setDiffs([])
    setProgress(null)
    try {
      await loadObjects(srcPid, srcDb)
      const state = useAppStore.getState()
      const tables = (state.connections[srcPid]?.objects[srcDb] ?? [])
        .filter((o) => o.objectType === 'table')
        .map((o) => o.name)
      const result = await window.skysql.dataSync.compare({
        jobId,
        source: { profileId: srcPid, database: srcDb },
        target: { profileId: tgtPid, database: tgtDb },
        tables,
        maxRowsPerTable: MAX_ROWS_PER_TABLE
      })
      setDiffs(result)
      setSelectedKeys(
        result.filter((d) => !d.skipped && d.inserts + d.updates + d.deletes > 0).map((d) => d.table)
      )
      setCompared(true)
      const totalDiff = result.reduce((acc, d) => acc + d.inserts + d.updates + d.deletes, 0)
      setStatus(`数据比对完成：${totalDiff.toLocaleString()} 行差异`)
    } catch (e) {
      message.error(`比对失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setComparing(false)
    }
  }

  const kinds: SyncKind[] = [
    ...(applyInsert ? (['insert'] as const) : []),
    ...(applyUpdate ? (['update'] as const) : []),
    ...(applyDelete ? (['delete'] as const) : [])
  ]

  const selectedDiffs = diffs.filter((d) => selectedKeys.includes(d.table) && !d.skipped)
  const pendingCount = selectedDiffs.reduce(
    (acc, d) =>
      acc +
      (applyInsert ? d.inserts : 0) +
      (applyUpdate ? d.updates : 0) +
      (applyDelete ? d.deletes : 0),
    0
  )

  const deploy = (): void => {
    if (!tgtPid || !tgtDb || pendingCount === 0) return
    modal.confirm({
      title: `将 ${pendingCount.toLocaleString()} 行变更部署到目标库 "${tgtDb}"？`,
      content: (
        <div>
          <p>
            {selectedDiffs.length} 张表；操作类型：
            {[applyInsert && '插入', applyUpdate && '更新', applyDelete && '删除']
              .filter(Boolean)
              .join('、')}
          </p>
          {applyDelete && <p style={{ color: '#e05252' }}>包含删除操作：目标中多余的行会被删除！</p>}
        </div>
      ),
      okText: '部署',
      okButtonProps: { danger: applyDelete },
      cancelText: '取消',
      onOk: async () => {
        setDeploying(true)
        try {
          const res = await window.skysql.dataSync.deploy({
            jobId: jobIdRef.current,
            targetProfileId: tgtPid,
            targetDatabase: tgtDb,
            selections: selectedDiffs.map((d) => ({ table: d.table, kinds })),
            continueOnError: true
          })
          const summary = `插入 ${res.inserted}、更新 ${res.updated}、删除 ${res.deleted}`
          if (res.errors.length === 0) {
            message.success(`部署完成：${summary}`)
          } else {
            modal.error({
              title: `部署完成（${summary}），但有 ${res.errors.length} 个错误`,
              width: 680,
              content: (
                <pre style={{ maxHeight: 280, overflow: 'auto', fontSize: 12 }}>
                  {res.errors.join('\n')}
                </pre>
              )
            })
          }
          await compare()
        } catch (e) {
          message.error(`部署失败: ${e instanceof Error ? e.message : String(e)}`)
        } finally {
          setDeploying(false)
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
          icon={<GitCompareArrows size={14} />}
          loading={comparing}
          disabled={!canCompare}
          onClick={() => void compare()}
        >
          比对
        </Button>
        <Button
          size="small"
          icon={<Play size={14} />}
          loading={deploying}
          disabled={!compared || pendingCount === 0 || kinds.length === 0}
          onClick={deploy}
        >
          部署（{pendingCount.toLocaleString()} 行）
        </Button>
        {(comparing || deploying) && progress?.note && (
          <span className="sync-progress">{progress.note}</span>
        )}
        {srcPid && tgtPid && !sameFamily && (
          <span className="wizard-error">源与目标的数据库类型不一致</span>
        )}
        {samePair && srcPid && <span className="wizard-error">源与目标不能是同一个库</span>}
      </div>
      <div className="transfer-options">
        <span className="sync-label">应用操作:</span>
        <Checkbox checked={applyInsert} onChange={(e) => setApplyInsert(e.target.checked)}>
          插入（目标缺失的行）
        </Checkbox>
        <Checkbox checked={applyUpdate} onChange={(e) => setApplyUpdate(e.target.checked)}>
          更新（值不同的行）
        </Checkbox>
        <Checkbox checked={applyDelete} onChange={(e) => setApplyDelete(e.target.checked)}>
          删除（目标多余的行）
        </Checkbox>
      </div>
      <div className="sync-hint">
        按主键行级比对，方向「源 → 目标」；无主键、目标缺表或行数超过 {MAX_ROWS_PER_TABLE.toLocaleString()} 的表会跳过。
      </div>
      <div className="sync-result">
        <AntTable<TableSyncDiff>
          size="small"
          rowKey="table"
          dataSource={diffs}
          pagination={false}
          scroll={{ y: 'calc(100vh - 330px)' }}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: setSelectedKeys,
            getCheckboxProps: (r) => ({ disabled: Boolean(r.skipped) })
          }}
          columns={[
            { title: '表', dataIndex: 'table', width: 280 },
            {
              title: '插入',
              dataIndex: 'inserts',
              width: 100,
              align: 'right',
              render: (v: number, r) => (r.skipped ? '-' : v.toLocaleString())
            },
            {
              title: '更新',
              dataIndex: 'updates',
              width: 100,
              align: 'right',
              render: (v: number, r) => (r.skipped ? '-' : v.toLocaleString())
            },
            {
              title: '删除',
              dataIndex: 'deletes',
              width: 100,
              align: 'right',
              render: (v: number, r) => (r.skipped ? '-' : v.toLocaleString())
            },
            {
              title: '状态',
              render: (_, r) =>
                r.skipped ? (
                  <Tag color="default">{r.skipped}</Tag>
                ) : r.inserts + r.updates + r.deletes === 0 ? (
                  <Tag color="green">一致</Tag>
                ) : (
                  <Tag color="orange">有差异</Tag>
                )
            }
          ]}
          locale={{ emptyText: compared ? '没有可比对的表' : '选择源和目标后点击「比对」' }}
        />
      </div>
    </div>
  )
}
