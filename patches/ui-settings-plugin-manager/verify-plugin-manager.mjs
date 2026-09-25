/**
 * Functional harness for the user-level plugin-manager bundle.
 *
 * Host half: imports the real `lib/index.js`, exercises the patch-file
 * editing helpers (remove/append disabled blocks) against a TEMP patch file —
 * including the tolerant recognition of hand-written disable rows (quoted id,
 * indentation, extra keys, value on the next line, flow mapping), idempotent
 * disable, multi-row cleanup and the honest `recognized:false` report — then
 * applies the plugin to a mock Cordis context and asserts the transport carrier
 * is declared as a STATIC module-level dependency (`export const
 * inject = ['webServer']`, with no `ctx.get('webServer')` optional read and no
 * dynamic `ctx.inject` gate left anywhere in the source), the `/plugin-toggle`
 * prefix route on the `webServer` service — handed to `apply` as a plain
 * `ctx.webServer` property, exactly as a real activation sees it — its
 * registration through exactly one `ctx.effect`, the exact fence (403 foreign
 * Origin / 405 non-POST / 415 non-JSON / 404 empty-or-multi-segment endpoint /
 * 400 non-JSON body / 413 over 1 MB / 500 throwing handler), the endpoint
 * validation, the disposer that releases the route when the fiber unloads, an
 * independent remount (user-layer hot reload), and the failure behaviour when
 * the carrier is somehow absent or `register` throws (loudly, or reported as a
 * warning — never a silent skip that leaves the page without its transport) —
 * including the P0 guard: `apply` must NOT return a thenable.
 *
 * "A carrier that arrives LATE still activates the transport" and
 * `TypeError('Invalid effect')` on a returned fiber are real-Cordis semantics
 * owned by the authoritative tests/load-smoke.mjs; this harness mirrors them
 * with mocks.
 *
 * Client half: loads the exact deployed `lib/client.js` the browser will
 * execute, feeds it a module table stubbed with the real platform words
 * (react, react/jsx-runtime, ui-primitives), asserts the registration
 * contract, drives `toggleEnabled` through a `fetch` double (URL / method /
 * content-type / exact JSON body, plus the envelope, HTTP and network failure
 * branches), then — when jsdom is available — renders the tab and exercises
 * the filters and the enable/disable toggle end to end.
 *
 * Dependency resolution goes through `scripts/test-deps.mjs` (the repository's
 * own node_modules, then `$NODE_PATH`, the deployed profile trees and
 * `$DSH_TEST_DEPS`), so no machine-specific path appears in this harness. jsdom
 * is the only DOM dependency; when it cannot be resolved the render section is
 * skipped with a notice and the bundle + contract checks still run — a fallback
 * only, because the repo's devDependencies provide react + react-dom + jsdom
 * and the DOM sections are meant to really run.
 *
 * Run: node patches/ui-settings-plugin-manager/verify-plugin-manager.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { createUiRequire, loadDomDeps } from '../../scripts/test-deps.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// Browser packages (react / jsdom / react-dom) come from the shared resolver,
// every anchor derived from this module or the environment — never a hardcoded
// checkout path.
const uiRequire = createUiRequire(import.meta.url)
const domDeps = loadDomDeps(import.meta.url)
const React = domDeps.React
const JSDOM = domDeps.JSDOM
if (!domDeps.available) console.warn(`SKIP DOM checks: ${domDeps.hint}`)

const hostPath = join(here, 'lib', 'index.js')
const bundlePath = join(here, 'lib', 'client.js')
const PLUGIN_ID = '@local/dsh-client-ui-settings-plugin-manager'

// --- host half: patch-file editing + /plugin-toggle RPC ------------------------
const host = await import(pathToFileURL(hostPath).href)

// Pure helpers: disabled-block append/remove semantics
{
  const base = '# header\n- insert:\n    - id: a\n      name: pkg-a\n'
  const removed = host.removeDisabledBlock(base + '- id: a\n  disabled: true\n- id: b\n  disabled: true\n', 'a')
  if (removed.removed !== 1) throw new Error(`removeDisabledBlock removed ${removed.removed}`)
  if (removed.content.includes('- id: a\n  disabled: true')) throw new Error('disabled block for a must be removed')
  if (!removed.content.includes('- id: b\n  disabled: true')) throw new Error('disabled block for b must stay')
  const untouched = host.removeDisabledBlock(base, 'a')
  if (untouched.removed !== 0 || untouched.content !== base) throw new Error('remove with no match must be a no-op')
  const appended = host.appendDisabledBlock(base, 'a')
  if (!appended.endsWith('- id: a\n  disabled: true\n')) throw new Error(`append shape: ${appended}`)
  console.log('host helpers OK: removeDisabledBlock + appendDisabledBlock')
}

// setEnabled against a TEMP patch file (never the real profile layer)
const tmpDir = mkdtempSync(join(tmpdir(), 'plugin-manager-verify-'))
const tmpPatch = join(tmpDir, 'cordis.patch.yml')
const PATCH_HEADER = '# test layer\n- insert:\n    - id: a\n      name: pkg-a\n    - id: b\n      name: pkg-b\n'
writeFileSync(tmpPatch, PATCH_HEADER)

{
  const off = await host.setEnabled(tmpPatch, 'a', false)
  if (off.enabled !== false || off.changed !== true) throw new Error(`setEnabled(false) first: ${JSON.stringify(off)}`)
  if (!readFileSync(tmpPatch, 'utf8').includes('- id: a\n  disabled: true')) throw new Error('disable must append the disabled block')
  const offAgain = await host.setEnabled(tmpPatch, 'a', false)
  if (offAgain.changed !== false) throw new Error(`setEnabled(false) twice must be idempotent: ${JSON.stringify(offAgain)}`)
  const on = await host.setEnabled(tmpPatch, 'a', true)
  if (on.enabled !== true || on.changed !== true) throw new Error(`setEnabled(true): ${JSON.stringify(on)}`)
  const content = readFileSync(tmpPatch, 'utf8')
  if (content.includes('disabled: true')) throw new Error(`enable must remove the disabled block:\n${content}`)
  const onAgain = await host.setEnabled(tmpPatch, 'a', true)
  if (onAgain.changed !== false) throw new Error('setEnabled(true) twice must be idempotent')
  let invalidRejected = false
  try { await host.setEnabled(tmpPatch, 'a/../evil', false) } catch { invalidRejected = true }
  if (!invalidRejected) throw new Error('setEnabled must reject path-ish entry ids (..)')
  for (const bad of ['a b', 'a#b', 'a"b', 'a\\b', '']) {
    let rejected = false
    try { await host.setEnabled(tmpPatch, bad, false) } catch { rejected = true }
    if (!rejected) throw new Error(`setEnabled must reject ${JSON.stringify(bad)}`)
  }
  // Loader-builtin ids (cordis: prefix) are valid — this was the reported
  // regression: the original identifier charset rejected them.
  const builtinOff = await host.setEnabled(tmpPatch, 'cordis:include', false)
  if (builtinOff.enabled !== false || builtinOff.changed !== true) throw new Error(`cordis: prefix disable: ${JSON.stringify(builtinOff)}`)
  const builtinOn = await host.setEnabled(tmpPatch, 'cordis:include', true)
  if (builtinOn.changed !== true) throw new Error(`cordis: prefix enable: ${JSON.stringify(builtinOn)}`)
  console.log('host setEnabled OK: disable appends / enable removes / idempotent / rejects bad ids / accepts cordis: builtins')
}

// Regression: tolerant disable-row recognition + honest reporting.
// Hand-written layers spell the disable row in many legal ways; the old
// "column 0, exactly two spaces of indent" reader missed them and then
// answered changed=false / "已生效" although the row was still there.
{
  const HEAD = '# test layer\n- insert:\n    - id: a\n      name: pkg-a\n    - id: b\n      name: pkg-b\n'
  const write = (name, content) => {
    const file = join(tmpDir, name)
    writeFileSync(file, content)
    return file
  }
  const ENABLE_CASES = {
    // [disable row as a hand-written layer spells it, content left behind]
    'quoted id (single)': ["- id: 'a'\n  disabled: true\n", ''],
    'quoted id (double, comment)': ['- id: "a"  # hand written\n  disabled: true\n', ''],
    'indented row': ['  - id: a\n    disabled: true\n', ''],
    'insert-group child row': ['    - id: a\n      disabled: true\n', ''],
    'keys around disabled': ['- id: a\n  note: hand written\n  disabled: true\n', '- id: a\n  note: hand written\n'],
    'value on the next line': ['- id: a\n  disabled:\n    true\n', ''],
    'spaced key': ['- id: a\n  disabled  :   true\n', ''],
    'flow mapping': ['- { id: a, disabled: true }\n', ''],
  }
  for (const [label, [row, tail]] of Object.entries(ENABLE_CASES)) {
    const file = write('shape.yml', HEAD + row)
    const on = await host.setEnabled(file, 'a', true)
    const after = readFileSync(file, 'utf8')
    if (on.changed !== true || on.removed !== 1 || on.recognized !== true) {
      throw new Error(`${label}: enable must clear exactly one row and confirm it: ${JSON.stringify(on)}`)
    }
    if (after !== HEAD + tail) {
      throw new Error(`${label}: expected the layer to come back as ${JSON.stringify(HEAD + tail)}, got ${JSON.stringify(after)}`)
    }
  }

  // A normal entry row for the same id is not a disable row: it survives an
  // enable byte-for-byte, and an explicit `disabled: false` is left in place.
  const keepFile = write('keep.yml', HEAD)
  const keep = await host.setEnabled(keepFile, 'a', true)
  if (keep.changed !== false || keep.removed !== 0 || keep.recognized !== true) {
    throw new Error(`entry row must be left alone and confirmed: ${JSON.stringify(keep)}`)
  }
  if (readFileSync(keepFile, 'utf8') !== HEAD) throw new Error('enable rewrote a file it had nothing to change')
  const falseFile = write('false.yml', HEAD + '- id: a\n  disabled: false\n')
  const explicit = await host.setEnabled(falseFile, 'a', true)
  if (explicit.changed !== false || explicit.recognized !== true) {
    throw new Error(`disabled: false is an explicit enable, not a disable row: ${JSON.stringify(explicit)}`)
  }
  if (!readFileSync(falseFile, 'utf8').includes('disabled: false')) throw new Error('disabled: false must be kept')

  // Idempotent disable: any recognizable spelling suppresses the append, so
  // repeated disable can never stack a second row for the same id.
  const offFile = write('off.yml', HEAD + "- id: 'a'\n  disabled: true\n")
  const offFirst = await host.setEnabled(offFile, 'a', false)
  const offSecond = await host.setEnabled(offFile, 'a', false)
  const offContent = readFileSync(offFile, 'utf8')
  if (offFirst.changed !== false || offSecond.changed !== false) {
    throw new Error(`disable must be idempotent on a quoted row: ${JSON.stringify([offFirst, offSecond])}`)
  }
  if ((offContent.match(/^- id:/gm) ?? []).length !== 1) {
    throw new Error(`disable stacked a duplicate row:\n${offContent}`)
  }

  // Enable clears every duplicate disable row and reports how many it cleared.
  const dupFile = write('dup.yml', HEAD + "- id: a\n  disabled: true\n- id: 'a'\n  disabled: yes\n- id: \"a\"\n  disabled: true\n")
  const cleared = await host.setEnabled(dupFile, 'a', true)
  if (cleared.changed !== true || cleared.removed !== 3 || cleared.recognized !== true) {
    throw new Error(`enable must clear all duplicate rows and count them: ${JSON.stringify(cleared)}`)
  }
  const dupAfter = readFileSync(dupFile, 'utf8')
  if (dupAfter.includes('disabled') || !dupAfter.includes('name: pkg-a') || !dupAfter.includes('name: pkg-b')) {
    throw new Error(`duplicate cleanup damaged the layer:\n${dupAfter}`)
  }

  // Shapes this reader cannot judge are reported instead of guessed at: no
  // write, no "applied", and the offending line comes back as a warning.
  const exoticFile = write('exotic.yml', HEAD + '- id: a\n  disabled: *pm-off\n')
  const exoticBefore = readFileSync(exoticFile, 'utf8')
  const exotic = await host.setEnabled(exoticFile, 'a', true)
  if (exotic.changed !== false || exotic.recognized !== false || exotic.warnings.length === 0) {
    throw new Error(`unjudgeable shape must be reported: ${JSON.stringify(exotic)}`)
  }
  const exoticLine = HEAD.split('\n').length + 1
  if (!exotic.warnings[0].includes('line ' + exoticLine)) {
    throw new Error(`warning must name line ${exoticLine}: ${JSON.stringify(exotic.warnings)}`)
  }
  if (readFileSync(exoticFile, 'utf8') !== exoticBefore) throw new Error('an unjudged shape must never be rewritten')
  const exoticOff = await host.setEnabled(exoticFile, 'a', false)
  if (exoticOff.changed !== false || exoticOff.recognized !== false) {
    throw new Error(`disable must not stack a row onto an unjudged shape: ${JSON.stringify(exoticOff)}`)
  }

  // An id this file never mentions cannot be confirmed as enabled.
  const missingFile = write('missing.yml', HEAD)
  const missing = await host.setEnabled(missingFile, 'not-in-this-file', true)
  if (missing.changed !== false || missing.recognized !== false || missing.warnings.length === 0) {
    throw new Error(`an id absent from the file must not be reported as applied: ${JSON.stringify(missing)}`)
  }
  console.log('host tolerant-row regression OK: 8 hand-written disable shapes cleared, entry rows + disabled:false kept, duplicate disable idempotent, 3 duplicate rows cleared and counted, unjudgeable/absent rows reported as unconfirmed')
}

// --- `webServer` route doubles ------------------------------------------------
// The host half's transport is one fenced prefix route on the `webServer`
// service — declared as a STATIC module-level dependency (`export const
// inject = ['webServer']`), replacing the Connection RPC channel that dsh
// 0.1.5-rc.1 cannot register for a plugin outside the connection package.
// Because the carrier is declared, Cordis only activates the plugin once it is
// bound and hands it to `apply` as a plain `ctx.webServer` property, which is
// exactly the shape the mock below takes. These doubles observe the route
// surface directly and drive the real handler with a fake req/res, so the fence
// below is asserted, not assumed.
const TOGGLE_PATH = '/plugin-toggle'

/** `webServer` service double: records every register() as { kind, path, handler }. */
const makeWebServerStub = () => {
  const routes = []
  let disposers = 0
  return {
    routes,
    disposeCount: () => disposers,
    register: (route) => {
      const entry = { kind: route.kind, path: route.path, handler: route.handler }
      routes.push(entry)
      return () => {
        disposers += 1
        const at = routes.indexOf(entry)
        if (at >= 0) routes.splice(at, 1)
      }
    },
  }
}

