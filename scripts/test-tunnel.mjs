// SSH 隧道模块冒烟测试（无需真实 SSH 服务器）：node scripts/test-tunnel.mjs
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
execSync(
  `npx esbuild src/main/db/sshTunnel.ts --bundle --platform=node --format=cjs ` +
    `--alias:@shared=./src/shared --external:ssh2 --outfile=scripts/.tunnel-bundle.cjs`,
  { cwd: root, stdio: 'inherit' }
)

const require = createRequire(import.meta.url)
const { withTunnel, createTunnel } = require(join(root, 'scripts/.tunnel-bundle.cjs'))

let failures = 0
function assert(label, cond, detail) {
  if (cond) console.log(`✓ ${label}`)
  else {
    failures++
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// 未启用 SSH → 原样直通，不建隧道
const plain = { id: 'x', name: 't', dbType: 'mysql', host: 'db.internal', port: 3306 }
const r1 = await withTunnel(plain)
assert('未启用 SSH 直通', r1.tunnel === null && r1.effective.host === 'db.internal')

// SQLite 即使配置了 SSH 也直通
const sqlite = { id: 'x', name: 't', dbType: 'sqlite', filePath: 'a.db', sshConfig: { enabled: true, host: 'h', port: 22, user: 'u', authType: 'password' } }
const r2 = await withTunnel(sqlite)
assert('SQLite 跳过隧道', r2.tunnel === null)

// 不可达的 SSH 主机 → 报"SSH 连接失败"而不是崩溃
let errMsg = ''
try {
  await createTunnel({
    id: 'x', name: 't', dbType: 'mysql', host: '127.0.0.1', port: 3306,
    sshConfig: { enabled: true, host: '127.0.0.1', port: 1, user: 'u', authType: 'password', password: 'x' }
  })
} catch (e) {
  errMsg = e.message
}
assert('SSH 不可达报错', errMsg.includes('SSH 连接失败'), errMsg)

// 私钥模式缺文件 → 明确报错
let errMsg2 = ''
try {
  await createTunnel({
    id: 'x', name: 't', dbType: 'mysql', host: '127.0.0.1', port: 3306,
    sshConfig: { enabled: true, host: 'h', port: 22, user: 'u', authType: 'privateKey' }
  })
} catch (e) {
  errMsg2 = e.message
}
assert('缺私钥文件报错', errMsg2.includes('私钥'), errMsg2)

if (failures > 0) {
  console.error(`\n${failures} 个用例失败`)
  process.exit(1)
}
console.log('\n全部通过')
