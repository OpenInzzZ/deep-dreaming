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
 * `settings.section` page registration (id 'session-cleanup'),
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
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
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
 * `{ kind, path, handler }` plus the live-route count at the first settings
 * `describe()` (used to prove the transport is installed BEFORE the settings
 * bridge, so a throwing settings wiring cannot be mistaken for the reason).
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
function makeCtx({ withSettings, settingsThrows = false, withoutCarrier = false, entry = {} }) {
  const calls = {
    info: [],
    warn: [],
    cleanups: [],
    settingsUpdates: [],
    settingsReplaces: [],
    /** How often the host half read the config document. */
    settingsDescribeCalls: 0,
    /** Every document-change broadcast, for the live-rebuild assertions. */
    settingsEmit: 0,
    /** Listeners the host half attached to `settings/document-updated`. */
    documentListeners: [],
    /** Every dependency list the host half declared *dynamically*, in order. */
    injectLists: [],
    /** Labels of the effects registered through `ctx.effect`, in order. */
    effectLabels: [],
    /** Live route count at the moment the settings document was first read. */
    routesAtSettingsRegister: null,
    /** Set when a throwing settings provider fails the settings child fiber. */
    settingsFailure: undefined,
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
  //
  // 0.2.x's `SettingsForms` has NO `register()`: the section IS the loader
  // entry id, reads ride `describe()` and writes ride `update()` / `replace()`
  // into the configuration document. The double reproduces exactly that face
  // (and rejects a foreign namespace) so the test cannot pass against an API
  // the real Host does not provide.
  let user = {}
  let revision = 0
  const emitDocument = () => {
    revision += 1
    calls.settingsEmit += 1
    for (const listener of [...calls.documentListeners]) listener('session-cleanup', revision)
  }
  calls.fireSettingsChange = emitDocument
  const settingsService = withSettings ? {
    describe: () => {
      calls.settingsDescribeCalls += 1
      if (calls.routesAtSettingsRegister === null) calls.routesAtSettingsRegister = web.routes.length
      if (settingsThrows) throw new Error('settings provider exploded during describe (harness double)')
      return [{
        ns: 'session-cleanup',
        // The real descriptor's `value` is the resolved section: composition
        // entry over schema defaults, with the user document on top.
        value: { ...host.DEFAULTS, ...entry, ...user },
        base: { ...host.DEFAULTS, ...entry },
        user: { ...user },
        revision,
        writable: true,
      }]
    },
    update: async (ns, fields) => {
      if (ns !== 'session-cleanup') throw new Error(`update for foreign namespace ${ns} (harness double)`)
      user = { ...user, ...fields }
      calls.settingsUpdates.push(fields)
      emitDocument()
    },
    replace: async (ns, section) => {
      if (ns !== 'session-cleanup') throw new Error(`replace for foreign namespace ${ns} (harness double)`)
      user = { ...(section ?? {}) }
      calls.settingsReplaces.push(section)
      emitDocument()
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
    // `ctx.on` — the settings bridge listens for document changes. Cordis
    // disposes these with the fiber; the double returns the same disposer.
    on: (event, listener) => {
      if (event !== 'settings/document-updated') return () => {}
      calls.documentListeners.push(listener)
      return () => {
        const at = calls.documentListeners.indexOf(listener)
        if (at >= 0) calls.documentListeners.splice(at, 1)
      }
    },
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
  // 0.2.x's SettingsForms has no register(); a reintroduced call would fail
  // inside the inject child fiber and silently take the write path down again.
  if (/settings\s*\.\s*register\s*\(/.test(hostCode)) {
    throw new Error('the host half must not call settings.register: 0.2.x has no such API (use describe/update/replace)')
  }
  // 载体缺席在真实运行里到不了（静态依赖会先等它绑定），这里断言的是宿主代码
  // 已经没有 undefined 分支：只能响亮地抛，不能悄悄不注册。
  const ctx = makeCtx({ withSettings: true, withoutCarrier: true })
  let carrierFailure = null
  try { host.apply(ctx, { sessionsRoot }) } catch (error) { carrierFailure = error }
  if (!(carrierFailure instanceof Error)) {
    throw new Error('a missing declared carrier must fail loudly, never skip the registration silently')
  }
  if (ctx.web.routes.length !== 0) throw new Error('no route may be registered against a missing carrier')
  // enabled:false 仍注册传输，但拒绝一切删除。
  //
  // 这里与旧版相反：旧版在 apply 开头 `return`，页面于是整块消失；现在的要求
  // 是「关掉后不列出也不允许删除」，页面必须能把这件事说出来，所以路由照样
  // 落地，由端点自己按 `enabled` 拒绝。
  // The settings double resolves its descriptor from `host.DEFAULTS` over the
  // composition entry, exactly like the real `describe()`. The entry therefore
  // has to be handed to BOTH `makeCtx` and `apply`, or the double would report
  // the schema default `enabled: true` for a composition that says `false`.
  const offEntry = { enabled: false, sessionsRoot }
  const off = makeCtx({ withSettings: true, entry: offEntry })
  if (host.apply(off, offEntry) !== undefined) {
    throw new Error('a disabled apply must return undefined')
  }
  if (off.web.routes.length !== 1) {
    throw new Error(`enabled:false must still install the transport so the page can explain why, got ${off.web.routes.length} route(s)`)
  }
  const offRoute = routeOf(off)
  const offList = await callEndpoint(offRoute, 'listArchived')
  if (!offList.ok || offList.value.disabled !== true || offList.value.items.length !== 0) {
    throw new Error(`a disabled plugin must list nothing and say so: ${JSON.stringify(offList)}`)
  }
  const offDelete = await callEndpoint(offRoute, 'deleteArchived', { args: { ids: ['session-anything'] } })
  assertErrorEnvelope('disabled delete', offDelete)
  if (offDelete.error.code !== 'disabled') {
    throw new Error(`a disabled plugin must refuse deletion: ${JSON.stringify(offDelete)}`)
  }
  dispose(off)
  console.log(`host inject OK: static inject = ${JSON.stringify(host.inject)} (no ctx.get race, missing carrier throws, enabled:false keeps the transport but refuses deletion)`)
}

// 1) no settings service -> entry config drives the endpoints, the route works
{
  const entry = { enabled: true, sessionsRoot }
  const ctx = makeCtx({ withSettings: false })
  ctx.calls.info = ctx.calls.info ?? []
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
  // 装载后什么都不该自己跑一遍：自动清理已移除，插件只被动响应请求。
  if (ctx.calls.info.length !== 0) {
    throw new Error(`loading must not run any cleanup by itself, got ${JSON.stringify(ctx.calls.info)}`)
  }
  if (ctx.calls.settingsDescribeCalls !== 0) throw new Error('no settings service must not read a settings document')
  if (ctx.web.routes.length !== 1) throw new Error(`exactly one route must be registered, got ${ctx.web.routes.length}`)
  // 路由由恰好一个 effect 持有 —— 卸载时就是它把路由放掉的（下面 dispose 验）。
  const routeEffects = ctx.calls.effectLabels.filter((label) => label !== null && label.includes('rpc route'))
  if (routeEffects.length !== 1) {
    throw new Error(`the route must be held by exactly one labelled effect, got ${JSON.stringify(ctx.calls.effectLabels)}`)
  }
  const route = routeOf(ctx)
  const got = await callEndpoint(route, 'getConfig')
  if (!got.ok || got.value.enabled !== true || got.value.sessionsRoot !== sessionsRoot) {
    throw new Error(`getConfig without settings: ${JSON.stringify(got)}`)
  }
  const list = await callEndpoint(route, 'listArchived')
  if (!list.ok || !Array.isArray(list.value.items)) throw new Error(`listArchived without settings: ${JSON.stringify(list)}`)
  const set = await callEndpoint(route, 'setConfig', { args: { fields: { enabled: false } } })
  if (set.ok || set.error.code !== 'settings-unavailable') {
    throw new Error(`setConfig without settings must report settings-unavailable: ${JSON.stringify(set)}`)
  }
  const reset = await callEndpoint(route, 'resetConfig')
  if (reset.ok || reset.error.code !== 'settings-unavailable') {
    throw new Error(`resetConfig without settings must report settings-unavailable: ${JSON.stringify(reset)}`)
  }
  const unknown = await callEndpoint(route, 'nope')
  // An unknown endpoint is a request error regardless of whether settings is
  // wired — the endpoint table is checked before the settings-only endpoints.
  assertErrorEnvelope('unknown endpoint without settings', unknown)
  if (unknown.error.code !== 'bad-request') {
    throw new Error(`an unknown endpoint must report bad-request here: ${JSON.stringify(unknown)}`)
  }
  const before = ctx.calls.info.length
  dispose(ctx)
  if (ctx.web.routes.length !== 0) throw new Error('dispose must remove the /session-cleanup route')
  if (ctx.web.disposeCount() !== 1) throw new Error(`dispose must run the route disposer, ran ${ctx.web.disposeCount()}`)
  if (ctx.calls.info.length !== before) {
    throw new Error('dispose must not start any work')
  }
  console.log('host OK: entry-config fallback (no settings), nothing runs on load, /session-cleanup prefix route + unload guards')
}

// 1b) the transport fence, driven through the real route
{
  const ctx = makeCtx({ withSettings: true })
  host.apply(ctx, { sessionsRoot })
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

// 2) settings service -> the document layer overrides the entry config and the
//    route writes through it. There is no timer any more, so the old
//    "document change rebuilds the timer" assertions are replaced by "a
//    document change is picked up by the next read".
{
  const entry = { enabled: true, sessionsRoot }
  const ctx = makeCtx({ withSettings: true, entry })
  host.apply(ctx, entry)
  await settle()
  if (ctx.calls.settingsDescribeCalls === 0) throw new Error('the settings document was never read')
  if (ctx.calls.routesAtSettingsRegister !== 1) {
    throw new Error(`the route must already be live when settings is wired, saw ${ctx.calls.routesAtSettingsRegister} route(s)`)
  }
  // Loading itself must not run anything.
  if (ctx.calls.info.length !== 0) {
    throw new Error(`loading must not run any cleanup by itself: ${JSON.stringify(ctx.calls.info)}`)
  }

  const route = routeOf(ctx)
  const set = await callEndpoint(route, 'setConfig', { args: { fields: { enabled: false } } })
  if (!set.ok || set.value.enabled !== false) throw new Error(`setConfig through the document: ${JSON.stringify(set)}`)
  if (ctx.calls.settingsUpdates.length !== 1 || ctx.calls.settingsUpdates[0].enabled !== false) {
    throw new Error(`settings update not written: ${JSON.stringify(ctx.calls.settingsUpdates)}`)
  }
  // The write landed in the document, so the next read reflects it: nothing had
  // to restart, because there is nothing left to restart.
  const afterSet = await callEndpoint(route, 'listArchived')
  if (!afterSet.ok || afterSet.value.disabled !== true) {
    throw new Error(`the disabled flag must take effect on the next read: ${JSON.stringify(afterSet)}`)
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
  // 恢复默认 resolves the composition entry again (the user layer is cleared).
  if (reset.value.enabled !== true) throw new Error(`resetConfig must fall back to the entry config: ${JSON.stringify(reset)}`)

  dispose(ctx)
  if (ctx.web.routes.length !== 0) throw new Error('dispose must remove the route')
  if (ctx.calls.info.length !== 0) throw new Error('dispose must not run any cleanup')
  // A document event arriving after teardown must be guarded, not crash.
  ctx.calls.fireSettingsChange()
  await new Promise((resolve) => setTimeout(resolve, 50))
  console.log('host OK: settings document read/write + next-read refresh + no background work + isUnloading guard')
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
  try { host.apply(ctx, { sessionsRoot }) } catch (error) { applyFailure = error }
  if (applyFailure !== null) throw new Error(`apply must not throw: ${applyFailure?.stack}`)
  if (!(ctx.calls.settingsFailure instanceof Error)) {
    throw new Error('the harness must have delivered the settings failure into the child fiber')
  }
  if (ctx.calls.routesAtSettingsRegister !== 1) {
    throw new Error(`the route must already be live when the settings bridge runs, saw ${ctx.calls.routesAtSettingsRegister} route(s)`)
  }
  if (ctx.web.routes.length !== 1) throw new Error(`the route must still be live, got ${ctx.web.routes.length}`)
  const route = routeOf(ctx)
  const got = await callEndpoint(route, 'getConfig')
  // A settings provider that cannot describe leaves the ENTRY config in charge.
  if (!got.ok || got.value.enabled !== true) {
    throw new Error(`the entry-config fallback must still answer getConfig: ${JSON.stringify(got)}`)
  }
  const set = await callEndpoint(route, 'setConfig', { args: { fields: { enabled: false } } })
  if (set.ok || set.error.code !== 'settings-unavailable') {
    throw new Error(`setConfig must degrade with settings-unavailable: ${JSON.stringify(set)}`)
  }
  dispose(ctx)
  console.log('host fail-soft OK: a throwing settings describe leaves the /session-cleanup route fully usable')
}

// 2c) same wiring, measured instead of inferred: the settings document must be
//     first read while the route is ALREADY live (Cordis rolls back every
//     effect registered before a throw in the same inject callback).
{
  const ctx = makeCtx({ withSettings: true })
  host.apply(ctx, { sessionsRoot })
  await settle()
  if (ctx.calls.routesAtSettingsRegister !== 1) {
    throw new Error(`the route must be live before the settings document is read, saw ${ctx.calls.routesAtSettingsRegister} route(s)`)
  }
  dispose(ctx)
  console.log('host order OK: the /session-cleanup route is installed before the settings bridge')
}

rmSync(sessionsRoot, { recursive: true, force: true })

/**
 * Archive-set double: the real registry exposes `archivedSessionIds` as a
 * getter and `unarchiveSession(id)` as a durable write, and the host half now
 * calls the latter after a successful delete.
 */
const makeRegistry = (initial) => {
  let archived = [...initial]
  return {
    get archivedSessionIds() { return archived },
    async unarchiveSession(id) { archived = archived.filter((entry) => entry !== id) },
  }
}
// --- client half: bundle + contract checks --------------------------------------
// `React` / `JSDOM` come from `scripts/test-deps.mjs`; jsdom stays the only
// section-level gate.
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
    return {
      IconChevronDownOutlineMedium: icon,
      IconTrashOutlineMedium: icon,
      // The confirm dialog is a Modal in the shipped shell; the double renders
      // its children inline so the jsdom flow can drive it.
      Modal: ({ open, title, children, footer }) => (open
        ? React.createElement('div', { 'data-modal': title }, children, footer)
        : null),
    }
  }
  throw new Error(`unexpected module-table word: ${spec}`)
}
const exports_ = handoff.factory(requireTable)
if (typeof exports_.apply !== 'function' || !Array.isArray(exports_.inject)) throw new Error('exports contract broken')
if (exports_.NS !== 'session-cleanup.card') throw new Error(`NS mismatch: ${exports_.NS}`)
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

// Regression guards on the SOURCE, because the failure modes below are silent:
// a registration on an undeclared slot waits forever and renders nowhere.
{
  const source = readFileSync(clientPath, 'utf8')
  if (!/settings\.section/.test(source)) {
    throw new Error('the card must register on the shipped `settings.section` page slot')
  }
  if (/['"]settings\.plugin\.item['"]/.test(source)) {
    throw new Error('the card must not register on the retired `settings.plugin.item` slot')
  }
  if (!/sidebar\.workspaces\.session\.menu\.item/.test(source)) {
    throw new Error('the session-row menu entry must register on `sidebar.workspaces.session.menu.item`')
  }
  console.log('slot source OK: settings.section + sidebar.workspaces.session.menu.item, never the retired settings.plugin.item')
}

// Card CSS must only reference theme aliases the shipped theme actually defines:
// an undefined var() silently drops its declaration.
for (const dead of ['--dsw-alias-label-on-brand', '--dsw-alias-label-error']) {
  if (bundleSource.includes(dead)) throw new Error(`card CSS references an undefined theme alias: ${dead}`)
}

let registered = null
const menuRegistered = []
let dictionaries = null

/**
 * `fetch` double, wired to the REAL host route, so every client call exercises
 * the two halves' shared contract rather than a hand-written envelope.
 */
const fetchCalls = []
let fetchMode = { networkError: null }
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
    inject: (key, callback) => {
      const entry = callback()
      entry.slot = key
      if (key === 'settings.section') registered = entry
      else menuRegistered.push(entry)
    },
    register: (options, component) => ({ ...options, component }),
  },
}

// Archive fixture: the host half installed for the client section lists these
// from a temp sessions root, so the client literally renders what the Host says.
const clientRoot = mkdtempSync(join(tmpdir(), 'cleanup-client-'))
const archA = 'session-ver-a'
const archB = 'session-ver-b'
for (const [project, id] of [['p1', archA], ['p2', archB]]) {
  mkdirSync(join(clientRoot, project, id), { recursive: true })
  writeFileSync(join(clientRoot, project, id, 'session.v4.jsonl.zstd'), Buffer.alloc(2048, 0x61))
}

const cardEntry = { enabled: true, sessionsRoot: clientRoot }
const fetchCtx = makeCtx({ withSettings: true, entry: cardEntry })
fetchCtx.sessions.list = () => []
fetchCtx.workspaceRegistry = makeRegistry([archA, archB])
host.apply(fetchCtx, cardEntry)
await settle()
activeCtx = fetchCtx

exports_.apply(clientCtx)
if (registered === null) throw new Error('settings.section was never registered')
if (menuRegistered.length !== 1) throw new Error(`the session menu entry must register exactly once, got ${menuRegistered.length}`)

// The settings page claims the slot the shipped shell declares.
if (registered.slot !== 'settings.section' || registered.name !== 'settings.section') {
  throw new Error(`card registration mismatch: ${JSON.stringify({ slot: registered.slot, name: registered.name })}`)
}
if (registered.id !== 'session-cleanup') throw new Error(`card id mismatch: ${JSON.stringify(registered.id)}`)
if (typeof registered.label !== 'function' || registered.label() !== 't:title') {
  throw new Error(`the label must be a thunk resolving through this plugin's dictionary: ${JSON.stringify(registered.label?.())}`)
}
for (const fn of ['getConfig', 'setConfig', 'resetConfig', 'listArchived', 'deleteArchived']) {
  if (typeof registered.inject()[fn] !== 'function') throw new Error(`the card must receive ${fn} through its inject thunk`)
}

// The session-row menu entry claims its slot with a stable id and order.
const menu = menuRegistered[0]
if (menu.name !== 'sidebar.workspaces.session.menu.item') {
  throw new Error(`menu registration name must match the slot: ${JSON.stringify(menu.name)}`)
}
if (menu.id === undefined || typeof menu.order !== 'number') {
  throw new Error(`menu registration must carry an id and order: ${JSON.stringify({ id: menu.id, order: menu.order })}`)
}

if (dictionaries === null || dictionaries.ns !== exports_.NS) throw new Error('dictionaries not registered')
const zhKeys = Object.keys(dictionaries.dicts.zh)
const enKeys = Object.keys(dictionaries.dicts.en)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  throw new Error(`zh/en key mismatch:\nzh: ${zhKeys}\nen: ${enKeys}`)
}
console.log(`apply contract OK: settings.section id=session-cleanup label=thunk | menu id=${menu.id} order=${menu.order} | dict keys = ${zhKeys.length}`)

// The client must not depend on the Connection RPC surface any more.
if (exports_.inject.includes('connection')) throw new Error(`exports.inject still requires connection: ${JSON.stringify(exports_.inject)}`)
if (/\bctx\.connection\b/.test(bundleSource)) throw new Error('the bundle still accesses ctx.connection')
if (/\bconnection\.rpc\b/.test(bundleSource)) throw new Error('the bundle still calls ctx.connection.rpc')

// cardApi flow: the card reads the list and deletes over the real host route.
{
  const api = registered.inject()
  const cfg = await api.getConfig()
  if (cfg.enabled !== true) throw new Error(`cardApi getConfig: ${JSON.stringify(cfg)}`)
  // The removed automatic-cleanup knobs must not come back.
  for (const gone of ['maxAgeDays', 'maxTotalMB', 'keepSessions', 'intervalMinutes', 'dryRun']) {
    if (gone in cfg) throw new Error(`config must no longer expose ${gone}: ${JSON.stringify(cfg)}`)
  }
  const listing = await api.listArchived()
  if (listing.items.length !== 2) throw new Error(`cardApi listArchived: ${JSON.stringify(listing)}`)
  if (!(listing.totalBytes >= 4096)) throw new Error(`listing must report sizes: ${JSON.stringify(listing)}`)

  const before = fetchCalls.length
  const result = await api.deleteArchived([archA])
  if (result.removed.length !== 1 || result.removed[0].id !== archA) {
    throw new Error(`cardApi deleteArchived: ${JSON.stringify(result)}`)
  }
  const call = fetchCalls[fetchCalls.length - 1]
  if (call.url !== '/session-cleanup/deleteArchived' || call.method !== 'POST' || call.contentType !== 'application/json') {
    throw new Error(`deleteArchived fetch: ${JSON.stringify(call)}`)
  }
  if (call.body !== JSON.stringify({ args: { ids: [archA] } })) {
    throw new Error(`deleteArchived body: ${JSON.stringify(call.body)}`)
  }
  // The fixture directory is really gone, proving the two halves agree.
  let stillThere = true
  try { readdirSync(join(clientRoot, 'p1', archA)) } catch { stillThere = false }
  if (stillThere) throw new Error('the archived session directory must be gone after deleteArchived')
  if (fetchCalls.length - before !== 1) {
    throw new Error(`deleteArchived must issue exactly one request, issued ${fetchCalls.length - before}`)
  }
  console.log('cardApi OK: listArchived/deleteArchived POST to /session-cleanup/<endpoint> and are answered by the host route')
}

// Failure branches must all reject with an Error so the card can report it.
{
  const api = registered.inject()
  fetchMode = { networkError: 'connection refused' }
  let netFailure = null
  try { await api.listArchived() } catch (error) { netFailure = error }
  if (netFailure === null || !netFailure.message.includes('connection refused')) {
    throw new Error(`a dead network must reject: ${JSON.stringify(netFailure)}`)
  }
  fetchMode = { networkError: null, forceStatus: 500 }
  let httpFailure = null
  try { await api.listArchived() } catch (error) { httpFailure = error }
  if (httpFailure === null || !httpFailure.message.includes('HTTP 500')) {
    throw new Error(`a 500 must reject with the status: ${JSON.stringify(httpFailure)}`)
  }
  fetchMode = { networkError: null, forceStatus: 200, forceEnvelope: { ok: false, error: { code: 'disabled', message: 'turned off', details: {} } } }
  let envelopeFailure = null
  try { await api.deleteArchived([archB]) } catch (error) { envelopeFailure = error }
  if (envelopeFailure === null || envelopeFailure.code !== 'disabled') {
    throw new Error(`a failed envelope must carry .code: ${JSON.stringify(envelopeFailure)}`)
  }
  fetchMode = { networkError: null }
  fetchCalls.length = 0
  console.log('cardApi OK: transport failures reject (network / HTTP 500 / failed envelope with .code)')
}

// --- render + interact (jsdom; skipped when jsdom is missing) --------------------
if (JSDOM === null) {
  console.log('client DOM sections SKIPPED (react/jsdom not resolvable; run `npm install` in the repository root or set DSH_TEST_DEPS)')
} else {
  const { act } = React
  const { createRoot } = uiRequire('react-dom/client')
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const en = dictionaries.dicts.en
  const t = (key, params) => {
    const text = en[key]
    if (text === undefined) return key
    if (params === undefined) return text
    return text.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole))
  }
  const doc = dom.window.document

  // A pristine host half for the render flow.
  fetchCalls.length = 0
  const renderRoot = mkdtempSync(join(tmpdir(), 'cleanup-render-'))
  const rA = 'session-render-a'
  const rB = 'session-render-b'
  for (const [project, id] of [['p1', rA], ['p2', rB]]) {
    mkdirSync(join(renderRoot, project, id), { recursive: true })
    writeFileSync(join(renderRoot, project, id, 'session.v4.jsonl.zstd'), Buffer.alloc(4096, 0x61))
  }
  const renderEntry = { enabled: true, sessionsRoot: renderRoot }
  const domCtx = makeCtx({ withSettings: true, entry: renderEntry })
  domCtx.sessions.list = () => []
  domCtx.workspaceRegistry = makeRegistry([rA, rB])
  host.apply(domCtx, renderEntry)
  await settle()
  activeCtx = domCtx

  const fireClick = (el) => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
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

  await act(async () => { fireClick(doc.querySelector('.sc-header')) })
  await waitFor(() => doc.querySelectorAll('.sc-row').length > 0, 'the archived session list')

  const rows = [...doc.querySelectorAll('.sc-row')]
  if (rows.length !== 2) throw new Error(`expected 2 archived rows, got ${rows.length}`)
  const checkboxes = [...doc.querySelectorAll('.sc-check[type="checkbox"]')]
  if (checkboxes.length !== 2) throw new Error(`expected 2 selectable rows, got ${checkboxes.length}`)

  // The card must not offer any automatic-cleanup knob any more.
  for (const dead of ['#sc-maxAgeDays', '#sc-maxTotalMB', '#sc-keepSessions', '#sc-intervalMinutes', '#sc-dryRun']) {
    if (doc.querySelector(dead) !== null) throw new Error(`the automatic-cleanup field ${dead} must be gone`)
  }

  // Selecting a row reveals the bulk delete action.
  await act(async () => { fireClick(checkboxes[0]) })
  await waitFor(() => [...doc.querySelectorAll('.sc-danger')].some((b) => b.textContent.startsWith(en.deleteSelected)), 'bulk delete')

  // Deleting asks first: the confirmation names the directory and the warning.
  const bulk = [...doc.querySelectorAll('.sc-danger')].find((b) => b.textContent.startsWith(en.deleteSelected))
  await act(async () => { fireClick(bulk) })
  await waitFor(() => doc.querySelector('[data-modal]') !== null, 'the confirmation dialog')
  const modal = doc.querySelector('[data-modal]')
  if (!modal.textContent.includes(en.confirmWarn)) throw new Error('the dialog must warn that deletion is irreversible')
  if (!modal.textContent.includes(en.confirmIntro)) throw new Error('the dialog must state what is deleted')
  const deletesBeforeConfirm = fetchCalls.filter((c) => c.url.endsWith('/deleteArchived')).length
  if (deletesBeforeConfirm !== 0) throw new Error('opening the dialog must not delete anything')

  // Cancelling leaves everything alone.
  const cancelButton = [...modal.querySelectorAll('button')].find((b) => b.textContent === en.confirmCancel)
  if (cancelButton === undefined) throw new Error('the dialog must offer a cancel action')
  await act(async () => { fireClick(cancelButton) })
  await waitFor(() => doc.querySelector('[data-modal]') === null, 'the dialog to close')
  if (fetchCalls.filter((c) => c.url.endsWith('/deleteArchived')).length !== 0) {
    throw new Error('cancelling must not delete anything')
  }
  console.log('card OK: archived sessions render, selecting shows bulk delete, and the dialog asks before deleting')

  // Confirming really deletes, and the list refreshes. Only THIS section's new
  // requests count: `fetchCalls` still holds the earlier cardApi section's, and
  // matching those would assert against a different sessions root.
  const deletesBefore = fetchCalls.filter((c) => c.url.endsWith('/deleteArchived')).length
  await act(async () => { fireClick([...doc.querySelectorAll('.sc-danger')].find((b) => b.textContent.startsWith(en.deleteSelected))) })
  await waitFor(() => doc.querySelector('[data-modal]') !== null, 'the dialog again')
  const confirmButton = [...doc.querySelectorAll('[data-modal] button')].find((b) => b.textContent === en.confirmDelete)
  if (confirmButton === undefined) throw new Error('the dialog must offer a permanent-delete action')
  await act(async () => { fireClick(confirmButton) })
  await waitFor(() => fetchCalls.filter((c) => c.url.endsWith('/deleteArchived')).length > deletesBefore, 'the deleteArchived request')
  const delCall = fetchCalls.filter((c) => c.url.endsWith('/deleteArchived'))[deletesBefore]
  if (delCall.method !== 'POST' || delCall.contentType !== 'application/json') {
    throw new Error(`delete request: ${JSON.stringify(delCall)}`)
  }
  if (!delCall.body.includes(rA)) {
    throw new Error(`the delete must target this section's fixture (${rA}), got: ${delCall.body}`)
  }
  // The whole session directory must be gone from THIS section's root.
  await waitFor(() => {
    try { readdirSync(join(renderRoot, 'p1', rA)); return false } catch { return true }
  }, 'the archived session directory to disappear')
  // The deleted session must also leave the archive set: a directory that is
  // gone while its id stays archived shows up forever as an undeletable ghost.
  await waitFor(() => !domCtx.workspaceRegistry.archivedSessionIds.includes(rA), 'the session to be unarchived')
  await waitFor(() => doc.querySelectorAll('.sc-row').length === 1, 'the list to shrink to one row')
  console.log('card OK: confirming deletes the directory over POST /session-cleanup/deleteArchived, unarchives it, and refreshes the list')

  await act(async () => { root.unmount() })
  rmSync(renderRoot, { recursive: true, force: true })
}

rmSync(clientRoot, { recursive: true, force: true })
globalThis.fetch = realFetch

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
