/**
 * Functional harness for the ui-settings-model-capabilities patch.
 *
 * Client half: loads the exact deployed `lib/client.js` the browser will
 * execute, feeds it the platform seed words (react, react/jsx-runtime,
 * ui-primitives), applies it against a mock ctx (slots / locale /
 * configForms), and asserts the registration contract — one keyed
 * `settings.models.provider-card` entry for `llm-pi-ai` plus the namespace the
 * scope binds. Pure helpers (stateOf / stateOfInput / levelsToConfig /
 * validState / canonical / applyDrafts / withLevel / withWire / withInput) are
 * exercised directly.
 *
 * With jsdom the card renders against a fake scope snapshot and the flow runs
 * end to end: the thinking switch with its level editor, the image-input
 * segmented control, save -> one `scope.mutate` path op writing the models
 * array, the inherited/declared distinction surviving a round trip, the
 * refused-write detection, and discard.
 *
 * Run from the repo root:
 *   node patches/ui-settings-model-capabilities/verify-model-capabilities.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadDomDeps, createUiRequire } from '../../scripts/test-deps.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// react / jsdom resolve from the repo's own dev dependencies, $NODE_PATH or the
// deployed profile — never from a machine-specific checkout path.
const uiRequire = createUiRequire(import.meta.url)
const domDeps = loadDomDeps(import.meta.url)
const React = domDeps.React
const JSDOM = domDeps.JSDOM
// jsdom is optional: without it the DOM sections are skipped and the contract
// checks still run.
const DOM_AVAILABLE = domDeps.available
if (!DOM_AVAILABLE) console.warn(`SKIP DOM checks: ${domDeps.hint}`)

const clientPath = join(here, 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-client-ui-settings-model-capabilities'

// --- source-level wiring guards -----------------------------------------------
// Every claim below is silent when it breaks, so each one is asserted against the
// deployed source rather than trusted (AGENTS.md pitfall 16). The retired names
// belong to the settings-service rename that killed this half once already.
{
  const source = readFileSync(clientPath, 'utf8')
  // The retired client settings service: `settingsScope` was renamed to
  // `configForms` in 0.1.7-alpha.1, and its `bind({ namespace })` entry point
  // became `get(entryId)`. Declaring the old name leaves the entry pending on a
  // service nobody provides, so the plugin never activates at all. The name is
  // allowed to appear in prose (the header documents the rename); a call site is
  // not.
  const retiredCalls = [...source.matchAll(/(?:ctx\.|\.)(settingsScope)\s*[.(]/g)]
  if (retiredCalls.length > 0) {
    throw new Error(`retired settings service used as a call site: ${JSON.stringify(retiredCalls.map((hit) => hit[0]))}`)
  }
  if (!source.includes("ctx.configForms.get(PI_AI_NS)")) {
    throw new Error('client.js must take its form from configForms.get(<ns>)')
  }
  // The rename this patch carries: the loader entry id, the bundle id and the
  // package name all moved from `…-model-reasoning` to `…-model-capabilities`,
  // and a leftover id would either shadow the new entry or fail to resolve.
  const bundleYml = readFileSync(join(here, 'cordis.patch.yml'), 'utf8')
  const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
  if (!bundleYml.includes(`id: ui-settings-model-capabilities`)) {
    throw new Error('cordis.patch.yml must carry the renamed loader row id')
  }
  if (bundleYml.includes('ui-settings-model-reasoning')) {
    throw new Error('cordis.patch.yml still names the retired loader row id')
  }
  if (manifest.name !== PLUGIN_ID) {
    throw new Error(`package.json name: expected ${PLUGIN_ID}, got ${manifest.name}`)
  }
  if (!bundleYml.includes(manifest.name)) {
    throw new Error("cordis.patch.yml row must name this package's own package.json name")
  }
  // The client bundle id the shell keys its module table on, and the id the
  // style tag is namespaced by, must agree with the manifest.
  if (!source.includes(`window.__ModuleLoader__.load({ id: '${PLUGIN_ID}'`)) {
    throw new Error('client.js must hand off under the package name')
  }
  console.log('source guards OK: configForms (not settingsScope) + the renamed entry id everywhere')
}

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
/**
 * The shipped SegmentedControl's salient contract, mirrored so the harness
 * fails the same way the app would: a tablist whose tabs are `${id}-${value}`,
 * the selected one `aria-selected="true"` and owning the tab stop, and a click
 * on the ALREADY selected segment reported as nothing (the real control stays
 * silent rather than echoing a no-op change).
 */
