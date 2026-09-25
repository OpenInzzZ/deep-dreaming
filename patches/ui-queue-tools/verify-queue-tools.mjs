/**
 * Functional harness for the user-level ui-queue-tools patch.
 *
 * Host half: imports the real `lib/index.js`, applies it to a mock Cordis
 * context (fake `webServer` carrier + fake agents) and exercises the `/queue`
 * contract — the prefix route's fence (cross-origin 403 / non-POST 405 /
 * non-JSON 415 / unknown endpoint 404) driven through a fake `req`/`res`, plus
 * the reorder semantics against a mock Inbox with real splice behavior. The
 * plugin declares its services STATICALLY (`export const inject`), so the mock
 * hands them over as plain `ctx.*` properties and fails the run whenever
 * `apply` reaches for a dynamic `ctx.inject(...)` or for the optional
 * `ctx.get('webServer')` read: the dynamic form lost the transport on user-layer
 * hot reload (the child fiber is never re-activated) and the optional read races
 * the carrier's binding (it saw `undefined` and skipped registration silently).
 * Real-Cordis semantics — incl. "a late carrier still activates the transport"
 * and `TypeError('Invalid effect')` on a returned fiber — are covered by the
 * authoritative tests/load-smoke.mjs, which this harness mirrors with mocks.
 *
 * Client half: loads the exact deployed `lib/client.js` the browser will
 * execute and asserts the shadow registration (same slot id, lower priority)
 * plus the dictionary key parity. The host is reached with a module-level
 * `fetch` (NOT `ctx.connection.rpc.call`), so a `fetch` double records every
 * request (URL/method/content-type/body) and serves the `{ ok, value }` /
 * `{ ok, error }` envelope the real route answers. The jsdom render/interaction
 * checks (full-text hover tooltip, drag reorder, the two failure toasts,
 * multiline edit, single-row affordance) run only when `react`+`jsdom` and
 * `@testing-library/react` resolve; otherwise those interaction checks are
 * skipped with a notice. The DOM-free contract checks always run.
 *
 * No hardcoded machine paths: dependency resolution goes through
 * `scripts/test-deps.mjs` (repo node_modules → $NODE_PATH → the deployed
 * profile trees → $DSH_TEST_DEPS).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { createUiRequire, loadDomDeps, resolveUiModule } from '../../scripts/test-deps.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const hostPath = join(here, 'lib', 'index.js')
const clientPath = join(here, 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-client-ui-queue-tools'

// Browser packages (react / jsdom / @testing-library/react) come from the shared
// resolver: the repository's own node_modules first, then $NODE_PATH, the
// deployed profile trees and $DSH_TEST_DEPS — every anchor derived, so this
// harness carries no machine-specific absolute path.
const uiRequire = createUiRequire(import.meta.url)
const domDeps = loadDomDeps(import.meta.url)
const React = domDeps.React
const JSDOM = domDeps.JSDOM
const testingLibraryPath = resolveUiModule('@testing-library/react', import.meta.url)
const domAvailable = domDeps.available && testingLibraryPath !== undefined
if (!domDeps.available) console.warn(`SKIP DOM checks: ${domDeps.hint}`)

// --- host half: /queue channel + reorder semantics ----------------------------
const host = await import(pathToFileURL(hostPath).href)

function makeInbox(ids, stepIds = []) {
  const nextTurn = ids.map((id) => ({ id }))
  const nextStep = stepIds.map((step) => (typeof step === 'string' ? { id: step } : step))
  return {
    nextTurn,
    nextStep,
    splice(target, start, deleteCount, inserted) {
      const list = target === 'next-turn' ? this.nextTurn : this.nextStep
      const removed = list.splice(start, deleteCount, ...inserted)
      return removed
    },
  }
}

/** Same shape, but the numbered splice calls in `failAt` throw instead of
 *  mutating — the harness stand-in for an Inbox whose durable append fails. */
function makeFailingInbox(ids, failAt) {
  const nextTurn = ids.map((id) => ({ id }))
  return {
    nextTurn,
    nextStep: [],
    splices: 0,
    splice(target, start, deleteCount, inserted) {
      this.splices += 1
      if (failAt.includes(this.splices)) throw new Error(`inbox splice #${this.splices} refused`)
      const list = target === 'next-turn' ? this.nextTurn : this.nextStep
      return list.splice(start, deleteCount, ...inserted)
    },
  }
}

// reorderQueueItem unit checks (each scenario uses a fresh inbox)
{
  let inbox = makeInbox(['a', 'b', 'c'])
  let r = host.reorderQueueItem({ inbox }, 'a', 1)
  if (!r.ok || inbox.nextTurn.map((m) => m.id).join('') !== 'bac') throw new Error(`down-move: ${JSON.stringify(inbox.nextTurn)}`)

  inbox = makeInbox(['a', 'b', 'c'])
  r = host.reorderQueueItem({ inbox }, 'c', 1)
  if (!r.ok || inbox.nextTurn.map((m) => m.id).join('') !== 'acb') throw new Error(`up-move: ${JSON.stringify(inbox.nextTurn)}`)

  inbox = makeInbox(['a', 'b', 'c'])
  r = host.reorderQueueItem({ inbox }, 'c', 0)
  if (!r.ok || inbox.nextTurn.map((m) => m.id).join('') !== 'cab') throw new Error(`move-top: ${JSON.stringify(inbox.nextTurn)}`)

  inbox = makeInbox(['a', 'b', 'c'])
  r = host.reorderQueueItem({ inbox }, 'a', 99)
  if (!r.ok || inbox.nextTurn.map((m) => m.id).join('') !== 'bca') throw new Error(`move-bottom: ${JSON.stringify(inbox.nextTurn)}`)

  inbox = makeInbox(['a', 'b', 'c'])
  r = host.reorderQueueItem({ inbox }, 'nope', 0)
  if (r.ok || r.error.code !== 'queue-item-not-found') throw new Error('missing item must be not-found')

  inbox = makeInbox(['x'])
  r = host.reorderQueueItem({ inbox }, 'x', 0)
  if (!r.ok || inbox.nextTurn.map((m) => m.id).join('') !== 'x') throw new Error('single-item no-op')

  inbox = makeInbox([])
  inbox.nextStep.push({ id: 's1' })
  r = host.reorderQueueItem({ inbox }, 's1', 0)
  if (!r.ok || inbox.nextStep.map((m) => m.id).join('') !== 's1') throw new Error('next-step item no-op reorder')
  console.log('reorderQueueItem OK: down/up/top/bottom/not-found/no-op/next-step')
}

