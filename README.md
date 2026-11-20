# deep-dreaming

> **目标平台**: DSH **桌面端**(Electron,`@deepseek-ai/dsh-desktop`),当前适配 **`0.2.2-rc.5`**
> (profile:`~/.dsh/profiles/desktop`;宿主:打包运行时 `resources/app.asar/dsh`;宿主端口由桌面端动态分配)
> Web 端(`dsh web`)已**不再维护**,其生命周期脚本归档在 [`archive/`](archive/README.md)

个人 dsh(DeepSeek Harness)用户级补丁集。所有补丁都通过 `~/.dsh` 的
补丁层 / 插件机制装载,**不修改 dsh 源码**;本仓库是各补丁的实现来源与
文档所在。

## 目录结构

```
deep-dreaming/
├── README.md                     # 本文件:总览 + 补丁清单
├── package.json                  # 仅测试用依赖(react / react-dom / jsdom),npm install 后 npm test
├── patches/                      # 全部补丁,一补丁一目录(代码 + 测试 + README)
│   ├── session-cleanup/          # 已归档会话的手动物理删除(目录包插件)
│   ├── queue-reorder/            # 排队消息拖拽排序(装饰官方队列坞,不遮蔽它)
│   ├── temp-session/             # 「新会话」按钮下方的临时会话快捷入口，一键发起不绑定项目的临时会话 + verify
│   ├── todo-board/               # 跨项目的待办/已办/功能分支清单(JSON 为准 + Markdown 镜像)
│   ├── discussion-plaza/         # 跨工作区交流广场(每个讨论组一份 Markdown + 租约写锁 + 关组确认)
│   └── whale-background/         # 会话区域鲸鱼娘背景图(bundle 补丁)
├── assets/                       # 品牌资产(鲸鱼娘 favicon;不归任何补丁,由 deploy.ps1 同步到 ~/.dsh/assets)
├── archive/                      # 已退役的脚本 / 资产 / 补丁(只读保留,不再部署)
├── scripts/
│   ├── install.ps1               # 一键安装:建 junction 兜底(含 @local 自引用)+ 6 个 bundle 补丁全部装成 bundle(先剥遗留行) + 退役登记清理 + 部署校验(幂等)
│   ├── deploy.ps1                # 只读校验:同步脚本与资产 + bundle 登记/行属主 + junction + 体检宿主依赖仓库
│   ├── start-desktop.ps1         # 启动桌面端(已在运行则聚焦窗口)
│   ├── restart-desktop.ps1       # 重启桌面端(改补丁源码后必须;需 -Force)
│   ├── desktop-install.mjs       # 发现桌面端安装 + 体检共享依赖仓库(解析 + 版本一致性,只读,含单元测试)
│   ├── migrate-icon-names.mjs    # 把 `…Outline16/14` 图标名迁移到 0.2.0-rc.2 的 `…OutlineRegular/Medium`
│   ├── migrate-mnemon-to-mneme.mjs # 把 dsh-mnemon 各工作区图谱转换成 dsh-mneme 单库(幂等、可回滚、支持 --dry-run)
│   ├── migrate-mnemon-to-mneme.test.mjs # 上面的类型映射/标题剥离/幂等键等纯逻辑测试
│   ├── verify-plugin-meta.mjs    # 复刻官方 readPluginMeta,证明「设置 → 内置插件」会显示我们的标题/描述
│   ├── verify-bundle-rows.mjs    # 校验每个补丁的 dsh.bundle 声明与包内 cordis.patch.yml 行结构
│   ├── run-tests.mjs             # 跑完整个测试矩阵(npm test)
│   └── test-deps.mjs             # 验证脚本的 react / jsdom 解析(仓库 node_modules → NODE_PATH → profile)
└── .dsh-memory/                  # LEGACY 记忆笔记(旧实现产物,已导出到参考图谱与各记忆后端),gitignored
```

## 补丁清单

| 补丁 | 作用 | 部署方式 | 使用文档 |
| --- | --- | --- | --- |
| [session-cleanup](patches/session-cleanup/) | 手动删除已归档会话(设置页列表 + 会话右键菜单,二次确认,不自动清理) | **bundle**:包内 `cordis.patch.yml` 行 + `install.ps1` pnpm link 进 profile 并登记 `dsh.profile.bundles` | [README](patches/session-cleanup/README.md) |
| [queue-reorder](patches/queue-reorder/) | **排队消息拖拽排序**。官方队列坞（QueueDock）没有任何更改顺序的方式——`QueueAction` 只有 `edit`/`remove`/`steer`。本补丁在官方坞的行上加拖拽，落点经宿主 `/queue-reorder/reorder` 走标准 inbox splice，顺序由 `agent/inbox/spliced` 事件广播。**装饰而非接管**：官方坞照常渲染（编辑/steer/附件/折叠都是官方的），插件注册独立 slot id，官方升级不用跟 | **bundle**:包内 `cordis.patch.yml` 行 + pnpm link + `dsh.profile.bundles` | [README](patches/queue-reorder/README.md) |
| [temp-session](patches/temp-session/) | 侧边栏「新会话」按钮下方的「临时会话」行:一键发起绑定**用户级临时目录**的会话,不关联任何项目 | **bundle**:包内 `cordis.patch.yml` 行 + pnpm link + `dsh.profile.bundles` | [README](patches/temp-session/README.md) |
| [whale-background](patches/whale-background/) | 会话区域背景:在对话滚动区居中偏右显示鲸鱼娘透明图(13% 透明度),资源缺失时自动跳过而不影响启动 | **bundle**:包内 `cordis.patch.yml` 行 + pnpm link + `dsh.profile.bundles` | [README](patches/whale-background/README.md) |
| [todo-board](patches/todo-board/) | **跨项目的待办 / 已办 / 功能分支清单**。`taikoo-saas` 那套 `TODO.md` / `DONE.md` / `功能分支整理.md` 的局限是文件属于一个仓库,换工作区就看不见;本补丁把清单搬到 `$DSH_HOME/todo-board/board.json`(所有工作区共享)再按原格式生成三份 Markdown 镜像。五个入口:7 个模型工具(`workboard_list`/`workboard_add`/`workboard_update`/`workboard_complete`/`workboard_archive`/`workboard_import`/`workboard_export`,项目默认取会话工作目录名)、`/workboard` 斜杠命令(新增/列出/完成/删除/导入/导出,不进模型)、左侧边栏导航行「工作清单」(点开占用中列整页)、系统提示词小结、整页右侧的单条详情栏(平台 `MarkdownText` 渲染,与镜像同源;可拖拽调宽并记住宽度) | **bundle**:包内 `cordis.patch.yml` 行 + pnpm link + `dsh.profile.bundles` | [README](patches/todo-board/README.md) |
| [discussion-plaza](patches/discussion-plaza/) | **跨工作区交流广场**。讨论组是一份 Markdown 文档(`$DSH_HOME/discussion-plaza/groups/<id>.md`,所有工作区共享,id 形如 `dg_xxxxx_yyyyyy`),参与者标识是**工作区/sessionId**(`key` 字段落盘),每个组带**租约写锁**(写入中状态、fencing token、跨进程锁文件)与关闭状态机(讨论中 → 关闭确认中 → 全员确认后已关闭且只读);人类可把组标记为**长期讨论组**(置顶、Agent 不能关,只能由人在面板结束)。三个入口:11 个 `plaza_*` 模型工具(发言里 `@工作区` 或 `wake` 参数**点名唤醒**空闲会话,忙碌/未加载不硬打扰)、`agent/pre-step` 未读与待确认通知、左下角「交流广场」按钮(角标显示**进行中的讨论组数**,中列整页含列表/详情/参与者投票/写锁持有者,人类可新建组/长期标记/解除写锁/移出失联参与者) | **bundle**:包内 `cordis.patch.yml` 行 + pnpm link + `dsh.profile.bundles` | [README](patches/discussion-plaza/README.md) |