const SegmentedControl = ({ id, value, options, onChange, label, disabled, className }) => {
  const [selected, setSelected] = React.useState(value)
  React.useEffect(() => { setSelected(value) }, [value])
  return React.createElement('div', { role: 'tablist', 'aria-label': label, className }, options.map((option) => {
    const active = option.value === selected
    return React.createElement('button', {
      key: option.value,
      id: `${id}-${option.value}`,
      type: 'button',
      role: 'tab',
      'aria-selected': active,
      tabIndex: active ? 0 : -1,
      disabled: disabled === true || option.disabled === true,
      onClick: () => { if (!active) { setSelected(option.value); onChange(option.value) } },
    }, option.label)
  }))
}
const requireTable = (spec) => {
  if (spec === 'react') return uiRequire('react')
  if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return { Switch, Input, SegmentedControl, IconChevronDownOutlineMedium: icon }
  }
  throw new Error(`unexpected module-table word: ${spec}`)
}
const exports_ = handoff.factory(requireTable)

// --- exports contract ---------------------------------------------------------
if (typeof exports_.apply !== 'function') throw new Error('exports.apply missing')
if (!Array.isArray(exports_.inject) || exports_.inject.join(',') !== 'slots,locale,configForms') {
  throw new Error(`exports.inject mismatch: ${JSON.stringify(exports_.inject)}`)
}
if (exports_.NS !== 'modelCapabilities') throw new Error(`NS mismatch: ${exports_.NS}`)
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

