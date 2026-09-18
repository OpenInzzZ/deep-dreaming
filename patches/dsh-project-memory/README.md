# dsh-project-memory

跨会话项目记忆的 **Memorix 桥接插件**:把「什么时候该读/写项目记忆」告诉 Agent,真正的存储、检索、去重、成熟度全部由 [Memorix](https://www.npmjs.com/package/memorix) 通过 DSH 的 MCP 客户端提供。

> ⚠️ **本插件不再自己提供工具**,也不再读写 `<项目根>/.dsh-memory/`。
> `project_memory_save` / `project_memory_search` / `project_memory_list`
> 三个工具在 2ce1e73(「记忆补丁调整」)中移除;记忆工具现在是
> `mcp__memorix__memorix_*`(由 MCP 服务器注册)。旧的 `.dsh-memory/`
> 笔记需要用 `scripts/migrate-dsh-memory.mjs` 导入 Memorix,见下文
> [从旧版迁移](#从旧版迁移)。

## 前置条件(缺一不可)

1. **Memorix 已安装**:`npm install -g memorix`(验证:`memorix --version`)。
2. **DSH 侧 MCP 行已写入**用户层 patch:`memorix setup --agent dsh --global`,
   会在 `~/.dsh/cordis.patch.yml` 写入一行 `@deepseek-ai/dsh-mcp-client`
   (serverName `memorix`,stdio,`memorix serve --mode lite`)。
   `scripts/install.ps1` 已包含这两步(幂等)。
3. **重启 dsh web** 后,工具以 `mcp__memorix__<工具名>` 出现在会话里。

`dsh-mcp-client` 也支持热加载:只改 `~/.dsh/cordis.patch.yml` 时无需重启,
新增行会在数秒内装载(日志里能看到 `[memorix] MCP Server running on stdio`)。

## 项目绑定(本桥接存在的首要原因)

Memorix 的记忆**按项目(git 仓库)隔离**,而 DSH 全进程只启动**一个** MCP
实例、且它的工作目录是 dsh 进程的 cwd(web 场景下通常是
`~/.dsh/profiles/web`,不是一个 git 仓库)——`dsh-mcp-client` 不会向 MCP
服务器发送每个会话的工作区 root。因此未绑定时 Memorix 会**拒绝一切项目级
工具**:

```
Cannot search the current project yet.
No git project could be resolved from "C:\Users\<user>\.dsh\profiles\web".
```

绑定方式是会话级的一次调用,`projectRoot` 必须是本会话的工作区根目录:

```
mcp__memorix__memorix_session_start({ projectRoot: "D:\\GitHub\\my-project" })
```

本插件的 host 半知道该路径(会话 header 的 `cwd`),所以**召回提示里会直接
带上它**,Agent 无需自己猜:会话开始(autoRecall)收到「项目记忆召回 ·
memory search」,第一步就是绑定,然后用
`mcp__memorix__memorix_project_context` 取任务 brief。若该目录不是 git 仓库
(例如临时会话目录),提示会要求 agent 直接开始工作、不要反复重试绑定。

> **并发限制**:同一进程内所有会话共享这一个 MCP 实例,因此**绑定是全局的**
> ——两个不同工作区的会话同时运行时,后绑定者会覆盖前者。各会话在自己的开始
> 阶段重新绑定即可保证正确;若需要严格隔离,请让不同项目使用不同的 dsh 实例
> (不同端口 + 不同 DSH_HOME),或在保存前显式重新绑定。

## 工作方式

1. **常驻指令**(注入每个会话的 system prompt,`systemPrompt.section`
   `project-memory:guidance`):说明 Memorix 是项目级记忆、必须绑定、
   何时检索(brief)、何时保存(store),以及只记事实与结论。
2. **会话开始自动召回**(`autoRecall`,默认开):会话**第一轮**
   (`turn/start`)把一条 context notice 注入**当轮**——携带本会话工作区
   根目录与绑定调用,要求先绑定、再取 brief。每个会话仅一次;子代理不触发;
   没有工作区的会话不触发。
   - 用 `agent.inject(...)`(next-step,**不唤醒**驱动器)而不是
     `agent.followup(...)`:前者像 DSH 自己的运行时上下文一样落在用户本轮
     之内,后者按官方语义是「**该条目自成一整轮**」,会凭空多出一轮对话。
   - 触发点用 `turn/start` 而不是第一条 `user/message`:第一条用户消息落盘时
     agent 还没进入 `ctx.agents`(发布顺序在消息之后),`agents.get()` 必然
     返回 undefined —— 这正是旧版召回**从未生效**的原因(实测:本机 8 份最大
     的会话日志里 0 次召回)。
3. **不产生任何额外轮次**:插件不再在回合结束后做任何事(见下)。

### 为什么没有「会话结束自动回顾」

旧版本的 `autoReview` 在每轮完成、agent 回到 idle 时调用
`agent.followup(回顾提示)`,而 `followup()` 的官方语义是
*The item becomes the sole ordinary message of its own turn* —— 于是**每个
用户轮次都会多出一轮纯管理性的对话**,可见痕迹只有一行 Thinking 加一句
「无需记录」。实测某 62 轮会话里有 **23 轮**是这样产生的。

能否把它渲染成图 2 那种折叠卡?不能:assistant 步骤的 chat node kind 由官方
chat 渲染器固定拥有(`conversation.chat.node` 的 key 表),要折叠它就得接管
**所有**轮次的 assistant 渲染 —— 代价远超收益。(图 2 那种卡片之所以可行,是
因为记忆**工具调用**走的是 `tool.call.toolview` 这个 key 开放的工具视图槽位;
真正保存时它本来就已经是那个样子。)

因此保存改为只由常驻指令 + Memorix 自带的 `~/.dsh/AGENTS.md` 规约驱动;agent
保存时依旧渲染为可折叠的「记忆 · 保存/更新」卡片,不保存时不留下任何痕迹。
旧配置里的 `autoReview: true` 会被 schema 忽略(未知键被剥离),不会导致启动
失败;确实想恢复该行为可从 git 历史取回。

4. **只做提示,不做存储**:本插件不 import 任何存储代码、不注册工具、
   不读写文件——Memorix 的 SQLite/Orama 后端、去重、成熟度、Git Memory、
   Reasoning Memory 都由 Memorix 自己拥有。

## 记忆阶段折叠卡(浏览器半)

浏览器半(`client.js`,经 `dsh.client` 声明装载)把**每个** Memorix 记忆工具
调用渲染成可折叠卡片,与官方「Think」推理行**同款组件与风格**(复用
primitives 的 `DisclosureRow`):

| 工具 | 卡片标题 |
| --- | --- |
| `mcp__memorix__memorix_search` | 记忆 · 检索 |
| `mcp__memorix__memorix_store` | 记忆 · 保存/更新 |
| `mcp__memorix__memorix_project_context` | 记忆 · 任务上下文 |
| `mcp__memorix__memorix_detail` | 记忆 · 详情 |

折叠行 = 动作图标 + 标题 + 状态点 + 一行摘要;展开可见结果全文。
**默认全部折叠**(含执行中的卡片,摘要显示「运行中…」),点击行展开。
修改 `client.js` 后需重启 dsh web 生效(与其它补丁源码一致)。

会话开始的**召回提示**本身以官方 context notice 形态注入
(`source.form = 'notice'` + `summary`),折叠为一行摘要,并落在用户本轮之内,
不占额外对话轮次;召回里出现的 `mcp__memorix__*` 调用同样渲染为上面的卡片。

## 从旧版迁移

旧版把笔记存成 `<项目根>/.dsh-memory/<分类>/<标题>.md`。这些文件对 Memorix
不可见,导入一次即可(幂等,可重复运行):

```powershell
# 在需要迁移的项目根目录执行(记忆按 git 项目绑定)
node D:\GitHub\deep-dreaming\scripts\migrate-dsh-memory.mjs
node D:\GitHub\deep-dreaming\scripts\migrate-dsh-memory.mjs --dry-run   # 先看要导入哪些
```

脚本经**真实 MCP stdio 通道**(与 dsh 用的是同一条:`memorix serve --mode
lite`)调用 `memorix_search` 去重、`memorix_store` 写入:front matter 里的
`keywords` 变成 Memorix 的 `concepts`,分类映射为观察类型
(`common_pitfalls_experience` → `gotcha` 等),正文连同来源路径写入
narrative。**旧笔记不会被删除**,确认导入成功后可自行归档/删除
`.dsh-memory/`。

## 配置

只剩两个行为开关,存储层参数已归 Memorix(`memorix.toml` /
`~/.memorix/config.toml`)。默认配置即开即用;覆盖方式是在
`~/.dsh/profiles/web/cordis.patch.yml` 追加:

```yaml
- id: project-memory
  config:
    autoRecall: false   # 关闭会话开始自动召回(仍可手动调用记忆工具)
```

> 旧配置里的 `memoryDirName` / `autoDedupe` / `mergeContentThreshold` /
> `trackUsage` / `autoReview` 已不存在:未知键会被 schema 忽略(不报错),
> 便于平滑迁移。

## 安装

本插件是**组合包(bundle)插件**,随 profile 的 bundle 层装载,不在
`cordis.patch.yml` 里手工 insert:

```powershell
# 仓库根执行(或直接用 scripts\install.ps1 完成全部步骤)
corepack pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" add "$((Resolve-Path .).Path)\patches\dsh-project-memory"
# 再把 "dsh-project-memory" 追加进 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles
```

插件目录还需要一个指向宿主依赖的 junction(插件 import `@deepseek-ai/dsh-llm`
等宿主包,Node 按仓库侧真实路径解析):

```powershell
New-Item -ItemType Junction -Path "patches\dsh-project-memory\node_modules" -Target "$env:USERPROFILE\.dsh\profiles\node_modules"
# scripts\deploy.ps1 会自动补齐/修复该链接
```

> ⚠️ **不要**再在 `~/.dsh/profiles/web/cordis.patch.yml` 里手工 insert
> `project-memory` 条目 —— bundle 层已提供该行(自带 config 默认值),
> 用户层再 insert 同名行会导致下次启动
> `duplicate loader entry id: project-memory` 硬失败。

最后重启 `dsh web`(bundle 层变更需重启)。卸载:
`dsh plugin --profile web remove dsh-project-memory` 并从 bundles 列表移除。

## 测试

```powershell
# 仓库根执行一次 npm install 以取得 react / jsdom(浏览器半验证用)
npm install

node patches/dsh-project-memory/tests/plugin.smoke.mjs     # 真实 Cordis 装载:Config 校验 + 提示词/事件流
node patches/dsh-project-memory/tests/client-contract.mjs  # 浏览器半:4 个记忆卡片注册 + 折叠渲染
```

冒烟覆盖:apply 返回值不是 thenable(Invalid effect 回归)、Config 对错误
类型响亮失败而旧键(含 `autoReview`)被容忍、guidance 段落含绑定步骤与工具名、
召回在**第一轮** `turn/start` 时以 `inject` 投递(不是 followup、不自成一轮)、
携带本会话工作区根目录、只触发一次、排除子代理与无工作区会话、
**轮次结束/再次空闲后不再产生任何消息**(旧 autoReview 的噪音回归守卫)。

## 相关文件

- `lib/index.js` — host 半:guidance 段落 + 第一轮召回(inject)
- `client.js` — 浏览器半:Memorix 工具的折叠卡片
- `cordis.patch.yml` — bundle 层条目(`autoRecall` 默认值)

> 旧版本地存储实现(`lib/store.js`:相似度合并、成熟度、`.dsh-memory/` 读写)
> 与其单测已在 Memorix 迁移完成后删除 —— 存储归 Memorix,笔记格式的解析由
> `scripts/migrate-dsh-memory.mjs` 自带(它只读 front matter 的
> title/category/keywords/usage_scenario,不依赖被删代码)。
