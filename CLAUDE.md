# SkySQL 项目说明（给 AI 助手）

复刻 Navicat 的数据库管理桌面工具。产品需求基准见 `docs/navicat-research.md`（Navicat 17 功能调研），README 里有路线图。

## 关键约定

- **技术栈**：Electron + electron-vite + React 19 + TypeScript + antd 6 + zustand；SQL 编辑器用 Monaco（本地打包，勿用 CDN loader）；数据网格用 @glideapps/glide-data-grid（canvas 渲染，需要 `#portal` 挂载点和显式像素尺寸）。
- **跨平台**：先做 Windows，但所有代码必须保持 mac 兼容（不要用 win32 专属 API；平台差异写在主进程并以 `process.platform` 分支）。
- **驱动抽象**：所有数据库操作经 `src/main/db/driver.ts` 的 `DatabaseDriver` 接口；新数据库 = 新驱动实现 + `registry.ts` 注册 + `DbType` 扩展。渲染进程绝不直接接触驱动。
- **IPC**：通道名和 API 类型集中在 `src/shared/ipc.ts`；主进程统一用 `ipcHandlers.ts` 的 `handle()` 包装（错误转 `{ok:false,error}`），渲染进程经 `window.skysql` 调用。
- **数据序列化**：跨 IPC 的单元格值是 `CellValue`（Buffer→binary 标记对象、Date→字符串、BigInt→number/string），转换函数在 `driver.ts` 的 `toCellValue/fromCellValue`。
- **SQL 安全**：值一律走绑定参数；标识符用各驱动的 `quoteIdent`；limit/offset 经 `safeInt` 校验后内联。
- **中文 UI**：界面文案用简体中文，antd locale 为 zh_CN。

## 常用命令

- `npm run dev` — 开发模式（Electron 二进制缺失时：`$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js`）
- `npm run typecheck` — 两个 tsconfig（node + web）都要过
- `node scripts/test-ddl.mjs` — 表设计器 DDL 生成器（src/renderer/src/ddl.ts）的冒烟测试，改 DDL 逻辑后必跑
- `node scripts/test-parsers.mjs` — 导入文件解析器（src/main/transfer/parsers.ts）的冒烟测试
- `node scripts/test-tunnel.mjs` — SSH 隧道模块（src/main/db/sshTunnel.ts）的冒烟测试（错误路径，无需真实 SSH）
- `node scripts/test-usersql.mjs` — 用户 SQL 生成器（src/main/db/userSql.ts，纯函数）的冒烟测试
- `node scripts/test-sqlsplit.mjs` — SQL 语句拆分器（src/main/db/sqlSplit.ts）的冒烟测试；备份/还原引擎在 src/main/transfer/backup.ts
- `node scripts/test-typemap.mjs` — 跨库种类型映射与建表（src/main/transfer/ddlBuild.ts，纯函数）的冒烟测试；数据传输引擎在 src/main/transfer/dataTransfer.ts
- `node scripts/test-datasync.mjs` — 数据同步行级 diff（src/main/transfer/dataSync.ts 的 diffRows 纯函数）的冒烟测试；比对结果缓存在主进程 diffCache（jobId 键），部署后/标签页关闭时需 release
- `node scripts/test-querybuilder.mjs` — 查询构建器 SQL 生成（src/renderer/src/queryBuilder.ts，纯函数）的冒烟测试
- SSH/SSL：隧道在 connectionManager 中与连接同生命周期；驱动收到的是"等效 profile"（host/port 指向本地隧道端口）；SSL 文件读取在 src/main/db/ssl.ts
- 导入导出在 `src/main/transfer/`：进度经 IPC 事件 `transfer:progress` 推送，jobId 由渲染层生成；解析逻辑放 parsers.ts（无 electron 依赖，便于测试）
- dev 已带 `--watch`：主进程/preload 改动会自动重启 Electron
- `.npmrc` 已设 legacy-peer-deps（glide-data-grid 尚未声明 React 19 peer）

## 打包注意事项

- **Electron 固定在 41.x**：better-sqlite3 v12 的预编译只发布到 Electron ABI v145（=Electron 41），本机没有 VS 编译环境无法从源码编译；升级 Electron 前先确认 better-sqlite3 发布了对应 ABI 的 prebuild（GitHub releases 查 `electron-vXXX-win32-x64`）。
- **asar 已禁用**（package.json build.asar=false）：本机 electron-builder 打 asar 会出现内容偏移损坏（文件头正确但内容错位到其他文件，疑似杀软干扰写入），症状是打包后启动即静默退出 exit 1；诊断方法：`ELECTRON_RUN_AS_NODE=1 SkySQL.exe -e "require('<app>/out/main/index.js')"`。
- **打包命令**需设镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`、`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。
- 打包结尾可能报 `EBUSY unlink ...nsis.7z`（杀软锁临时文件）——是清理阶段的报错，`release/SkySQL-Setup-*.exe` 已完整生成，可忽略。
- 渲染层依赖都在 devDependencies（Vite 已打进产物）；dependencies 只放主进程运行时依赖（驱动、ssh2、xlsx、papaparse），electron-builder 只携带 production deps。

## 已知环境问题

- 本机跑 Electron 需要 `disable-gpu`/`in-process-gpu` 开关（已在 `src/main/index.ts` 处理），否则 GPU 进程报 error_code=57 直接退出。