// --- pure helpers -------------------------------------------------------------
{
  const {
    stateOf, stateOfInput, levelsToConfig, validState, canonical, applyDrafts, withLevel, withWire, withInput,
    modelsAt, entryOf,
  } = exports_
  for (const name of [
    'stateOf', 'stateOfInput', 'levelsToConfig', 'validState', 'canonical', 'applyDrafts', 'withLevel', 'withWire',
    'withInput', 'modelsAt', 'entryOf',
  ]) {
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
  // pi-ai keeps a declared off value in the map for dispatch (adapter.spec's
  // `off: none` promise) and rejects an empty string on any level.
  const offWired = stateOf({ off: 'none', high: 'high' })
  if (offWired.levels.off !== 'none') throw new Error(`stateOf must keep the off wire: ${JSON.stringify(offWired)}`)
  if (JSON.stringify(levelsToConfig(offWired)) !== '{"off":"none","high":"high"}') {
    throw new Error(`levelsToConfig must write the off wire: ${JSON.stringify(levelsToConfig(offWired))}`)
  }
  if (stateOf({ off: '', high: 'high' }).levels.off !== null) throw new Error('stored off: "" must heal to null on read')
  if (levelsToConfig({ enabled: true, levels: { off: '', high: 'high' } }).off !== null) {
    throw new Error('staged off: "" must write null')
  }
  if (validState({ enabled: true, levels: { off: '', high: 'high' } }) !== false) throw new Error('off: "" must be invalid in validState')
  if (validState({ enabled: true, levels: { off: 'none', high: 'high' } }) !== true) throw new Error('off with a wire must be valid')
  if (validState({ enabled: true, levels: { off: null } }) !== false) throw new Error('off-only state must be invalid')
  if (validState({ enabled: true, levels: { off: null, low: ' ' } }) !== true) throw new Error('non-empty wire must be valid')
  if (validState({ enabled: true, levels: { off: null, low: '' } }) !== false) throw new Error('empty wire must be invalid')
  if (validState({ enabled: false, levels: {} }) !== true) throw new Error('disabled state must be valid')
  // The image half of validation: only the schema's own modalities, never empty.
  if (validState({ enabled: false, levels: {}, input: ['text', 'image'] }) !== true) throw new Error('declared image input must be valid')
  if (validState({ enabled: false, levels: {}, input: ['image'] }) !== true) throw new Error('image-only input must be valid')
  if (validState({ enabled: false, levels: {}, input: [] }) !== false) throw new Error('an empty declaration must be invalid (inherit removes the key)')
  if (validState({ enabled: false, levels: {}, input: ['audio'] }) !== false) throw new Error('an unknown modality must be invalid')
  const grown = withLevel({ enabled: true, levels: { off: null } }, 'medium', true)
  if (JSON.stringify(grown.levels) !== '{"off":null,"medium":"medium"}') throw new Error(`withLevel default wire: ${JSON.stringify(grown.levels)}`)
  const wired = withWire(grown, 'medium', 'mid')
  if (wired.levels.medium !== 'mid') throw new Error(`withWire: ${JSON.stringify(wired.levels)}`)
  if (withWire(wired, 'off', '').levels.off !== null) throw new Error('clearing the off input must stage null')
  const dropped = withLevel(wired, 'off', false)
  if ('off' in dropped.levels) throw new Error('withLevel(false) must drop the level')
  // The declared/inherited distinction: 'inherit' removes the key, the others
  // write the schema's own modality lists.
  if (withInput({ enabled: false, levels: {} }, 'image').input.join('+') !== 'text+image') {
    throw new Error('withInput(image) must stage text+image')
  }
  if (withInput({ enabled: false, levels: {}, input: ['text', 'image'] }, 'text').input.join('+') !== 'text') {
    throw new Error('withInput(text) must stage text')
  }
  if ('input' in withInput({ enabled: false, levels: {}, input: ['text'] }, 'inherit')) {
    throw new Error('withInput(inherit) must drop the key')
  }
  const models = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', reasoningEfforts: false }]
  const drafted = applyDrafts(models, { a: { enabled: true, levels: { off: null, low: 'low' } } })
  if (drafted[0].reasoningEfforts.low !== 'low' || drafted[1].reasoningEfforts !== false) {
    throw new Error(`applyDrafts: ${JSON.stringify(drafted)}`)
  }
  if ('input' in drafted[0]) throw new Error('an inherited image state must not materialize an input key')
  const declaredDraft = applyDrafts([{ id: 'a', name: 'A', input: ['text'] }], { a: { enabled: false, levels: {}, input: ['text', 'image'] } })[0]
  if (declaredDraft.input.join('+') !== 'text+image') throw new Error(`applyDrafts must write the declaration: ${JSON.stringify(declaredDraft)}`)
  const clearedDraft = applyDrafts([{ id: 'a', name: 'A', input: ['text', 'image'] }], { a: { enabled: false, levels: {} } })[0]
  if ('input' in clearedDraft) throw new Error('applyDrafts must REMOVE the key when the staged state inherits')
  if (canonical({ enabled: true, levels: { low: 'low', off: null } }) !== canonical({ enabled: true, levels: { off: null, low: 'low' } })) {
    throw new Error('canonical must be level-order independent')
  }
  if (canonical({ enabled: false, levels: {} }) !== canonical({ enabled: false, levels: {}, input: undefined })) {
    throw new Error('canonical: an absent and a staged-away input are the same claim')
  }
  if (canonical({ enabled: false, levels: {}, input: ['text'] }) === canonical({ enabled: false, levels: {} })) {
    throw new Error('canonical: a declaration must differ from the inherited state')
  }
  // Layer accessors: only an array of models answers, and a missing layer is [].
  if (modelsAt({ providers: { p: { models } } }, ['providers', 'p']).length !== 2) throw new Error('modelsAt must read the section')
  if (modelsAt({ providers: { p: {} } }, ['providers', 'p']).length !== 0) throw new Error('modelsAt must answer [] without a list')
  if (modelsAt({ providers: {} }, ['providers', 'missing']).length !== 0) throw new Error('modelsAt must answer [] without the section')
  if (entryOf(models, 'b')?.name !== 'B' || entryOf(models, 'zz') !== undefined) throw new Error('entryOf must match by id')
  // stateOfInput: an absent key inherits, and the empty array the config schema
  // materializes for one is the adapter's own "no answer here".
  if (stateOfInput(undefined) !== 'inherit' || stateOfInput({}) !== 'inherit') throw new Error('stateOfInput: absent input inherits')
  if (stateOfInput({ input: [] }) !== 'text') throw new Error('stateOfInput: [] materializes as text-only')
  if (stateOfInput({ input: ['text'] }) !== 'text') throw new Error('stateOfInput: [text] is text-only')
  if (stateOfInput({ input: ['text', 'image'] }) !== 'image') throw new Error('stateOfInput: an image member claims images')
  if (stateOfInput({ input: ['image'] }) !== 'image') throw new Error('stateOfInput: image-only claims images')
  console.log('pure helpers OK: stateOf/stateOfInput/levelsToConfig/validState/withLevel/withWire/withInput/applyDrafts/canonical')
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
// The composition layer the Host resolved over: pro and astra declare no
// `input` (the config schema materializes `[]`, the adapter's "no answer
// here"), flash declares images, and the catalog case carries one too.
const composedModels = [
  {
    id: 'deepseek-v4-pro',
    name: 'deepseek-v4-pro',
    input: [],
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
  },
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', input: ['text', 'image'], reasoningEfforts: false },
  { id: 'gpt-6-astra', name: 'gpt-6-astra', contextWindow: 922000, input: [] },
]
// The raw user layer as stored: the same three models, and no `input` on the
// two that inherit.
const userModels = [
  {
    id: 'deepseek-v4-pro',
    name: 'deepseek-v4-pro',
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
  },
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', input: ['text', 'image'], reasoningEfforts: false },
  { id: 'gpt-6-astra', name: 'gpt-6-astra', contextWindow: 922000 },
]
const snapshot = {
  status: 'ready',
  value: { providers: { [route]: { apiKeyEnv: 'TAIKOO_CGH_API_KEY', models: JSON.parse(JSON.stringify(composedModels)) } } },
  user: { providers: { [route]: { apiKeyEnv: 'TAIKOO_CGH_API_KEY', models: JSON.parse(JSON.stringify(userModels)) } } },
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
/** Stand in for the Host: a fold of the user layer over the composition layer. */
const fold = () => {
  const written = snapshot.user.providers[route]?.models
  if (!Array.isArray(written)) return
  snapshot.value.providers[route].models = JSON.parse(JSON.stringify(written))
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
    fold()
  },
}

const clientCtx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dict) => { dictionaries.push({ ns, dict }) },
    bind,
  },
  configForms: {
    // Regression: 0.2.0-rc.2's settings service is `configForms`, whose entry
    // point is `get(entryId)` — the settings namespace of a Host plugin entry is
    // its loader entry id. It used to be `settingsScope.bind({ namespace })`;
    // declaring that retired name leaves the entry pending forever.
    get: (entryId) => { boundSpec = { entryId }; return fakeScope },
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
if (registered.locale !== 'modelCapabilities') throw new Error(`registration locale: ${registered.locale}`)
if (boundSpec === null || boundSpec.entryId !== 'llm-pi-ai') {
  throw new Error(`configForms.get mismatch: ${JSON.stringify(boundSpec)}`)
}
const face = registered.inject()
if (typeof face.scope?.mutate !== 'function' || typeof face.scope?.getSnapshot !== 'function') {
  throw new Error('injected face must expose the settings scope')
}
const dict = dictionaries.find((candidate) => candidate.ns === 'modelCapabilities')
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
const t = bind('modelCapabilities')
const rootHost = globalThis.document.createElement('div')
globalThis.document.body.appendChild(rootHost)
const root = createRoot(rootHost)
const render = async () => {
  await act(async () => {
    root.render(React.createElement(registered.component, { provider, configured: true, keyConfigured: true, t, ...face }))
  })
}
const click = (el) => { el.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true })) }
const rows = () => [...rootHost.querySelectorAll('.mc-model')]
const rowOf = (name) => rows().find((row) => row.querySelector('.mc-name').textContent === name)
const modelSwitch = (name) => rowOf(name).querySelector('.mc-row [role="switch"]')
const levels = (name) => rowOf(name).querySelectorAll('.mc-level')
const wireOf = (name, level) => {
  const levelRow = [...levels(name)].find((row) => row.querySelector('.mc-level-name').textContent === t('level.' + level))
  return levelRow.querySelector('.mc-wire')
}
const inputTabs = (name) => [...rowOf(name).querySelectorAll('.mc-cap [role="tab"]')]
const inputTab = (name, state) => inputTabs(name).find((tab) => tab.textContent === t('input.' + state))
const selectedInput = (name) => inputTabs(name).find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent
const saveButton = () => rootHost.querySelector('.mc-save')
const discardButton = () => rootHost.querySelector('.mc-discard')

