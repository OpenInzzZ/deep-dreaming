# 设置「其他」页 —— 服务管理(重载插件 / 重启 / 中断 / 运行状态 / 空闲自动停止 / 桌面快捷方式)+ 静默启动

在 dsh Web 设置中新增一个 **其他(Other)** 页面,提供六块能力:

1. **重载用户插件**:触发 dsh 对 `cordis.patch.yml` 的热重载
   (`watchUserPatches` 事务性重应用),全部用户级插件(host 与浏览器两半)
   卸载后重新装载,**不重启服务、不中断会话**、排队消息不丢。插件条目
   增删/配置修改、或想确认补丁变更已生效时用它;数秒内完成,无需刷新页面。
2. **创建桌面快捷方式**:在桌面生成 `dsh-web.lnk`(鲸鱼娘图标),双击即可
   静默启动服务(已运行时为无操作);重复点击幂等,不会覆盖已有快捷方式。
3. **重启服务**:点击后 dsh 服务进程自行重启(以相同命令行重新拉起一个后台
   进程,当前进程退出)。**会中断所有运行中的会话**,仅用于升级 dsh、
   修改核心插件或状态异常等必须整进程重启的场景(日常用户插件更新请用
   「重载用户插件」)。
4. **中断服务**:点击后 dsh 服务进程优雅退出,**不会自动重启**;需要时用
   桌面快捷方式或 `start-dsh.ps1` 重新拉起。同样**会中断所有运行中的
   会话**,用于停机维护 / 切换启动方式等场景。命令行等价物:
   `stop-dsh.ps1`。
5. **运行状态**:实时展示服务进程快照 —— 进程 ID、监听端口、运行时长、
   内存占用、Node 版本、dsh 版本、运行中会话数、空闲自动停止倒计时
   (每 10 秒自动轮询,也可手动刷新)。
6. **空闲自动停止**:持续没有**运行中的会话**超过 `idleMinutes`(默认 120,
   即 2 小时)后,服务自动优雅退出;配合桌面快捷方式可随时静默重新拉起。

## 品牌图标(鲸鱼娘)

- **桌面快捷方式图标**:`DeepSeekHarness-WhaleGirl.ico`(16-256 多尺寸透明底)
  由 `deploy.ps1` 同步到 `~/.dsh/assets/`;「创建桌面快捷方式」按钮会先确保
  该资产存在,`.lnk` 的 IconLocation 指向它。
- **Web 标题栏图标(favicon)**:host 半注入 `webServer` 服务后注册精确路由
  `/favicon.svg`,用补丁内置的 128px PNG(经 base64 嵌入 SVG)覆盖 dsh 默认
  favicon,标题栏/标签页图标与 DeepSeek 开放平台区分开。
