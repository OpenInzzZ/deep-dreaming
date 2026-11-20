/**
 * discussion-plaza 浏览器半的契约测试（jsdom + 真 React）。
 *
 * 这一半最怕的不是抛错，而是**静静地什么都没挂上**：交接 id 写错 → 模块永远
 * pending；注册到没人消费的槽位 → 永远不显示；main 的 key 与按钮的 PANEL_ID
 * 不一致 → 点按钮抛 `main panel "x" is not registered`。
 *
 * 所以这里真的跑两遍：
 *   1. 交接与注册面：`__ModuleLoader__.load`、`apply`、两个座位、locale 字典、
 *      CSS 只注入一次；
 *   2. 真渲染：用假 fetch 回放 view/detail，点行打开详情、点关闭收起、新建表单
 *      真的 POST `/discussion-plaza/create`；左下按钮真的调 `layout.selectPanel`。
 *
 * 从仓库根运行：
 *   node patches/discussion-plaza/tests/client-contract.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadDomDeps, loadUiModule } from '../../../scripts/test-deps.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-discussion-plaza'
const NS = 'sidebar.discussionPlaza'
const PANEL_ID = 'discussion-plaza'

let ok = 0
let fail = 0

/**
 * 跑一条同步断言并记账。
 * @param label - 断言描述。
 * @param run - 断言体。
 */
function check(label, run) {
  try {
    run()
    ok += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${String(error?.message ?? error).split('\n').join('\n       ')}`)
  }
}

/**
 * 跑一条异步断言并记账。
 * @param label - 断言描述。
 * @param run - 异步断言体。
 */
async function checkAsync(label, run) {
  try {
    await run()
    ok += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${String(error?.message ?? error).split('\n').join('\n       ')}`)
  }
}

const domDeps = loadDomDeps(import.meta.url)
const JSDOM = domDeps.JSDOM
const React = domDeps.React
const jsxRuntime = loadUiModule('react/jsx-runtime', import.meta.url)
const canRender = JSDOM !== null && React !== undefined && jsxRuntime !== undefined
if (!canRender) console.warn(`SKIP DOM/render checks: ${domDeps.hint}`)

const source = readFileSync(clientPath, 'utf8')

/**
 * 按 shell 内核的方式交接 bundle。
 */
function createShell() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://127.0.0.1:19387/',
  })
  const sharedWindow = dom.window
  globalThis.window = sharedWindow
  for (const key of Object.getOwnPropertyNames(sharedWindow)) {
    if (!(key in globalThis)) globalThis[key] = sharedWindow[key]
  }
  let handoff = null
  sharedWindow.__ModuleLoader__ = { load: (handler) => { handoff = handler } }
  new Function('window', 'document', source)(sharedWindow, sharedWindow.document)
  return { handoff, window: sharedWindow, document: sharedWindow.document }
}

const shell = createShell()

// --- 1. 交接 ----------------------------------------------------------------

check('bundle hands itself to window.__ModuleLoader__', () => {
  assert.ok(shell.handoff !== null && typeof shell.handoff === 'object', 'no handoff captured')
})

check('module id is the package name', () => {
  assert.equal(shell.handoff.id, PLUGIN_ID)
})

/**
 * 用给定种子词表装载客户端半。
 * @param table - `Map<string, unknown>`。
 */
function loadExports(table) {
  return shell.handoff.factory((name) => {
    if (table.has(name)) return table.get(name)
    throw new Error(`the client half required '${name}', which is not a seed word of the module table`)
  })
}

const MARKDOWN_STUB = React === undefined ? undefined : (props) => {
  // 真实 MarkdownText 渲染代码围栏时会读 labels.code；桩也要求它，防止再出现
  // “详情里有 ``` 就整页空白”的回归。
  if (props?.labels?.code === undefined) throw new Error('MarkdownText needs code labels')
  return React.createElement(
    'div', { className: 'markdown', 'data-md': String(props?.text ?? '') }, props?.text,
  )
}

const PRIMITIVES = React === undefined ? {} : new Proxy({ MarkdownText: MARKDOWN_STUB }, {
  get: (target, name) => {
    if (name === '__esModule' || typeof name !== 'string') return undefined
    const own = Reflect.get(target, name)
    if (own !== undefined) return own
    return React.forwardRef((props, ref) => React.createElement('svg', {
      ref,
      'data-icon': name,
      width: props?.size ?? 16,
      height: props?.size ?? 16,
    }))
  },
})

