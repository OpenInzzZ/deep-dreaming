/**
 * Functional harness for the user-level ui-settings-other patch.
 *
 * Transport note: this patch no longer registers a `ctx.connection.rpc`
 * channel. In dsh 0.1.5-rc.1 that registry throws `cannot get property
 * "webServer" without inject` for every plugin outside the connection package,
 * and because the throw happens inside the `ctx.inject` callback it also rolls
 * back everything that callback had already registered. The host half now
 * registers one `{ kind: 'prefix', path: '/app' }` route on the `webServer`
 * service (see `createRpcRoute` in lib/index.js) and the browser half calls it
 * with `fetch('/app/<endpoint>', { method: 'POST', … })`. This harness drives
 * the real route handler with a fake req/res, and stubs `fetch` on the client
 * side — nothing here calls `ctx.connection`.
 *
 * Host half: imports the real `lib/index.js`, applies it to a mock Cordis
 * context, and asserts the `/app` prefix route registration plus endpoint
 * validation (never invokes `restart` with a real script — that respawns the
 * process). Covers the runtime-status snapshot (serviceInfo / listeningPorts /
 * dshVersion), the idle auto-stop decision + monitor mechanics, the
 * settings-namespace wiring (entry base → registered namespace → watch
 * rebuild), and the restart endpoint's session protection (busy refusal /
 * forced cancel). Also guards the P0 regression: `apply` must NOT return a
 * thenable (Cordis treats a returned Fiber as an invalid Effect).
 *
 * The route's own fence is asserted through the real handler: a cross-origin
 * `Origin` is refused (403) without reaching the endpoint, non-POST is 405,
 * a non-JSON content-type is 415, a non-JSON body is 400, an oversized body is
 * 413, and a malformed endpoint path (`/app`, `/app/`, `/app/a/b`) is 404.
 *
 * Diagnostics: drives the real `/ui-settings-other/health` route through a
 * fake req/res (exact kind+path, application/json + no-store, channel /
 * settings / branding flags, warnings text) and pins the fail-soft contract —
 * a throwing settings register or an unreadable favicon asset degrades its own
 * flag and warning while the `/app` route, its status endpoint and the
 * entry-config fallback stay up. A missing `webServer` warns and registers
 * nothing instead of throwing.
 *
 * Client half: loads the exact deployed `lib/client.js` the browser will
 * execute, feeds it a module table stubbed with the real platform words
 * (react, react/jsx-runtime, ui-primitives), asserts the registration
 * contracts (settings.section + settings.plugin.item + dictionaries, plus the
 * section's exact inject surface), then — when jsdom is available — renders
 * the section and exercises the status block, the create-shortcut flow, the
 * confirm-modal -> restart flow (cancel / confirm / busy / force / waiting /
 * error), and the configuration card's staged-edit -> save / reset flows
 * through the `/app` route (`fetch` double logs url/method/headers/body).
 * Without jsdom the DOM sections are skipped with a notice.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
// CJS view of `node:fs` — the only handle that can be monkey-patched (an ESM
// namespace object is immutable). `syncBuiltinESMExports()` then republishes
// the patch to the named imports the host half already linked (see section 2d).
import fs from 'node:fs'
// Same trick for the installer shell-out in section 2f.
import childProcess from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? ''
const profileAnchor = join(userProfile, '.dsh', 'profiles', 'web', 'package.json')
// Resolve from the deployed profile first; a DSH reinstall can prune the
// profile's hoisted copies (dangling links), so the harness checkout backs it up.
const harnessAnchor = 'D:/GitHub/deepseek-harness/apps/web/package.json'
const uiRequire = (spec) => {
  try { return createRequire(profileAnchor)(spec) } catch { return createRequire(harnessAnchor)(spec) }
}
const React = uiRequire('react')

// jsdom is optional: without it the DOM sections are skipped and the host +
// contract checks still run.
let JSDOM = null
try { JSDOM = uiRequire('jsdom').JSDOM } catch { /* skip */ }
const DOM_AVAILABLE = JSDOM !== null

const hostPath = join(here, 'lib', 'index.js')
const clientPath = join(here, 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-client-ui-settings-other'
const CARD_ID = '@local/dsh-client-ui-settings-other'

// --- host half: registration + endpoint validation ---------------------------
const host = await import(pathToFileURL(hostPath).href)

// Pure helpers
{
  const resolved = host.resolveRestartScript({})
  if (!resolved.toLowerCase().endsWith('.dsh\\scripts\\restart-dsh.ps1')) throw new Error(`default script path: ${resolved}`)
  const custom = host.resolveRestartScript({ script: 'C:\\Custom\\restart.ps1' })
  if (custom !== 'C:\\Custom\\restart.ps1') throw new Error(`custom script path: ${custom}`)
  const invocation = host.buildRestartSpawn(resolved)
  if (invocation.file !== 'powershell' || invocation.args[3] !== '-File' || invocation.args[4] !== resolved) {
    throw new Error(`spawn invocation: ${JSON.stringify(invocation)}`)
  }
  const cancelled = []
  const agents = {
    list: () => [
      { id: 'sess-a', status: 'running', cancel: (cause, opts) => cancelled.push({ id: 'sess-a', cause, opts }) },
      { id: 'sess-b', status: 'idle', cancel: () => cancelled.push({ id: 'sess-b' }) },
    ],
    get: (id) => agents.list().find((a) => a.id === id),
  }
  const running = host.runningSessionIds(agents)
  if (running.join(',') !== 'sess-a') throw new Error(`runningSessionIds: ${running}`)
  console.log('host helpers OK: resolveRestartScript + buildRestartSpawn + runningSessionIds')
}

// Branding helpers: favicon SVG wrapper + icon asset (idempotent copy)
{
  const svg = host.faviconSvg(host.patchAssetPath('favicon-128.png'))
  if (!svg.startsWith('<?xml') || !svg.includes('data:image/png;base64,')) throw new Error(`faviconSvg shape: ${svg.slice(0, 80)}`)
  if (!svg.includes('viewBox="0 0 128 128"')) throw new Error('faviconSvg must declare the 128 viewBox')
  const icon = host.ensureIconAsset()
  if (!icon.toLowerCase().endsWith('.dsh\\assets\\deepseekharness-whalegirl.ico')) throw new Error(`icon path: ${icon}`)
  if (!existsSync(icon)) throw new Error('ensureIconAsset must materialize the icon file')
  const again = host.ensureIconAsset()
  if (again !== icon) throw new Error('ensureIconAsset must be idempotent')
  console.log('branding OK: faviconSvg (png data URI) + ensureIconAsset (idempotent)')
}

// Desktop-shortcut status: `created` must come from the installer, not be assumed.
{
  const script = host.shortcutScriptPath()
  if (!script.toLowerCase().endsWith('.dsh\\scripts\\install-desktop-shortcut.ps1')) throw new Error(`shortcut script path: ${script}`)
  const untouched = 'shortcut already exists with -Pause: C:\\Users\\x\\Desktop\\dsh-web.lnk (use -Force to overwrite)'
  const written = 'created C:\\Users\\x\\Desktop\\dsh-web.lnk\ntarget : C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  if (host.shortcutAlreadyExisted(untouched) !== true) throw new Error('an untouched existing shortcut must report created:false')
  if (host.shortcutAlreadyExisted(written) !== false) throw new Error('a written shortcut must report created:true')
  if (host.shortcutAlreadyExisted('') !== false) throw new Error('empty installer output must not read as "already exists"')
  console.log('installShortcut OK: created/existed derived from the installer report')
}

// Runtime snapshot helpers
{
  const info = host.serviceInfo()
  if (info.pid !== process.pid) throw new Error(`serviceInfo.pid: ${info.pid} != ${process.pid}`)
  if (!Number.isFinite(info.uptime) || info.uptime < 0) throw new Error(`serviceInfo.uptime: ${info.uptime}`)
  if (!(info.rss > 0)) throw new Error(`serviceInfo.rss: ${info.rss}`)
  if (info.node !== process.version) throw new Error(`serviceInfo.node: ${info.node}`)
  if (typeof info.execPath !== 'string' || info.execPath.length === 0) throw new Error(`serviceInfo.execPath: ${info.execPath}`)
  if (!Array.isArray(info.ports) || info.ports.some((p) => !Number.isInteger(p))) throw new Error(`serviceInfo.ports: ${JSON.stringify(info.ports)}`)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(info.startedAt)) throw new Error(`serviceInfo.startedAt: ${info.startedAt}`)
  // dsh version resolves from the real CLI entry in the npx cache (when present)
  const npxRoot = join(userProfile, 'AppData', 'Local', 'npm-cache', '_npx', '1e7f6d9597241db0', 'node_modules', '@deepseek-ai', 'dsh')
  const binPath = join(npxRoot, 'lib', 'bin.js')
  const pkgPath = join(npxRoot, 'package.json')
  if (readFileSync(pkgPath, 'utf8').length > 0) {
    const expectedVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version
    const version = host.dshVersion(binPath)
    if (version !== expectedVersion) throw new Error(`dshVersion: ${version} != ${expectedVersion}`)
    console.log(`host snapshot OK: pid=${info.pid} ports=[${info.ports}] dsh=${version} node=${info.node}`)
  } else {
    console.log(`host snapshot OK: pid=${info.pid} ports=[${info.ports}] (dsh version check skipped: ${pkgPath} missing)`)
  }
}

