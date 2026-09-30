/**
 * Real-Cordis load smoke test for the ui-settings-model-reasoning host half.
 *
 * Loads lib/index.js into a real @deepseek-ai/cordis Context and asserts the
 * plugin fiber activates without TypeError('Invalid effect') — the P0
 * regression guard (apply must not return a thenable). The host half owns no
 * services, so activation is the whole contract: an activated entry is what
 * composes the client bundle into the web boot graph.
 *
 * Run from the repo root:
 *   node patches/ui-settings-model-reasoning/tests/load-smoke.mjs
 * (needs @deepseek-ai/cordis resolvable from this patch — the deployed
 * node_modules junction provides it; otherwise NODE_PATH=...\.dsh\profiles\node_modules)
 */
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

if (typeof mod.apply !== 'function') throw new Error('host half must export apply()')

const ctx = new Context()
const fiber = ctx.plugin(mod)
await fiber // throws TypeError('Invalid effect') on the P0 regression

if (fiber.state !== 2 /* ACTIVE */) throw new Error(`host fiber not active: state ${fiber.state}`)

await ctx.fiber.dispose()
console.log('load-smoke OK: host half activates through real ctx.plugin() with no Invalid effect')
