/**
 * todo-board 浏览器半的契约测试（jsdom + 真 React）。
 *
 * 这一半最怕的不是"抛错"，而是**静静地什么都没挂上**：交接 id 写错 → 模块永远
 * pending；注册到没人声明的槽位 → 永远不显示；组件 render 抛错 → 被官方容错吞掉，
 * 界面上只是少了一行。所以这里不复读源码，而是把两半真的跑一遍：
 *
 *  1. 交接：`window.__ModuleLoader__.load()` 收到的 id 必须是包名，导出必须是
 *     `{ apply, inject, NS }`，服务表只能是 `['slots','locale']`；
 *  2. 注册面：只有两个贡献点，是宿主「左侧导航行 + 中列整页」的**成对座位**
 *     `sidebar.panellist` / `main`，各自的 id 与 key **必须逐字相同**（否则宿主
 *     `selectPanel()` 抛 `main panel "x" is not registered`），并共用同一个 locale
 *     命名空间；
 *  3. 字典：zh / en 键集必须完全一致 —— 少一个键，另一种语言就渲染出原始 key；
 *  4. 真渲染：侧栏 glyph 的未办点、整页的标题/计数/tab/分组/行/动作按钮、功能分支
 *     的标记文案（`Nacos` 不能写成 `NACOS`）、空态、错误条，以及**点标题在整页
 *     右侧打开详情栏**（不是平台右侧边栏 —— 整页面板激活时那一列没有
 *     on-screen session，`openTab` 必抛 `no session surface is mounted`）；
 *  5. 传输契约：`call()` 打的是 `POST /todo-board/<endpoint>` + JSON body
 *     `{ args }`，并解 `{ ok, value }` 信封；
 *  6. 样式只注入一次。
 *
 * 从仓库根运行：
 *   node patches/todo-board/tests/client-contract.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadDomDeps, loadUiModule } from '../../../scripts/test-deps.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-todo-board'
const NS = 'sidebar.todoBoard'
const PANEL_ID = 'todo-board'

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
 * 跑一条异步断言并记账。渲染段的断言几乎都要等 React 提交，必须走这个，
 * 否则断言失败只会变成一次裸异常退出，计数里看不见（"ALL PASS" 也就不作数了）。
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
 * @returns `{ handoff, window, document }`
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
 * @returns 导出对象。
 */
function loadExports(table) {
  return shell.handoff.factory((name) => {
    if (table.has(name)) return table.get(name)
    throw new Error(`the client half required '${name}', which is not a seed word of the module table`)
  })
}

/** 详情页正文的替身：真组件渲染成 `<div class="markdown">`，用来断言正文真的交给了
 * 平台的 Markdown 渲染器，而不是被当纯文本摆出来。 */
const MARKDOWN_STUB = React === undefined ? undefined : (props) => React.createElement(
  'div', { className: 'markdown', 'data-md': String(props?.text ?? '') }, props?.text,
)

/** 图标替身：渲染成带 `data-icon` 的 `<svg>`，用来断言图标真的被调用。 */
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
    'the client half needs the slot table and the locale face — nothing else')
})

check('unknown seed words are rejected loudly', () => {
  const bare = new Map([...table].filter(([name]) => name !== 'react/jsx-runtime'))
  assert.throws(() => loadExports(bare), /not a seed word of the module table/)
})

// --- 2. 注册面 --------------------------------------------------------------
/**
 * 假客户端 ctx：记录注册面，effect 立即执行。
 *
 * 浏览器半只依赖槽位与语言包，没有动态 `inject` —— 详情走整页自己的右侧栏，
 * 不再探测平台的 `sidebarRight`（那一列在整页面板激活时没有 session）。
 * `inject` 仍然记一笔，断言它一次都没被调用。
 * @returns `{ ctx, registered, dictionaries, labels, injected }`
 */
