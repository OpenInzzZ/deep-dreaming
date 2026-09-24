/**
 * Functional harness for the user-level ui-settings-other patch.
 *
 * Transport note: this patch no longer registers a `ctx.connection.rpc`
 * channel. In dsh 0.1.5-rc.1 that registry throws `cannot get property
 * "webServer" without inject` for every plugin outside the connection package,
 * and because the throw happens inside the `ctx.inject` callback it also rolls
 * back everything that callback had already registered. The host half now
 * registers one `{ kind: 'prefix', path: '/app' }` route on the `webServer`
 * service (see `createRpcRoute` in lib/index.js) and the browser half calls it
 * with `fetch('/app/<endpoint>', { method: 'POST', … })`. This harness drives
 * the real route handler with a fake req/res, and stubs `fetch` on the client
 * side — nothing here calls `ctx.connection`.
 *
 * Host half: imports the real `lib/index.js`, applies it to a mock Cordis
 * context, and asserts the `/app` prefix route registration plus endpoint
 * validation (never invokes `restart` with a real script — that respawns the
 * process). Covers the runtime-status snapshot (serviceInfo / listeningPorts /
 * dshVersion) and the restart endpoint's session protection (busy refusal /
 * forced cancel). Also guards the P0 regression: `apply` must NOT return a
 * thenable (Cordis treats a returned Fiber as an invalid Effect).
 *
 * The idle auto-stop is gone (feature deleted, settings namespace included), so
 * this harness pins that removal: `status` carries no `idle` key, no settings
 * namespace is registered even when a settings service is present, and the host
 * half arms no interval.
 *
 * The route's own fence is asserted through the real handler: a cross-origin
 * `Origin` is refused (403) without reaching the endpoint, non-POST is 405,
 * a non-JSON content-type is 415, a non-JSON body is 400, an oversized body is
 * 413, and a malformed endpoint path (`/app`, `/app/`, `/app/a/b`) is 404.
 *
 * Diagnostics: drives the real `/ui-settings-other/health` route through a
 * fake req/res (exact kind+path, application/json + no-store, channel /
 * branding flags, warnings text) and pins the fail-soft contract — an
 * unreadable favicon asset degrades its own flag and warning while the `/app`
 * route and its status endpoint stay up. A missing `webServer` warns and
 * registers nothing instead of throwing.
 *
 * Client half: loads the exact deployed `lib/client.js` the browser will
 * execute, feeds it a module table stubbed with the real platform words
 * (react, react/jsx-runtime, ui-primitives), asserts the registration
 * contracts (settings.section + dictionaries, plus the section's exact inject
 * surface), then — when jsdom is available — renders the section and exercises
 * the status block, the create-shortcut flow, the confirm-modal -> restart
 * flow (cancel / confirm / busy / force / waiting / error / progress), through
 * the `/app` route (`fetch` double logs url/method/headers/body). The restart
 * progress is driven against the pids the status double reports, including the
 * 'unknown' tail a changed port produces. Without jsdom the DOM sections are
 * skipped with a notice.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
// CJS view of `node:fs` — the only handle that can be monkey-patched (an ESM
// namespace object is immutable). `syncBuiltinESMExports()` then republishes
// the patch to the named imports the host half already linked (see section 2d).
import fs from 'node:fs'
// Same trick for the installer shell-out in section 2f.
import childProcess from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const userProfile = process.env.USERPROFILE ?? process.env.HOME ?? ''
const profileAnchor = join(userProfile, '.dsh', 'profiles', 'web', 'package.json')
// Resolve from the deployed profile first; a DSH reinstall can prune the
// profile's hoisted copies (dangling links), so the harness checkout backs it up.
const harnessAnchor = 'D:/GitHub/deepseek-harness/apps/web/package.json'
const uiRequire = (spec) => {
  try { return createRequire(profileAnchor)(spec) } catch { return createRequire(harnessAnchor)(spec) }
}
const React = uiRequire('react')

// jsdom is optional: without it the DOM sections are skipped and the host +
// contract checks still run.
let JSDOM = null
try { JSDOM = uiRequire('jsdom').JSDOM } catch { /* skip */ }
const DOM_AVAILABLE = JSDOM !== null

const hostPath = join(here, 'lib', 'index.js')
const clientPath = join(here, 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-client-ui-settings-other'
const CARD_ID = '@local/dsh-client-ui-settings-other'

// --- host half: registration + endpoint validation ---------------------------
const host = await import(pathToFileURL(hostPath).href)

// Pure helpers
{
  const resolved = host.resolveRestartScript({})
  if (!resolved.toLowerCase().endsWith('.dsh\\scripts\\restart-dsh.ps1')) throw new Error(`default script path: ${resolved}`)
  const custom = host.resolveRestartScript({ script: 'C:\\Custom\\restart.ps1' })
  if (custom !== 'C:\\Custom\\restart.ps1') throw new Error(`custom script path: ${custom}`)
  const invocation = host.buildRestartSpawn(resolved)
  if (invocation.file !== 'powershell') throw new Error(`spawn file: ${invocation.file}`)
  const outer = invocation.args.join(' ')
  // The outer powershell gets no script of its own (`-File` may only appear
  // inside the Start-Process argument string).
  if (invocation.args.includes('-File')) throw new Error(`the outer powershell must only start a process, got: ${outer}`)
  for (const fragment of ['-Command', 'Start-Process', "$PSHOME 'powershell.exe'", '-WindowStyle Hidden', '-PassThru', '$p.WaitForExit()', 'exit $p.ExitCode', resolved]) {
    if (!outer.includes(fragment)) throw new Error(`spawn invocation must contain ${JSON.stringify(fragment)}: ${outer}`)
  }
  // A path with spaces must reach the inner command line quoted with DOUBLE
  // quotes (single quotes there run nothing at all).
  const spacedInner = host.buildRestartSpawn('C:\\a b\\restart-dsh.ps1', ['-OpenBrowser']).args[4]
  if (!spacedInner.includes('"C:\\a b\\restart-dsh.ps1"')) throw new Error(`a spaced path must be double-quoted: ${spacedInner}`)
  if (spacedInner.includes("'C:\\a b")) throw new Error(`a spaced path must not be single-quoted: ${spacedInner}`)
  const cancelled = []
  const agents = {
    list: () => [
      { id: 'sess-a', status: 'running', cancel: (cause, opts) => cancelled.push({ id: 'sess-a', cause, opts }) },
      { id: 'sess-b', status: 'idle', cancel: () => cancelled.push({ id: 'sess-b' }) },
    ],
    get: (id) => agents.list().find((a) => a.id === id),
  }
  const running = host.runningSessionIds(agents)
  if (running.join(',') !== 'sess-a') throw new Error(`runningSessionIds: ${running}`)
  console.log('host helpers OK: resolveRestartScript + buildRestartSpawn + runningSessionIds')
}

// Version helpers: the guard behind "有更新". Prerelease ordering is the trap
// (`0.1.5-rc.10` > `0.1.5-rc.9`, a release beats its own prereleases, and an
// unparseable side must never read as "newer").
{
  const cases = [
    ['0.1.5-rc.2', '0.1.5-rc.3', true],
    ['0.1.5-rc.3', '0.1.5-rc.2', false],
    ['0.1.5-rc.3', '0.1.5-rc.3', false],
    ['0.1.5', '0.1.5-rc.3', false],
    ['0.1.5-rc.3', '0.1.5', true],
    ['0.1.5-rc.3', '0.1.6-alpha.1', true],
    ['0.1.5-rc.9', '0.1.5-rc.10', true],
    ['0.1.7-alpha.2', '0.1.5-rc.3', false],
    ['nonsense', '0.1.5', false],
    ['0.1.5', 'nonsense', false],
  ]
  for (const [installed, candidate, expected] of cases) {
    if (host.isNewerVersion(installed, candidate) !== expected) {
      throw new Error(`isNewerVersion(${installed}, ${candidate}) must be ${expected}`)
    }
  }
  // npmrc parsing: the top-level registry line only — the same file carries auth
  // tokens for other scopes, and neither they nor the scoped registries may
  // reach the answer.
  const npmrc = [
    '@swire:registry=https://jihulab.example/api/',
    '//jihulab.example/:_authToken=SECRET',
    'registry=https://registry.example/',
    '',
  ].join('\n')
  const registry = host.parseRegistry(npmrc)
  if (registry !== 'https://registry.example') throw new Error(`parseRegistry: ${registry}`)
  if (registry.includes('SECRET') || registry.includes('jihulab')) throw new Error('parseRegistry leaked a scoped registry or its token')
  if (host.parseRegistry('# registry=https://nope/\n') !== 'https://registry.npmjs.org') throw new Error('a commented registry line must be ignored')
  if (host.parseRegistry('') !== 'https://registry.npmjs.org') throw new Error('an absent registry must fall back to the public one')
  console.log(`version helpers OK: ${cases.length} semver cases + npmrc registry parsing (no token leakage)`)
}

// Spawn smoke: the invocation the restart endpoint uses must really EXECUTE the
// script. Windows PowerShell 5.1 spawned `detached` exits 0 without running a
// single line — which is how the restart button silently did nothing (no kill,
// no log, no warning; the page just sat on stage 1 until its budget ran out).
// This boots the REAL invocation against stubs and asserts both halves of the
// contract: the script runs, and its exit code reaches the wrapper (the
// endpoint clears its restart lock on a non-zero code).
{
  const smokeDir = mkdtempSync(join(tmpdir(), 'ui-settings-other-spawn-'))
  const marker = join(smokeDir, 'marker.txt')
  const stub = join(smokeDir, 'stub.ps1')
  const failingStub = join(smokeDir, 'failing-stub.ps1')
  writeFileSync(stub, [
    'param([switch]$OpenBrowser)',
    `Set-Content -Path '${marker}' -Value ("ran openBrowser=$OpenBrowser") -Encoding UTF8`,
    'exit 0',
    '',
  ].join('\n'))
  writeFileSync(failingStub, ['param([switch]$OpenBrowser)', 'exit 7', ''].join('\n'))

  /** Exactly how `apply` boots the script (no `detached`, stdio ignored). */
  const boot = (script, args) => {
    const invocation = host.buildRestartSpawn(script, args)
    const child = childProcess.spawn(invocation.file, invocation.args, {
      stdio: 'ignore', cwd: process.cwd(), env: process.env, windowsHide: true,
    })
    child.unref()
    return child
  }
  const waitFor = async (predicate, label, ms = 30_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error(`${label} (waited ${ms}ms)`)
  }

  boot(stub, ['-OpenBrowser'])
  await waitFor(() => existsSync(marker), 'the restart script was never executed by the host invocation')
  const written = readFileSync(marker, 'utf8').trim()
  if (written !== 'ran openBrowser=True') throw new Error(`stub marker: ${written}`)

  let failingExit = null
  const failing = boot(failingStub, [])
  failing.on('exit', (code) => { failingExit = code })
  await waitFor(() => failingExit !== null, 'the wrapper process never exited', 20_000)
  if (failingExit !== 7) throw new Error(`the script's exit code must reach the wrapper, got ${failingExit}`)
  console.log('spawn smoke OK: the host invocation really executes the script (marker written, openBrowser passed through) and forwards exit 7')
}

// Branding helpers: favicon SVG wrapper + icon asset (idempotent copy)
{
  const svg = host.faviconSvg(host.patchAssetPath('favicon-128.png'))
  if (!svg.startsWith('<?xml') || !svg.includes('data:image/png;base64,')) throw new Error(`faviconSvg shape: ${svg.slice(0, 80)}`)
  if (!svg.includes('viewBox="0 0 128 128"')) throw new Error('faviconSvg must declare the 128 viewBox')
  const icon = host.ensureIconAsset()
  if (!icon.toLowerCase().endsWith('.dsh\\assets\\deepseekharness-whalegirl.ico')) throw new Error(`icon path: ${icon}`)
  if (!existsSync(icon)) throw new Error('ensureIconAsset must materialize the icon file')
  const again = host.ensureIconAsset()
  if (again !== icon) throw new Error('ensureIconAsset must be idempotent')
  console.log('branding OK: faviconSvg (png data URI) + ensureIconAsset (idempotent)')
}

// Desktop-shortcut status: `created` must come from the installer, not be assumed.
{
  const script = host.shortcutScriptPath()
  if (!script.toLowerCase().endsWith('.dsh\\scripts\\install-desktop-shortcut.ps1')) throw new Error(`shortcut script path: ${script}`)
  const untouched = 'shortcut already exists with -Pause: C:\\Users\\x\\Desktop\\dsh-web.lnk (use -Force to overwrite)'
  const written = 'created C:\\Users\\x\\Desktop\\dsh-web.lnk\ntarget : C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  if (host.shortcutAlreadyExisted(untouched) !== true) throw new Error('an untouched existing shortcut must report created:false')
  if (host.shortcutAlreadyExisted(written) !== false) throw new Error('a written shortcut must report created:true')
  if (host.shortcutAlreadyExisted('') !== false) throw new Error('empty installer output must not read as "already exists"')
  console.log('installShortcut OK: created/existed derived from the installer report')
}

// Runtime snapshot helpers
{
  const info = host.serviceInfo()
  if (info.pid !== process.pid) throw new Error(`serviceInfo.pid: ${info.pid} != ${process.pid}`)
  if (!Number.isFinite(info.uptime) || info.uptime < 0) throw new Error(`serviceInfo.uptime: ${info.uptime}`)
  if (!(info.rss > 0)) throw new Error(`serviceInfo.rss: ${info.rss}`)
  if (info.node !== process.version) throw new Error(`serviceInfo.node: ${info.node}`)
  if (typeof info.execPath !== 'string' || info.execPath.length === 0) throw new Error(`serviceInfo.execPath: ${info.execPath}`)
  if (!Array.isArray(info.ports) || info.ports.some((p) => !Number.isInteger(p))) throw new Error(`serviceInfo.ports: ${JSON.stringify(info.ports)}`)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(info.startedAt)) throw new Error(`serviceInfo.startedAt: ${info.startedAt}`)
  // dsh version resolves from the real CLI entry in the npx cache (when present)
  const npxRoot = join(userProfile, 'AppData', 'Local', 'npm-cache', '_npx', '1e7f6d9597241db0', 'node_modules', '@deepseek-ai', 'dsh')
  const binPath = join(npxRoot, 'lib', 'bin.js')
  const pkgPath = join(npxRoot, 'package.json')
  if (readFileSync(pkgPath, 'utf8').length > 0) {
    const expectedVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version
    const version = host.dshVersion(binPath)
    if (version !== expectedVersion) throw new Error(`dshVersion: ${version} != ${expectedVersion}`)
    console.log(`host snapshot OK: pid=${info.pid} ports=[${info.ports}] dsh=${version} node=${info.node}`)
  } else {
    console.log(`host snapshot OK: pid=${info.pid} ports=[${info.ports}] (dsh version check skipped: ${pkgPath} missing)`)
  }
}

