/**
 * Functional harness for the user-level temp-session patch.
 *
 * Host half: imports the real `lib/index.js`, applies it to a mock Cordis
 * context, and asserts the `/temp-session` RPC channel registration plus the
 * `ensure` endpoint: idempotent workspace creation over a real temp directory
 * (first call creates, second call reuses the same id), bad endpoint
 * rejection, and error wrapping. Also guards the P0 regression: `apply` must
 * NOT return a thenable (Cordis treats a returned Fiber as an invalid Effect).
 * Regression guards for the reviewed defects: the channel effect is the
 * rpc.handle disposer (unload unregisters `/temp-session`), the `args` guard
 * rejects `null`/arrays/scalars, and the serial ensure chain is per instance
 * (`createEnsureQueue()`) — ordered, rejection-safe, instance-independent, and
 * applied to overlapping endpoint calls.
 *
 * Client half: loads the exact deployed `lib/client.js` the browser will
 * execute, feeds it a module table stubbed with the real platform words
 * (react, react/jsx-runtime, ui-primitives), asserts the registration
 * contract (sidebar.footer.action entry + dictionaries + inject face) plus the
 * CSS contract (one `data-plugin` / `data-plugin-css` tag, reused when the
 * bundle body runs again) and that the removed `ctx.locale.bind(NS)` dead call
 * stays removed, then — when jsdom is available — renders the action and
 * exercises the click flow (RPC ensure -> uiWorkspace.startSession) and the
 * error path. Without jsdom the DOM sections are skipped with a notice.
 */
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, existsSync } from 'node:fs'
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
const PLUGIN_ID = '@local/dsh-client-ui-temp-session'

// --- host half: registration + ensure endpoint --------------------------------
const host = await import(pathToFileURL(hostPath).href)

// ensureTempWorkspace over a real temp dir with a stub registry
{
  const tempRoot = mkdtempSync(join(tmpdir(), 'temp-session-verify-'))
  const dir = join(tempRoot, 'tmp-workspaces')
  const workspaces = []
  const fakeRegistry = {
    resolveByPath: async (path) => workspaces.find((w) => w.path === path),
    create: async (path, title) => {
      const id = 'ws-' + (workspaces.length + 1)
      const ws = { id, path, title }
      workspaces.push(ws)
      return ws
    },
  }
  const first = await host.ensureTempWorkspace({ workspaceRegistry: fakeRegistry }, { dir, title: '临时会话' })
  if (first.created !== true) throw new Error(`first ensure must create: ${JSON.stringify(first)}`)
  if (first.path !== dir || first.title !== '临时会话' || !/^ws-\d+$/.test(first.workspaceId)) {
    throw new Error(`first ensure shape: ${JSON.stringify(first)}`)
  }
  if (!existsSync(dir)) throw new Error(`ensure must mkdir ${dir}`)
  const second = await host.ensureTempWorkspace({ workspaceRegistry: fakeRegistry }, { dir, title: '临时会话' })
  if (second.created !== false || second.workspaceId !== first.workspaceId) {
    throw new Error(`second ensure must reuse: ${JSON.stringify(second)}`)
  }
  const custom = await host.ensureTempWorkspace(
    { workspaceRegistry: fakeRegistry },
    { dir: join(tempRoot, 'other'), title: 'Scratch' },
  )
  if (custom.created !== true || custom.title !== 'Scratch') throw new Error(`custom dir: ${JSON.stringify(custom)}`)
  console.log('host ensure OK: idempotent create/reuse over real temp dirs + config title')
}

// --- host request/response doubles -------------------------------------------
/** `webServer` service double: records every register() as { kind, path, handler }. */
function makeWebServerStub() {
  const routes = []
  return {
    routes,
    unregistered: [],
    register: (route) => {
      const entry = { kind: route.kind, path: route.path, handler: route.handler }
      routes.push(entry)
      return () => {
        const at = routes.indexOf(entry)
        if (at >= 0) routes.splice(at, 1)
        return undefined
      }
    },
  }
}