/**
 * Invoke one registered prefix route with a fake req/res.
 *
 * The route registers its request listeners synchronously and answers from a
 * promise continuation, so the body is delivered only after `handler()`
 * returned, and the helper resolves when the response is really finished. The
 * oversize-body path destroys the request instead of answering, so `destroy()`
 * settles the helper on the current response state.
 */
const callRoute = async (route, {
  method = 'POST',
  pathname = route.path,
  body = {},
  raw = null,
  headers = {},
} = {}) => {
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const res = {
    status: null,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, extra) {
      this.status = status
      for (const [name, value] of Object.entries(extra ?? {})) this.headers[name.toLowerCase()] = value
      return this
    },
    end(chunk) {
      this.body = String(chunk ?? '')
      this.writableEnded = true
      settle(this)
      return this
    },
  }
  const listeners = new Map()
  const req = {
    method,
    url: pathname,
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', ...headers },
    destroy() { settle(res) },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return req
    },
  }
  await route.handler(req, res)
  const payload = raw === null ? JSON.stringify(body) : raw
  for (const listener of [...(listeners.get('data') ?? [])]) listener(Buffer.from(payload, 'utf8'))
  for (const listener of [...(listeners.get('end') ?? [])]) listener()
  return Promise.race([
    done,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`route ${pathname} never answered`)), 2000).unref?.()
    }),
  ])
}

