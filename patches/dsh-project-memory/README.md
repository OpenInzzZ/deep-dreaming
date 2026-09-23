# dsh-project-memory —— Memorix 记忆桥(自动召回 / 自动回顾)

**本插件不再自己存记忆。** 它是 Memorix(MCP)与本仓库之间的轻量桥:
**存储、检索、去重、成熟度全部由 Memorix 负责**,本插件只负责在合适的
时机提醒 Agent 去调用 `mcp__memorix__*` 工具。

- 插件类型:组合包插件(bundle,包名 `dsh-project-memory`),条目
  `project-memory` 定义在包自带的 `cordis.patch.yml`,经 package.json 的
  `dsh.bundle.patch` 装载;不修改 dsh 源码。
- 不再提供 `project_memory_save` / `project_memory_search` /
  `project_memory_list` 三个工具(上一代实现),也不再需要
  `@deepseek-ai/dsh-tools`。
- 现在只剩三个动作:注入常驻提示段、会话开始排队一次「召回」、每轮完整
  结束后排队一次「回顾」。

## 三个动作

### 1. 常驻提示段(注入每个会话的 system prompt)

`lib/index.js:180-186` 向 `systemPrompt` 注册名为 `project-memory:guidance`、
`order: 60` 的段落,正文是 `lib/index.js:56-64` 的 `<project_memory>` 段,告诉
Agent:记忆由 Memorix 维护,会话开始先绑定 + 检索,产生确定性知识后保存,
需要细节/摘要时用 `mcp__memorix__memorix_detail` /
`mcp__memorix__memorix_project_context`,且只记录事实与结论。

### 2. 会话开始自动召回(`autoRecall`,默认开)

`lib/index.js:152-177`。会话收到**第一条真实用户消息**时,插件立即
`followup` 一条「项目记忆召回 · memory search」提示(`lib/index.js:67-68`),
要求 Agent:

1. 先调用 `mcp__memorix__memorix_session_start`,用 `projectRoot` 参数把当前
   工作目录绑定为项目根目录;
2. 再调用 `mcp__memorix__memorix_search` 检索与本任务/本项目相关的既有记忆
   (项目约定、关键决策、踩坑经验、接口或数据结构事实等),遵循既有约定、
   避免重复探索;检索为空则直接开始工作。

每次会话**最多一次**(按 agent 记在 `recalled` 集合里,`agent/disposed` 时清理)。

### 3. 每轮完成自动回顾(`autoReview`,默认开)

`lib/index.js:100-146`。用户消息 → 轮次以 `turn/end` 且
`reason.kind === 'completed'` 结束 → Agent 进入 `idle` 时,插件 `followup` 一条
「项目记忆回顾 · memory save/update」提示(`lib/index.js:75-76`):由 Agent 自行
判断本轮是否产生了值得跨会话保留的知识,有则直接调用
`mcp__memorix__memorix_store`(同主题更新、否则新建),没有则直接结束本轮,
不输出分析文字。保存结果本身会渲染成「记忆 · 保存/更新」卡片,所以提示
额外要求 Agent 不要复述。

## 生效条件与边界

- **可回顾会话**(`reviewable(agent)`,`lib/index.js:83-88`):会话 header 存在、
  `header.origin !== 'subagent'`、`header.cwd` 为非空字符串。**子会话(子代理)
  既不做召回也不做回顾**;没有工作目录的会话同理。
- **只在完整轮次后回顾**:`turn/end` 的 `reason.kind` 不是 `completed`
  (中断 / 出错 / 达到 token 上限)时,挂起的回顾会被清除;`agent/status`
  只有 `idle` 才触发投递。
- **自己的提示不会再次触发**:召回与回顾消息的 source 是
  `{ kind: 'plugin', plugin: 'project-memory', form: 'notice', summary: … }`,
  `isOwnNotice`(`lib/index.js:94-96`)据此识别并跳过,避免召回→回顾→召回
  自我循环。提示在会话里渲染成官方 **context notice**(折叠一行摘要,展开
  可见全文),不占用普通对话气泡。
