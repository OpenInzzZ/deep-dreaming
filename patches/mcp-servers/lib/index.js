/**
 * mcp-servers — 把外部 MCP 服务挂进 dsh（伞包宿主半端）。
 *
 * 一份配置、多个服务：`Config.servers` 是一个数组，`apply()` 对每一项挂一个
 * 官方 `@deepseek-ai/dsh-mcp-client` 子 fiber。服务清单因此是**配置**而不是
 * loader 行 —— 加一个服务不用改 yml、不用重启桌面端。
 * （多子 fiber 这条路已实测：同模块两个子 fiber 各注册自己的工具，命名空间互不
 * 干扰；`serverName` 撞名是**明确抛错**而不是静默失效；父 fiber dispose 会注销
 * 全部子 fiber 的工具。）
 *
 * 官方包本身不能直接用，两处原因都在本文件里补：
 *
 * 1. 它的 `Config` 是 `z.union([stdio, streamable-http])`。设置分区是从 entry 的
 *    `Config` 推导的，union 展不开成表单 —— 所以本包导出自己那份扁平 `Config`。
 * 2. `transport` 钉死 `streamable-http`，不放进表单：填成 stdio 却没有 `command`
 *    是死配置，而 IDE 侧端点只有这一个形态（实测 `/mcp` 404，`/sse` 是旧版传输、
 *    官方 client 不认纯 SSE）。
 *
 * 子 fiber 的入参还要再过一遍**官方自己的** schema：`headers`、`reconnect` 等默认值
 * 由它补，只走我们这份 Config 会让那些字段变成 undefined。
 */
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'

export const name = 'mcp-servers'

/** 子 fiber 要的服务依赖；与官方包声明的那份保持一致。 */
export const inject = [...mcpClient.inject]

/** 一个外部 MCP 服务。 */
const ServerSchema = z.object({
  /** 工具名前缀 `mcp__<serverName>__<tool>`；官方 client 全局预留，必须唯一。 */
  serverName: z.string(),
  /** Streamable HTTP 端点。 */
  url: z.string(),
  /**
   * 额外请求头。官方 client 的 streamable 分支本来就有这一项
   * （`dsh-mcp-client/lib/index.js:795` 的 `headers: z.dict(String).default({})`，
   * `:46` 把它塞进 `requestInit`），要带鉴权的服务（如 DBX 的 bearer token）靠它。
   * 这里必须显式声明：我们自己这份 ServerSchema 才是 `plainConfig()` 之后的校验关卡，
   * 没声明的键在进 `toMcpConfig()` 之前就被丢掉了。
   */
  headers: z.dict(String).default({}),
  // IDEA 实测：冷分析一个新文件 3.6s、热复用 0.13s、8 文件批量 4.9s。
  toolCallTimeoutMs: z.number().min(1000).default(90000),
  // false = 对方没起着时静默不激活（桌面端常常比被连的应用先起来）。
  failOnStartupError: z.boolean().default(false),
  // 我们自己的闸门：关掉的服务根本不挂子 fiber，不必去 IDE 侧拔工具。
  enabled: z.boolean().default(true),
})

/**
 * 设置卡片的表单。导出名必须正好是 `Config`：Cordis loader 读 `plugin.Config`
 * 校验 entry 配置，别的名字会被静默忽略。
 *
 * `servers` 必须 `.volatile()`：宿主的设置分区只收 volatile 字段
 * （`settings/src/index.ts:308` 的 `volatileForm` 为空就把这个 entry 整个跳过），
 * 漏标就是「卡片在、页面上什么都能改不了」。标了之后它在校验结果里是 `{ get }`
 * 访问器，读之前要 `plainConfig()` 摊平。
 */
export const Config = z.object({
  servers: z.array(ServerSchema).default([]).volatile(),
})

/**
 * 读平 volatile 盒子（官方同款：`llm-deepseek/src/config.ts:65` 的 `plainOptions`）。
 * 把盒子直接交给下游 schema 会被拒。
 */
export function plainConfig(config) {
  return Object.fromEntries(Object.entries(config ?? {}).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]))
}

/**
 * 一条服务里会影响子 fiber 行为的全部字段的稳定签名。
 *
 * 用途只有一个：配置热更新时判断"这一条到底变没变"。变了就撤掉子 fiber 重挂，
 * 没变就不动（避免把正在工作的连接平白断一次）。
 *
 * header 名按小写排序后比较：HTTP 头名不区分大小写，顺序也不该算差异。
 * 只列这四项，是因为别的字段进不了子 fiber（`transport` 是钉死的，`enabled`
 * 在 `selectServers()` 那层就决定挂不挂）。
 */
