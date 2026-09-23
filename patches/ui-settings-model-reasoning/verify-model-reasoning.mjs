/**
 * Functional harness for the ui-settings-model-reasoning patch.
 *
 * Client half: loads the exact deployed `lib/client.js` the browser will
 * execute, feeds it the platform seed words (react, react/jsx-runtime,
 * ui-primitives), applies it against a mock ctx (slots / locale /
 * settingsScope), and asserts the registration contract — one keyed
 * `settings.models.provider-card` entry for `llm-pi-ai` plus the namespace the
 * scope binds. Pure helpers (stateOf / levelsToConfig / validState /
 * applyDrafts / withLevel / withWire) are exercised directly.
 *
 * With jsdom the card renders against a fake scope snapshot and the flow runs
 * end to end: per-model switch, level editor (defaults, membership, wire
 * values), save -> one `scope.mutate` path op writing the models array, the
 * refused-write detection, and discard.
 *
 * Run from the repo root:
 *   node patches/ui-settings-model-reasoning/verify-model-reasoning.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? ''
const profileAnchor = join(userProfile, '.dsh', 'profiles', 'web', 'package.json')
// Resolve from the deployed profile first; a DSH reinstall can prune the
// profile's hoisted copies (dangling links), so the harness checkout backs it up.
const harnessAnchor = 'D:/GitHub/deepseek-harness/apps/web/package.json'
const uiRequire = (spec) => {
  try { return createRequire(profileAnchor)(spec) } catch { return createRequire(harnessAnchor)(spec) }
}
const React = uiRequire('react')

// jsdom is optional: without it the DOM sections are skipped and the contract
// checks still run.
let JSDOM = null
try { JSDOM = uiRequire('jsdom').JSDOM } catch { /* skip */ }
const DOM_AVAILABLE = JSDOM !== null

const clientPath = join(here, 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-client-ui-settings-model-reasoning'

// --- load the bundle exactly like the shell kernel does ----------------------
let handoff = null
const bundleSource = readFileSync(clientPath, 'utf8')
if (DOM_AVAILABLE) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3080/',
  })
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

const icon = (props) => React.createElement('svg', { ...props, 'data-icon': true })
const Switch = ({ checked, onChange, label, disabled }) => React.createElement('button', {
  type: 'button',
  role: 'switch',
  'aria-checked': checked === true,
  'aria-label': label,
  disabled: disabled === true,
  onClick: () => { if (disabled !== true) onChange(!checked) },
})
const Input = ({ className, value, onChange, ...rest }) => React.createElement('input', {
  className,
  value: value ?? '',
  onChange,
  ...rest,
})
const requireTable = (spec) => {
  if (spec === 'react') return uiRequire('react')
  if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return { Switch, Input, IconChevronDownOutline14: icon }
  }
  throw new Error(`unexpected module-table word: ${spec}`)
}
const exports_ = handoff.factory(requireTable)

// --- exports contract ---------------------------------------------------------
if (typeof exports_.apply !== 'function') throw new Error('exports.apply missing')
if (!Array.isArray(exports_.inject) || exports_.inject.join(',') !== 'slots,locale,settingsScope') {
  throw new Error(`exports.inject mismatch: ${JSON.stringify(exports_.inject)}`)
}
if (exports_.NS !== 'modelReasoning') throw new Error(`NS mismatch: ${exports_.NS}`)
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