// Idle decision + monitor mechanics (fake clock)
{
  const decision = host.idleDecision
  if (decision({ busy: true, lastBusyAt: 0, now: 99_999_999, idleMinutes: 120 }).action !== 'busy') throw new Error('busy must win')
  const wait = decision({ busy: false, lastBusyAt: 0, now: 60_000, idleMinutes: 2 })
  if (wait.action !== 'wait' || wait.remainingMs !== 60_000) throw new Error(`wait decision: ${JSON.stringify(wait)}`)
  const stop = decision({ busy: false, lastBusyAt: 0, now: 120_000, idleMinutes: 2 })
  if (stop.action !== 'stop') throw new Error(`stop decision: ${JSON.stringify(stop)}`)
  if (decision({ busy: false, lastBusyAt: 0, now: 9_999_999, idleMinutes: 0 }).action !== 'disabled') throw new Error('non-positive idleMinutes must disable')

  // monitor: busy resets the clock; idle past the threshold stops exactly once
  let t = 1_000_000
  let intervalFn = null
  const clock = {
    now: () => t,
    setInterval: (fn) => { intervalFn = fn; return { id: 1 } },
    clearInterval: () => {},
    advance: (ms) => { t += ms },
  }
  let stopped = 0
  let sessionsBusy = true
  const monitor = host.createIdleMonitor({
    busy: () => sessionsBusy,
    idleMinutes: () => 2,
    onStop: () => { stopped += 1 },
    now: clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  })
  clock.advance(10 * 60_000)
  if (monitor.check().action !== 'busy') throw new Error('monitor must stay busy while sessions run')
  if (monitor.lastBusyAt() !== t) throw new Error('busy must reset the idle clock')
  sessionsBusy = false
  clock.advance(119_999)
  if (monitor.check().action !== 'wait') throw new Error('monitor must wait before the threshold')
  clock.advance(2)
  if (monitor.check().action !== 'stop') throw new Error('monitor must stop past the threshold')
  if (stopped !== 1) throw new Error(`onStop fired ${stopped} times`)
  if (monitor.check() !== null) throw new Error('stopped monitor must not act again')
  monitor.stop()
  if (monitor.check() !== null) throw new Error('explicit stop must silence the monitor')
  console.log('host idle OK: decision + monitor (busy reset / wait / stop-once)')
}

let cancelled = []
let innerCtx = null
let settingsRegistered = null
let settingsWatchCb = null
let appExitCalls = []
// Diagnostic-surface doubles, owned by the sections below:
// - `hostWarns` collects the real logger.warn text (the health route's own
//   `warnings` array is read back over the route itself);
// - `settingsRegisterThrows` makes the settings provider explode on register;
// - `settingsOverlay` is the user layer of the settings double: a write through
//   `/app/setSettings` must be observable in the next `status` snapshot;
// - `webServerStub` is the `webServer` service double (null = service absent);
// - `routeEvents` is one ordered log of route registrations, which is how "the
//   health route is registered at the START of the callback, before every
//   optional step and before /app" is asserted.
let hostWarns = []
let settingsRegisterThrows = false
let settingsOverlay = {}
let webServerStub = null
let routeEvents = []
let agentsListCalls = 0
const fakeAgents = {
  list: () => {
    // Counted so the fence assertions can prove that a refused request never
    // reached the endpoint (the `status` endpoint is the only observer-free
    // way to tell: it reads the agent list first).
    agentsListCalls += 1
    return [
      { id: 'sess-a', status: 'running', cancel: (cause, opts) => cancelled.push({ id: 'sess-a', cause, opts }) },
    ]
  },
  get: (id) => fakeAgents.list().find((a) => a.id === id),
}
let settingsAvailable = false
/**
 * The transport moved off `connection` entirely (see the file header), so this
 * double keeps only a TRIPWIRE there: reading any property of it throws. A
 * surviving `ctx.connection.rpc.handle(...)` would therefore fail loudly
 * instead of "registering a channel" into a variable nothing reads. The name
 * is still declared in the plugin's inner inject gate, which this mock resolves
 * by string, so the tripwire never blocks the callback.
 */
const connectionTripwire = () => new Proxy({}, {
  get: (_target, prop) => {
    throw new Error(`ctx.connection.${String(prop)} was read: the transport must go through webServer`)
  },
})
const hostCtx = {
  connection: connectionTripwire(),
  inject: (services, callback) => {
    const list = services.join(',')
    // `webServer` is declared (not an optional read): the carrier is bound
    // late, so reading it during this callback would race its activation and
    // silently skip the whole transport. `agents` stays for session queries.
    if (list === 'webServer,agents') {
      innerCtx = {
        connection: connectionTripwire(),
        agents: fakeAgents,
        logger: { info: () => {}, warn: (message) => { hostWarns.push(String(message)) } },
        get: (name) => {
          if (name === 'appExit') return (code) => { appExitCalls.push(code) }
          if (name === 'webServer') return webServerStub ?? undefined
          return undefined
        },
        inject: hostCtx.inject,
        effect: (fn) => fn(),
        fiber: { state: 0 },
      }
      return callback(innerCtx)
    }
    if (list === 'settings' && settingsAvailable) {
      return callback({
        ...innerCtx,
        settings: {
          register: (ns, schema, options) => {
            if (settingsRegisterThrows) throw new Error('settings provider exploded during register (harness double)')
            settingsRegistered = { ns, options }
            settingsOverlay = {}
            // Mirrors the real scope: `get()` resolves base over the user
            // layer, and `update`/`replace` move that layer and notify watch.
            const get = () => ({ ...host.DEFAULTS, ...(options.base ?? {}), ...settingsOverlay })
            const notify = () => { if (settingsWatchCb !== null) settingsWatchCb() }
            return {
              get,
              watch: (cb) => { settingsWatchCb = cb; return () => {} },
              update: async (fields) => {
                if (settingsRegistered === null) throw new Error('scope detached (harness double)')
                settingsOverlay = { ...settingsOverlay, ...fields }
                notify()
              },
              replace: async () => {
                if (settingsRegistered === null) throw new Error('scope detached (harness double)')
                settingsOverlay = {}
                notify()
              },
            }
          },
        },
      })
    }
    return undefined
  },
  effect: (fn) => fn(),
}

// config.script points at a NON-EXISTENT path so the restart endpoint fails
// cleanly (script-missing branch) instead of spawning a real restart.
const MISSING_SCRIPT = 'C:\\__no_such_dir__\\restart-dsh.ps1'
// Temp dir for harness-owned stub scripts (never the real profile layer).
const harnessTmpDir = mkdtempSync(join(tmpdir(), 'ui-settings-other-verify-'))

/**
 * Every RPC failure must carry the repository's full envelope
 * `{ ok: false, error: { code, message, details } }` — an empty `details` is
 * allowed, a missing one is not.
 */
const assertErrorEnvelope = (label, result) => {
  if (result?.ok !== false) throw new Error(`${label}: expected ok:false, got ${JSON.stringify(result)}`)
  const { code, message, details } = result.error ?? {}
  if (typeof code !== 'string' || code.length === 0) throw new Error(`${label}: error.code missing`)
  if (typeof message !== 'string' || message.length === 0) throw new Error(`${label}: error.message missing`)
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    throw new Error(`${label}: error.details missing`)
  }
}

// --- route doubles ------------------------------------------------------------
// The host half owns two surfaces on the `webServer` service: its diagnostics
// route `/ui-settings-other/health` (without it, "the /app route never
// registered" and "an optional step threw" look identical from the page — these
// checks are the only place that surface is observed directly) and the `/app`
// prefix route that carries every RPC endpoint.
const HEALTH_PATH = '/ui-settings-other/health'
const FAVICON_PATH = '/favicon.svg'
const APP_PATH = '/app'
const EXPECTED_ROUTE_SURFACE = [`exact ${HEALTH_PATH}`, `exact ${FAVICON_PATH}`, `prefix ${APP_PATH}`]

/** `webServer` service double: records every register() as { kind, path, handler }. */
const makeWebServerStub = () => {
  const routes = []
  return {
    routes,
    register: (route) => {
      routes.push({ kind: route.kind, path: route.path, handler: route.handler })
      routeEvents.push(`route:${route.path}`)
      return () => {} // the real service returns a disposer
    },
  }
}

/**
 * Minimal `req` double: exactly the surface `createRpcRoute`'s handler uses
 * (method / headers / url / on / destroy). `send()` replays the body through
 * the 'data' listener and then closes the stream with 'end' — the same order
 * the carrier delivers them in.
 */
const makeReq = ({ method = 'POST', url = '/', headers = {}, body = '', host = '127.0.0.1:3080' } = {}) => {
  const listeners = new Map()
  const req = {
    method,
    url,
    headers: { host, ...headers },
    destroyed: false,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return req
    },
    destroy() { req.destroyed = true },
    send() {
      if (body.length > 0) for (const listener of listeners.get('data') ?? []) listener(body)
      for (const listener of listeners.get('end') ?? []) listener()
    },
  }
  return req
}

/** `res` double recording writeHead/end; `settled` resolves once end() ran. */
const makeRes = () => {
  let settle
  const settled = new Promise((resolve) => { settle = resolve })
  return {
    status: null,
    headers: {},
    body: '',
    writableEnded: false,
    settled,
    writeHead(status, headers) {
      this.status = status
      for (const [name, value] of Object.entries(headers ?? {})) this.headers[name.toLowerCase()] = value
      return this
    },
    end(chunk) {
      this.body = String(chunk ?? '')
      this.writableEnded = true
      settle(this)
      return this
    },
  }
}

/**
 * Drive one registered route the way the web carrier would. The `/app` handler
 * answers from inside `req.on('end')`, so the response is NOT ready when the
 * handler returns: the request is streamed first, then the response is awaited
 * (with a 2 s guard so a handler that never answers fails the harness instead
 * of hanging it).
 */
const callRoute = async (route, options = {}) => {
  const req = makeReq({ url: route.path, ...options })
  const res = makeRes()
  await route.handler(req, res)
  req.send()
  const guard = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`route ${route.path} never answered (${req.method} ${req.url})`)), 2000).unref?.()
  })
  await Promise.race([res.settled, guard])
  return res
}

/** The exact health route this apply() registered (both kind and path asserted). */
const healthRouteOf = (stub) => {
  const route = stub.routes.find((r) => r.path === HEALTH_PATH)
  if (route === undefined) {
    throw new Error(`${HEALTH_PATH} never registered (routes: ${JSON.stringify(stub.routes.map((r) => r.path))})`)
  }
  if (route.kind !== 'exact') throw new Error(`${HEALTH_PATH} must be kind 'exact', got '${route.kind}'`)
  return route
}

/**
 * The `/app` route this apply() registered. It replaced the old
 * `ctx.connection.rpc` channel, so the registration is asserted the same way:
 * exact kind + path, and a real handler to drive.
 */
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
 * One `POST /app/<endpoint>` through the real route handler, the way the
 * browser half sends it, with the answer parsed back into the envelope.
 * `overrides` lets a caller break one part of the request on purpose (the fence
 * assertions below do exactly that).
 */