/**
 * The repository's full failure envelope is `{ ok:false, error:{ code, message,
 * details } }`; the transport's own rejections must carry it too.
 */
const assertErrorEnvelope = (label, result) => {
  if (result?.ok !== false) throw new Error(`${label}: expected ok:false, got ${JSON.stringify(result)}`)
  const { code, message, details } = result.error ?? {}
  if (typeof code !== 'string' || code.length === 0) throw new Error(`${label}: error.code missing`)
  if (typeof message !== 'string' || message.length === 0) throw new Error(`${label}: error.message missing`)
  if (typeof details !== 'object' || details === null || Array.isArray(details)) throw new Error(`${label}: error.details missing`)
}

const hostSource = readFileSync(hostPath, 'utf8')
// 形状检查只看真正的代码：宿主半的文档注释里点名了两种被淘汰的写法
// （`ctx.inject(...)` 与 `ctx.get('webServer')`），不先剥掉注释就会自己误伤。
const hostCode = hostSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/**
 * A mock context shaped like a REAL activation of this plugin: `webServer` is
 * the module's STATIC `inject` dependency, so Cordis binds it before `apply`
 * runs and hands it over as a plain service property.
 *
 * `get` answers `undefined` for every service, exactly like the optional read
 * does while a service is unbound, so a regression to `ctx.get('webServer')`
 * loses the route and fails the registration assertion below. `inject` throws:
 * a dynamic gate inside `apply` is the shape this migration removed.
 *
 * `withoutCarrier` / `register` model the two ways the transport can fail to
 * come up, and `effects` records every `ctx.effect(fn, label)` together with
 * the disposer it returned, so "exactly one effect owns the route" is
 * observable rather than assumed.
 */
function makeHostCtx({ withoutCarrier = false, register = null } = {}) {
  const web = makeWebServerStub()
  if (register !== null) web.register = register
  const effects = []
  const warns = []
  const settingsNamespaces = []
  const ctx = {
    logger: { info: () => {}, warn: (message) => { warns.push(String(message)) } },
    effect: (fn, label) => {
      const disposer = fn()
      effects.push({ label: typeof label === 'string' ? label : null, disposer })
      return disposer
    },
    get: () => undefined,
    inject: () => {
      throw new Error('apply() used a dynamic ctx.inject(): a user-layer hot reload never re-activates that child fiber, so the /plugin-toggle transport dies until a full restart. Declare the carrier statically (export const inject).')
    },
    settings: {
      register: (namespace) => { settingsNamespaces.push(namespace); return () => {} },
    },
  }
  if (!withoutCarrier) ctx.webServer = web
  return { ctx, web, effects, warns, settingsNamespaces }
}