let cancelled = []
let innerCtx = null
// Diagnostic-surface doubles, owned by the sections below:
// - `hostWarns` collects the real logger.warn text (the health route's own
//   `warnings` array is read back over the route itself);
// - `webServerStub` is the `webServer` service double (null = service absent);
// - `routeEvents` is one ordered log of route registrations, which is how "the
//   health route is registered at the START of the callback, before every
//   optional step and before /app" is asserted;
// - `settingsInjectAttempts` counts `inject(['settings'])`: this plugin owns no
//   settings namespace any more, so it must stay 0;
// - `intervals` counts every setInterval the host half arms (it owns no timer
//   now that the idle monitor is gone).
let hostWarns = []
let webServerStub = null
let routeEvents = []
let agentsListCalls = 0
let settingsInjectAttempts = 0
const intervals = new Set()
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
globalThis.setInterval = (fn, ms) => {
  const handle = realSetInterval(fn, ms)
  intervals.add(handle)
  return handle
}
globalThis.clearInterval = (handle) => {
  intervals.delete(handle)
  return realClearInterval(handle)
}
const fakeAgents = {
  list: () => {
    // Counted so the fence assertions can prove that a refused request never
    // reached the endpoint (the `status` endpoint is the only observer-free
    // way to tell: it reads the agent list first).
    agentsListCalls += 1
    return [
      { id: 'sess-a', status: 'running', cancel: (cause, opts) => cancelled.push({ id: 'sess-a', cause, opts }) },
    ]
  },
  get: (id) => fakeAgents.list().find((a) => a.id === id),
}
/**
 * The transport moved off `connection` entirely (see the file header), so this
 * double keeps only a TRIPWIRE there: reading any property of it throws. A
 * surviving `ctx.connection.rpc.handle(...)` would therefore fail loudly
 * instead of "registering a channel" into a variable nothing reads. The name
 * is still declared in the plugin's inner inject gate, which this mock resolves
 * by string, so the tripwire never blocks the callback.
 */
const connectionTripwire = () => new Proxy({}, {
  get: (_target, prop) => {
    throw new Error(`ctx.connection.${String(prop)} was read: the transport must go through webServer`)
  },
})
const hostCtx = {
  connection: connectionTripwire(),
  inject: (services, callback) => {
    const list = services.join(',')
    // `webServer` is declared (not an optional read): the carrier is bound
    // late, so reading it during this callback would race its activation and
    // silently skip the whole transport. `agents` stays for session queries.
    if (list === 'webServer,agents') {
      innerCtx = {
        connection: connectionTripwire(),
        agents: fakeAgents,
        logger: { info: () => {}, warn: (message) => { hostWarns.push(String(message)) } },
        get: (name) => {
          if (name === 'webServer') return webServerStub ?? undefined
          return undefined
        },
        inject: hostCtx.inject,
        effect: (fn) => fn(),
        fiber: { state: 0 },
      }
      return callback(innerCtx)
    }
    // A settings service may be present in the environment; this plugin owns no
    // namespace any more, so an `inject(['settings'])` from it must never happen.
    if (list === 'settings') {
      settingsInjectAttempts += 1
      return callback({ ...innerCtx, settings: { register: () => { throw new Error('this plugin must register no settings namespace') } } })
    }
    return undefined
  },
  effect: (fn) => fn(),
}

// config.script points at a NON-EXISTENT path so the restart endpoint fails
// cleanly (script-missing branch) instead of spawning a real restart.
const MISSING_SCRIPT = 'C:\\__no_such_dir__\\restart-dsh.ps1'
// Temp dir for harness-owned stub scripts (never the real profile layer).
const harnessTmpDir = mkdtempSync(join(tmpdir(), 'ui-settings-other-verify-'))

/**
 * Every RPC failure must carry the repository's full envelope
 * `{ ok: false, error: { code, message, details } }` — an empty `details` is
 * allowed, a missing one is not.
 */
const assertErrorEnvelope = (label, result) => {
  if (result?.ok !== false) throw new Error(`${label}: expected ok:false, got ${JSON.stringify(result)}`)
  const { code, message, details } = result.error ?? {}
  if (typeof code !== 'string' || code.length === 0) throw new Error(`${label}: error.code missing`)
  if (typeof message !== 'string' || message.length === 0) throw new Error(`${label}: error.message missing`)
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    throw new Error(`${label}: error.details missing`)
  }
}

// --- route doubles ------------------------------------------------------------
// The host half owns two surfaces on the `webServer` service: its diagnostics
// route `/ui-settings-other/health` (without it, "the /app route never
// registered" and "an optional step threw" look identical from the page — these
// checks are the only place that surface is observed directly) and the `/app`
// prefix route that carries every RPC endpoint.
const HEALTH_PATH = '/ui-settings-other/health'
const FAVICON_PATH = '/favicon.svg'
const APP_PATH = '/app'
const EXPECTED_ROUTE_SURFACE = [`exact ${HEALTH_PATH}`, `exact ${FAVICON_PATH}`, `prefix ${APP_PATH}`]

/** `webServer` service double: records every register() as { kind, path, handler }. */
const makeWebServerStub = () => {
  const routes = []
  return {
    routes,
    register: (route) => {
      routes.push({ kind: route.kind, path: route.path, handler: route.handler })
      routeEvents.push(`route:${route.path}`)
      return () => {} // the real service returns a disposer
    },
  }
}

/**
 * Minimal `req` double: exactly the surface `createRpcRoute`'s handler uses
 * (method / headers / url / on / destroy). `send()` replays the body through
 * the 'data' listener and then closes the stream with 'end' — the same order
 * the carrier delivers them in.
 */
const makeReq = ({ method = 'POST', url = '/', headers = {}, body = '', host = '127.0.0.1:3080' } = {}) => {
  const listeners = new Map()
  const req = {
    method,
    url,
    headers: { host, ...headers },
    destroyed: false,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return req
    },
    destroy() { req.destroyed = true },
    send() {
      if (body.length > 0) for (const listener of listeners.get('data') ?? []) listener(body)
      for (const listener of listeners.get('end') ?? []) listener()
    },
  }
  return req
}

/** `res` double recording writeHead/end; `settled` resolves once end() ran. */
const makeRes = () => {
  let settle
  const settled = new Promise((resolve) => { settle = resolve })
  return {
    status: null,
    headers: {},
    body: '',
    writableEnded: false,
    settled,
    writeHead(status, headers) {
      this.status = status
      for (const [name, value] of Object.entries(headers ?? {})) this.headers[name.toLowerCase()] = value
      return this
    },
    end(chunk) {
      this.body = String(chunk ?? '')
      this.writableEnded = true
      settle(this)
      return this
    },
  }
}

/**
 * Drive one registered route the way the web carrier would. The `/app` handler
 * answers from inside `req.on('end')`, so the response is NOT ready when the
 * handler returns: the request is streamed first, then the response is awaited
 * (with a 2 s guard so a handler that never answers fails the harness instead
 * of hanging it).
 */
const callRoute = async (route, options = {}) => {
  const { guardMs = 2000, ...requestOptions } = options
  const req = makeReq({ url: route.path, ...requestOptions })
  const res = makeRes()
  await route.handler(req, res)
  req.send()
  const guard = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`route ${route.path} never answered (${req.method} ${req.url})`)), guardMs).unref?.()
  })
  await Promise.race([res.settled, guard])
  return res
}

/** The exact health route this apply() registered (both kind and path asserted). */
const healthRouteOf = (stub) => {
  const route = stub.routes.find((r) => r.path === HEALTH_PATH)
  if (route === undefined) {
    throw new Error(`${HEALTH_PATH} never registered (routes: ${JSON.stringify(stub.routes.map((r) => r.path))})`)
  }
  if (route.kind !== 'exact') throw new Error(`${HEALTH_PATH} must be kind 'exact', got '${route.kind}'`)
  return route
}

/**
 * The `/app` route this apply() registered. It replaced the old
 * `ctx.connection.rpc` channel, so the registration is asserted the same way:
 * exact kind + path, and a real handler to drive.
 */
const appRouteOf = (stub) => {
  const route = stub.routes.find((r) => r.path === APP_PATH)
  if (route === undefined) {
    throw new Error(`${APP_PATH} route never registered (routes: ${JSON.stringify(stub.routes.map((r) => `${r.kind} ${r.path}`))})`)
  }
  if (route.kind !== 'prefix') throw new Error(`${APP_PATH} must be kind 'prefix', got '${route.kind}'`)
  if (typeof route.handler !== 'function') throw new Error(`${APP_PATH} route must expose a handler`)
  return route
}

