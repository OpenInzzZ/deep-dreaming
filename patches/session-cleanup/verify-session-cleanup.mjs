/**
 * Functional harness for the session-cleanup patch's settings integration.
 *
 * Host half: applies the real `session-cleanup.mjs` to a mock Cordis context —
 * both without a settings service (entry-config fallback) and with one
 * (namespace registration + watch-driven timer rebuild + the /session-cleanup
 * prefix route). Guards the P0 regression: `apply` must NOT return a thenable
 * (Cordis treats a returned Fiber as an invalid Effect and throws
 * TypeError('Invalid effect')), the settings detach disposer / watcher must not
 * rebuild the timer while the plugin unloads (isUnloading guard), and the
 * transport (a fenced prefix route on the `webServer` service — NOT a
 * `connection.rpc` channel, which dsh 0.1.5-rc.1 cannot register for a plugin
 * outside the connection package) is owned by `ctx.effect` and must survive a
 * throwing settings wiring. The mock context mirrors what a real activation
 * looks like now that `webServer` / `sessions` are STATIC module-level `inject`
 * dependencies: `apply` reads them straight off `ctx`, so the context exposes
 * them as properties and only `settings` is still asked for dynamically.
 *
 * Endpoint handling is asserted through the route itself with a fake req/res:
 * the fence (403 foreign Origin / 405 non-POST / 415 non-JSON / 404
 * empty-or-multi-segment endpoint / 400 non-JSON body / 413 over 1 MB / 500
 * throwing handler) and the three config endpoints over the unchanged
 * `{ ok, value }` / `{ ok, error }` envelope.
 *
 * Client half: loads the exact deployed `client.js`, asserts the
 * `settings.plugin.item` card registration (key 'session-cleanup'),
 * checks the dictionaries, drives the cardApi (getConfig / setConfig /
 * resetConfig) through a `fetch` double — the card reads and writes config over
 * `POST /session-cleanup/<endpoint>` — and renders the card in jsdom to
 * exercise the staged-edit → save → transport flow end to end. The fetch double
 * is wired to the REAL host route, so every client call is answered by the
 * installed host half rather than by a hand-written envelope.
 *
 * Dependency resolution goes through `scripts/test-deps.mjs` (no hardcoded
 * machine paths): jsdom / react / react-dom / @deepseek-ai/* resolve from the
 * repo's own dev dependencies, then $NODE_PATH, then the deployed profile
 * trees. jsdom is the only DOM dependency; if it is missing the render section
 * is skipped with a notice and the host + client contract checks still run.
 *
 * Run: node patches/session-cleanup/verify-session-cleanup.mjs
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadDomDeps, createUiRequire } from '../../scripts/test-deps.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// react / jsdom 由仓库自己的 devDependencies 提供（scripts/test-deps.mjs 负责
// 按“仓库 → $NODE_PATH → ~/.dsh/profiles”的顺序解析），不再锚到某个机器上的
// harness 检出路径 —— 那会让别人克隆下来就跑不起来。
const uiRequire = createUiRequire(import.meta.url)
const domDeps = loadDomDeps(import.meta.url)
const React = domDeps.React
const JSDOM = domDeps.JSDOM
if (!domDeps.available) console.warn(`SKIP DOM checks: ${domDeps.hint}`)
const hostPath = join(here, 'session-cleanup.mjs')
const clientPath = join(here, 'client.js')
const PLUGIN_ID = '@local/dsh-plugin-session-cleanup'
const ROUTE_PATH = '/session-cleanup'

// --- host half: entry fallback + settings integration + route ------------------
const host = await import(pathToFileURL(hostPath).href)
// 形状检查只看真正的代码：宿主半的文档注释里点名了两种被淘汰的写法
// （`ctx.inject(...)` 与 `ctx.get('webServer')`），不先剥掉注释就会自己误伤。
const hostCode = readFileSync(hostPath, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
const sessionsRoot = mkdtempSync(join(tmpdir(), 'cleanup-verify-'))

/**
 * `webServer` service double: records every register() as
 * `{ kind, path, handler }` plus the live-route count at each settings
 * `register()` (used to prove the transport is installed BEFORE the settings
 * section, so a throwing settings wiring cannot be mistaken for the reason).
 * Handed to the mock context as the `webServer` property, exactly like a real
 * activation of a plugin that lists the carrier in its static `inject`.
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
 * A mock context shaped like a REAL activation of this plugin: `sessions` and
 * `webServer` are the module's STATIC `inject` dependencies, so Cordis hands
 * them to `apply` as plain properties (and only activates the plugin once both
 * are bound). `settings` stays dynamic — it is an optional enhancement the host
 * half asks for with `ctx.inject(['settings'], …)`.
 *
 * `withoutCarrier` models a state the static declaration makes unreachable in
 * production: `webServer` missing while `apply` runs. It exists to prove the
 * host half carries no `undefined` branch any more — registration is
 * unconditional, so a missing carrier throws instead of silently skipping the
 * page's whole transport, which is exactly the symptom this fix removed.
 */