// 传输载体的依赖形态：模块级**静态** `inject`，不是 apply 内的动态门。
//
// Cordis 并发挂载各行，HTTP 载体比别的服务绑定得更晚。被淘汰的两种写法都把页面的
// 整条通道弄丢过：动态 `ctx.inject(['webServer'], …)` 门在用户层热重载后不再重新
// 激活；可选的 `ctx.get('webServer')` 读取又与载体的绑定相互竞态，读到 undefined
// 就什么都不注册。静态声明把“等载体”交回给 Cordis（声明过的依赖就绪才激活插件），
// tests/load-smoke.mjs 已在真实运行时里证明晚到的载体仍然会挂上路由；这里守住 mock
// 还能观测的那一半 —— 旧“回调声明了 webServer”门断言的等价替换：
{
  if (!Array.isArray(host.inject)) throw new Error(`host.inject must be a static array, got ${typeof host.inject}`)
  if (!host.inject.includes('webServer')) {
    throw new Error(`host.inject must declare 'webServer' as a hard dependency: ${JSON.stringify(host.inject)}`)
  }
  if (/ctx\.get\(\s*['"]webServer/.test(hostCode)) {
    throw new Error('the host half reads the web carrier optionally again (ctx.get) — that is the activation race this fix removed')
  }
  if (/ctx\.inject\(\s*\[[^\]]*['"]webServer/.test(hostCode)) {
    throw new Error('the web carrier must stay a STATIC inject, not a dynamic gate inside apply')
  }
  console.log(`host inject OK: static inject = ${JSON.stringify(host.inject)} (carrier declared, no optional ctx.get read and no dynamic gate left in the source)`)
}

// apply(): the /plugin-toggle prefix route + the transport fence + endpoint validation
{
  const { ctx: hostCtx, web, effects, warns, settingsNamespaces } = makeHostCtx()
  const ret = host.apply(hostCtx, { patchFile: tmpPatch })
  if (ret !== undefined && ret !== null && typeof ret.then === 'function') {
    throw new Error('P0 regression: apply returned a thenable (Invalid effect)')
  }
  if (ret !== undefined) throw new Error(`apply must return undefined, got ${typeof ret}`)
  if (warns.length !== 0) throw new Error(`a healthy apply must log no warnings: ${JSON.stringify(warns)}`)
  if (settingsNamespaces.length !== 0) {
    throw new Error(`this patch owns no settings namespace, yet apply registered: ${JSON.stringify(settingsNamespaces)}`)
  }
  if (effects.length !== 1) {
    throw new Error(`apply must register exactly one effect, got ${JSON.stringify(effects.map((entry) => entry.label))}`)
  }
  if (!String(effects[0].label).includes('plugin-toggle')) {
    throw new Error(`the route effect must carry a recognisable label, got '${effects[0].label}'`)
  }
  if (web.routes.length !== 1) throw new Error(`webServer.register must be called once, got ${web.routes.length}`)
  const route = web.routes.find((r) => r.path === TOGGLE_PATH)
  if (route === undefined) throw new Error(`${TOGGLE_PATH} never registered (routes: ${JSON.stringify(web.routes.map((r) => r.path))})`)
  if (route.kind !== 'prefix') throw new Error(`${TOGGLE_PATH} must be kind 'prefix' (the page POSTs /<channel>/<endpoint>), got '${route.kind}'`)
  if (warns.length !== 0) throw new Error(`a healthy apply must log no warnings: ${JSON.stringify(warns)}`)

  // Endpoint validation through the real transport: an ok envelope, the two
  // bad-request shapes, and the unknown endpoint — all with 200 + JSON.
  const missingEnabled = await callRoute(route, { pathname: TOGGLE_PATH + '/setEnabled', body: { args: { entryId: 'a' } } })
  if (missingEnabled.status !== 200 || missingEnabled.headers['content-type'] !== 'application/json') {
    throw new Error(`a handler-level failure must still answer 200 + application/json: ${missingEnabled.status} ${JSON.stringify(missingEnabled.headers)}`)
  }
  const bad = JSON.parse(missingEnabled.body)
  assertErrorEnvelope('missing enabled', bad)
  if (bad.error.code !== 'bad-request') throw new Error(`missing enabled: ${JSON.stringify(bad)}`)

  const badId = JSON.parse((await callRoute(route, { pathname: TOGGLE_PATH + '/setEnabled', body: { args: { entryId: 'a/../x', enabled: true } } })).body)
  assertErrorEnvelope('bad id', badId)
  if (badId.error.code !== 'bad-request') throw new Error(`bad id: ${JSON.stringify(badId)}`)

  const unknown = JSON.parse((await callRoute(route, { pathname: TOGGLE_PATH + '/nope', body: {} })).body)
  assertErrorEnvelope('unknown endpoint', unknown)
  if (unknown.error.code !== 'bad-request') throw new Error(`unknown endpoint: ${JSON.stringify(unknown)}`)

  const ok = JSON.parse((await callRoute(route, { pathname: TOGGLE_PATH + '/setEnabled', body: { args: { entryId: 'b', enabled: false } } })).body)
  if (!ok.ok || ok.value.enabled !== false || ok.value.changed !== true) throw new Error(`setEnabled via the route: ${JSON.stringify(ok)}`)
  if (!readFileSync(tmpPatch, 'utf8').includes('- id: b\n  disabled: true')) throw new Error('the route must write the patch file')

  // --- the fence -------------------------------------------------------------
  // 403: a cross-site POST always carries its own Origin and must be refused.
  const crossOrigin = await callRoute(route, {
    pathname: TOGGLE_PATH + '/setEnabled',
    body: { args: { entryId: 'b', enabled: true } },
    headers: { origin: 'http://evil.example' },
  })
  if (crossOrigin.status !== 403) throw new Error(`a foreign Origin must be refused with 403, got ${crossOrigin.status}`)
  assertErrorEnvelope('cross-origin refusal', JSON.parse(crossOrigin.body))
  // The SAME origin is the normal page case and must pass.
  const sameOrigin = await callRoute(route, {
    pathname: TOGGLE_PATH + '/setEnabled',
    body: { args: { entryId: 'b', enabled: true } },
    headers: { origin: 'http://127.0.0.1:3080' },
  })
  if (sameOrigin.status !== 200) throw new Error(`a same-origin POST must pass the fence, got ${sameOrigin.status} (${sameOrigin.body})`)
  const unparsableOrigin = await callRoute(route, {
    pathname: TOGGLE_PATH + '/setEnabled',
    body: {},
    headers: { origin: 'not a url' },
  })
  if (unparsableOrigin.status !== 403) throw new Error(`an unparsable Origin must be refused, got ${unparsableOrigin.status}`)

  // 405: mutations go through POST only.
  const get = await callRoute(route, { method: 'GET', pathname: TOGGLE_PATH + '/setEnabled' })
  if (get.status !== 405) throw new Error(`GET must be refused with 405, got ${get.status}`)
  assertErrorEnvelope('GET refusal', JSON.parse(get.body))

  // 415: a JSON body is what forces the CORS preflight we never answer.
  const wrongType = await callRoute(route, {
    pathname: TOGGLE_PATH + '/setEnabled',
    body: { args: { entryId: 'b', enabled: true } },
    headers: { 'content-type': 'text/plain' },
  })
  if (wrongType.status !== 415) throw new Error(`a non-JSON content-type must be refused with 415, got ${wrongType.status}`)
  assertErrorEnvelope('content-type refusal', JSON.parse(wrongType.body))
  // A charset parameter is still application/json.
  const charset = await callRoute(route, {
    pathname: TOGGLE_PATH + '/setEnabled',
    body: { args: { entryId: 'b', enabled: true } },
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
  if (charset.status !== 200) throw new Error(`application/json; charset=utf-8 must pass, got ${charset.status}`)

  // 404: the endpoint comes from /<path>/<endpoint>, exactly one segment.
  for (const pathname of [TOGGLE_PATH, TOGGLE_PATH + '/', TOGGLE_PATH + '/a/b']) {
    const res = await callRoute(route, { pathname, body: {} })
    if (res.status !== 404) throw new Error(`${pathname} must be 404, got ${res.status} (${res.body})`)
    assertErrorEnvelope(`${pathname} 404`, JSON.parse(res.body))
  }
  // A query string is stripped before the endpoint is read.
  const withQuery = await callRoute(route, { pathname: TOGGLE_PATH + '/setEnabled?t=1', body: { args: { entryId: 'b', enabled: true } } })
  if (withQuery.status !== 200) throw new Error(`a query string must not break endpoint parsing, got ${withQuery.status}`)

  // 400: a body that is not JSON; 413: a body over the 1 MB cap.
  const notJson = await callRoute(route, { pathname: TOGGLE_PATH + '/setEnabled', raw: 'not json' })
  if (notJson.status !== 400) throw new Error(`a non-JSON body must be 400, got ${notJson.status}`)
  assertErrorEnvelope('non-JSON body', JSON.parse(notJson.body))
  const tooLarge = await callRoute(route, { pathname: TOGGLE_PATH + '/setEnabled', raw: 'x'.repeat((1 << 20) + 1) })
  if (tooLarge.status !== 413) throw new Error(`a body over 1 MB must be 413, got ${tooLarge.status}`)
  assertErrorEnvelope('oversized body', JSON.parse(tooLarge.body))

  // Empty bodies are an empty payload, not a parse error.
  const emptyBody = JSON.parse((await callRoute(route, { pathname: TOGGLE_PATH + '/setEnabled', raw: '' })).body)
  assertErrorEnvelope('empty body', emptyBody)
  if (emptyBody.error.code !== 'bad-request') throw new Error(`an empty body must reach the handler: ${JSON.stringify(emptyBody)}`)

  // 500: a throwing handler must not take the route down. Wired through a
  // second route so the plugin's real handler stays untouched.
  const throwing = host.createRpcRoute('/boom', async () => { throw new Error('handler exploded') })
  const boom = await callRoute(throwing, { pathname: '/boom/x', body: {} })
  if (boom.status !== 500) throw new Error(`a throwing handler must answer 500, got ${boom.status}`)
  const boomBody = JSON.parse(boom.body)
  assertErrorEnvelope('throwing handler', boomBody)
  if (boomBody.error.code !== 'internal' || !boomBody.error.message.includes('handler exploded')) {
    throw new Error(`500 envelope: ${JSON.stringify(boomBody)}`)
  }
  console.log('host OK: /plugin-toggle prefix route (kind=prefix) + fence 403/405/415/404/400/413/500 + setEnabled writes the temp patch')

  // An absent carrier is unreachable in production now: a declared dependency
  // is bound before the plugin activates, and the LATE-carrier case is proven
  // against the real Cordis runtime in tests/load-smoke.mjs. What stays
  // observable here is the half this fix actually removed — the host half must
  // keep no `undefined` / warn-and-skip branch, so a carrier that really is
  // missing surfaces (loudly or in the log) instead of leaving the page with a
  // silently dead endpoint.
  const absent = makeHostCtx({ withoutCarrier: true })
  let absentThrew = null
  let absentReturned
  try {
    absentReturned = host.apply(absent.ctx, { patchFile: tmpPatch })
  } catch (error) {
    absentThrew = error
  }
  if (absentReturned !== undefined && absentReturned !== null && typeof absentReturned.then === 'function') {
    throw new Error('P0 regression: apply returned a thenable on the failure path (Invalid effect)')
  }
  if (absent.web.routes.length !== 0) throw new Error('no route may be registered against a missing carrier')
  if (absentThrew === null && absent.warns.length === 0) {
    throw new Error('a missing carrier must fail loudly or be reported — never be skipped in silence')
  }
  if (absentThrew === null && !/plugin-toggle/.test(absent.warns.join('\n'))) {
    throw new Error(`the report must name the transport that failed: ${JSON.stringify(absent.warns)}`)
  }

  // A throwing register must warn, not escape apply(): the transport is this
  // plugin's only optional step, so the activation itself still succeeds.
  const throwingRegister = makeHostCtx({ register: () => { throw new Error('route table exploded') } })
  const retThrowing = host.apply(throwingRegister.ctx, { patchFile: tmpPatch })
  if (retThrowing !== undefined) throw new Error('a failing register must not change what apply returns')
  if (throwingRegister.warns.length !== 1 || !/could not be registered/.test(throwingRegister.warns[0])) {
    throw new Error(`a throwing register must be reported as a warning: ${JSON.stringify(throwingRegister.warns)}`)
  }

  // The route is owned by that one effect: the disposer `apply` hands back must
  // be the one the service returned, so unloading the fiber releases the route.
  const owned = makeHostCtx()
  host.apply(owned.ctx, { patchFile: tmpPatch })
  if (owned.effects.length !== 1) {
    throw new Error(`the route must be owned by exactly one effect, got ${JSON.stringify(owned.effects.map((entry) => entry.label))}`)
  }
  const disposer = owned.effects[0].disposer
  if (typeof disposer !== 'function') throw new Error('the route must be registered inside ctx.effect()')
  if (owned.web.routes.length !== 1) throw new Error('the route must be live before disposal')
  disposer()
  if (owned.web.routes.length !== 0 || owned.web.disposeCount() !== 1) {
    throw new Error(`the effect body must return the service's own disposer (disposeCount=${owned.web.disposeCount()})`)
  }

  // 用户层热重载的重挂：静态声明下每次激活都自己把路由挂上，既不需要动态门，也不
  // 会碰到上一个实例的路由表；卸载只放掉自己那一条。
  const remount = makeHostCtx()
  const retRemount = host.apply(remount.ctx, { patchFile: tmpPatch })
  if (retRemount !== undefined) throw new Error('a remount activation must return undefined')
  if (remount.web.routes.length !== 1 || remount.web.routes[0].path !== TOGGLE_PATH) {
    throw new Error(`a fresh activation must bring the transport up by itself: ${JSON.stringify(remount.web.routes.map((r) => r.path))}`)
  }
  if (remount.warns.length !== 0) throw new Error(`a healthy remount must stay quiet: ${JSON.stringify(remount.warns)}`)
  const remounted = await callRoute(remount.web.routes[0], { pathname: TOGGLE_PATH + '/setEnabled', body: { args: { entryId: 'a', enabled: true } } })
  if (remounted.status !== 200 || JSON.parse(remounted.body).ok !== true) {
    throw new Error(`the remounted route must serve the endpoint: ${remounted.status} ${remounted.body}`)
  }
  if (web.routes.length !== 1) throw new Error('a remount must not touch the previous instance\'s route table')
  for (const entry of remount.effects) entry.disposer()
  if (remount.web.routes.length !== 0) throw new Error('the remounted route must be released with its own instance')
  console.log('host OK: static inject = webServer, a missing/throwing carrier is reported instead of skipped, one effect owns the route, remount and unload stay independent')
}
rmSync(tmpDir, { recursive: true, force: true })

// --- load the bundle exactly like the shell kernel does ----------------------
let dom = null
let handoff = null
const bundleSource = readFileSync(bundlePath, 'utf8')
if (JSDOM !== null) {
  dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3080/',
  })
  globalThis.window = dom.window
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (!(key in globalThis)) globalThis[key] = dom.window[key]
  }
  dom.window.__ModuleLoader__ = { load: (h) => { handoff = h } }
  const evaluate = new Function('window', 'document', bundleSource)
  evaluate(dom.window, dom.window.document)
} else {
  // Minimal DOM shim: the bundle's CSS IIFE guards on `document` and the
  // module table only needs `__ModuleLoader__.load` to register the factory.
  const shimDocument = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, setAttribute: () => {}, appendChild: () => {} }),
    head: { appendChild: () => {} },
  }
  const shimWindow = { __ModuleLoader__: { load: (h) => { handoff = h } } }
  const evaluate = new Function('window', 'document', bundleSource)
  evaluate(shimWindow, shimDocument)
}
if (handoff === null) throw new Error('bundle never called __ModuleLoader__.load')
if (handoff.id !== PLUGIN_ID) throw new Error(`handoff id mismatch: ${handoff.id}`)

