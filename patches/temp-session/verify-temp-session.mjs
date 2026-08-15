/**
 * Functional harness for the user-level temp-session patch.
 *
 * Host half: imports the real `lib/index.js`, applies it to a mock Cordis
 * context, and asserts the `/temp-session` RPC channel registration plus the
 * `ensure` endpoint: idempotent workspace creation over a real temp directory
 * (first call creates, second call reuses the same id), bad endpoint
 * rejection, and error wrapping. Also guards the P0 regression: `apply` must
 * NOT return a thenable (Cordis treats a returned Fiber as an invalid Effect).
 *
 * Client half: loads the exact deployed `lib/client.js` the browser will
 * execute, feeds it a module table stubbed with the real platform words
 * (react, react/jsx-runtime, ui-primitives), asserts the registration
 * contract (sidebar.footer.action entry + dictionaries + inject face), then —
 * when jsdom is available — renders the action and exercises the click flow
 * (RPC ensure -> refresh -> startSession) and the error path. Without jsdom
 * the DOM sections are skipped with a notice.
 */
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? ''
const profileAnchor = join(userProfile, '.dsh', 'profiles', 'web', 'package.json')
const uiRequire = createRequire(profileAnchor)
const React = uiRequire('react')

// Optional DOM deps (jsdom) may be absent without a harness checkout; the
// client DOM sections are skipped then, host + contract checks still run.
let JSDOM = null
try {
  JSDOM = uiRequire('jsdom').JSDOM
} catch {
  try { JSDOM = createRequire('D:/GitHub/deepseek-harness/package.json')('jsdom').JSDOM } catch { /* skip */ }
}
const DOM_AVAILABLE = JSDOM !== null