const callApp = async (stub, endpoint, args, overrides = {}) => {
  const res = await callRoute(appRouteOf(stub), {
    method: 'POST',
    url: `${APP_PATH}/${endpoint}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: args ?? {} }),
    ...overrides,
  })
  if (res.status !== 200) throw new Error(`POST ${APP_PATH}/${endpoint} must answer 200, got ${res.status}: ${res.body}`)
  if (res.headers['content-type'] !== 'application/json') {
    throw new Error(`POST ${APP_PATH}/${endpoint} content-type: ${JSON.stringify(res.headers['content-type'])}`)
  }
  if (res.headers['cache-control'] !== 'no-store') {
    throw new Error(`POST ${APP_PATH}/${endpoint} cache-control: ${JSON.stringify(res.headers['cache-control'])}`)
  }
  return parseBody(`${APP_PATH}/${endpoint}`, res)
}

/** The envelope carried by a route response (must be JSON). */
const parseBody = (label, res) => {
  try {
    return JSON.parse(res.body)
  } catch {
    throw new Error(`${label}: body is not JSON: ${JSON.stringify(res.body).slice(0, 200)}`)
  }
}

/** One refused request: status + envelope code + the JSON/no-store headers. */
const assertRouteFailure = (res, status, code, label) => {
  if (res.status !== status) throw new Error(`${label}: must answer ${status}, got ${res.status}: ${res.body}`)
  if (res.headers['content-type'] !== 'application/json') {
    throw new Error(`${label}: content-type: ${JSON.stringify(res.headers['content-type'])}`)
  }
  if (res.headers['cache-control'] !== 'no-store') {
    throw new Error(`${label}: cache-control: ${JSON.stringify(res.headers['cache-control'])}`)
  }
  const body = parseBody(label, res)
  assertErrorEnvelope(label, body)
  if (body.error.code !== code) throw new Error(`${label}: error.code must be ${code}, got ${JSON.stringify(body)}`)
  return body
}

/**
 * Read the health route the way the page would: real writeHead/end capture,
 * JSON body, exact headers, and one expected value per diagnostic flag.
 */
const readHealth = async (stub, expected, label) => {
  const res = await callRoute(healthRouteOf(stub))
  if (res.status !== 200) throw new Error(`${label}: health must answer 200, got ${res.status}`)
  if (res.headers['content-type'] !== 'application/json') {
    throw new Error(`${label}: content-type must be application/json, got ${JSON.stringify(res.headers['content-type'])}`)
  }
  if (res.headers['cache-control'] !== 'no-store') {
    throw new Error(`${label}: cache-control must be no-store, got ${JSON.stringify(res.headers['cache-control'])}`)
  }
  let body = null
  try {
    body = JSON.parse(res.body)
  } catch {
    throw new Error(`${label}: health body is not JSON: ${JSON.stringify(res.body).slice(0, 200)}`)
  }
  if (body.ok !== true) throw new Error(`${label}: ok must be true, got ${JSON.stringify(body.ok)}`)
  if (body.namespace !== 'ui-settings-other') throw new Error(`${label}: namespace mismatch: ${JSON.stringify(body.namespace)}`)
  if (!Array.isArray(body.warnings)) throw new Error(`${label}: warnings must be an array, got ${JSON.stringify(body.warnings)}`)
  for (const [key, value] of Object.entries(expected)) {
    if (body[key] !== value) {
      throw new Error(`${label}: ${key} must be ${value}, got ${JSON.stringify(body[key])} — body ${JSON.stringify(body)}`)
    }
  }
  return body
}

/** Status is this section's life support: it must answer even when degraded. */
const assertStatusUsable = async (stub, label) => {
  const status = await callApp(stub, 'status')
  if (status?.ok !== true) throw new Error(`${label}: status must still answer ok:true, got ${JSON.stringify(status)}`)
  if (typeof status.value?.running !== 'number') {
    throw new Error(`${label}: status.value.running must be a number, got ${JSON.stringify(status.value?.running)}`)
  }
  return status
}

// 1) apply without a settings service -> entry fallback, status still rich
{
  cancelled = []
  appExitCalls = []
  settingsRegistered = null
  settingsAvailable = false
  hostWarns = []
  routeEvents = []
  webServerStub = makeWebServerStub()
  const web = webServerStub
  const ret = host.apply(hostCtx, { script: MISSING_SCRIPT })
  // P0 regression guard: returning the ctx.inject() thenable Fiber from apply
  // makes Cordis throw TypeError('Invalid effect') and fail the plugin.
  if (ret !== undefined && (typeof ret === 'object' || typeof ret === 'function') && typeof ret.then === 'function') {
    throw new Error('P0 regression: apply returned a thenable (Invalid effect)')
  }
  // The transport registration: one prefix route at /app (this is what the old
  // `handled.channel === '/app'` + loopback-authority pair asserted).
  const app = appRouteOf(web)
  if (app.path !== APP_PATH) throw new Error(`host route path: ${app.path}`)
  if (settingsRegistered !== null) throw new Error('no settings service must not register a namespace')
  if (hostWarns.length !== 0) throw new Error(`apply without settings must not warn: ${JSON.stringify(hostWarns)}`)

  const status0 = await callApp(web, 'status')
  if (!status0.ok || status0.value.running !== 1 || status0.value.sessions.join(',') !== 'sess-a') {
    throw new Error(`status endpoint: ${JSON.stringify(status0)}`)
  }
  if (status0.value.service?.pid !== process.pid) throw new Error(`status service.pid: ${JSON.stringify(status0.value.service)}`)
  if (!status0.value.idle?.enabled || status0.value.idle.idleMinutes !== 120) {
    throw new Error(`status idle defaults: ${JSON.stringify(status0.value.idle)}`)
  }
  if (typeof status0.value.idle.lastBusyAt !== 'number') throw new Error('idle must expose lastBusyAt')
  if (appExitCalls.length !== 0) throw new Error('status must never exit')

  const unknown = await callApp(web, 'nope')
  assertErrorEnvelope('unknown endpoint', unknown)
  if (unknown.ok !== false || unknown.error.code !== 'bad-request') throw new Error('unknown endpoint must be rejected')
  if (unknown.error.details.endpoint !== 'nope') throw new Error(`unknown endpoint details: ${JSON.stringify(unknown.error.details)}`)

  const settingsUnavailable = await callApp(web, 'setSettings', { fields: { idleMinutes: 5 } })
  assertErrorEnvelope('setSettings without settings', settingsUnavailable)
  if (settingsUnavailable.error.code !== 'settings-unavailable') {
    throw new Error(`settings-unavailable code: ${JSON.stringify(settingsUnavailable)}`)
  }
  if (settingsUnavailable.error.details.namespace !== 'ui-settings-other') {
    throw new Error(`settings-unavailable details: ${JSON.stringify(settingsUnavailable.error.details)}`)
  }

  const busy = await callApp(web, 'restart', {})
  assertErrorEnvelope('busy restart', busy)
  if (busy.ok !== false || busy.error.code !== 'sessions-running') throw new Error(`busy must be refused: ${JSON.stringify(busy)}`)
  if (cancelled.length !== 0) throw new Error('non-force restart must not cancel sessions')

  const forced = await callApp(web, 'restart', { force: true })
  assertErrorEnvelope('forced restart (missing script)', forced)
  if (forced.ok !== false || forced.error.code !== 'internal') throw new Error(`forced must reach script check: ${JSON.stringify(forced)}`)
  if (forced.error.details.script !== MISSING_SCRIPT) throw new Error(`restart details.script: ${JSON.stringify(forced.error.details)}`)
  if (cancelled.length !== 1 || cancelled[0].id !== 'sess-a') throw new Error(`force must cancel running sessions: ${JSON.stringify(cancelled)}`)
  if (cancelled[0].opts?.keepInbox !== true) throw new Error('force cancel must keepInbox')

  console.log('host OK: prefix /app route + status(running/service/idle) + restart session protection (busy/force)')
}

// 2) apply WITH a settings service -> namespace registered, entry as base, watch wired
{
  settingsRegistered = null
  settingsWatchCb = null
  settingsAvailable = true
  hostWarns = []
  routeEvents = []
  webServerStub = makeWebServerStub()
  const web = webServerStub
  const ret = host.apply(hostCtx, { script: MISSING_SCRIPT, idleMinutes: 7 })
  if (ret !== undefined && typeof ret.then === 'function') throw new Error('P0 regression: apply returned a thenable (with settings)')
  appRouteOf(web)
  if (settingsRegistered === null || settingsRegistered.ns !== 'ui-settings-other') {
    throw new Error(`namespace not registered: ${JSON.stringify(settingsRegistered)}`)
  }
  if (JSON.stringify(settingsRegistered.options.base) !== '{"idleMinutes":7}') {
    throw new Error(`entry base mismatch: ${JSON.stringify(settingsRegistered.options.base)}`)
  }
  if (settingsWatchCb === null) throw new Error('settings watch must be wired')
  const status1 = await callApp(web, 'status')
  if (status1.value.idle.idleMinutes !== 7) throw new Error(`entry idleMinutes must drive status: ${JSON.stringify(status1.value.idle)}`)
  settingsWatchCb() // simulated settings change: monitor rebuild must not throw
  if (status1.value.idle.enabled !== true) throw new Error('idle enabled default mismatch')
  const badFields = await callApp(web, 'setSettings', { fields: [] })
  assertErrorEnvelope('setSettings with bad fields', badFields)
  if (badFields.error.code !== 'bad-request' || badFields.error.details.received !== 'array') {
    throw new Error(`bad fields envelope: ${JSON.stringify(badFields)}`)
  }

  // The remaining settings endpoints through the real route: `getSettings`
  // returns the resolved source, a valid `setSettings` write moves it (and the
  // next `status` snapshot proves the write reached the plugin, not just the
  // scope double), `resetSettings` drops the user layer back to the entry base.
  const read = await callApp(web, 'getSettings')
  if (!read.ok || read.value.idleMinutes !== 7 || read.value.idleEnabled !== true) {
    throw new Error(`getSettings envelope: ${JSON.stringify(read)}`)
  }
  const write = await callApp(web, 'setSettings', { fields: { idleMinutes: 30 } })
  if (!write.ok || write.value.idleMinutes !== 30) throw new Error(`setSettings must answer the new source: ${JSON.stringify(write)}`)
  const statusWritten = await callApp(web, 'status')
  if (statusWritten.value.idle.idleMinutes !== 30) {
    throw new Error(`a committed write must drive status: ${JSON.stringify(statusWritten.value.idle)}`)
  }
  const reset = await callApp(web, 'resetSettings')
  if (!reset.ok || reset.value.idleMinutes !== 7) {
    throw new Error(`resetSettings must fall back to the entry base: ${JSON.stringify(reset)}`)
  }
  const statusReset = await callApp(web, 'status')
  if (statusReset.value.idle.idleMinutes !== 7) {
    throw new Error(`reset must drive status back to the entry base: ${JSON.stringify(statusReset.value.idle)}`)
  }
  console.log('host OK: settings namespace ui-settings-other (base=entry) + watch rebuild + get/set/reset Settings over /app')
}

// 2b) diagnostics route: with a `webServer` service, every apply() publishes an
//     exact `/ui-settings-other/health` that reports what actually attached.
{
  settingsRegistered = null
  settingsWatchCb = null
  settingsAvailable = true
  settingsRegisterThrows = false
  hostWarns = []
  routeEvents = []
  webServerStub = makeWebServerStub()
  const web = webServerStub

  host.apply(hostCtx, { script: MISSING_SCRIPT })

  appRouteOf(web)
  const health = await readHealth(web, { channel: true, settings: true, branding: true }, 'health (healthy apply)')
  if (health.warnings.length !== 0) throw new Error(`a healthy apply must report no warnings: ${JSON.stringify(health.warnings)}`)
  if (hostWarns.length !== 0) throw new Error(`a healthy apply must log no warnings: ${JSON.stringify(hostWarns)}`)

  // Exactly three routes: both exact routes plus the /app prefix; the favicon
  // route really serves the SVG and /app really answers an endpoint.
  const routeSurface = web.routes.map((r) => `${r.kind} ${r.path}`)
  if (JSON.stringify(routeSurface) !== JSON.stringify(EXPECTED_ROUTE_SURFACE)) {
    throw new Error(`route surface must be exactly ${JSON.stringify(EXPECTED_ROUTE_SURFACE)}, got ${JSON.stringify(routeSurface)}`)
  }
  const faviconRes = await callRoute(web.routes.find((r) => r.path === FAVICON_PATH))
  if (faviconRes.headers['content-type'] !== 'image/svg+xml') {
    throw new Error(`favicon content-type: ${JSON.stringify(faviconRes.headers['content-type'])}`)
  }
  if (!faviconRes.body.startsWith('<?xml') || !faviconRes.body.includes('data:image/png;base64,')) {
    throw new Error(`favicon body shape: ${faviconRes.body.slice(0, 60)}`)
  }

  // Health FIRST: it is registered before every optional step and before the
  // /app prefix route, so a later failure cannot take the diagnostic surface
  // down with it.
  const expectedOrder = `route:${HEALTH_PATH}|route:${FAVICON_PATH}|route:${APP_PATH}`
  if (routeEvents.join('|') !== expectedOrder) {
    throw new Error(`registration order must be ${expectedOrder}, got ${routeEvents.join('|')}`)
  }
  console.log(`host health OK: exact ${HEALTH_PATH} (json + no-store) reports channel/settings/branding, registered first`)
}

// 2c) fail-soft, core regression: a throwing settings wiring must NOT take the
//     /app route down. Unguarded, that throw skipped the route registration
//     below it — no route existed and the whole page read 运行状态获取失败.
//
//     Fidelity note: this shared hostCtx double calls `inject` callbacks
//     SYNCHRONOUSLY (sections 1/2 already depend on that), so the settings
//     throw below really lands in apply's catch. A real Cordis Context
//     schedules that callback in the settings child fiber instead, where the
//     throw is contained and never reaches apply — verified against
//     @deepseek-ai/cordis, which is why the favicon/monitor guards (2d) are the
//     ones that protect the transport in production.
{
  settingsRegistered = null
  settingsWatchCb = null
  settingsAvailable = true
  settingsRegisterThrows = true
  hostWarns = []
  routeEvents = []
  webServerStub = makeWebServerStub()
  const web = webServerStub

  let applyFailure = null
  try { host.apply(hostCtx, { script: MISSING_SCRIPT }) } catch (error) { applyFailure = error }
  if (applyFailure !== null) {
    throw new Error(`fail-soft regression: a throwing settings wiring must not escape apply (threw: ${applyFailure.message})`)
  }
  // appRouteOf throws the same way the old channel assertion did: the route
  // must exist even though the settings wiring above it exploded.
  appRouteOf(web)
  if (settingsRegistered !== null) throw new Error('a throwing register must not be recorded as registered')

  const health = await readHealth(web, { channel: true, settings: false, branding: true }, 'health (settings wiring failed)')
  if (health.warnings.length !== 1 || !/^settings wiring failed/.test(health.warnings[0])) {
    throw new Error(`the settings failure must be reported once in warnings: ${JSON.stringify(health.warnings)}`)
  }
  if (hostWarns.length !== 1 || !hostWarns[0].includes(health.warnings[0])) {
    throw new Error(`the same reason must reach logger.warn: ${JSON.stringify(hostWarns)}`)
  }

  // The route is fully usable, not merely registered.
  const status = await assertStatusUsable(web, 'degraded status (settings wiring failed)')
  if (status.value.idle?.enabled !== true || status.value.idle.idleMinutes !== 120) {
    throw new Error(`the entry-config fallback must still drive idle: ${JSON.stringify(status.value.idle)}`)
  }
  const write = await callApp(web, 'setSettings', { fields: { idleMinutes: 5 } })
  assertErrorEnvelope('setSettings without a scope', write)
  if (write.error.code !== 'settings-unavailable') {
    throw new Error(`setSettings must degrade with settings-unavailable: ${JSON.stringify(write)}`)
  }
  console.log('host fail-soft OK: a throwing settings register still leaves /app + status + settings-unavailable')
}

// 2d) fail-soft: an unreadable favicon asset must only skip the branding. The
//     failure is injected at the REAL read site — `faviconSvg()` reads
//     assets/favicon-128.png through the `readFileSync` named import of
//     `node:fs` — by patching that function for that one path and republishing
//     it to the already-linked ESM import via `syncBuiltinESMExports()`. No repo
//     file is touched, and the patch is removed in a `finally` before any later
//     read, so every other read in this harness stays real.
{
  const faviconAsset = host.patchAssetPath('favicon-128.png')

  settingsRegistered = null
  settingsWatchCb = null
  settingsAvailable = true
  settingsRegisterThrows = false
  hostWarns = []
  routeEvents = []
  webServerStub = makeWebServerStub()
  const web = webServerStub

  const realReadFileSync = fs.readFileSync
  let injected = 0
  let applyFailure = null
  try {
    fs.readFileSync = function readFileSyncWithUnreadableFavicon(path, ...rest) {
      if (String(path) === faviconAsset) {
        injected += 1
        const error = new Error(`ENOENT: no such file or directory, open '${path}'`)
        error.code = 'ENOENT'
        throw error
      }
      return realReadFileSync.call(fs, path, ...rest)
    }
    syncBuiltinESMExports() // the host half's named import now sees the patch
    try { host.apply(hostCtx, { script: MISSING_SCRIPT }) } catch (error) { applyFailure = error }
  } finally {
    fs.readFileSync = realReadFileSync
    syncBuiltinESMExports()
  }

  if (applyFailure !== null) {
    throw new Error(`fail-soft regression: an unreadable favicon asset must not escape apply (threw: ${applyFailure.message})`)
  }
  appRouteOf(web)
  if (injected !== 1) throw new Error(`the favicon asset must be read exactly once, injected ${injected} failure(s)`)
  // The injection is really gone: the asset reads again, and it is a real PNG.
  const png = readFileSync(faviconAsset)
  if (png.subarray(0, 4).toString('hex') !== '89504e47') throw new Error('the favicon asset must read as PNG after the probe')

  const health = await readHealth(web, { channel: true, settings: true, branding: false }, 'health (favicon unreadable)')
  if (health.warnings.length !== 1 || !/^favicon override skipped/.test(health.warnings[0]) || !health.warnings[0].includes('ENOENT')) {
    throw new Error(`the favicon failure must be reported once, with its cause: ${JSON.stringify(health.warnings)}`)
  }
  const routeSurface = web.routes.map((r) => `${r.kind} ${r.path}`)
  const expectedSurface = [`exact ${HEALTH_PATH}`, `prefix ${APP_PATH}`]
  if (JSON.stringify(routeSurface) !== JSON.stringify(expectedSurface)) {
    throw new Error(`a skipped branding must register no favicon route, got ${JSON.stringify(routeSurface)}`)
  }
  const status = await assertStatusUsable(web, 'degraded status (favicon unreadable)')
  if (status.value.idle?.idleMinutes !== 120) throw new Error(`status idle after a skipped branding: ${JSON.stringify(status.value.idle)}`)
  console.log('host fail-soft OK: an unreadable favicon asset skips branding only; /app + status stay up')
}

// 2e) the /app route's fence, driven through the real handler. This is the
//     access-control surface that replaced the Connection's own loopback
//     authority, so every branch is asserted on the wire: cross-origin refusal
//     (403, endpoint never reached), POST-only (405), JSON-only bodies (415,
//     400), the 1 MB cap (413), and endpoint-path parsing (404 for a bare,
//     trailing-slash or multi-segment path; the query string is not part of the
//     endpoint).
{
  settingsRegistered = null
  settingsWatchCb = null
  settingsAvailable = true
  settingsRegisterThrows = false
  hostWarns = []
  routeEvents = []
  webServerStub = makeWebServerStub()
  const web = webServerStub
  host.apply(hostCtx, { script: MISSING_SCRIPT })
  const route = appRouteOf(web)

  // (1) Cross-origin: `Origin` present and different from `Host` -> 403, and the
  //     endpoint must not run. `status` reads the agent list first, which is the
  //     observable side effect that proves the handler never got there.
  agentsListCalls = 0
  const crossOrigin = await callRoute(route, {
    method: 'POST',
    url: `${APP_PATH}/status`,
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{"args":{}}',
  })
  assertRouteFailure(crossOrigin, 403, 'forbidden', 'cross-origin POST')
  if (agentsListCalls !== 0) throw new Error('a refused cross-origin request must not reach the endpoint')

  // (2) Positive control: the SAME request with a same-origin `Origin` is served —
  //     and so is one with no `Origin` at all, which is the plain same-origin
  //     fetch the browser half actually sends.
  agentsListCalls = 0
  const sameOrigin = await callRoute(route, {
    method: 'POST',
    url: `${APP_PATH}/status`,
    headers: { origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' },
    body: '{"args":{}}',
  })
  if (sameOrigin.status !== 200) throw new Error(`same-origin POST must be served, got ${sameOrigin.status}: ${sameOrigin.body}`)
  if (parseBody('same-origin status', sameOrigin).ok !== true) throw new Error('same-origin status must answer ok:true')
  if (agentsListCalls !== 1) throw new Error(`same-origin status must reach the endpoint once, got ${agentsListCalls}`)
  agentsListCalls = 0
  const noOrigin = await callApp(web, 'status')
  if (noOrigin.ok !== true) throw new Error(`a request without Origin must be served: ${JSON.stringify(noOrigin)}`)
  if (agentsListCalls !== 1) throw new Error(`a request without Origin must reach the endpoint once, got ${agentsListCalls}`)

  // (3) POST only.
  const notPost = await callRoute(route, {
    method: 'GET',
    url: `${APP_PATH}/status`,
    headers: { 'content-type': 'application/json' },
  })
  assertRouteFailure(notPost, 405, 'method-not-allowed', 'GET /app/status')

  // (4) JSON bodies only.
  const wrongType = await callRoute(route, {
    method: 'POST',
    url: `${APP_PATH}/status`,
    headers: { 'content-type': 'text/plain' },
    body: '{"args":{}}',
  })
  assertRouteFailure(wrongType, 415, 'unsupported-media-type', 'text/plain POST')

  // (5) A body that is not JSON.
  const badJson = await callRoute(route, {
    method: 'POST',
    url: `${APP_PATH}/status`,
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  assertRouteFailure(badJson, 400, 'bad-request', 'non-JSON body')

  // (6) Endpoint parsing: a bare prefix, a trailing slash and any multi-segment
  //     path are all "unknown endpoint" — never a silently accepted alias.
  for (const [path, label] of [[APP_PATH, 'bare prefix'], [`${APP_PATH}/`, 'trailing slash'], [`${APP_PATH}/a/b`, 'multi-segment']]) {
    const malformed = await callRoute(route, {
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/json' },
      body: '{"args":{}}',
    })
    assertRouteFailure(malformed, 404, 'unknown-endpoint', label)
  }

  // (7) The 1 MB cap and the query string.
  const oversized = await callRoute(route, {
    method: 'POST',
    url: `${APP_PATH}/status`,
    headers: { 'content-type': 'application/json' },
    body: `{"args":"${'x'.repeat(1 << 20)}"}`,
  })
  assertRouteFailure(oversized, 413, 'payload-too-large', 'oversized body')
  const queried = await callRoute(route, {
    method: 'POST',
    url: `${APP_PATH}/status?probe=1`,
    headers: { 'content-type': 'application/json' },
    body: '{"args":{}}',
  })
  if (queried.status !== 200) throw new Error(`a query string must not change the endpoint, got ${queried.status}: ${queried.body}`)
  console.log('host fence OK: 403 cross-origin (endpoint unreached) | 405 non-POST | 415 non-JSON type | 400 bad JSON | 413 oversized | 404 bare/trailing/multi-segment')
}

// 2f) the installShortcut endpoint through the real route. It shells out to
//     powershell, so `execFileSync` is scripted out for the duration (CJS view +
//     syncBuiltinESMExports, the same technique as the favicon probe): the
//     endpoint, its argument vector and its envelope stay real, but no process
//     starts and no desktop shortcut is ever created.
{
  settingsRegistered = null
  settingsWatchCb = null
  settingsAvailable = true
  settingsRegisterThrows = false
  hostWarns = []
  routeEvents = []
  webServerStub = makeWebServerStub()
  const web = webServerStub
  host.apply(hostCtx, { script: MISSING_SCRIPT })
  appRouteOf(web)

  const installerDeployed = existsSync(host.shortcutScriptPath())
  const realExecFileSync = childProcess.execFileSync
  const scripted = []
  let created = null
  let failed = null
  try {
    childProcess.execFileSync = (file, args, options) => {
      scripted.push({ file, args, options })
      return 'created C:\\Users\\x\\Desktop\\dsh-web.lnk\ntarget : powershell.exe\n'
    }
    syncBuiltinESMExports() // installShortcut's named import now sees the stub
    created = await callApp(web, 'installShortcut')

    // The installer failing is the endpoint's ok:false branch (its own output is
    // the message, and the script path rides along in details).
    childProcess.execFileSync = () => {
      const error = new Error('powershell exited with code 1')
      error.stdout = 'installer could not create the shortcut'
      throw error
    }
    syncBuiltinESMExports()
    failed = await callApp(web, 'installShortcut')
  } finally {
    childProcess.execFileSync = realExecFileSync
    syncBuiltinESMExports()
  }

  // The endpoint shells out to the DEPLOYED installer script. On a checkout
  // where `scripts/deploy.ps1` has not run yet that file is absent, the endpoint
  // stops at its own "install script missing" envelope and never reaches
  // execFileSync — so that is the branch observable there.
  if (!installerDeployed) {
    assertErrorEnvelope('installShortcut (installer not deployed)', created)
    if (!/install script missing/.test(created.error.message)) {
      throw new Error(`an undeployed installer must be reported as such: ${JSON.stringify(created)}`)
    }
    if (scripted.length !== 0) throw new Error('no installer may run while the script is missing')
    console.log('installShortcut OK: /app installShortcut reports the missing deployed installer (run scripts/deploy.ps1 to exercise the powershell path)')
  } else {
    if (created?.ok !== true || created.value?.created !== true || !String(created.value.output).startsWith('created ')) {
      throw new Error(`installShortcut envelope: ${JSON.stringify(created)}`)
    }
    if (scripted.length !== 1) throw new Error(`the installer must run exactly once, ran ${scripted.length} time(s)`)
    const invocation = scripted[0]
    if (invocation.file !== 'powershell') throw new Error(`installer file: ${invocation.file}`)
    if (!invocation.args.includes('-File')) throw new Error(`installer args: ${JSON.stringify(invocation.args)}`)
    const scriptArg = String(invocation.args[invocation.args.length - 1])
    if (!scriptArg.toLowerCase().endsWith('.dsh\\scripts\\install-desktop-shortcut.ps1')) {
      throw new Error(`installer script path: ${scriptArg}`)
    }
    if (!String(created.value.icon).toLowerCase().endsWith('.dsh\\assets\\deepseekharness-whalegirl.ico')) {
      throw new Error(`installShortcut icon path: ${created.value.icon}`)
    }
    assertErrorEnvelope('installShortcut failure', failed)
    if (failed.error.code !== 'internal' || !failed.error.message.includes('could not create')) {
      throw new Error(`a failed installer must surface as an internal error envelope: ${JSON.stringify(failed)}`)
    }
    console.log('installShortcut OK: /app installShortcut -> powershell -File install-desktop-shortcut.ps1 -> ok/failed envelopes')
  }
}

// 2g) without a `webServer` service the transport cannot exist: apply must warn
//     once and register nothing, NOT throw (the page then shows its own
//     fallback copy instead of the plugin taking the boot down).
{
  settingsRegistered = null
  settingsWatchCb = null
  settingsAvailable = true
  settingsRegisterThrows = false
  hostWarns = []
  routeEvents = []
  webServerStub = null // no webServer service at all

  let applyFailure = null
  let returned
  try { returned = host.apply(hostCtx, { script: MISSING_SCRIPT }) } catch (error) { applyFailure = error }
  if (applyFailure !== null) throw new Error(`a missing webServer must not throw (threw: ${applyFailure.message})`)
  if (returned !== undefined && typeof returned.then === 'function') throw new Error('P0 regression: apply returned a thenable (no webServer)')
  if (hostWarns.length !== 1 || !/webServer is unavailable/.test(hostWarns[0])) {
    throw new Error(`a missing webServer must warn exactly once: ${JSON.stringify(hostWarns)}`)
  }
  if (routeEvents.length !== 0) throw new Error(`no route may register without a webServer: ${JSON.stringify(routeEvents)}`)
  console.log('host fail-soft OK: a missing webServer warns once and registers nothing')
}

// Hand the shared hostCtx double back in its default shape (no webServer).
webServerStub = null

// 3) lifecycle: one monitor per apply, none created during an unload, none
//    leaked by it, and no restart watchdog outliving the plugin.
//
//    The mock mirrors the two Cordis semantics these guarantees rest on:
//    `ctx.inject` registers a CHILD fiber on the parent (and settles on a later
//    microtask, so the settings section attaches after `apply` returns), and a
//    fiber releases its effects in REVERSE registration order — which is why
//    the settings section's disposer runs before the monitor-owning effect.
{
  const FIBER_ACTIVE = 2
  const FIBER_UNLOADING = 5
  const FIBER_DISPOSED = 4
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const lifecycleLogger = { info: () => {}, warn: () => {} }

  const makeFiber = ({ services }) => {
    const disposables = []
    const children = []
    const fiber = { state: FIBER_ACTIVE }
    const self = {
      ctx: null,
      async dispose() {
        fiber.state = FIBER_UNLOADING
        for (const entry of disposables.splice(0).reverse()) await entry.dispose()
        fiber.state = FIBER_DISPOSED
      },
    }
    const ctx = {
      fiber,
      logger: lifecycleLogger,
      children,
      // Cordis exposes every available service as a context property as well.
      ...services,
      get: (name) => services[name],
      effect: (execute, label) => {
        const dispose = execute()
        if (typeof dispose === 'function') disposables.push({ label, dispose })
        return dispose
      },
      inject: (names, callback) => {
        // Cordis starts the child only once every injected service is present,
        // and only after a microtask checkpoint.
        if (names.some((name) => services[name] === undefined)) return undefined
        const child = makeFiber({ services })
        children.push(child)
        disposables.push({ label: 'ctx.inject()', dispose: () => child.dispose() })
        void Promise.resolve().then(() => callback(child.ctx))
        return child
      },
    }
    self.ctx = ctx
    return self
  }

  /** Settings provider double: `get()` resolves base over the user layer. */
  const makeSettings = (initial) => {
    let value = { ...initial }
    const watchers = new Set()
    return {
      set: (fields) => {
        value = { ...value, ...fields }
        for (const cb of watchers) cb()
      },
      service: {
        register: (ns, schema, options) => ({
          get: () => ({ ...options.base, ...value }),
          watch: (cb) => { watchers.add(cb); return () => watchers.delete(cb) },
          update: async (fields) => { value = { ...value, ...fields } },
          replace: async () => { value = {} },
        }),
      },
    }
  }

  /**
   * The service set one lifecycle case runs against: the transport service is
   * `webServer` now, and `connection` is deliberately a bare `{}` — the plugin's
   * inject gate still names it, but nothing may read from it any more.
   */
  const makeServices = (settingsService) => ({
    webServer: makeWebServerStub(),
    connection: {},
    agents: { list: () => [], get: () => undefined },
    ...settingsService === undefined ? {} : { settings: settingsService },
  })

  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const liveIntervals = new Set()
  let createdIntervals = 0
  globalThis.setInterval = (fn, ms) => {
    const handle = realSetInterval(fn, ms)
    liveIntervals.add(handle)
    createdIntervals += 1
    return handle
  }
  globalThis.clearInterval = (handle) => {
    liveIntervals.delete(handle)
    return realClearInterval(handle)
  }
  try {
    // (a) settings present, idle auto-stop on: ONE assembly, no churn.
    {
      const settings = makeSettings({ idleEnabled: true, idleMinutes: 120 })
      const app = makeFiber({ services: makeServices(settings.service) })
      host.apply(app.ctx, { idleMinutes: 120 })
      await flush() // let the settings section attach
      if (createdIntervals !== 1) throw new Error(`apply must assemble exactly one monitor, created ${createdIntervals}`)
      if (liveIntervals.size !== 1) throw new Error(`expected one live interval, got ${liveIntervals.size}`)

      // Unload: the settings section's disposer runs FIRST (reverse order).
      const beforeUnload = createdIntervals
      await app.dispose()
      if (createdIntervals !== beforeUnload) {
        throw new Error(`unload created ${createdIntervals - beforeUnload} monitor(s); it must create none`)
      }
      if (liveIntervals.size !== 0) throw new Error(`unload left ${liveIntervals.size} interval(s) running`)
      console.log('lifecycle OK: one monitor per apply; an unload rebuilds nothing and leaks nothing')
    }

    // (b) settings disable idle auto-stop; when the PROVIDER detaches the
    //     plugin keeps running, so the entry config must take over again.
    {
      const settings = makeSettings({ idleEnabled: false, idleMinutes: 120 })
      const app = makeFiber({ services: makeServices(settings.service) })
      const before = createdIntervals
      host.apply(app.ctx, { idleMinutes: 120 })
      await flush()
      if (createdIntervals - before !== 1) {
        throw new Error(`the attached settings scope must not assemble a second monitor, created ${createdIntervals - before}`)
      }
      if (liveIntervals.size !== 0) throw new Error('the attached settings scope must stop the entry-config monitor')

      const settingsChild = app.ctx.children[0].ctx.children[0]
      if (settingsChild === undefined) throw new Error('settings child fiber missing')
      await settingsChild.dispose() // provider detach: the plugin is NOT unloading
      if (createdIntervals - before !== 2) {
        throw new Error(`provider detach must rebuild from the entry config, created ${createdIntervals - before}`)
      }
      if (liveIntervals.size !== 1) throw new Error(`fallback monitor must be live, got ${liveIntervals.size}`)

      const beforeUnload = createdIntervals
      await app.dispose()
      if (createdIntervals !== beforeUnload) throw new Error('plugin unload must not rebuild the fallback monitor')
      if (liveIntervals.size !== 0) throw new Error(`unload left ${liveIntervals.size} interval(s) running`)
      console.log('lifecycle OK: provider detach falls back to the entry config; a later unload stays silent')
    }

    // (c) settings DISABLE idle auto-stop while the entry config enables it:
    //     unloading must not resurrect the monitor. The settings section's
    //     disposer runs BEFORE the monitor-owning effect, so without the
    //     unload guard it would restore the entry source and rebuild here.
    {
      const settings = makeSettings({ idleEnabled: false, idleMinutes: 120 })
      const app = makeFiber({ services: makeServices(settings.service) })
      const before = createdIntervals
      host.apply(app.ctx, { idleMinutes: 120 })
      await flush()
      if (createdIntervals - before !== 1) throw new Error(`single assembly expected, created ${createdIntervals - before}`)
      if (liveIntervals.size !== 0) throw new Error('the attached settings scope must have stopped the entry-config monitor')
      const beforeUnload = createdIntervals
      await app.dispose()
      if (createdIntervals !== beforeUnload) {
        throw new Error(`unload created ${createdIntervals - beforeUnload} monitor(s); it must create none`)
      }
      if (liveIntervals.size !== 0) throw new Error(`unload left ${liveIntervals.size} interval(s) running`)
      console.log('lifecycle OK: an unload never resurrects the monitor the settings layer disabled')
    }
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    for (const handle of liveIntervals) realClearInterval(handle)
  }

  // (c) the restart watchdog is armed once and released by the unload. The
  //     restart script is a TEMP stub that exits 0: it stands in for a script
  //     whose process never brings the service back (the lock must still be
  //     released by the watchdog, and the timer must not outlive the plugin).
  {
    const stubScript = join(harnessTmpDir, 'restart-stub.ps1')
    writeFileSync(stubScript, [
      '# verify-harness stub for restart-dsh.ps1: exits without restarting anything',
      'param([switch]$OpenBrowser)',
      'exit 0',
      '',
    ].join('\n'))
    const services = makeServices(makeSettings({ idleEnabled: true, idleMinutes: 120 }).service)
    const app = makeFiber({ services })
    host.apply(app.ctx, { script: stubScript })
    await flush()
    const web = services.webServer
    appRouteOf(web) // the transport of this case: one prefix route on webServer

    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const watchdogs = new Set()
    globalThis.setTimeout = (fn, delay, ...rest) => {
      const handle = realSetTimeout(fn, delay, ...rest)
      if (delay === 90_000) watchdogs.add(handle)
      return handle
    }
    globalThis.clearTimeout = (handle) => {
      watchdogs.delete(handle)
      return realClearTimeout(handle)
    }
    try {
      const first = await callApp(web, 'restart', {})
      if (!first.ok || first.value?.scheduled !== true) throw new Error(`restart must schedule: ${JSON.stringify(first)}`)
      if (watchdogs.size !== 1) throw new Error(`restart must arm exactly one watchdog, got ${watchdogs.size}`)
      const second = await callApp(web, 'restart', {})
      if (!second.ok || second.value?.already !== true) {
        throw new Error(`the lock must hold while the watchdog is pending: ${JSON.stringify(second)}`)
      }
      await app.dispose()
      if (watchdogs.size !== 0) throw new Error('unload must clear the pending restart watchdog')
      console.log('lifecycle OK: restart watchdog armed once and cleared by the unload')
    } finally {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      for (const handle of watchdogs) realClearTimeout(handle)
    }
  }
}

// --- client half: bundle + contract checks (DOM shim when jsdom is absent) ---
let dom = null
let handoff = null
const bundleSource = readFileSync(clientPath, 'utf8')

// Theme-token audit: an undefined `var(--dsw-alias-…)` silently drops the
// declaration, so every alias the bundle styles with must exist in the shipped
// theme. Skipped (with a notice) when the theme bundle cannot be read.
{
  const used = [...new Set(bundleSource.match(/--dsw-alias-[a-z0-9-]+/g) ?? [])].sort()
  const themeCandidates = [
    join(userProfile, 'AppData', 'Local', 'npm-cache', '_npx', '1e7f6d9597241db0', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'),
  ]
  try {
    themeCandidates.push(join(dirname(uiRequire.resolve('@deepseek-ai/dsh-client-ui-theme/package.json')), 'lib', 'client.js'))
  } catch { /* theme package not resolvable from the profile */ }
  const themePath = themeCandidates.find((candidate) => existsSync(candidate))
  if (themePath === undefined) {
    console.log(`client CSS OK: ${used.length} --dsw-alias-* tokens used (theme bundle not found, definition check skipped)`)
  } else {
    const defined = new Set(readFileSync(themePath, 'utf8').match(/--dsw-alias-[a-z0-9-]+(?=\s*:)/g) ?? [])
    const missing = used.filter((name) => !defined.has(name))
    if (missing.length > 0) throw new Error(`client CSS uses undefined theme tokens: ${missing.join(', ')}`)
    console.log(`client CSS OK: all ${used.length} --dsw-alias-* tokens are defined by the theme (${defined.size} aliases)`)
  }
}

if (DOM_AVAILABLE) {
  dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3080/',
  })
  globalThis.window = dom.window
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (!(key in globalThis)) globalThis[key] = dom.window[key]
  }
  dom.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
  const evaluate = new Function('window', 'document', bundleSource)
  evaluate(dom.window, dom.window.document)
} else {
  // Minimal DOM shim: the bundle's CSS IIFE guards on `document` and the
  // module table only needs `__ModuleLoader__.load` to register the factory.
  const shimDocument = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, setAttribute: () => {}, appendChild: () => {} }),
    head: { appendChild: () => {} },
  }
  const shimWindow = { __ModuleLoader__: { load: (h) => { handoff = h } } }
  const evaluate = new Function('window', 'document', bundleSource)
  evaluate(shimWindow, shimDocument)
}
if (handoff === null) throw new Error('bundle never called __ModuleLoader__.load')
if (handoff.id !== PLUGIN_ID) throw new Error(`handoff id mismatch: ${handoff.id}`)

const icon = (props) => React.createElement('svg', { ...props, 'data-icon': true })
// Minimal Modal stub matching the primitives contract used by the section:
// open -> overlay with title/description/footer; closed -> null. The real
// Modal portals to document.body; the stub renders in place — both forms
// expose role="dialog" and data-modal-title for the tests to query.
const ModalStub = (props) => {
  if (!props.open) return null
  return React.createElement('div', { role: 'dialog', 'data-modal-title': props.title, className: 'so-modal' },
    React.createElement('p', null, props.description),
    props.footer,
  )
}
const requireTable = (spec) => {
  if (spec === 'react') return uiRequire('react')
  if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return { IconChevronDownOutline14: icon, Modal: ModalStub }
  }
  throw new Error(`unexpected module-table word: ${spec}`)
}
const exports_ = handoff.factory(requireTable)

// --- registration contract ----------------------------------------------------
if (typeof exports_.apply !== 'function') throw new Error('exports.apply missing')
if (!Array.isArray(exports_.inject)) throw new Error('exports.inject missing')
if (exports_.NS !== 'settings.other') throw new Error(`NS mismatch: ${exports_.NS}`)
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

let registrations = []
let dicts = []
let rpcLog = []
let restartResult = { ok: true, value: { scheduled: true, delayMs: 2600 } }
let cardValue = { idleEnabled: true, idleMinutes: 45 }
let statusValue = {
  running: 0,
  sessions: [],
  service: {
    pid: 4242,
    startedAt: '2026-01-01T00:00:00.000Z',
    uptime: 3661,
    rss: 536870912,
    node: 'v22.0.0',
    execPath: 'C:/node.exe',
    version: '0.1.0-rc.6',
    ports: [3080],
  },
  idle: { enabled: true, idleMinutes: 120, lastBusyAt: Date.now() - 60_000 },
}
const clientCtx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dict) => { dicts.push({ ns, dict }) },
    bind: () => (key) => 't:' + key,
  },
  // The bundle still DECLARES `connection` in its inject list (the loader's
  // contract), but it must not read anything off it any more: this double is
  // empty, so a surviving `ctx.connection.rpc.call(...)` would throw here.
  connection: {},
  slots: {
    inject: (_key, callback) => { registrations.push(callback()) },
    register: (options, component) => ({ ...options, component }),
  },
}

// --- browser transport double -------------------------------------------------
// The deployed bundle talks to the host over `fetch('/app/<endpoint>', …)` now
// (the /app prefix route on webServer), NOT through `ctx.connection.rpc.call`.
// Every call is logged as { url, method, headers, body } — the exact contract
// the host route's fence enforces — and answered with a Response double.
// `rpcFailure` forces the HTTP-failure branch (non-2xx).
let rpcFailure = null
const envelopeFor = (endpoint, args) => {
  if (endpoint === 'status') return { ok: true, value: statusValue }
  if (endpoint === 'restart') return restartResult
  if (endpoint === 'installShortcut') return { ok: true, value: { created: true, icon: 'C:/icon.ico', output: 'created C:\\Users\\x\\Desktop\\dsh-web.lnk' } }
  if (endpoint === 'getSettings') return { ok: true, value: cardValue }
  if (endpoint === 'setSettings') {
    cardValue = { ...cardValue, ...args.fields }
    return { ok: true, value: cardValue }
  }
  if (endpoint === 'resetSettings') {
    cardValue = { idleEnabled: true, idleMinutes: 120 }
    return { ok: true, value: cardValue }
  }
  return { ok: false, error: { code: 'bad-request', message: 'unexpected', details: {} } }
}
globalThis.fetch = async (url, init = {}) => {
  const href = String(url)
  rpcLog.push({ url: href, method: init.method, headers: init.headers ?? {}, body: init.body })
  if (rpcFailure !== null) return { ok: false, status: rpcFailure, json: async () => ({}) }
  if (!href.startsWith(`${APP_PATH}/`)) throw new TypeError(`client must call ${APP_PATH}/<endpoint>, got ${href}`)
  const endpoint = href.slice(APP_PATH.length + 1)
  // Parsing here enforces the body shape the host's fence requires; a malformed
  // body would reject the call exactly like a real 400 would.
  const parsed = init.body === undefined ? {} : JSON.parse(init.body)
  return { ok: true, status: 200, json: async () => envelopeFor(endpoint, parsed.args ?? {}) }
}

/**
 * One logged client call must be exactly what the host route accepts:
 * POST /app/<endpoint>, content-type application/json, and a body that parses
 * to `{ args: {...} }`.
 */
const assertClientCall = (call, endpoint, args, label = endpoint) => {
  const where = `${label}: expected POST ${APP_PATH}/${endpoint}`
  if (call === undefined) {
    throw new Error(`${where} — log: ${JSON.stringify(rpcLog.map((c) => `${c.method} ${c.url}`))}`)
  }
  if (call.url !== `${APP_PATH}/${endpoint}`) throw new Error(`${where}, got ${call.url}`)
  if (call.method !== 'POST') throw new Error(`${where}, method ${JSON.stringify(call.method)}`)
  if (String(call.headers?.['content-type'] ?? '').toLowerCase() !== 'application/json') {
    throw new Error(`${where}, headers ${JSON.stringify(call.headers)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(call.body)
  } catch {
    throw new Error(`${where}, body is not JSON: ${JSON.stringify(call.body)}`)
  }
  if (JSON.stringify(Object.keys(parsed)) !== '["args"]') {
    throw new Error(`${where}, body keys ${JSON.stringify(Object.keys(parsed))}`)
  }
  if (JSON.stringify(parsed.args) !== JSON.stringify(args)) {
    throw new Error(`${where} with args ${JSON.stringify(args)}, got ${JSON.stringify(parsed.args)}`)
  }
  return parsed
}
exports_.apply(clientCtx)

const sectionReg = registrations.find((r) => r.name === 'settings.section')
const cardReg = registrations.find((r) => r.name === 'settings.plugin.item')
if (sectionReg === undefined) throw new Error('settings.section never registered')
if (sectionReg.id !== 'other' || sectionReg.order !== 30) {
  throw new Error(`section options mismatch: ${JSON.stringify(sectionReg)}`)
}
// The section's whole inject surface, asserted EXACTLY: the deleted
// `reloadPlugins` (重载用户插件) and `stopService` (中断服务) entries must stay
// gone, and no new key may slip in unnoticed.
const SECTION_INJECT_KEYS = ['installShortcut', 'restart', 'status']
const sectionInjected = sectionReg.inject()
const sectionInjectKeys = Object.keys(sectionInjected).sort()
if (JSON.stringify(sectionInjectKeys) !== JSON.stringify(SECTION_INJECT_KEYS)) {
  throw new Error(`section inject surface must be exactly ${JSON.stringify(SECTION_INJECT_KEYS)}, got ${JSON.stringify(sectionInjectKeys)}`)
}
for (const key of SECTION_INJECT_KEYS) {
  if (typeof sectionInjected[key] !== 'function') throw new Error(`section inject must expose ${key} as a function`)
}
if (cardReg === undefined) throw new Error('settings.plugin.item never registered')
if (cardReg.key !== 'ui-settings-other' || cardReg.locale !== 'settings.other.card') {
  throw new Error(`card options mismatch: ${JSON.stringify(cardReg)}`)
}
const sectionDict = dicts.find((d) => d.ns === 'settings.other')
const cardDict = dicts.find((d) => d.ns === 'settings.other.card')
if (sectionDict === undefined || cardDict === undefined) throw new Error('dictionaries not registered')
const zhKeys = Object.keys(sectionDict.dict.zh)
const enKeys = Object.keys(sectionDict.dict.en)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  throw new Error(`zh/en key mismatch (section):\nzh: ${zhKeys}\nen: ${enKeys}`)
}
const zhCardKeys = Object.keys(cardDict.dict.zh)
const enCardKeys = Object.keys(cardDict.dict.en)
if (JSON.stringify(zhCardKeys) !== JSON.stringify(enCardKeys)) {
  throw new Error(`zh/en key mismatch (card):\nzh: ${zhCardKeys}\nen: ${enCardKeys}`)
}
console.log(`apply contract OK: section id=other order=30 | card key=ui-settings-other | dict keys = ${zhKeys.length} + ${zhCardKeys.length}`)

if (!DOM_AVAILABLE) {
  console.log('\nclient DOM sections SKIPPED (jsdom not installed)')
  console.log('ALL NON-DOM HARNESS CHECKS PASSED (install jsdom to enable the DOM sections)')
  process.exit(0)
}

// --- render + interact (react-dom in jsdom) ------------------------------------
const { act } = React
const { createRoot } = uiRequire('react-dom/client')

const fireClick = (el) => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) }
const fireChange = (el, value) => {
  const proto = el.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const en = sectionDict.dict.en
const clientInjected = sectionReg.inject('session-1')
const tWithParams = (key, params) => {
  const value = en[key]
  return params && params.n !== undefined ? value.replace('{n}', String(params.n)) : value
}

const root = createRoot(dom.window.document.getElementById('root'))
await act(async () => {
  root.render(React.createElement(sectionReg.component, {
    restart: clientInjected.restart,
    status: clientInjected.status,
    installShortcut: clientInjected.installShortcut,
    t: tWithParams,
  }))
})

const doc = dom.window.document
const buttons = () => [...doc.querySelectorAll('.so-btn')]
const buttonTexts = () => buttons().map((b) => b.textContent)
// The current flow's status line is the LAST .so-flow-status in DOM order
// (the shortcut success line from an earlier flow stays mounted).
const flowLine = () => {
  const lines = [...doc.querySelectorAll('.so-flow-status')]
  return lines.length > 0 ? lines[lines.length - 1] : null
}

// runtime snapshot block renders from the first /app/status poll
const infoRows = () => [...doc.querySelectorAll('.so-info-row')]
if (infoRows().length !== 8) throw new Error(`expected 8 info rows, got ${infoRows().length}`)
const infoText = doc.querySelector('.so-info').textContent
if (!infoText.includes('4242')) throw new Error(`pid missing: ${infoText}`)
if (!infoText.includes('3080')) throw new Error(`ports missing: ${infoText}`)
if (!infoText.includes('v22.0.0')) throw new Error(`node missing: ${infoText}`)
if (!infoText.includes('0.1.0-rc.6')) throw new Error(`dsh version missing: ${infoText}`)
const refreshButton = buttons().find((b) => b.textContent === en.refresh)
if (refreshButton === undefined) throw new Error('refresh button missing')
const shortcutButton = buttons().find((b) => b.textContent === en.createShortcut)
if (shortcutButton === undefined) throw new Error('create-shortcut button missing')
const restartButton = buttons().find((b) => b.textContent === en.restart)
if (restartButton === undefined) throw new Error('restart button missing')
// Exactly the three surviving controls: 「刷新」 + 创建桌面快捷方式 + 重启服务.
if (buttons().length !== 3) {
  throw new Error(`expected 3 buttons (${en.refresh} + ${en.createShortcut} + ${en.restart}), got ${buttons().length}: ${JSON.stringify(buttonTexts())}`)
}
if (doc.querySelector('.so-danger-note') === null) throw new Error('danger note missing')
// The mount poll went out over the /app prefix route as one fenced JSON POST —
// no `ctx.connection.rpc`, no /api channel.
assertClientCall(rpcLog[rpcLog.length - 1], 'status', {}, 'mount poll')
rpcLog = [] // the mount already polled status once; reset before interaction
console.log(`status block OK: 8 rows render pid/ports/versions; buttons = ${JSON.stringify(buttonTexts())}`)

// refresh button re-polls /app/status
await act(async () => { fireClick(refreshButton) })
assertClientCall(rpcLog.find((c) => c.url === `${APP_PATH}/status`), 'status', {}, 'refresh')
rpcLog = []
console.log('status block OK: refresh re-polls /app/status')

// create-shortcut flow: calls /app/installShortcut and shows the result line
await act(async () => { fireClick(shortcutButton) })
assertClientCall(rpcLog.find((c) => c.url === `${APP_PATH}/installShortcut`), 'installShortcut', {}, 'create shortcut')
await act(async () => {})
const shortcutDone = [...doc.querySelectorAll('.so-flow-status')].find((el) => el.textContent.includes(en.shortcutCreated))
if (shortcutDone === null) throw new Error('shortcut created status missing')
console.log('shortcut flow OK: POST /app/installShortcut + created status')
rpcLog = []

// click -> confirm modal opens (no call yet)
const dialog = () => doc.querySelector('[role="dialog"]')
await act(async () => { fireClick(restartButton) })
if (rpcLog.length !== 0) throw new Error('confirm state must not call the host yet')
const confirmDialog = dialog()
if (confirmDialog === null) throw new Error('restart confirm modal missing')
if (confirmDialog.getAttribute('data-modal-title') !== en.restart) throw new Error('restart modal title mismatch')
if (!confirmDialog.textContent.includes(en.confirmPrompt)) throw new Error('confirm prompt missing in modal')
const confirmButton = buttons().find((b) => b.textContent === en.confirm)
if (confirmButton === undefined) throw new Error('confirm button missing')
console.log('confirm modal OK (restart)')

// cancel (in modal) returns to idle
await act(async () => { fireClick(buttons().find((b) => b.textContent === en.cancel)) })
if (dialog() !== null) throw new Error('cancel must close the modal')
if (buttons().length !== 3) {
  throw new Error(`cancel should restore the ${en.refresh} + ${en.createShortcut} + ${en.restart} buttons, got ${JSON.stringify(buttonTexts())}`)
}
console.log('cancel OK')

// confirm -> calling -> scheduled; host endpoint + request shape
await act(async () => { fireClick(buttons().find((b) => b.textContent === en.restart)) })
await act(async () => { fireClick(buttons().find((b) => b.textContent === en.confirm)) })
assertClientCall(rpcLog.find((c) => c.url === `${APP_PATH}/restart`), 'restart', {}, 'restart confirm')
if (flowLine() === null || flowLine().textContent !== en.scheduled) throw new Error('scheduled status missing')
console.log('restart flow OK: POST /app/restart (args {}) + scheduled status')

// busy flow: sessions running -> busy view -> force restart passes force: true
const busyHost = dom.window.document.createElement('div')
const busyRoot = createRoot(busyHost)
restartResult = { ok: false, error: { code: 'sessions-running', message: 'x', details: { running: 2, sessions: ['a', 'b'] } } }
statusValue = { running: 2, sessions: ['a', 'b'] }
rpcLog = []
await act(async () => {
  busyRoot.render(React.createElement(sectionReg.component, {
    restart: clientInjected.restart,
    status: clientInjected.status,
    installShortcut: clientInjected.installShortcut,
    t: tWithParams,
  }))
})
await act(async () => { fireClick([...busyHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.restart)) })
await act(async () => { fireClick([...busyHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.confirm)) })
const busyLine = busyHost.querySelector('.so-flow-status[data-tone="error"]')
if (busyLine === null || busyLine.textContent !== en.busy.replace('{n}', '2')) {
  throw new Error(`busy line: ${busyLine?.textContent}`)
}
const forceButton = [...busyHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.busyActionForce)
if (forceButton === undefined) throw new Error('force button missing')
const waitButton = [...busyHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.busyActionWait)
if (waitButton === undefined) throw new Error('wait button missing')
rpcLog = []
await act(async () => { fireClick(forceButton) })
assertClientCall(rpcLog.find((c) => c.url === `${APP_PATH}/restart`), 'restart', { force: true }, 'force restart')
console.log('busy flow OK: refused -> busy view -> force restart sends force:true')

// wait flow: poll /app/status until idle, then auto-restart
const waitHost = dom.window.document.createElement('div')
const waitRoot = createRoot(waitHost)
restartResult = { ok: false, error: { code: 'sessions-running', message: 'x', details: { running: 1, sessions: ['a'] } } }
statusValue = { running: 1, sessions: ['a'] }
rpcLog = []
await act(async () => {
  waitRoot.render(React.createElement(sectionReg.component, {
    restart: clientInjected.restart,
    status: clientInjected.status,
    installShortcut: clientInjected.installShortcut,
    t: tWithParams,
  }))
})
await act(async () => { fireClick([...waitHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.restart)) })
await act(async () => { fireClick([...waitHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.confirm)) })
await act(async () => { fireClick([...waitHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.busyActionWait)) })
// first status poll fires after the 2s interval. The sleep runs INSIDE act so
// the interval-driven state update is flushed in the same scope (otherwise
// React logs "not wrapped in act" for a poll this flow depends on).
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)) })
const waitingLine = waitHost.querySelector('.so-flow-status')
if (waitingLine === null || waitingLine.textContent !== en.waiting.replace('{n}', '1')) {
  throw new Error(`waiting line: ${waitingLine?.textContent}`)
}
if (!rpcLog.some((c) => c.url === `${APP_PATH}/status`)) throw new Error('wait flow must poll /app/status')
// sessions finish -> next poll triggers the auto restart (interval is 2s)
statusValue = { running: 0, sessions: [] }
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)) })
assertClientCall(rpcLog.find((c) => c.url === `${APP_PATH}/restart`), 'restart', {}, 'wait-flow auto restart')
console.log('wait flow OK: polls status and auto-restarts when idle')

