/**
 * Functional harness for the user-level plugin-manager bundle.
 *
 * Loads the exact deployed `lib/client.js` the browser will execute, feeds it
 * a module table stubbed with the real platform words (react, react/jsx-runtime,
 * ui-primitives — resolved from the harness repo's node_modules), asserts the
 * registration contract, then renders the tab in jsdom and exercises the
 * filters end to end.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const repoRequire = createRequire('D:/GitHub/deepseek-harness/package.json')
// The browser module table is the DEPLOYED profile's packages — anchor there.
const uiRequire = createRequire('C:/Users/zhoukaiying/.dsh/profiles/web/package.json')
const { JSDOM } = repoRequire('jsdom')
const React = uiRequire('react')
const bundlePath = 'C:/Users/zhoukaiying/.dsh/profiles/node_modules/@local/dsh-client-ui-settings-plugin-manager/lib/client.js'
const PLUGIN_ID = '@local/dsh-client-ui-settings-plugin-manager'

// --- jsdom environment (what the browser shell provides) ---------------------
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
})
globalThis.window = dom.window
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (!(key in globalThis)) globalThis[key] = dom.window[key]
}

// --- load the bundle exactly like the shell kernel does ----------------------
let handoff = null
dom.window.__ModuleLoader__ = { load: (h) => { handoff = h } }

const bundleSource = readFileSync(bundlePath, 'utf8')
const evaluate = new Function('window', 'document', bundleSource)
evaluate(dom.window, dom.window.document)
if (handoff === null) throw new Error('bundle never called __ModuleLoader__.load')
if (handoff.id !== PLUGIN_ID) throw new Error(`handoff id mismatch: ${handoff.id}`)

const requireTable = (spec) => {
  if (spec === 'react') return uiRequire('react')
  if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
  // The deployed ui-primitives node half pulls katex CSS into Node; the bundle
  // only consumes the two icon components, so stub them with plain svg
  // placeholders (identical contract, no styling dependency).
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    const icon = (props) => React.createElement('svg', { ...props, 'data-icon': true })
    return {
      IconChevronDownOutline14: icon,
      IconSearchOutline16: icon,
    }
  }
  throw new Error(`unexpected module-table word: ${spec}`)
}
const exports_ = handoff.factory(requireTable)

// --- registration contract ----------------------------------------------------
if (typeof exports_.apply !== 'function') throw new Error('exports.apply missing')
if (!Array.isArray(exports_.inject)) throw new Error('exports.inject missing')
if (exports_.NS !== 'settings.pluginManager') throw new Error(`NS mismatch: ${exports_.NS}`)
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

// --- apply() against a mock client ctx ----------------------------------------
const SNAPSHOT = {
  entries: [
    { entryId: 'official-active', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: true, fiberPhase: 'active' },
    { entryId: 'official-failed', moduleName: '@deepseek-ai/dsh-host-plugin-inventory', enabled: true, fiberPhase: 'failed' },
    { entryId: 'official-disabled', moduleName: '@deepseek-ai/dsh-host-directory-picker-native', enabled: false, fiberPhase: null },
    { entryId: 'builtin-pending', moduleName: 'cordis:pending-name', enabled: true, fiberPhase: 'pending' },
    { entryId: 'custom-loading', moduleName: '@fixture/loading-name', enabled: true, fiberPhase: 'loading' },
    { entryId: 'custom-unobserved', moduleName: '@fixture/unobserved-name', enabled: true, fiberPhase: null },
    { entryId: 'custom-disabled', moduleName: 'file:///C:/Users/me/.dsh/plugins/session-cleanup.mjs', enabled: false, fiberPhase: null },
  ],
}

let registered = null
let dictionaries = null
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => { dictionaries = { ns, dicts } },
    bind: () => (key) => 't:' + key,
  },
  remote: {
    pluginInventory: { list: async () => ({ ok: true, value: SNAPSHOT }) },
  },
  slots: {
    inject: (_key, callback) => { registered = callback() },
    register: (options, component) => ({ ...options, component }),
  },
}
exports_.apply(ctx)
if (registered === null) throw new Error('slots.inject never registered')
if (registered.id !== 'manager' || registered.order !== 20) {
  throw new Error(`tab options mismatch: ${JSON.stringify(registered)}`)
}
if (dictionaries === null || dictionaries.ns !== exports_.NS) throw new Error('dictionaries not registered')
const zhKeys = Object.keys(dictionaries.dicts.zh)
const enKeys = Object.keys(dictionaries.dicts.en)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  throw new Error(`zh/en key mismatch:\nzh: ${zhKeys}\nen: ${enKeys}`)
}
console.log('apply contract OK: tab id =', registered.id, 'order =', registered.order, '| dict keys =', zhKeys.length)

// --- render + interact (react-dom in jsdom) ------------------------------------
const { act } = React
const { createRoot } = uiRequire('react-dom/client')
const { fireEvent } = repoRequire('@testing-library/react')
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const en = dictionaries.dicts.en
const root = createRoot(dom.window.document.getElementById('root'))

await act(async () => {
  root.render(React.createElement(registered.component, {
    list: async () => SNAPSHOT,
    t: (key) => en[key],
  }))
})

const doc = dom.window.document
const cards = () => [...doc.querySelectorAll('.pm-card')]
const count = () => doc.querySelector('[data-managed-plugin-count]').textContent

if (cards().length !== 7) throw new Error(`expected 7 cards, got ${cards().length}`)
if (doc.querySelectorAll('[data-category="official"]').length !== 4) throw new Error('official tag count mismatch')
if (doc.querySelectorAll('[data-category="custom"]').length !== 3) throw new Error('custom tag count mismatch')
console.log('initial render OK: 7 cards, official tags = 4, custom tags = 3')

const select = (label) => doc.querySelector(`select[aria-label="${label}"]`)

// category filter
await act(async () => { fireEvent.change(select('Category'), { target: { value: 'official' } }) })
if (cards().length !== 4 || count() !== '4') throw new Error(`category=official: ${cards().length} cards, count ${count()}`)
await act(async () => { fireEvent.change(select('Category'), { target: { value: 'custom' } }) })
if (cards().length !== 3) throw new Error(`category=custom: ${cards().length} cards`)
console.log('category filter OK')

// enablement filter
await act(async () => { fireEvent.change(select('Category'), { target: { value: 'all' } }) })
await act(async () => { fireEvent.change(select('Enablement'), { target: { value: 'disabled' } }) })
if (cards().length !== 2) throw new Error(`enablement=disabled: ${cards().length} cards`)
console.log('enablement filter OK')

// phase filter
await act(async () => { fireEvent.change(select('Enablement'), { target: { value: 'all' } }) })
await act(async () => { fireEvent.change(select('Runtime status'), { target: { value: 'failed' } }) })
if (cards().length !== 1) throw new Error(`phase=failed: ${cards().length} cards`)
if (cards()[0].textContent.includes('plugin-inventory') === false) throw new Error('failed card title mismatch')
console.log('phase filter OK')

// search + combined AND semantics
await act(async () => {
  fireEvent.change(select('Runtime status'), { target: { value: 'all' } })
  fireEvent.change(doc.querySelector('input[type="search"]'), { target: { value: 'not-a-plugin' } })
})
if (cards().length !== 0) throw new Error('search miss should render 0 cards')
if (doc.body.textContent.includes(en.emptySearch) === false) throw new Error('emptySearch copy missing')

await act(async () => {
  fireEvent.change(doc.querySelector('input[type="search"]'), { target: { value: 'hmr' } })
  fireEvent.change(select('Category'), { target: { value: 'official' } })
  fireEvent.change(select('Enablement'), { target: { value: 'enabled' } })
  fireEvent.change(select('Runtime status'), { target: { value: 'active' } })
})
if (cards().length !== 1) throw new Error(`combined: ${cards().length} cards`)
if (cards()[0].getAttribute('data-plugin-entry') !== 'official-active') throw new Error('combined filter picked wrong row')

// disclosure expands
await act(async () => { fireEvent.click(cards()[0].querySelector('.pm-card-content')) })
if (doc.querySelector('[data-loader-entry]') === null) throw new Error('disclosure details missing')
console.log('search + combined + disclosure OK')

// error state
const errorHost = dom.window.document.createElement('div')
const root2 = createRoot(errorHost)
await act(async () => {
  root2.render(React.createElement(registered.component, {
    list: async () => { throw new Error('private detail') },
    t: (key) => en[key],
  }))
})
if (errorHost.querySelector('[role="alert"]') === null) throw new Error('error state missing')
if (errorHost.textContent.includes('private detail')) throw new Error('error state leaked transport detail')
console.log('error state OK')

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
