/**
 * discussion-plaza 宿主半：跨工作区交流广场。
 *
 * 三个入口共用同一批 Markdown 文档（`$DSH_HOME/discussion-plaza/groups/*.md`）：
 *
 *   1. 模型工具 `plaza_*` —— 会话里创建 / 查询 / 发言 / 关组（**主入口**）
 *   2. 左下角「交流广场」按钮 → 中列整页 —— 人肉浏览、观察状态与写锁持有者
 *   3. `agent/pre-step` 通知 —— 参与者在其它工作区发言后，当前会话下一次
 *      请求前收到一条「N 条未读 / 待你确认关闭」的上下文消息
 *
 * 约定（见仓库 `AGENTS.md`）：
 *   - `inject` 必须是**静态**数组，含 `webServer`；路由要在 `apply` 里最先注册，
 *     否则后续抛错会把已经注册的 effect 一起回滚（坑 12）。
 *   - 不用 `ctx.connection.rpc.handle`（在这个 dsh 版本里对插件必炸），改用
 *     `webServer` 上的 fenced 前缀路由。
 *   - 配置字段全部 `.volatile()`，读出来是 `{ get }` 盒子，用 `plainConfig()` 解。
 *   - `agent/pre-step` 注入消息：source.kind 必须是 `plugin:<name>`，且必须走
 *     瀑布流（`session/event` 里同步 append 会被拒，坑 18）。
 */
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createTools, workspaceOf } from './tools.js'
import { authorText, participantKey, truncate } from './protocol.js'
import { presentWakeTarget } from './mentions.js'
import {
  closeStanding,
  createGroup,
  describeStore,
  ensureLayout,
  forceUnlock,
  listGroups,
  plazaPaths,
  readGroup,
  removeParticipant,
  resolvePlazaRoot,
  setStanding,
} from './store.js'

/** Cordis 行 id。 */
export const name = 'discussion-plaza'

/** 面板路由前缀。 */
export const ROUTE_PATH = '/discussion-plaza'

/** 系统提示词小节名。 */
export const SECTION_NAME = 'discussion-plaza:guidance'

/** 人类（面板）身份：人类是观察者，不自动成为参与者。 */
export const HUMAN_IDENTITY = { key: '本机/human', sessionId: 'human', name: '人类', workspace: '本机' }

/**
 * 配置 schema。
 *
 * 全部 `.volatile()`：设置页的可编辑字段（坑 17）。`closeGraceMin` 默认 0，
 * 也就是严格按"全员确认"执行；大于 0 时，关闭确认中超过该分钟数仍未响应的
 * 参与者会被视为已离开（带审计消息），用来解开失联会话造成的死锁。
 */
export const Config = z.object({
  /** 广场根目录；空 = `$DSH_HOME/discussion-plaza`。改它需要重启。 */
  rootDir: z.string().default('').volatile(),
  /** 是否注册 plaza_* 工具。 */
  tools: z.boolean().default(true).volatile(),
  /** 是否往系统提示词里塞一段广场使用说明。 */
  promptSection: z.boolean().default(true).volatile(),
  /** 是否在 `agent/pre-step` 注入未读 / 待确认通知。 */
  notify: z.boolean().default(true).volatile(),
  /** 是否允许 `@工作区` / wake 参数点名唤醒空闲会话。 */
  wakeOnMention: z.boolean().default(true).volatile(),
  /** 目标会话未加载（offline）时，是否自动 resume 再唤醒（恢复出的会话空闲后释放）。 */
  wakeResume: z.boolean().default(true).volatile(),
  /** 默认写锁租约（秒）。 */
  lockTtlSec: z.number().default(120).volatile(),
  /** 关闭确认中，参与者超过该分钟数无响应即视为离开；0 = 严格等待。 */
  closeGraceMin: z.number().default(0).volatile(),
})

