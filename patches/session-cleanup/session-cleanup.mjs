/**
 * session-cleanup —— DeepSeek Harness 会话日志自动清理插件
 *
 * 按保留天数 / 总大小上限定期清理 $DSH_HOME/sessions 下的归档会话，
 * 跳过当前活跃会话。通过 cordis.patch.yml 的 insert 装载。
 *
 * 配置来源(优先级从低到高):schema 默认值 < 组合层 entry 配置
 * (cordis.patch.yml 的 config)< 设置文档的用户层。配置经 dsh-settings
 * 服务注册(namespace `session-cleanup`),可在 设置 → 插件 → 插件配置
 * 中可视化编辑;`applies: live`,保存后即时生效(定时器按新间隔重建)。
 * settings 服务不存在时回退到组合层配置,行为与旧版一致。
 *
 * 配置项:
 *   enabled: boolean        插件开关 (默认 true)
 *   maxAgeDays: number      超过该天数的会话可删 (默认 30, 0 = 不按天数清理)
 *   maxTotalMB: number      会话目录总占用上限 MB (默认 1024, 0 = 不限制)
 *   keepSessions: number    最少保留的会话数 (默认 5)
 *   intervalMinutes: number 清理间隔分钟 (默认 360)
 *   dryRun: boolean         演练模式, 只报告不删除 (默认 false)
 *   sessionsRoot: string    会话根目录 (默认 $DSH_HOME/sessions)
 *
 * 浏览器半(设置页的配置卡片)经 webServer 上的前缀路由
 * `POST /session-cleanup/<endpoint>` 读写配置(getConfig / setConfig /
 * resetConfig),见 createRpcRoute —— dsh 0.1.5-rc.1 的
 * `ctx.connection.rpc.handle` 对连接包之外的插件必然抛错,不能用。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readdir, rm, stat } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'

export const name = 'session-cleanup'

export const SETTINGS_NAMESPACE = 'session-cleanup'

/**
 * Settings schema: defaults here are the floor; the entry config and the
 * user document layer resolve above them.
 *
 * The export name must be exactly `Config`: the Cordis loader reads
 * `plugin.Config` (vendor/cordis registry.ts) to validate the entry config;
 * any other export name silently skips validation.
 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  maxAgeDays: z.number().default(30),
  maxTotalMB: z.number().default(1024),
  keepSessions: z.number().default(5),
  // 0 would make setInterval spin at ~1ms; 1 minute is the sane floor.
  intervalMinutes: z.number().min(1).default(360),
  dryRun: z.boolean().default(false),
  sessionsRoot: z.string().default(''),
})

export const DEFAULTS = {
  enabled: true,
  maxAgeDays: 30,
  maxTotalMB: 1024,
  keepSessions: 5,
  intervalMinutes: 360,
  dryRun: false,
  sessionsRoot: undefined,
}

/** 会话目录名形态: session-<uuid> */
const SESSION_DIR_RE = /^session-/

/** 解析会话根目录: 配置 > $DSH_HOME/sessions > ~/.dsh/sessions */
export function resolveSessionsRoot(configured) {
  if (configured) return resolve(configured)
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** 统计一个会话目录的总字节数与最后修改时间 */
async function statSessionDir(dir) {
  let size = 0
  let mtimeMs = 0
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else {
        const info = await stat(full)
        size += info.size
        if (info.mtimeMs > mtimeMs) mtimeMs = info.mtimeMs
      }
    }
  }
  await walk(dir)
  return { size, mtimeMs }
}

/**
 * 执行一次清理。纯函数核心, 不依赖 Cordis, 便于独立测试。
 * @returns {{ scanned, removed, skippedLive, kept, freedBytes, totalBytes, errors }}
 */
