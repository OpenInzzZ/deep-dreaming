/**
 * session-cleanup —— DeepSeek Harness 归档会话物理删除插件
 *
 * 本插件**不再做任何自动清理**：没有定时器、没有保留天数、没有容量上限。
 * 它只为「已归档会话」提供手动物理删除：
 *
 *   - 设置页「会话清理」列出所有已归档会话（含占用大小与所在目录），
 *     可逐条或批量删除，删除前有二次确认；
 *   - 侧边栏会话行的右键菜单在会话已归档时出现「删除归档会话」。
 *
 * 「已归档」的权威来源是 `workspaceRegistry.archivedSessionIds`（官方
 * 「归档会话」写的那份持久集合），**不是**目录名推测。只有同时满足
 * 「在归档集合里」且「不是活跃会话」的会话才会被删除。
 *
 * 删除粒度是**整个会话目录** `<sessionsRoot>/<projectKey>/<encodeSegment(id)>/`
 * ——与官方 `session-persistence-jsonl` 的 `sessionDir()` 一致。因此删除的
 * 不只是日志，还包括该会话目录下的其它产物（附件、检查点等）。这一点在
 * UI 的确认弹窗里如实告知。
 *
 * 数据通道是本插件自己的 fenced 前缀路由 `POST /session-cleanup/<endpoint>`：
 *   getConfig      读取当前配置
 *   setConfig      写入配置
 *   resetConfig    恢复默认
 *   listArchived   列出已归档会话（带大小、目录、活跃标记）
 *   deleteArchived 物理删除指定已归档会话（`{ ids: string[] }`）
 *
 * dsh 0.1.5-rc.1 起 `ctx.connection.rpc.handle` 对连接包之外的插件必然抛
 * `cannot get property "webServer" without inject`，所以传输一律走
 * webServer 上自注册的前缀路由（见 createRpcRoute）。
 */
import { homedir } from 'node:os'
import { join, resolve, sep, isAbsolute, dirname } from 'node:path'
import { readdir, rm, stat } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'

export const name = 'session-cleanup'

export const SETTINGS_NAMESPACE = 'session-cleanup'

/**
 * Settings schema.
 *
 * 自动清理的字段已全部移除（用户要求不再自动删会话），只剩两个：
 *   enabled    插件总开关；关闭后设置页隐藏、右键菜单项不出现、删除端点拒绝
 *   sessionsRoot 会话根目录（默认 $DSH_HOME/sessions）
 *
 * 导出名必须是 `Config`：Cordis loader 读的是 `plugin.Config`，换成别的名字
 * 会静默跳过校验。字段必须 `.volatile()`：设置分区由 `volatileForm(Config)`
 * 派生，未标记的字段会让整张卡「有卡片无表单」（`has no volatile fields`），
 * 且写入时报 `Config field "x" is not volatile`。
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  sessionsRoot: z.string().default('').volatile(),
})

/**
 * 把 schemastery `.volatile()` 的 `{ get }` 盒子解成普通值。
 * 不解盒子会导致 `enabled` 恒为真、任何算术都是 NaN。
 * @param config - 校验过的 entry 配置。
 */
export function plainConfig(config) {
  return Object.fromEntries(
    Object.entries(config ?? {}).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]),
  )
}

export const DEFAULTS = {
  enabled: true,
  sessionsRoot: undefined,
}

/**
 * 非会话的桶目录：官方 `_no-cwd` 不是某次会话的目录。
 * 隐藏项（`.` 开头）同样跳过。
 */
const NON_SESSION_DIRS = new Set(['_no-cwd'])

/**
 * `SessionId` -> 目录名，与官方 `encodeSegment` 同构。
 *
 * 必须自己实现一份：宿主端只 import schemastery/cosmokit，而这个转换要参与
 * 「绝不删活跃会话」的判断。安全字符 `A-Za-z0-9._-` 原样保留，其余按 UTF-16
 * 码元写成 `~XXXX`；`.` 与 `..` 特判防目录穿越。
 *
 * 官方实现见 `packages/session/session-persistence-jsonl/src/format.ts`，
 * 本函数与之逐字符一致，并已由测试守住。
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * 这个目录名是不是某个活跃会话的日志目录？
 *
 * 目录名可能是 id 本身（`session-<uuid>` 全是安全字符），也可能是它的
 * `encodeSegment` 形态。只比其中一种，另一种形态下的活跃会话会被误删，
 * 所以两种都接受——宁可少删，不可误删。
 * @param name - 磁盘上的目录名。
 * @param liveSessionIds - 当前活跃会话 id 集合。
 */
