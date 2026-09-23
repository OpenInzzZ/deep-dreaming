/**
 * Real-Cordis load smoke test for the ui-settings-other host half.
 *
 * Loads lib/index.js into a real @deepseek-ai/cordis Context with stubbed
 * agents/webServer services and asserts:
 *   - the plugin fiber activates without TypeError('Invalid effect') — the P0
 *     regression guard (apply must not return the ctx.inject() thenable);
 *   - the `Config` export is really the schema the loader validates the entry
 *     config with: defaults are filled in, an out-of-range value is rejected;
 *   - the transport is one `{ kind: 'prefix', path: '/app' }` route on the
 *     `webServer` service — NOT a `ctx.connection.rpc` channel. In dsh
 *     0.1.5-rc.1 that registry throws `cannot get property "webServer" without
 *     inject` for every plugin outside the connection package, and because the
 *     throw happens inside the inject callback it also rolls back every effect
 *     that callback had already registered;
 *   - the /app route registers even when `ctx.get('connection')` is undefined,
 *     i.e. the host half never READS the connection service any more;
 *   - the registered route really answers (`POST /app/status` → 200 + ok:true)
 *     and keeps its fence (GET → 405);
 *   - with idleEnabled: false no idle monitor is created (no real intervals —
 *     a live one would also keep this process from exiting).
 *
 * Fidelity note: the plugin still NAMES `connection` in its inner
 * `ctx.inject(['connection', 'agents'], …)` gate, so the service has to be
 * PROVIDED (any value, including `undefined`) for that callback to run at all.
 * This test proves its value is never read; removing the name from that list is
 * a lib/index.js change, not a test change.
 *
 * Run from the repo root:
 *   node patches/ui-settings-other/tests/load-smoke.mjs
 * (needs @deepseek-ai/cordis resolvable from this patch — the deployed
 * node_modules junction provides it; otherwise NODE_PATH=...\.dsh\profiles\node_modules)
 */
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const APP_PATH = '/app'
const HEALTH_PATH = '/ui-settings-other/health'
const FAVICON_PATH = '/favicon.svg'

// --- Config: the export the Cordis loader resolves the entry config with ------
if (typeof mod.Config !== 'function') {
  throw new Error('Config export missing: the loader validates the entry config through it')
}
const defaults = mod.Config({})
if (defaults.idleEnabled !== true || defaults.idleMinutes !== 120 || defaults.script !== '') {
  throw new Error(`Config defaults: ${JSON.stringify(defaults)}`)
}
const normalized = mod.Config({ idleEnabled: false })
if (normalized.idleEnabled !== false || normalized.idleMinutes !== 120) {
  throw new Error(`Config must fill the missing keys with their defaults: ${JSON.stringify(normalized)}`)
}
let rejected = null
try { mod.Config({ idleMinutes: 0 }) } catch (error) { rejected = error }
if (rejected === null) throw new Error('Config must reject idleMinutes below its floor of 1')
console.log(`Config OK: defaults ${JSON.stringify(defaults)}; idleMinutes 0 rejected`)

/** `webServer` service double: records every register() as { kind, path, handler }. */
const makeWebServerStub = () => {
  const routes = []
  return {
    routes,
    register: (route) => {
      routes.push({ kind: route.kind, path: route.path, handler: route.handler })
      return () => {} // the real service returns a disposer
    },
  }
}

/** The /app prefix route this load registered (kind + path + handler asserted). */
const appRouteOf = (stub) => {
  const route = stub.routes.find((r) => r.path === APP_PATH)
  if (route === undefined) {
    throw new Error(`${APP_PATH} route never registered (routes: ${JSON.stringify(stub.routes.map((r) => `${r.kind} ${r.path}`))})`)
  }
  if (route.kind !== 'prefix') throw new Error(`${APP_PATH} must be kind 'prefix', got '${route.kind}'`)
  if (typeof route.handler !== 'function') throw new Error(`${APP_PATH} route must expose a handler`)
  return route
}

