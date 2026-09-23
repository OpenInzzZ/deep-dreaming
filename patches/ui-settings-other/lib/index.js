/**
 * Host half of the ui-settings-other patch: a restart-service RPC endpoint,
 * a runtime-status snapshot, an idle auto-stop monitor, a desktop-shortcut
 * installer, and the Web title-bar icon (favicon) override.
 *
 * Exposes a dedicated Connection RPC channel `/app` (the shared `/api` channel
 * is exclusively owned by the Typert gateway, so a user-level plugin registers
 * its own channel through `ctx.connection.rpc.handle` with the loopback
 * authority — the web page only ever reaches this from 127.0.0.1).
 *
 * Endpoints:
 * - `status`  → `{ running, sessions, service, idle }` where `service` is a
 *   live process snapshot (pid, startedAt, uptime, rss, node, execPath, dsh
 *   version, listening ports via netstat) and `idle` is the auto-stop state.
 * - `restart` → delegates the whole job to the standalone script
 *   `restart-dsh.ps1` (deployed to `~/.dsh/scripts/` by scripts/deploy.ps1):
 *   the script finds the process listening on the web port, recovers its exact
 *   command line, lets the RPC response settle, stops the old process, starts
 *   a replacement with the same command line (logs redirected), and polls
 *   until the service answers. Keeping the lifecycle in a script makes the
 *   restart independently testable (`-DryRun`) and keeps this host entry a
 *   thin, dependency-free trigger.
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
 * Idle auto-stop: when no agent session has been running for `idleMinutes`
 * (settings namespace `ui-settings-other`, default 120 = 2 h, editable in
 * 设置 → 插件 → 插件配置), the service requests a graceful shutdown through
 * `ctx.appExit` — the launcher-provided exit request that disposes the app
 * fiber — falling back to `process.exit(0)` when absent. The namespace is
 * registered by hand (`settings.register` + `scope.watch`), NOT through
 * `settings.installSection`, and it is not `applies: live`: re-deriving the
 * idle monitor from a committed change is this plugin's own job.
 *
 * The script path comes from the patch config (`script`), defaulting to
 * `~/.dsh/scripts/restart-dsh.ps1`.
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

export const SETTINGS_NAMESPACE = 'ui-settings-other'

/** Idle monitor cadence. */
export const IDLE_CHECK_MS = 60_000

/** Floor defaults; the composition entry and the settings document layer rise above. */
export const DEFAULTS = { idleEnabled: true, idleMinutes: 120 }

/**
 * Settings schema for the namespace (defaults are the floor). Exported as
 * `Config` so the Loader validates the entry config at load time. Unknown keys
 * are tolerated (kept, not rejected), so dropping a key here never breaks an
 * existing entry config.
 */
export const ConfigSchema = z.object({
  idleEnabled: z.boolean().default(true),
  idleMinutes: z.number().default(120).min(1),
  script: z.string().default(''),
})

export const Config = ConfigSchema

