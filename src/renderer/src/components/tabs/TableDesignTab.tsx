import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App,
  AutoComplete,
  Button,
  Checkbox,
  Input,
  Select,
  Table as AntTable,
  Tabs
} from 'antd'
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from 'lucide-react'
import type { DbType } from '@shared/types'
import { useAppStore, type TabState } from '@/stores/appStore'
import {
  emptyColumn,
  generateAlterTable,
  generateCreateTable,
  metaToDesign,
  newTableDesign,
  nextKey,
  type DesignColumn,
  type DesignFk,
  type DesignIndex,
  type TableDesign
} from '@/ddl'

const TYPE_OPTIONS: Record<string, string[]> = {
  mysql: [
    'int', 'bigint', 'smallint', 'tinyint', 'mediumint', 'decimal', 'float', 'double',
    'varchar', 'char', 'text', 'mediumtext', 'longtext', 'json',
    'datetime', 'timestamp', 'date', 'time', 'year',
    'blob', 'mediumblob', 'longblob', 'bit', 'enum', 'set'
  ],
  postgresql: [
    'integer', 'bigint', 'smallint', 'serial', 'bigserial', 'numeric', 'real', 'double precision',
    'character varying', 'character', 'text', 'boolean', 'json', 'jsonb', 'uuid', 'bytea',
    'date', 'time', 'timestamp', 'timestamptz', 'interval'
  ],
  sqlite: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB'],
  sqlserver: [
    'int', 'bigint', 'smallint', 'tinyint', 'bit', 'decimal', 'numeric', 'money', 'float', 'real',
    'nvarchar', 'varchar', 'nchar', 'char', 'ntext', 'text', 'uniqueidentifier', 'xml',
    'datetime2', 'datetime', 'smalldatetime', 'datetimeoffset', 'date', 'time',
    'varbinary', 'binary', 'image'
  ]
}

const FK_RULES = ['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL', 'SET DEFAULT']

const INDEX_METHODS: Record<string, string[]> = {
  mysql: ['BTREE', 'HASH'],
  postgresql: ['btree', 'hash', 'gin', 'gist', 'brin'],
  sqlite: [],
  sqlserver: ['NONCLUSTERED', 'CLUSTERED']
}

function typeOptionsFor(dbType?: DbType): string[] {
  if (!dbType) return []
  if (dbType === 'mariadb') return TYPE_OPTIONS.mysql
  return TYPE_OPTIONS[dbType] ?? []
}