> **MCP 服务管理已移交社区插件**（2026-11-13）：本仓库的 `mcp-servers` 补丁已退役归档到
> [`archive/patches/mcp-servers`](archive/patches/mcp-servers/)，由社区插件
> **`dsh-mcp-panel`**（设置 → 插件 → MCP，`/mcp` 命令）接管。那套实现用的是**官方行词汇**
> ——每个服务一条 `@deepseek-ai/dsh-mcp-client` 行——所以现有服务已按该形态迁移进
> profile 层 `cordis.patch.yml` 的 `- insert:` 列表（`mcp-idea` / `mcp-dbx` / `mcp-api_fox` /
> `mcp-data_mock`），不为任何一个服务保留插件私有的 `servers` 数组。

> **跨会话记忆已移交社区插件**（2026-11-16）：本仓库的 `dsh-project-memory` 补丁已退役归档到
> [`archive/patches/dsh-project-memory`](archive/patches/dsh-project-memory/)，当时由社区插件
> **`dsh-mnemon`**（0.5.46，Mnemon Native Provider + 全局 `mnemon` CLI）接管。那个桥补丁本身
> 不存任何数据，只注入一段提示词引导和一条会话开始时的召回提示；`dsh-mnemon` 自己拥有这整片
> 表面（routing 引导、三层召回、自己的工具集、Memory Space），保留它只会让第二个后端同时挂上
> 提示词。原 MCP Reference Memory 图谱已迁进按工作区划分的 Memory Space
> （`~/.mnemon/workspaces/<sha256(realpath 工作区)>/data/default/mnemon.db`）。
> home 层那条 `reference_memory` MCP 行与图谱文件保留作兜底，不再由脚本安装。
>
> **2026-11-17 再往前一步**：那批按工作区的图谱已迁移进 **`@modusensus/dsh-mneme`**（单库
> `~/.dsh/memory/memory.db`，10 工作区 / 279 行），`dsh-mnemon` 插件与全局 `mnemon` CLI 已**整体
> 卸载**。`~/.mnemon` 与 `~/.mnemon.backup-20261116` **原样留在磁盘上**，是这次导入的回滚副本，
> 运行时不读它们；迁移脚本与撤销方式见文末
> [§ 记忆迁移 dsh-mnemon → @modusensus/dsh-mneme](#记忆迁移-dsh-mnemon--modusensusdsh-mneme2026-11-17)。

## 快速部署

**推荐一条命令**(任何机器克隆后即可,路径自动推导,无需改动):

```powershell
# 在仓库根目录执行:建 junction 兜底(含 @local 自引用)+ 把 6 个 bundle 补丁全部装成 bundle
# (pnpm link + 登记 dsh.profile.bundles,先剥离 profile 层遗留行)
# + 部署校验(幂等,可重复运行)
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
# 一般无需重启:profile manifest 与用户层都会热应用(几秒内)。
# 若插件页卡片或某条 host 路由缺失,再重启(会结束当前会话):
powershell -ExecutionPolicy Bypass -File .\scripts\restart-desktop.ps1 -Force
```

`install.ps1` 还会:剥离 profile 层遗留的 `- insert:` 行(bundle 装失败时原样恢复该行,保证补丁始终有属主)、执行 `$renamedBundles` 里的**退役登记**(清掉旧包名的 profile 依赖、`dsh.profile.bundles` 条目与遗留 junction),并用桌面端自带的 CLI(`resources\runtime\cli\bin\dsh.cmd plugin --profile desktop add`)装 bundle。所有脚本读写配置文件都走显式 UTF-8(Windows PowerShell 5.1 的 `Get-Content`/`Set-Content` 默认按 ANSI 解码,会把中文注释写成乱码)。

> 跨会话记忆**不再由本仓库安装**:`dsh-mnemon` 接管后,脚本只会**提示**home 层还留着一条
> `reference_memory` MCP 行(作兜底),不再安装 `@modelcontextprotocol/server-memory`、
> 也不再写那条行。

动手前它会**只读体检**「共享宿主依赖仓库」`~/.dsh/profiles/node_modules`,并报告桌面端安装与版本——补丁的宿主端 `import '@deepseek-ai/*'` 只能在这里被解析,仓库坏掉时补丁会以 `MODULE_NOT_FOUND` 装不上。

手工方式(路径用变量,不写死):

```powershell
$repo = (Resolve-Path .).Path          # 在仓库根执行;其它位置请指向克隆目录

# 1. 全部补丁都是 bundle:包内自带 cordis.patch.yml 行,install.ps1 负责
#    pnpm link 进 profile + 登记 dsh.profile.bundles(下面的 junction 只是解析兜底)
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-plugin-session-cleanup" -Target "$repo\patches\session-cleanup"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-temp-session" -Target "$repo\patches\temp-session"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-whale-background" -Target "$repo\patches\whale-background"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-todo-board" -Target "$repo\patches\todo-board"

# 2. 逐个装成 bundle:用桌面端自带 CLI(包声明了 dsh.bundle,CLI 自动登记 dsh.profile.bundles)
#    装之前先删掉 profile 层同 id 的 - insert: 行,否则两层同 id 会让启动 fail-loud
$cli = "D:\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $cli plugin --profile desktop add "$repo\patches\session-cleanup"
& $cli plugin --profile desktop add "$repo\patches\temp-session"
& $cli plugin --profile desktop add "$repo\patches\whale-background"
& $cli plugin --profile desktop add "$repo\patches\queue-reorder"
& $cli plugin --profile desktop add "$repo\patches\todo-board"
# (bundle 层变更由 HMR 热应用;若卡片/路由缺失再重启桌面端)

# 2.5 跨会话记忆:现由 @modusensus/dsh-mneme 承载(dsh-mnemon 已于 2026-11-17 整体卸载)
#     dsh plugin --profile desktop add @modusensus/dsh-mneme
#     库落在 ~/.dsh/memory/memory.db + 十个 md 镜像;面板「记忆库」可浏览
#     若还有旧的 ~/.mnemon 图谱要搬进来(幂等,先干跑):
#     node scripts/migrate-mnemon-to-mneme.mjs --dry-run   (详见文末迁移小节)

# 3. 部署校验(可随时运行,只读):核对 patch 层引用与 junction、
#    体检共享依赖仓库,并把桌面端生命周期脚本同步到 ~/.dsh/scripts/
powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
```

> 仓库内**不写死任何绝对路径**:所有脚本基于 `$PSScriptRoot` 推导,补丁
> 代码基于 `import.meta.url` / `%USERPROFILE%` 解析;克隆到任何位置、
> 任何用户名下均可直接使用(`install.ps1` / `deploy.ps1` 自动跟随)。

## 部署不变量(必读)

- **一个 loader 行只能有一个来源。** 每个补丁都声明了 `dsh.bundle`,它的行由 bundle 层(包自带 `cordis.patch.yml`)提供;profile 层**不能**再写同 id 的 `- insert:` 行。两层若同时提供同一个 id,`applyEntryPatches` 不会去重,Loader 会 fail-loud 抛 `TypeError: duplicate loader entry id`,dsh 直接起不来。`install.ps1` 会**先**剥离 profile 遗留行再装 bundle(若 bundle 安装失败则把该行原样恢复回去);`deploy.ps1` 检测到「bundle 已声明但未登记」或「profile 层插入了已在 `dsh.profile.bundles` 里的名字」都会报 FAIL。
  注意 `dsh plugin add` / `dsh plugin update --profile desktop` 会自行把声明了 `dsh.bundle` 的依赖补进 `dsh.profile.bundles`,所以不要"为了保险"两边都写。
- **不要在 `patches/` 下做递归扫描**:`patches/<p>/node_modules` 是指向 `~/.dsh/profiles/node_modules` 的 junction,而 profile 里的 `@local/*` 又指回 `patches/*`,形成环;`Get-ChildItem -Recurse` 之类的命令不会结束。
- **`~/.dsh/profiles/node_modules` 必须是按运行时版本物化的实目录。** 它曾经是 web 时代 npx 缓存留下的 **250 条指向 `%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules` 的软链**:一次 `npm cache clean`(或缓存 GC)就能让全部补丁同时 `MODULE_NOT_FOUND`;而且那套包比打包运行时落后一个 minor(schemastery 3.18.2 vs 3.18.4)—— 这正是「卡片在、设置表单没有」的根因,因为 `.volatile()` 在 3.18.2 里不存在(可编辑分区只收 volatile 字段)。2026-10-13 已按运行时版本重物化:临时目录里 `npm i @deepseek-ai/dsh-llm@0.2.0-rc.2 @deepseek-ai/dsh-mcp-client@0.2.0-rc.2`(cordis / schemastery 交给 npm 自己解析,**不要手抄版本号**),旧目录**移出**到 `~/.dsh/store-npx-era-<ts>`(未删除),`@local/*` 链接按快照 `~/.dsh/store-snapshot-<ts>.tsv` 恢复。
  **2026-10-18 又按 `0.2.1-rc.2` 重物化了一次**(`npm i @deepseek-ai/dsh-llm@0.2.1-rc.2 @deepseek-ai/dsh-mcp-client@0.2.1-rc.2 @deepseek-ai/dsh-session-format-catalog@0.2.1-rc.2`,最后一个供测试里的真实 v4 编码器使用),旧树保留在 `~/.dsh/store-npx-era-20261017-190810`。`deploy.ps1` 现在**既**检查任何指向 `npm-cache\_npx` 的 store 条目,**也**比对 store 里 `@deepseek-ai/dsh-llm` 与桌面端版本 —— 不一致即 FAIL(此前只检查"可解析",实测 app 0.2.1 + store 0.2.0 曾被误判为 OK)。
  **2026-10-30 再按 `0.2.1-rc.5` 物化**(桌面端在 2026-10-29 自动更新,而 store 已退回 `dsh-llm` 0.2.0-rc.2 / `cordis` 4.0.4 / `schemastery` 3.18.4,deploy 直接 FAIL):`npm i @deepseek-ai/dsh-llm@0.2.1-rc.5 @deepseek-ai/dsh-mcp-client@0.2.1-rc.5 @deepseek-ai/dsh-session-format-catalog@0.2.1-rc.5`;新树为 `cordis` 4.0.5 / `schemastery` 3.18.5 / `cosmokit` 1.8.6,旧树保留在 `~/.dsh/store-0.2.0-rc.2-20261030-105152`,快照 `~/.dsh/store-snapshot-20261030-105152.tsv`。顺带清掉了归档补丁留下的 `@local/dsh-client-ui-settings-other` 断链。
  **2026-11-19 按 `0.2.2-rc.5` 物化**(桌面端自动更新,store 还投影着 rc.3,deploy 报 `dsh-llm 0.2.2-rc.3 != 0.2.2-rc.5`):同样三步换树。新树 `@deepseek-ai/cordis` **4.1.0** / `cosmokit` **1.9.0** / `schemastery` **3.19.0**,与 `resources/app.asar/dsh/node_modules/@deepseek-ai/*` 一致;包集合与 rc.3 完全相同,换树后重建 4 个 `@local` junction。旧树保留在 `~/.dsh/store-0.2.2-rc.3-20261119-101007`,快照 `~/.dsh/store-snapshot-20261119-101007.tsv`。详见文末「0.2.2-rc.5 适配补记」。

## 故障恢复

某个用户级补丁把启动搞坏时(比如上面那条 duplicate id),把 profile 的用户层移开再重启桌面端:

```powershell
# 桌面端:把用户补丁层挪走 -> 重启 -> 只加载 bundle 层
Move-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak"
powershell -ExecutionPolicy Bypass -File .\scripts\restart-desktop.ps1 -Force
# 修好后挪回来
Move-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak" "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml"
```

> 旧的 `dsh web --clean` 逃生舱随 Web 端一起归档([`archive/web-scripts/patch-cli.ps1`](archive/web-scripts/patch-cli.ps1)):
> 它给的是 **npx 缓存**里的 CLI,而桌面端跑的是打包运行时,没有这个开关。
> 打包 CLI 仍支持 `--dump-config` / `--dump-default-config` 供排查。

**补丁装不上、报 `MODULE_NOT_FOUND` 时**先体检共享依赖仓库:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
```

它会打印 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm` 的解析结果与
`~/.dsh/profiles/node_modules` 的可用投影数。这个仓库是**补丁唯一能解析宿主包的地方**
(Node 从补丁的真实路径解析 `import '@deepseek-ai/*'`),它一旦断链,所有补丁都会装不上;
重建办法是把该 release 的 `@deepseek-ai/dsh`、`dsh-llm`、`schemastery` 装回
`~/.dsh/profiles/`,再为 `@deepseek-ai/*` 补回顶层投影(详见
[`scripts/desktop-install.mjs`](scripts/desktop-install.mjs) 顶部注释里记录的实测结论)。

## 热插拔(启停/改配置免重启)

DSH 桌面端对 profile 的 `cordis.patch.yml` 内置热加载(`watchUserPatches`,
每个长期存活的 surface 无条件启用):

- **增删插件条目、修改条目 `config` → 保存文件后数秒内事务性生效**,
  host 半与 client 半都会重新装载/卸载,**无需重启 dsh**;
- 用户层 patch 文件位置有两处,都会被监视:`~/.dsh/profiles/desktop/cordis.patch.yml`
  (profile 层)与 `~/.dsh/cordis.patch.yml`(home 层,`reference_memory` 的 MCP 行在这里)。
  实测:home 层新增 `@deepseek-ai/dsh-mcp-client` 行后,运行中的 dsh 数秒内就
  拉起了对应 MCP 子进程(参考记忆服务器的日志是
  `Knowledge Graph MCP Server running on stdio`),工具随之出现在会话里。
- 触发条件是**文件内容确有变化**:只改注释、或写回一份内容等价的文件都**不会**
  触发重挂 —— `Entry.update` 对 options 做深比较,无差异即直接返回;热重载不中断
  会话、排队消息不丢。
- ⚠️ 尽管如此,**改过 patch 文件、要用 host 侧功能之前先重启**。2026-09-18 实测:
  一次整层重挂之后,`/queue`、`/app`、`/session-cleanup`、`/temp-session`、
  `/plugin-toggle` 五个通道全部消失(表现:排队消息拖拽排序报「排序失败」,因为
  `POST /queue/reorder` 落到 404),`session-cleanup` 的 settings namespace 也一并
  从 `settings.describe()` 里消失,而补丁的客户端半仍在正常渲染 —— 界面看起来一切
  正常。当时五个 host 半都用 `ctx.connection.rpc.handle` 注册通道,而这条 API 对
  连接包之外的插件必然抛 `cannot get property "webServer" without inject`;抛错会把
  同一个 `apply` 里此前注册的每一个 effect 一起回滚(路由、定时器、设置分区全没)。
  所以「重挂丢掉 host 半」和「通道根本就没挂上」是同一个根因的两种表现,不是热加载
  本身的缺陷。现在每个 host 半统一为:自己往 `webServer` 注册一条 fenced 前缀路由,
  并且用**静态 `export const inject`** 把 `webServer` 声明成依赖(见 AGENTS.md
  「Client ↔ Host transport」),不再走连接服务的通道注册。
  - 自查:host 端读 `webServer` 的路由表最直接(应含 `/queue`、`/app` 等);浏览器侧
    发一个 `POST /<channel>/<endpoint>`(带 `content-type: application/json`)拿到
    `{ ok, ... }` JSON 信封即在册,落进 SPA 兜底(非 JSON 的 404/405)即不在册。
  - `install.ps1` 因此只在内容真的变化时才写该文件(无变化时 mtime 不变,不再触发
    无谓的整层重载)。
- **profile manifest(`package.json`)改动热应用**(2026-09-24 实测:`install.ps1`
  通过桌面 CLI 把补丁登记进 `dsh.profile.bundles` 并剥离 profile 层遗留行,
  —— 该数字是当时的实测样本;2026-10-13 起 7(新增 `mcp-servers`),2026-11-03 起 6(退役 `ui-settings-model-capabilities`),
  2026-11-13 起 5(退役 `mcp-servers`,移交给社区插件 `dsh-mcp-panel`),
  2026-11-16 起 4(退役 `dsh-project-memory`,移交给社区插件 `dsh-mnemon`;
  2026-11-17 `dsh-mnemon` 整体卸载、记忆改由 `@modusensus/dsh-mneme` 承载,计数不变
  —— 两者从来都不是本仓库的补丁),机制不变)
  运行中的宿主数秒内挂上 bundle 行,四条 host 路由全部 200,无需重启)。
