/**
 * Real-Cordis load smoke test for the ui-settings-balance host half.
 *
 * Loads `lib/index.js` through the ACTUAL Cordis runtime (`new Context()`,
 * `ctx.provide(...)`, `ctx.plugin(...)` / `await`), the same path the DSH host
 * uses. It pins what has broken this patch (and its predecessor) before:
 *
 *  1. `apply()` must not `return ctx.inject(...)` — a real `ctx.inject()` returns
 *     a Fiber wrapper (a PromiseLike), Cordis treats an apply return as an Effect,
 *     and the load fails with `TypeError('Invalid effect')`.
 *  2. The route must be registered through the CORDIS SERVICE
 *     (`ctx.webServer.register`, declared in `inject`), not through a
 *     `ctx.get('webServer')` read that silently skips the transport.
 *  3. The balance endpoint must report a STATUS for every outcome. Collapsing
 *     "signed out", "query failed" and "no service" into an empty balance would
 *     render a signed-out user as having no money — the one wrong answer a
 *     balance panel must never give.
 *
 * `@deepseek-ai/cordis` resolution: this file has no local node_modules and ESM
 * `import` ignores NODE_PATH, so the package is located with createRequire (CJS
 * resolution honors NODE_PATH) in this order:
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

const { Context } = await import(pathToFileURL(resolveCordisEntry()).href)
const host = await import(pathToFileURL(hostPath).href)

// --- export contract --------------------------------------------------------
assert.deepEqual(host.inject, ['webServer'], 'the host half must declare the webServer service in inject')
assert.equal(host.PLUGIN_NAMESPACE, 'ui-settings-balance')
assert.equal(host.SECTION_ID, 'balance')
assert.equal(typeof host.balanceInfo, 'function')
assert.equal(typeof host.createRpcRoute, 'function')
assert.equal(typeof host.faviconSvg, 'function')
// The restart/shortcut/update surface is gone: this section only reads balances.
for (const gone of ['buildRestartSpawn', 'installShortcut', 'resolveRestartScript', 'resolveUpdateScript', 'serviceInfo', 'runningSessionIds']) {
  assert.equal(host[gone], undefined, `${gone} must no longer exist on the host half`)
}

// --- request identity ------------------------------------------------------
const metadata = host.accountClientMetadata('zh-CN', '9.9.9-test')
assert.deepEqual(
  { version: metadata.version, locale: metadata.locale },
  { version: '9.9.9-test', locale: 'zh-CN' },
  'accountClientMetadata must carry the caller identity dsh derives Platform headers from',
)
assert.equal(
  metadata.timezoneOffsetSeconds,
  -new Date().getTimezoneOffset() * 60,
  'the timezone offset must follow the browser convention (positive east), not getTimezoneOffset()',
)
assert.equal(
  host.accountClientMetadata(undefined, '1.0.0').locale,
  '',
  'a missing locale must not become the string "undefined"',
)

// --- balanceInfo outcomes ---------------------------------------------------
const wallets = [{ currency: 'CNY', balance: '123.45' }]
const bonus = [{ currency: 'CNY', balance: '10.00' }]

assert.deepEqual(
  await host.balanceInfo({ getBalance: async () => ({ status: 'ready', value: wallets, bonusWallets: bonus }) }),
  { status: 'ready', wallets, bonusWallets: bonus },
  'a ready outcome must pass both wallet lists through',
)
assert.deepEqual(
  await host.balanceInfo({ getBalance: async () => null }),
  { status: 'signed-out' },
  'a null outcome means signed out, not a zero balance',
)
assert.equal(
  (await host.balanceInfo({ getBalance: async () => ({ status: 'failed' }) })).status,
  'failed',
  'a failed outcome must stay failed',
)
assert.equal(
  (await host.balanceInfo(undefined)).status,
  'unavailable',
  'a missing account service must be reported, not thrown',
)
assert.equal(
  (await host.balanceInfo({ getBalance: async () => { throw new Error('boom') } })).status,
  'failed',
  'a throwing query must degrade to a failure status',
)
const odd = await host.balanceInfo({ getBalance: async () => ({ status: 'ready', value: 'nope' }) })
assert.deepEqual([odd.wallets, odd.bonusWallets], [[], []], 'non-array wallet fields must normalize to empty lists')

// --- transport through the real Cordis runtime ------------------------------
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
// Supplied as a REAL service so the endpoint reads it the way it does in dsh.
ctx.provide('deepseekAccount', { getBalance: async () => ({ status: 'ready', value: wallets, bonusWallets: bonus }) })

// DSH's host runner wraps every plugin as an object whose `apply` METHOD
// delegates to the original, so Cordis calls apply as a function. Reproduce it.
const guarded = {
  name: 'ui-settings-balance',
  apply(ctx) {
    return host.apply(ctx)
  },
}

const fiber = ctx.plugin(guarded)
await fiber

const byPath = (path) => routes.find((route) => route.path === path)
assert.equal(
  routes.length,
  3,
  `expected health + favicon + /app routes, saw: ${routes.map((route) => route.path).join(', ')}`,
)
const rpcRoute = byPath('/app')
assert.ok(rpcRoute !== undefined, 'the /app prefix route must be registered on ctx.webServer')
assert.equal(rpcRoute.kind, 'prefix')
assert.ok(byPath('/ui-settings-balance/health') !== undefined, 'the diagnostics route must be registered')
assert.ok(byPath('/favicon.svg') !== undefined, 'the favicon route must be registered from the bundled asset')

/** Drive a fake req/res pair through one route. */
async function request(route, options = {}) {
  const {
    method = 'POST', url = '/app/balance', origin, contentType = 'application/json', body = '{}',
  } = options
  const chunks = []
  const req = {
    method,
    url,
    headers: {
      host: '127.0.0.1:19387',
      ...(origin === undefined ? {} : { origin }),
      ...(contentType === null ? {} : { 'content-type': contentType }),
    },
    on(event, listener) {
      if (event === 'data' && body !== null) listener(Buffer.from(body))
      if (event === 'end') listener()
      return req
    },
    destroy() {},
  }
  const res = {
    status: 0,
    writeHead(status) { this.status = status; return this },
    end(text) { chunks.push(text ?? '') },
  }
  route.handler(req, res)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const text = chunks.join('')
  return { status: res.status, json: text === '' ? null : JSON.parse(text) }
}

