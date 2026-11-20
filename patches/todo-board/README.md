# todo-board —— 跨项目的待办 / 已办 / 功能分支清单

把「待办事项」从**单个仓库的文件**变成**跨项目共享的一份清单**：

```
~/.dsh/todo-board/board.json        ← 唯一真相（所有工作区共享）
~/.dsh/todo-board/TODO.md           ← 生成物：待办镜像
~/.dsh/todo-board/DONE.md           ← 生成物：已办镜像
~/.dsh/todo-board/功能分支整理.md    ← 生成物：功能分支镜像
```

`taikoo-saas` 那套用 `TODO.md` / `DONE.md` / `zky_doc/功能分支整理.md` 维护待办与
已办的方式很好，但有个天生的局限：**文件属于一个仓库**，换一个工作区就看不见，
更没法在一个清单里同时看几个项目的进度。本插件把清单抬到 `$DSH_HOME` 下，
再按原格式生成三份 Markdown 镜像——既能跨项目查，又保留原来的读法（编辑器、
Git、`grep` 全都还能用，镜像就是普通 Markdown 文件）。

- 插件类型：**bundle**（包名 `@local/dsh-todo-board`），loader 行由包内
  `cordis.patch.yml` 自带。
- **JSON 为准，Markdown 是镜像**。每次写动作都会重写三份镜像；手改镜像**不会**
  回写 JSON（镜像里没有 id，人工编辑无法可靠归属）。要从已有 Markdown 迁进来，
  用 `workboard_import`（按 `kind + project + title` 幂等）。
- 三个入口共用同一份数据：模型工具（主入口）、左侧边栏面板、系统提示词小结。

## 五个入口

### 1. 模型工具（主入口）

7 个工具，任何工作区的会话都能用——这就是"跨工作区读写"的落点：

| 工具 | 用途 |
|------|------|
| `workboard_list` | 按 `kind` / `project` / `status` / `module` / **序号（`#N`）** / `query` 过滤查询 |
| `workboard_add` | 新增一条（项目默认取**当前会话工作目录名**） |
| `workboard_update` | 按 `id` 改标题、状态、小节、标记 |
| `workboard_complete` | 把待办转成已办（原条归档并留住溯源） |
| `workboard_archive` | 归档；`hard: true` 则物理删除 |
| `workboard_import` | 从既有 Markdown 导入（`dryRun` 可先看） |
| `workboard_export` | 返回路径与计数；`write: true` 重写三份镜像 |

`project` 不传时取 `exec.agent.session.header.cwd` 的 basename，所以「在哪个工作区
调用就落哪个项目」，模型不必先问一句"这是哪个项目"。显式传 `project` 仍然覆盖。

### 2. `/workboard` 斜杠命令

输入框里打 `/workboard` 就能直接读写清单。它解决的是一件具体的错位：会话里说"记个待办"
时，模型可能去改当前仓库的 `TODO.md`（那是项目自己的交付物），也可能只用会话内的
`todo_write`（那是本轮的临时清单，会话结束就没了）。一条人类发出的 `/workboard` 把落点
说死，而且它**不进模型**——命令由 `CommandRuntime.execute` 直接调 handler，不会变成
一条用户消息。

| 用法 | 作用 |
|---|---|
| `/workboard` | 列出未完成的待办（含已办 / 功能分支的条数） |
| `/workboard <标题>` | 新增一条待办；`project` 默认取当前工作区目录名 |
| `/workboard done <id\|#序号>` | 标记已办（原条归档并留住溯源） |
| `/workboard del <id\|#序号>` | 硬删除（真的从 `board.json` 里抹掉） |
| `/workboard import <路径> [kind]` | 从 Markdown 导入；`kind` 省略时按文件名认 `TODO.md` / `DONE.md` / `功能分支整理.md` |
| `/workboard export` | 重写三份 Markdown 镜像 |
| `/workboard help` | 用法 |

命令名为什么是 `workboard`：宿主对命令名有硬正则 `^[a-z][a-z0-9_-]*$`
（`packages/interaction/commands/src/index.ts:32`），中文、大写、空格都会被拒；而斜杠菜单里
那些中文条目是**显示名**（`builtinCommandTokens.zh`），只有 6 个内置命令才有，第三方插件
注册的命令只显示自己的 `name` 与 `description`。所以取「工作清单」的英文 `workboard`。