- 素材来源:[fornarwhal/deepseek-whale-girl-icon](https://github.com/fornarwhal/deepseek-whale-girl-icon)
  (CC BY-NC-SA 4.0,须署名、非商用),角色形象「溟月」(上善无形)、DeepSeek
  元素二创(ZipZipPipe)、改进修复(QYQCAMIAO)。个人使用请保留署名。

## 功能

### 服务卡片(设置 → 其他)

- 设置导航新增「其他」页(排在 Agent 预设之后,`order: 30`)。
- 「服务」卡片顶部是**运行状态**块(见上),中部是**重载用户插件**与
  **创建桌面快捷方式**按钮(普通操作,绿色提示),底部是**重启服务**与
  **中断服务**按钮(危险区,附说明文案)。
- **重载用户插件**:点击即经 `/app` 通道的 `reloadPlugins` 端点在
  `cordis.patch.yml` 上维护一行时间戳标记并写回,触发官方热重载;
  成功后显示「已请求重载,数秒内生效」。host 端不等待重载完成即返回,
  重载过程异步进行;若某插件重载失败,`watchUserPatches` 会记录日志告警
  并保持上次成功状态。
- **创建桌面快捷方式**:点击即经 `/app` 通道的 `installShortcut` 端点运行
  `~/.dsh/scripts/install-desktop-shortcut.ps1`(同步等待);成功显示
  「快捷方式已创建:<路径>」,已存在时同样显示(脚本幂等);失败显示原因。
  生成的快捷方式**双击会静默启动服务并用默认浏览器打开 dsh Web**。
- **重启服务**(危险):**二次确认弹窗**后才真正执行(第一次点击弹出确认
  对话框,含说明文案与「取消 / 确认重启」,点遮罩或按 Esc 也可取消);请求
  发出后按钮进入「正在重启…」禁用态;成功后显示「已请求重启,服务即将
  断开,请稍后刷新页面」;失败显示错误并提供重试。
- **中断服务**(危险):与重启同一行,独立**二次确认弹窗**(「确定中断服务?
  服务将停止,需用桌面快捷方式或 start-dsh.ps1 重新启动。」);确认后经
  `/app` 通道的 `stop` 端点,host 延迟 500ms 调用 launcher 的
  `ctx.appExit(0)` 优雅退出(该通道不可用时回退 `process.exit(0)`)——
  延迟保证 RPC 响应先送达浏览器。
- **防重复**:host 侧有锁(spawn 失败 / 脚本非零退出 / 90 秒看门狗都会
  释放),重复请求直接返回"已排定"。
- **会话保护**:有会话正在运行时,`restart` / `stop` 拒绝执行并返回
  `sessions-running`(含数量);页面提供两个选项:
  - **等待空闲后重启**(仅重启支持):每 2s 轮询 `/app/status`,归零后
    自动发起重启;
  - **强制重启 / 强制中断**:先对所有运行中会话执行
    `agent.cancel({ kind: 'user' }, { keepInbox: true })`,再执行。

### 空闲自动停止(设置 → 插件 → 插件配置)

- 配置卡片「服务(空闲自动停止)」,两个字段:
  - **启用空闲自动停止**(开关,默认开);
  - **空闲时长(分钟)**(数字,默认 120)。
- 保存即时生效(host 按新配置重建监控);也可直接编辑
  `~/.dsh/settings.yaml` 的 `ui-settings-other:` 段(文件被监听)。
- 配置卡片经插件自身的 `/app` RPC 通道读写(getSettings / setSettings /
  resetSettings),不依赖 dsh 设置的暴露白名单(apiproxy),在
  **设置 → 插件 → 插件配置** 页编辑(插件管理页仅负责插件启停,不承载
  配置卡片);点 **恢复默认** 整体回退到组合层配置。
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
  (透传额外参数,如 `-Port 3099 -NodeArgs '--port','3099'`),以及
  **`-OpenBrowser`**:无论服务是已运行还是刚启动,都会打开 dsh Web——
  **若浏览器已有显示 dsh 页面的窗口(窗口标题含页面标题
  「DeepSeek Harness」)则直接聚焦该窗口,否则用默认浏览器新建标签页**
  (聚焦为尽力而为:受系统焦点策略限制,失败时同样回退新建标签页)。
- **`install-desktop-shortcut.ps1`**:在桌面创建 `dsh-web.lnk`,
  目标为 `powershell.exe -WindowStyle Hidden -File …start-dsh.ps1
  -OpenBrowser` —— **双击即静默启动(已运行时为无操作)并自动打开默认
  浏览器**进入 dsh Web。已存在的旧版快捷方式(不含 `-OpenBrowser`)会被
  自动升级;仅含 `-OpenBrowser` 的快捷方式才幂等跳过。
- 手动执行:
  `powershell -NoProfile -ExecutionPolicy Bypass -File .\patches\ui-settings-other\start-dsh.ps1`

## 工作原理

补丁分 host / client 两半,挂载在同一个 loader 条目上,**重启与中断逻辑收敛
在独立脚本** `restart-dsh.ps1` / `stop-dsh.ps1`(由 `scripts/deploy.ps1`
同步到 `~/.dsh/scripts/`),可脱离插件单独运行与测试:

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
  - `stop` 端点:会话保护同 `restart`(非强制且有运行会话时返回
    `sessions-running`;强制时先 `agent.cancel(…, { keepInbox: true })`
    取消所有运行中会话),随后延迟 500ms 调用 `ctx.appExit(0)`(回退
    `process.exit(0)`)——延迟让 RPC 响应先送达浏览器再退出。
  - 空闲监控:settings namespace `ui-settings-other` 经
    `installSettingsSection` 注册(`applies: live`,变更即时重建监控);
    settings 服务缺失时回退补丁 entry 配置。
- **脚本(`restart-dsh.ps1`)**:完整生命周期 —— 通过端口找到当前 dsh
  进程并恢复其原始命令行(引号感知 tokenizer)→ `SettleSeconds` 让 RPC
  响应先送达 → 停止旧进程 → 等待端口释放 → 以相同命令行启动新进程
  (日志重定向)→ 轮询端口直至就绪。支持 `-DryRun`、`-Port`、
  `-SettleSeconds`。
- **脚本(`stop-dsh.ps1`)**:通过端口找到监听进程并打印其命令行 →
  `Stop-Process -Force` → 等待端口释放(供后续 `start-dsh.ps1` 安全
  重拉)。支持 `-DryRun`、`-Port`;没有任何会话检查,请在运行前确认
  没有进行中的会话。
- **Client 半(`lib/client.js`)**:注册 `settings.section` slot
  (`id: 'other'`, `order: 30`)与 `settings.plugin.item` 配置卡片
  (`id: '@local/dsh-client-ui-settings-other'`, `order: 30`);按钮与状态块
  调用 `ctx.connection.rpc.call('/app', …)`。

## 部署(加载到 dsh)

与 ui-settings-plugin-manager 相同的机制:实现来源在本仓库,部署侧建立
junction 链接 + patch 条目;`deploy.ps1` 会把 `restart-dsh.ps1` /
`stop-dsh.ps1` / `start-dsh.ps1` / `install-desktop-shortcut.ps1` 同步到
`~/.dsh/scripts/`。

1. 建立指向本目录的目录联接(junction):

```powershell
# 在仓库根执行:\$repo = (Resolve-Path .).Path
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-settings-other" -Target "$repo\patches\ui-settings-other"
```

2. 同步脚本并校验部署:

```powershell
# 在仓库根执行:\$repo = (Resolve-Path .).Path
powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
```

3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 中追加启用条目:

```yaml
- insert:
    - id: ui-settings-other
      name: '@local/dsh-client-ui-settings-other'
      config:
        # script: 'D:\path\to\restart-dsh.ps1'   # 可选:自定义重启脚本路径
        # patchFile: '...'                        # 可选:重载插件时 touch 的 patch 文件,默认 ~/.dsh/profiles/web/cordis.patch.yml
        # idleMinutes: 120                        # 可选:空闲停止阈值(分钟),默认 120
```

条目增删 / 配置修改保存后**数秒热生效**(host + client 均热装载,无需
重启);「其他」页的**重载用户插件**按钮可手动触发同样的热重载。
**修改本补丁源码后需重启 dsh web**(`restart-dsh.ps1`)才生效。

## 如何使用

1. 打开 dsh Web 界面 → **设置** → 左侧导航最下方 **其他**:
   - 查看服务运行状态(进程 ID / 端口 / 运行时长 / 内存 / 版本 / 会话数);
   - 更新了任何用户级插件(本仓库补丁或其他 `cordis.patch.yml` 条目)后,
     点击 **重载用户插件** → 数秒内生效,不中断会话;
   - 仅当升级 dsh / 修改核心插件时,才使用 **重启服务** → 确认 →
     等待约 10~20 秒后刷新页面(会中断所有运行中会话);
   - 需要停机维护时使用 **中断服务** → 确认 → 服务优雅退出(会中断
     所有运行中会话);之后用桌面快捷方式或 `start-dsh.ps1` 重新拉起。
     命令行等价物:
     `powershell -ExecutionPolicy Bypass -File .\scripts\stop-dsh.ps1`。
2. 设置 → **插件** → **插件配置** → 展开「服务(空闲自动停止)」:
   调整开关与空闲分钟数,点「保存」即时生效。
3. 桌面双击 **dsh-web** 快捷方式静默启动服务(已运行时无操作);
   首次安装快捷方式:
   `powershell -ExecutionPolicy Bypass -File .\scripts\install-desktop-shortcut.ps1`
   (已部署到 `~/.dsh/scripts/`,可用 `-Name` / `-Force` 调整)。

## 卸载

1. 删除 `~/.dsh/profiles/web/cordis.patch.yml` 中的 `ui-settings-other`
   条目(**热生效**:数秒后「其他」页与配置卡片消失,`/app` 通道注销,
   空闲监控随 fiber 卸载停止);
2. 删除 `~/.dsh/profiles/node_modules/@local/dsh-client-ui-settings-other`
   链接;
3. 可选:删除桌面 `dsh-web.lnk` 与 `~/.dsh/scripts/` 下本补丁的四个脚本。

## 注意事项

- **重启 / 中断服务会中断所有运行中会话**(整进程停止);日常用户插件更新
  请用「重载用户插件」。
- 重启后新进程**脱离原终端独立运行**(detached);再次重启需在 Web 中
  操作、运行脚本或结束进程后重新启动。
- 空闲自动停止会**结束整个 dsh web 进程**(包括正在浏览页面的人),请在
  无人使用或接受中断时开启;需要保活可把空闲分钟数调大或关闭开关。
- 手动运行 `restart-dsh.ps1` / `stop-dsh.ps1` 没有会话检查(脚本无法访问
  会话状态),请在运行前确认没有进行中的会话。
- 重载用户插件后,若某个补丁加载失败,`cordis.patch.yml` 热重载保持上次
  成功状态并在 dsh 日志记录告警;修复补丁后再次「重载用户插件」即可。

## 测试

```powershell
# 在仓库根执行:\$repo = (Resolve-Path .).Path
node verify-settings-other.mjs          # 在本补丁目录下运行
```

覆盖:host 半 `/app` 通道注册与端点校验(不真正重启)、`stop` 端点(非强制
拒绝 / 强制取消会话并调用 appExit(0))、`reloadPlugins` 端点(写临时
patch 文件,不碰真实 profile 层)、apply 不返回 thenable 的 P0 回归守卫、
运行状态快照(serviceInfo / listeningPorts / dshVersion)、空闲判定与监控器
(假时钟:busy 重置 / 阈值等待 / 恰好一次停止)、settings namespace 注册与
watch 重建、client 半契约(bundle handoff、section 与卡片 id/order、
zh/en 字典一致、reloadPlugins / stopService 注入面、Modal stub 契约)。
DOM 交互段(状态块渲染、重载/重启/中断弹窗确认/等待/强制流程、配置卡片
经 `/app` RPC 保存与重置)需要 jsdom;未安装时自动跳过并提示。