function fakeClientCtx() {
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

check('registers exactly the paired seats (row + page)', () => {
  assert.equal(surface.registered.length, 2,
    `expected 2 registrations (main, sidebar row), got ${surface.registered.length}: ` +
    surface.registered.map((row) => row.options.name).join(', '))
})

check('no dynamic inject: the detail lives inside the page, not in sidebarRight', () => {
  // 老宿主没有右侧边栏，而平台在 `activePanelId !== null` 时把 on-screen session
  // 置空 —— 在整页面板里 openTab 必抛 `no session surface is mounted`。所以这一半
  // 不该再探测（也不该注册）任何 sidebarRight 面。
  assert.deepEqual(exported.inject, ['slots', 'locale'])
  assert.equal(surface.injected.length, 0, 'the client half must not probe optional services')
  const names = surface.registered.map((row) => row.options.name)
  assert.ok(!names.some((name) => String(name).startsWith('sidebar.right')), names.join(', '))
})

check('sidebar row rides sidebar.panellist (never sidebar.footer.action)', () => {
  const entry = surface.registered.find((row) => row.options.name === 'sidebar.panellist')
  assert.ok(entry !== undefined, 'no sidebar.panellist registration')
  assert.equal(entry.options.id, PANEL_ID, 'a distinct id — the shipped rows keep their own seats')
  assert.equal(entry.options.order, 20, 'after 插件(0) / 自动化任务(10), before 记忆(60); 更多 is always last')
  assert.equal(entry.options.locale, NS)
  assert.equal(typeof entry.options.label, 'function', 'the row label follows the active locale')
  assert.equal(entry.options.label(), NS + ':label')
  // 宿主自己的 PanelRow 负责按钮、点击与 aria-current：插件不该自己造按钮。
  assert.equal(typeof entry.component, 'function', 'the row seat takes a glyph component')
})

check('page rides the main seat with the same key as the row id', () => {
  const entry = surface.registered.find((row) => row.options.name === 'main')
  assert.ok(entry !== undefined, 'no main registration')
  // 宿主 selectPanel(id) 按 options.key 找 main entry，两处不一致就抛
  // `main panel "x" is not registered`。
  assert.equal(entry.options.key, PANEL_ID, 'the main key must be character-identical to the row id')
  assert.equal(entry.options.locale, NS)
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

check('the row label is 工作清单 / Work board', () => {
  const dict = surface.dictionaries.find((row) => row.ns === NS)?.dict
  assert.equal(dict.zh.label, '工作清单')
  assert.equal(dict.zh.panelTitle, '工作清单')
  assert.equal(dict.en.label, 'Work board')
})

check('the detail column copy says 详情 / Details', () => {
  const dict = surface.dictionaries.find((row) => row.ns === NS)?.dict
  assert.equal(dict.zh.detailTitle, '详情')
  assert.equal(dict.en.detailTitle, 'Details')
  assert.equal(dict.zh.detailClose, '关闭详情')
  assert.equal(dict.zh.detailNoSidebar, undefined, 'the sidebar-unavailable copy has no place any more')
})

check('every effect is labelled', () => {
  assert.ok(surface.labels.length > 0)
  for (const label of surface.labels) assert.ok(String(label).length > 0, 'an effect had no label')
})

check('css is injected once, tagged for unload', () => {
  const tag = shell.document.querySelector(`style[data-plugin-css="${PLUGIN_ID}/todo-board.css"]`)
  assert.ok(tag !== null, 'no <style data-plugin-css> tag')
  assert.equal(tag.dataset.plugin, PLUGIN_ID)
  assert.ok(tag.textContent.includes('.tb-page'), 'the injected css looks empty')
  // 再交接一次：同一个 tagId 必须去重，不能叠第二个 <style>。
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

  /** 有界轮询：React 18 的 createRoot 是并发提交的，不能靠固定延时赌时序。 */
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

  /**
   * 记录 fetch 并回放响应。`routes` 按 URL 覆盖统一值，详情栏与清单不是同一份
   * 数据，两者必须能分开回放。
   */
  const installFetch = (value, options = {}) => {
    const calls = []
    const original = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      if (options.error !== undefined) {
        return { ok: true, status: 200, json: async () => ({ ok: false, error: options.error }) }
      }
      const resolved = options.routes?.[url] !== undefined ? options.routes[url] : value
      return { ok: true, status: 200, json: async () => ({ ok: true, value: resolved }) }
    }
    return { calls, restore: () => { globalThis.fetch = original } }
  }

  const VIEW = {
    items: [
      {
        id: 'tb_t_1', kind: 'todo', number: 1, title: '补丁上线', project: 'deep-dreaming',
        status: 'TODO', date: '2026-11-19', sections: { 背景: '需要跨项目', 方案: 'JSON + 镜像' },
      },
      {
        id: 'tb_b_1', kind: 'branch', number: 1, title: '物料库存隔离', project: 'taikoo-saas',
        module: 'Weinee IMS（第三方）', flags: { ddl: false, sql: true, nacos: false },
        sections: { 分支: 'weinee@feat-SITEW-2905' },
      },
      {
        id: 'tb_d_1', kind: 'done', number: 1, title: 'NPE 修复', project: 'taikoo-saas',
        date: '2026-11-18', sections: {},
      },
    ],
    summary: { counts: { todo: 1, done: 1, branch: 1 } },
  }

  const t = (key) => key
  const glyph = surface.registered
    .find((row) => row.options.name === 'sidebar.panellist').component
  const page = surface.registered
    .find((row) => row.options.name === 'main').component

  // 3a. 侧栏 glyph：图标 + 有未办事项时的一颗点。
  await checkAsync('the sidebar glyph marks pending work with a dot', async () => {
    const fetchStub = installFetch(VIEW)
    const view = mount(glyph, { size: 16 })
    try {
      await waitFor(() => view.container.querySelector('.tb-dot') !== null, 'the pending dot')
      const icon = view.container.querySelector('svg[data-icon="IconChecklistOutlineRegular"]')
      assert.ok(icon !== null, 'the checklist icon must be rendered')
      assert.equal(icon.getAttribute('width'), '16', 'the glyph honours the size the sidebar asks for')
      assert.equal(fetchStub.calls[0].url, '/todo-board/view', 'the dot is read from /todo-board/view')
    } finally {
      view.unmount()
      fetchStub.restore()
    }
  })

  // 3b. 零未办：不画点。
  await checkAsync('a zero pending count renders no dot', async () => {
    const fetchStub = installFetch({ items: [], summary: { counts: { todo: 0, done: 0, branch: 0 } } })
    const view = mount(glyph, { size: 18 })
    try {
      await waitFor(() => fetchStub.calls.length > 0, 'the first call')
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(view.container.querySelector('.tb-dot'), null, 'a zero count must not render a dot')
      assert.equal(view.container.querySelector('svg[data-icon="IconChecklistOutlineRegular"]')
        .getAttribute('width'), '18')
    } finally {
      view.unmount()
      fetchStub.restore()
    }
  })

  // 3c. 整页：标题、计数、tab、序号、行、标记文案。
  await checkAsync('the page renders head, three tabs, numbered rows', async () => {
    const fetchStub = installFetch(VIEW)
    const view = mount(page, { t })
    try {
      // 默认停在「待办」，所以只有那一条 todo 行。
      await waitFor(() => view.container.querySelectorAll('.tb-row').length === 1, 'the todo row')

      assert.equal(view.container.querySelector('.tb-title').textContent, 'panelTitle')
      // 计数搬进了头部副标题：三个 tab 各自已经带数字了，这里给总数不必再重复。
      assert.equal(view.container.querySelector('.tb-sub').textContent,
        '1 filterTodo · 1 filterDone · 1 filterBranch')

      const tabs = view.container.querySelectorAll('.tb-tab')
      assert.equal(tabs.length, 3, 'todo / done / branch — there is no "all" tab any more')
      assert.equal(tabs[0].getAttribute('data-active'), 'true', 'the todo tab starts active')
      assert.equal(tabs[0].textContent, 'filterTodo 1', 'each tab carries its own count')
      assert.equal(view.container.querySelector('.tb-tab[data-active="true"]').textContent,
        'filterTodo 1', 'no "all" entry survives the tab list')

      // 没有项目分组标题：跨项目清单不该按项目再切成一堆小段。
      assert.equal(view.container.querySelector('.tb-group'), null,
        'the page must not group rows by project any more')

      // 序号：与镜像里的编号同源，便于"界面上第 #1 条"和"文件里第 1 条"对上。
      const nums = [...view.container.querySelectorAll('.tb-num')].map((node) => node.textContent)
      assert.deepEqual(nums, ['#1'], 'the todo row is #1')

      assert.deepEqual(
        [...view.container.querySelectorAll('.tb-row-title')].map((node) => node.textContent),
        ['补丁上线'],
      )

      // 每条待办一个「标记完成」，每条一个「归档」。
      assert.equal(view.container.querySelectorAll('.tb-row-actions button').length, 2,
        '1 todo complete button + 1 archive button')
    } finally {
      view.unmount()
      fetchStub.restore()
    }
  })

  // 3c-b. 切到「功能分支」tab：模块名与三件硬交付物都要出现，序号按各自 tab 编。
  await checkAsync('the branch tab shows the module meta and keeps Nacos casing', async () => {
    const fetchStub = installFetch(VIEW)
    const view = mount(page, { t })
    try {
      await waitFor(() => view.container.querySelectorAll('.tb-tab').length === 3, 'the tabs')
      const branchTab = [...view.container.querySelectorAll('.tb-tab')]
        .find((node) => node.textContent.startsWith('filterBranch'))
      assert.ok(branchTab !== undefined, 'the branch tab is missing')
      branchTab.click()
      await waitFor(() => view.container.querySelectorAll('.tb-row').length === 1, 'the branch row')

      const metas = [...view.container.querySelectorAll('.tb-row-meta')].map((node) => node.textContent)
      const branchMeta = metas.find((text) => text.includes('Weinee IMS'))
      assert.ok(branchMeta !== undefined, `no branch meta line: ${metas.join(' | ')}`)
      // `Nacos` 是产品名：写成 NACOS 就是错的（源文档里从来不是大写）。
      assert.ok(branchMeta.includes('无DDL'), branchMeta)
      assert.ok(branchMeta.includes('SQL'), branchMeta)
      assert.ok(branchMeta.includes('无Nacos'), `Nacos must keep its product casing: ${branchMeta}`)
      assert.ok(!branchMeta.includes('NACOS'), `Nacos must never be uppercased: ${branchMeta}`)
      // 项目仍然是来源标签，留在元信息里；去掉的只是作为分组标题的那一份。
      assert.ok(branchMeta.includes('taikoo-saas'), branchMeta)

      const nums = [...view.container.querySelectorAll('.tb-num')].map((node) => node.textContent)
      assert.deepEqual(nums, ['#1'], 'the branch list is numbered from #1')
    } finally {
      view.unmount()
      fetchStub.restore()
    }
  })

  // 3c-c. 「已办」tab 的一键归档：两段式确认，第二下才真的打宿主。
  await checkAsync('the DONE tab offers a two-step archive-all that posts to the host', async () => {
    const fetchStub = installFetch(VIEW)
    const view = mount(page, { t })
    const button = () => view.container.querySelector('[data-action="archive-all"]')
    try {
      await waitFor(() => view.container.querySelectorAll('.tb-tab').length === 3, 'the tabs')
      const doneTab = [...view.container.querySelectorAll('.tb-tab')]
        .find((node) => node.textContent.startsWith('filterDone'))
      assert.ok(doneTab !== undefined, 'the done tab is missing')
      doneTab.click()
      await waitFor(() => button() !== null, 'the archive-all button')

      assert.equal(button().getAttribute('data-armed'), 'false', 'the button must start unarmed')
      assert.equal(button().textContent, 'archiveAll 1', 'the label carries the DONE count')

      // 第一下：只进入确认态，不发请求——这个按钮会清空整个 tab，不能一键误触。
      button().click()
      await waitFor(() => button()?.getAttribute('data-armed') === 'true', 'the armed state')
      assert.equal(button().textContent, 'archiveAllConfirm 1')
      assert.equal(
        fetchStub.calls.some((row) => String(row.url).includes('/archiveAll')),
        false,
        'the first click must not archive anything',
      )

      // 第二下：POST /todo-board/archiveAll，参数带上 kind。
      button().click()
      await waitFor(
        () => fetchStub.calls.some((row) => String(row.url).endsWith('/todo-board/archiveAll')),
        'the archiveAll call',
      )
      const archiveCall = fetchStub.calls.find((row) => String(row.url).endsWith('/todo-board/archiveAll'))
      assert.equal(archiveCall.init.method, 'POST')
      assert.deepEqual(JSON.parse(archiveCall.init.body), { args: { kind: 'done' } })
    } finally {
      view.unmount()
      fetchStub.restore()
    }
  })

  // 3d. 空清单：渲染空态而不是崩溃。
  await checkAsync('empty board renders the empty state', async () => {
    const fetchStub = installFetch({ items: [], summary: { counts: { todo: 0, done: 0, branch: 0 } } })
    const view = mount(page, { t })
    try {
      // 首次渲染时 view 还是 null，先显示「处理中」；等视图真的回来再断言空态。
      await waitFor(() => view.container.querySelector('.tb-empty')?.textContent === 'empty',
        'the loaded empty state')
      assert.equal(view.container.querySelectorAll('.tb-row').length, 0)
    } finally {
      view.unmount()
      fetchStub.restore()
    }
  })

  // 3e. 失败路径：宿主回 error 信封时显示错误条而不是白屏。
  await checkAsync('a host error surfaces as an alert line', async () => {
    const fetchStub = installFetch(null, { error: { code: 'board-corrupt', message: 'board.json is not valid JSON' } })
    const view = mount(page, { t })
    try {
      await waitFor(() => view.container.querySelector('.tb-error') !== null, 'the error line')
      const line = view.container.querySelector('.tb-error')
      assert.equal(line.getAttribute('role'), 'alert')
      assert.ok(line.textContent.includes('board-corrupt'), `the code must reach the user: ${line.textContent}`)
      assert.ok(line.textContent.includes('board.json is not valid JSON'), line.textContent)
    } finally {
      view.unmount()
      fetchStub.restore()
    }
  })

  // --- 4. 传输契约 ----------------------------------------------------------
  await checkAsync('transport contract: POST /todo-board/view with a JSON { args } body', async () => {
    const fetchStub = installFetch({ items: [], summary: { counts: { todo: 0, done: 0, branch: 0 } } })
    const view = mount(page, { t })
    try {
      await waitFor(() => fetchStub.calls.length > 0, 'the first transport call')
      const { url, init } = fetchStub.calls[0]
      assert.equal(url, '/todo-board/view', 'the fenced prefix route owns /todo-board/<endpoint>')
      assert.equal(init.method, 'POST', 'the fence accepts POST only')
      assert.equal(init.headers['content-type'], 'application/json',
        'the fence rejects anything else with 415')
      assert.deepEqual(JSON.parse(init.body), { args: {} },
        'the payload is { args } — an empty call must still send args, not undefined')
    } finally {
      view.unmount()
      fetchStub.restore()
    }
  })

  // --- 5. 新增动作 ----------------------------------------------------------
  await checkAsync('the add row posts title + kind + project', async () => {
    const fetchStub = installFetch(VIEW)
    const view = mount(page, { t })
    try {
      await waitFor(() => view.container.querySelector('.tb-add-input') !== null, 'the add row')
      const input = view.container.querySelector('.tb-add-input')
      const addButton = view.container.querySelector('.tb-primary')
      assert.ok(addButton.disabled === true, 'the add button starts disabled on an empty draft')

      // React 受控 input：必须走原生 setter 再派发 input 事件，否则 React 看不到变更。
      const setter = Object.getOwnPropertyDescriptor(shell.window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '新的一条待办')
      input.dispatchEvent(new shell.window.Event('input', { bubbles: true }))
      await waitFor(() => view.container.querySelector('.tb-primary').disabled !== true, 'the add button to arm')

      view.container.querySelector('.tb-primary').click()
      await waitFor(
        () => fetchStub.calls.some((row) => row.url === '/todo-board/add'),
        'the add call',
      )
      const addCall = fetchStub.calls.find((row) => row.url === '/todo-board/add')
      const body = JSON.parse(addCall.init.body)
      assert.equal(body.args.title, '新的一条待办')
      assert.equal(body.args.kind, 'todo', 'the kind select defaults to todo')
      // 新条目沿用清单里第一个条目的 project，避免落到 UI 猜不出的项目上。
      assert.equal(body.args.project, 'deep-dreaming')
    } finally {
      view.unmount()
      fetchStub.restore()
    }
  })

  // --- 6. 详情：点击标题 → 整页右侧详情栏 -----------------------------------
  const MARKDOWN = '### 补丁上线 — 2026-11-19\n\n**背景**\n\n需要跨项目'

  await checkAsync('clicking a row title opens the in-page detail column', async () => {
    const fetchStub = installFetch(VIEW, { routes: { '/todo-board/detail': { markdown: MARKDOWN } } })
    const view = mount(page, { t })
    try {
      await waitFor(() => view.container.querySelectorAll('.tb-row-title').length === 1, 'the todo title')
      // 正文不在列表里内联展开（`**背景**` 原样露出来正是用户当初报的问题）。
      assert.equal(view.container.querySelector('.tb-sections'), null,
        'the page must not render the body inline in the list')
      // 详情栏一开始是收起的：它只在用户点了某一条之后出现。
      assert.equal(view.container.querySelector('.tb-side'), null, 'the detail column starts closed')

      const title = view.container.querySelector('.tb-row-title')
      assert.equal(title.textContent, '补丁上线', 'the todo row is the one on the default tab')
      assert.equal(title.getAttribute('role'), 'button', 'the title is the affordance that opens the detail')

      title.click()
      await waitFor(() => view.container.querySelector('.tb-side') !== null, 'the detail column')
      const side = view.container.querySelector('.tb-side')
      assert.equal(side.getAttribute('data-detail-id'), 'tb_t_1', 'the column knows which item it shows')
      assert.equal(view.container.querySelector('.tb-row').getAttribute('data-selected'), 'true',
        'the row whose detail is open is marked selected')

      const detailCall = fetchStub.calls.find((row) => row.url === '/todo-board/detail')
      assert.ok(detailCall !== undefined, `no /todo-board/detail call: ${fetchStub.calls.map((r) => r.url).join(', ')}`)
      assert.equal(detailCall.init.method, 'POST')
      assert.deepEqual(JSON.parse(detailCall.init.body), { args: { id: 'tb_t_1' } },
        'the id travels in the { args } envelope, same as every other endpoint')

      await waitFor(() => view.container.querySelector('.tb-detail .markdown') !== null, 'the rendered document')
      const rendered = view.container.querySelector('.tb-detail .markdown')
      // 关键：正文交给平台渲染器，而不是当纯文本 —— `**背景**` 必须被渲染，而不是
      // 原样显示两个星号。
      assert.equal(rendered.getAttribute('data-md'), MARKDOWN)
      assert.equal(rendered.textContent, MARKDOWN)
      // 详情栏在列表右边，不是盖住列表：两个容器是兄弟。
      assert.equal(side.parentElement.className, 'tb-body')
      assert.ok(side.previousElementSibling.classList.contains('tb-list'),
        'the detail column must sit after the scrolling list')
    } finally {
      view.unmount()
      fetchStub.restore()
    }
  })

  // --- 6b. 整行都是打开详情的命中区 -----------------------------------------
  await checkAsync('clicking anywhere on the row (not just the title) opens the detail', async () => {
    const fetchStub = installFetch(VIEW, { routes: { '/todo-board/detail': { markdown: MARKDOWN } } })
    const view = mount(page, { t })
    try {
      await waitFor(() => view.container.querySelector('.tb-row-meta') !== null, 'the row meta line')
      // 元信息行原来是"点了没反应"的那块区域（用户报的 bug：只有标题能点开）。
      view.container.querySelector('.tb-row-meta').click()
      await waitFor(() => view.container.querySelector('.tb-side') !== null, 'the detail column')
      assert.equal(view.container.querySelector('.tb-side').getAttribute('data-detail-id'), 'tb_t_1')

      // 点序号那一片也一样；同一条重复点不会重复取详情（state 没变）。
      view.container.querySelector('.tb-num').click()
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(fetchStub.calls.filter((row) => row.url === '/todo-board/detail').length, 1,
        'clicking the same row again must not refetch the same document')
    } finally {
      view.unmount()
      fetchStub.restore()
    }
  })

  await checkAsync('row action buttons do not open the detail', async () => {
    const fetchStub = installFetch(VIEW)
    const view = mount(page, { t })
    try {
      await waitFor(() => view.container.querySelector('.tb-row-actions button[title="complete"]') !== null,
        'the complete action')
      // 完成 / 归档是行内动作：点它们不该顺手打开详情（按钮 stopPropagation）。
      view.container.querySelector('.tb-row-actions button[title="complete"]').click()
      await waitFor(() => fetchStub.calls.some((row) => row.url === '/todo-board/complete'), 'the complete call')
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(view.container.querySelector('.tb-side'), null, 'completing must not open the detail column')
      assert.equal(fetchStub.calls.some((row) => row.url === '/todo-board/detail'), false,
        'no detail fetch from an action button')
    } finally {
      view.unmount()
      fetchStub.restore()
    }
  })

  await checkAsync('selecting row text does not open the detail', async () => {
    const fetchStub = installFetch(VIEW, { routes: { '/todo-board/detail': { markdown: MARKDOWN } } })
    const view = mount(page, { t })
    try {
      await waitFor(() => view.container.querySelector('.tb-row-title') !== null, 'the todo row')
      const selection = shell.window.getSelection()
      const range = shell.window.document.createRange()
      range.selectNodeContents(view.container.querySelector('.tb-row-title'))
      selection.removeAllRanges()
      selection.addRange(range)
      assert.ok(selection.toString().length > 0, 'the setup needs a real selection')

      // 拖选文本之后松手也会派发一次 click：那不该被当成"打开详情"。
      view.container.querySelector('.tb-row').click()
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(view.container.querySelector('.tb-side'), null, 'a drag-select must not open the detail')
      assert.equal(fetchStub.calls.some((row) => row.url === '/todo-board/detail'), false)

      // 清掉选区之后，同一行的点击恢复正常。
      selection.removeAllRanges()
      view.container.querySelector('.tb-row').click()
      await waitFor(() => view.container.querySelector('.tb-side') !== null,
        'the detail column after clearing the selection')
    } finally {
      shell.window.getSelection().removeAllRanges()
      view.unmount()
      fetchStub.restore()
    }
  })

  // --- 7. 详情栏可以换一条、也可以收起 --------------------------------------
  await checkAsync('picking another item swaps the detail; the close button collapses it', async () => {
    const fetchStub = installFetch(VIEW, { routes: { '/todo-board/detail': { markdown: MARKDOWN } } })
    const view = mount(page, { t })
    try {
      await waitFor(() => view.container.querySelectorAll('.tb-tab').length === 3, 'the tabs')
      // 行要等 `/todo-board/view` 回来才有：tabs 是无条件渲染的，不能拿它当"已加载"。
      await waitFor(() => view.container.querySelector('.tb-row-title') !== null, 'the todo row')
      const firstTitle = view.container.querySelector('.tb-row-title')
      assert.ok(firstTitle !== null, 'the todo row title is missing')
      firstTitle.click()
      await waitFor(() => view.container.querySelector('.tb-side')?.getAttribute('data-detail-id') === 'tb_t_1',
        'the first detail')

      // 切到「已办」tab，点另一条：同一个详情栏换成它，用户不离开清单。
      const doneTab = [...view.container.querySelectorAll('.tb-tab')]
        .find((node) => node.textContent.startsWith('filterDone'))
      assert.ok(doneTab !== undefined, 'the done tab is missing')
      doneTab.click()
      await waitFor(() => view.container.querySelectorAll('.tb-row-title').length === 1, 'the done row')
      assert.equal(view.container.querySelector('.tb-row-title').textContent, 'NPE 修复')
      const doneTitle = view.container.querySelector('.tb-row-title')
      assert.ok(doneTitle !== null, 'the done row title is missing')
      doneTitle.click()
      await waitFor(() => view.container.querySelector('.tb-side')?.getAttribute('data-detail-id') === 'tb_d_1',
        'the second detail')
      const ids = fetchStub.calls
        .filter((row) => row.url === '/todo-board/detail')
        .map((row) => JSON.parse(row.init.body).args.id)
      assert.deepEqual(ids, ['tb_t_1', 'tb_d_1'], 'each pick re-reads its own document')

      // 关闭按钮：详情栏消失、行不再选中。
      const closeButton = view.container.querySelector('.tb-side-head button')
      assert.ok(closeButton !== null, 'the detail close button is missing')
      closeButton.click()
      await waitFor(() => view.container.querySelector('.tb-side') === null, 'the detail column to close')
      assert.equal(view.container.querySelector('.tb-row').getAttribute('data-selected'), 'false')
    } finally {
      view.unmount()
      fetchStub.restore()
    }
  })

  // --- 7b. 详情栏宽度：拖拽 / 记忆 / 双击复位 -------------------------------
  await checkAsync('dragging the detail edge resizes it and remembers the width', async () => {
    shell.window.localStorage.removeItem('todo-board.detailWidth')
    const fetchStub = installFetch(VIEW, { routes: { '/todo-board/detail': { markdown: MARKDOWN } } })
    const view = mount(page, { t })
    try {
      await waitFor(() => view.container.querySelector('.tb-row-title') !== null, 'the todo row')
      view.container.querySelector('.tb-row-title').click()
      await waitFor(() => view.container.querySelector('.tb-side') !== null, 'the detail column')

      const handle = view.container.querySelector('.tb-side-resize')
      assert.ok(handle !== null, 'the detail column needs a resize handle')
      assert.equal(handle.getAttribute('role'), 'separator')
      assert.equal(handle.getAttribute('aria-orientation'), 'vertical')
      assert.equal(handle.getAttribute('data-dragging'), 'false')
      // 没拖过时没有内联宽度：宽度由 CSS clamp 决定，随窗口缩放。
      assert.equal(view.container.querySelector('.tb-side').style.width, '')

      // 手柄向左拖 100px：360（jsdom 无布局时的起始宽度回退值）+ 100 = 460。
      handle.dispatchEvent(new shell.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 900 }))
      await waitFor(() => handle.getAttribute('data-dragging') === 'true', 'the handle to light up while dragging')
      shell.window.dispatchEvent(new shell.window.MouseEvent('pointermove', { bubbles: true, clientX: 800 }))
      await waitFor(() => view.container.querySelector('.tb-side').style.width === '460px', 'the dragged width')
      shell.window.dispatchEvent(new shell.window.MouseEvent('pointerup', { bubbles: true, clientX: 800 }))
      await waitFor(() => handle.getAttribute('data-dragging') === 'false', 'the drag to end')
      assert.equal(shell.window.localStorage.getItem('todo-board.detailWidth'), '460',
        'the width is remembered for the next open')
    } finally {
      view.unmount()
      fetchStub.restore()
      shell.window.localStorage.removeItem('todo-board.detailWidth')
    }
  })

  await checkAsync('a saved width is restored and double-click resets it', async () => {
    shell.window.localStorage.setItem('todo-board.detailWidth', '520')
    const fetchStub = installFetch(VIEW, { routes: { '/todo-board/detail': { markdown: MARKDOWN } } })
    const view = mount(page, { t })
    try {
      await waitFor(() => view.container.querySelector('.tb-row-title') !== null, 'the todo row')
      view.container.querySelector('.tb-row-title').click()
      await waitFor(() => view.container.querySelector('.tb-side')?.style.width === '520px',
        'the width remembered from the previous open')

      view.container.querySelector('.tb-side-resize')
        .dispatchEvent(new shell.window.MouseEvent('dblclick', { bubbles: true }))
      await waitFor(() => view.container.querySelector('.tb-side').style.width === '', 'the default width')
      assert.equal(shell.window.localStorage.getItem('todo-board.detailWidth'), null,
        'reset forgets the stored width instead of storing the default as if it were dragged')
    } finally {
      view.unmount()
      fetchStub.restore()
      shell.window.localStorage.removeItem('todo-board.detailWidth')
    }
  })

  // --- 8. 详情栏的失败面 ----------------------------------------------------
  await checkAsync('a missing item surfaces the host error inside the detail column', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async (url) => {
      if (url === '/todo-board/detail') {
        return {
          ok: true, status: 200,
          json: async () => ({ ok: false, error: { code: 'item-not-found', message: 'there is no such item' } }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, value: VIEW }) }
    }
    const view = mount(page, { t })
    try {
      await waitFor(() => view.container.querySelector('.tb-row-title') !== null, 'the todo row')
      view.container.querySelector('.tb-row-title').click()
      await waitFor(() => view.container.querySelector('.tb-side-error') !== null, 'the failure line')
      const line = view.container.querySelector('.tb-side-error')
      assert.equal(line.getAttribute('role'), 'alert')
      assert.ok(line.textContent.includes('item-not-found'), line.textContent)
      // 失败信息留在详情栏里：列表本身照常可用。
      assert.equal(view.container.querySelectorAll('.tb-row').length, 1)
    } finally {
      view.unmount()
      globalThis.fetch = original
    }
  })

  // --- 9. 侧栏点与整页的联动 ------------------------------------------------
  await checkAsync('a page reload makes the sidebar dot follow the new data', async () => {
    // 先让清单报 1 条未办（点出现），再把它改成 0，然后点整页的「重新读取」。
    // 整页 reload 之后会广播，侧栏那颗点必须跟着新数据消失 —— 停在旧状态就是
    // "侧栏不刷新"那个老毛病。
    const state = { todo: 1 }
    const original = globalThis.fetch
    globalThis.fetch = async (url) => {
      const value = url === '/todo-board/view'
        ? { items: [], summary: { counts: { todo: state.todo, done: 0, branch: 0 } } }
        : {}
      return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
    }
    const glyphView = mount(glyph, { size: 16 })
    const pageView = mount(page, { t })
    try {
      await waitFor(() => glyphView.container.querySelector('.tb-dot') !== null, 'the dot from the first read')
      state.todo = 0
      await waitFor(() => pageView.container.querySelector('.tb-icon-btn') !== null, 'the refresh button')
      pageView.container.querySelector('.tb-icon-btn').click()
      await waitFor(() => glyphView.container.querySelector('.tb-dot') === null,
        'the dot to clear after the page reported zero')
    } finally {
      glyphView.unmount()
      pageView.unmount()
      globalThis.fetch = original
    }
  })

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} — ok ${ok} / fail ${fail}`)
  if (fail > 0) process.exitCode = 1
}