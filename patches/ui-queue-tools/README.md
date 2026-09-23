# 排队消息增强 —— hover 全文预览 + 排序(用户级 dsh 插件)

增强输入区上方的**排队消息停靠栏**(Queue Dock:Agent 忙时连发的消息排队显示
的地方),提供:

1. **hover 预览全文**:把鼠标悬停在排队消息上即可看到完整文本 —— 使用与
   操作按钮一致的 Tooltip 样式(500ms 延迟,气泡展示全文;官方实现只显示
   200 字符截断预览,无全文入口);
2. **拖拽排序**:直接**拖动**排队消息行到目标位置即可调整发送顺序(队列按
   FIFO 发送,排序即调整谁先被发送);拖拽中目标行高亮,被拖行半透明。

其余行为(折叠计数头、编辑、删除、插话发送)与官方一致,其中**编辑**做了
多行优化:编辑框为自适应高度的 `textarea` —— 内容自动换行,长消息的前文
始终可见,不再需要横向滚动;`Enter` 提交、`Shift+Enter` 换行、`Esc` 取消。

## 工作原理

- **Client 半(`lib/client.js`)**:以 `priority: -10` 注册
  `conversation.input.dock` 槽位的同 id `queue` 条目,shadow 掉官方停靠栏
  (槽位注册表按 priority 渲染最低者)。组件复刻官方行为,新增:
  - 预览包一层 `Tooltip`(label = 完整文本,`delayMs: 500`,与操作按钮
    一致的交互样式);
  - 行 `draggable` + `dragstart/dragover/drop` 事件:拖到目标行即向宿主
    `POST /queue/reorder`(目标位置 = 目标行的最终索引,body 为
    `{ args: { sessionId, itemId, toIndex, placement } }`);
  - 编辑框为自适应高度 `textarea`(自动换行,`scrollHeight` 跟随内容,
    上限 112px 内滚动),`Enter` 提交 / `Shift+Enter` 换行 / `Esc` 取消;
  - 编辑按钮 `onMouseDown` 阻止默认 focus —— 修复"点击编辑后焦点触发的
    tooltip 残留/误现"问题(键盘 Tab 聚焦不受影响,键盘路径仍即时显示
    tooltip)。
- **Host 半(`lib/index.js`)**:在 `webServer` 上注册**前缀路由** `/queue`
  (`ctx.inject(['webServer', 'agents'], …)` —— 载体是**声明的依赖**,激活等待它
  就绪,而不是 `ctx.get('webServer')` 与载体绑定竞态;路由本身经
  `ctx.effect(...)` 持有,自带同源栅栏:非 POST → 405、
  非 `application/json` → 415、`Origin` 与 `Host` 不同 → 403)。**不再**用
  `ctx.connection.rpc.handle`:dsh 0.1.5-rc.1 的 Connection 注册表会对外部插件
  抛 `cannot get property "webServer" without inject`,通道根本不存在,浏览器
  请求会落到 SPA 兜底(405/404)。`reorder` 端点先按 `itemId` 在 agent inbox
  的两个待发列表(`next-turn` / `next-step`)中定位条目,校验调用方声明的
  `placement` 与条目实际所在列表一致后,再用 Inbox 的标准 `splice` 语义重排
  —— 与官方 append/remove 走同一条 durable 事件通道
  (`agent/inbox/spliced`),所有客户端自动收到新顺序,无需本地乐观更新。
- 排队停靠栏只渲染 `placement === 'queued'`(即 `next-turn`)项,因此客户端
  每次重排都声明 `placement: 'queued'`,`toIndex` 就是该列表内的最终位置;
  若条目实际位于 `next-step`(`steering` / `context`),host 返回
  `queue-item-placement-mismatch`,不会把该索引施加到另一个列表上。
- 重排是「先校验、再摘出、再插回」的原子步骤:两个索引在改动列表前都已
  校验,插回失败时会把消息还原到原位置并返回 `queue-reorder-failed`,
  不会丢消息。

## 部署(加载到 dsh)

与 ui-settings-* 插件相同的机制:

```powershell
# 在仓库根执行:\$repo = (Resolve-Path .).Path
# 1. 建立指向本目录的目录联接(junction)
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-queue-tools" -Target "$repo\patches\ui-queue-tools"
```

2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 中追加启用条目:

