# dsh-project-memory

文档化跨会话项目记忆插件。会话中产生的确定性项目知识(重要决策、约定/规范、踩坑经验、接口与数据结构事实)由 Agent 自行判断,以 Markdown 笔记(带 `keywords` / `usage_scenario` 元数据)保存到项目根目录的 `.dsh-memory/` 下;后续会话中 Agent 可以检索这些记忆,让记忆跨会话生效。

## 工作方式

1. **常驻指令**(注入每个会话的 system prompt):
   - 开始实质性工作前 → 先调用 `project_memory_search` 检索既有记忆,遵循既有约定;
   - 完成产生确定性知识的工作后 → 调用 `project_memory_save` 记录(同主题更新而非重复新建)。
2. **三个工具**(每个会话可见):
   - `project_memory_save` — 保存/更新一条记忆笔记
   - `project_memory_search` — 按关键词/标题/使用场景/正文检索记忆(中文分词友好:ASCII 词 + CJK 单字/二元组)
   - `project_memory_list` — 浏览全部记忆(可按分类过滤)
3. **会话完成自动回顾**(配置 `autoReview`,默认开):每轮用户消息被完整回答后,插件向 Agent 发送一条简短回顾消息,由 Agent 自行判断本轮是否产生值得记录的知识;无价值时回复"无需记录"。子代理会话与未完成(中断/出错)的轮次不会触发。
4. **自动更新**:保存同主题笔记即更新(自动沿用已有分类,不产生重复);每次保存/更新都会"再次确认"该记忆(usage_count +1)。
5. **重复清理与相似合并**(配置 `autoDedupe`,默认开):每次保存后自动扫描全库,命中以下任一规则即合并为一篇(保留使用次数最多、其次最早的原笔记;被合并笔记的关键词、使用场景、正文并集后删除):
   - 标题相似度 ≥ 0.8;
   - 内容相似度 ≥ `mergeContentThreshold`(默认 0.55);
   - 内容包含度 ≥ 0.9(一篇正文几乎是另一篇的副本)。
6. **成熟度**(配置 `trackUsage`,默认开):每条记忆带 `usage_count`(保存/更新确认 +1,检索命中 +1),映射为成熟度等级 `new(0-1)` → `developing(2-4)` → `mature(5-9)` → `authoritative(10+)`。检索/列表结果标注成熟度与使用次数,常驻指令提示 Agent:成熟度越高越值得采信,但任何记忆都可能过时,采信前仍应结合当前代码核对。

## 笔记格式

参考 Qoder 记忆格式(YAML front matter + 正文),存放在 `<项目根>/.dsh-memory/<分类>/<标题>.md`:

```markdown
---
title: "禁止使用全限定类名"
category: "development_code_specification"
usage_scenario:
    - "代码审查时检查是否存在冗余全限定类名"
    - "重构代码时清理import后残留的全限定引用"
keywords:
    - "全限定类名"
    - "import"
    - "代码风格"
usage_count: 3
updated_at: "2026-08-14T12:00:00.000Z"
---

禁止在代码中使用全限定类名(如java.util.Map),当已通过import导入对应类时,应统一使用短类名(如Map)。
```

- 项目根 = 会话所属工作区目录(会话 header 的 cwd)
- 分类默认 `general`,可用 `project_introduction` / `development_code_specification` / `common_pitfalls_experience` / `project_tech_stack` 等
- 更新时若省略 category,自动沿用已有笔记的分类,避免产生重复

## 安装

```powershell
dsh plugin --profile web add D:\GitHub\deep-dreaming\patches\dsh-project-memory
# 若 pnpm 不在 PATH(dsh plugin 转发 pnpm),可用 corepack:
# corepack pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" add D:\GitHub\deep-dreaming\patches\dsh-project-memory
```

