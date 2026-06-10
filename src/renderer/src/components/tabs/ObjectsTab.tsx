import { useMemo, useState } from 'react'
import { App, Button, Input, Table as AntTable, Tooltip } from 'antd'
import { Code, Download, Eye, FolderOpen, List, Network, Pencil, Plus, RefreshCw, Table, Trash2, Upload } from 'lucide-react'
import type { DbObjectInfo } from '@shared/types'
import { useAppStore } from '@/stores/appStore'
import { quoteIdentFor } from '@/utils'
import { UsersPane } from '@/components/UsersPane'
import { ERDiagram } from '@/components/ERDiagram'

export function ObjectsTab(): React.JSX.Element {
  const { message, modal } = App.useApp()
  const current = useAppStore((s) => s.current)
  const profiles = useAppStore((s) => s.profiles)
  const connections = useAppStore((s) => s.connections)
  const category = useAppStore((s) => s.category)
  const loadObjects = useAppStore((s) => s.loadObjects)
  const openTableTab = useAppStore((s) => s.openTableTab)
  const openDesignTab = useAppStore((s) => s.openDesignTab)
  const openExportDialog = useAppStore((s) => s.openExportDialog)
  const openImportDialog = useAppStore((s) => s.openImportDialog)

  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<DbObjectInfo | null>(null)
  const [viewMode, setViewMode] = useState<'list' | 'er'>('list')

  const profile = profiles.find((p) => p.id === current.profileId)
  const conn = current.profileId ? connections[current.profileId] : undefined
  const objects = conn && current.database ? conn.objects[current.database] : undefined

  const filtered = useMemo(() => {
    const byCategory = (objects ?? []).filter((o) => {
      if (category === 'tables') return o.objectType === 'table'
      if (category === 'views') return o.objectType === 'view'
      return o.objectType === 'function' || o.objectType === 'procedure'
    })
    if (!search) return byCategory
    return byCategory.filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))
  }, [objects, category, search])

  const canOpen = selected && (selected.objectType === 'table' || selected.objectType === 'view')

  const handleOpen = (obj?: DbObjectInfo): void => {
    const target = obj ?? selected
    if (!target || !current.profileId || !current.database) return
    if (target.objectType === 'table' || target.objectType === 'view') {
      openTableTab(current.profileId, current.database, target.name)
    }
  }

  const handleDrop = (): void => {
    if (!selected || !profile || !current.profileId || !current.database) return
    const kindLabel = selected.objectType === 'view' ? '视图' : '表'
    const stmt = `DROP ${selected.objectType === 'view' ? 'VIEW' : 'TABLE'} ${quoteIdentFor(profile.dbType, selected.name)}`
    modal.confirm({
      title: `确定删除${kindLabel} "${selected.name}" 吗？`,
      content: '此操作不可恢复！',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await window.skysql.conn.query(current.profileId!, current.database!, stmt)
          message.success(`${kindLabel} ${selected.name} 已删除`)
          setSelected(null)
          await loadObjects(current.profileId!, current.database!, true)
        } catch (e) {
          message.error(`删除失败: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    })
  }

  const categoryLabel = category === 'tables' ? '表' : category === 'views' ? '视图' : '函数'

  if (category === 'users') {
    return <UsersPane />
  }

  if (!current.profileId || !current.database) {
    return (
      <div className="objects-empty">
        <p>在左侧导航中打开连接并选择数据库，即可浏览其中的对象。</p>
      </div>
    )
  }

  return (
    <div className="objects-tab">
      <div className="object-toolbar">
        <Button
          size="small"
          type="text"
          icon={<FolderOpen size={14} />}
          disabled={!canOpen}
          onClick={() => handleOpen()}
        >
          打开{categoryLabel}
        </Button>
        {category === 'tables' ? (
          <>
            <Button
              size="small"
              type="text"
              icon={<Pencil size={14} />}
              disabled={!selected || selected.objectType !== 'table'}
              onClick={() =>
                selected && openDesignTab(current.profileId!, current.database!, selected.name)
              }
            >
              设计表
            </Button>
            <Button
              size="small"
              type="text"
              icon={<Plus size={14} />}
              onClick={() => openDesignTab(current.profileId!, current.database!)}
            >
              新建表
            </Button>
          </>
        ) : (
          <Tooltip title="后续版本提供">
            <Button size="small" type="text" icon={<Pencil size={14} />} disabled>
              设计{categoryLabel}
            </Button>
          </Tooltip>
        )}
        <Button
          size="small"
          type="text"
          danger
          icon={<Trash2 size={14} />}
          disabled={!canOpen}
          onClick={handleDrop}
        >
          删除{categoryLabel}
        </Button>
        <Button
          size="small"
          type="text"
          icon={<Upload size={14} />}
          onClick={() =>
            openImportDialog(current.profileId!, current.database!, selected?.name)
          }
        >
          导入向导
        </Button>
        <Button
          size="small"
          type="text"
          icon={<Download size={14} />}
          disabled={!selected || (selected.objectType !== 'table' && selected.objectType !== 'view')}
          onClick={() => openExportDialog(current.profileId!, current.database!, selected!.name)}
        >
          导出向导
        </Button>
        <Button
          size="small"
          type="text"
          icon={<RefreshCw size={14} />}
          onClick={() => void loadObjects(current.profileId!, current.database!, true)}
        >
          刷新
        </Button>
        <span className="object-toolbar-spacer" />
        {category === 'tables' && (
          <Button.Group size="small">
            <Button
              type={viewMode === 'list' ? 'primary' : 'default'}
              icon={<List size={13} />}
              onClick={() => setViewMode('list')}
            >
              列表
            </Button>
            <Button
              type={viewMode === 'er' ? 'primary' : 'default'}
              icon={<Network size={13} />}
              onClick={() => setViewMode('er')}
            >
              ER 图
            </Button>
          </Button.Group>
        )}
        <Input.Search
          size="small"
          placeholder={`搜索${categoryLabel}`}
          style={{ width: 200 }}
          allowClear
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {category === 'tables' && viewMode === 'er' ? (
        <ERDiagram />
      ) : (
        <ObjectListBody />
      )}
    </div>
  )

  function ObjectListBody(): React.JSX.Element {
    return (
      <div className="object-table">
        <AntTable<DbObjectInfo>
          size="small"
          rowKey="name"
          dataSource={filtered}
          pagination={false}
          scroll={{ y: 'calc(100vh - 270px)' }}
          rowClassName={(r) => (selected?.name === r.name ? 'object-row-selected' : '')}
          onRow={(record) => ({
            onClick: () => setSelected(record),
            onDoubleClick: () => handleOpen(record)
          })}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              render: (name: string, r) => (
                <span className="object-name">
                  {r.objectType === 'view' ? (
                    <Eye size={14} className="tree-icon view" />
                  ) : r.objectType === 'table' ? (
                    <Table size={14} className="tree-icon table" />
                  ) : (
                    <Code size={14} className="tree-icon func" />
                  )}
                  {name}
                </span>
              )
            },
            {
              title: '行',
              dataIndex: 'rowCount',
              width: 110,
              align: 'right',
              render: (v: number | null | undefined) => (v == null ? '-' : v.toLocaleString())
            },
            { title: '引擎', dataIndex: 'engine', width: 110, render: (v?: string) => v ?? '-' },
            {
              title: '修改日期',
              dataIndex: 'modifiedAt',
              width: 170,
              render: (v?: string) => v ?? '-'
            },
            { title: '注释', dataIndex: 'comment', ellipsis: true, render: (v?: string) => v ?? '' }
          ]}
        />
      </div>
    )
  }
}