const setNativeValue = (input, value) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, 'value')
  descriptor.set.call(input, value)
  input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }))
}
/** The last write's models array, as the Host received it. */
const lastWrite = () => mutations[mutations.length - 1][0].value

await render()
if (rows().length !== 3) throw new Error(`expected 3 model rows, got ${rows().length}`)
if (modelSwitch('deepseek-v4-pro').getAttribute('aria-checked') !== 'true') throw new Error('configured model must start on')
if (modelSwitch('deepseek-v4-flash').getAttribute('aria-checked') !== 'false') throw new Error('disabled model must start off')
if (rowOf('deepseek-v4-flash').querySelector('.mc-state').textContent !== t('stateOff')) throw new Error('disabled state label wrong')
if (rowOf('gpt-6-astra').querySelector('.mc-state').textContent !== t('stateInherit')) throw new Error('inherit state label wrong')
// The image half reads the RAW layer: pro and astra declare nothing (their
// composed `[]` is the schema's materialization) while flash declares images.
if (selectedInput('deepseek-v4-pro') !== t('input.inherit')) throw new Error(`pro must read as inherited, got ${selectedInput('deepseek-v4-pro')}`)
if (selectedInput('gpt-6-astra') !== t('input.inherit')) throw new Error(`astra must read as inherited, got ${selectedInput('gpt-6-astra')}`)
if (selectedInput('deepseek-v4-flash') !== t('input.image')) throw new Error(`flash must read as declared images, got ${selectedInput('deepseek-v4-flash')}`)
if (inputTabs('deepseek-v4-pro').length !== 3) throw new Error('the image control must offer all three states')
if (saveButton().disabled !== true) throw new Error('save must start disabled (clean draft)')
console.log('render OK: three models, thinking state label + inherited/declared image state both read correctly')

