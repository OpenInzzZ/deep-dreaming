/**
 * Real-Cordis load smoke test for the mcp-servers host half.
 *
 * mcp-servers mounts one child of the official `@deepseek-ai/dsh-mcp-client` per
 * entry of its `servers` array, so the load-bearing claims are:
 *
 *  1. `inject` is the official `['tools']` — dropping it means the children can
 *     never register anything;
 *  2. `servers` is marked `.volatile()`. Without the flag the Host skips the
 *     entry in `settings.describe()` and the settings page has nothing to edit
 *     (measured: `settings/src/index.ts:308` drops entries whose
 *     `volatileForm` is empty);
 *  3. `plainConfig()` unwraps the `{ get }` box a volatile field validates into
 *     — feeding the box onward fails with `expected { serverName: string … }`;
 *  4. `selectServers()` skips `enabled: false` and collapses duplicate
 *     `serverName`s (the official client reserves the name globally and fails
 *     the later instance loudly, so mounting both would only trade a clear error
 *     for a confusing one);
 *  5. `toMcpConfig()` pins `transport: 'streamable-http'` while the OFFICIAL
 *     schema still fills its own defaults (`headers`, the whole `reconnect`
 *     policy);
 *  6. against a live MCP server, one mount per entry really registers tools under
 *     `mcp__<serverName>__…`, and disposing the parent unregisters all of them;
 *  7. a **volatile-only** `servers` edit (what the settings page writes) is
 *     reconciled by the plugin itself: the Loader commits the new value, emits
 *     `loader/volatile-update` and deliberately does NOT re-apply, so the mount
 *     may only change because `apply()` listens for that event.
 *
 * Package resolution: `patches/mcp-servers/node_modules` must be the
 * host-dependency junction into `~/.dsh/profiles/node_modules`
 * (scripts/deploy.ps1 creates it).
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import net from 'node:net'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { delimiter, dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const patchDir = join(here, '..')
const hostPath = join(patchDir, 'lib', 'index.js')

const IDEA_URL = 'http://127.0.0.1:64342/stream'

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
  throw new Error("cannot resolve '@deepseek-ai/cordis'; run scripts/deploy.ps1 to create the host-dependency junction")
}

let host
try {
  host = await import(pathToFileURL(hostPath).href)
} catch (err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') {
    console.error(
      `load-smoke FAILED: ${err.message}\n` +
      '  mcp-servers imports @deepseek-ai/dsh-mcp-client, which only resolves through the\n' +
      '  host-dependency junction patches/mcp-servers/node_modules -> ~/.dsh/profiles/node_modules.\n' +
      '  Run scripts/install.ps1 then scripts/deploy.ps1.',
    )
    process.exit(1)
  }
  throw err
}

const { Context } = await import(pathToFileURL(resolveCordisEntry()).href)

// --- 1. the declared dependency survives the re-export ---------------------------
assert.deepEqual(host.inject, ['tools'], 'mcp-servers must carry the official inject: ["tools"]')
assert.equal(typeof host.apply, 'function', 'the host half must export apply()')

// --- 2. the list is editable: `servers` must be volatile -------------------------
assert.equal(host.Config.dict?.servers?.meta?.volatile, true,
  'Config.servers must be .volatile() or the Host serves no namespace and the settings page is dead')

// --- 3. the box is unwrapped before anything consumes it -------------------------
const raw = host.Config({})
assert.equal(typeof raw.servers, 'object')
assert.equal(typeof raw.servers?.get, 'function', 'a .volatile() field validates into a { get } accessor')
assert.deepEqual(host.plainConfig(raw).servers, [], 'plainConfig must read the current value behind the box')

// --- 4. selection: disabled skipped, duplicates collapsed ------------------------
const picked = host.selectServers([
  { serverName: 'a', url: 'http://127.0.0.1:1/mcp', enabled: true },
  { serverName: 'off', url: 'http://127.0.0.1:2/mcp', enabled: false },
  { serverName: 'a', url: 'http://127.0.0.1:3/mcp', enabled: true },
])
assert.deepEqual(picked.taken.map((row) => row.serverName), ['a'], 'only the first live entry per name may mount')
assert.deepEqual(picked.duplicates, ['a'], 'the collapsed name must be reported, not dropped in silence')
assert.deepEqual(host.selectServers(undefined), { taken: [], duplicates: [] }, 'a missing list must not throw')

// --- 5. the mapping pins transport and keeps the official defaults ----------------
const mapped = host.toMcpConfig({ serverName: 'idea', url: IDEA_URL, toolCallTimeoutMs: 90000, failOnStartupError: false, enabled: true })
assert.equal(mapped.transport, 'streamable-http', 'transport must be pinned, never taken from the form')
assert.equal(mapped.command, undefined, 'a streamable config must not carry the stdio branch keys')
assert.deepEqual(mapped.reconnect, { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 }, 'the OFFICIAL schema must fill its own reconnect policy')
assert.deepEqual(mapped.headers, {}, 'the official schema defaults headers to {}')
// Headers must survive the round trip: this patch has its own ServerSchema, so a
// key it does not declare is dropped before toMcpConfig() ever sees it — that is
// exactly how an authenticated server (DBX) stayed at 401 while looking configured.
//
// These cases go through `Config` — the REAL path `apply()` takes — rather than a
// bare literal, because the two are NOT equivalent here: a `.volatile()` field
// validates into a FROZEN element, and the official `z.dict(String)` writes its
// default IN PLACE, so a non-empty headers map blows up with
// "Cannot assign to read only property …" and the union reports only a generic
// mismatch. Measured: the literal form passes while the frozen form throws, which
// is why this bug survived the first test pass.
const viaConfig = (servers) => host.plainConfig(host.Config({ servers })).servers
const authed = host.toMcpConfig(viaConfig([{ serverName: 'dbx', url: 'http://127.0.0.1:5225/mcp', headers: { Authorization: 'Bearer t0ken' } }])[0])
assert.deepEqual(authed.headers, { Authorization: 'Bearer t0ken' }, 'configured headers must reach the official transport requestInit')
assert.deepEqual(host.toMcpConfig(viaConfig([{ serverName: 'idea', url: IDEA_URL }])[0]).headers, {},
  'an entry with no headers must still validate to the {} default')
assert.ok(Object.isFrozen(viaConfig([{ serverName: 'x', url: 'http://127.0.0.1:1/mcp' }])[0]),
  'the validated element really is frozen — if this ever stops being true, the copy in toMcpConfig() is no longer load-bearing')
// A literal still has to work (the live-mount block below passes one).
assert.deepEqual(host.toMcpConfig({ serverName: 'dbx', url: 'http://127.0.0.1:5225/mcp', headers: { Authorization: 'Bearer t0ken' } }).headers,
  { Authorization: 'Bearer t0ken' }, 'the literal form must keep working too')

// --- 5b. reconciliation plan: what a live `servers` edit must do -----------------
// The settings page writes a `.volatile()` field, and the Loader treats a
// volatile-only config diff as "no remount" — so `apply()` never re-runs and the
// patch itself has to reconcile. These are the pure decisions that drives.
assert.equal(
  host.serverSignature({ url: 'http://x/mcp', headers: { b: '2', A: '1' } }),
  host.serverSignature({ url: 'http://x/mcp', headers: { A: '1', b: '2' } }),
  'header order and case must not count as a change (an unchanged server must not be remounted)',
)
assert.notEqual(host.serverSignature({ url: 'http://x/mcp' }), host.serverSignature({ url: 'http://y/mcp' }), 'a URL change must count')
assert.notEqual(host.serverSignature({ url: 'u' }), host.serverSignature({ url: 'u', headers: { Authorization: 'Bearer t' } }),
  'adding headers must count (that is the whole point of the signature)')
assert.notEqual(host.serverSignature({ url: 'u' }), host.serverSignature({ url: 'u', toolCallTimeoutMs: 5000 }),
  'a timeout change must count')

const signatureOf = (server) => host.serverSignature(server)
const unchanged = host.planReconcile(new Map([['a', signatureOf({ serverName: 'a', url: 'u' })]]), [
  { serverName: 'a', url: 'u' },
  { serverName: 'b', url: 'v' },
])
assert.deepEqual(unchanged.unmount, [], 'an unchanged mounted server must survive a reconcile')
assert.deepEqual(unchanged.mount.map((server) => server.serverName), ['b'], 'only the new server mounts')

const edited = host.planReconcile(new Map([
  ['a', signatureOf({ serverName: 'a', url: 'u' })],
  ['b', signatureOf({ serverName: 'b', url: 'v' })],
]), [
  { serverName: 'a', url: 'u' },
  { serverName: 'b', url: 'v2' },
])
assert.deepEqual(edited.unmount, ['b'], 'a changed server unmounts before it mounts again')
assert.deepEqual(edited.mount.map((server) => server.serverName), ['b'], 'a changed server mounts with the new config')

const removed = host.planReconcile(new Map([['a', signatureOf({ serverName: 'a', url: 'u' })]]), [
  { serverName: 'a', url: 'u', enabled: false },
])
assert.deepEqual(removed, { unmount: ['a'], mount: [] }, 'disabling a server unmounts it and mounts nothing')
assert.deepEqual(host.planReconcile(new Map([['a', signatureOf({ serverName: 'a', url: 'u' })]]), undefined),
  { unmount: ['a'], mount: [] }, 'an emptied list unmounts everything')

// --- 6. mount for real when IDEA is listening ------------------------------------
const listening = await new Promise((resolve) => {
  const sock = net.connect({ host: '127.0.0.1', port: 64342 })
  sock.setTimeout(800)
  sock.once('connect', () => { sock.destroy(); resolve(true) })
  sock.once('timeout', () => { sock.destroy(); resolve(false) })
  sock.once('error', () => resolve(false))
})

/** Poll until `predicate()` holds; returns false on timeout. */
const waitFor = async (predicate, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return predicate()
}

