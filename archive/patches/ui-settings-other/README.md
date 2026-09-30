# 设置「其他」页 —— 服务管理(重启 / 运行状态 / 桌面快捷方式)+ 启动脚本

在 dsh Web 设置中新增一个 **其他(Other)** 页面,提供三块能力:

1. **运行状态**:实时展示服务进程快照 —— 进程 ID、监听端口、运行时长、
   内存占用、Node 版本、dsh 版本、运行中会话数(每 10 秒自动轮询,也可手动
   刷新;这个 10 秒**只在页面可见时成立** —— 后台标签页的定时器会被浏览器
   节流到分钟级,所以**切回前台会立即补读一次**,重启流程走到「已就绪」时
   也会立即补读一次,免得那行还挂着已经消失的旧 pid)。
2. **创建桌面快捷方式**:在桌面生成 `dsh-web.lnk`(鲸鱼娘图标),双击后**新开一个
   控制台窗口**启动服务(该窗口会打印端口并等待按键,`start-dsh.ps1 -OpenBrowser
   -Pause`);重复点击幂等,已带 `-Pause` 的快捷方式不会被覆盖。
3. **重启服务**:点击后 dsh 服务进程自行重启(以相同命令行重新拉起一个后台
   进程,当前进程退出)。**会中断所有运行中的会话**,仅用于升级 dsh、
   修改核心插件或状态异常等必须整进程重启的场景;这是页面上**唯一的危险
   按钮**。**三条会真正断开服务的路径都必须先过确认弹窗**(普通重启、
   强制重启、等待空闲后重启),确认后页面用**三阶段进度条**报告重启进度
   (见下文)。

> 页面**不再提供「中断服务」按钮**:危险操作只保留「重启服务」一个。需要停机
> 维护时用命令行 `~/.dsh/scripts/stop-dsh.ps1`
> (`powershell -ExecutionPolicy Bypass -File .\scripts\stop-dsh.ps1`),之后用
> 桌面快捷方式或 `start-dsh.ps1` 重新拉起。
>
> **空闲自动停止已删除**(2026-09):该特性原本在无运行中会话超过 `idleMinutes`
> 后自动停止服务,配套的 settings 命名空间 `ui-settings-other` 与
> 「设置 → 插件 → 插件配置」卡片一并移除 —— 本补丁现在不拥有任何 settings
> 命名空间,也不注册 `settings.plugin.item` 卡片。旧的 `idleEnabled` /
> `idleMinutes` 条目键留着无害(`Config` 容忍未知键),但不再有任何作用。

## 品牌图标(鲸鱼娘)

- **桌面快捷方式图标**:`DeepSeekHarness-WhaleGirl.ico`(16-256 多尺寸透明底)
  由 `deploy.ps1` 同步到 `~/.dsh/assets/`;「创建桌面快捷方式」按钮会先确保
  该资产存在,`.lnk` 的 IconLocation 指向它。
- **Web 标题栏图标(favicon)**:host 半注入 `webServer` 服务后注册精确路由
  `/favicon.svg`,用补丁内置的 128px PNG(经 base64 嵌入 SVG)覆盖 dsh 默认
  favicon,标题栏/标签页图标与 DeepSeek 开放平台区分开。
- **诊断路由** `GET /ui-settings-other/health`(只读、`no-store`、本机可达):
  返回 `{ ok, namespace, channel, branding, warnings }`,用来区分
  「`/app` 路由根本没注册」和「某个端点报错」——这两种情况在页面上都表现为
  「运行状态获取失败」。`channel/branding` 是两个阶段是否成功
  (`namespace` 只是本插件的身份标签,不再对应任何 settings 命名空间),
  `warnings` 是各阶段失败的原文。排查顺序:先 curl 这条路由。
  同时 host 半的可选步骤(favicon 品牌覆盖)单独 try/catch 并写 warning,
  **它失败不会再拖垮 `/app` 通道**——早先这些步骤是顺序执行且没有保护,
  一步抛错就会让「其他」页整页按钮失效。
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
- **重启服务**(危险,页面上唯一的危险按钮):**三条会真正断开服务的路径
  统一先过确认弹窗** —— 普通重启、忙碌时的**强制重启**、以及「等待空闲后
  重启」等到会话归零的那一刻,都会弹出确认对话框(含说明文案与
  「取消 / 确认重启」,点遮罩或按 Esc 也可取消;强制重启的弹窗带会话数量)。
  取消强制重启会**回到忙碌视图**保留「等待空闲 / 强制重启」的选择。
  请求发出后按钮进入「正在重启…」禁用态;失败显示错误并提供重试。
