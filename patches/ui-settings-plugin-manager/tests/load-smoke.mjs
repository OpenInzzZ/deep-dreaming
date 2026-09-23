/**
 * Real-Cordis load smoke test for the plugin-manager host half.
 *
 * Loads `lib/index.js` through the ACTUAL Cordis runtime (`new Context()`,
 * `ctx.provide(...)`, `ctx.plugin(...)` / `await`), the same path the DSH
 * host uses. This is the authoritative check for two historical load bugs:
 *
 *  - `apply()` used to `return ctx.inject(...)`; real `ctx.inject()` returns a
 *    Fiber wrapper (a PromiseLike resolving to the Fiber instance), Cordis
 *    treats an apply return as an Effect, and `safeCollect(fiber)` throws
 *    `TypeError('Invalid effect')` (fiber.ts `_execute`), failing the plugin
 *    load. The mock-based verify script cannot catch this because a mock
 *    `inject` returning the callback result masks the thenable semantics.
 *  - the transport used to be `ctx.connection.rpc.handle('/plugin-toggle', …)`,
 *    which cannot work here: `HostConnectionService.register` ends in
 *    `owner.effect(() => owner.webServer.register(route))` and `owner` never
 *    declared `webServer`, so every plugin outside the connection package
 *    throws `cannot get property "webServer" without inject`. The host half
 *    now registers its own fenced prefix route on the `webServer` service.
 *
 * Asserts: the plugin fiber activates, the transport is registered from inside
 * the plugin's `ctx.inject(['webServer'], …)` gate — the carrier is a DECLARED
 * dependency, so activation WAITS for it instead of racing it with an optional
 * `ctx.get('webServer')` read that would see `undefined` and silently skip the
 * page's transport — exactly one `kind: 'prefix'` route for `/plugin-toggle` is
 * registered, that route really answers a `POST` end to end through the
 * endpoint handler, the route is disposed with the fiber, and a boot whose
 * `webServer` service appears LATE still activates the transport instead of
 * leaving the page with a dead endpoint.
 *
 * Safety: the toggle writes to a TEMP patch file via `config.patchFile`,
 * never the real `~/.dsh/profiles/web/cordis.patch.yml`.
 *
 * @deepseek-ai/cordis resolution: this file has no local node_modules and ESM
 * `import` ignores NODE_PATH, so the package is located with createRequire
 * (CJS resolution honors NODE_PATH) in this order:
 *   1. standard ancestor node_modules of this patch;
 *   2. `$NODE_PATH` entries;
 *   3. the deployed profile junction tree `~/.dsh/profiles/node_modules`.
 * If resolution fails, run with NODE_PATH pointing at a node_modules that
 * contains @deepseek-ai/cordis, e.g.:
 *   NODE_PATH=%USERPROFILE%\.dsh\profiles\node_modules node patches/ui-settings-plugin-manager/tests/load-smoke.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'

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

/**
 * `webServer` service double: records every register() as { kind, path, handler }.
 *
 * `service` is the plain object handed to `ctx.provide()`; the assertions drive
 * the routes captured from THAT object, never from `ctx.get('webServer')`,
 * which Cordis wraps in a traceable proxy that would swallow the request
 * listeners the route registers.
 */
const makeRegisteringWebServer = () => {
  const routes = []
  let disposers = 0
  return {
    routes,
    disposed: () => disposers,
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
 * Drive one registered prefix route with a fake req/res (POST + JSON body).
 *
 * Two fidelity details matter here:
 *  - `ctx.provide()` hands out a TRACEABLE PROXY of the service, so the routes
 *    are captured into — and driven from — the plain object that was provided;
 *    going through the proxy would wrap the request's `on()` calls and swallow
 *    every listener.
 *  - the route answers from a promise continuation, so the request body is
 *    delivered only after the handler returned (the order a real HTTP request
 *    follows) and this helper waits for `res.end()` instead of assuming the
 *    response is already written.
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
    destroy: () => { settle(res) },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return req
    },
  }
  await route.handler(req, res)
  // The handler is listening now: deliver the body exactly like node would.
  for (const listener of [...(listeners.get('data') ?? [])]) {
    listener(Buffer.from(JSON.stringify(payload ?? {}), 'utf8'))
  }
  for (const listener of [...(listeners.get('end') ?? [])]) {
    listener()
  }
  return Promise.race([
    done,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`route ${pathname} never answered`)), 2000).unref?.()
    }),
  ])
}

// --- provide the services, then load the plugin for real ----------------------
const ctx = new Context()

const connectionCalls = []
ctx.provide('connection', {
  rpc: {
    // Kept only to prove the migrated host half no longer touches this API.
    handle: (channel, handler, options) => {
      connectionCalls.push({ channel, options })
      return () => {}
    },
  },
})

const webServer = makeRegisteringWebServer()
ctx.provide('webServer', webServer.service)