/** Fake server request: a real header bag plus an async `data`/`end` stream. */
function makeReq({ method = 'POST', url = '/temp-session/ensure', headers = {} } = {}) {
  const listeners = { data: [], end: [], error: [] }
  let destroyed = false
  return {
    method,
    url,
    headers,
    get destroyed() { return destroyed },
    on(event, listener) { (listeners[event] ??= []).push(listener); return this },
    destroy() {
      destroyed = true
      for (const listener of listeners.error) listener(new Error('aborted'))
    },
    /** Deliver `text` as one chunk, then end the request. */
    send(text) {
      if (destroyed) return
      for (const listener of listeners.data) listener(text)
      for (const listener of listeners.end) listener()
    },
  }
}

/** Fake server response: captures status, headers and the body it ended with. */
function makeRes() {
  return {
    status: null,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      for (const [name, value] of Object.entries(headers ?? {})) this.headers[name.toLowerCase()] = value
      return this
    },
    end(chunk) { this.body = String(chunk ?? ''); this.writableEnded = true; return this },
  }
}

/** Drive one registered route exactly like the web carrier does. */
async function callRoute(route, { method = 'POST', url = '/temp-session/ensure', headers = {}, body = '{}' } = {}) {
  const res = makeRes()
  const req = makeReq({ method, url, headers })
  route.handler(req, res)
  req.send(body)
  // The endpoint handler is async and touches the real filesystem, so the
  // response arrives after arbitrary event-loop turns: poll instead of
  // assuming one macrotask is enough.
  const deadline = Date.now() + 5000
  while (!res.writableEnded && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  let envelope = null
  try { envelope = JSON.parse(res.body) } catch { envelope = null }
  return { status: res.status, headers: res.headers, body: res.body, envelope }
}

const FENCE_HEADERS = { host: '127.0.0.1:3080', 'content-type': 'application/json' }
const ROUTE_PATH = '/temp-session'

// apply: prefix route + endpoint validation (no real workspace registry needed)
let injectedServices = null
let routeEffectDisposer = null
let hostWarns = []
const hostWebServer = makeWebServerStub()
const hostCtx = {
  get: (name) => (name === 'webServer' ? hostWebServer : undefined),
  logger: { info: () => {}, warn: (message) => { hostWarns.push(String(message)) } },
  inject: (services, callback) => {
    injectedServices = services
    // The carrier is DECLARED first: Cordis runs this callback only once
    // `webServer` is bound, so activation waits for the carrier instead of
    // racing it with an optional read.
    if (services.join(',') === 'webServer,workspaceRegistry') {
      callback({
        workspaceRegistry: {
          resolveByPath: async (path) => undefined,
          create: async (path, title) => ({ id: 'ws-rpc', path, title }),
        },
        get: hostCtx.get,
        logger: hostCtx.logger,
        effect: (fn, label) => {
          // Cordis returns a Disposable from `ctx.effect()`; mirror that shape.
          const dispose = fn()
          routeEffectDisposer = { label, dispose }
          return { dispose }
        },
        fiber: { state: 0 },
      })
      return { then: () => {} }
    }
    return undefined
  },
  effect: (fn) => fn(),
}
const ret = host.apply(hostCtx, { dir: join(tmpdir(), 'temp-session-verify-apply'), title: '临时会话' })

// P0 regression guard: returning the ctx.inject() thenable Fiber from apply
// makes Cordis throw TypeError('Invalid effect') and fail the plugin.
if (ret !== undefined && typeof ret.then === 'function') {
  throw new Error('P0 regression: apply returned a thenable (Invalid effect)')
}
if (injectedServices === null || injectedServices.join(',') !== 'webServer,workspaceRegistry') {
  throw new Error(`host inject mismatch (webServer must be DECLARED, not ctx.get-raced): ${JSON.stringify(injectedServices)}`)
}
const tempRoute = hostWebServer.routes.find((route) => route.path === ROUTE_PATH)
if (tempRoute === undefined) {
  throw new Error(`${ROUTE_PATH} never registered (routes: ${JSON.stringify(hostWebServer.routes.map((r) => r.path))})`)
}
if (tempRoute.kind !== 'prefix') throw new Error(`${ROUTE_PATH} must be kind 'prefix', got '${tempRoute.kind}'`)
// Lifecycle guard: the route registration must be an effect on the child fiber,
// so a reload/unload unregisters it instead of leaving a stale handler behind
// (the old shape dropped the rpc.handle() disposer; this one must not).
if (routeEffectDisposer === null || typeof routeEffectDisposer.dispose !== 'function') {
  throw new Error('lifecycle: the /temp-session route must be registered through ctx.effect()')
}
if (routeEffectDisposer.label !== 'temp-session: /temp-session rpc route') {
  throw new Error(`lifecycle: the route effect must be labelled, got ${JSON.stringify(routeEffectDisposer.label)}`)
}
console.log('lifecycle OK: ctx.effect on the child fiber registers the route (disposer owned by the plugin)')

// The fence, driven through the real handler: cross-origin POSTs are refused,
// non-POST verbs are refused, and only application/json is accepted.
{
  const crossOrigin = await callRoute(tempRoute, {
    headers: { ...FENCE_HEADERS, origin: 'https://evil.example' },
  })
  if (crossOrigin.status !== 403 || crossOrigin.envelope?.error?.code !== 'forbidden') {
    throw new Error(`cross-origin request must be refused with 403: ${JSON.stringify(crossOrigin)}`)
  }
  const sameOrigin = await callRoute(tempRoute, {
    headers: { ...FENCE_HEADERS, origin: 'http://127.0.0.1:3080' },
  })
  if (sameOrigin.status !== 200) throw new Error(`same-origin POST must pass the fence: ${JSON.stringify(sameOrigin)}`)

  const get = await callRoute(tempRoute, { method: 'GET', headers: FENCE_HEADERS })
  if (get.status !== 405 || get.envelope?.error?.code !== 'method-not-allowed') {
    throw new Error(`non-POST must answer 405: ${JSON.stringify(get)}`)
  }

  const wrongType = await callRoute(tempRoute, { headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain' } })
  if (wrongType.status !== 415 || wrongType.envelope?.error?.code !== 'unsupported-media-type') {
    throw new Error(`non-JSON content-type must answer 415: ${JSON.stringify(wrongType)}`)
  }

  const root = await callRoute(tempRoute, { url: ROUTE_PATH, headers: FENCE_HEADERS })
  if (root.status !== 404 || root.envelope?.error?.code !== 'unknown-endpoint') {
    throw new Error(`the bare prefix must answer 404: ${JSON.stringify(root)}`)
  }
  const deep = await callRoute(tempRoute, { url: `${ROUTE_PATH}/a/b`, headers: FENCE_HEADERS })
  if (deep.status !== 404 || deep.envelope?.error?.code !== 'unknown-endpoint') {
    throw new Error(`a multi-segment endpoint must answer 404: ${JSON.stringify(deep)}`)
  }
  console.log('host fence OK: 403 cross-origin, 405 non-POST, 415 non-JSON, 404 bare/deep endpoint')
}

// Body handling: a malformed body is 400, an oversized one 413.
{
  const notJson = await callRoute(tempRoute, { headers: FENCE_HEADERS, body: 'not json' })
  if (notJson.status !== 400 || notJson.envelope?.error?.code !== 'bad-request') {
    throw new Error(`a non-JSON body must answer 400: ${JSON.stringify(notJson)}`)
  }
  const huge = await callRoute(tempRoute, {
    headers: FENCE_HEADERS,
    body: JSON.stringify({ args: { pad: 'x'.repeat((1 << 20) + 64) } }),
  })
  if (huge.status !== 413 || huge.envelope?.error?.code !== 'payload-too-large') {
    throw new Error(`an oversized body must answer 413: ${JSON.stringify({ status: huge.status })}`)
  }
  console.log('host body OK: 400 non-JSON, 413 oversized')
}

const okEnsure = (await callRoute(tempRoute, {
  headers: FENCE_HEADERS,
  body: JSON.stringify({ args: {} }),
})).envelope
if (!okEnsure.ok || okEnsure.value.workspaceId !== 'ws-rpc' || okEnsure.value.created !== true) {
  throw new Error(`ensure endpoint: ${JSON.stringify(okEnsure)}`)
}
const badEndpoint = (await callRoute(tempRoute, {
  url: `${ROUTE_PATH}/nope`,
  headers: FENCE_HEADERS,
  body: '{}',
})).envelope
if (badEndpoint.ok !== false || badEndpoint.error.code !== 'bad-request') {
  throw new Error(`unknown endpoint must be rejected: ${JSON.stringify(badEndpoint)}`)
}
// Args guard: only `undefined` (omitted) or a plain object may pass. `null`
// slips through `typeof === 'object'` and arrays are not arg objects.
for (const [label, body] of [
  ['null args', JSON.stringify({ args: null })],
  ['array args', JSON.stringify({ args: [] })],
  ['scalar args', JSON.stringify({ args: 'x' })],
]) {
  const rejected = (await callRoute(tempRoute, { headers: FENCE_HEADERS, body })).envelope
  if (rejected.ok !== false || rejected.error.code !== 'bad-request') {
    throw new Error(`${label} must be rejected as bad-request: ${JSON.stringify(rejected)}`)
  }
}
// An omitted `args` still parses (the empty body reaches the handler as `{}`).
const noArgs = (await callRoute(tempRoute, { headers: FENCE_HEADERS, body: '' })).envelope
if (!noArgs.ok) throw new Error(`omitted args must be accepted: ${JSON.stringify(noArgs)}`)
console.log(`host OK: prefix ${ROUTE_PATH} + ensure endpoint + bad-request/args guards`)
console.log('args guard OK: null / array / scalar rejected, omitted args accepted')

// Waiting semantics — this IS the fix. `webServer` is a DECLARED dependency
// now, so a host whose carrier is not up yet never runs the inject callback at
// all: the child fiber waits for the service instead of activating and
// silently skipping the page's whole transport (the pre-fix behaviour, which
// also reported a bogus "webServer is unavailable" warning from an up-front
// `ctx.get` probe run while the carrier was still binding).
{
  let injected = null
  let activate = null
  const store = []
  const lateWebServer = makeWebServerStub()
  host.apply({
    inject: (services, callback) => {
      injected = services
      // Deliberately NOT called: the carrier is still missing, which is exactly
      // what Cordis does while it waits for a declared service.
      activate = () => callback({
        workspaceRegistry: {
          resolveByPath: async (path) => store.find((w) => w.path === path),
          create: async (path, title) => {
            const workspace = { id: 'ws-late', path, title }
            store.push(workspace)
            return workspace
          },
        },
        get: (name) => (name === 'webServer' ? lateWebServer : undefined),
        logger: { info: () => {}, warn: () => {} },
        effect: (fn) => fn(),
      })
      return { then: () => {} }
    },
    logger: { info: () => {}, warn: () => {} },
  }, { dir: mkdtempSync(join(tmpdir(), 'temp-session-verify-late-')), title: '临时会话' })
  if (injected === null || injected.join(',') !== 'webServer,workspaceRegistry') {
    throw new Error(`the carrier must be a DECLARED dependency: ${JSON.stringify(injected)}`)
  }
  if (lateWebServer.routes.length !== 0) throw new Error('nothing may register while the carrier is still absent')
  activate()
  if (!lateWebServer.routes.some((route) => route.path === ROUTE_PATH)) {
    throw new Error(`once the carrier appears ${ROUTE_PATH} must register: ${JSON.stringify(lateWebServer.routes)}`)
  }
  // The eager startup ensure lives in the same callback, so it must run with it.
  const ensureDeadline = Date.now() + 2000
  while (store.length === 0 && Date.now() < ensureDeadline) await new Promise((resolve) => setTimeout(resolve, 5))
  if (store.length !== 1) throw new Error(`the startup ensure must run when the gate activates: ${store.length}`)
}
console.log('host waiting semantics OK: /temp-session waits for the declared webServer carrier (inject = webServer,workspaceRegistry)')

// The retained fallback branch of that declared read: a carrier that is
// declared yet somehow still absent warns once and skips the route instead of
// throwing — the workspace is still ensured on startup. Unreachable in real
// Cordis, still exercised here.
{
  const warns = []
  let registered = 0
  host.apply({
    get: () => undefined,
    logger: { info: () => {}, warn: (message) => { warns.push(String(message)) } },
    inject: (services, callback) => {
      callback({
        workspaceRegistry: {
          resolveByPath: async () => undefined,
          create: async (path, title) => ({ id: 'ws-degraded', path, title }),
        },
        get: () => undefined,
        logger: { info: () => {}, warn: (message) => { warns.push(String(message)) } },
        effect: () => { registered += 1; return () => {} },
      })
      return { then: () => {} }
    },
  }, { dir: mkdtempSync(join(tmpdir(), 'temp-session-verify-degraded-')), title: '临时会话' })
  if (registered !== 0) throw new Error('no webServer must register no route')
  if (warns.length !== 1 || !warns[0].includes('webServer is unavailable')) {
    throw new Error(`a still-absent carrier must log one warning: ${JSON.stringify(warns)}`)
  }
}
console.log('host fallback OK: a declared-yet-absent carrier -> one warning, no route, no throw')

// Lifecycle: disposing the route effect removes the route.
routeEffectDisposer.dispose()
if (hostWebServer.routes.some((route) => route.path === ROUTE_PATH)) {
  throw new Error('lifecycle: disposing the route effect must unregister /temp-session')
}

// Per-instance serial queue: the chain must NOT be module scope, otherwise a
// reloaded instance queues behind the previous instance's pending ensure.
if (typeof host.createEnsureQueue !== 'function') {
  throw new Error('createEnsureQueue export missing: the serial chain must be owned per instance')
}
{
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const order = []
  const queue = host.createEnsureQueue()
  const first = queue(async () => { order.push('a:start'); await wait(20); order.push('a:end'); return 'a' })
  const second = queue(async () => { order.push('b:start'); return 'b' })
  const [a, b] = await Promise.all([first, second])
  if (a !== 'a' || b !== 'b') throw new Error(`queue must resolve with the task value: ${a},${b}`)
  if (order.join(',') !== 'a:start,a:end,b:start') {
    throw new Error(`queue must run one task at a time in order: ${order.join(',')}`)
  }

  // A failing task must not poison the chain behind it.
  const failing = host.createEnsureQueue()
  const failure = await failing(async () => { throw new Error('boom') }).then(() => 'no-throw', (e) => e.message)
  if (failure !== 'boom') throw new Error(`queue must propagate the task failure: ${failure}`)
  if (await failing(async () => 'recovered') !== 'recovered') throw new Error('queue must stay usable after a failure')

  // Two instances own independent chains: a blocked task on one instance must
  // not delay the other (exactly what the module-level chain used to do).
  const TIMEOUT = Symbol('queue-independent-timeout')
  const slow = host.createEnsureQueue()
  const fast = host.createEnsureQueue()
  let release = null
  const gate = new Promise((resolve) => { release = resolve })
  const blocked = slow(async () => { await gate; return 'slow' })
  const fastValue = await Promise.race([fast(async () => 'fast'), wait(300).then(() => TIMEOUT)])
  if (fastValue !== 'fast') throw new Error('a second instance must not queue behind the first instance chain')
  release()
  if (await blocked !== 'slow') throw new Error('the blocked task must still resolve once released')
  console.log('queue OK: per-instance serial chain — ordered, rejection-safe, instance-independent')
}

// Concurrent /temp-session requests on one instance must serialize through that
// instance's chain: two overlapping ensures would otherwise both mkdir and
// both resolveByPath before either create lands. Both requests are driven
// through the registered route, not the handler directly.
{
  const serialDir = mkdtempSync(join(tmpdir(), 'temp-session-verify-serial-'))
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const store = []
  let inFlight = 0
  let maxInFlight = 0
  const serialWebServer = makeWebServerStub()
  const serialCtx = {
    get: (name) => (name === 'webServer' ? serialWebServer : undefined),
    logger: { info: () => {}, warn: () => {} },
    inject: (services, callback) => {
      if (services.join(',') !== 'webServer,workspaceRegistry') return undefined
      callback({
        workspaceRegistry: {
          resolveByPath: async (path) => {
            inFlight += 1
            if (inFlight > maxInFlight) maxInFlight = inFlight
            await wait(10)
            inFlight -= 1
            return store.find((w) => w.path === path)
          },
          create: async (path, title) => {
            const ws = { id: 'ws-serial-' + (store.length + 1), path, title }
            store.push(ws)
            return ws
          },
        },
        get: serialCtx.get,
        logger: serialCtx.logger,
        effect: (fn) => fn(),
        fiber: { state: 0 },
      })
      return { then: () => {} }
    },
    effect: (fn) => fn(),
  }
  host.apply(serialCtx, { dir: serialDir, title: '临时会话' })
  const deadline = Date.now() + 2000
  while (store.length === 0 && Date.now() < deadline) await wait(5)
  if (store.length !== 1) throw new Error(`startup ensure must register the temp workspace once: ${store.length}`)
  const serialRoute = serialWebServer.routes.find((route) => route.path === ROUTE_PATH)
  if (serialRoute === undefined) throw new Error(`serial instance route: ${JSON.stringify(serialWebServer.routes)}`)
  maxInFlight = 0
  const [firstCall, secondCall] = await Promise.all([
    callRoute(serialRoute, { headers: FENCE_HEADERS, body: JSON.stringify({ args: {} }) }),
    callRoute(serialRoute, { headers: FENCE_HEADERS, body: JSON.stringify({ args: {} }) }),
  ]).then((responses) => responses.map((response) => response.envelope))
  if (maxInFlight !== 1) throw new Error(`concurrent ensures must serialize (max in flight = ${maxInFlight})`)
  if (store.length !== 1) throw new Error(`concurrent ensures must reuse one workspace: ${store.length}`)
  if (!firstCall.ok || !secondCall.ok || firstCall.value.workspaceId !== secondCall.value.workspaceId) {
    throw new Error(`concurrent ensure results: ${JSON.stringify([firstCall, secondCall])}`)
  }
  console.log('serialize OK: overlapping /temp-session ensures run one at a time on one workspace')
}

// --- client half: bundle + contract checks (DOM shim when jsdom is absent) ---
let dom = null
let handoff = null
let readPluginStyles = () => []
let reEvaluateBundle = () => {}
const bundleSource = readFileSync(clientPath, 'utf8')
// Named so the same bundle can be evaluated twice: a hot reload re-runs the
// module body, which is what the CSS de-duplication guard has to survive.
const evaluateBundle = (win, doc) => { new Function('window', 'document', bundleSource)(win, doc) }
if (DOM_AVAILABLE) {
  dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3080/',
  })
  globalThis.window = dom.window
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (!(key in globalThis)) globalThis[key] = dom.window[key]
  }
  dom.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
  evaluateBundle(dom.window, dom.window.document)
  readPluginStyles = () => Array.from(dom.window.document.querySelectorAll('style[data-plugin-css]'))
  reEvaluateBundle = () => evaluateBundle(dom.window, dom.window.document)
} else {
  // Minimal DOM shim: keeps the appended <style> tags so the injection
  // contract stays assertable without jsdom, mirroring the shell's own
  // `style[data-plugin-css]` de-duplication.
  const styles = []
  const shimDocument = {
    querySelector: (selector) => {
      const match = /^style\[data-plugin-css="(.+)"\]$/.exec(selector)
      if (match === null) return null
      return styles.find((tag) => tag.dataset.pluginCss === match[1]) ?? null
    },
    createElement: () => ({ dataset: {}, setAttribute: () => {}, appendChild: () => {} }),
    head: { appendChild: (tag) => { styles.push(tag) } },
  }
  const shimWindow = { __ModuleLoader__: { load: (h) => { handoff = h } } }
  evaluateBundle(shimWindow, shimDocument)
  readPluginStyles = () => styles
  reEvaluateBundle = () => evaluateBundle(shimWindow, shimDocument)
}
if (handoff === null) throw new Error('bundle never called __ModuleLoader__.load')
if (handoff.id !== PLUGIN_ID) throw new Error(`handoff id mismatch: ${handoff.id}`)

