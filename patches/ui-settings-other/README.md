# 设置「其他」页 —— 服务管理(重启 / 运行状态 / 空闲自动停止 / 桌面快捷方式)+ 启动脚本

在 dsh Web 设置中新增一个 **其他(Other)** 页面,提供四块能力:

1. **运行状态**:实时展示服务进程快照 —— 进程 ID、监听端口、运行时长、
   内存占用、Node 版本、dsh 版本、运行中会话数、空闲自动停止倒计时
   (每 10 秒自动轮询,也可手动刷新)。
2. **创建桌面快捷方式**:在桌面生成 `dsh-web.lnk`(鲸鱼娘图标),双击后**新开一个
   控制台窗口**启动服务(该窗口会打印端口并等待按键,`start-dsh.ps1 -OpenBrowser
   -Pause`);重复点击幂等,已带 `-Pause` 的快捷方式不会被覆盖。
3. **重启服务**:点击后 dsh 服务进程自行重启(以相同命令行重新拉起一个后台
   进程,当前进程退出)。**会中断所有运行中的会话**,仅用于升级 dsh、
   修改核心插件或状态异常等必须整进程重启的场景;这是页面上**唯一的危险
   按钮**。有会话正在运行时,确认流程会给出「等待空闲后重启」与
   「强制重启」两条路径(见下文)。
4. **空闲自动停止**:持续没有**运行中的会话**超过 `idleMinutes`(默认 120,
   即 2 小时)后,服务自动优雅退出;配合桌面快捷方式可随时重新拉起。

> 页面**不再提供「中断服务」按钮**:危险操作只保留「重启服务」一个。需要停机
> 维护时用命令行 `~/.dsh/scripts/stop-dsh.ps1`
> (`powershell -ExecutionPolicy Bypass -File .\scripts\stop-dsh.ps1`),之后用
> 桌面快捷方式或 `start-dsh.ps1` 重新拉起。

## 品牌图标(鲸鱼娘)

- **桌面快捷方式图标**:`DeepSeekHarness-WhaleGirl.ico`(16-256 多尺寸透明底)
  由 `deploy.ps1` 同步到 `~/.dsh/assets/`;「创建桌面快捷方式」按钮会先确保
  该资产存在,`.lnk` 的 IconLocation 指向它。
- **Web 标题栏图标(favicon)**:host 半注入 `webServer` 服务后注册精确路由
  `/favicon.svg`,用补丁内置的 128px PNG(经 base64 嵌入 SVG)覆盖 dsh 默认
  favicon,标题栏/标签页图标与 DeepSeek 开放平台区分开。
- **诊断路由** `GET /ui-settings-other/health`(只读、`no-store`、本机可达):
  返回 `{ ok, namespace, channel, settings, branding, warnings }`,用来区分
  「`/app` 通道根本没注册」和「某个端点报错」——这两种情况在页面上都表现为
  「运行状态获取失败」。`channel/settings/branding` 是三个阶段是否成功,
  `warnings` 是各阶段失败的原文。排查顺序:先 curl 这条路由。
  同时 host 半的可选步骤(settings 接线、空闲监控、favicon)各自 try/catch 并
  写 warning,**任何一步失败都不会再拖垮 `/app` 通道**——早先它们是顺序执行且
  没有保护,一步抛错就会让「其他」页整页按钮失效。
