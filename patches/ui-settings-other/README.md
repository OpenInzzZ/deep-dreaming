# 设置「其他」页 —— 服务管理(重启 / 运行状态 / 空闲自动停止)+ 静默启动

在 dsh Web 设置中新增一个 **其他(Other)** 页面,提供三块能力:

1. **重启服务**:点击后 dsh 服务进程自行重启(以相同命令行重新拉起一个后台
   进程,当前进程退出),适用于插件配置变更、状态异常等需要整进程重启的
   场景,无需回到终端手动操作。
2. **运行状态**:实时展示服务进程快照 —— 进程 ID、监听端口、运行时长、
   内存占用、Node 版本、dsh 版本、运行中会话数、空闲自动停止倒计时
   (每 10 秒自动轮询,也可手动刷新)。
3. **空闲自动停止**:持续没有**运行中的会话**超过 `idleMinutes`(默认 120,
   即 2 小时)后,服务自动优雅退出;配合桌面快捷方式可随时静默重新拉起。

## 功能

### 服务卡片(设置 → 其他)

- 设置导航新增「其他」页(排在 Agent 预设之后,`order: 30`)。
- 「服务」卡片顶部是**运行状态**块(见上),底部是**重启服务**按钮。
- **二次确认**:第一次点击按钮进入确认态,再点「确认重启」才真正执行;
  可「取消」退回。
- 请求发出后按钮进入「正在重启…」禁用态;成功后显示
  「已请求重启,服务即将断开,请稍后刷新页面」;失败显示错误并提供重试。
- **防重复**:host 侧有锁,重复请求直接返回"已排定"。
- **会话保护**:有会话正在运行时,`restart` 拒绝执行并返回 `sessions-running`
  (含数量);页面提供两个选项:
  - **等待空闲后重启**:每 2s 轮询 `/app/status`,归零后自动发起重启;
  - **强制重启**:先对所有运行中会话执行
    `agent.cancel({ kind: 'user' }, { keepInbox: true })`,再重启。

### 空闲自动停止(设置 → 插件 → 插件配置)

- 配置卡片「服务(空闲自动停止)」,两个字段:
  - **启用空闲自动停止**(开关,默认开);
  - **空闲时长(分钟)**(数字,默认 120)。
- 保存即时生效(host 按新配置重建监控);也可直接编辑
  `~/.dsh/settings.yaml` 的 `ui-settings-other:` 段(文件被监听)。
- 判定规则:host 每分钟检查一次 `agents` 服务,只要有会话处于
  `running` 状态就重置空闲时钟;超过阈值仍无运行会话则调用
  launcher 提供的 `ctx.appExit(0)` 优雅关闭(该通道不可用时回退
  `process.exit(0)`)。
- 注意:空闲判定**只认运行中的会话**;排队中但未运行的会话不阻止停止。
  服务停止后,用桌面快捷方式或 `start-dsh.ps1` 重新拉起即可。

## 静默启动与桌面快捷方式

- **`start-dsh.ps1`**(由 `scripts/deploy.ps1` 同步到 `~/.dsh/scripts/`):
  若端口(默认 3080)已有服务则直接退出(幂等);否则自动定位
  node.exe 与 npx 缓存中最新的 dsh CLI 入口,以 **隐藏窗口** 启动
  `node <bin> web`(日志重定向到 `~/.dsh/logs/dsh-web.<时间戳>.*.log`),
  并轮询端口直到就绪。支持 `-Port` / `-Force` / `-NodeArgs`
  (透传额外参数,如 `-Port 3099 -NodeArgs '--port','3099'`)。
- **`install-desktop-shortcut.ps1`**:在桌面创建 `dsh-web.lnk`,
  目标为 `powershell.exe -WindowStyle Hidden -File …start-dsh.ps1`,
  双击即静默启动(已运行时为无操作)。
- 手动执行:
  `powershell -NoProfile -ExecutionPolicy Bypass -File .\patches\ui-settings-other\start-dsh.ps1`

## 工作原理

补丁分 host / client 两半,挂载在同一个 loader 条目上,**重启逻辑收敛在
独立脚本** `restart-dsh.ps1`(由 `scripts/deploy.ps1` 同步到
`~/.dsh/scripts/`),可脱离插件单独运行与测试:

- **Host 半(`lib/index.js`)**:
  - 通过 `ctx.connection.rpc.handle('/app', …)` 注册独立 RPC 通道
    (权限 `loopback`,仅本机页面可达;共享的 `/api` 通道由 Typert
    gateway 独占)。
  - `status` 端点返回 `{ running, sessions, service, idle }`:
    `service` 为进程快照(pid / startedAt / uptime / rss / node /
    execPath / dsh 版本(从入口脚本向上解析 package.json)/ 监听端口
    (netstat 按本进程 PID 过滤,10s 缓存));`idle` 为空闲停止状态
    (enabled / idleMinutes / lastBusyAt)。
  - `restart` 端点只做一件事:detached 调起 `restart-dsh.ps1`(路径取自
    补丁 config 的 `script`,默认 `~/.dsh/scripts/restart-dsh.ps1`)。
  - 空闲监控:settings namespace `ui-settings-other` 经
    `installSettingsSection` 注册(`applies: live`,变更即时重建监控);
    settings 服务缺失时回退补丁 entry 配置。
- **脚本(`restart-dsh.ps1`)**:完整生命周期 —— 通过端口找到当前 dsh
  进程并恢复其原始命令行(引号感知 tokenizer)→ `SettleSeconds` 让 RPC
  响应先送达 → 停止旧进程 → 以相同命令行启动新进程(日志重定向)→
  轮询端口直至就绪。支持 `-DryRun`、`-Port`、`-SettleSeconds`。
- **Client 半(`lib/client.js`)**:注册 `settings.section` slot
  (`id: 'other'`, `order: 30`)与 `settings.plugin.item` 配置卡片
  (`id: 'ui-settings-other'`, `order: 30`);按钮与状态块调用
  `ctx.connection.rpc.call('/app', …)`。

## 部署(加载到 dsh)

与 ui-settings-plugin-manager 相同的机制:实现来源在本仓库,部署侧建立
junction 链接 + patch 条目;`deploy.ps1` 会把 `restart-dsh.ps1` /
`start-dsh.ps1` / `install-desktop-shortcut.ps1` 同步到 `~/.dsh/scripts/`。

1. 建立指向本目录的目录联接(junction):

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-settings-other" -Target "D:\GitHub\deep-dreaming\patches\ui-settings-other"
```

2. 同步脚本并校验部署:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
```

3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 中追加启用条目:

```yaml
- insert:
    - id: ui-settings-other
      name: '@local/dsh-client-ui-settings-other'
      config:
        # script: 'D:\path\to\restart-dsh.ps1'   # 可选:自定义重启脚本路径
        # idleMinutes: 120                        # 可选:空闲停止阈值(分钟),默认 120
```

host 代码或 client bundle 有变更时需重启 dsh web(host)并刷新页面
(client);仅改 `cordis.patch.yml` 时热加载即可。

## 如何使用

1. 打开 dsh Web 界面 → **设置** → 左侧导航最下方 **其他**:
   - 查看服务运行状态(进程 ID / 端口 / 运行时长 / 内存 / 版本 / 会话数);
   - 点击 **重启服务** → 确认 → 等待约 10~20 秒后刷新页面。
2. 设置 → **插件** → **插件配置** → 展开「服务(空闲自动停止)」:
   调整开关与空闲分钟数,点「保存」即时生效。
3. 桌面双击 **dsh-web** 快捷方式静默启动服务(已运行时无操作);
   首次安装快捷方式:
   `powershell -ExecutionPolicy Bypass -File .\scripts\install-desktop-shortcut.ps1`
   (已部署到 `~/.dsh/scripts/`,可用 `-Name` / `-Force` 调整)。

## 卸载

1. 删除 `~/.dsh/profiles/web/cordis.patch.yml` 中的 `ui-settings-other`
   条目;
2. 删除 `~/.dsh/profiles/node_modules/@local/dsh-client-ui-settings-other`
   链接;
3. 重启 dsh web(页面刷新后「其他」页与配置卡片消失,`/app` 通道注销);
4. 可选:删除桌面 `dsh-web.lnk` 与 `~/.dsh/scripts/` 下本补丁的三个脚本。

## 注意事项

- 重启后新进程**脱离原终端独立运行**(detached);再次重启需在 Web 中
  操作、运行脚本或结束进程后重新启动。
- 空闲自动停止会**结束整个 dsh web 进程**(包括正在浏览页面的人),请在
  无人使用或接受中断时开启;需要保活可把空闲分钟数调大或关闭开关。
- 手动运行 `restart-dsh.ps1` 没有会话检查(脚本无法访问会话状态),请在
  运行前确认没有进行中的会话。

## 测试

```powershell
node verify-settings-other.mjs          # 在本补丁目录下运行
```

覆盖:host 半 `/app` 通道注册与端点校验(不真正重启)、运行状态快照
(serviceInfo / listeningPorts / dshVersion)、空闲判定与监控器(假时钟:
busy 重置 / 阈值等待 / 恰好一次停止)、settings namespace 注册与 watch
重建、client 半契约(section 与卡片 id/order、zh/en 字典一致)、状态块
渲染与刷新、二次确认与 busy/wait/force 流程、配置卡片的暂存保存 / 重置
/ 只读禁用。
