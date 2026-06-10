// 查询构建器 SQL 生成冒烟测试：node scripts/test-querybuilder.mjs
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
execSync(
  `npx esbuild src/renderer/src/queryBuilder.ts --bundle --platform=node --format=cjs ` +
    `--alias:@shared=./src/shared --alias:@=./src/renderer/src --outfile=scripts/.qb-bundle.cjs`,
  { cwd: root, stdio: 'inherit' }
)

const require = createRequire(import.meta.url)
const { generateQuery } = require(join(root, 'scripts/.qb-bundle.cjs'))

let failures = 0
function eq(label, actual, expected) {
  if (actual === expected) console.log(`✓ ${label}`)
  else {
    failures++
    console.error(`✗ ${label}\n--- 期望 ---\n${expected}\n--- 实际 ---\n${actual}`)
  }
}

// 最简：SELECT *
eq('最简查询', generateQuery('mysql', {
  baseTable: 'users', joins: [], fields: [], conditions: [], groupBy: [], orderBy: []
}), 'SELECT *\nFROM `users`')

// 完整：JOIN + 字段 + WHERE + GROUP BY + ORDER BY + LIMIT
eq('完整查询 MySQL', generateQuery('mysql', {
  baseTable: 'orders',
  joins: [{ key: '1', type: 'LEFT', table: 'users', leftTable: 'orders', leftCol: 'user_id', rightCol: 'id' }],
  fields: ['orders.id', 'users.name'],
  conditions: [
    { key: '1', column: 'orders.status', op: '=', value: 'paid' },
    { key: '2', column: 'orders.amount', op: '>', value: '100' },
    { key: '3', column: 'users.deleted_at', op: 'IS NULL', value: '' }
  ],
  groupBy: ['users.name'],
  orderBy: [{ key: '1', column: 'orders.id', dir: 'DESC' }],
  limit: 50
}), [
  'SELECT `orders`.`id`, `users`.`name`',
  'FROM `orders`',
  'LEFT JOIN `users` ON `orders`.`user_id` = `users`.`id`',
  "WHERE `orders`.`status` = 'paid'",
  '  AND `orders`.`amount` > 100',
  '  AND `users`.`deleted_at` IS NULL',
  'GROUP BY `users`.`name`',
  'ORDER BY `orders`.`id` DESC',
  'LIMIT 50'
].join('\n'))

// PG schema 限定表
eq('PG schema 表', generateQuery('postgresql', {
  baseTable: 'app.orders', joins: [], fields: ['app.orders.id'],
  conditions: [], groupBy: [], orderBy: []
}), 'SELECT "app"."orders"."id"\nFROM "app"."orders"')

// 值转义
eq('单引号转义', generateQuery('sqlite', {
  baseTable: 't', joins: [],
  fields: [], conditions: [{ key: '1', column: 't.name', op: '=', value: "o'neil" }],
  groupBy: [], orderBy: []
}), `SELECT *\nFROM "t"\nWHERE "t"."name" = 'o''neil'`)

// 不完整 JOIN 被忽略；空条件被忽略
eq('忽略不完整片段', generateQuery('mysql', {
  baseTable: 'a',
  joins: [{ key: '1', type: 'INNER', table: '', leftTable: 'a', leftCol: '', rightCol: '' }],
  fields: [], conditions: [{ key: '1', column: 'a.x', op: '=', value: '' }],
  groupBy: [], orderBy: [{ key: '1', column: '', dir: 'ASC' }]
}), 'SELECT *\nFROM `a`')

if (failures > 0) {
  console.error(`\n${failures} 个用例失败`)
  process.exit(1)
}
console.log('\n全部通过')