- 素材来源:[fornarwhal/deepseek-whale-girl-icon](https://github.com/fornarwhal/deepseek-whale-girl-icon)
  (CC BY-NC-SA 4.0,须署名、非商用),角色形象「溟月」(上善无形)、DeepSeek
  元素二创(ZipZipPipe)、改进修复(QYQCAMIAO)。个人使用请保留署名。

## 功能

### 服务卡片(设置 → 其他)

- 设置导航新增「其他」页(排在 Agent 预设之后,`order: 30`)。
- 「服务」卡片顶部是**运行状态**块(含一个**刷新**按钮),下面是
  **创建桌面快捷方式**按钮与其说明文案(普通操作),底部是危险区 ——
  只有**重启服务**一个按钮(附说明文案)。
- **创建桌面快捷方式**:点击即经 `/app` 通道的 `installShortcut` 端点运行
  `~/.dsh/scripts/install-desktop-shortcut.ps1`(同步等待);成功显示
  「快捷方式已创建:<路径>」,已存在时同样显示(脚本幂等);失败显示原因。
  返回的 `created` 取自脚本输出(报告「already exists」时为 `false`),不再恒为
  `true`。生成的快捷方式**双击会新开控制台窗口启动服务并打开默认浏览器**,
  窗口会打印端口并等待按键后才关闭。
- **重启服务**(危险,页面上唯一的危险按钮):**二次确认弹窗**后才真正执行
  (点击弹出确认对话框,含说明文案与「取消 / 确认重启」,点遮罩或按 Esc 也可
  取消);请求发出后按钮进入「正在重启…」禁用态;成功后显示「已请求重启,
  服务即将断开,请稍后刷新页面」;失败显示错误并提供重试。
- **防重复**:host 侧有锁(spawn 失败 / 脚本非零退出 / 90 秒看门狗都会
  释放),重复请求直接返回"已排定";看门狗定时器与空闲监控同属插件生命周期
  (`ctx.effect`),插件卸载时会被清除。
- **会话保护**:有会话正在运行时,`restart` 拒绝执行并返回
  `sessions-running`(含数量);页面提供两个选项:
  - **等待空闲后重启**:每 2s 轮询 `/app/status`,归零后
    自动发起重启;
  - **强制重启**:先对所有运行中会话执行
    `agent.cancel({ kind: 'user' }, { keepInbox: true })`,再执行。

### 空闲自动停止(设置 → 插件 → 插件配置)

- 配置卡片「服务(空闲自动停止)」,两个字段:
  - **启用空闲自动停止**(开关,默认开);
  - **空闲时长(分钟)**(数字,默认 120)。
- 保存即时生效(host 重新装配监控:开→建、关→停;`idleMinutes` 每次 tick 都
  从当前配置读取,不需要为改数值重建定时器);也可直接编辑
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

## 启动脚本与桌面快捷方式

- **`start-dsh.ps1`**(由 `scripts/deploy.ps1` 同步到 `~/.dsh/scripts/`):
  `-Port` 为 0(默认)时先在 **3080-3100 端口池**里找**已在运行的 dsh 实例**
  (监听端口 + PID 确认为 node.exe 且命令行含 `@deepseek-ai/dsh`);找到即视为
  「已在运行」并退出(幂等),否则再扫描第一个能通过真实绑定测试的端口(占用或
  处于 TIME_WAIT 的端口会被跳过)。端口池扫描必须排在「已在运行」判断**之后**,
  否则扫描返回的必然是空闲端口、永远看不到已有实例,从而在池内另起第二个实例
  (共用同一 profile:同一会话库、两个补丁监视器)。非 dsh 的监听者会被忽略。
  显式传 `-Port 3080` 时直接检查该端口,已有服务即退出(幂等);`-Force` 时跳过
  该判断,照常在空闲端口启动新实例。未在运行时自动定位 node.exe 与 npx 缓存中
  最新的 dsh CLI 入口,以
  **隐藏窗口** 启动 `node <bin> web`(日志重定向到
  `~/.dsh/logs/dsh-web.<时间戳>.*.log`),并轮询端口直到就绪。支持
  `-Port` / `-Force` / `-NodeArgs`(透传额外参数,如
  `-Port 3099 -NodeArgs '--port','3099'`),以及 **`-OpenBrowser`**:无论服务
  是已运行还是刚启动,都会打开 dsh Web —— **若浏览器已有显示 dsh 页面的窗口
  (窗口标题含页面标题「DeepSeek Harness」)则直接聚焦该窗口,否则用默认浏览器
  新建标签页**(聚焦为尽力而为:受系统焦点策略限制,失败时同样回退新建标签页)。
  (它先按监听端口找到现有进程,找不到才委托启动)。
- **`install-desktop-shortcut.ps1`**:在桌面创建 `dsh-web.lnk`,目标为
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File …start-dsh.ps1
  -OpenBrowser -Pause`(工作目录 `~/.dsh/profiles/web`,图标取自
  `~/.dsh/assets/DeepSeekHarness-WhaleGirl.ico`)—— **双击会打开一个控制台
  窗口启动服务、自动打开默认浏览器,并打印端口后等待按键才关闭**;服务已在
  运行时该窗口同样显示已运行状态并等待按键。已存在但参数不含 `-Pause` 的旧版
  快捷方式会被就地升级;已带 `-Pause` 的快捷方式幂等跳过(除非 `-Force`)。
- 手动执行:
  `powershell -NoProfile -ExecutionPolicy Bypass -File .\patches\ui-settings-other\start-dsh.ps1`

## 工作原理

补丁分 host / client 两半,挂载在同一个 loader 条目上,**重启逻辑收敛
在独立脚本** `restart-dsh.ps1`(由 `scripts/deploy.ps1`
同步到 `~/.dsh/scripts/`),可脱离插件单独运行与测试;`stop-dsh.ps1` 仍在
部署范围内,但只供命令行停机使用,插件与页面都不再调用它。

- **Host 半(`lib/index.js`)**:
  - 在 `ctx.get('webServer')` 上注册一条**前缀路由 `/app`**(`createRpcRoute('/app', handleEndpoint)`),
    替代 `ctx.connection.rpc.handle`。原因:dsh 0.1.5-rc.1 的 Connection
    注册表对任何外部插件都抛 `cannot get property "webServer" without inject`
    (`owner.effect(() => owner.webServer.register(route))` 里的 `owner` 从未声明
    `webServer`),通道根本注册不上,而且抛错发生在 inject 回调里会**回滚该回调
    先前注册的所有 effect**(favicon、空闲监控、诊断路由会一起消失)。路由自带
    同源栅栏(`Origin` 必须等于 `Host`)、只收 `POST`、只收 `application/json`
    —— 跨站 POST 会带自己的 `Origin`、JSON body 又会触发预检(我们不响应预检),
    因此等价于 Connection 原来的 Host/Origin 栅栏。
  - 端点共六个:`getSettings` / `setSettings` /
    `resetSettings` / `status` / `installShortcut` / `restart` ——
    没有 `stop`,也没有 `reloadPlugins`(原因见「注意事项」)。端点处理函数仍是
    `async (endpoint, payload) => {ok,value}|{ok,error}`,与旧通道时代完全一致。
  - `status` 端点返回 `{ running, sessions, service, idle }`:
    `service` 为进程快照(pid / startedAt / uptime / rss / node /
    execPath / dsh 版本(从入口脚本向上解析 package.json)/ 监听端口
    (netstat 按本进程 PID 过滤,10s 缓存));`idle` 为空闲停止状态
    (enabled / idleMinutes / lastBusyAt)。
  - `restart` 端点只做一件事:detached 调起 `restart-dsh.ps1`(路径取自
    补丁 config 的 `script`,默认 `~/.dsh/scripts/restart-dsh.ps1`)。
  - 空闲监控:settings namespace `ui-settings-other` 由本插件**手写注册**
    (`settings.register(ns, schema, { base: entry })` + `scope.watch(...)`,
    并非 `settings.installSection`,也没有 `applies: live`):配置变更后由
    `scope.watch` 回调按新值重新装配监控(开→建、关→停;`idleMinutes` 每次
    tick 从当前来源读取)。settings 服务缺失时回退补丁 entry 配置(entry +
    schema 默认值),provider 中途卸载时也会回退到该来源。所有定时器都在
    `ctx.effect` 里注册:空载时按反序释放,Cordis 会**先**运行 settings 子
    fiber 的 disposer,因此该 disposer 自己在卸载中关闭重建路径
    (`isUnloading`),避免在卸载过程中重新建出监控器。
  - `restart` 端点的 90 秒看门狗同属插件生命周期:由 `ctx.effect` 持有并在
    卸载时 `clearTimeout`。
- **脚本(`restart-dsh.ps1`)**:完整生命周期 —— 通过端口(默认扫描
  3080-3100 池)找到当前 dsh 进程,校验该 PID 确实是 dsh CLI(node.exe 且
  命令行含 `@deepseek-ai/dsh`;不是则报错退出,绝不强杀无关进程),再恢复其
  原始命令行(引号感知 tokenizer)→ `SettleSeconds` 让 RPC
  响应先送达 → 再次校验同 PID 后停止旧进程 → 等待端口释放 → **在 3080-3100
  端口池里挑新端口:能重新绑定就沿用原端口,原端口不可用(TIME_WAIT / 被占)
  才改选池内下一个空闲端口**,必要时改写命令行里的 `--port` → 以修改后的
  命令行启动新进程(日志重定向)→ 轮询直到服务应答。就绪判定是**「有 HTTP
  应答」而不是「HTTP 200」**:dsh web 对无凭据请求的根路径返回 401,而
  `Invoke-WebRequest` 会把它当异常抛出,早先只认 200 的写法会让脚本空等
  120 s、报超时并**跳过打开浏览器那一步**(即使服务其实已经起来了);
  现在只有「连接被拒/超时」才算未就绪。host 半以 `-OpenBrowser` 调用本脚本,
  因此重启后会自动打开**新端口**的地址(端口没变就是原地址)。支持
  `-DryRun`、`-Port`、`-SettleSeconds`。**幂等回退**:端口上没有任何进程时
  不再报错,而是委托同目录的 `start-dsh.ps1` 直接启动(在跑则重启,未跑则启动)。
  `--clean` 支持不再内联在此脚本里,而是调用唯一的共享实现
  `~/.dsh/scripts/patch-dsh-cli.ps1`(仓库内为 `scripts/patch-cli.ps1`);
  该文件缺失时只打印一条 WARN,不阻塞启动。
- **脚本(`stop-dsh.ps1`)**:提供命令行停机(页面不调用它)。`-Port` 为 0
  (默认)时扫描同一 3080-3100 端口池,取第一个监听端口(显式 `-Port` 则只查
  该端口)→ 校验 PID 确实是 dsh CLI(同上,不是则报错退出)→ 打印其命令行 →
  `Stop-Process -Force` → 等待端口释放(供后续 `start-dsh.ps1` 安全
  重拉)。支持 `-DryRun`、`-Port`;没有任何会话检查,请在运行前确认
  没有进行中的会话。
- **Client 半(`lib/client.js`)**:注册 `settings.section` slot
  (`id: 'other'`, `order: 30`)与 `settings.plugin.item` 配置卡片
  (`key: 'ui-settings-other'`);状态块、**创建桌面快捷方式**与
  **重启服务**按钮经模块级 `call(endpoint, args)` 用 `fetch` 调
  `POST /app/<endpoint>`(`content-type: application/json`,body `{args}`,
  解 `{ok,value}` 信封),注入面为 `restart` / `status` / `installShortcut`。

## 部署(加载到 dsh)

与 ui-settings-plugin-manager 相同的机制:实现来源在本仓库,部署侧建立
junction 链接 + patch 条目;`deploy.ps1` 会把 `restart-dsh.ps1` /
`stop-dsh.ps1` / `start-dsh.ps1` / `install-desktop-shortcut.ps1` 同步到
`~/.dsh/scripts/`,并把仓库唯一的 CLI 补丁实现 `scripts/patch-cli.ps1`
同步为 `~/.dsh/scripts/patch-dsh-cli.ps1`(start / restart 调用它来提供
`dsh web --clean`;缺失时只告警)。

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
        # idleMinutes: 120                        # 可选:空闲停止阈值(分钟),默认 120
```

条目增删 / 配置修改保存后**数秒热生效**(host + client 均热装载,无需
重启):`watchUserPatches` 在监视该文件,只有**内容发生真实变化**(增删行、
改 `config`)才会事务性重挂整个用户层(不中断会话);只改注释、或写回一份
内容等价的文件都不会触发 —— `Entry.update` 会对 options 做深比较,无差异
即直接返回。**修改本补丁源码后需重启 dsh web**(`restart-dsh.ps1`)才生效。

## 如何使用

1. 打开 dsh Web 界面 → **设置** → 左侧导航最下方 **其他**:
   - 查看服务运行状态(进程 ID / 端口 / 运行时长 / 内存 / 版本 / 会话数),
     需要最新快照时点 **刷新**;
   - 修改了 `cordis.patch.yml` 的**条目内容**(增删行、改 `config`)后,
     热重载会在数秒内自动生效(不中断会话);只改注释不会触发重挂;
   - 仅当升级 dsh / 修改核心插件时,才使用 **重启服务** → 确认 →
     等待约 10~20 秒后刷新页面(会中断所有运行中会话);有会话正在运行时
     可选择「等待空闲后重启」或「强制重启」;
   - 需要停机维护时改用命令行停机(会中断所有运行中会话),之后用桌面
     快捷方式或 `start-dsh.ps1` 重新拉起:
     `powershell -ExecutionPolicy Bypass -File .\scripts\stop-dsh.ps1`。
2. 设置 → **插件** → **插件配置** → 展开「服务(空闲自动停止)」:
   调整开关与空闲分钟数,点「保存」即时生效。
3. 桌面双击 **dsh-web** 快捷方式:打开控制台窗口启动服务(打印端口后等待
   按键关闭),并自动打开默认浏览器;
   首次安装快捷方式:
   `powershell -ExecutionPolicy Bypass -File .\scripts\install-desktop-shortcut.ps1`
   (已部署到 `~/.dsh/scripts/`,可用 `-Name` / `-Force` 调整)。

## 卸载

1. 删除 `~/.dsh/profiles/web/cordis.patch.yml` 中的 `ui-settings-other`
   条目(**热生效**:数秒后「其他」页与配置卡片消失,`/app` 通道注销,
   空闲监控随 fiber 卸载停止);
2. 删除 `~/.dsh/profiles/node_modules/@local/dsh-client-ui-settings-other`
   链接;
3. 可选:删除桌面 `dsh-web.lnk` 与 `~/.dsh/scripts/` 下本补丁的脚本
   (`restart-dsh.ps1` / `stop-dsh.ps1` / `start-dsh.ps1` /
   `install-desktop-shortcut.ps1` / `patch-dsh-cli.ps1`)。

## 注意事项

- **重启服务会中断所有运行中会话**(整进程停止),所以它是页面上唯一的危险
  按钮;日常调整用户插件不必重启 —— 编辑 `cordis.patch.yml`,只要内容有
  真实变化(增删行、改 `config`),数秒内即热生效。
- 重启后新进程**脱离原终端独立运行**(detached);再次重启需在 Web 中
  操作、运行脚本或结束进程后重新启动。
- 空闲自动停止会**结束整个 dsh web 进程**(包括正在浏览页面的人),请在
  无人使用或接受中断时开启;需要保活可把空闲分钟数调大或关闭开关。
- 手动运行 `restart-dsh.ps1` / `stop-dsh.ps1` 没有会话检查(脚本无法访问
  会话状态),请在运行前确认没有进行中的会话;两者都会先校验目标 PID 确实是
  dsh CLI,遇到无关监听进程时报错退出而不是强杀。
- **已移除的两个按钮:「重载用户插件」与「中断服务」**。前者只改写
  `cordis.patch.yml` 的注释行,解析出的 patch 列表不变,Loader 不会重启任何行
  (源码链路:`hmr.registerConfig` 监听 → `watchUserPatches` 回调重读该文件 →
  `Entry.update` 对 options 做深比较后提前返回),因此它从不生效;后者被去掉,
  危险操作只保留「重启服务」一个。停止服务请走命令行 `stop-dsh.ps1`。
  补丁的 `config` 也不再接受 `patchFile` 键(只剩 `idleEnabled` /
  `idleMinutes` / `script`)。
- 若某个补丁加载失败,该次候选更新整体回滚并广播 `hmr/config-update-failed`,
  上一次成功的条目树继续运行;让该文件再发生一次真实改动即可再次触发重载
  (只改注释不会触发);修改补丁源码后则需重启 dsh web 才生效。

## 测试

```powershell
# 在仓库根执行:\$repo = (Resolve-Path .).Path
node verify-settings-other.mjs          # 在本补丁目录下运行
```

覆盖:host 半 `/app` 通道注册与端点校验(不真正重启)、`restart` 端点的会话
保护(非强制拒绝并返回 `sessions-running` / 强制先取消会话再执行)、
apply 不返回 thenable 的 P0 回归守卫、
RPC 失败信封完整性(`{ok:false,error:{code,message,details}}`)、
运行状态快照(serviceInfo / listeningPorts / dshVersion)、空闲判定与监控器
(假时钟:busy 重置 / 阈值等待 / 恰好一次停止)、settings namespace 注册与
watch 重建、**生命周期回归守卫**(镜像 Cordis 的「子 fiber + 反序释放」语义:
每次 apply 只装配一个监控器、卸载过程中不会新建 interval、卸载后不残留
interval、provider 卸载时回退 entry 配置、重启看门狗随卸载清理)、
`installShortcut` 的真实 created 状态、client 半契约(bundle handoff、
section 与卡片 id/order、zh/en 字典一致、注入面 `restart` / `status` /
`installShortcut`、Modal stub 契约)与 **主题 token 审计**(bundle 用到的
每个 `--dsw-alias-*` 都必须在已安装主题里有定义)。
DOM 交互段(状态块渲染、重启的确认弹窗/等待空闲/强制流程、配置卡片
经 `/app` RPC 保存与重置)需要 jsdom;未安装时自动跳过并提示。
