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
  - 行 `draggable` + `dragstart/dragover/drop` 事件:拖到目标行即调用
    `/queue` 通道的 `reorder` RPC(目标位置 = 目标行的最终索引);
  - 编辑框为自适应高度 `textarea`(自动换行,`scrollHeight` 跟随内容,
    上限 112px 内滚动),`Enter` 提交 / `Shift+Enter` 换行 / `Esc` 取消;
  - 编辑按钮 `onMouseDown` 阻止默认 focus —— 修复"点击编辑后焦点触发的
    tooltip 残留/误现"问题(键盘 Tab 聚焦不受影响,键盘路径仍即时显示
    tooltip)。
- **Host 半(`lib/index.js`)**:注册独立 RPC 通道 `/queue`(`loopback`
  权限)。`reorder` 端点按 `itemId` 定位 agent inbox 的 `next-turn` 列表,
  用 Inbox 的标准 `splice` 语义重排 —— 与官方 append/remove 走同一条
  durable 事件通道(`agent/inbox/spliced`),所有客户端自动收到新顺序,
  无需本地乐观更新。
- 排队停靠栏只渲染 `next-turn` 项,因此 `toIndex` 就是该列表内的最终
  位置,语义简单。

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
   client 半都重新装载);也可在设置 →「其他」页点 **重载用户插件** 手动
   触发。**修改本补丁源码后需重启 dsh web** 才生效。

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

- 排序仅作用于**排队中**(placement `queued`,即 next-turn)的消息;
  「插话发送」中的临时消息不在停靠栏显示,不受影响。
- 若消息在排序请求到达前已被 Agent 消费(开始发送),host 返回
  `queue-item-not-found`,停靠栏提示失败并随下一帧刷新。
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

覆盖:host 半 `/queue` 通道与参数校验、重排语义(下移/上移/置顶/置底/
不存在/单条/next-step)、apply 不返回 thenable(回归守卫)、client 半
shadow 注册(priority)、hover 全文 Tooltip 气泡、拖拽排序的 RPC 参数、
编辑态无焦点 tooltip 残留、单条消息隐藏拖拽能力(jsdom 交互部分在
`jsdom`/`@testing-library/react` 可解析时运行,否则跳过并提示)。
