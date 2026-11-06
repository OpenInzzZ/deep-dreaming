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
 * Also guards:
 *  - the plugin registers NO timer: the automatic-cleanup feature was removed
 *    on request, so loading must leave the process with nothing scheduled;
 *  - the transport is a fenced PREFIX route on the `webServer` service, which
 *    is a DECLARED dependency — never a `connection.rpc` channel, which dsh
 *    0.1.5-rc.1 cannot register for a plugin outside the connection package;
 *  - `listArchived` reads the archive set from `workspaceRegistry`, never
 *    guesses it from directory names;
 *  - `deleteArchived` refuses a live session and deletes an archived one end
 *    to end over the real route;
 *  - `enabled: false` refuses deletion;
 *  - a boot whose `webServer` arrives LATE still registers the route.
 *
 * @deepseek-ai/cordis resolution: this file resolves packages from the patch
 * dir's node_modules or the deployed profile tree (~/.dsh/profiles/node_modules).
 *   node patches/session-cleanup/tests/load-smoke.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, delimiter } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
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
    'node_modules; run `npm install` in the patch dir or point NODE_PATH at a node_modules that contains it',
  )
}

const { Context } = await import(pathToFileURL(resolveCordisEntry()).href)
const host = await import(pathToFileURL(hostPath).href)

/** `webServer` service double; routes are driven from THIS object, not from ctx.get(). */
const makeWebServer = () => {
  const routes = []
  let disposers = 0
  return {
    routes,
    disposeCount: () => disposers,
    service: {
      register: (route) => {
        const entry = { kind: route.kind, path: route.path, handler: route.handler }
        routes.push(entry)
        return () => {
          disposers += 1
          const at = routes.indexOf(entry)
          if (at >= 0) routes.splice(at, 1)
        }
      },
    },
  }
}

/** Drive one registered prefix route with a fake req/res. */
const postRoute = async (route, pathname, payload, headers = {}) => {
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const res = {
    status: null,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, extra) {
      this.status = status
      for (const [name, value] of Object.entries(extra ?? {})) this.headers[name.toLowerCase()] = value
      return this
    },
    end(chunk) {
      this.body = String(chunk ?? '')
      this.writableEnded = true
      settle(this)
      return this
    },
  }
  const listeners = new Map()
  const req = {
    method: 'POST',
    url: pathname,
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', ...headers },
    destroy() { settle(res) },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return req
    },
  }
  await route.handler(req, res)
  for (const listener of [...(listeners.get('data') ?? [])]) listener(Buffer.from(JSON.stringify(payload ?? {}), 'utf8'))
  for (const listener of [...(listeners.get('end') ?? [])]) listener()
  return Promise.race([
    done,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`route ${pathname} never answered`)), 2000).unref?.()
    }),
  ])
}

const callRoute = async (route, endpoint, args) => {
  const res = await postRoute(route, `/session-cleanup/${endpoint}`, { args })
  return { status: res.status, envelope: JSON.parse(res.body) }
}

/** Build a fake session directory tree under a temp root. */
const makeSessionDir = (root, project, dirName) => {
  const dir = join(root, project, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(256, 0x61))
  return dir
}

// --- enabled: true — provide the services, then load for real -------------------
const sessionsRoot = mkdtempSync(join(tmpdir(), 'cleanup-smoke-'))
const archivedOwned = 'session-archived-owned-1'
const archivedLive = 'session-archived-live-2'
const notArchived = 'session-not-archived-3'
const archivedDir = makeSessionDir(sessionsRoot, 'proj-a', archivedOwned)
makeSessionDir(sessionsRoot, 'proj-a', archivedLive)
makeSessionDir(sessionsRoot, 'proj-a', notArchived)

const ctx = new Context()
const connectionCalls = []
ctx.provide('connection', {
  rpc: {
    // Kept only to prove the migrated host half no longer touches this API.
    handle: (channel, options) => {
      connectionCalls.push({ channel, options })
      return () => {}
    },
  },
})
ctx.provide('sessions', { list: () => [{ id: archivedLive }] })
// The archive set is the single authority for "archived" — never a guess.
ctx.provide('workspaceRegistry', { archivedSessionIds: [archivedOwned, archivedLive] })

const webServer = makeWebServer()
ctx.provide('webServer', webServer.service)

const fiber = ctx.plugin(host, { enabled: true, sessionsRoot })
await fiber

assert.equal(connectionCalls.length, 0, 'the host half must not call ctx.connection.rpc.handle any more')
assert.equal(webServer.routes.length, 1, `webServer.register must be called exactly once, got ${webServer.routes.length}`)
assert.equal(webServer.routes[0].path, '/session-cleanup')
assert.equal(webServer.routes[0].kind, 'prefix', 'a prefix route is what the page POSTs /<channel>/<endpoint> to')
const route = webServer.routes[0]

// No timer may be scheduled: automatic cleanup was removed on request.
assert.equal(
  fiber.ctx.get('timer') ?? undefined, undefined,
  'the plugin must not require the timer service',
)

// getConfig still answers end-to-end from the entry config.
{
  const { status, envelope } = await callRoute(route, 'getConfig')
  assert.equal(status, 200)
  assert.equal(envelope.ok, true)
  assert.equal(envelope.value.enabled, true)
  assert.equal(envelope.value.sessionsRoot, sessionsRoot)
  // The removed automatic-cleanup knobs must be gone from the resolved config.
  for (const gone of ['maxAgeDays', 'maxTotalMB', 'keepSessions', 'intervalMinutes', 'dryRun']) {
    assert.equal(gone in envelope.value, false, `config must no longer expose ${gone}`)
  }
}

