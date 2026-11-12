/**
 * queue-reorder 浏览器半的契约测试（jsdom）。
 *
 * 这一半最怕的是「看起来挂上了，其实影子都没动」：注册错槽位、组件崩了被
 * 官方容错吞掉、或者属性打在了一个官方根本不会渲染的节点上。所以这里不复读
 * 源码，而是**把官方 QueueDock 的形状搭出来**（同样的 `data-queue-dock` / `li` /
 * `data-submission-echo` 结构），再把本插件的组件真的跑一遍（真 React +
 * 真 jsdom），断言：
 *
 *  1. 模块交接 id 与声明的服务表 —— 名字错一个，整个客户端半就永远 pending；
 *  2. 注册落在 `conversation.input.dock`，但用的是**独立 id**（`queue-reorder`）
 *     而不是官方的 `queue`：同 id + 更低 priority 才是遮蔽，这里是并存；
 *  3. 组件对官方行打标记：id 属性、draggable、回显行不参与、单行时不打；
 *  4. 三步换位的换算：拖 A 到 C 的行上 → 宿主收到的是 C 在 `next-turn` 里的下标；
 *  5. 按在按钮上不触发拖拽、编辑中的行（textarea）不参与；
 *  6. 失败路径：传输层错误提示「服务未加载」，宿主拒绝提示「可能已开始发送」；
 *  7. 卸载后标记被清掉、监听被拆掉（热重载不留残渣）。
 *
 * 从仓库根运行：
 *   node patches/queue-reorder/tests/client-contract.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadDomDeps } from '../../../scripts/test-deps.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const patchDir = join(here, '..')
const clientPath = join(patchDir, 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-client-queue-reorder'

const domDeps = loadDomDeps(import.meta.url)
const JSDOM = domDeps.JSDOM
const React = domDeps.React
if (!domDeps.available) console.warn(`SKIP DOM checks: ${domDeps.hint}`)

const source = readFileSync(clientPath, 'utf8')

// --- 装载：与 shell 内核完全一样地交棒 ---------------------------------------
let handoff = null
const sharedDocument = JSDOM !== null
  ? new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:19387/' }).window
  : null
if (sharedDocument !== null) {
  globalThis.window = sharedDocument
  for (const key of Object.getOwnPropertyNames(sharedDocument)) {
    if (!(key in globalThis)) globalThis[key] = sharedDocument[key]
  }
  sharedDocument.__ModuleLoader__ = { load: (h) => { handoff = h } }
  new Function('window', 'document', source)(sharedDocument, sharedDocument.document)
} else {
  const shimDocument = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, setAttribute: () => {}, appendChild: () => {} }),
    head: { appendChild: () => {} },
  }
  const shimWindow = { __ModuleLoader__: { load: (h) => { handoff = h } } }
  new Function('window', 'document', source)(shimWindow, shimDocument)
}

assert.ok(handoff !== null, 'the bundle must hand itself to window.__ModuleLoader__')
assert.equal(handoff.id, PLUGIN_ID, 'the module id must be the package name (the shell resolves the client half by it)')

// --- 1. 服务表 + 纯逻辑（无 DOM 也能跑） --------------------------------------
// 模块只 require 一个种子词 `react`。有真 React 时必须喂真 React：组件闭包里
// 拿到的是这里这一份，桩件会让 useEffect 变成空操作，后面「渲染后打标记」就
// 永远测不出真实行为。
const STUB_REACT = { useEffect: () => {}, useRef: (value) => ({ current: value }) }
let exported = null
{
  const table = new Map()
  const uiRequire = (name) => {
    if (table.has(name)) return table.get(name)
    throw new Error(`the client half required '${name}', which is not a seed word of the module table`)
  }
  table.set('react', React ?? STUB_REACT)
  exported = handoff.factory(uiRequire)
}

assert.deepEqual(exported.inject, ['slots', 'locale', 'sessions'],
  'the decorator needs the slot table, the locale face and the session scopes — nothing else')
assert.equal(typeof exported.apply, 'function')
assert.equal(exported.NS, 'queue.reorder')
assert.equal(exported.queuedPlacement, 'queued', 'every toIndex is relative to the next-turn list')
assert.equal(exported.dockSelector, '[data-queue-dock]')
assert.equal(exported.echoAttribute, 'data-submission-echo')

// visibleQueue 必须逐字复刻官方坞的过滤：本地已进 transcript 的提交要排除。
{
  const inbox = {
    'next-turn': [
      { id: 'm1', source: { kind: 'user', rpcId: 'r1' } },
      { id: 'm2', source: { kind: 'user', rpcId: 'r2' } },
      { id: 'm3', source: { kind: 'plugin:project-memory', form: 'notice' } },
    ],
  }
  assert.deepEqual(exported.visibleQueue(inbox, []).map((m) => m.id), ['m1', 'm2', 'm3'])
  assert.deepEqual(
    exported.visibleQueue(inbox, [{ requestId: 'r1', placement: 'transcript' }]).map((m) => m.id),
    ['m2', 'm3'],
    'a submission already echoed into the transcript must not occupy a row',
  )
  // queued 状态的本地提交还没有 inbox 行，不影响持久行的顺序。
  assert.deepEqual(
    exported.visibleQueue(inbox, [{ requestId: 'r9', placement: 'queued' }]).map((m) => m.id),
    ['m1', 'm2', 'm3'],
  )
  // 脏输入不许抛：缺 inbox、inbox 是 null、next-turn 不是数组。
  assert.deepEqual(exported.visibleQueue(undefined, undefined), [])
  assert.deepEqual(exported.visibleQueue(null, null), [])
  assert.deepEqual(exported.visibleQueue({ 'next-turn': 'nope' }, []), [])
}
assert.equal(exported.nextTurnIndexOf({ 'next-turn': [{ id: 'a' }, { id: 'b' }] }, 'b'), 1)
assert.equal(exported.nextTurnIndexOf({ 'next-turn': [{ id: 'a' }] }, 'zz'), -1)
assert.equal(exported.nextTurnIndexOf(null, 'a'), -1)

// --- 2. 注册面 ----------------------------------------------------------------
{
  const registered = []
  const effects = []
  const dictionaries = []
  const ctx = {
    effect: (fn, label) => { effects.push(label); const disposer = fn(); if (typeof disposer === 'function') disposer() },
    locale: {
      register: (ns, dict) => { dictionaries.push({ ns, dict }); return () => {} },
      bind: (ns) => (key) => `${ns}:${key}`,
    },
    slots: {
      inject: (name, run) => { const disposer = run(); return typeof disposer === 'function' ? disposer : () => {} },
      register: (options, component) => { registered.push({ options, component }); return () => {} },
    },
    sessions: { scope: () => ({ get: () => ({ updateQueue: () => {}, input: { for: () => ({ notify: () => {} }) } }) }) },
  }
  exported.apply(ctx)
  assert.equal(registered.length, 1, 'exactly one slot registration')
  const { options } = registered[0]
  assert.equal(options.name, 'conversation.input.dock', 'it must ride the SAME slot as the shipped dock')
  assert.equal(options.id, 'queue-reorder', 'a DIFFERENT id — same id with a lower priority is what shadows')
  assert.equal(options.priority, undefined,
    'no priority override: the shipped queue cell must keep priority 0 and win its own cell')
  assert.equal(options.order, 30, 'it must sit after the shipped queue entry (order 20)')
  assert.equal(options.locale, 'queue.reorder')
  assert.ok(dictionaries.some((d) => d.ns === 'queue.reorder'), 'the dictionaries must be registered')
  const dict = dictionaries[0].dict
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort(),
    'every copy key must exist in both dictionaries')
}

// --- 3..7. DOM 行为 -----------------------------------------------------------
/**
 * 把官方 QueueDock 的 DOM 形状搭出来。
 * @param rows - 持久行，`{ id, text, echo }`。
 * @returns 容器元素。
 */
