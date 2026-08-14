/**
 * Host half of the ui-settings-other patch: a restart-service RPC endpoint,
 * a runtime-status snapshot, and an idle auto-stop monitor.
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
 */

import { spawn, execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, isAbsolute, dirname, resolve } from 'node:path'
import { statSync, readFileSync } from 'node:fs'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export const SETTINGS_NAMESPACE = 'ui-settings-other'

/** Idle monitor cadence. */
export const IDLE_CHECK_MS = 60_000

/** Floor defaults; the composition entry and the settings document layer rise above. */
export const DEFAULTS = { idleEnabled: true, idleMinutes: 120 }

/** Settings schema for the namespace (defaults are the floor). */
export const ConfigSchema = z.object({
  idleEnabled: z.boolean().default(true),
  idleMinutes: z.number().default(120),
})

/** Resolve the restart-script path: config > default under the dsh home. */
export function resolveRestartScript(config = {}) {
  const configured = config.script
  if (typeof configured === 'string' && configured.length > 0) {
    return isAbsolute(configured) ? configured : join(homedir(), '.dsh', configured)
  }
  return join(homedir(), '.dsh', 'scripts', 'restart-dsh.ps1')
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

let restarting = false

/** Cordis plugin entry: register the `/app` RPC channel + the idle monitor. */
export function apply(ctx, config = {}) {
  const settingsEntry = pickSettings(config)

  return ctx.inject(['connection', 'agents'], (ctx) => {
    const logger = ctx.logger
    let source = () => ({ ...DEFAULTS, ...settingsEntry })
    let monitorApi = null

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

    installSettingsSection(ctx, SETTINGS_NAMESPACE, ConfigSchema, settingsEntry, {
      setSource: (current) => { source = current },
      onChange: rebuildMonitor,
    })
    rebuildMonitor()

    return ctx.connection.rpc.handle('/app', async (endpoint, payload) => {
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

      const invocation = buildRestartSpawn(scriptPath)
      try {
        const child = spawn(invocation.file, invocation.args, {
          detached: true,
          stdio: 'ignore',
          cwd: process.cwd(),
          env: process.env,
          windowsHide: true,
        })
        child.unref()
        child.on('error', () => {}) // spawn failure is observed by the script's absence; nothing to surface here
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