- **重启进度条**:确认后页面进入**三阶段进度条**(①已请求重启 ②旧服务已
  停止 ③新服务已就绪)。阶段判定只用页面**还能观察到的事实**:发起重启后
  第一次 `/app/status` 读到的 `service.pid` 是**旧进程**的基准;之后
  ① 轮询连不上 = 旧服务已停,② 轮询应答且 **pid 变化** = 新服务已接管。
  两者都没观察到(超出预算 120 秒)→ 进度条降到 `unknown` 态并提示**端口
  很可能已变化**,给出**重试检测**按钮(只重新探测、不重复请求重启)。
  重试期间基准 pid 会被保留,所以换端口的服务一旦在本地址应答即可判为就绪。
  预算是**墙上时钟 120 秒**(不是 120 次轮询),且**切回前台会立即补探一次** ——
  后台标签页的 1 秒轮询会被浏览器节流,按轮询次数计预算会让它变成几分钟;
  判定为「已就绪」的那一次会**同时把运行状态块刷新一遍**。
- **防重复**:host 侧有锁(spawn 失败 / 脚本非零退出 / 90 秒看门狗都会
  释放),重复请求直接返回"已排定";看门狗定时器属插件生命周期
  (`ctx.effect`),插件卸载时会被清除。
- **dsh 版本卡片**(只读):显示**当前版本**与**最新版本(dist-tag `latest`)**,
  并给出「已是最新 / 有新版本可用」;有「检查更新」按钮可手动刷新(绕过 10 分钟
  缓存)。检查源是**机器 npmrc 里配置的 registry**(本机为
  `https://registry.npmmirror.com/`),没有配置时退回官方源;`~/.npmrc` 里同时
  存着其它 scope 的 authToken,所以解析器**只取顶层 `registry=` 那一行**、绝不
  把文件内容带进日志或响应。registry 拿不到时是 fail-soft:`ok:true` + `error`
  字段说明原因(卡片显示「检查失败:<原因>」),不会变成红色报错。**只跟 `latest`**:
  `alpha` 通道(现为 0.1.7-alpha.2)跑在 latest 前面,跟着它会把 RC 安装误判成
  该升级。
- **更新并重启**(有更新时才出现,危险色):点击**先弹确认框**(文案含目标版本),
  取消不触碰任何东西;确认后调 `/app/update`(带上卡片刚读到的版本号,固定这次
  运行的目标),然后**复用重启那条三阶段进度条** —— 只是标题变成「更新进度」、
  第一阶段文案变成「已请求更新」,预算从 120 秒放宽到 **300 秒**(更新要下载、
  打补丁、再启动),宿主侧的锁窗口同步放宽到 **10 分钟**(90 秒会让第二次更新在
  第一次还在跑时插进来)。判定为「已就绪」时,运行状态块与版本卡片都会被刷新一遍。
- **会话保护**:有会话正在运行时,`restart` 拒绝执行并返回
  `sessions-running`(含数量);页面提供两个选项:
  - **等待空闲后重启**:每 2s 轮询 `/app/status`,归零后**弹确认框**
    (不再自动发起);
  - **强制重启**:先对所有运行中会话执行
    `agent.cancel({ kind: 'user' }, { keepInbox: true })`,再执行。

## 更新(检测 + 按钮 + `update-dsh.ps1` 已接好;真正的切换仍未跑过)

链路已完整:`其他` 页的版本卡片 → 确认框 → `/app/update` → `update-dsh.ps1` →
进度条。**唯一没被执行过的是「停旧 → 起新」那一步本身**(预热与定位是实测的,
见下;真升级会替换正在运行的服务,所以留给你在确认的时间点跑)。脚本设计成
**薄编排**,不重复实现端口/PID/打补丁/等就绪:

```
update-dsh.ps1  = 解析目标版本(默认 npm 的 latest dist-tag)
                → 预热: npx -y @deepseek-ai/dsh@<v> --version(断言打印出的就是 <v>)
                → 断言「最新缓存条目 == 目标版本」(start-dsh.ps1 与 patch-cli.ps1
                  都只认按写入时间最新的那一条,选错就会给旧构建打补丁还报成功)
                → Start-Sleep 让在途 RPC 响应送达
                → 委托 stop-dsh.ps1 -Port <旧端口>(它自己会校验 PID 确实是 dsh CLI)
                → 委托 start-dsh.ps1 [-OpenBrowser](它自己会定位最新入口、重跑
                  patch-cli.ps1、挑空闲端口、隐藏窗口启动、轮询就绪)
```

`-DryRun` 实测输出(只打印计划,不做任何改动):

```
registry: https://registry.npmmirror.com/
target version: 0.1.5-rc.3
running now: PID 41692 on port 3080
running build: 0.1.5-rc.2  (..._npx\1e7f6d9597241db0)
already cached: 0.1.5-rc.3  (..._npx\99cabb0ceac85b86\...\bin.js)
newest entry: 0.1.5-rc.3  (..._npx\99cabb0ceac85b86)
plan: 1. prime(skip) 2. assert 3. stop 4. start
DRY-RUN: no changes made.
```

未缓存的分支也验过(`-Version 0.1.6-alpha.2` → 计划里 prime 步显示真实命令);
非法版本号硬失败(`not a dsh version: 'banana'`)。**注意 `-DryRun` 之外尚未执行**
—— 真正切换前请先跑 `-DryRun` 确认命令,并且确认没有运行中的会话(脚本本身没有
会话检查,UI 侧接上时要复用 `sessions-running` 保护)。`scripts/deploy.ps1` 会把
它同步到 `~/.dsh/scripts/`。

此前实测清楚的机制细节:

- **预热新版本的命令**(实测):`npx -y @deepseek-ai/dsh@<目标版本> --version`。
  它会把新版本**新开**一个 npx 缓存目录(实测 rc.3 → `_npx/99cabb0ceac85b86`,内含
  `lib/bin.js`),**不动**正在运行的那个目录 —— 所以「先备好、再切换」是可行的,
  失败也不会污染当前进程。`--version` 是安全探针(打印版本即退出,不启服务);
  注意 `-v` **不是**版本开关(它会要求 `--profile`)。
- **切换步骤**:停旧进程 → 用**新缓存目录**的 `bin.js` 启动(定位新入口要用
  `start-dsh.ps1` 那套「扫 npx 缓存里最新的 dsh 入口」逻辑,**不能**沿用
  `restart-dsh.ps1` 的「恢复旧命令行」,否则会拉起旧目录)→ **必须重跑
  `patch-cli.ps1`**(新缓存目录里没有 `--clean`)→ 轮询就绪 → 可选打开浏览器。
- **失败兜底**:`dsh web --clean`(只加载 bundle 层)是升级把用户层搞坏时的逃生舱;
  另外**有会话在跑时必须拒绝**更新(整进程会被换掉,复用现有 `sessions-running`
  保护)。
