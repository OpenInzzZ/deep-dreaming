/**
 * Host half of the ui-settings-other patch: a restart-service RPC endpoint.
 *
 * Exposes a dedicated Connection RPC channel `/app` (the shared `/api` channel
 * is exclusively owned by the Typert gateway, so a user-level plugin registers
 * its own channel through `ctx.connection.rpc.handle` with the loopback
 * authority — the web page only ever reaches this from 127.0.0.1).
 *
 * The `restart` endpoint delegates the whole job to the standalone script
 * `restart-dsh.ps1` (deployed to `~/.dsh/scripts/` by scripts/deploy.ps1):
 * the script finds the process listening on the web port, recovers its exact
 * command line, lets the RPC response settle, stops the old process, starts a
 * replacement with the same command line (logs redirected), and polls until
 * the service answers. Keeping the lifecycle in a script makes the restart
 * independently testable (`-DryRun`) and keeps this host entry a thin,
 * dependency-free trigger.
 *
 * The script path comes from the patch config (`script`), defaulting to
 * `~/.dsh/scripts/restart-dsh.ps1`.
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { statSync } from 'node:fs'

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

let restarting = false

/** Cordis plugin entry: register the `/app` RPC channel on the Connection. */
export function apply(ctx, config = {}) {
  return ctx.inject(['connection'], (ctx) => {
    return ctx.connection.rpc.handle('/app', async (endpoint) => {
      if (endpoint !== 'restart') {
        return {
          ok: false,
          error: { code: 'bad-request', message: `unknown endpoint: ${endpoint}`, details: {} },
        }
      }
      if (restarting) {
        return { ok: true, value: { scheduled: true, already: true, script: resolveRestartScript(config) } }
      }
      restarting = true

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