/**
 * One `POST /app/<endpoint>` through the real route handler, the way the
 * browser half sends it, with the answer parsed back into the envelope.
 * `overrides` lets a caller break one part of the request on purpose (the fence
 * assertions below do exactly that).
 */
const callApp = async (stub, endpoint, args, overrides = {}) => {
  const res = await callRoute(appRouteOf(stub), {
    method: 'POST',
    url: `${APP_PATH}/${endpoint}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: args ?? {} }),
    // The version check waits on a registry (up to 5 s), so it gets a longer
    // guard than the local endpoints.
    guardMs: endpoint === 'versionCheck' ? 15_000 : 2000,
    ...overrides,
  })
  if (res.status !== 200) throw new Error(`POST ${APP_PATH}/${endpoint} must answer 200, got ${res.status}: ${res.body}`)
  if (res.headers['content-type'] !== 'application/json') {
    throw new Error(`POST ${APP_PATH}/${endpoint} content-type: ${JSON.stringify(res.headers['content-type'])}`)
  }
  if (res.headers['cache-control'] !== 'no-store') {
    throw new Error(`POST ${APP_PATH}/${endpoint} cache-control: ${JSON.stringify(res.headers['cache-control'])}`)
  }
  return parseBody(`${APP_PATH}/${endpoint}`, res)
}

/** The envelope carried by a route response (must be JSON). */
const parseBody = (label, res) => {
  try {
    return JSON.parse(res.body)
  } catch {
    throw new Error(`${label}: body is not JSON: ${JSON.stringify(res.body).slice(0, 200)}`)
  }
}

/** One refused request: status + envelope code + the JSON/no-store headers. */
const assertRouteFailure = (res, status, code, label) => {
  if (res.status !== status) throw new Error(`${label}: must answer ${status}, got ${res.status}: ${res.body}`)
  if (res.headers['content-type'] !== 'application/json') {
    throw new Error(`${label}: content-type: ${JSON.stringify(res.headers['content-type'])}`)
  }
  if (res.headers['cache-control'] !== 'no-store') {
    throw new Error(`${label}: cache-control: ${JSON.stringify(res.headers['cache-control'])}`)
  }
  const body = parseBody(label, res)
  assertErrorEnvelope(label, body)
  if (body.error.code !== code) throw new Error(`${label}: error.code must be ${code}, got ${JSON.stringify(body)}`)
  return body
}

/**
 * Read the health route the way the page would: real writeHead/end capture,
 * JSON body, exact headers, and one expected value per diagnostic flag.
 */
const readHealth = async (stub, expected, label) => {
  const res = await callRoute(healthRouteOf(stub))
  if (res.status !== 200) throw new Error(`${label}: health must answer 200, got ${res.status}`)
  if (res.headers['content-type'] !== 'application/json') {
    throw new Error(`${label}: content-type must be application/json, got ${JSON.stringify(res.headers['content-type'])}`)
  }
  if (res.headers['cache-control'] !== 'no-store') {
    throw new Error(`${label}: cache-control must be no-store, got ${JSON.stringify(res.headers['cache-control'])}`)
  }
  let body = null
  try {
    body = JSON.parse(res.body)
  } catch {
    throw new Error(`${label}: health body is not JSON: ${JSON.stringify(res.body).slice(0, 200)}`)
  }
  if (body.ok !== true) throw new Error(`${label}: ok must be true, got ${JSON.stringify(body.ok)}`)
  if (body.namespace !== 'ui-settings-other') throw new Error(`${label}: namespace mismatch: ${JSON.stringify(body.namespace)}`)
  if (!Array.isArray(body.warnings)) throw new Error(`${label}: warnings must be an array, got ${JSON.stringify(body.warnings)}`)
  for (const [key, value] of Object.entries(expected)) {
    if (body[key] !== value) {
      throw new Error(`${label}: ${key} must be ${value}, got ${JSON.stringify(body[key])} — body ${JSON.stringify(body)}`)
    }
  }
  return body
}

/** Status is this section's life support: it must answer even when degraded. */
const assertStatusUsable = async (stub, label) => {
  const status = await callApp(stub, 'status')
  if (status?.ok !== true) throw new Error(`${label}: status must still answer ok:true, got ${JSON.stringify(status)}`)
  if (typeof status.value?.running !== 'number') {
    throw new Error(`${label}: status.value.running must be a number, got ${JSON.stringify(status.value?.running)}`)
  }
  return status
}

// 1) apply without a settings service -> entry fallback, status still rich
{
  cancelled = []
  hostWarns = []
  routeEvents = []
  webServerStub = makeWebServerStub()
  const web = webServerStub
  const ret = host.apply(hostCtx, { script: MISSING_SCRIPT })
  // P0 regression guard: returning the ctx.inject() thenable Fiber from apply
  // makes Cordis throw TypeError('Invalid effect') and fail the plugin.
  if (ret !== undefined && (typeof ret === 'object' || typeof ret === 'function') && typeof ret.then === 'function') {
    throw new Error('P0 regression: apply returned a thenable (Invalid effect)')
  }
  // The transport registration: one prefix route at /app (this is what the old
  // `handled.channel === '/app'` + loopback-authority pair asserted).
  const app = appRouteOf(web)
  if (app.path !== APP_PATH) throw new Error(`host route path: ${app.path}`)
  if (hostWarns.length !== 0) throw new Error(`apply must not warn: ${JSON.stringify(hostWarns)}`)

  const status0 = await callApp(web, 'status')
  if (!status0.ok || status0.value.running !== 1 || status0.value.sessions.join(',') !== 'sess-a') {
    throw new Error(`status endpoint: ${JSON.stringify(status0)}`)
  }
  if (status0.value.service?.pid !== process.pid) throw new Error(`status service.pid: ${JSON.stringify(status0.value.service)}`)
  // The idle auto-stop is gone: the envelope must carry no `idle` key at all.
  if (status0.value.idle !== undefined) throw new Error(`status must not carry idle any more: ${JSON.stringify(status0.value.idle)}`)

  const unknown = await callApp(web, 'nope')
  assertErrorEnvelope('unknown endpoint', unknown)
  if (unknown.ok !== false || unknown.error.code !== 'bad-request') throw new Error('unknown endpoint must be rejected')
  if (unknown.error.details.endpoint !== 'nope') throw new Error(`unknown endpoint details: ${JSON.stringify(unknown.error.details)}`)

  // The settings endpoints are gone with the namespace they served.
  for (const endpoint of ['getSettings', 'setSettings', 'resetSettings']) {
    const gone = await callApp(web, endpoint, { fields: { idleMinutes: 5 } })
    assertErrorEnvelope(`${endpoint} after the settings removal`, gone)
    if (gone.error.code !== 'bad-request') {
      throw new Error(`${endpoint} must now be an unknown endpoint: ${JSON.stringify(gone)}`)
    }
  }

  const busy = await callApp(web, 'restart', {})
  assertErrorEnvelope('busy restart', busy)
  if (busy.ok !== false || busy.error.code !== 'sessions-running') throw new Error(`busy must be refused: ${JSON.stringify(busy)}`)
  if (cancelled.length !== 0) throw new Error('non-force restart must not cancel sessions')

  const forced = await callApp(web, 'restart', { force: true })
  assertErrorEnvelope('forced restart (missing script)', forced)
  if (forced.ok !== false || forced.error.code !== 'internal') throw new Error(`forced must reach script check: ${JSON.stringify(forced)}`)
  if (forced.error.details.script !== MISSING_SCRIPT) throw new Error(`restart details.script: ${JSON.stringify(forced.error.details)}`)
  if (cancelled.length !== 1 || cancelled[0].id !== 'sess-a') throw new Error(`force must cancel running sessions: ${JSON.stringify(cancelled)}`)
  if (cancelled[0].opts?.keepInbox !== true) throw new Error('force cancel must keepInbox')

  console.log('host OK: prefix /app route + status(running/service, no idle) + restart session protection (busy/force)')
}

// 2) the removed settings surface, pinned: a settings service may be present in
//    the environment, but this plugin must neither register a namespace nor ask
//    for one — the idle auto-stop was its only consumer.
{
  hostWarns = []
  routeEvents = []
  webServerStub = makeWebServerStub()
  const web = webServerStub
  settingsInjectAttempts = 0

  const ret = host.apply(hostCtx, { script: MISSING_SCRIPT, idleMinutes: 7 })
  if (ret !== undefined && typeof ret.then === 'function') throw new Error('P0 regression: apply returned a thenable (with a settings service present)')
  appRouteOf(web)
  if (settingsInjectAttempts !== 0) {
    throw new Error(`the host half must not inject the settings service any more, asked ${settingsInjectAttempts} time(s)`)
  }
  if (intervals.size !== 0) throw new Error(`the host half must arm no interval, got ${intervals.size}`)
  const status = await callApp(web, 'status')
  if (status.value.idle !== undefined) throw new Error(`status must not carry idle: ${JSON.stringify(status.value)}`)
  // An entry-config key from the deleted feature is inert, not fatal: `Config`
  // keeps unknown keys, so an existing profile entry still boots.
  console.log('host OK: no settings namespace, no interval, and a legacy idleMinutes entry key is tolerated')
}

// 2b) diagnostics route: with a `webServer` service, every apply() publishes an
//     exact `/ui-settings-other/health` that reports what actually attached.
{
  hostWarns = []
  routeEvents = []
  webServerStub = makeWebServerStub()
  const web = webServerStub

  host.apply(hostCtx, { script: MISSING_SCRIPT })

  appRouteOf(web)
  const health = await readHealth(web, { channel: true, branding: true }, 'health (healthy apply)')
  if (health.warnings.length !== 0) throw new Error(`a healthy apply must report no warnings: ${JSON.stringify(health.warnings)}`)
  if (hostWarns.length !== 0) throw new Error(`a healthy apply must log no warnings: ${JSON.stringify(hostWarns)}`)

  // Exactly three routes: both exact routes plus the /app prefix; the favicon
  // route really serves the SVG and /app really answers an endpoint.
  const routeSurface = web.routes.map((r) => `${r.kind} ${r.path}`)
  if (JSON.stringify(routeSurface) !== JSON.stringify(EXPECTED_ROUTE_SURFACE)) {
    throw new Error(`route surface must be exactly ${JSON.stringify(EXPECTED_ROUTE_SURFACE)}, got ${JSON.stringify(routeSurface)}`)
  }
  const faviconRes = await callRoute(web.routes.find((r) => r.path === FAVICON_PATH))
  if (faviconRes.headers['content-type'] !== 'image/svg+xml') {
    throw new Error(`favicon content-type: ${JSON.stringify(faviconRes.headers['content-type'])}`)
  }
  if (!faviconRes.body.startsWith('<?xml') || !faviconRes.body.includes('data:image/png;base64,')) {
    throw new Error(`favicon body shape: ${faviconRes.body.slice(0, 60)}`)
  }

  // Health FIRST: it is registered before every optional step and before the
  // /app prefix route, so a later failure cannot take the diagnostic surface
  // down with it.
  const expectedOrder = `route:${HEALTH_PATH}|route:${FAVICON_PATH}|route:${APP_PATH}`
  if (routeEvents.join('|') !== expectedOrder) {
    throw new Error(`registration order must be ${expectedOrder}, got ${routeEvents.join('|')}`)
  }
  console.log(`host health OK: exact ${HEALTH_PATH} (json + no-store) reports channel/branding, registered first`)
}

// 2d) fail-soft: an unreadable favicon asset must only skip the branding. The
//     failure is injected at the REAL read site — `faviconSvg()` reads
//     assets/favicon-128.png through the `readFileSync` named import of
//     `node:fs` — by patching that function for that one path and republishing
//     it to the already-linked ESM import via `syncBuiltinESMExports()`. No repo
//     file is touched, and the patch is removed in a `finally` before any later
//     read, so every other read in this harness stays real.
{
  const faviconAsset = host.patchAssetPath('favicon-128.png')

  hostWarns = []
  routeEvents = []
  webServerStub = makeWebServerStub()
  const web = webServerStub

  const realReadFileSync = fs.readFileSync
  let injected = 0
  let applyFailure = null
  try {
    fs.readFileSync = function readFileSyncWithUnreadableFavicon(path, ...rest) {
      if (String(path) === faviconAsset) {
        injected += 1
        const error = new Error(`ENOENT: no such file or directory, open '${path}'`)
        error.code = 'ENOENT'
        throw error
      }
      return realReadFileSync.call(fs, path, ...rest)
    }
    syncBuiltinESMExports() // the host half's named import now sees the patch
    try { host.apply(hostCtx, { script: MISSING_SCRIPT }) } catch (error) { applyFailure = error }
  } finally {
    fs.readFileSync = realReadFileSync
    syncBuiltinESMExports()
  }

  if (applyFailure !== null) {
    throw new Error(`fail-soft regression: an unreadable favicon asset must not escape apply (threw: ${applyFailure.message})`)
  }
  appRouteOf(web)
  if (injected !== 1) throw new Error(`the favicon asset must be read exactly once, injected ${injected} failure(s)`)
  // The injection is really gone: the asset reads again, and it is a real PNG.
  const png = readFileSync(faviconAsset)
  if (png.subarray(0, 4).toString('hex') !== '89504e47') throw new Error('the favicon asset must read as PNG after the probe')

  const health = await readHealth(web, { channel: true, branding: false }, 'health (favicon unreadable)')
  if (health.warnings.length !== 1 || !/^favicon override skipped/.test(health.warnings[0]) || !health.warnings[0].includes('ENOENT')) {
    throw new Error(`the favicon failure must be reported once, with its cause: ${JSON.stringify(health.warnings)}`)
  }
  const routeSurface = web.routes.map((r) => `${r.kind} ${r.path}`)
  const expectedSurface = [`exact ${HEALTH_PATH}`, `prefix ${APP_PATH}`]
  if (JSON.stringify(routeSurface) !== JSON.stringify(expectedSurface)) {
    throw new Error(`a skipped branding must register no favicon route, got ${JSON.stringify(routeSurface)}`)
  }
  await assertStatusUsable(web, 'degraded status (favicon unreadable)')
  console.log('host fail-soft OK: an unreadable favicon asset skips branding only; /app + status stay up')
}

// 2e) the /app route's fence, driven through the real handler. This is the
//     access-control surface that replaced the Connection's own loopback
//     authority, so every branch is asserted on the wire: cross-origin refusal
//     (403, endpoint never reached), POST-only (405), JSON-only bodies (415,
//     400), the 1 MB cap (413), and endpoint-path parsing (404 for a bare,
//     trailing-slash or multi-segment path; the query string is not part of the
//     endpoint).
{
  hostWarns = []
  routeEvents = []
  webServerStub = makeWebServerStub()
  const web = webServerStub
  host.apply(hostCtx, { script: MISSING_SCRIPT })
  const route = appRouteOf(web)

  // (1) Cross-origin: `Origin` present and different from `Host` -> 403, and the
  //     endpoint must not run. `status` reads the agent list first, which is the
  //     observable side effect that proves the handler never got there.
  agentsListCalls = 0
  const crossOrigin = await callRoute(route, {
    method: 'POST',
    url: `${APP_PATH}/status`,
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{"args":{}}',
  })
  assertRouteFailure(crossOrigin, 403, 'forbidden', 'cross-origin POST')
  if (agentsListCalls !== 0) throw new Error('a refused cross-origin request must not reach the endpoint')

  // (2) Positive control: the SAME request with a same-origin `Origin` is served —
  //     and so is one with no `Origin` at all, which is the plain same-origin
  //     fetch the browser half actually sends.
  agentsListCalls = 0
  const sameOrigin = await callRoute(route, {
    method: 'POST',
    url: `${APP_PATH}/status`,
    headers: { origin: 'http://127.0.0.1:3080', 'content-type': 'application/json' },
    body: '{"args":{}}',
  })
  if (sameOrigin.status !== 200) throw new Error(`same-origin POST must be served, got ${sameOrigin.status}: ${sameOrigin.body}`)
  if (parseBody('same-origin status', sameOrigin).ok !== true) throw new Error('same-origin status must answer ok:true')
  if (agentsListCalls !== 1) throw new Error(`same-origin status must reach the endpoint once, got ${agentsListCalls}`)
  agentsListCalls = 0
  const noOrigin = await callApp(web, 'status')
  if (noOrigin.ok !== true) throw new Error(`a request without Origin must be served: ${JSON.stringify(noOrigin)}`)
  if (agentsListCalls !== 1) throw new Error(`a request without Origin must reach the endpoint once, got ${agentsListCalls}`)

  // (3) POST only.
  const notPost = await callRoute(route, {
    method: 'GET',
    url: `${APP_PATH}/status`,
    headers: { 'content-type': 'application/json' },
  })
  assertRouteFailure(notPost, 405, 'method-not-allowed', 'GET /app/status')

  // (4) JSON bodies only.
  const wrongType = await callRoute(route, {
    method: 'POST',
    url: `${APP_PATH}/status`,
    headers: { 'content-type': 'text/plain' },
    body: '{"args":{}}',
  })
  assertRouteFailure(wrongType, 415, 'unsupported-media-type', 'text/plain POST')

  // (5) A body that is not JSON.
  const badJson = await callRoute(route, {
    method: 'POST',
    url: `${APP_PATH}/status`,
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  assertRouteFailure(badJson, 400, 'bad-request', 'non-JSON body')

  // (6) Endpoint parsing: a bare prefix, a trailing slash and any multi-segment
  //     path are all "unknown endpoint" — never a silently accepted alias.
  for (const [path, label] of [[APP_PATH, 'bare prefix'], [`${APP_PATH}/`, 'trailing slash'], [`${APP_PATH}/a/b`, 'multi-segment']]) {
    const malformed = await callRoute(route, {
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/json' },
      body: '{"args":{}}',
    })
    assertRouteFailure(malformed, 404, 'unknown-endpoint', label)
  }

  // (7) The 1 MB cap and the query string.
  const oversized = await callRoute(route, {
    method: 'POST',
    url: `${APP_PATH}/status`,
    headers: { 'content-type': 'application/json' },
    body: `{"args":"${'x'.repeat(1 << 20)}"}`,
  })
  assertRouteFailure(oversized, 413, 'payload-too-large', 'oversized body')
  const queried = await callRoute(route, {
    method: 'POST',
    url: `${APP_PATH}/status?probe=1`,
    headers: { 'content-type': 'application/json' },
    body: '{"args":{}}',
  })
  if (queried.status !== 200) throw new Error(`a query string must not change the endpoint, got ${queried.status}: ${queried.body}`)
  console.log('host fence OK: 403 cross-origin (endpoint unreached) | 405 non-POST | 415 non-JSON type | 400 bad JSON | 413 oversized | 404 bare/trailing/multi-segment')
}

// 2f) the installShortcut endpoint through the real route. It shells out to
//     powershell, so `execFileSync` is scripted out for the duration (CJS view +
//     syncBuiltinESMExports, the same technique as the favicon probe): the
//     endpoint, its argument vector and its envelope stay real, but no process
//     starts and no desktop shortcut is ever created.
{
  hostWarns = []
  routeEvents = []
  webServerStub = makeWebServerStub()
  const web = webServerStub
  host.apply(hostCtx, { script: MISSING_SCRIPT })
  appRouteOf(web)

  const installerDeployed = existsSync(host.shortcutScriptPath())
  const realExecFileSync = childProcess.execFileSync
  const scripted = []
  let created = null
  let failed = null
  try {
    childProcess.execFileSync = (file, args, options) => {
      scripted.push({ file, args, options })
      return 'created C:\\Users\\x\\Desktop\\dsh-web.lnk\ntarget : powershell.exe\n'
    }
    syncBuiltinESMExports() // installShortcut's named import now sees the stub
    created = await callApp(web, 'installShortcut')

    // The installer failing is the endpoint's ok:false branch (its own output is
    // the message, and the script path rides along in details).
    childProcess.execFileSync = () => {
      const error = new Error('powershell exited with code 1')
      error.stdout = 'installer could not create the shortcut'
      throw error
    }
    syncBuiltinESMExports()
    failed = await callApp(web, 'installShortcut')
  } finally {
    childProcess.execFileSync = realExecFileSync
    syncBuiltinESMExports()
  }

  // The endpoint shells out to the DEPLOYED installer script. On a checkout
  // where `scripts/deploy.ps1` has not run yet that file is absent, the endpoint
  // stops at its own "install script missing" envelope and never reaches
  // execFileSync — so that is the branch observable there.
  if (!installerDeployed) {
    assertErrorEnvelope('installShortcut (installer not deployed)', created)
    if (!/install script missing/.test(created.error.message)) {
      throw new Error(`an undeployed installer must be reported as such: ${JSON.stringify(created)}`)
    }
    if (scripted.length !== 0) throw new Error('no installer may run while the script is missing')
    console.log('installShortcut OK: /app installShortcut reports the missing deployed installer (run scripts/deploy.ps1 to exercise the powershell path)')
  } else {
    if (created?.ok !== true || created.value?.created !== true || !String(created.value.output).startsWith('created ')) {
      throw new Error(`installShortcut envelope: ${JSON.stringify(created)}`)
    }
    if (scripted.length !== 1) throw new Error(`the installer must run exactly once, ran ${scripted.length} time(s)`)
    const invocation = scripted[0]
    if (invocation.file !== 'powershell') throw new Error(`installer file: ${invocation.file}`)
    if (!invocation.args.includes('-File')) throw new Error(`installer args: ${JSON.stringify(invocation.args)}`)
    const scriptArg = String(invocation.args[invocation.args.length - 1])
    if (!scriptArg.toLowerCase().endsWith('.dsh\\scripts\\install-desktop-shortcut.ps1')) {
      throw new Error(`installer script path: ${scriptArg}`)
    }
    if (!String(created.value.icon).toLowerCase().endsWith('.dsh\\assets\\deepseekharness-whalegirl.ico')) {
      throw new Error(`installShortcut icon path: ${created.value.icon}`)
    }
    assertErrorEnvelope('installShortcut failure', failed)
    if (failed.error.code !== 'internal' || !failed.error.message.includes('could not create')) {
      throw new Error(`a failed installer must surface as an internal error envelope: ${JSON.stringify(failed)}`)
    }
    console.log('installShortcut OK: /app installShortcut -> powershell -File install-desktop-shortcut.ps1 -> ok/failed envelopes')
  }
}

// 2h) versionCheck through the real route. Shape is asserted unconditionally —
//     an unreachable registry must still answer ok:true with the reason in
//     `error` — and the comparison runs against whatever `latest` really is,
//     so this test cannot pass by hardcoding a version.
{
  hostWarns = []
  routeEvents = []
  webServerStub = makeWebServerStub()
  const web = webServerStub
  host.apply(hostCtx, { script: MISSING_SCRIPT })

  const first = await callApp(web, 'versionCheck')
  if (first.ok !== true) throw new Error(`versionCheck must answer ok:true even without a registry answer: ${JSON.stringify(first)}`)
  const value = first.value
  // `current` comes from dshVersion(), which walks up from `process.argv[1]` —
  // the dsh bin.js in the service, but THIS harness file when run from the repo,
  // so null is the expected shape here (and `hasUpdate` must then stay false).
  if (value.current !== null && (typeof value.current !== 'string' || value.current.length === 0)) {
    throw new Error(`versionCheck.current: ${JSON.stringify(value)}`)
  }
  if (value.current === null && value.hasUpdate !== false) {
    throw new Error(`an unresolved current version can never be "an update available": ${JSON.stringify(value)}`)
  }
  if (value.latest !== null && typeof value.latest !== 'string') throw new Error(`versionCheck.latest: ${JSON.stringify(value)}`)
  if (typeof value.hasUpdate !== 'boolean') throw new Error(`versionCheck.hasUpdate: ${JSON.stringify(value)}`)
  if (typeof value.registry !== 'string' || !/^https?:\/\//.test(value.registry)) throw new Error(`versionCheck.registry: ${JSON.stringify(value)}`)
  if (value.error !== null && typeof value.error !== 'string') throw new Error(`versionCheck.error: ${JSON.stringify(value)}`)
  if (value.registry !== host.resolveRegistry()) {
    throw new Error(`the check must use the configured registry (${host.resolveRegistry()}), got ${value.registry}`)
  }

  if (value.latest === null) {
    console.log(`versionCheck OK: registry unreachable, shape holds (error: ${value.error})`)
  } else {
    if (value.error !== null) throw new Error(`a parsed latest must not carry an error: ${JSON.stringify(value)}`)
    if (value.hasUpdate !== host.isNewerVersion(value.current, value.latest)) {
      throw new Error(`hasUpdate must be isNewerVersion(current, latest): ${JSON.stringify(value)}`)
    }
    // The answer is cached, and `force` is the only way past it.
    const cached = await callApp(web, 'versionCheck')
    if (JSON.stringify(cached.value) !== JSON.stringify(value)) throw new Error(`the cached answer must be reused: ${JSON.stringify(cached.value)}`)
    const forced = await callApp(web, 'versionCheck', { force: true })
    if (!forced.ok || typeof forced.value.latest !== 'string') throw new Error(`a forced check must still answer: ${JSON.stringify(forced)}`)
    console.log(`versionCheck OK: current=${value.current} latest=${value.latest} hasUpdate=${value.hasUpdate} registry=${value.registry} (cached + forced reads)`)
  }
}

// 2i) the update endpoint: it shares the restart machinery (lock, session
//     protection, spawn, watchdog) and only adds the target version. Drives the
//     real route; the script is a TEMP stub that exits 0.
{
  const stubScript = join(harnessTmpDir, 'update-stub.ps1')
  writeFileSync(stubScript, [
    '# verify-harness stub for update-dsh.ps1: exits without updating anything',
    'param([string]$Version = "", [switch]$OpenBrowser)',
    'exit 0',
    '',
  ].join('\n'))

  hostWarns = []
  routeEvents = []
  webServerStub = makeWebServerStub()
  const web = webServerStub
  cancelled = []
  host.apply(hostCtx, { script: MISSING_SCRIPT, updateScript: stubScript })

  // A version is what the page read from the registry: it must be pinned onto
  // the script's command line, and junk must be refused before anything spawns.
  const junk = await callApp(web, 'update', { version: 'banana' })
  assertErrorEnvelope('update with a junk version', junk)
  if (junk.error.code !== 'bad-request' || junk.error.details.version !== 'banana') {
    throw new Error(`junk version envelope: ${JSON.stringify(junk)}`)
  }

  // Sessions running: same refusal as a restart (fakeAgents always has one).
  const refused = await callApp(web, 'update', { version: '0.1.5-rc.3' })
  assertErrorEnvelope('update while sessions run', refused)
  if (refused.error.code !== 'sessions-running') throw new Error(`update must refuse: ${JSON.stringify(refused)}`)
  if (cancelled.length !== 0) throw new Error('a refused update must not cancel sessions')

  const scheduled = await callApp(web, 'update', { version: '0.1.5-rc.3', force: true })
  if (!scheduled.ok || scheduled.value?.scheduled !== true || scheduled.value.version !== '0.1.5-rc.3') {
    throw new Error(`update envelope: ${JSON.stringify(scheduled)}`)
  }
  if (scheduled.value.script !== stubScript) throw new Error(`update must use the configured script: ${JSON.stringify(scheduled.value)}`)
  if (cancelled.length !== 1 || cancelled[0].id !== 'sess-a') throw new Error(`forced update must cancel running sessions: ${JSON.stringify(cancelled)}`)
  const again = await callApp(web, 'update', { version: '0.1.5-rc.3', force: true })
  if (!again.ok || again.value?.already !== true) {
    throw new Error(`the restart lock must also cover updates: ${JSON.stringify(again)}`)
  }

  // A missing update script is reported as such (deploy hint), like the restart one.
  hostWarns = []
  webServerStub = makeWebServerStub()
  const bare = webServerStub
  host.apply(hostCtx, { script: MISSING_SCRIPT, updateScript: MISSING_SCRIPT })
  const missing = await callApp(bare, 'update', { version: '0.1.5-rc.3', force: true })
  assertErrorEnvelope('update without a script', missing)
  if (missing.error.code !== 'internal' || !/update script not found/.test(missing.error.message)) {
    throw new Error(`missing update script envelope: ${JSON.stringify(missing)}`)
  }
  console.log('host OK: /app/update pins the version, refuses junk + running sessions, shares the restart lock, reports a missing script')
}

// 2g) without a `webServer` service the transport cannot exist: apply must warn
//     once and register nothing, NOT throw (the page then shows its own
//     fallback copy instead of the plugin taking the boot down).
{
  hostWarns = []
  routeEvents = []
  webServerStub = null // no webServer service at all

  let applyFailure = null
  let returned
  try { returned = host.apply(hostCtx, { script: MISSING_SCRIPT }) } catch (error) { applyFailure = error }
  if (applyFailure !== null) throw new Error(`a missing webServer must not throw (threw: ${applyFailure.message})`)
  if (returned !== undefined && typeof returned.then === 'function') throw new Error('P0 regression: apply returned a thenable (no webServer)')
  if (hostWarns.length !== 1 || !/webServer is unavailable/.test(hostWarns[0])) {
    throw new Error(`a missing webServer must warn exactly once: ${JSON.stringify(hostWarns)}`)
  }
  if (routeEvents.length !== 0) throw new Error(`no route may register without a webServer: ${JSON.stringify(routeEvents)}`)
  console.log('host fail-soft OK: a missing webServer warns once and registers nothing')
}

// Hand the shared hostCtx double back in its default shape (no webServer).
webServerStub = null

// 3) lifecycle: no restart watchdog outliving the plugin.
//
//    The mock mirrors the Cordis semantics this guarantee rests on: `ctx.inject`
//    registers a CHILD fiber on the parent (and settles on a later microtask), so
//    the transport route is registered after `apply` returns, and a fiber
//    releases its effects in REVERSE registration order.
{
  const FIBER_ACTIVE = 2
  const FIBER_UNLOADING = 5
  const FIBER_DISPOSED = 4
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const lifecycleLogger = { info: () => {}, warn: () => {} }

  const makeFiber = ({ services }) => {
    const disposables = []
    const children = []
    const fiber = { state: FIBER_ACTIVE }
    const self = {
      ctx: null,
      async dispose() {
        fiber.state = FIBER_UNLOADING
        for (const entry of disposables.splice(0).reverse()) await entry.dispose()
        fiber.state = FIBER_DISPOSED
      },
    }
    const ctx = {
      fiber,
      logger: lifecycleLogger,
      children,
      // Cordis exposes every available service as a context property as well.
      ...services,
      get: (name) => services[name],
      effect: (execute, label) => {
        const dispose = execute()
        if (typeof dispose === 'function') disposables.push({ label, dispose })
        return dispose
      },
      inject: (names, callback) => {
        // Cordis starts the child only once every injected service is present,
        // and only after a microtask checkpoint.
        if (names.some((name) => services[name] === undefined)) return undefined
        const child = makeFiber({ services })
        children.push(child)
        disposables.push({ label: 'ctx.inject()', dispose: () => child.dispose() })
        void Promise.resolve().then(() => callback(child.ctx))
        return child
      },
    }
    self.ctx = ctx
    return self
  }

  /**
   * The service set one lifecycle case runs against: the transport service is
   * `webServer`, and `connection` is deliberately a bare `{}` — nothing may read
   * from it any more.
   */
  const makeServices = () => ({
    webServer: makeWebServerStub(),
    connection: {},
    agents: { list: () => [], get: () => undefined },
  })

  // The restart watchdog is armed once and released by the unload. The
  // restart script is a TEMP stub that exits 0: it stands in for a script
  // whose process never brings the service back (the lock must still be
  // released by the watchdog, and the timer must not outlive the plugin).
  {
    const stubScript = join(harnessTmpDir, 'restart-stub.ps1')
    writeFileSync(stubScript, [
      '# verify-harness stub for restart-dsh.ps1: exits without restarting anything',
      'param([switch]$OpenBrowser)',
      'exit 0',
      '',
    ].join('\n'))
    const services = makeServices()
    const app = makeFiber({ services })
    host.apply(app.ctx, { script: stubScript })
    await flush()
    const web = services.webServer
    appRouteOf(web) // the transport of this case: one prefix route on webServer

    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const watchdogs = new Set()
    globalThis.setTimeout = (fn, delay, ...rest) => {
      const handle = realSetTimeout(fn, delay, ...rest)
      if (delay === 90_000) watchdogs.add(handle)
      return handle
    }
    globalThis.clearTimeout = (handle) => {
      watchdogs.delete(handle)
      return realClearTimeout(handle)
    }
    try {
      const first = await callApp(web, 'restart', {})
      if (!first.ok || first.value?.scheduled !== true) throw new Error(`restart must schedule: ${JSON.stringify(first)}`)
      if (watchdogs.size !== 1) throw new Error(`restart must arm exactly one watchdog, got ${watchdogs.size}`)
      const second = await callApp(web, 'restart', {})
      if (!second.ok || second.value?.already !== true) {
        throw new Error(`the lock must hold while the watchdog is pending: ${JSON.stringify(second)}`)
      }
      await app.dispose()
      if (watchdogs.size !== 0) throw new Error('unload must clear the pending restart watchdog')
      console.log('lifecycle OK: restart watchdog armed once and cleared by the unload')
    } finally {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      for (const handle of watchdogs) realClearTimeout(handle)
    }
  }
}

// --- client half: bundle + contract checks (DOM shim when jsdom is absent) ---
let dom = null
let handoff = null
const bundleSource = readFileSync(clientPath, 'utf8')

// Theme-token audit: an undefined `var(--dsw-alias-…)` silently drops the
// declaration, so every alias the bundle styles with must exist in the shipped
// theme. Skipped (with a notice) when the theme bundle cannot be read.
{
  const used = [...new Set(bundleSource.match(/--dsw-alias-[a-z0-9-]+/g) ?? [])].sort()
  const themeCandidates = [
    join(userProfile, 'AppData', 'Local', 'npm-cache', '_npx', '1e7f6d9597241db0', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'),
  ]
  try {
    themeCandidates.push(join(dirname(uiRequire.resolve('@deepseek-ai/dsh-client-ui-theme/package.json')), 'lib', 'client.js'))
  } catch { /* theme package not resolvable from the profile */ }
  const themePath = themeCandidates.find((candidate) => existsSync(candidate))
  if (themePath === undefined) {
    console.log(`client CSS OK: ${used.length} --dsw-alias-* tokens used (theme bundle not found, definition check skipped)`)
  } else {
    const defined = new Set(readFileSync(themePath, 'utf8').match(/--dsw-alias-[a-z0-9-]+(?=\s*:)/g) ?? [])
    const missing = used.filter((name) => !defined.has(name))
    if (missing.length > 0) throw new Error(`client CSS uses undefined theme tokens: ${missing.join(', ')}`)
    console.log(`client CSS OK: all ${used.length} --dsw-alias-* tokens are defined by the theme (${defined.size} aliases)`)
  }
}

if (DOM_AVAILABLE) {
  dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3080/',
  })
  globalThis.window = dom.window
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (!(key in globalThis)) globalThis[key] = dom.window[key]
  }
  dom.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
  const evaluate = new Function('window', 'document', bundleSource)
  evaluate(dom.window, dom.window.document)
} else {
  // Minimal DOM shim: the bundle's CSS IIFE guards on `document` and the
  // module table only needs `__ModuleLoader__.load` to register the factory.
  const shimDocument = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, setAttribute: () => {}, appendChild: () => {} }),
    head: { appendChild: () => {} },
  }
  const shimWindow = { __ModuleLoader__: { load: (h) => { handoff = h } } }
  const evaluate = new Function('window', 'document', bundleSource)
  evaluate(shimWindow, shimDocument)
}
if (handoff === null) throw new Error('bundle never called __ModuleLoader__.load')
if (handoff.id !== PLUGIN_ID) throw new Error(`handoff id mismatch: ${handoff.id}`)

// Minimal Modal stub matching the primitives contract used by the section:
// open -> overlay with title/description/footer; closed -> null. The real
// Modal portals to document.body; the stub renders in place — both forms
// expose role="dialog" and data-modal-title for the tests to query.
const ModalStub = (props) => {
  if (!props.open) return null
  return React.createElement('div', { role: 'dialog', 'data-modal-title': props.title, className: 'so-modal' },
    React.createElement('p', null, props.description),
    props.footer,
  )
}
const requireTable = (spec) => {
  if (spec === 'react') return uiRequire('react')
  if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { Modal: ModalStub }
  throw new Error(`unexpected module-table word: ${spec}`)
}
const exports_ = handoff.factory(requireTable)

// --- registration contract ----------------------------------------------------
if (typeof exports_.apply !== 'function') throw new Error('exports.apply missing')
if (!Array.isArray(exports_.inject)) throw new Error('exports.inject missing')
if (exports_.NS !== 'settings.other') throw new Error(`NS mismatch: ${exports_.NS}`)
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

let registrations = []
let dicts = []
let rpcLog = []
let restartResult = { ok: true, value: { scheduled: true, delayMs: 2600 } }
// `service.pid` is what the progress driver keys on: the restart replaces the
// process, so the double flips it to model the replacement coming up.
const makeStatus = ({ running = 0, sessions = [], pid = 4242 } = {}) => ({
  running,
  sessions,
  service: {
    pid,
    startedAt: '2026-01-01T00:00:00.000Z',
    uptime: 3661,
    rss: 536870912,
    node: 'v22.0.0',
    execPath: 'C:/node.exe',
    version: '0.1.0-rc.6',
    ports: [3080],
  },
})
let statusValue = makeStatus()
const clientCtx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dict) => { dicts.push({ ns, dict }) },
    bind: () => (key) => 't:' + key,
  },
  // The bundle still DECLARES `connection` in its inject list (the loader's
  // contract), but it must not read anything off it any more: this double is
  // empty, so a surviving `ctx.connection.rpc.call(...)` would throw here.
  connection: {},
  slots: {
    inject: (_key, callback) => { registrations.push(callback()) },
    register: (options, component) => ({ ...options, component }),
  },
}

// --- browser transport double -------------------------------------------------
// The deployed bundle talks to the host over `fetch('/app/<endpoint>', …)` now
// (the /app prefix route on webServer), NOT through `ctx.connection.rpc.call`.
// Every call is logged as { url, method, headers, body } — the exact contract
// the host route's fence enforces — and answered with a Response double.
// `rpcFailure` forces the HTTP-failure branch (non-2xx).
let rpcFailure = null
/** What the version check answers; a fresh check may flip it. */
let versionValue = { current: '0.1.5-rc.2', latest: '0.1.5-rc.3', hasUpdate: true, registry: 'https://registry.example', error: null }
let updateResult = { ok: true, value: { scheduled: true, script: 'C:/update-dsh.ps1', version: '0.1.5-rc.3' } }
const envelopeFor = (endpoint, args) => {
  if (endpoint === 'status') return { ok: true, value: statusValue }
  if (endpoint === 'update') return updateResult
  if (endpoint === 'versionCheck') return { ok: true, value: versionValue }
  if (endpoint === 'restart') return restartResult
  if (endpoint === 'installShortcut') return { ok: true, value: { created: true, icon: 'C:/icon.ico', output: 'created C:\\Users\\x\\Desktop\\dsh-web.lnk' } }
  return { ok: false, error: { code: 'bad-request', message: 'unexpected', details: {} } }
}
globalThis.fetch = async (url, init = {}) => {
  const href = String(url)
  rpcLog.push({ url: href, method: init.method, headers: init.headers ?? {}, body: init.body })
  if (rpcFailure !== null) return { ok: false, status: rpcFailure, json: async () => ({}) }
  if (!href.startsWith(`${APP_PATH}/`)) throw new TypeError(`client must call ${APP_PATH}/<endpoint>, got ${href}`)
  const endpoint = href.slice(APP_PATH.length + 1)
  // Parsing here enforces the body shape the host's fence requires; a malformed
  // body would reject the call exactly like a real 400 would.
  const parsed = init.body === undefined ? {} : JSON.parse(init.body)
  return { ok: true, status: 200, json: async () => envelopeFor(endpoint, parsed.args ?? {}) }
}

/**
 * One logged client call must be exactly what the host route accepts:
 * POST /app/<endpoint>, content-type application/json, and a body that parses
 * to `{ args: {...} }`.
 */
const assertClientCall = (call, endpoint, args, label = endpoint) => {
  const where = `${label}: expected POST ${APP_PATH}/${endpoint}`
  if (call === undefined) {
    throw new Error(`${where} — log: ${JSON.stringify(rpcLog.map((c) => `${c.method} ${c.url}`))}`)
  }
  if (call.url !== `${APP_PATH}/${endpoint}`) throw new Error(`${where}, got ${call.url}`)
  if (call.method !== 'POST') throw new Error(`${where}, method ${JSON.stringify(call.method)}`)
  if (String(call.headers?.['content-type'] ?? '').toLowerCase() !== 'application/json') {
    throw new Error(`${where}, headers ${JSON.stringify(call.headers)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(call.body)
  } catch {
    throw new Error(`${where}, body is not JSON: ${JSON.stringify(call.body)}`)
  }
  if (JSON.stringify(Object.keys(parsed)) !== '["args"]') {
    throw new Error(`${where}, body keys ${JSON.stringify(Object.keys(parsed))}`)
  }
  if (JSON.stringify(parsed.args) !== JSON.stringify(args)) {
    throw new Error(`${where} with args ${JSON.stringify(args)}, got ${JSON.stringify(parsed.args)}`)
  }
  return parsed
}
exports_.apply(clientCtx)

const sectionReg = registrations.find((r) => r.name === 'settings.section')
// The 插件配置 card is gone with the idle auto-stop: this plugin owns no
// settings any more, so nothing may be contributed to `settings.plugin.item`.
if (registrations.some((r) => r.name === 'settings.plugin.item')) {
  throw new Error('settings.plugin.item must not be contributed any more (the config card was removed)')
}
if (sectionReg === undefined) throw new Error('settings.section never registered')
if (sectionReg.id !== 'other' || sectionReg.order !== 30) {
  throw new Error(`section options mismatch: ${JSON.stringify(sectionReg)}`)
}
// The section's whole inject surface, asserted EXACTLY: the deleted
// `reloadPlugins` (重载用户插件) and `stopService` (中断服务) entries must stay
// gone, and no new key may slip in unnoticed.
const SECTION_INJECT_KEYS = ['installShortcut', 'restart', 'status', 'update', 'versionCheck']
const sectionInjected = sectionReg.inject()
const sectionInjectKeys = Object.keys(sectionInjected).sort()
if (JSON.stringify(sectionInjectKeys) !== JSON.stringify(SECTION_INJECT_KEYS)) {
  throw new Error(`section inject surface must be exactly ${JSON.stringify(SECTION_INJECT_KEYS)}, got ${JSON.stringify(sectionInjectKeys)}`)
}
for (const key of SECTION_INJECT_KEYS) {
  if (typeof sectionInjected[key] !== 'function') throw new Error(`section inject must expose ${key} as a function`)
}
const sectionDict = dicts.find((d) => d.ns === 'settings.other')
if (sectionDict === undefined) throw new Error('the section dictionary was not registered')
if (dicts.some((d) => d.ns === 'settings.other.card')) throw new Error('the card dictionary must not be registered any more')
const zhKeys = Object.keys(sectionDict.dict.zh)
const enKeys = Object.keys(sectionDict.dict.en)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  throw new Error(`zh/en key mismatch (section):\nzh: ${zhKeys}\nen: ${enKeys}`)
}
console.log(`apply contract OK: section id=other order=30, no config card | dict keys = ${zhKeys.length}`)

if (!DOM_AVAILABLE) {
  console.log('\nclient DOM sections SKIPPED (jsdom not installed)')
  console.log('ALL NON-DOM HARNESS CHECKS PASSED (install jsdom to enable the DOM sections)')
  process.exit(0)
}

// --- render + interact (react-dom in jsdom) ------------------------------------
const { act } = React
const { createRoot } = uiRequire('react-dom/client')

const fireClick = (el) => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const en = sectionDict.dict.en
const clientInjected = sectionReg.inject('session-1')
// Named-placeholder interpolation, like the shipped locale service does for
// every key (the version card uses {v}, the session copy uses {n}).
const tWithParams = (key, params) => {
  let value = en[key]
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replace('{' + name + '}', String(replacement))
  }
  return value
}
/** The section props every render in this harness uses. */
const sectionProps = (extra = {}) => ({
  restart: clientInjected.restart,
  status: clientInjected.status,
  installShortcut: clientInjected.installShortcut,
  versionCheck: clientInjected.versionCheck,
  update: clientInjected.update,
  t: tWithParams,
  ...extra,
})

