# 临时会话 —— 侧边栏一键发起不绑定项目的临时会话

dsh 发起会话必须绑定一个工作区(没有工作区时对话输入框是禁用的)。对
临时、非项目相关的闲聊,每次都要选/建项目目录很烦。本补丁在**侧边栏
底部**(设置按钮上方)加一个「临时会话」按钮:点击后静默确保一个
**用户级临时目录**(默认 `~/.dsh/tmp-workspaces/`)注册为工作区(标题
「临时会话」),然后直接开一个新会话绑定到它。

- 会话显示在工作区树的「临时会话」分组下,agent 的 cwd 和文件操作落在
  用户级目录,不污染任何项目;
- 反复点击复用同一个工作区(幂等),不会堆积一堆空工作区;
- 侧边栏收窄成 rail 时按钮只显示图标(与设置按钮同一套 36px 圆)。

## 工作原理

- **Host 半(`lib/index.js`)**:在 `webServer` 上注册**前缀路由**
  `/temp-session`(自带同源栅栏:非 POST → 405、非 `application/json` →
  415、`Origin` 与 `Host` 不同 → 403)。载体的可用性由**声明的依赖**保证:
  `ctx.inject(['webServer', 'workspaceRegistry'], …)` 让激活等待 HTTP 载体
  就绪,而不是在 `apply` 里 `ctx.get('webServer')` 与载体绑定竞态(那正是四个
  补丁重启后静默失联的原因)。**不再**用
  `ctx.connection.rpc.handle`:dsh 0.1.5-rc.1 的 Connection 注册表会对外部插件
  抛 `cannot get property "webServer" without inject`,通道根本不存在,浏览器
  请求会落到 SPA 兜底(405/404)。端点 `ensure`:
  先 `mkdir -p` 用户级目录,再 `workspaceRegistry.resolveByPath(dir)` 幂等
  复用;不存在则 `workspaceRegistry.create(dir, title)` 注册。并发点击由
  **每个插件实例自己的** promise 链串行化(`createEnsureQueue()`,在 `apply`
  闭包内创建),不会重复创建,热重载后的新实例也不会排在旧实例的任务后面。
  路由以 `ctx.effect(...)` 注册在那个子 fiber 上(`webServer` 与
  `workspaceRegistry` 都声明在其中),卸载/热重载时 `/temp-session` 随之注销。
- **Client 半(`lib/client.js`)**:注册 `sidebar.footer.action` 槽
  (`id: 'temp-session'`, `order: -10`,排在设置上方);点击流程:
  `POST /temp-session/ensure`(body `{ args: {} }`,解析 `{ ok, value }` 信封)→
  `uiWorkspace.startSession(workspaceId)`(宿主在 ensure 后会把工作区写入
  客户端基线,不需要手动 `workspaces.refresh()`)。失败时按钮下方显示错误
  行,可重试。样式表以 `data-plugin` + `data-plugin-css` 注入,重复注入有
  去重守卫。

## 部署(加载到 dsh)

1. 建立指向本目录的目录联接(junction):

```powershell
# 在仓库根执行:\$repo = (Resolve-Path .).Path
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-temp-session" -Target "$repo\patches\temp-session"
```

2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 中追加启用条目:

```yaml
- insert:
    - id: temp-session
      name: '@local/dsh-client-ui-temp-session'
      config:
        # dir: 'D:\path\to\scratch'   # 可选:临时目录,默认 ~/.dsh/tmp-workspaces
        # title: '临时会话'            # 可选:工作区显示标题
```

条目增删 / 配置修改保存后**数秒热生效**;修改本补丁源码后需重启 dsh web。

## 卸载

1. 删除 `~/.dsh/profiles/web/cordis.patch.yml` 中的 `temp-session` 条目
   (热生效:按钮消失,`/temp-session` 通道注销);
2. 删除 `~/.dsh/profiles/node_modules/@local/dsh-client-ui-temp-session` 链接;
3. 可选:删除 `~/.dsh/tmp-workspaces/`(已绑定会话的工作区记录保留在 dsh
   存储里,目录删掉后该工作区路径失效,可右键删除工作区)。

## 测试

```powershell
# 在仓库根执行:\$repo = (Resolve-Path .).Path
node patches/temp-session/verify-temp-session.mjs   # 契约 + jsdom 渲染/交互断言
```

覆盖:host 半 `ensure` 端点在真实临时目录上的幂等性(首次创建/二次复用、
自定义 title)、`/temp-session` 前缀路由注册与栅栏(403 跨源 / 405 非 POST /
415 非 JSON / 404 端点为空或多段、400 非 JSON body、413 超大 body)、载体为
声明依赖 `webServer,workspaceRegistry`(载体缺席时子 fiber 等待、不注册任何
路由,载体出现即注册并同时触发启动 ensure —— 等待语义)、路由
disposer(卸载即注销路由)、bad-request 守卫与 `args` 守卫(仅接受 `undefined`
或普通对象,`null`/数组/标量一律 bad-request)、每实例串行链(有序、失败不污染
链、实例之间互不影响)与并发 `ensure` 经路由的串行化、apply 不返回 thenable 的
P0 回归守卫、client 半契约(bundle handoff、`sidebar.footer.action` 条目
id/order、zh/en 字典一致、注入面不含 `connection`、`data-plugin-css` 样式
去重)。DOM 交互段(按钮渲染 wide/rail 两态、点击后 `POST /temp-session/ensure`
→ startSession、失败/HTTP 错误/网络错误的错误行)需要 jsdom;未安装时自动
跳过并提示。