// switch a model on: the level editor opens with the default level set
await act(async () => { click(modelSwitch('deepseek-v4-flash')) })
if (modelSwitch('deepseek-v4-flash').getAttribute('aria-checked') !== 'true') throw new Error('toggle must stage the switch on')
const flashLevels = levels('deepseek-v4-flash')
if (flashLevels.length !== 7) throw new Error(`level rows: ${flashLevels.length}`)
const checkedLevels = [...flashLevels]
  .filter((row) => row.querySelector('[role="switch"]').getAttribute('aria-checked') === 'true')
  .map((row) => row.querySelector('.mc-level-name').textContent)
if (JSON.stringify(checkedLevels) !== JSON.stringify(['关闭', '低', '中', '高', '最高'])) {
  throw new Error(`default levels wrong: ${JSON.stringify(checkedLevels)}`)
}
if (saveButton().disabled !== false) throw new Error('save must enable on a dirty draft')
console.log('render OK: staged switch opens the default level set')

// save -> one path op writing the whole models array with the new reasoningEfforts
await act(async () => { click(saveButton()) })
if (mutations.length !== 1) throw new Error(`expected 1 mutation, got ${mutations.length}`)
const op = mutations[0][0]
if (op.op !== 'set' || JSON.stringify(op.path) !== JSON.stringify(['providers', route, 'models'])) {
  throw new Error(`op shape: ${JSON.stringify(op)}`)
}
const written = lastWrite().find((model) => model.id === 'deepseek-v4-flash')
if (JSON.stringify(written.reasoningEfforts) !== JSON.stringify({ off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' })) {
  throw new Error(`written reasoningEfforts: ${JSON.stringify(written.reasoningEfforts)}`)
}
if (lastWrite().find((model) => model.id === 'deepseek-v4-pro').reasoningEfforts.medium !== 'medium') {
  throw new Error('untouched models must carry their stored value')
}
// An untouched model keeps whatever the composed snapshot held: the empty list
// the config schema materializes for an absent `input` (the adapter reads it as
// the same "no answer here" as an absent key) — never an invented declaration.
const writtenPro = lastWrite().find((model) => model.id === 'deepseek-v4-pro')
if (writtenPro.input !== undefined && writtenPro.input.length !== 0) {
  throw new Error(`an inherited image state must not become a declaration: ${JSON.stringify(writtenPro.input)}`)
}
if (JSON.stringify(writtenPro.input) !== JSON.stringify([])) {
  throw new Error(`the composed materialization must pass through untouched: ${JSON.stringify(writtenPro.input)}`)
}
if (rootHost.querySelector('.mc-error') !== null) throw new Error('landed write must not surface an error')
if (saveButton().disabled !== true) throw new Error('drafts must reset after a landed write')
console.log('save OK: one models-array path op, untouched models pass through undeclared')

// wire values: switch astra on, edit the low wire, save -> the edited value rides the op
await act(async () => { click(modelSwitch('gpt-6-astra')) })
// Every level — `off` included — renders a wire input now: pi-ai keeps a
// declared off value (e.g. `none`) in the map for dispatch.
const offInput = wireOf('gpt-6-astra', 'off')
if (offInput === null) throw new Error('the off row must render a wire input, not a fixed note')
if (offInput.value !== '' || offInput.placeholder !== t('offNote')) {
  throw new Error(`off input must start empty with the "sends nothing" placeholder: value=${JSON.stringify(offInput.value)} placeholder=${JSON.stringify(offInput.placeholder)}`)
}
await act(async () => { setNativeValue(wireOf('gpt-6-astra', 'low'), 'lowest') })
await act(async () => { setNativeValue(offInput, 'none') })
await act(async () => { click(saveButton()) })
const astra = lastWrite().find((model) => model.id === 'gpt-6-astra')
if (astra.reasoningEfforts.low !== 'lowest' || astra.reasoningEfforts.max !== 'max') {
  throw new Error(`wire edit not carried: ${JSON.stringify(astra.reasoningEfforts)}`)
}
if (astra.reasoningEfforts.off !== 'none') {
  throw new Error(`off wire edit must ride the saved map: ${JSON.stringify(astra.reasoningEfforts)}`)
}
console.log('wire OK: edited wire values (incl. off) ride the saved map')

// clearing the off input stages null (pi-ai's "supported, send nothing")
// A landed save collapses the editor, so re-expand the row first.
await act(async () => { click(rowOf('gpt-6-astra').querySelector('.mc-expand')) })
await act(async () => { setNativeValue(wireOf('gpt-6-astra', 'off'), '') })
await act(async () => { click(saveButton()) })
const offCleared = lastWrite().find((model) => model.id === 'gpt-6-astra')
if (offCleared.reasoningEfforts.off !== null) {
  throw new Error(`cleared off input must write null: ${JSON.stringify(offCleared.reasoningEfforts)}`)
}
console.log('off OK: off edits round-trip (value rides, clearing writes null)')

// --- the image half ------------------------------------------------------------
// Declaring images on an inheriting model: the key appears with both modalities.
await act(async () => { click(inputTab('gpt-6-astra', 'image')) })
if (selectedInput('gpt-6-astra') !== t('input.image')) throw new Error('clicking the image segment must select it')
if (saveButton().disabled !== false) throw new Error('an image change alone must dirty the draft')
await act(async () => { click(saveButton()) })
const astraImage = lastWrite().find((model) => model.id === 'gpt-6-astra')
if (JSON.stringify(astraImage.input) !== JSON.stringify(['text', 'image'])) {
  throw new Error(`declared image input must write both modalities: ${JSON.stringify(astraImage.input)}`)
}
// The click did not disturb the other capability on the same row.
if (astraImage.reasoningEfforts.low !== 'lowest' || astraImage.reasoningEfforts.off !== null) {
  throw new Error(`the image write must preserve the thinking half: ${JSON.stringify(astraImage.reasoningEfforts)}`)
}
console.log('image OK: an inherited model declares images, preserving its thinking half')

// Back to inherit: the declaration is REMOVED, not stored as the empty list the
// catalog would then be pinned to. The control refuses to re-report the state
// already selected (mirroring the shipped tablist), so this case starts by
// putting the declaration back on.
await act(async () => { click(inputTab('gpt-6-astra', 'image')) })
await act(async () => { click(saveButton()) })
if (JSON.stringify(lastWrite().find((model) => model.id === 'gpt-6-astra').input) !== JSON.stringify(['text', 'image'])) {
  throw new Error('the inherit case needs a stored declaration to clear')
}
await act(async () => { click(inputTab('gpt-6-astra', 'inherit')) })
if (saveButton().disabled !== false) throw new Error('clearing the declaration must dirty the draft')
await act(async () => { click(saveButton()) })
const astraInherited = lastWrite().find((model) => model.id === 'gpt-6-astra')
if ('input' in astraInherited) {
  throw new Error(`returning to inherit must remove the key: ${JSON.stringify(astraInherited)}`)
}
if ('input' in fakeScope.snapshot.user.providers[route].models.find((model) => model.id === 'gpt-6-astra')) {
  throw new Error('the stored profile must drop the key, not store the empty list')
}
if (selectedInput('gpt-6-astra') !== t('input.inherit')) throw new Error('the card must read the removed key as inherited again')
console.log('inherit OK: the declaration round-trips away instead of pinning an empty list')

// A declared text-only model: the correction direction, and the write is a claim.
await act(async () => { click(inputTab('deepseek-v4-flash', 'text')) })
await act(async () => { click(saveButton()) })
const flashText = lastWrite().find((model) => model.id === 'deepseek-v4-flash')
if (JSON.stringify(flashText.input) !== JSON.stringify(['text'])) {
  throw new Error(`text-only correction must write ["text"]: ${JSON.stringify(flashText.input)}`)
}
if (selectedInput('deepseek-v4-flash') !== t('input.text')) throw new Error('the card must read the correction back')
console.log('text-only OK: a declared model corrects to ["text"]')

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
const errorLine = rootHost.querySelector('.mc-error')
if (errorLine === null || errorLine.textContent !== t('saveFailed')) {
  throw new Error(`refused write must surface the failure: ${errorLine?.textContent}`)
}
// Discard is still the way out of a preserved draft.
await act(async () => { click(discardButton()) })
if (modelSwitch('gpt-6-astra').getAttribute('aria-checked') !== storedBefore) {
  throw new Error('discard must still restore the stored state after a refusal')
}
if (rootHost.querySelector('.mc-error') !== null) throw new Error('discard must clear the surfaced failure')
refuseWrites = false
console.log('refusal OK: failure surfaced, draft kept for retry, discard still restores the stored state')

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