// Placement guard: `toIndex` is relative to ONE list, so the caller must
// declare which placement it sorted and an item pending in another list is
// refused instead of being reordered against foreign indices.
{
  let inbox = makeInbox(['a', 'b', 'c'])
  let r = host.reorderQueueItem({ inbox }, 'a', 1, 'queued')
  if (!r.ok || inbox.nextTurn.map((m) => m.id).join('') !== 'bac') throw new Error('a declared queued placement must reorder')
  if (r.value.target !== 'next-turn' || r.value.placement !== 'queued' || r.value.to !== 1) {
    throw new Error(`success value must report the operated list: ${JSON.stringify(r.value)}`)
  }

  inbox = makeInbox(['a', 'b', 'c'])
  r = host.reorderQueueItem({ inbox }, 'a', 2, 'steering')
  if (r.ok || r.error.code !== 'queue-item-placement-mismatch') throw new Error(`foreign placement must be refused: ${JSON.stringify(r)}`)
  if (r.error.details.expected !== 'steering' || r.error.details.actual !== 'queued' || r.error.details.target !== 'next-turn') {
    throw new Error(`mismatch details: ${JSON.stringify(r.error.details)}`)
  }
  if (inbox.nextTurn.map((m) => m.id).join('') !== 'abc') throw new Error('a refused reorder must leave the list untouched')

  // A next-step item renders as steering/context, never as the dock's queued rows.
  inbox = makeInbox([], [{ id: 's1', source: { kind: 'user' } }, { id: 's2', source: { kind: 'user' } }])
  r = host.reorderQueueItem({ inbox }, 's1', 1, 'queued')
  if (r.ok || r.error.code !== 'queue-item-placement-mismatch') throw new Error('a next-step item must be refused for the queued list')
  if (inbox.nextStep.map((m) => m.id).join('') !== 's1s2') throw new Error('a refused next-step reorder must not move the item')

  inbox = makeInbox([], [{ id: 's1', source: { kind: 'user' } }, { id: 's2', source: { kind: 'user' } }])
  r = host.reorderQueueItem({ inbox }, 's1', 1, 'steering')
  if (!r.ok || r.value.placement !== 'steering' || inbox.nextStep.map((m) => m.id).join('') !== 's2s1') {
    throw new Error(`a declared steering placement must reorder next-step: ${JSON.stringify(inbox.nextStep)}`)
  }

  inbox = makeInbox([], [{ id: 'ctx1' }])
  r = host.reorderQueueItem({ inbox }, 'ctx1', 0, 'context')
  if (!r.ok || r.value.placement !== 'context') throw new Error(`a non-user next-step item renders as context: ${JSON.stringify(r)}`)
  console.log('placement guard OK: declared placement validated, foreign list refused, operated placement returned')
}

// Atomicity: a splice the inbox refuses must never lose the message. The
// removal already committed when the insertion fails, so the only copy left is
// the detached array — it must be restored, and success must never be reported.
{
  const refusedInsert = makeFailingInbox(['a', 'b', 'c'], [2])
  const r = host.reorderQueueItem({ inbox: refusedInsert }, 'a', 2, 'queued')
  if (r.ok) throw new Error('a refused insertion must not report success')
  if (r.error.code !== 'queue-reorder-failed') throw new Error(`refused insertion code: ${r.error.code}`)
  if (r.error.details.restored !== true) throw new Error('the restore must be reported as restored:true')
  if (refusedInsert.nextTurn.map((m) => m.id).join('') !== 'abc') {
    throw new Error(`message lost after a refused insertion: ${JSON.stringify(refusedInsert.nextTurn)}`)
  }
  if (refusedInsert.splices !== 3) throw new Error(`expected remove+insert+restore, got ${refusedInsert.splices} splices`)

  // A stale index whose removal matches nothing is a not-found, never a blind insert.
  let inserts = 0
  const staleInbox = {
    nextTurn: [{ id: 'a' }],
    nextStep: [],
    splice(target, start, deleteCount, inserted) {
      if (deleteCount === 0) inserts += 1
      return []
    },
  }
  const staleResult = host.reorderQueueItem({ inbox: staleInbox }, 'a', 0, 'queued')
  if (staleResult.ok || staleResult.error.code !== 'queue-item-not-found') throw new Error('an empty removal must be not-found')
  if (inserts !== 0) throw new Error('a failed removal must not be followed by an insert')

  // When the restoring splice fails too, the failure is still reported (never a
  // phantom success); restored:false marks the message the inbox did not take back.
  const doomed = makeFailingInbox(['a', 'b'], [2, 3])
  const doomedResult = host.reorderQueueItem({ inbox: doomed }, 'a', 1, 'queued')
  if (doomedResult.ok || doomedResult.error.code !== 'queue-reorder-failed') throw new Error('a double splice failure must fail')
  if (doomedResult.error.details.restored !== false) throw new Error('a failed restore must be reported as restored:false')
  console.log('atomic reorder OK: refused insertion restores the message, never a phantom success')
}

// --- host half: the `/queue` prefix route + its fence -------------------------
/** `webServer` double: records every register() as { kind, path, handler }. */
function makeWebServerStub() {
  const routes = []
  const disposers = []
  return {
    routes,
    disposed: () => disposers.filter((entry) => entry.disposed).map((entry) => entry.path),
    register: (route) => {
      const entry = { kind: route.kind, path: route.path, handler: route.handler, disposed: false }
      routes.push(entry)
      const dispose = () => {
        entry.disposed = true
        const at = routes.indexOf(entry)
        if (at >= 0) routes.splice(at, 1)
      }
      disposers.push(entry)
      return dispose
    },
  }
}

/** Fake server request: a real header bag plus an async `data`/`end` stream. */
function makeReq({ method = 'POST', url = '/queue/reorder', headers = {} } = {}) {
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
    /** Deliver `text` as one chunk, then end the request (one microtask later,
     *  so handler-attached listeners exist exactly like they do on the wire). */
    async send(text) {
      await Promise.resolve()
      if (destroyed) return
      for (const listener of listeners.data) listener(text)
      for (const listener of listeners.end) listener()
      await Promise.resolve()
    },
  }
}