export function isLiveSessionDir(name, liveSessionIds) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (liveSessionIds.has(name)) return true
  for (const id of liveSessionIds) {
    if (typeof id !== 'string' || id.length === 0) continue
    if (encodeSegment(id) === name) return true
  }
  return false
}

/** 解析会话根目录: 配置 > $DSH_HOME/sessions > ~/.dsh/sessions */
export function resolveSessionsRoot(configured) {
  if (configured) return resolve(configured)
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/**
 * 统计一个会话目录的总字节数与最后修改时间。
 * @param dir - 会话目录绝对路径。
 */
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
 * 定位一个已归档会话的磁盘目录。
 *
 * 只做**按 id 的精确匹配**：候选名是 `id` 与其 `encodeSegment(id)` 两种形态，
 * 逐个项目目录查找。命中多个时视为歧义并全都返回，由调用方拒绝删除——
 * 删错一个会话的代价远高于删不掉。
 *
 * @param sessionsRoot - 会话根目录。
 * @param id - 会话 id（来自归档集合）。
 * @returns 命中的会话目录列表（通常 0 或 1 个）。
 */
export async function locateSessionDirs(sessionsRoot, id) {
  if (typeof id !== 'string' || id.length === 0) return []
  const wanted = new Set([id, encodeSegment(id)])
  const found = []
  const projects = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(sessionsRoot, project.name)
    const entries = await readdir(projectDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || !wanted.has(entry.name)) continue
      found.push({ project: project.name, name: entry.name, dir: join(projectDir, entry.name) })
    }
  }
  return found
}

/**
 * 列出全部已归档会话及其磁盘占用。
 *
 * `archivedIds` 必须是 `workspaceRegistry.archivedSessionIds`；本函数不自行
 * 推断归档状态。没有对应目录的归档记录也会列出（`missing: true`），
 * 让用户看到「归档但日志已不在」的残留，但这类条目不可删。
 *
 * @param sessionsRoot - 会话根目录。
 * @param archivedIds - 归档集合（权威来源）。
 * @param liveSessionIds - 活跃会话 id 集合，命中即标记 live 且不可删。
 * @returns `{ items, totalBytes, truncated }`。
 */
export async function listArchived(sessionsRoot, archivedIds, liveSessionIds = new Set()) {
  const items = []
  let totalBytes = 0
  for (const id of archivedIds) {
    const dirs = await locateSessionDirs(sessionsRoot, id)
    for (const found of dirs) {
      const { size, mtimeMs } = await statSessionDir(found.dir).catch(() => ({ size: 0, mtimeMs: 0 }))
      const live = isLiveSessionDir(found.name, liveSessionIds)
      items.push({
        id,
        project: found.project,
        dir: found.dir,
        size,
        mtimeMs,
        live,
        deletable: !live,
      })
      totalBytes += size
    }
    if (dirs.length === 0) {
      items.push({ id, project: null, dir: null, size: 0, mtimeMs: 0, live: false, deletable: false, missing: true })
    }
  }
  return { items, totalBytes }
}

/**
 * 删除一组已归档会话目录。
 *
 * 安全闸依次是：
 *   1. 会话必须在 `archivedIds` 里（否则视为未归档，拒绝）；
 *   2. 会话不是活跃会话（`liveSessionIds` 命中即拒绝）；
 *   3. 解析出的目录**唯一**且必须位于 `sessionsRoot` 之内（防穿越/防歧义）。
 * 任一不满足都只拒绝该条，不中断其余条目。
 *
 * @param sessionsRoot - 会话根目录。
 * @param ids - 要删除的会话 id。
 * @param archivedIds - 归档集合（权威来源）。
 * @param liveSessionIds - 活跃会话 id 集合。
 * @returns `{ removed, freedBytes, refused, errors }`。
 */
