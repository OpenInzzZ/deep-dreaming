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
  console.log('host helpers OK: resolveRestartScript + buildRestartSpawn')
}

let handled = null
let injected = null
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
    }
    return callback(fakeConnectionCtx)
  },
}
// config.script points at a NON-EXISTENT path so the restart endpoint fails
// cleanly (script-missing branch) instead of spawning a real restart.
const MISSING_SCRIPT = 'C:\\__no_such_dir__\\restart-dsh.ps1'
host.apply(hostCtx, { script: MISSING_SCRIPT })
if (injected === null || injected.services.join(',') !== 'connection') throw new Error('host inject mismatch')
if (handled === null || handled.channel !== '/app') throw new Error(`host channel mismatch: ${JSON.stringify(handled)}`)
if (handled.options.authority !== 'loopback') throw new Error(`host authority mismatch: ${handled.options.authority}`)
console.log('host contract OK: /app channel, authority = loopback')

const unknown = await handled.handler('nope', {})
if (unknown.ok !== false || unknown.error.code !== 'bad-request') throw new Error('unknown endpoint must be rejected')
console.log('host endpoint validation OK: unknown endpoint -> bad-request')

const missingScript = await handled.handler('restart', {})
if (missingScript.ok !== false || missingScript.error.code !== 'internal') {
  throw new Error(`missing script must fail cleanly: ${JSON.stringify(missingScript)}`)
}
if (!missingScript.error.message.includes('restart script not found')) throw new Error('missing-script message unhelpful')
console.log('host endpoint validation OK: restart without script -> internal (never spawns)')

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
let rpcTarget = null
const clientCtx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => { dictionaries = { ns, dicts } },
    bind: () => (key) => 't:' + key,
  },
  connection: {
    rpc: {
      call: async (channel, endpoint) => {
        rpcTarget = { channel, endpoint }
        return { ok: true, value: { scheduled: true, delayMs: 2600 } }
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
const root = createRoot(dom.window.document.getElementById('root'))
const restart = async () => {
  const result = await clientCtx.connection.rpc.call('/app', 'restart')
  return result.ok
}

await act(async () => {
  root.render(React.createElement(registered.component, { restart, t: (key) => en[key] }))
})

const doc = dom.window.document
const buttons = () => [...doc.querySelectorAll('.so-btn')]
const status = () => doc.querySelector('.so-status')

const restartButton = buttons().find((b) => b.textContent === en.restart)
if (restartButton === undefined) throw new Error('restart button missing')
if (buttons().length !== 1) throw new Error(`expected 1 button initially, got ${buttons().length}`)
console.log('initial render OK: restart button present')

// click -> confirm state (no call yet)
await act(async () => { fireEvent.click(restartButton) })
if (rpcTarget !== null) throw new Error('confirm state must not call the host yet')
const confirmButton = buttons().find((b) => b.textContent === en.confirm)
if (confirmButton === undefined) throw new Error('confirm button missing')
if (status() === null || status().textContent !== en.confirmPrompt) throw new Error('confirm prompt missing')
console.log('confirm state OK')

// cancel returns to idle
await act(async () => { fireEvent.click(buttons().find((b) => b.textContent === en.cancel)) })
if (buttons().length !== 1) throw new Error('cancel should restore single button')
console.log('cancel OK')

// confirm -> calling -> scheduled; host endpoint + payload shape
await act(async () => { fireEvent.click(buttons()[0]) })
await act(async () => { fireEvent.click(buttons().find((b) => b.textContent === en.confirm)) })
if (rpcTarget === null || rpcTarget.channel !== '/app' || rpcTarget.endpoint !== 'restart') {
  throw new Error(`rpc target mismatch: ${JSON.stringify(rpcTarget)}`)
}
if (status() === null || status().textContent !== en.scheduled) throw new Error('scheduled status missing')
console.log('restart flow OK: /app restart RPC + scheduled status')

// error state: host failure surfaces as error copy
const errorHost = dom.window.document.createElement('div')
const root2 = createRoot(errorHost)
await act(async () => {
  root2.render(React.createElement(registered.component, {
    restart: async () => { throw new Error('private detail') },
    t: (key) => en[key],
  }))
})
await act(async () => { fireEvent.click(errorHost.querySelector('.so-btn')) })
await act(async () => { fireEvent.click(errorHost.querySelector('.so-btn')) })
if (errorHost.querySelector('.so-status[data-tone="error"]') === null) throw new Error('error status missing')
if (errorHost.textContent.includes('private detail')) throw new Error('error state leaked transport detail')
console.log('error state OK')

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