`#序号` 与完整 id 都认：命令是手打的，`#3` 比 `tb_t_mwn0czez6e3b9d` 好敲；工具与
脚本仍然可以用 id。序号只在同一 `kind` 内唯一，所以按序号匹配时限定 kind，同号多条
时优先未归档的那条。

`commands` 是**可选依赖**，用动态 `ctx.inject(['commands'], …)` 探测，不写进静态
`inject`：老宿主或 headless 组合可能没有命令服务，静态声明会让整个补丁在那样的组合
里永久 pending，连工具都用不上。命令重名与工具重名一样是抛错而不是覆盖，所以注册时
单独兜一层（`isDuplicateCommand`），只对"同名命令已被注册"跳过并留一条警告。

配置项 `commands: false` 可以关掉它。

### 3. 左侧边栏导航行 + 中列整页

侧边栏导航区（插件 / 自动化任务 / 记忆 那一组，「更多」之上）多一行**工作清单**，
点开占用中列整页：

- 三个标签页：待办 / 已办 / 功能分支（就是三种清单，各自带条数；没有「全部」）
- 搜索框过滤标题、项目与正文
- 每条按 tab 内的 `#N` 编号（与 Markdown 镜像里的编号同源），一次平铺、不按项目分组，
  项目只作为来源标签留在行内元信息里
- 行内勾选完成、归档
- 点**整行任意位置**（标题、元信息、序号都行）在整页右侧的详情栏打开这条事项的渲染版详情（见下）
- 底部可新增；行上有未办事项时，侧栏 glyph 右上角带一颗点

这对座位是宿主的 `sidebar.panellist`（导航行）+ `main`（整页），两者的 id 与 key
必须**逐字相同**：宿主点面板行时调 `layout.selectPanel(id)`，它按 `options.key` 在
`main` 槽里找 entry，对不上就抛 `main panel "x" is not registered`。行本身由宿主的
`PanelRow` 渲染（按钮、`aria-current`、悬停取消固定都是官方的），插件只交一颗 glyph。

整页每次动作后都重新向宿主读一次 `view`，因为别的会话可能正在写同一份清单；读完之后
会广播一次，让侧栏那颗点跟着新数据走，而不是停在打开前的状态。

### 4. 整页右侧的详情栏

中列那页**不在列表行里内联渲染正文**：事项正文里本来就有 `**背景**`、表格、代码块和
反引号路径，当纯文本陈列等于把 Markdown 语法丢给用户看。点标题时改为在**整页自己的
右侧**打开一栏详情，用平台的 `MarkdownText` 渲染 —— 与官方预览 `TODO.md` 的观感一致，
而用户留在清单里，可以接着点下一条。

为什么不用平台的右侧边栏（`sidebarRight` + `sidebar.right.pane.tab`）：那一列只在
「中列显示会话」时存在。`ui-sidebar-right` 的 `client/index.ts` 把 on-screen session
算成 `activePanelId === null ? 当前会话 : undefined`，`RightbarRoot` 也在
`activePanelId !== null` 时隐藏会话内容。工作清单**就是**那个 `main` 面板，所以在这里
调用 `sidebarRight.openTab()` 必然抛
`sidebarRight: no session surface is mounted` —— 这不是可选依赖没探测到，而是平台在
整页面板激活期间根本没有可用的 tab 座位。（2026-11-20 实测确认，详情页据此改为页内右栏。）

实现是四块：

1. 点**整行任意位置**只记 `selectedId`，列表行打上 `data-selected` 高亮；再点关闭按钮就收起。
   行内的完成 / 归档按钮 `stopPropagation`（点它们不会顺手打开详情）；拖着选一段文字
   （复制路径）松手时也派发 click，这种点击被忽略，不算「打开详情」。
2. `DetailPane` 按 id 向 `/todo-board/detail` 取 `{ item, markdown }`；换一条时先清空，
   避免旧正文闪一下。条目被完成、归档或在别处删掉后，详情栏跟着收起（列表里已经没有它）。
