/**
 * Functional harness for the session-cleanup patch's settings integration.
 *
 * Host half: applies the real `session-cleanup.mjs` to a mock Cordis context —
 * both without a settings service (entry-config fallback) and with one
 * (namespace registration + watch-driven timer rebuild + the /session-cleanup
 * RPC channel). Guards the P0 regression: `apply` must NOT return a thenable
 * (Cordis treats a returned Fiber as an invalid Effect and throws
 * TypeError('Invalid effect')), and the settings detach disposer / watcher
 * must not rebuild the timer while the plugin unloads (isUnloading guard).
 *
 * Client half: loads the exact deployed `client.js`, asserts the
 * `settings.plugin.item` card registration (key 'session-cleanup'),
 * checks the dictionaries, drives the cardApi (getConfig / setConfig /
 * resetConfig) through a mocked `connection.rpc.call` — the card reads and
 * writes config via the /session-cleanup RPC channel — and renders the card
 * in jsdom to exercise the staged-edit → save → RPC flow end to end.
 *
 * Dependency resolution is entirely relative to this patch directory (no
 * hardcoded machine paths): jsdom / react / react-dom / @deepseek-ai/*
 * resolve from ./node_modules (npm install in the patch dir). jsdom is the
 * only DOM dependency; if it is missing the render section is skipped with a
 * notice and the host + client contract checks still run.
 *
 * Run: node patches/session-cleanup/verify-session-cleanup.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const hostPath = join(here, 'session-cleanup.mjs')
const clientPath = join(here, 'client.js')
const PLUGIN_ID = '@local/dsh-plugin-session-cleanup'

// --- host half: entry fallback + settings integration + RPC channel ------------
const host = await import(pathToFileURL(hostPath).href)
const sessionsRoot = mkdtempSync(join(tmpdir(), 'cleanup-verify-'))

function makeCtx({ withSettings }) {
  const calls = {
    info: [],
    warn: [],
    registered: null,
    watchCb: null,
    rpcHandles: [],
    cleanups: [],
    settingsUpdates: [],
    settingsReplaces: [],
  }
  const logger = {
    info: (...args) => { calls.info.push(args) },
    warn: (...args) => { calls.warn.push(args) },
  }
  // Cordis effect: run the body now, keep the disposer. All contexts share one
  // list in registration order; disposal runs it in reverse (LIFO), which for
  // this plugin reproduces the observable cordis teardown order: the plugin's
  // own disposed-setter runs before the settings child fiber's disposer.
  const effect = (fn) => {
    const cleanup = fn()
    if (typeof cleanup === 'function') calls.cleanups.push(cleanup)
    return cleanup
  }
  const ctx = {
    logger,
    calls,
    effect,
    inject: (services, callback) => {
      const list = services.join(',')
      if (list === 'sessions,connection') {
        return callback({
          logger,
          calls,
          effect,
          inject: ctx.inject,
          sessions: { list: () => [] },
          connection: {
            rpc: {
              handle: (channel, handler, options) => {
                const entry = { channel, handler, options }
                calls.rpcHandles.push(entry)
                return () => {
                  const i = calls.rpcHandles.indexOf(entry)
                  if (i >= 0) calls.rpcHandles.splice(i, 1)
                }
              },
            },
          },
        })
      }
      if (list === 'settings' && withSettings) {
        return callback({
          logger,
          calls,
          effect,
          inject: ctx.inject,
          settings: {
            register: (ns, schema, options) => {
              calls.registered = { ns, options }
              const stored = { ...host.DEFAULTS, ...options.base }
              return {
                get: () => ({ ...stored }),
                watch: (cb) => { calls.watchCb = cb; return () => {} },
                update: async (fields) => {
                  Object.assign(stored, fields)
                  calls.settingsUpdates.push(fields)
                },
                replace: async (fields) => {
                  for (const k of Object.keys(stored)) delete stored[k]
                  Object.assign(stored, fields)
                  calls.settingsReplaces.push(fields)
                },
              }
            },
          },
        })
      }
      return undefined
    },
  }
  return ctx
}

function dispose(ctx) {
  for (const cleanup of [...ctx.calls.cleanups].reverse()) {
    cleanup()
  }
  ctx.calls.cleanups.length = 0
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

// 1) no settings service -> entry config drives the cleanup, RPC still works
{
  const entry = { sessionsRoot, maxAgeDays: 7, intervalMinutes: 9, dryRun: true }
  const ctx = makeCtx({ withSettings: false })
  const applied = host.apply(ctx, entry)
  if (applied !== undefined) {
    throw new Error(`apply must return undefined (returning a thenable breaks cordis loading), got ${typeof applied}`)
  }
  await settle()
  if (ctx.calls.info.length === 0) throw new Error('startup cleanup tick must run from the entry config')
  if (!ctx.calls.info[0][0].includes('scanned=')) throw new Error(`tick summary missing: ${ctx.calls.info[0]}`)
  if (ctx.calls.registered !== null) throw new Error('no settings service must not register a namespace')
  if (ctx.calls.rpcHandles.length !== 1) throw new Error(`rpc.handle must be called once, got ${ctx.calls.rpcHandles.length}`)
  if (ctx.calls.rpcHandles[0].channel !== '/session-cleanup') {
    throw new Error(`rpc channel mismatch: ${ctx.calls.rpcHandles[0].channel}`)
  }
  const handler = ctx.calls.rpcHandles[0].handler
  const got = await handler('getConfig', { args: {} })
  if (!got.ok || got.value.maxAgeDays !== 7) throw new Error(`getConfig without settings: ${JSON.stringify(got)}`)
  const set = await handler('setConfig', { args: { fields: { maxAgeDays: 3 } } })
  if (set.ok || set.error.code !== 'settings-unavailable') {
    throw new Error(`setConfig without settings must report settings-unavailable: ${JSON.stringify(set)}`)
  }
  const before = ctx.calls.info.length
  dispose(ctx)
  if (ctx.calls.rpcHandles.length !== 0) throw new Error('dispose must remove the /session-cleanup channel')
  if (ctx.calls.info.length !== before) {
    throw new Error('dispose must not rebuild the timer (settings fallback onChange guarded)')
  }
  console.log('host OK: entry-config fallback (no settings) + RPC channel + unload guards')
}

// 2) settings service -> namespace registered, watch rebuilds the timer, RPC writes through the scope
{
  const entry = { sessionsRoot, maxAgeDays: 7, intervalMinutes: 9, dryRun: true }
  const ctx = makeCtx({ withSettings: true })
  host.apply(ctx, entry)
  await settle()
  if (ctx.calls.registered === null || ctx.calls.registered.ns !== 'session-cleanup') {
    throw new Error(`namespace not registered: ${JSON.stringify(ctx.calls.registered)}`)
  }
  if (ctx.calls.registered.options.base !== entry) throw new Error('entry config must be the composition base')
  if (ctx.calls.info.length === 0) throw new Error('startup tick must run with settings present')
  const before = ctx.calls.info.length
  ctx.calls.watchCb()
  await settle()
  if (ctx.calls.info.length <= before) throw new Error('watch change must rebuild the timer (startup tick again)')

  const handler = ctx.calls.rpcHandles[0].handler
  const set = await handler('setConfig', { args: { fields: { maxAgeDays: 3 } } })
  if (!set.ok || set.value.maxAgeDays !== 3) throw new Error(`setConfig through the scope: ${JSON.stringify(set)}`)
  if (ctx.calls.settingsUpdates.length !== 1 || ctx.calls.settingsUpdates[0].maxAgeDays !== 3) {
    throw new Error(`settings update not written: ${JSON.stringify(ctx.calls.settingsUpdates)}`)
  }
  const reset = await handler('resetConfig', { args: {} })
  if (!reset.ok) throw new Error(`resetConfig: ${JSON.stringify(reset)}`)
  if (ctx.calls.settingsReplaces.length !== 1) throw new Error('settings replace not called by resetConfig')

  const afterWatch = ctx.calls.info.length
  dispose(ctx)
  if (ctx.calls.rpcHandles.length !== 0) throw new Error('dispose must remove the rpc channel')
  if (ctx.calls.info.length !== afterWatch) {
    throw new Error('dispose must not rebuild the timer (isUnloading guard)')
  }
  ctx.calls.watchCb()
  await new Promise((resolve) => setTimeout(resolve, 50))
  if (ctx.calls.info.length !== afterWatch) {
    throw new Error('watch callback after dispose must be guarded too')
  }
  console.log('host OK: settings namespace + watch rebuild + RPC writes + isUnloading guards')
}

rmSync(sessionsRoot, { recursive: true, force: true })

// --- client half: bundle + contract checks --------------------------------------
let JSDOM = null
try {
  JSDOM = require('jsdom').JSDOM
} catch { /* render section skipped below */ }

