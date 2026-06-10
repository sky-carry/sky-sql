// SQL 语句拆分器冒烟测试：node scripts/test-sqlsplit.mjs
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
execSync(
  `npx esbuild src/main/db/sqlSplit.ts --bundle --platform=node --format=cjs --outfile=scripts/.sqlsplit-bundle.cjs`,
  { cwd: root, stdio: 'inherit' }
)

const require = createRequire(import.meta.url)
const { splitStatements, isCommentOnly } = require(join(root, 'scripts/.sqlsplit-bundle.cjs'))

let failures = 0
function assert(label, cond, detail) {
  if (cond) console.log(`✓ ${label}`)
  else {
    failures++
    console.error(`✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  }
}

// 基本拆分
const r1 = splitStatements('SELECT 1; SELECT 2;\nSELECT 3')
assert('基本拆分为 3 条', r1.length === 3, r1)

// 字符串内的分号不拆
const r2 = splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1")
assert('字符串内分号', r2.length === 2 && r2[0].includes("'a;b'"), r2)

// 转义引号（'' 形式）
const r3 = splitStatements("INSERT INTO t VALUES ('it''s; fine'); SELECT 1")
assert('转义引号内分号', r3.length === 2 && r3[0].includes("it''s; fine"), r3)

// 行注释内的分号不拆
const r4 = splitStatements('SELECT 1 -- comment; not a split\n; SELECT 2')
assert('行注释内分号', r4.length === 2, r4)

// 块注释内的分号不拆
const r5 = splitStatements('SELECT 1 /* x; y */; SELECT 2')
assert('块注释内分号', r5.length === 2, r5)

// 反引号标识符
const r6 = splitStatements('CREATE TABLE `a;b` (id int); SELECT 1')
assert('反引号内分号', r6.length === 2 && r6[0].includes('`a;b`'), r6)

// 备份文件典型结构：头注释 + SET + DDL + 多行 INSERT
const backup = `-- SkySQL 备份
-- 时间: 2026-06-10
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS \`users\`;
CREATE TABLE \`users\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`name\` varchar(64) COMMENT '姓名; 备注',
  PRIMARY KEY (\`id\`)
);
INSERT INTO \`users\` (\`id\`, \`name\`) VALUES
  (1, '张三'),
  (2, '李; 四');
SET FOREIGN_KEY_CHECKS = 1;
`
const r7 = splitStatements(backup)
const exec7 = r7.filter((s) => !isCommentOnly(s))
assert('备份文件拆分为 5 条可执行语句', exec7.length === 5, exec7.map((s) => s.slice(0, 30)))
assert('INSERT 含中文与分号值', exec7[3].includes("'李; 四'"), exec7[3])

// isCommentOnly
assert('纯注释识别', isCommentOnly('-- abc') && isCommentOnly('/* x */') && !isCommentOnly('SELECT 1 -- x'))

if (failures > 0) {
  console.error(`\n${failures} 个用例失败`)
  process.exit(1)
}
console.log('\n全部通过')