3. 正文交给平台的 `MarkdownText`，标签（复制/代码/脚注文案）走同一个 locale 命名空间。
4. 详情栏左边缘是**拖拽手柄**：宽度 260–720px，并且列表至少留 240px（拖到最宽也
   不会把它挤没）；拖完记进 `localStorage` 的 `todo-board.detailWidth`，下次打开
   还是那个宽度，**双击手柄**恢复 CSS 默认比例（`clamp(300px,32%,440px)`，随窗口
   缩放）。窄屏的覆盖抽屉没有手柄（拖拽在那里没有意义）。

`/todo-board/detail` 返回的 Markdown 由 `renderItemDoc()` 生成 —— 与三份镜像里那一段
**同源**，所以详情栏看到的和文件里写的不会各说一套。注意详情文档里**不能用裸 HTML**：
平台的 `MarkdownText` 把 HTML 节点当纯文本渲染（`render.tsx` 的
`omitHtml ? null : node.value`），`<sub>…</sub>` 会原样显示成一串尖括号（2026-11-20
用户实测报的渲染问题）。元信息因此用 Markdown 斜体、tags 用行内代码。

窄窗口（≤860px）放不下两栏时，详情栏变成盖在列表上的右侧抽屉（带不透明底色与关闭
按钮），而不是把清单挤到几乎不可读。

详情栏**不依赖任何平台服务**：中列清单和侧栏导航行照常挂载，浏览器半不需要动态
`ctx.inject` 探测可选服务，`inject` 始终是 `['slots', 'locale']`。

### 5. 系统提示词小结

插件往系统提示词注入一小段清单摘要（未完成条数与项目分布），让模型知道"跨项目
清单里还有哪些没做完"。`order` 取 2450，落在 `TOOL_GOAL`(2400) 与
`TOOL_SCHEDULE`(2500) 之间，与目标/计划类相邻。

## 三种清单形态

清单里有三类条目，各自沿用一份源文档的格式：

### 待办（`kind: 'todo'`）—— 对齐 `TODO.md`

```markdown
### [状态] N. 标题 — YYYY-MM-DD
**背景**
……
**方案**
……
```

小节：`背景 / 现状 / 方案 / 已实现 / 待验证 / 待确认 / 遗留 / 关联`。

### 已办（`kind: 'done'`）—— 对齐 `DONE.md`

```markdown
### ✅ 标题 — YYYY-MM-DD
**根因**
……
**验证**
……
```

小节：`根因 / 实现 / 验证 / 遗留 / 关联`。`workboard_complete` 生成的新条目会带
`fromId` 指向原待办，原待办转为 `archived`（不出现在镜像里，但仍可查询）。

### 功能分支（`kind: 'branch'`）—— 对齐 `zky_doc/功能分支整理.md`

```markdown
### 标题（有DDL，无SQL，无Nacos）
**背景**
……
**分支**
repo: xxx, branch: feature/yyy
**SQL**
repo: xxx, script: db/zzz.sql
**Nacos**
dataId: yyy, key: zzz
```

标题后缀由 `flags: { ddl, sql, nacos }` 渲染。那份文档的**硬性规则**在这里同样成立：

- 小节只用 `背景 / 根因 / 分支 / SQL / Nacos / 验证 / 上线前置 / 遗留 / 关联`，且按此顺序
- `分支`（仓库 + 分支名）、`SQL`（仓库 + 脚本路径）、`Nacos`（dataId + 配置项）
  是硬交付物，**即使为空也写一行 `无`**
- `SQL` 段不写执行库；不写 commit；`实现` / `已实现` 这类变体不要用（已办清单才有）
- 条目按**模块**分组（Foundry SaaS / Sitewalk SaaS / Tenantportal SaaS / Weinee IMS）

多项目时，三份镜像都会按项目分块并在目录里做二级分组；只有一个项目时，渲染结果
与源文档同形。

## 配置

字段全部 `.volatile()`（否则设置页只有卡片没有表单）：

| 字段 | 默认 | 说明 |
|------|------|------|
| `rootDir` | `''` | 清单目录；留空用 `$DSH_HOME/todo-board` |
| `promptSection` | `true` | 是否注入系统提示词小结 |
| `tools` | `true` | 是否注册 7 个工具 |
| `commands` | `true` | 是否注册 `/workboard` 斜杠命令 |

`DSH_HOME` 环境变量优先于 `~/.dsh`。

## 接线（宿主半）

