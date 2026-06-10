import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Checkbox, Input, InputNumber, Modal, Select } from 'antd'
import { Plus, X } from 'lucide-react'
import type { DbType, FilterOp } from '@shared/types'
import { useAppStore } from '@/stores/appStore'
import {
  emptyBuilderState,
  generateQuery,
  type QbCondition,
  type QbJoin,
  type QbOrder,
  type QueryBuilderState
} from '@/queryBuilder'

const FILTER_OPS: FilterOp[] = ['=', '<>', '>', '>=', '<', '<=', 'LIKE', 'NOT LIKE', 'IS NULL', 'IS NOT NULL']

let keyCounter = 0
const nextKey = (): string => `qb${++keyCounter}`

interface QueryBuilderDialogProps {
  open: boolean
  profileId?: string
  database?: string
  dbType?: DbType
  onClose: () => void
  onApply: (sql: string) => void
}

export function QueryBuilderDialog({
  open,
  profileId,
  database,
  dbType,
  onClose,
  onApply
}: QueryBuilderDialogProps): React.JSX.Element {
  const { message } = App.useApp()
  const connections = useAppStore((s) => s.connections)
  const loadObjects = useAppStore((s) => s.loadObjects)

  const [state, setState] = useState<QueryBuilderState>(emptyBuilderState())
  const [colsCache, setColsCache] = useState<Record<string, string[]>>({})

  useEffect(() => {
    if (!open) return
    setState(emptyBuilderState())
    setColsCache({})
    if (profileId && database) void loadObjects(profileId, database)
  }, [open, profileId, database, loadObjects])

  const tables = useMemo(
    () =>
      (profileId && database ? (connections[profileId]?.objects[database] ?? []) : [])
        .filter((o) => o.objectType === 'table' || o.objectType === 'view')
        .map((o) => o.name),
    [connections, profileId, database]
  )

  const fetchCols = useCallback(
    (table: string): void => {
      if (!profileId || !database || !table || colsCache[table]) return
      window.skysql.conn
        .tableColumns(profileId, database, table)
        .then((cols) => setColsCache((prev) => ({ ...prev, [table]: cols.map((c) => c.name) })))
        .catch((e) => message.error(`读取 ${table} 字段失败: ${e instanceof Error ? e.message : e}`))
    },
    [profileId, database, colsCache, message]
  )

  /** 参与查询的全部表（主表 + 已 JOIN 的表） */
  const involvedTables = useMemo(
    () => [state.baseTable, ...state.joins.map((j) => j.table)].filter(Boolean),
    [state.baseTable, state.joins]
  )

  /** 全部可选的限定列 */
  const qualifiedColumns = useMemo(
    () =>
      involvedTables.flatMap((t) => (colsCache[t] ?? []).map((c) => `${t}.${c}`)),
    [involvedTables, colsCache]
  )

  const sql = useMemo(() => (dbType ? generateQuery(dbType, state) : ''), [dbType, state])

  const patch = (p: Partial<QueryBuilderState>): void => setState((s) => ({ ...s, ...p }))
  const patchJoin = (key: string, p: Partial<QbJoin>): void =>
    setState((s) => ({ ...s, joins: s.joins.map((j) => (j.key === key ? { ...j, ...p } : j)) }))
  const patchCond = (key: string, p: Partial<QbCondition>): void =>
    setState((s) => ({
      ...s,
      conditions: s.conditions.map((c) => (c.key === key ? { ...c, ...p } : c))
    }))
  const patchOrder = (key: string, p: Partial<QbOrder>): void =>
    setState((s) => ({ ...s, orderBy: s.orderBy.map((o) => (o.key === key ? { ...o, ...p } : o)) }))

  const colOptions = qualifiedColumns.map((c) => ({ value: c, label: c }))

  return (
    <Modal
      title="查询构建器"
      open={open}
      onCancel={onClose}
      width={760}
      okText="应用到编辑器"
      cancelText="取消"
      okButtonProps={{ disabled: !sql }}
      onOk={() => {
        onApply(sql)
        onClose()
      }}
    >
      <div className="qb-body">
        <div className="qb-section">
          <div className="qb-section-title">主表（FROM）</div>
          <Select
            size="small"
            showSearch
            style={{ width: 280 }}
            placeholder="选择主表"
            value={state.baseTable || undefined}
            onChange={(v) => {
              patch({ baseTable: v, fields: [], conditions: [], groupBy: [], orderBy: [], joins: [] })
              fetchCols(v)
            }}
            options={tables.map((t) => ({ value: t, label: t }))}
          />
        </div>

        <div className="qb-section">
          <div className="qb-section-title">
            连接（JOIN）
            <Button
              size="small"
              type="text"
              icon={<Plus size={13} />}
              disabled={!state.baseTable}
              onClick={() =>
                setState((s) => ({
                  ...s,
                  joins: [
                    ...s.joins,
                    {
                      key: nextKey(),
                      type: 'INNER',
                      table: '',
                      leftTable: s.baseTable,
                      leftCol: '',
                      rightCol: ''
                    }
                  ]
                }))
              }
            >
              添加
            </Button>
          </div>
          {state.joins.map((j) => (
            <div key={j.key} className="qb-row">
              <Select
                size="small"
                style={{ width: 90 }}
                value={j.type}
                onChange={(v) => patchJoin(j.key, { type: v })}
                options={['INNER', 'LEFT', 'RIGHT'].map((t) => ({ value: t, label: t }))}
              />
              <span>JOIN</span>
              <Select
                size="small"
                showSearch
                style={{ width: 160 }}
                placeholder="表"
                value={j.table || undefined}
                onChange={(v) => {
                  patchJoin(j.key, { table: v, rightCol: '' })
                  fetchCols(v)
                }}
                options={tables.map((t) => ({ value: t, label: t }))}
              />
              <span>ON</span>
              <Select
                size="small"
                showSearch
                style={{ width: 110 }}
                placeholder="左表"
                value={j.leftTable || undefined}
                onChange={(v) => patchJoin(j.key, { leftTable: v, leftCol: '' })}
                options={involvedTables.filter((t) => t !== j.table).map((t) => ({ value: t, label: t }))}
              />
              <Select
                size="small"
                showSearch
                style={{ width: 130 }}
                placeholder="左列"
                value={j.leftCol || undefined}
                onChange={(v) => patchJoin(j.key, { leftCol: v })}
                options={(colsCache[j.leftTable] ?? []).map((c) => ({ value: c, label: c }))}
              />
              <span>=</span>
              <Select
                size="small"
                showSearch
                style={{ width: 130 }}
                placeholder="右列"
                value={j.rightCol || undefined}
                onChange={(v) => patchJoin(j.key, { rightCol: v })}
                options={(colsCache[j.table] ?? []).map((c) => ({ value: c, label: c }))}
              />
              <Button
                size="small"
                type="text"
                icon={<X size={12} />}
                onClick={() => setState((s) => ({ ...s, joins: s.joins.filter((x) => x.key !== j.key) }))}
              />
            </div>
          ))}
        </div>

        <div className="qb-section">
          <div className="qb-section-title">字段（SELECT，不勾选 = *）</div>
          <div className="qb-fields">
            {involvedTables.map((t) => (
              <div key={t} className="qb-field-group">
                <div className="qb-field-table">{t}</div>
                {(colsCache[t] ?? []).map((c) => {
                  const qualified = `${t}.${c}`
                  return (
                    <Checkbox
                      key={qualified}
                      checked={state.fields.includes(qualified)}
                      onChange={(e) =>
                        patch({
                          fields: e.target.checked
                            ? [...state.fields, qualified]
                            : state.fields.filter((f) => f !== qualified)
                        })
                      }
                    >
                      {c}
                    </Checkbox>
                  )
                })}
              </div>
            ))}
            {involvedTables.length === 0 && <span className="wizard-hint">先选择主表</span>}
          </div>
        </div>

        <div className="qb-section">
          <div className="qb-section-title">
            条件（WHERE，AND 连接）
            <Button
              size="small"
              type="text"
              icon={<Plus size={13} />}
              disabled={!state.baseTable}
              onClick={() =>
                setState((s) => ({
                  ...s,
                  conditions: [...s.conditions, { key: nextKey(), column: '', op: '=', value: '' }]
                }))
              }
            >
              添加
            </Button>
          </div>
          {state.conditions.map((c) => (
            <div key={c.key} className="qb-row">
              <Select
                size="small"
                showSearch
                style={{ width: 220 }}
                placeholder="字段"
                value={c.column || undefined}
                onChange={(v) => patchCond(c.key, { column: v })}
                options={colOptions}
              />
              <Select
                size="small"
                style={{ width: 110 }}
                value={c.op}
                onChange={(v) => patchCond(c.key, { op: v })}
                options={FILTER_OPS.map((op) => ({ value: op, label: op }))}
              />
              {c.op !== 'IS NULL' && c.op !== 'IS NOT NULL' && (
                <Input
                  size="small"
                  style={{ width: 180 }}
                  placeholder="值"
                  value={c.value}
                  onChange={(e) => patchCond(c.key, { value: e.target.value })}
                />
              )}
              <Button
                size="small"
                type="text"
                icon={<X size={12} />}
                onClick={() =>
                  setState((s) => ({ ...s, conditions: s.conditions.filter((x) => x.key !== c.key) }))
                }
              />
            </div>
          ))}
        </div>

        <div className="qb-section qb-inline">
          <div>
            <div className="qb-section-title">分组（GROUP BY）</div>
            <Select
              size="small"
              mode="multiple"
              style={{ width: 300 }}
              placeholder="可选"
              value={state.groupBy}
              onChange={(v) => patch({ groupBy: v })}
              options={colOptions}
            />
          </div>
          <div>
            <div className="qb-section-title">
              排序（ORDER BY）
              <Button
                size="small"
                type="text"
                icon={<Plus size={13} />}
                disabled={!state.baseTable}
                onClick={() =>
                  setState((s) => ({
                    ...s,
                    orderBy: [...s.orderBy, { key: nextKey(), column: '', dir: 'ASC' }]
                  }))
                }
              >
                添加
              </Button>
            </div>
            {state.orderBy.map((o) => (
              <div key={o.key} className="qb-row">
                <Select
                  size="small"
                  showSearch
                  style={{ width: 200 }}
                  placeholder="字段"
                  value={o.column || undefined}
                  onChange={(v) => patchOrder(o.key, { column: v })}
                  options={colOptions}
                />
                <Select
                  size="small"
                  style={{ width: 90 }}
                  value={o.dir}
                  onChange={(v) => patchOrder(o.key, { dir: v })}
                  options={[
                    { value: 'ASC', label: '升序' },
                    { value: 'DESC', label: '降序' }
                  ]}
                />
                <Button
                  size="small"
                  type="text"
                  icon={<X size={12} />}
                  onClick={() =>
                    setState((s) => ({ ...s, orderBy: s.orderBy.filter((x) => x.key !== o.key) }))
                  }
                />
              </div>
            ))}
          </div>
          <div>
            <div className="qb-section-title">LIMIT</div>
            <InputNumber
              size="small"
              min={1}
              style={{ width: 120 }}
              placeholder="可选"
              value={state.limit}
              onChange={(v) => patch({ limit: v ?? undefined })}
            />
          </div>
        </div>

        <div className="qb-section">
          <div className="qb-section-title">SQL 预览</div>
          <pre className="qb-preview">{sql || '-- 选择主表后生成'}</pre>
        </div>
      </div>
    </Modal>
  )
}
