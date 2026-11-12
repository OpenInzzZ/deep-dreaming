/**
 * queue-reorder 的宿主半：一个排队消息重排端点。
 *
 * 官方 0.2.2-rc.1 的会话控制器只提供 `updateQueue(itemId, { kind: 'edit' |
 * 'remove' | 'steer' })`，没有「换顺序」这一动作；`QueueAction`
 * （packages/api/session-controller/src/types.ts:142）里也确实没有 reorder 分支。
 * 所以顺序只能在宿主侧改：Agent 的 `inbox` 暴露了标准 splice 语义
 * （packages/core/agent-loop/src/inbox.ts），一次 remove + insert 就会以
 * `agent/inbox/spliced` 持久事件的形式广播给每个客户端，前端不需要做任何
 * 乐观重排。
 *
 * 传输用 `webServer` 上的自注册前缀路由 `/queue-reorder`（共享的 `/api` 通道
 * 归 Typert 网关所有；`ctx.connection.rpc.handle` 在本版本对连接包之外的插件
 * 会抛 `cannot get property "webServer" without inject`）。围栏与既有补丁一致：
 * 同源校验、只收 POST、只收 application/json。
 *
 * 刻意不 import 任何 `@deepseek-ai/*`：宿主半只依赖注入进来的服务。
 */

/** 定位一条待发消息所在列表与位置；不在任何列表里时返回 undefined。 */
function locate(agent, itemId) {
  const inbox = agent.inbox
  const fromTurn = inbox.nextTurn.findIndex((message) => message.id === itemId)
  if (fromTurn >= 0) return { target: 'next-turn', from: fromTurn, placement: 'queued' }
  const fromStep = inbox.nextStep.findIndex((message) => message.id === itemId)
  if (fromStep >= 0) {
    // 客户端把 next-step 行渲染成 steering/context，从不当作 queued 行。
    const message = inbox.nextStep[fromStep]
    return {
      target: 'next-step',
      from: fromStep,
      placement: message.source?.kind === 'user' ? 'steering' : 'context',
    }
  }
  return undefined
}

const notFound = (itemId) => ({
  ok: false,
  error: {
    code: 'queue-item-not-found',
    message: 'queued item is no longer pending',
    details: { itemId },
  },
})

/** 消息还在待发状态，但不在调用方排序的那个列表里。 */
const placementMismatch = (itemId, expected, target, actual) => ({
  ok: false,
  error: {
    code: 'queue-item-placement-mismatch',
    message: `queued item is in the "${target}" list (placement "${actual}"), not "${expected}"`,
    details: { itemId, expected, actual, target },
  },
})

/** 宿主拒绝了这次 splice：如实报错，不伪装成功。 */
const spliceFailed = (itemId, target, error, restored) => ({
  ok: false,
  error: {
    code: 'queue-reorder-failed',
    message: `inbox splice failed: ${error instanceof Error ? error.message : String(error)}`,
    details: { itemId, target, restored },
  },
})

/**
 * 把一条待发消息移动到同一待发列表的 `toIndex`（0 基、移动后的最终位置）。
 *
 * 摘除之前先校验两个位置；插入被拒绝时把消息放回原处，所以一次失败的
 * 重排绝不会丢掉一条待发消息。
 *
 * @param agent - 持有该消息的在活 agent。
 * @param itemId - 待发消息 id。
 * @param toIndex - 目标最终位置，会夹到列表边界内。
 * @param expectedPlacement - 调用方据以计算 `toIndex` 的 placement；给了的话，
 *   位于另一个列表的消息会被拒绝，而不是被套上一个外来索引。
 */
