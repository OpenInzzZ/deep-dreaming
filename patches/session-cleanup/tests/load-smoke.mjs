/**
 * Real-Cordis load smoke test for the session-cleanup host half.
 *
 * Loads `session-cleanup.mjs` through the ACTUAL Cordis runtime (`new
 * Context()`, `ctx.provide(...)`, `ctx.plugin(...)` / `await`), the same path
 * the DSH host loader uses. This is the authoritative check for the historical
 * load bug: `apply()` used to `return ctx.inject(...)`; real `ctx.inject()`
 * returns a Fiber wrapper (a PromiseLike resolving to the Fiber instance),
 * Cordis treats an apply return as an Effect, and `safeCollect(fiber)` throws
 * `TypeError('Invalid effect')` (vendor/cordis fiber.ts `_execute`), failing
 * the plugin load. The mock-based verify script cannot catch this because a
 * mock `inject` returning the callback result masks the thenable semantics.
 *
 * Also guards:
 *  - the entry config is validated against `plugin.Config` (an intervalMinutes
 *    of 0 must be rejected by the `.min(1)` bound);
 *  - the transport is a fenced PREFIX route on the `webServer` service, which
 *    is a DECLARED dependency of the plugin's `ctx.inject` gate — never a
 *    `connection.rpc` channel, which dsh 0.1.5-rc.1 cannot register for a
 *    plugin outside the connection package (`HostConnectionService.register`
 *    ends in `owner.effect(() => owner.webServer.register(route))` on an
 *    `owner` that never declared `webServer`) — registered through `ctx.effect`
 *    so it is released with the fiber, and really answering a `POST` end to end
 *    (`getConfig` from the entry config). Declaring the carrier is what makes
 *    the registration unconditional: an optional `ctx.get('webServer')` read
 *    inside the callback races the carrier's later binding, sees `undefined`
 *    and silently drops the page's transport;
 *  - `enabled: false` loads without registering anything;
 *  - a boot whose `webServer` service arrives LATE still registers the route
 *    when it appears (the child fiber waits, it never skips).
 *
 * @deepseek-ai/cordis resolution: this file resolves packages from the patch
 * dir's node_modules (`npm install` in patches/session-cleanup installs
 * @deepseek-ai/cordis + @deepseek-ai/schemastery as dev/peer deps), so no
 * NODE_PATH is needed:
 *   node patches/session-cleanup/tests/load-smoke.mjs
 * Fallbacks (in order): ancestor node_modules of this patch, `$NODE_PATH`
 * entries, then the deployed profile tree `~/.dsh/profiles/node_modules`.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, delimiter } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const patchDir = join(here, '..')
const hostPath = join(patchDir, 'session-cleanup.mjs')

function resolveCordisEntry() {
  const req = createRequire(import.meta.url)
  try {
    return req.resolve('@deepseek-ai/cordis')
  } catch {}
  for (const entry of (process.env.NODE_PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      return req.resolve(join(entry, '@deepseek-ai', 'cordis'))
    } catch {}
  }
  const profileEntry = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'cordis')
  try {
    return req.resolve(profileEntry)
  } catch {}
  throw new Error(
    "cannot resolve '@deepseek-ai/cordis' from this patch, $NODE_PATH, or the deployed profile " +
    'node_modules; run `npm install` in the patch dir or point NODE_PATH at a node_modules that ' +
    'contains it (e.g. C:\\Users\\98645\\.dsh\\profiles\\node_modules)',
  )
}

const { Context } = await import(pathToFileURL(resolveCordisEntry()).href)
const host = await import(pathToFileURL(hostPath).href)

/**
 * `webServer` service double.
 *
 * `service` is the plain object handed to `ctx.provide()`; the assertions drive
 * the routes captured from THAT object, never from `ctx.get('webServer')`,
 * which Cordis wraps in a traceable proxy whose `on()`/`register()` calls are
 * intercepted.
 */
const makeWebServer = () => {
  const routes = []
  let disposers = 0
  return {
    routes,
    disposeCount: () => disposers,
    service: {
      register: (route) => {
        const entry = { kind: route.kind, path: route.path, handler: route.handler }
        routes.push(entry)
        return () => {
          disposers += 1
          const at = routes.indexOf(entry)
          if (at >= 0) routes.splice(at, 1)
        }
      },
    },
  }
}

/**
 * Drive one registered prefix route with a fake req/res.
 *
 * The route registers its request listeners synchronously and answers from a
 * promise continuation, so the body is delivered only after `handler()`
 * returned and the helper resolves when `res.end()` really happened.
 */
const postRoute = async (route, pathname, payload, headers = {}) => {
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const res = {
    status: null,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, extra) {
      this.status = status
      for (const [name, value] of Object.entries(extra ?? {})) this.headers[name.toLowerCase()] = value
      return this
    },
    end(chunk) {
      this.body = String(chunk ?? '')
      this.writableEnded = true
      settle(this)
      return this
    },
  }
  const listeners = new Map()
  const req = {
    method: 'POST',
    url: pathname,
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', ...headers },
    destroy() { settle(res) },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return req
    },
  }
  await route.handler(req, res)
  for (const listener of [...(listeners.get('data') ?? [])]) listener(Buffer.from(JSON.stringify(payload ?? {}), 'utf8'))
  for (const listener of [...(listeners.get('end') ?? [])]) listener()
  return Promise.race([
    done,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`route ${pathname} never answered`)), 2000).unref?.()
    }),
  ])
}