const requireTable = (spec) => {
  if (spec === 'react') return React
  if (spec === 'react/jsx-runtime') return uiRequire('react/jsx-runtime')
  // The bundle only consumes the two icon components, so stub them with plain
  // svg placeholders (identical contract, no styling dependency).
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    const icon = (props) => React.createElement('svg', { ...props, 'data-icon': true })
    return {
      IconChevronDownOutline14: icon,
      IconSearchOutline16: icon,
    }
  }
  throw new Error(`unexpected module-table word: ${spec}`)
}
const exports_ = handoff.factory(requireTable)

// --- registration contract ----------------------------------------------------
if (typeof exports_.apply !== 'function') throw new Error('exports.apply missing')
if (!Array.isArray(exports_.inject)) throw new Error('exports.inject missing')
if (exports_.NS !== 'settings.pluginManager') throw new Error(`NS mismatch: ${exports_.NS}`)
console.log('exports contract OK:', JSON.stringify(exports_.inject), 'NS =', exports_.NS)

// --- apply() against a mock client ctx ----------------------------------------
const SNAPSHOT = {
  entries: [
    { entryId: 'official-active', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: true, fiberPhase: 'active' },
    { entryId: 'official-failed', moduleName: '@deepseek-ai/dsh-host-plugin-inventory', enabled: true, fiberPhase: 'failed' },
    { entryId: 'official-disabled', moduleName: '@deepseek-ai/dsh-host-directory-picker-native', enabled: false, fiberPhase: null },
    { entryId: 'builtin-pending', moduleName: 'cordis:pending-name', enabled: true, fiberPhase: 'pending' },
    { entryId: 'custom-loading', moduleName: '@fixture/loading-name', enabled: true, fiberPhase: 'loading' },
    { entryId: 'custom-unobserved', moduleName: '@fixture/unobserved-name', enabled: true, fiberPhase: null },
    { entryId: 'custom-disabled', moduleName: 'file:///C:/Users/me/.dsh/plugins/session-cleanup.mjs', enabled: false, fiberPhase: null },
  ],
}

