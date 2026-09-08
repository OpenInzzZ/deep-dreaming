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
 * - `installShortcut` → creates the desktop shortcut that silently starts
 *   dsh web (via `install-desktop-shortcut.ps1`), first ensuring the whale-girl
 *   icon asset exists under `~/.dsh/assets/`.
 * - `reloadPlugins` → hot-reloads the user patch layer (see below).
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
 * fiber — falling back to `process.exit(0)` when absent. `applies: live`:
 * settings changes rebuild the monitor immediately.
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
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

export const SETTINGS_NAMESPACE = 'ui-settings-other'

/** Idle monitor cadence. */
export const IDLE_CHECK_MS = 60_000

/** Floor defaults; the composition entry and the settings document layer rise above. */
export const DEFAULTS = { idleEnabled: true, idleMinutes: 120 }

/**
 * Settings schema for the namespace (defaults are the floor). Exported as
 * `Config` so the Loader validates the entry config at load time and strips
 * nothing (unknown keys would be dropped by the schema's default strip).
 */
export const ConfigSchema = z.object({
  idleEnabled: z.boolean().default(true),
  idleMinutes: z.number().default(120).min(1),
  script: z.string().default(''),
  patchFile: z.string().default(''),
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

/** Resolve the user patch layer to touch for a hot plugin reload. */
export function resolvePatchFile(config = {}) {
  const configured = config.patchFile
  if (typeof configured === 'string' && configured.length > 0) {
    return isAbsolute(configured) ? configured : join(homedir(), '.dsh', configured)
  }
  return join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml')
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

/**
 * Create (or refresh) the desktop shortcut that silently starts dsh web.
 * Runs the deployed `install-desktop-shortcut.ps1` synchronously and returns
 * its output; the script is idempotent (existing shortcut → "already exists").
 * @returns {{ ok: boolean, output: string, icon: string }}
 */
export function installShortcut() {
  const icon = ensureIconAsset()
  const script = join(homedir(), '.dsh', 'scripts', 'install-desktop-shortcut.ps1')
  if (!existsSync(script)) {
    return { ok: false, output: `install script missing: ${script} (run scripts/deploy.ps1 first)`, icon }
  }
  try {
    const output = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    return { ok: true, output: output.trim(), icon }
  } catch (error) {
    const detail = error?.stdout?.toString()?.trim() || error?.message || String(error)
    return { ok: false, output: detail, icon }
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
 * Register the settings namespace and hand the write scope to `onScope`.
 * Mirrors dsh-settings' installSettingsSection (including its `isUnloading`
 * guard: the disposer restores the entry source but must not rebuild
 * resources while the plugin is going down — a rebuild would leak a fresh
 * monitor/timer on a disposed context).
 */
function registerConfigSection(ctx, ns, schema, entry, hooks, onScope) {
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(ns, schema, { base: entry })
    hooks.setSource(() => scope.get())
    sctx.effect(() => () => {
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => { hooks.onChange() })
    onScope(scope)
  })
}

/** RPC failure envelope for the config endpoints. */
function settingsError(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/** Cordis plugin entry: register the `/app` RPC channel + the idle monitor. */
export function apply(ctx, config = {}) {
  const settingsEntry = pickSettings(config)

  // State is per-instance: module-level mutable state would leak across HMR
  // reloads (a stale `restarting` flag would permanently block restarts).
  ctx.inject(['connection', 'agents'], (ctx) => {
    const logger = ctx.logger
    let source = () => ({ ...DEFAULTS, ...settingsEntry })
    let configScope = null
    let monitorApi = null
    let restarting = false
    let disposed = false

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

    /** (Re)build the idle monitor from the current source (settings > entry). */
    const rebuildMonitor = () => {
      if (disposed) return
      if (monitorApi !== null) {
        monitorApi.stop()
        monitorApi = null
      }
      const current = source()
      if (current.idleEnabled !== true || !(current.idleMinutes > 0)) return
      monitorApi = createIdleMonitor({
        busy: () => runningSessionIds(ctx.agents).length > 0,
        idleMinutes: () => source().idleMinutes,
        onStop: stopService,
      })
    }

    // The idle monitor owns a raw interval; dispose it with the plugin. This
    // must run before registerConfigSection's disposer (reverse order), so a
    // stale rebuild during unload is a no-op via `disposed`.
    ctx.effect(() => () => {
      disposed = true
      if (monitorApi !== null) {
        monitorApi.stop()
        monitorApi = null
      }
    }, 'ui-settings-other: idle monitor')

    registerConfigSection(ctx, SETTINGS_NAMESPACE, ConfigSchema, settingsEntry, {
      setSource: (current) => { source = current },
      onChange: rebuildMonitor,
    }, (scope) => { configScope = scope })
    rebuildMonitor()

    // Branding: override the shipped favicon with the whale-girl icon. The
    // exact route wins over the SPA dist fallback; the icon is bundled in
    // this patch and served as an SVG wrapper around the 128px PNG.
    const webServer = ctx.get('webServer')
    if (webServer !== undefined) {
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
    }
    return ctx.connection.rpc.handle('/app', async (endpoint, payload) => {
      if (endpoint === 'getSettings') {
        return { ok: true, value: source() }
      }
      if (endpoint === 'setSettings') {
        if (configScope === null) {
          return settingsError('settings-unavailable', 'settings service is not ready yet')
        }
        const fields = payload?.args?.fields
        if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
          return settingsError('bad-request', 'fields must be a plain object')
        }
        try {
          await configScope.update(fields)
          return { ok: true, value: source() }
        } catch (error) {
          return settingsError('settings-rejected', String(error?.message ?? error))
        }
      }
      if (endpoint === 'resetSettings') {
        if (configScope === null) {
          return settingsError('settings-unavailable', 'settings service is not ready yet')
        }
        try {
          await configScope.replace({})
          return { ok: true, value: source() }
        } catch (error) {
          return settingsError('settings-rejected', String(error?.message ?? error))
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
        // Create the desktop shortcut (silent start, whale-girl icon). The
        // script is idempotent; an existing shortcut is reported, not replaced.
        const result = installShortcut()
        if (!result.ok) {
          return {
            ok: false,
            error: { code: 'internal', message: result.output, details: {} },
          }
        }
        return { ok: true, value: { created: true, icon: result.icon, output: result.output } }
      }
      if (endpoint === 'stop') {
        // Stop (not restart) the service: graceful exit through the launcher's
        // appExit hook. The exit is deferred so the RPC response reaches the
        // browser first; sessions-running is protected like restart.
        const force = payload?.args?.force === true
        const running = runningSessionIds(ctx.agents)
        if (running.length > 0 && !force) {
          return {
            ok: false,
            error: {
              code: 'sessions-running',
              message: `${running.length} 个会话正在运行,中断会打断它们(可强制中断)`,
              details: { running: running.length, sessions: running },
            },
          }
        }
        if (running.length > 0) {
          for (const id of running) {
            const agent = ctx.agents.get(id)
            if (agent !== undefined && agent.status === 'running') {
              agent.cancel({ kind: 'user' }, { keepInbox: true })
            }
          }
        }
        logger.info(`[ui-settings-other] stop requested${force ? ' (force)' : ''}; exiting gracefully`)
        setTimeout(() => {
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
        }, 500)
        return { ok: true, value: { stopping: true } }
      }
      if (endpoint === 'reloadPlugins') {
        // Hot-reload the user patch layer: touching the profile's
        // cordis.patch.yml triggers dsh's watchUserPatches (a Cordis HMR
        // config watch), which transactionally re-applies the whole user
        // layer — every user-level plugin (host + client) is unloaded and
        // remounted without restarting the service, so running sessions and
        // the durable inbox are untouched.
        const patchFile = resolvePatchFile(config)
        try {
          const marker = `# dsh-plugin-reload: ${new Date().toISOString()}`
          let content = await readFile(patchFile, 'utf8')
          if (/^# dsh-plugin-reload: /m.test(content)) {
            content = content.replace(/^# dsh-plugin-reload: .*$/m, marker)
          } else {
            content = content.replace(/\s*$/, '\n') + marker + '\n'
          }
          await writeFile(patchFile, content, 'utf8')
          return { ok: true, value: { requested: true, patchFile, marker } }
        } catch (error) {
          return {
            ok: false,
            error: { code: 'internal', message: `failed to touch patch file: ${String(error)}`, details: {} },
          }
        }
      }
      if (endpoint !== 'restart') {
        return {
          ok: false,
          error: { code: 'bad-request', message: `unknown endpoint: ${endpoint}`, details: {} },
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
            details: {},
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
        // non-zero within 90s, release the lock anyway.
        setTimeout(() => { restarting = false }, 90_000)
      } catch (error) {
        restarting = false
        return {
          ok: false,
          error: { code: 'internal', message: String(error), details: {} },
        }
      }
      return { ok: true, value: { scheduled: true, script: scriptPath } }
    }, { authority: 'loopback' })
  })
}