let liveNote = 'IDEA MCP server not listening: live mount and volatile reconcile skipped'
if (listening) {
  const registered = []
  const ctx = new Context()
  ctx.provide('tools', {
    register(tool) {
      registered.push(tool)
      return () => {
        const at = registered.indexOf(tool)
        if (at >= 0) registered.splice(at, 1)
      }
    },
  })
  // The REAL shape: Cordis validates this raw config into `fiber.config`, whose
  // `servers` is a volatile `{ get }` box — that box is what `apply()` receives
  // and what the Loader writes on a live settings save.
  const fiber = ctx.plugin(host, {
    servers: [
      { serverName: 'probeA', url: IDEA_URL, enabled: true },
      { serverName: 'probeB', url: IDEA_URL, enabled: true },
      { serverName: 'probeC', url: IDEA_URL, enabled: false },
      { serverName: 'probeA', url: IDEA_URL, enabled: true },
    ],
  })
  await Promise.race([
    fiber,
    new Promise((_r, reject) => setTimeout(() => reject(new Error('live mount did not settle within 30s')), 30000).unref?.()),
  ])
  // `await fiber` settles BEFORE discovery finishes in this build: measured, the
  // tools land within a few seconds of activation. Poll instead of asserting
  // immediately, or the check is a coin flip.
  const namespaces = () => new Set(registered.map((t) => t?.name?.split('__')[1]).filter(Boolean))
  await waitFor(() => namespaces().size >= 2, 20000)
  const seen = [...namespaces()]
  assert.deepEqual(seen.sort(), ['probeA', 'probeB'], `exactly the two enabled, de-duplicated servers may mount, got ${seen.join(', ')}`)
  assert.ok(registered.every((t) => /^mcp__probe[AB]__/.test(t.name)), 'every tool must carry its server namespace')

  // Drive the Loader's volatile-only path by hand: write the box, emit the event.
  // The Loader does exactly these two steps and deliberately does NOT re-apply,
  // so the mount can only change because this patch reconciles on the event.
  const write = Symbol.for('cosmokit.volatile.write')
  const box = fiber.config.servers
  assert.equal(typeof box?.[write], 'function', 'the volatile box must be writable through the shared symbol')
  box[write]([
    { serverName: 'probeA', url: IDEA_URL, enabled: true },
    { serverName: 'probeD', url: IDEA_URL, enabled: true },
  ])
  ctx.emit('loader/volatile-update', [['servers']])
  const reconciled = await waitFor(() => {
    const current = [...namespaces()].sort()
    return current.length === 2 && current[0] === 'probeA' && current[1] === 'probeD'
  }, 30000)
  assert.ok(reconciled, `a volatile servers update must mount the new server and drop the old one, got ${[...namespaces()].sort().join(', ')}`)
  assert.ok(registered.every((t) => /^mcp__probe[AD]__/.test(t.name)), 'the dropped server must have unregistered every tool')

  await fiber.dispose()
  assert.equal(registered.length, 0, 'dispose must unregister every child’s tools')
  liveNote = `live mount registered ${seen.join(' + ')} namespaces, a volatile edit swapped probeB for probeD, and dispose unregistered them`
}

// --- 7. source guards on the retired / duplicated machinery -----------------------
const src = await readFile(hostPath, 'utf8')
assert.ok(!src.includes('StreamableHTTPClientTransport'), 'the transport must stay inside the official package')
assert.ok(!src.includes('ctx.settings.register'), '0.2.0-rc.2 has no settings registration call')
assert.ok(!/return\s+ctx\.plugin\(/.test(src), 'apply() must not return a child fiber (Cordis reads it as an Effect)')
assert.ok(src.includes("'loader/volatile-update'"),
  'a volatile-only servers edit never re-applies; apply() must reconcile on loader/volatile-update')

console.log(`load-smoke OK: real Cordis loaded mcp-servers; inject=["tools"], servers volatile, box unwrapped, disabled skipped, duplicates collapsed, transport pinned with the official defaults filled, volatile edits reconciled; ${liveNote}`)
