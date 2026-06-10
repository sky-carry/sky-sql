import { app, safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type { ConnectionProfile, SshConfig } from '@shared/types'

/** 磁盘上的 SSH 配置：密码与口令加密 */
type StoredSsh = Omit<SshConfig, 'password' | 'passphrase'> & {
  passwordEnc?: string
  passphraseEnc?: string
}

/** 磁盘存储结构：所有敏感字段经 safeStorage 加密为 base64 */
interface StoredProfile extends Omit<ConnectionProfile, 'password' | 'sshConfig'> {
  passwordEnc?: string
  sshConfig?: StoredSsh
}

function storePath(): string {
  return join(app.getPath('userData'), 'connections.json')
}

function readStore(): StoredProfile[] {
  const file = storePath()
  if (!existsSync(file)) return []
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as StoredProfile[]
  } catch {
    return []
  }
}

function writeStore(profiles: StoredProfile[]): void {
  const file = storePath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(profiles, null, 2), 'utf-8')
}

function encryptSecret(secret?: string): string | undefined {
  if (!secret) return undefined
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(secret).toString('base64')
  }
  // 加密不可用时降级为明文标记存储
  return 'plain:' + Buffer.from(secret, 'utf-8').toString('base64')
}

function decryptSecret(enc?: string): string | undefined {
  if (!enc) return undefined
  try {
    if (enc.startsWith('plain:')) {
      return Buffer.from(enc.slice(6), 'base64').toString('utf-8')
    }
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return undefined
  }
}

function toProfile(stored: StoredProfile): ConnectionProfile {
  const { passwordEnc, sshConfig, ...rest } = stored
  let ssh: SshConfig | undefined
  if (sshConfig) {
    const { passwordEnc: spe, passphraseEnc: ppe, ...sshRest } = sshConfig
    ssh = { ...sshRest, password: decryptSecret(spe), passphrase: decryptSecret(ppe) }
  }
  return { ...rest, password: decryptSecret(passwordEnc), sshConfig: ssh }
}

function toStoredSsh(input: SshConfig, previous?: StoredSsh): StoredSsh {
  const { password, passphrase, ...rest } = input
  return {
    ...rest,
    // undefined 表示编辑时未改动，沿用旧密文
    passwordEnc: password !== undefined ? encryptSecret(password) : previous?.passwordEnc,
    passphraseEnc: passphrase !== undefined ? encryptSecret(passphrase) : previous?.passphraseEnc
  }
}

export function listProfiles(): ConnectionProfile[] {
  return readStore().map(toProfile)
}

export function getProfile(id: string): ConnectionProfile {
  const stored = readStore().find((p) => p.id === id)
  if (!stored) throw new Error('连接配置不存在')
  return toProfile(stored)
}

export function saveProfile(input: Partial<ConnectionProfile>): ConnectionProfile {
  const profiles = readStore()
  const now = new Date().toISOString()
  const { password, sshConfig, ...rest } = input

  if (input.id) {
    const idx = profiles.findIndex((p) => p.id === input.id)
    if (idx === -1) throw new Error('连接配置不存在')
    const updated: StoredProfile = {
      ...profiles[idx],
      ...rest,
      id: input.id,
      updatedAt: now
    }
    if (password !== undefined) updated.passwordEnc = encryptSecret(password)
    if (sshConfig !== undefined) {
      updated.sshConfig = toStoredSsh(sshConfig, profiles[idx].sshConfig)
    }
    profiles[idx] = updated
    writeStore(profiles)
    return toProfile(updated)
  }

  const created: StoredProfile = {
    name: '未命名连接',
    dbType: 'mysql',
    ...rest,
    id: randomUUID(),
    passwordEnc: encryptSecret(password),
    sshConfig: sshConfig ? toStoredSsh(sshConfig) : undefined,
    createdAt: now,
    updatedAt: now
  }
  profiles.push(created)
  writeStore(profiles)
  return toProfile(created)
}

export function removeProfile(id: string): void {
  writeStore(readStore().filter((p) => p.id !== id))
}
