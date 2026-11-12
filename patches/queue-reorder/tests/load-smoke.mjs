/**
 * queue-reorder 宿主半的真实 Cordis 装载冒烟测试。
 *
 * 走的是 DSH 宿主真正用的那条路：`new Context()` + `ctx.provide(...)` +
 * `ctx.plugin(...)`，而不是 mock。这就是历史上那个装载 bug 的权威检查点：
 * `apply()` 一旦 `return ctx.inject(...)`，真实 `ctx.inject()` 返回的 Fiber
 * 是个 PromiseLike，Cordis 会把它当 Effect 收，`safeCollect(fiber)` 抛
 * `TypeError('Invalid effect')`，插件装载失败。mock 版测不到这个，因为 mock
 * 的 inject 直接返回回调结果，把 thenable 语义掩盖掉了。
 *
 * 这里断言四件事：
 *
 *  1. 装载成功，且只注册一条 `kind: 'prefix'` 的 `/queue-reorder` 路由；
 *  2. 围栏跟着路由走（跨源 403 / 非 POST 405 / 非 JSON 415 / 无端点 404）；
 *  3. 参数校验与「会话没有在活 agent」的失败码；
 *  4. 真实的 inbox splice 重排：一个假的 agent 记录 splice 调用，验证
 *     `reorderQueueItem()` 的最终下标、placement 拒绝、以及失败时的回滚。
 *
 * 另外复现一次**迟到载体**：`webServer` 在插件激活之后才 provide 时，声明的静态
 * 依赖必须让路由仍然注册。这正是把载体写成静态 inject（而非 `ctx.get`
 * 探测）要换来的东西。
 *
 * @deepseek-ai/cordis 解析：本文件没有本地 node_modules，ESM `import` 又不看
 * NODE_PATH，所以用 createRequire（CJS 解析认 NODE_PATH）按这个顺序找：
 *   1. 本补丁的标准祖先 node_modules；
 *   2. `$NODE_PATH` 各项；
 *   3. 部署后的 profile junction 树 `~/.dsh/profiles/node_modules`。
 * 解析出的入口再用 file URL 导入。找不到时用 NODE_PATH 指到一个含
 * @deepseek-ai/cordis 的 node_modules 再跑。
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
    "cannot resolve '@deepseek-ai/cordis' from this patch, $NODE_PATH, or the deployed profile "
    + 'node_modules; run with NODE_PATH pointing at a node_modules that contains it',
  )
}

const { Context } = await import(pathToFileURL(resolveCordisEntry()).href)
const host = await import(pathToFileURL(hostPath).href)

// --- 4. 纯逻辑：reorderQueueItem 的 splice 语义 ------------------------------

/**
 * 建一个记录 splice 调用的假 agent。
 * @param nextTurn - `next-turn` 列表里的消息 id。
 * @param nextStep - `next-step` 里的消息（`{ id, sourceKind }`）。
 * @returns `{ agent, calls }`。
 */
function fakeAgent(nextTurn, nextStep = []) {
  const state = {
    'next-turn': nextTurn.map((id) => ({ id, content: [], source: { kind: 'user' } })),
    'next-step': nextStep.map(({ id, sourceKind }) => ({ id, content: [], source: { kind: sourceKind } })),
  }
  const calls = []
  const inbox = {
    get nextTurn() { return state['next-turn'] },
    get nextStep() { return state['next-step'] },
    splice(target, start, deleteCount, inserted) {
      calls.push({ target, start, deleteCount, inserted: inserted.map((m) => m.id) })
      const list = state[target]
      const removed = list.splice(start, deleteCount, ...inserted)
      return removed
    },
  }
  return { agent: { inbox }, calls, state }
}

