# SkySQL

类 Navicat 的专业数据库管理工具（桌面应用），基于 Electron + React + TypeScript。
当前优先支持 Windows，代码层面保持跨平台（macOS 打包配置已就位）。

## 当前支持

- **数据库**：MySQL / MariaDB、PostgreSQL、SQLite、SQL Server（2016+，mssql/tedious 纯 JS 驱动）
- **连接管理**：新建/编辑/删除/测试连接，密码加密存储（Electron safeStorage），颜色标记、分组字段
- **SSH 隧道**：密码或私钥（含口令）认证，主进程本地端口转发，SSH 凭据同样加密存储；语义与 Navicat 一致（常规页主机 = 相对 SSH 主机的地址）
- **SSL/TLS**：CA 证书、客户端证书/密钥、可选服务器证书校验（MySQL/PostgreSQL）
- **导航树**：连接 → 数据库 → 表/视图/函数，双击打开，右键菜单
- **对象列表**：表/视图/函数分类浏览，搜索，删除表
- **表数据网格**：分页（默认 1000 行/页）、列头排序、条件筛选、内联编辑、新增/删除行（基于主键，事务提交）
- **SQL 查询编辑器**：Monaco 语法高亮、自动补全（关键字/表名/`表.`列名）、SQL 美化、运行/运行选中（Ctrl+Enter）、多结果集、执行信息
- **查询构建器**：可视化拼装 SELECT —— 选主表、多个 JOIN（INNER/LEFT/RIGHT + ON 列选择）、字段按表分组勾选、WHERE 条件行、GROUP BY/ORDER BY/LIMIT，实时 SQL 预览，一键追加到查询编辑器
- **表设计器**：字段（类型/长度/主键/自增/默认值/注释）、索引、外键、表选项（引擎/字符集）子页；新建表生成 CREATE，修改表按 diff 生成 ALTER；保存前预览 SQL；SQLite 不支持的变更会给出警告而非误执行
- **导出向导**：表数据导出为 CSV（BOM + 自定义分隔符）/ JSON / SQL INSERT 脚本 / Excel，可选字段、分批流式写入、进度显示与取消
- **导入向导**：CSV / JSON / Excel 导入，文件预览、源列→目标列映射（按名自动匹配）、追加或清空后插入两种模式、批量参数化插入（防注入）、进度显示与取消
- **用户与权限**：工具栏「用户」进入用户列表；新建/编辑/删除用户、改密码、重命名；MySQL 管理全局权限（按 diff 生成 GRANT/REVOKE），PostgreSQL 管理角色属性（LOGIN/SUPERUSER/CREATEDB 等），SQL Server 管理登录名与固定服务器角色（sysadmin/dbcreator 等）
- **备份**：整库或选表转储为自包含 SQL 文件（DDL + 批量 INSERT，可选 DROP 语句与数据）；MySQL 用 SHOW CREATE、PG 从元数据组装且外键后置、SQLite 取 sqlite_master；外键检查关闭语句包裹
- **还原 / 运行 SQL 文件**：语句级拆分执行（正确跳过字符串/注释内的分号）、进度显示、可选"遇错继续"并汇总失败语句
- **ER 图**：表实体卡片（字段 + 主键🔑/外键🔗标记）+ 外键关系连线（标注列映射），dagre 自动布局，支持节点拖拽、缩放、小地图；并发读取元数据带进度，大库（>60 表）需确认再加载
- **结构同步**：选源库/目标库（同类型数据库）→ 并发比对所有表 → 差异清单（新建/修改/删除三类，可展开看 SQL）→ 勾选后确认部署；"删除目标多余表"默认不勾选，部署失败语句逐条汇总
- **数据传输**：跨连接复制表结构+数据，**支持异构**（MySQL↔PostgreSQL↔SQLite↔SQL Server，自动类型映射：varchar↔character varying↔nvarchar、datetime↔timestamp↔datetime2、tinyint(1)↔boolean↔bit、blob↔bytea↔varbinary(max) 等）；可选 DROP 重建/索引/外键（后置执行）/插入前清空/遇错继续；分批流式传输带实时进度
- **数据同步**：同类型库间按主键行级比对（宽松值比较抹平 1/"1.00" 等驱动表示差异），差异分插入/更新/删除三类按表汇总，可勾选表与操作类型后部署（删除默认关闭）；无主键/目标缺表/超 20 万行的表自动跳过并说明原因；比对结果缓存在主进程，部署后自动重新比对验证
- **主题**：浅色/深色切换

