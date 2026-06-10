import { useCallback, useEffect, useRef, useState } from 'react'
import { App, Button, Select, Tabs } from 'antd'
import { Blocks, Play, Sparkles, SquareDashedMousePointer } from 'lucide-react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { format } from 'sql-formatter'
import type { QueryResultSet } from '@shared/types'
import '@/monacoSetup'
import { ensureSqlCompletion, setCompletionContext } from '@/sqlCompletion'
import { useAppStore, type TabState } from '@/stores/appStore'
import { DataGridView } from '@/components/DataGridView'
import { QueryBuilderDialog } from '@/components/QueryBuilderDialog'
import { formatterDialect } from '@/utils'

type EditorInstance = Parameters<OnMount>[0]

export function QueryTab({ tab }: { tab: TabState }): React.JSX.Element {
  const { message } = App.useApp()
  const theme = useAppStore((s) => s.theme)
  const profiles = useAppStore((s) => s.profiles)
  const connections = useAppStore((s) => s.connections)
  const loadObjects = useAppStore((s) => s.loadObjects)
  const updateTab = useAppStore((s) => s.updateTab)
  const setStatus = useAppStore((s) => s.setStatus)

  const editorRef = useRef<EditorInstance | null>(null)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<QueryResultSet[]>([])
  const [errorMsg, setErrorMsg] = useState('')
  const [activeResult, setActiveResult] = useState('info')
  const [builderOpen, setBuilderOpen] = useState(false)

  const { profileId, database } = tab
  const profile = profiles.find((p) => p.id === profileId)
  const conn = profileId ? connections[profileId] : undefined

  // 维护自动补全的 schema 上下文
  useEffect(() => {
    if (!profileId || !database) return
    void loadObjects(profileId, database)
  }, [profileId, database, loadObjects])

  useEffect(() => {
    const objects = conn && database ? (conn.objects[database] ?? []) : []
    setCompletionContext({
      profileId,
      database,
      tables: objects
        .filter((o) => o.objectType === 'table' || o.objectType === 'view')
        .map((o) => o.name)
    })
  }, [conn, profileId, database])

  const runSql = useCallback(
    async (onlySelection: boolean): Promise<void> => {
      const editor = editorRef.current
      if (!editor || !profileId || !database) {
        message.warning('请先选择连接和数据库')
        return
      }
      let sql = ''
      const selection = editor.getSelection()
      if (onlySelection && selection && !selection.isEmpty()) {
        sql = editor.getModel()?.getValueInRange(selection) ?? ''
      } else if (!onlySelection) {
        sql = editor.getValue()
      } else {
        sql = editor.getValue()
      }
      if (!sql.trim()) return

      setRunning(true)
      setErrorMsg('')
      setStatus('正在执行查询...')
      try {
        const res = await window.skysql.conn.query(profileId, database, sql)
        setResults(res)
        const firstWithRows = res.findIndex((r) => r.columns.length > 0)
        setActiveResult(firstWithRows >= 0 ? `result-${firstWithRows}` : 'info')
        const totalMs = res.reduce((acc, r) => acc + r.durationMs, 0)
        setStatus(`执行完成：${res.length} 条语句，耗时 ${totalMs} ms`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setErrorMsg(msg)
        setResults([])
        setActiveResult('info')
        setStatus('执行出错')
      } finally {
        setRunning(false)
      }
    },
    [profileId, database, message, setStatus]
  )

  const runRef = useRef(runSql)
  runRef.current = runSql

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    ensureSqlCompletion()
    // Ctrl/Cmd + Enter 运行
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      void runRef.current(true)
    })
  }

  const beautify = (): void => {
    const editor = editorRef.current
    if (!editor) return
    try {
      editor.setValue(format(editor.getValue(), { language: formatterDialect(profile?.dbType) }))
    } catch (e) {
      message.error(`美化失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const resultItems = [
    {
      key: 'info',
      label: '信息',
      children: (
        <div className="query-info">
          {errorMsg && <pre className="query-error">{errorMsg}</pre>}
          {!errorMsg && results.length === 0 && <span className="query-info-hint">尚未执行查询</span>}
          {results.map((r, i) => (
            <div key={i} className="query-info-line">
              [{i + 1}]{' '}
              {r.columns.length > 0
                ? `返回 ${r.rows.length} 行`
                : `影响 ${r.affectedRows ?? 0} 行`}
              ，耗时 {r.durationMs} ms
              {r.statement ? ` — ${r.statement.slice(0, 80)}` : ''}
            </div>
          ))}
        </div>
      )
    },
    ...results
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.columns.length > 0)
      .map(({ r, i }) => ({
        key: `result-${i}`,
        label: `结果 ${i + 1}`,
        children: (
          <div className="query-result-grid">
            <DataGridView
              columns={r.columns}
              rowCount={r.rows.length}
              getCellValue={(row, col) => r.rows[row]?.[col] ?? null}
              dark={theme === 'dark'}
            />
          </div>
        )
      }))
  ]

  return (
    <div className="query-tab">
      <div className="query-toolbar">
        <Button
          size="small"
          type="primary"
          icon={<Play size={14} />}
          loading={running}
          onClick={() => void runSql(false)}
        >
          运行
        </Button>
        <Button
          size="small"
          icon={<SquareDashedMousePointer size={14} />}
          disabled={running}
          onClick={() => void runSql(true)}
        >
          运行选中
        </Button>
        <Button size="small" icon={<Sparkles size={14} />} onClick={beautify}>
          美化 SQL
        </Button>
        <Button
          size="small"
          icon={<Blocks size={14} />}
          disabled={!profileId || !database}
          onClick={() => setBuilderOpen(true)}
        >
          查询构建器
        </Button>
        <span className="query-toolbar-spacer" />
        <Select
          size="small"
          style={{ width: 160 }}
          placeholder="连接"
          value={profileId}
          onChange={(v) => updateTab(tab.id, { profileId: v, database: undefined })}
          options={Object.keys(connections).map((id) => ({
            value: id,
            label: profiles.find((p) => p.id === id)?.name ?? id
          }))}
        />
        <Select
          size="small"
          style={{ width: 160 }}
          placeholder="数据库"
          value={database}
          onChange={(v) => updateTab(tab.id, { database: v })}
          options={(conn?.databases ?? []).map((db) => ({ value: db, label: db }))}
        />
      </div>
      <div className="query-editor">
        <Editor
          defaultLanguage="sql"
          theme={theme === 'dark' ? 'vs-dark' : 'vs'}
          onMount={handleEditorMount}
          options={{
            fontSize: 13,
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2
          }}
        />
      </div>
      <QueryBuilderDialog
        open={builderOpen}
        profileId={profileId}
        database={database}
        dbType={profile?.dbType}
        onClose={() => setBuilderOpen(false)}
        onApply={(sql) => {
          const editor = editorRef.current
          if (!editor) return
          const current = editor.getValue()
          editor.setValue(current.trim() ? `${current.trimEnd()}\n\n${sql};\n` : `${sql};\n`)
        }}
      />
      <div className="query-results">
        <Tabs
          size="small"
          activeKey={activeResult}
          onChange={setActiveResult}
          items={resultItems}
          className="query-result-tabs"
        />
      </div>
    </div>
  )
}
