/**
 * Functional harness for the user-level ui-settings-other patch.
 *
 * Host half: imports the real `lib/index.js`, applies it to a mock Cordis
 * context, and asserts the `/app` RPC channel registration plus endpoint
 * validation (never invokes `restart` — that respawns the process). Covers
 * the runtime-status snapshot (serviceInfo / listeningPorts / dshVersion),
 * the idle auto-stop decision + monitor mechanics, the settings-namespace
 * wiring (entry base → registered namespace → watch rebuild), and the
 * `reloadPlugins` hot-reload endpoint (touches a TEMP patch file, never the
 * real profile layer). Also guards the P0 regression: `apply` must NOT
 * return a thenable (Cordis treats a returned Fiber as an invalid Effect).
 *
 * Client half: loads the exact deployed `lib/client.js` the browser will
 * execute, feeds it a module table stubbed with the real platform words
 * (react, react/jsx-runtime, ui-primitives), asserts the registration
 * contracts (settings.section + settings.plugin.item + dictionaries), then —
 * when jsdom is available — renders the section and exercises the status
 * block, the reload-plugins flow, the confirm -> restart flow, and the
 * configuration card's staged-edit -> save / reset flows through the `/app`
 * RPC channel. Without jsdom the DOM sections are skipped with a notice.
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
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
  JSDOM = uiRequire('jsdom')
} catch {
  try { JSDOM = createRequire('D:/GitHub/deepseek-harness/package.json')('jsdom') } catch { /* skip */ }
}
const DOM_AVAILABLE = JSDOM !== null

const hostPath = join(here, 'lib', 'index.js')
const clientPath = join(here, 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-client-ui-settings-other'
const CARD_ID = '@local/dsh-client-ui-settings-other'

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
  const patchFile = host.resolvePatchFile({})
  if (!patchFile.toLowerCase().endsWith('.dsh\\profiles\\web\\cordis.patch.yml')) throw new Error(`default patch file: ${patchFile}`)
  console.log('host helpers OK: resolveRestartScript + buildRestartSpawn + runningSessionIds + resolvePatchFile')
}

// Runtime snapshot helpers
{
  const info = host.serviceInfo()
  if (info.pid !== process.pid) throw new Error(`serviceInfo.pid: ${info.pid} != ${process.pid}`)
  if (!Number.isFinite(info.uptime) || info.uptime < 0) throw new Error(`serviceInfo.uptime: ${info.uptime}`)
  if (!(info.rss > 0)) throw new Error(`serviceInfo.rss: ${info.rss}`)
  if (info.node !== process.version) throw new Error(`serviceInfo.node: ${info.node}`)
  if (typeof info.execPath !== 'string' || info.execPath.length === 0) throw new Error(`serviceInfo.execPath: ${info.execPath}`)
  if (!Array.isArray(info.ports) || info.ports.some((p) => !Number.isInteger(p))) throw new Error(`serviceInfo.ports: ${JSON.stringify(info.ports)}`)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(info.startedAt)) throw new Error(`serviceInfo.startedAt: ${info.startedAt}`)
  // dsh version resolves from the real CLI entry in the npx cache (when present)
  const npxRoot = join(userProfile, 'AppData', 'Local', 'npm-cache', '_npx', '1e7f6d9597241db0', 'node_modules', '@deepseek-ai', 'dsh')
  const binPath = join(npxRoot, 'lib', 'bin.js')
  const pkgPath = join(npxRoot, 'package.json')
  if (readFileSync(pkgPath, 'utf8').length > 0) {
    const expectedVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version
    const version = host.dshVersion(binPath)
    if (version !== expectedVersion) throw new Error(`dshVersion: ${version} != ${expectedVersion}`)
    console.log(`host snapshot OK: pid=${info.pid} ports=[${info.ports}] dsh=${version} node=${info.node}`)
  } else {
    console.log(`host snapshot OK: pid=${info.pid} ports=[${info.ports}] (dsh version check skipped: ${pkgPath} missing)`)
  }
}