let registered = null
let dictionaries = null
/**
 * `fetch` double: the transport the client half now uses.
 *
 * The browser bundle calls `fetch('/plugin-toggle/setEnabled', { method, headers,
 * body })` and unwraps the `{ ok, value }` envelope, so this records every
 * request (url, method, content-type, exact JSON body) and answers with a real
 * Response-shaped object. `networkError` / `httpStatus` / `envelope` let each
 * section drive one failure mode.
 */
const toggleCalls = []
let fetchMode = { networkError: null, httpStatus: 200, envelope: null }
// The double is installed for the whole client section (the DOM flow needs it
// too) and restored on every exit path below.
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const headers = init.headers ?? {}
  toggleCalls.push({
    url: String(url),
    method: init.method,
    contentType: headers['content-type'],
    body: String(init.body ?? ''),
  })
  if (fetchMode.networkError !== null) throw new Error(fetchMode.networkError)
  const request = JSON.parse(String(init.body ?? '{}'))
  const args = request.args ?? {}
  const envelope = fetchMode.envelope ?? { ok: true, value: { enabled: args.enabled, changed: true, entryId: args.entryId } }
  return {
    ok: fetchMode.httpStatus >= 200 && fetchMode.httpStatus < 300,
    status: fetchMode.httpStatus,
    json: async () => envelope,
  }
}
const ctx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, dicts) => { dictionaries = { ns, dicts } },
    bind: () => (key) => 't:' + key,
  },
  remote: {
    pluginInventory: { list: async () => ({ ok: true, value: SNAPSHOT }) },
  },
  slots: {
    inject: (_key, callback) => { registered = callback() },
    register: (options, component) => ({ ...options, component }),
  },
}
exports_.apply(ctx)
if (registered === null) throw new Error('slots.inject never registered')
if (registered.id !== 'manager' || registered.order !== 20) {
  throw new Error(`tab options mismatch: ${JSON.stringify(registered)}`)
}
if (typeof registered.inject().toggleEnabled !== 'function') throw new Error('inject must expose toggleEnabled')
const toggleProbe = await registered.inject().toggleEnabled('ui-queue-tools', false)
if (toggleProbe.enabled !== false) throw new Error(`toggleEnabled result: ${JSON.stringify(toggleProbe)}`)
const toggleCall = toggleCalls.pop()
if (toggleCall.url !== '/plugin-toggle/setEnabled') throw new Error(`toggle fetch url: ${JSON.stringify(toggleCall)}`)
if (toggleCall.method !== 'POST') throw new Error(`toggle fetch method: ${JSON.stringify(toggleCall)}`)
if (toggleCall.contentType !== 'application/json') throw new Error(`toggle fetch content-type: ${JSON.stringify(toggleCall)}`)
if (toggleCall.body !== '{"args":{"entryId":"ui-queue-tools","enabled":false}}') {
  throw new Error(`toggle fetch body: ${JSON.stringify(toggleCall)}`)
}
if (dictionaries === null || dictionaries.ns !== exports_.NS) throw new Error('dictionaries not registered')
const zhKeys = Object.keys(dictionaries.dicts.zh)
const enKeys = Object.keys(dictionaries.dicts.en)
if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  throw new Error(`zh/en key mismatch:\nzh: ${zhKeys}\nen: ${enKeys}`)
}
console.log('apply contract OK: tab id =', registered.id, 'order =', registered.order, '| dict keys =', zhKeys.length, '| toggleEnabled → POST /plugin-toggle/setEnabled')