const root = createRoot(dom.window.document.getElementById('root'))
await act(async () => {
  root.render(React.createElement(sectionReg.component, sectionProps()))
})

const doc = dom.window.document
const buttons = () => [...doc.querySelectorAll('.so-btn')]
const buttonTexts = () => buttons().map((b) => b.textContent)
// The current flow's status line is the LAST .so-flow-status of the SERVICE
// card (the shortcut success line stays mounted, and the version card below
// owns a flow line of its own).
const flowLine = () => {
  const card = doc.querySelector('.so-card')
  const lines = [...card.querySelectorAll('.so-flow-status')]
  return lines.length > 0 ? lines[lines.length - 1] : null
}

// Runtime snapshot block renders from the first /app/status poll. Scoped to
// the status block: the version card contributes info rows of its own.
// (7 rows: the 空闲自动停止 countdown row went with the feature)
const infoRows = () => [...doc.querySelectorAll('.so-status-block .so-info-row')]
if (infoRows().length !== 7) throw new Error(`expected 7 info rows, got ${infoRows().length}`)
const infoText = doc.querySelector('.so-info').textContent
if (!infoText.includes('4242')) throw new Error(`pid missing: ${infoText}`)
if (!infoText.includes('3080')) throw new Error(`ports missing: ${infoText}`)
if (!infoText.includes('v22.0.0')) throw new Error(`node missing: ${infoText}`)
if (!infoText.includes('0.1.0-rc.6')) throw new Error(`dsh version missing: ${infoText}`)
const refreshButton = buttons().find((b) => b.textContent === en.refresh)
if (refreshButton === undefined) throw new Error('refresh button missing')
const shortcutButton = buttons().find((b) => b.textContent === en.createShortcut)
if (shortcutButton === undefined) throw new Error('create-shortcut button missing')
const restartButton = buttons().find((b) => b.textContent === en.restart)
if (restartButton === undefined) throw new Error('restart button missing')
// Exactly these controls, and nothing else: the deleted ones (重载用户插件 /
// 中断服务) must stay gone while 检查更新 arrived with the version card.
// 更新并重启 only exists while the check reports an update, which the fixture
// does (versionValue.hasUpdate).
const EXPECTED_BUTTONS = [en.createShortcut, en.refresh, en.restart, en.update, en.versionCheck].sort()
const actualButtons = buttonTexts().slice().sort()
if (JSON.stringify(actualButtons) !== JSON.stringify(EXPECTED_BUTTONS)) {
  throw new Error(`expected buttons ${JSON.stringify(EXPECTED_BUTTONS)}, got ${JSON.stringify(actualButtons)}`)
}
if (doc.querySelector('.so-danger-note') === null) throw new Error('danger note missing')
// The mount poll went out over the /app prefix route as one fenced JSON POST —
// no `ctx.connection.rpc`, no /api channel. (Searched, not "last": the version
// card's own mount read lands after it.)
assertClientCall(rpcLog.find((c) => c.url === `${APP_PATH}/status`), 'status', {}, 'mount poll')
console.log(`status block OK: 7 rows render pid/ports/versions; buttons = ${JSON.stringify(buttonTexts())}`)

