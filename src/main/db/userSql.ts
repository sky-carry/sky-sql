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

/** SQL Server 固定服务器角色 */
export const MSSQL_SERVER_ROLES = [
  'sysadmin', 'serveradmin', 'securityadmin', 'processadmin',
  'setupadmin', 'bulkadmin', 'diskadmin', 'dbcreator'
]

function msIdent(name: string): string {
  return '[' + name.replace(/]/g, ']]') + ']'
}

function msStr(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * 生成 SQL Server 登录名变更语句。
 * currentRoles：编辑场景下当前所属的服务器角色（用于 diff），新建传 null。
 */
export function mssqlUserStatements(design: UserDesign, currentRoles: string[] | null): string[] {
  const statements: string[] = []

  if (!design.originalName) {
    statements.push(
      `CREATE LOGIN ${msIdent(design.name)} WITH PASSWORD = N'${msStr(design.password ?? '')}', CHECK_POLICY = OFF`
    )
    for (const role of design.privileges) {
      statements.push(`ALTER SERVER ROLE ${msIdent(role)} ADD MEMBER ${msIdent(design.name)}`)
    }
    return statements
  }

  let loginName = design.originalName
  if (design.name !== design.originalName) {
    statements.push(`ALTER LOGIN ${msIdent(design.originalName)} WITH NAME = ${msIdent(design.name)}`)
    loginName = design.name
  }
  if (design.password !== undefined && design.password !== '') {
    statements.push(`ALTER LOGIN ${msIdent(loginName)} WITH PASSWORD = N'${msStr(design.password)}'`)
  }
  const current = new Set(currentRoles ?? [])
  const next = new Set(design.privileges)
  for (const role of design.privileges.filter((r) => !current.has(r))) {
    statements.push(`ALTER SERVER ROLE ${msIdent(role)} ADD MEMBER ${msIdent(loginName)}`)
  }
  for (const role of [...current].filter((r) => !next.has(r))) {
    statements.push(`ALTER SERVER ROLE ${msIdent(role)} DROP MEMBER ${msIdent(loginName)}`)
  }
  return statements
}

export function mssqlDropUser(name: string): string {
  return `DROP LOGIN ${msIdent(name)}`
}
