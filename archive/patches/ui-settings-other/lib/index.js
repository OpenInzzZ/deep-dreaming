/**
 * Host half of the ui-settings-other patch: a restart-service RPC endpoint,
 * a runtime-status snapshot, a desktop-shortcut installer, and the Web
 * title-bar icon (favicon) override.
 *
 * The page reaches this half over a self-registered fenced prefix route
 * `/app` on the `webServer` service (the shared `/api` channel is exclusively
 * owned by the Typert gateway, and `ctx.connection.rpc.handle` is broken in
 * this dsh version — see `createRpcRoute`).
 *
 * Endpoints:
 * - `status`  → `{ running, sessions, service }` where `service` is a live
 *   process snapshot (pid, startedAt, uptime, rss, node, execPath, dsh
 *   version, listening ports via netstat). The browser half uses `service.pid`
 *   to tell the old process from its replacement while the restart progress
 *   runs.
 * - `restart` → delegates the whole job to the standalone script
 *   `restart-dsh.ps1` (deployed to `~/.dsh/scripts/` by scripts/deploy.ps1):
 *   the script finds the process listening on the web port, recovers its exact
 *   command line, lets the RPC response settle, stops the old process, starts
 *   a replacement with the same command line (logs redirected), and polls
 *   until the service answers. Keeping the lifecycle in a script makes the
 *   restart independently testable (`-DryRun`) and keeps this host entry a
 *   thin, dependency-free trigger.
 * - `versionCheck` → `{ current, latest, hasUpdate, registry, error }`: the
 *   running version against the `latest` dist-tag of the npm registry the
 *   machine is configured for (`~/.npmrc`, else the public one). Read-only,
 *   fail-soft (an unreachable registry reports its reason in `error`), cached
 *   for a few minutes, `force: true` to bypass that cache.
 * - `update` → installs a newer dsh and switches the service to it, by spawning
 *   `update-dsh.ps1` (path from the patch config `updateScript`, default
 *   `~/.dsh/scripts/update-dsh.ps1`) with the caller's `version` (omitted lets
 *   the script ask npm for `latest`). It ends in the same restart, so it shares
 *   the restart lock, the session protection and the watchdog; the browser half
 *   drives the same progress bar. Read-only until the confirm: the endpoint only
 *   refuses (wrong shape, `already-current`) or schedules.
 * - `installShortcut` → creates the desktop shortcut that starts dsh web (via
 *   `install-desktop-shortcut.ps1`; the shortcut opens a console window and
 *   waits for a key press — `start-dsh.ps1 -Pause`), first ensuring the
 *   whale-girl icon asset exists under `~/.dsh/assets/`.
 *
 * There is deliberately no `stop` endpoint: stopping the service is a
 * CLI/desktop action (`stop-dsh.ps1`), and the only destructive control the UI
 * offers is the single restart button. `reloadPlugins` is gone too — a
 * comment-only rewrite of cordis.patch.yml parses to the same patch list, and
 * `Entry.update` returns early on equal options, so it never remounted
 * anything; editing the layer's rows/config is what actually hot-applies.
 *
 * Session safety: a restart kills the service process, which interrupts every
 * RUNNING agent session. To keep restarts from silently breaking in-flight
 * work the endpoint refuses to restart while sessions are running unless the
 * caller passes `force: true`, in which case each running agent is cancelled
 * first (`keepInbox` preserves pending queued work) so sessions are left in a
 * resumable state.
 *
 * This half owns no settings namespace: the idle auto-stop feature (the
 * namespace's only consumer) was removed, so there is nothing left to
 * configure here. The restart script path stays a patch-config key (`script`),
 * defaulting to `~/.dsh/scripts/restart-dsh.ps1`.
 *
 * Branding: when the `webServer` service is present, this plugin registers an
 * exact `/favicon.svg` route that serves the whale-girl icon (SVG wrapper
 * around the bundled PNG), overriding the shipped favicon; the same ico asset
 * is used for the desktop shortcut.
 */