// Idle decision + monitor mechanics (fake clock)
{
  const decision = host.idleDecision
  if (decision({ busy: true, lastBusyAt: 0, now: 99_999_999, idleMinutes: 120 }).action !== 'busy') throw new Error('busy must win')
  const wait = decision({ busy: false, lastBusyAt: 0, now: 60_000, idleMinutes: 2 })
  if (wait.action !== 'wait' || wait.remainingMs !== 60_000) throw new Error(`wait decision: ${JSON.stringify(wait)}`)
  const stop = decision({ busy: false, lastBusyAt: 0, now: 120_000, idleMinutes: 2 })
  if (stop.action !== 'stop') throw new Error(`stop decision: ${JSON.stringify(stop)}`)
  if (decision({ busy: false, lastBusyAt: 0, now: 9_999_999, idleMinutes: 0 }).action !== 'disabled') throw new Error('non-positive idleMinutes must disable')

  // monitor: busy resets the clock; idle past the threshold stops exactly once
  let t = 1_000_000
  let intervalFn = null
  const clock = {
    now: () => t,
    setInterval: (fn) => { intervalFn = fn; return { id: 1 } },
    clearInterval: () => {},
    advance: (ms) => { t += ms },
  }
  let stopped = 0
  let sessionsBusy = true
  const monitor = host.createIdleMonitor({
    busy: () => sessionsBusy,
    idleMinutes: () => 2,
    onStop: () => { stopped += 1 },
    now: clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  })
  clock.advance(10 * 60_000)
  if (monitor.check().action !== 'busy') throw new Error('monitor must stay busy while sessions run')
  if (monitor.lastBusyAt() !== t) throw new Error('busy must reset the idle clock')
  sessionsBusy = false
  clock.advance(119_999)
  if (monitor.check().action !== 'wait') throw new Error('monitor must wait before the threshold')
  clock.advance(2)
  if (monitor.check().action !== 'stop') throw new Error('monitor must stop past the threshold')
  if (stopped !== 1) throw new Error(`onStop fired ${stopped} times`)
  if (monitor.check() !== null) throw new Error('stopped monitor must not act again')
  monitor.stop()
  if (monitor.check() !== null) throw new Error('explicit stop must silence the monitor')
  console.log('host idle OK: decision + monitor (busy reset / wait / stop-once)')
}

let handled = null
let cancelled = []
let innerCtx = null
let settingsRegistered = null
let settingsWatchCb = null
let appExitCalls = []
const fakeAgents = {
  list: () => [
    { id: 'sess-a', status: 'running', cancel: (cause, opts) => cancelled.push({ id: 'sess-a', cause, opts }) },
  ],
  get: (id) => fakeAgents.list().find((a) => a.id === id),
}
let settingsAvailable = false
const hostCtx = {
  inject: (services, callback) => {
    const list = services.join(',')
    if (list === 'connection,agents') {
      innerCtx = {
        connection: {
          rpc: {
            handle: (channel, handler, options) => {
              handled = { channel, handler, options }
              return () => {}
            },
          },
        },
        agents: fakeAgents,
        logger: { info: () => {}, warn: () => {} },
        get: (name) => (name === 'appExit' ? (code) => { appExitCalls.push(code) } : undefined),
        inject: hostCtx.inject,
        effect: (fn) => fn(),
        fiber: { state: 0 },
      }
      return callback(innerCtx)
    }
    if (list === 'settings' && settingsAvailable) {
      return callback({
        ...innerCtx,
        settings: {
          register: (ns, schema, options) => {
            settingsRegistered = { ns, options }
            return {
              get: () => ({ ...host.DEFAULTS, ...(options.base ?? {}) }),
              watch: (cb) => { settingsWatchCb = cb; return () => {} },
            }
          },
        },
      })
    }
    return undefined
  },
  effect: (fn) => fn(),
}