// --- enabled: true — provide the services, then load for real -------------------
const sessionsRoot = mkdtempSync(join(tmpdir(), 'cleanup-smoke-'))
const ctx = new Context()

const connectionCalls = []
ctx.provide('connection', {
  rpc: {
    // Kept only to prove the migrated host half no longer touches this API.
    handle: (channel, options) => {
      connectionCalls.push({ channel, options })
      return () => {}
    },
  },
})
ctx.provide('sessions', { list: () => [] })

const webServer = makeWebServer()
ctx.provide('webServer', webServer.service)

// Same call the DSH host loader makes: ctx.plugin(module) -> resolve ->
// apply(ctx). `await` settles once loading finished; with the historical bug
// this rejects with TypeError('Invalid effect').
const fiber = ctx.plugin(host, {
  enabled: true,
  dryRun: true,
  sessionsRoot,
  maxAgeDays: 30,
  maxTotalMB: 0,
  keepSessions: 5,
  intervalMinutes: 360,
})
await fiber

assert.equal(connectionCalls.length, 0, 'the host half must not call ctx.connection.rpc.handle any more')
assert.equal(webServer.routes.length, 1, `webServer.register must be called exactly once, got ${webServer.routes.length}`)
assert.equal(webServer.routes[0].path, '/session-cleanup')
assert.equal(webServer.routes[0].kind, 'prefix', 'a prefix route is what the page POSTs /<channel>/<endpoint> to')

// The registered handler is the real one and still works end-to-end.
const gotRes = await postRoute(webServer.routes[0], '/session-cleanup/getConfig', { args: {} })
assert.equal(gotRes.status, 200, `route must answer 200, got ${gotRes.status} (${gotRes.body})`)
assert.equal(gotRes.headers['content-type'], 'application/json')
const got = JSON.parse(gotRes.body)
assert.equal(got.ok, true)
assert.equal(got.value.dryRun, true)
assert.equal(got.value.intervalMinutes, 360)

// An unknown endpoint keeps the unchanged failure envelope, still HTTP 200.
// (Without a settings service the handler reports `settings-unavailable` first,
// in the same order the old RPC handler did; the `bad-request` spelling is
// asserted in verify-session-cleanup.mjs, which owns a settings double.)
const unknownRes = await postRoute(webServer.routes[0], '/session-cleanup/nope', {})
const unknown = JSON.parse(unknownRes.body)
assert.equal(unknownRes.status, 200)
assert.equal(unknown.ok, false)
assert.equal(unknown.error.code, 'settings-unavailable')

// The entry config is validated against plugin.Config: intervalMinutes 0 must
// be rejected (the .min(1) bound) instead of spinning a 1ms interval.
await assert.rejects(
  async () => { await ctx.plugin(host, { enabled: true, intervalMinutes: 0, sessionsRoot }) },
  /intervalMinutes/i,
  'intervalMinutes 0 must be rejected by the Config schema',
)

await fiber.dispose()
assert.equal(webServer.routes.length, 0, 'dispose must run the route disposer')
assert.equal(webServer.disposeCount(), 1, 'the route disposer must run exactly once')
rmSync(sessionsRoot, { recursive: true, force: true })

// --- enabled: false — apply returns early without registering --------------------
const ctx2 = new Context()
const web2 = makeWebServer()
ctx2.provide('webServer', web2.service)
ctx2.provide('sessions', { list: () => [] })
const fiber2 = ctx2.plugin(host, { enabled: false })
await fiber2 // must settle without TypeError('Invalid effect') and without registering
assert.equal(web2.routes.length, 0, 'enabled:false must not register any route')
await fiber2.dispose()

// --- no `webServer` service yet: the transport WAITS for it ----------------------
// The regression this fix removes: with the carrier read as an optional
// `ctx.get('webServer')`, a plugin activated before the carrier was bound saw
// `undefined` and silently registered nothing. With `webServer` declared, the
// child fiber instead waits, and the route appears the moment the service does.
const ctx3 = new Context()
ctx3.provide('sessions', { list: () => [] })
const web3 = makeWebServer()
const fiber3 = ctx3.plugin(host, { enabled: true, dryRun: true, sessionsRoot: tmpdir(), intervalMinutes: 360, maxAgeDays: 0, maxTotalMB: 0, keepSessions: 0 })
await fiber3 // must settle without TypeError('Invalid effect')
// No carrier yet, so the inject callback has not run at all: nothing registered.
await new Promise((resolve) => setTimeout(resolve, 100))
assert.equal(web3.routes.length, 0, 'with no webServer the gate must not have run: nothing may be registered')

ctx3.provide('webServer', web3.service)
const lateDeadline = Date.now() + 2000
while (web3.routes.length === 0 && Date.now() < lateDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}
assert.equal(web3.routes.length, 1, `a LATE webServer must still activate the transport, got ${web3.routes.length} route(s)`)
assert.equal(web3.routes[0].path, '/session-cleanup')
assert.equal(web3.routes[0].kind, 'prefix')
await fiber3.dispose()
assert.equal(web3.routes.length, 0, 'dispose must unregister the late-registered route')

console.log('load-smoke OK: real Cordis ctx.plugin() loaded session-cleanup.mjs; /session-cleanup registered as a prefix route on the DECLARED webServer dependency, answered a real POST, disposed with the fiber, Config validates, enabled:false registers nothing, and a LATE webServer still activates the transport')