const icon = (props) => React.createElement('svg', { ...props, 'data-icon': true })
const requireTable = (spec) => {
  if (spec === 'react') return uiRequire('react')
  if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return { IconSparkle16: icon }
  }
  throw new Error(`unexpected module-table word: ${spec}`)
}
const exports_ = handoff.factory(requireTable)

if (typeof exports_.apply !== 'function') throw new Error('exports.apply missing')
if (!Array.isArray(exports_.inject)) throw new Error('exports.inject missing')
if (exports_.NS !== 'sidebar.tempSession') throw new Error(`NS mismatch: ${exports_.NS}`)
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

let registrations = []
let dicts = []
let rpcLog = []
let starts = []
let localeBindCalls = 0
let ensureResult = { ok: true, value: { workspaceId: 'ws-temp', path: 'C:/Users/x/.dsh/tmp-workspaces', title: '临时会话', created: true } }
// `fetch` double: the browser half reaches the host over `POST
// /temp-session/ensure` now, so the double records the real request (URL /
// method / content-type / body) and answers with the route's envelope.
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const headers = init.headers ?? {}
  const contentType = headers['content-type'] ?? headers['Content-Type']
  let parsed
  try { parsed = JSON.parse(String(init.body)) } catch { parsed = undefined }
  rpcLog.push({ url: String(url), method: init.method, contentType, body: String(init.body), payload: parsed })
  if (ensureResult instanceof Error) throw ensureResult
  if (ensureResult.status !== undefined && ensureResult.status !== 200) {
    return { ok: false, status: ensureResult.status, json: async () => ensureResult.envelope }
  }
  return { ok: true, status: 200, json: async () => ensureResult }
}
const clientCtx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dict) => { dicts.push({ ns, dict }) },
    bind: () => { localeBindCalls += 1; return (key) => 't:' + key },
  },
  // No `connection` service: the browser half must not need one any more.
  uiWorkspace: {
    startSession: (workspaceId) => { starts.push(workspaceId) },
  },
  slots: {
    inject: (_key, callback) => { registrations.push(callback()) },
    register: (options, component) => ({ ...options, component }),
  },
}
exports_.apply(clientCtx)

