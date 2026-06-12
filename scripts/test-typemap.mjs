// 跨库种类型映射与建表生成冒烟测试：node scripts/test-typemap.mjs
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
execSync(
  `npx esbuild src/main/transfer/ddlBuild.ts --bundle --platform=node --format=cjs ` +
    `--alias:@shared=./src/shared --outfile=scripts/.typemap-bundle.cjs`,
  { cwd: root, stdio: 'inherit' }
)

const require = createRequire(import.meta.url)
const m = require(join(root, 'scripts/.typemap-bundle.cjs'))

let failures = 0
function eq(label, actual, expected) {
  if (actual === expected) console.log(`✓ ${label}`)
  else {
    failures++
    console.error(`✗ ${label} — 期望 ${expected}，实际 ${actual}`)
  }
}
function has(label, list, ...subs) {
  const text = list.join(';\n')
  for (const s of subs) {
    if (!text.includes(s)) {
      failures++
      console.error(`✗ ${label}\n  缺少: ${s}\n  实际: ${text}`)
      return
    }
  }
  console.log(`✓ ${label}`)
}

const col = (dataType, columnType, extra = {}) => ({
  name: 'c', dataType, columnType, nullable: true, defaultValue: null,
  isPrimaryKey: false, isAutoIncrement: false, ...extra
})

// MySQL → PG
eq('mysql varchar→pg', m.mapColumnType('mysql', 'postgresql', col('varchar', 'varchar(255)')), 'character varying(255)')
eq('mysql int→pg', m.mapColumnType('mysql', 'postgresql', col('int', 'int')), 'integer')
eq('mysql tinyint(1)→pg bool', m.mapColumnType('mysql', 'postgresql', col('tinyint', 'tinyint(1)')), 'boolean')
eq('mysql datetime→pg', m.mapColumnType('mysql', 'postgresql', col('datetime', 'datetime')), 'timestamp')
eq('mysql longblob→pg', m.mapColumnType('mysql', 'postgresql', col('longblob', 'longblob')), 'bytea')
eq('mysql json→pg', m.mapColumnType('mysql', 'postgresql', col('json', 'json')), 'jsonb')
eq('mysql enum→pg', m.mapColumnType('mysql', 'postgresql', col('enum', "enum('a','b')")), 'text')
eq('mysql decimal→pg', m.mapColumnType('mysql', 'postgresql', col('decimal', 'decimal(10,2)')), 'numeric(10,2)')

// PG → MySQL
eq('pg charvar→mysql', m.mapColumnType('postgresql', 'mysql', col('character varying', 'character varying(64)')), 'varchar(64)')
eq('pg bool→mysql', m.mapColumnType('postgresql', 'mysql', col('boolean', 'boolean')), 'tinyint(1)')
eq('pg timestamptz→mysql', m.mapColumnType('postgresql', 'mysql', col('timestamptz', 'timestamptz')), 'datetime')
eq('pg uuid→mysql', m.mapColumnType('postgresql', 'mysql', col('uuid', 'uuid')), 'char(36)')
eq('pg jsonb→mysql', m.mapColumnType('postgresql', 'mysql', col('jsonb', 'jsonb')), 'json')
eq('pg bytea→mysql', m.mapColumnType('postgresql', 'mysql', col('bytea', 'bytea')), 'longblob')

// → SQLite
eq('mysql int→sqlite', m.mapColumnType('mysql', 'sqlite', col('int', 'int')), 'INTEGER')
eq('pg numeric→sqlite', m.mapColumnType('postgresql', 'sqlite', col('numeric', 'numeric(10,2)')), 'REAL')
eq('mysql varchar→sqlite', m.mapColumnType('mysql', 'sqlite', col('varchar', 'varchar(50)')), 'TEXT')

// 同族原样
eq('mysql→mariadb 原样', m.mapColumnType('mysql', 'mariadb', col('varchar', 'varchar(255) unsigned')), 'varchar(255) unsigned')

// SQL Server → 其他
eq('mssql nvarchar→pg', m.mapColumnType('sqlserver', 'postgresql', col('nvarchar', 'nvarchar(50)')), 'character varying(50)')
eq('mssql nvarchar(max)→pg', m.mapColumnType('sqlserver', 'postgresql', col('nvarchar', 'nvarchar(max)')), 'text')
eq('mssql datetime2→pg', m.mapColumnType('sqlserver', 'postgresql', col('datetime2', 'datetime2(7)')), 'timestamp')
eq('mssql uniqueidentifier→pg', m.mapColumnType('sqlserver', 'postgresql', col('uniqueidentifier', 'uniqueidentifier')), 'uuid')
eq('mssql bit→pg', m.mapColumnType('sqlserver', 'postgresql', col('bit', 'bit')), 'boolean')
eq('mssql money→pg', m.mapColumnType('sqlserver', 'postgresql', col('money', 'money')), 'numeric(19,4)')
eq('mssql float→pg', m.mapColumnType('sqlserver', 'postgresql', col('float', 'float')), 'double precision')
eq('mssql varbinary(max)→mysql', m.mapColumnType('sqlserver', 'mysql', col('varbinary', 'varbinary(max)')), 'longblob')
eq('mssql nvarchar→mysql', m.mapColumnType('sqlserver', 'mysql', col('nvarchar', 'nvarchar(50)')), 'varchar(50)')
eq('mssql datetime2→mysql', m.mapColumnType('sqlserver', 'mysql', col('datetime2', 'datetime2')), 'datetime')
eq('mssql bit→sqlite', m.mapColumnType('sqlserver', 'sqlite', col('bit', 'bit')), 'INTEGER')