// The client must not depend on the Connection RPC surface any more, and its
// inject list must not name a service it no longer reads. (The explanatory
// comment that names the old call is fine; an actual property access is not.)
if (exports_.inject.includes('connection')) throw new Error(`exports.inject still requires connection: ${JSON.stringify(exports_.inject)}`)
if (/\bctx\.connection\b/.test(bundleSource)) throw new Error('the bundle still accesses ctx.connection')
if (/\bconnection\.rpc\b/.test(bundleSource)) throw new Error('the bundle still calls ctx.connection.rpc')
if (typeof globalThis.fetch !== 'function') throw new Error('the bundle must call the browser fetch global')

// envelope failure -> Error carrying .code/.details (the branch the tab uses to
// tell "the host refused" from "the request never arrived").
fetchMode = { networkError: null, httpStatus: 200, envelope: { ok: false, error: { code: 'bad-request', message: 'entryId must be a plain identifier', details: { hint: 'x' } } } }
let envelopeFailure = null
try { await registered.inject().toggleEnabled('ui-queue-tools', true) } catch (error) { envelopeFailure = error }
if (envelopeFailure === null) throw new Error('a failed envelope must reject')
if (envelopeFailure.code !== 'bad-request' || envelopeFailure.details?.hint !== 'x') {
  throw new Error(`a failed envelope must carry .code/.details: ${JSON.stringify(envelopeFailure)}`)
}
if (!envelopeFailure.message.includes('bad-request')) throw new Error(`failure message must name the code: ${envelopeFailure.message}`)

// non-2xx and a dead network must both reject too.
fetchMode = { networkError: null, httpStatus: 500, envelope: { ok: true, value: {} } }
let httpFailure = null
try { await registered.inject().toggleEnabled('ui-queue-tools', true) } catch (error) { httpFailure = error }
if (httpFailure === null || !httpFailure.message.includes('HTTP 500')) throw new Error(`HTTP failure: ${JSON.stringify(httpFailure)}`)
fetchMode = { networkError: 'connection refused', httpStatus: 200, envelope: null }
let netFailure = null
try { await registered.inject().toggleEnabled('ui-queue-tools', true) } catch (error) { netFailure = error }
if (netFailure === null || !netFailure.message.includes('connection refused')) throw new Error(`network failure: ${JSON.stringify(netFailure)}`)
fetchMode = { networkError: null, httpStatus: 200, envelope: null }
toggleCalls.length = 0
console.log('client transport OK: fetch envelope unwrapped, .code/.details preserved, HTTP + network failures reject')

// --- render + interact (jsdom; the fallback only keeps a dependency-free box green)
if (JSDOM === null) {
  globalThis.fetch = realFetch
  console.log(`\nclient DOM sections SKIPPED: ${domDeps.hint}`)
  console.log('ALL NON-DOM HARNESS CHECKS PASSED (install the repo devDependencies to enable the DOM sections)')
  process.exit(0)
}

// --- render + interact (react-dom in jsdom) ------------------------------------
const { act } = React
const { createRoot } = uiRequire('react-dom/client')
const fireChange = (el, value) => {
  const proto = el.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}
const fireClick = (el) => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const en = dictionaries.dicts.en
const injected = registered.inject()
const root = createRoot(dom.window.document.getElementById('root'))

await act(async () => {
  root.render(React.createElement(registered.component, {
    list: async () => SNAPSHOT,
    toggleEnabled: injected.toggleEnabled,
    t: (key) => en[key],
  }))
})

const doc = dom.window.document
const cards = () => [...doc.querySelectorAll('.pm-card')]
const count = () => doc.querySelector('[data-managed-plugin-count]').textContent