const React = require('react')

let dom = null
let handoff = null
const bundleSource = readFileSync(clientPath, 'utf8')
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

const icon = (props) => React.createElement('svg', { ...props, 'data-icon': true })
const requireTable = (spec) => {
  if (spec === 'react') return React
  if (spec === 'react/jsx-runtime') return require('react/jsx-runtime')
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
const rpcCalls = []
let cardConfig = {
  enabled: true, maxAgeDays: 45, maxTotalMB: 1024, keepSessions: 5,
  intervalMinutes: 360, dryRun: false, sessionsRoot: '',
}
const baseConfig = { enabled: true, maxAgeDays: 30 }
const clientCtx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => { dictionaries = { ns, dicts } },
    bind: () => (key) => 't:' + key,
  },
  connection: {
    rpc: {
      call: async (channel, endpoint, payload) => {
        rpcCalls.push({ channel, endpoint, payload })
        if (endpoint === 'getConfig') return { ok: true, value: { ...cardConfig } }
        if (endpoint === 'setConfig') {
          Object.assign(cardConfig, payload.args.fields)
          return { ok: true, value: { ...cardConfig } }
        }
        if (endpoint === 'resetConfig') {
          cardConfig = { ...baseConfig }
          return { ok: true, value: { ...cardConfig } }
        }
        return { ok: false, error: { code: 'bad-request', message: `unknown endpoint: ${endpoint}` } }
      },
    },
  },
  slots: {
    inject: (_key, callback) => { registered = callback() },
    register: (options, component) => ({ ...options, component }),
  },
}
exports_.apply(clientCtx)
if (registered === null) throw new Error('slots.inject never registered')
if (registered.key !== 'session-cleanup') {
  throw new Error(`card registration mismatch: ${JSON.stringify(registered)}`)
}
if (dictionaries === null || dictionaries.ns !== exports_.NS) throw new Error('dictionaries not registered')
const zhKeys = Object.keys(dictionaries.dicts.zh)
const enKeys = Object.keys(dictionaries.dicts.en)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  throw new Error(`zh/en key mismatch:\nzh: ${zhKeys}\nen: ${enKeys}`)
}
console.log(`apply contract OK: settings.plugin.item key=session-cleanup | dict keys = ${zhKeys.length}`)

