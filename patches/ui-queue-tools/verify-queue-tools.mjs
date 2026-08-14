/**
 * Functional harness for the user-level ui-queue-tools patch.
 *
 * Host half: imports the real `lib/index.js`, applies it to a mock Cordis
 * context (fake Connection + fake agents), and exercises the `/queue` channel
 * contract plus the reorder semantics against a mock Inbox with real splice
 * behavior.
 *
 * Client half: loads the exact deployed `lib/client.js` the browser will
 * execute, asserts the shadow registration (same slot id, lower priority),
 * renders the enhanced dock in jsdom and checks the full-text hover title and
 * the move-up/move-down buttons issuing the right reorder RPC.
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
const PLUGIN_ID = '@local/dsh-client-ui-queue-tools'

// --- host half: /queue channel + reorder semantics ----------------------------
const host = await import(pathToFileURL(hostPath).href)

function makeInbox(ids) {
  const nextTurn = ids.map((id) => ({ id }))
  const nextStep = []
  return {
    nextTurn,
    nextStep,
    splice(target, start, deleteCount, inserted) {
      const list = target === 'next-turn' ? this.nextTurn : this.nextStep
      const removed = list.splice(start, deleteCount, ...inserted)
      return removed
    },
  }
}

// reorderQueueItem unit checks (each scenario uses a fresh inbox)
{
  let inbox = makeInbox(['a', 'b', 'c'])
  let r = host.reorderQueueItem({ inbox }, 'a', 1)
  if (!r.ok || inbox.nextTurn.map((m) => m.id).join('') !== 'bac') throw new Error(`down-move: ${JSON.stringify(inbox.nextTurn)}`)

  inbox = makeInbox(['a', 'b', 'c'])
  r = host.reorderQueueItem({ inbox }, 'c', 1)
  if (!r.ok || inbox.nextTurn.map((m) => m.id).join('') !== 'acb') throw new Error(`up-move: ${JSON.stringify(inbox.nextTurn)}`)

  inbox = makeInbox(['a', 'b', 'c'])
  r = host.reorderQueueItem({ inbox }, 'c', 0)
  if (!r.ok || inbox.nextTurn.map((m) => m.id).join('') !== 'cab') throw new Error(`move-top: ${JSON.stringify(inbox.nextTurn)}`)

  inbox = makeInbox(['a', 'b', 'c'])
  r = host.reorderQueueItem({ inbox }, 'a', 99)
  if (!r.ok || inbox.nextTurn.map((m) => m.id).join('') !== 'bca') throw new Error(`move-bottom: ${JSON.stringify(inbox.nextTurn)}`)

  inbox = makeInbox(['a', 'b', 'c'])
  r = host.reorderQueueItem({ inbox }, 'nope', 0)
  if (r.ok || r.error.code !== 'queue-item-not-found') throw new Error('missing item must be not-found')

  inbox = makeInbox(['x'])
  r = host.reorderQueueItem({ inbox }, 'x', 0)
  if (!r.ok || inbox.nextTurn.map((m) => m.id).join('') !== 'x') throw new Error('single-item no-op')

  inbox = makeInbox([])
  inbox.nextStep.push({ id: 's1' })
  r = host.reorderQueueItem({ inbox }, 's1', 0)
  if (!r.ok || inbox.nextStep.map((m) => m.id).join('') !== 's1') throw new Error('next-step item no-op reorder')
  console.log('reorderQueueItem OK: down/up/top/bottom/not-found/no-op/next-step')
}

let handled = null
const fakeAgents = { get: () => undefined }
let hostInjected = null
const hostCtx = {
  inject: (services, callback) => {
    hostInjected = services
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
host.apply(hostCtx)
if (hostInjected === null || hostInjected.join(',') !== 'connection,agents') throw new Error(`host inject mismatch: ${hostInjected}`)
if (handled === null || handled.channel !== '/queue') throw new Error(`host channel mismatch: ${JSON.stringify(handled)}`)
if (handled.options.authority !== 'loopback') throw new Error(`host authority mismatch: ${handled.options.authority}`)

const unknown = await handled.handler('nope', { args: {} })
if (unknown.ok !== false || unknown.error.code !== 'bad-request') throw new Error('unknown endpoint must be rejected')
const badArgs = await handled.handler('reorder', { args: { sessionId: 's', itemId: 'm' } })
if (badArgs.ok !== false || badArgs.error.code !== 'bad-request') throw new Error('missing toIndex must be rejected')
const noAgent = await handled.handler('reorder', { args: { sessionId: 's', itemId: 'm', toIndex: 0 } })
if (noAgent.ok !== false || noAgent.error.code !== 'queue-item-not-found') throw new Error('absent agent must be not-found')

// live-agent path through the channel handler
let liveAgent = { inbox: makeInbox(['a', 'b', 'c']) }
fakeAgents.get = () => liveAgent
const live = await handled.handler('reorder', { args: { sessionId: 's', itemId: 'a', toIndex: 2 } })
if (!live.ok || liveAgent.inbox.nextTurn.map((m) => m.id).join('') !== 'bca') throw new Error(`channel reorder: ${JSON.stringify(liveAgent.inbox.nextTurn)}`)
console.log('host contract OK: /queue channel, validation, live reorder through channel')

// --- client half: jsdom environment -------------------------------------------
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
    const Tooltip = ({ children }) => children
    return {
      IconChevronDownOutline14: icon,
      IconChevronUpOutline14: icon,
      IconCloseOutline16: icon,
      IconEditOutline16: icon,
      IconQueueOutline14: icon,
      IconSendOutline14: icon,
      IconTrashOutline16: icon,
      IconCheckOutline16: icon,
      Tooltip,
    }
  }
  throw new Error(`unexpected module-table word: ${spec}`)
}
const exports_ = handoff.factory(requireTable)

if (typeof exports_.apply !== 'function' || !Array.isArray(exports_.inject)) throw new Error('exports contract broken')
if (exports_.NS !== 'queue.tools') throw new Error(`NS mismatch: ${exports_.NS}`)
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

let registered = null
let dictionaries = null
let rpcCalls = []
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
        return { ok: true, value: { accepted: true } }
      },
    },
  },
  sessions: { scope: () => ({ get: () => ({ updateQueue: async () => {}, input: { for: () => ({ notify: () => {} }) } }) }) },
  slots: {
    inject: (_key, callback) => { registered = callback() },
    register: (options, component) => ({ ...options, component }),
  },
}
exports_.apply(clientCtx)
if (registered === null) throw new Error('slots.inject never registered')
if (registered.id !== 'queue' || registered.order !== 20 || registered.priority !== -10) {
  throw new Error(`shadow registration mismatch: ${JSON.stringify(registered)}`)
}
if (dictionaries === null || dictionaries.ns !== exports_.NS) throw new Error('dictionaries not registered')
const zhKeys = Object.keys(dictionaries.dicts.zh)
const enKeys = Object.keys(dictionaries.dicts.en)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) throw new Error(`zh/en key mismatch:\nzh: ${zhKeys}\nen: ${enKeys}`)
console.log('apply contract OK: id=queue order=20 priority=-10 | dict keys =', zhKeys.length)

// --- render + interact ----------------------------------------------------------
const { act } = React
const { createRoot } = uiRequire('react-dom/client')
const { fireEvent } = repoRequire('@testing-library/react')
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const en = dictionaries.dicts.en
const rows = [
  { id: 'm1', placement: 'queued', preview: 'short one…', text: 'short one' },
  { id: 'm2', placement: 'queued', preview: 'second message…', text: 'second message' },
]
const root = createRoot(dom.window.document.getElementById('root'))
const injected = registered.inject('session-1')
await act(async () => {
  root.render(React.createElement(registered.component, {
    useSession: (select) => select({ queue: rows, running: false, subagent: null }),
    updateQueue: injected.updateQueue,
    notify: () => {},
    reorder: injected.reorder,
    t: (key, params) => {
      const value = en[key]
      return params && params.n !== undefined ? value.replace('{n}', String(params.n)) : value
    },
  }))
})

const doc = dom.window.document

// two rows: dock renders collapsed — expand via the header first
const header = doc.querySelector('.qt-header')
if (header === null) throw new Error('collapsed header missing')
if (doc.querySelectorAll('.qt-preview').length !== 0) throw new Error('rows must be hidden while collapsed')
await act(async () => { fireEvent.click(header) })

const previews = [...doc.querySelectorAll('.qt-preview')]
if (previews.length !== 2) throw new Error(`expected 2 previews, got ${previews.length}`)
if (previews[0].getAttribute('title') !== 'short one') throw new Error(`hover title: ${previews[0].getAttribute('title')}`)
if (previews[1].getAttribute('title') !== 'second message') throw new Error('hover title for second row missing')
console.log('hover full-text preview OK (title = full text)')

const moveUpButtons = [...doc.querySelectorAll('[aria-label="' + en.moveUp + '"]')]
const moveDownButtons = [...doc.querySelectorAll('[aria-label="' + en.moveDown + '"]')]
if (moveUpButtons.length !== 2 || moveDownButtons.length !== 2) {
  throw new Error(`move buttons: up=${moveUpButtons.length} down=${moveDownButtons.length}`)
}
if (moveUpButtons[0].disabled !== true) throw new Error('first row move-up must be disabled')
if (moveDownButtons[1].disabled !== true) throw new Error('last row move-down must be disabled')

rpcCalls = []
await act(async () => { fireEvent.click(moveDownButtons[0]) })
if (rpcCalls.length !== 1) throw new Error(`expected 1 RPC call, got ${rpcCalls.length}`)
const call = rpcCalls[0]
if (call.channel !== '/queue' || call.endpoint !== 'reorder') throw new Error(`RPC target: ${JSON.stringify(call)}`)
if (call.payload.args.sessionId !== 'session-1' || call.payload.args.itemId !== 'm1' || call.payload.args.toIndex !== 1) {
  throw new Error(`RPC args: ${JSON.stringify(call.payload)}`)
}
console.log('move-down OK: /queue reorder RPC with (session-1, m1, 1)')

rpcCalls = []
await act(async () => { fireEvent.click(moveUpButtons[1]) })
if (call.payload) {} // no-op keep lint quiet
if (rpcCalls.length !== 1 || rpcCalls[0].payload.args.itemId !== 'm2' || rpcCalls[0].payload.args.toIndex !== 0) {
  throw new Error(`move-up RPC args: ${JSON.stringify(rpcCalls[0]?.payload)}`)
}
console.log('move-up OK: /queue reorder RPC with (session-1, m2, 0)')

// single row: no reorder controls
await act(async () => {
  root.render(React.createElement(registered.component, {
    useSession: (select) => select({ queue: [rows[0]], running: false, subagent: null }),
    updateQueue: injected.updateQueue,
    notify: () => {},
    reorder: injected.reorder,
    t: (key, params) => {
      const value = en[key]
      return params && params.n !== undefined ? value.replace('{n}', String(params.n)) : value
    },
  }))
})
if (doc.querySelectorAll('.qt-action-group').length !== 0) throw new Error('single-row queue must not render reorder controls')
console.log('single-row queue hides reorder controls OK')

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
