# dom-inspect —— 浏览器 DOM 快照工具(验证插件渲染)

为 agent 提供 `dom_inspect` 工具:返回 dsh Web 页面当前渲染的
**记忆相关 DOM 快照**(记忆折叠卡、DisclosureRow 折叠行、摘要、关键词),
让 agent 无需截图即可核实插件渲染效果(折叠状态、关键词行、notice 行)。

## 工作方式

- **Client 半(`lib/client.js`)**:页面加载后每 2 秒采集一次固定选择器组的
  DOM(仅叶字段:tag / class / data-* / aria-expanded / 截断文本 / 子元素
  数,不序列化活对象),与上次对比**有变化才推送**;经 `/dom-inspect` RPC
  通道(loopback)推给 host。
- **Host 半(`lib/index.js`)**:内存保存最新快照,注册模型工具 `dom_inspect`
  —— 返回快照 + 采集时间与时效(ageMs);无快照时返回 `available:false`
  (页面未加载或 client 半未挂载)。

固定采集组(与记忆插件对应的选择器):

| 组 | 选择器 | 内容 |
| --- | --- | --- |
| `memory-cards` | `[data-memory-card]` | 记忆折叠卡(状态、文本、子元素) |
| `disclosure-rows` | `[data-disclosure-row]` | Think/记忆折叠行(aria-expanded) |
| `pmem-summaries` | `.pmem-summary` | 折叠行摘要 |
| `pmem-keywords` | `.pmem-keywords` | 折叠行关键词 |

## 部署

与其他 @local 补丁相同:junction 链接 + profile patch 条目
(条目增删热生效,无需重启;client 源码变更才需重启):

```powershell
# 在仓库根执行:\$repo = (Resolve-Path .).Path
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-plugin-dom-inspect" -Target "$repo\patches\dom-inspect"
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: dom-inspect
      name: '@local/dsh-plugin-dom-inspect'
```

## 使用

直接让 agent「检查页面记忆卡 DOM」——agent 调用 `dom_inspect`,返回:

```
DOM snapshot at 2026-08-15T… (age 120ms)
memory cards: 2 | disclosure rows: 3
  - 记忆 · 保存/更新已保存:测试笔记测试、笔记
```

由此核对:卡片是否默认折叠(`aria-expanded="false"`)、关键词是否上折叠行、
notice 行是否存在等。

## 卸载

删除 patch 条目 + `node_modules/@local/dsh-plugin-dom-inspect` 链接(热生效)。

## 测试

```powershell
# 在仓库根执行:\$repo = (Resolve-Path .).Path
node patches/dom-inspect/tests/load-smoke.mjs          # 真实 Cordis:工具+通道端到端
node patches/dom-inspect/tests/client-contract.mjs      # client 契约 + collect/apply(需 jsdom)
```
