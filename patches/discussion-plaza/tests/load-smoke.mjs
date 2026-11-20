/**
 * discussion-plaza 的 Cordis 装载冒烟测试。
 *
 * 目的不是复测协议（那是 core/store 两个测试），而是证明**宿主契约没写错**：
 * 工具定义形状、静态 inject、路由围栏、volatile 配置、pre-step 通知的消息 source
 * 能否通过 session-format v4 编码器 —— 这些错误在真实运行时全是静默的。
 *
 * 用真实的 `@deepseek-ai/cordis` 挂载，用真实的 `assertSupportedJsonSchema` /
 * `validateJsonSchemaValue` 校验每个工具，用真实的 `webServer` 桩走一遍围栏。
 *
 * 从仓库根运行：
 *   node patches/discussion-plaza/tests/load-smoke.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 与其它补丁同一套退让顺序。 */
function resolveEntry(specifier) {
  const candidates = []
  try {
    candidates.push(require.resolve(specifier))
  } catch {}
  for (const entry of String(process.env.NODE_PATH ?? '').split(';')) {
    if (entry.trim().length === 0) continue
    try {
      candidates.push(require.resolve(specifier, { paths: [entry] }))
    } catch {}
  }
  try {
    candidates.push(require.resolve(specifier, {
      paths: [join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'node_modules')],
    }))
  } catch {}
  return candidates[0]
}

const cordisEntry = resolveEntry('@deepseek-ai/cordis')
if (cordisEntry === undefined) {
  console.log('SKIP load-smoke: @deepseek-ai/cordis is not resolvable (no host dependency links)')
  process.exit(0)
}

const { Context } = await import(pathToFileURL(cordisEntry).href)
const toolsEntry = resolveEntry('@deepseek-ai/dsh-tools')
const hostTools = toolsEntry === undefined ? undefined : await import(pathToFileURL(toolsEntry).href)
let catalog
try {
  catalog = await import('@deepseek-ai/dsh-session-format-catalog')
} catch {
  catalog = undefined
}

const host = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href)
const { createStore } = host
const { createGroup, joinGroup, appendMessage } = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'store.js')).href)
const { parseDoc } = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'protocol.js')).href)

let passed = 0
let failed = 0

/**
 * 跑一个异步用例并记账。
 * @param label - 用例名。
 * @param run - 用例体。
 */
async function test(label, run) {
  try {
    await run()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${label}`)
    console.error(error)
  }
}

/**
 * 建一个装了桩服务的 Cordis 上下文。
 * @param options - `{ skipWebServer }`。
 */
function harness(options = {}) {
  const ctx = new Context()
  const routes = []
  const sections = []
  const tools = []
  const warnings = []
  ctx.provide('tools', {
    register(definition) {
      if (tools.some((entry) => entry.name === definition.name)) {
        throw new Error(`tool "${definition.name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`)
      }
      tools.push(definition)
      return () => {
        const index = tools.indexOf(definition)
        if (index !== -1) tools.splice(index, 1)
      }
    },
  })
  ctx.provide('systemPrompt', {
    section(section) {
      if (sections.some((entry) => entry.name === section.name)) {
        throw new Error(`prompt section "${section.name}" is already registered`)
      }
      sections.push(section)
      return () => {
        const index = sections.indexOf(section)
        if (index !== -1) sections.splice(index, 1)
      }
    },
  })
  ctx.provide('logger', {
    warn(...args) { warnings.push(args.join(' ')) },
    info() {},
    debug() {},
  })
  // 点名唤醒用：live agent 的桩（status + followup）。没有注册的会话就是 offline。
  const liveAgents = new Map()
  ctx.provide('agents', {
    get(id) { return liveAgents.get(id) },
  })
  if (options.skipWebServer !== true) {
    ctx.provide('webServer', {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index !== -1) routes.splice(index, 1)
        }
      },
    })
  }
  return { ctx, routes, sections, tools, warnings, liveAgents }
}

/**
 * 用真实的 Cordis 装载流程挂上宿主半，并注入配置。
 * @param ctx - Cordis 上下文。
 * @param config - 入口配置。
 */
