/**
 * Host half of the whale-background patch: serves the whale-girl image
 * via a dedicated route for the client half to reference.
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the whale-girl image asset from ui-settings-other. */
function patchAssetPath(name) {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui-settings-other', 'assets', name)
}

export const inject = ['webServer']

/** Cordis plugin entry: register the image route. */
export function apply(ctx) {
  // Serve the whale-girl image via a dedicated route
  const pngPath = patchAssetPath('whale-girl-transparent.png')
  const png = readFileSync(pngPath)

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
