import { useMemo, useState } from 'react'
import { App, Dropdown, Input, Tree, type MenuProps, type TreeDataNode } from 'antd'
import { Code, Database, Eye, Server, Table } from 'lucide-react'
import type { ConnectionProfile, DbObjectInfo } from '@shared/types'
import { useAppStore } from '@/stores/appStore'

type NodeMeta =
  | { type: 'conn'; profile: ConnectionProfile }
  | { type: 'db'; profileId: string; database: string }
  | { type: 'cat'; profileId: string; database: string; category: 'tables' | 'views' | 'functions' }
  | { type: 'obj'; profileId: string; database: string; object: DbObjectInfo }

const metaMap = new Map<string, NodeMeta>()

function objIcon(o: DbObjectInfo): React.ReactNode {
  if (o.objectType === 'view') return <Eye size={14} className="tree-icon view" />
  if (o.objectType === 'table') return <Table size={14} className="tree-icon table" />
  return <Code size={14} className="tree-icon func" />
}

export function ConnectionTree(): React.JSX.Element {
  const { message, modal } = App.useApp()
  const profiles = useAppStore((s) => s.profiles)
  const connections = useAppStore((s) => s.connections)
  const openConnection = useAppStore((s) => s.openConnection)
  const closeConnection = useAppStore((s) => s.closeConnection)
  const loadObjects = useAppStore((s) => s.loadObjects)
  const loadProfiles = useAppStore((s) => s.loadProfiles)
  const setCurrent = useAppStore((s) => s.setCurrent)
  const openTableTab = useAppStore((s) => s.openTableTab)
  const openQueryTab = useAppStore((s) => s.openQueryTab)
  const openDesignTab = useAppStore((s) => s.openDesignTab)
  const openConnDialog = useAppStore((s) => s.openConnDialog)
  const setStatus = useAppStore((s) => s.setStatus)

  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])
  const [filter, setFilter] = useState('')

  const treeData = useMemo<TreeDataNode[]>(() => {
    metaMap.clear()
    const list = filter
      ? profiles.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
      : profiles
    return list.map((p) => {
      const connKey = `conn:${p.id}`
      const conn = connections[p.id]
      metaMap.set(connKey, { type: 'conn', profile: p })
      const node: TreeDataNode = {
        key: connKey,
        title: p.name,
        icon: (
          <Server
            size={15}
            className={`tree-icon conn${conn ? ' open' : ''}`}
            style={p.color ? { color: p.color } : undefined}
          />
        ),
        children: conn
          ? conn.databases.map((db) => {
              const dbKey = `db:${p.id}:${db}`
              metaMap.set(dbKey, { type: 'db', profileId: p.id, database: db })
              const objects = conn.objects[db]
              const categories: {
                key: 'tables' | 'views' | 'functions'
                label: string
                filter: (o: DbObjectInfo) => boolean
              }[] = [
                { key: 'tables', label: '表', filter: (o) => o.objectType === 'table' },
                { key: 'views', label: '视图', filter: (o) => o.objectType === 'view' },
                {
                  key: 'functions',
                  label: '函数',
                  filter: (o) => o.objectType === 'function' || o.objectType === 'procedure'
                }
              ]
              return {
                key: dbKey,
                title: db,
                icon: <Database size={14} className="tree-icon db" />,
                children: categories.map((cat) => {
                  const catKey = `cat:${p.id}:${db}:${cat.key}`
                  metaMap.set(catKey, {
                    type: 'cat',
                    profileId: p.id,
                    database: db,
                    category: cat.key
                  })
                  const items = (objects ?? []).filter(cat.filter)
                  return {
                    key: catKey,
                    title: objects ? `${cat.label} (${items.length})` : cat.label,
                    selectable: false,
                    children: items.map((o) => {
                      const objKey = `obj:${p.id}:${db}:${o.objectType}:${o.name}`
                      metaMap.set(objKey, {
                        type: 'obj',
                        profileId: p.id,
                        database: db,
                        object: o
                      })
                      return { key: objKey, title: o.name, icon: objIcon(o), isLeaf: true }
                    })
                  }
                })
              }
            })
          : []
      }
      return node
    })
  }, [profiles, connections, filter])

  const handleOpenConnection = async (profile: ConnectionProfile): Promise<void> => {
    setStatus(`正在连接 ${profile.name}...`)
    try {
      await openConnection(profile.id)
      setExpandedKeys((keys) => [...keys, `conn:${profile.id}`])
      setStatus(`已连接 ${profile.name}`)
    } catch (e) {
      setStatus('连接失败')
      message.error(`连接失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleExpand = async (keys: React.Key[], info: { node: TreeDataNode }): Promise<void> => {
    setExpandedKeys(keys)
    const meta = metaMap.get(String(info.node.key))
    if (meta?.type === 'db') {
      try {
        await loadObjects(meta.profileId, meta.database)
      } catch (e) {
        message.error(`加载对象失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  const handleDoubleClick = (key: string): void => {
    const meta = metaMap.get(key)
    if (!meta) return
    if (meta.type === 'conn') {
      if (!connections[meta.profile.id]) void handleOpenConnection(meta.profile)
    } else if (meta.type === 'obj') {
      if (meta.object.objectType === 'table' || meta.object.objectType === 'view') {
        openTableTab(meta.profileId, meta.database, meta.object.name)
      }
    }
  }

  const handleSelect = (keys: React.Key[]): void => {
    const meta = metaMap.get(String(keys[0] ?? ''))
    if (!meta) return
    if (meta.type === 'conn') {
      setCurrent(meta.profile.id, undefined)
    } else if (meta.type === 'db' || meta.type === 'cat' || meta.type === 'obj') {
      setCurrent(meta.profileId, meta.database)
    }
  }

  const contextMenuFor = (key: string): MenuProps['items'] => {
    const meta = metaMap.get(key)
    if (!meta) return []
    if (meta.type === 'conn') {
      const isOpen = Boolean(connections[meta.profile.id])
      return [
        isOpen
          ? { key: 'close', label: '关闭连接', onClick: () => void closeConnection(meta.profile.id) }
          : { key: 'open', label: '打开连接', onClick: () => void handleOpenConnection(meta.profile) },
        { type: 'divider' },
        {
          key: 'edit',
          label: '编辑连接...',
          onClick: () => openConnDialog({ dbType: meta.profile.dbType, profile: meta.profile })
        },
        {
          key: 'delete',
          label: '删除连接',
          danger: true,
          onClick: () =>
            modal.confirm({
              title: `确定删除连接 "${meta.profile.name}" 吗？`,
              okText: '删除',
              okButtonProps: { danger: true },
              cancelText: '取消',
              onOk: async () => {
                await window.skysql.profiles.remove(meta.profile.id)
                await loadProfiles()
              }
            })
        }
      ]
    }
    if (meta.type === 'db') {
      return [
        {
          key: 'query',
          label: '新建查询',
          onClick: () => openQueryTab(meta.profileId, meta.database)
        },
        {
          key: 'newtable',
          label: '新建表',
          onClick: () => openDesignTab(meta.profileId, meta.database)
        },
        {
          key: 'refresh',
          label: '刷新',
          onClick: () => void loadObjects(meta.profileId, meta.database, true)
        }
      ]
    }
    if (meta.type === 'cat') {
      return [
        {
          key: 'refresh',
          label: '刷新',
          onClick: () => void loadObjects(meta.profileId, meta.database, true)
        }
      ]
    }
    if (meta.type === 'obj' && (meta.object.objectType === 'table' || meta.object.objectType === 'view')) {
      const items: MenuProps['items'] = [
        {
          key: 'open',
          label: meta.object.objectType === 'view' ? '打开视图' : '打开表',
          onClick: () => openTableTab(meta.profileId, meta.database, meta.object.name)
        }
      ]
      if (meta.object.objectType === 'table') {
        items.push({
          key: 'design',
          label: '设计表',
          onClick: () => openDesignTab(meta.profileId, meta.database, meta.object.name)
        })
      }
      return items
    }
    return []
  }

  return (
    <div className="connection-tree">
      <div className="tree-search">
        <Input.Search
          placeholder="筛选连接"
          size="small"
          allowClear
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="tree-body">
        <Tree
          showIcon
          blockNode
          treeData={treeData}
          expandedKeys={expandedKeys}
          onExpand={(keys, info) => void handleExpand(keys, info)}
          onSelect={handleSelect}
          onDoubleClick={(_e, node) => handleDoubleClick(String(node.key))}
          titleRender={(node) => (
            <Dropdown menu={{ items: contextMenuFor(String(node.key)) }} trigger={['contextMenu']}>
              <span className="tree-title">{node.title as React.ReactNode}</span>
            </Dropdown>
          )}
        />
        {profiles.length === 0 && (
          <div className="tree-empty">
            暂无连接
            <br />
            点击工具栏「连接」新建
          </div>
        )}
      </div>
    </div>
  )
}