// config.script points at a NON-EXISTENT path so the restart endpoint fails
// cleanly (script-missing branch) instead of spawning a real restart.
const MISSING_SCRIPT = 'C:\\__no_such_dir__\\restart-dsh.ps1'
// reloadPlugins touches a TEMP patch file, never the real profile layer.
const tmpPatchDir = mkdtempSync(join(tmpdir(), 'ui-settings-other-verify-'))
const tmpPatchFile = join(tmpPatchDir, 'cordis.patch.yml')
writeFileSync(tmpPatchFile, '- insert: []\n')

// 1) apply without a settings service -> entry fallback, status still rich
{
  cancelled = []
  appExitCalls = []
  settingsRegistered = null
  settingsAvailable = false
  handled = null
  const ret = host.apply(hostCtx, { script: MISSING_SCRIPT, patchFile: tmpPatchFile })
  // P0 regression guard: returning the ctx.inject() thenable Fiber from apply
  // makes Cordis throw TypeError('Invalid effect') and fail the plugin.
  if (ret !== undefined && (typeof ret === 'object' || typeof ret === 'function') && typeof ret.then === 'function') {
    throw new Error('P0 regression: apply returned a thenable (Invalid effect)')
  }
  if (handled === null || handled.channel !== '/app') throw new Error(`host channel mismatch: ${JSON.stringify(handled)}`)
  if (handled.options.authority !== 'loopback') throw new Error(`host authority mismatch: ${handled.options.authority}`)
  if (settingsRegistered !== null) throw new Error('no settings service must not register a namespace')

  const status0 = await handled.handler('status', {})
  if (!status0.ok || status0.value.running !== 1 || status0.value.sessions.join(',') !== 'sess-a') {
    throw new Error(`status endpoint: ${JSON.stringify(status0)}`)
  }
  if (status0.value.service?.pid !== process.pid) throw new Error(`status service.pid: ${JSON.stringify(status0.value.service)}`)
  if (!status0.value.idle?.enabled || status0.value.idle.idleMinutes !== 120) {
    throw new Error(`status idle defaults: ${JSON.stringify(status0.value.idle)}`)
  }
  if (typeof status0.value.idle.lastBusyAt !== 'number') throw new Error('idle must expose lastBusyAt')
  if (appExitCalls.length !== 0) throw new Error('status must never exit')

  const unknown = await handled.handler('nope', {})
  if (unknown.ok !== false || unknown.error.code !== 'bad-request') throw new Error('unknown endpoint must be rejected')

  const busy = await handled.handler('restart', { args: {} })
  if (busy.ok !== false || busy.error.code !== 'sessions-running') throw new Error(`busy must be refused: ${JSON.stringify(busy)}`)
  if (cancelled.length !== 0) throw new Error('non-force restart must not cancel sessions')

  const forced = await handled.handler('restart', { args: { force: true } })
  if (forced.ok !== false || forced.error.code !== 'internal') throw new Error(`forced must reach script check: ${JSON.stringify(forced)}`)
  if (cancelled.length !== 1 || cancelled[0].id !== 'sess-a') throw new Error(`force must cancel running sessions: ${JSON.stringify(cancelled)}`)
  if (cancelled[0].opts?.keepInbox !== true) throw new Error('force cancel must keepInbox')

  // reloadPlugins: touches the temp patch file, marker line is idempotent
  const reloaded = await handled.handler('reloadPlugins', { args: {} })
  if (!reloaded.ok) throw new Error(`reloadPlugins: ${JSON.stringify(reloaded)}`)
  const afterFirst = readFileSync(tmpPatchFile, 'utf8')
  if (!/^# dsh-plugin-reload: .*$/m.test(afterFirst)) throw new Error('reloadPlugins must write the marker line')
  await handled.handler('reloadPlugins', { args: {} })
  const afterSecond = readFileSync(tmpPatchFile, 'utf8')
  const markers = afterSecond.match(/^# dsh-plugin-reload: .*$/gm) ?? []
  if (markers.length !== 1) {
    throw new Error(`reloadPlugins marker must stay a single line: ${markers.join(' | ')}`)
  }
  console.log('host OK: /app channel + status(running/service/idle) + restart session protection + reloadPlugins (temp patch file)')
}

// 2) apply WITH a settings service -> namespace registered, entry as base, watch wired
{
  settingsRegistered = null
  settingsWatchCb = null
  settingsAvailable = true
  handled = null
  const ret = host.apply(hostCtx, { script: MISSING_SCRIPT, patchFile: tmpPatchFile, idleMinutes: 7 })
  if (ret !== undefined && typeof ret.then === 'function') throw new Error('P0 regression: apply returned a thenable (with settings)')
  if (settingsRegistered === null || settingsRegistered.ns !== 'ui-settings-other') {
    throw new Error(`namespace not registered: ${JSON.stringify(settingsRegistered)}`)
  }
  if (JSON.stringify(settingsRegistered.options.base) !== '{"idleMinutes":7}') {
    throw new Error(`entry base mismatch: ${JSON.stringify(settingsRegistered.options.base)}`)
  }
  if (settingsWatchCb === null) throw new Error('settings watch must be wired')
  const status1 = await handled.handler('status', {})
  if (status1.value.idle.idleMinutes !== 7) throw new Error(`entry idleMinutes must drive status: ${JSON.stringify(status1.value.idle)}`)
  settingsWatchCb() // simulated settings change: monitor rebuild must not throw
  if (status1.value.idle.enabled !== true) throw new Error('idle enabled default mismatch')
  console.log('host OK: settings namespace ui-settings-other (base=entry) + watch rebuild')
}

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

// --- registration contract ----------------------------------------------------
if (typeof exports_.apply !== 'function') throw new Error('exports.apply missing')
if (!Array.isArray(exports_.inject)) throw new Error('exports.inject missing')
if (exports_.NS !== 'settings.other') throw new Error(`NS mismatch: ${exports_.NS}`)
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

let registrations = []
let dicts = []
let rpcLog = []
let restartResult = { ok: true, value: { scheduled: true, delayMs: 2600 } }
let reloadResult = { ok: true, value: { requested: true, patchFile: 'x' } }
let cardValue = { idleEnabled: true, idleMinutes: 45 }
let statusValue = {
  running: 0,
  sessions: [],
  service: {
    pid: 4242,
    startedAt: '2026-01-01T00:00:00.000Z',
    uptime: 3661,
    rss: 536870912,
    node: 'v22.0.0',
    execPath: 'C:/node.exe',
    version: '0.1.0-rc.6',
    ports: [3080],
  },
  idle: { enabled: true, idleMinutes: 120, lastBusyAt: Date.now() - 60_000 },
}
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
        if (endpoint === 'status') return { ok: true, value: statusValue }
        if (endpoint === 'restart') return restartResult
        if (endpoint === 'reloadPlugins') return reloadResult
        if (endpoint === 'getSettings') return { ok: true, value: cardValue }
        if (endpoint === 'setSettings') {
          cardValue = { ...cardValue, ...payload.args.fields }
          return { ok: true, value: cardValue }
        }
        if (endpoint === 'resetSettings') {
          cardValue = { idleEnabled: true, idleMinutes: 120 }
          return { ok: true, value: cardValue }
        }
        return { ok: false, error: { code: 'bad-request', message: 'unexpected', details: {} } }
      },
    },
  },
  slots: {
    inject: (_key, callback) => { registrations.push(callback()) },
    register: (options, component) => ({ ...options, component }),
  },
}
exports_.apply(clientCtx)