function makeCtx({ withSettings, settingsThrows = false, withoutCarrier = false }) {
  const calls = {
    info: [],
    warn: [],
    registered: null,
    watchCb: null,
    cleanups: [],
    settingsUpdates: [],
    settingsReplaces: [],
    /** Every dependency list the host half declared *dynamically*, in order. */
    injectLists: [],
    /** Labels of the effects registered through `ctx.effect`, in order. */
    effectLabels: [],
    /** Live route count at the moment the settings namespace registered. */
    routesAtSettingsRegister: null,
  }
  const logger = {
    info: (...args) => { calls.info.push(args) },
    warn: (...args) => { calls.warn.push(args) },
  }
  const web = makeWebServer()
  // Cordis effect: run the body now, keep the disposer. All contexts share one
  // list in registration order; disposal runs it in reverse (LIFO), which for
  // this plugin reproduces the observable cordis teardown order: the plugin's
  // own disposed-setter runs before the settings child fiber's disposer.
  const effect = (fn, label) => {
    calls.effectLabels.push(typeof label === 'string' ? label : null)
    const cleanup = fn()
    if (typeof cleanup === 'function') calls.cleanups.push(cleanup)
    return cleanup
  }
  // The settings provider, kept out of `ctx` itself: a real plugin reaches it
  // only through the inject callback, and an optional `ctx.get('settings')`
  // read answers `undefined` when the service was never provided.
  const settingsService = withSettings ? {
    register: (ns, schema, options) => {
      // Recorded before anything can throw: this is the live route count
      // the settings section starts from.
      calls.routesAtSettingsRegister = web.routes.length
      if (settingsThrows) throw new Error('settings provider exploded during register (harness double)')
      calls.registered = { ns, options }
      const base = { ...host.DEFAULTS, ...options.base }
      // The real scope layers a USER DOCUMENT over the composition base:
      // `update` merges into the document, `replace` clears it, and
      // `get()` always resolves base-over-document. Modelling the base
      // as part of the mutable store would make 恢复默认 look like it
      // erased the entry config.
      let user = {}
      return {
        get: () => ({ ...base, ...user }),
        watch: (cb) => { calls.watchCb = cb; return () => {} },
        update: async (fields) => {
          user = { ...user, ...fields }
          calls.settingsUpdates.push(fields)
        },
        replace: async (fields) => {
          user = { ...(fields ?? {}) }
          calls.settingsReplaces.push(fields)
        },
      }
    },
  } : undefined
  // What every fiber of this plugin sees: the two STATIC dependencies are
  // already bound, which is precisely what `inject` promises.
  const shared = {
    logger,
    calls,
    web,
    effect,
    sessions: { list: () => [] },
    ...(withoutCarrier ? {} : { webServer: web.service }),
  }
  const ctx = {
    ...shared,
    get: (name) => (name === 'settings' ? settingsService : undefined),
    inject: (services, callback) => {
      const list = services.join(',')
      calls.injectLists.push(list)
      if (list === 'settings' && settingsService !== undefined) {
        const child = { ...shared, get: ctx.get, inject: ctx.inject, settings: settingsService }
        // Cordis runs this callback in its own CHILD fiber, so a throw inside it
        // fails that child (disposing only its own effects) and never reaches
        // `apply`. This synchronous mock reproduces that containment: it hands
        // the callback to the caller as usual but swallows the failure, so a
        // throw here cannot be mistaken for `apply` throwing.
        try {
          return callback(child)
        } catch (error) {
          calls.settingsFailure = error
          return undefined
        }
      }
      return undefined
    },
  }
  return ctx
}

function dispose(ctx) {
  for (const cleanup of [...ctx.calls.cleanups].reverse()) {
    cleanup()
  }
  ctx.calls.cleanups.length = 0
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

/** The exact route this apply() registered (kind and path both asserted). */
const routeOf = (ctx) => {
  const route = ctx.web.routes.find((r) => r.path === ROUTE_PATH)
  if (route === undefined) {
    throw new Error(`${ROUTE_PATH} never registered (routes: ${JSON.stringify(ctx.web.routes.map((r) => r.path))})`)
  }
  if (route.kind !== 'prefix') throw new Error(`${ROUTE_PATH} must be kind 'prefix', got '${route.kind}'`)
  return route
}

/**
 * Drive one registered prefix route with a fake req/res.
 *
 * The route registers its request listeners synchronously and answers from a
 * promise continuation, so the body is delivered only after `handler()`
 * returned and the helper resolves when the response is really finished. The
 * oversize-body path destroys the request instead of answering, so `destroy()`
 * settles the helper on the current response state.
 */
const callRoute = async (route, {
  method = 'POST',
  pathname = route.path,
  body = {},
  raw = null,
  headers = {},
} = {}) => {
  let settleDone
  const done = new Promise((resolve) => { settleDone = resolve })
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
      settleDone(this)
      return this
    },
  }
  const listeners = new Map()
  const req = {
    method,
    url: pathname,
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', ...headers },
    destroy() { settleDone(res) },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return req
    },
  }
  await route.handler(req, res)
  const payload = raw === null ? JSON.stringify(body) : raw
  for (const listener of [...(listeners.get('data') ?? [])]) listener(Buffer.from(payload, 'utf8'))
  for (const listener of [...(listeners.get('end') ?? [])]) listener()
  return Promise.race([
    done,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`route ${pathname} never answered`)), 2000).unref?.()
    }),
  ])
}

