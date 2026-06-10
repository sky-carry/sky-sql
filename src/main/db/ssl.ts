import { readFileSync } from 'fs'
import type { ConnectionProfile } from '@shared/types'

export interface SslOption {
  ca?: Buffer
  cert?: Buffer
  key?: Buffer
  rejectUnauthorized: boolean
}

/** 根据连接配置构建 mysql2 / pg 通用的 ssl 选项；未启用返回 undefined */
export function buildSslOption(profile: Partial<ConnectionProfile>): SslOption | undefined {
  const cfg = profile.sslConfig
  if (cfg?.enabled) {
    return {
      ca: cfg.caPath ? readFileSync(cfg.caPath) : undefined,
      cert: cfg.certPath ? readFileSync(cfg.certPath) : undefined,
      key: cfg.keyPath ? readFileSync(cfg.keyPath) : undefined,
      rejectUnauthorized: cfg.rejectUnauthorized
    }
  }
  // 兼容旧版布尔开关
  if (profile.ssl) return { rejectUnauthorized: false }
  return undefined
}
