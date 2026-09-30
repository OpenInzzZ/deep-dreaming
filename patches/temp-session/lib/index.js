/**
 * temp-session — host half: a user-level "temporary session" workspace.
 *
 * dsh's conversation UI only lets you start a session inside a real Workspace
 * (without one the hero input is inert). For ad-hoc, non-project chats this
 * forces picking/creating a project directory. This plugin provides a
 * dedicated user-level workspace (default `~/.dsh/tmp-workspaces/`) that any
 * session can bind to, so a temporary chat still has a real cwd (file
 * operations land in the user-level dir, never a project) while appearing in
 * the sidebar under its own "临时会话 / Temporary" group.
 *
 * Exposes the `webServer` prefix route `/temp-session` with one endpoint:
 *   ensure { args: {} } -> { ok, value: { workspaceId, path, title, created } }
 * Idempotent: repeated calls return the same workspace. The client half
 * (`lib/client.js`) renders the sidebar-footer action that calls it.
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'

/**
 * Default user-level directory hosting the temporary workspace. Evaluated at
 * module load (schemastery 3.x `.default()` stores the value as-is and cannot
 * take a function), so the user cannot switch OS user mid-process anyway.
 */
const DEFAULT_TEMP_DIR = path.join(os.homedir(), '.dsh', 'tmp-workspaces')

/**
 * Entry config schema. The Cordis loader validates the raw config against it
 * through the schemastery `~standard` protocol (a plain object here makes the
 * loader crash with "Cannot read properties of undefined (reading 'validate')")
 * and fills the defaults, so `apply` receives a complete, validated config.
 */
export const Config = z.object({
  /**
   * User-level directory hosting the temporary workspace. Defaults to
   * `~/.dsh/tmp-workspaces/`; must be absolute. Created on first use.
   */
  dir: z.string().default(DEFAULT_TEMP_DIR),
  /** Display title of the temporary workspace group. */
  title: z.string().default('临时会话'),
})

/**
 * Create one serial queue per plugin instance: `enqueue(task)` chains `task`
 * behind everything already queued on THIS queue and resolves with the task's
 * value, so concurrent ensure calls (double click, startup + RPC) run one at a
 * time and cannot create two workspaces.
 *
 * The chain must live in the `apply` closure, never at module scope: a
 * module-level chain is shared across hot reloads, so a new instance would
 * queue behind the previous instance's still-pending ensure and could not be
 * cancelled when that instance unloads.
 */
export function createEnsureQueue() {
  let tail = Promise.resolve()
  return function enqueue(task) {
    const operation = tail.then(task)
    // Only `operation` may reject; the chain itself always settles resolved so
    // one failed ensure does not poison the following ones.
    tail = operation.then(() => undefined, () => undefined)
    return operation
  }
}

/**
 * Resolve the configured temp workspace (create-on-demand, idempotent).
 * @param ctx - injected context with `workspaceRegistry`.
 * @param config - plugin config ({ dir, title }).
 * @param enqueue - optional serial queue from `createEnsureQueue()`; `apply`
 *   always passes its own instance queue, a bare call runs inline.
 * @returns { workspaceId, path, title, created }
 */
