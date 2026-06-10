import type { CellValue, DbType } from '@shared/types'

/** 单元格值转显示文本 */
export function cellToText(v: CellValue): string {
  if (v === null) return '(NULL)'
  if (typeof v === 'object' && '__type' in v) return `(BLOB ${v.length} 字节)`
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

/** 按数据库类型引用标识符（渲染进程侧生成 DDL 用） */
export function quoteIdentFor(dbType: DbType, name: string): string {
  if (dbType === 'mysql' || dbType === 'mariadb') return '`' + name.replace(/`/g, '``') + '`'
  return '"' + name.replace(/"/g, '""') + '"'
}

/** sql-formatter 的方言映射 */
export function formatterDialect(dbType?: DbType): 'mysql' | 'postgresql' | 'sqlite' | 'sql' {
  switch (dbType) {
    case 'mysql':
    case 'mariadb':
      return 'mysql'
    case 'postgresql':
      return 'postgresql'
    case 'sqlite':
      return 'sqlite'
    default:
      return 'sql'
  }
}