**再为插件目录建立宿主依赖链接**。插件代码 import `@deepseek-ai/*`(宿主包,
位于 `~/.dsh/profiles/node_modules`);插件虽以 junction 装进 profile,Node 仍
按仓库侧真实路径解析依赖,仓库树内必须暴露宿主 node_modules,否则 `dsh web`
启动会在插件树加载阶段报 `Cannot find package '@deepseek-ai/dsh-llm' ...
(ERR_MODULE_NOT_FOUND)`:

```powershell
New-Item -ItemType Junction -Path "D:\GitHub\deep-dreaming\patches\dsh-project-memory\node_modules" -Target "$env:USERPROFILE\.dsh\profiles\node_modules"
# 或直接运行仓库根目录的 deploy.ps1,自动为所有需要宿主依赖的插件补齐/修复该链接
```

然后**在 `~/.dsh/profiles/web/cordis.patch.yml` 追加启用条目**(pnpm 安装
不会自动把用户级插件注册进 bundle 层):

```yaml
- insert:
    - id: project-memory
      name: 'dsh-project-memory'
```

最后**重启 `dsh web`** 使插件加载(工具、常驻指令、自动回顾随之生效)。

卸载:删除 profile patch 条目 + `dsh plugin --profile web remove dsh-project-memory`,重启生效。

## 如何使用

安装并重启后无需任何手动操作,常驻指令会自动生效。以下是会话中的典型流程:

**首次进入已有项目**

1. 开始实质性工作前,Agent 会先调用 `project_memory_search`(关键词如项目名、
   技术栈),拉出既有记忆 —— 新项目首次检索结果为空,属正常。
2. 工作过程中产生了确定性知识(例如"本仓库约定:补丁统一放在 `patches/`
   目录,每个补丁自带 README"),在轮次结束时由 Agent 调用
   `project_memory_save` 记录。
3. 后续轮次/后续会话再次检索到该记忆,Agent 会遵循其中的约定继续工作。

**主动查看与管理**

- 让 Agent「列出项目记忆」→ 触发 `project_memory_list`,可看到全部笔记及
  分类、成熟度、使用次数。
- 笔记即普通 Markdown 文件,位于 `<项目根>/.dsh-memory/<分类>/<标题>.md`,
  也可直接用编辑器查看/手工编辑(注意保持 front matter 格式)。

**自动回顾(autoReview,默认开)**

- 每轮用户消息被完整回答后,插件会向 Agent 发送一条回顾消息;若本轮确实
  产生了值得记录的知识,Agent 会自行调用 `project_memory_save`,否则回复
  "无需记录",不产生任何文件。
- 子代理会话与未完成(中断/出错)的轮次不会触发回顾。

**验证插件已生效**

- 新开会话,在 system prompt 中应能看到"开始实质性工作前先检索项目记忆"
  之类的常驻指令;
- 或直接询问 Agent「你有哪些工具可用」,应包含 `project_memory_save` /
  `project_memory_search` / `project_memory_list` 三个工具。

## 配置

默认配置即开即用。如需覆盖,在 `~/.dsh/profiles/web/cordis.patch.yml` 中追加:

```yaml
- id: project-memory
  config:
    autoReview: false            # 关闭会话完成自动回顾(仍可用工具手动记录/检索)
    memoryDirName: '.dsh-memory' # 记忆目录名
    autoDedupe: true             # 保存后自动清理重复/合并相似记忆
    mergeContentThreshold: 0.55  # 内容相似度合并阈值 (0.1..0.95)
    trackUsage: true             # 检索命中/保存确认计入使用次数(成熟度)
```

## 测试

```powershell
# store 纯逻辑单测(无需 dsh 运行时):相似度/合并/成熟度/使用计数等
node tests/store.test.mjs

# 插件冒烟测试:需要 node_modules 能解析 @deepseek-ai/* 依赖
# (先运行 scripts/deploy.ps1 自动建立链接,或手工建 junction:
#  node_modules -> ~/.dsh/profiles/node_modules)
node tests/plugin.smoke.mjs
```
