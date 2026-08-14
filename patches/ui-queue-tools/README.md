# 排队消息增强 —— hover 全文预览 + 排序(用户级 dsh 插件)

增强输入区上方的**排队消息停靠栏**(Queue Dock:Agent 忙时连发的消息排队显示
的地方),提供:

1. **hover 预览全文**:把鼠标悬停在排队消息上即可看到完整文本(官方实现
   只显示 200 字符截断预览,无全文入口);
2. **排序**:每条排队消息增加**上移 / 下移**按钮,可调整发送顺序(队列按
   FIFO 发送,排序即调整谁先被发送)。

其余行为(折叠计数头、编辑、删除、插话发送)与官方一致。

## 工作原理

- **Client 半(`lib/client.js`)**:以 `priority: -10` 注册
  `conversation.input.dock` 槽位的同 id `queue` 条目,shadow 掉官方停靠栏
  (槽位注册表按 priority 渲染最低者)。组件复刻官方行为,新增:
  - 预览 `span` 增加 `title` 属性(hover 显示完整文本);
  - 每行两个排序按钮(上移/下移,首行上移、末行下移自动禁用),调用
    `/queue` 通道的 `reorder` RPC。
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
# 1. 建立指向本目录的目录联接(junction)
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-queue-tools" -Target "D:\GitHub\deep-dreaming\patches\ui-queue-tools"
```

2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 中追加启用条目:

```yaml
- insert:
    - id: ui-queue-tools
      name: '@local/dsh-client-ui-queue-tools'
```

3. **重启 dsh web**(当前运行方式下 patch 热加载不可靠),刷新页面后生效。

## 如何使用

1. Agent 运行中连发多条消息,后续消息进入输入区上方的排队停靠栏。
2. **预览全文**:鼠标悬停任意排队消息,显示完整文本。
3. **排序**:展开停靠栏(多条时点击计数头),点击消息右侧的 **↑ / ↓**
   调整顺序;首条的上移、末条的下移不可用。排序在 Agent 空闲或运行中
   均可进行(运行中排队项仍可重排,但已被消费的消息会提示失败)。

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
node verify-queue-tools.mjs             # 在本补丁目录下运行
```

覆盖:host 半 `/queue` 通道与参数校验、重排语义(下移/上移/置顶/置底/
不存在/单条/next-step)、client 半 shadow 注册(priority)、hover 全文
title、上移/下移按钮的 RPC 参数、单条消息隐藏排序控件。
