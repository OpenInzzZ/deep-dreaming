/**
 * Host half of the ui-queue-tools patch: a queue-reorder RPC endpoint.
 *
 * Exposes a dedicated `webServer` prefix route `/queue` (the shared `/api`
 * channel is exclusively owned by the Typert gateway, and `ctx.connection.rpc`
 * cannot register a channel at all in dsh 0.1.5-rc.1 — see `createRpcRoute`).
 * The `reorder` endpoint moves one still-pending queued message within the
 * agent's `next-turn` inbox list using the Inbox's standard `splice` semantics,
 * so the durable `agent/inbox/spliced` event stream broadcasts the new order to
 * every client exactly like an append/remove would.
 *
 * The caller declares the `placement` its `toIndex` was computed against (the
 * dock renders the `queued` — i.e. `next-turn` — rows), so an item that is
 * actually pending in another list is refused with
 * `queue-item-placement-mismatch` instead of having a foreign index applied to
 * it. `reorderQueueItem` itself stays list-agnostic and reports the list and
 * placement it operated on.
 *
 * Deliberately dependency-free apart from `node:child_process`-free code: the
 * host entry imports nothing but the injected services.
 */

/** Locate one pending message's list position, or undefined when not pending. */
function locate(agent, itemId) {
  const inbox = agent.inbox
  const fromTurn = inbox.nextTurn.findIndex((message) => message.id === itemId)
  if (fromTurn >= 0) return { target: 'next-turn', from: fromTurn, placement: 'queued' }
  const fromStep = inbox.nextStep.findIndex((message) => message.id === itemId)
  if (fromStep >= 0) {
    // The Client renders `next-step` rows as `steering`/`context`, never as
    // `queued` (see the Session Controller's queue projection).
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

/** The item is pending, but not in the list the caller sorted. */
const placementMismatch = (itemId, expected, target, actual) => ({
  ok: false,
  error: {
    code: 'queue-item-placement-mismatch',
    message: `queued item is in the "${target}" list (placement "${actual}"), not "${expected}"`,
    details: { itemId, expected, actual, target },
  },
})

/** A splice the inbox refused; reported instead of surfacing as a success. */
const spliceFailed = (itemId, target, error, restored) => ({
  ok: false,
  error: {
    code: 'queue-reorder-failed',
    message: `inbox splice failed: ${error instanceof Error ? error.message : String(error)}`,
    details: { itemId, target, restored },
  },
})

/**
 * Move one pending queue item to `toIndex` (0-based FINAL position in the
 * same pending list, i.e. where the item should sit after the move).
 *
 * Both positions are validated before anything is detached, and a refused
 * insertion puts the message back where it was, so a rejected reorder can
 * never lose a pending message.
 *
 * @param agent - live agent whose inbox owns the item.
 * @param itemId - pending message id.
 * @param toIndex - target final position, clamped to the list bounds.
 * @param expectedPlacement - placement the caller computed `toIndex` against;
 *   when given, an item living in another list is refused instead of moved.
 */
export function reorderQueueItem(agent, itemId, toIndex, expectedPlacement) {
  const found = locate(agent, itemId)
  if (found === undefined) return notFound(itemId)
  const { target, from, placement } = found
  const inbox = agent.inbox
  const list = target === 'next-turn' ? inbox.nextTurn : inbox.nextStep

  // Validate the source position against the list it was found in: a stale
  // index would detach an unrelated message.
  if (!Number.isInteger(from) || from < 0 || from >= list.length) return notFound(itemId)
  // The caller's index is relative to ONE list; applying it to the list the
  // item actually sits in would silently mis-order the caller's view.
  if (expectedPlacement !== undefined && expectedPlacement !== placement) {
    return placementMismatch(itemId, expectedPlacement, target, placement)
  }
  // After the removal the source list holds `length - 1` messages, so every
  // final position of that list is inside 0..length-1.
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
    // The removal already committed, so the detached messages only exist
    // here: restore them before reporting, and never report success.
    let restored = false
    try {
      inbox.splice(target, Math.max(0, Math.min(from, list.length)), 0, removed)
      restored = true
    } catch {
      // The original failure is the one reported; the queue already lost them.
    }
    return spliceFailed(itemId, target, error, restored)
  }
  return { ok: true, value: { accepted: true, to, target, placement } }
}

/**
 * Handle one `reorder` request on the `/queue` prefix route.
 *
 * The route calls this as a plain function and passes the live services as
 * `deps`; `this.agents` is the same binding the previous transport used and is
 * still honoured, so the endpoint stays callable in either shape.
 *
 * @param endpoint - endpoint name from `/queue/<endpoint>`.
 * @param payload - parsed JSON body, `{ args }` for this channel.
 * @param deps - `{ agents }`; falls back to `this.agents` when omitted.
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

/**
 * Local RPC over a `webServer` route, replacing `ctx.connection.rpc`.
 *
 * dsh 0.1.5-rc.1 broke the Connection RPC registry for every plugin outside
 * the connection package: `handle()` calls `register()`, which touches
 * `owner.webServer` on a context that never declared `webServer`, so it throws
 * `cannot get property "webServer" without inject`. The channel then never
 * exists and the browser's `POST /<channel>/<endpoint>` requests fall through
 * to the SPA fallback (405/404).
 *
 * This is the same contract on the surface a plugin does own: one prefix route,
 * a same-origin fence, JSON-only bodies, and the identical
 * `{ ok, value }` / `{ ok, error: { code, message, details } }` envelope the
 * endpoint handlers already return. The fence mirrors the Connection's own
 * reasoning: a cross-site POST always carries its own `Origin`, and requiring
 * `application/json` makes the browser preflight it (we never answer that
 * preflight), so a page the user merely visits cannot reach these endpoints.
 *
 * @param path - prefix route path, e.g. `/queue`.
 * @param handle - `async (endpoint, payload) => envelope`, unchanged from the
 *   RPC handler signature.
 */
export function createRpcRoute(path, handle) {
  const MAX_BODY_BYTES = 1 << 20
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
      req.on('error', () => { /* client went away */ })
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
 * Cordis plugin entry: publish the `/queue` reorder route on the web carrier.
 *
 * `agents` and `webServer` are **static** `inject` dependencies, not a dynamic
 * `ctx.inject(...)` inside `apply`: a user-layer hot reload does not re-activate
 * the dynamic child fiber (the channel stayed 404 until a full restart), while
 * the static form is unaffected — and it is what makes the HTTP carrier actually
 * present here, since Cordis mounts rows in parallel and `webServer` binds later
 * than `agents`. Reading it with `ctx.get('webServer')` during activation races
 * that binding, sees `undefined`, and silently drops the page's whole transport;
 * that race is how four of five migrated patches came up dead after the first
 * restart.
 */
export const inject = ['agents', 'webServer']

export function apply(ctx) {
  const agents = ctx.agents
  const handle = (endpoint, payload) => handleEndpoint(endpoint, payload, { agents })
  // The page reaches this half over one prefix route on the web carrier.
  // `ctx.connection.rpc.handle` is not an option in dsh 0.1.5: its registry
  // reads `owner.webServer` on the *reading* plugin's context, which never
  // declared it, and throws `cannot get property "webServer" without inject`, so
  // no channel would exist and the drag would land on the SPA fallback.
  // See createRpcRoute() for the fence that replaces the Connection's own.
  ctx.effect(() => ctx.webServer.register(createRpcRoute('/queue', handle)), 'ui-queue-tools: /queue rpc route')
}

export { handleEndpoint }