// --- pure helpers -------------------------------------------------------------
{
  const { stateOf, levelsToConfig, validState, canonical, applyDrafts, withLevel, withWire } = exports_
  for (const name of ['stateOf', 'levelsToConfig', 'validState', 'canonical', 'applyDrafts', 'withLevel', 'withWire']) {
    if (typeof exports_[name] !== 'function') throw new Error(`helper ${name} missing`)
  }
  const off = stateOf(false)
  if (off.enabled !== false || off.configured !== true) throw new Error(`stateOf(false): ${JSON.stringify(off)}`)
  const inherit = stateOf(undefined)
  if (inherit.enabled !== false || inherit.configured !== false) throw new Error(`stateOf(undefined): ${JSON.stringify(inherit)}`)
  const on = stateOf({ off: null, low: 'low' })
  if (on.enabled !== true || on.levels.off !== null || on.levels.low !== 'low') throw new Error(`stateOf(map): ${JSON.stringify(on)}`)
  if (JSON.stringify(levelsToConfig(on)) !== '{"off":null,"low":"low"}') throw new Error(`levelsToConfig(map): ${JSON.stringify(levelsToConfig(on))}`)
  if (levelsToConfig(off) !== false) throw new Error('levelsToConfig(disabled) must be false')
  if (validState({ enabled: true, levels: { off: null } }) !== false) throw new Error('off-only state must be invalid')
  if (validState({ enabled: true, levels: { off: null, low: ' ' } }) !== true) throw new Error('non-empty wire must be valid')
  if (validState({ enabled: true, levels: { off: null, low: '' } }) !== false) throw new Error('empty wire must be invalid')
  if (validState({ enabled: false, levels: {} }) !== true) throw new Error('disabled state must be valid')
  const grown = withLevel({ enabled: true, levels: { off: null } }, 'medium', true)
  if (JSON.stringify(grown.levels) !== '{"off":null,"medium":"medium"}') throw new Error(`withLevel default wire: ${JSON.stringify(grown.levels)}`)
  const wired = withWire(grown, 'medium', 'mid')
  if (wired.levels.medium !== 'mid') throw new Error(`withWire: ${JSON.stringify(wired.levels)}`)
  const dropped = withLevel(wired, 'off', false)
  if ('off' in dropped.levels) throw new Error('withLevel(false) must drop the level')
  const models = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', reasoningEfforts: false }]
  const drafted = applyDrafts(models, { a: { enabled: true, levels: { off: null, low: 'low' } } })
  if (drafted[0].reasoningEfforts.low !== 'low' || drafted[1].reasoningEfforts !== false) {
    throw new Error(`applyDrafts: ${JSON.stringify(drafted)}`)
  }
  if (canonical({ enabled: true, levels: { low: 'low', off: null } }) !== canonical({ enabled: true, levels: { off: null, low: 'low' } })) {
    throw new Error('canonical must be level-order independent')
  }
  console.log('pure helpers OK: stateOf/levelsToConfig/validState/withLevel/withWire/applyDrafts/canonical')
}

// --- apply(): registration + scope binding ------------------------------------
let registered = null
let injectedEntry = null
let boundSpec = null
const dictionaries = []
const bind = (ns) => (key, params) => {
  const entry = dictionaries.find((candidate) => candidate.ns === ns)
  const template = entry?.dict?.zh?.[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

const route = 'taikoo-cgh'
const settingsPath = ['providers', route]
const initialModels = [
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' } },
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', reasoningEfforts: false },
  { id: 'gpt-6-astra', name: 'gpt-6-astra', contextWindow: 922000 },
]
const snapshot = {
  status: 'ready',
  value: { providers: { [route]: { apiKeyEnv: 'TAIKOO_CGH_API_KEY', models: JSON.parse(JSON.stringify(initialModels)) } } },
  user: { providers: { [route]: { apiKeyEnv: 'TAIKOO_CGH_API_KEY', models: JSON.parse(JSON.stringify(initialModels)) } } },
  base: undefined,
  revision: 7,
  writable: true,
  mode: 'host',
}
const mutations = []
let refuseWrites = false
const setPath = (root, path, value) => {
  let current = root
  for (let i = 0; i < path.length - 1; i++) {
    if (typeof current[path[i]] !== 'object' || current[path[i]] === null) current[path[i]] = {}
    current = current[path[i]]
  }
  current[path[path.length - 1]] = value
}
const fakeScope = {
  // Deliberately prototype-style methods: the real SettingsScopeController
  // exposes unbound class methods, so handing them to useSyncExternalStore
  // without a receiver must throw here too (the regression this guards).
  snapshot,
  getSnapshot() { return this.snapshot },
  subscribe() { return () => {} },
  async mutate(ops) {
    mutations.push(JSON.parse(JSON.stringify(ops)))
    if (refuseWrites) return
    for (const op of ops) setPath(this.snapshot.user, op.path, op.value)
  },
}

const clientCtx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dict) => { dictionaries.push({ ns, dict }) },
    bind,
  },
  settingsScope: {
    bind: (spec) => { boundSpec = spec; return fakeScope },
  },
  slots: {
    inject: (key, callback) => { injectedEntry = { key, registration: callback() } },
    register: (options, component) => ({ ...options, component }),
  },
}
const returned = exports_.apply(clientCtx)
if (returned !== undefined && typeof returned.then === 'function') {
  throw new Error('apply returned a thenable (Invalid effect regression)')
}
if (injectedEntry === null || injectedEntry.key !== 'settings.models.provider-card') {
  throw new Error(`slot mismatch: ${JSON.stringify(injectedEntry?.key)}`)
}
registered = injectedEntry.registration
if (registered.name !== 'settings.models.provider-card' || registered.key !== 'llm-pi-ai') {
  throw new Error(`registration mismatch: ${JSON.stringify({ name: registered.name, key: registered.key })}`)
}
if (registered.locale !== 'modelReasoning') throw new Error(`registration locale: ${registered.locale}`)
if (boundSpec === null || boundSpec.namespace !== 'llm-pi-ai') {
  throw new Error(`scope bind mismatch: ${JSON.stringify(boundSpec)}`)
}
const face = registered.inject()
if (typeof face.scope?.mutate !== 'function' || typeof face.scope?.getSnapshot !== 'function') {
  throw new Error('injected face must expose the settings scope')
}
const dict = dictionaries.find((candidate) => candidate.ns === 'modelReasoning')
if (dict === undefined) throw new Error('dictionaries not registered')
const zhKeys = Object.keys(dict.dict.zh)
const enKeys = Object.keys(dict.dict.en)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  throw new Error(`zh/en key mismatch:\nzh: ${zhKeys}\nen: ${enKeys}`)
}
console.log(`apply contract OK: keyed provider-card registration (llm-pi-ai) | dict keys = ${zhKeys.length}`)

