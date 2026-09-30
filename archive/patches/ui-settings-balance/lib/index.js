/**
 * Host half of the ui-settings-balance patch: one read-only account-balance
 * endpoint, plus the DSH title-bar icon (favicon) override.
 *
 * Balance comes from the HOST's own `deepseekAccount` service, never from a
 * direct Platform call: that service owns the stored grant, derives the Platform
 * request headers from the caller's `AccountClientMetadata`, refreshes and
 * clears the credential on 401/40003, and separates "signed out" (null) from
 * "query failed". Re-implementing that chain in a user patch would duplicate the
 * credential handling and get it subtly wrong.
 *
 * The service is read with `ctx.get('deepseekAccount')` rather than declared in
 * `inject`, deliberately: on this dsh version the desktop profile DOES mount the
 * account platform (`deepseekAccount` is bound), while the Remote controller is
 * a separate, optional row (`dsh-api-account-controller` is `absent` in the
 * default desktop profile). Declaring it would make this whole section — and its
 * favicon route — fail to activate on a profile without an account. The trade-off
 * is explicit: a missing service is reported in the panel instead of failing the
 * plugin.
 *
 * The page reaches this half over a self-registered fenced prefix route `/app`
 * on the `webServer` service (the shared `/api` channel is exclusively owned by
 * the Typert gateway, and `ctx.connection.rpc.handle` is broken in this dsh
 * version — see `createRpcRoute`).
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Settings namespace and the route prefix (`/app/<endpoint>`). */
export const PLUGIN_NAMESPACE = 'ui-settings-balance'

/** The settings-section id shown in the settings list. */
export const SECTION_ID = 'balance'

/**
 * Resolve the running dsh package version from the entry script (walks up to
 * `package.json`). The account service takes this as part of the caller's
 * identity, so it must be the real running version, not a hardcoded one.
 * @param scriptPath - entry script; defaults to `process.argv[1]`.
 * @returns the version string, or null when it cannot be resolved.
 */
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

/**
 * Assemble the identity `deepseekAccount.getBalance()` requires.
 *
 * This is not decoration: DSH derives the outgoing Platform request headers
 * (wire locale, timezone) from it, so an absent or wrong value changes the
 * server's answer. Shaped exactly as `AccountClientMetadata`.
 *
 * @param locale - active UI language; empty lets Platform pick its default.
 * @param version - running dsh version; falls back to a neutral value.
 * @returns `{ version, locale, timezoneOffsetSeconds }`
 */
