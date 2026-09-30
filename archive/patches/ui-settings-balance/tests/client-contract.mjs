/**
 * Contract check for the ui-settings-balance browser half.
 *
 * Loads the exact deployed `client.js` the browser will execute through a
 * minimal DOM shim, asserts the module-table handoff, applies it against a mock
 * ctx, then renders the section with a stubbed host call. What it pins:
 *
 *  1. exactly ONE `settings.section` registration (id `balance`) — no leftover
 *     restart/shortcut/update controls;
 *  2. the locale dictionaries carry the SAME key set for both shipped locales
 *     (the locale service refuses an incomplete namespace);
 *  3. every host `status` renders as itself: `ready` shows the amounts,
 *     `signed-out` says so, `failed`/`unavailable` show the reason. A balance
 *     panel that renders "0" for a signed-out account is the failure mode this
 *     test exists to prevent.
 *
 * Rendering needs jsdom; without it the pure contract checks still run.
 *
 * Run from the repo root:
 *   node patches/ui-settings-balance/tests/client-contract.mjs
 */
import { loadDomDeps, createUiRequire } from '../../../scripts/test-deps.mjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const patchDir = join(here, '..')
const uiRequire = createUiRequire(import.meta.url)

const domDeps = loadDomDeps(import.meta.url)
const React = domDeps.React
const JSDOM = domDeps.JSDOM
if (!domDeps.available) console.warn(`SKIP DOM checks: ${domDeps.hint}`)

const clientPath = join(patchDir, 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-client-ui-settings-balance'

// --- load the bundle exactly like the shell kernel does ----------------------
let handoff = null
const bundleSource = readFileSync(clientPath, 'utf8')
if (JSDOM !== null) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1:19387/' })
  globalThis.window = dom.window
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (!(key in globalThis)) globalThis[key] = dom.window[key]
  }
  dom.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
  new Function('window', 'document', bundleSource)(dom.window, dom.window.document)
} else {
  const shimDocument = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, setAttribute: () => {}, appendChild: () => {}, textContent: '' }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
  }
  const shimWindow = { __ModuleLoader__: { load: (h) => { handoff = h } } }
  new Function('window', 'document', bundleSource)(shimWindow, shimDocument)
}
if (handoff === null) throw new Error('bundle never called __ModuleLoader__.load')
if (handoff.id !== PLUGIN_ID) throw new Error(`handoff id mismatch: ${handoff.id}`)

// --- module table: only seed words, primitives stubbed -----------------------
const icon = (props) => React.createElement('svg', { 'data-icon': true, ...props })
const requireTable = (spec) => {
  if (spec === 'react') return uiRequire('react')
  if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return { IconRefreshOutlineRegular: icon }
  }
  throw new Error(`client bundle must not require "${spec}"`)
}
const exports_ = handoff.factory(requireTable)

// --- exports contract --------------------------------------------------------
if (exports_.NS !== 'ui-settings-balance') throw new Error(`NS mismatch: ${exports_.NS}`)
if (!Array.isArray(exports_.inject) || exports_.inject.join(',') !== 'slots,locale') {
  throw new Error(`exports.inject mismatch: ${JSON.stringify(exports_.inject)}`)
}
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

// --- apply(): exactly one settings.section registration ----------------------
const registrations = []
const dictionaries = []
const styles = []
const clientCtx = {
  effect: (fn) => {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  locale: {
    register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} },
    bind: () => (key) => key,
  },
  slots: {
    inject: (_key, callback) => { registrations.push(callback()) },
    register: (options, component) => ({ ...options, component }),
  },
}
// Capture the style tag the bundle injects (its cleanup runs through effect()).
const realQuery = globalThis.document?.querySelector
exports_.apply(clientCtx)

const sections = registrations.filter((r) => r.name === 'settings.section')
if (sections.length !== 1) throw new Error(`expected exactly 1 settings.section registration, got ${sections.length}`)
const section = sections[0]
if (section.id !== 'balance') throw new Error(`section id mismatch: ${section.id}`)
if (typeof section.component !== 'function') throw new Error('the section must carry a component')
if (typeof section.inject !== 'function') throw new Error('the section must inject its host call')
console.log('apply OK: settings.section id=balance order=' + String(section.order))

if (dictionaries.length !== 1) throw new Error(`expected 1 dictionary registration, got ${dictionaries.length}`)
const dict = dictionaries[0].dicts
if (dict.zh === undefined || dict.en === undefined) throw new Error('both shipped locales are required')
const zhKeys = Object.keys(dict.zh).sort()
const enKeys = Object.keys(dict.en).sort()
if (zhKeys.join(',') !== enKeys.join(',')) {
  throw new Error(`locale key sets differ:\n  zh: ${zhKeys.join(',')}\n  en: ${enKeys.join(',')}`)
}
console.log('dictionaries OK:', String(zhKeys.length), 'keys, zh/en aligned')

if (JSDOM === null) {
  console.log('\nDOM render section SKIPPED (jsdom not installed)')
  console.log('ALL CONTRACT CHECKS PASSED (install jsdom to enable the render section)')
  process.exit(0)
}