- **补丁源码(仓库文件)改动不热加载**:模块级 HMR 对 `node_modules` 下的补丁不生效;
  改完源码需**重启桌面端**(`scripts/restart-desktop.ps1`,会结束当前会话,请在空闲时进行);
- **client 半源码改动会被重新下发**:client-modules 的 HMR 会让该行改用新的
  bundle rev(实测改 `patches/temp-session/lib/client.js` 后,index 的
  `__DSH_BOOT__` 里该行 rev 从批次 rev 变成独立的 `73afc512e22f`),已打开的页面
  刷新即得新代码 —— 这也是能在不重启的情况下验证客户端修复的原因。
- **包内 `cordis.patch.yml`(bundle 层文件)不在监视范围**:改它的行结构需重启
  (或触碰任一被监视文件触发重读);补丁**源码**改动同理需重启
  (`scripts/restart-desktop.ps1`,会结束当前会话,请在空闲时进行)。

## 测试

```powershell
# 仓库根执行一次,取得 react / react-dom / jsdom(浏览器半的渲染验证用)
npm install

npm test                      # 跑完下面整张矩阵
npm test -- session           # 只跑路径/名称匹配的子集
node scripts/run-tests.mjs --list
```

单跑某一个:

```powershell
# 基础设施(桌面端发现 + 共享依赖仓库体检)
node scripts/desktop-install.test.mjs                            # 单元测试,纯逻辑,不碰真实 ~/.dsh
node scripts/verify-plugin-meta.mjs                              # 展示元信息:复刻官方 readPluginMeta,证明页面会显示什么
node scripts/verify-bundle-rows.mjs                              # 每个补丁的 dsh.bundle 声明 + 包内 cordis.patch.yml 行结构
node scripts/migrate-mnemon-to-mneme.test.mjs                    # mnemon → mneme 迁移的类型映射/标题剥离/幂等键(纯逻辑)
# 每个补丁自带无依赖或低依赖测试(测试与脚本随补丁目录):
node patches/session-cleanup/session-cleanup.test.mjs            # 删除安全闸(仅已归档/非活跃/目录唯一)
node patches/session-cleanup/verify-session-cleanup.mjs          # 端点 + 设置页列表 + 右键菜单
node patches/session-cleanup/tests/load-smoke.mjs                # 真实 Cordis 加载冒烟(Invalid effect 回归)
node patches/queue-reorder/tests/load-smoke.mjs                  # 真实 Cordis + inbox splice 重排语义(含回滚)
node patches/queue-reorder/tests/client-contract.mjs             # 浏览器半契约(装饰官方行 + 拖放换算,jsdom)
node patches/queue-reorder/tests/official-dock-contract.mjs      # 官方 QueueDock 源码契约守卫(无检出时 SKIP)
node patches/temp-session/verify-temp-session.mjs                # temp-session host + client 契约 + 点击流程
node patches/todo-board/tests/core.test.mjs                      # 跨项目清单:store / markdown / import 规则
node patches/todo-board/tests/load-smoke.mjs                     # 真实 Cordis + 真实 JSON Schema 校验 + 围栏
node patches/todo-board/tests/client-contract.mjs                # 侧栏行 + 中列整页 + 页内详情栏(jsdom + 真 React)
node patches/discussion-plaza/tests/core.test.mjs                # 广场协议:文档往返 / 状态机 / 失联宽限
node patches/discussion-plaza/tests/mentions.test.mjs            # 广场点名: @工作区 / 边界 / 显式 wake
node patches/discussion-plaza/tests/store.test.mjs               # 广场存储:并发写 / 租约回收 / fencing / 关组
node patches/discussion-plaza/tests/load-smoke.mjs               # 11 个工具 schema + 路由围栏 + pre-step 通知(v4 编码)
node patches/discussion-plaza/tests/client-contract.mjs          # 左下按钮 + 整页列表/详情/新建(jsdom + 真 React)
node patches/whale-background/tests/load-smoke.mjs               # 鲸鱼娘图片路由 + 资源存在性
```

