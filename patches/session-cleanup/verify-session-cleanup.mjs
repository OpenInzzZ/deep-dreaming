/**
 * Functional harness for the session-cleanup patch's settings integration.
 *
 * Host half: applies the real `session-cleanup.mjs` to a mock Cordis context —
 * both without a settings service (entry-config fallback) and with one
 * (namespace registration + watch-driven timer rebuild).
 *
 * Client half: loads the exact deployed `client.js`, asserts the
 * `settings.plugin.item` card registration, renders it in jsdom, and checks
 * the staged-edit → save → `scope.set` flow plus per-field reset.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const repoRequire = createRequire('D:/GitHub/deepseek-harness/package.json')
const uiRequire = createRequire('C:/Users/zhoukaiying/.dsh/profiles/web/package.json')
const { JSDOM } = repoRequire('jsdom')
const React = uiRequire('react')

const here = dirname(fileURLToPath(import.meta.url))
const hostPath = join(here, 'session-cleanup.mjs')
const clientPath = join(here, 'client.js')
const PLUGIN_ID = '@local/dsh-plugin-session-cleanup/client'

// --- host half: entry fallback + settings integration --------------------------
const host = await import(pathToFileURL(hostPath).href)
const sessionsRoot = await mkdtemp(join(tmpdir(), 'cleanup-verify-'))

function makeCtx({ withSettings }) {
  const calls = { info: [], warn: [], registered: null, watchCb: null, effects: 0 }
  const logger = {
    info: (...args) => { calls.info.push(args) },
    warn: (...args) => { calls.warn.push(args) },
  }
  const ctx = {
    logger,
    calls,
    fiber: { state: 0 },
    inject: (services, callback) => {
      const list = services.join(',')
      if (list === 'sessions') {
        return callback({ ...ctx, sessions: { list: () => [] } })
      }
      if (list === 'settings' && withSettings) {
        return callback({
          ...ctx,
          settings: {
            register: (ns, schema, options) => {
              calls.registered = { ns, options }
              return {
                get: () => ({ ...host.DEFAULTS, ...options.base, intervalMinutes: 5 }),
                watch: (cb) => { calls.watchCb = cb; return () => {} },
              }
            },
          },
          effect: (fn) => { calls.effects += 1; return fn() },
        })
      }
      return undefined
    },
    effect: (fn) => { calls.effects += 1; return fn() },
  }
  return ctx
}

// 1) no settings service -> entry config drives the cleanup
{
  const entry = { sessionsRoot, maxAgeDays: 7, intervalMinutes: 9 }
  const ctx = makeCtx({ withSettings: false })
  const dispose = host.apply(ctx, entry)
  if (dispose === undefined) throw new Error('apply must still run without a settings service')
  await new Promise((resolve) => setTimeout(resolve, 120))
  if (ctx.calls.info.length === 0) throw new Error('startup cleanup tick must run from the entry config')
  if (!ctx.calls.info[0][0].includes('scanned=')) throw new Error(`tick summary missing: ${ctx.calls.info[0]}`)
  if (ctx.calls.registered !== null) throw new Error('no settings service must not register a namespace')
  dispose()
  console.log('host OK: entry-config fallback (no settings service)')
}

// 2) settings service -> namespace registered, watch rebuilds the timer
{
  const entry = { sessionsRoot, maxAgeDays: 7, intervalMinutes: 9 }
  const ctx = makeCtx({ withSettings: true })
  const dispose = host.apply(ctx, entry)
  await new Promise((resolve) => setTimeout(resolve, 120))
  if (ctx.calls.registered === null || ctx.calls.registered.ns !== 'session-cleanup') {
    throw new Error(`namespace not registered: ${JSON.stringify(ctx.calls.registered)}`)
  }
  if (ctx.calls.registered.options.base !== entry) throw new Error('entry config must be the composition base')
  const before = ctx.calls.info.length
  if (before === 0) throw new Error('startup tick must run with settings present')
  ctx.calls.watchCb()
  await new Promise((resolve) => setTimeout(resolve, 120))
  if (ctx.calls.info.length <= before) throw new Error('watch change must rebuild the timer (startup tick again)')
  dispose()
  console.log('host OK: settings namespace registration + watch-driven rebuild')
}

// --- client half: jsdom --------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
})
globalThis.window = dom.window
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (!(key in globalThis)) globalThis[key] = dom.window[key]
}

let handoff = null
dom.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
const bundleSource = readFileSync(clientPath, 'utf8')
const evaluate = new Function('window', 'document', bundleSource)
evaluate(dom.window, dom.window.document)
if (handoff === null) throw new Error('bundle never called __ModuleLoader__.load')
if (handoff.id !== PLUGIN_ID) throw new Error(`handoff id mismatch: ${handoff.id}`)

const icon = (props) => React.createElement('svg', { ...props, 'data-icon': true })
const requireTable = (spec) => {
  if (spec === 'react') return uiRequire('react')
  if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return { IconChevronDownOutline14: icon }
  }
  throw new Error(`unexpected module-table word: ${spec}`)
}
const exports_ = handoff.factory(requireTable)
if (typeof exports_.apply !== 'function' || !Array.isArray(exports_.inject)) throw new Error('exports contract broken')
if (exports_.NS !== 'session-cleanup.card') throw new Error(`NS mismatch: ${exports_.NS}`)
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

let registered = null
let dictionaries = null
let snapshot = {
  status: 'ready',
  value: { enabled: true, maxAgeDays: 45, maxTotalMB: 1024, keepSessions: 5, intervalMinutes: 360, dryRun: false, sessionsRoot: '' },
  base: { enabled: true, maxAgeDays: 30 },
  user: { maxAgeDays: 45 },
  revision: 1,
  writable: true,
  mode: 'host',
}
let listeners = []
const writes = []
const clears = []
const scope = {
  getSnapshot: () => snapshot,
  subscribe: (listener) => { listeners.push(listener); return () => {} },
  set: async (field, value) => { writes.push({ field, value }) },
  unset: async (field) => { clears.push(field) },
}
const clientCtx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => { dictionaries = { ns, dicts } },
    bind: () => (key) => 't:' + key,
  },
  settingsScope: { bind: (spec) => {
    if (spec.namespace !== 'session-cleanup') throw new Error(`unexpected namespace: ${spec.namespace}`)
    return scope
  } },
  slots: {
    inject: (_key, callback) => { registered = callback() },
    register: (options, component) => ({ ...options, component }),
  },
}
exports_.apply(clientCtx)
if (registered === null) throw new Error('slots.inject never registered')
if (registered.id !== 'session-cleanup' || registered.order !== 30) {
  throw new Error(`card registration mismatch: ${JSON.stringify(registered)}`)
}
if (dictionaries === null || dictionaries.ns !== exports_.NS) throw new Error('dictionaries not registered')
const zhKeys = Object.keys(dictionaries.dicts.zh)
const enKeys = Object.keys(dictionaries.dicts.en)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) throw new Error(`zh/en key mismatch:\nzh: ${zhKeys}\nen: ${enKeys}`)
console.log('apply contract OK: settings.plugin.item id=session-cleanup order=30 | dict keys =', zhKeys.length)

// --- render + interact ----------------------------------------------------------
const { act } = React
const { createRoot } = uiRequire('react-dom/client')
const { fireEvent } = repoRequire('@testing-library/react')
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const en = dictionaries.dicts.en
const tWithParams = (key) => en[key]
const root = createRoot(dom.window.document.getElementById('root'))
await act(async () => {
  root.render(React.createElement(registered.component, {
    scope,
    t: tWithParams,
  }))
})

const doc = dom.window.document
const header = doc.querySelector('.sc-header')
if (header === null) throw new Error('card header missing')
await act(async () => { fireEvent.click(header) })
const inputs = [...doc.querySelectorAll('.sc-input')]
if (inputs.length !== 5) throw new Error(`expected 5 number/text inputs, got ${inputs.length}`)
const toggles = [...doc.querySelectorAll('.sc-toggle')]
if (toggles.length !== 2) throw new Error(`expected 2 toggles, got ${toggles.length}`)

// the user override on maxAgeDays is visible and resettable
const maxAgeInput = doc.querySelector('#sc-maxAgeDays')
if (maxAgeInput === null || maxAgeInput.value !== '45') throw new Error(`override value: ${maxAgeInput?.value}`)
if (!doc.querySelector('.sc-overridden')) throw new Error('override badge missing')

// staged edit -> save writes the field through the scope
await act(async () => { fireEvent.change(maxAgeInput, { target: { value: '60' } }) })
if (!doc.querySelector('.sc-pending')) throw new Error('unsaved badge missing')
const saveButton = doc.querySelector('.sc-save')
if (saveButton === null || saveButton.disabled) throw new Error('save must be enabled with staged edits')
await act(async () => { fireEvent.click(saveButton) })
if (writes.length !== 1 || writes[0].field !== 'maxAgeDays' || writes[0].value !== 60) {
  throw new Error(`save write: ${JSON.stringify(writes)}`)
}
console.log('card OK: fields render, staged edit saves through scope.set')

// reset clears the override (per-field reset button inside the same field row)
const maxAgeField = maxAgeInput.closest('.sc-field')
if (maxAgeField === null) throw new Error('field row missing')
const resetButton = maxAgeField.querySelector('.sc-reset')
if (resetButton === null || resetButton.disabled) throw new Error('override reset must be enabled')
await act(async () => { fireEvent.click(resetButton) })
if (clears.length !== 1 || clears[0] !== 'maxAgeDays') throw new Error(`reset clear: ${JSON.stringify(clears)}`)
console.log('card OK: reset calls scope.unset')

// read-only snapshot disables the controls
snapshot = { ...snapshot, writable: false, revision: 2 }
listeners.forEach((l) => l())
await act(async () => {})
if (doc.querySelector('.sc-input').disabled !== true) throw new Error('read-only must disable inputs')
console.log('card OK: read-only disables controls')

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