import { spawn, execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, isAbsolute, dirname, resolve } from 'node:path'
import { statSync, readFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/**
 * Identity label of this plugin in the diagnostics route. It used to be the
 * settings namespace; the namespace is gone (its only consumer was the idle
 * auto-stop) and the health route keeps the same field so its contract does
 * not move.
 */
export const PLUGIN_NAMESPACE = 'ui-settings-other'

/**
 * Entry-config schema. Exported as `Config` so the Loader validates the entry
 * config at load time. Unknown keys are tolerated (kept, not rejected), so
 * dropping a key here never breaks an existing entry config.
 */
export const Config = z.object({
  script: z.string().default(''),
  updateScript: z.string().default(''),
})

/** Resolve the restart-script path: config > default under the dsh home. */
export function resolveRestartScript(config = {}) {
  const configured = config.script
  if (typeof configured === 'string' && configured.length > 0) {
    return isAbsolute(configured) ? configured : join(homedir(), '.dsh', configured)
  }
  return join(homedir(), '.dsh', 'scripts', 'restart-dsh.ps1')
}

/** Resolve the update-script path: config > default under the dsh home. */
export function resolveUpdateScript(config = {}) {
  const configured = config.updateScript
  if (typeof configured === 'string' && configured.length > 0) {
    return isAbsolute(configured) ? configured : join(homedir(), '.dsh', configured)
  }
  return join(homedir(), '.dsh', 'scripts', 'update-dsh.ps1')
}

/** Absolute path of one bundled brand asset inside this patch. */
export function patchAssetPath(name) {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', name)
}

/** The whale-girl desktop icon file under the dsh home (`~/.dsh/assets`). */
export function assetIconPath() {
  return join(homedir(), '.dsh', 'assets', 'DeepSeekHarness-WhaleGirl.ico')
}

/**
 * Ensure the desktop icon asset exists under the dsh home, copying it from
 * this patch's bundled assets when missing. The shortcut stores an absolute
 * icon path, so a later repo move must not break an installed shortcut.
 */
export function ensureIconAsset() {
  const target = assetIconPath()
  if (existsSync(target)) return target
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(patchAssetPath('DeepSeekHarness-WhaleGirl.ico'), target)
  return target
}

/** How long a version-check answer is reused, and how long the registry may take. */
const VERSION_CHECK_TTL_MS = 10 * 60_000
const VERSION_CHECK_TIMEOUT_MS = 5000

/** Lock window for an update: fetching, patching and booting a new build. */
const UPDATE_WATCHDOG_MS = 10 * 60_000

/** Absolute path of the deployed desktop-shortcut installer script. */
export function shortcutScriptPath() {
  return join(homedir(), '.dsh', 'scripts', 'install-desktop-shortcut.ps1')
}

/**
 * Whether installer output reports an existing shortcut left untouched. The
 * script is idempotent and says so (`shortcut already exists with -Pause: …`)
 * instead of rewriting the `.lnk`; every other outcome ends with the file
 * saved, so this is what separates "created" from "already there".
 */
export function shortcutAlreadyExisted(output) {
  return /already exists/i.test(String(output ?? ''))
}

/**
 * Create (or refresh) the desktop shortcut that starts dsh web in a console
 * window (`start-dsh.ps1 -OpenBrowser -Pause`). Runs the deployed
 * `install-desktop-shortcut.ps1` synchronously and reports what really
 * happened: `created` is derived from the script's own report, never assumed.
 * @returns {{ ok: boolean, created: boolean, output: string, icon: string, script: string }}
 */
export function installShortcut() {
  const icon = ensureIconAsset()
  const script = shortcutScriptPath()
  if (!existsSync(script)) {
    return { ok: false, created: false, output: `install script missing: ${script} (run scripts/deploy.ps1 first)`, icon, script }
  }
  try {
    const output = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim()
    return { ok: true, created: !shortcutAlreadyExisted(output), output, icon, script }
  } catch (error) {
    const detail = error?.stdout?.toString()?.trim() || error?.message || String(error)
    return { ok: false, created: false, output: detail, icon, script }
  }
}

/** One favicon SVG document: the bundled PNG embedded as a data URI. */
export function faviconSvg(pngPath) {
  const png = readFileSync(pngPath)
  const data = `data:image/png;base64,${png.toString('base64')}`
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 128 128">` +
    `<image width="128" height="128" href="${data}"/>` +
    `</svg>\n`
}

/** Single-quote one value for the PowerShell command line (`'` → `''`). */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Quote one value for the INNER powershell command line. Double quotes: a path
 * single-quoted inside the Start-Process argument string does not survive
 * (measured: the child exits with -196608 and runs nothing), the same path in
 * double quotes runs. A Windows file name cannot contain `"`, so no escaping is
 * needed here.
 */
function cmdArg(value) {
  const text = String(value)
  return /[\s"]/.test(text) ? `"${text}"` : text
}

/**
 * Build the spawn invocation for the restart script (pure, testable).
 *
 * The script is started through `Start-Process`, NOT by handing it to the
 * powershell we spawn directly. Windows PowerShell 5.1 must not be spawned
 * `detached`: with `detached: true` (plus `stdio: 'ignore'` and
 * `windowsHide: true`) it exits 0 immediately and runs none of the script — no
 * kill, no log, no warning, so the page sat on stage 1 for its whole budget
 * while the service kept running. Verified by spawn matrix; the CLI path never
 * showed it because a shell gives the child a console.
 *
 * `Start-Process` creates the same genuinely independent process the desktop
 * shortcut gets (this is also how start-dsh.ps1 launches node), and the wrapper
 * still forwards the script's exit code, so the endpoint keeps its
 * spawn-failure / non-zero-exit paths for releasing the restart lock.
 */
export function buildRestartSpawn(scriptPath, extraArgs = []) {
  const inner = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cmdArg(scriptPath), ...extraArgs.map(cmdArg)].join(' ')
  // The child is started by ABSOLUTE path (`$PSHOME\powershell.exe`): a bare
  // `-FilePath 'powershell'` is resolved to something else entirely and the
  // inner command silently never runs (measured: exit 0, no effect, no error).
  return {
    file: 'powershell',
    args: [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `$exe = Join-Path $PSHOME 'powershell.exe'; ` +
      `$p = Start-Process -FilePath $exe -ArgumentList ${psQuote(inner)} -WindowStyle Hidden -PassThru; ` +
      `$p.WaitForExit(); exit $p.ExitCode`,
    ],
  }
}

/**
 * Local RPC over a `webServer` route, replacing `ctx.connection.rpc`.
 *
 * dsh 0.1.5-rc.1 broke the Connection RPC registry for every plugin outside
 * the connection package: `handle()` calls `register()`, which touches
 * `owner.webServer` on a context that never declared `webServer`, so it throws
 * `cannot get property "webServer" without inject`. The channel then never
 * exists and the browser's `POST /<channel>/<endpoint>` requests fall through
 * to the SPA fallback (405/404).
 *
 * This is the same contract on the surface a plugin does own: one prefix route,
 * a same-origin fence, JSON-only bodies, and the identical
 * `{ ok, value }` / `{ ok, error: { code, message, details } }` envelope the
 * endpoint handlers already return. The fence mirrors the Connection's own
 * reasoning: a cross-site POST always carries its own `Origin`, and requiring
 * `application/json` makes the browser preflight it (we never answer that
 * preflight), so a page the user merely visits cannot reach these endpoints.
 *
 * @param path - prefix route path, e.g. `/app`.
 * @param handle - `async (endpoint, payload) => envelope`, unchanged from the
 *   RPC handler signature.
 */
export function createRpcRoute(path, handle) {
  const MAX_BODY_BYTES = 1 << 20
  const fail = (res, status, code, message) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: false, error: { code, message, details: {} } }))
  }
  return {
    kind: 'prefix',
    path,
    handler: (req, res) => {
      const host = req.headers.host
      const origin = req.headers.origin
      if (typeof origin === 'string' && origin.length > 0) {
        let sameOrigin = false
        try {
          sameOrigin = new URL(origin).host === host
        } catch {
          sameOrigin = false
        }
        if (!sameOrigin) return fail(res, 403, 'forbidden', 'cross-origin request refused')
      }
      if (req.method !== 'POST') return fail(res, 405, 'method-not-allowed', 'RPC endpoints accept POST only')
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (contentType !== 'application/json') return fail(res, 415, 'unsupported-media-type', 'content-type must be application/json')
      const url = String(req.url ?? '')
      const query = url.indexOf('?')
      const pathname = query === -1 ? url : url.slice(0, query)
      const endpoint = pathname.startsWith(`${path}/`) ? pathname.slice(path.length + 1) : undefined
      if (endpoint === undefined || endpoint.length === 0 || endpoint.includes('/')) {
        return fail(res, 404, 'unknown-endpoint', `unknown endpoint: ${JSON.stringify(pathname)}`)
      }
      let raw = ''
      let overflow = false
      req.on('data', (chunk) => {
        if (overflow) return
        raw += chunk
        if (raw.length > MAX_BODY_BYTES) {
          overflow = true
          req.destroy()
        }
      })
      req.on('error', () => { /* client went away */ })
      req.on('end', () => {
        if (overflow) return fail(res, 413, 'payload-too-large', 'request body is too large')
        let payload
        try {
          payload = raw.length === 0 ? {} : JSON.parse(raw)
        } catch {
          return fail(res, 400, 'bad-request', 'body is not JSON')
        }
        void Promise.resolve()
          .then(() => handle(endpoint, payload))
          .then(
            (envelope) => {
              if (res.writableEnded) return
              res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
              res.end(JSON.stringify(envelope))
            },
            (error) => {
              if (res.writableEnded) return
              fail(res, 500, 'internal', String(error?.message ?? error))
            },
          )
      })
    },
  }
}

