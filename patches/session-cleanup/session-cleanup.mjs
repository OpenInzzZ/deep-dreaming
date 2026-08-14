/**
 * session-cleanup —— DeepSeek Harness 会话日志自动清理插件
 *
 * 按保留天数 / 总大小上限定期清理 $DSH_HOME/sessions 下的归档会话，
 * 跳过当前活跃会话。通过 cordis.patch.yml 的 insert 装载。
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

export const name = 'session-cleanup'

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
 * Cordis 插件入口: 注入 sessions 服务, 启动时立即清理一次, 之后按
 * intervalMinutes 周期清理。定时器注册为 effect, 插件卸载时自动释放。
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (!cfg.enabled) return

  return ctx.inject(['sessions'], (ctx) => {
    const sessionsRoot = resolveSessionsRoot(cfg.sessionsRoot)
    const logger = ctx.logger
    const tick = async (reason) => {
      const liveIds = new Set(ctx.sessions.list().map((s) => s.id))
      const result = await runCleanup(sessionsRoot, cfg, liveIds)
      logger.info(`[${reason}] ${summarize(result)}`)
      if (result.errors.length > 0) logger.warn(`cleanup errors: ${result.errors.join(' | ')}`)
    }

    // 启动即清理一次; 失败不阻断启动
    void tick('startup').catch((e) => logger.warn(`startup cleanup failed: ${e.message}`))

    // 周期清理; effect 卸载时清除定时器
    return ctx.effect(() => {
      const timer = setInterval(() => {
        void tick('interval').catch((e) => logger.warn(`interval cleanup failed: ${e.message}`))
      }, cfg.intervalMinutes * 60_000)
      return () => clearInterval(timer)
    })
  })
}