// 其他 → SQL Server
eq('mysql varchar→mssql', m.mapColumnType('mysql', 'sqlserver', col('varchar', 'varchar(255)')), 'nvarchar(255)')
eq('mysql tinyint(1)→mssql', m.mapColumnType('mysql', 'sqlserver', col('tinyint', 'tinyint(1)')), 'bit')
eq('mysql text→mssql', m.mapColumnType('mysql', 'sqlserver', col('text', 'text')), 'nvarchar(max)')
eq('mysql datetime→mssql', m.mapColumnType('mysql', 'sqlserver', col('datetime', 'datetime')), 'datetime2')
eq('mysql longblob→mssql', m.mapColumnType('mysql', 'sqlserver', col('longblob', 'longblob')), 'varbinary(max)')
eq('pg boolean→mssql', m.mapColumnType('postgresql', 'sqlserver', col('boolean', 'boolean')), 'bit')
eq('pg uuid→mssql', m.mapColumnType('postgresql', 'sqlserver', col('uuid', 'uuid')), 'uniqueidentifier')
eq('pg numeric→mssql', m.mapColumnType('postgresql', 'sqlserver', col('numeric', 'numeric(10,2)')), 'decimal(10,2)')
eq('pg jsonb→mssql', m.mapColumnType('postgresql', 'sqlserver', col('jsonb', 'jsonb')), 'nvarchar(max)')

// 建表：MySQL 源 → SQL Server 目标（IDENTITY + 方括号引用）
has('跨库建表 mysql→mssql',
  m.buildCreateTable('sqlserver', 'users', {
    columns: [
      { name: 'id', dataType: 'int', columnType: 'int', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
      { name: 'ok', dataType: 'tinyint', columnType: 'tinyint(1)', nullable: false, defaultValue: 'TRUE', isPrimaryKey: false, isAutoIncrement: false }
    ],
    indexes: [], foreignKeys: []
  }, { includeIndexes: false, srcType: 'mysql' }),
  'CREATE TABLE [users]',
  '[id] int IDENTITY(1,1) NOT NULL',
  '[ok] bit DEFAULT 1 NOT NULL',
  'PRIMARY KEY ([id])')

// 分页方言
eq('mssql 分页', m.pageClause('sqlserver', 100, 200), ' ORDER BY (SELECT NULL) OFFSET 200 ROWS FETCH NEXT 100 ROWS ONLY')
eq('mssql 分页（已有排序）', m.pageClause('sqlserver', 100, 0, true), ' OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY')
eq('mysql 分页', m.pageClause('mysql', 100, 200), ' LIMIT 100 OFFSET 200')

// 表引用
eq('mssql schema 表引用', m.qualifyTable('sqlserver', 'sales.orders'), '[sales].[orders]')
eq('mssql 无 schema 表引用', m.qualifyTable('sqlserver', 'orders'), '[orders]')
eq('mysql 表引用不拆分', m.qualifyTable('mysql', 'a.b'), '`a.b`')

// 建表：MySQL 源 → PG 目标
const meta = {
  columns: [
    { name: 'id', dataType: 'int', columnType: 'int', nullable: false, defaultValue: null, isPrimaryKey: true, isAutoIncrement: true },
    { name: 'name', dataType: 'varchar', columnType: 'varchar(64)', nullable: false, defaultValue: 'guest', isPrimaryKey: false, isAutoIncrement: false },
    { name: 'created', dataType: 'datetime', columnType: 'datetime', nullable: true, defaultValue: 'CURRENT_TIMESTAMP', isPrimaryKey: false, isAutoIncrement: false }
  ],
  indexes: [{ name: 'idx_name', columns: ['name'], unique: true, method: 'BTREE' }],
  foreignKeys: [{ name: 'fk_x', columns: ['name'], refTable: 'other', refColumns: ['n'], onUpdate: 'NO ACTION', onDelete: 'CASCADE' }]
}
const createStmts = m.buildCreateTable('postgresql', 'users', meta, { includeIndexes: true, srcType: 'mysql' })
has('跨库建表 mysql→pg', createStmts,
  'CREATE TABLE "users"',
  '"id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL',
  `"name" character varying(64) DEFAULT 'guest' NOT NULL`,
  '"created" timestamp DEFAULT CURRENT_TIMESTAMP',
  'PRIMARY KEY ("id")',
  'CREATE UNIQUE INDEX "users_idx_name" ON "users" ("name")')

// 跨库种不带 USING BTREE
if (!createStmts.join(';').includes('USING')) console.log('✓ 跨库不带索引方法')
else { failures++; console.error('✗ 跨库不带索引方法') }

// 外键
has('外键语句', m.buildFkStatements('postgresql', 'users', meta),
  'ALTER TABLE "users" ADD CONSTRAINT "fk_x" FOREIGN KEY ("name") REFERENCES "other" ("n") ON DELETE CASCADE')

// SQLite 目标无外键
eq('sqlite 无外键', m.buildFkStatements('sqlite', 'users', meta).length, 0)

// SQLite 整数主键内联
has('sqlite 内联自增主键', m.buildCreateTable('sqlite', 'users', meta, { includeIndexes: false, srcType: 'mysql' }),
  '"id" INTEGER PRIMARY KEY AUTOINCREMENT')

if (failures > 0) {
  console.error(`\n${failures} 个用例失败`)
  process.exit(1)
}
console.log('\n全部通过')
