/**
 * Host half of the plugin-manager patch: the toggle endpoint.
 *
 * The browser tab is read-only inventory; this host half adds the enable /
 * disable action. `setEnabled` edits the profile's `cordis.patch.yml`
 * (adding, or removing, the id-targeted `- id: <entryId>` + `disabled: true`
 * patch row) and writes it back — dsh's `watchUserPatches` hot-reload then
 * unloads or remounts that entry within seconds, no restart needed, and the
 * choice survives restarts because it lives in the patch file. Existing rows
 * are matched tolerantly (see below) and the result reports honestly when the
 * file's shape could not be confirmed, so a toggle never claims an effect it
 * did not have.
 *
 * The page reaches this half through one fenced prefix route on the web
 * carrier, `POST /plugin-toggle/setEnabled` (see `createRpcRoute` below) —
 * `ctx.connection.rpc.handle` cannot work in dsh 0.1.5-rc.1, where the
 * Connection registry throws for every plugin outside the connection package.
 *
 * Deliberately tiny: no import of the host node_modules beyond node builtins,
 * mirroring the other @local patches.
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

/* ---------------------------------------------------------------------------
 * Tolerant reader for id-targeted disable rows.
 *
 * The documented way to disable an entry from a patch layer is a row that
 * targets its id (`- id: <entryId>` + `disabled: true`, the shape the shipped
 * telemetry patch uses). A hand-edited layer writes that row in many legal
 * spellings and every one of them has to be recognized:
 *
 *   - extra leading indentation (a row nested inside a `- insert:` group);
 *   - a quoted id (`- id: 'x'`), trailing spaces, a trailing `# comment`;
 *   - other keys before or after `disabled`, in any order;
 *   - the value on the next, deeper line (`disabled:` with `true` below it);
 *   - a single-line flow mapping (`- { id: x, disabled: true }`).
 *
 * Shapes this reader cannot judge are *reported* (see `ambiguous`), never
 * guessed at and never rewritten. A row that merely mentions the same id — a
 * normal entry row without a truthy `disabled` sibling — is not a disable row
 * and is never touched.
 * ------------------------------------------------------------------------- */

/** A row carrying only these keys is a pure disable row: drop it whole. */
const PURE_ROW_KEYS = new Set(['id', 'disabled'])

/**
 * Plain `disabled:` values the Loader reads as "not disabled". js-yaml 4
 * parses everything else as a truthy value (`no`, `off`, `1` and `"false"`
 * are all strings or numbers), and the Loader disables a row for any truthy
 * `disabled` value.
 */
const NOT_DISABLED = new Set(['false', 'null', '~', '0'])

const ITEM_RE = /^( *)-(?:([ \t]+)(.*))?$/
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(.*)$/
const BLANK_OR_COMMENT_RE = /^[ \t]*(?:#|$)/
const ID_LINE_RE = /^(?:-[ \t]+)?id[ \t]*:(.*)$/
const DISABLED_KEY_RE = /^disabled[ \t]*:/

/** Leading-space indentation of one line. */
function indentOf(line) {
  return /^ */.exec(line)[0].length
}

/** Read one scalar: drop an unquoted trailing comment, remove one quote layer. */
function readScalar(raw) {
  const text = raw.trim()
  const quote = text[0]
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1)
    return { text: end === -1 ? text.slice(1) : text.slice(1, end), quoted: true }
  }
  const hash = text.indexOf('#')
  return { text: (hash === -1 ? text : text.slice(0, hash)).trim(), quoted: false }
}

/**
 * Judge a `disabled:` value the way the Loader does: any truthy value
 * disables the row. A value built at runtime (alias, anchor, `!!js`
 * expression, `${}` template) cannot be judged from the text and comes back
 * 'unknown' so the caller reports it instead of guessing.
 */
function classifyDisabled(raw) {
  const { text, quoted } = readScalar(raw)
  if (text.length === 0) return 'enabled'
  if (quoted) return 'disabled'
  if (/[&*!${}[\]]/.test(text)) return 'unknown'
  return NOT_DISABLED.has(text.toLowerCase()) ? 'enabled' : 'disabled'
}

