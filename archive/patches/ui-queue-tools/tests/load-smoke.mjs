/**
 * Real-Cordis load smoke test for the ui-queue-tools host half.
 *
 * Loads `lib/index.js` through the ACTUAL Cordis runtime (`new Context()`,
 * `ctx.provide(...)`, `ctx.plugin(...)` / `await`), the same path the DSH
 * host uses. This is the authoritative check for the historical load bug:
 * `apply()` used to `return ctx.inject(...)`; real `ctx.inject()` returns a
 * Fiber wrapper (a PromiseLike resolving to the Fiber instance), Cordis
 * treats an apply return as an Effect, and `safeCollect(fiber)` throws
 * `TypeError('Invalid effect')` (fiber.ts `_execute`), failing the plugin
 * load. The mock-based verify script cannot catch this because a mock
 * `inject` returning the callback result masks the thenable semantics.
 *
 * The transport asserted here is the `webServer` PREFIX ROUTE `/queue` (not a
 * `connection.rpc` channel): dsh 0.1.5-rc.1's Connection registry throws
 * `cannot get property "webServer" without inject` for every plugin outside the
 * connection package, so a channel would never exist. The registered route is
 * driven with a fake `req`/`res` — the same shape `verify-queue-tools.mjs`
 * uses — and disposing the fiber must unregister it.
 *
 * @deepseek-ai/cordis resolution: this file has no local node_modules and ESM
 * `import` ignores NODE_PATH, so the package is located with createRequire
 * (CJS resolution honors NODE_PATH) in this order:
 *   1. standard ancestor node_modules of this patch;
 *   2. `$NODE_PATH` entries;
 *   3. the deployed profile junction tree
 *      `~/.dsh/profiles/node_modules` (on this machine the junctions point
 *      into the DSH checkout's node_modules).
 * The resolved entry is then imported via file URL. If resolution fails, run
 * with NODE_PATH pointing at a node_modules containing @deepseek-ai/cordis,
 * e.g.:
 *   NODE_PATH=%USERPROFILE%\.dsh\profiles\node_modules node patches/ui-queue-tools/tests/load-smoke.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, delimiter } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const patchDir = join(here, '..')
const hostPath = join(patchDir, 'lib', 'index.js')

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
    'node_modules; run with NODE_PATH pointing at a node_modules that contains it ' +
    '(e.g. C:\\Users\\98645\\.dsh\\profiles\\node_modules)',
  )
}

const { Context } = await import(pathToFileURL(resolveCordisEntry()).href)
const host = await import(pathToFileURL(hostPath).href)

/** `webServer` service double: records register() calls and their disposers. */
const routes = []
const webServerStub = {
  register: (route) => {
    const entry = { kind: route.kind, path: route.path, handler: route.handler }
    routes.push(entry)
    return () => {
      const at = routes.indexOf(entry)
      if (at >= 0) routes.splice(at, 1)
    }
  },
}

const ctx = new Context()
ctx.provide('webServer', webServerStub)
ctx.provide('agents', {
  get: () => undefined,
  list: () => [],
})

// DSH's host runner (dsh-cordis-host-runner, `guardedPlugin()`) never hands a
// bare function to ctx.plugin: it wraps every plugin as a plain OBJECT whose
// `apply` METHOD delegates to the original. That shape is what makes Cordis
// call apply as a FUNCTION — a bare `ctx.plugin(lib/index.js)` would make
// Cordis take the `isConstructor` -> `new` branch for the function
// declaration and silently ignore its return. Reproduce the DSH load shape.
const guarded = {
  name: 'ui-queue-tools',
  // The runner must forward the module's STATIC inject declaration: the plugin
  // reads ctx.connection / ctx.agents as injected properties.
  inject: host.inject,
  apply(ctx) {
    return host.apply(ctx)
  },
}

// Same call the DSH host loader makes: ctx.plugin(plugin) -> resolve ->
// apply(ctx). `await` settles once loading finished; with the historical bug
// this rejects with TypeError('Invalid effect').
const fiber = ctx.plugin(guarded)
await fiber

