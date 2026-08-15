/**
 * Contract check for the dom-inspect browser half.
 *
 * Loads the exact deployed `lib/client.js`, asserts the module-table handoff
 * and exports, then — with jsdom — verifies `collect()` projects the
 * memory-related DOM into leaf-field snapshots and that `apply()` wires the
 * `/dom-inspect` push RPC (with a stubbed timer so the poll does not run).
 *
 * Run from the repo root:
 *   node patches/dom-inspect/tests/client-contract.mjs
 * (jsdom optional: without it the collect/apply sections are skipped.)
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const patchDir = join(here, '..')
const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? ''
const uiRequire = createRequire(join(userProfile, '.dsh', 'profiles', 'web', 'package.json'))

let JSDOM = null
try {
  JSDOM = uiRequire('jsdom').JSDOM
} catch { /* collect/apply sections skipped below */ }

const clientPath = join(patchDir, 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-plugin-dom-inspect'

// --- load the bundle exactly like the shell kernel does ----------------------
let handoff = null
const bundleSource = readFileSync(clientPath, 'utf8')
if (JSDOM !== null) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:3080/' })
  globalThis.window = dom.window
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (!(key in globalThis)) globalThis[key] = dom.window[key]
  }
  dom.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
  new Function('window', 'document', bundleSource)(dom.window, dom.window.document)
} else {
  const shimDocument = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ dataset: {}, setAttribute: () => {}, appendChild: () => {} }),
    head: { appendChild: () => {} },
  }
  const shimWindow = { __ModuleLoader__: { load: (h) => { handoff = h } } }
  new Function('window', 'document', bundleSource)(shimWindow, shimDocument)
}
if (handoff === null) throw new Error('bundle never called __ModuleLoader__.load')
if (handoff.id !== PLUGIN_ID) throw new Error(`handoff id mismatch: ${handoff.id}`)

const exports_ = handoff.factory((spec) => {
  throw new Error(`unexpected module-table word: ${spec}`)
})
if (typeof exports_.apply !== 'function') throw new Error('exports.apply missing')
if (JSON.stringify(exports_.inject) !== JSON.stringify(['connection'])) {
  throw new Error(`exports.inject mismatch: ${JSON.stringify(exports_.inject)}`)
}
if (typeof exports_.collect !== 'function') throw new Error('exports.collect missing')
console.log('exports contract OK:', JSON.stringify(exports_.inject))

if (JSDOM === null) {
  console.log('\ncollect/apply sections SKIPPED (jsdom not installed)')
  console.log('ALL CONTRACT CHECKS PASSED (install jsdom to enable the DOM sections)')
  process.exit(0)
}

// --- collect(): fixed groups projected to leaf fields --------------------------
const doc = window.document
const root = doc.getElementById('root')
root.innerHTML =
  '<div data-memory-card data-state="ok">' +
    '<div data-disclosure-row aria-expanded="false">' +
      '<span class="pmem-title">记忆 · 保存/更新</span>' +
      '<span class="pmem-summary">已保存:测试笔记</span>' +
      '<span class="pmem-keywords">测试、笔记</span>' +
    '</div>' +
  '</div>' +
  '<div data-disclosure-row aria-expanded="true"><span class="pmem-summary">记忆 · 检索运行中…</span></div>'

const snapshot = exports_.collect()
const cards = snapshot.groups['memory-cards']
if (cards.length !== 1) throw new Error(`memory-cards count: ${cards.length}`)
if (cards[0].tag !== 'div' || cards[0].data?.state !== 'ok') throw new Error(`card projection: ${JSON.stringify(cards[0])}`)
if (!cards[0].text.includes('已保存:测试笔记')) throw new Error(`card text: ${cards[0].text}`)
const rows = snapshot.groups['disclosure-rows']
if (rows.length !== 2) throw new Error(`disclosure-rows count: ${rows.length}`)
if (rows[0].expanded !== 'false' || rows[1].expanded !== 'true') throw new Error('aria-expanded must be projected')
const summaries = snapshot.groups['pmem-summaries']
if (summaries.length !== 2 || !summaries[0].text.includes('已保存')) throw new Error(`summaries: ${JSON.stringify(summaries)}`)
const keywords = snapshot.groups['pmem-keywords']
if (keywords.length !== 1 || !keywords[0].text.includes('测试、笔记')) throw new Error(`keywords: ${JSON.stringify(keywords)}`)
console.log('collect OK: memory cards / disclosure rows / summaries / keywords projected to leaf fields')

// --- apply(): pushes the initial snapshot over /dom-inspect ---------------------
const pushes = []
let intervalFn = null
const realSetInterval = globalThis.setInterval
const clientCtx = {
  connection: {
    rpc: { call: async (channel, endpoint, payload) => { pushes.push({ channel, endpoint, payload }) ; return { ok: true } } },
  },
  effect: (fn) => { fn(); return () => {} },
}
globalThis.setInterval = (fn, ms) => { intervalFn = fn; return 1 }
exports_.apply(clientCtx)
globalThis.setInterval = realSetInterval
if (pushes.length !== 1) throw new Error(`initial push count: ${pushes.length}`)
if (pushes[0].channel !== '/dom-inspect' || pushes[0].endpoint !== 'push') throw new Error(`push target: ${JSON.stringify(pushes[0])}`)
if (pushes[0].payload.args.snapshot.groups['memory-cards'].length !== 1) throw new Error('initial push must carry the snapshot')
if (typeof intervalFn !== 'function') throw new Error('poll interval must be scheduled')
console.log('apply OK: initial snapshot pushed over /dom-inspect, 2s poll scheduled')

console.log('\nALL CLIENT CONTRACT CHECKS PASSED')
process.exit(0)