浏览器半的断言需要 react/jsdom:仓库根 `npm install` 后即可跑全;缺依赖时
各脚本自动降级为纯契约检查并打印 `SKIP`(不会假装通过)。

## 适配记录 - 历史(0.1.5-rc.2 及更早)

Web 端时期修掉的问题,以及下次升级时要先看的地方:

1. **`@deepseek-ai/dsh-client-runtime` 包已被移除**(0.1.2-alpha.1 起):
   `dsh.client.inject` 里残留该名字不会报错(该字段是**信息性**的预取排序
   提示,不是服务注入、也不做加载时序约束),但已全部换成真实包名。
2. **客户端 Workspace API 拆分**:`ctx.workspaces` 只剩纯 Controller 面
   (`create/rename/delete/insertBefore/archiveSession/insertSessionBefore`),
   `refresh()` 消失(列表由 Controller 的 follow 流维持),新建会话导航移到
   `ctx.uiWorkspace.startSession()` —— temp-session 的点击流程据此重写。
3. **profile 的 node_modules 不再有 react**:客户端 UI 已改为预构建浏览器
   bundle,React 被打进前端产物。验证脚本因此改为多锚点解析
   (`scripts/test-deps.mjs`),并由仓库根 `package.json` 提供 react/jsdom。
4. **Memorix 必须绑定项目(历史)**:dsh 全进程只有一个 MCP 实例、工作目录是
   进程 cwd(非 git 仓库),Memorix 会拒绝一切项目级工具,直到会话调用
   `memorix_session_start({ projectRoot })`;当时的召回提示带上本会话工作区
   根目录。**0.3.0 起后端改为 MCP Reference Memory**:没有绑定调用,项目隔离
   改为 `<project>/<topic>` 实体命名约定。详见该补丁 README。
   **2026-11-16 起整条记忆链改由社区插件 `dsh-mnemon` 承载**(那个桥补丁本身已归档;
   参考图谱按 `<project>` 迁成按工作区划分的 Memory Space,项目边界从命名约定变成
   物理分离的 `mnemon.db`)。**2026-11-17 再迁一次**:那批 Memory Space 已并入
   `@modusensus/dsh-mneme` 的单库多 scope,`dsh-mnemon` 与全局 `mnemon` CLI 均已卸载
   (详见文末 § 记忆迁移)。
5. **回合后的「记忆回顾」已删除**(实测噪音 + 机制限制):`agent.followup(...)`
   的官方语义是「该条目自成一整轮」,所以旧 autoReview 每轮都多开一轮只含
   Thinking + 一句「无需记录」的对话 —— 本机某 62 轮会话里有 23 轮是这么来的。
   assistant 步骤的 chat node kind 由官方渲染器固定拥有,无法像工具卡片那样
   折叠,因此不再做回顾;保存改由 guidance(以及当前记忆后端)的规约驱动
   (保存时本来就是图 2 那种 `记忆 · 保存/更新` 卡片)。
6. **会话开始召回此前是死代码**(顺带修好):旧实现挂在第一条 `user/message`
   上并用 `ctx.agents.get()` 查 agent,而 agent 是在该消息落盘**之后**才发布
   进注册表的,查询必然落空 —— 本机 8 份最大的会话日志里 **0 次召回**。现在
   改挂 `turn/start`(由拥有该轮次的 agent 发出,查得到),并用
   `agent.inject(...)`(next-step、不唤醒)投递,使召回落在用户本轮之内而不
   新开一轮。
9. **patch 文件热重载会丢"已有行"的 host 半**(实测,详见「热插拔」一节):
   `install.ps1` 的一次写入让 `/queue` 等五个通道消失(当时队列坞的拖拽排序
   因此报"排序失败",`POST /queue/reorder` → 404,而客户端半仍在正常渲染)。
   `install.ps1` 已改为内容无变化就不写文件;`ui-queue-tools` 当时还把失败
   提示改成区分"服务未加载"与"消息可能已开始发送"。
   **结论:改过 patch 文件后,先重启再用 host 侧功能。**(`/queue` 这个实例
   对应的补丁已于 2026-11-06 退役,但这条教训适用于任何 host 半。)

