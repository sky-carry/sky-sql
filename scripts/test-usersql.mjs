// 用户 SQL 生成器冒烟测试：node scripts/test-usersql.mjs
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
execSync(
  `npx esbuild src/main/db/userSql.ts --bundle --platform=node --format=cjs ` +
    `--alias:@shared=./src/shared --outfile=scripts/.usersql-bundle.cjs`,
  { cwd: root, stdio: 'inherit' }
)

const require = createRequire(import.meta.url)
const u = require(join(root, 'scripts/.usersql-bundle.cjs'))

let failures = 0
function check(label, actual, ...expects) {
  const text = actual.join(';\n')
  for (const e of expects) {
    if (!text.includes(e)) {
      failures++
      console.error(`✗ ${label}\n  缺少: ${e}\n  实际: ${text}\n`)
      return
    }
  }
  console.log(`✓ ${label}`)
}
function checkAbsent(label, actual, ...absents) {
  const text = actual.join(';\n')
  for (const a of absents) {
    if (text.includes(a)) {
      failures++
      console.error(`✗ ${label}\n  不应包含: ${a}\n  实际: ${text}\n`)
      return
    }
  }
  console.log(`✓ ${label}`)
}

// ---- MySQL 新建用户 ----
check('MySQL 新建',
  u.mysqlUserStatements({ name: 'app', host: '%', password: "p'wd", privileges: ['SELECT', 'INSERT'] }, null),
  "CREATE USER 'app'@'%' IDENTIFIED BY 'p''wd'",
  "GRANT SELECT, INSERT ON *.* TO 'app'@'%'")

// ---- MySQL 编辑：改密码 + 权限 diff ----
check('MySQL 编辑 diff',
  u.mysqlUserStatements(
    { originalName: 'app', originalHost: '%', name: 'app', host: '%', password: 'new', privileges: ['SELECT', 'UPDATE'] },
    ['SELECT', 'INSERT']
  ),
  "ALTER USER 'app'@'%' IDENTIFIED BY 'new'",
  "GRANT UPDATE ON *.* TO 'app'@'%'",
  "REVOKE INSERT ON *.* FROM 'app'@'%'")

// ---- MySQL 编辑：不改密码不应有 ALTER USER ----
checkAbsent('MySQL 不改密码',
  u.mysqlUserStatements(
    { originalName: 'app', originalHost: '%', name: 'app', host: '%', password: undefined, privileges: ['SELECT'] },
    ['SELECT']
  ),
  'ALTER USER', 'GRANT', 'REVOKE')

// ---- MySQL 重命名 ----
check('MySQL 重命名',
  u.mysqlUserStatements(
    { originalName: 'a', originalHost: '%', name: 'b', host: 'localhost', password: undefined, privileges: [] },
    []
  ),
  "RENAME USER 'a'@'%' TO 'b'@'localhost'")

// ---- MySQL 删除 ----
check('MySQL 删除', [u.mysqlDropUser('app', '%')], "DROP USER 'app'@'%'")

// ---- PG 新建角色 ----
check('PG 新建',
  u.pgUserStatements({ name: 'dev', password: 'pw', privileges: ['LOGIN', 'CREATEDB'] }, null),
  'CREATE ROLE "dev" WITH LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  "PASSWORD 'pw'")

// ---- PG 编辑：属性 diff ----
check('PG 属性 diff',
  u.pgUserStatements(
    { originalName: 'dev', name: 'dev', password: undefined, privileges: ['LOGIN', 'SUPERUSER'] },
    ['LOGIN', 'CREATEDB']
  ),
  'ALTER ROLE "dev" WITH SUPERUSER NOCREATEDB')

// ---- PG 无变更不应产生语句 ----
const noop = u.pgUserStatements(
  { originalName: 'dev', name: 'dev', password: undefined, privileges: ['LOGIN'] },
  ['LOGIN']
)
if (noop.length === 0) console.log('✓ PG 无变更为空')
else { failures++; console.error(`✗ PG 无变更为空 — 实际: ${noop.join(';')}`) }

// ---- PG 重命名 ----
check('PG 重命名',
  u.pgUserStatements({ originalName: 'a', name: 'b', password: undefined, privileges: [] }, []),
  'ALTER ROLE "a" RENAME TO "b"')

// ---- PG 删除 ----
check('PG 删除', [u.pgDropUser('dev')], 'DROP ROLE "dev"')

// ---- SQL Server 新建登录 ----
check('MSSQL 新建',
  u.mssqlUserStatements({ name: 'app', password: "p'wd", privileges: ['dbcreator', 'bulkadmin'] }, null),
  "CREATE LOGIN [app] WITH PASSWORD = N'p''wd', CHECK_POLICY = OFF",
  'ALTER SERVER ROLE [dbcreator] ADD MEMBER [app]',
  'ALTER SERVER ROLE [bulkadmin] ADD MEMBER [app]')

// ---- SQL Server 编辑：角色 diff ----
check('MSSQL 角色 diff',
  u.mssqlUserStatements(
    { originalName: 'app', name: 'app', password: undefined, privileges: ['sysadmin'] },
    ['dbcreator']
  ),
  'ALTER SERVER ROLE [sysadmin] ADD MEMBER [app]',
  'ALTER SERVER ROLE [dbcreator] DROP MEMBER [app]')

// ---- SQL Server 重命名 + 改密码 ----
check('MSSQL 重命名改密码',
  u.mssqlUserStatements(
    { originalName: 'a', name: 'b', password: 'new', privileges: [] },
    []
  ),
  'ALTER LOGIN [a] WITH NAME = [b]',
  "ALTER LOGIN [b] WITH PASSWORD = N'new'")

// ---- SQL Server 无变更不应产生语句 ----
const msNoop = u.mssqlUserStatements(
  { originalName: 'app', name: 'app', password: undefined, privileges: ['dbcreator'] },
  ['dbcreator']
)
if (msNoop.length === 0) console.log('✓ MSSQL 无变更为空')
else { failures++; console.error(`✗ MSSQL 无变更为空 — 实际: ${msNoop.join(';')}`) }

// ---- SQL Server 删除 ----
check('MSSQL 删除', [u.mssqlDropUser('app')], 'DROP LOGIN [app]')

if (failures > 0) {
  console.error(`\n${failures} 个用例失败`)
  process.exit(1)
}
console.log('\n全部通过')