export function reorderQueueItem(agent, itemId, toIndex, expectedPlacement) {
  const found = locate(agent, itemId)
  if (found === undefined) return notFound(itemId)
  const { target, from, placement } = found
  const inbox = agent.inbox
  const list = target === 'next-turn' ? inbox.nextTurn : inbox.nextStep

  // 源位置必须按它实际所在的列表校验：过期的索引会摘掉另一条消息。
  if (!Number.isInteger(from) || from < 0 || from >= list.length) return notFound(itemId)
  // 调用方的索引只相对某一个列表；套到消息真正所在的另一个列表上会静默错序。
  if (expectedPlacement !== undefined && expectedPlacement !== placement) {
    return placementMismatch(itemId, expectedPlacement, target, placement)
  }
  // 摘除后源列表只剩 length-1 条，因此该列表的每个最终位置都落在 0..length-1。
  const to = Math.max(0, Math.min(Number.isInteger(toIndex) ? toIndex : from, list.length - 1))

  let removed
  try {
    removed = inbox.splice(target, from, 1, [])
  } catch (error) {
    return spliceFailed(itemId, target, error, false)
  }
  if (removed.length === 0) return notFound(itemId)

  try {
    inbox.splice(target, to, 0, removed)
  } catch (error) {
    // 摘除已经提交，被摘下的消息只存在于这里：先放回去再报错，绝不报成功。
    let restored = false
    try {
      inbox.splice(target, Math.max(0, Math.min(from, list.length)), 0, removed)
      restored = true
    } catch {
      // 报告的是最初的失败；队列此时确实丢了这条消息。
    }
    return spliceFailed(itemId, target, error, restored)
  }
  return { ok: true, value: { accepted: true, to, target, placement } }
}

/**
 * 处理 `/queue-reorder` 前缀路由上的一次 `reorder` 请求。
 *
 * 路由把它当普通函数调用并传入在活服务；`this.agents` 是旧传输里的同一绑定，
 * 仍然被接受，所以两种形状都能调。
 *
 * @param endpoint - `/queue-reorder/<endpoint>` 里的端点名。
 * @param payload - 解析后的 JSON 体，本通道为 `{ args }`。
 * @param deps - `{ agents }`；省略时回退到 `this.agents`。
 */
async function handleEndpoint(endpoint, payload, deps) {
  if (endpoint !== 'reorder') {
    return {
      ok: false,
      error: { code: 'bad-request', message: `unknown endpoint: ${endpoint}`, details: {} },
    }
  }
  const args = payload?.args
  const sessionId = args?.sessionId
  const itemId = args?.itemId
  const toIndex = args?.toIndex
  const placement = args?.placement
  if (
    typeof sessionId !== 'string' ||
    typeof itemId !== 'string' ||
    !Number.isInteger(toIndex) ||
    typeof placement !== 'string'
  ) {
    return {
      ok: false,
      error: {
        code: 'bad-request',
        message: 'reorder requires sessionId (string), itemId (string), toIndex (integer), placement (string)',
        details: {},
      },
    }
  }
  const agents = deps !== undefined ? deps.agents : this?.agents
  const agent = agents.get(sessionId)
  if (agent === undefined) {
    return {
      ok: false,
      error: {
        code: 'session-not-found',
        message: 'session has no live agent',
        details: { sessionId },
      },
    }
  }
  return reorderQueueItem(agent, itemId, toIndex, placement)
}

/** 一次请求体上限，与其它补丁一致。 */
const MAX_BODY_BYTES = 1 << 20

/**
 * 在 `webServer` 上自注册一条前缀路由，替代 `ctx.connection.rpc`。
 *
 * dsh 0.1.5-rc.1 起 Connection 的 RPC 注册表对连接包之外的插件就不可用：
 * `handle()` 会调到 `register()`，后者在读它的 `owner`（也就是**读取方**插件
 * 的 ctx）上访问 `owner.webServer`，于是抛 `cannot get property "webServer"
 * without inject`，通道永远不会存在，浏览器的 `POST /<channel>/<endpoint>`
 * 会掉进 SPA 兜底（405/404）。
 *
 * 这里换成插件自己拥有的那层契约：一条前缀路由、同源围栏、只收 JSON 体，
 * 以及端点本来就返回的同一套 `{ ok, value }` / `{ ok, error: { code,
 * message, details } }` 信封。围栏沿用 Connection 自己的推理：跨站 POST 一定
 * 带着它自己的 `Origin`，而要求 `application/json` 会让浏览器先发预检（我们不
 * 应答预检），所以用户只是访问过的页面无法触达这些端点。
 *
 * @param path - 前缀路由路径，如 `/queue-reorder`。
 * @param handle - `async (endpoint, payload) => envelope`，与 RPC 处理器签名一致。
 */