async function mount(ctx, config) {
  const guarded = {
    name: host.name,
    inject: host.inject,
    apply(inner, received) { return host.apply(inner, received) },
  }
  const fiber = ctx.plugin(guarded, config)
  await fiber
  return fiber
}

/** 一个足够的假响应对象。 */
function createRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
      return this
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
      this.writableEnded = true
      return this
    },
  }
}

/**
 * 一个足够的假请求对象。
 * @param spec - `{ method, url, headers, body }`。
 */
function createReq(spec) {
  const listeners = new Map()
  const req = {
    method: spec.method ?? 'POST',
    url: spec.url ?? '/discussion-plaza/view',
    headers: spec.headers ?? {},
    destroyed: false,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return req
    },
    destroy() {
      req.destroyed = true
    },
  }
  queueMicrotask(() => {
    const payload = spec.body === undefined ? '' : spec.body
    if (payload.length > 0) for (const listener of listeners.get('data') ?? []) listener(Buffer.from(payload))
    for (const listener of listeners.get('end') ?? []) listener()
  })
  return req
}

/** 调一次路由。 */
async function callRoute(route, spec) {
  const res = createRes()
  await route.handler(createReq(spec), res)
  return { status: res.status, body: res.body.length === 0 ? undefined : JSON.parse(res.body) }
}

const HOME_HEADERS = { host: '127.0.0.1:3080', 'content-type': 'application/json' }
const root = await mkdtemp(join(tmpdir(), 'plaza-smoke-'))
const A = { id: 's-a', workspace: 'alpha' }
const B = { id: 's-b', workspace: 'beta' }
// 同一工作区的第二个会话：默认显示名与 A 完全相同，用来验证展示层补短 session。
const A2 = { id: 'session-aaaa2222', workspace: 'alpha' }

/** 假工具执行上下文。 */
const execFor = (who) => ({
  agent: {
    id: who.id,
    session: { id: who.id, header: { cwd: `D:\\GitHub\\${who.workspace}` } },
  },
})

