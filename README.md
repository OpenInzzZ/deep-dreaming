# deep-dreaming

> **支持的 DSH 版本**: `>=0.1.0-rc.6`（已在 `0.1.5-rc.1` 上验证）

个人 dsh(DeepSeek Harness)用户级补丁集。所有补丁都通过 `~/.dsh` 的
补丁层 / 插件机制装载,**不修改 dsh 源码**;本仓库是各补丁的实现来源与
文档所在。

## 目录结构

```
deep-dreaming/
├── README.md                     # 本文件:总览 + 补丁清单
├── patches/                      # 全部补丁,一补丁一目录(代码 + 测试 + 脚本 + README)
│   ├── dsh-project-memory/       # 跨会话项目记忆(组合包插件)
│   ├── session-cleanup/          # 会话日志自动清理(目录包插件)
│   ├── ui-settings-plugin-manager/  # Web 设置「插件管理」标签页(UI 插件)+ verify
│   ├── ui-settings-other/        # Web 设置「其他」页:服务运行状态/创建桌面快捷方式/重启服务(危险,唯一危险按钮)/空闲自动停止 + 静默启动脚本 + verify
│   ├── ui-settings-model-reasoning/  # 设置「模型」页扩展:自定义(llm-pi-ai)模型的思考开关 + 思考等级 + verify
│   ├── ui-queue-tools/           # 排队消息增强:hover 全文预览 + 上下移排序 + verify
│   ├── temp-session/             # 侧边栏一键发起不绑定项目的临时会话 + verify
│   └── whale-background/         # 会话区域鲸鱼娘背景图(目录包插件)
└── scripts/
    ├── install.ps1               # 一键安装:建全部 junction + 合并 patch 条目 + 安装 bundle + 部署校验(幂等)
    ├── deploy.ps1                # 部署校验:同步补丁脚本与品牌资产 + 核对 patch 层引用与 junction + 补齐 host 依赖
    └── patch-cli.ps1             # 给 npx 缓存里的 dsh CLI 注入 `--clean`(严格断言 + 自校验,失败自动回滚)
```

## 补丁清单

| 补丁 | 作用 | 部署方式 | 使用文档 |
| --- | --- | --- | --- |
| [dsh-project-memory](patches/dsh-project-memory/) | 跨会话项目记忆桥:**Memorix (MCP)** 负责存储/检索/去重/成熟度,本补丁只做「提示词引导 + 会话开始召回 followup + 每轮结束回顾 followup」;`mcp__memorix__*` 工具调用以**可折叠记忆卡片**展示 | 作为 **bundle** 安装:`dsh plugin --profile web add`(或 `pnpm add`)进 profile 并登记到 `dsh.profile.bundles` | [README](patches/dsh-project-memory/README.md) |
| [session-cleanup](patches/session-cleanup/) | 按天数/容量定期清理归档会话,跳过活跃会话 | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/session-cleanup/README.md) |
| [ui-settings-plugin-manager](patches/ui-settings-plugin-manager/) | Web 设置新增「插件管理」标签页:状态过滤 + 官方/自定义分类 + **启停开关(热生效)** | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/ui-settings-plugin-manager/README.md) |
| [ui-settings-other](patches/ui-settings-other/) | Web 设置新增「其他」页:服务运行状态(pid/端口/内存/版本 + 刷新)+ **创建桌面快捷方式(鲸鱼娘图标)** + **重启服务(唯一危险按钮,有会话运行时可选等待空闲或强制)** + 空闲自动停止(可配,默认 2h);**覆盖 Web 标题栏 favicon 为鲸鱼娘图标**;配套静默启动脚本与品牌资产 | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/ui-settings-other/README.md) |
| [ui-queue-tools](patches/ui-queue-tools/) | 排队消息增强:hover 预览全文 + 上移/下移排序(host 半经 Inbox.splice 重排) | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/ui-queue-tools/README.md) |
| [ui-settings-model-reasoning](patches/ui-settings-model-reasoning/) | 设置「模型」页扩展:给自定义(llm-pi-ai)路由逐模型配置**思考开关 + 思考等级(档位与发送值)**,写回 `reasoningEfforts`,模型菜单随之出现「推理等级」 | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/ui-settings-model-reasoning/README.md) |
| [temp-session](patches/temp-session/) | 侧边栏底部「临时会话」按钮:一键发起绑定**用户级临时目录**的会话,不关联任何项目 | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/temp-session/README.md) |
| [whale-background](patches/whale-background/) | 会话区域背景:在对话滚动区居中偏右显示鲸鱼娘透明图(13% 透明度),资源缺失时自动跳过而不影响启动 | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/whale-background/README.md) |