/** Ids of live agents currently running a turn. */
export function runningSessionIds(agents) {
  return agents.list().filter((agent) => agent.status === 'running').map((agent) => agent.id)
}

let portsCache = { at: 0, ports: [] }

/** Ports this process is listening on, discovered via netstat (cached 10 s). */
export function listeningPorts() {
  const now = Date.now()
  if (now - portsCache.at < 10_000) return portsCache.ports
  const found = []
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    const pid = String(process.pid)
    for (const line of out.split(/\r?\n/)) {
      if (!/\bLISTENING\b/i.test(line)) continue
      const cols = line.trim().split(/\s+/)
      if (cols.length < 5 || cols[cols.length - 1] !== pid) continue
      const match = cols[1]?.match(/:(\d+)$/)
      if (match) found.push(Number(match[1]))
    }
  } catch {
    /* netstat unavailable: report no ports */
  }
  const ports = [...new Set(found)].sort((a, b) => a - b)
  portsCache = { at: now, ports }
  return ports
}

/** dsh package version resolved from the entry script (walks up to package.json). */
export function dshVersion(scriptPath = process.argv[1]) {
  try {
    let dir = dirname(resolve(String(scriptPath ?? '')))
    for (let i = 0; i < 12; i++) {
      const pkgPath = join(dir, 'package.json')
      try {
        const json = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (json.name === '@deepseek-ai/dsh' && typeof json.version === 'string' && json.version.length > 0) {
          return json.version
        }
      } catch {
        /* keep walking up */
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    /* not resolvable */
  }
  return null
}

/** Live snapshot of the service process running this plugin. */
export function serviceInfo() {
  const uptime = process.uptime()
  return {
    pid: process.pid,
    startedAt: new Date(Date.now() - uptime * 1000).toISOString(),
    uptime: Math.floor(uptime),
    rss: process.memoryUsage?.().rss ?? 0,
    node: process.version,
    execPath: process.execPath,
    version: dshVersion(),
    ports: listeningPorts(),
  }
}

/** Parse `major.minor.patch[-prerelease]`; null when the text is not semver. */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text ?? '').trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? null : match[4].split('.'),
  }
}