// The inner ctx.inject(['agents'], ...) fiber starts on a microtask after
// apply(); wait (bounded) until the /queue route is up.
const deadline = Date.now() + 2000
while (routes.length === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

assert.equal(routes.length, 1, 'exactly one route must be registered')
assert.equal(routes[0].path, '/queue')
assert.equal(routes[0].kind, 'prefix')

/** Drive the registered route the way the web carrier does. */
async function callRoute({ method = 'POST', url = '/queue/reorder', headers = {}, body = '{}' } = {}) {
  const listeners = { data: [], end: [], error: [] }
  const req = {
    method,
    url,
    headers,
    on(event, listener) { (listeners[event] ??= []).push(listener); return this },
    destroy() { for (const listener of listeners.error) listener(new Error('aborted')) },
  }
  const res = {
    status: null,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, values) {
      this.status = status
      for (const [name, value] of Object.entries(values ?? {})) this.headers[name.toLowerCase()] = value
      return this
    },
    end(chunk) { this.body = String(chunk ?? ''); this.writableEnded = true; return this },
  }
  routes[0].handler(req, res)
  await Promise.resolve()
  for (const listener of listeners.data) listener(body)
  for (const listener of listeners.end) listener()
  // The endpoint handler is async: poll for the response instead of assuming
  // one macrotask is enough.
  const deadline = Date.now() + 5000
  while (!res.writableEnded && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  let envelope = null
  try { envelope = JSON.parse(res.body) } catch { envelope = null }
  return { status: res.status, headers: res.headers, envelope }
}

const JSON_HEADERS = { host: '127.0.0.1:3080', 'content-type': 'application/json' }

// The fence travels with the route: cross-origin / non-POST / non-JSON.
const crossOrigin = await callRoute({ headers: { ...JSON_HEADERS, origin: 'https://evil.example' } })
assert.equal(crossOrigin.status, 403)
const notPost = await callRoute({ method: 'GET', headers: JSON_HEADERS })
assert.equal(notPost.status, 405)
const notJson = await callRoute({ headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain' } })
assert.equal(notJson.status, 415)
const noEndpoint = await callRoute({ url: '/queue', headers: JSON_HEADERS })
assert.equal(noEndpoint.status, 404)

// The registered handler is the real one and still works end-to-end. A request
// must declare the placement its `toIndex` was computed on.
const noPlacement = (await callRoute({
  headers: JSON_HEADERS,
  body: JSON.stringify({ args: { sessionId: 's', itemId: 'm', toIndex: 0 } }),
})).envelope
assert.equal(noPlacement.ok, false)
assert.equal(noPlacement.error.code, 'bad-request')

// With no live agent for the session the failure is a SESSION failure
// (`session-not-found`); `queue-item-not-found` is reserved for a session that
// exists but no longer holds the item.
const result = (await callRoute({
  headers: JSON_HEADERS,
  body: JSON.stringify({ args: { sessionId: 's', itemId: 'm', toIndex: 0, placement: 'queued' } }),
})).envelope
assert.equal(result.ok, false)
assert.equal(result.error.code, 'session-not-found')

await fiber.dispose()
assert.equal(routes.length, 0, 'dispose must unregister the /queue route')

// --- the carrier arrives LATE: activation WAITS for it, never skips it -------
// This is the failure the declared dependency removes. While `webServer` was
// only an optional `ctx.get` read, a plugin activated before the HTTP carrier
// was bound saw `undefined` and returned without ever registering its route —
// silently, with no warning anywhere. Declaring it makes the child fiber wait,
// so the transport comes up the moment the service does.
{
  const lateRoutes = []
  const lateCtx = new Context()
  lateCtx.provide('agents', { get: () => undefined, list: () => [] })
  const lateFiber = lateCtx.plugin(guarded)
  await lateFiber
  // No carrier yet: the inject callback must not have run at all.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(lateRoutes.length, 0, 'with no webServer nothing may be registered')

  lateCtx.provide('webServer', {
    register: (route) => {
      lateRoutes.push(route.path)
      return () => {}
    },
  })
  const lateDeadline = Date.now() + 2000
  while (lateRoutes.length === 0 && Date.now() < lateDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(lateRoutes.length, 1, `the route must register as soon as the declared carrier appears, got ${JSON.stringify(lateRoutes)}`)
  assert.equal(lateRoutes[0], '/queue')
  await lateFiber.dispose()
}

console.log('load-smoke OK: real Cordis ctx.plugin() loaded lib/index.js, prefix route /queue registered + fenced, no TypeError("Invalid effect"), and a LATE webServer still activates the transport (declared dependency, no ctx.get race)')
