# archive/ — 已归档资产（不再维护）

本目录保留三类东西：**以 DSH Web 端为准**时期的脚本与资产（项目现在以 **DSH 桌面端**
（Electron，`dsh-desktop`）为唯一目标）、**已退役的补丁**（被后续补丁取代、与官方
能力重复，或按要求整体移除），以及**随记忆后端一起退役的迁移脚本**。它们一律**不再部署、
不再保证可运行**。

放在这里而不是删掉，是为了在需要时能读懂旧行为（例如排查历史故障、或把某段逻辑移植到
新补丁里）。

## `web-scripts/`

| 文件 | 原来的作用 | 为什么归档 |
| --- | --- | --- |
| `start-dsh.ps1` | 静默启动 `dsh web`：扫 3080-3100 端口池、定位 npx 缓存里最新的 dsh CLI、隐藏窗口启动、轮询就绪 | 桌面端由 Electron 拉起居中进程并固定监听 `127.0.0.1:19387`，端口与启动方式都不由脚本决定 |
| `restart-dsh.ps1` | 重启 `dsh web`：按端口找到旧进程、恢复其命令行、停旧起新、轮询就绪 | 同上；桌面端的重启是**重启整个应用**，见 `scripts/restart-desktop.ps1` |
| `stop-dsh.ps1` | 命令行停止 `dsh web`（按端口找进程、校验 PID、等端口释放） | 桌面端从托盘退出即可 |
| `update-dsh.ps1` | 把新版 dsh 装进 npx 缓存并切换运行中的服务 | 桌面端由 `electron-updater` 自带更新（`resources/app-update.yml`） |
| `install-desktop-shortcut.ps1` | 在桌面创建 `dsh-web.lnk`，双击启动 Web 服务并显示端口 | **功能已下线**：桌面端本身就是应用，再套一层快捷方式没有意义 |
| `patch-cli.ps1` | 给 **npx 缓存**里的 dsh CLI 注入 `dsh web --clean`（跳过用户层，作为崩溃逃生舱）；严格自检、失败回滚 | 桌面端跑的是打包运行时（`resources/app.asar/dsh`），不是 npx 缓存，没有可打补丁的对象 |

## `scripts/`

| 文件 | 原来的作用 | 为什么归档 |
| --- | --- | --- |
| `migrate-dsh-memory.mjs` | 把 `.dsh-memory/` 里 6 个旧实现的 Markdown 笔记（YAML front matter）经真实 MCP stdio 通道导入 **MCP Reference Memory** 图谱；幂等，支持 `--dry-run` | 它只往已退役的参考图谱写数据（2026-11-16 起记忆由 `dsh-mnemon` 承载）；图谱写完后内容又被导入 Mnemon 的 Memory Space，这条链路不再有下游 |
| `migrate-memorix-to-reference.mjs` | 对每个项目根调官方 `memorix transfer export`，把非归档 observation 映射成 `<project>/<title>` 并经 MCP stdio 写入参考图谱；已有实体名跳过，重跑幂等 | 同上：Memorix 时代的数据经参考图谱中转后已进 `dsh-mnemon`，这个中转站本身已退役 |

> 两个脚本都是「一次性搬运工」，保留只为读懂当年的数据形态（实体名规则、去重策略、
> `--dry-run` 的做法）。`package.json` 里的 `migrate:memory` 快捷脚本已随之删除。

## `patches/`