/** Fake server response: captures status, headers and the body it was ended with. */
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

/**
 * Drive one registered route exactly like the web carrier does: real writeHead /
 * end capture, JSON body, and the low-level headers the fence reads.
 * @returns {Promise<{status:number, headers:object, body:string, envelope:any}>}
 */
async function callRoute(route, {
  method = 'POST',
  url = '/queue/reorder',
  headers = {},
  body = '{}',
} = {}) {
  const res = makeRes()
  const req = makeReq({ method, url, headers })
  route.handler(req, res)
  await req.send(body)
  // The endpoint handler is async: poll for the response instead of assuming
  // one macrotask is enough.
  const deadline = Date.now() + 5000
  while (!res.writableEnded && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  let envelope = null
  try { envelope = JSON.parse(res.body) } catch { envelope = null }
  return { status: res.status, headers: res.headers, body: res.body, envelope }
}

const FENCE_HEADERS = { host: '127.0.0.1:3080', 'content-type': 'application/json' }

const fakeAgents = { get: () => undefined }

const hostSource = readFileSync(hostPath, 'utf8')
// 形状检查只看真正的代码：宿主半的文档注释里点名了两种被淘汰的写法
// （`ctx.inject(...)` 与 `ctx.get('webServer')`），不先剥掉注释就会自己误伤。
const hostCode = hostSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/**
 * A mock context shaped like a REAL activation of this plugin: `agents` and
 * `webServer` are the module's STATIC `inject` dependencies, so Cordis hands
 * them to `apply` as plain properties — and only activates the plugin once both
 * are bound.
 *
 * `withoutCarrier` models a state the static declaration makes unreachable in
 * production: `webServer` missing while `apply` runs. It exists to prove the
 * host half carries no `undefined`/warn-and-skip branch any more — registration
 * is unconditional, so a missing carrier throws loudly instead of silently
 * dropping the page's transport, which is the symptom this fix removed.
 * `get` answers `undefined` for every service, exactly like the optional read
 * does while a service is unbound, so a regression to `ctx.get('webServer')`
 * loses the route and fails the registration assertion below.
 * @returns {{ctx: object, webServer: object, effects: Array, warns: Array}}
 */
function makeHostCtx(agents, { withoutCarrier = false } = {}) {
  const webServer = makeWebServerStub()
  const effects = []
  const warns = []
  const ctx = {
    agents,
    logger: { info: () => {}, warn: (message) => { warns.push(String(message)) } },
    effect: (fn, label) => {
      const disposer = fn()
      effects.push({ label: typeof label === 'string' ? label : null, disposer })
      return disposer
    },
    get: () => undefined,
    inject: () => {
      throw new Error('apply() used a dynamic ctx.inject(): a user-layer hot reload never re-activates that child fiber, so the /queue transport dies until a full restart. Declare the services statically (export const inject).')
    },
  }
  if (!withoutCarrier) ctx.webServer = webServer
  return { ctx, webServer, effects, warns }
}

// 传输载体的依赖形态：模块级**静态** `inject`，不是 apply 内的动态门。
//
// Cordis 并发挂载各行，HTTP 载体比 `agents` 绑定得更晚。曾经的写法是在 apply 里
// `ctx.inject(['webServer','agents'], …)` 配一次可选的 `ctx.get('webServer')`
// 读取：用户层热重载后那条动态门不会重新激活，而读到 undefined 的分支干脆什么都不
// 注册 —— 页面的整条读写通道就这么静默消失了。改成静态声明之后，“载体晚到”改由
// Cordis 负责等（声明过的依赖就绪才激活插件），本仓库 tests/load-smoke.mjs 已在
// 真实运行时里证明晚到的载体仍然会注册路由；这里守住 mock 能观测的那一半，作为旧
// “回调等载体”门的等价替换：声明必须存在、apply 里不再有可选读取或动态门、载体真的
// 缺席时只能响亮地抛，注册仍然只由一个 effect 持有。
{
  if (!Array.isArray(host.inject)) throw new Error(`host.inject must be a static array, got ${typeof host.inject}`)
  for (const dep of ['agents', 'webServer']) {
    if (!host.inject.includes(dep)) throw new Error(`host.inject must declare '${dep}' as a hard dependency: ${JSON.stringify(host.inject)}`)
  }
  if (/ctx\.get\(\s*['"]webServer/.test(hostCode)) {
    throw new Error('the host half reads the web carrier optionally again (ctx.get) — that is the activation race this fix removed')
  }
  if (/ctx\.inject\(\s*\[[^\]]*['"]webServer/.test(hostCode)) {
    throw new Error('the web carrier must stay a STATIC inject, not a dynamic gate inside apply')
  }
  // 载体缺席在真实运行里到不了（静态依赖会先等它绑定），这里断言的是宿主代码已经没有
  // undefined / warn-and-skip 分支：只能抛，不能悄悄不注册。
  const absent = makeHostCtx(fakeAgents, { withoutCarrier: true })
  let carrierFailure = null
  try { host.apply(absent.ctx) } catch (error) { carrierFailure = error }
  if (!(carrierFailure instanceof Error)) {
    throw new Error('a missing declared carrier must fail loudly, never skip the registration silently')
  }
  if (absent.webServer.routes.length !== 0) throw new Error('no route may be registered against a missing carrier')
  console.log(`host inject OK: static inject = ${JSON.stringify(host.inject)} (carrier is a hard dependency, no ctx.get/dynamic gate, a missing carrier throws)`)
}

const { ctx: hostCtx, webServer: hostWebServer, effects: hostEffects, warns: hostWarns } = makeHostCtx(fakeAgents)
const applied = host.apply(hostCtx)
if (applied !== undefined) {
  throw new Error(`apply() must return nothing; real Cordis collects the return as an Effect and throws TypeError("Invalid effect") for a fiber/thenable, got ${typeof applied}`)
}
if (hostWarns.length !== 0) {
  throw new Error(`apply() warned while the declared carrier was present (a stale warn-and-skip branch): ${JSON.stringify(hostWarns)}`)
}
if (hostEffects.length !== 1) {
  throw new Error(`apply() must register exactly one effect, got ${JSON.stringify(hostEffects.map((entry) => entry.label))}`)
}
if (!String(hostEffects[0].label).includes('queue')) {
  throw new Error(`the route effect must carry a recognisable label, got '${hostEffects[0].label}'`)
}
const queueRoute = hostWebServer.routes.find((route) => route.path === '/queue')
if (queueRoute === undefined) {
  throw new Error(`/queue route never registered (routes: ${JSON.stringify(hostWebServer.routes.map((r) => r.path))}, warns: ${JSON.stringify(hostWarns)})`)
}
if (queueRoute.kind !== 'prefix') throw new Error(`/queue route must be kind 'prefix', got '${queueRoute.kind}'`)
console.log('host route OK: prefix /queue registered on the webServer carrier by exactly one labelled effect')

// The fence, driven through the real handler: a cross-site POST always carries
// its own Origin, non-POST mutating verbs are refused, and the JSON-only rule
// is what forces the browser preflight we never answer.
{
  const crossOrigin = await callRoute(queueRoute, {
    headers: { ...FENCE_HEADERS, origin: 'https://evil.example' },
    body: JSON.stringify({ args: {} }),
  })
  if (crossOrigin.status !== 403 || crossOrigin.envelope?.error?.code !== 'forbidden') {
    throw new Error(`cross-origin request must be refused with 403: ${JSON.stringify(crossOrigin)}`)
  }
  const sameOrigin = await callRoute(queueRoute, {
    headers: { ...FENCE_HEADERS, origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ args: {} }),
  })
  if (sameOrigin.status !== 200) throw new Error(`same-origin POST must pass the fence: ${JSON.stringify(sameOrigin)}`)

  const get = await callRoute(queueRoute, { method: 'GET', headers: FENCE_HEADERS })
  if (get.status !== 405 || get.envelope?.error?.code !== 'method-not-allowed') {
    throw new Error(`non-POST must answer 405: ${JSON.stringify(get)}`)
  }

  const wrongType = await callRoute(queueRoute, { headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain' }, body: '{}' })
  if (wrongType.status !== 415 || wrongType.envelope?.error?.code !== 'unsupported-media-type') {
    throw new Error(`non-JSON content-type must answer 415: ${JSON.stringify(wrongType)}`)
  }

  const root = await callRoute(queueRoute, { url: '/queue', headers: FENCE_HEADERS })
  if (root.status !== 404 || root.envelope?.error?.code !== 'unknown-endpoint') {
    throw new Error(`the bare prefix must answer 404: ${JSON.stringify(root)}`)
  }
  const deep = await callRoute(queueRoute, { url: '/queue/a/b', headers: FENCE_HEADERS })
  if (deep.status !== 404 || deep.envelope?.error?.code !== 'unknown-endpoint') {
    throw new Error(`a multi-segment endpoint must answer 404: ${JSON.stringify(deep)}`)
  }
  // A query string is stripped before the endpoint is read (`?x=1` is common
  // on cache-busted URLs and must not turn into part of the endpoint name).
  const withQuery = await callRoute(queueRoute, {
    url: '/queue/reorder?x=1',
    headers: FENCE_HEADERS,
    body: JSON.stringify({ args: { sessionId: 's', itemId: 'm', toIndex: 0 } }),
  })
  if (withQuery.status !== 200 || withQuery.envelope?.error?.code !== 'bad-request') {
    throw new Error(`a query string must be stripped, not treated as the endpoint: ${JSON.stringify(withQuery)}`)
  }
  console.log('host fence OK: 403 cross-origin, 405 non-POST, 415 non-JSON, 404 bare/deep endpoint, query stripped')
}

// Body handling: a malformed body is a 400, an oversized one a 413, and an
// absent body still reaches the handler as `{}` (never as a transport error).
{
  const notJson = await callRoute(queueRoute, { headers: FENCE_HEADERS, body: 'not json' })
  if (notJson.status !== 400 || notJson.envelope?.error?.code !== 'bad-request') {
    throw new Error(`a non-JSON body must answer 400: ${JSON.stringify(notJson)}`)
  }
  const huge = await callRoute(queueRoute, {
    headers: FENCE_HEADERS,
    body: JSON.stringify({ args: { sessionId: 'x'.repeat((1 << 20) + 64) } }),
  })
  if (huge.status !== 413 || huge.envelope?.error?.code !== 'payload-too-large') {
    throw new Error(`an oversized body must answer 413: ${JSON.stringify({ status: huge.status, envelope: huge.envelope })}`)
  }
  const empty = await callRoute(queueRoute, { headers: FENCE_HEADERS, body: '' })
  if (empty.status !== 200 || empty.envelope?.error?.code !== 'bad-request') {
    throw new Error(`an empty body must reach the handler as {}: ${JSON.stringify(empty)}`)
  }
  console.log('host body OK: 400 non-JSON, 413 oversized, empty body reaches the handler')
}

// Endpoint contract, through the real route: the same envelopes the endpoint
// handler always returned.
const rpc = async (endpoint, payload, url = `/queue/${endpoint}`) => callRoute(queueRoute, {
  url,
  headers: FENCE_HEADERS,
  body: JSON.stringify(payload ?? {}),
})

const unknown = (await rpc('nope', { args: {} })).envelope
if (unknown.ok !== false || unknown.error.code !== 'bad-request') throw new Error('unknown endpoint must be rejected')
const badArgs = (await rpc('reorder', { args: { sessionId: 's', itemId: 'm' } })).envelope
if (badArgs.ok !== false || badArgs.error.code !== 'bad-request') throw new Error('missing toIndex must be rejected')
const noPlacement = (await rpc('reorder', { args: { sessionId: 's', itemId: 'm', toIndex: 0 } })).envelope
if (noPlacement.ok !== false || noPlacement.error.code !== 'bad-request') throw new Error('missing placement must be rejected')
// No live agent is a SESSION failure; only a missing item is a queue failure.
const noAgent = (await rpc('reorder', { args: { sessionId: 's', itemId: 'm', toIndex: 0, placement: 'queued' } })).envelope
if (noAgent.ok !== false || noAgent.error.code !== 'session-not-found') throw new Error(`absent agent must be session-not-found: ${JSON.stringify(noAgent)}`)
if (noAgent.error.details.sessionId !== 's') throw new Error('session-not-found must name the session')

// live-agent path through the route
let liveAgent = { inbox: makeInbox(['a', 'b', 'c']) }
fakeAgents.get = () => liveAgent
const live = (await rpc('reorder', { args: { sessionId: 's', itemId: 'a', toIndex: 2, placement: 'queued' } })).envelope
if (!live.ok || liveAgent.inbox.nextTurn.map((m) => m.id).join('') !== 'bca') throw new Error(`route reorder: ${JSON.stringify(liveAgent.inbox.nextTurn)}`)
if (live.value.target !== 'next-turn' || live.value.placement !== 'queued') throw new Error(`route result must report the operated list: ${JSON.stringify(live.value)}`)

const missingItem = (await rpc('reorder', { args: { sessionId: 's', itemId: 'nope', toIndex: 0, placement: 'queued' } })).envelope
if (missingItem.ok !== false || missingItem.error.code !== 'queue-item-not-found') throw new Error('a vanished item must be queue-item-not-found')

// The dock's queued index must never be applied to the next-step list it does
// not render: the endpoint refuses the move and leaves both lists untouched.
liveAgent = { inbox: makeInbox(['a'], [{ id: 's1', source: { kind: 'user' } }]) }
const misplaced = (await rpc('reorder', { args: { sessionId: 's', itemId: 's1', toIndex: 0, placement: 'queued' } })).envelope
if (misplaced.ok !== false || misplaced.error.code !== 'queue-item-placement-mismatch') {
  throw new Error(`placement mismatch through the route: ${JSON.stringify(misplaced)}`)
}
if (liveAgent.inbox.nextStep.map((m) => m.id).join('') !== 's1' || liveAgent.inbox.nextTurn.map((m) => m.id).join('') !== 'a') {
  throw new Error(`a refused reorder must leave both lists untouched: ${JSON.stringify(liveAgent.inbox)}`)
}

// A handler that throws is a 500 with the repository envelope, never a hang.
{
  const explodingRoute = host.createRpcRoute('/boom', async () => { throw new Error('handler exploded') })
  const failed = await callRoute(explodingRoute, { url: '/boom/x', headers: FENCE_HEADERS })
  if (failed.status !== 500 || failed.envelope?.error?.code !== 'internal') {
    throw new Error(`a throwing handler must answer 500/internal: ${JSON.stringify(failed)}`)
  }
}
console.log('host contract OK: /queue prefix route, validation, session-not-found, placement guard, live reorder, 500 path')

// 热重载重挂：静态声明下每次激活都自己把路由挂上，不依赖任何动态门，也不与上一个
// 实例的路由表相互干扰；卸载时由那唯一一个 effect 放掉。
{
  const remount = makeHostCtx(fakeAgents)
  host.apply(remount.ctx)
  if (remount.webServer.routes.length !== 1 || remount.webServer.routes[0].path !== '/queue') {
    throw new Error(`a fresh activation must bring the transport up by itself: ${JSON.stringify(remount.webServer.routes.map((route) => route.path))}`)
  }
  if (remount.effects.length !== 1) throw new Error(`a fresh activation must own exactly one effect: ${JSON.stringify(remount.effects.map((entry) => entry.label))}`)
  if (remount.warns.length !== 0) throw new Error(`a healthy activation must stay quiet: ${JSON.stringify(remount.warns)}`)
  // A second plugin instance never shares or duplicates the first one's route.
  if (hostWebServer.routes.length !== 1) throw new Error('a remount must not touch the previous instance\'s route table')
  for (const entry of remount.effects) entry.disposer()
  if (remount.webServer.routes.length !== 0) throw new Error('the remounted route must be released with its instance')
}

// The endpoint is callable in both documented shapes: `apply` passes the live
// services as `deps`, and the previous transport's `this.agents` binding still
// resolves for direct callers.
{
  const agent = { inbox: makeInbox(['a', 'b']) }
  const bound = await host.handleEndpoint.call({ agents: { get: () => agent } }, 'reorder', {
    args: { sessionId: 's', itemId: 'a', toIndex: 1, placement: 'queued' },
  })
  if (!bound.ok || agent.inbox.nextTurn.map((m) => m.id).join('') !== 'ba') {
    throw new Error(`handleEndpoint must honour the this.agents binding: ${JSON.stringify(bound)}`)
  }
}
console.log('host lifecycle OK: a static-inject activation registers the route by itself, a remount is independent, unload releases it, both service bindings work')

// --- the single effect releases its route on unload ---------------------------
if (typeof hostEffects[0].disposer !== 'function') {
  throw new Error('the route effect must return the webServer disposer')
}
hostEffects[0].disposer()
if (hostWebServer.routes.length !== 0) {
  throw new Error(`unloading the plugin must unregister the route, left: ${JSON.stringify(hostWebServer.routes.map((route) => route.path))}`)
}
if (!hostWebServer.disposed().includes('/queue')) {
  throw new Error(`the released route must be marked disposed: ${JSON.stringify(hostWebServer.disposed())}`)
}
hostEffects[0].disposer()
console.log('host effect OK: exactly one effect, it releases the /queue route on unload and tolerates a double dispose')

// --- client half ----------------------------------------------------------------
if (React === undefined || React === null) {
  console.warn(`SKIP client half: ${domDeps.hint}`)
} else {
  let handoff = null
  let documentObj
  if (domAvailable) {
    // Full jsdom environment: bundle CSS injection + real DOM interaction.
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
      url: 'http://127.0.0.1:3080/',
    })
    globalThis.window = dom.window
    documentObj = dom.window.document
    for (const key of Object.getOwnPropertyNames(dom.window)) {
      if (!(key in globalThis)) globalThis[key] = dom.window[key]
    }
    dom.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
  } else {
    // DOM-free contract check: only the bundle handoff needs a window; the
    // CSS injection IIFE is guarded by `typeof document === 'undefined'`.
    globalThis.window = { __ModuleLoader__: { load: (h) => { handoff = h } } }
    documentObj = undefined
  }

  const bundleSource = readFileSync(clientPath, 'utf8')
  const evaluate = new Function('window', 'document', bundleSource)
  evaluate(globalThis.window, documentObj)
  if (handoff === null) throw new Error('bundle never called __ModuleLoader__.load')
  if (handoff.id !== PLUGIN_ID) throw new Error(`handoff id mismatch: ${handoff.id}`)

  const icon = (props) => React.createElement('svg', { ...props, 'data-icon': true })
  // Behavior-equivalent Tooltip: hover shows after delayMs, keyboard focus is
  // immediate — mirroring the shipped @deepseek-ai/dsh-client-ui-primitives
  // Tooltip (its node half cannot load in Node because it pulls katex CSS).
  const TooltipStub = ({ label, delayMs = 0, disabled = false, children }) => {
    const [visible, setVisible] = React.useState(false)
    const timer = React.useRef(null)
    return React.createElement(React.Fragment, null,
      React.cloneElement(children, {
        onMouseEnter: (event) => {
          children.props.onMouseEnter?.(event)
          if (disabled) return
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setVisible(true), delayMs)
        },
        onMouseLeave: (event) => {
          children.props.onMouseLeave?.(event)
          clearTimeout(timer.current)
          setVisible(false)
        },
        onFocus: (event) => {
          children.props.onFocus?.(event)
          if (!disabled) setVisible(true)
        },
        onBlur: (event) => {
          children.props.onBlur?.(event)
          setVisible(false)
        },
      }),
      visible && !disabled ? React.createElement('span', { role: 'tooltip' }, label) : null,
    )
  }

  const requireTable = (spec) => {
    if (spec === 'react') return uiRequire('react')
    if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        IconChevronDownOutline14: icon,
        IconChevronUpOutline14: icon,
        IconCloseOutline16: icon,
        IconEditOutline16: icon,
        IconQueueOutline14: icon,
        IconSendOutline14: icon,
        IconTrashOutline16: icon,
        IconCheckOutline16: icon,
        Tooltip: TooltipStub,
      }
    }
    throw new Error(`unexpected module-table word: ${spec}`)
  }
  const exports_ = handoff.factory(requireTable)

  if (typeof exports_.apply !== 'function' || !Array.isArray(exports_.inject)) throw new Error('exports contract broken')
  if (exports_.NS !== 'queue.tools') throw new Error(`NS mismatch: ${exports_.NS}`)
  // Every declared service is read as a `ctx.<name>` property. Two services
  // must NOT be declared: `conversation` (declared but only ever reached
  // through the session scope, so an unused hard dependency only delays apply)
  // and `connection` (the browser half reaches the host over `fetch` now —
  // `ctx.connection.rpc.call` cannot work in dsh 0.1.5-rc.1).
  for (const required of ['slots', 'locale', 'sessions']) {
    if (!exports_.inject.includes(required)) throw new Error(`client inject must declare ${required}`)
  }
  if (exports_.inject.includes('conversation')) throw new Error(`client inject declares the unused service 'conversation': ${JSON.stringify(exports_.inject)}`)
  if (exports_.inject.includes('connection')) throw new Error(`client inject still declares 'connection': the transport is now fetch('/queue/…'): ${JSON.stringify(exports_.inject)}`)
  console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

  let registered = null
  let dictionaries = null
  let rpcCalls = []
  let updateQueueCalls = []
  let rpcResponse = { ok: true, value: { accepted: true } }

  // `fetch` double: records the real request (URL / method / content-type /
  // body) and answers the route's envelope. Installed before the bundle's
  // `call` runs — the module-level helper resolves `fetch` at call time.
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const headers = init.headers ?? {}
    const contentType = headers['content-type'] ?? headers['Content-Type']
    let parsed
    try { parsed = JSON.parse(String(init.body)) } catch { parsed = undefined }
    rpcCalls.push({ url: String(url), method: init.method, contentType, body: String(init.body), payload: parsed })
    if (rpcResponse instanceof Error) throw rpcResponse
    if (rpcResponse.status !== undefined && rpcResponse.status !== 200) {
      return { ok: false, status: rpcResponse.status, json: async () => rpcResponse.envelope }
    }
    return { ok: true, status: 200, json: async () => rpcResponse }
  }
  const clientCtx = {
    effect: (fn) => fn(),
    locale: {
      register: (ns, dicts) => { dictionaries = { ns, dicts } },
      bind: () => (key) => 't:' + key,
    },
    // No `connection` service: the browser half must not need one any more.
    sessions: { scope: () => ({ get: () => ({ updateQueue: async (itemId, action) => { updateQueueCalls.push({ itemId, action }) }, input: { for: () => ({ notify: () => {} }) } }) }) },
    slots: {
      inject: (_key, callback) => { registered = callback() },
      register: (options, component) => ({ ...options, component }),
    },
  }
  exports_.apply(clientCtx)
  if (registered === null) throw new Error('slots.inject never registered')
  if (registered.id !== 'queue' || registered.order !== 20 || registered.priority !== -10) {
    throw new Error(`shadow registration mismatch: ${JSON.stringify(registered)}`)
  }
  if (dictionaries === null || dictionaries.ns !== exports_.NS) throw new Error('dictionaries not registered')
  const zhKeys = Object.keys(dictionaries.dicts.zh)
  const enKeys = Object.keys(dictionaries.dicts.en)
  if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) throw new Error(`zh/en key mismatch:\nzh: ${zhKeys}\nen: ${enKeys}`)
  console.log('apply contract OK: id=queue order=20 priority=-10 | dict keys =', zhKeys.length)

  // The dock's reorder face must declare the placement its index was computed
  // on (the `queued` rows it renders), must reach the host over
  // `POST /queue/reorder`, and a host refusal must surface as a rejected
  // promise so the dock keeps showing its failure notice.
  rpcCalls = []
  const reorderFace = registered.inject('session-1').reorder
  await reorderFace('m1', 1)
  if (rpcCalls.length !== 1) throw new Error(`expected 1 reorder fetch, got ${rpcCalls.length}`)
  const faceCall = rpcCalls[0]
  if (faceCall.url !== '/queue/reorder' || faceCall.method !== 'POST') {
    throw new Error(`reorder must POST /queue/reorder: ${JSON.stringify(faceCall)}`)
  }
  if (faceCall.contentType !== 'application/json') {
    throw new Error(`reorder must send content-type application/json: ${JSON.stringify(faceCall.contentType)}`)
  }
  if (faceCall.payload?.args?.placement !== 'queued' || faceCall.payload?.args?.toIndex !== 1 || faceCall.payload?.args?.itemId !== 'm1') {
    throw new Error(`reorder body must declare the queued placement: ${JSON.stringify(faceCall.body)}`)
  }
  if (faceCall.payload?.args?.sessionId !== 'session-1') {
    throw new Error(`reorder body must carry the session id: ${JSON.stringify(faceCall.body)}`)
  }
  rpcResponse = { ok: false, error: { code: 'queue-item-placement-mismatch', message: 'item is in another list', details: { itemId: 'm1' } } }
  let reorderError = null
  try {
    await reorderFace('m1', 1)
  } catch (error) {
    reorderError = error
  }
  rpcResponse = { ok: true, value: { accepted: true } }
  if (reorderError === null) throw new Error('a refused reorder must reject instead of resolving')
  if (!String(reorderError.message).includes('queue-item-placement-mismatch')) {
    throw new Error(`the refusal must carry its code: ${reorderError.message}`)
  }
  if (reorderError.code !== 'queue-item-placement-mismatch' || reorderError.details?.itemId !== 'm1') {
    throw new Error(`the refusal must keep its code/details fields: ${JSON.stringify({ code: reorderError.code, details: reorderError.details })}`)
  }
  // A host refusal must NOT carry the transport marker: the dock branches on it
  // and would blame an unloaded service for the user's own stale drag.
  if (reorderError.code === 'transport') throw new Error('an envelope refusal must not be classified as a transport failure')

  // Transport failures must reject too, not resolve with `undefined`: an HTTP
  // error status and a thrown network error are both refusals for the dock.
  rpcResponse = { status: 413, envelope: { ok: false, error: { code: 'payload-too-large', message: 'too big', details: {} } } }
  let httpError = null
  try { await reorderFace('m1', 1) } catch (error) { httpError = error }
  if (httpError === null || !String(httpError.message).includes('HTTP 413')) {
    throw new Error(`a non-2xx response must reject with its status: ${httpError?.message}`)
  }
  if (httpError.code !== 'transport') {
    throw new Error(`a non-2xx response is a transport failure the dock can name: ${httpError.code}`)
  }
  rpcResponse = new Error('network down')
  let networkError = null
  try { await reorderFace('m1', 1) } catch (error) { networkError = error }
  if (networkError === null || !String(networkError.message).includes('network down')) {
    throw new Error(`a rejected fetch must reject the call: ${networkError?.message}`)
  }
  if (networkError.code !== 'transport') {
    throw new Error(`a thrown fetch is a transport failure the dock can name: ${networkError.code}`)
  }
  rpcResponse = { ok: true, value: { accepted: true } }
  console.log('client reorder contract OK: POST /queue/reorder with the queued placement, refusal (envelope + HTTP + network) rejects with its own code')

  if (!domAvailable) {
    console.warn(`SKIP jsdom interaction checks: ${domDeps.available ? "'@testing-library/react' is not resolvable" : domDeps.hint}`)
  } else {
    // --- render + interact --------------------------------------------------------
    const { act } = React
    const { createRoot } = uiRequire('react-dom/client')
    const { fireEvent } = uiRequire('@testing-library/react')
    globalThis.IS_REACT_ACT_ENVIRONMENT = true

    const dom = globalThis.window
    const en = dictionaries.dicts.en
    const zh = dictionaries.dicts.zh
    const rows = [
      { id: 'm1', placement: 'queued', preview: 'short one…', text: 'short one' },
      { id: 'm2', placement: 'queued', preview: 'second message…', text: 'second message' },
    ]
    const root = createRoot(dom.document.getElementById('root'))
    const injected = registered.inject('session-1')
    const notifies = []
    // The dock's failure copy is whatever `t` resolves, so the toast checks pick
    // the dictionary explicitly (zh is the shipped user-facing wording).
    const renderProps = (dict = en, queue = rows) => ({
      useSession: (select) => select({ queue, running: false, subagent: null }),
      updateQueue: injected.updateQueue,
      notify: (level, text) => { notifies.push({ level, text }) },
      reorder: injected.reorder,
      t: (key, params) => {
        const value = dict[key]
        return params && params.n !== undefined ? value.replace('{n}', String(params.n)) : value
      },
    })
    await act(async () => {
      root.render(React.createElement(registered.component, renderProps()))
    })

    const doc = dom.document

    // two rows: dock renders collapsed — expand via the header first
    const header = doc.querySelector('.qt-header')
    if (header === null) throw new Error('collapsed header missing')
    if (doc.querySelectorAll('.qt-preview').length !== 0) throw new Error('rows must be hidden while collapsed')
    await act(async () => { fireEvent.click(header) })

    // hover full-text preview uses the Tooltip affordance (same as action buttons)
    const previews = [...doc.querySelectorAll('.qt-preview')]
    if (previews.length !== 2) throw new Error(`expected 2 previews, got ${previews.length}`)
    if (previews[0].getAttribute('title') !== null) throw new Error('preview must not use the native title attribute')
    await act(async () => { fireEvent.mouseEnter(previews[0]) })
    await new Promise((resolve) => setTimeout(resolve, 600))
    await act(async () => {})
    const bubbles = [...doc.querySelectorAll('[role="tooltip"]')]
    if (bubbles.length !== 1 || bubbles[0].textContent !== 'short one') {
      throw new Error(`hover bubble: ${bubbles.map((b) => b.textContent).join('|')}`)
    }
    await act(async () => { fireEvent.mouseLeave(previews[0]) })
    console.log('hover full-text preview OK (Tooltip bubble = full text)')

    // drag-to-reorder: drag m1 onto m2's row -> reorder(m1, index 1)
    const rowsEls = [...doc.querySelectorAll('.qt-row')]
    if (rowsEls.length !== 2) throw new Error(`expected 2 rows, got ${rowsEls.length}`)
    if (rowsEls[0].getAttribute('draggable') !== 'true') throw new Error('row must be draggable')
    rpcCalls = []
    await act(async () => { fireEvent.dragStart(rowsEls[0]) })
    await act(async () => { fireEvent.dragOver(rowsEls[1]) })
    if (rowsEls[1].classList.contains('qt-row-over') !== true) throw new Error('drag-over highlight missing')
    await act(async () => { fireEvent.drop(rowsEls[1]) })
    if (rpcCalls.length !== 1) throw new Error(`expected 1 reorder fetch, got ${rpcCalls.length}`)
    const call = rpcCalls[0]
    if (call.url !== '/queue/reorder' || call.method !== 'POST' || call.contentType !== 'application/json') {
      throw new Error(`reorder request: ${JSON.stringify(call)}`)
    }
    if (call.payload.args.sessionId !== 'session-1' || call.payload.args.itemId !== 'm1' || call.payload.args.toIndex !== 1) {
      throw new Error(`reorder body args: ${JSON.stringify(call.body)}`)
    }
    if (call.payload.args.placement !== 'queued') {
      throw new Error(`the drag must declare the queued placement it sorted: ${JSON.stringify(call.body)}`)
    }
    console.log('drag reorder OK: drag m1 onto m2 -> POST /queue/reorder (session-1, m1, 1, queued)')

    // 两条失败提示是用户能直接看到的文案，按 code 分流：宿主半没挂上（路由缺席时
    // 请求落到 SPA fallback，非 2xx）要说“服务未加载”，而宿主明确回绝（信封
    // ok:false）只能说“这条消息可能已经开始发送”。用 zh 字典渲染，断言实际文案。
    if (typeof zh.reorderUnavailable !== 'string' || zh.reorderUnavailable.length === 0) throw new Error('zh.reorderUnavailable is empty')
    if (typeof zh.reorderFailed !== 'string' || zh.reorderFailed.length === 0) throw new Error('zh.reorderFailed is empty')
    if (zh.reorderUnavailable === zh.reorderFailed) throw new Error('the two reorder failure copies must differ, the branch would prove nothing')
    const dragOntoSecondRow = async () => {
      rpcCalls = []
      notifies.length = 0
      const [row0, row1] = [...doc.querySelectorAll('.qt-row')]
      await act(async () => { fireEvent.dragStart(row0) })
      await act(async () => { fireEvent.dragOver(row1) })
      await act(async () => { fireEvent.drop(row1) })
      await act(async () => {})
    }
    await act(async () => {
      root.render(React.createElement(registered.component, renderProps(zh)))
    })
    // (a) the host half is not live in this process: the /queue route is absent,
    // so the request lands on the SPA fallback and answers a non-2xx status.
    rpcResponse = { status: 404, envelope: null }
    await dragOntoSecondRow()
    if (rpcCalls.length !== 1 || rpcCalls[0].url !== '/queue/reorder') {
      throw new Error(`the failing drag must still hit the host route once: ${JSON.stringify(rpcCalls)}`)
    }
    if (notifies.length !== 1 || notifies[0].level !== 'error' || notifies[0].text !== zh.reorderUnavailable) {
      throw new Error(`an absent transport must report the service is not loaded, got ${JSON.stringify(notifies)}`)
    }
    // (b) the host refused because the item is gone: the ordinary failure copy.
    rpcResponse = { ok: false, error: { code: 'queue-item-not-found', message: 'queued item is no longer pending', details: { itemId: 'm1' } } }
    await dragOntoSecondRow()
    if (notifies.length !== 1 || notifies[0].level !== 'error' || notifies[0].text !== zh.reorderFailed) {
      throw new Error(`a host refusal must report the item may have started sending, got ${JSON.stringify(notifies)}`)
    }
    rpcResponse = { ok: true, value: { accepted: true } }
    // A successful drag stays silent: the toast is a failure affordance only.
    await dragOntoSecondRow()
    if (notifies.length !== 0 || rpcCalls.length !== 1) throw new Error(`a reordered drag must stay quiet, got ${JSON.stringify(notifies)}`)
    console.log(`failure toast OK: absent transport -> "${zh.reorderUnavailable}", host refusal -> "${zh.reorderFailed}", success stays silent`)

    // editing the row blurs the edit button (no lingering focus tooltip)
    await act(async () => {
      root.render(React.createElement(registered.component, renderProps()))
    })
    const editButton = [...doc.querySelectorAll('.qt-action')].find((b) => b.getAttribute('aria-label') === en.edit)
    if (editButton === undefined) throw new Error('edit button missing')
    // keyboard focus shows the tooltip immediately (shipped Tooltip semantics)
    await act(async () => { fireEvent.focus(editButton) })
    if (doc.querySelectorAll('[role="tooltip"]').length === 0) throw new Error('focus must show the edit tooltip immediately')
    await act(async () => { fireEvent.focusOut(editButton) })
    if (doc.querySelector('[role="tooltip"]') !== null) throw new Error('focusOut must hide the tooltip')
    // mouse click path: mousedown preventDefault keeps the button unfocused, so
    // no focus-triggered tooltip can pop up when the row swaps into edit mode
    await act(async () => { fireEvent.mouseDown(editButton) })
    await act(async () => { fireEvent.click(editButton) })
    if (doc.querySelector('[role="tooltip"]') !== null) throw new Error('clicking edit must not leave a focus tooltip in edit mode')
    const editor = doc.querySelector('.qt-editor')
    if (editor === null) throw new Error('editor missing after clicking edit')
    if (editor.tagName !== 'TEXTAREA') throw new Error('editor must be a textarea (multiline editing)')
    console.log('edit OK: no focus-triggered tooltip in edit mode; multiline textarea editor')

    // multiline editing: type a two-line message and submit with Enter
    updateQueueCalls = []
    await act(async () => { fireEvent.change(editor, { target: { value: 'line one\nline two' } }) })
    await act(async () => { fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true }) })
    if (updateQueueCalls.length !== 0) throw new Error('Shift+Enter must insert a newline, not submit')
    await act(async () => { fireEvent.keyDown(editor, { key: 'Enter' }) })
    if (updateQueueCalls.length !== 1) throw new Error('Enter must submit the edit')
    const editCall = updateQueueCalls[0]
    if (editCall.itemId !== 'm1' || editCall.action.kind !== 'edit') throw new Error(`edit call: ${JSON.stringify(editCall)}`)
    if (editCall.action.content[0].text !== 'line one\nline two') throw new Error('multiline text must be preserved in the edit action')
    console.log('multiline edit OK: Shift+Enter newline, Enter submits, text preserved')

    // single row: no reorder affordance (row not draggable)
    await act(async () => {
      root.render(React.createElement(registered.component, {
        useSession: (select) => select({ queue: [rows[0]], running: false, subagent: null }),
        updateQueue: injected.updateQueue,
        notify: () => {},
        reorder: injected.reorder,
        t: (key, params) => {
          const value = en[key]
          return params && params.n !== undefined ? value.replace('{n}', String(params.n)) : value
        },
      }))
    })
    const singleRow = doc.querySelector('.qt-row')
    if (singleRow === null) throw new Error('single row missing')
    if (singleRow.getAttribute('draggable') === 'true') throw new Error('single-row queue must not be draggable')
    console.log('single-row queue hides reorder affordance OK')
  }

  // The `fetch` double is installed on the shared global: put the real one back
  // so nothing after this harness could inherit it.
  globalThis.fetch = realFetch
}

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
