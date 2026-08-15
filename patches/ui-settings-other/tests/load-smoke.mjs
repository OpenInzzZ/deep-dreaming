/**
 * Real-Cordis load smoke test for the ui-settings-other host half.
 *
 * Loads lib/index.js into a real @deepseek-ai/cordis Context with stubbed
 * connection/agents services and asserts:
 *   - the plugin fiber activates without TypeError('Invalid effect') — the P0
 *     regression guard (apply must not return the ctx.inject() thenable);
 *   - the /app RPC channel is registered with the loopback authority;
 *   - with idleEnabled: false no idle monitor is created (no real intervals).
 *
 * Run from the repo root:
 *   node patches/ui-settings-other/tests/load-smoke.mjs
 * (needs @deepseek-ai/cordis resolvable from this patch — the deployed
 * node_modules junction provides it; otherwise NODE_PATH=...\.dsh\profiles\node_modules)
 */
import { Context } from '@deepseek-ai/cordis'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const ctx = new Context()
const channels = []
ctx.provide('connection', {
  rpc: {
    handle: (channel, handler, options) => {
      channels.push({ channel, options })
      return () => {}
    },
  },
})
ctx.provide('agents', {
  list: () => [],
  get: () => undefined,
})

// idleEnabled: false keeps the idle monitor from creating a real interval.
const fiber = ctx.plugin(mod, { idleEnabled: false })
await fiber // throws TypeError('Invalid effect') on the P0 regression

const app = channels.find((c) => c.channel === '/app')
if (app === undefined) throw new Error('/app channel never registered')
if (app.options.authority !== 'loopback') throw new Error(`authority: ${app.options.authority}`)
if (channels.some((c) => c.channel !== '/app')) throw new Error(`unexpected channels: ${channels.map((c) => c.channel)}`)

await ctx.fiber.dispose()
console.log('load-smoke OK: /app channel registered (loopback), no Invalid effect, no idle monitor with idleEnabled=false')