const sectionReg = registrations.find((r) => r.name === 'settings.section')
const cardReg = registrations.find((r) => r.name === 'settings.plugin.item')
if (sectionReg === undefined) throw new Error('settings.section never registered')
if (sectionReg.id !== 'other' || sectionReg.order !== 30) {
  throw new Error(`section options mismatch: ${JSON.stringify(sectionReg)}`)
}
if (typeof sectionReg.inject().reloadPlugins !== 'function') throw new Error('section inject must expose reloadPlugins')
if (cardReg === undefined) throw new Error('settings.plugin.item never registered')
if (cardReg.id !== CARD_ID || cardReg.order !== 30 || cardReg.locale !== 'settings.other.card') {
  throw new Error(`card options mismatch: ${JSON.stringify(cardReg)}`)
}
const sectionDict = dicts.find((d) => d.ns === 'settings.other')
const cardDict = dicts.find((d) => d.ns === 'settings.other.card')
if (sectionDict === undefined || cardDict === undefined) throw new Error('dictionaries not registered')
const zhKeys = Object.keys(sectionDict.dict.zh)
const enKeys = Object.keys(sectionDict.dict.en)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  throw new Error(`zh/en key mismatch (section):\nzh: ${zhKeys}\nen: ${enKeys}`)
}
const zhCardKeys = Object.keys(cardDict.dict.zh)
const enCardKeys = Object.keys(cardDict.dict.en)
if (JSON.stringify(zhCardKeys) !== JSON.stringify(enCardKeys)) {
  throw new Error(`zh/en key mismatch (card):\nzh: ${zhCardKeys}\nen: ${enCardKeys}`)
}
console.log(`apply contract OK: section id=other order=30 | card id=${CARD_ID} order=30 | dict keys = ${zhKeys.length} + ${zhCardKeys.length}`)