// error state: host failure surfaces as error copy
const errorHost = dom.window.document.createElement('div')
const root2 = createRoot(errorHost)
await act(async () => {
  root2.render(React.createElement(sectionReg.component, {
    restart: async () => { throw new Error('private detail') },
    status: clientInjected.status,
    installShortcut: clientInjected.installShortcut,
    t: tWithParams,
  }))
})
await act(async () => { fireClick([...errorHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.restart)) })
await act(async () => { fireClick([...errorHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.confirm)) })
if (errorHost.querySelector('.so-flow-status[data-tone="error"]') === null) throw new Error('error status missing')
if (errorHost.textContent.includes('private detail')) throw new Error('error state leaked transport detail')
console.log('error state OK')

// transport failure: the host answering a non-2xx status must land on the same
// generic error copy (the `!response.ok` branch), never on a raw transport dump.
{
  const httpHost = dom.window.document.createElement('div')
  const httpRoot = createRoot(httpHost)
  rpcFailure = 500
  try {
    await act(async () => {
      httpRoot.render(React.createElement(sectionReg.component, {
        restart: clientInjected.restart,
        status: clientInjected.status,
        installShortcut: clientInjected.installShortcut,
        t: tWithParams,
      }))
    })
    await act(async () => { fireClick([...httpHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.restart)) })
    await act(async () => { fireClick([...httpHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.confirm)) })
    const failedLine = httpHost.querySelector('.so-flow-status[data-tone="error"]')
    if (failedLine === null || failedLine.textContent !== en.error) {
      throw new Error(`an HTTP failure must show the error copy, got: ${failedLine?.textContent}`)
    }
    if (/500|HTTP/.test(httpHost.textContent)) throw new Error('the error state must not leak the HTTP status')
  } finally {
    rpcFailure = null
  }
  console.log('error state OK: a non-2xx answer from the route shows the error copy')
}