export async function deleteArchived(sessionsRoot, ids, archivedIds, liveSessionIds = new Set()) {
  const archivedSet = new Set(archivedIds)
  const root = resolve(sessionsRoot)
  const result = { removed: [], freedBytes: 0, refused: [], errors: [] }

  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0) {
      result.refused.push({ id, reason: 'bad-id' })
      continue
    }
    if (!archivedSet.has(id)) {
      result.refused.push({ id, reason: 'not-archived' })
      continue
    }
    const dirs = await locateSessionDirs(root, id)
    if (dirs.length === 0) {
      result.refused.push({ id, reason: 'no-directory' })
      continue
    }
    if (dirs.length > 1) {
      result.refused.push({ id, reason: 'ambiguous-directory' })
      continue
    }
    const target = dirs[0]
    if (isLiveSessionDir(target.name, liveSessionIds)) {
      result.refused.push({ id, reason: 'live' })
      continue
    }
    // 目录必须真的在根之内：任何穿越或异常都按拒绝处理。
    const resolvedDir = resolve(target.dir)
    if (resolvedDir !== root && !resolvedDir.startsWith(root + sep)) {
      result.refused.push({ id, reason: 'outside-root' })
      continue
    }
    if (dirname(resolvedDir) === root) {
      // 会话目录必须位于某个项目目录之下，不能就是根的直接子项之外的层级错误
      result.refused.push({ id, reason: 'outside-root' })
      continue
    }

    const { size } = await statSessionDir(resolvedDir).catch(() => ({ size: 0 }))
    try {
      await rm(resolvedDir, { recursive: true, force: true })
      result.removed.push({ id, dir: resolvedDir, size })
      result.freedBytes += size
    } catch (error) {
      result.errors.push({ id, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/** 把字节数格式化成便于阅读的字符串（宿主端报告用）。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

/** 渲染一次删除结果（供日志输出）。 */
export function summarizeDeletion(result) {
  const parts = [`removed=${result.removed.length} freed=${formatBytes(result.freedBytes)}`]
  if (result.refused.length > 0) {
    parts.push(`refused=${result.refused.length}(${result.refused.map((r) => `${r.id}:${r.reason}`).join(',')})`)
  }
  if (result.errors.length > 0) {
    parts.push(`errors=${result.errors.length}(${result.errors.map((e) => e.message).join(';')})`)
  }
  return parts.join(' ')
}

/**
 * 挂载可选的 settings 文档层。
 *
 * 0.2.x 的 `settings` 服务是 `SettingsForms`，**没有 `register()`**：
 * 分区由 loader entry 的 `Config` 派生（命名空间就是 entry id），读用
 * `describe()`，写走 `update(ns, patch)` / `replace(ns, section)`。
 * 每次接受的写入都会重新发 `settings/document-updated`。
 *
 * 首次 `describe()` 故意不捕异常：设置服务存在却无法 describe，正是
 * 「路由先于设置桥注册」要保护的那种失败。之后读失败则软回退到组合层配置。
 *
 * @param ctx - 插件上下文。
 * @param hooks - `{ entryConfig, setSource, setApi, onChange }`。
 * @param isUnloading - 卸载探针，避免卸载期间响应文档事件。
 */
function installSettingsBridge(ctx, hooks, isUnloading = () => false) {
  ctx.inject(['settings'], (sctx) => {
    const settings = sctx.settings
    const read = () => {
      try {
        const row = settings.describe().find((form) => form.ns === SETTINGS_NAMESPACE)
        return row === undefined ? undefined : row.value
      } catch (error) {
        sctx.logger?.warn?.(`session-cleanup: settings describe failed: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }
    settings.describe()
    hooks.setSource(() => read() ?? hooks.entryConfig())
    sctx.on('settings/document-updated', (ns) => {
      if (ns !== SETTINGS_NAMESPACE || isUnloading()) return
      hooks.onChange()
    })
    hooks.setApi({
      update: (fields) => settings.update(SETTINGS_NAMESPACE, fields),
      replace: (section) => settings.replace(SETTINGS_NAMESPACE, section),
    })
    hooks.onChange()
  })
}

/** RPC 失败信封。 */
function configError(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

/**
 * 本地 RPC：webServer 上自注册的前缀路由，替代 `ctx.connection.rpc`。
 *
 * 围栏与官方 Connection 同构：带 `Origin` 时必须与 `Host` 同源；只接受
 * POST；强制 `content-type: application/json`（跨站 POST 必带自己的 Origin，
 * 而 JSON 正文会触发我们从不回应的预检，所以用户随便访问的页面碰不到它）。
 * 信封与旧 RPC handler 完全一致。
 *
 * @param path - 前缀路由路径，如 `/session-cleanup`。
 * @param handle - `async (endpoint, payload) => envelope`。
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
 * Cordis 插件入口。
 *
 * 本插件**不注册任何定时器**：装载后除了读配置、挂路由，什么都不做。
 * 删不删会话完全由用户点击决定。
 *
 * `sessions` / `workspaceRegistry` / `webServer` 都是**静态** inject：
 * 用户层热重载后动态 `ctx.inject` 那条不会重新激活，而静态声明才是让
 * `webServer` 在 `apply` 里一定就绪的唯一办法（Cordis 并行挂载各行，
 * HTTP 载体绑定得比服务晚，用 `ctx.get('webServer')` 会竞态到 undefined，
 * 静默丢掉整个传输通道）。
 * `settings` 保持动态 inject —— 它是可选增强，缺失时回退到组合层配置。
 */
export const inject = ['sessions', 'workspaceRegistry', 'webServer']

export function apply(ctx, config = {}) {
  // `.volatile()` 字段以 `{ get }` 盒子到达；解一次，后续都看普通值。
  const entryConfig = { ...DEFAULTS, ...plainConfig(config) }

  const logger = ctx.logger
  /** 当前权威配置：设置文档 > 组合层 entry。 */
  let source = () => entryConfig
  let settingsApi = null
  let disposed = false

  const currentConfig = () => ({ ...DEFAULTS, ...plainConfig(toPlain(source())) })

  /** 归档集合：官方「归档会话」写的那份持久集合，唯一权威来源。 */
  const archivedIds = () => {
    const registry = ctx.workspaceRegistry
    const ids = registry?.archivedSessionIds
    return Array.isArray(ids) ? [...ids] : []
  }

  /** 活跃会话 id 集合。 */
  const liveIds = () => new Set(ctx.sessions.list().map((s) => s.id))

  const handleEndpoint = async (endpoint, payload) => {
    const cfg = currentConfig()
    if (endpoint === 'getConfig') {
      return { ok: true, value: cfg }
    }
    if (settingsApi === null && (endpoint === 'setConfig' || endpoint === 'resetConfig')) {
      return configError('settings-unavailable', 'settings service is not ready yet')
    }
    if (endpoint === 'setConfig') {
      const fields = payload?.args?.fields
      if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
        return configError('bad-request', 'fields must be a plain object')
      }
      try {
        await settingsApi.update(fields)
        return { ok: true, value: currentConfig() }
      } catch (error) {
        return configError('settings-rejected', String(error?.message ?? error))
      }
    }
    if (endpoint === 'resetConfig') {
      try {
        await settingsApi.replace({})
        return { ok: true, value: currentConfig() }
      } catch (error) {
        return configError('settings-rejected', String(error?.message ?? error))
      }
    }
    if (endpoint === 'listArchived') {
      if (!cfg.enabled) return { ok: true, value: { items: [], totalBytes: 0, disabled: true } }
      const sessionsRoot = resolveSessionsRoot(cfg.sessionsRoot)
      const listing = await listArchived(sessionsRoot, archivedIds(), liveIds())
      return { ok: true, value: { ...listing, sessionsRoot } }
    }
    if (endpoint === 'deleteArchived') {
      if (!cfg.enabled) return configError('disabled', 'session cleanup is turned off')
      const ids = payload?.args?.ids
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) {
        return configError('bad-request', 'ids must be a non-empty array of session ids')
      }
      const sessionsRoot = resolveSessionsRoot(cfg.sessionsRoot)
      const result = await deleteArchived(sessionsRoot, ids, archivedIds(), liveIds())
      // 目录没了，id 若仍留在归档集合里就会变成一个永远删不掉的幽灵条目
      // （列表只能把它显示成「磁盘上已无此会话目录」）。删除成功后顺手取消
      // 归档，让归档集合与磁盘保持一致。这一步是尽力而为：失败不影响删除
      // 本身已完成的事实，只记一条 warn。
      for (const removed of result.removed) {
        try {
          await ctx.workspaceRegistry?.unarchiveSession?.(removed.id)
        } catch (error) {
          logger?.warn?.(`session-cleanup: could not unarchive ${removed.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (disposed) return { ok: true, value: result }
      if (result.removed.length > 0) {
        logger?.info?.(`session-cleanup: ${summarizeDeletion(result)}`)
      }
      if (result.errors.length > 0) {
        logger?.warn?.(`session-cleanup: delete errors: ${result.errors.map((e) => `${e.id}: ${e.message}`).join(' | ')}`)
      }
      return { ok: true, value: result }
    }
    return configError('bad-request', `unknown endpoint: ${endpoint}`)
  }

  // 传输先落地：Cordis 在 apply 抛错时会回滚此前注册的每个 effect，而设置
  // 接线是最容易抛错的一步。路由排在设置桥之前，设置挂掉也不会带走通道。
  ctx.effect(() => ctx.webServer.register(createRpcRoute('/session-cleanup', handleEndpoint)), 'session-cleanup: /session-cleanup rpc route')

  installSettingsBridge(ctx, {
    entryConfig: () => entryConfig,
    setSource: (next) => { source = next },
    setApi: (api) => { settingsApi = api },
    // 配置变化不再需要重建定时器（没有定时器了）。
    onChange: () => {},
  }, () => disposed)

  ctx.effect(() => () => {
    disposed = true
  })
}

/**
 * sources 可能返回已被解盒的普通对象，也可能返回盒子；这里统一兜底，
 * 避免 `plainConfig` 收到已解的对象时重复处理。
 * @param value - 配置来源的返回值。
 */
function toPlain(value) {
  if (value === null || typeof value !== 'object') return {}
  return value
}