if (!DOM_AVAILABLE) {
  console.log('\nclient DOM sections SKIPPED (jsdom not installed)')
  console.log('ALL NON-DOM HARNESS CHECKS PASSED (install jsdom to enable the DOM sections)')
  process.exit(0)
}

// --- render + interact (react-dom in jsdom) ------------------------------------
const { act } = React
const { createRoot } = uiRequire('react-dom/client')

const fireClick = (el) => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) }
const fireChange = (el, value) => {
  const proto = el.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const en = sectionDict.dict.en
const clientInjected = sectionReg.inject('session-1')
const tWithParams = (key, params) => {
  const value = en[key]
  return params && params.n !== undefined ? value.replace('{n}', String(params.n)) : value
}

const root = createRoot(dom.window.document.getElementById('root'))
await act(async () => {
  root.render(React.createElement(sectionReg.component, {
    restart: clientInjected.restart,
    status: clientInjected.status,
    reloadPlugins: clientInjected.reloadPlugins,
    t: tWithParams,
  }))
})

const doc = dom.window.document
const buttons = () => [...doc.querySelectorAll('.so-btn')]
const flowLine = () => doc.querySelector('.so-flow-status')

// runtime snapshot block renders from the first /app/status poll
const infoRows = () => [...doc.querySelectorAll('.so-info-row')]
if (infoRows().length !== 8) throw new Error(`expected 8 info rows, got ${infoRows().length}`)
const infoText = doc.querySelector('.so-info').textContent
if (!infoText.includes('4242')) throw new Error(`pid missing: ${infoText}`)
if (!infoText.includes('3080')) throw new Error(`ports missing: ${infoText}`)
if (!infoText.includes('v22.0.0')) throw new Error(`node missing: ${infoText}`)
if (!infoText.includes('0.1.0-rc.6')) throw new Error(`dsh version missing: ${infoText}`)
const refreshButton = buttons().find((b) => b.textContent === en.refresh)
if (refreshButton === undefined) throw new Error('refresh button missing')
const reloadButton = buttons().find((b) => b.textContent === en.reloadPlugins)
if (reloadButton === undefined) throw new Error('reload-plugins button missing')
const restartButton = buttons().find((b) => b.textContent === en.restart)
if (restartButton === undefined) throw new Error('restart button missing')
if (buttons().length !== 3) throw new Error(`expected 3 buttons (reload+restart+refresh), got ${buttons().length}`)
if (doc.querySelector('.so-danger-note') === null) throw new Error('danger note missing')
rpcLog = [] // the mount already polled status once; reset before interaction
console.log('status block OK: 8 rows render pid/ports/versions, reload + refresh + restart present')

// refresh button re-polls /app/status
await act(async () => { fireClick(refreshButton) })
if (!rpcLog.some((c) => c.endpoint === 'status')) throw new Error('refresh must re-poll /app/status')
rpcLog = []
console.log('status block OK: refresh re-polls /app/status')

// reload-plugins flow: calls /app/reloadPlugins and shows the requested line
await act(async () => { fireClick(reloadButton) })
const reloadCall = rpcLog.find((c) => c.endpoint === 'reloadPlugins')
if (reloadCall === undefined || reloadCall.channel !== '/app') throw new Error(`reload rpc target: ${JSON.stringify(reloadCall)}`)
if (flowLine() === null || flowLine().textContent !== en.reloadRequested) throw new Error('reload requested status missing')
console.log('reload flow OK: /app reloadPlugins + requested status')
rpcLog = []

// click -> confirm state (no call yet)
await act(async () => { fireClick(restartButton) })
if (rpcLog.length !== 0) throw new Error('confirm state must not call the host yet')
const confirmButton = buttons().find((b) => b.textContent === en.confirm)
if (confirmButton === undefined) throw new Error('confirm button missing')
if (flowLine() === null || flowLine().textContent !== en.confirmPrompt) throw new Error('confirm prompt missing')
console.log('confirm state OK')

// cancel returns to idle
await act(async () => { fireClick(buttons().find((b) => b.textContent === en.cancel)) })
if (buttons().length !== 3) throw new Error('cancel should restore reload+restart+refresh buttons')
console.log('cancel OK')

// confirm -> calling -> scheduled; host endpoint + payload shape
await act(async () => { fireClick(buttons().find((b) => b.textContent === en.restart)) })
await act(async () => { fireClick(buttons().find((b) => b.textContent === en.confirm)) })
const restartCall = rpcLog.find((c) => c.endpoint === 'restart')
if (restartCall === undefined || restartCall.channel !== '/app') throw new Error(`rpc target: ${JSON.stringify(restartCall)}`)
if (JSON.stringify(restartCall.payload.args) !== '{}') throw new Error(`non-force args: ${JSON.stringify(restartCall.payload)}`)
if (flowLine() === null || flowLine().textContent !== en.scheduled) throw new Error('scheduled status missing')
console.log('restart flow OK: /app restart RPC (args {}) + scheduled status')

// busy flow: sessions running -> busy view -> force restart passes force: true
const busyHost = dom.window.document.createElement('div')
const busyRoot = createRoot(busyHost)
restartResult = { ok: false, error: { code: 'sessions-running', message: 'x', details: { running: 2, sessions: ['a', 'b'] } } }
statusValue = { running: 2, sessions: ['a', 'b'] }
rpcLog = []
await act(async () => {
  busyRoot.render(React.createElement(sectionReg.component, {
    restart: clientInjected.restart,
    status: clientInjected.status,
    reloadPlugins: clientInjected.reloadPlugins,
    t: tWithParams,
  }))
})
await act(async () => { fireClick([...busyHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.restart)) })
await act(async () => { fireClick([...busyHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.confirm)) })
const busyLine = busyHost.querySelector('.so-flow-status[data-tone="error"]')
if (busyLine === null || busyLine.textContent !== en.busy.replace('{n}', '2')) {
  throw new Error(`busy line: ${busyLine?.textContent}`)
}
const forceButton = [...busyHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.busyActionForce)
if (forceButton === undefined) throw new Error('force button missing')
const waitButton = [...busyHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.busyActionWait)
if (waitButton === undefined) throw new Error('wait button missing')
rpcLog = []
await act(async () => { fireClick(forceButton) })
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
  waitRoot.render(React.createElement(sectionReg.component, {
    restart: clientInjected.restart,
    status: clientInjected.status,
    reloadPlugins: clientInjected.reloadPlugins,
    t: tWithParams,
  }))
})
await act(async () => { fireClick([...waitHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.restart)) })
await act(async () => { fireClick([...waitHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.confirm)) })
await act(async () => { fireClick([...waitHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.busyActionWait)) })
// first status poll fires after the 2s interval
await new Promise((resolve) => setTimeout(resolve, 2200))
await act(async () => {})
const waitingLine = waitHost.querySelector('.so-flow-status')
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
  root2.render(React.createElement(sectionReg.component, {
    restart: async () => { throw new Error('private detail') },
    status: clientInjected.status,
    reloadPlugins: clientInjected.reloadPlugins,
    t: tWithParams,
  }))
})
await act(async () => { fireClick([...errorHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.restart)) })
await act(async () => { fireClick([...errorHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.confirm)) })
if (errorHost.querySelector('.so-flow-status[data-tone="error"]') === null) throw new Error('error status missing')
if (errorHost.textContent.includes('private detail')) throw new Error('error state leaked transport detail')
console.log('error state OK')