## 快速部署

**推荐一条命令**(任何机器克隆后即可,路径自动推导,无需改动):

```powershell
# 在仓库根目录执行:建全部 junction + 合并 patch 条目 + 安装
# dsh-project-memory bundle + 部署校验(幂等,可重复运行)
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
# 完成后重启 dsh web:
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\scripts\restart-dsh.ps1"
```

`install.ps1` 还会:幂等安装 **Memorix**(`npm install -g memorix` + `memorix setup --agent dsh --global`,写进 `~/.dsh/cordis.patch.yml`,用 `-SkipMemorix` 跳过)、把 `dsh-project-memory` 收敛为唯一的 bundle 属主(见下节不变量)、修好 `dsh web --clean` 逃生舱。所有脚本读写配置文件都走显式 UTF-8(Windows PowerShell 5.1 的 `Get-Content`/`Set-Content` 默认按 ANSI 解码,会把中文注释写成乱码)。

手工方式(路径用变量,不写死):

```powershell
$repo = (Resolve-Path .).Path          # 在仓库根执行;其它位置请指向克隆目录

# 1. 目录包插件:建立 junction 链接 + profile patch 条目
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-plugin-session-cleanup" -Target "$repo\patches\session-cleanup"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-settings-plugin-manager" -Target "$repo\patches\ui-settings-plugin-manager"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-settings-other" -Target "$repo\patches\ui-settings-other"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-queue-tools" -Target "$repo\patches\ui-queue-tools"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-temp-session" -Target "$repo\patches\temp-session"

# 2. 组合包插件(dsh-project-memory):pnpm 装进 profile,并追加进 bundles
corepack pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" add "$repo\patches\dsh-project-memory"
# (然后在 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 追加
#  "dsh-project-memory";bundle 层变更需重启 dsh web 生效)

# 3. 部署校验(可随时运行):核对 patch 层引用与 junction,
#    并自动为需要宿主依赖的插件补齐或修复 node_modules junction
powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
```

> 仓库内**不写死任何绝对路径**:所有脚本基于 `$PSScriptRoot` 推导,补丁
> 代码基于 `import.meta.url` / `%USERPROFILE%` 解析;克隆到任何位置、
> 任何用户名下均可直接使用(`install.ps1` / `deploy.ps1` 自动跟随)。

## 部署不变量(必读)

- **一个 loader 行只能有一个来源。** `dsh-project-memory` 声明了 `dsh.bundle`,它的行由 bundle 层(包自带 `cordis.patch.yml`)提供;profile 层**不能**再写 `- id: project-memory`。两层若同时提供同一个 id,`applyEntryPatches` 不会去重,Loader 会 fail-loud 抛 `TypeError: duplicate loader entry id`,dsh 直接起不来。`install.ps1` 会**先**删掉 profile 行再装 bundle(若 bundle 步骤失败则把行恢复回去);`deploy.ps1` 检测到两者并存会报 FAIL。
  注意 `dsh plugin add` / `dsh plugin update --profile web` 会自行把声明了 `dsh.bundle` 的依赖补进 `dsh.profile.bundles`,所以不要"为了保险"两边都写。
- 其余 7 个补丁都是目录包:junction + profile 层 `- insert:` 行。
- **不要在 `patches/` 下做递归扫描**:`patches/<p>/node_modules` 是指向 `~/.dsh/profiles/node_modules` 的 junction,而 profile 里的 `@local/*` 又指回 `patches/*`,形成环;`Get-ChildItem -Recurse` 之类的命令不会结束。