// listArchived lists ONLY the archive set, marking the live one undeletable.
{
  const { envelope } = await callRoute(route, 'listArchived')
  assert.equal(envelope.ok, true)
  const ids = envelope.value.items.map((item) => item.id).sort()
  assert.deepEqual(ids, [archivedOwned, archivedLive].sort(), 'only archived sessions may be listed')
  const live = envelope.value.items.find((item) => item.id === archivedLive)
  const owned = envelope.value.items.find((item) => item.id === archivedOwned)
  assert.equal(live.live, true)
  assert.equal(live.deletable, false)
  assert.equal(owned.live, false)
  assert.equal(owned.deletable, true)
  assert.ok(envelope.value.totalBytes > 0)
}

// A live session is refused even though it is archived.
{
  const { envelope } = await callRoute(route, 'deleteArchived', { ids: [archivedLive] })
  assert.equal(envelope.ok, true)
  assert.equal(envelope.value.removed.length, 0)
  assert.equal(envelope.value.refused[0].reason, 'live')
  assert.equal(existsSync(join(sessionsRoot, 'proj-a', archivedLive)), true)
}

// An unarchived session is refused.
{
  const { envelope } = await callRoute(route, 'deleteArchived', { ids: [notArchived] })
  assert.equal(envelope.value.refused[0].reason, 'not-archived')
  assert.equal(existsSync(join(sessionsRoot, 'proj-a', notArchived)), true)
}

// The archived, non-live session is really deleted.
{
  const { envelope } = await callRoute(route, 'deleteArchived', { ids: [archivedOwned] })
  assert.equal(envelope.ok, true)
  assert.equal(envelope.value.removed.length, 1)
  assert.equal(envelope.value.removed[0].id, archivedOwned)
  assert.ok(envelope.value.freedBytes > 0)
  assert.equal(existsSync(archivedDir), false, 'the whole session directory must be gone')
}

// A malformed delete request is refused before touching the filesystem.
{
  const { envelope } = await callRoute(route, 'deleteArchived', { ids: [] })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'bad-request')
}

// The entry config is validated against plugin.Config. The old `intervalMinutes`
// bound is gone with the feature, so an unknown key is simply ignored rather
// than rejecting the whole entry. This runs on its OWN context so it cannot
// disturb the route/disposer accounting above.
{
  const ctxX = new Context()
  const webX = makeWebServer()
  ctxX.provide('webServer', webX.service)
  ctxX.provide('sessions', { list: () => [] })
  ctxX.provide('workspaceRegistry', { archivedSessionIds: [] })
  const accepted = ctxX.plugin(host, { enabled: true, sessionsRoot, intervalMinutes: 0 })
  await accepted
  assert.equal(webX.routes.length, 1, 'an unknown legacy key must not prevent the plugin from loading')
  await accepted.dispose()
  assert.equal(webX.routes.length, 0)
}

await fiber.dispose()
assert.equal(webServer.routes.length, 0, 'dispose must run the route disposer')
assert.equal(webServer.disposeCount(), 1, 'the route disposer must run exactly once')
rmSync(sessionsRoot, { recursive: true, force: true })

// --- enabled: false — the route exists but refuses to delete --------------------
{
  const root2 = mkdtempSync(join(tmpdir(), 'cleanup-smoke-off-'))
  try {
    const id = 'session-off-1'
    const dir = makeSessionDir(root2, 'p', id)
    const ctx2 = new Context()
    const web2 = makeWebServer()
    ctx2.provide('webServer', web2.service)
    ctx2.provide('sessions', { list: () => [] })
    ctx2.provide('workspaceRegistry', { archivedSessionIds: [id] })
    const fiber2 = ctx2.plugin(host, { enabled: false, sessionsRoot: root2 })
    await fiber2
    const route2 = web2.routes[0]
    assert.ok(route2, 'the transport stays registered even when disabled, so the page can report why')

    const listed = await callRoute(route2, 'listArchived')
    assert.equal(listed.envelope.ok, true)
    assert.equal(listed.envelope.value.disabled, true)
    assert.equal(listed.envelope.value.items.length, 0)

    const deleted = await callRoute(route2, 'deleteArchived', { ids: [id] })
    assert.equal(deleted.envelope.ok, false)
    assert.equal(deleted.envelope.error.code, 'disabled')
    assert.equal(existsSync(dir), true, 'a disabled plugin must never delete anything')

    await fiber2.dispose()
  } finally {
    rmSync(root2, { recursive: true, force: true })
  }
}

// --- no `webServer` service yet: the transport WAITS for it ----------------------
{
  const ctx3 = new Context()
  ctx3.provide('sessions', { list: () => [] })
  ctx3.provide('workspaceRegistry', { archivedSessionIds: [] })
  const web3 = makeWebServer()
  const fiber3 = ctx3.plugin(host, { enabled: true, sessionsRoot: tmpdir() })
  await fiber3
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(web3.routes.length, 0, 'with no webServer the gate must not have run: nothing may be registered')

  ctx3.provide('webServer', web3.service)
  const deadline = Date.now() + 2000
  while (web3.routes.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(web3.routes.length, 1, `a LATE webServer must still activate the transport, got ${web3.routes.length} route(s)`)
  assert.equal(web3.routes[0].path, '/session-cleanup')
  assert.equal(web3.routes[0].kind, 'prefix')
  await fiber3.dispose()
  assert.equal(web3.routes.length, 0, 'dispose must unregister the late-registered route')
}

console.log('load-smoke OK: real Cordis ctx.plugin() loaded session-cleanup.mjs; no timer is registered; /session-cleanup is a prefix route on the DECLARED webServer dependency; listArchived reads the workspaceRegistry archive set; deleteArchived refuses live and unarchived sessions, deletes an archived one end to end, and enabled:false refuses everything; a LATE webServer still activates the transport')