// cardApi RPC flow: the card reads/writes config through /session-cleanup
{
  const api = registered.inject()
  const got = await api.getConfig()
  if (got.maxAgeDays !== 45) throw new Error(`cardApi getConfig: ${JSON.stringify(got)}`)
  const set = await api.setConfig({ maxAgeDays: 60 })
  if (set.maxAgeDays !== 60) throw new Error(`cardApi setConfig: ${JSON.stringify(set)}`)
  const reset = await api.resetConfig()
  if (reset.maxAgeDays !== 30) throw new Error(`cardApi resetConfig: ${JSON.stringify(reset)}`)
  const [g, s, r] = rpcCalls
  if (g.channel !== '/session-cleanup' || g.endpoint !== 'getConfig' || JSON.stringify(g.payload) !== '{"args":{}}') {
    throw new Error(`getConfig rpc: ${JSON.stringify(g)}`)
  }
  if (s.channel !== '/session-cleanup' || s.endpoint !== 'setConfig' || JSON.stringify(s.payload) !== '{"args":{"fields":{"maxAgeDays":60}}}') {
    throw new Error(`setConfig rpc: ${JSON.stringify(s)}`)
  }
  if (r.channel !== '/session-cleanup' || r.endpoint !== 'resetConfig' || JSON.stringify(r.payload) !== '{"args":{}}') {
    throw new Error(`resetConfig rpc: ${JSON.stringify(r)}`)
  }
  console.log('cardApi OK: getConfig/setConfig/resetConfig go through the /session-cleanup RPC channel')
}