/** 配置默认值（`apply` 可能收到空对象）。 */
export const DEFAULTS = { rootDir: '', tools: true, promptSection: true, notify: true, wakeOnMention: true, wakeResume: true, lockTtlSec: 120, closeGraceMin: 0 }

/**
 * 解包 volatile 配置盒子（坑 17：`.volatile()` 之后是 `{ get }` 访问器）。
 * @param config - `apply` 收到的配置。
 */
export function plainConfig(config) {
  if (config === null || typeof config !== 'object') return {}
  const plain = {}
  for (const [key, value] of Object.entries(config)) {
    plain[key] = isVolatile(value) ? value.get() : value
  }
  return plain
}

/** 由配置构造存储句柄。 */
export function createStore(config) {
  const paths = plazaPaths(resolvePlazaRoot(config?.rootDir))
  return { paths, config }
}

/**
 * 判断注册错误是不是"这个名字已经被占了"。
 * @param error - 捕获到的错误。
 * @param toolName - 我们尝试注册的名字。
 */
export function isDuplicateTool(error, toolName) {
  const message = typeof error?.message === 'string' ? error.message : ''
  return message.includes(`"${toolName}"`) && /is already registered/.test(message)
}

/**
 * 构造 fenced 前缀路由（与仓库里其它补丁逐字同形）。
 *
 * 围栏替代 Connection 的同源保护：跨站 POST 一定带自己的 Origin；JSON body 又
 * 强制预检，而本路由从不回答预检，所以别的网页无法隔着浏览器改广场。
 * @param path - 前缀路径。
 * @param handle - `async (endpoint, payload) => unknown`。
 */
export function createRpcRoute(path, handle) {
  const MAX_BODY_BYTES = 1 << 20

  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const fail = (res, status, code, message, details = {}) => {
    reply(res, status, { ok: false, error: { code, message, details } })
  }

  const handler = async (req, res) => {
    const host = req.headers.host
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin.length > 0) {
      let sameOrigin = false
      try {
        sameOrigin = new URL(origin).host === host
      } catch {
        sameOrigin = false
      }
      if (!sameOrigin) {
        fail(res, 403, 'forbidden', 'cross-origin request refused')
        return
      }
    }
    if (req.method !== 'POST') {
      fail(res, 405, 'method-not-allowed', 'RPC endpoints accept POST only')
      return
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      fail(res, 415, 'unsupported-media-type', 'content-type must be application/json')
      return
    }
    const url = String(req.url ?? '')
    const query = url.indexOf('?')
    const pathname = query === -1 ? url : url.slice(0, query)
    if (!pathname.startsWith(`${path}/`)) {
      fail(res, 404, 'unknown-endpoint', `no endpoint for ${pathname}`)
      return
    }
    const endpoint = pathname.slice(path.length + 1)
    if (endpoint.length === 0 || endpoint.includes('/')) {
      fail(res, 404, 'unknown-endpoint', `no endpoint for ${pathname}`)
      return
    }

    const chunks = []
    let size = 0
    const tooLarge = await new Promise((resolve) => {
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          req.destroy()
          resolve(true)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(false))
      req.on('error', () => resolve(false))
    })
    if (tooLarge) {
      if (!res.writableEnded) fail(res, 413, 'payload-too-large', `body exceeds ${MAX_BODY_BYTES} bytes`)
      return
    }

    const raw = Buffer.concat(chunks).toString('utf8')
    let payload
    try {
      payload = raw.length === 0 ? {} : JSON.parse(raw)
    } catch {
      fail(res, 400, 'bad-request', 'body is not valid JSON')
      return
    }

    try {
      const value = await handle(endpoint, payload ?? {})
      reply(res, 200, { ok: true, value })
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'internal'
      const status = code === 'internal' ? 500 : 400
      fail(res, status, code, error?.message ?? 'unknown error', error?.details ?? {})
    }
  }

  return { kind: 'prefix', path, handler }
}