/** A key's value may sit on the next, deeper line (valid YAML); resolve both. */
function resolveValue(lines, key, keyIndent) {
  if (key.raw.trim().length > 0) return key.raw
  for (let j = key.index + 1; j < lines.length; j++) {
    if (BLANK_OR_COMMENT_RE.test(lines[j])) continue
    return indentOf(lines[j]) > keyIndent ? lines[j].trim() : ''
  }
  return ''
}

/** Split a flow-mapping body on its top-level commas (quotes respected). */
function splitFlow(body) {
  const parts = []
  let current = ''
  let quote = null
  for (const char of body) {
    if (quote !== null) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ',') {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/** Keys of a flow mapping (`{ id: x, disabled: true }`), or null when it holds none. */
function parseFlowKeys(text) {
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open === -1 || close <= open) return null
  const keys = []
  for (const part of splitFlow(text.slice(open + 1, close))) {
    const key = KEY_RE.exec(part.trim())
    if (key !== null) keys.push({ name: key[1], raw: key[2] })
  }
  return keys
}

/** A flow mapping may span lines; join from its opening brace to its closing one. */
function joinFlow(lines, start) {
  let text = lines[start].trim()
  if (!text.includes('{') || text.includes('}')) return text
  for (let j = start + 1; j < lines.length; j++) {
    text += ' ' + lines[j].trim()
    if (lines[j].includes('}')) break
  }
  return text
}

/**
 * Find every row in a patch layer that targets `id`, plus every shape that
 * mentions the id but cannot be judged.
 * @returns {{
 *   rows: Array<{ start: number, end: number, pure: boolean, disabled: Array<{ index: number, kind: string }> }>,
 *   ambiguous: Array<{ line: number, reason: string }>,
 *   found: boolean,
 * }} — `start`/`end` delimit the row (exclusive end), `pure` marks a row made
 * of nothing but `id`/`disabled`, `kind` is the judged `disabled` value,
 * `found` says whether the file mentions the id as a row.
 */
export function analyzeDisabledRows(content, id) {
  const lines = content.split(/\r?\n/)
  const rows = []
  const ambiguous = []
  const claimed = new Set()
  let found = false

  for (let i = 0; i < lines.length; i++) {
    if (BLANK_OR_COMMENT_RE.test(lines[i])) continue
    const item = ITEM_RE.exec(lines[i])
    if (item === null) continue
    const dashIndent = item[1].length
    const rest = (item[3] ?? '').trim()
    const keys = []
    let keyIndent = -1
    if (rest.length > 0 && !rest.startsWith('#')) {
      // The row's first key sits on the dash line; later keys line up with it.
      keyIndent = dashIndent + 1 + (item[2] ?? '').length
      if (rest.startsWith('{')) {
        // `- { id: x, disabled: true }` carries all its keys on one line.
        for (const key of parseFlowKeys(rest) ?? []) keys.push({ index: i, name: key.name, raw: key.raw })
      } else {
        const key = KEY_RE.exec(rest)
        if (key !== null) keys.push({ index: i, name: key[1], raw: key[2] })
      }
    }
    let end = i + 1
    const deeperDisabled = []
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (BLANK_OR_COMMENT_RE.test(line)) continue
      const indent = indentOf(line)
      if (indent <= dashIndent) break
      end = j + 1
      if (keyIndent === -1) keyIndent = indent
      if (indent !== keyIndent) {
        if (DISABLED_KEY_RE.test(line.slice(indent))) deeperDisabled.push(j)
        continue
      }
      const key = KEY_RE.exec(line.slice(indent))
      if (key !== null) keys.push({ index: j, name: key[1], raw: key[2] })
    }
    if (keys.length === 0) continue
    for (let j = i; j < end; j++) claimed.add(j)
    const idKey = keys.find(key => key.name === 'id')
    if (idKey === undefined) continue
    if (readScalar(resolveValue(lines, idKey, keyIndent)).text !== id) continue
    found = true
    const disabled = []
    for (const key of keys) {
      if (key.name !== 'disabled') continue
      const kind = classifyDisabled(resolveValue(lines, key, keyIndent))
      if (kind === 'unknown') {
        ambiguous.push({ line: key.index + 1, reason: `line ${key.index + 1}: cannot judge this "disabled" value` })
      }
      disabled.push({ index: key.index, kind })
    }
    // A `disabled:` key indented deeper than the row's keys is the nested value
    // of another key (a plugin config) — unless no key of this row opened a
    // block value, in which case the row is mis-indented (YAML rejects it) and
    // must be reported rather than silently ignored.
    if (!keys.some(key => key.raw.trim().length === 0)) {
      for (const j of deeperDisabled) {
        ambiguous.push({ line: j + 1, reason: `line ${j + 1}: "disabled" is indented deeper than "id"` })
      }
    }
    if (disabled.length > 0) {
      rows.push({
        start: i,
        end,
        // A pure row is a disable override wherever it sits: at the top level
        // it is the documented patch row, while inside an `insert:` group it is
        // a nameless entry row (it cannot mount, and next to the real entry row
        // it makes the Loader reject the duplicated id).
        pure: keys.every(key => PURE_ROW_KEYS.has(key.name)),
        disabled,
      })
    }
  }

  // Any other line that mentions the id is a shape this reader cannot act on
  // (a multi-line flow mapping, for instance): report it, never rewrite it.
  for (let i = 0; i < lines.length; i++) {
    if (claimed.has(i) || BLANK_OR_COMMENT_RE.test(lines[i])) continue
    const text = lines[i].trim()
    const own = ID_LINE_RE.exec(text)
    let raw
    if (own !== null) {
      raw = resolveValue(lines, { index: i, raw: own[1] }, indentOf(lines[i]))
    } else {
      const idKey = parseFlowKeys(joinFlow(lines, i))?.find(key => key.name === 'id')
      if (idKey === undefined) continue
      raw = idKey.raw
    }
    const cleaned = raw.trim().replace(/^[{,]/, '').replace(/[},]$/, '')
    if (readScalar(cleaned).text !== id) continue
    ambiguous.push({ line: i + 1, reason: `line ${i + 1}: unrecognized row shape for id ${JSON.stringify(id)}` })
  }

  return { rows, ambiguous, found }
}