## 故障恢复:`dsh web --clean`

某个用户级补丁把启动搞坏时(比如上面那条 duplicate id),用干净启动绕过整个用户层:

```powershell
dsh web --clean                  # 只加载 bundle 层,跳过 profile 层 / home 层 / --patch 覆盖层
dsh web --clean --dump-config    # 先看干净启动会组合出什么,再决定
```

官方没有这个开关:`scripts/patch-cli.ps1` 把它注入到 **npx 缓存**里的 dsh 构建(`lib/bin.js` + `profile-boot-*.js` + `dump-config-*.js`),不碰任何源码检出。这些是带 hash 的构建产物、每个 dsh 版本形状都不同,所以脚本是严格的:每处替换必须命中(或已应用)、写完必须过 `node --check`、最后还会真的跑两次 CLI 验证用户层确实消失;任何一步失败就回滚备份并以 1 退出。**每次升级 dsh 后重跑一次**(新的 npx 缓存里没有 `--clean`)。`start-dsh.ps1` / `restart-dsh.ps1` 会调用部署到 `~/.dsh/scripts/patch-dsh-cli.ps1` 的同一实现。

## 热插拔(启停/改配置免重启)

dsh web 对 profile 的 `cordis.patch.yml` 内置热加载(`watchUserPatches`,
每个长期存活的 surface 无条件启用):

- **增删插件条目、修改条目 `config` → 保存文件后数秒内事务性生效**,
  host 半与 client 半都会重新装载/卸载,**无需重启 dsh**;
- 触发条件是**文件内容确有变化**:只改注释、或写回一份内容等价的文件都
  **不会**触发重挂 —— `Entry.update` 对 options 做深比较,无差异即直接返回
  (设置 →「其他」页原有的「重载用户插件」按钮已移除,原因正是它只改写注释
  行、从不重挂任何插件);热重载不中断会话、排队消息不丢;
- **修改补丁源码(仓库文件)不热加载**:dsh web 官方禁用了模块级 HMR,且
  补丁位于 `node_modules` 下不被监视。改完源码后需重启 dsh web
  (`restart-dsh.ps1`,会中断所有运行中会话,请在空闲时进行)。

## 测试

```powershell
# 每个补丁自带无依赖或低依赖测试(测试与脚本随补丁目录):
node patches/session-cleanup/session-cleanup.test.mjs            # 清理规则
node patches/session-cleanup/verify-session-cleanup.mjs          # settings 集成 + 配置卡片
node patches/session-cleanup/tests/load-smoke.mjs                # 真实 Cordis 加载冒烟(Invalid effect 回归)
node patches/dsh-project-memory/tests/store.test.mjs             # 记忆库逻辑
node patches/dsh-project-memory/tests/plugin.smoke.mjs           # 真实 Cordis 加载冒烟(引导段/召回/回顾)
node patches/dsh-project-memory/tests/client-contract.mjs        # 浏览器半契约(记忆折叠卡注册)
node patches/ui-settings-plugin-manager/verify-plugin-manager.mjs  # 契约验证(启停逻辑 + 清单/过滤器)
node patches/ui-settings-plugin-manager/tests/load-smoke.mjs      # 真实 Cordis 加载冒烟
node patches/ui-settings-other/verify-settings-other.mjs         # settings-other host + client 验证
node patches/ui-settings-other/tests/load-smoke.mjs              # 真实 Cordis 加载冒烟
node patches/ui-queue-tools/verify-queue-tools.mjs               # queue-tools host + client 验证
node patches/ui-queue-tools/tests/load-smoke.mjs                 # 真实 Cordis 加载冒烟
node patches/temp-session/verify-temp-session.mjs               # temp-session host + client 契约 + 点击流程(需 jsdom 的部分自动跳过)
node patches/ui-settings-model-reasoning/verify-model-reasoning.mjs  # 模型思考配置:契约 + jsdom 渲染/交互/保存 ops
node patches/ui-settings-model-reasoning/tests/load-smoke.mjs        # 真实 Cordis 加载冒烟
```