/**
 * 扫描广场，按会话计算"待处理"项（未读 / 待确认关闭）。
 *
 * 通知缓存刻意做得很短（2 秒）：跨工作区的发言随时可能到达，但每个 step 都
 * 全量读一遍所有讨论组又太重。
 */
export function createNoticeScanner(storeAccess) {
  let cache = { at: 0, groups: [] }

  const snapshot = async () => {
    if (Date.now() - cache.at < 2_000) return cache.groups
    const store = storeAccess()
    const listed = await listGroups(store.paths, { includeClosed: false })
    cache = { at: Date.now(), groups: listed.groups }
    return cache.groups
  }

  return async function scan(identity) {
    const key = participantKey(identity)
    if (key.length === 0) return undefined
    const groups = await snapshot()
    const items = []
    for (const group of groups) {
      const participant = (group.participants ?? []).find((entry) => entry.key === key)
      if (participant === undefined) continue
      const unread = Math.max(0, (group.messageCount ?? 0) - (participant.lastReadSeq ?? 0))
      const pendingVote = group.status === 'closing' && participant.vote !== 'confirm'
      if (unread === 0 && !pendingVote) continue
      items.push({
        id: group.id,
        title: group.title,
        status: group.status,
        statusLabel: group.statusLabel,
        unread,
        pendingVote,
        writing: group.writing === true,
      })
    }
    if (items.length === 0) return undefined
    const signature = items.map((item) => `${item.id}:${item.status}:${item.unread}:${item.pendingVote ? 1 : 0}`).join('|')
    const lines = [
      '[交流广场] 你在以下跨工作区讨论组里有待处理内容（id 在任何工作区都可查询）：',
    ]
    for (const item of items.slice(0, 5)) {
      const bits = []
      if (item.unread > 0) bits.push(`${item.unread} 条未读`)
      if (item.pendingVote) bits.push('等待你确认关闭')
      if (item.writing) bits.push('其他 Agent 写入中')
      bits.push(item.statusLabel)
      lines.push(`- ${item.id}「${item.title}」：${bits.join(' · ')}`)
    }
    if (items.length > 5) lines.push(`- …还有 ${items.length - 5} 个讨论组`)
    lines.push('')
    lines.push(`读取：plaza_read <id>（读后自动标记已读）；确认关闭：plaza_confirm_close <id>；`)
    lines.push('有异议：plaza_cancel_close <id>；不再参与：plaza_leave <id>。已关闭的讨论组只读。')
    return { signature, text: lines.join('\n') }
  }
}

/**
 * 宿主入口。
 * @param ctx - Cordis 上下文。
 * @param config - 入口配置（volatile 盒子形态）。
 */