// version card: the mount read reports the update, the manual check forces a
// fresh read and follows the flipped answer. It asserts against the MOUNT log
// (status + versionCheck) and clears it afterwards.
{
  const versionRows = [...doc.querySelectorAll('.so-info-row')].filter((row) => /0\.1\.5/.test(row.textContent))
  const texts = versionRows.map((row) => row.textContent)
  if (texts.length !== 2 || !texts.some((text) => text.includes('0.1.5-rc.2')) || !texts.some((text) => text.includes('0.1.5-rc.3'))) {
    throw new Error(`version rows: ${JSON.stringify(texts)}`)
  }
  const available = [...doc.querySelectorAll('.so-flow-status')].find((el) => el.textContent === en.versionAvailable.replace('{v}', '0.1.5-rc.3'))
  if (available === undefined) throw new Error('the update-available copy is missing')
  if (versionRows.length !== 2) throw new Error(`the version card must show exactly two rows, got ${versionRows.length}`)
  assertClientCall(rpcLog.find((c) => c.url === `${APP_PATH}/versionCheck`), 'versionCheck', {}, 'version mount read')

  rpcLog = []
  versionValue = { current: '0.1.5-rc.3', latest: '0.1.5-rc.3', hasUpdate: false, registry: 'https://registry.example', error: null }
  await act(async () => { fireClick(buttons().find((b) => b.textContent === en.versionCheck)) })
  assertClientCall(rpcLog.find((c) => c.url === `${APP_PATH}/versionCheck`), 'versionCheck', { force: true }, 'manual version check')
  await act(async () => {})
  const upToDate = [...doc.querySelectorAll('.so-flow-status')].find((el) => el.textContent === en.versionUpToDate)
  if (upToDate === undefined) throw new Error('the manual check must follow the new answer')
  // 更新并重启 tracks the answer: gone while up to date, back once the check
  // reports an update again (the fixtures are restored for the flows below).
  if ([...doc.querySelectorAll('.so-btn')].some((b) => b.textContent === en.update)) {
    throw new Error('更新并重启 must not be offered while up to date')
  }
  versionValue = { current: '0.1.5-rc.2', latest: '0.1.5-rc.3', hasUpdate: true, registry: 'https://registry.example', error: null }
  await act(async () => { fireClick([...doc.querySelectorAll('.so-btn')].find((b) => b.textContent === en.versionCheck)) })
  await act(async () => {})
  if (![...doc.querySelectorAll('.so-btn')].some((b) => b.textContent === en.update)) {
    throw new Error('更新并重启 must come back with the update')
  }
  console.log('version card OK: mount read + forced re-check over POST /app/versionCheck (更新并重启 follows the answer)')
}

