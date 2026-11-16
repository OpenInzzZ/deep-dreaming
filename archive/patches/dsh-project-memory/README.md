# dsh-project-memory

跨会话项目记忆的 **MCP Reference Memory 桥接插件**:把「什么时候该读/写记忆、实体该叫什么」告诉 Agent,真正的存储、检索、关系与删除全部由官方参考记忆服务器 [`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) 通过 DSH 的 MCP 客户端提供。

> ⚠️ **本插件不存储任何东西**,也不注册记忆工具。它只做两件事:
> 注入提示词约定,并在会话首个被准入步骤召回本项目已有的记忆。
> 记忆工具是 `mcp__reference_memory__*`(九个图谱工具)。

## 前置条件(缺一不可)

1. **参考记忆服务器已全局安装**(DSH 只负责拉起,不负责下载):
   ```powershell
   npm install -g @modelcontextprotocol/server-memory@2026.7.4
   # 验证:mcp-server-memory 在 PATH 上
   ```
2. **DSH 侧 MCP 行已写入**用户层 patch `~/.dsh/cordis.patch.yml`:
   ```yaml
   - insert:
       - id: memory-mcp-reference
         name: "@deepseek-ai/dsh-mcp-client"
         config:
           serverName: reference_memory
           transport: stdio
           command: mcp-server-memory
           env:
             MEMORY_FILE_PATH: 'C:/Users/<you>/.dsh-mcp-reference-memory.jsonl'
   ```
   `scripts/install.ps1` 已包含这两步(幂等),并会**移除旧的 `memory-memorix` 行**,保证同一时间只挂一个记忆服务器。
3. **重启 DSH 桌面端**(或等热加载)后,工具以 `mcp__reference_memory__<工具名>` 出现在会话里。

> 本插件取代了旧的 **Memorix** 后端。Memorix 的记忆按 git 仓库隔离、需要每个会话先
> `memorix_session_start({ projectRoot })` 绑定;参考服务器没有项目概念,也没有绑定调用。

## 项目隔离:命名约定

参考记忆服务器**不按 git 仓库隔离**——整个 DSH 进程共享同一个 JSONL 图文件。因此本插件把
项目隔离做成**实体命名约定**:

```
<project>/<topic>
```

`<project>` 是会话工作区根目录的 basename(小写)。例如工作区 `D:\GitHub\deep-dreaming`
的记忆实体名是 `deep-dreaming/记忆后端`、`deep-dreaming/安装脚本`……

参考服务器的 `search_nodes` 对**实体名、类型、观察内容**做大小写不敏感的子串匹配,
所以 `search_nodes({ query: "deep-dreaming" })` 就能只取回本项目的记忆。

召回提示里会直接给出本会话的 `<project>`;常驻指令则要求 Agent 自己遵守这个前缀。

> **并发限制**:所有会话共享一张图,项目之间只靠命名前缀区分。不要用其他项目的
> 前缀保存,也不要在未带前缀的实体里写项目相关事实。

## 工作方式

1. **常驻指令**(注入每个会话的 system prompt,`systemPrompt.section`
   `project-memory:guidance`):说明后端是 MCP Reference Memory、图是共享的、
   实体必须用 `<project>/<topic>` 前缀,以及何时检索、何时保存、如何纠正。
2. **会话开始自动召回**(`autoRecall`,默认开):agent 的**第一个被准入的步骤**
   (`agent/pre-step`)把一条 context notice 追加进该步的模型消息批次——携带本
   会话工作区与项目标识,要求先 `search_nodes("<project>")`。每个 agent 实例仅一次;
   子代理不触发;没有工作区的会话不触发;被拒绝/中止的步骤不消耗这次机会。
   - 走官方 `agent/pre-step` 瀑布(与 `time-context`、`model-selection` 相同):
     返回 `messages: [...decision.messages, recall]`,消息由会话持久化为带来源
     的 user-role context row;它不是 `followup`,不会自成一轮。
   - 为什么不是 `agent.inject(...)`:从 `session/event` 监听器里调用它会同步
     `inbox.splice` → `session.append`;而事件正是在会话自身 append 尚未发布完
     (`appending === true`)时分发的,重入追加被拒绝
     ("session append cannot reenter while another append is being published")。
     旧实现吞掉了这个异常,所以召回**从未落盘**。
3. **不产生任何额外轮次**:插件不在回合结束后做任何事(见下)。

### 为什么没有「会话结束自动回顾」

旧版本的 `autoReview` 在每轮完成、agent 回到 idle 时调用
`agent.followup(回顾提示)`,而 `followup()` 的官方语义是
*The item becomes the sole ordinary message of its own turn* —— 于是**每个
用户轮次都会多出一轮纯管理性的对话**,可见痕迹只有一行 Thinking 加一句
「无需记录」。实测某 62 轮会话里有 **23 轮**是这样产生的。

能否把它渲染成折叠卡?不能:assistant 步骤的 chat node kind 由官方 chat 渲染器
固定拥有(`conversation.chat.node` 的 key 表),要折叠它就得接管**所有**轮次的
assistant 渲染 —— 代价远超收益。记忆**工具调用**则走 `tool.call.toolview` 这个
key 开放的槽位,保存时本来就是折叠卡片。

因此保存只由常驻指令驱动;不保存时不会留下任何痕迹。旧配置里的 `autoReview: true`
会被 schema 忽略(未知键被剥离),不会导致启动失败。

4. **只做提示,不做存储**:本插件不 import 任何存储代码、不注册工具、
   不读写文件——图文件、检索、关系、删除都由参考服务器自己拥有。

## 记忆阶段折叠卡(浏览器半)

浏览器半(`client.js`,经 `dsh.client` 声明装载)把**每个**参考记忆工具调用渲染成
可折叠卡片,与官方「Think」推理行**同款组件与风格**(复用 primitives 的
`DisclosureRow`):

| 工具 | 卡片标题 |
| --- | --- |
| `mcp__reference_memory__search_nodes` | 记忆 · 检索 |
| `mcp__reference_memory__read_graph` | 记忆 · 读取图谱 |
| `mcp__reference_memory__open_nodes` | 记忆 · 打开实体 |
| `mcp__reference_memory__create_entities` | 记忆 · 新建实体 |
| `mcp__reference_memory__add_observations` | 记忆 · 追加观察 |
| `mcp__reference_memory__create_relations` | 记忆 · 新建关联 |
| `mcp__reference_memory__delete_entities` | 记忆 · 删除实体 |
| `mcp__reference_memory__delete_observations` | 记忆 · 删除观察 |
| `mcp__reference_memory__delete_relations` | 记忆 · 删除关联 |

折叠行 = 动作图标 + 标题 + 状态点 + 一行摘要(图谱类工具显示
「N 个实体 · M 条关系」,写入类显示新建/追加数量);展开可见结果全文。
**默认全部折叠**(含执行中的卡片,摘要显示「运行中…」),点击行展开。
修改 `client.js` 后需重启 DSH 桌面端生效(与其它补丁源码一致)。

会话开始的**召回提示**本身以官方 context notice 形态注入
(`source.kind = 'plugin:project-memory'` + `form = 'notice'` + `summary`),
折叠为一行摘要,并落在用户本轮之内,不占额外对话轮次;召回里出现的
`mcp__reference_memory__*` 调用同样渲染为上面的卡片。会话格式 v4 拒绝旧的
`kind: 'plugin'` 包装(写入时即报 `format v4 message requires a
producer-owned source kind`),`plugin:<名称>` 正是 v3→v4 迁移器为未知插件
生成的来源拼写。

## 从 Memorix 迁移

如果之前在 Memorix 里积累了项目记忆,用 `scripts/migrate-memorix-to-reference.mjs`
把它们复制进参考图谱。脚本调用官方的 `memorix transfer export` 取快照,再经真实
`mcp-server-memory` stdio 通道写入;Memorix 自己的数据库不会被修改。

```powershell
# 每个项目根一个 --cwd(可重复);不传时只迁移当前目录
node scripts/migrate-memorix-to-reference.mjs --cwd "D:\GitHub\deep-dreaming" --cwd "D:\GitHub\another-project"

# 已经有 transfer 导出的 JSON 时可以直接喂给它
node scripts/migrate-memorix-to-reference.mjs --from "C:\path\to\memorix-export.json" --dry-run

# 目标图文件默认 ~/.dsh-mcp-reference-memory.jsonl,可用 --memory-file 覆盖
```

映射规则:

- 实体名 = `<project>/<title>`,`<project>` 取 Memorix 规范 projectId 的最后一段
  (小写),与插件从工作区 basename 推导出的前缀一致;
- `narrative` 作为一条 observation,`facts` 各自成条,并追加 `filesModified`、
  `concepts` 与一条含 Memorix id/type/status/项目/创建时间的来源行;
- `archived` 条目默认跳过(用户已明确退役;需要时加 `--include-archived`),
  `active` 与 `resolved` 迁移;
- 目标图谱中已存在同名实体时跳过,所以可安全重跑。

## 从旧版迁移

旧版把笔记存成 `<项目根>/.dsh-memory/<分类>/<标题>.md`。这些文件对参考图谱不可见,
导入一次即可(幂等,可重复运行):

```powershell
# 在本仓库根目录执行(要迁移别的项目时,把它的根目录作为第一个参数)
node scripts/migrate-dsh-memory.mjs
node scripts/migrate-dsh-memory.mjs --dry-run   # 先看要导入哪些
```

脚本经**真实 MCP stdio 通道**(与 dsh 用的是同一条:`mcp-server-memory`)调用
`search_nodes` 去重、`create_entities` 写入:实体名是 `<project>/<标题>`,
分类映射为实体类型(`common_pitfalls_experience` → `gotcha` 等),正文连同来源
路径写入 observations。目标图文件是 `MEMORY_FILE_PATH`,未设置时用
`~/.dsh-mcp-reference-memory.jsonl`。**旧笔记不会被删除**,确认导入成功后可自行
归档/删除 `.dsh-memory/`。

> 这个脚本只处理 `.dsh-memory/`。已有的 **Memorix** 记忆请用上面的
> `scripts/migrate-memorix-to-reference.mjs`;两者都只读取旧数据,不会删除或改写
> 来源。

## 配置

只剩一个行为开关;后端参数由参考服务器自己拥有(它的图文件由 MCP 行的
`MEMORY_FILE_PATH` 决定)。默认配置即开即用;覆盖方式是在
`~/.dsh/profiles/desktop/cordis.patch.yml` 追加:

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
corepack pnpm --dir "$env:USERPROFILE\.dsh\profiles\desktop" add "$((Resolve-Path .).Path)\patches\dsh-project-memory"
# 再把 "dsh-project-memory" 追加进 ~/.dsh/profiles/desktop/package.json 的 dsh.profile.bundles
```

插件目录还需要一个指向宿主依赖的 junction(插件 import `@deepseek-ai/dsh-llm`
等宿主包,Node 按仓库侧真实路径解析):

```powershell
New-Item -ItemType Junction -Path "patches\dsh-project-memory\node_modules" -Target "$env:USERPROFILE\.dsh\profiles\node_modules"
# scripts\deploy.ps1 会自动补齐/修复该链接
```

> ⚠️ **不要**再在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里手工 insert
> `project-memory` 条目 —— bundle 层已提供该行(自带 config 默认值),
> 用户层再 insert 同名行会导致下次启动
> `duplicate loader entry id: project-memory` 硬失败。

bundle 登记(profile manifest)属 HMR 监视范围,一般**数秒热生效**;
`~/.dsh/cordis.patch.yml` 里的 MCP 行同样被监视(数秒挂载,日志里能看到
`Knowledge Graph MCP Server running on stdio`)。若插件页卡片缺失再重启桌面端。
卸载:`dsh plugin --profile desktop remove dsh-project-memory` 并从 bundles 列表移除。

## 测试

```powershell
# 仓库根执行一次 npm install 以取得 react / jsdom(浏览器半验证用)
npm install

node patches/dsh-project-memory/tests/plugin.smoke.mjs     # 真实 Cordis 装载:Config 校验 + 提示词/事件流
node patches/dsh-project-memory/tests/client-contract.mjs  # 浏览器半:9 个记忆卡片注册 + 折叠渲染
```

冒烟覆盖:apply 返回值不是 thenable(Invalid effect 回归)、Config 对错误
类型响亮失败而旧键(含 `autoReview`)被容忍、guidance 段落含项目前缀约定与
工具名、`projectSlugOf` 的 basename/尾分隔符/根目录回退、召回在**第一个被准入
的 `agent/pre-step`** 追加进消息批次(不是 followup、不自成一轮、不替换原有
批次)、携带本会话工作区与项目标识、按 agent 只触发一次、被拒绝/中止的步骤不
消耗召回、排除子代理与无工作区会话、**轮次结束/再次空闲后不再产生任何消息**
(旧 autoReview 的噪音回归守卫)。

## 相关文件

- `lib/index.js` — host 半:guidance 段落 + 首个 pre-step 召回
- `client.js` — 浏览器半:九个参考记忆工具的折叠卡片
- `cordis.patch.yml` — bundle 层条目(`autoRecall` 默认值)

> 旧版本地存储实现(`lib/store.js`:相似度合并、成熟度、`.dsh-memory/` 读写)
> 与其单测已在 Memorix 迁移时删除;本版不再有第二套存储。