/** Resolve the restart-script path: config > default under the dsh home. */
export function resolveRestartScript(config = {}) {
  const configured = config.script
  if (typeof configured === 'string' && configured.length > 0) {
    return isAbsolute(configured) ? configured : join(homedir(), '.dsh', configured)
  }
  return join(homedir(), '.dsh', 'scripts', 'restart-dsh.ps1')
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

/** Build the spawn invocation for the restart script (pure, testable). */
export function buildRestartSpawn(scriptPath, extraArgs = []) {
  return {
    file: 'powershell',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...extraArgs],
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

/**
 * Pure idle decision. `busy` = any session is running right now.
 * @returns {{action:'busy'}} when busy (resets the idle clock),
 *          {{action:'stop'}} when idle longer than the threshold,
 *          {{action:'wait', remainingMs}} otherwise,
 *          {{action:'disabled'}} when idleMinutes is not positive.
 */
export function idleDecision({ busy, lastBusyAt, now, idleMinutes }) {
  if (busy) return { action: 'busy' }
  const idleMs = idleMinutes * 60_000
  if (!(idleMs > 0)) return { action: 'disabled' }
  const elapsed = now - lastBusyAt
  if (elapsed >= idleMs) return { action: 'stop', idleMs }
  return { action: 'wait', remainingMs: idleMs - elapsed }
}

/**
 * Idle monitor: every IDLE_CHECK_MS asks `busy()`; busy resets the clock,
 * otherwise `onStop` fires once the idle threshold (from `idleMinutes()`)
 * is crossed. Clock and timers are injectable for tests.
 */
export function createIdleMonitor({ busy, idleMinutes, onStop, now = Date.now, setInterval: setIntervalFn = setInterval, clearInterval: clearIntervalFn = clearInterval }) {
  let lastBusyAt = now()
  let stopped = false
  const check = () => {
    if (stopped) return null
    const decision = idleDecision({ busy: busy(), lastBusyAt, now: now(), idleMinutes: idleMinutes() })
    if (decision.action === 'busy') lastBusyAt = now()
    else if (decision.action === 'stop') {
      stopped = true
      onStop(decision)
    }
    return decision
  }
  const timer = setIntervalFn(check, IDLE_CHECK_MS)
  return {
    check,
    lastBusyAt: () => lastBusyAt,
    stop: () => {
      stopped = true
      clearIntervalFn(timer)
    },
  }
}

/** Only the settings-owned fields participate in the settings namespace. */
function pickSettings(config) {
  const out = {}
  if (config.idleEnabled !== undefined) out.idleEnabled = config.idleEnabled
  if (config.idleMinutes !== undefined) out.idleMinutes = config.idleMinutes
  return out
}

/**
 * Cordis `FiberState` members that mean "this fiber is going down". A const
 * enum has no runtime object, so the values are mirrored here — the same
 * mirror dsh's own settings provider keeps for its `isUnloading` guard.
 */
const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

/**
 * Whether a context's own fiber is unloading — as opposed to merely losing a
 * service it had injected. The two cases reach the same disposer and need
 * opposite reactions, so they must not be conflated.
 */
function isUnloading(ctx) {
  const state = ctx?.fiber?.state
  return state === FIBER_UNLOADING || state === FIBER_DISPOSED
}

/**
 * Register the settings namespace and hand the write scope to `onScope`.
 *
 * This is a hand-rolled `settings.installSection` (the namespace is registered
 * with `settings.register` + `scope.watch`, NOT with `applies: live`), and it
 * keeps that helper's `isUnloading` guard: the disposer below runs both when
 * the settings provider detaches (the plugin keeps running, so `entrySource` —
 * the entry config resolved exactly like `apply` resolves it — becomes the
 * source again) and when this plugin itself unloads (the entry value is
 * irrelevant and rebuilding resources would create a timer on a dying
 * context). `hooks.isUnloading()` reports WHICH of the two it is; it inspects
 * the plugin's own fiber, never the settings child fiber, because the child
 * unloads in both cases.
 *
 * The unloading branch closes the resource path itself, before it could notify
 * any change: Cordis releases a fiber's effects in reverse registration order
 * and this settings child fiber is registered after the monitor effect in
 * `apply`, so this disposer really does run first during an unload.
 */
function registerConfigSection(ctx, ns, schema, entry, hooks, onScope) {
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(ns, schema, { base: entry })
    hooks.setSource(() => scope.get())
    sctx.effect(() => () => {
      if (hooks.isUnloading()) {
        hooks.onClose()
        return
      }
      hooks.setSource(hooks.entrySource)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      if (hooks.isUnloading()) return
      hooks.onChange()
    })
    onScope(scope)
  })
}

