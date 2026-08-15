# deep-dreaming

个人 dsh(DeepSeek Harness)用户级补丁集。所有补丁都通过 `~/.dsh` 的
补丁层 / 插件机制装载,**不修改 dsh 源码**;本仓库是各补丁的实现来源与
文档所在。

## 目录结构

```
deep-dreaming/
├── README.md                     # 本文件:总览 + 补丁清单
├── patches/                      # 全部补丁,一补丁一目录(代码 + 测试 + 脚本 + README)
│   ├── session-cleanup/          # 会话日志自动清理(目录包插件)
│   ├── dsh-project-memory/       # 跨会话项目记忆(目录包插件)
│   ├── ui-settings-plugin-manager/  # Web 设置「插件管理」标签页(UI 插件)+ verify
│   ├── ui-settings-other/        # Web 设置「其他」页:服务状态/重启/空闲自动停止 + 静默启动脚本 + verify
│   └── ui-queue-tools/           # 排队消息增强:hover 全文预览 + 上下移排序 + verify
└── scripts/
    └── deploy.ps1                # 全局部署工具:同步补丁脚本 + 校验 patch 层引用与 junction,并为需要宿主依赖的插件自动补齐 node_modules 链接
```

## 补丁清单

| 补丁 | 作用 | 部署方式 | 使用文档 |
| --- | --- | --- | --- |
| [session-cleanup](patches/session-cleanup/) | 按天数/容量定期清理归档会话,跳过活跃会话 | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/session-cleanup/README.md) |
| [dsh-project-memory](patches/dsh-project-memory/) | 跨会话项目记忆:Agent 把确定性项目知识存为 Markdown 笔记,后续会话可检索 | `dsh plugin --profile web add` 安装到 profile | [README](patches/dsh-project-memory/README.md) |
| [ui-settings-plugin-manager](patches/ui-settings-plugin-manager/) | Web 设置新增「插件管理」标签页:状态过滤 + 官方/自定义分类 + **启停开关(热生效)** | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/ui-settings-plugin-manager/README.md) |
| [ui-settings-other](patches/ui-settings-other/) | Web 设置新增「其他」页:服务运行状态(pid/端口/内存/版本)+ **重载用户插件(热,不中断会话)** + 重启服务(危险)+ 空闲自动停止(可配,默认 2h);配套桌面快捷方式静默启动脚本 | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/ui-settings-other/README.md) |
| [ui-queue-tools](patches/ui-queue-tools/) | 排队消息增强:hover 预览全文 + 上移/下移排序(host 半经 Inbox.splice 重排) | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/ui-queue-tools/README.md) |

## 快速部署

补丁的装载方式分为两类,各自 README 里有完整步骤:

```powershell
# 1. 目录包插件(session-cleanup / ui-settings-plugin-manager /
#    ui-settings-other / ui-queue-tools):建立 junction 链接 + profile patch 条目
#    (条目增删/配置修改保存后数秒热生效,无需重启)
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-plugin-session-cleanup" -Target "D:\GitHub\deep-dreaming\patches\session-cleanup"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-settings-plugin-manager" -Target "D:\GitHub\deep-dreaming\patches\ui-settings-plugin-manager"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-settings-other" -Target "D:\GitHub\deep-dreaming\patches\ui-settings-other"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-queue-tools" -Target "D:\GitHub\deep-dreaming\patches\ui-queue-tools"

# 2. 组合包插件(dsh-project-memory):pnpm 装进 web profile,并把它追加进
#    profile package.json 的 dsh.profile.bundles(装载层由 bundle 提供)
corepack pnpm --dir "$env:USERPROFILE\.dsh\profiles\web" add D:\GitHub\deep-dreaming\patches\dsh-project-memory
# (然后手动在 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 追加
#  "dsh-project-memory";bundle 层变更需重启 dsh web 生效)

# 3. 部署校验(可随时运行):核对 patch 层引用与 junction,
#    并自动为需要宿主依赖的插件(dsh-project-memory / session-cleanup /
#    ui-settings-other)补齐或修复 node_modules junction
powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
```

> 路径写死为 `D:\GitHub\deep-dreaming`。仓库移动位置后,`dsh plugin add`
> 命令、junction 与各 README 中的路径需要同步更新(`deploy.ps1` 基于
> `$PSScriptRoot` 推导,自动跟随)。

## 热插拔(启停/改配置免重启)

dsh web 对 profile 的 `cordis.patch.yml` 内置热加载(`watchUserPatches`,
每个长期存活的 surface 无条件启用):

- **增删插件条目、修改条目 `config` → 保存文件后数秒内事务性生效**,
  host 半与 client 半都会重新装载/卸载,**无需重启 dsh**;
- 设置 →「其他」页的 **「重载用户插件」** 按钮即手动触发一次该热重载
  (不中断会话、排队消息不丢);
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
node patches/dsh-project-memory/tests/plugin.smoke.mjs           # 真实 Cordis 加载冒烟(工具/回顾/配置校验)
node patches/ui-settings-plugin-manager/verify-plugin-manager.mjs  # 契约验证(启停逻辑 + 清单/过滤器)
node patches/ui-settings-plugin-manager/tests/load-smoke.mjs      # 真实 Cordis 加载冒烟
node patches/ui-settings-other/verify-settings-other.mjs         # settings-other host + client 验证
node patches/ui-settings-other/tests/load-smoke.mjs              # 真实 Cordis 加载冒烟
node patches/ui-queue-tools/verify-queue-tools.mjs               # queue-tools host + client 验证
node patches/ui-queue-tools/tests/load-smoke.mjs                 # 真实 Cordis 加载冒烟
```