if (cards().length !== 7) throw new Error(`expected 7 cards, got ${cards().length}`)
if (doc.querySelectorAll('[data-category="official"]').length !== 4) throw new Error('official tag count mismatch')
if (doc.querySelectorAll('[data-category="custom"]').length !== 3) throw new Error('custom tag count mismatch')
console.log('initial render OK: 7 cards, official tags = 4, custom tags = 3')

// every card carries an enable/disable toggle; clicking it POSTs
// /plugin-toggle/setEnabled with the inverse state and refreshes the list
const toggles = () => [...doc.querySelectorAll('.pm-toggle')]
if (toggles().length !== 7) throw new Error(`expected 7 toggle buttons, got ${toggles().length}`)
const firstToggle = toggles()[0]
const firstCard = firstToggle.closest('.pm-card')
if (firstCard.getAttribute('data-plugin-entry') !== 'official-active') throw new Error('first card ordering mismatch')
await act(async () => { fireClick(firstToggle) })
const clickCall = toggleCalls.pop()
if (clickCall === undefined || clickCall.url !== '/plugin-toggle/setEnabled' || clickCall.method !== 'POST') {
  throw new Error(`toggle click fetch: ${JSON.stringify(clickCall)}`)
}
const clickArgs = JSON.parse(clickCall.body).args
if (clickArgs.entryId !== 'official-active' || clickArgs.enabled !== false) {
  throw new Error(`toggle click must send the inverse state: ${JSON.stringify(clickCall)}`)
}
console.log('toggle OK: card button POSTs /plugin-toggle/setEnabled (inverse state) over fetch')

// Honest status: the host's `recognized`/`removed` fields drive what the tab
// claims. `recognized: false` must never render as "已生效"; a confirmed enable
// that cleared N disable rows says so.
const renderStatusHost = async (value) => {
  const host = doc.createElement('div')
  const root = createRoot(host)
  await act(async () => {
    root.render(React.createElement(registered.component, {
      list: async () => SNAPSHOT,
      toggleEnabled: async (entryId, enabled) => ({ ...value, entryId, enabled }),
      t: (key) => en[key],
    }))
  })
  await act(async () => { fireClick(host.querySelector('.pm-toggle')) })
  return host
}
const unconfirmedHost = await renderStatusHost({ changed: false, removed: 0, recognized: false, warnings: ['line 8: cannot judge this "disabled" value'] })
const unconfirmedStatus = unconfirmedHost.querySelector('.pm-toggle-status')
if (unconfirmedStatus === null || unconfirmedStatus.textContent !== en.toggleUnconfirmed) {
  throw new Error(`unconfirmed status missing: ${JSON.stringify(unconfirmedHost.textContent)}`)
}
if (unconfirmedHost.textContent.includes(en.toggleDone)) throw new Error('an unconfirmed toggle must not claim success')
if (!(unconfirmedStatus.getAttribute('title') ?? '').includes('line 8')) {
  throw new Error('the warning detail must be reachable from the status: ' + unconfirmedStatus.getAttribute('title'))
}
const clearedHost = await renderStatusHost({ changed: true, removed: 2, recognized: true, warnings: [] })
const clearedStatus = clearedHost.querySelector('.pm-toggle-status')
const clearedText = en.toggleCleared.replace('{n}', '2')
if (clearedStatus === null || clearedStatus.textContent !== clearedText) {
  throw new Error(`cleared-row count missing: ${JSON.stringify(clearedHost.textContent)}`)
}
console.log('toggle status OK: recognized=false renders "not confirmed" (never "applied"), cleared-row count shown')

const select = (label) => doc.querySelector(`select[aria-label="${label}"]`)

// category filter
await act(async () => { fireChange(select('Category'), 'official') })
if (cards().length !== 4 || count() !== '4') throw new Error(`category=official: ${cards().length} cards, count ${count()}`)
await act(async () => { fireChange(select('Category'), 'custom') })
if (cards().length !== 3) throw new Error(`category=custom: ${cards().length} cards`)
console.log('category filter OK')

// enablement filter
await act(async () => { fireChange(select('Category'), 'all') })
await act(async () => { fireChange(select('Enablement'), 'disabled') })
if (cards().length !== 2) throw new Error(`enablement=disabled: ${cards().length} cards`)
console.log('enablement filter OK')

// phase filter
await act(async () => { fireChange(select('Enablement'), 'all') })
await act(async () => { fireChange(select('Runtime status'), 'failed') })
if (cards().length !== 1) throw new Error(`phase=failed: ${cards().length} cards`)
if (cards()[0].textContent.includes('plugin-inventory') === false) throw new Error('failed card title mismatch')
console.log('phase filter OK')

// search + combined AND semantics
await act(async () => {
  fireChange(select('Runtime status'), 'all')
  fireChange(doc.querySelector('input[type="search"]'), 'not-a-plugin')
})
if (cards().length !== 0) throw new Error('search miss should render 0 cards')
if (doc.body.textContent.includes(en.emptySearch) === false) throw new Error('emptySearch copy missing')

await act(async () => {
  fireChange(doc.querySelector('input[type="search"]'), 'hmr')
  fireChange(select('Category'), 'official')
  fireChange(select('Enablement'), 'enabled')
  fireChange(select('Runtime status'), 'active')
})
if (cards().length !== 1) throw new Error(`combined: ${cards().length} cards`)
if (cards()[0].getAttribute('data-plugin-entry') !== 'official-active') throw new Error('combined filter picked wrong row')

// disclosure expands
await act(async () => { fireClick(cards()[0].querySelector('.pm-card-content')) })
if (doc.querySelector('[data-loader-entry]') === null) throw new Error('disclosure details missing')
console.log('search + combined + disclosure OK')

// error state
const errorHost = dom.window.document.createElement('div')
const root2 = createRoot(errorHost)
await act(async () => {
  root2.render(React.createElement(registered.component, {
    list: async () => { throw new Error('private detail') },
    t: (key) => en[key],
  }))
})
if (errorHost.querySelector('[role="alert"]') === null) throw new Error('error state missing')
if (errorHost.textContent.includes('private detail')) throw new Error('error state leaked transport detail')
console.log('error state OK')

globalThis.fetch = realFetch
console.log('\nALL HARNESS CHECKS PASSED')
process.exit(0)
