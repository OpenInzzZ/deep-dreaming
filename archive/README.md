# archive/ — 以 Web 端为准的资产（已归档，不再维护）

本目录保留**以 DSH Web 端为准**时期的脚本与资产。项目现在以 **DSH 桌面端**
（Electron，`dsh-desktop`）为唯一目标：桌面端由应用自己管理生命周期与更新，
下面这些东西没有对应的执行者了，因此归档保留、**不再部署、不再保证可运行**。

放在这里而不是删掉，是为了在需要时能读懂旧行为（例如排查历史故障、或把某段
逻辑移植到桌面端）。

## `web-scripts/`

| 文件 | 原来的作用 | 为什么归档 |
| --- | --- | --- |
| `start-dsh.ps1` | 静默启动 `dsh web`：扫 3080-3100 端口池、定位 npx 缓存里最新的 dsh CLI、隐藏窗口启动、轮询就绪 | 桌面端由 Electron 拉起居中进程并固定监听 `127.0.0.1:19387`，端口与启动方式都不由脚本决定 |
| `restart-dsh.ps1` | 重启 `dsh web`：按端口找到旧进程、恢复其命令行、停旧起新、轮询就绪 | 同上；桌面端的重启是**重启整个应用**，见 `scripts/restart-desktop.ps1` |
| `stop-dsh.ps1` | 命令行停止 `dsh web`（按端口找进程、校验 PID、等端口释放） | 桌面端从托盘退出即可 |
| `update-dsh.ps1` | 把新版 dsh 装进 npx 缓存并切换运行中的服务 | 桌面端由 `electron-updater` 自带更新（`resources/app-update.yml`） |
| `install-desktop-shortcut.ps1` | 在桌面创建 `dsh-web.lnk`，双击启动 Web 服务并显示端口 | **功能已下线**：桌面端本身就是应用，再套一层快捷方式没有意义 |
| `patch-cli.ps1` | 给 **npx 缓存**里的 dsh CLI 注入 `dsh web --clean`（跳过用户层，作为崩溃逃生舱）；严格自检、失败回滚 | 桌面端跑的是打包运行时（`resources/app.asar/dsh`），不是 npx 缓存，没有可打补丁的对象 |

## `patches/`

| 目录 | 曾经的用途 | 为什么归档 |
| --- | --- | --- |
| `ui-settings-other/` | Web 设置「其他」页：服务运行状态、创建桌面快捷方式、检查更新、重启服务（三阶段进度条）、favicon 覆盖；配套 Web 生命周期脚本 | 这些能力都以 **Web 端生命周期**为准。桌面端的运行状态、更新与重启由应用自己负责，快捷方式也无意义（应用本身就是入口）。曾一度改造为只读余额页 `ui-settings-balance` |
| `ui-settings-balance/` | 只读「账户余额」页：充值 / 赠金余额，经宿主 `deepseekAccount` 读取 | **重复建设**：桌面端自带的「账号与余额」页（`@deepseek-ai/dsh-client-ui-settings-account`）已提供同样两行，另有「更多账号信息」「查询用量」和**充值按钮**。用户补丁只做出一个功能子集，还在 sidebar 上多了一个近义入口，因此退役 |
| `ui-settings-plugin-manager/` | 设置「插件管理」标签页：整份 loader 条目清单 + 分类/启用状态/运行状态三个过滤器 + 每行的启停开关 | **启停与官方重复**：官方 `pluginManager.setPluginEnabled` 写的是同一层、同一 YAML 形状，入口另有侧栏「插件」页、agent 工具 `plugin_manager` 与 `dsh plugin` CLI。归档前已修好它两处真实故障（写死 `profiles/web`；把 loader `entryId` 当补丁行 id 导致永不匹配却回报成功）并补了测试，但既然官方覆盖了核心能力，仍选择整体退役 |

> 教训（也已写进 `AGENTS.md` 的「Adding a New Patch」）：**做 UI 补丁前先在 DSH 源码检出里
> grep 一遍**（`packages/client/ui-*`），确认官方没做过同一件事。

## `assets/`

| 文件 | 原来的作用 | 为什么归档 |
| --- | --- | --- |
| `DeepSeekHarness-WhaleGirl.ico` | 桌面快捷方式 `dsh-web.lnk` 的图标（`IconLocation`） | 随快捷方式功能一起下线 |
| `improved-1.png` | 未被任何代码引用的原始素材 | 只是素材残渣 |

> 鲸鱼娘背景图 `whale-girl-transparent.png` **没有**归档：它归 `patches/whale-background/assets/`
> 所有，由该补丁自己的候选链解析（自身 `assets/` → `~/.dsh/assets/` → 本归档目录作为兜底）。

## 与归档无关的取舍

- 仓库的 CLI 补丁实现只在 `archive/web-scripts/patch-cli.ps1` 里存在一份；
  `scripts/install.ps1` / `scripts/deploy.ps1` 不再同步它到 `~/.dsh/scripts/`。
- 鲸鱼娘图标（favicon）**没有**归档：它已提升为**仓库级品牌资产**
  `assets/favicon-128.png`，不归任何补丁，由 `scripts/deploy.ps1` 同步到 `~/.dsh/assets/`。
