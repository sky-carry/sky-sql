// 数据同步行级 diff 冒烟测试：node scripts/test-datasync.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const esbuild = require(join(root, 'node_modules/esbuild'))

// 依赖 electron 的相对导入替换为测试桩
const stubPlugin = {
  name: 'stub',
  setup(build) {
    build.onResolve({ filter: /(connectionManager|\/jobs)$/ }, () => ({
      path: join(root, 'scripts/stub-empty.mjs')
    }))
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: join(root, 'src/shared', args.path.replace('@shared/', '') + '.ts')
    }))
  }
}

await esbuild.build({
  entryPoints: [join(root, 'src/main/transfer/dataSync.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(root, 'scripts/.datasync-bundle.cjs'),
  plugins: [stubPlugin]
})

const { diffRows } = require(join(root, 'scripts/.datasync-bundle.cjs'))

let failures = 0
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) console.log(`✓ ${label}`)
  else {
    failures++
    console.error(`✗ ${label}\n  期望 ${e}\n  实际 ${a}`)
  }
}

const cols = ['id', 'name', 'age']

// 基础三类差异
const d1 = diffRows(cols, ['id'],
  [[1, '张三', 20], [2, '李四', 30], [3, '王五', 40]],   // 源
  [[2, '李四', 31], [3, '王五', 40], [4, '赵六', 50]])   // 目标
eq('插入数', d1.inserts.length, 1)
eq('插入行', d1.inserts[0], [1, '张三', 20])
eq('更新数', d1.updates.length, 1)
eq('更新内容', d1.updates[0], { kind: 'update', keys: { id: 2 }, values: { age: 30 } })
eq('删除数', d1.deletes.length, 1)
eq('删除键', d1.deletes[0], { kind: 'delete', keys: { id: 4 } })

// 完全一致
const d2 = diffRows(cols, ['id'], [[1, 'a', 1]], [[1, 'a', 1]])
eq('一致时无差异', d2.inserts.length + d2.updates.length + d2.deletes.length, 0)

// 宽松数值比较：1 与 "1"、1.5 与 "1.50"
const d3 = diffRows(cols, ['id'], [[1, 'a', 1.5]], [['1', 'a', '1.50']])
eq('数值表示差异视为相等', d3.updates.length, 0)

// NULL 处理：null ≠ 0，null = null
const d4 = diffRows(cols, ['id'], [[1, null, null]], [[1, '0', null]])
eq('null 与 0 不等', d4.updates.length, 1)
eq('null 与 null 相等', Object.keys(d4.updates[0].values), ['name'])

// 复合主键 + 主键串拼接不碰撞（'a','bc' vs 'ab','c'）
const d5 = diffRows(['k1', 'k2', 'v'], ['k1', 'k2'],
  [['a', 'bc', 1]],
  [['ab', 'c', 1]])
eq('复合主键不碰撞-插入', d5.inserts.length, 1)
eq('复合主键不碰撞-删除', d5.deletes.length, 1)

// 二进制值比较
const bin = (b64) => ({ __type: 'binary', base64: b64, length: 4 })
const d6 = diffRows(['id', 'data'], ['id'],
  [[1, bin('AAAA')], [2, bin('BBBB')]],
  [[1, bin('AAAA')], [2, bin('CCCC')]])
eq('二进制相等跳过', d6.updates.length, 1)
eq('二进制差异检出', d6.updates[0].keys.id, 2)

if (failures > 0) {
  console.error(`\n${failures} 个用例失败`)
  process.exit(1)
}
console.log('\n全部通过')