- 桌面快捷方式侧同样待接:计划是在服务就绪后回调 `/app/versionCheck` 拿结论打印
  一行(那时它正好在等按键),拿不到就静默跳过 —— 这样 semver 比较只有一份实现,
  不用在 PS 里再抄一遍。

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
    先前注册的所有 effect**(favicon、诊断路由会一起消失)。路由自带
    同源栅栏(`Origin` 必须等于 `Host`)、只收 `POST`、只收 `application/json`
    —— 跨站 POST 会带自己的 `Origin`、JSON body 又会触发预检(我们不响应预检),
    因此等价于 Connection 原来的 Host/Origin 栅栏。
  - 端点共五个:`status` / `installShortcut` / `restart` / `versionCheck` / `update` ——
    没有 `stop`,没有 `reloadPlugins`(原因见「注意事项」),随空闲自动停止一起
    删掉的 `getSettings` / `setSettings` / `resetSettings` 现在只会返回
    `bad-request`(未知端点)。端点处理函数仍是
    `async (endpoint, payload) => {ok,value}|{ok,error}`,与旧通道时代完全一致。
  - `status` 端点返回 `{ running, sessions, service }`:
    `service` 为进程快照(pid / startedAt / uptime / rss / node /
    execPath / dsh 版本(从入口脚本向上解析 package.json)/ 监听端口
    (netstat 按本进程 PID 过滤,10s 缓存))。页面侧的重启进度条正是靠
    `service.pid` 区分旧进程与替代进程。
  - `restart` 端点只做一件事:调起 `restart-dsh.ps1`(路径取自补丁 config 的
    `script`,默认 `~/.dsh/scripts/restart-dsh.ps1`)。**用 `Start-Process` 起,
    而不是把 `detached: true` 交给 spawn**:Windows PowerShell 5.1 在被
    `detached: true`(配 `stdio:'ignore'` + `windowsHide`)spawn 时会**秒退并返回
    0,脚本体一行都不执行** —— 于是旧进程不被杀、没有日志、连
    `code !== 0` 的告警分支都不触发,客户端只能空等到 120 秒降级 `unknown`
    (2026-09-23 用 spawn 对照矩阵定位;命令行手动跑有控制台,所以这个 bug
    只在 UI 路径暴露)。现在的形状是:spawn 一个 powershell 只做
    `Start-Process -WindowStyle Hidden -PassThru`,再由它 `WaitForExit` 并把
    子进程退出码作为自己的退出码 —— 与桌面快捷方式起脚本同为「真正独立
    的进程」(`start-dsh.ps1` 起 node 也是这个模式),同时保留
    「非零退出 → 释放重启锁」的原有语义。
    两个实测细节别踩:`Start-Process` 的 `-FilePath` **必须用绝对路径**
    (`Join-Path $PSHOME 'powershell.exe'`;裸名 `'powershell'` 会静默起成别的东西、
    内层命令完全不生效且返回 0),内层命令行里**路径要用双引号**
    (单引号那版实测子进程以 -196608 退出、什么都不执行)。
    `verify-settings-other.mjs` 里的 **spawn 冒烟**就是这几条的回归守卫:
    用宿主原样调用起一个写标记文件的 stub,断言标记出现、`-OpenBrowser` 传到位、
    且非零退出码能透传到外层。
  - 本 half **不注册任何 settings 命名空间,也不注入 `settings` 服务**;
    `lib/index.js` 与 `lib/client.js` 都不再持有任何定时器(唯一的前端计时器
    是进度条轮询,属浏览器侧组件)。
  - `restart` 端点的 90 秒看门狗属插件生命周期:由 `ctx.effect` 持有并在
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
- **Client 半(`lib/client.js`)**:只注册 `settings.section` slot
  (`id: 'other'`, `order: 30`);状态块、**创建桌面快捷方式**与
  **重启服务**按钮经模块级 `call(endpoint, args)` 用 `fetch` 调
  `POST /app/<endpoint>`(`content-type: application/json`,body `{args}`,
  解 `{ok,value}` 信封),注入面为 `restart` / `status` / `installShortcut` /
  `versionCheck` / `update`。
  重启流程的状态机:`idle → confirm(restart) → calling → progress | busy | error`,
  其中 `busy → confirm(force)`(取消回 busy)与
  `busy → waiting → confirm(auto)` 都先过确认;`progress` 三阶段由 1s 轮询
  `/app/status` 驱动(基准 pid → 连接失败 → pid 变化),预算用尽则进
  `unknown` 态。

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
        # script: 'D:\path\to\restart-dsh.ps1'        # 可选:自定义重启脚本路径
        # updateScript: 'D:\path\to\update-dsh.ps1'   # 可选:自定义更新脚本路径
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
   - 仅当升级 dsh / 修改核心插件时,才使用 **重启服务** → 确认 → 看进度条
     走完三阶段(会中断所有运行中会话);有会话正在运行时可选择
     「等待空闲后重启」(会话归零后仍会先弹确认框)或「强制重启」;
   - 进度条停在 `unknown` 态说明本地址没等到应答:多半已换端口,重启脚本会
     自动打开新地址,也可以点 **重试检测** 再探一次;
   - 需要停机维护时改用命令行停机(会中断所有运行中会话),之后用桌面
     快捷方式或 `start-dsh.ps1` 重新拉起:
     `powershell -ExecutionPolicy Bypass -File .\scripts\stop-dsh.ps1`。
2. 桌面双击 **dsh-web** 快捷方式:打开控制台窗口启动服务(打印端口后等待
   按键关闭),并自动打开默认浏览器;
   首次安装快捷方式:
   `powershell -ExecutionPolicy Bypass -File .\scripts\install-desktop-shortcut.ps1`
   (已部署到 `~/.dsh/scripts/`,可用 `-Name` / `-Force` 调整)。