// --- configuration card (设置 → 插件 → 插件配置) --------------------------------
// The deployed card talks to the host through the /app RPC channel
// (getConfig/setConfig/resetConfig), NOT through a client settings scope.
const enCard = cardDict.dict.en
const tCardWithParams = (key, params) => {
  const value = enCard[key]
  return params && params.n !== undefined ? value.replace('{n}', String(params.n)) : value
}
const cardHost = dom.window.document.createElement('div')
const cardRoot = createRoot(cardHost)
await act(async () => {
  cardRoot.render(React.createElement(cardReg.component, {
    t: tCardWithParams,
    ...cardReg.inject(),
  }))
})

const header = cardHost.querySelector('.soc-header')
if (header === null) throw new Error('card header missing')
await act(async () => { fireClick(header) })
const inputs = [...cardHost.querySelectorAll('.soc-input')]
if (inputs.length !== 1) throw new Error(`expected 1 number input, got ${inputs.length}`)
const toggles = [...cardHost.querySelectorAll('.soc-toggle')]
if (toggles.length !== 1) throw new Error(`expected 1 toggle, got ${toggles.length}`)
const minutesInput = cardHost.querySelector('#soc-idleMinutes')
if (minutesInput === null || minutesInput.value !== '45') throw new Error(`override value: ${minutesInput?.value}`)

