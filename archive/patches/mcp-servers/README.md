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
- 改配置 → **volatile 快路径**：Loader 只把新值写进运行中的配置盒子并发
  `loader/volatile-update`，**不会**重跑 `apply()`（见下节），所以本包自己监听该事件、
  按"配置要什么"对齐已挂的子 fiber（新增的就挂、删掉的就撕、改过的先撕再挂）。
  实测：设置页里加一条服务，几秒内工具就出现，不用重启。

## 编辑入口：设置 → MCP 服务

**官方没有通用的插件配置编辑器。** `plugins.row.config` 这个 keyed slot 在
0.2.0-rc.2 里只有声明方和消费方，**没有任何贡献方**（checkout 与打包 `app.asar` 都查过），
所以插件页的行详情页不会凭空长出表单。Host 侧照常提供 `settings.describe` / `mutate`，
缺的只是 UI —— 本包的客户端半端就是补这一块，注册在官方的 `settings.section` 位上
（与 `session-cleanup` 的卡片同一形状）。

页面上可以：看列表（名称 / 地址 / 运行中·已停用）、加服务、改服务、删服务、单条启停。
写入走 `configForms.get('mcp-servers').mutate([{ op:'set', path:['servers'], value }], revision)`，
不另开通道；revision 围栏挡住并发覆盖。

请求头是**键/值表单**，不是一段 JSON：每行一个头，可增、可删。空行在保存时忽略
（不写 `{}`，保持"未配置"的状态，也就不会无故改变签名、触发重连）；名称按 HTTP 规则
不区分大小写地查重，不能含空格或冒号；值不能含换行（`fetch` 会直接拒绝）。表单写的仍是
配置里的普通 `{ 名称: 值 }` 映射，存储形状与挂载逻辑都不变。

## 三个必须知道的 volatile 事实

1. **可编辑分区只收 `.volatile()` 标过的字段**：`settings/src/index.ts:308` 会把
   `volatileForm(Config)` 为空的 entry 整个跳过。漏标 = 卡片在、页面读不到任何东西。
2. **标了 volatile 之后，校验结果里该字段是 `{ get }` 访问器**，不是值。进 `apply` 后
   必须先摊平（官方同款 `plainOptions()`，`llm-deepseek/src/config.ts:65`；本包即
   `plainConfig()`）。把盒子直接交给别的 schema 会被拒。
3. **只改 volatile 字段的配置更新不会重跑 `apply()`**（这条最坑，本包踩过）：
   `vendor/loader/src/config/entry.ts:143` 判出 `volatileOnly` 后只做两件事 ——
   把新值写进运行中那份配置的 volatile 盒子（`updateVolatile`，同一个盒子原地换值，
   所以 `apply` 闭包里捕获的 `config` 也能读到新值），然后向该 entry 发
   `loader/volatile-update`（路径列表）。`config/diff.ts:18` 只要命中
   `schema.meta.volatile` 就直接判等，所以"删掉一个服务再保存"也属于 volatileOnly。
   含义：**任何由配置驱动的运行时结构都必须自己监听这个事件**（官方 `llm-pi-ai` 的
   `providers`、`llm-deepseek` 的 key 同理）。漏掉的表现是"配置里有、设置页显示运行中、
   模型却拿不到工具"，重启后才好 —— 因为重启时 `apply()` 才会按当前配置重挂。

   本包的实现：`planReconcile()` 给出要撕/要挂的名单，`reconcile()` 串行执行，
   **先 `await fiber.dispose()` 再挂同名的下一个**（官方 client 的 `serverName` 是全局
   预留，旧子 fiber 注销是异步的，不等就会在加载阶段撞名抛错）。

`.volatile()` 需要 schemastery ≥ 3.18.4。共享 store 曾经是 web 时代 npx 缓存的 250 条软链
（3.18.2，没这个 API），已于 2026-10-13 按运行时版本重新物化，`deploy.ps1` 现在会守住
"store 不得是指向 `npm-cache\_npx` 的软链"。

## 配置项

| 字段 | 默认 | 说明 |
|------|------|------|
| `serverName` | — | 工具名前缀；`[A-Za-z0-9_-]{1,32}`，全局唯一 |
| `url` | — | Streamable HTTP 端点 |
| `headers` | `{}` | 额外请求头；需要鉴权的服务在这里放 `Authorization` 等 |
| `toolCallTimeoutMs` | `90000` | 单次工具调用超时（官方默认 60s） |
| `failOnStartupError` | `false` | `false` = 对方没起着时静默不激活；`true` = 启动即报错 |
| `enabled` | `true` | 本包自己的闸门：关掉就不挂 |

`transport` 固定 `streamable-http`，不放进表单（填成 stdio 却没有 `command` 是死配置）。

### `headers` 必须复制一份再交给官方 schema

官方 `z.dict(String)` 补默认值时是**原地写入**输入对象，而 `.volatile()` 字段校验出来的
元素是**冻结**的（`Object.isFrozen` 为真）。两者一撞就抛
`Cannot assign to read only property '<name>' of object '#<Object>'`，外层 union 只会报
一句笼统的 `expected { transport?: "stdio", … } but got {…}`。所以 `toMcpConfig()` 里
`headers: { ...(server?.headers ?? {}) }` 这层复制是**承重**的，不是装饰。

空 headers 不触发（没有键要写），只有配了鉴权头的服务才会挂 —— 这个坑因此很隐蔽。
`tests/load-smoke.mjs` 对此的断言**必须走 `Config` 往返**（`viaConfig()`），
只写字面量的测试会全绿却漏掉它。

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

1. 打开 设置 → MCP 服务 → 添加服务，填名称与端点，保存后几秒内挂上（不需要重启；
   走的是 `loader/volatile-update` 那套热对齐，见上节第 3 条）。
2. 想让它成为**出厂默认**（换机也要有），再往 `cordis.patch.yml` 的 `servers` 里加一条。
3. 需要鉴权（如 DBX）就在「请求头」里点「添加请求头」：名称填 `Authorization`、
   值填 `Bearer <token>`（键/值表单，不需要手写 JSON）；地址栏只填到 `/mcp`，
   **不要多写一个斜杠**。

## 已接入的服务：DBX 数据库工具

`http://127.0.0.1:5225/mcp`，广播 **25** 个工具（`dbx_list_connections`、`dbx_execute_query`、
`dbx_describe_table` 等）。两个本机事实（2026-10-15 实测）：

- **必须带 bearer token**：匿名请求是 `401`；token 在
  `%APPDATA%\com.dbx.app\mcp-http-token`（64 位 hex）。
- **token 不轮换**：该文件 10-13 写入后未变，期间 dbx.exe 重启过（`mcp-bridge-port`
  会换，5225 是真正提供 MCP 的那个端口）。所以直接写进配置即可，不需要动态读。
- 路径少一个斜杠都不行：`/mcp` 是 200，`//mcp` 是 404（`--path-as-is` 实测）。

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
- 页面上的启停是"配置里关掉就不挂"：保存后数秒内撕掉那条子 fiber（工具随之消失），
  再打开会重新连接；不是把已连着的连接"热拔"，而是按变更逐条对齐。
- 对方应用在 dsh 启动时没开着时，官方 client 的重连预算（10 次、约 2 分钟）耗尽后
  就不再尝试了，工具会一直缺席；此时改一下配置（任意一条保存）或重启桌面端即可重挂。
