/**
 * 朴素 SQL 多语句拆分：跳过单双引号/反引号字符串、行注释与块注释。
 * 用于 SQLite 驱动（prepare 仅支持单语句）和 SQL 文件还原。
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      current += ch
      i++
      while (i < sql.length) {
        current += sql[i]
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            current += sql[i + 1]
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        current += sql[i]
        i++
      }
      continue
    }
    if (ch === '/' && next === '*') {
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        current += sql[i]
        i++
      }
      current += '*/'
      i += 2
      continue
    }
    if (ch === ';') {
      statements.push(current)
      current = ''
      i++
      continue
    }
    current += ch
    i++
  }
  statements.push(current)
  return statements.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** 判断拆分出的片段是否为纯注释（还原时跳过） */
export function isCommentOnly(statement: string): boolean {
  const stripped = statement
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
  return stripped.length === 0
}
