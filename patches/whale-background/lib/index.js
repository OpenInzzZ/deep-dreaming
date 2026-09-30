/**
 * Host half of the whale-background patch: serves the whale-girl image
 * via a dedicated route for the client half to reference.
 *
 * The asset is resolved through a candidate list instead of one assumed path:
 * this patch ships no copy of the PNG (nor should it, at ~6 MB), so a renamed
 * or missing sibling patch must degrade to "no route registered" rather than
 * to a failed apply.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Asset file name served at `/whale-background.png`. */
export const ASSET_NAME = 'whale-girl-transparent.png'

/** This patch's root directory (`.../patches/whale-background`). */
const patchRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Candidate asset locations, in resolution order:
 *   1. this patch's own `assets/` directory (a drop-in copy wins),
 *   2. `~/.dsh/assets/`, where `scripts/deploy.ps1` syncs the bundled brand assets,
 *   3. the ARCHIVED `ui-settings-other` patch, `archive/patches/ui-settings-other/assets/`
 *      - that patch owned this PNG originally and is kept read-only under `archive/`,
 *   4. the pre-archive sibling location, `ui-settings-other/assets/`, so a checkout
 *      that still has the patch in place keeps working,
 *   5. the repo-level archive copy of the web scripts, which carried the same PNG.
 */
export function assetCandidates(name = ASSET_NAME) {
  const repoRoot = join(patchRoot, '..', '..')
  return [
    join(patchRoot, 'assets', name),
    join(homedir(), '.dsh', 'assets', name),
    join(repoRoot, 'archive', 'patches', 'ui-settings-other', 'assets', name),
    join(patchRoot, '..', 'ui-settings-other', 'assets', name),
  ]
}

/** First candidate that exists, or null when none resolves (never throws). */
export function resolveAssetPath(name = ASSET_NAME, candidates = assetCandidates(name)) {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // Unreadable candidate (permissions, dangling link): try the next one.
    }
  }
  return null
}

/** Log a warning without ever throwing: no logger must not break the plugin. */
function warn(ctx, message) {
  try {
    ctx.logger.warn(message)
  } catch {
    console.warn(message)
  }
}

export const inject = ['webServer']

/** Cordis plugin entry: register the image route when the asset resolves. */
export function apply(ctx) {
  const pngPath = resolveAssetPath()
  if (pngPath === null) {
    warn(ctx, `[whale-background] ${ASSET_NAME} not found in any of: ${assetCandidates().join(', ')}; image route not registered`)
    return
  }

  let png
  try {
    png = readFileSync(pngPath)
  } catch (error) {
    warn(ctx, `[whale-background] could not read ${pngPath}: ${String(error)}; image route not registered`)
    return
  }

  // Serve the whale-girl image via a dedicated route
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/whale-background.png',
    handler: (req, res) => {
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=86400',
      })
      res.end(png)
    },
  }), 'whale-background: image route')
}