const actionReg = registrations.find((r) => r.name === 'sidebar.footer.action')
if (actionReg === undefined) throw new Error('sidebar.footer.action never registered')
if (actionReg.id !== 'temp-session' || actionReg.order !== -10) {
  throw new Error(`action options mismatch: ${JSON.stringify(actionReg)}`)
}
if (typeof actionReg.inject().startTempSession !== 'function') {
  throw new Error('action inject must expose startTempSession')
}
const dict = dicts.find((d) => d.ns === 'sidebar.tempSession')
if (dict === undefined) throw new Error('dictionaries not registered')
const zhKeys = Object.keys(dict.dict.zh)
const enKeys = Object.keys(dict.dict.en)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  throw new Error(`zh/en key mismatch:\nzh: ${zhKeys}\nen: ${enKeys}`)
}
console.log(`apply contract OK: sidebar.footer.action id=temp-session order=-10 | dict keys = ${zhKeys.length}`)

// Dead-code guard: the module used to call ctx.locale.bind(NS) and never use
// the result; `t` reaches the component through the slot's `locale: NS` prop.
if (localeBindCalls !== 0) {
  throw new Error(`dead code: ctx.locale.bind must not be called (${localeBindCalls} call(s))`)
}

// CSS contract: exactly one sheet, marked for the loader (data-plugin) and for
// de-duplication (data-plugin-css); a hot reload re-runs the module body and
// must reuse the existing tag instead of stacking a second copy.
const pluginStyles = readPluginStyles()
if (pluginStyles.length !== 1) throw new Error(`bundle must inject exactly one style tag, got ${pluginStyles.length}`)
const cssTag = pluginStyles[0]
if (cssTag.dataset.plugin !== PLUGIN_ID) {
  throw new Error(`style[data-plugin] must be ${PLUGIN_ID}, got ${cssTag.dataset.plugin}`)
}
if (cssTag.dataset.pluginCss !== PLUGIN_ID + '/temp-session.css') {
  throw new Error(`style[data-plugin-css] must be the dedupe key, got ${cssTag.dataset.pluginCss}`)
}
if (typeof cssTag.textContent !== 'string' || !cssTag.textContent.includes('.ts-btn{')) {
  throw new Error('style tag must carry the injected sheet')
}
reEvaluateBundle()
if (readPluginStyles().length !== 1) {
  throw new Error('re-evaluating the bundle (hot reload) must reuse the style tag, not stack it')
}
console.log('css OK: one data-plugin/data-plugin-css style tag, re-injection guarded')

