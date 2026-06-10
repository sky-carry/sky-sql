import type { UserDesign } from '@shared/types'

/** MySQL 可授予的全局权限 */
export const MYSQL_PRIVILEGES = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'RELOAD', 'SHUTDOWN',
  'PROCESS', 'FILE', 'REFERENCES', 'INDEX', 'ALTER', 'SHOW DATABASES', 'SUPER',
  'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'EXECUTE', 'REPLICATION SLAVE',
  'REPLICATION CLIENT', 'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE',
  'CREATE USER', 'EVENT', 'TRIGGER', 'CREATE ROLE', 'DROP ROLE'
]

/** PostgreSQL 角色属性 */
export const PG_ATTRIBUTES = ['LOGIN', 'SUPERUSER', 'CREATEDB', 'CREATEROLE', 'REPLICATION', 'BYPASSRLS']

function escStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "''")
}

function mysqlAccount(name: string, host?: string): string {
  return `'${escStr(name)}'@'${escStr(host || '%')}'`
}

/**
 * 生成 MySQL 用户变更语句。
 * currentPrivs：编辑场景下当前已授予的全局权限（用于 GRANT/REVOKE diff），新建传 null。
 */
export function mysqlUserStatements(design: UserDesign, currentPrivs: string[] | null): string[] {
  const statements: string[] = []
  const account = mysqlAccount(design.name, design.host)

  if (!design.originalName) {
    statements.push(`CREATE USER ${account} IDENTIFIED BY '${escStr(design.password ?? '')}'`)
    if (design.privileges.length > 0) {
      statements.push(`GRANT ${design.privileges.join(', ')} ON *.* TO ${account}`)
    }
    return statements
  }

  const origAccount = mysqlAccount(design.originalName, design.originalHost)
  const renamed = design.name !== design.originalName || (design.host || '%') !== (design.originalHost || '%')
  if (renamed) {
    statements.push(`RENAME USER ${origAccount} TO ${account}`)
  }
  if (design.password !== undefined && design.password !== '') {
    statements.push(`ALTER USER ${account} IDENTIFIED BY '${escStr(design.password)}'`)
  }
  const current = new Set(currentPrivs ?? [])
  const next = new Set(design.privileges)
  const added = design.privileges.filter((p) => !current.has(p))
  const removed = [...current].filter((p) => !next.has(p))
  if (added.length > 0) statements.push(`GRANT ${added.join(', ')} ON *.* TO ${account}`)
  if (removed.length > 0) statements.push(`REVOKE ${removed.join(', ')} ON *.* FROM ${account}`)
  return statements
}

export function mysqlDropUser(name: string, host?: string): string {
  return `DROP USER ${mysqlAccount(name, host)}`
}

function pgIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

/** PG 属性 → ALTER/CREATE ROLE 关键字（取消时加 NO 前缀） */
function pgAttrKeyword(attr: string, enabled: boolean): string {
  return enabled ? attr : `NO${attr}`
}

/**
 * 生成 PostgreSQL 角色变更语句。
 * currentAttrs：编辑场景下当前属性集合，新建传 null。
 */
export function pgUserStatements(design: UserDesign, currentAttrs: string[] | null): string[] {
  const statements: string[] = []

  if (!design.originalName) {
    const parts = PG_ATTRIBUTES.map((a) => pgAttrKeyword(a, design.privileges.includes(a)))
    let create = `CREATE ROLE ${pgIdent(design.name)} WITH ${parts.join(' ')}`
    if (design.password) create += ` PASSWORD '${escStr(design.password)}'`
    statements.push(create)
    return statements
  }

  let roleName = design.originalName
  if (design.name !== design.originalName) {
    statements.push(`ALTER ROLE ${pgIdent(design.originalName)} RENAME TO ${pgIdent(design.name)}`)
    roleName = design.name
  }

  const current = new Set(currentAttrs ?? [])
  const changed = PG_ATTRIBUTES.filter((a) => current.has(a) !== design.privileges.includes(a))
  const withParts = changed.map((a) => pgAttrKeyword(a, design.privileges.includes(a)))
  if (design.password !== undefined && design.password !== '') {
    withParts.push(`PASSWORD '${escStr(design.password)}'`)
  }
  if (withParts.length > 0) {
    statements.push(`ALTER ROLE ${pgIdent(roleName)} WITH ${withParts.join(' ')}`)
  }
  return statements
}

export function pgDropUser(name: string): string {
  return `DROP ROLE ${pgIdent(name)}`
}
