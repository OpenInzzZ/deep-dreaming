# session-cleanup —— 已归档会话的物理删除插件

为 DSH 的**已归档会话**提供手动物理删除：在设置页看到全部归档会话及其磁盘占用，
勾选后删除；也可以直接右键某条已归档会话删除。

> **本插件不做任何自动清理。** 没有定时器、没有保留天数、没有容量上限 —— 删不删、
> 删哪些，完全由你点击决定。这是 2026-11-06 的一次有意收缩：此前它会按天数/容量
> 在后台删除会话，对「不想让任何东西替我删日志」的场景风险过高。

- 插件类型：**bundle**（包名 `@local/dsh-plugin-session-cleanup`），loader 行由
  包内 `cordis.patch.yml` 自带，通过 pnpm link 进 profile + 登记
  `dsh.profile.bundles` 装载，不修改 dsh 源码。
- 「已归档」的权威来源是 `workspaceRegistry.archivedSessionIds`（官方「归档会话」
  写的那份持久集合），**不是**按目录名推测。未归档的会话永远不在列表里，
  也永远删不掉。
- 删除粒度是**整个会话目录** `<sessions根>/<projectKey>/<encodeSegment(id)>/`，
  与官方 `session-persistence-jsonl` 的 `sessionDir()` 一致。也就是说删除的
  不只是日志，还包括该会话目录下的其它产物（附件、检查点等）——确认弹窗会
  如实列出目录与占用大小。

## 安装与部署

推荐仓库根一键：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

手工方式（路径用变量，不写死）：

```powershell
# 在仓库根执行：$repo = (Resolve-Path .).Path
# 先删掉 profile 层旧的 - insert: 行(若存在)，避免两层同 id 启动中断
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
    plugin --profile desktop add "$repo\patches\session-cleanup"
```

CLI 检测到包声明的 `dsh.bundle` 后会自动完成 pnpm link + 登记
`dsh.profile.bundles`；loader 行来自包内 `cordis.patch.yml`（见该文件）。

> ⚠️ **不要**再往 `~/.dsh/profiles/desktop/cordis.patch.yml` 手工
> `- insert:` 本插件的行 —— 两层同 id 会让下次启动 fail-loud 中断
> (`TypeError: duplicate loader entry id`)。`scripts/deploy.ps1` 会检测这一状态。

配置写进设置文档后**即时生效**；改包内 `cordis.patch.yml` 的行结构需重启
（bundle 层文件不在 HMR 监视范围）。**修改本补丁源码后需重启 DSH 桌面端**
才生效（`scripts/restart-desktop.ps1`）。

## 如何使用

### 设置页：已归档会话列表

**设置 → 会话清理**，展开卡片：

1. 上半部分是插件开关与会话根目录；
2. 下半部分「已归档会话」每条显示**项目名**（如 `D-GitHub-deep-dreaming`）作为
   标题，副行是「最后修改时间 · 占用大小 · 会话 id」，顶部显示合计占用；
3. 勾选一条或多条（或点「全选」），点 **删除所选**；也可以点某条右侧的
   **删除** 单独删它；
4. 弹出**二次确认**，列出将删除的目录与总占用，并提示不可撤销；
5. 确认后目录被真正删除，列表自动刷新，并提示释放了多少空间。

> **为什么标题是项目名而不是会话标题**：会话标题是事件流里的 `session/title`
> 事件，**不在 `SessionHeader` 里**（header 只有 id / createdAt / cwd / 父会话等）。
> 官方读标题的接口（`sessionTitle.snapshotOf(session)`、
> `projectionHandle.stateOf(session)`）都要一个**活的 Session 对象**，而归档会话
> 恰恰没有被打开；`sessionPersistence.list()` 又只返回 header、明确不读事件日志。
> 要拿到真实标题就得解压每个归档日志的 zstd（本机单个 1.6–4.7 MB），那会让
> 「打开设置页」变成一次批量解码。本插件因此只做文件系统层面的 stat/rm，
> 用已经在手的项目名 + 时间 + 大小来区分会话——同项目下靠时间与大小即可分辨。

正在运行的会话即使已归档也会被标记为「正在运行，不可删除」，无法勾选。
归档集合里残留、但磁盘上已无对应目录的记录会被**自动隐藏**——它没有可删的
东西，显示出来只会稀释列表。Host 返回的列表始终是完整事实（带 `missing`
标记），隐藏只是这张卡片的呈现选择。

### 会话右键菜单

在侧边栏对**已归档**的会话右键（或点「⋯」），菜单里会出现 **删除归档会话**；
非归档会话不显示该项。点击同样走二次确认。

## 删除的安全闸

宿主端每次删除都会逐条检查，任何一条不满足就只拒绝该条、不中断其余：

| 检查 | 拒绝原因 | 说明 |
| --- | --- | --- |
| 在归档集合里 | `not-archived` | 未归档的会话一律拒绝，即使目录存在 |
| 不是活跃会话 | `live` | 裸 id 与 `encodeSegment` 两种目录名形态都比对 |
| 目录唯一命中 | `no-directory` / `ambiguous-directory` | 命中多个视为歧义，拒绝而不是猜 |
| 目录在根之内 | `outside-root` | 防目录穿越；解析后必须位于 `sessionsRoot` 之下 |
| id 合法 | `bad-id` | 空或非字符串 |