// refresh button re-polls /app/status
rpcLog = [] // the mount (status + versionCheck) was asserted above
await act(async () => { fireClick(refreshButton) })
assertClientCall(rpcLog.find((c) => c.url === `${APP_PATH}/status`), 'status', {}, 'refresh')
rpcLog = []
console.log('status block OK: refresh re-polls /app/status')

// create-shortcut flow: calls /app/installShortcut and shows the result line
await act(async () => { fireClick(shortcutButton) })
assertClientCall(rpcLog.find((c) => c.url === `${APP_PATH}/installShortcut`), 'installShortcut', {}, 'create shortcut')
await act(async () => {})
const shortcutDone = [...doc.querySelectorAll('.so-flow-status')].find((el) => el.textContent.includes(en.shortcutCreated))
if (shortcutDone === null) throw new Error('shortcut created status missing')
console.log('shortcut flow OK: POST /app/installShortcut + created status')
rpcLog = []

// click -> confirm modal opens (no call yet)
const dialog = () => doc.querySelector('[role="dialog"]')
await act(async () => { fireClick(restartButton) })
if (rpcLog.length !== 0) throw new Error('confirm state must not call the host yet')
const confirmDialog = dialog()
if (confirmDialog === null) throw new Error('restart confirm modal missing')
if (confirmDialog.getAttribute('data-modal-title') !== en.restart) throw new Error('restart modal title mismatch')
if (!confirmDialog.textContent.includes(en.confirmPromptRestart)) throw new Error('confirm prompt missing in modal')
const confirmButton = buttons().find((b) => b.textContent === en.confirm)
if (confirmButton === undefined) throw new Error('confirm button missing')
console.log('confirm modal OK (restart)')

