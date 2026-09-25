# deep-dreaming

> **支持的 DSH 版本**: `>=0.1.0-rc.6`（当前适配至 `0.1.5-rc.2`）

个人 dsh(DeepSeek Harness)用户级补丁集。所有补丁都通过 `~/.dsh` 的
补丁层 / 插件机制装载,**不修改 dsh 源码**;本仓库是各补丁的实现来源与
文档所在。

## 目录结构

```
deep-dreaming/
├── README.md                     # 本文件:总览 + 补丁清单
├── package.json                  # 仅测试用依赖(react / react-dom / jsdom),npm install 后 npm test
├── patches/                      # 全部补丁,一补丁一目录(代码 + 测试 + 脚本 + README)
│   ├── dsh-project-memory/       # 跨会话项目记忆(Memorix 桥接,组合包插件)
│   ├── session-cleanup/          # 会话日志自动清理(目录包插件)
│   ├── ui-settings-plugin-manager/  # Web 设置「插件管理」标签页(UI 插件)+ verify
│   ├── ui-settings-other/        # Web 设置「其他」页:服务运行状态/创建桌面快捷方式/重启服务(危险,唯一危险按钮,三阶段进度条)+ 静默启动脚本 + verify
│   ├── ui-settings-model-reasoning/  # 设置「模型」页扩展:自定义(llm-pi-ai)模型的思考开关 + 思考等级 + verify
│   ├── ui-queue-tools/           # 排队消息增强:hover 全文预览 + 上下移排序 + verify
│   ├── temp-session/             # 侧边栏一键发起不绑定项目的临时会话 + verify
│   └── whale-background/         # 会话区域鲸鱼娘背景图(目录包插件)
└── scripts/
    ├── install.ps1               # 一键安装:建全部 junction + 合并 patch 条目 + 安装 bundle + Memorix + 部署校验(幂等)
    ├── deploy.ps1                # 部署校验:同步补丁脚本与品牌资产 + 核对 patch 层引用与 junction + 补齐 host 依赖链接
    ├── patch-cli.ps1             # 给 npx 缓存的 dsh CLI 打 `--clean`(跳过用户层)补丁;锚点不匹配时响亮失败、不写半套
    ├── migrate-dsh-memory.mjs    # 把旧版 .dsh-memory/ 笔记导入 Memorix(幂等,可 --dry-run)
    ├── run-tests.mjs             # 跑完整个测试矩阵(npm test)
    └── test-deps.mjs             # 验证脚本的 react / jsdom 解析(仓库 node_modules → NODE_PATH → profile)
```

## 补丁清单

| 补丁 | 作用 | 部署方式 | 使用文档 |
| --- | --- | --- | --- |
| [dsh-project-memory](patches/dsh-project-memory/) | 跨会话项目记忆:**Memorix 桥接**(存储/检索/去重/成熟度都在 Memorix)——注入提示词引导,并在会话第一轮召回既有记忆(带上本会话工作区根目录与项目绑定步骤),记忆存取由 Memorix 经 MCP(`mcp__memorix__*`)完成;记忆工具调用以**可折叠「记忆阶段」卡片**展示,**不产生额外对话轮次** | 作为 **bundle** 安装:`dsh plugin --profile web add`(或 `pnpm add`)进 profile 并登记到 `dsh.profile.bundles` + Memorix 全局安装与 `memorix setup --agent dsh --global` | [README](patches/dsh-project-memory/README.md) |
| [session-cleanup](patches/session-cleanup/) | 按天数/容量定期清理归档会话,跳过活跃会话 | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/session-cleanup/README.md) |
| [ui-settings-plugin-manager](patches/ui-settings-plugin-manager/) | Web 设置新增「插件管理」标签页:状态过滤 + 官方/自定义分类 + **启停开关(热生效)** | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/ui-settings-plugin-manager/README.md) |
| [ui-settings-other](patches/ui-settings-other/) | Web 设置新增「其他」页:服务运行状态(pid/端口/内存/版本 + 刷新)+ **创建桌面快捷方式(鲸鱼娘图标)** + **重启服务(唯一危险按钮,有会话运行时可选等待空闲或强制;三条断开路径统一确认,确认后三阶段进度条报告进度)**;**覆盖 Web 标题栏 favicon 为鲸鱼娘图标**;配套静默启动脚本与品牌资产 | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/ui-settings-other/README.md) |
| [ui-queue-tools](patches/ui-queue-tools/) | 排队消息增强:hover 预览全文 + 上移/下移排序(host 半经 Inbox.splice 重排) | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/ui-queue-tools/README.md) |
| [ui-settings-model-reasoning](patches/ui-settings-model-reasoning/) | 设置「模型」页扩展:给自定义(llm-pi-ai)路由逐模型配置**思考开关 + 思考等级(档位与发送值)**,写回 `reasoningEfforts`,模型菜单随之出现「推理等级」 | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/ui-settings-model-reasoning/README.md) |
| [temp-session](patches/temp-session/) | 侧边栏底部「临时会话」按钮:一键发起绑定**用户级临时目录**的会话,不关联任何项目 | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/temp-session/README.md) |
| [whale-background](patches/whale-background/) | 会话区域背景:在对话滚动区居中偏右显示鲸鱼娘透明图(13% 透明度),资源缺失时自动跳过而不影响启动 | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/whale-background/README.md) |