删除成功后还会**取消归档**，否则目录没了而 id 仍留在归档集合里，会变成一个
永远删不掉的幽灵条目。这一步是尽力而为：失败只记一条 warn，不影响删除本身
已完成的事实。

## 配置方式

配置来源（优先级从低到高）：schema 默认值 < 组合层条目配置
（包内 `cordis.patch.yml` 的 `config`）< 设置文档用户层。**推荐在界面配置**：
**设置** → **会话清理** → 展开 → 编辑 → **保存**；点 **恢复默认** 整体回退到
组合层配置。

> 配置卡片经插件自身的 `/session-cleanup` 前缀路由读写（`getConfig` /
> `setConfig` / `resetConfig` / `listArchived` / `deleteArchived`；
> `POST /session-cleanup/<endpoint>`，注册在 `webServer` 服务上，自带同源栅栏 +
> 只收 POST + 只收 `application/json`）。
>
> 宿主侧不调用 `ctx.settings.register`（0.2.x 的 `SettingsForms` 没有这个
> 方法）：字段标 `.volatile()` 后由宿主的配置文档承载用户层，读走
> `settings.describe()`，写走 `settings.update()` / `replace()`（命名空间就是
> loader entry id `session-cleanup`）。
>
> 载体是**静态声明的依赖**（`export const inject = ['sessions',
> 'workspaceRegistry', 'webServer']`），插件只在三者都绑定后激活；不在回调里
> `ctx.get('webServer')` 与载体绑定竞态 —— 后者会在载体尚未 listen 时读到
> `undefined` 并静默跳过整个传输通道。
>
> 为什么不是 `ctx.connection.rpc.handle`：dsh 0.1.5-rc.1 的 Connection 注册表对
> 连接包之外的插件必然抛 `cannot get property "webServer" without inject`
> （`dsh-client-connection/lib/index.js` 的 `register()` 里
> `owner.effect(() => owner.webServer.register(route))`，`owner` 从未声明
> `webServer`），通道根本不会存在，浏览器请求会落到 SPA 兜底。做法：
> `createRpcRoute(path, handle)` + `webServer.register`，且路由注册排在设置桥
> 之前 —— inject 回调抛错会回滚它此前注册的全部 effect，传输先落地才不会被
> 设置挂掉带走。

## 配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 插件总开关；`false` 时不列出、也不允许删除 |
| `sessionsRoot` | `$DSH_HOME/sessions` | 会话根目录，可指向其他位置 |

> 若 JSONL 后端配置的会话根目录不是 `$DSH_HOME/sessions`，请把 `sessionsRoot`
> 配成与后端一致；配错时列表会**空着**（所有记录都被判为磁盘上无目录而隐藏），
> 这是最容易误判成「插件坏了」的一种情况，先查这个配置。
>
> 目录名有 `session-<uuid>` 与裸 `<uuid>` 两种铸造方式，插件按 id 的两种编码
> 形态精确匹配，不靠前缀猜。

## 卸载

1. 插件管理页「已安装」卡片卸载，或命令行：
   `dsh plugin --profile desktop remove @local/dsh-plugin-session-cleanup`
   （**热生效**：数秒后 `/session-cleanup` 路由注销、设置页消失）；
2. 可选：删除 `~/.dsh/profiles/node_modules/@local/dsh-plugin-session-cleanup`
   解析兜底链接（源码留在仓库，重装即可恢复）。

已删除的会话不会因为卸载插件而回来 —— 那是操作系统的删除，与插件无关。

## 测试

```powershell
# 在仓库根执行：$repo = (Resolve-Path .).Path
node patches/session-cleanup/session-cleanup.test.mjs      # 删除安全闸纯逻辑
node patches/session-cleanup/verify-session-cleanup.mjs    # 主机端点 + 设置页 + 右键菜单
node patches/session-cleanup/tests/load-smoke.mjs          # 真实 Cordis 加载冒烟
```

覆盖：

- **纯逻辑**：目录定位的两种 id 形态、未归档拒绝、活跃会话拒绝、整目录删除
  （含附件与检查点）、逐条拒绝不中断、`listArchived` 的 `live`/`missing` 标记、
  `encodeSegment` 与官方同构、字节格式化；
- **主机端点**：静态 inject 形态、装载后不做任何后台工作、栅栏（403 跨源
  Origin / 405 非 POST / 415 非 JSON / 404 端点段数 / 400 非 JSON body /
  413 超 1MB / 500 handler 抛错）、设置文档读写、`enabled:false` 仍保留传输但
  拒绝删除、路由排在设置桥之前、卸载守卫；
- **真实 Cordis**：`ctx.plugin()` 能加载、不注册定时器、`listArchived` 读
  `workspaceRegistry`、`deleteArchived` 端到端删除一个归档会话并拒绝活跃/
  未归档会话、晚到的 `webServer` 仍会激活传输；
- **客户端**：`settings.section` 与 `sidebar.workspaces.session.menu.item` 两个
  槽位注册、字典中英一致、列表渲染、**行为项目名而非存储键/uuid**
  （副行仍带会话 id）、**归档但磁盘上无目录的会话不渲染**（`missing` 条目被
  过滤）、勾选后出现批量删除、弹窗先问再删、取消不删任何东西、
  确认后目录消失且会话被取消归档并刷新列表、
  fetch 桩直连真实 host 路由、网络/HTTP/信封失败均 reject。

DOM 交互段需要 jsdom，未安装时自动跳过。