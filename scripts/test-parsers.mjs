// 导入文件解析器冒烟测试：node scripts/test-parsers.mjs
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createRequire } from 'module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
execSync(
  `npx esbuild src/main/transfer/parsers.ts --bundle --platform=node --format=cjs ` +
    `--alias:@shared=./src/shared --external:xlsx --external:papaparse --outfile=scripts/.parsers-bundle.cjs`,
  { cwd: root, stdio: 'inherit' }
)

const require = createRequire(import.meta.url)
const { parseFile, previewFile } = require(join(root, 'scripts/.parsers-bundle.cjs'))
const XLSX = require(join(root, 'node_modules/xlsx'))

const dir = mkdtempSync(join(tmpdir(), 'skysql-test-'))
let failures = 0
function assert(label, cond, detail) {
  if (cond) {
    console.log(`✓ ${label}`)
  } else {
    failures++
    console.error(`✗ ${label}${detail ? ` — ${JSON.stringify(detail)}` : ''}`)
  }
}

// ---- CSV：带 BOM、引号转义、内嵌逗号与换行 ----
const csvPath = join(dir, 'a.csv')
writeFileSync(csvPath, '﻿id,name,remark\r\n1,"张三","说 ""你好""，再见"\r\n2,李四,"多行\n文本"\r\n', 'utf-8')
const csv = parseFile(csvPath, 'csv', { delimiter: ',', hasHeader: true })
assert('CSV 表头', JSON.stringify(csv.headers) === '["id","name","remark"]', csv.headers)
assert('CSV 行数', csv.rows.length === 2, csv.rows.length)
assert('CSV 引号转义', csv.rows[0][2] === '说 "你好"，再见', csv.rows[0][2])
assert('CSV 内嵌换行', csv.rows[1][2] === '多行\n文本', csv.rows[1][2])

// ---- CSV：无表头 + 分号分隔 ----
const csv2Path = join(dir, 'b.csv')
writeFileSync(csv2Path, '1;a\n2;b\n', 'utf-8')
const csv2 = parseFile(csv2Path, 'csv', { delimiter: ';', hasHeader: false })
assert('CSV 无表头列名', JSON.stringify(csv2.headers) === '["列1","列2"]', csv2.headers)
assert('CSV 无表头行数', csv2.rows.length === 2, csv2.rows)

// ---- JSON：对象数组 + 嵌套对象序列化 + 列并集 ----
const jsonPath = join(dir, 'c.json')
writeFileSync(jsonPath, JSON.stringify([
  { id: 1, name: '张三', meta: { vip: true } },
  { id: 2, email: 'x@y.com' }
]), 'utf-8')
const json = parseFile(jsonPath, 'json', { delimiter: ',', hasHeader: true })
assert('JSON 列并集', JSON.stringify(json.headers) === '["id","name","meta","email"]', json.headers)
assert('JSON 嵌套序列化', json.rows[0][2] === '{"vip":true}', json.rows[0][2])
assert('JSON 缺失列为 undefined/null', json.rows[1][1] == null, json.rows[1])

// ---- JSON：非数组报错 ----
const badJsonPath = join(dir, 'd.json')
writeFileSync(badJsonPath, '{"a":1}', 'utf-8')
let threw = false
try { parseFile(badJsonPath, 'json', { delimiter: ',', hasHeader: true }) } catch { threw = true }
assert('JSON 非数组抛错', threw)

// ---- XLSX 往返 ----
const xlsxPath = join(dir, 'e.xlsx')
const ws = XLSX.utils.aoa_to_sheet([['id', '姓名'], [1, '张三'], [2, '李四']])
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, ws, '数据')
XLSX.writeFile(wb, xlsxPath)
const xlsx = parseFile(xlsxPath, 'xlsx', { delimiter: ',', hasHeader: true })
assert('XLSX 表头', JSON.stringify(xlsx.headers) === '["id","姓名"]', xlsx.headers)
assert('XLSX 行数', xlsx.rows.length === 2, xlsx.rows)
assert('XLSX 工作表列表', JSON.stringify(xlsx.sheets) === '["数据"]', xlsx.sheets)
assert('XLSX 数字保留类型', xlsx.rows[0][0] === 1, typeof xlsx.rows[0][0])

// ---- 预览 ----
const pv = previewFile(csvPath, 'csv', { delimiter: ',', hasHeader: true })
assert('预览行数提示', pv.totalRowsHint === 2, pv.totalRowsHint)
assert('预览值为字符串', typeof pv.rows[0][0] === 'string')

rmSync(dir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} 个用例失败`)
  process.exit(1)
}
console.log('\n全部通过')
