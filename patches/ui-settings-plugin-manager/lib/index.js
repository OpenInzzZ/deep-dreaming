/**
 * Host half of the plugin-manager patch: a toggle RPC channel.
 *
 * The browser tab is read-only inventory; this host half adds the enable /
 * disable action. `setEnabled` edits the profile's `cordis.patch.yml`
 * (adding or removing a top-level `- id: <entryId>` + `disabled: true` block)
 * and writes it back — dsh's `watchUserPatches` hot-reload then unloads or
 * remounts that entry within seconds, no restart needed, and the choice
 * survives restarts because it lives in the patch file.
 *
 * Deliberately tiny: no import of the host node_modules beyond node builtins
 * and the injected `connection` service, mirroring the other @local patches.
 */
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'

export const name = 'ui-settings-plugin-manager'

/** Resolve the profile patch layer to toggle entries on. */
export function resolvePatchFile(config = {}) {
  const configured = config.patchFile
  if (typeof configured === 'string' && configured.length > 0) {
    return isAbsolute(configured) ? configured : join(homedir(), '.dsh', configured)
  }
  return join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml')
}

/**
 * Entry ids in the patch layer are plain identifiers, plus the Loader
 * builtins (`cordis:include`, `cordis:group`) and package-shaped ids that
 * appear in the inventory. The id is interpolated into a YAML line
 * (`- id: <id>`), so whitespace, quotes, `#`, `..` and other
 * YAML-significant / path-ish sequences are rejected to keep the write
 * inject-safe.
 */
const ID_RE = /^(?!.*\.\.)[A-Za-z0-9@/:_\-.]+$/
const ID_HINT = 'letters, digits, @ / : . _ - (no whitespace, quotes, # or ..)'

/**
 * Remove one top-level `- id: <id>` + `  disabled: true` block.
 * @returns the new content and how many blocks were removed.
 */
export function removeDisabledBlock(content, id) {
  const lines = content.split(/\r?\n/)
  const out = []
  let removed = 0
  for (let i = 0; i < lines.length; i++) {
    const match = /^- id:\s*(.+)$/.exec(lines[i])
    if (match !== null && match[1].trim() === id) {
      const next = lines[i + 1]
      if (next !== undefined && /^  disabled:\s*true\s*$/.test(next)) {
        removed += 1
        i += 1 // drop the `  disabled: true` line too
        continue
      }
    }
    out.push(lines[i])
  }
  return { content: out.join('\n'), removed }
}

/** Append one top-level `- id: <id>` + `  disabled: true` block. */
export function appendDisabledBlock(content, id) {
  const block = `- id: ${id}\n  disabled: true`
  const trimmed = content.replace(/\s+$/, '')
  return trimmed.length === 0 ? block + '\n' : trimmed + '\n' + block + '\n'
}

/**
 * Enable or disable one patch entry by rewriting the profile patch layer.
 * Disabling appends a `disabled: true` patch row (id-targeted override, the
 * documented way to disable a row); enabling removes that row again.
 * @returns {{ enabled: boolean, changed: boolean }} — changed=false when the
 *          file already had the requested state.
 */
export async function setEnabled(patchFile, id, enabled) {
  if (!ID_RE.test(id)) throw new Error(`invalid entry id: ${JSON.stringify(id)}`)
  const content = await readFile(patchFile, 'utf8')
  const { content: withoutBlock, removed } = removeDisabledBlock(content, id)
  if (enabled) {
    // Enable: drop the disabled block; no-op when there was none.
    if (removed === 0) return { enabled: true, changed: false }
    await writeFile(patchFile, withoutBlock, 'utf8')
    return { enabled: true, changed: true }
  }
  // Disable: append the block; no-op when it is already present.
  if (removed > 0) return { enabled: false, changed: false }
  const after = appendDisabledBlock(content, id)
  await writeFile(patchFile, after, 'utf8')
  return { enabled: false, changed: true }
}

/** RPC failure envelope. */
function toggleError(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/** Cordis plugin entry: register the `/plugin-toggle` RPC channel. */
export function apply(ctx, config = {}) {
  // Statement call on purpose: returning the ctx.inject() thenable Fiber from
  // apply makes Cordis throw TypeError('Invalid effect') (see repo memory).
  ctx.inject(['connection'], (ctx) => {
    const patchFile = resolvePatchFile(config)
    return ctx.connection.rpc.handle('/plugin-toggle', async (endpoint, payload) => {
      if (endpoint !== 'setEnabled') {
        return toggleError('bad-request', `unknown endpoint: ${endpoint}`)
      }
      const args = payload?.args
      const id = args?.entryId
      const enabled = args?.enabled
      if (typeof id !== 'string' || typeof enabled !== 'boolean') {
        return toggleError('bad-request', 'setEnabled requires entryId (string) and enabled (boolean)')
      }
      if (!ID_RE.test(id)) {
        return toggleError('bad-request', `entryId must be a plain identifier (${ID_HINT})`)
      }
      try {
        const result = await setEnabled(patchFile, id, enabled)
        return { ok: true, value: { ...result, entryId: id, patchFile } }
      } catch (error) {
        return toggleError('internal', `failed to update patch file: ${String(error?.message ?? error)}`)
      }
    }, { authority: 'loopback' })
  })
}