| 目录 | 曾经的用途 | 为什么归档 |
| --- | --- | --- |
| `ui-settings-other/` | Web 设置「其他」页：服务运行状态、创建桌面快捷方式、检查更新、重启服务（三阶段进度条）、favicon 覆盖；配套 Web 生命周期脚本 | 这些能力都以 **Web 端生命周期**为准。桌面端的运行状态、更新与重启由应用自己负责，快捷方式也无意义（应用本身就是入口）。曾一度改造为只读余额页 `ui-settings-balance` |
| `ui-settings-balance/` | 只读「账户余额」页：充值 / 赠金余额，经宿主 `deepseekAccount` 读取 | **重复建设**：桌面端自带的「账号与余额」页（`@deepseek-ai/dsh-client-ui-settings-account`）已提供同样两行，另有「更多账号信息」「查询用量」和**充值按钮**。用户补丁只做出一个功能子集，还在 sidebar 上多了一个近义入口，因此退役 |
| `ui-settings-plugin-manager/` | 设置「插件管理」标签页：整份 loader 条目清单 + 分类/启用状态/运行状态三个过滤器 + 每行的启停开关 | **启停与官方重复**：官方 `pluginManager.setPluginEnabled` 写的是同一层、同一 YAML 形状，入口另有侧栏「插件」页、agent 工具 `plugin_manager` 与 `dsh plugin` CLI。归档前已修好它两处真实故障（写死 `profiles/web`；把 loader `entryId` 当补丁行 id 导致永不匹配却回报成功）并补了测试，但既然官方覆盖了核心能力，仍选择整体退役 |
| `ui-settings-model-reasoning/` | 设置「模型」页扩展：给自定义（`llm-pi-ai`）路由逐模型配置**思考开关 + 思考等级**，写回 `reasoningEfforts` | **被后续补丁取代**（不是失败）：迭代为 `patches/ui-settings-model-capabilities`，把同一条目扩成「模型能力」卡片——思考之外并入**图片输入三态**（跟随上游 / 仅文本 / 支持图片），补上官方勾选框无法表达的「继承」状态。loader 条目 id 与包名随之改名（`…-model-reasoning` → `…-model-capabilities`），旧行由 `scripts/install.ps1` 的 `$renamedBundles` 幂等注销 |
| `ui-settings-model-capabilities/` | 设置「模型」页扩展：给 `llm-pi-ai` 路由逐模型配置**思考开关 + 等级（档位与发送值）**写回 `reasoningEfforts`（仅目录型路由，声明型路由交官方模型行），以及**图片输入三态**（跟随上游 / 仅文本 / 支持图片）写回 `input` | **按要求退役**（2026-11-03），不是被官方取代：移除「我们自己写的思考等级与多模态支持配置」。两层同时做——profile 里各模型的 `reasoningEfforts` / `input` 声明一并删除（副作用：`deepseek-v4.1-flash` 不再声明图片输入，官方按纯文本处理该模型），补丁目录由 `patches/` 移入本归档、profile 登记与两条 junction 已注销；`scripts/install.ps1` 的 `$renamedBundles` 因此推广为 `New = $null` 的退役登记 |
| `ui-queue-tools/` | 排队消息坞增强：遮蔽官方 `conversation.input.dock` 的 `queue` 单元（`priority: -10`），自绘整块队列坞，额外提供 **hover 全文预览** 与 **拖拽排序**（host 半经 `Inbox.splice` 重排）；其余行为逐版跟随官方坞同步（附件缩略图/文件块、本地排队回显、可继续子代理） | **收益不再配得上成本**（2026-11-06）：官方坞后来已自带多行编辑（`InlineEditor` 本就是 textarea，Enter 保存 / Shift+Enter 换行 / Escape 取消，且处理 IME 组合输入）、5 处 Tooltip、附件缩略图与文件 chip、sending 状态行。补丁真正的增量只剩两项，而**遮蔽是全量替换**——官方之后为该坞新增的任何能力（steer、折叠计数等）都会被补丁版本挡掉，且必须每版人工对齐。loader 行与两条 junction 已由 `$renamedBundles` 的 `New = $null` 幂等注销。**后续(同日)**：官方至今仍没有更改排队顺序的方式(会话控制器的 `QueueAction` 只有 `edit`/`remove`/`steer`)，因此「拖拽排序」这一项以新补丁 `patches/queue-reorder` 回归——但换了形态：不遮蔽官方坞，只往官方行上加拖拽。本归档目录保留作参考(151 行 host 半的 `Inbox.splice` 重排逻辑、客户端拖拽交互、`verify-queue-tools.mjs`)，新补丁的重排语义即源自这里 |
| `mcp-servers/` | 一张设置页管理多个外部 MCP 服务：清单存在插件的 `servers` 配置数组里，宿主端对每项挂一个官方 `@deepseek-ai/dsh-mcp-client` 子 fiber（官方一个 entry 只连一个 server，且它的 `z.union` 展不开成表单），客户端半端注册 `settings.section` 页；出厂默认那条是 IDEA 代码诊断 | **社区插件已有对应实现**（2026-11-13 按用户要求退役）：社区插件 **`dsh-mcp-panel`**（`dsh plugin --profile desktop add dsh-mcp-panel`，设置 → 插件 → MCP，`/mcp` 命令）覆盖同一片能力，还多出健康诊断、连接状态、重连计数、工具试调与 Streamable HTTP 探测。更关键的是**数据形态**：它读写的正是官方行词汇（每个服务一条 `@deepseek-ai/dsh-mcp-client` 行），而本补丁用的是插件私有的 `servers` 数组——两者并存就是两套事实来源。因此既有 4 个服务（idea / dbx / api_fox / data_mock）已按官方行迁进 profile 层 `cordis.patch.yml` 的 `- insert:` 列表（`mcp-idea` / `mcp-dbx` / `mcp-api_fox` / `mcp-data_mock`），补丁目录移入本归档，profile 依赖、`dsh.profile.bundles` 条目与两条 junction 由 `$renamedBundles` 的 `New = $null` 幂等注销。目录内保留 `lib/index.js`（`planReconcile` / 子 fiber 挂载）、`lib/client.js` 与两份测试，作为「volatile 配置 + 按项 reconcile」的参考实现 |
| `dsh-project-memory/` | **MCP Reference Memory 桥**：注入一段 `project-memory:guidance` 系统提示（order 60，告诉 agent 何时用 `mcp__reference_memory__*`、实体名要带 `<project>/` 前缀），并在会话第一个 `agent/pre-step` 步骤追加一条 recall 提示（`createUserMessage` + `source.kind = 'plugin:project-memory'`）；客户端半为参考服务器的 9 个工具注册 `tool.call.toolview` 折叠卡（`TOOL_PREFIX = 'mcp__reference_memory__'`），不开设置项、不存数据 | **社区插件已接管**（2026-11-16 按用户要求退役）：社区插件 **`dsh-mnemon`**（Mnemon Native provider + 全局 `mnemon` CLI 0.2.13）覆盖同一片能力，还多了按工作区的物理隔离、图遍历、软删除与设置页。两者并存会挂上**第二个**提示段，让 agent 同时被告知用两套后端。迁移先行已完成：240 实体 / 39 关系 / 2894 observation → 8 个按工作区划分的 Memory Space 共 266 条 insight（`errors: 0`）；因边不能跨 `mnemon.db`，**丢了 4 条跨项目关系**（`weinee ↔ taikoo-saas` 两条、`idaas ↔ alibaba-cloud-idaas` 两条）。home 层那条 `memory-mcp-reference` 行与其图谱**故意保留**作只读兜底（图谱是迁移前数据的唯一副本），`deploy.ps1` 对它只报 `[INFO]`；补丁本身由 `$renamedBundles` 的 `New = $null` 幂等注销。目录内保留 `lib/index.js`、`client.js` 与两份测试，是「`agent/pre-step` 瀑布注入 notice + 生产者自有 `source.kind`」的参考实现 |

