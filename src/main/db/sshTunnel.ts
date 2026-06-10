import { createServer, type Server, type Socket } from 'net'
import { readFileSync } from 'fs'
import { Client, type ConnectConfig } from 'ssh2'
import type { ConnectionProfile } from '@shared/types'

export interface TunnelHandle {
  localHost: string
  localPort: number
  close(): void
}

/**
 * 建立 SSH 本地端口转发隧道。
 * 返回本地监听地址，数据库驱动连接该地址，流量经 SSH 转发到 profile.host:profile.port
 * （即 Navicat 语义：常规页的主机是相对 SSH 主机的地址）。
 */
export async function createTunnel(profile: ConnectionProfile): Promise<TunnelHandle> {
  const ssh = profile.sshConfig
  if (!ssh?.enabled) throw new Error('SSH 配置未启用')

  const dstHost = profile.host || '127.0.0.1'
  const dstPort = profile.port ?? 3306

  const config: ConnectConfig = {
    host: ssh.host,
    port: ssh.port || 22,
    username: ssh.user,
    readyTimeout: 15000,
    keepaliveInterval: 30000
  }
  if (ssh.authType === 'privateKey') {
    if (!ssh.privateKeyPath) throw new Error('请选择 SSH 私钥文件')
    config.privateKey = readFileSync(ssh.privateKeyPath)
    if (ssh.passphrase) config.passphrase = ssh.passphrase
  } else {
    config.password = ssh.password ?? ''
  }

  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve())
    client.once('error', (e) => reject(new Error(`SSH 连接失败: ${e.message}`)))
    client.connect(config)
  })

  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    client.forwardOut(
      socket.localAddress ?? '127.0.0.1',
      socket.localPort ?? 0,
      dstHost,
      dstPort,
      (err, stream) => {
        if (err) {
          socket.destroy()
          return
        }
        socket.pipe(stream).pipe(socket)
        stream.on('error', () => socket.destroy())
        socket.on('error', () => stream.destroy())
      }
    )
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    client.end()
    throw new Error('本地转发端口监听失败')
  }

  // SSH 断开时关闭本地服务，避免悬挂的死隧道
  client.on('close', () => {
    server.close()
    for (const s of sockets) s.destroy()
  })

  return {
    localHost: '127.0.0.1',
    localPort: address.port,
    close: () => {
      for (const s of sockets) s.destroy()
      server.close()
      client.end()
    }
  }
}

/** 若启用 SSH，返回指向本地隧道端口的等效连接配置 */
export async function withTunnel(
  profile: ConnectionProfile
): Promise<{ effective: ConnectionProfile; tunnel: TunnelHandle | null }> {
  if (!profile.sshConfig?.enabled || profile.dbType === 'sqlite') {
    return { effective: profile, tunnel: null }
  }
  const tunnel = await createTunnel(profile)
  return {
    effective: { ...profile, host: tunnel.localHost, port: tunnel.localPort },
    tunnel
  }
}
