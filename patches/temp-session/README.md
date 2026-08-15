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

- **Host 半(`lib/index.js`)**:通过 `ctx.connection.rpc.handle('/temp-session')`
  注册独立 RPC 通道(权限 `loopback`,仅本机页面可达)。端点 `ensure`:
  先 `mkdir -p` 用户级目录,再 `workspaceRegistry.resolveByPath(dir)` 幂等
  复用;不存在则 `workspaceRegistry.create(dir, title)` 注册。并发点击
  由内部 promise 链串行化,不会重复创建。
- **Client 半(`lib/client.js`)**:注册 `sidebar.footer.action` 槽
  (`id: 'temp-session'`, `order: -10`,排在设置上方);点击流程:
  `ensure` → `workspaces.refresh()`(新工作区先进入客户端基线,否则
  `connectWorkspace` 找不到)→ `workspaces.startSession(workspaceId)`。
  失败时按钮下方显示错误行,可重试。

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
node verify-temp-session.mjs          # 在本补丁目录下运行
```

覆盖:host 半 `ensure` 端点在真实临时目录上的幂等性(首次创建/二次复用、
自定义 title)、`/temp-session` 通道注册与 bad-request 守卫、apply 不返回
thenable 的 P0 回归守卫、client 半契约(bundle handoff、
`sidebar.footer.action` 条目 id/order、zh/en 字典一致、注入面)。DOM 交互段
(按钮渲染 wide/rail 两态、点击后 ensure → refresh → startSession、失败
错误行)需要 jsdom;未安装时自动跳过并提示。