- `inject` 是**静态**数组：`['tools', 'systemPrompt', 'webServer']`。`webServer`
  必须在里面——用 `ctx.get('webServer')` 探测会与载体的绑定竞速，静默丢掉面板的
  传输（见仓库 `AGENTS.md` 的传输章节）。
- 传输是 `webServer` 上的 **fenced 前缀路由** `/todo-board`，不是
  `ctx.connection.rpc.handle`（那玩意对连接包之外的插件必炸）。围栏顺序与仓库里
  其它补丁逐字相同：Origin/Host 同源 → 只 POST → `application/json` → 端点校验 →
  1 MiB 上限 → JSON 解析 → 处理。跨站 POST 一定带自己的 `Origin`，JSON body 又
  强制预检，两者一起把"别的网页替我改清单"挡在外面。
- 路由在 `apply` 里**最先**注册：`apply` 后面任何一步抛错，Cordis 会回滚此前注册
  的 effect，而"面板能连上宿主"是最后能自救的那条路。
- 工具注册对重名**逐个兜住**并跳过（`tools.register` 对重复名字是抛错而不是覆盖），
  不让重复注册把整个 `apply` 回滚掉。

## 存储细节

- 写入走 `writeTextAtomic`（同目录临时文件 + rename），读改写由
  `withBoardLock` 按 root 串行化——并发 `add` 不会丢更新。
- `board.json` 语法错误会抛 `board-corrupt`，**不会**静默清空。
- `isoDate()` 用**本地**日期，不是 `toISOString()`（东八区会差一天）。
- **序号是位置，不是历史自增号**：每次落盘前 `renumberItems` 把每个 `kind` 重排成
  连续的 `1..N`（未归档的在前，归档的接在后面）。所以删掉中间一条之后，剩下的是
  `#1 / #2`，不会留 `#1 / #3` 的空洞；完成中间一条之后，后面的序号也会往前收；
  新增总是接在当前末尾。JSON 的 `seq`、三份镜像的标题编号与面板里的 `#N` 读的是同一组数字。
- **排序只按序号，不按项目**：`sortItems` 的键是 `kind → number`。`view.items` 是界面
  直接渲染的顺序，如果中间还夹一层 `project`，跨项目时就会印出 `#2 / #1 / #3` 这样的
  倒序，看起来和「编号丢了」一模一样。项目名只作为来源标签留在行内元信息里。

## 安装与部署

推荐仓库根一键：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

CLI 检测到包声明的 `dsh.bundle` 后会自动完成 pnpm link + 登记
`dsh.profile.bundles`；loader 行来自包内 `cordis.patch.yml`。**不要**再往
profile 层的 `cordis.patch.yml` 里 insert 同 id 的行——两层同 id 会让启动
fail-loud 抛 `TypeError: duplicate loader entry id`。

宿主半 import 了 `@deepseek-ai/schemastery` 与 `@deepseek-ai/cosmokit`，所以需要
host 依赖链接（`scripts/deploy.ps1` 会自动补）：

```
patches/todo-board/node_modules → ~/.dsh/profiles/node_modules
```

源码改动不热重载，改完要重启桌面端（`scripts/restart-desktop.ps1 -Force`）。

## 测试

```powershell
node patches/todo-board/tests/core.test.mjs         # 48 项：store / markdown / import / 详情 / 序号（含 #N 过滤）/ /workboard 命令
node patches/todo-board/tests/load-smoke.mjs        # 30 项：真实 Cordis + 真实 schema 校验 + 命令座位
node patches/todo-board/tests/client-contract.mjs   # 31 项：侧栏导航行 + 中列整页 + 页内详情栏（整行点击、拖拽宽度）
```

三个脚本各自覆盖一个**静默失败面**：

- `core.test.mjs` —— 纯逻辑：序号规整（删除后压实、完成中间一条后后序前收、
  跨项目时顺序与编号一致）、`archived` 不复活、本地日期、
  三种文档的解析与渲染往返、`renderItemDoc` 的三种标题形态（详情页与镜像必须同源，
  否则「界面一套、文件一套」），以及 `/workboard` 六种调用形态（新增 / 列出 / done / del /
  import / export）与 `resolveRef` 对 `#序号`、裸数字、完整 id 的解析。