// cancel (in modal) returns to idle
await act(async () => { fireClick(buttons().find((b) => b.textContent === en.cancel)) })
if (dialog() !== null) throw new Error('cancel must close the modal')
if (JSON.stringify(buttonTexts().slice().sort()) !== JSON.stringify(EXPECTED_BUTTONS)) {
  throw new Error(`cancel should restore the idle buttons, got ${JSON.stringify(buttonTexts())}`)
}
console.log('cancel OK')

// confirm -> calling -> progress; host endpoint + request shape, then the three
// stages driven by what the page can still observe on its own origin.
const progressHost = dom.window.document.createElement('div')
const progressRoot = createRoot(progressHost)
const pButton = (text) => [...progressHost.querySelectorAll('.so-btn')].find((b) => b.textContent === text)
const pStepStates = () => [...progressHost.querySelectorAll('.so-progress-step')].map((el) => el.getAttribute('data-stage-state'))
const pFill = () => progressHost.querySelector('.so-progress-fill')
const pLine = (tone) => progressHost.querySelector(`.so-flow-status[data-tone="${tone}"]`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

statusValue = makeStatus({ pid: 4242 })
restartResult = { ok: true, value: { scheduled: true } }
rpcLog = []
await act(async () => { progressRoot.render(React.createElement(sectionReg.component, sectionProps())) })
await act(async () => { fireClick(pButton(en.restart)) })
await act(async () => { fireClick(pButton(en.confirm)) })
assertClientCall(rpcLog.find((c) => c.url === `${APP_PATH}/restart`), 'restart', {}, 'restart confirm')
// stage 1: the request is in, and the baseline poll still sees the OLD pid
if (pFill() === null) throw new Error('progress bar missing after the restart was accepted')
if (pFill().getAttribute('data-stage') !== '1' || pFill().getAttribute('data-state') !== 'active') {
  throw new Error(`stage 1 fill: ${pFill().getAttribute('data-stage')} / ${pFill().getAttribute('data-state')}`)
}
if (JSON.stringify(pStepStates()) !== JSON.stringify(['done', 'active', 'pending'])) {
  throw new Error(`stage 1 markers: ${JSON.stringify(pStepStates())}`)
}
// the old process is still answering: the bar must not move
await act(async () => { await sleep(1100) })
if (pFill().getAttribute('data-stage') !== '1') throw new Error(`the old pid must hold stage 1, got ${pFill().getAttribute('data-stage')}`)
// the process goes away (the poll cannot connect), then answers with a NEW pid
rpcFailure = 503
await act(async () => { await sleep(1100) })
if (pFill().getAttribute('data-stage') !== '2' || pFill().getAttribute('data-state') !== 'active') {
  throw new Error(`a failed poll must move to stage 2: ${pFill().getAttribute('data-stage')} / ${pFill().getAttribute('data-state')}`)
}
if (JSON.stringify(pStepStates()) !== JSON.stringify(['done', 'done', 'active'])) {
  throw new Error(`stage 2 markers: ${JSON.stringify(pStepStates())}`)
}
rpcFailure = null
statusValue = makeStatus({ pid: 5151 })
await act(async () => { await sleep(1100) })
if (pFill().getAttribute('data-stage') !== '3' || pFill().getAttribute('data-state') !== 'ready') {
  throw new Error(`the replacement pid must complete the bar: ${pFill().getAttribute('data-stage')} / ${pFill().getAttribute('data-state')}`)
}
if (JSON.stringify(pStepStates()) !== JSON.stringify(['done', 'done', 'done'])) {
  throw new Error(`ready markers: ${JSON.stringify(pStepStates())}`)
}
if (pLine('ok') === null || pLine('ok').textContent !== en.readyCopy) throw new Error('ready copy missing')
// The completion also re-reads the runtime snapshot: without that nudge the
// block keeps showing the pre-restart pid until its own (throttled) 10 s poll,
// which is exactly the stale line the progress bar had just contradicted.
const pInfo = progressHost.querySelector('.so-info')
if (pInfo === null || !pInfo.textContent.includes('5151')) {
  throw new Error(`the runtime snapshot must follow the restart: ${pInfo === null ? 'no info block' : pInfo.textContent}`)
}
console.log('restart flow OK: POST /app/restart (args {}) + progress stages 1 -> 2 -> 3 driven by the pid')

// unknown tail: nothing observable within the budget (the script can fall back
// to another port, where this origin never answers again).
const lostHost = dom.window.document.createElement('div')
const lostRoot = createRoot(lostHost)
statusValue = makeStatus({ pid: 4242 })
restartResult = { ok: true, value: { scheduled: true } }
rpcLog = []
await act(async () => { lostRoot.render(React.createElement(sectionReg.component, sectionProps({ progressBudgetMs: 40 }))) })
const lButton = (text) => [...lostHost.querySelectorAll('.so-btn')].find((b) => b.textContent === text)
await act(async () => { fireClick(lButton(en.restart)) })
await act(async () => { fireClick(lButton(en.confirm)) })
await act(async () => { await sleep(1200) })
const lostFill = lostHost.querySelector('.so-progress-fill')
if (lostFill === null || lostFill.getAttribute('data-state') !== 'unknown' || lostFill.getAttribute('data-stage') !== '2') {
  throw new Error(`the budget must degrade the last stage: ${lostFill?.getAttribute('data-stage')} / ${lostFill?.getAttribute('data-state')}`)
}
const lostLine = lostHost.querySelector('.so-flow-status[data-tone="error"]')
if (lostLine === null || lostLine.textContent !== en.readyUnknown.replace('{n}', '0')) {
  throw new Error(`unknown copy missing: ${lostLine?.textContent}`)
}
// 重试检测 re-probes without sending a second restart
rpcLog = []
statusValue = makeStatus({ pid: 5151 })
await act(async () => { fireClick(lButton(en.checkAgain)) })
await act(async () => { await sleep(1100) })
if (lostHost.querySelector('.so-progress-fill').getAttribute('data-state') !== 'ready') {
  throw new Error('check-again must re-probe the same origin')
}
if (rpcLog.some((c) => c.url === `${APP_PATH}/restart`)) throw new Error('check-again must not re-request the restart')
console.log('progress OK: no observable replacement within the budget degrades to unknown + check-again re-probes')

// busy flow: sessions running -> busy view -> 强制重启 must confirm too
const busyHost = dom.window.document.createElement('div')
const busyRoot = createRoot(busyHost)
restartResult = { ok: false, error: { code: 'sessions-running', message: 'x', details: { running: 2, sessions: ['a', 'b'] } } }
statusValue = makeStatus({ running: 2, sessions: ['a', 'b'] })
rpcLog = []
await act(async () => {
  busyRoot.render(React.createElement(sectionReg.component, sectionProps()))
})
await act(async () => { fireClick([...busyHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.restart)) })
await act(async () => { fireClick([...busyHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.confirm)) })
const busyLine = busyHost.querySelector('.so-flow-status[data-tone="error"]')
if (busyLine === null || busyLine.textContent !== en.busy.replace('{n}', '2')) {
  throw new Error(`busy line: ${busyLine?.textContent}`)
}
const bButton = (text) => [...busyHost.querySelectorAll('.so-btn')].find((b) => b.textContent === text)
const forceButton = bButton(en.busyActionForce)
if (forceButton === undefined) throw new Error('force button missing')
const waitButton = bButton(en.busyActionWait)
if (waitButton === undefined) throw new Error('wait button missing')
// 强制重启 is one of the two paths that used to disconnect the service with no
// prompt at all: it must open the confirm dialog first, carrying the force copy.
rpcLog = []
await act(async () => { fireClick(forceButton) })
if (rpcLog.length !== 0) throw new Error('force restart must not call the host before the confirmation')
// The Modal stub renders in place, so a detached host is queried directly
// (only the first flow renders into the attached #root and can use dialog()).
const forceDialog = busyHost.querySelector('[role="dialog"]')
if (forceDialog === null) throw new Error('force restart must confirm first')
if (forceDialog.getAttribute('data-modal-title') !== en.busyActionForce) throw new Error('force modal title mismatch')
if (!forceDialog.textContent.includes(en.confirmPromptForce.replace('{n}', '2'))) {
  throw new Error(`force confirm copy: ${forceDialog.textContent}`)
}
// cancel leaves the service alone and returns to the busy view, which keeps the
// 等待空闲/强制重启 choice (the sessions are still running)
await act(async () => { fireClick(bButton(en.cancel)) })
if (rpcLog.length !== 0) throw new Error('cancelling the force confirm must not call the host')
if (busyHost.querySelector('[role="dialog"]') !== null) throw new Error('cancel must close the force dialog')
if (bButton(en.busyActionForce) === undefined) throw new Error('cancel must fall back to the busy view')
// confirmed: the request now goes out with force: true
await act(async () => { fireClick(bButton(en.busyActionForce)) })
await act(async () => { fireClick(bButton(en.confirm)) })
assertClientCall(rpcLog.find((c) => c.url === `${APP_PATH}/restart`), 'restart', { force: true }, 'force restart')
console.log('busy flow OK: refused -> busy view -> force restart confirms first, then sends force:true')

// wait flow: poll /app/status until idle, then confirm the auto-restart
const waitHost = dom.window.document.createElement('div')
const waitRoot = createRoot(waitHost)
restartResult = { ok: false, error: { code: 'sessions-running', message: 'x', details: { running: 1, sessions: ['a'] } } }
statusValue = makeStatus({ running: 1, sessions: ['a'] })
rpcLog = []
await act(async () => {
  waitRoot.render(React.createElement(sectionReg.component, sectionProps()))
})
const wButton = (text) => [...waitHost.querySelectorAll('.so-btn')].find((b) => b.textContent === text)
const wDialog = () => waitHost.querySelector('[role="dialog"]')
await act(async () => { fireClick(wButton(en.restart)) })
await act(async () => { fireClick(wButton(en.confirm)) })
await act(async () => { fireClick(wButton(en.busyActionWait)) })
// The confirmed restart that came back `sessions-running` is behind us: from
// here on the log only holds this flow's polls (and any restart it fires).
rpcLog = []
// first status poll fires after the 2s interval. The sleep runs INSIDE act so
// the interval-driven state update is flushed in the same scope (otherwise
// React logs "not wrapped in act" for a poll this flow depends on).
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)) })
const waitingLine = waitHost.querySelector('.so-flow-status')
if (waitingLine === null || waitingLine.textContent !== en.waiting.replace('{n}', '1')) {
  throw new Error(`waiting line: ${waitingLine?.textContent}`)
}
if (!rpcLog.some((c) => c.url === `${APP_PATH}/status`)) throw new Error('wait flow must poll /app/status')
if (rpcLog.some((c) => c.url === `${APP_PATH}/restart`)) throw new Error('the wait flow must not restart while sessions run')
// sessions finish -> the next poll asks for the second confirmation instead of
// restarting on its own (the other path that used to fire with no prompt)
statusValue = makeStatus()
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)) })
if (rpcLog.some((c) => c.url === `${APP_PATH}/restart`)) {
  throw new Error('the wait flow must ask before it disconnects the service')
}
const autoDialog = wDialog()
if (autoDialog === null) throw new Error('the wait flow must open the confirm dialog once the sessions ended')
if (!autoDialog.textContent.includes(en.confirmPromptAuto)) {
  throw new Error(`auto confirm copy: ${autoDialog.textContent}`)
}
rpcLog = []
await act(async () => { fireClick(wButton(en.confirm)) })
assertClientCall(rpcLog.find((c) => c.url === `${APP_PATH}/restart`), 'restart', {}, 'wait-flow auto restart')
console.log('wait flow OK: polls status, then confirms before the auto restart')

