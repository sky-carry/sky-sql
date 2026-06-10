import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from 'dagre'
import { App, Button, Spin } from 'antd'
import { KeyRound, Link2, Table } from 'lucide-react'
import type { TableMeta } from '@shared/types'
import { useAppStore } from '@/stores/appStore'

const NODE_WIDTH = 230
const HEADER_HEIGHT = 34
const ROW_HEIGHT = 22
const MAX_COLUMNS_SHOWN = 30
/** 表数量超过该值时需要用户确认再加载 */
const AUTO_LOAD_LIMIT = 60

interface TableNodeData extends Record<string, unknown> {
  table: string
  meta: TableMeta
  fkColumns: Set<string>
}

type TableFlowNode = Node<TableNodeData, 'table'>

function nodeHeight(meta: TableMeta): number {
  const shown = Math.min(meta.columns.length, MAX_COLUMNS_SHOWN + 1)
  return HEADER_HEIGHT + shown * ROW_HEIGHT + 8
}

function TableNode({ data }: NodeProps<TableFlowNode>): React.JSX.Element {
  const { table, meta, fkColumns } = data
  const shown = meta.columns.slice(0, MAX_COLUMNS_SHOWN)
  const hidden = meta.columns.length - shown.length
  return (
    <div className="er-table">
      <Handle type="target" position={Position.Left} className="er-handle" />
      <Handle type="source" position={Position.Right} className="er-handle" />
      <div className="er-table-header">
        <Table size={13} />
        <span className="er-table-name">{table}</span>
      </div>
      <div className="er-table-cols">
        {shown.map((c) => (
          <div key={c.name} className={`er-col${c.isPrimaryKey ? ' pk' : ''}`}>
            <span className="er-col-icon">
              {c.isPrimaryKey ? (
                <KeyRound size={11} />
              ) : fkColumns.has(c.name) ? (
                <Link2 size={11} />
              ) : null}
            </span>
            <span className="er-col-name">{c.name}</span>
            <span className="er-col-type">{c.dataType}</span>
          </div>
        ))}
        {hidden > 0 && <div className="er-col more">… 还有 {hidden} 个字段</div>}
      </div>
    </div>
  )
}

const nodeTypes = { table: TableNode }

function layoutGraph(nodes: TableFlowNode[], edges: Edge[]): TableFlowNode[] {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 90 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: nodeHeight(n.data.meta) })
  }
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target)
  }
  dagre.layout(g)
  return nodes.map((n) => {
    const pos = g.node(n.id)
    return {
      ...n,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - nodeHeight(n.data.meta) / 2 }
    }
  })
}

export function ERDiagram(): React.JSX.Element {
  const { message } = App.useApp()
  const theme = useAppStore((s) => s.theme)
  const current = useAppStore((s) => s.current)
  const connections = useAppStore((s) => s.connections)
  const loadObjects = useAppStore((s) => s.loadObjects)

  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [confirmedLarge, setConfirmedLarge] = useState(false)
  const [nodes, setNodes, onNodesChange] = useNodesState<TableFlowNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const { profileId, database } = current
  const tables = useMemo(
    () =>
      (profileId && database ? (connections[profileId]?.objects[database] ?? []) : [])
        .filter((o) => o.objectType === 'table')
        .map((o) => o.name),
    [connections, profileId, database]
  )

  const tooMany = tables.length > AUTO_LOAD_LIMIT && !confirmedLarge

  const build = useCallback(async (): Promise<void> => {
    if (!profileId || !database || tables.length === 0) {
      setNodes([])
      setEdges([])
      return
    }
    setLoading(true)
    setProgress(`0 / ${tables.length}`)
    try {
      const metas = new Map<string, TableMeta>()
      // 限并发 6 拉取所有表的元数据
      let index = 0
      let done = 0
      const workers = Array.from({ length: Math.min(6, tables.length) }, async () => {
        while (index < tables.length) {
          const table = tables[index++]
          try {
            metas.set(table, await window.skysql.conn.tableMeta(profileId, database, table))
          } catch {
            // 单表失败不阻塞整图
          }
          done++
          setProgress(`${done} / ${tables.length}`)
        }
      })
      await Promise.all(workers)

      const newNodes: TableFlowNode[] = []
      const newEdges: Edge[] = []
      const edgeColor = theme === 'dark' ? '#7a7d82' : '#9aa0a6'
      for (const [table, meta] of metas) {
        const fkColumns = new Set(meta.foreignKeys.flatMap((f) => f.columns))
        newNodes.push({
          id: table,
          type: 'table',
          position: { x: 0, y: 0 },
          data: { table, meta, fkColumns }
        })
        for (const fk of meta.foreignKeys) {
          if (!metas.has(fk.refTable)) continue
          newEdges.push({
            id: `${table}:${fk.name}`,
            source: table,
            target: fk.refTable,
            type: 'smoothstep',
            label: `${fk.columns.join(',')} → ${fk.refColumns.join(',')}`,
            labelShowBg: true,
            style: { stroke: edgeColor },
            markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor }
          })
        }
      }
      setNodes(layoutGraph(newNodes, newEdges))
      setEdges(newEdges)
    } catch (e) {
      message.error(`加载 ER 图失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [profileId, database, tables, theme, message, setNodes, setEdges])

  useEffect(() => {
    if (profileId && database) void loadObjects(profileId, database)
  }, [profileId, database, loadObjects])

  useEffect(() => {
    if (!tooMany) void build()
    // build 依赖 tables（随 objects 加载而变化）
  }, [build, tooMany])

  if (!profileId || !database) {
    return <div className="objects-empty">请先选择数据库。</div>
  }

  if (tooMany) {
    return (
      <div className="objects-empty">
        <div style={{ textAlign: 'center' }}>
          <p>当前数据库有 {tables.length} 张表，渲染 ER 图可能较慢。</p>
          <Button type="primary" onClick={() => setConfirmedLarge(true)}>
            仍然加载
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="er-diagram">
      {loading && (
        <div className="er-loading">
          <Spin />
          <span>正在读取表结构 {progress}</span>
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        colorMode={theme === 'dark' ? 'dark' : 'light'}
        fitView
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        deleteKeyCode={null}
      >
        <Background gap={18} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  )
}