// --- render the section (jsdom) ---------------------------------------------
const { act } = React
const { createRoot } = uiRequire('react-dom/client')
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** Render the section over a stubbed `fetch`, going through the real call path. */
async function renderWith(responder) {
  const injected = section.inject()
  if (typeof injected.balance !== 'function') throw new Error('the injected API must expose balance()')
  // Stub fetch rather than the injected function: the section must be exercised
  // through its REAL transport (envelope unwrapping included), which is where
  // "HTTP 200 with ok:false" used to be mistaken for success.
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    const outcome = await responder(calls.length)
    if (outcome instanceof Error) throw outcome
    const envelope = outcome !== undefined && outcome !== null && outcome.envelope !== undefined
      ? outcome.envelope
      : { ok: true, value: outcome }
    // `httpStatus` lets a case model "HTTP 200 carrying ok:false" explicitly,
    // which is the envelope failure path rather than a transport failure.
    const httpStatus = outcome?.httpStatus ?? (envelope.ok === true ? 200 : 500)
    return {
      ok: httpStatus >= 200 && httpStatus < 300,
      status: httpStatus,
      json: async () => envelope,
    }
  }
  const host = globalThis.document.createElement('div')
  const root = createRoot(host)
  const t = (key) => dict.zh[key]
  await act(async () => {
    root.render(React.createElement(section.component, { ...injected, t }))
  })
  return { host, calls, t }
}

// ready: both wallet kinds render their exact amounts
{
  const { host, calls } = await renderWith(async () => ({
    status: 'ready',
    wallets: [{ currency: 'CNY', balance: '123.45' }, { currency: 'USD', balance: '6.78' }],
    bonusWallets: [{ currency: 'CNY', balance: '10.00' }],
  }))
  if (calls.length !== 1) throw new Error(`the panel must read once on mount, saw ${calls.length}`)
  if (calls[0].url !== '/app/balance') throw new Error(`unexpected call target: ${calls[0].url}`)
  const text = host.textContent
  for (const expected of ['123.45', '6.78', '10.00']) {
    if (!text.includes(expected)) throw new Error(`ready panel must show ${expected}: ${text}`)
  }
  if (!text.includes(dict.zh.recharge) || !text.includes(dict.zh.bonus)) {
    throw new Error(`ready panel must label both wallet kinds: ${text}`)
  }
  const rows = host.querySelectorAll('.usb-wallet')
  if (rows.length !== 3) throw new Error(`expected 3 wallet rows, got ${rows.length}`)
  console.log('render OK: ready balance shows 3 wallet rows with exact amounts')
}

// signed-out: must say so, and must NOT render a number
{
  const { host } = await renderWith(async () => ({ status: 'signed-out' }))
  const text = host.textContent
  if (!text.includes(dict.zh.signedOut)) throw new Error(`signed-out panel must explain itself: ${text}`)
  if (host.querySelectorAll('.usb-wallet').length !== 0) throw new Error('signed-out panel must render no wallet rows')
  // The amounts live in dedicated elements; a signed-out panel must produce none.
  if (host.querySelectorAll('.usb-wallet-amount').length !== 0) {
    throw new Error(`signed-out panel must render no amount element: ${text}`)
  }
  console.log('render OK: signed-out panel explains itself and shows no amount')
}

// unavailable: the host has no account service
{
  const { host } = await renderWith(async () => ({ status: 'unavailable', reason: 'deepseekAccount 服务未挂载' }))
  if (!host.textContent.includes('deepseekAccount')) throw new Error(`unavailable panel must carry the reason: ${host.textContent}`)
  console.log('render OK: unavailable panel reports the missing service')
}

// failed: the reason is surfaced
{
  const { host } = await renderWith(async () => ({ status: 'failed', reason: 'HTTP 401' }))
  if (!host.textContent.includes('HTTP 401')) throw new Error(`failed panel must carry the reason: ${host.textContent}`)
  console.log('render OK: failed panel surfaces the host reason')
}

// transport rejection: the panel shows an error instead of throwing
{
  const { host } = await renderWith(async () => { throw new Error('rpc balance failed: HTTP 500') })
  if (!host.textContent.includes('HTTP 500')) throw new Error(`transport error must render: ${host.textContent}`)
  console.log('render OK: transport rejection renders the error line')
}

// HTTP 200 with ok:false must NOT be treated as success. This is the envelope
// path: the host answered, and answering "not ok" is not an HTTP failure.
{
  const { host } = await renderWith(async () => ({
    envelope: { ok: false, error: { code: 'internal', message: 'boom', details: {} } },
    httpStatus: 200,
  }))
  if (!host.textContent.includes('boom')) throw new Error(`an ok:false envelope must render its message: ${host.textContent}`)
  if (host.querySelectorAll('.usb-wallet-amount').length !== 0) throw new Error('an ok:false envelope must not render amounts')
  console.log('render OK: an ok:false envelope renders the error, never a balance')
}

// refresh button re-reads through the transport
{
  const { host } = await renderWith(async (nth) => ({
    status: 'ready',
    wallets: [{ currency: 'CNY', balance: nth === 1 ? '1.00' : '2.00' }],
    bonusWallets: [],
  }))
  const button = host.querySelector('.usb-refresh')
  if (button === null) throw new Error('the refresh button must exist')
  await act(async () => { button.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true })) })
  if (!host.textContent.includes('2.00')) throw new Error(`refresh must render the new amount: ${host.textContent}`)
  console.log('render OK: refresh button re-reads and repaints the new amount')
}

console.log('\nALL CLIENT CONTRACT CHECKS PASSED')
process.exit(0)