> **三个归档补丁留下的通用知识**（写进了 `AGENTS.md` 的 pitfalls，代码本身只在归档里）：
> `mcp-servers` 是「volatile 字段改动不重跑 `apply()`、插件必须自己监听 `loader/volatile-update` 并
> reconcile」的原始范本；也是 `.volatile()` 会把校验值装箱成 `{ get }`、下游必须先解箱的原始范本。
> `dsh-project-memory` 则是「往会话里注入一条 notice」的原始范本：必须走 `agent/pre-step` 瀑布
> （`return { ...decision, messages: [...decision.messages, notice] }`），不能在 `session/event` 里调
> `agent.inject`（那次 append 会被拒：`session append cannot reenter while another append is being
> published`），且 `source.kind` 必须是生产者自有的 `plugin:<name>`（v4 编码器拒收 `kind: 'plugin'`）。
> 它的 `tests/plugin.smoke.mjs` 是唯一把这两条钉住的测试。

> `ui-settings-other/` 归档时按新归属拆分过：它的 5 个生命周期脚本与 `scripts/patch-cli.ps1`
> 一起并入 `web-scripts/`（逐字节相同，因此归档目录里不再留副本），4 个资产分别落到仓库级
> `assets/favicon-128.png`、`patches/whale-background/assets/whale-girl-transparent.png`
> 与 `assets/`（见下表），归档目录内只保留补丁代码与文档。

> 教训（也已写进 `AGENTS.md` 的「Adding a New Patch」）：**做 UI 补丁前先在 DSH 源码检出里
> grep 一遍**（`packages/client/ui-*`），确认官方没做过同一件事。
>
> 同一条教训的社区版（`mcp-servers` 归档时补）：**先看社区插件是否已经做过**。这次不是官方
> 接管，而是社区插件 `dsh-mcp-panel` 早已覆盖同一片能力；它用的还是官方行词汇，接入成本更低。
> 判断标准应该是「谁的数据形态更接近官方」，而不是「谁先写出来」。
>
> 同一标准的第二次应用（`dsh-project-memory` 归档时补）：这次是社区插件 `dsh-mnemon` 接管了
> 整条记忆链。判断依据仍是数据形态——官方 MCP Reference Memory 只给一个跨项目共享的 JSONL 图，
> 项目划分靠实体名前缀这一条纪律；`dsh-mnemon` 直接按工作区落物理分离的 `mnemon.db`，配合 provider
> 的能力声明（search / related / link / forget）表达出桥补丁根本做不到的读能力。**先迁移数据、再退役
> 桥**的顺序也很关键：图谱是迁移前数据的唯一副本，脚本不删它，只把它降级为兜底。

## `assets/`

| 文件 | 原来的作用 | 为什么归档 |
| --- | --- | --- |
| `DeepSeekHarness-WhaleGirl.ico` | 桌面快捷方式 `dsh-web.lnk` 的图标（`IconLocation`） | 随快捷方式功能一起下线 |
| `improved-1.png` | 未被任何代码引用的原始素材 | 只是素材残渣 |

> 鲸鱼娘背景图 `whale-girl-transparent.png` **没有**归档：它归 `patches/whale-background/assets/`
> 所有，由该补丁自己的候选链解析（自身 `assets/` → `~/.dsh/assets/` → 本归档目录作为兜底）。

## 与归档无关的取舍

- 仓库的 CLI 补丁实现只在 `archive/web-scripts/patch-cli.ps1` 里存在一份；
  `scripts/install.ps1` / `scripts/deploy.ps1` 不再同步它到 `~/.dsh/scripts/`。
- 鲸鱼娘图标（favicon）**没有**归档：它已提升为**仓库级品牌资产**
  `assets/favicon-128.png`，不归任何补丁，由 `scripts/deploy.ps1` 同步到 `~/.dsh/assets/`。