if (!DOM_AVAILABLE) {
  console.log('\nDOM render section SKIPPED (jsdom not installed)')
  console.log('ALL NON-DOM HARNESS CHECKS PASSED (install jsdom to enable the render section)')
  process.exit(0)
}

// --- render + interact (react-dom in jsdom) ------------------------------------
const { act } = React
const { createRoot } = uiRequire('react-dom/client')
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const provider = {
  provider: route,
  displayName: 'Taikoo-Model',
  settingsNs: 'llm-pi-ai',
  settingsPath,
  active: true,
  declared: true,
}
const t = bind('modelReasoning')
const rootHost = globalThis.document.createElement('div')
globalThis.document.body.appendChild(rootHost)
const root = createRoot(rootHost)
const render = async () => {
  await act(async () => {
    root.render(React.createElement(registered.component, { provider, configured: true, keyConfigured: true, t, ...face }))
  })
}
const click = (el) => { el.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true })) }
const rows = () => [...rootHost.querySelectorAll('.mr-model')]
const rowOf = (name) => rows().find((row) => row.querySelector('.mr-name').textContent === name)
const modelSwitch = (name) => rowOf(name).querySelector('.mr-row [role="switch"]')
const levels = (name) => rowOf(name).querySelectorAll('.mr-level')
const wireOf = (name, level) => {
  const levelRow = [...levels(name)].find((row) => row.querySelector('.mr-level-name').textContent === t('level.' + level))
  return levelRow.querySelector('.mr-wire') ?? levelRow.querySelector('.mr-off')
}
const saveButton = () => rootHost.querySelector('.mr-save')
const discardButton = () => rootHost.querySelector('.mr-discard')

const setNativeValue = (input, value) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, 'value')
  descriptor.set.call(input, value)
  input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }))
}

await render()
if (rows().length !== 3) throw new Error(`expected 3 model rows, got ${rows().length}`)
if (modelSwitch('deepseek-v4-pro').getAttribute('aria-checked') !== 'true') throw new Error('configured model must start on')
if (modelSwitch('deepseek-v4-flash').getAttribute('aria-checked') !== 'false') throw new Error('disabled model must start off')
if (rowOf('deepseek-v4-flash').querySelector('.mr-state').textContent !== t('stateOff')) throw new Error('disabled state label wrong')
if (rowOf('gpt-6-astra').querySelector('.mr-state').textContent !== t('stateInherit')) throw new Error('inherit state label wrong')
if (saveButton().disabled !== true) throw new Error('save must start disabled (clean draft)')