const ok = await request(rpcRoute)
assert.equal(ok.status, 200, 'a fenced same-origin POST must be answered')
assert.equal(ok.json.ok, true, `balance envelope must be ok: ${JSON.stringify(ok.json)}`)
assert.equal(ok.json.value.status, 'ready')
assert.deepEqual(ok.json.value.wallets, wallets)
assert.deepEqual(ok.json.value.bonusWallets, bonus)

const unknown = await request(rpcRoute, { url: '/app/nope' })
assert.equal(unknown.json.ok, false)
assert.equal(unknown.json.error.code, 'bad-request')

const crossOrigin = await request(rpcRoute, { origin: 'https://evil.example' })
assert.equal(crossOrigin.status, 403, 'a cross-origin POST must be refused')
const notPost = await request(rpcRoute, { method: 'GET' })
assert.equal(notPost.status, 405, 'only POST is accepted')
const wrongType = await request(rpcRoute, { contentType: 'text/plain' })
assert.equal(wrongType.status, 415, 'the body must be JSON')
const badJson = await request(rpcRoute, { body: '{oops' })
assert.equal(badJson.status, 400, 'malformed JSON must be rejected')

await fiber.dispose()
assert.equal(routes.length, 0, 'dispose must run every route disposer')

// --- health reports the real wiring ----------------------------------------
{
  const ctx2 = new Context()
  const routes2 = []
  ctx2.provide('webServer', {
    register(route) {
      routes2.push(route)
      return () => {}
    },
  })
  const fiber2 = ctx2.plugin({ name: 'ui-settings-balance', apply: (c) => host.apply(c) })
  await fiber2
  let payload = null
  routes2.find((route) => route.path === '/ui-settings-balance/health')
    .handler({}, { writeHead() {}, end(text) { payload = JSON.parse(text) } })
  assert.equal(payload.ok, true)
  assert.equal(payload.namespace, 'ui-settings-balance')
  assert.equal(payload.channel, true, 'a registered transport must be reported')
  assert.equal(payload.branding, true, 'the bundled favicon asset must be reported as wired')
  await fiber2.dispose()
}

// --- static-inject activation (no dynamic gate) -----------------------------
{
  // A re-activation on a fresh context must register the transport on its own:
  // the dynamic `ctx.inject` gate is what left the channel 404 after a reload.
  const ctx3 = new Context()
  const routes3 = []
  ctx3.provide('webServer', {
    register(route) {
      routes3.push(route)
      return () => {
        const index = routes3.indexOf(route)
        if (index !== -1) routes3.splice(index, 1)
      }
    },
  })
  const fiber3 = ctx3.plugin({ name: 'ui-settings-balance', apply: (c) => host.apply(c) })
  await fiber3
  assert.ok(
    routes3.some((route) => route.path === '/app'),
    'a static inject must register /app without any external trigger',
  )
  await fiber3.dispose()
  assert.equal(routes3.length, 0, 'unload must release every route')
}

// --- no account service at all ---------------------------------------------
{
  const ctx4 = new Context()
  const routes4 = []
  ctx4.provide('webServer', {
    register(route) {
      routes4.push(route)
      return () => {}
    },
  })
  const fiber4 = ctx4.plugin({ name: 'ui-settings-balance', apply: (c) => host.apply(c) })
  await fiber4
  // `ctx.get` on an unmounted service must yield the unavailable status through
  // the endpoint rather than breaking activation.
  const route = routes4.find((entry) => entry.path === '/app')
  const result = await request(route)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.value.status, 'unavailable')
  await fiber4.dispose()
}

console.log(
  'load-smoke OK: real Cordis loaded ui-settings-balance; health + favicon + fenced /app routes registered, ' +
  'balanceInfo reports ready/signed-out/failed/unavailable, no TypeError("Invalid effect")',
)