// --- render + interact (jsdom; skipped when jsdom is missing) --------------------
if (JSDOM === null) {
  console.log('client DOM sections SKIPPED (jsdom not installed; run `npm install` in the patch dir)')
} else {
  const { act } = React
  const { createRoot } = require('react-dom/client')
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const en = dictionaries.dicts.en
  const t = (key) => en[key]
  const doc = dom.window.document

  // Reset mock state so the render flow starts from a pristine card.
  rpcCalls.length = 0
  cardConfig = {
    enabled: true, maxAgeDays: 45, maxTotalMB: 1024, keepSessions: 5,
    intervalMinutes: 360, dryRun: false, sessionsRoot: '',
  }

  const fireClick = (el) => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  }
  const fireChange = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  }
  const waitFor = async (predicate, what) => {
    const deadline = Date.now() + 3000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }

  const root = createRoot(doc.getElementById('root'))
  await act(async () => {
    root.render(React.createElement(registered.component, { ...registered.inject(), t }))
  })
  await waitFor(() => doc.querySelector('.sc-header') !== null, 'card header (initial getConfig)')

  // the user override is visible and the body opens on click
  await act(async () => { fireClick(doc.querySelector('.sc-header')) })
  const inputs = [...doc.querySelectorAll('.sc-input')]
  if (inputs.length !== 5) throw new Error(`expected 5 number/text inputs, got ${inputs.length}`)
  const toggles = [...doc.querySelectorAll('.sc-toggle')]
  if (toggles.length !== 2) throw new Error(`expected 2 toggles, got ${toggles.length}`)
  const maxAgeInput = doc.querySelector('#sc-maxAgeDays')
  if (maxAgeInput === null || maxAgeInput.value !== '45') throw new Error(`override value: ${maxAgeInput?.value}`)

  // staged edit -> save writes the field through the /session-cleanup setConfig RPC
  await act(async () => { fireChange(maxAgeInput, '60') })
  if (!doc.querySelector('.sc-pending')) throw new Error('unsaved badge missing')
  const saveButton = doc.querySelector('.sc-save')
  if (saveButton === null || saveButton.disabled) throw new Error('save must be enabled with staged edits')
  await act(async () => { fireClick(saveButton) })
  await waitFor(() => rpcCalls.some((c) => c.endpoint === 'setConfig'), 'setConfig rpc call')
  const setCall = rpcCalls[rpcCalls.length - 1]
  if (setCall.channel !== '/session-cleanup' || JSON.stringify(setCall.payload) !== '{"args":{"fields":{"maxAgeDays":60}}}') {
    throw new Error(`save rpc: ${JSON.stringify(setCall)}`)
  }
  if (doc.querySelector('.sc-pending')) throw new Error('pending badge must clear after save')
  console.log('card OK: fields render, staged edit saves through setConfig RPC')

  // 恢复默认 (reset-all) writes through the resetConfig RPC
  const resetAllButton = [...doc.querySelectorAll('.sc-discard')].find((b) => b.textContent === en.resetAll)
  if (resetAllButton === undefined || resetAllButton.disabled) throw new Error('reset-all must be enabled after save')
  await act(async () => { fireClick(resetAllButton) })
  await waitFor(() => rpcCalls.some((c) => c.endpoint === 'resetConfig'), 'resetConfig rpc call')
  const resetCall = rpcCalls[rpcCalls.length - 1]
  if (resetCall.channel !== '/session-cleanup' || JSON.stringify(resetCall.payload) !== '{"args":{}}') {
    throw new Error(`reset rpc: ${JSON.stringify(resetCall)}`)
  }
  console.log('card OK: reset-all calls the resetConfig RPC')

  await act(async () => { root.unmount() })
}

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
