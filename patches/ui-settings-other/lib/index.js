/**
 * Host half of the ui-settings-other patch: a restart-service RPC endpoint.
 *
 * Exposes a dedicated Connection RPC channel `/app` (the shared `/api` channel
 * is exclusively owned by the Typert gateway, so a user-level plugin registers
 * its own channel through `ctx.connection.rpc.handle` with the loopback
 * authority — the web page only ever reaches this from 127.0.0.1).
 *
 * The `restart` endpoint respawns this exact dsh process (same node binary,
 * same argv, inherited cwd/env) as a detached background child, then exits the
 * current process after a short grace so the RPC response reaches the browser
 * first and the listening port is free before the child finishes booting.
 *
 * Deliberately dependency-free on the host side: only `node:child_process`
 * plus globals, so the file:// or @local loader entry needs nothing else to
 * resolve.
 */

import { spawn } from 'node:child_process'

/** Grace before the current process exits, after the child was spawned (ms). */
const EXIT_GRACE_MS = 2000
/** Delay before the child is spawned, letting the RPC response land first (ms). */
const SPAWN_DELAY_MS = 600

let restarting = false

/**
 * Spawn a detached copy of this process (same binary, argv, cwd, env) that
 * survives the current process exiting.
 */
function spawnReplacement() {
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
  })
  child.unref()
  return child.pid ?? null
}

/** Handle one endpoint on the `/app` channel. */
async function handleEndpoint(endpoint) {
  if (endpoint !== 'restart') {
    return {
      ok: false,
      error: { code: 'bad-request', message: `unknown endpoint: ${endpoint}`, details: {} },
    }
  }
  if (restarting) {
    return { ok: true, value: { scheduled: true, already: true, delayMs: 0 } }
  }
  restarting = true
  let pid = null
  try {
    setTimeout(() => {
      try {
        pid = spawnReplacement()
      } catch (error) {
        // The process still exits below; the child failed to start, so the
        // operator restarts from the terminal instead.
        console.error('[ui-settings-other] respawn failed:', error)
      }
    }, SPAWN_DELAY_MS)
  } catch (error) {
    restarting = false
    return {
      ok: false,
      error: { code: 'internal', message: String(error), details: {} },
    }
  }
  setTimeout(() => process.exit(0), SPAWN_DELAY_MS + EXIT_GRACE_MS)
  return { ok: true, value: { scheduled: true, pid, delayMs: SPAWN_DELAY_MS + EXIT_GRACE_MS } }
}

/** Cordis plugin entry: register the `/app` RPC channel on the Connection. */
export function apply(ctx) {
  return ctx.inject(['connection'], (ctx) => {
    return ctx.connection.rpc.handle('/app', handleEndpoint, { authority: 'loopback' })
  })
}

export { handleEndpoint }