export async function runCleanup(sessionsRoot, options = {}, liveSessionIds = new Set(), now = Date.now()) {
  const cfg = { ...DEFAULTS, ...options }
  const result = { scanned: 0, removed: [], kept: [], skippedLive: 0, freedBytes: 0, totalBytes: 0, errors: [] }
  const candidates = []

  // 1. 扫描 <root>/<project>/<session-*>/ 结构
  const projects = await readdir(sessionsRoot, { withFileTypes: true }).catch((e) => {
    result.errors.push(`scan root: ${e.message}`)
    return []
  })
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(sessionsRoot, project.name)
    const entries = await readdir(projectDir, { withFileTypes: true }).catch((e) => {
      result.errors.push(`scan ${project.name}: ${e.message}`)
      return []
    })
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_DIR_RE.test(entry.name)) continue
      const sessionDir = join(projectDir, entry.name)
      const { size, mtimeMs } = await statSessionDir(sessionDir).catch((e) => {
        result.errors.push(`stat ${project.name}/${entry.name}: ${e.message}`)
        return { size: 0, mtimeMs: 0 }
      })
      result.scanned += 1
      result.totalBytes += size
      if (liveSessionIds.has(entry.name)) {
        result.skippedLive += 1
        continue
      }
      candidates.push({ key: `${project.name}/${entry.name}`, sessionDir, projectDir, id: entry.name, size, mtimeMs })
    }
  }

  // 2. 新 -> 旧 排序
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)

  // 3. 规则 A: 超龄删除 (仅对超出 keepSessions 的最旧部分生效)
  const remove = new Set()
  if (cfg.maxAgeDays > 0 && candidates.length > cfg.keepSessions) {
    const excess = candidates.slice(cfg.keepSessions)
    const cutoff = now - cfg.maxAgeDays * 86_400_000
    for (const c of excess) {
      if (c.mtimeMs < cutoff) remove.add(c.key)
    }
  }

  // 4. 规则 B: 总占用超上限时按最旧优先删
  // 统计口径 = 本次清理后仍会留在磁盘上的候选体积: 规则 A 已选中的会话这一轮
  // 必定被删, 先把它们的体积从总量里扣除, 否则容量判断偏高、会比实际需要多删。
  // 活跃会话在上面就 `continue` 了, 从不进入 candidates, 本就不参与该总量
  // (result.totalBytes 仍统计包含活跃会话的全部占用, 仅用于报告)。
  if (cfg.maxTotalMB > 0) {
    const cap = cfg.maxTotalMB * 1024 * 1024
    const survivors = candidates.filter((c) => !remove.has(c.key))
    let total = survivors.reduce((sum, c) => sum + c.size, 0)
    for (const c of survivors.reverse()) {
      if (total <= cap) break
      remove.add(c.key)
      total -= c.size
    }
  }

  // 5. 执行删除 (最旧优先)
  const emptyProjects = new Set()
  for (const c of [...candidates].reverse()) {
    if (!remove.has(c.key)) {
      result.kept.push({ id: c.id, project: c.projectDir.split(/[\\/]/).pop(), size: c.size })
      continue
    }
    if (cfg.dryRun) {
      result.removed.push({ id: c.id, dryRun: true, size: c.size, ageDays: Math.round((now - c.mtimeMs) / 86_400_000) })
      continue
    }
    try {
      await rm(c.sessionDir, { recursive: true, force: true })
      result.removed.push({ id: c.id, size: c.size })
      result.freedBytes += c.size
      emptyProjects.add(c.projectDir)
    } catch (e) {
      result.errors.push(`remove ${c.key}: ${e.message}`)
    }
  }

  // 6. 清理已空的项目目录 (非演练模式)
  if (!cfg.dryRun) {
    for (const projectDir of emptyProjects) {
      // readdir/rm failures here are best-effort: the next interval tick
      // re-scans and retries, and a vanished dir is a success by definition.
      const rest = await readdir(projectDir).catch(() => [])
      if (rest.length === 0) await rm(projectDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return result
}

/** 渲染清理报告 (供日志输出) */
export function summarize(result) {
  const lines = [
    `scanned=${result.scanned} liveSkipped=${result.skippedLive} kept=${result.kept.length} totalBytes=${result.totalBytes}`,
  ]
  if (result.removed.length > 0) {
    lines.push(`removed=${result.removed.length} freedBytes=${result.freedBytes} (${result.removed.map((r) => `${r.id}${r.dryRun ? '[dry]' : ''}`).join(', ')})`)
  } else {
    lines.push('removed=0')
  }
  if (result.errors.length > 0) lines.push(`errors=${result.errors.length}: ${result.errors.join(' | ')}`)
  return lines.join(' | ')
}

/**
 * Register the settings namespace and hand the write scope to `onScope`.
 * Same contract as dsh-settings' installSettingsSection, plus the scope:
 * the config RPC writes through it (persisted to settings.yaml), so edits
 * survive restarts and take effect live via the watcher.
 *
 * `isUnloading` mirrors the official isUnloading(ctx) guard: when the
 * plugin's own fiber is tearing down, both the settings detach disposer and
 * the watcher must NOT re-run `onChange` (= start), which would rebuild the
 * timer against resources being released. The `disposed` flag is set by the
 * plugin's teardown effect before the settings child fiber disposes (the
 * parent fiber disposes its own effects first), so the guard sees it set.
 */
function registerConfigSection(ctx, ns, schema, entry, hooks, onScope, isUnloading = () => false) {
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(ns, schema, { base: entry })
    hooks.setSource(() => scope.get())
    sctx.effect(() => () => {
      // Runs both when the settings provider detaches (the consumer keeps
      // running and must fall back to its composition entry) and when the
      // plugin itself unloads (disposed is already set; onChange would
      // rebuild the timer against a fiber whose resources are being let go).
      if (isUnloading()) return
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      // A stored change landing while the consumer unloads reaches the
      // watcher before the registration is released; guard it the same way.
      if (!isUnloading()) hooks.onChange()
    })
    onScope(scope)
  })
}

