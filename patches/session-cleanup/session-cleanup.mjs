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
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readdir, rm, stat } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'

export const name = 'session-cleanup'

export const SETTINGS_NAMESPACE = 'session-cleanup'

/** Settings schema: defaults here are the floor; the entry config and the
 * user document layer resolve above them. */
export const ConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxAgeDays: z.number().default(30),
  maxTotalMB: z.number().default(1024),
  keepSessions: z.number().default(5),
  intervalMinutes: z.number().default(360),
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
  if (cfg.maxTotalMB > 0) {
    const cap = cfg.maxTotalMB * 1024 * 1024
    let total = candidates.reduce((sum, c) => sum + c.size, 0)
    for (const c of [...candidates].reverse()) {
      if (total <= cap) break
      if (remove.has(c.key)) continue
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
 */
function registerConfigSection(ctx, ns, schema, entry, hooks, onScope) {
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(ns, schema, { base: entry })
    hooks.setSource(() => scope.get())
    sctx.effect(() => () => {
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => { hooks.onChange() })
    onScope(scope)
  })
}

/** RPC failure envelope for the config channel. */
function configError(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * Cordis 插件入口: 注入 sessions 服务, 启动时立即清理一次, 之后按
 * intervalMinutes 周期清理。定时器注册为 effect, 插件卸载时自动释放。
 * 配置经 dsh-settings 注册(namespace `session-cleanup`), 设置变更时
 * (onChange) 按新配置重建定时器 —— 即时生效。
 * 配置经 /session-cleanup RPC 通道读写(getConfig/setConfig/resetConfig),由
 * 插件管理页的配置卡片调用 —— 不受 dsh 设置白名单(apiproxy)限制。
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (!cfg.enabled) return

  return ctx.inject(['sessions', 'connection'], (ctx) => {
    const logger = ctx.logger
    /** 当前权威配置: 设置文档 > 组合层 entry; settings 缺失时回退 entry。 */
    let source = () => ({ ...DEFAULTS, ...config })
    let configScope = null
    let timer = null
    let disposed = false

    const tick = async (reason, cfg) => {
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

    registerConfigSection(ctx, SETTINGS_NAMESPACE, ConfigSchema, config, {
      setSource: (current) => { source = current },
      onChange: start,
    }, (scope) => { configScope = scope })

    start()

    ctx.connection.rpc.handle('/session-cleanup', async (endpoint, payload) => {
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
    }, { authority: 'loopback' })

    return ctx.effect(() => () => {
      disposed = true
      stop()
    })
  })
}
