/**
 * Real-Cordis load smoke test for the ui-queue-tools host half.
 *
 * Loads `lib/index.js` through the ACTUAL Cordis runtime (`new Context()`,
 * `ctx.provide(...)`, `ctx.plugin(...)` / `await`), the same path the DSH
 * host uses. This is the authoritative check for the historical load bug:
 * `apply()` used to `return ctx.inject(...)`; real `ctx.inject()` returns a
 * Fiber wrapper (a PromiseLike resolving to the Fiber instance), Cordis
 * treats an apply return as an Effect, and `safeCollect(fiber)` throws
 * `TypeError('Invalid effect')` (fiber.ts `_execute`), failing the plugin
 * load. The mock-based verify script cannot catch this because a mock
 * `inject` returning the callback result masks the thenable semantics.
 *
 * @deepseek-ai/cordis resolution: this file has no local node_modules and ESM
 * `import` ignores NODE_PATH, so the package is located with createRequire
 * (CJS resolution honors NODE_PATH) in this order:
 *   1. standard ancestor node_modules of this patch;
 *   2. `$NODE_PATH` entries;
 *   3. the deployed profile junction tree
 *      `~/.dsh/profiles/node_modules` (on this machine the junctions point
 *      into the DSH checkout's node_modules).
 * The resolved entry is then imported via file URL. If resolution fails, run
 * with NODE_PATH pointing at a node_modules containing @deepseek-ai/cordis,
 * e.g.:
 *   NODE_PATH=C:\Users\98645\.dsh\profiles\node_modules node patches/ui-queue-tools/tests/load-smoke.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, delimiter } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const patchDir = join(here, '..')
const hostPath = join(patchDir, 'lib', 'index.js')

function resolveCordisEntry() {
  const req = createRequire(import.meta.url)
  try {
    return req.resolve('@deepseek-ai/cordis')
  } catch {}
  for (const entry of (process.env.NODE_PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      return req.resolve(join(entry, '@deepseek-ai', 'cordis'))
    } catch {}
  }
  const profileEntry = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'cordis')
  try {
    return req.resolve(profileEntry)
  } catch {}
  throw new Error(
    "cannot resolve '@deepseek-ai/cordis' from this patch, $NODE_PATH, or the deployed profile " +
    'node_modules; run with NODE_PATH pointing at a node_modules that contains it ' +
    '(e.g. C:\\Users\\98645\\.dsh\\profiles\\node_modules)',
  )
}

const { Context } = await import(pathToFileURL(resolveCordisEntry()).href)
const host = await import(pathToFileURL(hostPath).href)

// --- provide the injected services, then load the plugin for real -------------
const ctx = new Context()

const handleCalls = []
const connectionStub = {
  rpc: {
    handle: (channel, handler, options) => {
      handleCalls.push({ channel, handler, options })
      return () => {
        handleCalls.splice(handleCalls.findIndex((c) => c.channel === channel), 1)
      }
    },
  },
}
const agentsStub = {
  get: () => undefined,
  list: () => [],
}

ctx.provide('connection', connectionStub)
ctx.provide('agents', agentsStub)

// DSH's host runner (dsh-cordis-host-runner, `guardedPlugin()`) never hands a
// bare function to ctx.plugin: it wraps every plugin as a plain OBJECT whose
// `apply` METHOD delegates to the original. That shape is what makes Cordis
// call apply as a FUNCTION — a bare `ctx.plugin(lib/index.js)` would make
// Cordis take the `isConstructor` -> `new` branch for the function
// declaration and silently ignore its return. Reproduce the DSH load shape.
const guarded = {
  name: 'ui-queue-tools',
  apply(ctx) {
    return host.apply(ctx)
  },
}

// Same call the DSH host loader makes: ctx.plugin(plugin) -> resolve ->
// apply(ctx). `await` settles once loading finished; with the historical bug
// this rejects with TypeError('Invalid effect').
const fiber = ctx.plugin(guarded)
await fiber

// The inner ctx.inject(['connection','agents'], ...) fiber starts on a
// microtask after apply(); wait (bounded) until the /queue handler is up.
const deadline = Date.now() + 2000
while (handleCalls.length === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

assert.equal(handleCalls.length, 1, 'rpc.handle must be called exactly once for /queue')
assert.equal(handleCalls[0].channel, '/queue')
assert.equal(handleCalls[0].options.authority, 'loopback')

// The registered handler is the real one and still works end-to-end.
const result = await handleCalls[0].handler('reorder', { args: { sessionId: 's', itemId: 'm', toIndex: 0 } })
assert.equal(result.ok, false)
assert.equal(result.error.code, 'queue-item-not-found')

await fiber.dispose()
assert.equal(handleCalls.length, 0, 'dispose must run the /queue channel disposer')

console.log('load-smoke OK: real Cordis ctx.plugin() loaded lib/index.js, /queue handler registered, no TypeError("Invalid effect")')
