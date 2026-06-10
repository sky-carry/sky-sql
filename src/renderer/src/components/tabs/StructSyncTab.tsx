import { useMemo, useState } from 'react'
import { App, Button, Select, Table as AntTable, Tag } from 'antd'
import { ArrowRight, GitCompareArrows, Play } from 'lucide-react'
import type { DbType, TableMeta } from '@shared/types'
import { useAppStore } from '@/stores/appStore'
import {
  alignDesignForSync,
  generateAlterTable,
  generateCreateTable,
  metaToDesign
} from '@/ddl'
import { quoteIdentFor } from '@/utils'

interface DiffItem {
  key: string
  table: string
  kind: 'create' | 'alter' | 'drop'
  statements: string[]
}

const KIND_META: Record<DiffItem['kind'], { label: string; color: string }> = {
  create: { label: '目标缺失，新建', color: 'green' },
  alter: { label: '结构差异，修改', color: 'orange' },
  drop: { label: '目标多余，删除', color: 'red' }
}

function familyOf(dbType?: DbType): string {
  return dbType === 'mariadb' ? 'mysql' : (dbType ?? '')
}

export function StructSyncTab(): React.JSX.Element {
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
  const [compared, setCompared] = useState(false)
  const [items, setItems] = useState<DiffItem[]>([])
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([])
  const [progress, setProgress] = useState('')

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
    if (!srcPid || !srcDb || !tgtPid || !tgtDb || !tgtProfile) return
    setComparing(true)
    setCompared(false)
    setItems([])
    try {
      await Promise.all([loadObjects(srcPid, srcDb, true), loadObjects(tgtPid, tgtDb, true)])
      const state = useAppStore.getState()
      const srcTables = (state.connections[srcPid]?.objects[srcDb] ?? [])
        .filter((o) => o.objectType === 'table')
        .map((o) => o.name)
      const tgtTables = (state.connections[tgtPid]?.objects[tgtDb] ?? [])
        .filter((o) => o.objectType === 'table')
        .map((o) => o.name)
      const tgtSet = new Set(tgtTables)
      const srcSet = new Set(srcTables)
      const dbType = tgtProfile.dbType
      const diffs: DiffItem[] = []

      // 公共表：拉两端元数据做 diff（限并发 6）
      const common = srcTables.filter((t) => tgtSet.has(t))
      let index = 0
      let done = 0
      setProgress(`0 / ${common.length}`)
      const workers = Array.from({ length: Math.min(6, common.length) }, async () => {
        while (index < common.length) {
          const table = common[index++]
          try {
            const [srcMeta, tgtMeta]: [TableMeta, TableMeta] = await Promise.all([
              window.skysql.conn.tableMeta(srcPid, srcDb, table),
              window.skysql.conn.tableMeta(tgtPid, tgtDb, table)
            ])
            const targetDesign = metaToDesign(table, tgtMeta)
            const aligned = alignDesignForSync(metaToDesign(table, srcMeta), targetDesign)
            const statements = generateAlterTable(
              dbType,
              tgtDb,
              { name: table, design: targetDesign, pkConstraint: tgtMeta.pkConstraint },
              aligned
            )
            if (statements.some((s) => !s.startsWith('--'))) {
              diffs.push({ key: `alter:${table}`, table, kind: 'alter', statements })
            }
          } catch (e) {
            diffs.push({
              key: `alter:${table}`,
              table,
              kind: 'alter',
              statements: [`-- 比对失败: ${e instanceof Error ? e.message : String(e)}`]
            })
          }
          done++
          setProgress(`${done} / ${common.length}`)
        }
      })
      await Promise.all(workers)

      // 仅源端存在 → 在目标创建
      for (const table of srcTables.filter((t) => !tgtSet.has(t))) {
        try {
          const meta = await window.skysql.conn.tableMeta(srcPid, srcDb, table)
          diffs.push({
            key: `create:${table}`,
            table,
            kind: 'create',
            statements: generateCreateTable(dbType, tgtDb, metaToDesign(table, meta))
          })
        } catch (e) {
          diffs.push({
            key: `create:${table}`,
            table,
            kind: 'create',
            statements: [`-- 读取源表失败: ${e instanceof Error ? e.message : String(e)}`]
          })
        }
      }

      // 仅目标存在 → 可选删除（默认不勾选）
      for (const table of tgtTables.filter((t) => !srcSet.has(t))) {
        diffs.push({
          key: `drop:${table}`,
          table,
          kind: 'drop',
          statements: [`DROP TABLE ${quoteIdentFor(dbType, table)}`]
        })
      }

      diffs.sort((a, b) => a.table.localeCompare(b.table))
      setItems(diffs)
      setSelectedKeys(diffs.filter((d) => d.kind !== 'drop').map((d) => d.key))
      setCompared(true)
      setStatus(`结构比对完成：${diffs.length} 处差异`)
    } catch (e) {
      message.error(`比对失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setComparing(false)
      setProgress('')
    }
  }

  const deploy = (): void => {
    if (!tgtPid || !tgtDb) return
    const selected = items.filter((d) => selectedKeys.includes(d.key))
    const statements = selected.flatMap((d) => d.statements).filter((s) => !s.startsWith('--'))
    if (statements.length === 0) {
      message.info('没有可执行的语句')
      return
    }
    modal.confirm({
      title: `将 ${statements.length} 条语句部署到目标库 "${tgtDb}"？`,
      width: 680,
      content: (
        <pre style={{ maxHeight: 320, overflow: 'auto', fontSize: 12 }}>
          {statements.join(';\n\n') + ';'}
        </pre>
      ),
      okText: '部署',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setDeploying(true)
        const errors: string[] = []
        try {
          for (const stmt of statements) {
            try {
              await window.skysql.conn.query(tgtPid, tgtDb, stmt)
            } catch (e) {
              errors.push(`${stmt.slice(0, 60)}... → ${e instanceof Error ? e.message : String(e)}`)
            }
          }
          if (errors.length === 0) {
            message.success('部署完成')
          } else {
            modal.error({
              title: `部署完成，但有 ${errors.length} 条语句失败`,
              width: 680,
              content: <pre style={{ maxHeight: 280, overflow: 'auto', fontSize: 12 }}>{errors.join('\n')}</pre>
            })
          }
          await loadObjects(tgtPid, tgtDb, true)
          await compare()
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
          disabled={!compared || selectedKeys.length === 0}
          onClick={deploy}
        >
          部署选中项
        </Button>
        {progress && <span className="sync-progress">比对中 {progress}</span>}
        {srcPid && tgtPid && !sameFamily && (
          <span className="wizard-error">源与目标的数据库类型不一致，暂不支持跨类型同步</span>
        )}
        {samePair && srcPid && <span className="wizard-error">源与目标不能是同一个库</span>}
      </div>
      <div className="sync-hint">
        说明：同步方向为「源 → 目标」，会让目标表结构与源一致（含删除目标多余的列/索引/外键）。
        「目标多余，删除」类差异默认不勾选；部署前请人工复核脚本。
      </div>
      <div className="sync-result">
        <AntTable<DiffItem>
          size="small"
          rowKey="key"
          dataSource={items}
          pagination={false}
          scroll={{ y: 'calc(100vh - 320px)' }}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: setSelectedKeys
          }}
          expandable={{
            expandedRowRender: (r) => (
              <pre className="sync-sql">{r.statements.join(';\n') + ';'}</pre>
            )
          }}
          columns={[
            { title: '表', dataIndex: 'table', width: 260 },
            {
              title: '差异类型',
              dataIndex: 'kind',
              width: 160,
              render: (k: DiffItem['kind']) => <Tag color={KIND_META[k].color}>{KIND_META[k].label}</Tag>
            },
            {
              title: '语句数',
              width: 90,
              align: 'right',
              render: (_, r) => r.statements.filter((s) => !s.startsWith('--')).length
            },
            {
              title: '预览',
              ellipsis: true,
              render: (_, r) => r.statements[0]
            }
          ]}
          locale={{
            emptyText: compared ? '两端结构一致，没有差异 🎉' : '选择源和目标后点击「比对」'
          }}
        />
      </div>
    </div>
  )
}
