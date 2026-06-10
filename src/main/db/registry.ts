import type { ConnectionProfile, TestConnectionResult } from '@shared/types'
import type { DatabaseDriver } from './driver'
import { MySqlDriver, testMySql } from './drivers/mysql'
import { PostgresDriver, testPostgres } from './drivers/postgres'
import { SqliteDriver, testSqlite } from './drivers/sqlite'
import { withTunnel } from './sshTunnel'

export function createDriver(profile: ConnectionProfile): DatabaseDriver {
  switch (profile.dbType) {
    case 'mysql':
    case 'mariadb':
      return new MySqlDriver(profile)
    case 'postgresql':
      return new PostgresDriver(profile)
    case 'sqlite':
      return new SqliteDriver(profile)
    default:
      throw new Error(`暂不支持的数据库类型: ${profile.dbType}`)
  }
}

export async function testProfile(profile: Partial<ConnectionProfile>): Promise<TestConnectionResult> {
  // 启用 SSH 时先建临时隧道，用隧道地址测试
  let tunnel: Awaited<ReturnType<typeof withTunnel>>['tunnel'] = null
  let effective = profile
  if (profile.sshConfig?.enabled && profile.dbType !== 'sqlite') {
    try {
      const res = await withTunnel(profile as ConnectionProfile)
      effective = res.effective
      tunnel = res.tunnel
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
  }
  try {
    switch (effective.dbType) {
      case 'mysql':
      case 'mariadb':
        return await testMySql(effective)
      case 'postgresql':
        return await testPostgres(effective)
      case 'sqlite':
        return await testSqlite(effective)
      default:
        return { ok: false, message: `暂不支持的数据库类型: ${effective.dbType}` }
    }
  } finally {
    tunnel?.close()
  }
}