/**
 * Remove every recognizable disable row for `id`. A pure row (`- id: <id>`
 * plus `disabled: ...` and nothing else) is dropped whole; a row that carries
 * other keys loses only its `disabled` key lines, so an entry row that merely
 * mentions the id — or a group child disabled inline — survives.
 * @returns {{ content: string, removed: number, ambiguous: Array<{ line: number, reason: string }>, found: boolean }}
 *          — `removed` counts disable rows; the input is returned untouched
 *          when there was nothing to remove.
 */
export function removeDisabledBlock(content, id) {
  const { rows, ambiguous, found } = analyzeDisabledRows(content, id)
  const drop = new Set()
  let removed = 0
  for (const row of rows) {
    const actionable = row.disabled.filter(key => key.kind === 'disabled')
    if (actionable.length === 0) continue
    removed += 1
    if (row.pure) for (let j = row.start; j < row.end; j++) drop.add(j)
    else for (const key of actionable) drop.add(key.index)
  }
  if (removed === 0) return { content, removed, ambiguous, found }
  const lines = content.split(/\r?\n/)
  return {
    content: lines.filter((_line, index) => !drop.has(index)).join('\n'),
    removed,
    ambiguous,
    found,
  }
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
 * documented way to disable a row) and is idempotent: any recognizable
 * disable row for the id — whatever its spelling — suppresses the append.
 * Enabling removes every recognizable disable row for the id.
 * @returns {{ enabled: boolean, changed: boolean, removed: number,
 *            recognized: boolean, warnings: string[] }} — `changed` says
 *          whether the file was rewritten, `removed` how many disable rows
 *          were dropped, `recognized` whether the requested state could be
 *          positively confirmed in this file (false means the caller must not
 *          report success), `warnings` names every shape left unjudged.
 */
