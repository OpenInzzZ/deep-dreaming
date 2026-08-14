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
│   ├── ui-settings-other/        # Web 设置「其他」页:重启服务按钮 + restart-dsh.ps1 + verify
│   └── ui-queue-tools/           # 排队消息增强:hover 全文预览 + 上下移排序 + verify
└── scripts/
    └── deploy.ps1                # 全局部署工具:同步补丁脚本 + 校验 patch 层引用与 junction
```

## 补丁清单

| 补丁 | 作用 | 部署方式 | 使用文档 |
| --- | --- | --- | --- |
| [session-cleanup](patches/session-cleanup/) | 按天数/容量定期清理归档会话,跳过活跃会话 | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/session-cleanup/README.md) |
| [dsh-project-memory](patches/dsh-project-memory/) | 跨会话项目记忆:Agent 把确定性项目知识存为 Markdown 笔记,后续会话可检索 | `dsh plugin --profile web add` 安装到 profile | [README](patches/dsh-project-memory/README.md) |
| [ui-settings-plugin-manager](patches/ui-settings-plugin-manager/) | Web 设置新增「插件管理」标签页:状态过滤 + 官方/自定义分类 | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/ui-settings-plugin-manager/README.md) |
| [ui-settings-other](patches/ui-settings-other/) | Web 设置新增「其他」页:重启服务按钮(host 半自动重启 dsh 进程) | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/ui-settings-other/README.md) |
| [ui-queue-tools](patches/ui-queue-tools/) | 排队消息增强:hover 预览全文 + 上移/下移排序(host 半经 Inbox.splice 重排) | junction 链接到 profile node_modules + `~/.dsh/profiles/web/cordis.patch.yml` 条目 | [README](patches/ui-queue-tools/README.md) |

## 快速部署

补丁的装载方式分为两类,各自 README 里有完整步骤:

```powershell
# 1. 目录包插件(session-cleanup / ui-settings-plugin-manager /
#    ui-settings-other):建立 junction 链接 + profile patch 条目
#    (patch 热加载可用时保存后刷新页面即可;不可用时重启 dsh web 生效)
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-plugin-session-cleanup" -Target "D:\GitHub\deep-dreaming\patches\session-cleanup"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-settings-plugin-manager" -Target "D:\GitHub\deep-dreaming\patches\ui-settings-plugin-manager"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-settings-other" -Target "D:\GitHub\deep-dreaming\patches\ui-settings-other"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-queue-tools" -Target "D:\GitHub\deep-dreaming\patches\ui-queue-tools"

# 2. 目录包插件(dsh-project-memory):装进 web profile,重启 dsh web 生效
dsh plugin --profile web add D:\GitHub\deep-dreaming\patches\dsh-project-memory

# 3. 校验 patch 层引用与 junction(可随时运行)
powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
```

> 路径写死为 `D:\GitHub\deep-dreaming`。仓库移动位置后,`dsh plugin add`
> 命令、junction 与各 README 中的路径需要同步更新(`deploy.ps1` 基于
> `$PSScriptRoot` 推导,自动跟随)。

## 测试

```powershell
# 每个补丁自带无依赖或低依赖测试(测试与脚本随补丁目录):
node patches/session-cleanup/session-cleanup.test.mjs            # 清理规则
node patches/session-cleanup/verify-session-cleanup.mjs          # settings 集成 + 配置卡片
node patches/dsh-project-memory/tests/store.test.mjs             # 记忆库逻辑
node patches/ui-settings-plugin-manager/verify-plugin-manager.mjs  # 部署后的 UI 插件端到端验证
node patches/ui-settings-other/verify-settings-other.mjs         # settings-other host + client 验证
node patches/ui-queue-tools/verify-queue-tools.mjs               # queue-tools host + client 验证
```