/** One endpoint call: POST the envelope-shaped body and parse the answer. */
const callEndpoint = async (route, endpoint, body = { args: {} }, options = {}) => {
  const res = await callRoute(route, { pathname: `${ROUTE_PATH}/${endpoint}`, body, ...options })
  if (res.status !== 200) throw new Error(`${endpoint}: expected 200, got ${res.status} (${res.body})`)
  if (res.headers['content-type'] !== 'application/json') {
    throw new Error(`${endpoint}: content-type must be application/json, got ${JSON.stringify(res.headers['content-type'])}`)
  }
  return JSON.parse(res.body)
}

/** The repository's full failure envelope, enforced on every transport failure. */
const assertErrorEnvelope = (label, result) => {
  if (result?.ok !== false) throw new Error(`${label}: expected ok:false, got ${JSON.stringify(result)}`)
  const { code, message, details } = result.error ?? {}
  if (typeof code !== 'string' || code.length === 0) throw new Error(`${label}: error.code missing`)
  if (typeof message !== 'string' || message.length === 0) throw new Error(`${label}: error.message missing`)
  if (typeof details !== 'object' || details === null || Array.isArray(details)) throw new Error(`${label}: error.details missing`)
}

// 0) 传输载体的依赖形态：模块级**静态** `inject`，不是 apply 内的动态门。
//
//    Cordis 并发挂载各行，HTTP 载体比 `sessions` 绑定得更晚。曾经的写法是在
//    apply 里 `ctx.inject(['webServer','sessions'], …)` 配一次可选的
//    `ctx.get('webServer')` 读取：用户层热重载后那条动态门不会重新激活，而
//    读到 undefined 的那个分支干脆什么都不注册 —— 页面的整条读写通道就这么
//    静默消失了（~/.dsh/logs 里连一条 warn 都没有）。改成静态声明之后，
//    “载体晚到”是 Cordis 负责等的（依赖就绪才激活插件），本仓库
//    tests/load-smoke.mjs 在真实运行时里证明了晚到的载体仍然会注册路由；
//    这里守住脚本能观测的那一半：声明存在、apply 里不再有可选读取或动态门、
//    并且载体真的缺失时抛错而不是静默跳过。
{
  if (!Array.isArray(host.inject)) throw new Error(`host.inject must be a static array, got ${typeof host.inject}`)
  for (const dep of ['sessions', 'webServer']) {
    if (!host.inject.includes(dep)) throw new Error(`host.inject must declare '${dep}' as a hard dependency: ${JSON.stringify(host.inject)}`)
  }
  if (/ctx\.get\(\s*['"]webServer/.test(hostCode)) {
    throw new Error('the host half reads the web carrier optionally again (ctx.get) — that is the activation race this fix removed')
  }
  if (/ctx\.inject\(\s*\[[^\]]*['"]webServer/.test(hostCode)) {
    throw new Error('the web carrier must stay a STATIC inject, not a dynamic gate inside apply')
  }
  // 载体缺席在真实运行里到不了（静态依赖会先等它绑定），这里断言的是宿主代码
  // 已经没有 undefined 分支：只能响亮地抛，不能悄悄不注册。
  const ctx = makeCtx({ withSettings: true, withoutCarrier: true })
  let carrierFailure = null
  try { host.apply(ctx, { sessionsRoot, dryRun: true, intervalMinutes: 9 }) } catch (error) { carrierFailure = error }
  if (!(carrierFailure instanceof Error)) {
    throw new Error('a missing declared carrier must fail loudly, never skip the registration silently')
  }
  if (ctx.web.routes.length !== 0) throw new Error('no route may be registered against a missing carrier')
  // enabled:false 在任何注册之前就返回。
  const off = makeCtx({ withSettings: true })
  if (host.apply(off, { enabled: false, sessionsRoot }) !== undefined) {
    throw new Error('a disabled apply must return undefined')
  }
  if (off.web.routes.length !== 0 || off.calls.effectLabels.length !== 0) {
    throw new Error(`enabled:false must register nothing, got ${off.web.routes.length} route(s) / ${off.calls.effectLabels.length} effect(s)`)
  }
  console.log(`host inject OK: static inject = ${JSON.stringify(host.inject)} (no ctx.get race, missing carrier throws, enabled:false registers nothing)`)
}

// 1) no settings service -> entry config drives the cleanup, the route still works
{
  const entry = { sessionsRoot, maxAgeDays: 7, intervalMinutes: 9, dryRun: true }
  const ctx = makeCtx({ withSettings: false })
  const applied = host.apply(ctx, entry)
  if (applied !== undefined) {
    throw new Error(`apply must return undefined (returning a thenable breaks cordis loading), got ${typeof applied}`)
  }
  await settle()
  // 载体是静态依赖，所以 apply 里只剩 `settings` 这一个动态门；通道不能再退回
  // 到 ctx.inject / ctx.get —— 那是热重载后失联的那条路。
  if (ctx.calls.injectLists.some((list) => list.includes('webServer'))) {
    throw new Error(`the transport must not be gated by a dynamic inject: ${JSON.stringify(ctx.calls.injectLists)}`)
  }
  if (ctx.calls.info.length === 0) throw new Error('startup cleanup tick must run from the entry config')
  if (!ctx.calls.info[0][0].includes('scanned=')) throw new Error(`tick summary missing: ${ctx.calls.info[0]}`)
  if (ctx.calls.registered !== null) throw new Error('no settings service must not register a namespace')
  if (ctx.web.routes.length !== 1) throw new Error(`exactly one route must be registered, got ${ctx.web.routes.length}`)
  // 路由由恰好一个 effect 持有 —— 卸载时就是它把路由放掉的（下面 dispose 验）。
  const routeEffects = ctx.calls.effectLabels.filter((label) => label !== null && label.includes('rpc route'))
  if (routeEffects.length !== 1) {
    throw new Error(`the route must be held by exactly one labelled effect, got ${JSON.stringify(ctx.calls.effectLabels)}`)
  }
  const route = routeOf(ctx)
  const got = await callEndpoint(route, 'getConfig')
  if (!got.ok || got.value.maxAgeDays !== 7) throw new Error(`getConfig without settings: ${JSON.stringify(got)}`)
  const set = await callEndpoint(route, 'setConfig', { args: { fields: { maxAgeDays: 3 } } })
  if (set.ok || set.error.code !== 'settings-unavailable') {
    throw new Error(`setConfig without settings must report settings-unavailable: ${JSON.stringify(set)}`)
  }
  const reset = await callEndpoint(route, 'resetConfig')
  if (reset.ok || reset.error.code !== 'settings-unavailable') {
    throw new Error(`resetConfig without settings must report settings-unavailable: ${JSON.stringify(reset)}`)
  }
  const unknown = await callEndpoint(route, 'nope')
  if (unknown.ok || unknown.error.code !== 'settings-unavailable') {
    throw new Error(`an unknown endpoint degrades the same way here: ${JSON.stringify(unknown)}`)
  }
  const before = ctx.calls.info.length
  dispose(ctx)
  if (ctx.web.routes.length !== 0) throw new Error('dispose must remove the /session-cleanup route')
  if (ctx.web.disposeCount() !== 1) throw new Error(`dispose must run the route disposer, ran ${ctx.web.disposeCount()}`)
  if (ctx.calls.info.length !== before) {
    throw new Error('dispose must not rebuild the timer (settings fallback onChange guarded)')
  }
  console.log('host OK: entry-config fallback (no settings) + /session-cleanup prefix route + unload guards')
}

// 1b) the transport fence, driven through the real route
{
  const ctx = makeCtx({ withSettings: true })
  host.apply(ctx, { sessionsRoot, dryRun: true, intervalMinutes: 9 })
  await settle()
  const route = routeOf(ctx)

  // A cross-site POST always carries its own Origin: 403.
  const crossOrigin = await callRoute(route, {
    pathname: `${ROUTE_PATH}/getConfig`,
    headers: { origin: 'http://evil.example' },
  })
  if (crossOrigin.status !== 403) throw new Error(`a foreign Origin must be 403, got ${crossOrigin.status}`)
  assertErrorEnvelope('cross-origin refusal', JSON.parse(crossOrigin.body))
  // The page's own origin is the normal case and must pass.
  const sameOrigin = await callRoute(route, {
    pathname: `${ROUTE_PATH}/getConfig`,
    headers: { origin: 'http://127.0.0.1:3080' },
  })
  if (sameOrigin.status !== 200) throw new Error(`a same-origin POST must pass, got ${sameOrigin.status}`)

  // POST only.
  const get = await callRoute(route, { method: 'GET', pathname: `${ROUTE_PATH}/getConfig` })
  if (get.status !== 405) throw new Error(`GET must be 405, got ${get.status}`)
  assertErrorEnvelope('GET refusal', JSON.parse(get.body))

  // JSON only — that is what forces the preflight this route never answers.
  const wrongType = await callRoute(route, {
    pathname: `${ROUTE_PATH}/getConfig`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  if (wrongType.status !== 415) throw new Error(`a non-JSON content-type must be 415, got ${wrongType.status}`)
  assertErrorEnvelope('content-type refusal', JSON.parse(wrongType.body))
  const charset = await callRoute(route, {
    pathname: `${ROUTE_PATH}/getConfig`,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
  if (charset.status !== 200) throw new Error(`application/json; charset=utf-8 must pass, got ${charset.status}`)

  // The endpoint is one segment under the prefix.
  for (const pathname of [ROUTE_PATH, `${ROUTE_PATH}/`, `${ROUTE_PATH}/a/b`]) {
    const res = await callRoute(route, { pathname })
    if (res.status !== 404) throw new Error(`${pathname} must be 404, got ${res.status} (${res.body})`)
    assertErrorEnvelope(`${pathname} 404`, JSON.parse(res.body))
  }

  // Body guards: not JSON -> 400, over 1 MB -> 413.
  const notJson = await callRoute(route, { pathname: `${ROUTE_PATH}/getConfig`, raw: '<xml/>' })
  if (notJson.status !== 400) throw new Error(`a non-JSON body must be 400, got ${notJson.status}`)
  assertErrorEnvelope('non-JSON body', JSON.parse(notJson.body))
  const tooLarge = await callRoute(route, { pathname: `${ROUTE_PATH}/getConfig`, raw: 'x'.repeat((1 << 20) + 1) })
  if (tooLarge.status !== 413) throw new Error(`a body over 1 MB must be 413, got ${tooLarge.status}`)
  assertErrorEnvelope('oversized body', JSON.parse(tooLarge.body))

  // A throwing handler -> 500 with the internal envelope, route still alive.
  const throwing = host.createRpcRoute('/boom', async () => { throw new Error('handler exploded') })
  const boom = await callRoute(throwing, { pathname: '/boom/x' })
  if (boom.status !== 500) throw new Error(`a throwing handler must be 500, got ${boom.status}`)
  const boomBody = JSON.parse(boom.body)
  assertErrorEnvelope('throwing handler', boomBody)
  if (!boomBody.error.message.includes('handler exploded')) throw new Error(`500 cause: ${JSON.stringify(boomBody)}`)
  const stillAlive = await callEndpoint(route, 'getConfig')
  if (stillAlive.ok !== true) throw new Error('the real route must survive a sibling failure')

  dispose(ctx)
  console.log('host fence OK: 403 foreign Origin (same origin passes) / 405 non-POST / 415 non-JSON (charset passes) / 404 empty+multi-segment / 400 bad body / 413 over 1 MB / 500 throwing handler')
}

// 2) settings service -> namespace registered, watch rebuilds the timer, the route writes through the scope
{
  const entry = { sessionsRoot, maxAgeDays: 7, intervalMinutes: 9, dryRun: true }
  const ctx = makeCtx({ withSettings: true })
  host.apply(ctx, entry)
  await settle()
  if (ctx.calls.registered === null || ctx.calls.registered.ns !== 'session-cleanup') {
    throw new Error(`namespace not registered: ${JSON.stringify(ctx.calls.registered)}`)
  }
  if (ctx.calls.registered.options.base !== entry) throw new Error('entry config must be the composition base')
  if (ctx.calls.info.length === 0) throw new Error('startup tick must run with settings present')
  const before = ctx.calls.info.length
  ctx.calls.watchCb()
  await settle()
  if (ctx.calls.info.length <= before) throw new Error('watch change must rebuild the timer (startup tick again)')

  const route = routeOf(ctx)
  const set = await callEndpoint(route, 'setConfig', { args: { fields: { maxAgeDays: 3 } } })
  if (!set.ok || set.value.maxAgeDays !== 3) throw new Error(`setConfig through the scope: ${JSON.stringify(set)}`)
  if (ctx.calls.settingsUpdates.length !== 1 || ctx.calls.settingsUpdates[0].maxAgeDays !== 3) {
    throw new Error(`settings update not written: ${JSON.stringify(ctx.calls.settingsUpdates)}`)
  }
  // The client's own body shape is what the client sends; the handler must also
  // reject a non-object `fields` with the unchanged bad-request code.
  const badFields = await callEndpoint(route, 'setConfig', { args: { fields: [] } })
  assertErrorEnvelope('setConfig with an array', badFields)
  if (badFields.error.code !== 'bad-request') throw new Error(`bad fields code: ${JSON.stringify(badFields)}`)
  const unknown = await callEndpoint(route, 'nope')
  assertErrorEnvelope('unknown endpoint with settings', unknown)
  if (unknown.error.code !== 'bad-request') throw new Error(`unknown endpoint code: ${JSON.stringify(unknown)}`)
  const reset = await callEndpoint(route, 'resetConfig')
  if (!reset.ok) throw new Error(`resetConfig: ${JSON.stringify(reset)}`)
  if (ctx.calls.settingsReplaces.length !== 1) throw new Error('settings replace not called by resetConfig')

  const afterWatch = ctx.calls.info.length
  dispose(ctx)
  if (ctx.web.routes.length !== 0) throw new Error('dispose must remove the route')
  if (ctx.calls.info.length !== afterWatch) {
    throw new Error('dispose must not rebuild the timer (isUnloading guard)')
  }
  ctx.calls.watchCb()
  await new Promise((resolve) => setTimeout(resolve, 50))
  if (ctx.calls.info.length !== afterWatch) {
    throw new Error('watch callback after dispose must be guarded too')
  }
  console.log('host OK: settings namespace + watch rebuild + route writes through the scope + isUnloading guards')
}

// 2b) fail-soft: the transport must be installed BEFORE the settings section.
//
//     Fidelity note: real Cordis runs the `ctx.inject(['settings'], …)` callback
//     in a CHILD fiber, so a throw there fails that child and never reaches
//     `apply` — which is exactly why the ordering (route first, settings
//     section second) is what protects the page: a throw rolls back only the
//     effects registered in the failing callback, and the route is not one of
//     them. This shared mock invokes inject callbacks synchronously, so the
//     throw is delivered the way Cordis would deliver it — from inside the
//     settings child — while `routesAtSettingsRegister` records what was already
//     live at that moment. The route is then driven for real, so "survived" is
//     measured, not inferred.
{
  const ctx = makeCtx({ withSettings: true, settingsThrows: true })
  let applyFailure = null
  try { host.apply(ctx, { sessionsRoot, dryRun: true, intervalMinutes: 9 }) } catch (error) { applyFailure = error }
  if (applyFailure !== null) throw new Error(`apply must not throw: ${applyFailure?.stack}`)
  if (!(ctx.calls.settingsFailure instanceof Error)) {
    throw new Error('the harness must have delivered the settings failure into the child fiber')
  }
  if (ctx.calls.registered !== null) throw new Error('a throwing register must not be recorded as registered')
  if (ctx.calls.routesAtSettingsRegister !== 1) {
    throw new Error(`the route must already be live when the settings section runs, saw ${ctx.calls.routesAtSettingsRegister} route(s)`)
  }
  if (ctx.web.routes.length !== 1) throw new Error(`the route must still be live, got ${ctx.web.routes.length}`)
  const route = routeOf(ctx)
  const got = await callEndpoint(route, 'getConfig')
  if (!got.ok || got.value.maxAgeDays !== 30) {
    throw new Error(`the entry-config fallback must still answer getConfig: ${JSON.stringify(got)}`)
  }
  const set = await callEndpoint(route, 'setConfig', { args: { fields: { maxAgeDays: 3 } } })
  if (set.ok || set.error.code !== 'settings-unavailable') {
    throw new Error(`setConfig must degrade with settings-unavailable: ${JSON.stringify(set)}`)
  }
  dispose(ctx)
  console.log('host fail-soft OK: a throwing settings register leaves the /session-cleanup route fully usable')
}

// 2c) same wiring, measured instead of inferred: the settings namespace must be
//     registered while the route is ALREADY live (Cordis rolls back every
//     effect registered before a throw in the same inject callback).
{
  const ctx = makeCtx({ withSettings: true })
  host.apply(ctx, { sessionsRoot, dryRun: true, intervalMinutes: 9 })
  await settle()
  if (ctx.calls.routesAtSettingsRegister !== 1) {
    throw new Error(`the route must be live before the settings section registers, saw ${ctx.calls.routesAtSettingsRegister} route(s)`)
  }
  dispose(ctx)
  console.log('host order OK: the /session-cleanup route is installed before the settings section')
}

rmSync(sessionsRoot, { recursive: true, force: true })

// --- client half: bundle + contract checks --------------------------------------
// `React` / `JSDOM` come from `scripts/test-deps.mjs` (resolved at the top of
// this file); jsdom stays the only section-level gate.
let dom = null
let handoff = null
const bundleSource = readFileSync(clientPath, 'utf8')
if (JSDOM !== null) {
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
const requireTable = (spec) => {
  if (spec === 'react') return React
  if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return { IconChevronDownOutline14: icon }
  }
  throw new Error(`unexpected module-table word: ${spec}`)
}
const exports_ = handoff.factory(requireTable)
if (typeof exports_.apply !== 'function' || !Array.isArray(exports_.inject)) throw new Error('exports contract broken')
if (exports_.NS !== 'session-cleanup.card') throw new Error(`NS mismatch: ${exports_.NS}`)
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

// Card CSS must only reference theme aliases the shipped theme actually defines:
// an undefined var() silently drops its declaration (the shipped settings card
// still asks for `--dsw-alias-label-error` / `--dsw-alias-label-on-brand`, which
// 0.1.5-rc.1's @deepseek-ai/dsh-client-ui-theme never defines; it defines
// `--dsw-alias-state-error-primary` and `--dsw-alias-label-primary-foreground`).
for (const dead of ['--dsw-alias-label-on-brand', '--dsw-alias-label-error']) {
  if (bundleSource.includes(dead)) throw new Error(`card CSS references an undefined theme alias: ${dead}`)
}

let registered = null
let dictionaries = null

/**
 * `fetch` double, wired to the REAL host route.
 *
 * The browser half now posts to `/session-cleanup/<endpoint>` and unwraps the
 * `{ ok, value }` envelope, so this records every request (url, method,
 * content-type, exact body) and answers with a Response-shaped object built
 * from what the installed host half really replies through its route. A
 * hand-written envelope would not prove the two halves agree on the contract.
 */
const fetchCalls = []
let fetchMode = { networkError: null }
/** The host context the fetch double answers from (swapped per section). */
let activeCtx = null
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const headers = init.headers ?? {}
  const call = {
    url: String(url),
    method: init.method,
    contentType: headers['content-type'],
    body: String(init.body ?? ''),
  }
  fetchCalls.push(call)
  if (fetchMode.networkError !== null) throw new Error(fetchMode.networkError)
  if (fetchMode.forceStatus !== undefined) {
    return {
      ok: fetchMode.forceStatus >= 200 && fetchMode.forceStatus < 300,
      status: fetchMode.forceStatus,
      json: async () => fetchMode.forceEnvelope ?? { ok: true, value: {} },
    }
  }
  // Default: answered by the REAL host route installed above, so a client call
  // exercises the two halves' shared contract rather than a hand-written stub.
  const res = await callRoute(routeOf(activeCtx), { pathname: call.url, body: JSON.parse(call.body) })
  return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => JSON.parse(res.body) }
}

const clientCtx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => { dictionaries = { ns, dicts } },
    bind: () => (key) => 't:' + key,
  },
  slots: {
    inject: (_key, callback) => { registered = callback() },
    register: (options, component) => ({ ...options, component }),
  },
}

// One settings-capable host half, live for the whole client section: the card's
// reads and writes are answered by the real route and the real settings scope.
// The entry config carries the 45-day override the card must render (the mock
// settings provider starts from exactly this base).
let fetchCtx = null
fetchCtx = makeCtx({ withSettings: true })
host.apply(fetchCtx, {
  sessionsRoot: 'C:/__verify__/sessions',
  enabled: true, maxAgeDays: 45, maxTotalMB: 1024, keepSessions: 5,
  intervalMinutes: 360, dryRun: false,
})
await settle()
activeCtx = fetchCtx

exports_.apply(clientCtx)
if (registered === null) throw new Error('slots.inject never registered')
if (registered.key !== 'session-cleanup') {
  throw new Error(`card registration mismatch: ${JSON.stringify(registered)}`)
}
if (dictionaries === null || dictionaries.ns !== exports_.NS) throw new Error('dictionaries not registered')
const zhKeys = Object.keys(dictionaries.dicts.zh)
const enKeys = Object.keys(dictionaries.dicts.en)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  throw new Error(`zh/en key mismatch:\nzh: ${zhKeys}\nen: ${enKeys}`)
}
console.log(`apply contract OK: settings.plugin.item key=session-cleanup | dict keys = ${zhKeys.length}`)

// The client must not depend on the Connection RPC surface any more, and its
// inject list must not name a service it no longer reads. (The explanatory
// comment that names the old call is fine; an actual property access is not.)
if (exports_.inject.includes('connection')) throw new Error(`exports.inject still requires connection: ${JSON.stringify(exports_.inject)}`)
if (/\bctx\.connection\b/.test(bundleSource)) throw new Error('the bundle still accesses ctx.connection')
if (/\bconnection\.rpc\b/.test(bundleSource)) throw new Error('the bundle still calls ctx.connection.rpc')

// cardApi flow: the card reads/writes config over POST /session-cleanup/<endpoint>,
// answered by the real host route.
{
  const api = registered.inject()
  const got = await api.getConfig()
  if (got.maxAgeDays !== 45) throw new Error(`cardApi getConfig: ${JSON.stringify(got)}`)
  const set = await api.setConfig({ maxAgeDays: 60 })
  if (set.maxAgeDays !== 60) throw new Error(`cardApi setConfig: ${JSON.stringify(set)}`)
  const reset = await api.resetConfig()
  // The scope's `get()` resolves the ENTRY config back over the (now empty)
  // user document, so 恢复默认 lands on 45 — the composition base — not on the
  // schema default. That is the value the card re-renders afterwards.
  if (reset.maxAgeDays !== 45) throw new Error(`cardApi resetConfig: ${JSON.stringify(reset)}`)
  const [g, s, r] = fetchCalls
  if (g.url !== '/session-cleanup/getConfig' || g.method !== 'POST' || g.contentType !== 'application/json' || g.body !== '{"args":{}}') {
    throw new Error(`getConfig fetch: ${JSON.stringify(g)}`)
  }
  if (s.url !== '/session-cleanup/setConfig' || s.method !== 'POST' || s.contentType !== 'application/json' || s.body !== '{"args":{"fields":{"maxAgeDays":60}}}') {
    throw new Error(`setConfig fetch: ${JSON.stringify(s)}`)
  }
  if (r.url !== '/session-cleanup/resetConfig' || r.method !== 'POST' || r.contentType !== 'application/json' || r.body !== '{"args":{}}') {
    throw new Error(`resetConfig fetch: ${JSON.stringify(r)}`)
  }
  console.log('cardApi OK: getConfig/setConfig/resetConfig POST to /session-cleanup/<endpoint> and are answered by the host route')
}

// Failure branches: a non-2xx response, a server-side 500 and a dead network
// must all reject with an Error, so the card's catch renders 保存失败 instead of
// a false success.
{
  const api = registered.inject()
  fetchMode = { networkError: 'connection refused' }
  let netFailure = null
  try { await api.getConfig() } catch (error) { netFailure = error }
  if (netFailure === null || !netFailure.message.includes('connection refused')) {
    throw new Error(`a dead network must reject: ${JSON.stringify(netFailure)}`)
  }
  fetchMode = { networkError: null, forceStatus: 500 }
  let httpFailure = null
  try { await api.getConfig() } catch (error) { httpFailure = error }
  if (httpFailure === null || !httpFailure.message.includes('HTTP 500')) {
    throw new Error(`a 500 must reject with the status: ${JSON.stringify(httpFailure)}`)
  }
  fetchMode = { networkError: null, forceStatus: 200, forceEnvelope: { ok: false, error: { code: 'settings-rejected', message: 'rejected by schema', details: { namespace: 'session-cleanup' } } } }
  let envelopeFailure = null
  try { await api.getConfig() } catch (error) { envelopeFailure = error }
  if (envelopeFailure === null || envelopeFailure.code !== 'settings-rejected' || envelopeFailure.details?.namespace !== 'session-cleanup') {
    throw new Error(`a failed envelope must carry .code/.details: ${JSON.stringify(envelopeFailure)}`)
  }
  fetchMode = { networkError: null }
  fetchCalls.length = 0
  console.log('cardApi OK: transport failures reject (network / HTTP 500 / failed envelope with .code+.details)')
}

// --- render + interact (jsdom; skipped when jsdom is missing) --------------------
if (JSDOM === null) {
  console.log('client DOM sections SKIPPED (react/jsdom not resolvable; run `npm install` in the repository root or set DSH_TEST_DEPS)')
} else {
  const { act } = React
  const { createRoot } = uiRequire('react-dom/client')
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const en = dictionaries.dicts.en
  const t = (key) => en[key]
  const doc = dom.window.document

  // A pristine host half for the render flow: the earlier cardApi section wrote
  // through the installed scope, so this one starts from the documented 45-day
  // override. `activeCtx` is what the fetch double answers from.
  fetchCalls.length = 0
  const domCtx = makeCtx({ withSettings: true })
  host.apply(domCtx, {
    sessionsRoot: 'C:/__verify__/sessions',
    enabled: true, maxAgeDays: 45, maxTotalMB: 1024, keepSessions: 5,
    intervalMinutes: 360, dryRun: false,
  })
  await settle()
  activeCtx = domCtx

  const fireClick = (el) => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  }
  const fireChange = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  }
  const waitFor = async (predicate, what) => {
    const deadline = Date.now() + 3000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }

  const root = createRoot(doc.getElementById('root'))
  await act(async () => {
    root.render(React.createElement(registered.component, { ...registered.inject(), t }))
  })
  await waitFor(() => doc.querySelector('.sc-header') !== null, 'card header (initial getConfig)')

  // the user override is visible and the body opens on click
  await act(async () => { fireClick(doc.querySelector('.sc-header')) })
  const inputs = [...doc.querySelectorAll('.sc-input')]
  if (inputs.length !== 5) throw new Error(`expected 5 number/text inputs, got ${inputs.length}`)
  const toggles = [...doc.querySelectorAll('.sc-toggle')]
  if (toggles.length !== 2) throw new Error(`expected 2 toggles, got ${toggles.length}`)
  const maxAgeInput = doc.querySelector('#sc-maxAgeDays')
  if (maxAgeInput === null || maxAgeInput.value !== '45') throw new Error(`override value: ${maxAgeInput?.value}`)

  // No dead per-field reset entry point: the card must not render a reset
  // button / override badge that can never enable (only 恢复默认 exists).
  if (doc.querySelector('.sc-reset') !== null || doc.querySelector('.sc-overridden') !== null) {
    throw new Error('per-field reset UI must not exist (it was a permanently disabled no-op)')
  }

  // staged edit -> save writes the field over POST /session-cleanup/setConfig
  await act(async () => { fireChange(maxAgeInput, '60') })
  if (!doc.querySelector('.sc-pending')) throw new Error('unsaved badge missing')
  const saveButton = doc.querySelector('.sc-save')
  if (saveButton === null || saveButton.disabled) throw new Error('save must be enabled with staged edits')
  await act(async () => { fireClick(saveButton) })
  await waitFor(() => fetchCalls.some((c) => c.url.endsWith('/setConfig')), 'setConfig request')
  const setCall = fetchCalls[fetchCalls.length - 1]
  if (setCall.url !== '/session-cleanup/setConfig' || setCall.method !== 'POST' || setCall.contentType !== 'application/json') {
    throw new Error(`save request: ${JSON.stringify(setCall)}`)
  }
  if (setCall.body !== '{"args":{"fields":{"maxAgeDays":60}}}') throw new Error(`save body: ${JSON.stringify(setCall)}`)
  if (doc.querySelector('.sc-pending')) throw new Error('pending badge must clear after save')
  console.log('card OK: fields render, staged edit saves over POST /session-cleanup/setConfig')

  // 恢复默认 (reset-all) posts to /session-cleanup/resetConfig
  const resetAllButton = [...doc.querySelectorAll('.sc-discard')].find((b) => b.textContent === en.resetAll)
  if (resetAllButton === undefined || resetAllButton.disabled) throw new Error('reset-all must be enabled after save')
  await act(async () => { fireClick(resetAllButton) })
  await waitFor(() => fetchCalls.some((c) => c.url.endsWith('/resetConfig')), 'resetConfig request')
  const resetCall = fetchCalls[fetchCalls.length - 1]
  if (resetCall.url !== '/session-cleanup/resetConfig' || resetCall.method !== 'POST' || resetCall.body !== '{"args":{}}') {
    throw new Error(`reset request: ${JSON.stringify(resetCall)}`)
  }
  console.log('card OK: reset-all posts to /session-cleanup/resetConfig')

  // Per-field validation mirrors the Host schema bounds: intervalMinutes is
  // `z.number().min(1)` there, so a staged 0 must be reported under that field
  // (and keep 保存 blocked) instead of failing only after the Host rejects it.
  const intervalInput = doc.querySelector('#sc-intervalMinutes')
  await act(async () => { fireChange(intervalInput, '0') })
  const invalidText = doc.querySelector('.sc-invalid-text')
  if (invalidText === null || invalidText.textContent !== en.invalidInterval) {
    throw new Error(`intervalMinutes 0 must show its own message, got: ${JSON.stringify(invalidText?.textContent)}`)
  }
  if (!doc.querySelector('#sc-intervalMinutes').classList.contains('sc-invalid')) {
    throw new Error('the offending input must carry the sc-invalid marker')
  }
  const blockedSave = doc.querySelector('.sc-save')
  if (blockedSave === null || !blockedSave.disabled) throw new Error('save must be blocked while a staged field is invalid')
  const setCallsBefore = fetchCalls.filter((c) => c.url.endsWith('/setConfig')).length
  await act(async () => { fireClick(blockedSave) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  if (fetchCalls.filter((c) => c.url.endsWith('/setConfig')).length !== setCallsBefore) {
    throw new Error('an invalid staged field must never reach the setConfig endpoint')
  }
  const discardButton = [...doc.querySelectorAll('.sc-discard')].find((b) => b.textContent === en.discard)
  await act(async () => { fireClick(discardButton) })
  if (doc.querySelector('.sc-invalid-text') !== null) throw new Error('discard must clear the staged invalid value')
  console.log('card OK: per-field validation names the field and blocks the save')

  await act(async () => { root.unmount() })
}

globalThis.fetch = realFetch

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
