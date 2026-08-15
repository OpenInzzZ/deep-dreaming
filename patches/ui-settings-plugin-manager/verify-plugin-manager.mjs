/**
 * Functional harness for the user-level plugin-manager bundle.
 *
 * Host half: imports the real `lib/index.js`, exercises the patch-file
 * editing helpers (remove/append disabled blocks) against a TEMP patch file,
 * then applies the plugin to a mock Cordis context and asserts the
 * `/plugin-toggle` RPC channel (loopback) with endpoint validation —
 * including the P0 guard: `apply` must NOT return a thenable.
 *
 * Client half: loads the exact deployed `lib/client.js` the browser will
 * execute, feeds it a module table stubbed with the real platform words
 * (react, react/jsx-runtime, ui-primitives), asserts the registration
 * contract, then — when jsdom is available — renders the tab and exercises
 * the filters and the enable/disable toggle end to end.
 *
 * Dependency resolution is relative to this patch directory and the deployed
 * profile (`~/.dsh/profiles/...`); no machine-specific paths. jsdom is the
 * only DOM dependency; when it is missing the render section is skipped with
 * a notice and the bundle + contract checks still run (DOM shim).
 *
 * Run: node patches/ui-settings-plugin-manager/verify-plugin-manager.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? ''
const uiRequire = createRequire(join(userProfile, '.dsh', 'profiles', 'web', 'package.json'))
const React = uiRequire('react')

let JSDOM = null
try {
  JSDOM = uiRequire('jsdom').JSDOM
} catch { /* render section skipped below */ }