// error state: host failure surfaces as error copy
const errorHost = dom.window.document.createElement('div')
const root2 = createRoot(errorHost)
await act(async () => {
  root2.render(React.createElement(sectionReg.component, sectionProps({ restart: async () => { throw new Error('private detail') } })))
})
await act(async () => { fireClick([...errorHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.restart)) })
await act(async () => { fireClick([...errorHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.confirm)) })
if (errorHost.querySelector('.so-flow-status[data-tone="error"]') === null) throw new Error('error status missing')
if (errorHost.textContent.includes('private detail')) throw new Error('error state leaked transport detail')
console.log('error state OK')

// transport failure: the host answering a non-2xx status must land on the same
// generic error copy (the `!response.ok` branch), never on a raw transport dump.
{
  const httpHost = dom.window.document.createElement('div')
  const httpRoot = createRoot(httpHost)
  rpcFailure = 500
  try {
    await act(async () => {
      httpRoot.render(React.createElement(sectionReg.component, sectionProps()))
    })
    await act(async () => { fireClick([...httpHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.restart)) })
    await act(async () => { fireClick([...httpHost.querySelectorAll('.so-btn')].find((b) => b.textContent === en.confirm)) })
    const failedLine = httpHost.querySelector('.so-flow-status[data-tone="error"]')
    if (failedLine === null || failedLine.textContent !== en.error) {
      throw new Error(`an HTTP failure must show the error copy, got: ${failedLine?.textContent}`)
    }
    // Scoped to the service card: that is the copy under test here (the
    // version card below reports its own, separately-worded, failure).
    if (/500|HTTP/.test(httpHost.querySelector('.so-card').textContent)) {
      throw new Error('the error state must not leak the HTTP status')
    }
  } finally {
    rpcFailure = null
  }
  console.log('error state OK: a non-2xx answer from the route shows the error copy')
}

// update flow: 更新并重启 sits on the version card, must confirm first (it
// installs a build and replaces the process), and then drives the SAME progress
// bar — with the update's own title and first-stage label. Last block in the
// DOM section: its progress polling runs for the update budget, so it is
// unmounted on the way out instead of leaving an interval behind.
{
  const updateHost = dom.window.document.createElement('div')
  const updateRoot = createRoot(updateHost)
  versionValue = { current: '0.1.5-rc.2', latest: '0.1.5-rc.3', hasUpdate: true, registry: 'https://registry.example', error: null }
  updateResult = { ok: true, value: { scheduled: true, script: 'C:/update-dsh.ps1', version: '0.1.5-rc.3' } }
  statusValue = makeStatus({ pid: 4242 })
  rpcLog = []
  await act(async () => { updateRoot.render(React.createElement(sectionReg.component, sectionProps())) })
  const uButton = (text) => [...updateHost.querySelectorAll('.so-btn')].find((b) => b.textContent === text)

  await act(async () => { fireClick(uButton(en.update)) })
  if (rpcLog.some((c) => c.url === `${APP_PATH}/update`)) {
    throw new Error('the update must confirm before it calls the host')
  }
  const uDialog = updateHost.querySelector('[role="dialog"]')
  if (uDialog === null) throw new Error('更新并重启 must open the confirm dialog')
  if (uDialog.getAttribute('data-modal-title') !== en.update) throw new Error(`update modal title: ${uDialog.getAttribute('data-modal-title')}`)
  if (!uDialog.textContent.includes(en.confirmPromptUpdate.replace('{v}', '0.1.5-rc.3'))) {
    throw new Error(`update confirm copy: ${uDialog.textContent}`)
  }
  // cancel is the safe default: nothing installed, nothing disconnected
  await act(async () => { fireClick(uButton(en.cancel)) })
  if (uDialog !== null && updateHost.querySelector('[role="dialog"]') !== null) throw new Error('cancel must close the update dialog')
  if (rpcLog.some((c) => c.url === `${APP_PATH}/update`)) throw new Error('cancelling the update must not call the host')

  await act(async () => { fireClick(uButton(en.update)) })
  await act(async () => { fireClick(uButton(en.confirm)) })
  assertClientCall(rpcLog.find((c) => c.url === `${APP_PATH}/update`), 'update', { version: '0.1.5-rc.3' }, 'update confirm')
  const uFill = updateHost.querySelector('.so-progress-fill')
  if (uFill === null || uFill.getAttribute('data-stage') !== '1' || uFill.getAttribute('data-state') !== 'active') {
    throw new Error(`the update must start the progress bar: ${uFill?.getAttribute('data-stage')} / ${uFill?.getAttribute('data-state')}`)
  }
  const uTitle = updateHost.querySelector('.so-progress .so-status-title')
  if (uTitle === null || uTitle.textContent !== en.progressTitleUpdate) throw new Error(`update progress title: ${uTitle?.textContent}`)
  const uSteps = [...updateHost.querySelectorAll('.so-progress-step')].map((el) => el.textContent)
  if (uSteps.length !== 3 || !uSteps[0].includes(en.stageRequestUpdate)) {
    throw new Error(`the update bar must label its first stage as an update: ${JSON.stringify(uSteps)}`)
  }
  console.log('update flow OK: 更新并重启 -> confirm -> POST /app/update {version} -> update progress bar')
  await act(async () => { updateRoot.unmount() })
}

console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