```yaml
- insert:
    - id: ui-queue-tools
      name: '@local/dsh-client-ui-queue-tools'
```

3. **保存即生效,无需重启**:dsh web 对 `cordis.patch.yml` 内置热加载
   (`watchUserPatches`),条目增删/配置修改保存后数秒内事务性生效(host 与
   client 半都重新装载),**不中断会话** —— 前提是文件内容确有真实变化
   (增删行、改 `config`);`Entry.update` 对 options 做深比较,只改注释、
   或写回一份内容等价的文件都**不会**触发重挂。
   **修改本补丁源码后需重启 dsh web** 才生效。

## 如何使用

1. Agent 运行中连发多条消息,后续消息进入输入区上方的排队停靠栏。
2. **预览全文**:鼠标悬停任意排队消息,气泡显示完整文本(与按钮提示同款
   样式)。
3. **拖拽排序**:展开停靠栏(多条时点击计数头),**按住并拖动**消息行到
   目标位置松开即可;被拖行半透明、目标行虚线高亮。排序在 Agent 空闲或
   运行中均可进行(运行中排队项仍可重排,但已被消费的消息会提示失败)。

## 卸载

1. 删除 `~/.dsh/profiles/web/cordis.patch.yml` 中的 `ui-queue-tools` 条目;
2. 删除 `~/.dsh/profiles/node_modules/@local/dsh-client-ui-queue-tools`
   链接;
3. 重启 dsh web(官方停靠栏恢复)。

## 注意事项

- 停靠栏只对**排队中**的消息(`placement === 'queued'`,即 `next-turn`
  列表)提供排序;host 侧的 `reorderQueueItem` 本身仍是列表无关的纯函数,
  但 `/queue` 端点要求调用方声明 `placement`,与条目实际所在列表不一致时
  返回 `queue-item-placement-mismatch`,因此 `toIndex` 不会被施加到
  `next-step` 等另一个列表上。「插话发送」中的临时消息(`steering`)不在
  停靠栏显示,不受影响。
- 若消息在排序请求到达前已被 Agent 消费(开始发送),host 返回
  `queue-item-not-found`,停靠栏提示失败并随下一帧刷新。
- 若会话已经没有活跃 agent(条目无从谈起),host 返回 `session-not-found`;
  `queue-item-not-found` 只表示「会话在、条目已不在」。
- shadow 依赖 slot 注册表的 priority 语义;若未来官方停靠栏注册了更低
  priority,本补丁会被官方反超,届时删除本补丁即可。
- 客户端样式为官方 QueueDock 样式规则的自有类名复刻,不依赖官方 CSS。

## 测试

```powershell
# 在仓库根执行:\$repo = (Resolve-Path .).Path
node verify-queue-tools.mjs             # 在本补丁目录下运行
node tests/load-smoke.mjs               # 真实 Cordis 加载冒烟(需能解析到 @deepseek-ai/cordis,
                                        # 见 tests/load-smoke.mjs 文件头注释)
```

覆盖:host 半 `/queue` 前缀路由注册与栅栏(403 跨源 / 405 非 POST /
415 非 JSON / 404 端点为空或多段、400 非 JSON body、413 超大 body)、载体为
声明依赖 `webServer,agents`(载体缺席时回调不运行、绝不注册任何东西;载体出现
即注册 —— 等待语义,本目录 `tests/load-smoke.mjs` 用真实 Cordis 的迟到
`provide('webServer')` 验证)、参数校验
(sessionId / itemId / toIndex / placement)、`session-not-found` 与
`queue-item-not-found` 的区分、重排语义
(下移/上移/置顶/置底/不存在/单条/next-step)、placement 守卫(声明与条目
实际列表不一致时拒绝且不改动任何列表)、插回失败时还原原消息(注入会抛错的
inbox,断言消息不丢且不误报成功)、apply 不返回 thenable(回归守卫)、client
半 shadow 注册(priority)、`inject` 不含未使用的服务(`conversation` 与
`connection`)、重排请求打到 `POST /queue/reorder`(`content-type` + body 携带
`placement`)且宿主拒绝(信封 / HTTP / 网络错误)时抛错、hover 全文 Tooltip
气泡、拖拽排序的请求参数、编辑态无焦点 tooltip 残留、单条消息隐藏拖拽能力
(jsdom 交互部分在 `jsdom`/`@testing-library/react` 可解析时运行,否则跳过并提示)。