const hostPath = join(here, 'lib', 'index.js')
const bundlePath = join(here, 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-client-ui-settings-plugin-manager'

// --- host half: patch-file editing + /plugin-toggle RPC ------------------------
const host = await import(pathToFileURL(hostPath).href)

// Pure helpers: disabled-block append/remove semantics
{
  const base = '# header\n- insert:\n    - id: a\n      name: pkg-a\n'
  const removed = host.removeDisabledBlock(base + '- id: a\n  disabled: true\n- id: b\n  disabled: true\n', 'a')
  if (removed.removed !== 1) throw new Error(`removeDisabledBlock removed ${removed.removed}`)
  if (removed.content.includes('- id: a\n  disabled: true')) throw new Error('disabled block for a must be removed')
  if (!removed.content.includes('- id: b\n  disabled: true')) throw new Error('disabled block for b must stay')
  const untouched = host.removeDisabledBlock(base, 'a')
  if (untouched.removed !== 0 || untouched.content !== base) throw new Error('remove with no match must be a no-op')
  const appended = host.appendDisabledBlock(base, 'a')
  if (!appended.endsWith('- id: a\n  disabled: true\n')) throw new Error(`append shape: ${appended}`)
  console.log('host helpers OK: removeDisabledBlock + appendDisabledBlock')
}

// setEnabled against a TEMP patch file (never the real profile layer)
const tmpDir = mkdtempSync(join(tmpdir(), 'plugin-manager-verify-'))
const tmpPatch = join(tmpDir, 'cordis.patch.yml')
const PATCH_HEADER = '# test layer\n- insert:\n    - id: a\n      name: pkg-a\n    - id: b\n      name: pkg-b\n'
writeFileSync(tmpPatch, PATCH_HEADER)

{
  const off = await host.setEnabled(tmpPatch, 'a', false)
  if (off.enabled !== false || off.changed !== true) throw new Error(`setEnabled(false) first: ${JSON.stringify(off)}`)
  if (!readFileSync(tmpPatch, 'utf8').includes('- id: a\n  disabled: true')) throw new Error('disable must append the disabled block')
  const offAgain = await host.setEnabled(tmpPatch, 'a', false)
  if (offAgain.changed !== false) throw new Error(`setEnabled(false) twice must be idempotent: ${JSON.stringify(offAgain)}`)
  const on = await host.setEnabled(tmpPatch, 'a', true)
  if (on.enabled !== true || on.changed !== true) throw new Error(`setEnabled(true): ${JSON.stringify(on)}`)
  const content = readFileSync(tmpPatch, 'utf8')
  if (content.includes('disabled: true')) throw new Error(`enable must remove the disabled block:\n${content}`)
  const onAgain = await host.setEnabled(tmpPatch, 'a', true)
  if (onAgain.changed !== false) throw new Error('setEnabled(true) twice must be idempotent')
  let invalidRejected = false
  try { await host.setEnabled(tmpPatch, 'a/../evil', false) } catch { invalidRejected = true }
  if (!invalidRejected) throw new Error('setEnabled must reject path-ish entry ids (..)')
  for (const bad of ['a b', 'a#b', 'a"b', 'a\\b', '']) {
    let rejected = false
    try { await host.setEnabled(tmpPatch, bad, false) } catch { rejected = true }
    if (!rejected) throw new Error(`setEnabled must reject ${JSON.stringify(bad)}`)
  }
  // Loader-builtin ids (cordis: prefix) are valid — this was the reported
  // regression: the original identifier charset rejected them.
  const builtinOff = await host.setEnabled(tmpPatch, 'cordis:include', false)
  if (builtinOff.enabled !== false || builtinOff.changed !== true) throw new Error(`cordis: prefix disable: ${JSON.stringify(builtinOff)}`)
  const builtinOn = await host.setEnabled(tmpPatch, 'cordis:include', true)
  if (builtinOn.changed !== true) throw new Error(`cordis: prefix enable: ${JSON.stringify(builtinOn)}`)
  console.log('host setEnabled OK: disable appends / enable removes / idempotent / rejects bad ids / accepts cordis: builtins')
}

// apply(): /plugin-toggle channel registration + endpoint validation
{
  let handled = null
  const hostCtx = {
    inject: (services, callback) => {
      if (services.join(',') === 'connection') {
        return callback({
          connection: {
            rpc: {
              handle: (channel, handler, options) => {
                handled = { channel, handler, options }
                return () => {}
              },
            },
          },
        })
      }
      return undefined
    },
  }
  const ret = host.apply(hostCtx, { patchFile: tmpPatch })
  if (ret !== undefined && typeof ret.then === 'function') {
    throw new Error('P0 regression: apply returned a thenable (Invalid effect)')
  }
  if (handled === null || handled.channel !== '/plugin-toggle') throw new Error(`channel: ${JSON.stringify(handled)}`)
  if (handled.options.authority !== 'loopback') throw new Error(`authority: ${handled.options.authority}`)

  const bad = await handled.handler('setEnabled', { args: { entryId: 'a' } })
  if (bad.ok !== false || bad.error.code !== 'bad-request') throw new Error(`missing enabled: ${JSON.stringify(bad)}`)
  const badId = await handled.handler('setEnabled', { args: { entryId: 'a/../x', enabled: true } })
  if (badId.ok !== false || badId.error.code !== 'bad-request') throw new Error(`bad id: ${JSON.stringify(badId)}`)
  const unknown = await handled.handler('nope', {})
  if (unknown.ok !== false || unknown.error.code !== 'bad-request') throw new Error(`unknown endpoint: ${JSON.stringify(unknown)}`)
  const ok = await handled.handler('setEnabled', { args: { entryId: 'b', enabled: false } })
  if (!ok.ok || ok.value.enabled !== false || ok.value.changed !== true) throw new Error(`setEnabled via rpc: ${JSON.stringify(ok)}`)
  if (!readFileSync(tmpPatch, 'utf8').includes('- id: b\n  disabled: true')) throw new Error('rpc setEnabled must write the file')
  console.log('host OK: /plugin-toggle channel (loopback) + validation + setEnabled writes the temp patch')
}
rmSync(tmpDir, { recursive: true, force: true })

// --- load the bundle exactly like the shell kernel does ----------------------
let dom = null
let handoff = null
const bundleSource = readFileSync(bundlePath, 'utf8')
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

const requireTable = (spec) => {
  if (spec === 'react') return React
  if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
  // The bundle only consumes the two icon components, so stub them with plain
  // svg placeholders (identical contract, no styling dependency).
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
const toggleCalls = []
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => { dictionaries = { ns, dicts } },
    bind: () => (key) => 't:' + key,
  },
  connection: {
    rpc: {
      call: async (channel, endpoint, payload) => {
        toggleCalls.push({ channel, endpoint, payload })
        return { ok: true, value: { enabled: payload.args.enabled, changed: true, entryId: payload.args.entryId } }
      },
    },
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
if (typeof registered.inject().toggleEnabled !== 'function') throw new Error('inject must expose toggleEnabled')
const toggleProbe = await registered.inject().toggleEnabled('ui-queue-tools', false)
if (toggleProbe.enabled !== false) throw new Error(`toggleEnabled rpc result: ${JSON.stringify(toggleProbe)}`)
const toggleCall = toggleCalls.pop()
if (toggleCall.channel !== '/plugin-toggle' || toggleCall.endpoint !== 'setEnabled') {
  throw new Error(`toggle rpc target: ${JSON.stringify(toggleCall)}`)
}
if (JSON.stringify(toggleCall.payload) !== '{"args":{"entryId":"ui-queue-tools","enabled":false}}') {
  throw new Error(`toggle rpc payload: ${JSON.stringify(toggleCall)}`)
}
if (dictionaries === null || dictionaries.ns !== exports_.NS) throw new Error('dictionaries not registered')
const zhKeys = Object.keys(dictionaries.dicts.zh)
const enKeys = Object.keys(dictionaries.dicts.en)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  throw new Error(`zh/en key mismatch:\nzh: ${zhKeys}\nen: ${enKeys}`)
}
console.log('apply contract OK: tab id =', registered.id, 'order =', registered.order, '| dict keys =', zhKeys.length, '| toggleEnabled → /plugin-toggle setEnabled')

if (JSDOM === null) {
  console.log('\nclient DOM sections SKIPPED (jsdom not installed)')
  console.log('ALL NON-DOM HARNESS CHECKS PASSED (install jsdom to enable the DOM sections)')
  process.exit(0)
}

// --- render + interact (react-dom in jsdom) ------------------------------------
const { act } = React
const { createRoot } = uiRequire('react-dom/client')
const fireChange = (el, value) => {
  const proto = el.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}
const fireClick = (el) => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const en = dictionaries.dicts.en
const injected = registered.inject()
const root = createRoot(dom.window.document.getElementById('root'))

await act(async () => {
  root.render(React.createElement(registered.component, {
    list: async () => SNAPSHOT,
    toggleEnabled: injected.toggleEnabled,
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

// every card carries an enable/disable toggle; clicking it calls
// /plugin-toggle setEnabled with the inverse state and refreshes the list
const toggles = () => [...doc.querySelectorAll('.pm-toggle')]
if (toggles().length !== 7) throw new Error(`expected 7 toggle buttons, got ${toggles().length}`)
const firstToggle = toggles()[0]
const firstCard = firstToggle.closest('.pm-card')
if (firstCard.getAttribute('data-plugin-entry') !== 'official-active') throw new Error('first card ordering mismatch')
await act(async () => { fireClick(firstToggle) })
const clickCall = toggleCalls.pop()
if (clickCall === undefined || clickCall.endpoint !== 'setEnabled' || clickCall.payload.args.entryId !== 'official-active' || clickCall.payload.args.enabled !== false) {
  throw new Error(`toggle click rpc: ${JSON.stringify(clickCall)}`)
}
console.log('toggle OK: card button calls /plugin-toggle setEnabled (inverse state)')

const select = (label) => doc.querySelector(`select[aria-label="${label}"]`)

// category filter
await act(async () => { fireChange(select('Category'), 'official') })
if (cards().length !== 4 || count() !== '4') throw new Error(`category=official: ${cards().length} cards, count ${count()}`)
await act(async () => { fireChange(select('Category'), 'custom') })
if (cards().length !== 3) throw new Error(`category=custom: ${cards().length} cards`)
console.log('category filter OK')

// enablement filter
await act(async () => { fireChange(select('Category'), 'all') })
await act(async () => { fireChange(select('Enablement'), 'disabled') })
if (cards().length !== 2) throw new Error(`enablement=disabled: ${cards().length} cards`)
console.log('enablement filter OK')

// phase filter
await act(async () => { fireChange(select('Enablement'), 'all') })
await act(async () => { fireChange(select('Runtime status'), 'failed') })
if (cards().length !== 1) throw new Error(`phase=failed: ${cards().length} cards`)
if (cards()[0].textContent.includes('plugin-inventory') === false) throw new Error('failed card title mismatch')
console.log('phase filter OK')

// search + combined AND semantics
await act(async () => {
  fireChange(select('Runtime status'), 'all')
  fireChange(doc.querySelector('input[type="search"]'), 'not-a-plugin')
})
if (cards().length !== 0) throw new Error('search miss should render 0 cards')
if (doc.body.textContent.includes(en.emptySearch) === false) throw new Error('emptySearch copy missing')

await act(async () => {
  fireChange(doc.querySelector('input[type="search"]'), 'hmr')
  fireChange(select('Category'), 'official')
  fireChange(select('Enablement'), 'enabled')
  fireChange(select('Runtime status'), 'active')
})
if (cards().length !== 1) throw new Error(`combined: ${cards().length} cards`)
if (cards()[0].getAttribute('data-plugin-entry') !== 'official-active') throw new Error('combined filter picked wrong row')

// disclosure expands
await act(async () => { fireClick(cards()[0].querySelector('.pm-card-content')) })
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