- 插件**不探测 Memorix 是否可用**:Memorix 没装好时,提示照常注入/投递,
  但 Agent 调不到 `mcp__memorix__*` 工具,只会空转——请先完成下面的
  「前置条件」。

## 配置

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `autoRecall` | `true` | 会话首条真实用户消息时排队一次召回提示;`false` 关闭 |
| `autoReview` | `true` | 每轮 `completed` 结束后排队一次回顾提示;`false` 关闭 |

`Config` schema 见 `lib/index.js:37-44`,**只接受这两个布尔键**;键名写错或
填了上一代的 `memoryDirName` / `autoDedupe` / `mergeContentThreshold` /
`trackUsage`(这些现在归 Memorix 自己的配置管:`memorix.toml` /
`~/.memorix/config.toml`),装载时会直接报 `invalid config` 硬失败。

配置入口是**条目 `config`**,即包自带的 `cordis.patch.yml`(仓库内
`patches/dsh-project-memory/cordis.patch.yml`,默认已写 `true` / `true`):

```yaml
- insert:
    - id: project-memory
      name: 'dsh-project-memory'
      config:
        autoRecall: true
        autoReview: true
```

改完需**重启 dsh web** 生效。本插件没有注册 settings 命名空间,因此设置页
不提供它的配置卡片。

> ⚠️ bundle 层已经提供 `project-memory` 这一行,**不要**再在
> `~/.dsh/profiles/web/cordis.patch.yml` 里手工 insert 同名条目,否则下次
> 启动会以 `duplicate loader entry id: project-memory` 硬失败。

## 浏览器半:记忆折叠卡

`client.js` 通过 `dsh.client` 声明装载,把 Memorix 的 MCP 工具调用渲染成
**可折叠的「记忆」卡片**(与官方「Think」推理行同款组件 `DisclosureRow`,
图标 + 标题 + 状态点 + 一行摘要,默认折叠,点击展开看完整结果):

| 工具 | 卡片标题 |
| --- | --- |
| `mcp__memorix__memorix_session_start` | 记忆 · 绑定项目/会话开始 |
| `mcp__memorix__memorix_search` | 记忆 · 检索 |
| `mcp__memorix__memorix_store` | 记忆 · 保存/更新 |
| `mcp__memorix__memorix_project_context` | 记忆 · 任务上下文 |
| `mcp__memorix__memorix_detail` | 记忆 · 详情 |

映射表在 `client.js:55-68`,每个 key 通过 `ctx.slots.inject('tool.call.toolview', …)`
注册(`client.js:144-151`);召回提示要求 Agent **先**调
`mcp__memorix__memorix_session_start`,所以它同样在映射里,否则会落到默认
工具卡片。未知工具名回退为「记忆」标题 + 默认图标;执行中显示「运行中…」,
失败显示「失败」。修改 `client.js` 后需重启 dsh web 生效。

## 安装与前置条件

### 1. 前置:Memorix 自身

本插件的工具全部来自 Memorix,先把 Memorix 装好并接进 dsh
(`scripts/install.ps1` 第 3.5 步做的就是这个;`-SkipMemorix` 可跳过):

```powershell
npm install -g memorix          # 安装 memorix CLI
memorix setup --agent dsh --global   # 写入 dsh 的 MCP 客户端条目(含 memory-memorix)
```

装好后会话里才会出现 `mcp__memorix__*` 工具。Memorix 的记忆存储由它自己
管理(项目里的 `.dsh-memory/` 属于上一代实现,见文末「遗留文件」)。

### 2. 安装本插件(bundle 方式)

