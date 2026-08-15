/**
 * Real-Cordis load smoke test for the session-cleanup host half.
 *
 * Loads `session-cleanup.mjs` through the ACTUAL Cordis runtime (`new
 * Context()`, `ctx.provide(...)`, `ctx.plugin(...)` / `await`), the same path
 * the DSH host loader uses. This is the authoritative check for the historical
 * load bug: `apply()` used to `return ctx.inject(...)`; real `ctx.inject()`
 * returns a Fiber wrapper (a PromiseLike resolving to the Fiber instance),
 * Cordis treats an apply return as an Effect, and `safeCollect(fiber)` throws
 * `TypeError('Invalid effect')` (vendor/cordis fiber.ts `_execute`), failing
 * the plugin load. The mock-based verify script cannot catch this because a
 * mock `inject` returning the callback result masks the thenable semantics.
 *
 * Also guards: the entry config is validated against `plugin.Config` (an
 * intervalMinutes of 0 must be rejected by the `.min(1)` bound), the
 * `/session-cleanup` RPC channel is registered with `authority: 'loopback'`
 * and is removed again on dispose, and `enabled: false` loads without
 * injecting any service.
 *
 * @deepseek-ai/cordis resolution: this file resolves packages from the patch
 * dir's node_modules (`npm install` in patches/session-cleanup installs
 * @deepseek-ai/cordis + @deepseek-ai/schemastery as dev/peer deps), so no
 * NODE_PATH is needed:
 *   node patches/session-cleanup/tests/load-smoke.mjs
 * Fallbacks (in order): ancestor node_modules of this patch, `$NODE_PATH`
 * entries, then the deployed profile tree `~/.dsh/profiles/node_modules`.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, delimiter } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const patchDir = join(here, '..')
const hostPath = join(patchDir, 'session-cleanup.mjs')

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
    'node_modules; run `npm install` in the patch dir or point NODE_PATH at a node_modules that ' +
    'contains it (e.g. C:\\Users\\98645\\.dsh\\profiles\\node_modules)',
  )
}

const { Context } = await import(pathToFileURL(resolveCordisEntry()).href)
const host = await import(pathToFileURL(hostPath).href)

// --- enabled: true — provide the injected services, then load for real ----------
const sessionsRoot = mkdtempSync(join(tmpdir(), 'cleanup-smoke-'))
const ctx = new Context()

const handleCalls = []
const connectionStub = {
  rpc: {
    handle: (channel, handler, options) => {
      handleCalls.push({ channel, handler, options })
      return () => {
        const i = handleCalls.findIndex((c) => c.channel === channel)
        if (i >= 0) handleCalls.splice(i, 1)
      }
    },
  },
}
const sessionsStub = { list: () => [] }

ctx.provide('connection', connectionStub)
ctx.provide('sessions', sessionsStub)

// Same call the DSH host loader makes: ctx.plugin(module) -> resolve ->
// apply(ctx). `await` settles once loading finished; with the historical bug
// this rejects with TypeError('Invalid effect').
const fiber = ctx.plugin(host, {
  enabled: true,
  dryRun: true,
  sessionsRoot,
  maxAgeDays: 30,
  maxTotalMB: 0,
  keepSessions: 5,
  intervalMinutes: 360,
})
await fiber

// The inner ctx.inject(['sessions','connection'], ...) fiber starts on a
// microtask after apply(); wait (bounded) until the /session-cleanup channel
// is up.
const deadline = Date.now() + 2000
while (handleCalls.length === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

assert.equal(handleCalls.length, 1, 'rpc.handle must be called exactly once for /session-cleanup')
assert.equal(handleCalls[0].channel, '/session-cleanup')
assert.equal(handleCalls[0].options.authority, 'loopback')

// The registered handler is the real one and still works end-to-end.
const got = await handleCalls[0].handler('getConfig', { args: {} })
assert.equal(got.ok, true)
assert.equal(got.value.dryRun, true)
assert.equal(got.value.intervalMinutes, 360)

// The entry config is validated against plugin.Config: intervalMinutes 0 must
// be rejected (the .min(1) bound) instead of spinning a 1ms interval.
await assert.rejects(
  async () => { await ctx.plugin(host, { enabled: true, intervalMinutes: 0, sessionsRoot }) },
  /intervalMinutes/i,
  'intervalMinutes 0 must be rejected by the Config schema',
)

await fiber.dispose()
assert.equal(handleCalls.length, 0, 'dispose must run the /session-cleanup channel disposer')
rmSync(sessionsRoot, { recursive: true, force: true })

// --- enabled: false — apply returns early without injecting ----------------------
const ctx2 = new Context()
const handles2 = []
ctx2.provide('connection', { rpc: { handle: (channel, handler, options) => {
  handles2.push({ channel, handler, options })
  return () => {}
} } })
ctx2.provide('sessions', { list: () => [] })

const fiber2 = ctx2.plugin(host, { enabled: false })
await fiber2 // must settle without TypeError('Invalid effect') and without injecting
assert.equal(handles2.length, 0, 'enabled:false must not register any RPC channel')
await fiber2.dispose()

console.log('load-smoke OK: real Cordis ctx.plugin() loaded session-cleanup.mjs, /session-cleanup channel registered, Config validates, no TypeError("Invalid effect")')