- `load-smoke.mjs` —— 真实 `@deepseek-ai/cordis` 的 `ctx.plugin()` 装载流程、
  真实的 `assertSupportedJsonSchema` / `validateJsonSchemaValue`，以及一个会真的
  走围栏的 `webServer` 桩。这类错误在运行时全是静默的：工具形状不对，模型那边
  只是少几个工具；`inject` 位置不对，面板永远连不上宿主。另有两条命令座位断言：
  `/workboard` 真的注册进 `commands`，以及**没有命令服务时补丁照常装上**（`commands`
  若误写成静态 `inject`，headless 组合里整个补丁会永久 pending）。
- `client-contract.mjs` —— 浏览器半：交接 id、**成对座位**（`sidebar.panellist` 的
  `id` 与 `main` 的 `key` 必须逐字相同，否则宿主 `selectPanel()` 抛
  `main panel "x" is not registered`）、**不再探测 `sidebarRight`**（整页面板期间它没有
  on-screen session，`openTab` 必抛 `no session surface is mounted`；`inject` 只能是
  `['slots','locale']`、动态 `ctx.inject` 一次都不调）、zh/en 字典键集一致，以及**真渲染**
  （侧栏 glyph 的未办点、整页的计数与三个 tab、`#N` 序号、不再按项目分组、功能分支标记写成
  「无Nacos」而不是「无NACOS」、空态、错误信封变成 `role="alert"`、`POST /todo-board/view`
  的 `{ args }` 请求体、点整行任意位置（标题 / 元信息 / 序号）都能在整页右侧开详情栏、
  行内的完成 / 归档按钮不会冒泡成"打开详情"、拖选文本后的 click 被忽略、
  从 `/todo-board/detail` 取这一条的 Markdown 交给渲染器、换一条会重读、关闭按钮收起详情栏、
  拖拽手柄改宽度并写进 `localStorage`、双击复位、失败信息留在详情栏里、整页刷新后侧栏的点
  跟着变）。注册对了但组件崩掉时，界面上只是少一行——没有渲染断言就发现不了。

清单目录指向临时目录，绝不碰 `~/.dsh/todo-board`。

## 已知边界

- **手改镜像不回写**。JSON 是唯一真相；要从 Markdown 迁进来请用 `workboard_import`。
- **镜像不是逐字节兼容原文件**。格式、小节、标题后缀、目录结构都对齐，但多项目
  时会插入项目分组与 `<!-- 项目：X -->` 注释（源文档只有单项目）。
- **`workboard_complete` 是「新建 + 归档」**，不是原地改 `kind`：已办清单的溯源字段
  （`fromId`）与待办的 `archived` 都依赖这条路径，原地改会丢掉溯源。
- 功能分支的「发版后整条移除」没有自动执行，按原文档的约定由人决定何时归档。
- **详情栏在整页内部，不占用平台右侧边栏**。平台那一列只在「中列显示会话」时存在
  （`activePanelId === null` 才有 on-screen session），而工作清单本身就是整页面板，
  在那里调 `sidebarRight.openTab()` 必抛 `no session surface is mounted`。页内详情栏
  换来的是「不离开清单、不依赖可选服务」，代价是它不能像平台 tab 那样拖成浮动窗或与
  其他插件的 tab 并列。详情正文与三份镜像同源（`renderItemDoc`），但它是独立的一篇
  文档，不带原文件里的锚点与 `---` 分隔线。
- **详情按 id 取数**。事项在别处被删或改名后，已开着的详情栏不会自动刷新；重新点一次
  标题即重读。条目被完成、归档或从当前清单消失时，详情栏会自动收起。
- **拖出来的详情栏宽度存在浏览器里**（`localStorage`），不是 profile 配置：换一台机器、
  换一个浏览器数据目录、或清站点的本地存储，都会回到默认比例。它只是阅读偏好，丢了不影响
  功能；拖拽期间禁用了列表的文本选中，结束后恢复。
- **`/workboard <标题>` 一律建成待办**。要记功能分支条目（带模块与 DDL/SQL/Nacos 三个硬
  交付物标记）仍走 `workboard_add` 工具或面板——命令只有一行输入，塞不下这些结构。
- **`/workboard` 不产生模型回合**。它是给人用的直接动作，执行完只在会话日志里留
  `command/run` 与 `command/done` 两条 log-only 事件；模型要到下一轮才从系统提示词
  的摘要里看到新增的条目。