### 桌面端适配(0.2.0-rc.2 → 0.2.1-rc.2)

从「以 Web 端为准」转到「以桌面端为准」时踩到并修掉的:

1. **桌面端本来就没装这些补丁**:`~/.dsh/profiles/desktop` 的补丁层是空的,
   补丁的行与 junction 都在 `web` profile 里。`install.ps1` 现在默认
   `-Profile desktop`,并用桌面端自带 CLI 装 bundle。
2. **客户端图标名在 0.2.0-rc.2 全部改名**:`@deepseek-ai/dsh-client-ui-primitives`
   的导出从 `…Outline16/14` 变成 `…OutlineRegular/Medium`(笔画粗细维度,尺寸改由
   `size` prop 控制)。旧名**不会报错**,只会静默渲染出空图标 —— 全仓库 18 处
   (7 个 client 半 + 6 个验证脚本的桩)已由 `scripts/migrate-icon-names.mjs` 修好。
   升级 DSH 后重跑它(`--apply`)检查一遍。
3. **共享宿主依赖仓库必须与宿主同版本**:`~/.dsh/profiles/node_modules` 是补丁唯一能
   解析 `import '@deepseek-ai/*'` 的地方(Node 从补丁的真实路径解析)。它原本指向一个
   后来被 npm 清空的 npx 缓存(0.1.5-rc.2),导致补丁全部 `MODULE_NOT_FOUND`;
   现按桌面端 release 重建(2026-10-18 已随 **0.2.1-rc.2** 再次物化)。
   **不要试图把这个仓库指到打包运行时**:junction 指向 `app.asar` 内部时 Node 解析
   不了(实测 `readFileSync` ENOENT),物化要 236 MB,删掉投影则 import 直接失败。
4. **`dsh-project-memory` 的 peer 门槛(该补丁现已归档,留作教训)**:它当初声明
   `@deepseek-ai/dsh-llm: ^0.1.5-rc.2`,而 `^0.1.x` 不包含 `0.2.0-rc.2`,桌面端会因
   peer 不满足而**跳过该 bundle**。已改为 `^0.2.0-rc.2`(带 `includePrerelease` 的检查
   同时接受 `0.2.1-rc.2`)。**教训:补丁的 peer 范围必须跟着运行时 release 走,
   peer 不满足时宿主只是静默跳过该 bundle。**
5. **运行状态 / 重启 / 检查更新 / 创建快捷方式整体下线**:这些都以 Web 端生命周期
   为准。原 `ui-settings-other` 已改造为只读余额页
   (`ui-settings-balance`),**随后也退役了** —— 见下一条;
   重启改走 `scripts/restart-desktop.ps1`(会结束当前会话,需 `-Force`)。
6. **余额页是重复建设,已退役**:`ui-settings-balance` 只显示充值/赠金余额,而桌面端
   **自带**的「账号与余额」页(`@deepseek-ai/dsh-client-ui-settings-account`)提供同样的
   两行,还多了「更多账号信息」「查询用量」和**充值按钮**。结果是一个功能子集 + sidebar
   上两个近义入口。**教训:做 UI 补丁前先在 DSH 源码检出里 grep 一遍**
   (`packages/client/ui-*`),确认官方没做过。两者都已归档到
   [`archive/patches/`](archive/README.md)。
7. **插件管理页也是重复建设,已退役**:`ui-settings-plugin-manager` 的启停能力,官方
   `pluginManager.setPluginEnabled` 写的是**同一层、同一 YAML 形状**(`- id` + `disabled: true`);
   官方入口还有三条(侧栏「插件」页的组合包开关、agent 工具 `plugin_manager`、`dsh plugin` CLI)。
   它独有的是「整份 loader 条目清单 + 分类/启用状态/运行状态三个过滤器」,而官方那页只有搜索框。
   审计同时查出它两处真实故障:默认写死 `profiles/web`(desktop 那一行没有 config 覆盖,于是
   改的是没人监听的文件),以及把 loader `entryId`(形如 `include:<行id>`)当补丁行 id 写入,
   永不匹配却回报 `recognized: true`,页面显示「已生效」。两处都修好并有测试后,用户仍选择
   直接用官方功能,故归档。
8. **客户端图标名在 0.2.0-rc.2 全部改名**:见下节第 2 条。
9. **CLI 补丁(`--clean`)不再需要**:桌面端跑打包运行时,不是 npx 缓存。
   `archive/web-scripts/patch-cli.ps1` 保留但不再部署。

### 0.2.1-rc.2 适配补记(2026-10-18)

升级到 0.2.1-rc.2 时实际修掉/确认的:

1. **会话格式 v4 拒绝 `source.kind = 'plugin'`**:编码时抛
   `format v4 message requires a producer-owned source kind`。插件来源必须写成
   `plugin:<name>`(v3→v4 迁移器对未知插件的拼写);原 `dsh-project-memory` 的召回
   即按此改(该补丁已于 2026-11-16 归档,教训保留)。注意这在 0.2.0-rc.2 就已是 v4,
   只是当时没有测试覆盖到「真实编码器」。
2. **不能从 `session/event` 监听器里调 `agent.inject`**:事件在会话自身 append
   尚未发布完(`appending=true`)时分发,`inject` 同步触发
   `inbox.splice → session.append`,被以 `session append cannot reenter while
   another append is being published` 拒绝;旧代码吞掉异常,召回从未落盘。
   正确做法是 `agent/pre-step` 瀑布返回
   `messages: [...decision.messages, notice]`(官方 `time-context` /
   `model-selection` 同款)。
3. **0.2.x 的 `settings` 服务没有 `register()`**:`session-cleanup` 改用
   `Config` 字段 `.volatile()` + `settings.describe()` 读、`settings.update()` /
   `replace()` 写,并监听 `settings/document-updated` 重建定时器;设置卡片的
   `setConfig` 从 `settings-unavailable` 恢复为可写。
4. **store 版本校验**:`deploy.ps1` / `desktop-install.mjs` 现在比对 store 的
   `@deepseek-ai/dsh-llm` 与桌面端版本(此前 app 0.2.1 + store 0.2.0 会被判 OK)。
5. **profile 的 `llm-deepseek-account.config.models` 已不可配置**:0.2.1 报
   `models is no longer configurable`,该 entry 会不激活;该键已从
   `~/.dsh/profiles/desktop/cordis.patch.yml` 删除(备份 `.bak-20261018`)。
6. **桌面端宿主端口改为动态分配**(不再固定 19387;本次多次重启分别落在
   63920 / 54920 / 59749):脚本与文档不得硬编码端口。
7. **功能重叠处理**:`ui-queue-tools` 影子坞同步官方 0.2.1(附件、本地回显、
   continuable 子代理、工厂渲染),只保留全文 Tooltip + 拖拽排序;
   `ui-settings-model-capabilities` 在声明型路由上隐藏思考区(官方
   `ModelReasoningEfforts` 负责),保存时 `reasoningEfforts` 原样透传。
   > 两者后来都已退役(2026-11-03 / 2026-11-06),见 `archive/README.md`。

### 0.2.1-rc.5 适配补记(2026-10-30)

桌面端 2026-10-29 自动更新到 **0.2.1-rc.5**(打包运行时自报 release commit
`d4db512`)。rc.2→rc.5 共 19 个提交、667 个变更文件,但**真实源码改动只有 83 个**
(其余都是 monorepo 的 `package.json` 版本号),且 `packages/host/webserver`、
`packages/settings`、`packages/agent`、`packages/session` **源码零改动** ——
补丁依赖的宿主 API 面没有变。

改动集中在客户端(`ui-entry-customization` 新增、`ui-sidebar` /
`ui-conversation` 的 More 菜单与视图 pin、思考块渲染 `ui-chat`、tooltip、
ACP stdout)与 LLM(`llm-deepseek-api-key` 跟随官方 `/models` 列表)、
`mcp-client` 的 resources 能力探测。**没有任何补丁被官方功能取代**,也无需改代码:

1. 补丁用到的扩展位与图标在 rc.5 全部仍在:`settings.section`、
   `settings.models.provider-card`、`conversation.input.dock`、
   `sidebar.footer.action`、`tool.call.toolview`,以及 15 个
   `@deepseek-ai/dsh-client-ui-primitives` 图标导出。