// DSH's host runner never hands a bare function to ctx.plugin: it wraps every
// plugin as a plain OBJECT whose `apply` METHOD delegates to the original.
// Reproduce the DSH load shape (a bare function would take Cordis'
// isConstructor -> `new` branch and silently ignore the return).
const guarded = {
  name: host.name,
  apply(ctx, config) {
    return host.apply(ctx, config)
  },
}

const smokeDir = mkdtempSync(join(tmpdir(), 'plugin-manager-smoke-'))
const patchFile = join(smokeDir, 'cordis.patch.yml')
writeFileSync(patchFile, '# smoke layer\n- insert:\n    - id: a\n      name: pkg-a\n')

const fiber = ctx.plugin(guarded, { patchFile })
await fiber // rejects with TypeError('Invalid effect') on the historical bug

assert.equal(connectionCalls.length, 0, 'the host half must not call ctx.connection.rpc.handle any more')
assert.equal(webServer.routes.length, 1, `webServer.register must be called exactly once, got ${webServer.routes.length}`)
assert.equal(webServer.routes[0].path, '/plugin-toggle')
assert.equal(webServer.routes[0].kind, 'prefix', 'a prefix route is what the page POSTs /<channel>/<endpoint> to')
assert.equal(typeof webServer.routes[0].handler, 'function')

// The registered handler is the real one and still works end-to-end: the
// transport accepts the request and the endpoint handler edits the file.
const offRes = await postRoute(webServer.routes[0], '/plugin-toggle/setEnabled', { args: { entryId: 'a', enabled: false } })
assert.equal(offRes.status, 200, `route must answer 200, got ${offRes.status} (${offRes.body})`)
assert.equal(offRes.headers['content-type'], 'application/json')
const off = JSON.parse(offRes.body)
assert.equal(off.ok, true)
assert.equal(off.value.enabled, false)
assert.equal(off.value.changed, true)
assert.ok(readFileSync(patchFile, 'utf8').includes('- id: a\n  disabled: true'), 'disable must write the disabled block')

const onRes = await postRoute(webServer.routes[0], '/plugin-toggle/setEnabled', { args: { entryId: 'a', enabled: true } })
assert.equal(onRes.status, 200)
const on = JSON.parse(onRes.body)
assert.equal(on.ok, true)
assert.equal(on.value.changed, true)
assert.ok(!readFileSync(patchFile, 'utf8').includes('disabled: true'), 'enable must remove the disabled block')

// Unknown endpoints still answer the unchanged failure envelope.
const unknownRes = await postRoute(webServer.routes[0], '/plugin-toggle/nope', {})
const unknown = JSON.parse(unknownRes.body)
assert.equal(unknownRes.status, 200)
assert.equal(unknown.ok, false)
assert.equal(unknown.error.code, 'bad-request')

await fiber.dispose()
assert.equal(webServer.routes.length, 0, 'dispose must run the route disposer')
assert.equal(webServer.disposed(), 1, 'the route disposer must run exactly once')

// --- the carrier arrives LATE: the transport WAITS for it, never skips it ----
// The regression this fix removes: while `webServer` was only an optional
// `ctx.get` read, a plugin activated before the HTTP carrier was bound saw
// `undefined`, returned early, and never registered `/plugin-toggle` — with no
// warning anywhere. Declaring it makes the inject gate wait, so the route comes
// up the moment the service does.
const lateWebServer = makeRegisteringWebServer()
const ctx2 = new Context()
const fiber2 = ctx2.plugin({
  name: host.name,
  apply(ctx, config) {
    return host.apply(ctx, config)
  },
}, { patchFile })
await fiber2 // must settle: the gate is waiting, it never throws
// No carrier yet, so the inject callback has not run at all.
await new Promise((resolve) => setTimeout(resolve, 100))
assert.equal(lateWebServer.routes.length, 0, 'with no webServer the gate must not have run: nothing may be registered')

ctx2.provide('webServer', lateWebServer.service)
const lateDeadline = Date.now() + 2000
while (lateWebServer.routes.length === 0 && Date.now() < lateDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}
assert.equal(lateWebServer.routes.length, 1, `a LATE webServer must still activate the transport, got ${lateWebServer.routes.length} route(s)`)
assert.equal(lateWebServer.routes[0].path, '/plugin-toggle')
assert.equal(lateWebServer.routes[0].kind, 'prefix')
// And it is the real handler: the late-registered route edits the patch file.
const lateRes = await postRoute(lateWebServer.routes[0], '/plugin-toggle/setEnabled', { args: { entryId: 'a', enabled: false } })
assert.equal(lateRes.status, 200, `the late route must answer, got ${lateRes.status} (${lateRes.body})`)
assert.equal(JSON.parse(lateRes.body).ok, true)
await fiber2.dispose()
assert.equal(lateWebServer.routes.length, 0, 'dispose must run the late route disposer')

rmSync(smokeDir, { recursive: true, force: true })
console.log('load-smoke OK: real Cordis ctx.plugin() loaded lib/index.js; /plugin-toggle registered as a prefix route from inside the DECLARED webServer inject gate, answered a real POST, disposed with the fiber, and a LATE webServer still activates the transport')