// switch a model on: the level editor opens with the default level set
await act(async () => { click(modelSwitch('deepseek-v4-flash')) })
if (modelSwitch('deepseek-v4-flash').getAttribute('aria-checked') !== 'true') throw new Error('toggle must stage the switch on')
const flashLevels = levels('deepseek-v4-flash')
if (flashLevels.length !== 7) throw new Error(`level rows: ${flashLevels.length}`)
const checkedLevels = [...flashLevels]
  .filter((row) => row.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true')
  .map((row) => row.querySelector('.mr-level-name').textContent)
if (JSON.stringify(checkedLevels) !== JSON.stringify(['关闭', '低', '中', '高', '最高'])) {
  throw new Error(`default levels wrong: ${JSON.stringify(checkedLevels)}`)
}
if (saveButton().disabled !== false) throw new Error('save must enable on a dirty draft')
console.log('render OK: three models, staged switch opens the default level set')

// save -> one path op writing the whole models array with the new reasoningEfforts
await act(async () => { click(saveButton()) })
if (mutations.length !== 1) throw new Error(`expected 1 mutation, got ${mutations.length}`)
const op = mutations[0][0]
if (op.op !== 'set' || JSON.stringify(op.path) !== JSON.stringify(['providers', route, 'models'])) {
  throw new Error(`op shape: ${JSON.stringify(op)}`)
}
const written = op.value.find((model) => model.id === 'deepseek-v4-flash')
if (JSON.stringify(written.reasoningEfforts) !== JSON.stringify({ off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' })) {
  throw new Error(`written reasoningEfforts: ${JSON.stringify(written.reasoningEfforts)}`)
}
if (op.value.find((model) => model.id === 'deepseek-v4-pro').reasoningEfforts.medium !== 'medium') {
  throw new Error('untouched models must carry their stored value')
}
if (rootHost.querySelector('.mr-error') !== null) throw new Error('landed write must not surface an error')
if (saveButton().disabled !== true) throw new Error('drafts must reset after a landed write')
console.log('save OK: one models-array path op, untouched models pass through')

// wire values: switch astra on, edit the low wire, save -> the edited value rides the op
await act(async () => { click(modelSwitch('gpt-6-astra')) })
await act(async () => { setNativeValue(wireOf('gpt-6-astra', 'low'), 'lowest') })
await act(async () => { click(saveButton()) })
const astra = mutations[mutations.length - 1][0].value.find((model) => model.id === 'gpt-6-astra')
if (astra.reasoningEfforts.low !== 'lowest' || astra.reasoningEfforts.max !== 'max') {
  throw new Error(`wire edit not carried: ${JSON.stringify(astra.reasoningEfforts)}`)
}
console.log('wire OK: edited wire value rides the saved map')

// discard: a staged edit reverts to the stored state
await act(async () => { click(modelSwitch('deepseek-v4-pro')) })
if (modelSwitch('deepseek-v4-pro').getAttribute('aria-checked') !== 'false') throw new Error('toggle must stage off')
await act(async () => { click(discardButton()) })
if (modelSwitch('deepseek-v4-pro').getAttribute('aria-checked') !== 'true') throw new Error('discard must restore the stored state')
if (saveButton().disabled !== true) throw new Error('discard must clean the draft')
console.log('discard OK: staged edits revert, save returns to disabled')

// refused write: the scope never rejects, so the card detects the unchanged section
refuseWrites = true
const storedBefore = modelSwitch('gpt-6-astra').getAttribute('aria-checked')
const storedEffortsBefore = JSON.stringify(
  fakeScope.snapshot.user.providers[route].models.find((model) => model.id === 'gpt-6-astra').reasoningEfforts,
)
await act(async () => { click(modelSwitch('gpt-6-astra')) })
const stagedAfter = modelSwitch('gpt-6-astra').getAttribute('aria-checked')
if (stagedAfter === storedBefore) throw new Error('refusal case needs a staged change to observe')
const beforeRefusal = mutations.length
await act(async () => { click(saveButton()) })
if (mutations.length !== beforeRefusal + 1) throw new Error('refused save must still attempt the write')
const storedEffortsAfter = JSON.stringify(
  fakeScope.snapshot.user.providers[route].models.find((model) => model.id === 'gpt-6-astra').reasoningEfforts,
)
if (storedEffortsAfter !== storedEffortsBefore) throw new Error('refused write must leave the stored section untouched')
// A refusal keeps the drafts: the staged edit stays on screen and still dirty,
// so the user's work is not thrown away — only the failure is surfaced.
if (modelSwitch('gpt-6-astra').getAttribute('aria-checked') !== stagedAfter) {
  throw new Error('refused write must keep the staged draft')
}
if (saveButton().disabled !== false) throw new Error('refused write must keep the draft dirty for a retry')
const errorLine = rootHost.querySelector('.mr-error')
if (errorLine === null || errorLine.textContent !== t('saveFailed')) {
  throw new Error(`refused write must surface the failure: ${errorLine?.textContent}`)
}
// Discard is still the way out of a preserved draft.
await act(async () => { click(discardButton()) })
if (modelSwitch('gpt-6-astra').getAttribute('aria-checked') !== storedBefore) {
  throw new Error('discard must still restore the stored state after a refusal')
}
if (rootHost.querySelector('.mr-error') !== null) throw new Error('discard must clear the surfaced failure')
refuseWrites = false
console.log('refusal OK: failure surfaced, draft kept for retry, discard still restores the stored state')

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
