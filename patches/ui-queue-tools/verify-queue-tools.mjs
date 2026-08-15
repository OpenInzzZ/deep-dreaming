/**
 * Functional harness for the user-level ui-queue-tools patch.
 *
 * Host half: imports the real `lib/index.js`, applies it to a mock Cordis
 * context (fake Connection + fake agents) and exercises the `/queue` channel
 * contract plus the reorder semantics against a mock Inbox with real splice
 * behavior. The mock `inject` mirrors real Cordis's thenable Fiber return, so
 * the historical "apply returned ctx.inject(...)" bug is caught here instead
 * of being masked by a synchronous mock (real Cordis rejects such a return
 * with `TypeError('Invalid effect')` — see also the real-load smoke test in
 * tests/load-smoke.mjs).
 *
 * Client half: loads the exact deployed `lib/client.js` the browser will
 * execute and asserts the shadow registration (same slot id, lower priority)
 * plus the dictionary key parity. The jsdom render/interaction checks
 * (full-text hover title, drag reorder RPC, multiline edit, single-row
 * affordance) run only when `jsdom` and `@testing-library/react` resolve from
 * the deployed profile node_modules or NODE_PATH; otherwise those interaction
 * checks are skipped with a notice. The DOM-free contract checks always run.
 *
 * No hardcoded machine paths: the browser packages are resolved from
 * `~/.dsh/profiles/node_modules` (derived from the current user's home).
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, delimiter } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const hostPath = join(here, 'lib', 'index.js')
const clientPath = join(here, 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-client-ui-queue-tools'

// Browser packages live in the DEPLOYED profile's node_modules (junction
// tree). Anchor there by deriving from the current user's home.
const profilesNm = join(homedir(), '.dsh', 'profiles', 'node_modules')
const profilesUrl = pathToFileURL(join(profilesNm, 'package.json')).href
const uiRequire = createRequire(profilesUrl)

/** Resolve `spec` from the patch dir, the profile node_modules, or NODE_PATH. */
function tryResolve(spec) {
  for (const base of [import.meta.url, profilesUrl]) {
    try {
      return createRequire(base).resolve(spec)
    } catch {}
  }
  for (const entry of (process.env.NODE_PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      return createRequire(pathToFileURL(join(entry, 'package.json')).href).resolve(spec)
    } catch {}
  }
  return undefined
}

/** CJS-compatible `import()`: prefer the default export, else the namespace. */
async function loadCjs(resolvedPath) {
  const mod = await import(pathToFileURL(resolvedPath).href)
  return mod.default ?? mod
}

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
let hostInjected = null
const fakeAgents = { get: () => undefined }
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
    // Run the callback synchronously so the endpoint logic below can exercise
    // the real handler. Real Cordis would schedule the callback only after the
    // services appear; the synchronous run is a harness convenience, NOT a
    // model of Cordis. The thenable returned below IS the model: real
    // `ctx.inject()` (registry.inject -> registry.plugin) returns a Fiber
    // wrapper — a PromiseLike resolving to the Fiber instance — and `apply()`
    // returning it is exactly the historical load failure.
    callback(fakeConnectionCtx)
    return { then: () => {} }
  },
}
const applied = host.apply(hostCtx)
if (hostInjected === null || hostInjected.join(',') !== 'connection,agents') {
  throw new Error(`host inject mismatch: ${hostInjected}`)
}
if (applied !== undefined && applied !== null && typeof applied.then === 'function') {
  throw new Error('apply() returned a thenable (the ctx.inject "return" bug): real Cordis would throw TypeError("Invalid effect")')
}
if (applied !== undefined) throw new Error(`apply() must return nothing; got ${String(applied)}`)
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

// --- client half ----------------------------------------------------------------
const reactPath = tryResolve('react')
const jsdomPath = tryResolve('jsdom')
const testingLibraryPath = tryResolve('@testing-library/react')
const domAvailable = reactPath !== undefined && jsdomPath !== undefined && testingLibraryPath !== undefined