const hostPath = join(here, 'lib', 'index.js')
const clientPath = join(here, 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-client-ui-temp-session'

// --- host half: registration + ensure endpoint --------------------------------
const host = await import(pathToFileURL(hostPath).href)

// ensureTempWorkspace over a real temp dir with a stub registry
{
  const tempRoot = mkdtempSync(join(tmpdir(), 'temp-session-verify-'))
  const dir = join(tempRoot, 'tmp-workspaces')
  const workspaces = []
  const fakeRegistry = {
    resolveByPath: async (path) => workspaces.find((w) => w.path === path),
    create: async (path, title) => {
      const id = 'ws-' + (workspaces.length + 1)
      const ws = { id, path, title }
      workspaces.push(ws)
      return ws
    },
  }
  const first = await host.ensureTempWorkspace({ workspaceRegistry: fakeRegistry }, { dir, title: '临时会话' })
  if (first.created !== true) throw new Error(`first ensure must create: ${JSON.stringify(first)}`)
  if (first.path !== dir || first.title !== '临时会话' || !/^ws-\d+$/.test(first.workspaceId)) {
    throw new Error(`first ensure shape: ${JSON.stringify(first)}`)
  }
  if (!existsSync(dir)) throw new Error(`ensure must mkdir ${dir}`)
  const second = await host.ensureTempWorkspace({ workspaceRegistry: fakeRegistry }, { dir, title: '临时会话' })
  if (second.created !== false || second.workspaceId !== first.workspaceId) {
    throw new Error(`second ensure must reuse: ${JSON.stringify(second)}`)
  }
  const custom = await host.ensureTempWorkspace(
    { workspaceRegistry: fakeRegistry },
    { dir: join(tempRoot, 'other'), title: 'Scratch' },
  )
  if (custom.created !== true || custom.title !== 'Scratch') throw new Error(`custom dir: ${JSON.stringify(custom)}`)
  console.log('host ensure OK: idempotent create/reuse over real temp dirs + config title')
}

// apply: RPC channel + endpoint validation (no real workspace registry needed)
let handled = null
let innerCtx = null
const hostCtx = {
  inject: (services, callback) => {
    if (services.join(',') === 'connection,workspaceRegistry') {
      innerCtx = {
        connection: {
          rpc: {
            handle: (channel, handler, options) => {
              handled = { channel, handler, options }
              return () => {}
            },
          },
        },
        workspaceRegistry: {
          resolveByPath: async (path) => undefined,
          create: async (path, title) => ({ id: 'ws-rpc', path, title }),
        },
        effect: (fn) => fn(),
        fiber: { state: 0 },
      }
      return callback(innerCtx)
    }
    return undefined
  },
  effect: (fn) => fn(),
}
const ret = host.apply(hostCtx, { dir: join(tmpdir(), 'temp-session-verify-apply'), title: '临时会话' })
// P0 regression guard: returning the ctx.inject() thenable Fiber from apply
// makes Cordis throw TypeError('Invalid effect') and fail the plugin.
if (ret !== undefined && typeof ret.then === 'function') {
  throw new Error('P0 regression: apply returned a thenable (Invalid effect)')
}
if (handled === null || handled.channel !== '/temp-session') {
  throw new Error(`host channel mismatch: ${JSON.stringify(handled)}`)
}
if (handled.options.authority !== 'loopback') throw new Error(`host authority mismatch: ${handled.options.authority}`)

const okEnsure = await handled.handler('ensure', { args: {} })
if (!okEnsure.ok || okEnsure.value.workspaceId !== 'ws-rpc' || okEnsure.value.created !== true) {
  throw new Error(`ensure endpoint: ${JSON.stringify(okEnsure)}`)
}
const badEndpoint = await handled.handler('nope', {})
if (badEndpoint.ok !== false || badEndpoint.error.code !== 'bad-request') {
  throw new Error(`unknown endpoint must be rejected: ${JSON.stringify(badEndpoint)}`)
}
console.log('host OK: /temp-session channel (loopback) + ensure endpoint + bad-request guard')

// --- client half: bundle + contract checks (DOM shim when jsdom is absent) ---
let dom = null
let handoff = null
const bundleSource = readFileSync(clientPath, 'utf8')
if (DOM_AVAILABLE) {
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

const icon = (props) => React.createElement('svg', { ...props, 'data-icon': true })
const requireTable = (spec) => {
  if (spec === 'react') return uiRequire('react')
  if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return { IconSparkle16: icon }
  }
  throw new Error(`unexpected module-table word: ${spec}`)
}
const exports_ = handoff.factory(requireTable)

if (typeof exports_.apply !== 'function') throw new Error('exports.apply missing')
if (!Array.isArray(exports_.inject)) throw new Error('exports.inject missing')
if (exports_.NS !== 'sidebar.tempSession') throw new Error(`NS mismatch: ${exports_.NS}`)
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

let registrations = []
let dicts = []
let rpcLog = []
let refreshCount = 0
let starts = []
let ensureResult = { ok: true, value: { workspaceId: 'ws-temp', path: 'C:/Users/x/.dsh/tmp-workspaces', title: '临时会话', created: true } }
const clientCtx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dict) => { dicts.push({ ns, dict }) },
    bind: () => (key) => 't:' + key,
  },
  connection: {
    rpc: {
      call: async (channel, endpoint, payload) => {
        rpcLog.push({ channel, endpoint, payload })
        if (endpoint === 'ensure') return ensureResult
        return { ok: false, error: { code: 'bad-request', message: 'unexpected', details: {} } }
      },
    },
  },
  workspaces: {
    refresh: async () => { refreshCount += 1 },
    startSession: (workspaceId) => { starts.push(workspaceId) },
  },
  slots: {
    inject: (_key, callback) => { registrations.push(callback()) },
    register: (options, component) => ({ ...options, component }),
  },
}
exports_.apply(clientCtx)