/**
 * Semver ordering (spec §11), prerelease-aware: `0.1.5-rc.3` > `0.1.5-rc.2`,
 * and a release beats its own prereleases (`0.1.5` > `0.1.5-rc.3`). Returns
 * null when either side is unparseable, so callers never treat "cannot tell"
 * as "newer".
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.pre === null && b.pre === null) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index]
    const y = b.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
      continue
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Whether `candidate` is strictly newer than `installed`. */
export function isNewerVersion(installed, candidate) {
  return compareVersions(candidate, installed) === 1
}

/**
 * The registry the version check asks. Only the top-level `registry=` line is
 * ever extracted from the npmrc — that file also carries auth tokens for other
 * scopes, so its text must never reach a log or a response. npm itself would
 * also consider a project npmrc and the global one; a check running inside the
 * service cannot know those, hence the user file then the public registry.
 */
export function parseRegistry(npmrcText) {
  for (const line of String(npmrcText ?? '').split(/\r?\n/)) {
    const match = /^\s*registry\s*=\s*(\S+)\s*$/.exec(line)
    if (match !== null) return match[1].replace(/\/+$/, '')
  }
  return 'https://registry.npmjs.org'
}

/** Registry from `~/.npmrc` (see parseRegistry), never throwing. */
export function resolveRegistry(home = homedir()) {
  try {
    return parseRegistry(readFileSync(join(home, '.npmrc'), 'utf8'))
  } catch {
    return 'https://registry.npmjs.org'
  }
}