if (!DOM_AVAILABLE) {
  console.log('\nclient DOM sections SKIPPED (jsdom not installed)')
  console.log('ALL NON-DOM HARNESS CHECKS PASSED (install jsdom to enable the DOM sections)')
  process.exit(0)
}

// --- render + interact (react-dom in jsdom) ------------------------------------
const { act } = React
const { createRoot } = uiRequire('react-dom/client')

const fireClick = (el) => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const en = dict.dict.en
const clientInjected = actionReg.inject('session-1')
const tWithParams = (key) => en[key]

const rootHost = dom.window.document.createElement('div')
const root = createRoot(rootHost)
await act(async () => {
  root.render(React.createElement(actionReg.component, {
    wide: true,
    startTempSession: clientInjected.startTempSession,
    t: tWithParams,
  }))
})

const btn = rootHost.querySelector('.ts-btn')
if (btn === null) throw new Error('action button missing')
if (btn.getAttribute('aria-label') !== en.title) throw new Error(`aria-label: ${btn.getAttribute('aria-label')}`)
if (btn.textContent !== en.label) throw new Error(`wide label: ${btn.textContent}`)
// The wrapper must claim the flex-row width (footerActions is display:flex),
// or the button's calc(100%+8px) collapses to the label width and the hover
// chrome only covers the text (the reported bug).
const wrap = rootHost.querySelector('.ts-wrap')
if (wrap === null || wrap.classList.contains('ts-rail-wrap')) throw new Error('wide wrapper must not be rail-mode')
console.log('render OK: wide row shows icon + label, aria-label set, wrapper claims full width')

