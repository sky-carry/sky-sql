import { monaco } from './monacoSetup'

export interface CompletionContext {
  profileId?: string
  database?: string
  tables: string[]
}

/** 当前查询编辑器的 schema 上下文（由聚焦的查询标签页设置） */
let ctx: CompletionContext = { tables: [] }

export function setCompletionContext(next: CompletionContext): void {
  ctx = next
}

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'CREATE TABLE',
  'ALTER TABLE', 'DROP TABLE', 'CREATE INDEX', 'CREATE VIEW', 'JOIN', 'INNER JOIN',
  'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'AND', 'OR', 'NOT',
  'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL', 'GROUP BY', 'HAVING',
  'ORDER BY', 'LIMIT', 'OFFSET', 'UNION', 'UNION ALL', 'DISTINCT', 'AS', 'SET',
  'VALUES', 'INTO', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'COUNT', 'SUM', 'AVG',
  'MIN', 'MAX', 'COALESCE', 'CAST', 'SHOW', 'DESC', 'ASC', 'TRUNCATE', 'BEGIN',
  'COMMIT', 'ROLLBACK', 'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'DEFAULT',
  'AUTO_INCREMENT', 'NOT NULL', 'UNIQUE', 'IF EXISTS', 'IF NOT EXISTS'
]

let registered = false

/** 注册 SQL 自动补全（关键字 + 表名 + `表名.` 后的列名） */
export function ensureSqlCompletion(): void {
  if (registered) return
  registered = true

  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.'],
    provideCompletionItems: async (model, position) => {
      const word = model.getWordUntilPosition(position)
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn
      }
      const lineBefore = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      })

      // `表名.` 后补全该表的列
      const dotMatch = /([A-Za-z_][\w$]*)\.[\w$]*$/.exec(lineBefore)
      if (dotMatch && ctx.profileId && ctx.database) {
        const table = ctx.tables.find((t) => t.toLowerCase() === dotMatch[1].toLowerCase())
        if (table) {
          try {
            const cols = await window.skysql.conn.tableColumns(ctx.profileId, ctx.database, table)
            return {
              suggestions: cols.map((c) => ({
                label: c.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: c.name,
                detail: c.columnType,
                range
              }))
            }
          } catch {
            return { suggestions: [] }
          }
        }
      }

      return {
        suggestions: [
          ...KEYWORDS.map((k) => ({
            label: k,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: k,
            range
          })),
          ...ctx.tables.map((t) => ({
            label: t,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: t,
            detail: '表',
            range
          }))
        ]
      }
    }
  })
}
