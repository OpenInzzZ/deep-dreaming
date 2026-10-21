/**
 * Contract check for the mcp-servers browser half.
 *
 * Loads the exact file the shell will execute through a minimal DOM shim, then
 * applies it against a mock ctx. What this pins down:
 *
 *  1. the module handoff id and the declared service list — a wrong service name
 *     leaves the whole half pending and nothing renders;
 *  2. the registration lands on the shipped `settings.section` seat with the
 *     entry id as its namespace key (`mcp-servers`), so the page edits the same
 *     document the Host serves;
 *  3. every copy key exists in BOTH dictionaries (a missing key renders the raw
 *     key in the UI);
 *  4. the pure list-editing helpers: validation, the blank-timeout rule, and the
 *     append/replace/remove operations that become `mutate` ops;
 *  5. the data path stays the shared settings form — no private fetch channel
 *     (AGENTS.md: the `/api` channel belongs to the Typert gateway, and
 *     `connection.rpc.handle` cannot work for a plugin outside its package).
 *
 * Run from the repo root:
 *   node patches/mcp-servers/tests/client-contract.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadDomDeps } from '../../../scripts/test-deps.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const patchDir = join(here, '..')
const clientPath = join(patchDir, 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-client-mcp-servers'

const domDeps = loadDomDeps(import.meta.url)
const JSDOM = domDeps.JSDOM
if (!domDeps.available) console.warn(`SKIP DOM checks: ${domDeps.hint}`)

const source = readFileSync(clientPath, 'utf8')

// --- load the bundle exactly like the shell kernel does ----------------------
let handoff = null
if (JSDOM !== null) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:19387/' })
  globalThis.window = dom.window
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (!(key in globalThis)) globalThis[key] = dom.window[key]
  }
  dom.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
  new Function('window', 'document', source)(dom.window, dom.window.document)
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

// The factory needs the frozen module table; only seed words may appear.
// React and the primitives are replaced with RECORDING stubs: `jsx()` builds
// plain element objects, so the page can be walked without a renderer while
// every Switch/Input prop is still observable (this is what pins the prop
// names — DSH's Switch takes `onChange`/`label`, NOT shadcn's
// `onCheckedChange`/`aria-label`, and a wrong name silently does nothing).
const seen = { switches: [], inputs: [] }
const table = new Map()
const uiRequire = (name) => {
  if (table.has(name)) return table.get(name)
  throw new Error(`the client half required '${name}', which is not a seed word of the module table`)
}
uiRequire.add = (name, value) => table.set(name, value)
uiRequire.add('react', { useState: (init) => [init, () => {}], useSyncExternalStore: (_sub, get) => get() })
uiRequire.add('react/jsx-runtime', { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) })
const SwitchStub = (props) => { seen.switches.push(props); return null }
const InputStub = (props) => { seen.inputs.push(props); return null }
uiRequire.add('@deepseek-ai/dsh-client-ui-primitives', { Switch: SwitchStub, Input: InputStub })

const exported = handoff.factory(uiRequire)

// --- 1. the service list -----------------------------------------------------
assert.deepEqual(exported.inject, ['slots', 'locale', 'configForms'],
  'the page needs the slot table, the locale face, and the shared config forms — nothing else')
assert.equal(typeof exported.apply, 'function')

// --- the mock settings form the page edits ----------------------------------
const serverA = { serverName: 'idea', url: 'http://127.0.0.1:64342/stream', enabled: true }
const mutateCalls = []
const scope = {
  id: 'mcp-servers',
  getSnapshot: () => ({ status: 'ready', value: { servers: [serverA] }, revision: 7 }),
  subscribe: () => () => {},
  mutate: async (ops, revision) => { mutateCalls.push({ ops, revision }); return true },
}

// --- 2. the registration ----------------------------------------------------
const registered = []
const dictionaries = []
const effects = []
let boundNamespace = null
const ctx = {
  effect: (fn, label) => { effects.push(label); const disposer = fn(); if (typeof disposer === 'function') disposer() },
  locale: {
    register: (ns, dict) => { dictionaries.push({ ns, dict }); return () => {} },
    bind: (ns) => { boundNamespace = ns; return (key, vars) => String(dictionaries[0]?.dict?.zh?.[key] ?? key).replace(/\{(\w+)\}/g, (_m, name) => vars?.[name] ?? '') },
  },
  configForms: { get: () => scope },
  slots: {
    inject: (name, run) => { const disposer = run(); return typeof disposer === 'function' ? disposer : () => {} },
    register: (options, component) => { registered.push({ options, component }); return () => {} },
  },
}
exported.apply(ctx)

assert.equal(registered.length, 1, 'exactly one settings section must be registered')
const { options } = registered[0]
assert.equal(options.name, 'settings.section', 'the page rides the shipped page-level seat')
assert.equal(options.id, exported.ENTRY_ID, 'the section id must be the loader entry id — a settings namespace IS the entry id')
assert.equal(options.id, 'mcp-servers')
assert.equal(options.locale, exported.NS)
assert.equal(typeof options.order, 'number')
assert.equal(typeof registered[0].component, 'function', 'the registration must carry a component')
assert.ok(String(options.label()).length > 0, 'the navigation label must resolve to real copy')
assert.equal(boundNamespace, exported.NS, 'the copy must be bound to this plugin’s own namespace')
const face = options.inject()
assert.equal(face.scope.id, 'mcp-servers', 'the page must edit the umbrella entry’s own namespace')

// --- 3. both dictionaries carry the same keys -------------------------------
assert.equal(dictionaries.length, 1)
const { dict } = dictionaries[0]
assert.ok(dict.zh && dict.en, 'zh and en dictionaries must both be registered')
const zhKeys = Object.keys(dict.zh).sort()
const enKeys = Object.keys(dict.en).sort()
assert.deepEqual(zhKeys, enKeys, 'a key missing from one language renders the raw key')
assert.ok(zhKeys.every((key) => String(dict.zh[key]).trim() !== '' && String(dict.en[key]).trim() !== ''))
for (const key of ['nav', 'title', 'add', 'edit', 'remove', 'save', 'enabled', 'headers', 'headersHint', 'headersEmpty', 'headerAdd', 'headerName', 'headerValue', 'headerNamePlaceholder', 'headerValuePlaceholder', 'headerRemove', 'errorName', 'errorDuplicate', 'errorUrl', 'errorHeaderName', 'errorHeaderValue', 'errorHeaderDuplicate', 'errorTimeout']) {
  assert.ok(zhKeys.includes(key), `the page needs the copy key '${key}'`)
}

// --- 4. the list-editing helpers --------------------------------------------
const servers = [
  { serverName: 'idea', url: 'http://127.0.0.1:64342/stream' },
  { serverName: 'dbx', url: 'http://127.0.0.1:7000/mcp', enabled: false },
]
assert.deepEqual(exported.serversOf(undefined), [], 'a namespace that never loaded reads as an empty list')
assert.deepEqual(exported.serversOf({ servers }), servers)

const ok = { serverName: 'new-one', url: 'https://example.com/mcp', headers: [], toolCallTimeoutMs: '' }
assert.equal(exported.validateDraft(ok, servers, -1), null, 'a fresh, unique, http endpoint must pass')
assert.equal(exported.validateDraft({ ...ok, serverName: 'bad name!' }, servers, -1), 'errorName')
assert.equal(exported.validateDraft({ ...ok, serverName: 'idea' }, servers, -1), 'errorDuplicate',
  'serverName is reserved globally by the official client, so the UI must refuse it before saving')
assert.equal(exported.validateDraft({ ...ok, serverName: 'idea' }, servers, 0), null, 'editing a row must not collide with itself')
assert.equal(exported.validateDraft({ ...ok, url: 'ftp://example.com' }, servers, -1), 'errorUrl')
assert.equal(exported.validateDraft({ ...ok, toolCallTimeoutMs: '500' }, servers, -1), 'errorTimeout')

// Request headers are edited as key/value rows; the stored shape stays the plain
// map the Host schema expects. An authenticated server (DBX) needs this, and a
// wrong row here would otherwise become a silent 401 / connect failure.
const row = (name, value = '') => ({ name, value })
assert.equal(exported.validateDraft({ ...ok, headers: [] }, servers, -1), null, 'no rows means no extra headers')
assert.equal(exported.validateDraft({ ...ok, headers: [row('', '')] }, servers, -1), null,
  'a blank row means "not filled in yet", not an error')
assert.equal(exported.validateDraft({ ...ok, headers: [row('X-Token')] }, servers, -1), null,
  'a named header with an empty value is still legal HTTP and must not be refused')
assert.equal(exported.validateDraft({ ...ok, headers: [row('Bad Name', 'x')] }, servers, -1), 'errorHeaderName')
assert.equal(exported.validateDraft({ ...ok, headers: [row('', 'orphan value')] }, servers, -1), 'errorHeaderName',
  'a value with no name has nowhere to go')
assert.equal(exported.validateDraft({ ...ok, headers: [row('X-Token', 'a\nb')] }, servers, -1), 'errorHeaderValue',
  'fetch refuses a header value containing a line break')
assert.equal(exported.validateDraft({ ...ok, headers: [row('Authorization', 'Bearer x'), row('authorization', 'Bearer y')] }, servers, -1),
  'errorHeaderDuplicate', 'header names are case-insensitive, so two rows differing only in case must be refused')
assert.equal(exported.validateDraft({ ...ok, headers: [row('Authorization', 'Bearer <token>')] }, servers, -1), null)

assert.deepEqual(exported.validateHeaders([row('X', '1'), row('x', '2')]), { key: 'errorHeaderDuplicate', at: 1 },
  'the second duplicate is the row to paint')
assert.deepEqual(exported.validateHeaders([row('', ''), row('Bad Name', 'x')]), { key: 'errorHeaderName', at: 1 },
  'blank rows are skipped when locating the offending row')
assert.equal(exported.validateHeaders([row('X', '1')]), null)

const editedRows = [row('Authorization', 'Bearer x'), row('', ''), row('X-Apifox-Api-Version', '2025-09-01')]
assert.deepEqual(exported.headersOf(editedRows),
  { Authorization: 'Bearer x', 'X-Apifox-Api-Version': '2025-09-01' }, 'blank rows are dropped on save')
assert.equal(exported.headersOf([row('', '')]), undefined,
  'an untouched editor omits the key, so the Host default {} wins — never write {}')
assert.deepEqual(exported.headerRowsOf({ Authorization: 'Bearer x' }), [row('Authorization', 'Bearer x')])
assert.deepEqual(exported.headerRowsOf({}), [row('', '')], 'a server without headers opens on one usable row')
assert.deepEqual(exported.headerRowsOf(undefined), [row('', '')])

// A blank timeout is OMITTED, not sent as '' or 0: the Host default must win.
// Blank headers are likewise omitted, never written as an empty object.
assert.deepEqual(exported.serverOf({ ...ok, toolCallTimeoutMs: '  ' }), {
  serverName: 'new-one', url: 'https://example.com/mcp', failOnStartupError: false, enabled: true,
})
assert.equal(exported.serverOf({ ...ok, toolCallTimeoutMs: '30000' }).toolCallTimeoutMs, 30000)
assert.deepEqual(exported.serverOf({ ...ok, headers: [row('Authorization', 'Bearer x')] }).headers, { Authorization: 'Bearer x' })
assert.equal(exported.serverOf({ ...ok, headers: [] }).headers, undefined, 'no rows must be omitted, not sent as {}')
assert.equal(exported.serverOf({ ...ok, headers: [row('', '')] }).headers, undefined, 'a blank row must not become an empty-name header')

// The edit form round-trips stored headers back into rows.
assert.deepEqual(exported.draftOf({ ...ok, headers: { Authorization: 'Bearer x' } }).headers, [row('Authorization', 'Bearer x')])
assert.deepEqual(exported.draftOf({ ...ok, headers: {} }).headers, [row('', '')], 'an empty map pre-fills as one blank row')
assert.deepEqual(exported.emptyDraft().headers, [row('', '')])

assert.deepEqual(exported.replaceAt(servers, 5, { serverName: 'appended' }).map((row) => row.serverName), ['idea', 'dbx', 'appended'], 'index out of range appends (that is how Add works)')
assert.deepEqual(exported.replaceAt(servers, 1, { serverName: 'replaced' }).map((row) => row.serverName), ['idea', 'replaced'])
assert.deepEqual(exported.removeAt(servers, 0).map((row) => row.serverName), ['dbx'])

// --- 5. the data path and the retired APIs ----------------------------------
assert.ok(!source.includes('fetch('), 'the page must not open a private channel; the shared settings form owns the transport')
assert.ok(!source.includes('rpc.call'), 'connection.rpc.call cannot work for a plugin outside its package')
assert.ok(!source.includes('settingsScope'), 'the client service is configForms since 0.1.7-alpha.1')
assert.ok(source.includes('data-plugin-css'), 'the stylesheet must carry the loader cleanup attributes')
// Width must reach the primitive itself: `.ms-control input` does not style it.
const inputBlocks = source.match(/jsx\(Input, \{[^}]*\}/gu) ?? []
assert.ok(inputBlocks.length >= 5, `expected the editor inputs (name, url, header name, header value, timeout), got ${inputBlocks.length}`)
for (const block of inputBlocks) {
  assert.ok(/className: 'ms-input'/u.test(block), `every Input needs the width class: ${block.slice(0, 60)}…`)
}
assert.ok(!source.includes('JSON.parse'), 'headers are edited as rows now; the page must not parse a JSON blob')
assert.ok(!source.includes('currentTarget'), 'read the field value from event.target.value, like the other patches')
assert.ok(source.includes('.ms-header-row{'), 'the header rows need their own layout rule')

// --- 6. the page really wires its controls ----------------------------------
// `jsx()` was stubbed into plain element objects, so the tree is walkable
// without a renderer and every primitive prop is observable.
function walk(node, into = []) {
  if (Array.isArray(node)) { for (const child of node) walk(child, into); return into }
  if (node && typeof node === 'object') {
    if (typeof node.type === 'function') into.push(node)
    if (node.props) walk(node.props.children, into)
  }
  return into
}
const t = (key, vars) => String(dictionaries[0].dict.zh[key] ?? key).replace(/\{(\w+)\}/g, (_m, name) => vars?.[name] ?? '')
const elements = walk(registered[0].component({ t, scope }))

const switches = elements.filter((el) => el.type === SwitchStub)
assert.ok(switches.length >= 1, 'the rendered page must carry at least the row switch')
for (const el of switches) {
  assert.equal(el.props.onCheckedChange, undefined,
    'DSH’s Switch fires onChange; onCheckedChange is not a prop here and would do nothing at all')
  assert.equal(typeof el.props.onChange, 'function', 'every switch must handle onChange')
  assert.ok(typeof el.props.label === 'string' && el.props.label.length > 0, 'the switch needs an accessible label')
}

// Toggling the row switch must write the whole list back through the form.
switches[0].props.onChange(false)
await new Promise((resolve) => setImmediate(resolve))
assert.equal(mutateCalls.length, 1, 'one click must produce exactly one write')
assert.deepEqual(mutateCalls[0].ops, [{ op: 'set', path: ['servers'], value: [{ ...serverA, enabled: false }] }],
  'the write must be a path op on the servers list, not a private channel')
assert.equal(mutateCalls[0].revision, 7, 'the write must fence on the revision the page read')

// --- 7. the header editor is a real key/value form, not a JSON blob ----------
// The page only mounts ServerForm after Add/Edit, and the useState stub cannot
// reach that state, so drive the form directly. `jsx()` was stubbed into plain
// elements and the form is hook-free, so expanding the function components by
// hand is a pure tree walk.
function renderTree(node, into = { elements: [], inputs: [], switches: [] }) {
  if (Array.isArray(node)) { for (const child of node) renderTree(child, into); return into }
  if (node === null || node === undefined || typeof node !== 'object') return into
  if (node.type === InputStub) { into.inputs.push(node.props); return into }
  if (node.type === SwitchStub) { into.switches.push(node.props); return into }
  if (typeof node.type === 'function') { renderTree(node.type(node.props), into); return into }
  if (typeof node.type === 'string') into.elements.push(node)
  if (node.props && node.props.children !== undefined) renderTree(node.props.children, into)
  return into
}

const baseDraft = {
  serverName: 'dbx', url: 'http://127.0.0.1:5225/mcp',
  headers: [row('Authorization', 'Bearer t0ken'), row('', '')],
  toolCallTimeoutMs: '', failOnStartupError: false, enabled: true, touched: false,
}
let nextDraft = null
const formView = renderTree(exported.ServerForm({
  t, draft: baseDraft, saving: false,
  onChange: (next) => { nextDraft = next }, onSubmit: () => {}, onCancel: () => {},
}))
assert.equal(formView.inputs.length, 7, 'the form must render name + url + timeout + two cells per header row')

const nameCell = formView.inputs.find((props) => props['aria-label'] === t('headerName'))
const valueCell = formView.inputs.find((props) => props['aria-label'] === t('headerValue'))
assert.ok(nameCell && valueCell, 'both header cells need an accessible name')
assert.equal(nameCell.value, 'Authorization')
assert.equal(valueCell.value, 'Bearer t0ken')
assert.equal(nameCell.className, 'ms-input', 'the cell must use the shared input styling')
assert.equal(nameCell.autoComplete, 'off', 'a token cell must not collect browser autofill')
assert.equal(nameCell.spellCheck, false, 'spell-check squiggles over a token are noise')
nameCell.onChange({ target: { value: 'X-Dbx-Token' } })
assert.deepEqual(nextDraft.headers, [row('X-Dbx-Token', 'Bearer t0ken'), row('', '')], 'editing one cell rewrites that row only')
assert.equal(nextDraft.touched, true, 'editing a header must unlock the field error, like the other inputs')

const addButton = formView.elements.find((el) => el.type === 'button' && el.props.children === t('headerAdd'))
assert.ok(addButton, 'the header editor needs an Add-header affordance')
addButton.props.onClick()
assert.equal(nextDraft.headers.length, 3)
assert.deepEqual(nextDraft.headers[2], { name: '', value: '' }, 'a new row starts empty and is ignored unless filled')

const removeButtons = formView.elements.filter((el) => el.type === 'button' && el.props['aria-label'] === t('headerRemove'))
assert.equal(removeButtons.length, 2, 'one remove button per header row')
removeButtons[0].props.onClick()
assert.deepEqual(nextDraft.headers, [row('', '')], 'removing a row drops exactly that row')

// An invalid draft paints the offending row, not just the field.
const dupDraft = {
  ...baseDraft, touched: true, errorKey: 'errorHeaderDuplicate',
  headers: [row('Authorization', 'Bearer x'), row('authorization', 'Bearer y')],
}
const badView = renderTree(exported.ServerForm({ t, draft: dupDraft, saving: false, onChange: () => {}, onSubmit: () => {}, onCancel: () => {} }))
const rowViews = badView.elements.filter((el) => typeof el.props.className === 'string' && el.props.className.startsWith('ms-header-row'))
assert.equal(rowViews.length, 2)
assert.ok(!rowViews[0].props.className.includes('ms-header-row-bad'), 'the first row is valid and must stay unmarked')
assert.ok(rowViews[1].props.className.includes('ms-header-row-bad'), 'the duplicate row is the one to paint')
const alerts = badView.elements.filter((el) => el.props.role === 'alert')
assert.ok(alerts.some((el) => el.props.children === t('errorHeaderDuplicate')), 'the header field must show the duplicate message')

// Regression: a failed save used to leave Save disabled for good, because the
// error key stays in the draft while the user fixes the offending field.
const blockedView = renderTree(exported.ServerForm({
  t, saving: false, onChange: () => {}, onSubmit: () => {}, onCancel: () => {},
  draft: { ...baseDraft, serverName: '', touched: true, errorKey: 'errorName' },
}))
const saveButton = blockedView.elements.find((el) => el.type === 'button' && el.props.children === t('save'))
assert.equal(saveButton.props.disabled, false, 'Save must stay clickable so a corrected draft can be retried')

if (JSDOM !== null) {
  const tags = globalThis.window.document.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`)
  assert.equal(tags.length, 1, `exactly one injected stylesheet for ${PLUGIN_ID}, got ${tags.length}`)
}

console.log(`client-contract OK: ${PLUGIN_ID}/client.js registers settings.section id=mcp-servers over its own namespace, ${zhKeys.length} copy keys in zh+en, list helpers validated, no private channel${JSDOM === null ? ' (DOM checks skipped)' : ''}`)