function mountDock(rows) {
  const document = globalThis.document
  document.body.innerHTML = ''
  const dock = document.createElement('div')
  dock.setAttribute('data-queue-dock', '')
  const list = document.createElement('ul')
  for (const row of rows) {
    const li = document.createElement('li')
    if (row.echo === true) li.setAttribute('data-submission-echo', '')
    const preview = document.createElement('span')
    preview.textContent = row.text ?? row.id
    li.appendChild(preview)
    if (row.editing === true) {
      const area = document.createElement('textarea')
      li.appendChild(area)
    }
    list.appendChild(li)
  }
  dock.appendChild(list)
  document.body.appendChild(dock)
  return dock
}

/** 造一个浏览器 DragEvent（jsdom 没有 DataTransfer，手工补一个最小的）。 */
function dragEvent(type, target, dataTransfer = {}) {
  const EventCtor = globalThis.window.DragEvent ?? globalThis.window.Event
  let event
  try {
    event = new EventCtor(type, { bubbles: true, cancelable: true })
  } catch {
    event = new globalThis.window.Event(type, { bubbles: true, cancelable: true })
  }
  Object.defineProperty(event, 'target', { value: target, configurable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer, configurable: true })
  return event
}

const DOM_CHECKS = sharedDocument !== null

if (!DOM_CHECKS) {
  console.log('SKIP DOM checks: no jsdom/react; the pure-logic and registration checks above still ran')
} else {
  const document = globalThis.document

  // 3. 装饰：两行时打标记，回显行不打，编辑中的行不打，单行时不打。
  {
    mountDock([{ id: 'a' }, { id: 'b' }, { id: 'echo-1', echo: true }, { id: 'c', editing: true }])
    const rows = exported.stampRows(['a', 'b', 'c'], true)
    assert.equal(rows.length, 3, 'the echo row must not be part of the durable rows')
    assert.equal(rows[0].getAttribute('data-queue-reorder-id'), 'a')
    assert.equal(rows[1].getAttribute('data-queue-reorder-id'), 'b')
    assert.equal(rows[2].getAttribute('data-queue-reorder-id'), null, 'an editing row must not be armed')
    assert.equal(rows[0].getAttribute('draggable'), 'true')
    assert.equal(rows[2].getAttribute('draggable'), null)
    const echoRow = document.querySelector('[data-submission-echo]')
    assert.equal(echoRow.getAttribute('draggable'), null, 'a local echo has no inbox row to splice')
  }
  {
    // 单行：没有可换的顺序，不参与拖拽。
    mountDock([{ id: 'only' }])
    const rows = exported.stampRows(['only'], true)
    assert.equal(rows[0].getAttribute('draggable'), null)
  }
  {
    // id 数与行数对不上（官方坞渲染形状变了）：一律不打标记，宁可不排。
    mountDock([{ id: 'a' }, { id: 'b' }])
    const rows = exported.stampRows(['a'], true)
    assert.equal(rows[0].getAttribute('data-queue-reorder-id'), null)
    assert.equal(rows[1].getAttribute('data-queue-reorder-id'), null)
  }
  {
    // 会话不允许队列变更（子代理不可续接）：同样不打标记。
    mountDock([{ id: 'a' }, { id: 'b' }])
    const rows = exported.stampRows(['a', 'b'], false)
    assert.equal(rows[0].getAttribute('draggable'), null)
  }

  // 4. 拖放换算：拖 a 的行落到 c 的行上 → 宿主收到 c 在 next-turn 里的下标 2。
  {
    mountDock([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    const inbox = { 'next-turn': [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
    exported.stampRows(['a', 'b', 'c'], true)
    const calls = []
    const uninstall = exported.installDrag({
      latest: () => ({ inbox }),
      reorder: (itemId, toIndex) => { calls.push({ itemId, toIndex }); return Promise.resolve() },
      onError: (error) => { throw error },
    })
    const [rowA, , rowC] = exported.queueRowElements()
    document.dispatchEvent(dragEvent('dragstart', rowA))
    assert.equal(rowA.getAttribute('data-queue-reorder-dragging'), '1')
    document.dispatchEvent(dragEvent('dragover', rowC))
    assert.equal(rowC.getAttribute('data-queue-reorder-over'), '1')
    document.dispatchEvent(dragEvent('drop', rowC))
    assert.equal(rowA.getAttribute('data-queue-reorder-dragging'), null, 'the drag marks must clear on drop')
    // reorder 走的是 microtask，flush 一次。
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, [{ itemId: 'a', toIndex: 2 }],
      'dropping on the row of "c" means the host index of "c" inside next-turn')
    uninstall()
  }

  // 5. 按在按钮上不触发拖拽；编辑态的行不参与。
  {
    mountDock([{ id: 'a' }, { id: 'b' }])
    const inbox = { 'next-turn': [{ id: 'a' }, { id: 'b' }] }
    exported.stampRows(['a', 'b'], true)
    const calls = []
    const uninstall = exported.installDrag({
      latest: () => ({ inbox }),
      reorder: (itemId, toIndex) => { calls.push({ itemId, toIndex }); return Promise.resolve() },
      onError: () => {},
    })
    const rows = exported.queueRowElements()
    const button = document.createElement('button')
    rows[0].appendChild(button)
    const down = new globalThis.window.Event('pointerdown', { bubbles: true })
    Object.defineProperty(down, 'target', { value: button, configurable: true })
    document.dispatchEvent(down)
    const start = dragEvent('dragstart', rows[0])
    document.dispatchEvent(start)
    assert.equal(start.defaultPrevented, true, 'pressing a button must not start a drag')
    assert.equal(rows[0].getAttribute('data-queue-reorder-dragging'), null)
    uninstall()
  }
  {
    // 编辑中的行虽然打了 draggable，也可能在两次渲染之间进入编辑态：dragstart 兜底拒绝。
    mountDock([{ id: 'a' }, { id: 'b' }])
    exported.stampRows(['a', 'b'], true)
    const rows = exported.queueRowElements()
    rows[0].appendChild(document.createElement('textarea'))
    const calls = []
    const uninstall = exported.installDrag({
      latest: () => ({ inbox: { 'next-turn': [{ id: 'a' }, { id: 'b' }] } }),
      reorder: (itemId, toIndex) => { calls.push({ itemId, toIndex }); return Promise.resolve() },
      onError: () => {},
    })
    const start = dragEvent('dragstart', rows[0])
    document.dispatchEvent(start)
    assert.equal(start.defaultPrevented, true, 'a row holding an editor must not be dragged')
    uninstall()
  }

  // 6. 失败路径的两种措辞。
  {
    mountDock([{ id: 'a' }, { id: 'b' }])
    exported.stampRows(['a', 'b'], true)
    const toasts = []
    const uninstall = exported.installDrag({
      latest: () => ({ inbox: { 'next-turn': [{ id: 'a' }, { id: 'b' }] } }),
      reorder: () => {
        const error = new Error('boom')
        error.code = 'transport'
        return Promise.reject(error)
      },
      onError: (error) => toasts.push(error.code === 'transport' ? 'unavailable' : 'failed'),
    })
    const rows = exported.queueRowElements()
    document.dispatchEvent(dragEvent('dragstart', rows[0]))
    document.dispatchEvent(dragEvent('drop', rows[1]))
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(toasts, ['unavailable'], 'a missing route must be reported as "service not loaded"')
    uninstall()
  }

  // 7. 卸载：标记清掉、事件不再响应。
  {
    mountDock([{ id: 'a' }, { id: 'b' }])
    exported.stampRows(['a', 'b'], true)
    const calls = []
    const uninstall = exported.installDrag({
      latest: () => ({ inbox: { 'next-turn': [{ id: 'a' }, { id: 'b' }] } }),
      reorder: (itemId, toIndex) => { calls.push({ itemId, toIndex }); return Promise.resolve() },
      onError: () => {},
    })
    const rows = exported.queueRowElements()
    document.dispatchEvent(dragEvent('dragstart', rows[0]))
    uninstall()
    document.dispatchEvent(dragEvent('drop', rows[1]))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, [], 'after uninstall no reorder may be issued')
    assert.equal(rows[0].getAttribute('data-queue-reorder-dragging'), null, 'uninstall must clear its marks')
  }

  // 组件本身：真的用 React 渲染一次，断言它不产出 DOM 且会把标记打上去。
  {
    mountDock([{ id: 'a' }, { id: 'b' }])
    const { createRoot } = await import('react-dom/client')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const ctx = {
      effect: (fn) => { fn(); return () => {} },
      locale: { register: () => () => {}, bind: () => (key) => key },
      slots: {
        inject: (name, run) => run(),
        register: (options, component) => { ctx.__component = component; return () => {} },
      },
      sessions: {
        scope: () => ({
          get: () => ({ updateQueue: () => {}, input: { for: () => ({ notify: () => {} }) } }),
        }),
      },
    }
    // 组件通过槽位注册被拿到；这里直接渲染它，并喂一个假的标准 props 面。
    exported.apply(ctx)
    const Component = ctx.__component
    const inbox = { 'next-turn': [{ id: 'a' }, { id: 'b' }] }
    const hooks = {
      useProjection: () => inbox,
      useSession: (selector) => selector({
        pendingSubmissions: [],
        subagent: null,
        running: true,
      }),
      sessionId: 'sess-1',
      reorder: () => Promise.resolve(),
      notify: () => {},
      t: (key) => key,
    }
    root.render(React.createElement(Component, hooks))
    // React 18 的 createRoot 是并发提交的：render() 之后 effect 不一定已经跑过。
    // 轮询到标记出现为止（有界），不要靠固定延时赌时序。
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error(`timed out waiting for ${label}`)
    }
    await waitFor(
      () => exported.queueRowElements()[0]?.getAttribute('data-queue-reorder-id') === 'a',
      'the decorator to stamp the shipped rows',
    )
    assert.equal(container.childNodes.length, 0, 'the decorator must render nothing of its own')
    const rows = exported.queueRowElements()
    assert.equal(rows[1].getAttribute('data-queue-reorder-id'), 'b')

    // 8. 回归：展开队列坞是官方坞自己的 local state，**不会**重渲染本组件。
    //    折叠态下多行坞不渲染任何行，展开时行是新插入的 DOM。如果不靠 DOM 观察
    //    （或 pointerdown/dragstart 兜底），用户点开坞后要等下一次 inbox 变化才能
    //    拖 —— 实测的「时灵时不灵 / 要等一下才能拖」就是这个。
    {
      const dock = document.querySelector('[data-queue-dock]')
      const list = dock.querySelector('ul')
      // 折叠：官方坞把行整批摘掉（行还在，只是被 hidden/卸载——这里模拟卸载）。
      for (const li of [...list.children]) li.remove()
      assert.deepEqual(exported.queueRowElements(), [], 'collapsed: no durable rows in the DOM')

      // 展开：行作为**新节点**插回来（真实场景是 React 新建的 li），期间没有
      // 任何一次本组件重渲染。
      for (const id of ['a', 'b']) {
        const li = document.createElement('li')
        const span = document.createElement('span')
        span.textContent = id
        li.appendChild(span)
        list.appendChild(li)
      }
      assert.equal(exported.queueRowElements()[0].getAttribute('data-queue-reorder-id'), null,
        'freshly inserted rows are not armed by React — that is the bug being pinned')
      exported.stampNow()
      assert.equal(exported.queueRowElements()[0].getAttribute('data-queue-reorder-id'), 'a',
        'stampNow() must arm rows that appeared outside a React render')
      assert.equal(exported.queueRowElements()[1].getAttribute('draggable'), 'true')

      // 观察者路径：DOM 变动后由 MutationObserver 自动补标记（microtask 合并）。
      const stop = exported.observeDock()
      for (const li of [...list.children]) {
        li.removeAttribute('data-queue-reorder-id')
        li.removeAttribute('draggable')
        li.remove()
      }
      for (const id of ['a', 'b']) {
        const li = document.createElement('li')
        const span = document.createElement('span')
        span.textContent = id
        li.appendChild(span)
        list.appendChild(li)
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(exported.queueRowElements()[0].getAttribute('data-queue-reorder-id'), 'a',
        'the dock observer must arm rows inserted by an expand/collapse')
      stop()
    }

    root.unmount()
    document.body.innerHTML = ''
  }

  // 9. dragstart 兜底：标记缺失时现场补一次，而不是直接放弃。
  {
    mountDock([{ id: 'a' }, { id: 'b' }])
    exported.stampRows(['a', 'b'], true)
    // 模拟「行是新插入的、尚未打标记」：清掉属性。
    for (const li of exported.queueRowElements()) {
      li.removeAttribute('data-queue-reorder-id')
      li.removeAttribute('draggable')
    }
    const inbox = { 'next-turn': [{ id: 'a' }, { id: 'b' }] }
    // stampNow 读的是最近一次渲染的表；这里手动把它对齐到本测试的 id 表。
    exported.stampNow()
    const calls = []
    const uninstall = exported.installDrag({
      latest: () => ({ inbox }),
      reorder: (itemId, toIndex) => { calls.push({ itemId, toIndex }); return Promise.resolve() },
      onError: () => {},
    })
    const rows = exported.queueRowElements()
    rows[0].removeAttribute('data-queue-reorder-id')
    rows[0].removeAttribute('draggable')
    document.dispatchEvent(dragEvent('dragstart', rows[0]))
    document.dispatchEvent(dragEvent('drop', rows[1]))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, [{ itemId: 'a', toIndex: 1 }],
      'dragstart must re-stamp on the spot instead of refusing the drag')
    uninstall()
  }

  // 10. pressed 不残留：点过一次按钮后，仍能从同一行拖。
  {
    mountDock([{ id: 'a' }, { id: 'b' }])
    exported.stampRows(['a', 'b'], true)
    const inbox = { 'next-turn': [{ id: 'a' }, { id: 'b' }] }
    const calls = []
    const uninstall = exported.installDrag({
      latest: () => ({ inbox }),
      reorder: (itemId, toIndex) => { calls.push({ itemId, toIndex }); return Promise.resolve() },
      onError: () => {},
    })
    const rows = exported.queueRowElements()
    const button = document.createElement('button')
    rows[0].appendChild(button)
    const down = new globalThis.window.Event('pointerdown', { bubbles: true })
    Object.defineProperty(down, 'target', { value: button, configurable: true })
    document.dispatchEvent(down)
    const up = new globalThis.window.Event('pointerup', { bubbles: true })
    document.dispatchEvent(up)
    // 点完按钮后从该行的文字区域起手拖拽，必须能拖。
    const down2 = new globalThis.window.Event('pointerdown', { bubbles: true })
    Object.defineProperty(down2, 'target', { value: rows[0].querySelector('span'), configurable: true })
    document.dispatchEvent(down2)
    const start = dragEvent('dragstart', rows[0])
    document.dispatchEvent(start)
    assert.equal(start.defaultPrevented, false, 'a stale pressed button must not block the next drag')
    document.dispatchEvent(dragEvent('drop', rows[1]))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, [{ itemId: 'a', toIndex: 1 }])
    uninstall()
  }
}

console.log('client-contract OK: separate slot id (no shadowing), stamps shipped rows by message id, drag maps a drop to the host next-turn index, refuses button presses and editing rows, and reports transport vs host failures differently')