# session-cleanup —— 会话日志自动清理插件

按**保留天数** / **总大小上限**定期清理 dsh 的归档会话目录
(`$DSH_HOME/sessions`,默认 `~/.dsh/sessions`),**跳过当前活跃会话**。
防止长时间使用后 `sessions` 目录无限膨胀占用磁盘。

- 插件类型:目录包插件(包名 `@local/dsh-plugin-session-cleanup`),通过
  `cordis.patch.yml` 的 `insert` 装载,不修改 dsh 源码。
- 清理对象:`<sessions根>/<项目>/session-<uuid>/` 形态的归档目录;活跃会话
  由 `sessions` 服务实时列表识别并跳过。
- 双重规则:超龄删除(带最少保留数保护)+ 总容量超限时按最旧优先删。

## 安装与部署

与 ui-settings-* 插件相同的机制:实现来源在本仓库,部署侧建立 junction
链接 + patch 条目。

```powershell
# 1. 建立指向本目录的目录联接(junction)
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-plugin-session-cleanup" -Target "D:\GitHub\deep-dreaming\patches\session-cleanup"

# 2. 在 ~/.dsh/profiles/web/cordis.patch.yml 中追加启用条目
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: session-cleanup
      name: '@local/dsh-plugin-session-cleanup'
      config:
        maxAgeDays: 30
        maxTotalMB: 1024
        keepSessions: 5
        intervalMinutes: 360
        dryRun: false
```

> 旧版本通过 `~/.dsh/cordis.patch.yml` 的 `file://` URL 直接加载单文件;
> 已迁移为包名形式(插件管理页按 `@local/...` 显示)。若迁移前安装过,
> 记得删除 home 层的旧条目,避免重复加载。

3. **重启 dsh** 使插件加载。启动时立即执行一次清理,之后按
   `intervalMinutes` 周期执行。

## 如何使用

插件加载后无需任何手动操作,清理自动进行;日志会输出每次清理摘要:

```
[startup] scanned=12 liveSkipped=1 kept=5 totalBytes=184321024 | removed=6 freedBytes=155123712 (session-aaaa, session-bbbb, ...)
```

- `scanned` — 扫描到的归档会话数;`liveSkipped` — 跳过的活跃会话数
- `removed` — 本次删除的会话(id 列表,`[dry]` 标记演练模式)
- 有错误时追加 `errors=N: <详情>`

**验证规则是否符合预期**(推荐先演练):

1. 在 `cordis.patch.yml` 把 `dryRun` 改为 `true`,重启,观察日志 —— 只报告
   将要删除的会话,不实际删除;
2. 确认无误后改回 `false` 重启生效。

**临时手动清理**:想立即触发一次,重启 dsh 即可(启动时自动清理一次)。

## 配置项

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 插件总开关,`false` 时插件不装载 |
| `maxAgeDays` | `30` | 超过该天数的会话可删;`0` = 不按天数清理 |
| `maxTotalMB` | `1024` | sessions 总占用上限 MB;`0` = 不限制 |
| `keepSessions` | `5` | 最少保留的会话数(超龄规则仅作用于最旧超出部分) |
| `intervalMinutes` | `360` | 清理间隔分钟(启动时总会先清一次) |
| `dryRun` | `false` | 演练模式:只报告不删除 |
| `sessionsRoot` | `$DSH_HOME/sessions` | 会话根目录,可指向其他位置 |

清理判定(两条规则取并集):

- **规则 A(超龄)**:按最后修改时间从新到旧排序,仅对超出 `keepSessions`
  的最旧部分,删除 `mtime` 早于 `now - maxAgeDays` 天的会话 —— 最近常用的
  会话即使超龄也受 `keepSessions` 保护。
- **规则 B(超容量)**:全部候选(不含活跃会话)总占用超过 `maxTotalMB`
  时,从最旧开始删直到低于上限;被规则 A 选中的会话不重复计。
- 删除后会顺带清理变空的 `<项目>` 目录(演练模式不做任何删除)。

## 卸载

1. 删除 `~/.dsh/profiles/web/cordis.patch.yml` 中的 `session-cleanup` 条目;
2. 删除 `~/.dsh/profiles/node_modules/@local/dsh-plugin-session-cleanup`
   链接;
3. 重启 dsh。

## 测试

```powershell
node patches/session-cleanup/session-cleanup.test.mjs
```

覆盖:超龄删除、`keepSessions` 保护、容量上限、活跃会话跳过、演练模式、
空项目目录清理等场景。
