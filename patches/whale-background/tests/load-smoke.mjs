/**
 * Real-Cordis load smoke test for the whale-background host half.
 *
 * Loads `lib/index.js` through the ACTUAL Cordis runtime (`new Context()`,
 * `ctx.provide(...)`, `ctx.plugin(...)` / `await`), the same path the DSH host
 * uses. It pins three things that have each broken this patch before:
 *
 *  1. `apply()` must not `return ctx.inject(...)` — real `ctx.inject()`
 *     returns a Fiber wrapper (a PromiseLike), Cordis treats an apply return
 *     as an Effect, and the load fails with `TypeError('Invalid effect')`.
 *  2. The route must be registered through the CORDIS SERVICE
 *     (`ctx.webServer.register`, declared in `inject`), not through a
 *     `ctx.get('webServer')` read that silently skips the route when the
 *     service is absent or not yet live — the bug behind "鲸鱼娘失踪"
 *     (commit fbaaf16).
 *  3. The image asset must exist next to the patch: the route reads it
 *     synchronously at apply time, so a moved asset must fail here rather than
 *     at boot.
 *
 * `@deepseek-ai/cordis` resolution: this file has no local node_modules and
 * ESM `import` ignores NODE_PATH, so the package is located with createRequire
 * (CJS resolution honors NODE_PATH) in this order:
 *   1. standard ancestor node_modules of this patch;
 *   2. `$NODE_PATH` entries;
 *   3. the deployed profile junction tree `~/.dsh/profiles/node_modules`.
 * The resolved entry is then imported via file URL.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, delimiter } from 'node:path'
import { existsSync } from 'node:fs'

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
    'node_modules; run with NODE_PATH pointing at a node_modules that contains it',
  )
}

const assetPath = join(patchDir, '..', 'ui-settings-other', 'assets', 'whale-girl-transparent.png')
assert.ok(existsSync(assetPath), `whale image asset missing: ${assetPath}`)

const { Context } = await import(pathToFileURL(resolveCordisEntry()).href)
const host = await import(pathToFileURL(hostPath).href)

assert.deepEqual(host.inject, ['webServer'], 'the host half must declare the webServer service in inject')

const ctx = new Context()
const routes = []
ctx.provide('webServer', {
  register(route) {
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index !== -1) routes.splice(index, 1)
    }
  },
})

// DSH's host runner wraps every plugin as an object whose `apply` METHOD
// delegates to the original, so Cordis calls apply as a function. Reproduce it.
const guarded = {
  name: 'whale-background',
  apply(ctx) {
    return host.apply(ctx)
  },
}

const fiber = ctx.plugin(guarded)
await fiber

assert.equal(routes.length, 1, 'the image route must be registered on ctx.webServer')
assert.equal(routes[0].kind, 'exact')
assert.equal(routes[0].path, '/whale-background.png')

// The handler must actually answer with the PNG bytes.
const chunks = []
await routes[0].handler({}, {
  writeHead(status, headers) { this.status = status; this.headers = headers },
  end(body) { chunks.push(body) },
})
assert.equal(chunks[0][0], 0x89, 'the served body must be the PNG asset')
assert.equal(chunks[0][1], 0x50)

await fiber.dispose()
assert.equal(routes.length, 0, 'dispose must run the route disposer')

console.log('load-smoke OK: real Cordis loaded whale-background, /whale-background.png registered with the PNG asset, no TypeError("Invalid effect")')