if (reactPath === undefined) {
  console.warn(`SKIP client half: 'react' not resolvable from ${profilesNm} or NODE_PATH`)
} else {
  let handoff = null
  let documentObj
  if (domAvailable) {
    // Full jsdom environment: bundle CSS injection + real DOM interaction.
    const { JSDOM } = await loadCjs(jsdomPath)
    const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
      url: 'http://127.0.0.1:3080/',
    })
    globalThis.window = dom.window
    documentObj = dom.window.document
    for (const key of Object.getOwnPropertyNames(dom.window)) {
      if (!(key in globalThis)) globalThis[key] = dom.window[key]
    }
    dom.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
  } else {
    // DOM-free contract check: only the bundle handoff needs a window; the
    // CSS injection IIFE is guarded by `typeof document === 'undefined'`.
    globalThis.window = { __ModuleLoader__: { load: (h) => { handoff = h } } }
    documentObj = undefined
  }

  const bundleSource = readFileSync(clientPath, 'utf8')
  const evaluate = new Function('window', 'document', bundleSource)
  evaluate(globalThis.window, documentObj)
  if (handoff === null) throw new Error('bundle never called __ModuleLoader__.load')
  if (handoff.id !== PLUGIN_ID) throw new Error(`handoff id mismatch: ${handoff.id}`)

  const React = uiRequire('react')
  const icon = (props) => React.createElement('svg', { ...props, 'data-icon': true })
  // Behavior-equivalent Tooltip: hover shows after delayMs, keyboard focus is
  // immediate — mirroring the shipped @deepseek-ai/dsh-client-ui-primitives
  // Tooltip (its node half cannot load in Node because it pulls katex CSS).
  const TooltipStub = ({ label, delayMs = 0, disabled = false, children }) => {
    const [visible, setVisible] = React.useState(false)
    const timer = React.useRef(null)
    return React.createElement(React.Fragment, null,
      React.cloneElement(children, {
        onMouseEnter: (event) => {
          children.props.onMouseEnter?.(event)
          if (disabled) return
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setVisible(true), delayMs)
        },
        onMouseLeave: (event) => {
          children.props.onMouseLeave?.(event)
          clearTimeout(timer.current)
          setVisible(false)
        },
        onFocus: (event) => {
          children.props.onFocus?.(event)
          if (!disabled) setVisible(true)
        },
        onBlur: (event) => {
          children.props.onBlur?.(event)
          setVisible(false)
        },
      }),
      visible && !disabled ? React.createElement('span', { role: 'tooltip' }, label) : null,
    )
  }

  const requireTable = (spec) => {
    if (spec === 'react') return uiRequire('react')
    if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        IconChevronDownOutline14: icon,
        IconChevronUpOutline14: icon,
        IconCloseOutline16: icon,
        IconEditOutline16: icon,
        IconQueueOutline14: icon,
        IconSendOutline14: icon,
        IconTrashOutline16: icon,
        IconCheckOutline16: icon,
        Tooltip: TooltipStub,
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
  let updateQueueCalls = []
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
    sessions: { scope: () => ({ get: () => ({ updateQueue: async (itemId, action) => { updateQueueCalls.push({ itemId, action }) }, input: { for: () => ({ notify: () => {} }) } }) }) },
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

  if (!domAvailable) {
    console.warn(`SKIP jsdom interaction checks: need 'jsdom' and '@testing-library/react' (tried ${profilesNm}, NODE_PATH)`)
  } else {
    // --- render + interact --------------------------------------------------------
    const { act } = React
    const { createRoot } = uiRequire('react-dom/client')
    const { fireEvent } = await loadCjs(testingLibraryPath)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true

    const dom = globalThis.window
    const en = dictionaries.dicts.en
    const rows = [
      { id: 'm1', placement: 'queued', preview: 'short one…', text: 'short one' },
      { id: 'm2', placement: 'queued', preview: 'second message…', text: 'second message' },
    ]
    const root = createRoot(dom.document.getElementById('root'))
    const injected = registered.inject('session-1')
    const renderProps = () => ({
      useSession: (select) => select({ queue: rows, running: false, subagent: null }),
      updateQueue: injected.updateQueue,
      notify: () => {},
      reorder: injected.reorder,
      t: (key, params) => {
        const value = en[key]
        return params && params.n !== undefined ? value.replace('{n}', String(params.n)) : value
      },
    })
    await act(async () => {
      root.render(React.createElement(registered.component, renderProps()))
    })

    const doc = dom.document

    // two rows: dock renders collapsed — expand via the header first
    const header = doc.querySelector('.qt-header')
    if (header === null) throw new Error('collapsed header missing')
    if (doc.querySelectorAll('.qt-preview').length !== 0) throw new Error('rows must be hidden while collapsed')
    await act(async () => { fireEvent.click(header) })

    // hover full-text preview uses the Tooltip affordance (same as action buttons)
    const previews = [...doc.querySelectorAll('.qt-preview')]
    if (previews.length !== 2) throw new Error(`expected 2 previews, got ${previews.length}`)
    if (previews[0].getAttribute('title') !== null) throw new Error('preview must not use the native title attribute')
    await act(async () => { fireEvent.mouseEnter(previews[0]) })
    await new Promise((resolve) => setTimeout(resolve, 600))
    await act(async () => {})
    const bubbles = [...doc.querySelectorAll('[role="tooltip"]')]
    if (bubbles.length !== 1 || bubbles[0].textContent !== 'short one') {
      throw new Error(`hover bubble: ${bubbles.map((b) => b.textContent).join('|')}`)
    }
    await act(async () => { fireEvent.mouseLeave(previews[0]) })
    console.log('hover full-text preview OK (Tooltip bubble = full text)')

    // drag-to-reorder: drag m1 onto m2's row -> reorder(m1, index 1)
    const rowsEls = [...doc.querySelectorAll('.qt-row')]
    if (rowsEls.length !== 2) throw new Error(`expected 2 rows, got ${rowsEls.length}`)
    if (rowsEls[0].getAttribute('draggable') !== 'true') throw new Error('row must be draggable')
    rpcCalls = []
    await act(async () => { fireEvent.dragStart(rowsEls[0]) })
    await act(async () => { fireEvent.dragOver(rowsEls[1]) })
    if (rowsEls[1].classList.contains('qt-row-over') !== true) throw new Error('drag-over highlight missing')
    await act(async () => { fireEvent.drop(rowsEls[1]) })
    if (rpcCalls.length !== 1) throw new Error(`expected 1 reorder RPC, got ${rpcCalls.length}`)
    const call = rpcCalls[0]
    if (call.channel !== '/queue' || call.endpoint !== 'reorder') throw new Error(`RPC target: ${JSON.stringify(call)}`)
    if (call.payload.args.sessionId !== 'session-1' || call.payload.args.itemId !== 'm1' || call.payload.args.toIndex !== 1) {
      throw new Error(`RPC args: ${JSON.stringify(call.payload)}`)
    }
    console.log('drag reorder OK: drag m1 onto m2 -> /queue reorder (session-1, m1, 1)')

    // editing the row blurs the edit button (no lingering focus tooltip)
    await act(async () => {
      root.render(React.createElement(registered.component, renderProps()))
    })
    const editButton = [...doc.querySelectorAll('.qt-action')].find((b) => b.getAttribute('aria-label') === en.edit)
    if (editButton === undefined) throw new Error('edit button missing')
    // keyboard focus shows the tooltip immediately (shipped Tooltip semantics)
    await act(async () => { fireEvent.focus(editButton) })
    if (doc.querySelectorAll('[role="tooltip"]').length === 0) throw new Error('focus must show the edit tooltip immediately')
    await act(async () => { fireEvent.focusOut(editButton) })
    if (doc.querySelector('[role="tooltip"]') !== null) throw new Error('focusOut must hide the tooltip')
    // mouse click path: mousedown preventDefault keeps the button unfocused, so
    // no focus-triggered tooltip can pop up when the row swaps into edit mode
    await act(async () => { fireEvent.mouseDown(editButton) })
    await act(async () => { fireEvent.click(editButton) })
    if (doc.querySelector('[role="tooltip"]') !== null) throw new Error('clicking edit must not leave a focus tooltip in edit mode')
    const editor = doc.querySelector('.qt-editor')
    if (editor === null) throw new Error('editor missing after clicking edit')
    if (editor.tagName !== 'TEXTAREA') throw new Error('editor must be a textarea (multiline editing)')
    console.log('edit OK: no focus-triggered tooltip in edit mode; multiline textarea editor')

    // multiline editing: type a two-line message and submit with Enter
    updateQueueCalls = []
    await act(async () => { fireEvent.change(editor, { target: { value: 'line one\nline two' } }) })
    await act(async () => { fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true }) })
    if (updateQueueCalls.length !== 0) throw new Error('Shift+Enter must insert a newline, not submit')
    await act(async () => { fireEvent.keyDown(editor, { key: 'Enter' }) })
    if (updateQueueCalls.length !== 1) throw new Error('Enter must submit the edit')
    const editCall = updateQueueCalls[0]
    if (editCall.itemId !== 'm1' || editCall.action.kind !== 'edit') throw new Error(`edit call: ${JSON.stringify(editCall)}`)
    if (editCall.action.content[0].text !== 'line one\nline two') throw new Error('multiline text must be preserved in the edit action')
    console.log('multiline edit OK: Shift+Enter newline, Enter submits, text preserved')

    // single row: no reorder affordance (row not draggable)
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
    const singleRow = doc.querySelector('.qt-row')
    if (singleRow === null) throw new Error('single row missing')
    if (singleRow.getAttribute('draggable') === 'true') throw new Error('single-row queue must not be draggable')
    console.log('single-row queue hides reorder affordance OK')
  }
}

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