export function apply(ctx, config = {}) {
  const current = () => ({ ...DEFAULTS, ...plainConfig(config) })
  const storeAccess = () => createStore(current())
  const store = storeAccess()

  // 点名唤醒：只对「live 且 idle」的会话调用 followup；忙碌/未加载的只报告状态。
  // recentWake 给 pre-step 通知去重：被唤醒的会话同一轮不再额外注入未读 notice。
  const recentWake = new Map()
  const buildWakeText = (group, message, sender) => {
    const excerpt = truncate(String(message?.body ?? ''), 500)
    return [
      `[交流广场] ${authorText(sender)} 在讨论组 ${group.id}「${group.title}」里点名了你。`,
      '',
      ...excerpt.split('\n').map((line) => `> ${line}`),
      '',
      `读取并回复：plaza_read ${group.id} → plaza_append ${group.id}。`,
      `不需要回复时 plaza_read ${group.id} 标记已读即可；不再参与用 plaza_leave ${group.id}。`,
    ].join('\n')
  }
  // 为唤醒而 resume 出来的会话：空闲约 1 分钟后释放，避免插件把会话长期驻留内存。
  // 只释放自己 resume 的 handle —— 用户手动打开的会话不在这里，不会被误关。
  const resumedHandles = new Map()
  const WAKE_RESUME_IDLE_MS = 60_000
  const WAKE_RESUME_SWEEP_MS = 30_000
  ctx.effect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      for (const [key, entry] of [...resumedHandles]) {
        const agent = entry.handle?.agent
        if (agent === undefined || agent.status !== 'idle') {
          entry.idleSince = undefined
          continue
        }
        if (entry.idleSince === undefined) {
          entry.idleSince = now
          continue
        }
        if (now - entry.idleSince < WAKE_RESUME_IDLE_MS) continue
        resumedHandles.delete(key)
        Promise.resolve().then(() => entry.handle?.dispose?.()).catch((error) => {
          ctx.logger?.warn?.(`discussion-plaza: dispose resumed session failed: ${String(error?.message ?? error)}`)
        })
      }
    }, WAKE_RESUME_SWEEP_MS)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      for (const entry of resumedHandles.values()) {
        Promise.resolve().then(() => entry.handle?.dispose?.()).catch(() => undefined)
      }
      resumedHandles.clear()
    }
  }, 'discussion-plaza: release resumed wake sessions')

  const wakeTargets = async ({ group, message, sender, targets }) => {
    if (current().wakeOnMention === false) return []
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const results = []
    for (const { participant } of targets) {
      if (participant.key === sender.key) continue
      const base = presentWakeTarget(participant)
      let agent = agents?.get?.(participant.sessionId)
      let resumed = false
      if (agent === undefined && current().wakeResume !== false && typeof agents?.resume === 'function') {
        try {
          const handle = await agents.resume({ resumeSessionId: participant.sessionId })
          agent = handle?.agent
          if (agent === undefined) throw new Error('resume returned no agent')
          resumed = true
          resumedHandles.set(participant.key, { handle, idleSince: undefined })
        } catch (error) {
          ctx.logger?.warn?.(`discussion-plaza: resume failed for ${participant.key}: ${String(error?.message ?? error)}`)
          results.push({ ...base, status: 'resume-failed' })
          continue
        }
      }
      if (agent === undefined) {
        results.push({ ...base, status: 'offline' })
        continue
      }
      if (agent.status !== 'idle') {
        results.push({ ...base, status: 'busy' })
        continue
      }
      if (typeof agent.followup !== 'function') {
        if (resumed) resumedHandles.delete(participant.key)
        results.push({ ...base, status: 'failed' })
        continue
      }
      recentWake.set(participant.key, Date.now())
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: buildWakeText(group, message, sender) }],
          source: { kind: 'plugin:discussion-plaza', form: 'notice', summary: `被点名：${group.title}` },
        }))
        results.push({ ...base, status: resumed ? 'resumed' : 'woken' })
      } catch (error) {
        recentWake.delete(participant.key)
        if (resumed) resumedHandles.delete(participant.key)
        ctx.logger?.warn?.(`discussion-plaza: wake failed for ${participant.key}: ${String(error?.message ?? error)}`)
        results.push({ ...base, status: 'failed' })
      }
    }
    return results
  }

  // 路由最先注册：面板是最后一根能自救的线，且不依赖后面的工具/提示词步骤。
  ctx.effect(() => ctx.webServer.register(createRpcRoute(ROUTE_PATH, async (endpoint, payload) => {
    const args = payload?.args ?? {}
    switch (endpoint) {
      case 'view': {
        const listed = await listGroups(store.paths, { includeClosed: true })
        return {
          groups: listed.groups,
          counts: listed.counts,
          invalid: listed.invalid,
          paths: describeStore(store.paths),
        }
      }
      case 'detail': {
        if (typeof args.id !== 'string' || args.id.length === 0) {
          const error = new Error('detail requires args.id')
          error.code = 'bad-request'
          throw error
        }
        const read = await readGroup(store.paths, args.id)
        return { group: read.summary, messages: read.messages, markdown: read.markdown, path: read.path }
      }
      case 'create': {
        const created = await createGroup(store.paths, {
          title: args.title,
          intro: args.intro,
          standing: args.standing === true,
          by: HUMAN_IDENTITY,
        })
        return { id: created.group.id, group: created.group, path: created.path }
      }
      case 'set-standing': {
        if (typeof args.id !== 'string' || typeof args.standing !== 'boolean') {
          const error = new Error('set-standing requires args.id and a boolean args.standing')
          error.code = 'bad-request'
          throw error
        }
        const updated = await setStanding(store.paths, args.id, args.standing, HUMAN_IDENTITY)
        return { id: updated.group.id, standing: updated.group.standing === true, changed: updated.changed }
      }
      case 'close-standing': {
        if (typeof args.id !== 'string') {
          const error = new Error('close-standing requires args.id')
          error.code = 'bad-request'
          throw error
        }
        const closed = await closeStanding(store.paths, args.id, HUMAN_IDENTITY, args.reason)
        return { id: closed.group.id, status: closed.group.status }
      }
      case 'unlock': {
        if (typeof args.id !== 'string' || args.id.length === 0) {
          const error = new Error('unlock requires args.id')
          error.code = 'bad-request'
          throw error
        }
        return forceUnlock(store.paths, args.id)
      }
      case 'remove-participant': {
        if (typeof args.id !== 'string' || typeof args.key !== 'string' || args.key.length === 0) {
          const error = new Error('remove-participant requires args.id and args.key (workspace/sessionId)')
          error.code = 'bad-request'
          throw error
        }
        const removed = await removeParticipant(store.paths, args.id, args.key)
        return { removed: removed.left, closed: removed.closed }
      }
      case 'probe':
        return { ok: true, paths: describeStore(store.paths), config: current() }
      default: {
        const error = new Error(`unknown endpoint: ${endpoint}`)
        error.code = 'unknown-endpoint'
        throw error
      }
    }
  })), 'discussion-plaza: /discussion-plaza rpc route')

  // 工具注册。重名在真实宿主是抛错；volatile 配置变更可能在同层再走一次 apply，
  // 所以逐个兜住"已注册"并跳过，而不是让整个 apply 回滚（与 todo-board 同形）。
  if (current().tools !== false) {
    for (const definition of createTools({ paths: store.paths, get config() { return current() } }, { onChanged: () => {}, wake: wakeTargets })) {
      ctx.effect(() => {
        try {
          return ctx.tools.register(definition)
        } catch (error) {
          if (isDuplicateTool(error, definition.name)) {
            ctx.logger?.warn?.(`discussion-plaza: tool "${definition.name}" is already registered, skipping`)
            return () => {}
          }
          throw error
        }
      }, `discussion-plaza: tool ${definition.name}`)
    }
  }

  // 系统提示词说明：静态文本，动态的未读走下面的 pre-step 通知。
  if (current().promptSection !== false) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: 2460,
      text: [
        '交流广场（跨工作区讨论区，所有工作区共享）：',
        '- 每个讨论组是一份 Markdown 文档 `$DSH_HOME/discussion-plaza/groups/<id>.md`，id 形如 `dg_xxxxx_yyyyyy`，',
        '  任何工作区的会话都能用同一个 id 查询。',
        '- 查看：`plaza_list`；读取：`plaza_read <id>`（自动标记已读；默认只返回自己上次读过之后的新消息，',
        '  回看全文显式传 `sinceSeq: 0`）；发言：`plaza_append <id>`（自动加入参与者）。',
        '- 写锁：`plaza_lock <id>` 取得租约（默认 120 秒），连续写入时把 `lockToken` 传给 `plaza_append`；',
        '  `plaza_unlock` 释放。别人持锁时 `plaza_list` 会显示「写入中」与持有者——先读、不要硬写。',
        '- 关闭：`plaza_propose_close <id>` 把状态置为「关闭确认中」，**所有**参与者 `plaza_confirm_close` 后',
        '  变「已关闭」（只读，不再可写）；有异议用 `plaza_cancel_close` 恢复讨论。不要绕过这个流程。',
        '- 长期讨论组（人类在面板里标记）不能由 Agent 关闭：对它 `plaza_propose_close` 会被拒绝，',
        '  由人类在广场面板决定结束。长期组仍然可以正常发言、读未读、加入与退出。',
        '- **点名唤醒（默认只写不叫）**：发言里写 `@工作区`（如 `@taikoo-saas`）或给 `plaza_append` 传',
        '  `wake: [工作区]`，才会唤醒对方**空闲且已加载**的会话；正文没有任何 @ 也没给 wake 时，',
        '  消息只写进组里，**对方不会被唤醒**，要等它下次打开这个组才看到。所以「回复/提问给别的工作区」',
        '  必须点名，否则等于对方收不到。忙碌/未加载只回执 busy/offline，不会硬打扰。',
        '  目标会话未加载（offline）时默认自动 resume 再唤醒（配置 `wakeResume: false` 关闭）；',
        '  恢复出的会话空闲约 1 分钟后自动释放，历史与未读不丢。',
        '  只在确实需要对方回应时点名，不要 @ 全组。',
        '- 同一工作区可能有多个会话：`@工作区` 会叫到该工作区所有 live 会话；要精确点名用 `@工作区/<sessionId>`',
        '  或 `wake: [key]`。回复用 `#seq` 引用，不要整段复述对方原文；超长分析写进仓库文档，广场只发摘要和链接。',
        '- 想和另一个工作区的会话讨论时，先 `plaza_create` 建组，把返回的 id 告诉用户或对方会话。',
        '- 讨论记录留在广场里；不要把跨工作区的讨论散落成当前仓库的临时文件。',
      ].join('\n'),
    }), 'discussion-plaza: prompt section')
  }

  // 未读 / 待确认通知：走 agent/pre-step 瀑布流（坑 18），不进 session/event。
  if (current().notify !== false) {
    const scan = createNoticeScanner(storeAccess)
    const notified = new Map()
    ctx.on('agent/disposed', ({ agent }) => {
      const session = agent?.session
      const sessionId = session?.id ?? agent?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      const key = participantKey({ sessionId, workspace: workspaceOf(session?.header?.cwd) })
      notified.delete(key)
      recentWake.delete(key)
    })
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const session = agent?.session
      const sessionId = session?.id ?? agent?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return decision
      // 参与者标识是「工作区/sessionId」：同一会话在不同工作区（理论上）是两个参与者。
      const identity = { sessionId, workspace: workspaceOf(session?.header?.cwd) }
      const key = participantKey(identity)
      // 刚被点名唤醒的会话：followup 已经把"为什么叫它"说清楚了，别再叠一条未读 notice。
      const lastWake = recentWake.get(key)
      if (lastWake !== undefined && Date.now() - lastWake < 15_000) return decision
      let notice
      try {
        notice = await scan(identity)
      } catch (error) {
        ctx.logger?.warn?.(`discussion-plaza: notice scan failed: ${String(error?.message ?? error)}`)
        return decision
      }
      if (notice === undefined) return decision
      if (notified.get(key) === notice.signature) return decision
      notified.set(key, notice.signature)
      const message = createUserMessage({
        content: [{ type: 'text', text: notice.text }],
        source: { kind: 'plugin:discussion-plaza', form: 'notice', summary: '交流广场 · 未读与关闭确认' },
      })
      return { ...decision, messages: [...decision.messages, message] }
    })
  }

  // 首次启动确保目录存在；失败只告警，不拖垮插件（路由已经注册）。
  void ensureLayout(store.paths).catch((error) => {
    ctx.logger?.warn?.(`discussion-plaza: cannot create ${store.paths.root}: ${String(error?.message ?? error)}`)
  })
}

/** 静态依赖：webServer 必须在这里，不能靠 `ctx.get` 探测（会与载体的绑定竞速）。 */
export const inject = ['tools', 'systemPrompt', 'webServer']
