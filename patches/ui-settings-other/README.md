# 设置「其他」页 —— 重启服务(用户级 dsh 插件)

在 dsh Web 设置中新增一个 **其他(Other)** 页面,提供一个 **重启服务** 按钮:
点击后 dsh 服务进程自行重启(以相同命令行重新拉起一个后台进程,当前进程
优雅退出),适用于插件配置变更、状态异常等需要整进程重启的场景,无需回到
终端手动操作。

## 功能

- 设置导航新增「其他」页(排在 Agent 预设之后,`order: 30`)。
- 页面含一张「服务」卡片:描述文案 + 「重启服务」按钮。
- **二次确认**:第一次点击按钮进入确认态(显示"确定要重启服务吗?"),
  再点「确认重启」才真正执行;可「取消」退回。
- 请求发出后按钮进入「正在重启…」禁用态;成功后显示
  「已请求重启,服务即将断开,请稍后刷新页面」;失败显示错误并提供重试。
- **防重复**:host 侧有锁,重复请求直接返回"已排定"。

## 工作原理

补丁分 host / client 两半,挂载在同一个 loader 条目上,**重启逻辑收敛在
本目录的独立脚本** `restart-dsh.ps1`(由 `scripts/deploy.ps1` 同步到
`~/.dsh/scripts/`),可脱离插件单独运行与测试:

- **Host 半(`lib/index.js`)**:通过 `ctx.connection.rpc.handle('/app', …)`
  注册一个独立 RPC 通道(权限 `loopback`,仅本机页面可达;共享的 `/api`
  通道由 dsh 的 Typert gateway 独占,用户级插件不能抢占)。`restart`
  端点只做一件事:detached 调起 `restart-dsh.ps1`(路径取自补丁 config
  的 `script`,默认 `~/.dsh/scripts/restart-dsh.ps1`),不做任何进程管理。
- **脚本(`restart-dsh.ps1`)**:完整生命周期 ——
  1. 通过端口(默认 3080)找到当前 dsh 进程,恢复其**原始命令行**
     (引号感知 tokenizer,保留 npx / 直接 node 等任意启动方式);
  2. `SettleSeconds`(默认 2s)让 RPC 响应先送达浏览器;
  3. 停止旧进程;
  4. 以相同命令行启动新进程(日志重定向到 `~/.dsh/logs/`);
  5. 轮询端口直至服务就绪(最多 120s)。
  支持 `-DryRun`(只打印计划)、`-Port`、`-SettleSeconds` 参数。
- **Client 半(`lib/client.js`)**:注册 `settings.section` slot
  (`id: 'other'`, `order: 30`,同 seat 下的官方页面为通用设置/模型/插件/
  Agent 预设),按钮调用 `ctx.connection.rpc.call('/app', 'restart', …)`。

> 手动重启:直接运行
> `powershell -ExecutionPolicy Bypass -File .\patches\ui-settings-other\restart-dsh.ps1`
> (先 `-DryRun` 预览要执行的内容)。

## 部署(加载到 dsh)

与 ui-settings-plugin-manager 相同的机制:实现来源在本仓库,部署侧建立
junction 链接 + patch 条目;另外 `deploy.ps1` 会把重启脚本同步到
`~/.dsh/scripts/`。

1. 建立指向本目录的目录联接(junction):

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-settings-other" -Target "D:\GitHub\deep-dreaming\patches\ui-settings-other"
```

2. 同步重启脚本并校验部署:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
```

3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 中追加启用条目:

```yaml
- insert:
    - id: ui-settings-other
      name: '@local/dsh-client-ui-settings-other'
      config:
        # script: 'D:\path\to\restart-dsh.ps1'   # 可选:自定义脚本路径
```

`cordis.patch.yml` 由运行中的 dsh 热加载:保存后数秒内自动挂载
(host 半注册 `/app` 通道,浏览器刷新一次页面即可看到「其他」页)。

## 如何使用

1. 打开 dsh Web 界面 → **设置** → 左侧导航最下方 **其他**。
2. 点击 **重启服务** → 出现确认提示 → 点击 **确认重启**。
3. 页面显示"正在重启…",随后服务进程退出并自动以新进程拉起;
   连接断开是预期行为,**等待约 10~20 秒后刷新页面**即可恢复使用。

## 卸载

1. 删除 `~/.dsh/profiles/web/cordis.patch.yml` 中的 `ui-settings-other`
   条目;
2. 删除 `~/.dsh/profiles/node_modules/@local/dsh-client-ui-settings-other`
   链接;
3. 热加载自动移除(页面刷新后「其他」页消失,`/app` 通道随之注销)。

## 注意事项

- 重启后新进程**脱离原终端独立运行**(detached),原终端的日志输出不再
  跟随;再次重启需在 Web 中操作,或自行结束进程后从终端重新启动。
- 新进程与旧进程使用相同的 `argv` / `cwd` / `env`,启动方式(如
  `dsh web`、`dsh --profile web`)保持不变;`~/.dsh` 下的补丁配置照常加载。
- 若新进程因端口被占用等原因启动失败(概率极低:旧进程退出先于新进程
  boot 完成),服务不会自动恢复,需从终端重新启动;失败时旧进程退出前
  会在控制台打印 `[ui-settings-other] respawn failed`。
- 连续快速点击多次只触发一次重启(host 侧锁)。

## 测试

```powershell
node verify-settings-other.mjs          # 在本补丁目录下运行
```

覆盖:host 半 `/app` 通道注册与端点校验(不真正重启)、client 半契约
(section id/order、zh/en 字典一致)、渲染与二次确认交互、RPC 调用形态、
成功/失败状态展示。
