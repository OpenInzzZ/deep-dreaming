/**
 * Real-Cordis load smoke test for the plugin-manager host half.
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
 * Safety: the toggle writes to a TEMP patch file via `config.patchFile`,
 * never the real `~/.dsh/profiles/web/cordis.patch.yml`.
 *
 * @deepseek-ai/cordis resolution: this file has no local node_modules and ESM
 * `import` ignores NODE_PATH, so the package is located with createRequire
 * (CJS resolution honors NODE_PATH) in this order:
 *   1. standard ancestor node_modules of this patch;
 *   2. `$NODE_PATH` entries;
 *   3. the deployed profile junction tree `~/.dsh/profiles/node_modules`.
 * If resolution fails, run with NODE_PATH pointing at a node_modules that
 * contains @deepseek-ai/cordis, e.g.:
 *   NODE_PATH=%USERPROFILE%\.dsh\profiles\node_modules node patches/ui-settings-plugin-manager/tests/load-smoke.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'

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
ctx.provide('connection', connectionStub)

// DSH's host runner never hands a bare function to ctx.plugin: it wraps every
// plugin as a plain OBJECT whose `apply` METHOD delegates to the original.
// Reproduce the DSH load shape (a bare function would take Cordis'
// isConstructor -> `new` branch and silently ignore the return).
const guarded = {
  name: host.name,
  apply(ctx, config) {
    return host.apply(ctx, config)
  },
}

const smokeDir = mkdtempSync(join(tmpdir(), 'plugin-manager-smoke-'))
const patchFile = join(smokeDir, 'cordis.patch.yml')
writeFileSync(patchFile, '# smoke layer\n- insert:\n    - id: a\n      name: pkg-a\n')

const fiber = ctx.plugin(guarded, { patchFile })
await fiber // rejects with TypeError('Invalid effect') on the historical bug

// The inner ctx.inject(['connection'], ...) fiber starts on a microtask after
// apply(); wait (bounded) until the /plugin-toggle handler is up.
const deadline = Date.now() + 2000
while (handleCalls.length === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

assert.equal(handleCalls.length, 1, 'rpc.handle must be called exactly once for /plugin-toggle')
assert.equal(handleCalls[0].channel, '/plugin-toggle')
assert.equal(handleCalls[0].options.authority, 'loopback')

// The registered handler is the real one and still works end-to-end.
const off = await handleCalls[0].handler('setEnabled', { args: { entryId: 'a', enabled: false } })
assert.equal(off.ok, true)
assert.equal(off.value.enabled, false)
assert.equal(off.value.changed, true)
assert.ok(readFileSync(patchFile, 'utf8').includes('- id: a\n  disabled: true'), 'disable must write the disabled block')

const on = await handleCalls[0].handler('setEnabled', { args: { entryId: 'a', enabled: true } })
assert.equal(on.ok, true)
assert.equal(on.value.changed, true)
assert.ok(!readFileSync(patchFile, 'utf8').includes('disabled: true'), 'enable must remove the disabled block')

await fiber.dispose()
assert.equal(handleCalls.length, 0, 'dispose must run the /plugin-toggle channel disposer')

rmSync(smokeDir, { recursive: true, force: true })
console.log('load-smoke OK: real Cordis ctx.plugin() loaded lib/index.js, /plugin-toggle registered, toggle writes the temp patch, no TypeError("Invalid effect")')