```powershell
# 在仓库根执行:$repo = (Resolve-Path .).Path
dsh plugin --profile web add $repo\patches\dsh-project-memory
# 若 pnpm 不在 PATH(dsh plugin 转发 pnpm),可用 corepack:
# corepack pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" add $repo\patches\dsh-project-memory

# 宿主依赖链接:插件 import @deepseek-ai/*(位于 ~/.dsh/profiles/node_modules),
# 缺链接会在启动时报 Cannot find package '@deepseek-ai/dsh-llm' (ERR_MODULE_NOT_FOUND)
New-Item -ItemType Junction -Path "$repo\patches\dsh-project-memory\node_modules" -Target "$env:USERPROFILE\.dsh\profiles\node_modules"
```

pnpm 安装不会自动注册组合层,还需把 `dsh-project-memory` 追加进
`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`(`dsh plugin add`
会做)。`scripts\install.ps1`(幂等)与 `scripts\deploy.ps1` 覆盖上述全部步骤。

最后**重启 dsh web**;卸载用 `dsh plugin --profile web remove dsh-project-memory`
并从 bundles 列表移除,重启生效。

### 3. 验证已生效

- 新会话的 system prompt 里应能看到 `<project_memory>` 段;
- 发出第一条消息后,会话里应出现「记忆 · 绑定项目/会话开始」与
  「记忆 · 检索」两张折叠卡(说明 `mcp__memorix__*` 工具确实可用);
- 每轮回答完成后应出现「记忆 · 保存/更新」卡片,或 Agent 判断无需记录
  (无卡片)。

## 测试

在仓库根执行:

```powershell
node patches/dsh-project-memory/tests/store.test.mjs        # 遗留 store 纯逻辑单测
node patches/dsh-project-memory/tests/plugin.smoke.mjs      # 真实 Cordis 装载冒烟
node patches/dsh-project-memory/tests/client-contract.mjs   # 浏览器半契约(jsdom 可选)
```

- `store.test.mjs`:只覆盖**遗留**的 `lib/store.js`(清洗标题、front matter
  渲染/解析往返、成熟度、检索打分、相似度合并等纯逻辑),**不覆盖当前
  Memorix 桥的任何行为**。它需要可读的 `lib/store.js`,与运行时无关。
- `plugin.smoke.mjs`:`ctx.plugin()` 真装载 `lib/index.js`(stub `systemPrompt` /
  `agents` 两个服务),验证 Config 校验对错误类型硬失败、guidance 段已注册且
  指向 Memorix 工具、`apply` 不返回 thenable(`Invalid effect` 回归守卫)、
  autoReview 事件流(completed 轮次 → idle 触发、自身消息不重复武装、aborted
  轮次清除、子代理排除)、autoRecall(首条用户消息触发且仅一次、子代理排除)。
  需要 `node_modules` 能解析 `@deepseek-ai/*`(先跑 `scripts\deploy.ps1`)。
- `client-contract.mjs`:按浏览器内核的方式加载真实 `client.js`,校验模块表
  词表未越界(`react` / `react/jsx-runtime` /
  `@deepseek-ai/dsh-client-ui-primitives`)、`exports.inject` 与 `TITLES`
  覆盖表精确等于上表五个工具、每个 key 都注册了 `tool.call.toolview`;装了
  jsdom 时再渲染已完成的「保存/更新」卡(默认折叠 → 点击展开全文)与执行中
  的「检索」卡(保持折叠、摘要「运行中…」)。jsdom 缺失时渲染段自动跳过。

## 遗留文件

`lib/store.js` 是**上一代完整记忆实现的遗留模块**:运行时已不再被
`lib/index.js`、`client.js` 引用,也不在 package.json 的 `exports` 里,
仅剩 `tests/store.test.mjs` 覆盖它;它的职责已被 Memorix 取代。按项目约定
(先保留 `store.js` 与 `.dsh-memory/`,确认 Memorix 工作流满意后再清理)
**暂时保留、不要在其上继续开发**,也不要因为「零引用」而删除。