/**
 * One request through a registered route, with the surface the real handler
 * uses (method / headers / url / on / destroy) and a res double recording
 * writeHead/end. The /app handler answers from inside `req.on('end')`, so the
 * response is awaited (with a guard so a silent handler fails instead of
 * hanging).
 */
const request = async (route, { method = 'POST', url = route.path, headers = {}, body = '' } = {}) => {
  const listeners = new Map()
  let settle
  const done = new Promise((resolve) => { settle = resolve })
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
    end(chunk) {
      this.body = String(chunk ?? '')
      this.writableEnded = true
      settle(this)
      return this
    },
  }
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:3080', ...headers },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return req
    },
    destroy() {},
  }
  await route.handler(req, res)
  if (body.length > 0) for (const listener of listeners.get('data') ?? []) listener(body)
  for (const listener of listeners.get('end') ?? []) listener()
  const guard = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`route ${route.path} never answered (${method} ${url})`)), 2000).unref?.()
  })
  return Promise.race([done, guard])
}

// --- load into a real Context ------------------------------------------------
const webServer = makeWebServerStub()
const ctx = new Context()
// The connection service is PROVIDED (the inject gate waits for the name) but
// its value is `undefined`: the transport must not need it any more.
ctx.provide('connection', undefined)
ctx.provide('agents', { list: () => [], get: () => undefined })
ctx.provide('webServer', webServer)

// idleEnabled: false keeps the idle monitor from creating a real interval.
const realSetInterval = globalThis.setInterval
let createdIntervals = 0
globalThis.setInterval = (fn, ms) => {
  createdIntervals += 1
  return realSetInterval(fn, ms)
}
try {
  // Config validation happens here: `resolveConfig` runs the module's `Config`
  // schema over the entry config before the plugin starts.
  const fiber = ctx.plugin(mod, { idleEnabled: false })
  await fiber // throws TypeError('Invalid effect') on the P0 regression

  if (ctx.get('connection') !== undefined) {
    throw new Error(`premise failed: ctx.get('connection') must be undefined here, got ${String(ctx.get('connection'))}`)
  }
  if (fiber.config.idleEnabled !== false || fiber.config.idleMinutes !== 120) {
    throw new Error(`the loader must resolve the entry config through Config: ${JSON.stringify(fiber.config)}`)
  }

  const app = appRouteOf(webServer)
  const surface = webServer.routes.map((r) => `${r.kind} ${r.path}`)
  const expected = [`exact ${HEALTH_PATH}`, `exact ${FAVICON_PATH}`, `prefix ${APP_PATH}`]
  if (JSON.stringify(surface) !== JSON.stringify(expected)) {
    throw new Error(`route surface must be exactly ${JSON.stringify(expected)}, got ${JSON.stringify(surface)}`)
  }

  // The route is live, not merely recorded: one endpoint answers, and the fence
  // (POST + JSON only) still holds on the real handler.
  const status = await request(app, {
    method: 'POST',
    url: `${APP_PATH}/status`,
    headers: { 'content-type': 'application/json' },
    body: '{"args":{}}',
  })
  if (status.status !== 200 || status.headers['content-type'] !== 'application/json') {
    throw new Error(`POST ${APP_PATH}/status must answer 200 + JSON, got ${status.status} ${status.body}`)
  }
  const envelope = JSON.parse(status.body)
  if (envelope.ok !== true || typeof envelope.value?.running !== 'number') {
    throw new Error(`status envelope: ${status.body}`)
  }
  const refused = await request(app, { method: 'GET', url: `${APP_PATH}/status` })
  if (refused.status !== 405) throw new Error(`GET ${APP_PATH}/status must be refused, got ${refused.status}`)

  if (createdIntervals !== 0) throw new Error(`idleEnabled:false must arm no monitor, created ${createdIntervals}`)

  await ctx.fiber.dispose()
} finally {
  globalThis.setInterval = realSetInterval
}

console.log('load-smoke OK: prefix /app route registered with ctx.get("connection") === undefined, Config validated, no Invalid effect, no idle monitor with idleEnabled=false')
