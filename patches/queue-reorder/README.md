# queue-reorder — 排队消息拖拽排序

DSH 的排队消息（agent 正在跑的时候再发的那几条）**官方没有任何更改顺序的方式**：
会话控制器的 `QueueAction` 只有 `edit` / `remove` / `steer` 三个分支
（`packages/api/session-controller/src/types.ts:142`），队列坞（QueueDock）也只
渲染删除与插话按钮。这个补丁补上「拖动换顺序」。

## 与已归档的 ui-queue-tools 的区别

`ui-queue-tools`（2026-11-06 退役，见 `archive/patches/ui-queue-tools`）做的事更
多，但形态是**整坞接管**：用同一个 `conversation.input.dock` 的 `id: 'queue'` 加
`priority: -10` 压过官方那一项，把整个队列坞重画一遍。代价是官方以后给这个坞加的
任何东西（后来的多行 InlineEditor、5 处 Tooltip、附件 chip、steer 按钮、折叠计数）
都会被补丁版本挡住，且每版都要人工对齐一遍。

`queue-reorder` 不接管：

- 官方坞照常渲染，多行编辑 / 删除 / 插话 / 附件 / 折叠全是官方自己的行为。
- 本插件注册的是**另一个** `id`（`queue-reorder`，`order: 30`）。`list` 槽按
  `id` 分格，**同 id 才遮蔽**，所以两项并存。
- 那个组件渲染 `null`，只用来拿会话作用域的标准 props
  （`useProjection('inbox')` / `useSession`），并在每次渲染后给官方行打属性。

净效果：官方队列坞升级时，本插件大概率什么都不用改；只有官方行结构本身变了才会
被下面那条源码守卫测试点出来。

## 为什么需要一个宿主端点

顺序不在客户端决定。一次拖放调用 `POST /queue-reorder/reorder`，宿主半按标准的
inbox splice 语义把消息从原位置摘下、插到目标位置
（`packages/core/agent-loop/src/inbox.ts`）。这一步会持久化成
`agent/inbox/spliced` 事件，再广播给所有客户端——所以前端**不做乐观重排**：拖完
之后界面上的顺序来自宿主事件，与其它客户端、与刷新后的会话完全一致。

请求体：

```json
{ "args": { "sessionId": "…", "itemId": "…", "toIndex": 1, "placement": "queued" } }
```

`placement` 是调用方据以计算 `toIndex` 的列表。坞只渲染 `next-turn`
（`queued`），所以位于 `next-step` 的消息会被拒绝为
`queue-item-placement-mismatch`，而不是被套上一个外来索引。

失败码：`bad-request` / `session-not-found` / `queue-item-not-found` /
`queue-item-placement-mismatch` / `queue-reorder-failed`。

宿主半的 `reorderQueueItem()` 在摘除之前校验两个位置，插入被拒绝时会把消息放回
原处——一次失败的重排绝不会丢消息。

## 它是怎么找到「哪一行是哪条消息」的

官方 `QueueDock.tsx` 的行是 `<li key={row.id}>`：消息 id 只存在于 React 的 key
里，DOM 上**没有**。所以只能靠顺序对齐：

- 官方渲染的持久行顺序 = `inbox['next-turn']` 减去「已进 transcript 的本地提交」
  回显（`QueueDock.tsx` 里的 `queue` useMemo）。
- `visibleQueue()` 逐字复刻这条过滤；`stampRows()` 按序号把
  `data-queue-reorder-id="<消息 id>"` 写到对应行上。
- 行数与 id 数对不上时不打任何标记——宁可暂时不能拖，也不把消息搬到错误位置。

依赖的官方 DOM 契约只有三条：坞根节点带 `data-queue-dock`、持久行是 `li`、本地
回显行带 `data-submission-echo`。`tests/official-dock-contract.mjs` 直接读官方
源码检查这三条，并与本插件的常量交叉比对；一旦官方改形状，`npm test` 会先失败，
而不是让拖拽在运行时静默错位。

## 交互细节

- 只有超过一行、且该会话允许队列变更（与官方坞的 `queueMutable` 同一条判据：
  主会话，或 `continuable` 子代理）时才可拖。
- 按在按钮/输入框上不触发拖拽，官方坞的编辑、删除、插话按钮照常工作。
- 内联编辑中的行不参与拖拽（拖拽会抢走 textarea 的选区）。
- 本地排队回显行（`data-submission-echo`，宿主还没发布 inbox 行）不参与拖拽。

## 端点

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/queue-reorder/reorder` | 把一条待发消息移到同一列表的目标下标 |

围栏与其它补丁一致：`Origin` 必须与 `Host` 同源、只收 POST、只收
`application/json`。

## 测试

```powershell
node patches/queue-reorder/tests/load-smoke.mjs            # 真实 Cordis 装载 + 路由围栏
node patches/queue-reorder/tests/client-contract.mjs        # jsdom：装饰官方行 + 拖放换算
node patches/queue-reorder/tests/official-dock-contract.mjs # 官方 QueueDock 源码契约守卫
```