2. **官方仍无**会话自动清理、临时会话、队列坞拖拽排序/全文预览,
   因此 `session-cleanup`、`temp-session` 继续互补。
   （MCP 服务设置页原本也在这一条里；2026-11-13 起该能力由社区插件
   `dsh-mcp-panel` 提供，本仓库的 `mcp-servers` 补丁已退役归档。）
   `ui-queue-tools` 当时也靠这条互补存活,但它遮蔽官方整个队列坞、只多出
   「全文预览 + 拖拽排序」两项,官方坞后续每加一项能力都会被它挡掉,
   已于 2026-11-06 退役(见 `archive/README.md`);同日以
   **`queue-reorder`** 的形态把「拖拽排序」这一项加回来——不再遮蔽官方坞,
   只往官方行上加拖拽(见下节)。
3. **rc.3 新增的 `ui-entry-customization`**(侧边栏面板/会话视图的 More 菜单:
   pin/unpin、浏览插件、创建插件)只作用于 panellist 与 view tab;
   `temp-session` 挂在 `sidebar.session.action`（新会话整行的 HOC）上，
   不是可 pin 的面板，二者不冲突。
4. **模型能力**:官方 `ModelReasoningEfforts` 仍只对手写声明(declared)的 pi-ai
   路由渲染,目录型路由没有思考入口;图片输入仍是勾选框、表达不了「继承」。
   该能力卡片已于 2026-11-03 退役(见下节),目录型路由因此没有思考入口。
5. 实测:测试矩阵 16/16(load-smoke 跑在新的 store 上:real Cordis 4.0.5 /
   schemastery 3.18.5 / `dsh-mcp-client` 0.2.1-rc.5);`deploy.ps1` PASS(stage
   34/34);运行中的宿主上 `/session-cleanup/getConfig`、`/temp-session/*`、
   `/queue/*`、`/whale-background.png` 全部 200;`GET /plugins/events` 的
   0.2.1-rc.5 客户端图里 7 个补丁 client 行齐全且各自的 `client.js` 都能下载(200)。
6. **仍需重启才生效**:运行中的宿主仍持有旧 store 载入的 `dsh-mcp-client`
   0.2.0-rc.2(补丁把它挂成每个服务一个子 fiber)。`scripts/restart-desktop.ps1 -Force`
   之后才会用上 0.2.1-rc.5 的模块。
7. `llm-deepseek-account.config.models` 在 profile 层又出现了(0.2.1 起该键会让该
   entry 在 `resolveAccountOptions` 抛 `models is no longer configurable` 而不激活;
   schemastery 会保留未知键)。已再次从
   `~/.dsh/profiles/desktop/cordis.patch.yml` 删除 —— 注意设置页面保存模型时可能把它写回。

### 0.2.2-rc.5 适配补记(2026-11-19)

桌面端自动更新到 **0.2.2-rc.5**(exe `FileVersion` 0.2.2-rc.5,打包运行时自报
release commit `3f85d88`)。rc.3→rc.5 共 **448** 个变更文件,过滤掉
`package.json` / notes / tests / docs / snapshots 后**真实源码改动只有 19 个**,
全部集中在 **web 搜索与抓取链路**:

`packages/bundle/base/cordis.patch.yml`、
`packages/client/ui-settings-web-search/src/client/{WebSearchCard.tsx,locales.ts}`、
`packages/experimental/liveshare/src/host/tunnel-worker.ts`、
`packages/extensions/tool-cordis/src/api-catalog.ts`、
`packages/llm/llm-deepseek/src/translate.ts`、`packages/llm/llm/src/error.ts`、
`packages/web/{tool-web,web-search-deepseek,web}/src/*`。

补丁依赖的宿主面**全部零改动**:`packages/host/webserver`、`packages/settings`、
`packages/client/{modules,ui-slots,ui-workspace,connection,ui-conversation,ui-sidebar,ui-settings-plugins,ui-primitives,ui-session,locale}`、
`packages/agent`、`packages/session/session`、`packages/session-format`。
`QueueDock.tsx` / `QueueDock.module.css` rc.3→rc.5 **完全未改**;
`packages/client/connection/src/rpc-host.ts` 里 `() => owner.webServer.register(route)`
那处缺陷**也仍未修** —— 自建 fenced 路由方案必须继续保留。

唯一的**行为变更**不影响本仓库:base 组合删掉了 `web` 行的
`searchProvider: deepseek-search-api`,改由 `dsh-web` 按模型 provider 路由自动选择
(DeepSeek 路由走旧版 Messages 搜索并按 token 计费,其他路由仍走 Search API)。
本机 `agent-default-model` 走 `taikoo-cgh` 网关,**不是** DeepSeek 路由,
因此仍走 DeepSeek Search API,无需迁移。`llm-deepseek/translate.ts` 新增的
`stop_reason === 'refusal'` → `CONTENT_REFUSED` 处理同样与本仓库无关。

核查动作与结论:

1. **共享依赖仓库按 rc.5 重物化**(部署不变量那条的第三次迭代):
   `npm i` 三个根包到 `@0.2.2-rc.5`,旧树保留在
   `~/.dsh/store-0.2.2-rc.3-20261119-101007`。新树 `@deepseek-ai/cordis` **4.1.0**
   (上一次是 4.0.5)、`cosmokit` **1.9.0**(1.8.6)、`schemastery` **3.19.0**(不变),
   与 `resources/app.asar/dsh/node_modules/@deepseek-ai/*` 逐字一致。
   包集合与 rc.3 的完全相同(31 个 `@deepseek-ai` entry、20 个顶层目录),
   换树后按快照 `~/.dsh/store-snapshot-20261119-101007.tsv` 重建了 4 个 `@local` junction。
2. **`deploy.ps1` PASS**:`dsh 0.2.2-rc.5`、store 31/31 可解析、
   `[OK] schemastery 3.19.0`、`[OK] dsh-llm 0.2.2-rc.5`、4 个 bundle 行属主正确、
   4 个 `patches/<p>/node_modules` junction 正常、无 npm-cache 软链、无退役残留。
3. **测试矩阵 12/12**(`npm test`,rc.5 检出下重跑一次结论不变):
   含 session-cleanup 39 项纯逻辑、verify-plugin-meta 24 项、verify-bundle-rows 19 项、
   三个 load-smoke(跑在真 Cordis 4.1.0 / schemastery 3.19.0 上)、
   queue-reorder 的 client-contract 与 official-dock-contract。
4. **运行中宿主探针(端口 59131)全绿**:`/session-cleanup/{getConfig,listArchived}`、
   `/queue-reorder/reorder`(参数校验应答)、`/temp-session/ensure`、
   `/whale-background.png` 均 200;带 `Origin: http://evil.example` 的跨站 POST
   被 fence 挡成 **403**。
   > 提醒:旧文档里的 `/session-cleanup/probeScope`、`/queue-reorder/ping`
   > 已不存在,现在会答 `unknown endpoint`;真实端点是 getConfig / setConfig /
   > resetConfig / listArchived / deleteArchived 与 reorder / ensure。
5. **客户端图 88 个 entry**,四个 `@local` 行全部在场且 `client.js` 都能下载(200),
   每行的 `inject` 依赖(connection / locale / ui-conversation / ui-sidebar /
   ui-workspace / ui-settings-plugins / api-workspace-controller)都能在图中找到声明方。
   社区插件同时在场:`dsh-mcp-panel` 0.6.31、`billion-context` 0.1.216、
   `dshmarket` 1.73.20、`@modusensus/dsh-mneme` 0.16.0;`dsh-read-animation` 0.1.2
   是纯 host 插件,没有 client 半属正常。
6. **结论:四个补丁无需改代码。** rc.5 的 19 个源码变更没有一个落在补丁的依赖面上。

> 排查手法备注:`GET /plugins/events` 是 SSE 长连接,`Invoke-WebRequest` 永不返回,
> 必须 `curl.exe -s -N --max-time 6`;在 `app.asar` 里搜字符串用
> `findstr /C:"..." /M <asar>`(100–500ms),`Select-String` 扫整个 asar 会超时。

### queue-reorder:拖拽排序以「装饰」形态回归(2026-11-06)

