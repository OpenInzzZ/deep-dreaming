/**
 * temp-session — host half: a user-level "temporary session" workspace.
 *
 * dsh's conversation UI only lets you start a session inside a real Workspace
 * (without one the hero input is inert). For ad-hoc, non-project chats this
 * forces picking/creating a project directory. This plugin provides a
 * dedicated user-level workspace (default `~/.dsh/tmp-workspaces/`) that any
 * session can bind to, so a temporary chat still has a real cwd (file
 * operations land in the user-level dir, never a project) while appearing in
 * the sidebar under its own "临时会话 / Temporary" group.
 *
 * Exposes the loopback RPC channel `/temp-session` with one endpoint:
 *   ensure { args: {} } -> { ok, value: { workspaceId, path, title, created } }
 * Idempotent: repeated calls return the same workspace. The client half
 * (`lib/client.js`) renders the sidebar-footer action that calls it.
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'

/**
 * Default user-level directory hosting the temporary workspace. Evaluated at
 * module load (schemastery 3.x `.default()` stores the value as-is and cannot
 * take a function), so the user cannot switch OS user mid-process anyway.
 */
const DEFAULT_TEMP_DIR = path.join(os.homedir(), '.dsh', 'tmp-workspaces')

/**
 * Entry config schema. The Cordis loader validates the raw config against it
 * through the schemastery `~standard` protocol (a plain object here makes the
 * loader crash with "Cannot read properties of undefined (reading 'validate')")
 * and fills the defaults, so `apply` receives a complete, validated config.
 */
export const Config = z.object({
  /**
   * User-level directory hosting the temporary workspace. Defaults to
   * `~/.dsh/tmp-workspaces/`; must be absolute. Created on first use.
   */
  dir: z.string().default(DEFAULT_TEMP_DIR),
  /** Display title of the temporary workspace group. */
  title: z.string().default('临时会话'),
})

/** Serialize ensure calls so concurrent clicks cannot create two workspaces. */
let ensureTail = Promise.resolve()

/**
 * Resolve the configured temp workspace (create-on-demand, idempotent).
 * @param ctx - injected context with `workspaceRegistry`.
 * @param config - plugin config ({ dir, title }).
 * @returns { workspaceId, path, title, created }
 */
export async function ensureTempWorkspace(ctx, config) {
  const dir = config.dir
  const title = config.title
  const operation = ensureTail.then(async () => {
    await fs.mkdir(dir, { recursive: true })
    const existing = await ctx.workspaceRegistry.resolveByPath(dir)
    if (existing !== undefined) {
      return { workspaceId: existing.id, path: existing.path, title: existing.title, created: false }
    }
    const created = await ctx.workspaceRegistry.create(dir, title)
    return { workspaceId: created.id, path: created.path, title: created.title, created: true }
  })
  ensureTail = operation.then(() => undefined, () => undefined)
  return operation
}

/**
 * Cordis plugin: register the `/temp-session` RPC channel (loopback) once the
 * `connection` and `workspaceRegistry` services are available. NEVER return
 * the `ctx.inject(...)` value from `apply` (Cordis treats a thenable return
 * as an invalid Effect).
 */
export function apply(ctx, config = {}) {
  ctx.inject(['connection', 'workspaceRegistry'], (inner) => {
    inner.connection.rpc.handle('/temp-session', async (endpoint, payload) => {
      if (endpoint !== 'ensure') {
        return { ok: false, error: { code: 'bad-request', message: `unknown endpoint: ${endpoint}`, details: {} } }
      }
      if (payload?.args !== undefined && typeof payload.args !== 'object') {
        return { ok: false, error: { code: 'bad-request', message: 'ensure accepts no args', details: {} } }
      }
      try {
        const value = await ensureTempWorkspace(inner, config)
        return { ok: true, value }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'temp-workspace-failed',
            message: `cannot ensure temp workspace: ${error instanceof Error ? error.message : String(error)}`,
            details: {},
          },
        }
      }
    }, { authority: 'loopback' })
  })
}
