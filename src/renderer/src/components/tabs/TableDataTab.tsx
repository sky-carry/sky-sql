import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Input, Pagination, Select, Tooltip } from 'antd'
import { Check, Filter, Minus, Plus, RefreshCw, X } from 'lucide-react'
import type {
  CellValue,
  FilterOp,
  RowChange,
  TableDataResponse,
  TableFilter,
  TableSort
} from '@shared/types'
import { useAppStore, type TabState } from '@/stores/appStore'
import { DataGridView, type RowKind } from '@/components/DataGridView'

const FILTER_OPS: FilterOp[] = ['=', '<>', '>', '>=', '<', '<=', 'LIKE', 'NOT LIKE', 'IS NULL', 'IS NOT NULL']

interface PendingFilter {
  column?: string
  op: FilterOp
  value: string
}

export function TableDataTab({ tab }: { tab: TabState }): React.JSX.Element {
  const { message } = App.useApp()
  const theme = useAppStore((s) => s.theme)
  const setStatus = useAppStore((s) => s.setStatus)

  const [data, setData] = useState<TableDataResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(1000)
  const [sorts, setSorts] = useState<TableSort[]>([])
  const [appliedFilters, setAppliedFilters] = useState<TableFilter[]>([])
  const [showFilter, setShowFilter] = useState(false)
  const [pendingFilters, setPendingFilters] = useState<PendingFilter[]>([{ op: '=', value: '' }])

  // 编辑状态
  const [edits, setEdits] = useState<Map<string, CellValue>>(new Map())
  const [newRows, setNewRows] = useState<CellValue[][]>([])
  const [deletedRows, setDeletedRows] = useState<Set<number>>(new Set())
  const [selectedRows, setSelectedRows] = useState<number[]>([])

  const { profileId, database, table } = tab
  const dirty = edits.size > 0 || newRows.length > 0 || deletedRows.size > 0

  const resetEdits = useCallback((): void => {
    setEdits(new Map())
    setNewRows([])
    setDeletedRows(new Set())
  }, [])

  const load = useCallback(async (): Promise<void> => {
    if (!profileId || !database || !table) return
    setLoading(true)
    try {
      const res = await window.skysql.conn.tableData({
        profileId,
        database,
        table,
        limit: pageSize,
        offset: (page - 1) * pageSize,
        sorts,
        filters: appliedFilters
      })
      setData(res)
      resetEdits()
      setStatus(
        `${table}: 第 ${page} 页，共 ${res.totalRows ?? '?'} 行，耗时 ${res.result.durationMs} ms`
      )
    } catch (e) {
      message.error(`加载数据失败: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [profileId, database, table, page, pageSize, sorts, appliedFilters, message, setStatus, resetEdits])

  useEffect(() => {
    void load()
  }, [load])

  const columns = data?.result.columns ?? []
  const dataRows = data?.result.rows ?? []
  const totalRowCount = dataRows.length + newRows.length

  const pkColumns = useMemo(
    () => (data?.columns ?? []).filter((c) => c.isPrimaryKey),
    [data]
  )
  const editable = pkColumns.length > 0

  const getCellValue = useCallback(
    (row: number, col: number): CellValue => {
      if (row < dataRows.length) {
        const key = `${row}:${col}`
        return edits.has(key) ? (edits.get(key) as CellValue) : dataRows[row][col]
      }
      return newRows[row - dataRows.length]?.[col] ?? null
    },
    [dataRows, edits, newRows]
  )

  const handleCellEdited = useCallback(
    (row: number, col: number, value: CellValue): void => {
      if (row < dataRows.length) {
        setEdits((prev) => {
          const next = new Map(prev)
          // 与原值相同则撤销标记
          if (dataRows[row][col] === value) next.delete(`${row}:${col}`)
          else next.set(`${row}:${col}`, value)
          return next
        })
      } else {
        setNewRows((prev) => {
          const next = prev.map((r) => [...r])
          next[row - dataRows.length][col] = value
          return next
        })
      }
    },
    [dataRows]
  )

  const getRowKind = useCallback(
    (row: number): RowKind => {
      if (row >= dataRows.length) return 'new'
      return deletedRows.has(row) ? 'deleted' : 'normal'
    },
    [dataRows.length, deletedRows]
  )

  const handleHeaderClicked = useCallback(
    (col: number): void => {
      const name = columns[col]?.name
      if (!name) return
      setSorts((prev) => {
        const existing = prev.find((s) => s.column === name)
        if (!existing) return [{ column: name, dir: 'asc' }]
        if (existing.dir === 'asc') return [{ column: name, dir: 'desc' }]
        return []
      })
      setPage(1)
    },
    [columns]
  )

  const headerSuffix = useCallback(
    (colName: string): string => {
      const s = sorts.find((x) => x.column === colName)
      return s ? (s.dir === 'asc' ? ' ▲' : ' ▼') : ''
    },
    [sorts]
  )

  const addRow = (): void => {
    setNewRows((prev) => [...prev, columns.map(() => null)])
  }

  const deleteSelected = (): void => {
    const dataSelected = selectedRows.filter((r) => r < dataRows.length)
    const newSelected = selectedRows
      .filter((r) => r >= dataRows.length)
      .map((r) => r - dataRows.length)
    if (dataSelected.length === 0 && newSelected.length === 0) {
      message.info('请先用行号选择要删除的行')
      return
    }
    if (newSelected.length > 0) {
      setNewRows((prev) => prev.filter((_, i) => !newSelected.includes(i)))
    }
    setDeletedRows((prev) => new Set([...prev, ...dataSelected]))
  }

  const buildChanges = (): RowChange[] => {
    const changes: RowChange[] = []
    const colIndexByName = new Map(columns.map((c, i) => [c.name, i]))
    const keysForRow = (row: number): Record<string, CellValue> => {
      const keys: Record<string, CellValue> = {}
      for (const pk of pkColumns) {
        const idx = colIndexByName.get(pk.name)
        if (idx !== undefined) keys[pk.name] = dataRows[row][idx]
      }
      return keys
    }

    const updatesByRow = new Map<number, Record<string, CellValue>>()
    for (const [key, value] of edits) {
      const [rowStr, colStr] = key.split(':')
      const row = Number(rowStr)
      const col = Number(colStr)
      if (deletedRows.has(row)) continue
      const colName = columns[col]?.name
      if (!colName) continue
      const rowValues = updatesByRow.get(row) ?? {}
      rowValues[colName] = value
      updatesByRow.set(row, rowValues)
    }
    for (const [row, values] of updatesByRow) {
      changes.push({ kind: 'update', keys: keysForRow(row), values })
    }
    for (const row of deletedRows) {
      changes.push({ kind: 'delete', keys: keysForRow(row) })
    }
    for (const newRow of newRows) {
      const values: Record<string, CellValue> = {}
      newRow.forEach((v, i) => {
        if (v !== null && columns[i]) values[columns[i].name] = v
      })
      changes.push({ kind: 'insert', values })
    }
    return changes
  }

  const applyChanges = async (): Promise<void> => {
    if (!profileId || !database || !table) return
    const changes = buildChanges()
    if (changes.length === 0) return
    try {
      const affected = await window.skysql.conn.applyEdits({ profileId, database, table, changes })
      message.success(`已应用更改，影响 ${affected} 行`)
      await load()
    } catch (e) {
      message.error(`应用更改失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const applyFilters = (): void => {
    const filters: TableFilter[] = pendingFilters
      .filter((f) => f.column && (f.op === 'IS NULL' || f.op === 'IS NOT NULL' || f.value !== ''))
      .map((f) => ({ column: f.column!, op: f.op, value: f.value }))
    setAppliedFilters(filters)
    setPage(1)
  }

  return (
    <div className="table-data-tab">
      <div className="grid-toolbar">
        <Button size="small" type="text" icon={<RefreshCw size={14} />} onClick={() => void load()}>
          刷新
        </Button>
        <Tooltip title={editable ? '' : '该表没有主键，不支持编辑'}>
          <Button size="small" type="text" icon={<Plus size={14} />} disabled={!editable} onClick={addRow}>
            添加行
          </Button>
        </Tooltip>
        <Button
          size="small"
          type="text"
          icon={<Minus size={14} />}
          disabled={!editable}
          onClick={deleteSelected}
        >
          删除行
        </Button>
        <Button
          size="small"
          type="text"
          icon={<Check size={14} />}
          disabled={!dirty}
          style={dirty ? { color: '#3dba62' } : undefined}
          onClick={() => void applyChanges()}
        >
          应用更改
        </Button>
        <Button size="small" type="text" icon={<X size={14} />} disabled={!dirty} onClick={resetEdits}>
          放弃更改
        </Button>
        <Button
          size="small"
          type={showFilter || appliedFilters.length > 0 ? 'primary' : 'text'}
          ghost={showFilter || appliedFilters.length > 0}
          icon={<Filter size={14} />}
          onClick={() => setShowFilter((v) => !v)}
        >
          筛选{appliedFilters.length > 0 ? ` (${appliedFilters.length})` : ''}
        </Button>
        <span className="grid-toolbar-spacer" />
        {!editable && data && <span className="grid-readonly-hint">只读（无主键）</span>}
      </div>

      {showFilter && (
        <div className="filter-bar">
          {pendingFilters.map((f, i) => (
            <div key={i} className="filter-row">
              <Select
                size="small"
                style={{ width: 160 }}
                placeholder="字段"
                value={f.column}
                onChange={(v) =>
                  setPendingFilters((prev) => prev.map((x, j) => (j === i ? { ...x, column: v } : x)))
                }
                options={columns.map((c) => ({ value: c.name, label: c.name }))}
              />
              <Select
                size="small"
                style={{ width: 110 }}
                value={f.op}
                onChange={(v) =>
                  setPendingFilters((prev) => prev.map((x, j) => (j === i ? { ...x, op: v } : x)))
                }
                options={FILTER_OPS.map((op) => ({ value: op, label: op }))}
              />
              {f.op !== 'IS NULL' && f.op !== 'IS NOT NULL' && (
                <Input
                  size="small"
                  style={{ width: 200 }}
                  placeholder="值（LIKE 可用 % 通配）"
                  value={f.value}
                  onChange={(e) =>
                    setPendingFilters((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x))
                    )
                  }
                  onPressEnter={applyFilters}
                />
              )}
              <Button
                size="small"
                type="text"
                icon={<X size={12} />}
                onClick={() => setPendingFilters((prev) => prev.filter((_, j) => j !== i))}
              />
            </div>
          ))}
          <div className="filter-actions">
            <Button size="small" onClick={() => setPendingFilters((prev) => [...prev, { op: '=', value: '' }])}>
              添加条件
            </Button>
            <Button size="small" type="primary" onClick={applyFilters}>
              应用筛选
            </Button>
            <Button
              size="small"
              onClick={() => {
                setPendingFilters([{ op: '=', value: '' }])
                setAppliedFilters([])
                setPage(1)
              }}
            >
              清除
            </Button>
          </div>
        </div>
      )}

      <div className="grid-area">
        {data && (
          <DataGridView
            columns={columns}
            rowCount={totalRowCount}
            getCellValue={getCellValue}
            editable={editable}
            onCellEdited={handleCellEdited}
            isCellEdited={(row, col) => edits.has(`${row}:${col}`)}
            getRowKind={getRowKind}
            onHeaderClicked={handleHeaderClicked}
            headerSuffix={headerSuffix}
            onSelectedRowsChange={setSelectedRows}
            dark={theme === 'dark'}
          />
        )}
        {loading && <div className="grid-loading">加载中...</div>}
      </div>

      <div className="grid-pager">
        <Pagination
          size="small"
          current={page}
          pageSize={pageSize}
          total={data?.totalRows ?? 0}
          showSizeChanger
          pageSizeOptions={['100', '500', '1000', '5000']}
          showTotal={(total) => `共 ${total.toLocaleString()} 行`}
          onChange={(p, ps) => {
            setPage(ps !== pageSize ? 1 : p)
            setPageSize(ps)
          }}
        />
        {data && <span className="pager-duration">耗时 {data.result.durationMs} ms</span>}
      </div>
    </div>
  )
}