/**
 * Cordis plugin entry: register the `/app` RPC route (plus the favicon /
 * liveness routes that share this half's carrier).
 *
 * `agents` and `webServer` are **static** `inject` dependencies, not a dynamic
 * `ctx.inject(...)` inside `apply`: a user-layer hot reload does not re-activate
 * the dynamic child fiber (the channel stayed 404 until a full restart), while
 * the static form is unaffected — and it is what makes the HTTP carrier actually
 * present here, since Cordis mounts rows in parallel and `webServer` binds later
 * than `agents`. Reading it with `ctx.get('webServer')` during activation races
 * that binding, sees `undefined`, and silently skips the page's whole
 * transport; that race is how four of five migrated patches came up dead after
 * the first restart. The `webServer === undefined` branches below are the
 * "declared yet somehow still absent" fallback, kept so a missing carrier is
 * reported on /ui-settings-other/health instead of throwing.
 */
export const inject = ['agents', 'webServer']

export function apply(ctx, config = {}) {
  // State is per-instance: module-level mutable state would leak across HMR
  // reloads (a stale `restarting` flag would permanently block restarts).
  const logger = ctx.logger
  let restarting = false
  let restartWatchdog = null
  /** Last version-check answer, so repeated page polls do not hammer the registry. */
  let versionCache = null

  // Diagnostics: this host half's state, directly observable on loopback at
  // /ui-settings-other/health. Without it, "the /app route never registered"
  // and "the status endpoint threw" are indistinguishable from the page —
  // both render 运行状态获取失败. Read-only, no-store, exact route.
  const diagnostics = { channel: false, branding: false, warnings: [] }
  const webServer = ctx.get('webServer')
  try {
    if (webServer !== undefined) {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/ui-settings-other/health',
        handler: (req, res) => {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, namespace: PLUGIN_NAMESPACE, ...diagnostics }))
        },
      }), 'ui-settings-other: health route')
    }
  } catch (error) {
    logger.warn(`[ui-settings-other] health route unavailable: ${String(error?.message ?? error)}`)
  }

  const busyFailure = (sessions) => ({
    ok: false,
    error: {
      code: 'sessions-running',
      message: `${sessions.length} 个会话正在运行,重启会中断它们(可强制重启)`,
      details: { running: sessions.length, sessions },
    },
  })

  /**
   * Compare the running dsh against the `latest` dist-tag. Read-only and
   * fail-soft: an unreachable registry yields `latest: null` plus the reason
   * in `error` (never an ok:false envelope — "no update information" is not
   * a failed request). Cached for a few minutes; `force` skips the cache.
   */
  const versionCheck = async (force) => {
    const now = Date.now()
    if (!force && versionCache !== null && now - versionCache.at < VERSION_CHECK_TTL_MS) return versionCache.value
    const current = dshVersion()
    const registry = resolveRegistry()
    let latest = null
    let error = null
    try {
      const response = await fetch(`${registry}/@deepseek-ai%2Fdsh`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
      })
      if (!response.ok) {
        error = `registry answered HTTP ${response.status}`
      } else {
        const body = await response.json()
        const tag = body?.['dist-tags']?.latest
        if (typeof tag !== 'string' || tag.length === 0) error = 'registry has no latest dist-tag'
        else latest = tag
      }
    } catch (cause) {
      error = String(cause?.message ?? cause)
    }
    const value = {
      current,
      latest,
      // `latest` only: the alpha channel runs ahead of it and would otherwise
      // read as an available update on a release-candidate install.
      hasUpdate: latest !== null && current !== null && isNewerVersion(current, latest),
      registry,
      error,
    }
    versionCache = { at: now, value }
    return value
  }

  // The restart watchdog is a plugin-owned timer: unloading must cancel a
  // pending 90 s release instead of letting it fire on a disposed fiber
  // (and hold the process's event loop open).
  ctx.effect(() => () => {
    if (restartWatchdog !== null) {
      clearTimeout(restartWatchdog)
      restartWatchdog = null
    }
  }, 'ui-settings-other: restart watchdog')

  // Branding is optional setup and the `/app` route below is this section's
  // only lifeline: a throw here used to skip the registration entirely,
  // which leaves the whole page showing "运行状态获取失败" with every button
  // dead. It is therefore isolated and reports its own failure instead of
  // taking the route down.
  if (webServer !== undefined) {
    try {
      const svg = faviconSvg(patchAssetPath('favicon-128.png'))
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/favicon.svg',
        handler: (req, res) => {
          res.writeHead(200, {
            'content-type': 'image/svg+xml',
            'cache-control': 'public, max-age=86400',
          })
          res.end(svg)
        },
      }), 'ui-settings-other: favicon route')
      diagnostics.branding = true
    } catch (error) {
      const message = `favicon override skipped: ${String(error?.message ?? error)}`
      diagnostics.warnings.push(message)
      logger.warn(`[ui-settings-other] ${message}`)
    }
  }
  const handleEndpoint = async (endpoint, payload) => {
    if (endpoint === 'status') {
      const sessions = runningSessionIds(ctx.agents)
      return { ok: true, value: { running: sessions.length, sessions, service: serviceInfo() } }
    }
    if (endpoint === 'versionCheck') {
      return { ok: true, value: await versionCheck(payload?.args?.force === true) }
    }
    if (endpoint === 'installShortcut') {
      // Create the desktop shortcut (console window + whale-girl icon). The
      // script is idempotent: an existing shortcut is reported, not replaced,
      // and `created` carries that real outcome back to the caller.
      const result = installShortcut()
      if (!result.ok) {
        return {
          ok: false,
          error: { code: 'internal', message: result.output, details: { script: result.script } },
        }
      }
      return { ok: true, value: { created: result.created, icon: result.icon, output: result.output } }
    }
    if (endpoint !== 'restart' && endpoint !== 'update') {
      return {
        ok: false,
        error: { code: 'bad-request', message: `unknown endpoint: ${endpoint}`, details: { channel: '/app', endpoint: String(endpoint) } },
      }
    }

    // `update` installs a new dsh and ends in the same restart, so it shares
    // this whole tail: the lock, the session protection, the script spawn and
    // the watchdog. Only the script, its extra arguments and the payload's
    // `version` differ.
    const isUpdate = endpoint === 'update'
    let version = null
    if (isUpdate) {
      const requested = payload?.args?.version
      if (requested !== undefined && requested !== null) {
        // Pinned by the caller (what the page read from the registry) so the
        // run is deterministic; omitted lets the script ask npm for `latest`.
        if (typeof requested !== 'string' || !/^\d+\.\d+\.\d+/.test(requested)) {
          return {
            ok: false,
            error: { code: 'bad-request', message: `not a version: ${JSON.stringify(requested)}`, details: { version: String(requested) } },
          }
        }
        version = requested
      }
      const current = dshVersion()
      if (version !== null && current !== null && version === current) {
        return {
          ok: false,
          error: { code: 'already-current', message: `already running ${version}`, details: { current } },
        }
      }
    }
    const scriptPath = isUpdate ? resolveUpdateScript(config) : resolveRestartScript(config)
    if (restarting) {
      return { ok: true, value: { scheduled: true, already: true, script: scriptPath } }
    }

    const force = payload?.args?.force === true
    const running = runningSessionIds(ctx.agents)
    if (running.length > 0 && !force) {
      return busyFailure(running)
    }

    restarting = true

    // Force path: cancel running agents first so sessions stay resumable.
    if (running.length > 0) {
      for (const id of running) {
        const agent = ctx.agents.get(id)
        if (agent !== undefined && agent.status === 'running') {
          agent.cancel({ kind: 'user' }, { keepInbox: true })
        }
      }
    }

    try {
      statSync(scriptPath)
    } catch {
      restarting = false
      return {
        ok: false,
        error: {
          code: 'internal',
          message: `${isUpdate ? 'update' : 'restart'} script not found: ${scriptPath} (run scripts/deploy.ps1 to install it)`,
          details: { script: scriptPath },
        },
      }
    }

    const invocation = buildRestartSpawn(
      scriptPath,
      version === null ? ['-OpenBrowser'] : ['-Version', version, '-OpenBrowser'],
    )
    try {
      // NOT `detached: true`: PowerShell 5.1 spawned detached exits 0 without
      // running the script at all (see buildRestartSpawn). This outer
      // powershell only calls Start-Process, which is what makes the restart
      // script an independent process — and `unref()` keeps this process from
      // waiting on it.
      const child = spawn(invocation.file, invocation.args, {
        stdio: 'ignore',
        cwd: process.cwd(),
        env: process.env,
        windowsHide: true,
      })
      child.unref()
      // A successful restart kills this process before the child exits; any
      // other outcome (spawn failure or a non-zero script exit) must clear
      // the lock so later restarts are not stuck at "already scheduled".
      child.on('error', (error) => {
        logger.warn(`[ui-settings-other] restart spawn failed: ${String(error)}`)
        restarting = false
      })
      child.on('exit', (code) => {
        if (code !== 0) {
          logger.warn(`[ui-settings-other] restart script exited with code ${code}; restart may have failed`)
          restarting = false
        }
      })
      // Watchdog: if the script neither swaps the service nor exits non-zero
      // within its window, release the lock anyway. An update legitimately
      // runs for minutes (fetch, patch the new build, boot it), so it gets a
      // much longer one — 90 s there would let a second update in while the
      // first is still mid-flight. It is owned by the plugin lifecycle (the
      // effect registered in `apply`), so an unload cancels it instead of
      // leaving it to fire on a disposed fiber.
      if (restartWatchdog !== null) clearTimeout(restartWatchdog)
      restartWatchdog = setTimeout(() => {
        restartWatchdog = null
        restarting = false
      }, isUpdate ? UPDATE_WATCHDOG_MS : 90_000)
    } catch (error) {
      restarting = false
      return {
        ok: false,
        error: { code: 'internal', message: String(error), details: { script: scriptPath } },
      }
    }
    return { ok: true, value: isUpdate ? { scheduled: true, script: scriptPath, version } : { scheduled: true, script: scriptPath } }
  }

  // The page reaches this half over one prefix route on the web carrier.
  // `ctx.connection.rpc.handle` is not an option in dsh 0.1.5-rc.1: its
  // registry reads `owner.webServer` on a context that never declared it and
  // throws `cannot get property "webServer" without inject`, so no channel
  // would exist and the page's RPC calls would land on the SPA fallback.
  // See createRpcRoute() for the fence that replaces the Connection's own.
  if (webServer === undefined) {
    const message = 'webServer is unavailable; the page cannot reach this half'
    diagnostics.warnings.push(message)
    logger.warn(`[ui-settings-other] ${message}`)
    return undefined
  }
  try {
    const route = createRpcRoute('/app', handleEndpoint)
    ctx.effect(() => webServer.register(route), 'ui-settings-other: /app rpc route')
    diagnostics.channel = true
  } catch (error) {
    const message = `the /app route could not be registered: ${String(error?.message ?? error)}`
    diagnostics.warnings.push(message)
    logger.warn(`[ui-settings-other] ${message}`)
  }
  return undefined
}
