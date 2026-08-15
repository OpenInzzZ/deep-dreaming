/**
 * Contract check for the dsh-project-memory browser half.
 *
 * Loads the exact deployed `client.js` the browser will execute through a
 * minimal DOM shim, asserts the module-table handoff, then applies it against
 * a mock ctx and verifies that all three project-memory tools register a
 * `tool.call.toolview` entry (collapsible memory cards). Rendering needs
 * jsdom; when absent the pure contract checks still run.
 *
 * Run from the repo root:
 *   node patches/dsh-project-memory/tests/client-contract.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const patchDir = join(here, '..')
const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? ''
const uiRequire = createRequire(join(userProfile, '.dsh', 'profiles', 'web', 'package.json'))
const React = uiRequire('react')

let JSDOM = null
try {
  JSDOM = uiRequire('jsdom').JSDOM
} catch { /* render section skipped below */ }

const clientPath = join(patchDir, 'client.js')
const PLUGIN_ID = 'dsh-project-memory'
const KEYS = ['project_memory_save', 'project_memory_search', 'project_memory_list']

// --- load the bundle exactly like the shell kernel does ----------------------
let handoff = null
const bundleSource = readFileSync(clientPath, 'utf8')
if (JSDOM !== null) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:3080/' })
  globalThis.window = dom.window
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (!(key in globalThis)) globalThis[key] = dom.window[key]
  }
  dom.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
  new Function('window', 'document', bundleSource)(dom.window, dom.window.document)
} else {
  const shimDocument = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, setAttribute: () => {}, appendChild: () => {} }),
    head: { appendChild: () => {} },
  }
  const shimWindow = { __ModuleLoader__: { load: (h) => { handoff = h } } }
  new Function('window', 'document', bundleSource)(shimWindow, shimDocument)
}
if (handoff === null) throw new Error('bundle never called __ModuleLoader__.load')
if (handoff.id !== PLUGIN_ID) throw new Error(`handoff id mismatch: ${handoff.id}`)

// --- module-table words must stay within the platform seed set ---------------
// The real ui-primitives node half pulls katex CSS into Node, so the
// DisclosureRow + icons are stubbed here (same approach as the other patches'
// verifies); the stub mirrors the DisclosureRow behavior the bundle relies on
// (title + collapsedContent while closed, children while open, row click
// toggles via expandOnRowClick).
const icon = (props) => React.createElement('svg', { ...props, 'data-icon': true })
const requireTable = (spec) => {
  if (spec === 'react') return uiRequire('react')
  if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    const DisclosureRow = (props) => React.createElement(
      'div',
      {
        'data-disclosure-row': '',
        'data-open': props.open || undefined,
        onClick: props.expandable && props.expandOnRowClick ? props.onToggle : undefined,
      },
      props.icon,
      React.createElement('span', { className: 'pmem-title' }, props.title),
      (!props.open || props.keepContentWhenOpen) ? props.collapsedContent : null,
      props.open ? props.children : null,
    )
    return {
      DisclosureRow,
      IconListPenOutline16: icon,
      IconSearchOutline16: icon,
      IconChecklistOutline14: icon,
    }
  }
  throw new Error(`unexpected module-table word: ${spec}`)
}
const exports_ = handoff.factory(requireTable)
if (typeof exports_.apply !== 'function') throw new Error('exports.apply missing')
if (!Array.isArray(exports_.inject) || exports_.inject.join(',') !== 'slots') {
  throw new Error(`exports.inject mismatch: ${JSON.stringify(exports_.inject)}`)
}
if (JSON.stringify(Object.keys(exports_.TITLES).sort()) !== JSON.stringify([...KEYS].sort())) {
  throw new Error(`TITLES must cover exactly the three memory tools: ${JSON.stringify(exports_.TITLES)}`)
}
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'TITLES =', JSON.stringify(exports_.TITLES))