export async function ensureTempWorkspace(ctx, config, enqueue) {
  // Capture the service synchronously: an injected child fiber can unload
  // across awaits during startup (dependency epoch change), after which a
  // proxy access throws "cannot get required service in inactive context".
  const registry = ctx.workspaceRegistry
  const dir = config.dir
  const title = config.title
  const ensure = async () => {
    await fs.mkdir(dir, { recursive: true })
    const existing = await registry.resolveByPath(dir)
    if (existing !== undefined) {
      return { workspaceId: existing.id, path: existing.path, title: existing.title, created: false }
    }
    const created = await registry.create(dir, title)
    return { workspaceId: created.id, path: created.path, title: created.title, created: true }
  }
  return typeof enqueue === 'function' ? enqueue(ensure) : ensure()
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
 * @param path - prefix route path, e.g. `/temp-session`.
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
 * Handle one endpoint on the `/temp-session` channel.
 *
 * The route calls this as a plain function and passes the live service as
 * `deps`; the `inner.workspaceRegistry` form remains the shape this file is
 * built around, so the registry is an explicit argument rather than a captured
 * context (which would go inactive across the awaits below).
 *
 * @param endpoint - endpoint name from `/temp-session/<endpoint>`.
 * @param payload - parsed JSON body; `args` may be omitted or a plain object.
 * @param deps - `{ workspaceRegistry, config, enqueue }`.
 */
async function handleEndpoint(endpoint, payload, deps) {
  if (endpoint !== 'ensure') {
    return { ok: false, error: { code: 'bad-request', message: `unknown endpoint: ${endpoint}`, details: {} } }
  }
  // `args` may be omitted or a plain object; null and arrays are rejected
  // (`typeof null === 'object'` would otherwise let null through).
  const args = payload?.args
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
    return {
      ok: false,
      error: { code: 'bad-request', message: 'ensure accepts no args (omit args or pass a plain object)', details: {} },
    }
  }
  try {
    // The registry is read inside the guard so a context that went inactive
    // across the awaits still reports `temp-workspace-failed` instead of
    // surfacing as a transport-level 500.
    const value = await ensureTempWorkspace(
      { workspaceRegistry: deps.workspaceRegistry },
      deps.config,
      deps.enqueue,
    )
    return { ok: true, value }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'temp-workspace-failed',
        message: `cannot ensure temp workspace: ${error instanceof Error ? error.message : String(error)}`,
        details: {},
      },
    }
  }
}

/**
 * Cordis plugin: publish the fenced `/temp-session` prefix route on
 * `webServer`. `workspaceRegistry` and `webServer` are **static** `inject`
 * dependencies, not a dynamic `ctx.inject(...)` inside `apply`: a user-layer
 * hot reload does not re-activate the dynamic child fiber (the channel stayed
 * 404 until a full restart), while the static form is unaffected — and it is
 * what makes the HTTP carrier actually present here, since Cordis mounts rows
 * in parallel and `webServer` binds later than `workspaceRegistry`. Reading it
 * with `ctx.get('webServer')` during activation races that binding, sees
 * `undefined`, and silently drops the page's whole transport; that race is how
 * four of five migrated patches came up dead after the first restart.
 */
export const inject = ['workspaceRegistry', 'webServer']

export function apply(ctx, config = {}) {
  // Per-instance serial chain: a reloaded instance must not inherit (or wait
  // on) the previous instance's pending ensure.
  const enqueue = createEnsureQueue()
  const workspaceRegistry = ctx.workspaceRegistry
  // Eagerly register the temp workspace on startup so it appears as a
  // workspace group in the sidebar browser — users can click its "+" or
  // "新会话" row just like any project. Idempotent; repeated calls after
  // the first are no-ops and return the same workspace.
  ensureTempWorkspace({ workspaceRegistry }, config, enqueue).catch(err => {
    console.warn('[temp-session] startup workspace ensure failed:', err)
  })

  // The page reaches this half over one prefix route on the web carrier.
  // `ctx.connection.rpc.handle` is not an option in dsh 0.1.5: its registry
  // reads `owner.webServer` on the *reading* plugin's context, which never
  // declared it, and throws `cannot get property "webServer" without inject` —
  // so no channel would exist and the button would land on the SPA fallback.
  // See createRpcRoute() for the fence that replaces the Connection's own.
  //
  // The route effect hangs on the plugin's own fiber, so unloading or hot
  // reloading unregisters `/temp-session` instead of leaving a stale handler.
  const handle = (endpoint, payload) => handleEndpoint(endpoint, payload, { workspaceRegistry, config, enqueue })
  ctx.effect(() => ctx.webServer.register(createRpcRoute('/temp-session', handle)), 'temp-session: /temp-session rpc route')
}