// --- configuration card (设置 → 插件 → 插件配置) --------------------------------
// The deployed card talks to the host through the /app prefix route
// (getSettings/setSettings/resetSettings), NOT through a client settings scope.
const enCard = cardDict.dict.en
const tCardWithParams = (key, params) => {
  const value = enCard[key]
  return params && params.n !== undefined ? value.replace('{n}', String(params.n)) : value
}
const cardHost = dom.window.document.createElement('div')
const cardRoot = createRoot(cardHost)
rpcLog = []
await act(async () => {
  cardRoot.render(React.createElement(cardReg.component, {
    t: tCardWithParams,
    ...cardReg.inject(),
  }))
})
assertClientCall(rpcLog.find((c) => c.url === `${APP_PATH}/getSettings`), 'getSettings', {}, 'card load')

const header = cardHost.querySelector('.soc-header')
if (header === null) throw new Error('card header missing')
await act(async () => { fireClick(header) })
const inputs = [...cardHost.querySelectorAll('.soc-input')]
if (inputs.length !== 1) throw new Error(`expected 1 number input, got ${inputs.length}`)
const toggles = [...cardHost.querySelectorAll('.soc-toggle')]
if (toggles.length !== 1) throw new Error(`expected 1 toggle, got ${toggles.length}`)
const minutesInput = cardHost.querySelector('#soc-idleMinutes')
if (minutesInput === null || minutesInput.value !== '45') throw new Error(`override value: ${minutesInput?.value}`)