export function accountClientMetadata(locale = '', version = dshVersion() ?? '0.0.0') {
  return {
    version,
    locale: typeof locale === 'string' ? locale : '',
    // Same convention as the browser: positive east of Greenwich.
    // getTimezoneOffset() has the opposite sign, hence the negation.
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/**
 * Read the account balance. Never throws: every failure becomes a status the
 * panel can render, because a settings page that cannot load its own data must
 * still say why.
 *
 * Wire shape of the returned value:
 * - `ready`       → `wallets` / `bonusWallets` carry `{ currency, balance }` decimals
 * - `signed-out`  → no stored account grant
 * - `failed`      → the Platform query failed (`reason` explains it)
 * - `unavailable` → the host has no `deepseekAccount` service at all
 *
 * @param account - `ctx.get('deepseekAccount')`; undefined when unmounted.
 * @param locale - active UI language.
 * @returns a `status`-tagged value.
 */
export async function balanceInfo(account, locale = '') {
  if (account === undefined || account === null || typeof account.getBalance !== 'function') {
    return { status: 'unavailable', reason: 'deepseekAccount 服务未挂载（请在设置中启用账户）' }
  }
  try {
    const outcome = await account.getBalance(accountClientMetadata(locale))
    // null = signed out, or the grant changed mid-query. Not an error.
    if (outcome === null || outcome === undefined) return { status: 'signed-out' }
    if (outcome.status !== 'ready') return { status: 'failed', reason: '查询失败（凭据可能已过期）' }
    return {
      status: 'ready',
      wallets: Array.isArray(outcome.value) ? outcome.value : [],
      bonusWallets: Array.isArray(outcome.bonusWallets) ? outcome.bonusWallets : [],
    }
  } catch (error) {
    return { status: 'failed', reason: String(error?.message ?? error) }
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

/** Absolute path of one bundled brand asset inside this patch. */
export function patchAssetPath(name) {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', name)
}

/**
 * Build the fenced prefix route that carries this patch's client↔host channel.
 *
 * The fence replaces the Connection's own Host/Origin check, which no longer
 * applies to a plugin-registered route: a request carrying `Origin` must match
 * its `Host`, only `POST` is accepted, and the body must be JSON. A cross-site
 * POST always carries its own `Origin` and a JSON body forces a preflight this
 * route never answers, so nothing cross-origin reaches the handler.
 *
 * @param path - prefix route path, e.g. `/app`.
 * @param handle - `async (endpoint, payload) => envelope`.
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
          return fail(res, 400, 'bad-request', 'body is not valid JSON')
        }
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
          return fail(res, 400, 'bad-request', 'body must be a JSON object')
        }
        Promise.resolve()
          .then(() => handle(endpoint, payload))
          .then((envelope) => {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify(envelope))
          })
          .catch((error) => {
            res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({
              ok: false,
              error: { code: 'internal', message: String(error?.message ?? error), details: {} },
            }))
          })
      })
    },
  }
}

// `webServer` is a STATIC dependency: a user-layer hot reload does not
// re-activate a dynamic child fiber, and Cordis mounts rows in parallel so
// reading the carrier with `ctx.get` during activation races its binding and
// silently skips the whole transport. See AGENTS.md.
export const inject = ['webServer']

export function apply(ctx) {
  const logger = ctx.logger
  /** Observable state of this host half, reported on /ui-settings-balance/health. */
  const diagnostics = { channel: false, branding: false, warnings: [] }

  // Diagnostics and the favicon are registered FIRST and each in its own
  // try/catch: a throw later in this function disposes every effect registered
  // before it on this fiber, which is how one broken call once removed a
  // favicon route, a diagnostics route and the transport together.
  const webServer = ctx.get('webServer')
  try {
    if (webServer !== undefined) {
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/ui-settings-balance/health',
        handler: (req, res) => {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, namespace: PLUGIN_NAMESPACE, ...diagnostics }))
        },
      }), 'ui-settings-balance: health route')
    }
  } catch (error) {
    logger.warn(`[ui-settings-balance] health route unavailable: ${String(error?.message ?? error)}`)
  }

  // Branding is optional setup; the /app route below carries the actual data.
  try {
    if (webServer !== undefined) {
      const pngPath = patchAssetPath('favicon-128.png')
      if (existsSync(pngPath)) {
        const svg = faviconSvg(pngPath)
        ctx.effect(() => webServer.register({
          kind: 'exact',
          path: '/favicon.svg',
          handler: (req, res) => {
            res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' })
            res.end(svg)
          },
        }), 'ui-settings-balance: favicon route')
        diagnostics.branding = true
      } else {
        const message = `favicon asset missing: ${pngPath}`
        diagnostics.warnings.push(message)
        logger.warn(`[ui-settings-balance] ${message}`)
      }
    }
  } catch (error) {
    const message = `favicon override skipped: ${String(error?.message ?? error)}`
    diagnostics.warnings.push(message)
    logger.warn(`[ui-settings-balance] ${message}`)
  }

  const handleEndpoint = async (endpoint) => {
    if (endpoint !== 'balance') {
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: `unknown endpoint: ${endpoint}`,
          details: { channel: '/app', endpoint: String(endpoint) },
        },
      }
    }
    // Optional read, per request: the account row may be mounted after this
    // plugin activates, and a missing service must report itself through the
    // payload instead of failing activation.
    const localeService = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
    const active = typeof localeService?.getSnapshot === 'function'
      ? localeService.getSnapshot()?.active
      : undefined
    return { ok: true, value: await balanceInfo(ctx.get('deepseekAccount'), typeof active === 'string' ? active : '') }
  }

  if (webServer === undefined) {
    const message = 'webServer is unavailable; the page cannot reach this half'
    diagnostics.warnings.push(message)
    logger.warn(`[ui-settings-balance] ${message}`)
    return undefined
  }
  try {
    const route = createRpcRoute('/app', handleEndpoint)
    ctx.effect(() => webServer.register(route), 'ui-settings-balance: /app rpc route')
    diagnostics.channel = true
  } catch (error) {
    const message = `the /app route could not be registered: ${String(error?.message ?? error)}`
    diagnostics.warnings.push(message)
    logger.warn(`[ui-settings-balance] ${message}`)
  }
  return undefined
}