export function createRpcRoute(path, handle) {
  const fail = (res, status, code, message) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: false, error: { code, message, details: {} } }))
  }
  return {
    kind: 'prefix',
    path,
    handler: (req, res) => {
      const host = req.headers.host
      const origin = req.headers.origin
      if (typeof origin === 'string' && origin.length > 0) {
        let sameOrigin = false
        try {
          sameOrigin = new URL(origin).host === host
        } catch {
          sameOrigin = false
        }
        if (!sameOrigin) return fail(res, 403, 'forbidden', 'cross-origin request refused')
      }
      if (req.method !== 'POST') return fail(res, 405, 'method-not-allowed', 'RPC endpoints accept POST only')
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (contentType !== 'application/json') return fail(res, 415, 'unsupported-media-type', 'content-type must be application/json')
      const url = String(req.url ?? '')
      const query = url.indexOf('?')
      const pathname = query === -1 ? url : url.slice(0, query)
      const endpoint = pathname.startsWith(`${path}/`) ? pathname.slice(path.length + 1) : undefined
      if (endpoint === undefined || endpoint.length === 0 || endpoint.includes('/')) {
        return fail(res, 404, 'unknown-endpoint', `unknown endpoint: ${JSON.stringify(pathname)}`)
      }
      let raw = ''
      let overflow = false
      req.on('data', (chunk) => {
        if (overflow) return
        raw += chunk
        if (raw.length > MAX_BODY_BYTES) {
          overflow = true
          req.destroy()
        }
      })
      req.on('error', () => { /* 客户端已经走了 */ })
      req.on('end', () => {
        if (overflow) return fail(res, 413, 'payload-too-large', 'request body is too large')
        let payload
        try {
          payload = raw.length === 0 ? {} : JSON.parse(raw)
        } catch {
          return fail(res, 400, 'bad-request', 'body is not JSON')
        }
        void Promise.resolve()
          .then(() => handle(endpoint, payload))
          .then(
            (envelope) => {
              if (res.writableEnded) return
              res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
              res.end(JSON.stringify(envelope))
            },
            (error) => {
              if (res.writableEnded) return
              fail(res, 500, 'internal', String(error?.message ?? error))
            },
          )
      })
    },
  }
}

/**
 * Cordis 插件入口：在 web 载体上发布 `/queue-reorder` 重排路由。
 *
 * `agents` 与 `webServer` 都是**静态** `inject` 依赖，而不是 `apply` 里的动态
 * `ctx.inject(...)`：用户层热重载不会重新激活动态子 fiber（通道会一直 404 直到
 * 整机重启），静态声明则不受影响——而且它是让 HTTP 载体在这里一定就绪的唯一
 * 办法：Cordis 并行挂载各行，`webServer` 绑定得比 `agents` 晚，用
 * `ctx.get('webServer')` 会竞态到 undefined 并静默丢掉整个传输层。
 */
export const inject = ['agents', 'webServer']

export function apply(ctx) {
  const agents = ctx.agents
  const handle = (endpoint, payload) => handleEndpoint(endpoint, payload, { agents })
  ctx.effect(
    () => ctx.webServer.register(createRpcRoute('/queue-reorder', handle)),
    'queue-reorder: /queue-reorder rpc route',
  )
}

export { handleEndpoint }