## 开发

```bash
npm install        # 若 Electron 二进制下载失败：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
npm run dev        # 开发模式（热更新）
npm run typecheck  # 类型检查
npm run package:win  # 打包 Windows 安装包（产物在 release/SkySQL-Setup-*.exe）
npm run package:mac  # 打包 macOS dmg（需在 macOS 上执行）
```

> 国内网络打包前先设置镜像：
> `$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"`
> 其他注意事项见 CLAUDE.md「打包注意事项」。

## 架构

```
src/
  shared/        # 主进程与渲染进程共享的类型与 IPC 契约
    types.ts     # ConnectionProfile / QueryResultSet / TableDataRequest ...
    ipc.ts       # IPC 通道名 + SkySqlApi 接口定义
  main/          # Electron 主进程
    index.ts             # 窗口创建
    profileStore.ts      # 连接配置持久化（密码 safeStorage 加密）
    ipcHandlers.ts       # IPC 处理器（统一错误包装）
    db/
      driver.ts          # DatabaseDriver 统一接口 + 公共工具
      registry.ts        # dbType -> 驱动实现 的注册表
      connectionManager.ts
      drivers/           # mysql.ts / postgres.ts / sqlite.ts / sqlserver.ts
  preload/       # contextBridge 暴露 window.skysql
  renderer/      # React UI
    src/
      stores/appStore.ts   # zustand 全局状态（连接、标签页、主题）
      components/
        MainToolbar.tsx    # Navicat 风格大图标工具栏
        ConnectionTree.tsx # 左侧导航树
        ConnectionDialog.tsx
        DataGridView.tsx   # glide-data-grid 封装（编辑/排序/行标记）
        tabs/              # ObjectsTab / TableDataTab / QueryTab
```

**新增数据库类型**：实现 `DatabaseDriver` 接口，在 `registry.ts` 注册，再把类型加入 `shared/types.ts` 的 `DbType` 即可。

## 路线图（对照 docs/navicat-research.md）

- [x] 第一梯队：连接管理 / 导航树 / 数据网格 / SQL 编辑器 / 暗色主题
- [x] 表设计器（字段/索引/外键/选项/SQL 预览，CREATE 与 ALTER diff 生成，三方言适配）
- [x] 导入导出向导（导出 CSV/JSON/SQL/Excel；导入 CSV/JSON/Excel，字段映射 + 追加/复制模式 + 进度）
- [x] SSH 隧道（密码/私钥认证，本地端口转发）/ SSL 证书配置（CA、客户端证书/密钥、服务器证书校验）
- [x] 用户与权限管理（MySQL 用户 + 全局权限 GRANT/REVOKE diff；PG 角色属性；改密码/重命名/删除）
- [x] 备份/还原（整库/选表转储为自包含 SQL 文件；运行 SQL 文件还原，带进度与遇错继续）
- [x] 结构同步（双库表结构比对 → CREATE/ALTER/DROP 差异清单 → 勾选部署，复用 DDL diff 生成器）
- [x] 数据传输（跨连接复制表结构+数据，支持 MySQL↔PG↔SQLite 异构传输与类型映射）
- [x] 数据同步（按主键行级 diff，插入/更新/删除分类部署）
- [x] ER 图查看（对象页「列表 / ER 图」切换，外键关系连线 + 自动布局 + 拖拽/缩放/小地图）
- [x] 查询构建器（主表/JOIN/字段勾选/WHERE/GROUP BY/ORDER BY/LIMIT 可视化，生成 SQL 进编辑器）
- [ ] 模型设计器（正向建模）
- [x] Windows 打包（NSIS 安装包，可选安装目录 + 桌面快捷方式 + 应用图标）
- [x] SQL Server 驱动（连接/浏览/数据网格/查询/设计器/导入导出/备份/同步/传输/用户全功能接入）
- [ ] Oracle / MongoDB / Redis 驱动