{
  const { agent, calls, state } = fakeAgent(['a', 'b', 'c'])
  const result = host.reorderQueueItem(agent, 'c', 0, 'queued')
  assert.deepEqual(result, { ok: true, value: { accepted: true, to: 0, target: 'next-turn', placement: 'queued' } })
  assert.deepEqual(state['next-turn'].map((m) => m.id), ['c', 'a', 'b'], 'c must land at index 0')
  assert.equal(calls.length, 2, 'one detach + one insert')
  assert.deepEqual(calls[0], { target: 'next-turn', start: 2, deleteCount: 1, inserted: [] })
  assert.deepEqual(calls[1], { target: 'next-turn', start: 0, deleteCount: 0, inserted: ['c'] })
}

{
  // 未知名与越界都报 queue-item-not-found，且一次 splice 都不发。
  const { agent, calls } = fakeAgent(['a', 'b'])
  assert.equal(host.reorderQueueItem(agent, 'zz', 0, 'queued').error.code, 'queue-item-not-found')
  assert.equal(calls.length, 0)
}

{
  // placement 不符：消息在 next-step，调用方按 queued 算的下标必须被拒。
  const { agent, calls } = fakeAgent(['a'], [{ id: 's', sourceKind: 'user' }])
  const result = host.reorderQueueItem(agent, 's', 0, 'queued')
  assert.equal(result.error.code, 'queue-item-placement-mismatch')
  assert.deepEqual(result.error.details, { itemId: 's', expected: 'queued', actual: 'steering', target: 'next-step' })
  assert.equal(calls.length, 0, 'a refused placement must not touch the inbox')
}

{
  // 目标下标会被夹到列表边界内（摘除后只剩 length-1 个位置）。
  const { agent, state } = fakeAgent(['a', 'b', 'c'])
  assert.equal(host.reorderQueueItem(agent, 'a', 99, 'queued').value.to, 2)
  assert.deepEqual(state['next-turn'].map((m) => m.id), ['b', 'c', 'a'])
}

{
  // 插入抛错时必须把摘下的消息放回去，且绝不报成功。
  const { agent, calls } = fakeAgent(['a', 'b'])
  const original = agent.inbox.splice
  let call = 0
  agent.inbox.splice = (...args) => {
    call += 1
    if (call === 2) throw new Error('inbox refused')
    return original(...args)
  }
  const result = host.reorderQueueItem(agent, 'a', 1, 'queued')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'queue-reorder-failed')
  assert.equal(result.error.details.restored, true, 'the detached message must be put back')
  assert.deepEqual(agent.inbox.nextTurn.map((m) => m.id), ['a', 'b'])
  assert.equal(calls.length, 2, 'detach + failed insert; the restore goes through the overridden splice')
}

// --- 1..3. 真实 Cordis 装载 + 路由 ------------------------------------------

/** `webServer` 服务替身：记录 register() 调用与它的 disposer。 */
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

const liveAgents = new Map()
const ctx = new Context()
ctx.provide('webServer', webServerStub)
ctx.provide('agents', { get: (id) => liveAgents.get(id), list: () => [...liveAgents.values()] })

// DSH 的宿主 runner（dsh-cordis-host-runner 的 guardedPlugin()）从不把裸函数交给
// ctx.plugin：它把每个插件包成带 `apply` 方法的普通对象，正是这个形状让 Cordis
// 把 apply 当函数调用；裸的 `ctx.plugin(lib/index.js)` 会走 isConstructor 的
// `new` 分支，并静默忽略返回值。复现 DSH 的装载形状。
const guarded = {
  name: 'queue-reorder',
  inject: host.inject,
  apply(inner) {
    return host.apply(inner)
  },
}

const fiber = ctx.plugin(guarded)
await fiber