// click -> POST /temp-session/ensure -> uiWorkspace.startSession
await act(async () => { fireClick(btn) })
const ensureCall = rpcLog.find((c) => c.url === '/temp-session/ensure')
if (ensureCall === undefined) throw new Error(`ensure request: ${JSON.stringify(rpcLog)}`)
if (ensureCall.method !== 'POST' || ensureCall.contentType !== 'application/json') {
  throw new Error(`ensure request must be POST + JSON: ${JSON.stringify(ensureCall)}`)
}
if (JSON.stringify(ensureCall.payload.args) !== '{}') throw new Error(`ensure args: ${JSON.stringify(ensureCall.body)}`)
if (starts.length !== 1 || starts[0] !== 'ws-temp') throw new Error(`startSession target: ${JSON.stringify(starts)}`)
console.log('click flow OK: POST /temp-session/ensure -> uiWorkspace.startSession(ws-temp)')

// error path: ensure failure surfaces as the error line, button back to label
ensureResult = { ok: false, error: { code: 'temp-workspace-failed', message: 'boom', details: {} } }
rpcLog = []
await act(async () => { fireClick(rootHost.querySelector('.ts-btn')) })
if (!rootHost.querySelector('.ts-error')) throw new Error('error line missing')
if (rootHost.querySelector('.ts-btn').textContent !== en.label) throw new Error('button must return to label after failure')
console.log('error path OK: failure shows error line, button re-enabled')