const actionReg = registrations.find((r) => r.name === 'sidebar.footer.action')
if (actionReg === undefined) throw new Error('sidebar.footer.action never registered')
if (actionReg.id !== 'temp-session' || actionReg.order !== -10) {
  throw new Error(`action options mismatch: ${JSON.stringify(actionReg)}`)
}
if (typeof actionReg.inject().startTempSession !== 'function') {
  throw new Error('action inject must expose startTempSession')
}
const dict = dicts.find((d) => d.ns === 'sidebar.tempSession')
if (dict === undefined) throw new Error('dictionaries not registered')
const zhKeys = Object.keys(dict.dict.zh)
const enKeys = Object.keys(dict.dict.en)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  throw new Error(`zh/en key mismatch:\nzh: ${zhKeys}\nen: ${enKeys}`)
}
console.log(`apply contract OK: sidebar.footer.action id=temp-session order=-10 | dict keys = ${zhKeys.length}`)

if (!DOM_AVAILABLE) {
  console.log('\nclient DOM sections SKIPPED (jsdom not installed)')
  console.log('ALL NON-DOM HARNESS CHECKS PASSED (install jsdom to enable the DOM sections)')
  process.exit(0)
}

// --- render + interact (react-dom in jsdom) ------------------------------------
const { act } = React
const { createRoot } = uiRequire('react-dom/client')

const fireClick = (el) => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const en = dict.dict.en
const clientInjected = actionReg.inject('session-1')
const tWithParams = (key) => en[key]

const rootHost = dom.window.document.createElement('div')
const root = createRoot(rootHost)
await act(async () => {
  root.render(React.createElement(actionReg.component, {
    wide: true,
    startTempSession: clientInjected.startTempSession,
    t: tWithParams,
  }))
})

const btn = rootHost.querySelector('.ts-btn')
if (btn === null) throw new Error('action button missing')
if (btn.getAttribute('aria-label') !== en.title) throw new Error(`aria-label: ${btn.getAttribute('aria-label')}`)
if (btn.textContent !== en.label) throw new Error(`wide label: ${btn.textContent}`)
console.log('render OK: wide row shows icon + label, aria-label set')

// click -> /temp-session ensure -> workspaces.refresh -> startSession
await act(async () => { fireClick(btn) })
const ensureCall = rpcLog.find((c) => c.endpoint === 'ensure')
if (ensureCall === undefined || ensureCall.channel !== '/temp-session') {
  throw new Error(`ensure rpc target: ${JSON.stringify(ensureCall)}`)
}
if (JSON.stringify(ensureCall.payload.args) !== '{}') throw new Error(`ensure args: ${JSON.stringify(ensureCall.payload)}`)
if (refreshCount !== 1) throw new Error(`refresh must run once, got ${refreshCount}`)
if (starts.length !== 1 || starts[0] !== 'ws-temp') throw new Error(`startSession target: ${JSON.stringify(starts)}`)
console.log('click flow OK: ensure -> refresh -> startSession(ws-temp)')

// error path: ensure failure surfaces as the error line, button back to label
ensureResult = { ok: false, error: { code: 'temp-workspace-failed', message: 'boom', details: {} } }
rpcLog = []
await act(async () => { fireClick(rootHost.querySelector('.ts-btn')) })
if (!rootHost.querySelector('.ts-error')) throw new Error('error line missing')
if (rootHost.querySelector('.ts-btn').textContent !== en.label) throw new Error('button must return to label after failure')
console.log('error path OK: failure shows error line, button re-enabled')

// rail rendering: icon only, no label
const railHost = dom.window.document.createElement('div')
const railRoot = createRoot(railHost)
await act(async () => {
  railRoot.render(React.createElement(actionReg.component, {
    wide: false,
    startTempSession: clientInjected.startTempSession,
    t: tWithParams,
  }))
})
const railBtn = railHost.querySelector('.ts-btn')
if (railBtn === null || !railBtn.classList.contains('ts-rail')) throw new Error('rail button missing/classless')
if (railBtn.textContent !== '') throw new Error(`rail must hide the label: '${railBtn.textContent}'`)
console.log('rail OK: icon-only circle without label')

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