const deadline = Date.now() + 2000
while (routes.length === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

assert.deepEqual(host.inject, ['agents', 'webServer'], 'the carrier is a STATIC dependency, never a ctx.get probe')
assert.equal(routes.length, 1, 'exactly one route must be registered')
assert.equal(routes[0].path, '/queue-reorder')
assert.equal(routes[0].kind, 'prefix')

/** 按 web 载体的方式驱动已注册路由。 */
async function callRoute({ method = 'POST', url = '/queue-reorder/reorder', headers = {}, body = '{}' } = {}) {
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
  const settle = Date.now() + 5000
  while (!res.writableEnded && Date.now() < settle) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  let envelope = null
  try { envelope = JSON.parse(res.body) } catch { envelope = null }
  return { status: res.status, headers: res.headers, envelope }
}

const JSON_HEADERS = { host: '127.0.0.1:3080', 'content-type': 'application/json' }

// 围栏跟着路由走：跨源 / 非 POST / 非 JSON。
assert.equal((await callRoute({ headers: { ...JSON_HEADERS, origin: 'https://evil.example' } })).status, 403)
assert.equal((await callRoute({ headers: { ...JSON_HEADERS, origin: 'http://127.0.0.1:3080' } })).status, 200,
  'a same-origin request must pass the fence')
assert.equal((await callRoute({ method: 'GET', headers: JSON_HEADERS })).status, 405)
assert.equal((await callRoute({ headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain' } })).status, 415)
assert.equal((await callRoute({ url: '/queue-reorder', headers: JSON_HEADERS })).status, 404)
assert.equal((await callRoute({ url: '/queue-reorder/a/b', headers: JSON_HEADERS })).status, 404)

// 参数校验：placement 是必填的，缺了就是 bad-request。
{
  const missing = (await callRoute({
    headers: JSON_HEADERS,
    body: JSON.stringify({ args: { sessionId: 's', itemId: 'm', toIndex: 0 } }),
  })).envelope
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'bad-request')
}
// 没有在活 agent 的会话是 SESSION 失败；queue-item-not-found 留给「会话在、消息没了」。
{
  const result = (await callRoute({
    headers: JSON_HEADERS,
    body: JSON.stringify({ args: { sessionId: 'nope', itemId: 'm', toIndex: 0, placement: 'queued' } }),
  })).envelope
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'session-not-found')
}
// 未知端点。
{
  const result = (await callRoute({ url: '/queue-reorder/nope', headers: JSON_HEADERS })).envelope
  assert.equal(result.error.code, 'bad-request')
}

// 端到端：注册一条真实的假 agent，路由真的把顺序改了。
{
  const { agent, state } = fakeAgent(['a', 'b', 'c'])
  liveAgents.set('sess-1', agent)
  const result = (await callRoute({
    headers: JSON_HEADERS,
    body: JSON.stringify({ args: { sessionId: 'sess-1', itemId: 'a', toIndex: 2, placement: 'queued' } }),
  })).envelope
  assert.equal(result.ok, true, `route must report success, got ${JSON.stringify(result)}`)
  assert.deepEqual(state['next-turn'].map((m) => m.id), ['b', 'c', 'a'])
  liveAgents.clear()
}

await fiber.dispose()
assert.equal(routes.length, 0, 'dispose must unregister the /queue-reorder route')

// --- 迟到载体：静态依赖让激活等它，而不是跳过它 ------------------------------
// 这正是声明依赖要消掉的那种故障：载体若只是可选的 ctx.get 读取，插件在 HTTP
// 载体绑定之前激活时会读到 undefined，然后一声不响地跳过注册。
{
  const lateRoutes = []
  const lateCtx = new Context()
  lateCtx.provide('agents', { get: () => undefined, list: () => [] })
  const lateFiber = lateCtx.plugin(guarded)
  await lateFiber
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
  assert.equal(lateRoutes[0], '/queue-reorder')
  await lateFiber.dispose()
}

console.log('load-smoke OK: real Cordis ctx.plugin() loaded lib/index.js, prefix route /queue-reorder registered + fenced, reorderQueueItem splices next-turn correctly (placement refusal + rollback), and a LATE webServer still activates the transport (declared dependency, no ctx.get race)')