`ui-queue-tools` 退役当天就发现:官方队列坞**确实没有**任何更改顺序的方式
(`QueueAction` 只有 `edit` / `remove` / `steer`,见
`packages/api/session-controller/src/types.ts:142`)。于是把「拖拽排序」这一项
单独做成新补丁 `queue-reorder`,换个形态:

1. **不遮蔽**。`ui-queue-tools` 用同 id (`queue`) + `priority: -10` 整坞接管;
   `queue-reorder` 注册的是独立 id (`queue-reorder`, `order: 30`),官方坞那一格
   完全保留 —— `list` 槽按 id 分格,同 id 才遮蔽。官方以后给这个坞加的能力
   (编辑/steer/附件/折叠,以及将来新增的)都不会被挡掉。
2. **只加拖拽**。组件渲染 `null`,每次渲染后按 `inbox['next-turn']` 的顺序给
   官方行写 `data-queue-reorder-id`,再在 document 上装一次捕获阶段的
   dragstart/dragover/drop/dragend 代理。
3. **顺序由宿主决定**。`POST /queue-reorder/reorder` 走标准 inbox splice
   (`packages/core/agent-loop/src/inbox.ts`),`agent/inbox/spliced` 事件广播给
   所有客户端,所以前端不做乐观重排。摘除前校验两个位置,插入被拒绝时把消息
   放回原处 —— 失败的拖拽不会丢消息。

**代价**:依赖官方 DOM 的三条事实(坞根 `data-queue-dock`、持久行是 `li`、
本地回显行带 `data-submission-echo`),外加「持久行顺序 = `next-turn` 减去已进
transcript 的提交」这条过滤。错位是**静默**的,所以
`patches/queue-reorder/tests/official-dock-contract.mjs` 直接读官方源码盯着
这几条(以及「官方 `QueueAction` 仍无 reorder 分支」这条本补丁存在的前提),
官方一改形状 `npm test` 先失败。该测试在没有 DSH 源码检出的机器上 SKIP。

运行中宿主实测:客户端图里 `@local/dsh-client-queue-reorder` 行在位且 `client.js`
可下载(200),`POST /queue-reorder/reorder` 对无在活 agent 的会话返回
`session-not-found`(端点真的跑起来了);官方 `ui-conversation` 行仍在,未被遮蔽。

### ui-settings-model-capabilities 退役(2026-11-03)

应要求移除「我们自己写的思考等级与多模态支持配置」,两层同时做:

1. **配置数据**:`~/.dsh/profiles/desktop/cordis.patch.yml` 里 `llm-pi-ai` 各模型的
   `reasoningEfforts`(taikoo-cgh 的 `deepseek-v4-pro`、`deepseek-v4.1-flash`)与
   `input`(xiaomi 的两个 mimo、`deepseek-v4.1-flash`)全部删除,模型回到
   「跟随继承」:思考档位由官方目录/模型行决定,图片输入不再声明。
   **副作用**:`deepseek-v4.1-flash` 不再声明 `input: [text, image]`,官方会按
   纯文本处理该模型 —— 附件与 `read_image` 会被拒;要恢复图片支持需重新声明。
2. **补丁本体**:目录移入 `archive/patches/ui-settings-model-capabilities/`,
   从 `install.ps1`、`deploy.ps1`、`run-tests.mjs`、`verify-plugin-meta.mjs`、
   `verify-bundle-rows.mjs` 摘除,并注销 profile 的依赖与 `dsh.profile.bundles`
   条目 + 两条 junction(store 的 `@local` 与 profile 各一)。热重载后
   `/plugins/events` 的客户端图里该行消失,其余 6 个补丁不受影响。

`install.ps1` 的 `$renamedBundles` 顺带推广为「改名或退役」通用机制:
`New = $null` 表示无后继包、只要 profile 还有登记就注销(`deploy.ps1` 只校验
仓库 → profile 方向,反方向只有这里兜底);注销 junction 改用 `cmd /c rmdir`
—— `Remove-Item -Recurse` 会走进 junction 目标。

### dsh-project-memory 退役、记忆移交 dsh-mnemon(2026-11-16)

跨会话记忆整体换后端:本仓库的桥补丁移入
[`archive/patches/dsh-project-memory/`](archive/patches/dsh-project-memory/),
由社区插件 **`dsh-mnemon`**(0.5.46)接管。两件事同时发生:

1. **数据迁移**。原 MCP Reference Memory 图谱(240 实体 / 39 关系 / 2894 条
   observation)按 `<project>/` 前缀拆成 **8 个工作区各自的 Memory Space**,合计
   **266 条 insight**,导入 `errors` 全 0。库落在
   `~/.mnemon/workspaces/<sha256(realpath 工作区)>/data/default/mnemon.db`
   (`storageScope: workspaces`)。完整性对数:observation 合计 829542 字节,
   draft 合计 841929 字节,差值是 `[topic] ` 前缀与分隔符开销,内容无丢失。
   **已知损失**:分库后 mnemon 的边不能跨 db,原图谱 39 条关系里有 **4 条跨项目边**
   丢失(`weinee ↔ taikoo-saas` 两条、`idaas ↔ alibaba-cloud-idaas` 两条),
   落库后剩 35 条。
2. **补丁退役**。`$renamedBundles` 新增 `Old='dsh-project-memory'` /
   `RowId='project-memory'` / `New=$null`;`$bundlePatchDirs` 与 `$depPlugins`
   摘掉该目录;`run-tests.mjs` 去掉两条冒烟;`package.json` 去掉
   `migrate:memory`;两个只往参考图谱写数的迁移脚本
   (`migrate-dsh-memory.mjs` / `migrate-memorix-to-reference.mjs`)一并移入
   `archive/scripts/`。

`deploy.ps1` 的记忆检查随之从 **FAIL 降级为 INFO**:home 层那条
`reference_memory` MCP 行如今只是**兜底**(不再有补丁依赖它),`install.ps1` 也
不再安装 `@modelcontextprotocol/server-memory`、不再写那条行——只提示它还在,
以及想彻底清掉时的三条命令。这样迁移前的原图仍是唯一副本时不会被脚本顺手删掉。

> **一条 dsh-mnemon 特有的坑(归档时实测)**:Memory Space 是在会话中途建的,
> 而本轮 View 早在建空间**之前**就组装并缓存了(`ComposerMemoryTurnManager`
> 按 turn id 缓存),当时 `active` 为空 → `facts()` 的 `routeIds` 里没有 `recall`,
> 于是 `mnemon_recall` 报 `Source Route is not offered by the current View`,
> 而 `mnemon_remember` 照常可写(它只要求 `providerReady`)。**开新的一段对话**
> 即可,View 会按当前的 active 空间重建。

### 记忆迁移 dsh-mnemon → @modusensus/dsh-mneme(2026-11-17)

跨会话记忆的第二段迁移:从 `dsh-mnemon`(每个工作区一个 SQLite 图谱)搬到
`@modusensus/dsh-mneme`(**单库多 scope**)。两边 schema 毫无关系,mnemon 的行
没有 `title`/`type`,边是 insight-id → insight-id,所以**不能拷文件**,只能转换
后走 mneme 的写库面。转换器与测试:

```powershell
node scripts/migrate-mnemon-to-mneme.mjs --dry-run     # 先看要迁什么(默认不写)
node scripts/migrate-mnemon-to-mneme.mjs               # 真跑(先自动备份 memory.db)
node scripts/migrate-mnemon-to-mneme.mjs --only deep-dreaming
```

实测结果(本机,2026-11-17 真跑):**10 个工作区 / 279 行** = 269 条 insight + 10 篇
document,类型分布 `pitfall×112 history×62 project×60 decision×21 pattern×16
constraint×8`;其中 112 条 pitfall + 8 条 constraint 共 **120 行受编码门控**。
第二次真跑 `inserted: 0 / skipped: 279`(幂等成立),镜像十个 md 由
`service.recoverMirror()` 当场重建,质量闸没有归档任何一行。跑前在副本库上量到的是
278 行(9 篇 document)——真跑前 deep-dreaming 又多了一篇 document,所以真跑比副本
多 1 行,不是数字漂移。有行的 share 包 **9 个**(`vip-point-exception-management`
只有空包号、没有行),库总计 310 行 = 279 导入 + 31 自有。