// staged edit -> save writes the field through /app/setSettings
rpcLog = []
await act(async () => { fireChange(minutesInput, '60') })
if (!cardHost.querySelector('.soc-pending')) throw new Error('unsaved badge missing')
const saveButton = cardHost.querySelector('.soc-save')
if (saveButton === null || saveButton.disabled) throw new Error('save must be enabled with staged edits')
await act(async () => { fireClick(saveButton) })
assertClientCall(
  rpcLog.find((c) => c.url === `${APP_PATH}/setSettings`),
  'setSettings',
  { fields: { idleMinutes: 60 } },
  'card save',
)
if (cardValue.idleMinutes !== 60) throw new Error(`card must adopt the host response: ${JSON.stringify(cardValue)}`)
console.log('card OK: fields render, staged edit saves through POST /app/setSettings')

// toggle staged edit -> save writes the boolean
await act(async () => { fireClick(cardHost.querySelector('#soc-idleEnabled')) })
await act(async () => { fireClick(cardHost.querySelector('.soc-save')) })
assertClientCall(
  rpcLog.filter((c) => c.url === `${APP_PATH}/setSettings`).pop(),
  'setSettings',
  { fields: { idleEnabled: false } },
  'card toggle',
)
console.log('card OK: toggle saves through POST /app/setSettings')

// reset-all restores defaults through /app/resetSettings (second .soc-discard)
await act(async () => { fireClick(cardHost.querySelectorAll('.soc-discard')[1]) })
assertClientCall(
  rpcLog.find((c) => c.url === `${APP_PATH}/resetSettings`),
  'resetSettings',
  {},
  'card reset-all',
)
if (cardValue.idleMinutes !== 120) throw new Error(`reset must adopt the host response: ${JSON.stringify(cardValue)}`)
console.log('card OK: reset-all calls POST /app/resetSettings')

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