try {
  console.log('— 导出形状 —')

  await test('导出 name / Config / apply / inject', () => {
    assert.equal(host.name, 'discussion-plaza')
    assert.equal(typeof host.apply, 'function')
    assert.equal(typeof host.Config, 'function')
  })

  await test('inject 是静态数组且含 webServer / tools / systemPrompt', () => {
    assert.ok(Array.isArray(host.inject))
    for (const service of ['webServer', 'tools', 'systemPrompt']) assert.ok(host.inject.includes(service), service)
  })

  await test('源码里没有 ctx.get("webServer") 探测或 connection.rpc 通道', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8')
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    assert.ok(!/ctx\.get\(\s*['"]webServer['"]\s*\)/.test(code), 'must not probe the carrier with ctx.get')
    assert.ok(!/connection\.rpc/.test(code), 'must not use the broken connection.rpc channel')
  })

  await test('Config 的字段都是 volatile（否则设置页没有表单）', () => {
    const dict = host.Config.dict ?? {}
    for (const key of ['rootDir', 'tools', 'promptSection', 'notify', 'wakeOnMention', 'lockTtlSec', 'closeGraceMin']) {
      assert.ok(Object.hasOwn(dict, key), `Config must declare ${key}`)
      assert.equal(dict[key].meta?.volatile, true, `${key} must be .volatile()`)
    }
  })

  await test('plainConfig 解包 volatile 盒子', () => {
    const boxed = host.Config({ rootDir: root, tools: false, notify: false })
    const plain = host.plainConfig(boxed)
    assert.equal(plain.rootDir, root)
    assert.equal(plain.tools, false)
    assert.equal(plain.notify, false)
  })

  console.log('— 工具定义 —')

  await test('11 个 plaza_* 工具都注册，名字唯一', async () => {
    const { ctx, tools } = harness()
    const fiber = await mount(ctx, { rootDir: join(root, 'tools') })
    try {
      const names = tools.map((tool) => tool.name).sort()
      assert.deepEqual(names, [
        'plaza_append', 'plaza_cancel_close', 'plaza_confirm_close', 'plaza_create', 'plaza_join',
        'plaza_leave', 'plaza_list', 'plaza_lock', 'plaza_propose_close', 'plaza_read', 'plaza_unlock',
      ])
    } finally {
      await fiber.dispose()
    }
  })

  await test('每个工具都有 description / execute / output.schema / output.render', async () => {
    const { ctx, tools } = harness()
    const fiber = await mount(ctx, { rootDir: join(root, 'tools-shape') })
    try {
      for (const tool of tools) {
        assert.equal(typeof tool.description, 'string', `${tool.name} needs a description`)
        assert.ok(tool.description.length > 40, `${tool.name} description is too thin`)
        assert.equal(typeof tool.execute, 'function', `${tool.name} needs execute`)
        assert.equal(typeof tool.output?.render, 'function', `${tool.name} needs output.render`)
        assert.equal(typeof tool.output?.schema, 'object', `${tool.name} needs output.schema`)
      }
    } finally {
      await fiber.dispose()
    }
  })

  await test('工具 schema 都通过宿主的 assertSupportedJsonSchema', async () => {
    if (hostTools?.assertSupportedJsonSchema === undefined) {
      console.log('     (skipped: @deepseek-ai/dsh-tools not resolvable)')
      return
    }
    const { ctx, tools } = harness()
    const fiber = await mount(ctx, { rootDir: join(root, 'tools-schema') })
    try {
      for (const tool of tools) {
        hostTools.assertSupportedJsonSchema(tool.parameters)
        hostTools.assertSupportedJsonSchema(tool.output.schema)
      }
    } finally {
      await fiber.dispose()
    }
  })

  await test('真实执行一遍：创建 → 加入 → 发言 → 加锁写 → 关组，返回值逐个过 output schema', async () => {
    const { ctx, tools, liveAgents } = harness()
    const fiber = await mount(ctx, { rootDir: join(root, 'flow') })
    try {
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      const validate = (name, value) => {
        if (hostTools?.validateJsonSchemaValue === undefined) return
        hostTools.validateJsonSchemaValue(byName.get(name).output.schema, value, `${name} value`)
      }

      const created = await byName.get('plaza_create').execute({ title: '接口对齐', intro: '先开个场' }, execFor(A))
      validate('plaza_create', created)
      const id = created.group.id

      const listed = await byName.get('plaza_list').execute({}, execFor(B))
      validate('plaza_list', listed)
      assert.equal(listed.groups.length, 1)
      assert.equal(listed.groups[0].youAreParticipant, false)

      const joined = await byName.get('plaza_join').execute({ id }, execFor(B))
      validate('plaza_join', joined)
      assert.equal(joined.joined, true)

      const readByA = await byName.get('plaza_read').execute({ id }, execFor(A))
      validate('plaza_read', readByA)
      assert.equal(readByA.group.youAreParticipant, true)

      const appended = await byName.get('plaza_append').execute({ id, body: 'B 的回复' }, execFor(B))
      validate('plaza_append', appended)
      assert.equal(appended.message.seq, 2)
      assert.equal(appended.joined, false)

      // 默认增量读：A 上次读到 #1，这次只返回 #2；显式 sinceSeq: 0 才回看全文。
      const incremental = await byName.get('plaza_read').execute({ id }, execFor(A))
      validate('plaza_read', incremental)
      assert.deepEqual(incremental.messages.map((message) => message.seq), [2])
      const fullHistory = await byName.get('plaza_read').execute({ id, sinceSeq: 0 }, execFor(A))
      validate('plaza_read', fullHistory)
      assert.deepEqual(fullHistory.messages.map((message) => message.seq), [1, 2])

      // 没有新消息时不能误报 "no messages yet"（真实长讨论组里读到过这个误导）。
      const noNew = await byName.get('plaza_read').execute({ id }, execFor(A))
      validate('plaza_read', noNew)
      assert.equal(noNew.messages.length, 0)
      const noNewText = byName.get('plaza_read').output.render({}, noNew)
        .map((block) => block.text ?? '').join('')
      assert.ok(noNewText.includes('no new messages'), 'must say there are no NEW messages, not no messages')
      assert.ok(noNewText.includes('2 in total'), 'must mention the total history size')

      // 点名唤醒：@beta 命中空闲的 B，host 用 agent.followup 开一个新 turn。
      const followed = []
      liveAgents.set('s-b', { status: 'idle', followup(message) { followed.push(message) } })
      const woken = await byName.get('plaza_append').execute({ id, body: '关于 B 的回复，请 @beta 确认' }, execFor(A))
      validate('plaza_append', woken)
      assert.deepEqual(woken.mentions.map((entry) => entry.key), ['beta/s-b'])
      assert.equal(woken.wake.length, 1)
      assert.equal(woken.wake[0].status, 'woken')
      assert.equal(followed.length, 1)
      assert.ok(followed[0].content[0].text.includes(id), 'wake text must name the group id')
      assert.ok(followed[0].content[0].text.includes('点名'), 'wake text must say it was mentioned')
      assert.equal(followed[0].source.kind, 'plugin:discussion-plaza')

      // 刚被唤醒的会话：同一轮的 pre-step 不再叠一条未读 notice。
      const wokenBeforeNotice = await ctx.events.waterfall('agent/pre-step', {
        agent: { id: 's-b', session: { id: 's-b', header: { cwd: 'D:\\GitHub\\beta' } } },
        messages: [],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      }, () => ({ kind: 'enter', messages: [] }))
      assert.equal(wokenBeforeNotice.messages.filter((message) => message?.source?.kind === 'plugin:discussion-plaza').length, 0)

      // 忙碌 / 未加载：不硬打扰，回执里给出状态。
      liveAgents.set('s-b', { status: 'running', followup(message) { followed.push(message) } })
      const busyWake = await byName.get('plaza_append').execute({ id, body: '再来一次', wake: ['beta'] }, execFor(A))
      validate('plaza_append', busyWake)
      assert.equal(busyWake.wake[0].status, 'busy')
      assert.equal(followed.length, 1, 'a running agent must not be woken again')
      liveAgents.delete('s-b')
      const offlineWake = await byName.get('plaza_append').execute({ id, body: '离线点名', wake: ['beta'] }, execFor(A))
      validate('plaza_append', offlineWake)
      assert.equal(offlineWake.wake[0].status, 'offline')

      const lock = await byName.get('plaza_lock').execute({ id, ttlSec: 120, purpose: '汇总' }, execFor(A))
      validate('plaza_lock', lock)
      const lockedAppend = await byName.get('plaza_append').execute({ id, body: 'A 的汇总', lockToken: lock.token }, execFor(A))
      validate('plaza_append', lockedAppend)
      assert.equal(lockedAppend.lockHeld, true)
      const unlocked = await byName.get('plaza_unlock').execute({ id, token: lock.token }, execFor(A))
      validate('plaza_unlock', unlocked)
      assert.equal(unlocked.released, true)

      const proposed = await byName.get('plaza_propose_close').execute({ id, reason: '结论已定' }, execFor(A))
      validate('plaza_propose_close', proposed)
      assert.equal(proposed.closed, false)
      assert.equal(proposed.awaiting.length, 1)
      await assert.rejects(
        () => byName.get('plaza_append').execute({ id, body: '还想说' }, execFor(B)),
        (error) => error.code === 'close-pending',
      )
      const confirmed = await byName.get('plaza_confirm_close').execute({ id }, execFor(B))
      validate('plaza_confirm_close', confirmed)
      assert.equal(confirmed.closed, true)
      await assert.rejects(
        () => byName.get('plaza_append').execute({ id, body: '迟到' }, execFor(B)),
        (error) => error.code === 'group-closed',
      )

      // 长期讨论组：只能由人类标记/结束；Agent 的关组提议必须被拒绝。
      const flowStore = createStore({ rootDir: join(root, 'flow') })
      const standing = await createGroup(flowStore.paths, {
        title: '长期议题',
        by: { sessionId: 's-a', name: 'A', workspace: 'alpha' },
        standing: true,
      })
      await assert.rejects(
        () => byName.get('plaza_propose_close').execute({ id: standing.group.id }, execFor(A)),
        (error) => error.code === 'standing-group',
      )
      const standingList = await byName.get('plaza_list').execute({ standing: true }, execFor(A))
      validate('plaza_list', standingList)
      assert.deepEqual(standingList.groups.map((entry) => entry.id), [standing.group.id])
      assert.equal(standingList.groups[0].standing, true)
    } finally {
      await fiber.dispose()
    }
  })

  await test('wakeOnMention:false 时点名只记录、不投递 followup', async () => {
    const { ctx, tools, liveAgents } = harness()
    const fiber = await mount(ctx, { rootDir: join(root, 'wake-off'), wakeOnMention: false })
    try {
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      const created = await byName.get('plaza_create').execute({ title: '关闭唤醒', intro: '开场' }, execFor(A))
      const id = created.group.id
      await byName.get('plaza_join').execute({ id }, execFor(B))
      const followed = []
      liveAgents.set('s-b', { status: 'idle', followup(message) { followed.push(message) } })
      const result = await byName.get('plaza_append').execute({ id, body: '请 @beta 看', wake: ['beta'] }, execFor(A))
      assert.equal(result.mentions.length, 1, 'mentions are still reported')
      assert.deepEqual(result.wake, [], 'wakeOnMention:false must not deliver')
      assert.equal(followed.length, 0)
    } finally {
      await fiber.dispose()
    }
  })

  await test('同一工作区多会话：plaza_read 的参与者名单补短 session', async () => {
    const { ctx, tools } = harness()
    const fiber = await mount(ctx, { rootDir: join(root, 'dup-labels') })
    try {
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      const created = await byName.get('plaza_create').execute({ title: '同名会话', intro: '开场' }, execFor(A))
      const id = created.group.id
      await byName.get('plaza_join').execute({ id }, execFor(B))
      await byName.get('plaza_join').execute({ id }, execFor(A2))
      const read = await byName.get('plaza_read').execute({ id }, execFor(A))
      const rendered = byName.get('plaza_read').output.render({}, read)
      const text = (Array.isArray(rendered) ? rendered : []).map((block) => block.text ?? '').join('')
      assert.ok(text.includes('alpha [s-a]'), 'first alpha session must show its short session')
      assert.ok(text.includes('alpha [aaaa2222]'), 'second alpha session must show its short session')
      assert.ok(text.includes('beta'), 'beta is not duplicated, no suffix needed')
    } finally {
      await fiber.dispose()
    }
  })

  await test('拿不到会话身份时写工具给出 session-required', async () => {
    const { ctx, tools } = harness()
    const fiber = await mount(ctx, { rootDir: join(root, 'identity') })
    try {
      const create = tools.find((tool) => tool.name === 'plaza_create')
      await assert.rejects(() => create.execute({ title: 'x' }, {}), (error) => error.code === 'session-required')
      const list = tools.find((tool) => tool.name === 'plaza_list')
      const value = await list.execute({}, {})
      assert.equal(value.groups.length, 0, '只读工具在无身份时可以退化为“没有 mine 信息”')
    } finally {
      await fiber.dispose()
    }
  })

  console.log('— 路由与围栏 —')

  await test('前缀路由注册在 /discussion-plaza 上', async () => {
    const { ctx, routes } = harness()
    const fiber = await mount(ctx, { rootDir: join(root, 'route') })
    try {
      assert.equal(routes.length, 1)
      assert.equal(routes[0].kind, 'prefix')
      assert.equal(routes[0].path, '/discussion-plaza')
      assert.equal(typeof routes[0].handler, 'function')
    } finally {
      await fiber.dispose()
    }
  })

  await test('围栏：跨站 Origin 403 / GET 405 / 非 JSON 415 / 未知端点 400', async () => {
    const { ctx, routes } = harness()
    const fiber = await mount(ctx, { rootDir: join(root, 'route-fence') })
    try {
      const route = routes[0]
      const cross = await callRoute(route, { headers: { host: '127.0.0.1:3080', origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
      assert.equal(cross.status, 403)
      const get = await callRoute(route, { method: 'GET', url: '/discussion-plaza/view', headers: HOME_HEADERS })
      assert.equal(get.status, 405)
      const form = await callRoute(route, { headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain' }, body: '{}' })
      assert.equal(form.status, 415)
      const missing = await callRoute(route, { url: '/discussion-plaza/nope', headers: HOME_HEADERS, body: '{}' })
      assert.equal(missing.status, 400)
      assert.equal(missing.body.error.code, 'unknown-endpoint')
    } finally {
      await fiber.dispose()
    }
  })

  await test('view / create / detail / unlock / remove-participant / set-standing / close-standing / probe 端点可用', async () => {
    const { ctx, routes } = harness()
    const fiber = await mount(ctx, { rootDir: join(root, 'route-endpoints') })
    try {
      const route = routes[0]
      const created = await callRoute(route, {
        url: '/discussion-plaza/create',
        headers: HOME_HEADERS,
        body: JSON.stringify({ args: { title: '面板创建的组', intro: '人类开场' } }),
      })
      assert.equal(created.status, 200, JSON.stringify(created.body))
      const id = created.body.value.id
      assert.match(id, /^dg_/)

      const view = await callRoute(route, { url: '/discussion-plaza/view', headers: HOME_HEADERS, body: '{"args":{}}' })
      assert.equal(view.status, 200)
      assert.equal(view.body.value.groups.length, 1)
      assert.equal(view.body.value.groups[0].participantCount, 0, '人类创建不自动成为参与者')

      const detail = await callRoute(route, { url: '/discussion-plaza/detail', headers: HOME_HEADERS, body: JSON.stringify({ args: { id } }) })
      assert.equal(detail.status, 200)
      assert.equal(detail.body.value.markdown.includes('面板创建的组'), true)

      const bad = await callRoute(route, { url: '/discussion-plaza/detail', headers: HOME_HEADERS, body: JSON.stringify({ args: {} }) })
      assert.equal(bad.status, 400)
      assert.equal(bad.body.error.code, 'bad-request')

      const unlock = await callRoute(route, { url: '/discussion-plaza/unlock', headers: HOME_HEADERS, body: JSON.stringify({ args: { id } }) })
      assert.equal(unlock.status, 200)

      const probe = await callRoute(route, { url: '/discussion-plaza/probe', headers: HOME_HEADERS, body: '{"args":{}}' })
      assert.equal(probe.status, 200)
      assert.equal(probe.body.value.paths.root, join(root, 'route-endpoints'))

      // 人类移出参与者：按「工作区/sessionId」的 key 寻址（不是裸 sessionId）。
      const store = createStore({ rootDir: join(root, 'route-endpoints') })
      const agentGroup = await createGroup(store.paths, {
        title: '可移除的组',
        by: { sessionId: 's-a', name: 'A', workspace: 'alpha' },
      })
      await joinGroup(store.paths, agentGroup.group.id, { sessionId: 's-b', name: 'B', workspace: 'beta' })
      const removed = await callRoute(route, {
        url: '/discussion-plaza/remove-participant',
        headers: HOME_HEADERS,
        body: JSON.stringify({ args: { id: agentGroup.group.id, key: 'beta/s-b' } }),
      })
      assert.equal(removed.status, 200)
      assert.equal(removed.body.value.removed, true)
      const afterRemove = await callRoute(route, {
        url: '/discussion-plaza/detail',
        headers: HOME_HEADERS,
        body: JSON.stringify({ args: { id: agentGroup.group.id } }),
      })
      assert.equal(afterRemove.body.value.group.participants.some((entry) => entry.key === 'beta/s-b'), false)
      assert.ok(afterRemove.body.value.group.participants.some((entry) => entry.key === 'alpha/s-a'))

      // 长期讨论组：创建时标记、取消/重标、人类结束（Agent 无法走这条路径）。
      const longCreated = await callRoute(route, {
        url: '/discussion-plaza/create',
        headers: HOME_HEADERS,
        body: JSON.stringify({ args: { title: '长期议题', standing: true } }),
      })
      assert.equal(longCreated.status, 200)
      const longId = longCreated.body.value.id
      assert.equal(longCreated.body.value.group.standing, true)

      const unmark = await callRoute(route, {
        url: '/discussion-plaza/set-standing',
        headers: HOME_HEADERS,
        body: JSON.stringify({ args: { id: longId, standing: false } }),
      })
      assert.equal(unmark.status, 200)
      assert.equal(unmark.body.value.standing, false)
      const remark = await callRoute(route, {
        url: '/discussion-plaza/set-standing',
        headers: HOME_HEADERS,
        body: JSON.stringify({ args: { id: longId, standing: true } }),
      })
      assert.equal(remark.status, 200)
      assert.equal(remark.body.value.standing, true)
      const badStanding = await callRoute(route, {
        url: '/discussion-plaza/set-standing',
        headers: HOME_HEADERS,
        body: JSON.stringify({ args: { id: longId, standing: 'yes' } }),
      })
      assert.equal(badStanding.status, 400)

      const closeLong = await callRoute(route, {
        url: '/discussion-plaza/close-standing',
        headers: HOME_HEADERS,
        body: JSON.stringify({ args: { id: longId, reason: '收尾' } }),
      })
      assert.equal(closeLong.status, 200)
      assert.equal(closeLong.body.value.status, 'closed')
      const longDetail = await callRoute(route, {
        url: '/discussion-plaza/detail',
        headers: HOME_HEADERS,
        body: JSON.stringify({ args: { id: longId } }),
      })
      assert.equal(longDetail.body.value.group.standing, true)
      assert.equal(longDetail.body.value.group.status, 'closed')
      assert.ok(longDetail.body.value.markdown.includes('结束长期讨论'))
    } finally {
      await fiber.dispose()
    }
  })

  console.log('— 系统提示词与通知 —')

  await test('系统提示词小节注册了 plaza_* 工具与关闭流程', async () => {
    const { ctx, sections } = harness()
    const fiber = await mount(ctx, { rootDir: join(root, 'prompt') })
    try {
      const section = sections.find((entry) => entry.name === 'discussion-plaza:guidance')
      assert.ok(section !== undefined, 'guidance section missing')
      assert.equal(section.order, 2460)
      const text = typeof section.text === 'function' ? section.text({}) : section.text
      for (const name of ['plaza_list', 'plaza_read', 'plaza_append', 'plaza_lock', 'plaza_propose_close', 'plaza_confirm_close', 'plaza_cancel_close']) {
        assert.ok(text.includes(name), `guidance must mention ${name}`)
      }
      assert.ok(text.includes('所有工作区'), 'guidance must say the plaza is cross-workspace')
    } finally {
      await fiber.dispose()
    }
  })

  await test('pre-step 通知：参与者的未读注入一条 plugin:discussion-plaza notice，且不重复', async () => {
    const noticeRoot = join(root, 'notice')
    const store = createStore({ rootDir: noticeRoot })
    const created = await createGroup(store.paths, { title: '跨组讨论', intro: 'A 开场', by: { sessionId: A.id, name: 'A', workspace: A.workspace } })
    await joinGroup(store.paths, created.group.id, { sessionId: B.id, name: 'B', workspace: B.workspace })
    await appendMessage(store.paths, created.group.id, { sessionId: B.id, name: 'B', workspace: B.workspace }, 'B 给 A 的消息')

    const { ctx } = harness()
    const fiber = await mount(ctx, { rootDir: noticeRoot })
    try {
      const agent = { id: A.id, session: { id: A.id, header: { cwd: `D:\\GitHub\\${A.workspace}` } } }
      const controller = new AbortController()
      const claimed = [{ role: 'user', id: 'u1', content: [] }]
      const decision = await ctx.events.waterfall('agent/pre-step', {
        agent,
        messages: claimed,
        turn: 1,
        step: 1,
        signal: controller.signal,
      }, () => ({ kind: 'enter', messages: claimed }))
      assert.equal(decision.kind, 'enter')
      const notices = decision.messages.filter((message) => message?.source?.kind === 'plugin:discussion-plaza')
      assert.equal(notices.length, 1, 'expected exactly one plaza notice')
      const notice = notices[0]
      assert.equal(notice.source.form, 'notice')
      assert.ok(notice.content[0].text.includes(created.group.id))
      assert.ok(notice.content[0].text.includes('1 条未读'))
      assert.equal(decision.messages[0], claimed[0], 'the admitted batch must be preserved, notice appended after it')
      assert.equal(decision.messages[decision.messages.length - 1], notice)

      // 真实 v4 编码器：source.kind 的拼写错了，这一步才会暴露。
      if (catalog?.sessionFormatCatalog !== undefined) {
        catalog.sessionFormatCatalog.encodeCurrentEvent({ type: 'user/message', seq: 1, time: Date.now(), data: notice })
      }

      // 同样的未读再来一步：不应重复注入。
      const again = await ctx.events.waterfall('agent/pre-step', {
        agent, messages: claimed, turn: 1, step: 2, signal: new AbortController().signal,
      }, () => ({ kind: 'enter', messages: claimed }))
      assert.equal(again.messages.filter((message) => message?.source?.kind === 'plugin:discussion-plaza').length, 0)

      // 读完就不再通知。扫描缓存是 2 秒，等它过期再断言，免得测到旧快照。
      const tool = (await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'tools.js')).href))
        .createTools(store, {})
        .find((definition) => definition.name === 'plaza_read')
      await tool.execute({ id: created.group.id }, execFor(A))
      await new Promise((done) => { setTimeout(done, 2_100) })
      const afterRead = await ctx.events.waterfall('agent/pre-step', {
        agent, messages: claimed, turn: 2, step: 1, signal: new AbortController().signal,
      }, () => ({ kind: 'enter', messages: claimed }))
      assert.equal(afterRead.messages.filter((message) => message?.source?.kind === 'plugin:discussion-plaza').length, 0)

      // reject / aborted 都不能注入。
      const rejected = await ctx.events.waterfall('agent/pre-step', {
        agent, messages: claimed, turn: 3, step: 1, signal: new AbortController().signal,
      }, () => ({ kind: 'reject' }))
      assert.equal(rejected.kind, 'reject')
    } finally {
      await fiber.dispose()
    }
  })

  await test('通知关闭后不再扫描（notify:false 时不注入）', async () => {
    const { ctx } = harness()
    const fiber = await mount(ctx, { rootDir: join(root, 'notice'), notify: false })
    try {
      const agent = { id: A.id, session: { id: A.id, header: { cwd: `D:\\GitHub\\${A.workspace}` } } }
      const claimed = [{ role: 'user', id: 'u1', content: [] }]
      const decision = await ctx.events.waterfall('agent/pre-step', {
        agent, messages: claimed, turn: 1, step: 1, signal: new AbortController().signal,
      }, () => ({ kind: 'enter', messages: claimed }))
      assert.equal(decision.messages.length, 1)
    } finally {
      await fiber.dispose()
    }
  })

  await test('落盘文档自洽（validateGroup 无问题）', async () => {
    const store = createStore({ rootDir: join(root, 'flow') })
    const { listGroupIds, readGroupFile } = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'store.js')).href)
    const { validateGroup } = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'protocol.js')).href)
    const ids = await listGroupIds(store.paths)
    assert.ok(ids.length > 0)
    for (const id of ids) {
      const { group } = await readGroupFile(store.paths, id)
      assert.deepEqual(validateGroup(group), [], id)
    }
    const first = await readGroupFile(store.paths, ids[0])
    assert.equal(typeof first.group.title, 'string')
  })
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'} — ok ${passed} / fail ${failed}`)
if (failed > 0) process.exitCode = 1
