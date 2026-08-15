/**
 * Real-Cordis load smoke test for the dom-inspect host half.
 *
 * Loads `lib/index.js` through the ACTUAL Cordis runtime (`new Context()`,
 * `ctx.provide(...)`, `ctx.plugin(...)` / `await`), the same path the DSH
 * host uses. Guards the historical `apply`-returns-thenable bug and verifies
 * the `/dom-inspect` RPC channel plus the `dom_inspect` tool end to end.
 *
 * Run from the repo root:
 *   node patches/dom-inspect/tests/load-smoke.mjs
 * (@deepseek-ai/cordis + @deepseek-ai/dsh-tools resolve from the deployed
 * profile junction tree; NODE_PATH fallback documented in the other patches'
 * load-smokes.)
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, delimiter } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const patchDir = join(here, '..')
const hostPath = join(patchDir, 'lib', 'index.js')

function resolveFromProfile(spec) {
  const req = createRequire(import.meta.url)
  for (const entry of (process.env.NODE_PATH ?? '').split(delimiter).filter(Boolean)) {
    try { return req.resolve(join(entry, spec)) } catch {}
  }
  const profileEntry = join(homedir(), '.dsh', 'profiles', 'node_modules', spec)
  return req.resolve(profileEntry)
}

const { Context } = await import(pathToFileURL(resolveFromProfile('@deepseek-ai/cordis')).href)
const host = await import(pathToFileURL(hostPath).href)

const ctx = new Context()

const handleCalls = []
const registeredTools = []
ctx.provide('connection', {
  rpc: {
    handle: (channel, handler, options) => {
      handleCalls.push({ channel, handler, options })
      return () => { handleCalls.splice(handleCalls.findIndex((c) => c.channel === channel), 1) }
    },
  },
})
ctx.provide('tools', {
  register: (tool) => {
    registeredTools.push(tool)
    return () => { registeredTools.splice(registeredTools.findIndex((t) => t.name === tool.name), 1) }
  },
})

const guarded = {
  name: host.name,
  apply(ctx) { return host.apply(ctx) },
}

const fiber = ctx.plugin(guarded)
await fiber // TypeError('Invalid effect') on the historical bug

const deadline = Date.now() + 2000
while ((handleCalls.length === 0 || registeredTools.length === 0) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

assert.equal(handleCalls.length, 1, '/dom-inspect channel must be registered once')
assert.equal(handleCalls[0].channel, '/dom-inspect')
assert.equal(handleCalls[0].options.authority, 'loopback')
const tool = registeredTools.find((t) => t.name === 'dom_inspect')
assert.ok(tool, 'dom_inspect tool must be registered')

// push a snapshot through the RPC channel, then read it back via the tool
const push = await handleCalls[0].handler('push', { args: { snapshot: { groups: { 'memory-cards': [{ tag: 'div', text: '记忆 · 保存/更新已保存:x' }] } } } })
assert.equal(push.ok, true)
const result = await tool.execute({}, { signal: new AbortController().signal })
assert.equal(result.available, true)
assert.equal(result.groups['memory-cards'][0].text, '记忆 · 保存/更新已保存:x')
assert.ok(result.ageMs >= 0)

const bad = await handleCalls[0].handler('push', { args: { snapshot: 'nope' } })
assert.equal(bad.ok, false)
assert.equal(bad.error.code, 'bad-request')

await fiber.dispose()
assert.equal(handleCalls.length, 0, 'dispose must remove the channel')
assert.equal(registeredTools.length, 0, 'dispose must remove the tool')

console.log('load-smoke OK: real Cordis loaded lib/index.js, /dom-inspect + dom_inspect tool work end to end, no TypeError("Invalid effect")')