## 快速部署

**推荐一条命令**(任何机器克隆后即可,路径自动推导,无需改动):

```powershell
# 在仓库根目录执行:建全部 junction + 合并 patch 条目 + 安装
# dsh-project-memory bundle + 安装并接线 Memorix + 部署校验
# (幂等,可重复运行)
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
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-whale-background" -Target "$repo\patches\whale-background"

# 2. 组合包插件(dsh-project-memory):pnpm 装进 profile,并追加进 bundles
corepack pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" add "$repo\patches\dsh-project-memory"
# (然后在 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 追加
#  "dsh-project-memory";bundle 层变更需重启 dsh web 生效)

# 2.5 项目记忆的后端:Memorix 全局安装 + 写入 MCP 行(install.ps1 已含)
npm install -g memorix
memorix setup --agent dsh --global
# 旧版 .dsh-memory/ 笔记导入 Memorix(在对应项目根执行,幂等):
node "$repo\scripts\migrate-dsh-memory.mjs"

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
- 用户层 patch 文件位置有两处,都会被监视:`~/.dsh/profiles/web/cordis.patch.yml`
  (profile 层)与 `~/.dsh/cordis.patch.yml`(home 层,Memorix 的 MCP 行在这里)。
  实测:home 层新增 `@deepseek-ai/dsh-mcp-client` 行后,运行中的 dsh 数秒内就
  拉起了 `memorix serve`(日志 `[memorix] MCP Server running on stdio`),
  工具随之出现在会话里。
- 触发条件是**文件内容确有变化**:只改注释、或写回一份内容等价的文件都**不会**
  触发重挂 —— `Entry.update` 对 options 做深比较,无差异即直接返回;热重载不中断
  会话、排队消息不丢。设置 →「其他」页原有的「重载用户插件」按钮已移除,原因正是
  它只改写注释行、从不重挂任何插件。
- ⚠️ 尽管如此,**改过 patch 文件、要用 host 侧功能之前先重启**。2026-09-18 实测:
  一次整层重挂之后,`/queue`、`/app`、`/session-cleanup`、`/temp-session`、
  `/plugin-toggle` 五个通道全部消失(表现:排队消息拖拽排序报「排序失败」,因为
  `POST /queue/reorder` 落到 404),`session-cleanup` / `ui-settings-other` 的
  settings namespace 也一并从 `settings.describe()` 里消失,而这两个补丁的客户端半
  仍在正常渲染 —— 界面看起来一切正常。当时五个 host 半都用
  `ctx.connection.rpc.handle` 注册通道,而这条 API 在 dsh 0.1.5 对连接包之外的插件
  必然抛 `cannot get property "webServer" without inject`;抛错会把同一个 `apply`
  里此前注册的每一个 effect 一起回滚(路由、定时器、设置分区全没)。所以「重挂丢掉
  host 半」和「通道根本就没挂上」是同一个根因的两种表现,不是热加载本身的缺陷。
  现在五个 host 半统一为:自己往 `webServer` 注册一条 fenced 前缀路由,并且用
  **静态 `export const inject`** 把 `webServer` 声明成依赖(见 AGENTS.md
  「Client ↔ Host transport」),不再走连接服务的通道注册。
  - 自查:host 端读 `webServer` 的路由表最直接(应含 `/queue`、`/app` 等);浏览器侧
    发一个 `POST /<channel>/<endpoint>`(带 `content-type: application/json`)拿到
    `{ ok, ... }` JSON 信封即在册,落进 SPA 兜底(非 JSON 的 404/405)即不在册。
  - `install.ps1` 因此只在内容真的变化时才写该文件(无变化时 mtime 不变,不再触发
    无谓的整层重载)。
- **补丁源码(仓库文件)改动不热加载**:dsh web 官方禁用了模块级 HMR,且补丁位于
  `node_modules` 下不被监视;改完源码需重启 dsh web(`restart-dsh.ps1`,会中断所有
  运行中会话,请在空闲时进行);
- **client 半源码改动会被重新下发**:client-modules 的 HMR 会让该行改用新的
  bundle rev(实测改 `patches/temp-session/lib/client.js` 后,index 的
  `__DSH_BOOT__` 里该行 rev 从批次 rev 变成独立的 `73afc512e22f`),已打开的页面
  刷新即得新代码 —— 这也是能在不重启的情况下验证客户端修复的原因。
- bundle / profile manifest(`package.json` 的 `dsh.*`)改动需重启。

## 测试

```powershell
# 仓库根执行一次,取得 react / react-dom / jsdom(浏览器半的渲染验证用)
npm install