## 卸载

1. 删除 `~/.dsh/profiles/web/cordis.patch.yml` 中的 `ui-settings-other`
   条目(**热生效**:数秒后「其他」页消失,`/app` 通道注销,重启看门狗随
   fiber 卸载清理);
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
- 进度条只能证明页面**在本地址**看到的现象:重启脚本优先复用原端口,只有
  原端口不可用(TIME_WAIT / 被占)时才改选 3080-3100 池内的下一个端口,此时
  旧页面永远等不到应答(这是 `unknown` 态的正常来源,不是失败)。
- 手动运行 `restart-dsh.ps1` / `stop-dsh.ps1` 没有会话检查(脚本无法访问
  会话状态),请在运行前确认没有进行中的会话;两者都会先校验目标 PID 确实是
  dsh CLI,遇到无关监听进程时报错退出而不是强杀。
- **已移除的两个按钮:「重载用户插件」与「中断服务」**。前者只改写
  `cordis.patch.yml` 的注释行,解析出的 patch 列表不变,Loader 不会重启任何行
  (源码链路:`hmr.registerConfig` 监听 → `watchUserPatches` 回调重读该文件 →
  `Entry.update` 对 options 做深比较后提前返回),因此它从不生效;后者被去掉,
  危险操作只保留「重启服务」一个。停止服务请走命令行 `stop-dsh.ps1`。
  补丁的 `config` 也不再接受 `patchFile` 键(现在只剩 `script`;
  `idleEnabled` / `idleMinutes` 随空闲自动停止一并失效,写在新条目里也不会
  被 `Config` 拒绝,但不会有任何作用)。
- 若某个补丁加载失败,该次候选更新整体回滚并广播 `hmr/config-update-failed`,
  上一次成功的条目树继续运行;让该文件再发生一次真实改动即可再次触发重载
  (只改注释不会触发);修改补丁源码后则需重启 dsh web 才生效。

## 测试

在仓库根执行(`# 在本补丁目录下运行` 的那条除外):

```powershell
node patches/ui-settings-other/tests/load-smoke.mjs   # 真 Cordis Context 装载:只需 agents + webServer
node patches/ui-settings-other/verify-settings-other.mjs
```

覆盖:host 半 `/app` 前缀路由注册与端点校验(不真正重启)、`restart` 端点的会话
保护(非强制拒绝并返回 `sessions-running` / 强制先取消会话再执行)、
apply 不返回 thenable 的 P0 回归守卫、
RPC 失败信封完整性(`{ok:false,error:{code,message,details}}`)、
运行状态快照(serviceInfo / listeningPorts / dshVersion)、
**空闲自动停止的删除守卫**(`status` 不含 `idle` 键、settings 端点返回
`bad-request`、有 settings 服务时也不注册命名空间/不注入 `settings`、
host 半不挂任何 interval、旧的 `idleMinutes` 条目键不致命)、
**生命周期回归守卫**(镜像 Cordis 的「子 fiber + 反序释放」语义:
重启看门狗随卸载清理)、`installShortcut` 的真实 created 状态、
client 半契约(bundle handoff、section id/order、不再贡献
`settings.plugin.item` 卡片、zh/en 字典一致、注入面 `restart` / `status` /
`installShortcut` / `versionCheck` / `update`、Modal stub 契约)、**版本检测与更新**
(isNewerVersion 的 10 个 semver/prerelease 用例、npmrc 只取顶层 registry=
且不泄漏 token、`/app/versionCheck` 真路由的 fail-soft 形状 + 缓存 + force、
`/app/update` 真路由:版本号被钉住/垃圾版本被拒/有会话时拒绝并返回
`sessions-running`/强制会先取消会话/与重启共用同一把锁/缺脚本时报
`update script not found`、版本卡片的挂载读取与强制重查、更新流程的
「确认 → POST /app/update {version} → 进度条(更新标题与首阶段文案)」)
与 **主题 token 审计**(bundle 用到的
每个 `--dsw-alias-*` 都必须在已安装主题里有定义)。
DOM 交互段(状态块渲染 7 行、重启的确认弹窗/等待空闲/强制流程、
**三阶段进度条与 unknown 降级 + 重试检测**)需要 jsdom;未安装时自动跳过
并提示。