/** RPC failure envelope for the config endpoints. */
function configError(code, message) {
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
 * @param path - prefix route path, e.g. `/session-cleanup`.
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
 * Cordis 插件入口: 注入 sessions + webServer 服务, 启动时立即清理一次, 之后按
 * intervalMinutes 周期清理。定时器注册为 effect, 插件卸载时自动释放。
 * 配置经 dsh-settings 注册(namespace `session-cleanup`), 设置变更时
 * (onChange) 按新配置重建定时器 —— 即时生效。
 * 配置经 /session-cleanup 前缀路由读写(getConfig/setConfig/resetConfig),
 * 由插件管理页的配置卡片调用 —— 不受 dsh 设置白名单(apiproxy)限制。
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (!cfg.enabled) return

  // Note: `ctx.inject` returns a thenable Fiber; returning it from `apply`
  // makes Cordis treat it as an Effect and fail with TypeError('Invalid
  // effect'). The child fiber's disposer is registered on the parent fiber
  // automatically, so a statement call is enough.
  //
  // `webServer` 是**声明的依赖**, 不是可选读取: Cordis 并行挂载各行, HTTP 载体
  // 比 `sessions` 这类服务绑定得晚, 所以在回调里 `ctx.get('webServer')` 会与那次
  // 绑定竞态 —— 读到 undefined, 于是静默跳过页面整个传输通道(第一次重启后四个补丁
  // 就是这样一起失联的)。在这里等它, 注册才是无条件的。
  ctx.inject(['webServer', 'sessions'], (ctx) => {
    const logger = ctx.logger
    /** 当前权威配置: 设置文档 > 组合层 entry; settings 缺失时回退 entry。 */
    let source = () => ({ ...DEFAULTS, ...config })
    let configScope = null
    let timer = null
    let disposed = false

    const tick = async (reason, cfg) => {
      // A tick landing after teardown began must not scan or log; the
      // interval callback and start() both funnel through here.
      if (disposed) return
      const sessionsRoot = resolveSessionsRoot(cfg.sessionsRoot)
      const liveIds = new Set(ctx.sessions.list().map((s) => s.id))
      const result = await runCleanup(sessionsRoot, cfg, liveIds)
      logger.info(`[${reason}] ${summarize(result)}`)
      if (result.errors.length > 0) logger.warn(`cleanup errors: ${result.errors.join(' | ')}`)
    }

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }

    const start = () => {
      stop()
      if (disposed) return
      const current = source()
      if (!current.enabled) return
      // 启动/配置变更即清理一次; 失败不阻断
      void tick('startup', current).catch((e) => logger.warn(`startup cleanup failed: ${e.message}`))
      timer = setInterval(() => {
        void tick('interval', source()).catch((e) => logger.warn(`interval cleanup failed: ${e.message}`))
      }, current.intervalMinutes * 60_000)
    }

    // 端点处理函数: 契约与旧的 RPC handler 完全一致(getConfig / setConfig /
    // resetConfig), 只是换了承载方式。`configScope` 在调用时才读取, 所以
    // 无论设置分区此时是否已经挂上, 读到的都是当前那个 scope。
    const handleEndpoint = async (endpoint, payload) => {
      if (endpoint === 'getConfig') {
        return { ok: true, value: source() }
      }
      if (configScope === null) {
        return configError('settings-unavailable', 'settings service is not ready yet')
      }
      if (endpoint === 'setConfig') {
        const fields = payload?.args?.fields
        if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
          return configError('bad-request', 'fields must be a plain object')
        }
        try {
          await configScope.update(fields)
          return { ok: true, value: source() }
        } catch (error) {
          return configError('settings-rejected', String(error?.message ?? error))
        }
      }
      if (endpoint === 'resetConfig') {
        try {
          await configScope.replace({})
          return { ok: true, value: source() }
        } catch (error) {
          return configError('settings-rejected', String(error?.message ?? error))
        }
      }
      return configError('bad-request', `unknown endpoint: ${endpoint}`)
    }

    // 页面经由 webServer 上的一条前缀路由到达本插件。dsh 0.1.5-rc.1 下
    // `ctx.connection.rpc.handle` 对连接包之外的插件必然抛
    // `cannot get property "webServer" without inject`(见 createRpcRoute 的
    // 说明), 通道根本不会存在, 页面的 POST 会落到 SPA 兜底。
    //
    // 顺序很重要: 该注册排在设置分区之前。Cordis 在 inject 回调抛错时会回滚
    // 这个回调此前注册的每一个 effect, 而设置分区恰恰是最容易抛错的一步
    // (见 ui-settings-other 的同类教训); 传输先落地, 设置挂掉也不会把页面
    // 的读写通道一起带走。注册仍走 ctx.effect: 路由随插件卸载一起释放。
    //
    // 载体用 `ctx.get` 读只是兜底: 真正让它存在的是上面声明的依赖, 而下面这个
    // 分支是"已声明却仍缺席"的不可达路径。
    const webServer = ctx.get('webServer')
    if (webServer === undefined) {
      logger.warn('[session-cleanup] webServer is unavailable; the page cannot reach the config endpoints')
    } else {
      ctx.effect(() => webServer.register(createRpcRoute('/session-cleanup', handleEndpoint)), 'session-cleanup: /session-cleanup rpc route')
    }

    registerConfigSection(ctx, SETTINGS_NAMESPACE, Config, config, {
      setSource: (current) => { source = current },
      onChange: start,
    }, (scope) => { configScope = scope }, () => disposed)

    start()

    return ctx.effect(() => () => {
      disposed = true
      stop()
    })
  })
}