npm test                      # 跑完下面整张矩阵
npm test -- session           # 只跑路径/名称匹配的子集
node scripts/run-tests.mjs --list
```

单跑某一个:

```powershell
# 每个补丁自带无依赖或低依赖测试(测试与脚本随补丁目录):
node patches/session-cleanup/session-cleanup.test.mjs            # 清理规则
node patches/session-cleanup/verify-session-cleanup.mjs          # settings 集成 + 配置卡片
node patches/session-cleanup/tests/load-smoke.mjs                # 真实 Cordis 加载冒烟(Invalid effect 回归)
node patches/dsh-project-memory/tests/plugin.smoke.mjs           # Memorix 桥接:Config 校验 + 提示词/事件流(无回顾轮次)
node patches/dsh-project-memory/tests/client-contract.mjs        # 浏览器半契约(记忆折叠卡注册与渲染)
node patches/ui-settings-plugin-manager/verify-plugin-manager.mjs  # 契约验证(启停逻辑 + 清单/过滤器)
node patches/ui-settings-plugin-manager/tests/load-smoke.mjs      # 真实 Cordis 加载冒烟
node patches/ui-settings-other/verify-settings-other.mjs         # settings-other host + client 验证
node patches/ui-settings-other/tests/load-smoke.mjs              # 真实 Cordis 加载冒烟
node patches/ui-queue-tools/verify-queue-tools.mjs               # queue-tools host + client 验证
node patches/ui-queue-tools/tests/load-smoke.mjs                 # 真实 Cordis 加载冒烟
node patches/temp-session/verify-temp-session.mjs               # temp-session host + client 契约 + 点击流程(需 react/jsdom 的部分自动跳过)
node patches/ui-queue-tools/tests/load-smoke.mjs                 # 真实 Cordis 加载冒烟(静态 inject 声明 + 前缀路由)
node patches/ui-queue-tools/verify-queue-tools.mjs              # 排队工具 host + client 契约 + jsdom 拖拽/预览交互
node patches/ui-settings-model-reasoning/verify-model-reasoning.mjs  # 模型思考配置:契约 + jsdom 渲染/交互/保存 ops
node patches/ui-settings-model-reasoning/tests/load-smoke.mjs        # 真实 Cordis 加载冒烟
node patches/whale-background/tests/load-smoke.mjs              # 鲸鱼娘图片路由 + 资源存在性
```

浏览器半的断言需要 react/jsdom:仓库根 `npm install` 后即可跑全;缺依赖时
各脚本自动降级为纯契约检查并打印 `SKIP`(不会假装通过)。

## 适配记录(0.1.5-rc.2)

本轮适配修掉的问题,以及下次升级时要先看的地方:

1. **`@deepseek-ai/dsh-client-runtime` 包已被移除**(0.1.2-alpha.1 起):
   `dsh.client.inject` 里残留该名字不会报错(该字段是**信息性**的预取排序
   提示,不是服务注入、也不做加载时序约束),但已全部换成真实包名。
2. **客户端 Workspace API 拆分**:`ctx.workspaces` 只剩纯 Controller 面
   (`create/rename/delete/insertBefore/archiveSession/insertSessionBefore`),
   `refresh()` 消失(列表由 Controller 的 follow 流维持),新建会话导航移到
   `ctx.uiWorkspace.startSession()` —— temp-session 的点击流程据此重写。
3. **profile 的 node_modules 不再有 react**:客户端 UI 已改为预构建浏览器
   bundle,React 被打进前端产物。验证脚本因此改为多锚点解析
   (`scripts/test-deps.mjs`),并由仓库根 `package.json` 提供 react/jsdom。
4. **CLI 补丁的锚点漂移**:`profile-boot` 的 `composeProfile` 多了第三个参数、
   `resolveBoot` 的返回对象新增 `fromDefaultProfile` —— `patch-cli.ps1` 已按
   0.1.5-rc.2 重写,并**逐个替换做校验**:模式不匹配时响亮失败、不写半套。
5. **Memorix 必须绑定项目**:dsh 全进程只有一个 MCP 实例、工作目录是进程
   cwd(非 git 仓库),Memorix 会拒绝一切项目级工具,直到会话调用
   `memorix_session_start({ projectRoot })`;`dsh-project-memory` 的召回提示
   现在带上本会话工作区根目录。详见该补丁 README。
6. **`--clean` 仍然可用**:`dsh web --clean` 跳过用户层(`cordis.patch.yml`
   与 `--patch`),用户补丁把启动搞挂时的自救入口;它跳过的内容等价于
   `--dump-default-config` 打印的组合。
7. **回合后的「记忆回顾」已删除**(实测噪音 + 机制限制):`agent.followup(...)`
   的官方语义是「该条目自成一整轮」,所以旧 autoReview 每轮都多开一轮只含
   Thinking + 一句「无需记录」的对话 —— 本机某 62 轮会话里有 23 轮是这么来的。
   assistant 步骤的 chat node kind 由官方渲染器固定拥有,无法像工具卡片那样
   折叠,因此不再做回顾;保存改由 guidance 与 Memorix 的 `AGENTS.md` 规约驱动
   (保存时本来就是图 2 那种 `记忆 · 保存/更新` 卡片)。
8. **会话开始召回此前是死代码**(顺带修好):旧实现挂在第一条 `user/message`
   上并用 `ctx.agents.get()` 查 agent,而 agent 是在该消息落盘**之后**才发布
   进注册表的,查询必然落空 —— 本机 8 份最大的会话日志里 **0 次召回**。现在
   改挂 `turn/start`(由拥有该轮次的 agent 发出,查得到),并用
   `agent.inject(...)`(next-step、不唤醒)投递,使召回落在用户本轮之内而不
   新开一轮。
9. **patch 文件热重载会丢"已有行"的 host 半**(实测,详见「热插拔」一节):
   `install.ps1` 的一次写入让 `/queue` 等五个通道消失,排队消息拖拽排序因此
   报"排序失败"(`POST /queue/reorder` → 404),而客户端半仍在正常渲染。
   `install.ps1` 已改为内容无变化就不写文件;`ui-queue-tools` 的失败提示也
   改成区分"服务未加载"与"消息可能已开始发送",不再把前者说成后者。
   **结论:改过 patch 文件后,先重启再用 host 侧功能。**

### 本轮部署状态(2026-09-18)

已生效、无需重启(在运行中的 dsh 上实测):

- 7 个补丁的 client 行都在 index 的 `__DSH_BOOT__` 组合里(含重新接线的
  whale-background);`/whale-background.png` 返回 200 + PNG;
- 改过的 temp-session / dsh-project-memory 客户端 bundle 已按新 rev 下发;
- Memorix 已装(1.9.4)并按 `memorix setup --agent dsh --global` 接线,
  `memorix serve` 已由运行中的 dsh 拉起,`mcp__memorix__*` 工具可见可用;
- 旧笔记已迁移:`node scripts/migrate-dsh-memory.mjs` 导入 `.dsh-memory/`
  的 10 篇(3 篇新建、7 篇命中同名记录被跳过),旧目录保留未删。

需要**重启 dsh web** 才生效:

- host 半源码改动 —— `patches/dsh-project-memory/lib/index.js`:
  guidance 段落、第一轮召回(带本会话工作区根目录与绑定步骤)、
  **移除 autoReview**(重启后不再有回合结束的记忆回顾轮次);
- **五个已有补丁行的 host 半**(`/queue`、`/app`、`/session-cleanup`、
  `/temp-session`、`/plugin-toggle`):它们在 21:00 的那次 patch 文件写入后
  就没再注册,重启后才会回来 —— 排队消息拖拽排序、设置「其他」页的服务
  状态/重启/中断、会话清理卡片、临时会话按钮都依赖它们;
- `package.json` 里的 `dsh.client.inject` 元数据(启动时缓存的扫描结果)。

重启命令:`powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\scripts\restart-dsh.ps1"`
(会中断所有运行中会话;若补丁把启动搞挂,用 `dsh web --clean` 兜底)。