export function TableDesignTab({ tab }: { tab: TabState }): React.JSX.Element {
  const { message, modal } = App.useApp()
  const profiles = useAppStore((s) => s.profiles)
  const connections = useAppStore((s) => s.connections)
  const loadObjects = useAppStore((s) => s.loadObjects)
  const updateTab = useAppStore((s) => s.updateTab)

  const { profileId, database } = tab
  const profile = profiles.find((p) => p.id === profileId)
  const dbType = profile?.dbType
  const isMySql = dbType === 'mysql' || dbType === 'mariadb'

  const [design, setDesign] = useState<TableDesign | null>(null)
  const [original, setOriginal] = useState<{
    name: string
    design: TableDesign
    pkConstraint?: string
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [selectedCol, setSelectedCol] = useState<string>()
  const [selectedIdx, setSelectedIdx] = useState<string>()
  const [selectedFk, setSelectedFk] = useState<string>()
  const [refColsCache, setRefColsCache] = useState<Record<string, string[]>>({})

  const loadMeta = useCallback(
    async (table: string): Promise<void> => {
      if (!profileId || !database) return
      try {
        const meta = await window.skysql.conn.tableMeta(profileId, database, table)
        setDesign(metaToDesign(table, meta))
        setOriginal({ name: table, design: metaToDesign(table, meta), pkConstraint: meta.pkConstraint })
      } catch (e) {
        message.error(`加载表结构失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    [profileId, database, message]
  )

  useEffect(() => {
    if (tab.table) {
      void loadMeta(tab.table)
    } else {
      setDesign(newTableDesign())
      setOriginal(null)
    }
    // 仅初始化时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (profileId && database) void loadObjects(profileId, database)
  }, [profileId, database, loadObjects])

  const tableOptions = useMemo(() => {
    const objects = profileId && database ? (connections[profileId]?.objects[database] ?? []) : []
    return objects.filter((o) => o.objectType === 'table').map((o) => ({ value: o.name, label: o.name }))
  }, [connections, profileId, database])

  const fetchRefCols = useCallback(
    async (refTable: string): Promise<void> => {
      if (!profileId || !database || refColsCache[refTable]) return
      try {
        const cols = await window.skysql.conn.tableColumns(profileId, database, refTable)
        setRefColsCache((prev) => ({ ...prev, [refTable]: cols.map((c) => c.name) }))
      } catch {
        // 引用表读取失败时让用户手动输入
      }
    },
    [profileId, database, refColsCache]
  )

  const statements = useMemo(() => {
    if (!design || !dbType || !database) return []
    if (!design.name) return ['-- 请填写表名']
    return original
      ? generateAlterTable(dbType, database, original, design)
      : generateCreateTable(dbType, database, design)
  }, [design, dbType, database, original])

  const patch = (p: Partial<TableDesign>): void => setDesign((d) => (d ? { ...d, ...p } : d))
  const patchCol = (key: string, p: Partial<DesignColumn>): void =>
    setDesign((d) =>
      d ? { ...d, columns: d.columns.map((c) => (c.key === key ? { ...c, ...p } : c)) } : d
    )
  const patchIdx = (key: string, p: Partial<DesignIndex>): void =>
    setDesign((d) =>
      d ? { ...d, indexes: d.indexes.map((i) => (i.key === key ? { ...i, ...p } : i)) } : d
    )
  const patchFk = (key: string, p: Partial<DesignFk>): void =>
    setDesign((d) =>
      d ? { ...d, foreignKeys: d.foreignKeys.map((f) => (f.key === key ? { ...f, ...p } : f)) } : d
    )

  const addColumn = (after?: boolean): void => {
    setDesign((d) => {
      if (!d) return d
      const col = emptyColumn()
      const idx = selectedCol ? d.columns.findIndex((c) => c.key === selectedCol) : -1
      const columns = [...d.columns]
      if (after === false && idx >= 0) columns.splice(idx, 0, col)
      else columns.push(col)
      setSelectedCol(col.key)
      return { ...d, columns }
    })
  }

  const removeColumn = (): void => {
    if (!selectedCol) return
    setDesign((d) => (d ? { ...d, columns: d.columns.filter((c) => c.key !== selectedCol) } : d))
    setSelectedCol(undefined)
  }

  const moveColumn = (dir: -1 | 1): void => {
    if (!selectedCol) return
    setDesign((d) => {
      if (!d) return d
      const idx = d.columns.findIndex((c) => c.key === selectedCol)
      const target = idx + dir
      if (idx < 0 || target < 0 || target >= d.columns.length) return d
      const columns = [...d.columns]
      ;[columns[idx], columns[target]] = [columns[target], columns[idx]]
      return { ...d, columns }
    })
  }

  const handleSave = (): void => {
    if (!design || !profileId || !database) return
    if (!design.name.trim()) {
      message.warning('请填写表名')
      return
    }
    const executable = statements.filter((s) => !s.startsWith('--'))
    if (executable.length === 0) {
      message.info('没有需要保存的更改')
      return
    }
    modal.confirm({
      title: original ? '保存表结构更改' : '创建表',
      width: 640,
      content: (
        <pre style={{ maxHeight: 320, overflow: 'auto', fontSize: 12 }}>
          {statements.join(';\n\n') + ';'}
        </pre>
      ),
      okText: '执行',
      cancelText: '取消',
      onOk: async () => {
        setSaving(true)
        try {
          for (const stmt of executable) {
            await window.skysql.conn.query(profileId, database, stmt)
          }
          message.success(original ? '表结构已更新' : `表 ${design.name} 已创建`)
          await loadObjects(profileId, database, true)
          updateTab(tab.id, { table: design.name, title: `设计表 ${design.name}` })
          await loadMeta(design.name)
        } catch (e) {
          message.error(`执行失败: ${e instanceof Error ? e.message : String(e)}`)
          throw e
        } finally {
          setSaving(false)
        }
      }
    })
  }

  if (!design) {
    return <div className="objects-empty">加载中...</div>
  }

  const columnNames = design.columns.filter((c) => c.name).map((c) => c.name)
  const methodOptions = INDEX_METHODS[isMySql ? 'mysql' : (dbType ?? 'sqlite')] ?? []

  const fieldsPane = (
    <div className="design-pane">
      <div className="design-pane-toolbar">
        <Button size="small" type="text" icon={<Plus size={14} />} onClick={() => addColumn()}>
          添加字段
        </Button>
        <Button size="small" type="text" icon={<Plus size={14} />} onClick={() => addColumn(false)}>
          插入字段
        </Button>
        <Button
          size="small"
          type="text"
          danger
          icon={<Trash2 size={14} />}
          disabled={!selectedCol}
          onClick={removeColumn}
        >
          删除字段
        </Button>
        <Button
          size="small"
          type="text"
          icon={<ArrowUp size={14} />}
          disabled={!selectedCol}
          onClick={() => moveColumn(-1)}
        >
          上移
        </Button>
        <Button
          size="small"
          type="text"
          icon={<ArrowDown size={14} />}
          disabled={!selectedCol}
          onClick={() => moveColumn(1)}
        >
          下移
        </Button>
      </div>
      <AntTable<DesignColumn>
        size="small"
        rowKey="key"
        dataSource={design.columns}
        pagination={false}
        scroll={{ y: 'calc(100vh - 320px)' }}
        rowClassName={(r) => (r.key === selectedCol ? 'object-row-selected' : '')}
        onRow={(r) => ({ onClick: () => setSelectedCol(r.key) })}
        columns={[
          {
            title: '名',
            dataIndex: 'name',
            width: 180,
            render: (_, r) => (
              <Input
                size="small"
                value={r.name}
                onChange={(e) => patchCol(r.key, { name: e.target.value })}
              />
            )
          },
          {
            title: '类型',
            dataIndex: 'type',
            width: 170,
            render: (_, r) => (
              <AutoComplete
                size="small"
                style={{ width: '100%' }}
                value={r.type}
                options={typeOptionsFor(dbType).map((t) => ({ value: t }))}
                filterOption={(input, opt) =>
                  String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase())
                }
                onChange={(v) => patchCol(r.key, { type: v })}
              />
            )
          },
          {
            title: '长度',
            dataIndex: 'length',
            width: 80,
            render: (_, r) => (
              <Input
                size="small"
                value={r.length}
                onChange={(e) => patchCol(r.key, { length: e.target.value.replace(/\D/g, '') })}
              />
            )
          },
          {
            title: '小数点',
            dataIndex: 'scale',
            width: 80,
            render: (_, r) => (
              <Input
                size="small"
                value={r.scale}
                onChange={(e) => patchCol(r.key, { scale: e.target.value.replace(/\D/g, '') })}
              />
            )
          },
          {
            title: '不是 null',
            dataIndex: 'notNull',
            width: 80,
            align: 'center',
            render: (_, r) => (
              <Checkbox
                checked={r.notNull}
                onChange={(e) => patchCol(r.key, { notNull: e.target.checked })}
              />
            )
          },
          {
            title: '主键',
            dataIndex: 'pk',
            width: 60,
            align: 'center',
            render: (_, r) => (
              <Checkbox
                checked={r.pk}
                onChange={(e) =>
                  patchCol(r.key, { pk: e.target.checked, notNull: e.target.checked || r.notNull })
                }
              />
            )
          },
          {
            title: '自增',
            dataIndex: 'autoIncrement',
            width: 60,
            align: 'center',
            render: (_, r) => (
              <Checkbox
                checked={r.autoIncrement}
                onChange={(e) => patchCol(r.key, { autoIncrement: e.target.checked })}
              />
            )
          },
          {
            title: '默认值',
            dataIndex: 'defaultValue',
            width: 150,
            render: (_, r) => (
              <Input
                size="small"
                value={r.defaultValue}
                placeholder="无"
                disabled={r.autoIncrement}
                onChange={(e) => patchCol(r.key, { defaultValue: e.target.value })}
              />
            )
          },
          ...(dbType === 'sqlite' || dbType === 'sqlserver'
            ? []
            : [
                {
                  title: '注释',
                  dataIndex: 'comment',
                  render: (_: unknown, r: DesignColumn) => (
                    <Input
                      size="small"
                      value={r.comment}
                      onChange={(e) => patchCol(r.key, { comment: e.target.value })}
                    />
                  )
                }
              ])
        ]}
      />
    </div>
  )

  const indexesPane = (
    <div className="design-pane">
      <div className="design-pane-toolbar">
        <Button
          size="small"
          type="text"
          icon={<Plus size={14} />}
          onClick={() =>
            setDesign((d) =>
              d
                ? {
                    ...d,
                    indexes: [
                      ...d.indexes,
                      { key: nextKey(), name: '', columns: [], unique: false }
                    ]
                  }
                : d
            )
          }
        >
          添加索引
        </Button>
        <Button
          size="small"
          type="text"
          danger
          icon={<Trash2 size={14} />}
          disabled={!selectedIdx}
          onClick={() => {
            setDesign((d) =>
              d ? { ...d, indexes: d.indexes.filter((i) => i.key !== selectedIdx) } : d
            )
            setSelectedIdx(undefined)
          }}
        >
          删除索引
        </Button>
      </div>
      <AntTable<DesignIndex>
        size="small"
        rowKey="key"
        dataSource={design.indexes}
        pagination={false}
        rowClassName={(r) => (r.key === selectedIdx ? 'object-row-selected' : '')}
        onRow={(r) => ({ onClick: () => setSelectedIdx(r.key) })}
        columns={[
          {
            title: '名',
            dataIndex: 'name',
            width: 220,
            render: (_, r) => (
              <Input
                size="small"
                value={r.name}
                onChange={(e) => patchIdx(r.key, { name: e.target.value })}
              />
            )
          },
          {
            title: '字段',
            dataIndex: 'columns',
            render: (_, r) => (
              <Select
                size="small"
                mode="multiple"
                style={{ width: '100%' }}
                value={r.columns}
                onChange={(v) => patchIdx(r.key, { columns: v })}
                options={columnNames.map((n) => ({ value: n, label: n }))}
              />
            )
          },
          {
            title: '唯一',
            dataIndex: 'unique',
            width: 60,
            align: 'center',
            render: (_, r) => (
              <Checkbox
                checked={r.unique}
                onChange={(e) => patchIdx(r.key, { unique: e.target.checked })}
              />
            )
          },
          ...(methodOptions.length
            ? [
                {
                  title: '索引方法',
                  dataIndex: 'method',
                  width: 130,
                  render: (_: unknown, r: DesignIndex) => (
                    <Select
                      size="small"
                      style={{ width: '100%' }}
                      allowClear
                      value={r.method}
                      onChange={(v) => patchIdx(r.key, { method: v })}
                      options={methodOptions.map((m) => ({ value: m, label: m }))}
                    />
                  )
                }
              ]
            : [])
        ]}
      />
    </div>
  )

  const fksPane = (
    <div className="design-pane">
      <div className="design-pane-toolbar">
        <Button
          size="small"
          type="text"
          icon={<Plus size={14} />}
          onClick={() =>
            setDesign((d) =>
              d
                ? {
                    ...d,
                    foreignKeys: [
                      ...d.foreignKeys,
                      {
                        key: nextKey(),
                        name: `fk_${d.name || 'table'}_${d.foreignKeys.length + 1}`,
                        columns: [],
                        refTable: '',
                        refColumns: [],
                        onUpdate: 'NO ACTION',
                        onDelete: 'NO ACTION'
                      }
                    ]
                  }
                : d
            )
          }
        >
          添加外键
        </Button>
        <Button
          size="small"
          type="text"
          danger
          icon={<Trash2 size={14} />}
          disabled={!selectedFk}
          onClick={() => {
            setDesign((d) =>
              d ? { ...d, foreignKeys: d.foreignKeys.filter((f) => f.key !== selectedFk) } : d
            )
            setSelectedFk(undefined)
          }}
        >
          删除外键
        </Button>
      </div>
      <AntTable<DesignFk>
        size="small"
        rowKey="key"
        dataSource={design.foreignKeys}
        pagination={false}
        rowClassName={(r) => (r.key === selectedFk ? 'object-row-selected' : '')}
        onRow={(r) => ({ onClick: () => setSelectedFk(r.key) })}
        columns={[
          {
            title: '名',
            dataIndex: 'name',
            width: 180,
            render: (_, r) => (
              <Input
                size="small"
                value={r.name}
                onChange={(e) => patchFk(r.key, { name: e.target.value })}
              />
            )
          },
          {
            title: '字段',
            dataIndex: 'columns',
            width: 180,
            render: (_, r) => (
              <Select
                size="small"
                mode="multiple"
                style={{ width: '100%' }}
                value={r.columns}
                onChange={(v) => patchFk(r.key, { columns: v })}
                options={columnNames.map((n) => ({ value: n, label: n }))}
              />
            )
          },
          {
            title: '被引用的表',
            dataIndex: 'refTable',
            width: 180,
            render: (_, r) => (
              <Select
                size="small"
                showSearch
                style={{ width: '100%' }}
                value={r.refTable || undefined}
                onChange={(v) => {
                  patchFk(r.key, { refTable: v, refColumns: [] })
                  void fetchRefCols(v)
                }}
                options={tableOptions}
              />
            )
          },
          {
            title: '被引用的字段',
            dataIndex: 'refColumns',
            width: 180,
            render: (_, r) => (
              <Select
                size="small"
                mode="multiple"
                style={{ width: '100%' }}
                value={r.refColumns}
                onChange={(v) => patchFk(r.key, { refColumns: v })}
                options={(refColsCache[r.refTable] ?? []).map((n) => ({ value: n, label: n }))}
              />
            )
          },
          {
            title: '删除时',
            dataIndex: 'onDelete',
            width: 130,
            render: (_, r) => (
              <Select
                size="small"
                style={{ width: '100%' }}
                value={r.onDelete}
                onChange={(v) => patchFk(r.key, { onDelete: v })}
                options={FK_RULES.map((x) => ({ value: x, label: x }))}
              />
            )
          },
          {
            title: '更新时',
            dataIndex: 'onUpdate',
            width: 130,
            render: (_, r) => (
              <Select
                size="small"
                style={{ width: '100%' }}
                value={r.onUpdate}
                onChange={(v) => patchFk(r.key, { onUpdate: v })}
                options={FK_RULES.map((x) => ({ value: x, label: x }))}
              />
            )
          }
        ]}
      />
    </div>
  )

  const optionsPane = (
    <div className="design-pane design-options">
      {isMySql && (
        <>
          <div className="design-option-row">
            <label>引擎</label>
            <Select
              size="small"
              style={{ width: 200 }}
              value={design.engine}
              onChange={(v) => patch({ engine: v })}
              options={['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE', 'CSV'].map((x) => ({
                value: x,
                label: x
              }))}
            />
          </div>
          <div className="design-option-row">
            <label>字符集</label>
            <Select
              size="small"
              style={{ width: 200 }}
              allowClear
              value={design.charset}
              onChange={(v) => patch({ charset: v })}
              options={['utf8mb4', 'utf8', 'latin1', 'gbk', 'binary'].map((x) => ({
                value: x,
                label: x
              }))}
            />
          </div>
          <div className="design-option-row">
            <label>排序规则</label>
            <Input
              size="small"
              style={{ width: 200 }}
              value={design.collation ?? ''}
              placeholder="默认"
              onChange={(e) => patch({ collation: e.target.value || undefined })}
            />
          </div>
        </>
      )}
      {dbType !== 'sqlite' && dbType !== 'sqlserver' && (
        <div className="design-option-row design-option-comment">
          <label>表注释</label>
          <Input.TextArea
            rows={3}
            style={{ width: 420 }}
            value={design.comment}
            onChange={(e) => patch({ comment: e.target.value })}
          />
        </div>
      )}
      {dbType === 'sqlite' && !isMySql && (
        <div className="design-option-hint">SQLite 没有表级选项。</div>
      )}
      {dbType === 'sqlserver' && (
        <div className="design-option-hint">SQL Server 的表/列注释（扩展属性）暂不支持在设计器中编辑。</div>
      )}
    </div>
  )

  const previewPane = (
    <div className="design-pane">
      <pre className="sql-preview">{statements.length ? statements.join(';\n\n') + ';' : '-- 没有更改'}</pre>
    </div>
  )

  return (
    <div className="design-tab">
      <div className="design-toolbar">
        <Button
          size="small"
          type="primary"
          icon={<Save size={14} />}
          loading={saving}
          onClick={handleSave}
        >
          保存
        </Button>
        <span className="design-name-label">表名</span>
        <Input
          size="small"
          style={{ width: 220 }}
          value={design.name}
          placeholder={dbType === 'postgresql' || dbType === 'sqlserver' ? 'schema.表名 或 表名' : '表名'}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </div>
      <Tabs
        size="small"
        className="design-tabs"
        items={[
          { key: 'fields', label: '字段', children: fieldsPane },
          { key: 'indexes', label: '索引', children: indexesPane },
          { key: 'fks', label: '外键', children: fksPane },
          { key: 'options', label: '选项', children: optionsPane },
          { key: 'preview', label: 'SQL 预览', children: previewPane }
        ]}
      />
    </div>
  )
}
