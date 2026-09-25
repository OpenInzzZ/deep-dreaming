/**
 * Real-Cordis load smoke test for the ui-settings-other host half.
 *
 * Loads lib/index.js into a real @deepseek-ai/cordis Context with stubbed
 * agents/webServer services and asserts:
 *   - the plugin fiber activates without TypeError('Invalid effect') — the P0
 *     regression guard (apply must not return the ctx.inject() thenable);
 *   - the `Config` export is really the schema the loader validates the entry
 *     config with: defaults are filled in, a wrong type is rejected;
 *   - the transport is one `{ kind: 'prefix', path: '/app' }` route on the
 *     `webServer` service — NOT a `ctx.connection.rpc` channel. In dsh
 *     0.1.5-rc.1 that registry throws `cannot get property "webServer" without
 *     inject` for every plugin outside the connection package, and because the
 *     throw happens inside the inject callback it also rolls back every effect
 *     that callback had already registered;
 *   - no `connection` service is needed at all: the host half never reads it,
 *     so the context here provides only `agents` and `webServer`;
 *   - the registered route really answers (`POST /app/status` → 200 + ok:true)
 *     and keeps its fence (GET → 405);
 *   - the `status` envelope carries no `idle` key — the idle auto-stop is gone
 *     from the host half, settings namespace included;
 *   - the host half arms no interval at all (the idle monitor was its only one).
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
if (defaults.script !== '') {
  throw new Error(`Config defaults: ${JSON.stringify(defaults)}`)
}
const normalized = mod.Config({ script: 'C:\\x\\restart-dsh.ps1' })
if (normalized.script !== 'C:\\x\\restart-dsh.ps1') {
  throw new Error(`Config must keep the configured script: ${JSON.stringify(normalized)}`)
}
let rejected = null
try { mod.Config({ script: 42 }) } catch (error) { rejected = error }
if (rejected === null) throw new Error('Config must reject a non-string script')
console.log(`Config OK: defaults ${JSON.stringify(defaults)}; a non-string script is rejected`)

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
// Only the two declared dependencies: the transport is a route on `webServer`,
// and `agents` answers the session queries. No `connection` service exists here
// (or in the plugin) any more.
ctx.provide('agents', { list: () => [], get: () => undefined })
ctx.provide('webServer', webServer)

// The host half arms no timer: this counts them to prove the idle monitor (the
// only interval it ever owned) is really gone.
const realSetInterval = globalThis.setInterval
let createdIntervals = 0
globalThis.setInterval = (fn, ms) => {
  createdIntervals += 1
  return realSetInterval(fn, ms)
}
try {
  // Config validation happens here: `resolveConfig` runs the module's `Config`
  // schema over the entry config before the plugin starts.
  const fiber = ctx.plugin(mod, { script: '' })
  await fiber // throws TypeError('Invalid effect') on the P0 regression

  if (fiber.config.script !== '') {
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
  if (envelope.value.idle !== undefined) throw new Error(`status must not carry idle any more: ${status.body}`)
  if (typeof envelope.value.service?.pid !== 'number') {
    throw new Error(`status must still carry the process snapshot (the progress driver reads service.pid): ${status.body}`)
  }
  const refused = await request(app, { method: 'GET', url: `${APP_PATH}/status` })
  if (refused.status !== 405) throw new Error(`GET ${APP_PATH}/status must be refused, got ${refused.status}`)

  if (createdIntervals !== 0) throw new Error(`the host half must arm no interval, created ${createdIntervals}`)

  await ctx.fiber.dispose()
} finally {
  globalThis.setInterval = realSetInterval
}

console.log('load-smoke OK: prefix /app route registered without a connection service, Config validated, no Invalid effect, status(idle gone) + no interval')