export function serverSignature(server) {
  const headers = Object.entries(server?.headers ?? {})
    .map(([name, value]) => [String(name).toLowerCase(), String(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify([
    server?.url ?? '',
    headers,
    server?.toolCallTimeoutMs ?? null,
    server?.failOnStartupError === true,
  ])
}

/**
 * 一条服务 -> 官方 client 认得的 streamable 配置（含它自己的默认值）。
 *
 * `headers` 必须换成一份**可变**副本：`.volatile()` 字段校验出来的对象是冻结的，
 * 而官方 `z.dict(String)` 会**原地写入**它补默认值，撞上冻结就抛
 * `Cannot assign to read only property '<name>' of object '#<Object>'` ——
 * 外层 union 把它归成普通的 "expected … but got …"，看不出真正原因。
 * 空 headers 不触发（没有键要写），所以只有填了鉴权头的服务会挂，这个坑在
 * 上次改动前不存在（那时 `headers` 没被声明，进 `toMcpConfig()` 前就被丢了）。
 */
export function toMcpConfig(server) {
  return mcpClient.Config({
    ...server,
    transport: 'streamable-http',
    headers: { ...(server?.headers ?? {}) },
  })
}

/**
 * 挑出要挂的服务：跳过 `enabled: false`，并按 `serverName` 去重。
 *
 * 去重是必须的：官方 client 在全局预留 `serverName`，两条同名会让后加载那条在
 * 加载阶段抛错，而那个异常落在这里会被当成"这个服务坏了"吞掉 —— 与其让第二台
 * 静默消失，不如在挂载前就只留一条。
 *
 * @param servers 已摊平的服务列表
 * @returns `{ taken, duplicates }`：要挂的服务与被去重掉的 serverName
 */
export function selectServers(servers) {
  const taken = []
  const duplicates = []
  const seen = new Set()
  for (const server of Array.isArray(servers) ? servers : []) {
    if (server?.enabled === false) continue
    if (seen.has(server?.serverName)) {
      duplicates.push(server.serverName)
      continue
    }
    seen.add(server?.serverName)
    taken.push(server)
  }
  return { taken, duplicates }
}

/**
 * 对比"当前挂着什么"与"配置要什么"，给出撤销与新增两组。
 *
 * @param mounted `serverName` -> 签名 的映射（本实例已挂的子 fiber）
 * @param servers 已摊平的服务列表（配置里的原样）
 * @returns `{ unmount, mount }`：要撕掉的名字、要新挂的服务（改过的服务两边都有）
 */
export function planReconcile(mounted, servers) {
  const { taken } = selectServers(servers)
  const wanted = new Map(taken.map((server) => [server.serverName, server]))
  const unmount = []
  for (const [name, signature] of mounted) {
    const next = wanted.get(name)
    if (next === undefined || serverSignature(next) !== signature) unmount.push(name)
  }
  const mount = taken.filter((server) => mounted.get(server.serverName) !== serverSignature(server))
  return { unmount, mount }
}

export function apply(ctx, config) {
  /** `serverName` -> `{ fiber, signature }`：本实例此刻挂着的子 fiber。 */
  const mounted = new Map()

  const mount = (server) => {
    // 一台坏配置不能带走其它服务：官方 apply 在建连失败且 failOnStartupError 为真时抛错。
    try {
      // 子模块对象按值传（官方 client 的 apply/Config/inject 都在上面）。
      // 不要 return 子 fiber：ctx.plugin 返回的是 thenable，apply 的返回值会被当作 Effect。
      const fiber = ctx.plugin({ ...mcpClient, name: `mcp-servers:${server.serverName}` }, toMcpConfig(server))
      mounted.set(server.serverName, { fiber, signature: serverSignature(server) })
    } catch (error) {
      ctx.logger?.warn?.(`mcp-servers: ${server.serverName} 挂载失败`, error)
    }
  }

  const signatures = () => new Map([...mounted].map(([name, entry]) => [name, entry.signature]))

  /**
   * 把挂载状态对齐到配置。
   *
   * 先撤后挂：官方 client 在**全局**预留 `serverName`，旧子 fiber 的注销是异步的，
   * 同名的下一个必须等它真的 dispose 完再 `ctx.plugin()`，否则加载阶段就撞名抛错。
   * 这也是整个函数串行化的原因。
   */
  async function reconcile() {
    const { unmount, mount: added } = planReconcile(signatures(), plainConfig(config).servers)
    for (const name of unmount) {
      const entry = mounted.get(name)
      mounted.delete(name)
      try {
        await entry.fiber.dispose()
      } catch (error) {
        ctx.logger?.warn?.(`mcp-servers: ${name} 卸载失败`, error)
      }
    }
    for (const server of added) mount(server)
  }

  // 激活时先把配置里的服务全挂上（和以前一样同步完成，激活即可用）。
  for (const server of selectServers(plainConfig(config).servers).taken) mount(server)

  /**
   * 运行期的增删改：**必须**自己对齐，`apply()` 不会重跑。
   *
   * `servers` 是 `.volatile()` 字段（设置分区只收 volatile 字段），而 Loader 对
   * "只改了 volatile 值"的更新有一条快路径：把新值写进运行中的配置盒子、发这个事件，
   * 然后**不重跑 apply()**（`vendor/loader/src/config/entry.ts:143` 的 volatileOnly，
   * 判等是 `equalExceptVolatile`，命中 `schema.meta.volatile` 就返回相等，
   * 见 `config/diff.ts:18`）。所以设置页里新加的服务如果只靠 apply() 挂，
   * 会一直是"配置里有、页面上显示运行中、模型却拿不到工具"。
   * 官方 llm-pi-ai / llm-deepseek 的 providers 也是同一个原因才监听这个事件。
   *
   * 事件里带的 `paths` 是本次变动的 volatile 字段路径；只关心 `servers`。
   */
  let queue = Promise.resolve()
  ctx.on('loader/volatile-update', (paths) => {
    if (!Array.isArray(paths) || !paths.some((path) => path?.[0] === 'servers')) return
    // 串行化：上一次 reconcile 还在 dispose 时不能开始下一次。
    queue = queue.then(reconcile, reconcile).catch((error) => {
      ctx.logger?.warn?.('mcp-servers: 配置同步失败', error)
    })
  })
}