几个只能这么做、不能更省事的点:

1. **写库面选 `store.save()` 而不是插件自带的 HTTP 面。**
   `/api/dsh-mneme/create` 把 `source` 硬编码成 `panel` 且**拒收 scope /
   occurred_at**;standalone 的 `POST /memories` 默认关闭(`externalApiEnabled:
   false`,本机 8790 端口没开);`/api/dsh-mneme/import` 只吃镜像形态的
   Markdown、按标题合并,既无 scope 也无 per-row 幂等键。`store.save()` 除了
   `created_at`/`updated_at`/`content_hash`(store 自己铸)之外,导入关心的列全都收。
   → 源库里原有的 `created_at` 落到 **`occurred_at`**,注入块打印的就是它。
2. **读 mnemon 的库必须用裸 `DatabaseSync(..., { readOnly: true })`。**
   用 mneme 的 `createStore()` 去开 `mnemon.db`,open 阶段会跑 mneme 的 schema
   migrations,**在源库里建出十张外来表**。测试里用正则断言守住了这一条。
3. **工作区发现不能只信 `~/.dsh/storages/workspace.json`。**
   `taikoo-sitewalk-one`(12 条)与 `alibaba-cloud-idaas`(2 条)有数据但不在注册表里,
   只按注册表发现会**静默漏掉 14 条**。现在的做法是注册表路径 + 每个路径的父目录
   同级扫描,再用 `realpathSync.native` + sha256 比对 `~/.mnemon/workspaces/<hash>`;
   没被认领的桶会在报告里逐个列出并警告,不会悄悄丢。
4. **类型映射决定「导入后看不看得见」。** mneme 的 `CODING_MEMORY_TYPES`
   (`pitfall` / `constraint` / `rejected_solution`)在**非编码任务里被 `codingGate`
   直接滤掉**,所以 120 行(全部 pitfall/constraint)只在编码类提问中出现。映射优先用
   mnemon 的 `tags[1]`(问题-方案 / 变更 / 原理 / 坑 / 决策……),category 只兜底。
5. **`workspace_scope` 默认写 `explicit`,但隔离还要配合 `strictScope`。**
   实测 `injectCandidates`:`strictScope=false` 时,任何工作区的会话都能把 10 条
   注入位全被导入行占满;`strictScope=true` + `explicit` 后 deep-dreaming 的会话只
   看到 deep-dreaming 的 10 条,taikoo-saas 只看自己的,**未标注工作区的会话拿到 0 条**
   (fail-closed)。报告里会把这段影响打印出来,不让人以为 `explicit` 自带隔离。
6. **7154 条边明确丢弃。** mneme 的 `entity_relations` 端点要求**实体名**,
   而且 `saveAttr` 是快照语义(同一 entity+attr_key 再写会失效前一行),没有忠实
   译法。宁可不管,也不把它伪装成 tags 塞进去。
7. **幂等键复用了 share 包的两列。** `share_external_id =
   mnemon:<hash12>:<kind>:<sourceId>` 做 per-row 去重,`share_pack_id =
   shortHash(workspacePath)` 做整包撤销(`store.deleteBySharePackId`,面板的撤销
   按钮也认这一列)。这两列在 store 里只是普通寻址键,没有别处假设它们等于
   `source === "imported"`。

> 迁移**只写 `~/.dsh/memory/memory.db`**,mnemon 的库**保持只读**、原样保留。
> 想撤销:`store.deleteBySharePackId(<某工作区的 packId>)` 逐工作区删干净。

**迁移之后的收尾(2026-11-17 当天完成)。** 数据到位、并且确认 mneme 侧无恙(311 行 /
`mirror_state` 干净 / 8 个镜像文件齐全 / `/api/dsh-mneme/health` 的 `active_rows` 与
`archived_rows` 对得上)之后,`dsh-mnemon` 被整体下线,分三步:

1. **先 disable 验证,再卸载。** profile 层 `- id: mnemon` 上加 `disabled: true`(一行 + 注释)
   就能卸掉整个 `mnemon-bundle` 组,因为 bundle 自己的 `cordis.patch.yml` 用一个 `!!js`
   表达式读这一行的 flag。判据必须是 A/B:`POST /dsh-mnemon-view/list` 在启用时返回
   **401**(路由存在、要 token),禁用后变 **405**(落 SPA fallback),同时
   `POST /session-cleanup/probeScope` 保持 **200** 作活体对照 —— 因为 mnemon 的 HTTP 面
   注册在**动态** `ctx.inject(["connection","webServer"], …)` 门控里,只看 404/405 会误判。
   profile 层的 yml 改动 **~10–12 秒热重载**,不用重启。
2. **`dsh plugin remove dsh-mnemon` 会留下 profile 层的主行。** 它把 `package.json` /
   `pnpm-lock.yaml` / `node_modules` / `dsh.profile.bundles` 都清对了,连两条
   `mnemon-strategy-*` 行也一起删了,却把 `- id: mnemon`(75 行:id、name 和整段 `config:`)
   留了下来。这行指向一个已不存在的包,只是因为先前的 `disabled: true` 才没让启动报错;
   `config.memoryView.entries` 里的两个 `include:mnemon-strategy-*` 引用此时已经悬空。
   **删它必须按 `- id: <name>` 锚定行范围**,不要用整文件正则
   (`-replace '(?m)^  disabled: false$'` 曾把两条无关的 strategy 行一起改掉)。
3. **全局 CLI 单独卸。** `npm uninstall -g @mnemon-dev/mnemon` 会带走 `@mnemon-dev/mnemon`
   和它依赖的 2 个包,以及 `D:\Environment\nodejs` 下的 `mnemon`/`mnemon.cmd`/`mnemon.ps1`
   三个 shim;剩下的空 scope 目录 `@mnemon-dev` 要手动删。

**只有数据保留。** `~/.mnemon`(11 个工作区桶 / 9 个 `mnemon.db` / 7.2 MB)在
`2026-11-17 18:29:35` 之后冻结不动,和 `~/.mnemon.backup-20261116` 一起作为这次导入的
回滚副本;运行时不读它们,要读就用裸 `DatabaseSync(..., { readOnly: true })`。**不要删**
——那是 mnemon 那一侧唯一还存在的原始数据。

### 本轮部署状态(2026-09-18,Web 端)

> 这一节记录的是 Web 端时期的实测结果,保留作为对照。桌面端的当前状态见上一节。

已生效、无需重启(在运行中的 dsh 上实测):

- 7 个补丁的 client 行都在 index 的 `__DSH_BOOT__` 组合里(含重新接线的
  whale-background);`/whale-background.png` 返回 200 + PNG;
- 改过的 temp-session 客户端 bundle 已按新 rev 下发;
- (历史,当时后端是 Memorix)Memorix 已装(1.9.4)并按
  `memorix setup --agent dsh --global` 接线,`memorix serve` 已由运行中的 dsh
  拉起,`mcp__memorix__*` 工具可见可用;0.3.0 起改为 MCP Reference Memory,
  2026-11-16 起改为社区插件 dsh-mnemon,2026-11-17 起改为 @modusensus/dsh-mneme
  (dsh-mnemon 已卸载);
- 旧笔记已迁移:`archive/scripts/migrate-dsh-memory.mjs`(该脚本随参考图谱一起
  归档)导入 `.dsh-memory/` 的 10 篇(3 篇新建、7 篇命中同名记录被跳过),旧目录保留未删。

需要**重启**才生效(Web 端当时是 `restart-dsh.ps1`,桌面端现在是
`scripts/restart-desktop.ps1 -Force`):

- host 半源码改动 —— 例如当时 `patches/dsh-project-memory/lib/index.js` 的
  guidance 段落、第一轮召回与**移除 autoReview**(该补丁已归档);
- 已有补丁行的 host 半(`/queue`、`/app`、`/session-cleanup`、`/temp-session`、
  `/plugin-toggle`):它们在 21:00 的那次 patch 文件写入后就没再注册,重启后才回来;
- `package.json` 里的 `dsh.client.inject` 元数据(启动时缓存的扫描结果)。