// --- apply(): three keyed toolview registrations ------------------------------
const registrations = []
const clientCtx = {
  effect: (fn) => fn(),
  slots: {
    inject: (_key, callback) => { registrations.push(callback()) },
    register: (options, component) => ({ ...options, component }),
  },
}
exports_.apply(clientCtx)
const views = registrations.filter((r) => r.name === 'tool.call.toolview')
if (views.length !== 3) throw new Error(`expected 3 toolview registrations, got ${views.length}`)
for (const key of KEYS) {
  if (!views.some((v) => v.key === key)) throw new Error(`missing toolview key ${key}`)
  if (typeof views.find((v) => v.key === key).component !== 'function') throw new Error(`toolview ${key} must carry a component`)
}
console.log('apply OK: tool.call.toolview registered for', KEYS.join(', '))

if (JSDOM === null) {
  console.log('\nDOM render section SKIPPED (jsdom not installed)')
  console.log('ALL CONTRACT CHECKS PASSED (install jsdom to enable the render section)')
  process.exit(0)
}

// --- render the settled card (jsdom) -------------------------------------------
const { act } = React
const { createRoot } = uiRequire('react-dom/client')
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const component = views.find((v) => v.key === 'project_memory_save').component
const settled = {
  kind: 'tool-result',
  seq: 1,
  time: Date.now(),
  callId: 'call-1',
  call: { name: 'project_memory_save', argsRaw: '{"title":"测试笔记","content":"x","keywords":["测试","笔记"]}' },
  callTime: null,
  content: [{ type: 'text', text: 'Project memory saved: 测试笔记 [general] (new, used 1) -> C:\\w\\x.md' }],
  isError: false,
  callView: null,
  resultView: null,
  subCalls: [],
}
const host = document.createElement('div')
const root = createRoot(host)
await act(async () => {
  root.render(React.createElement(component, { block: settled, callId: 'call-1', toolName: 'project_memory_save' }))
})
const card = host.querySelector('[data-memory-card]')
if (card === null) throw new Error('memory card did not render')
const head = host.querySelector('[data-disclosure-row]')
if (head === null) throw new Error('card head missing (DisclosureRow)')
if (!head.textContent.includes('记忆') || !head.textContent.includes('已保存')) {
  throw new Error(`head summary missing: ${head.textContent}`)
}
if (!head.textContent.includes('测试') || !head.textContent.includes('笔记')) {
  throw new Error(`collapsed row must show the memory keywords: ${head.textContent}`)
}
// collapsed by default for settled cards; expanding reveals the full text
if (host.querySelector('.pmem-text') !== null) throw new Error('settled card must start collapsed')
await act(async () => { head.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const text = host.querySelector('.pmem-text')
if (text === null || !text.textContent.includes('Project memory saved')) throw new Error('expanded text missing')
console.log('render OK: settled save card (DisclosureRow) collapses to 已保存:<title> + keywords, expands to full text')

// running card stays collapsed too (memory cards never auto-expand); the
// summary row still shows "运行中…", and expanding reveals the running text
const runningComponent = views.find((v) => v.key === 'project_memory_search').component
const runningBlock = { callId: 'call-2', name: 'project_memory_search', argsRaw: '{"query":"约定"}', turn: 1, step: 1, time: Date.now(), callView: null, subCalls: [] }
const host2 = document.createElement('div')
const root2 = createRoot(host2)
await act(async () => {
  root2.render(React.createElement(runningComponent, { block: runningBlock, callId: 'call-2', toolName: 'project_memory_search' }))
})
if (host2.querySelector('.pmem-text') !== null) throw new Error('running card must start collapsed')
if (!host2.querySelector('.pmem-summary').textContent.includes('运行中')) throw new Error('running summary missing')
await act(async () => { host2.querySelector('[data-disclosure-row]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
if (!host2.querySelector('.pmem-text').textContent.includes('执行中')) throw new Error('running text missing')
console.log('render OK: running search card stays collapsed (运行中 summary), expands on click')

console.log('\nALL CLIENT CONTRACT CHECKS PASSED')
process.exit(0)