/** RPC failure envelope for the config endpoints. */
function settingsError(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

/** Cordis plugin entry: register the `/app` RPC channel + the idle monitor. */
export function apply(ctx, config = {}) {
  const settingsEntry = pickSettings(config)

  // State is per-instance: module-level mutable state would leak across HMR
  // reloads (a stale `restarting` flag would permanently block restarts).
  //
  // `webServer` is a DECLARED dependency, not an optional read: Cordis mounts
  // rows in parallel and the HTTP carrier is bound later than `agents`, so
  // reading it with `ctx.get('webServer')` during this callback races that
  // binding, sees `undefined`, and silently skips the page's whole transport.
  // That race is exactly how four of five migrated patches came up dead after
  // the first restart. Waiting on it here makes the registration unconditional.
  ctx.inject(['webServer', 'agents'], (ctx) => {
    const logger = ctx.logger
    // The plugin's own context: its fiber state, not the settings child's,
    // tells "the settings provider went away" from "this plugin is unloading".
    const ownerCtx = ctx
    /** Entry-config source, resolved with the schema defaults as the floor. */
    const entrySource = () => ({ ...DEFAULTS, ...settingsEntry })
    let source = entrySource
    let configScope = null
    let monitorApi = null
    let restarting = false
    let restartWatchdog = null
    let closed = false

    // Diagnostics: this host half's state, directly observable on loopback at
    // /ui-settings-other/health. Without it, "the /app channel never
    // registered" and "the status endpoint threw" are indistinguishable from
    // the page — both render 运行状态获取失败. Read-only, no-store, exact route.
    const diagnostics = { channel: false, settings: false, branding: false, warnings: [] }
    const webServer = ctx.get('webServer')
    try {
      if (webServer !== undefined) {
        ctx.effect(() => webServer.register({
          kind: 'exact',
          path: '/ui-settings-other/health',
          handler: (req, res) => {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, namespace: SETTINGS_NAMESPACE, ...diagnostics }))
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

    /** Graceful shutdown request through the launcher's exit hook. */
    const stopService = () => {
      const current = source()
      logger.info(`[ui-settings-other] idle auto-stop: no running session for ${current.idleMinutes} minutes; stopping dsh web`)
      try {
        const exit = ctx.get('appExit')
        if (typeof exit === 'function') {
          exit(0)
          return
        }
      } catch {
        /* fall through to a hard exit */
      }
      process.exit(0)
    }

    /** Stop the idle monitor, if one is live (idempotent). */
    const stopMonitor = () => {
      if (monitorApi !== null) {
        monitorApi.stop()
        monitorApi = null
      }
    }

    /**
     * Single assembly path for the idle monitor: make it match the current
     * source (settings > entry) instead of unconditionally rebuilding it.
     * `idleMinutes` is read through `source()` on every tick, so only the
     * enabled/disabled decision needs assembling at all; calling this twice for
     * the same configuration — the settings section attaching after the entry
     * fallback below, or a no-op settings write — must not build a second
     * monitor and stop the first.
     */
    const syncMonitor = () => {
      if (closed) return
      const current = source()
      const wanted = current.idleEnabled === true && current.idleMinutes > 0
      if (!wanted) {
        stopMonitor()
        return
      }
      if (monitorApi !== null) return
      monitorApi = createIdleMonitor({
        busy: () => runningSessionIds(ctx.agents).length > 0,
        idleMinutes: () => source().idleMinutes,
        onStop: stopService,
      })
    }

    /**
     * Close the rebuild path and stop whatever timer is live. BOTH disposers
     * call it, because Cordis releases a fiber's effects in reverse
     * registration order: the monitor effect below is registered before the
     * settings child fiber (`ctx.inject`), so during an unload the settings
     * section's disposer runs FIRST — while a flag owned by this effect is
     * still false. The section therefore closes the path itself (see
     * `registerConfigSection`) before it can notify a change, and this effect
     * closes it again as the outer safety net. In either order, no monitor can
     * be created during the unload and none survives it.
     */
    const closeMonitor = () => {
      closed = true
      stopMonitor()
    }

    ctx.effect(() => () => closeMonitor(), 'ui-settings-other: idle monitor')

    // The restart watchdog is a plugin-owned timer too: unloading must cancel
    // a pending 90 s release instead of letting it fire on a disposed fiber
    // (and hold the process's event loop open).
    ctx.effect(() => () => {
      if (restartWatchdog !== null) {
        clearTimeout(restartWatchdog)
        restartWatchdog = null
      }
    }, 'ui-settings-other: restart watchdog')

    // Everything between here and the `/app` registration below is optional
    // setup, and the RPC channel is the section's only lifeline: a throw in
    // the settings wiring or in the favicon branding used to skip the
    // registration entirely, which leaves the whole page showing
    // "运行状态获取失败" with every button dead. Each step is therefore
    // isolated and reports its own failure instead of taking the channel down.
    try {
      registerConfigSection(ctx, SETTINGS_NAMESPACE, ConfigSchema, settingsEntry, {
        setSource: (current) => { source = current },
        entrySource,
        onChange: syncMonitor,
        onClose: closeMonitor,
        isUnloading: () => isUnloading(ownerCtx),
      }, (scope) => { configScope = scope; diagnostics.settings = true })
    } catch (error) {
      const message = `settings wiring failed (${String(error?.message ?? error)}); the page runs on the entry-config defaults`
      diagnostics.warnings.push(message)
      logger.warn(`[ui-settings-other] ${message}`)
    }

    // Entry-config fallback: the section above assembles the monitor as soon
    // as it attaches (its `ctx.inject` callback runs on a later microtask), so
    // this only covers a boot without a settings service — and because
    // `syncMonitor` is idempotent it stays a single assembly either way.
    try {
      syncMonitor()
    } catch (error) {
      const message = `idle monitor not armed: ${String(error?.message ?? error)}`
      diagnostics.warnings.push(message)
      logger.warn(`[ui-settings-other] ${message}`)
    }

    // Branding: override the shipped favicon with the whale-girl icon. The
    // exact route wins over the SPA dist fallback; the icon is bundled in
    // this patch and served as an SVG wrapper around the 128px PNG. A missing
    // or unreadable asset only skips the branding.
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
      if (endpoint === 'getSettings') {
        return { ok: true, value: source() }
      }
      if (endpoint === 'setSettings') {
        if (configScope === null) {
          return settingsError('settings-unavailable', 'settings service is not ready yet', { namespace: SETTINGS_NAMESPACE })
        }
        const fields = payload?.args?.fields
        if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
          return settingsError('bad-request', 'fields must be a plain object', {
            namespace: SETTINGS_NAMESPACE,
            received: Array.isArray(fields) ? 'array' : typeof fields,
          })
        }
        try {
          await configScope.update(fields)
          return { ok: true, value: source() }
        } catch (error) {
          return settingsError('settings-rejected', String(error?.message ?? error), { namespace: SETTINGS_NAMESPACE })
        }
      }
      if (endpoint === 'resetSettings') {
        if (configScope === null) {
          return settingsError('settings-unavailable', 'settings service is not ready yet', { namespace: SETTINGS_NAMESPACE })
        }
        try {
          await configScope.replace({})
          return { ok: true, value: source() }
        } catch (error) {
          return settingsError('settings-rejected', String(error?.message ?? error), { namespace: SETTINGS_NAMESPACE })
        }
      }
      if (endpoint === 'status') {
        const sessions = runningSessionIds(ctx.agents)
        const current = source()
        const idle = {
          enabled: current.idleEnabled === true && current.idleMinutes > 0,
          idleMinutes: current.idleMinutes,
        }
        if (idle.enabled && monitorApi !== null) idle.lastBusyAt = monitorApi.lastBusyAt()
        return { ok: true, value: { running: sessions.length, sessions, service: serviceInfo(), idle } }
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
      if (endpoint !== 'restart') {
        return {
          ok: false,
          error: { code: 'bad-request', message: `unknown endpoint: ${endpoint}`, details: { channel: '/app', endpoint: String(endpoint) } },
        }
      }
      if (restarting) {
        return { ok: true, value: { scheduled: true, already: true, script: resolveRestartScript(config) } }
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

      const scriptPath = resolveRestartScript(config)
      try {
        statSync(scriptPath)
      } catch {
        restarting = false
        return {
          ok: false,
          error: {
            code: 'internal',
            message: `restart script not found: ${scriptPath} (run scripts/deploy.ps1 to install it)`,
            details: { script: scriptPath },
          },
        }
      }

      const invocation = buildRestartSpawn(scriptPath, ['-OpenBrowser'])
      try {
        const child = spawn(invocation.file, invocation.args, {
          detached: true,
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
        // Watchdog: if the script neither restarts the service nor exits
        // non-zero within 90s, release the lock anyway. It is owned by the
        // plugin lifecycle (the effect registered in `apply`), so an unload
        // cancels it instead of leaving it to fire on a disposed fiber.
        if (restartWatchdog !== null) clearTimeout(restartWatchdog)
        restartWatchdog = setTimeout(() => {
          restartWatchdog = null
          restarting = false
        }, 90_000)
      } catch (error) {
        restarting = false
        return {
          ok: false,
          error: { code: 'internal', message: String(error), details: { script: scriptPath } },
        }
      }
      return { ok: true, value: { scheduled: true, script: scriptPath } }
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
  })
}