// staged edit -> save writes the field through /app/setSettings
rpcLog = []
await act(async () => { fireChange(minutesInput, '60') })
if (!cardHost.querySelector('.soc-pending')) throw new Error('unsaved badge missing')
const saveButton = cardHost.querySelector('.soc-save')
if (saveButton === null || saveButton.disabled) throw new Error('save must be enabled with staged edits')
await act(async () => { fireClick(saveButton) })
const setCall = rpcLog.find((c) => c.endpoint === 'setSettings')
if (setCall === undefined || setCall.channel !== '/app' || setCall.payload.args.fields.idleMinutes !== 60) {
  throw new Error(`save rpc: ${JSON.stringify(rpcLog)}`)
}
if (cardValue.idleMinutes !== 60) throw new Error(`card must adopt the host response: ${JSON.stringify(cardValue)}`)
console.log('card OK: fields render, staged edit saves through /app setSettings')

// toggle staged edit -> save writes the boolean
await act(async () => { fireClick(cardHost.querySelector('#soc-idleEnabled')) })
await act(async () => { fireClick(cardHost.querySelector('.soc-save')) })
const toggleCall = rpcLog.filter((c) => c.endpoint === 'setSettings').pop()
if (toggleCall === undefined || toggleCall.payload.args.fields.idleEnabled !== false) {
  throw new Error(`toggle write: ${JSON.stringify(toggleCall?.payload)}`)
}
console.log('card OK: toggle saves through /app setSettings')

// reset-all restores defaults through /app/resetSettings (second .soc-discard)
await act(async () => { fireClick(cardHost.querySelectorAll('.soc-discard')[1]) })
const resetCall = rpcLog.find((c) => c.endpoint === 'resetSettings')
if (resetCall === undefined || resetCall.channel !== '/app') throw new Error(`reset rpc: ${JSON.stringify(rpcLog)}`)
if (cardValue.idleMinutes !== 120) throw new Error(`reset must adopt the host response: ${JSON.stringify(cardValue)}`)
console.log('card OK: reset-all calls /app resetSettings')

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