// a non-2xx answer and a rejected fetch are failures too (never a silent no-op)
for (const [label, value] of [
  ['HTTP 500', { status: 500, envelope: { ok: false, error: { code: 'internal', message: 'boom', details: {} } } }],
  ['network error', new Error('network down')],
]) {
  ensureResult = value
  rpcLog = []
  await act(async () => { fireClick(rootHost.querySelector('.ts-btn')) })
  if (!rootHost.querySelector('.ts-error')) throw new Error(`${label} must show the error line`)
  if (starts.length !== 1) throw new Error(`${label} must not start a session: ${JSON.stringify(starts)}`)
  if (rpcLog.length !== 1 || rpcLog[0].url !== '/temp-session/ensure') {
    throw new Error(`${label} must really call the route: ${JSON.stringify(rpcLog)}`)
  }
}
ensureResult = { ok: true, value: { workspaceId: 'ws-temp', path: 'C:/Users/x/.dsh/tmp-workspaces', title: '临时会话', created: true } }
console.log('transport error path OK: HTTP status and network rejection both surface the error line')

// rail rendering: icon only, no label
const railHost = dom.window.document.createElement('div')
const railRoot = createRoot(railHost)
await act(async () => {
  railRoot.render(React.createElement(actionReg.component, {
    wide: false,
    startTempSession: clientInjected.startTempSession,
    t: tWithParams,
  }))
})
const railBtn = railHost.querySelector('.ts-btn')
if (railBtn === null || !railBtn.classList.contains('ts-rail')) throw new Error('rail button missing/classless')
if (railBtn.textContent !== '') throw new Error(`rail must hide the label: '${railBtn.textContent}'`)
const railWrap = railHost.querySelector('.ts-wrap')
if (railWrap === null || !railWrap.classList.contains('ts-rail-wrap')) throw new Error('rail wrapper must be rail-mode')
console.log('rail OK: icon-only circle without label, centered wrapper')

// The `fetch` double is installed on the shared global: put the real one back.
globalThis.fetch = realFetch

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
