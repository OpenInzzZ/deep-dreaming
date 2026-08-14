/**
 * Functional harness for the user-level ui-settings-other patch.
 *
 * Host half: imports the real `lib/index.js`, applies it to a mock Cordis
 * context, and asserts the `/app` RPC channel registration plus endpoint
 * validation (never invokes `restart` — that respawns the process).
 *
 * Client half: loads the exact deployed `lib/client.js` the browser will
 * execute, feeds it a module table stubbed with the real platform words
 * (react, react/jsx-runtime, ui-primitives — resolved from the harness repo's
 * node_modules), asserts the registration contract, then renders the section
 * in jsdom and exercises the confirm -> restart flow end to end.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const repoRequire = createRequire('D:/GitHub/deepseek-harness/package.json')
// The browser module table is the DEPLOYED profile's packages — anchor there.
const uiRequire = createRequire('C:/Users/zhoukaiying/.dsh/profiles/web/package.json')
const { JSDOM } = repoRequire('jsdom')
const React = uiRequire('react')

const here = dirname(fileURLToPath(import.meta.url))
const hostPath = join(here, 'lib', 'index.js')
const clientPath = join(here, 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-client-ui-settings-other'

// --- host half: registration + endpoint validation ---------------------------
const host = await import(pathToFileURL(hostPath).href)

// Pure helpers
{
  const resolved = host.resolveRestartScript({})
  if (!resolved.toLowerCase().endsWith('.dsh\\scripts\\restart-dsh.ps1')) throw new Error(`default script path: ${resolved}`)
  const custom = host.resolveRestartScript({ script: 'C:\\Custom\\restart.ps1' })
  if (custom !== 'C:\\Custom\\restart.ps1') throw new Error(`custom script path: ${custom}`)
  const invocation = host.buildRestartSpawn(resolved)
  if (invocation.file !== 'powershell' || invocation.args[3] !== '-File' || invocation.args[4] !== resolved) {
    throw new Error(`spawn invocation: ${JSON.stringify(invocation)}`)
  }
  const cancelled = []
  const agents = {
    list: () => [
      { id: 'sess-a', status: 'running', cancel: (cause, opts) => cancelled.push({ id: 'sess-a', cause, opts }) },
      { id: 'sess-b', status: 'idle', cancel: () => cancelled.push({ id: 'sess-b' }) },
    ],
    get: (id) => agents.list().find((a) => a.id === id),
  }
  const running = host.runningSessionIds(agents)
  if (running.join(',') !== 'sess-a') throw new Error(`runningSessionIds: ${running}`)
  console.log('host helpers OK: resolveRestartScript + buildRestartSpawn + runningSessionIds')
}

let handled = null
let injected = null
let cancelled = []
const fakeAgents = {
  list: () => [
    { id: 'sess-a', status: 'running', cancel: (cause, opts) => cancelled.push({ id: 'sess-a', cause, opts }) },
  ],
  get: (id) => fakeAgents.list().find((a) => a.id === id),
}
const hostCtx = {
  inject: (services, callback) => {
    injected = { services, callback }
    // apply() returns the registration result; emulate Cordis by invoking it.
    const fakeConnectionCtx = {
      connection: {
        rpc: {
          handle: (channel, handler, options) => {
            handled = { channel, handler, options }
            return () => {}
          },
        },
      },
      agents: fakeAgents,
    }
    return callback(fakeConnectionCtx)
  },
}
// config.script points at a NON-EXISTENT path so the restart endpoint fails
// cleanly (script-missing branch) instead of spawning a real restart.
const MISSING_SCRIPT = 'C:\\__no_such_dir__\\restart-dsh.ps1'
host.apply(hostCtx, { script: MISSING_SCRIPT })
if (injected === null || injected.services.join(',') !== 'connection,agents') throw new Error('host inject mismatch')
if (handled === null || handled.channel !== '/app') throw new Error(`host channel mismatch: ${JSON.stringify(handled)}`)
if (handled.options.authority !== 'loopback') throw new Error(`host authority mismatch: ${handled.options.authority}`)
console.log('host contract OK: /app channel, authority = loopback')

const unknown = await handled.handler('nope', {})
if (unknown.ok !== false || unknown.error.code !== 'bad-request') throw new Error('unknown endpoint must be rejected')
console.log('host endpoint validation OK: unknown endpoint -> bad-request')

// status endpoint reflects the running-session count
const status0 = await handled.handler('status', {})
if (!status0.ok || status0.value.running !== 1 || status0.value.sessions.join(',') !== 'sess-a') {
  throw new Error(`status endpoint: ${JSON.stringify(status0)}`)
}
console.log('host endpoint validation OK: status reports running sessions')

// restart while a session is running -> refused, nothing cancelled, nothing spawned
const busy = await handled.handler('restart', { args: {} })
if (busy.ok !== false || busy.error.code !== 'sessions-running') throw new Error(`busy must be refused: ${JSON.stringify(busy)}`)
if (busy.error.details.running !== 1) throw new Error('busy details missing running count')
if (cancelled.length !== 0) throw new Error('non-force restart must not cancel sessions')
console.log('host endpoint validation OK: restart refused while sessions running')

// force restart cancels the running session first, then fails on the missing script
const forced = await handled.handler('restart', { args: { force: true } })
if (forced.ok !== false || forced.error.code !== 'internal') throw new Error(`forced must reach script check: ${JSON.stringify(forced)}`)
if (cancelled.length !== 1 || cancelled[0].id !== 'sess-a') throw new Error(`force must cancel running sessions: ${JSON.stringify(cancelled)}`)
if (cancelled[0].opts?.keepInbox !== true) throw new Error('force cancel must keepInbox')
console.log('host endpoint validation OK: force cancels running sessions (keepInbox) before restart')

// --- client half: jsdom environment (what the browser shell provides) -------
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

const requireTable = (spec) => {
  if (spec === 'react') return uiRequire('react')
  if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
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
if (exports_.NS !== 'settings.other') throw new Error(`NS mismatch: ${exports_.NS}`)
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

let registered = null
let dictionaries = null
let rpcLog = []
let restartResult = { ok: true, value: { scheduled: true, delayMs: 2600 } }
let statusValue = { running: 0, sessions: [] }
const clientCtx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => { dictionaries = { ns, dicts } },
    bind: () => (key) => 't:' + key,
  },
  connection: {
    rpc: {
      call: async (channel, endpoint, payload) => {
        rpcLog.push({ channel, endpoint, payload })
        if (endpoint === 'status') return { ok: true, value: statusValue }
        if (endpoint === 'restart') return restartResult
        return { ok: false, error: { code: 'bad-request', message: 'unexpected', details: {} } }
      },
    },
  },
  sessions: {
    scope: () => ({ get: () => ({ updateQueue: async () => {}, input: { for: () => ({ notify: () => {} }) } }) }),
  },
  slots: {
    inject: (_key, callback) => { registered = callback() },
    register: (options, component) => ({ ...options, component }),
  },
}
exports_.apply(clientCtx)
if (registered === null) throw new Error('slots.inject never registered')
if (registered.id !== 'other' || registered.order !== 30) {
  throw new Error(`section options mismatch: ${JSON.stringify(registered)}`)
}
if (dictionaries === null || dictionaries.ns !== exports_.NS) throw new Error('dictionaries not registered')
const zhKeys = Object.keys(dictionaries.dicts.zh)
const enKeys = Object.keys(dictionaries.dicts.en)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  throw new Error(`zh/en key mismatch:\nzh: ${zhKeys}\nen: ${enKeys}`)
}
console.log('apply contract OK: section id = other, order = 30 | dict keys =', zhKeys.length)

// --- render + interact (react-dom in jsdom) ------------------------------------
const { act } = React
const { createRoot } = uiRequire('react-dom/client')
const { fireEvent } = repoRequire('@testing-library/react')
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const en = dictionaries.dicts.en
const clientInjected = registered.inject('session-1')
const tWithParams = (key, params) => {
  const value = en[key]
  return params && params.n !== undefined ? value.replace('{n}', String(params.n)) : value
}
const renderInto = (host, props) => {
  const root = createRoot(host)
  return { root, props }
}

const root = createRoot(dom.window.document.getElementById('root'))
await act(async () => {
  root.render(React.createElement(registered.component, {
    restart: clientInjected.restart,
    status: clientInjected.status,
    t: tWithParams,
  }))
})

const doc = dom.window.document
const buttons = () => [...doc.querySelectorAll('.so-btn')]
const statusLine = () => doc.querySelector('.so-status')

const restartButton = buttons().find((b) => b.textContent === en.restart)
if (restartButton === undefined) throw new Error('restart button missing')
if (buttons().length !== 1) throw new Error(`expected 1 button initially, got ${buttons().length}`)
console.log('initial render OK: restart button present')

// click -> confirm state (no call yet)
await act(async () => { fireEvent.click(restartButton) })
if (rpcLog.length !== 0) throw new Error('confirm state must not call the host yet')
const confirmButton = buttons().find((b) => b.textContent === en.confirm)
if (confirmButton === undefined) throw new Error('confirm button missing')
if (statusLine() === null || statusLine().textContent !== en.confirmPrompt) throw new Error('confirm prompt missing')
console.log('confirm state OK')

// cancel returns to idle
await act(async () => { fireEvent.click(buttons().find((b) => b.textContent === en.cancel)) })
if (buttons().length !== 1) throw new Error('cancel should restore single button')
console.log('cancel OK')

// confirm -> calling -> scheduled; host endpoint + payload shape
await act(async () => { fireEvent.click(buttons()[0]) })
await act(async () => { fireEvent.click(buttons().find((b) => b.textContent === en.confirm)) })
const restartCall = rpcLog.find((c) => c.endpoint === 'restart')
if (restartCall === undefined || restartCall.channel !== '/app') throw new Error(`rpc target: ${JSON.stringify(restartCall)}`)
if (JSON.stringify(restartCall.payload.args) !== '{}') throw new Error(`non-force args: ${JSON.stringify(restartCall.payload)}`)
if (statusLine() === null || statusLine().textContent !== en.scheduled) throw new Error('scheduled status missing')
console.log('restart flow OK: /app restart RPC (args {}) + scheduled status')

// busy flow: sessions running -> busy view -> force restart passes force: true
const busyHost = dom.window.document.createElement('div')
const busyRoot = createRoot(busyHost)
restartResult = { ok: false, error: { code: 'sessions-running', message: 'x', details: { running: 2, sessions: ['a', 'b'] } } }
rpcLog = []
await act(async () => {
  busyRoot.render(React.createElement(registered.component, {
    restart: clientInjected.restart,
    status: clientInjected.status,
    t: tWithParams,
  }))
})
await act(async () => { fireEvent.click(busyHost.querySelector('.so-btn')) })
await act(async () => { fireEvent.click([...busyHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.confirm)) })
const busyLine = busyHost.querySelector('.so-status[data-tone="error"]')
if (busyLine === null || busyLine.textContent !== en.busy.replace('{n}', '2')) {
  throw new Error(`busy line: ${busyLine?.textContent}`)
}
const forceButton = [...busyHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.busyActionForce)
if (forceButton === undefined) throw new Error('force button missing')
const waitButton = [...busyHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.busyActionWait)
if (waitButton === undefined) throw new Error('wait button missing')
rpcLog = []
await act(async () => { fireEvent.click(forceButton) })
const forceCall = rpcLog.find((c) => c.endpoint === 'restart')
if (forceCall === undefined || forceCall.payload.args.force !== true) {
  throw new Error(`force call args: ${JSON.stringify(forceCall?.payload)}`)
}
console.log('busy flow OK: refused -> busy view -> force restart sends force:true')

// wait flow: poll /app/status until idle, then auto-restart
const waitHost = dom.window.document.createElement('div')
const waitRoot = createRoot(waitHost)
restartResult = { ok: false, error: { code: 'sessions-running', message: 'x', details: { running: 1, sessions: ['a'] } } }
statusValue = { running: 1, sessions: ['a'] }
rpcLog = []
await act(async () => {
  waitRoot.render(React.createElement(registered.component, {
    restart: clientInjected.restart,
    status: clientInjected.status,
    t: tWithParams,
  }))
})
await act(async () => { fireEvent.click(waitHost.querySelector('.so-btn')) })
await act(async () => { fireEvent.click([...waitHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.confirm)) })
await act(async () => { fireEvent.click([...waitHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.busyActionWait)) })
// first status poll fires after the 2s interval
await new Promise((resolve) => setTimeout(resolve, 2200))
await act(async () => {})
const waitingLine = waitHost.querySelector('.so-status')
if (waitingLine === null || waitingLine.textContent !== en.waiting.replace('{n}', '1')) {
  throw new Error(`waiting line: ${waitingLine?.textContent}`)
}
if (!rpcLog.some((c) => c.endpoint === 'status')) throw new Error('wait flow must poll /app/status')
// sessions finish -> next poll triggers the auto restart (interval is 2s)
statusValue = { running: 0, sessions: [] }
await new Promise((resolve) => setTimeout(resolve, 2200))
await act(async () => {})
const autoCall = rpcLog.find((c) => c.endpoint === 'restart')
if (autoCall === undefined) throw new Error('wait flow must auto-restart once idle')
console.log('wait flow OK: polls status and auto-restarts when idle')

// error state: host failure surfaces as error copy
const errorHost = dom.window.document.createElement('div')
const root2 = createRoot(errorHost)
await act(async () => {
  root2.render(React.createElement(registered.component, {
    restart: async () => { throw new Error('private detail') },
    status: clientInjected.status,
    t: tWithParams,
  }))
})
await act(async () => { fireEvent.click(errorHost.querySelector('.so-btn')) })
await act(async () => { fireEvent.click(errorHost.querySelector('.so-btn')) })
if (errorHost.querySelector('.so-status[data-tone="error"]') === null) throw new Error('error status missing')
if (errorHost.textContent.includes('private detail')) throw new Error('error state leaked transport detail')
console.log('error state OK')

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