export async function setEnabled(patchFile, id, enabled) {
  if (!ID_RE.test(id)) throw new Error(`invalid entry id: ${JSON.stringify(id)}`)
  const content = await readFile(patchFile, 'utf8')
  const { content: withoutRows, removed, ambiguous, found } = removeDisabledBlock(content, id)
  const warnings = ambiguous.map(entry => entry.reason)
  if (enabled) {
    if (removed === 0) {
      // Nothing in this file disables the id. That is a genuine no-op when the
      // file still has a row for it; when it does not, the disable comes from
      // another layer and this call cannot confirm anything.
      const notes = found ? warnings : [...warnings, `no row for id ${JSON.stringify(id)} in this patch file`]
      return { enabled: true, changed: false, removed: 0, recognized: notes.length === 0, warnings: notes }
    }
    await writeFile(patchFile, withoutRows, 'utf8')
    return { enabled: true, changed: true, removed, recognized: warnings.length === 0, warnings }
  }
  if (removed > 0) {
    // Already disabled by a recognizable row: a second row for the same id
    // would just duplicate the override.
    return { enabled: false, changed: false, removed: 0, recognized: warnings.length === 0, warnings }
  }
  if (warnings.length > 0) {
    // A disable-ish row is there but cannot be judged: do not append a second
    // override blindly, report the lines the user has to look at instead.
    return { enabled: false, changed: false, removed: 0, recognized: false, warnings }
  }
  await writeFile(patchFile, appendDisabledBlock(content, id), 'utf8')
  return { enabled: false, changed: true, removed: 0, recognized: true, warnings: [] }
}

/** RPC failure envelope. */
function toggleError(code, message) {
  return { ok: false, error: { code, message, details: {} } }
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
 * @param path - prefix route path, e.g. `/plugin-toggle`.
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

/**
 * Endpoint handler: the unchanged `/plugin-toggle` contract, one endpoint.
 * Kept separate from the transport so it stays directly testable.
 */
async function handleEndpoint(endpoint, payload, patchFile) {
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
}

/** Cordis plugin entry: register the `/plugin-toggle` prefix route. */
export function apply(ctx, config = {}) {
  const patchFile = resolvePatchFile(config)

  // The page reaches this half over one prefix route on the web carrier.
  // `ctx.connection.rpc.handle` is not an option in dsh 0.1.5-rc.1: its
  // registry reads `owner.webServer` on a context that never declared it and
  // throws `cannot get property "webServer" without inject`, so no channel
  // would exist and the page's RPC calls would land on the SPA fallback.
  // See createRpcRoute() for the fence that replaces the Connection's own.
  //
  // `webServer` is a DECLARED dependency, not an optional read: Cordis mounts
  // rows in parallel and the HTTP carrier is bound later than the other host
  // services, so reading it with `ctx.get('webServer')` while `apply` runs
  // races that binding, sees `undefined`, and silently skips the page's whole
  // transport. That race is exactly how four of five migrated patches came up
  // dead after the first restart. Waiting on the carrier here makes the
  // registration unconditional; the endpoint handler still closes over
  // `patchFile` from this scope.
  ctx.inject(['webServer'], (wctx) => {
    try {
      const route = createRpcRoute('/plugin-toggle', (endpoint, payload) => handleEndpoint(endpoint, payload, patchFile))
      wctx.effect(() => wctx.webServer.register(route), 'ui-settings-plugin-manager: /plugin-toggle route')
    } catch (error) {
      wctx.logger?.warn(`[ui-settings-plugin-manager] the /plugin-toggle route could not be registered: ${String(error?.message ?? error)}`)
    }
    return undefined
  })
  return undefined
}
