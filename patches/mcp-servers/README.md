# mcp-servers — MCP 服务接入

一张设置页管理**多个外部 MCP 服务**：清单存在配置里，加/删服务不用改 yml、不用重启桌面端。
挂上之后，模型可以像调用原生工具一样调用这些服务的工具（工具名 `mcp__<服务名>__<工具>`）。

## 为什么不是 loader 行

`@deepseek-ai/dsh-mcp-client` **一个 entry 只连一个 server**，而设置分区的命名空间就是
entry id。若"一个服务 = 一行"，加服务就要改 bundle 的 `cordis.patch.yml` 并重启（bundle
自己的 yml 不在 HMR 监听范围内）。所以本包把清单收进**自己的一份配置**：

```yaml
config:
  servers:
    - serverName: idea
      url: http://127.0.0.1:64342/stream
      toolCallTimeoutMs: 90000
      failOnStartupError: false
      enabled: true
```

`apply()` 对每一项挂一个官方 client 子 fiber。已实测的行为：

- 两个子 fiber 同时挂载 → 各注册自己的工具，命名空间互不干扰（本机对 IDEA 实测：各 59 个）。
- `enabled: false` 的项**根本不挂**（不需要去 IDE 侧拔工具）。
- `serverName` 重名会在挂载前被收敛掉（官方 client 全局预留该名字，重名那条是**明确抛错**，
  见 `selectServers()`）。
- 父 fiber dispose → 全部子 fiber 的工具注销。
- 改配置（配置级 diff）→ `fiber.update` → `apply` 重跑 → 重新挂载，**热生效**。

## 编辑入口：设置 → MCP 服务

**官方没有通用的插件配置编辑器。** `plugins.row.config` 这个 keyed slot 在
0.2.0-rc.2 里只有声明方和消费方，**没有任何贡献方**（checkout 与打包 `app.asar` 都查过），
所以插件页的行详情页不会凭空长出表单。Host 侧照常提供 `settings.describe` / `mutate`，
缺的只是 UI —— 本包的客户端半端就是补这一块，注册在官方的 `settings.section` 位上
（与 `session-cleanup` 的卡片同一形状）。

页面上可以：看列表（名称 / 地址 / 运行中·已停用）、加服务、改服务、删服务、单条启停。
写入走 `configForms.get('mcp-servers').mutate([{ op:'set', path:['servers'], value }], revision)`，
不另开通道；revision 围栏挡住并发覆盖。

## 两个必须知道的 volatile 事实

1. **可编辑分区只收 `.volatile()` 标过的字段**：`settings/src/index.ts:308` 会把
   `volatileForm(Config)` 为空的 entry 整个跳过。漏标 = 卡片在、页面读不到任何东西。
2. **标了 volatile 之后，校验结果里该字段是 `{ get }` 访问器**，不是值。进 `apply` 后
   必须先摊平（官方同款 `plainOptions()`，`llm-deepseek/src/config.ts:65`；本包即
   `plainConfig()`）。把盒子直接交给别的 schema 会被拒。

`.volatile()` 需要 schemastery ≥ 3.18.4。共享 store 曾经是 web 时代 npx 缓存的 250 条软链
（3.18.2，没这个 API），已于 2026-10-13 按运行时版本重新物化，`deploy.ps1` 现在会守住
"store 不得是指向 `npm-cache\_npx` 的软链"。

## 配置项

| 字段 | 默认 | 说明 |
|------|------|------|
| `serverName` | — | 工具名前缀；`[A-Za-z0-9_-]{1,32}`，全局唯一 |
| `url` | — | Streamable HTTP 端点 |
| `toolCallTimeoutMs` | `90000` | 单次工具调用超时（官方默认 60s） |
| `failOnStartupError` | `false` | `false` = 对方没起着时静默不激活；`true` = 启动即报错 |
| `enabled` | `true` | 本包自己的闸门：关掉就不挂 |

`transport` 固定 `streamable-http`，不放进表单（填成 stdio 却没有 `command` 是死配置）。

## 已接入的服务：IDEA 代码诊断

出厂默认那一项。前置条件（IDEA 侧）：

| 条件 | 怎么确认 |
|------|----------|
| IDEA 2025.2+（MCP Server 插件随 IDE 捆绑） | 本机实测 `IU-262.10968.63` + 插件 `262.10968.92` |
| 插件已启用 | Settings → Plugins → 搜 `MCP Server`（禁用时 `disabled_plugins.txt` 里有 `com.intellij.mcpServer`） |
| server 已启动 | Settings → Tools → MCP Server → 勾选启用；日志出现 `io.ktor.server.Application - Responding at http://127.0.0.1:64342` |
| 项目已在 IDEA 里打开 | 诊断参数里的 `projectPath` 建议总是显式传 |

实测数据（2026-10-13）：

- 端点 `/stream` 是 Streamable HTTP（`initialize` → 200 + `mcp-session-id`，协议 `2025-06-18`）；
  `/mcp` 404，`/sse` 是旧版 HTTP+SSE 而官方 client 不认纯 SSE。
- 广播 **59** 个工具。主力是 `lint_files`（多文件，`min_severity`）与 `get_file_problems`（单文件）。
- 时序：冷分析一个新文件 **3.6s**、紧接着同一文件 **0.13s**、8 文件批量 **4.9s**。
- 正样本（埋 4 类错）：`不兼容的类型`、`无法解析符号`×2、`应为无参，但实际为 1 个`、
  `运算符 '+' 不能应用于 …` —— 5 条 ERROR，行列号精确。
- **干净文件会被整个省略**，不是返回空数组。
- 从 IDE 外部写入的文件（IDE 没获焦点）也能被诊断到。
- `/stream` 的 session 会被服务端较快回收（实测 2 次 `session not found`），同一会话内紧接着调正常。

## 安全边界

`dsh-mcp-client` 没有工具级过滤，挂上去就是该 server 广播的全部工具原样进模型视野；IDEA 那台
含写/执行类（`apply_patch`、`create_new_file`、`execute_terminal_command`、`build_project`、
`execute_sql_query` 等）。IDEA 侧的逐工具收口在 Settings → Tools → MCP Server → 子页
**Exposed Tools**。本仓库的裁定（2026-10-13）是全工具放开、不在 IDE 侧裁剪。

## 加一个服务

1. 打开 设置 → MCP 服务 → 添加服务，填名称与端点，保存即挂。
2. 想让它成为**出厂默认**（换机也要有），再往 `cordis.patch.yml` 的 `servers` 里加一条。

## 验证

```powershell
node patches/mcp-servers/tests/load-smoke.mjs        # 宿主端：映射、选择规则、真实挂载
node patches/mcp-servers/tests/client-contract.mjs   # 客户端：注册、字典、列表操作
node scripts/verify-plugin-meta.mjs                  # locale 标题/描述按 DSH 的读法解析
node scripts/verify-bundle-rows.mjs                  # bundle 声明与 cordis.patch.yml 结构
```

## 已知限制

- 诊断/工具质量绑在对方应用的模型上（IDEA 索引没跑完会吐假错误）。
- 目标应用没开着时工具静默消失（`failOnStartupError: false` 的代价）。
- 页面上的启停是"配置里关掉就不挂"，不是运行时热拔：改完会重挂整个 entry。