const table = new Map()
table.set('react', React)
table.set('react/jsx-runtime', jsxRuntime)
table.set('@deepseek-ai/dsh-client-ui-primitives', PRIMITIVES)

const exported = loadExports(table)

check('exports { apply, inject, NS }', () => {
  assert.equal(typeof exported.apply, 'function')
  assert.equal(exported.NS, NS)
  assert.deepEqual(exported.inject, ['slots', 'locale'],
    'the client half needs the slot table and the locale face; layout is an optional read')
})

check('unknown seed words are rejected loudly', () => {
  const bare = new Map([...table].filter(([name]) => name !== 'react/jsx-runtime'))
  assert.throws(() => loadExports(bare), /not a seed word of the module table/)
})

// --- 2. 注册面 --------------------------------------------------------------

/**
 * 假客户端 ctx：记录注册面，effect 立即执行。
 * @param layout - 可选的假 layout 服务。
 */
function fakeClientCtx(layout) {
  const registered = []
  const dictionaries = []
  const labels = []
  const injected = []
  const ctx = {
    effect: (fn, label) => {
      labels.push(label)
      const disposer = fn()
      if (typeof disposer === 'function') disposer()
    },
    inject: (services, callback) => { injected.push({ services, callback }) },
    get: (name) => (name === 'layout' ? layout : undefined),
    locale: {
      register: (ns, dict) => { dictionaries.push({ ns, dict }); return () => {} },
      bind: (ns) => (key) => `${ns}:${key}`,
    },
    slots: {
      inject: (name, run) => {
        const disposer = run()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registered, dictionaries, labels, injected }
}

const surface = fakeClientCtx()
exported.apply(surface.ctx)

check('registers exactly the footer button and the main panel', () => {
  const names = surface.registered.map((row) => row.options.name).sort()
  assert.deepEqual(names, ['main', 'sidebar.footer.action'],
    `expected 2 registrations, got ${surface.registered.map((row) => row.options.name).join(', ')}`)
})

check('footer button rides sidebar.footer.action beside the temp-session action', () => {
  const entry = surface.registered.find((row) => row.options.name === 'sidebar.footer.action')
  assert.ok(entry !== undefined, 'no sidebar.footer.action registration')
  assert.equal(entry.options.id, PANEL_ID)
  assert.equal(entry.options.order, 20, 'after the temp-session action (-10)')
  assert.equal(entry.options.locale, NS)
  assert.equal(typeof entry.options.inject, 'function', 'the button needs the open callback')
  const injectedProps = entry.options.inject()
  assert.equal(typeof injectedProps.openPlaza, 'function')
  assert.equal(typeof entry.component, 'function')
})

check('main panel key is character-identical to the footer button id', () => {
  const entry = surface.registered.find((row) => row.options.name === 'main')
  assert.ok(entry !== undefined, 'no main registration')
  assert.equal(entry.options.key, PANEL_ID, 'layout.selectPanel finds the panel by this key')
  assert.equal(entry.options.locale, NS)
  assert.equal(typeof entry.component, 'function')
})

check('both contributions share one locale namespace', () => {
  assert.deepEqual([...new Set(surface.registered.map((row) => row.options.locale))], [NS])
})

check('zh and en carry the same key set', () => {
  const dict = surface.dictionaries.find((row) => row.ns === NS)?.dict
  assert.ok(dict !== undefined, 'no dictionary registered')
  assert.deepEqual(Object.keys(dict.zh).sort(), Object.keys(dict.en).sort(),
    'every copy key must exist in both dictionaries')
})

check('the button label is 交流广场 / Plaza', () => {
  const dict = surface.dictionaries.find((row) => row.ns === NS)?.dict
  assert.equal(dict.zh.label, '交流广场')
  assert.equal(dict.en.label, 'Plaza')
  assert.equal(dict.zh.open, '讨论中')
  assert.equal(dict.zh.writing, '写入中')
  assert.equal(dict.zh.closing, '关闭确认中')
  assert.equal(dict.zh.closed, '已关闭')
})

check('every effect is labelled', () => {
  assert.ok(surface.labels.length > 0)
  for (const label of surface.labels) assert.ok(String(label).length > 0, 'an effect had no label')
})

check('css is injected once, tagged for unload', () => {
  const tag = shell.document.querySelector(`style[data-plugin-css="${PLUGIN_ID}/discussion-plaza.css"]`)
  assert.ok(tag !== null, 'no <style data-plugin-css> tag')
  assert.equal(tag.dataset.plugin, PLUGIN_ID)
  assert.ok(tag.textContent.includes('.dp-page'), 'the injected css looks empty')
  const before = shell.document.querySelectorAll('style[data-plugin]').length
  new Function('window', 'document', source)(shell.window, shell.document)
  assert.equal(shell.document.querySelectorAll('style[data-plugin]').length, before,
    'a reload must not stack a second style tag')
})

// --- 3. 真渲染 --------------------------------------------------------------

if (!canRender) {
  console.log('\nSKIP render checks: no jsdom/react; the contract checks above still ran')
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — ok ${ok} / fail ${fail}`)
  if (fail > 0) process.exitCode = 1
} else {
  const { createRoot } = await import('react-dom/client')
  const document = shell.document

  /** 有界轮询：React 18 并发提交，不能靠固定延时赌时序。 */
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  /** 一次渲染的容器 + 卸载函数。 */
  const mount = (Component, props) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    root.render(React.createElement(Component, props))
    return { container, unmount: () => { root.unmount(); container.remove() } }
  }

  /** 记录 fetch 并按 URL 回放；`view` 与 `detail` 是两份数据。 */
  const installFetch = (routes) => {
    const calls = []
    const original = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init, body: init?.body })
      const key = Object.keys(routes).find((candidate) => url.startsWith(candidate))
      if (key === undefined) throw new Error(`unexpected fetch ${url}`)
      return { ok: true, status: 200, json: async () => ({ ok: true, value: routes[key] }) }
    }
    return { calls, restore: () => { globalThis.fetch = original } }
  }

  const VIEW = {
    groups: [
      {
        id: 'dg_abcde_111111',
        title: '接口对齐',
        status: 'open',
        statusLabel: '讨论中',
        writing: false,
        participants: [
          { key: 'alpha/s-a', sessionId: 's-a', name: 'A', workspace: 'alpha', lastReadSeq: 2 },
          { key: 'beta/s-b', sessionId: 's-b', name: 'B', workspace: 'beta', lastReadSeq: 1 },
        ],
        participantCount: 2,
        messageCount: 2,
        createdAt: '2026-11-20T05:40:00.000Z',
        updatedAt: '2026-11-20T05:41:00.000Z',
        youAreParticipant: false,
        yourUnread: 0,
        path: 'C:/plaza/groups/dg_abcde_111111.md',
      },
      {
        id: 'dg_abcde_222222',
        title: '写入中的组',
        status: 'open',
        statusLabel: '讨论中',
        standing: true,
        writing: true,
        lock: { holder: { key: 'gamma/s-c', sessionId: 's-c', name: 'C', workspace: 'gamma' }, purpose: 'append', acquiredAt: '2026-11-20T05:42:00.000Z', expiresAt: '2026-11-20T05:44:00.000Z' },
        participants: [{ key: 'gamma/s-c', sessionId: 's-c', name: 'C', workspace: 'gamma', lastReadSeq: 0 }],
        participantCount: 1,
        messageCount: 0,
        createdAt: '2026-11-20T05:42:00.000Z',
        updatedAt: '2026-11-20T05:42:00.000Z',
        youAreParticipant: false,
        yourUnread: 0,
      },
    ],
    counts: { open: 2, closing: 0, closed: 0, writing: 1, total: 2 },
    invalid: [],
    paths: { root: 'C:/plaza', groups: 'C:/plaza/groups', locks: 'C:/plaza/locks' },
  }

  const DETAIL = {
    group: {
      ...VIEW.groups[0],
      status: 'closing',
      statusLabel: '关闭确认中',
      close: { by: 'alpha/s-a', at: '2026-11-20T05:43:00.000Z', reason: '结论已定' },
      pendingConfirmations: [{ key: 'alpha/s-b', sessionId: 's-b', name: 'A', workspace: 'alpha', lastReadSeq: 1 }],
      participants: [
        { key: 'alpha/s-a', sessionId: 's-a', name: 'A', workspace: 'alpha', lastReadSeq: 2, vote: 'confirm' },
        // 同一工作区的第二个会话：显示名与 A 相同，面板必须补短 session 区分。
        { key: 'alpha/s-b', sessionId: 's-b', name: 'A', workspace: 'alpha', lastReadSeq: 1 },
      ],
    },
    messages: [
      { seq: 1, at: '2026-11-20 13:40:00', author: 'alpha · A', body: '开场' },
      { seq: 2, at: '2026-11-20 13:41:00', author: 'beta · B', body: '回复' },
    ],
    markdown: '# 接口对齐\n\n> 讨论组 `dg_abcde_111111` · 状态：关闭确认中\n\n## 1 · 2026-11-20 13:40:00 · alpha · A\n\n开场\n\n```js\nconst answer = 42\n```',
    path: 'C:/plaza/groups/dg_abcde_111111.md',
  }

  const dict = surface.dictionaries.find((row) => row.ns === NS)?.dict ?? { zh: {}, en: {} }
  const t = (key) => dict.zh[key] ?? key
  const mainEntry = surface.registered.find((row) => row.options.name === 'main')
  const footerEntry = surface.registered.find((row) => row.options.name === 'sidebar.footer.action')

  await checkAsync('page renders the group list with status chips and the writing lock', async () => {
    const io = installFetch({ '/discussion-plaza/view': VIEW })
    const mounted = mount(mainEntry.component, { t })
    try {
      await waitFor(() => mounted.container.querySelectorAll('.dp-row').length === 2, 'two group rows')
      const rows = [...mounted.container.querySelectorAll('.dp-row')]
      assert.ok(rows[0].textContent.includes('接口对齐'))
      assert.ok(rows[0].textContent.includes('dg_abcde_111111'))
      assert.equal(rows[0].querySelector('.dp-chip').textContent, '讨论中')
      const writing = [...mounted.container.querySelectorAll('.dp-chip')].find((chip) => chip.textContent === '写入中')
      assert.ok(writing !== undefined, 'the writing group must show the 写入中 chip')
      assert.ok(rows[1].textContent.includes('长期'), 'a standing group must show the 长期 badge')
      assert.ok(rows[1].textContent.includes('gamma · C'), 'the lock holder must be named')
      assert.ok(io.calls.some((entry) => entry.url === '/discussion-plaza/view'), 'view must be fetched')
    } finally {
      mounted.unmount()
      io.restore()
    }
  })

  await checkAsync('clicking a row loads the detail pane (closing state, votes, markdown)', async () => {
    const io = installFetch({
      '/discussion-plaza/view': VIEW,
      '/discussion-plaza/detail': DETAIL,
      '/discussion-plaza/remove-participant': { removed: true, closed: false },
    })
    const mounted = mount(mainEntry.component, { t })
    try {
      await waitFor(() => mounted.container.querySelectorAll('.dp-row').length === 2, 'rows')
      mounted.container.querySelector('.dp-row').dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => mounted.container.querySelector('.dp-side') !== null, 'detail pane')
      const side = mounted.container.querySelector('.dp-side')
      assert.ok(side.textContent.includes('接口对齐'))
      assert.ok(side.textContent.includes('关闭提议'), 'close proposal section')
      assert.ok(side.textContent.includes('结论已定'), 'close reason')
      assert.ok(side.textContent.includes('已确认'), 'A has confirmed')
      assert.ok(side.textContent.includes('待确认'), 'B is pending')
      assert.ok(side.textContent.includes('alpha · A [s-a]'), 'duplicate participant names must get a session suffix')
      assert.ok(side.textContent.includes('alpha · A [s-b]'), 'the second same-name participant must be distinguishable')
      const markdown = side.querySelector('.markdown')
      assert.ok(markdown !== null, 'the transcript must go through MarkdownText')
      assert.ok(markdown.textContent.includes('开场'))
      assert.ok(io.calls.some((entry) => entry.url === '/discussion-plaza/detail'), 'detail must be fetched')

      // 人类移出参与者：面板必须用参与者的复合 key（工作区/sessionId）寻址。
      const removeButtons = [...mounted.container.querySelectorAll('.dp-side button')]
        .filter((button) => button.getAttribute('aria-label') === dict.zh.removeHint)
      assert.equal(removeButtons.length, 2, 'both participants offer human removal')
      removeButtons[1].dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => io.calls.some((entry) => entry.url === '/discussion-plaza/remove-participant'), 'remove request')
      const removeCall = io.calls.find((entry) => entry.url === '/discussion-plaza/remove-participant')
      assert.deepEqual(JSON.parse(removeCall.body), { args: { id: 'dg_abcde_111111', key: 'alpha/s-b' } })

      // 关闭详情回到列表。移除动作会触发重渲染，重新找按钮。
      const closeButton = [...mounted.container.querySelectorAll('.dp-side button')]
        .find((button) => button.getAttribute('aria-label') === '关闭详情')
      assert.ok(closeButton !== undefined, 'close detail button')
      closeButton.dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => mounted.container.querySelector('.dp-side') === null, 'detail closed')
    } finally {
      mounted.unmount()
      io.restore()
    }
  })

  await checkAsync('a detail render error shows an error instead of a blank page', async () => {
    const brokenGroup = { ...DETAIL.group };
    Object.defineProperty(brokenGroup, 'title', { get() { throw new Error('boom') } });
    const brokenDetail = { ...DETAIL, group: brokenGroup };
    const io = installFetch({
      '/discussion-plaza/view': VIEW,
      '/discussion-plaza/detail': brokenDetail,
    })
    const mounted = mount(mainEntry.component, { t })
    try {
      await waitFor(() => mounted.container.querySelectorAll('.dp-row').length === 2, 'rows')
      mounted.container.querySelector('.dp-row').dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => mounted.container.querySelector('.dp-error') !== null, 'error boundary')
      const text = mounted.container.querySelector('.dp-error').textContent
      assert.ok(text.includes('页面渲染失败'), 'the boundary must name the failure')
      assert.ok(text.includes('boom'), 'the original error must be visible for diagnosis')
    } finally {
      mounted.unmount()
      io.restore()
    }
  })

  await checkAsync('human can mark a group long-term, then end it with two-step confirm', async () => {
    const openGroup = {
      ...VIEW.groups[0],
      status: 'open',
      statusLabel: '讨论中',
      standing: false,
      close: undefined,
    }
    const openDetail = { group: openGroup, messages: [], markdown: '# 接口对齐\n\n正文', path: 'C:/plaza/groups/dg_abcde_111111.md' }
    const standingDetail = { ...openDetail, group: { ...openGroup, standing: true } }

    // 标记为长期讨论组
    let io = installFetch({
      '/discussion-plaza/view': VIEW,
      '/discussion-plaza/detail': openDetail,
      '/discussion-plaza/set-standing': { id: 'dg_abcde_111111', standing: true, changed: true },
    })
    let mounted = mount(mainEntry.component, { t })
    try {
      await waitFor(() => mounted.container.querySelectorAll('.dp-row').length === 2, 'rows')
      mounted.container.querySelector('.dp-row').dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => mounted.container.querySelector('.dp-side') !== null, 'side')
      const mark = [...mounted.container.querySelectorAll('.dp-side button')]
        .find((button) => button.textContent === '标记为长期讨论组')
      assert.ok(mark !== undefined, 'mark-standing button')
      mark.dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => io.calls.some((entry) => entry.url === '/discussion-plaza/set-standing'), 'set-standing request')
      assert.deepEqual(
        JSON.parse(io.calls.find((entry) => entry.url === '/discussion-plaza/set-standing').body),
        { args: { id: 'dg_abcde_111111', standing: true } },
      )
    } finally {
      mounted.unmount()
      io.restore()
    }

    // 结束长期讨论：两步确认后才发请求
    io = installFetch({
      '/discussion-plaza/view': VIEW,
      '/discussion-plaza/detail': standingDetail,
      '/discussion-plaza/close-standing': { id: 'dg_abcde_111111', status: 'closed' },
    })
    mounted = mount(mainEntry.component, { t })
    try {
      await waitFor(() => mounted.container.querySelectorAll('.dp-row').length === 2, 'rows')
      mounted.container.querySelector('.dp-row').dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => mounted.container.querySelector('.dp-side') !== null, 'side')
      const end = [...mounted.container.querySelectorAll('.dp-side button')]
        .find((button) => button.textContent === '结束长期讨论')
      assert.ok(end !== undefined, 'end-standing button')
      end.dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => [...mounted.container.querySelectorAll('.dp-side button')]
        .some((button) => button.textContent === '确认结束（只读）'), 'confirm-end button')
      assert.equal(io.calls.some((entry) => entry.url === '/discussion-plaza/close-standing'), false,
        'the first click must not close the group')
      const confirm = [...mounted.container.querySelectorAll('.dp-side button')]
        .find((button) => button.textContent === '确认结束（只读）')
      confirm.dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => io.calls.some((entry) => entry.url === '/discussion-plaza/close-standing'), 'close-standing request')
      assert.deepEqual(
        JSON.parse(io.calls.find((entry) => entry.url === '/discussion-plaza/close-standing').body),
        { args: { id: 'dg_abcde_111111' } },
      )
    } finally {
      mounted.unmount()
      io.restore()
    }
  })

  await checkAsync('the create form posts to /discussion-plaza/create', async () => {
    const io = installFetch({ '/discussion-plaza/view': { ...VIEW, groups: [], counts: { open: 0, closing: 0, closed: 0, writing: 0, total: 0 } }, '/discussion-plaza/create': { id: 'dg_abcde_333333' } })
    const mounted = mount(mainEntry.component, { t })
    try {
      await waitFor(() => mounted.container.querySelector('.dp-empty') !== null, 'empty state')
      const createButton = [...mounted.container.querySelectorAll('button')].find((button) => button.textContent.includes('新建讨论组'))
      assert.ok(createButton !== undefined, 'create button')
      createButton.dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true }))
      await waitFor(() => mounted.container.querySelector('.dp-form') !== null, 'create form')
      const input = mounted.container.querySelector('.dp-input')
      const setter = Object.getOwnPropertyDescriptor(shell.window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '新议题')
      input.dispatchEvent(new shell.window.Event('input', { bubbles: true }))
      const checkbox = mounted.container.querySelector('.dp-check input')
      assert.ok(checkbox !== null, 'standing checkbox')
      checkbox.click()
      const form = mounted.container.querySelector('.dp-form')
      form.dispatchEvent(new shell.window.Event('submit', { bubbles: true, cancelable: true }))
      await waitFor(() => io.calls.some((entry) => entry.url === '/discussion-plaza/create'), 'create request')
      const created = io.calls.find((entry) => entry.url === '/discussion-plaza/create')
      assert.deepEqual(JSON.parse(created.body), { args: { title: '新议题', intro: '', standing: true } })
    } finally {
      mounted.unmount()
      io.restore()
    }
  })

  await checkAsync('footer button opens the panel through the layout service', async () => {
    const io = installFetch({ '/discussion-plaza/view': VIEW })
    const selected = []
    const layout = { selectPanel: (id) => { selected.push(id) } }
    const surfaceWithLayout = fakeClientCtx(layout)
    exported.apply(surfaceWithLayout.ctx)
    const entry = surfaceWithLayout.registered.find((row) => row.options.name === 'sidebar.footer.action')
    const injectedProps = entry.options.inject()
    const mounted = mount(entry.component, { wide: true, t, ...injectedProps })
    try {
      await waitFor(() => mounted.container.querySelector('button') !== null, 'footer button')
      const button = mounted.container.querySelector('button')
      assert.ok(button.textContent.includes('交流广场'))
      button.dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true }))
      assert.deepEqual(selected, ['discussion-plaza'])
    } finally {
      mounted.unmount()
      io.restore()
    }
  })

  await checkAsync('footer button badges the number of active (open + closing) groups', async () => {
    const base = {
      participants: [], participantCount: 0, messageCount: 1, writing: false,
      createdAt: '2026-11-20T05:40:00.000Z', updatedAt: '2026-11-20T05:41:00.000Z',
      youAreParticipant: false, yourUnread: 0,
    }
    const badgeView = {
      groups: [
        { ...base, id: 'dg_badge_777777', title: '进行中', status: 'open', statusLabel: '讨论中', standing: false },
        { ...base, id: 'dg_badge_888888', title: '待确认', status: 'closing', statusLabel: '关闭确认中', standing: false },
      ],
      counts: { open: 1, closing: 1, closed: 0, writing: 0, total: 2 },
      invalid: [],
    }
    const io = installFetch({ '/discussion-plaza/view': badgeView })
    const mounted = mount(footerEntry.component, { wide: true, t, ...footerEntry.options.inject() })
    try {
      await waitFor(() => mounted.container.querySelector('.dp-badge-count')?.textContent === '2', 'badge count 2')
      assert.ok(mounted.container.querySelector('.dp-btn').getAttribute('aria-label').includes('进行中'))
    } finally {
      mounted.unmount()
      io.restore()
    }
  })

  await checkAsync('a missing layout service must not throw from the footer button', async () => {
    const io = installFetch({ '/discussion-plaza/view': VIEW })
    const surfaceWithoutLayout = fakeClientCtx(undefined)
    exported.apply(surfaceWithoutLayout.ctx)
    const entry = surfaceWithoutLayout.registered.find((row) => row.options.name === 'sidebar.footer.action')
    const mounted = mount(entry.component, { wide: false, t, ...entry.options.inject() })
    try {
      await waitFor(() => mounted.container.querySelector('button') !== null, 'footer button')
      const button = mounted.container.querySelector('button')
      button.dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true }))
    } finally {
      mounted.unmount()
      io.restore()
    }
  })

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — ok ${ok} / fail ${fail}`)
  if (fail > 0) process.exitCode = 1
}
