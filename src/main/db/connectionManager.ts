import type { ConnectionProfile } from '@shared/types'
import type { DatabaseDriver } from './driver'
import { createDriver } from './registry'
import { withTunnel, type TunnelHandle } from './sshTunnel'

interface ActiveConnection {
  driver: DatabaseDriver
  tunnel: TunnelHandle | null
}

const active = new Map<string, ActiveConnection>()

export async function openConnection(profile: ConnectionProfile): Promise<DatabaseDriver> {
  const existing = active.get(profile.id)
  if (existing) return existing.driver

  const { effective, tunnel } = await withTunnel(profile)
  const driver = createDriver(effective)
  try {
    await driver.connect()
  } catch (e) {
    tunnel?.close()
    throw e
  }
  active.set(profile.id, { driver, tunnel })
  return driver
}

export async function closeConnection(profileId: string): Promise<void> {
  const conn = active.get(profileId)
  if (conn) {
    active.delete(profileId)
    await conn.driver.disconnect().catch(() => undefined)
    conn.tunnel?.close()
  }
}

export function getDriver(profileId: string): DatabaseDriver {
  const conn = active.get(profileId)
  if (!conn) throw new Error('连接未打开，请先打开连接')
  return conn.driver
}

export async function closeAll(): Promise<void> {
  await Promise.allSettled([...active.values()].map((c) => c.driver.disconnect()))
  for (const c of active.values()) c.tunnel?.close()
  active.clear()
}
