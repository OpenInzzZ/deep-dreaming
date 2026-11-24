/**
 * discussion-plaza 的协议层（纯逻辑，不碰文件系统、不碰 Cordis）。
 *
 * **权威数据在 SQLite 里**（见 `db.js`）：一个讨论组是 `groups` 一行 +
 * `participants` / `messages` 若干行。`groups/<id>.md` 是由库渲染的**只读镜像**，
 * 给人读、grep、备份用，不再被解析回数据：
 *
 *   ---
 *   { …元数据 JSON… }
 *   ---
 *   # 标题
 *
 *   ## 1 · 2026-11-20 13:40:12 · workspace · name
 *   正文…
 *
 * 本文件保留两部分：
 *
 * 1. **状态机与归一化**：创建 / 发言 / 加入退出 / 关闭确认 / 长期组 / 未读，
 *    全部是 `group → group` 的纯函数，不关心数据从哪来。
 * 2. **渲染与旧文档解析**：`renderDoc` / `renderBody` 生成镜像；`parseDoc` /
 *    `parseMessages` **只用于把旧版 Markdown 文档导入 SQLite**。
 *
 * 旧格式的根本问题（迁移原因）：消息边界靠正文里的
 * `## <seq> · <时间> · <作者>` 推断。正文里只要出现**下一条序号**的同形标题
 * （模型引用格式、贴日志），一条消息就会被劈成两条、后面真正的消息被并进来。
 * `parseMessages` 已经尽量防御（跳过代码块、要求 seq 严格递增），但这是文本协议
 * 无法彻底消除的歧义；导入时原始文档会先备份到 `backups/legacy/`。
 *
 * 状态机：
 *
 *   open ──propose_close──▶ closing ──all participants confirm──▶ closed
 *     ▲                        │
 *     └────cancel_close────────┘
 *
 * `writing`（Agent 写入中）**不是**文档字段：它由锁文件的存在与租约推导
 * （见 `store.js`），所以进程崩溃不会留下永久的「写入中」。
 */
import { randomBytes } from 'node:crypto'

/** 文档 front matter 的结构版本。 */
export const DOC_VERSION = 1

/** 三种持久状态。 */
export const STATUS_OPEN = 'open'
export const STATUS_CLOSING = 'closing'
export const STATUS_CLOSED = 'closed'
export const STATUSES = [STATUS_OPEN, STATUS_CLOSING, STATUS_CLOSED]

/** 状态的用户可见文案（面板与工具回执共用）。 */
export const STATUS_LABEL = {
  [STATUS_OPEN]: '讨论中',
  [STATUS_CLOSING]: '关闭确认中',
  [STATUS_CLOSED]: '已关闭',
}

/** 「写入中」是派生态，不是持久状态。 */
export const WRITING_LABEL = '写入中'

/** 讨论组 id：`dg_<时间戳 base36>_<随机>`，跨工作区查询的唯一键。 */
export const GROUP_ID_PATTERN = /^dg_[a-z0-9]{5,10}_[a-z0-9]{4,8}$/

/** 标题、名字、工作区名的长度上限。 */
export const MAX_TITLE_LENGTH = 120
export const MAX_NAME_LENGTH = 40
export const MAX_WORKSPACE_LENGTH = 60

/** 单条消息的字节上限（防止一个模型把 100MB 塞进正文）。 */
export const MAX_MESSAGE_BYTES = 256 * 1024

/**
 * Markdown 镜像的单文件上限。
 *
 * 库本身没有这个上限（长期讨论组可以一直写）；超过它只是**不再刷新镜像**，
 * 数据仍在 `plaza.db` 里，面板与 `plaza_read` 走库。镜像不是权威数据，
 * 所以宁可跳过，也不为了写一份人读副本把一次 append 拖成 100MB 磁盘写。
 */
export const MAX_MIRROR_BYTES = 4 * 1024 * 1024

/** 一个讨论组的参与者上限；超过说明用法错了，而不是需要继续扩容。 */
export const MAX_PARTICIPANTS = 32

/** 用创建者身份生成的系统消息作者名。 */
export const SYSTEM_AUTHOR = '系统'

/**
 * 带错误码的业务错误（路由与工具管线都会原样带给调用方）。
 * @param code - 机器可读错误码。
 * @param message - 面向人的说明。
 * @param details - 附加信息。
 */
export function plazaError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  error.details = details
  return error
}

/**
 * 单行化：把换行压成空格并去掉首尾空白。
 *
 * 标题、参与者名、工作区名都会进 Markdown 标题行与 `## ` 消息头，换行会把
 * 文档结构直接弄坏。
 * @param value - 任意值。
 */
export function oneLine(value) {
  if (value === undefined || value === null) return ''
  const text = String(value).replace(/\r\n?/g, '\n')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .trim()
}

/**
 * 截断到指定长度（按 Unicode 码点，避免把代理对切成半个字符）。
 * @param text - 已单行化的文本。
 * @param limit - 最大码点数。
 */
export function truncate(text, limit) {
  const points = Array.from(text)
  return points.length <= limit ? text : points.slice(0, limit).join('')
}

/** 清洗标题。 */
export function sanitizeTitle(value) {
  return truncate(oneLine(value), MAX_TITLE_LENGTH)
}

/** 清洗参与者显示名。 */
export function sanitizeName(value) {
  return truncate(oneLine(value), MAX_NAME_LENGTH)
}

/** 清洗工作区名。 */
export function sanitizeWorkspace(value) {
  return truncate(oneLine(value), MAX_WORKSPACE_LENGTH)
}

/**
 * 规范化消息正文：统一换行，去掉首尾空行；空正文非法。
 * @param value - 模型/调用方给的正文。
 */
export function normalizeBody(value) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
  return text
}

/** UTF-8 字节数（`Buffer` 在宿主与测试里都可用）。 */
export function byteLength(text) {
  return Buffer.byteLength(String(text), 'utf8')
}

/** 当前时间戳（ISO 8601，带毫秒）。 */
export function nowIso(now) {
  const date = now instanceof Date ? now : new Date(now ?? Date.now())
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

/**
 * 本地时间戳 `YYYY-MM-DD HH:mm:ss`（消息标题里给人看的那个）。
 *
 * 刻意不走 `toISOString()`：讨论组在同一台机器上，人读的应当是本地时间。
 * @param value - ISO 字符串 / Date / 毫秒。
 */
export function formatStamp(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  const safe = Number.isNaN(date.getTime()) ? new Date() : date
  const pad = (part) => String(part).padStart(2, '0')
  return `${safe.getFullYear()}-${pad(safe.getMonth() + 1)}-${pad(safe.getDate())} ` +
    `${pad(safe.getHours())}:${pad(safe.getMinutes())}:${pad(safe.getSeconds())}`
}

/**
 * 生成讨论组 id。
 *
 * 时间戳部分让同一毫秒内的先后可读，随机后缀让两个工作区同时创建不会撞。
 * @param taken - 已存在的 id 集合。
 * @param now - 时间点（测试可注入）。
 */
export function createGroupId(taken = new Set(), now = Date.now()) {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const stamp = Math.floor(now / 1000).toString(36)
    const id = `dg_${stamp}_${randomBytes(3).toString('hex')}`
    if (!taken.has(id)) return id
  }
  return `dg_${randomBytes(5).toString('hex')}_${randomBytes(3).toString('hex')}`
}

/**
 * 作者展示文本：`工作区 · 名字`；同名时只写一次。
 * @param identity - `{ workspace, name }`。
 */
export function authorText(identity) {
  const workspace = sanitizeWorkspace(identity?.workspace)
  const name = sanitizeName(identity?.name)
  if (workspace.length === 0) return name.length === 0 ? '匿名' : name
  if (name.length === 0 || name === workspace) return workspace
  return `${workspace} · ${name}`
}

/**
 * 参与者标识：**工作区 + sessionId**，形如 `taikoo-saas/<sessionId>`。
 *
 * 为什么不是裸 sessionId：会话 id 是 UUID，读文档的人看不出这个参与者属于哪个
 * 工作区；而"哪个工作区的哪个会话"才是讨论组里真正要区分的东西。工作区名来自
 * cwd 的 basename（不含 `/`），sessionId 也不含 `/`，所以这个拼接不会歧义，
 * 且可以直接当字符串比较。
 * @param value - `{ workspace, sessionId }`。
 */
export function participantKey(value) {
  if (value === null || typeof value !== 'object') return ''
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
  if (sessionId.length === 0) return ''
  const workspace = sanitizeWorkspace(value.workspace) || '未知工作区'
  return `${workspace}/${sessionId}`
}

/** 参与者规范化；没有 sessionId 的条目直接丢弃。key 缺失时按工作区+sessionId 补。 */
export function normalizeParticipant(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId.length > 0 ? raw.sessionId : undefined
  if (sessionId === undefined) return undefined
  const workspace = sanitizeWorkspace(raw.workspace) || '未知工作区'
  const key = typeof raw.key === 'string' && raw.key.length > 0
    ? raw.key
    : participantKey({ workspace, sessionId })
  const vote = raw.vote === 'confirm' || raw.vote === 'decline' ? raw.vote : null
  return {
    key,
    sessionId,
    name: sanitizeName(raw.name) || workspace || '未命名',
    workspace,
    joinedAt: typeof raw.joinedAt === 'string' ? raw.joinedAt : nowIso(),
    lastSeenAt: typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : nowIso(),
    lastReadSeq: Number.isInteger(raw.lastReadSeq) && raw.lastReadSeq > 0 ? raw.lastReadSeq : 0,
    vote,
  }
}

/**
 * 关闭记录规范化。
 *
 * `by`/`at` 是"谁在何时提议关闭"；`closedAt` 出现在真正关闭之后；
 * `canceledBy`/`canceledAt` 记录一次被撤回的提议（保留审计，不删历史）。
 */
export function normalizeClose(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const close = {
    by: typeof raw.by === 'string' ? raw.by : '',
    at: typeof raw.at === 'string' ? raw.at : nowIso(),
    reason: oneLine(raw.reason),
  }
  if (typeof raw.closedAt === 'string') close.closedAt = raw.closedAt
  if (typeof raw.closedReason === 'string' && raw.closedReason.length > 0) close.closedReason = raw.closedReason
  if (typeof raw.canceledBy === 'string') {
    close.canceledBy = raw.canceledBy
    close.canceledAt = typeof raw.canceledAt === 'string' ? raw.canceledAt : nowIso()
    close.cancelReason = oneLine(raw.cancelReason)
  }
  return close
}

/**
 * 把 front matter 的原始对象收敛成合法讨论组（宽容修复，不因单个坏字段打不开）。
 * @param raw - `JSON.parse` 后的元数据。
 * @param messages - 已解析的消息。
 */
export function normalizeGroup(raw, messages = []) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const id = typeof source.id === 'string' && GROUP_ID_PATTERN.test(source.id) ? source.id : ''
  const participants = []
  const seen = new Set()
  for (const entry of Array.isArray(source.participants) ? source.participants : []) {
    const participant = normalizeParticipant(entry)
    if (participant === undefined || seen.has(participant.key)) continue
    seen.add(participant.key)
    participants.push(participant)
    if (participants.length >= MAX_PARTICIPANTS) break
  }
  const status = STATUSES.includes(source.status) ? source.status : STATUS_OPEN
  // `messageCount` 让「只带最后一条消息」的列表视图仍能算出未读数：消息全量
  // 存在库里，但 `plaza_list` 不需要为每个组搬一遍全部正文。
  const messageCount = Number.isInteger(source.messageCount) && source.messageCount >= messages.length
    ? source.messageCount
    : messages.length
  return {
    version: DOC_VERSION,
    id,
    title: sanitizeTitle(source.title) || '未命名讨论组',
    status,
    standing: source.standing === true,
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : nowIso(),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : nowIso(),
    createdBy: normalizeParticipant(source.createdBy) ?? normalizeParticipant({
      sessionId: 'unknown',
      name: '未知',
      workspace: '未知工作区',
      joinedAt: nowIso(),
      lastSeenAt: nowIso(),
      lastReadSeq: 0,
      vote: null,
    }),
    lastWriteAt: typeof source.lastWriteAt === 'string' ? source.lastWriteAt : undefined,
    participants,
    close: normalizeClose(source.close),
    // 归档是「已关闭」之后的人类整理动作，只影响列表展示；`archivedAt` 是可选的审计时间。
    archived: source.archived === true,
    archivedAt: typeof source.archivedAt === 'string' ? source.archivedAt : undefined,
    messages,
    messageCount,
  }
}

/** 消息头里的时间格式（与 `formatStamp` 一致）。 */
const MESSAGE_HEADING = /^## (\d+)\s+·\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+·\s+(.+?)\s*$/

/**
 * 从正文里解析消息。
 * @param body - front matter 之后的全部文本。
 */
export function parseMessages(body) {
  const messages = []
  let pending = null
  // 代码块里的 `## …` 不当消息头：模型经常在正文里引用文档格式，围栏是唯一可靠的
  // "这里是引用"的标记。围栏外的消息头还要求 seq 严格递增（见下）。
  let fence = null
  const finish = () => {
    if (pending === null) return
    messages.push({
      seq: pending.seq,
      at: pending.at,
      author: pending.author,
      body: pending.lines.join('\n').replace(/^\n+/, '').replace(/\n+$/, ''),
    })
    pending = null
  }
  for (const line of String(body).split('\n')) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line)
    if (fenceMatch !== null) {
      const marker = fenceMatch[1][0]
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      if (pending !== null) pending.lines.push(line)
      continue
    }
    const match = fence === null ? MESSAGE_HEADING.exec(line) : null
    const expected = pending === null ? messages.length + 1 : pending.seq + 1
    if (match !== null && Number(match[1]) === expected) {
      finish()
      pending = { seq: expected, at: match[2], author: match[3], lines: [] }
      continue
    }
    if (pending !== null) pending.lines.push(line)
  }
  finish()
  return messages
}

/** 消息渲染成文档里的一段。 */
export function renderMessage(message) {
  return `## ${message.seq} · ${message.at} · ${message.author}\n\n${message.body}`
}

/**
 * 渲染讨论组的**正文**（人读的部分：标题 + 消息），不含 front matter。
 * @param group - 扁平讨论组对象（含 `messages`）。
 */
export function renderBody(group) {
  const archived = group.archived === true
    ? ` · 已归档${typeof group.archivedAt === 'string' ? `于 ${formatStamp(group.archivedAt)}` : ''}`
    : ''
  const header = [
    `# ${group.title}`,
    '',
    `> 讨论组 \`${group.id}\` · 状态：${STATUS_LABEL[group.status]} · ` +
      `参与者 ${group.participants.length} 位 · 更新于 ${formatStamp(group.updatedAt)}${archived}`,
  ].join('\n')
  const body = group.messages.map(renderMessage).join('\n\n')
  return `${header}\n${body.length > 0 ? `\n${body}\n` : ''}`
}

/**
 * 渲染整份讨论组文档（front matter 元数据 + 正文）。
 * @param group - 扁平讨论组对象（含 `messages`）。
 */
export function renderDoc(group) {
  const { messages, ...meta } = group
  const front = JSON.stringify({ ...meta, messageCount: lastSeq(group) }, null, 2)
  return `---\n${front}\n---\n\n${renderBody(group)}`
}

/**
 * 解析一份讨论组文档。
 * @param text - 文件全文。
 * @returns `{ group, messages }`；结构错误抛 `group-corrupt`。
 */
export function parseDoc(text) {
  const source = String(text ?? '').replace(/^\ufeff/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (match === null) {
    throw plazaError('group-corrupt', '讨论组文档缺少 front matter（两个 --- 之间的 JSON 元数据）')
  }
  let raw
  try {
    raw = JSON.parse(match[1])
  } catch (error) {
    throw plazaError('group-corrupt', `讨论组文档的 front matter 不是合法 JSON：${error.message}`)
  }
  const body = source.slice(match[0].length)
  const messages = parseMessages(body)
  const group = normalizeGroup(raw, messages)
  if (group.id.length === 0) {
    throw plazaError('group-corrupt', '讨论组文档的 id 非法或缺失')
  }
  return { group, messages }
}

/** 最后一条消息的序号（也是消息总数）。列表视图只带最后一条消息，靠 `messageCount`。 */
export function lastSeq(group) {
  return Number.isInteger(group?.messageCount) && group.messageCount > group.messages.length
    ? group.messageCount
    : group.messages.length
}

/**
 * 当前会话在某讨论组的未读数。
 * @param group - 讨论组。
 * @param actor - 身份对象，或工作区/sessionId 组成的 key；不是参与者时返回 0。
 */
export function unreadOf(group, actor) {
  const participant = findParticipant(group, actor)
  if (participant === undefined) return 0
  return Math.max(0, lastSeq(group) - participant.lastReadSeq)
}

/** 按参与者标识（工作区/sessionId）找参与者；也接受 `{ workspace, sessionId }`。 */
export function findParticipant(group, value) {
  const key = typeof value === 'string' ? value : participantKey(value)
  if (key.length === 0) return undefined
  return group.participants.find((entry) => entry.key === key)
}

/**
 * 状态机函数统一把"参与者"解析成复合键：字符串按 key 处理，对象按
 * 工作区+sessionId 推导。这样调用方传身份对象或直接传 key 都可以。
 * @param value - 身份对象或 key。
 */
export function keyOf(value) {
  return typeof value === 'string' ? value : participantKey(value)
}

/** 是否全部参与者都已确认关闭。 */
export function allConfirmed(participants) {
  return participants.length > 0 && participants.every((entry) => entry.vote === 'confirm')
}

/** 关闭确认中还没有表态的参与者。 */
export function pendingConfirmations(group) {
  if (group.status !== STATUS_CLOSING) return []
  return group.participants.filter((entry) => entry.vote !== 'confirm')
}

/**
 * 把身份写进参与者列表（不存在则加入，存在则刷新名字与 lastSeenAt）。
 *
 * 返回新的数组，绝不原地修改入参。
 * @param group - 讨论组。
 * @param identity - `{ sessionId, name, workspace }`。
 * @param stamp - 时间戳。
 */
export function ensureParticipant(group, identity, stamp) {
  const existing = findParticipant(group, identity)
  const key = participantKey(identity)
  if (existing !== undefined) {
    const participants = group.participants.map((entry) => entry.key === key
      ? { ...entry, name: sanitizeName(identity.name) || entry.name, lastSeenAt: stamp }
      : entry)
    return { participants, joined: false }
  }
  if (group.participants.length >= MAX_PARTICIPANTS) {
    throw plazaError('too-many-participants', `讨论组参与者已达上限 ${MAX_PARTICIPANTS} 位`)
  }
  return {
    participants: [...group.participants, normalizeParticipant({
      sessionId: identity.sessionId,
      name: identity.name,
      workspace: identity.workspace,
      joinedAt: stamp,
      lastSeenAt: stamp,
      lastReadSeq: 0,
      vote: null,
    })],
    joined: true,
  }
}

/** 给讨论组追加一条系统消息（审计用：加入 / 退出 / 提议关闭 / 确认 / 撤回）。 */
export function pushSystem(group, text, stamp) {
  const body = String(text ?? '').trim()
  if (body.length === 0) return group
  const message = {
    seq: lastSeq(group) + 1,
    at: formatStamp(stamp),
    author: SYSTEM_AUTHOR,
    body,
  }
  return {
    ...group,
    messages: [...group.messages, message],
    messageCount: message.seq,
    updatedAt: stamp,
    lastWriteAt: stamp,
  }
}

/**
 * 关闭讨论组：状态置 closed，记录 closedAt；参与者投票保留为审计。
 * @param group - 讨论组。
 * @param stamp - 时间戳。
 * @param reason - `all-confirmed` / `abandoned` / `single-participant`。
 */
export function closeGroup(group, stamp, reason) {
  return {
    ...group,
    status: STATUS_CLOSED,
    updatedAt: stamp,
    close: { ...(group.close ?? { by: '', at: stamp, reason: '' }), closedAt: stamp, closedReason: reason },
  }
}

/**
 * 讨论中校验：关闭确认中 / 已关闭都不能再写。
 * @param group - 讨论组。
 */
export function assertWritable(group) {
  if (group.status === STATUS_CLOSED) {
    throw plazaError('group-closed', `讨论组 ${group.id} 已关闭，仅可读`)
  }
  if (group.status === STATUS_CLOSING) {
    throw plazaError('close-pending', `讨论组 ${group.id} 处于关闭确认中，暂不接受新发言；请 plaza_confirm_close 确认或 plaza_cancel_close 撤回`)
  }
}

/**
 * 加入讨论组（幂等）。
 * @param group - 讨论组。
 * @param identity - 调用方身份。
 * @param stamp - 时间戳。
 */
export function planJoin(group, identity, stamp) {
  if (group.status === STATUS_CLOSED) throw plazaError('group-closed', `讨论组 ${group.id} 已关闭，不能再加入`)
  if (group.status === STATUS_CLOSING) throw plazaError('close-pending', `讨论组 ${group.id} 处于关闭确认中，不能再加入`)
  const { participants, joined } = ensureParticipant(group, identity, stamp)
  if (!joined) return { group: { ...group, participants }, joined: false, participant: findParticipant({ ...group, participants }, identity) }
  // 加入不写系统消息：参与者列表与 joinedAt 已经是审计记录，而消息会让新加入者
  // 立刻多出一条"自己加入"的未读，噪音大于信息。
  return { group: { ...group, participants }, joined: true, participant: findParticipant({ ...group, participants }, identity) }
}

/**
 * 追加一条发言；不是参与者时自动加入（发言即参与）。
 * @param group - 讨论组。
 * @param identity - 调用方身份。
 * @param body - 正文（已由 `normalizeBody` 清洗）。
 * @param stamp - 时间戳。
 */
export function planAppend(group, identity, body, stamp) {
  assertWritable(group)
  const text = normalizeBody(body)
  if (text.trim().length === 0) throw plazaError('empty-message', '发言正文不能为空')
  if (byteLength(text) > MAX_MESSAGE_BYTES) {
    throw plazaError('message-too-large', `单条发言超过上限 ${MAX_MESSAGE_BYTES} 字节`)
  }
  const { participants, joined } = ensureParticipant(group, identity, stamp)
  const key = participantKey(identity)
  const message = {
    seq: lastSeq(group) + 1,
    at: formatStamp(stamp),
    author: authorText(identity),
    body: text,
  }
  // 作者自己写的那条不算未读。
  const nextParticipants = participants.map((entry) => entry.key === key
    ? { ...entry, lastReadSeq: message.seq }
    : entry)
  const next = {
    ...group,
    participants: nextParticipants,
    messages: [...group.messages, message],
    messageCount: message.seq,
    updatedAt: stamp,
    lastWriteAt: stamp,
  }
  return { group: next, message, joined }
}

/**
 * 参与者退出（幂等）。
 *
 * 关闭确认中退出会把该参与者从确认集合里移除；如果剩下的都确认了（或已无人
 * 可确认），讨论组随之关闭 —— 这是"失联成员"不阻塞关闭的显式出口。
 * @param group - 讨论组。
 * @param actor - 退出者（身份对象，或工作区/sessionId 组成的 key）。
 * @param stamp - 时间戳。
 * @param options - `{ silent }`：人类强制移除时不写"主动退出"的系统消息。
 */
export function planLeave(group, actor, stamp, options = {}) {
  if (group.status === STATUS_CLOSED) throw plazaError('group-closed', `讨论组 ${group.id} 已关闭，不能再退出`)
  const key = keyOf(actor)
  const participant = findParticipant(group, key)
  if (participant === undefined) return { group, left: false, closed: false }
  const participants = group.participants.filter((entry) => entry.key !== key)
  let next = { ...group, participants, updatedAt: stamp }
  if (options.silent !== true) {
    next = pushSystem(next, `${authorText(participant)} 退出讨论`, stamp)
  }
  let closed = false
  if (next.status === STATUS_CLOSING) {
    if (participants.length === 0) {
      next = closeGroup(next, stamp, 'abandoned')
      next = pushSystem(next, '已无参与者，讨论组自动关闭', stamp)
      closed = true
    } else if (allConfirmed(participants)) {
      next = closeGroup(next, stamp, 'all-confirmed')
      next = pushSystem(next, '参与讨论的 Agent 已全部确认，讨论组已关闭', stamp)
      closed = true
    }
  }
  return { group: next, left: true, closed }
}

/**
 * 提议关闭：open → closing，提议者自动投确认票。
 * 单参与者（或全员都已在提议前确认）时直接关闭。
 * @param group - 讨论组。
 * @param identity - 提议者身份。
 * @param reason - 结束原因。
 * @param stamp - 时间戳。
 */
export function planProposeClose(group, identity, reason, stamp) {
  if (group.status === STATUS_CLOSED) throw plazaError('group-closed', `讨论组 ${group.id} 已关闭`)
  if (group.status === STATUS_CLOSING) {
    throw plazaError('close-pending', `讨论组 ${group.id} 已在关闭确认中；等待其余参与者 plaza_confirm_close，或 plaza_cancel_close 撤回`)
  }
  if (group.standing === true) {
    throw plazaError('standing-group',
      `讨论组 ${group.id} 是长期讨论组，只能由人类在广场面板里结束；Agent 请继续讨论，不要尝试关闭`)
  }
  const { participants: ensured } = ensureParticipant(group, identity, stamp)
  const key = participantKey(identity)
  const participants = ensured.map((entry) => ({
    ...entry,
    vote: entry.key === key ? 'confirm' : null,
    lastSeenAt: entry.key === key ? stamp : entry.lastSeenAt,
  }))
  const text = oneLine(reason)
  let next = {
    ...group,
    status: STATUS_CLOSING,
    participants,
    close: { by: key, at: stamp, reason: text },
    updatedAt: stamp,
  }
  const pendingCount = pendingConfirmations(next).length
  next = pushSystem(next, pendingCount === 0
    ? `${authorText(identity)} 提议结束讨论${text.length > 0 ? `（${text}）` : ''}，没有其他参与者需要确认`
    : `${authorText(identity)} 提议结束讨论${text.length > 0 ? `（${text}）` : ''}，等待 ${pendingCount} 位参与者确认`, stamp)
  if (allConfirmed(participants)) {
    next = closeGroup(next, stamp, participants.length === 1 ? 'single-participant' : 'all-confirmed')
    next = pushSystem(next, '参与讨论的 Agent 已全部确认，讨论组已关闭', stamp)
  }
  return { group: next }
}

/**
 * 关闭确认中的失联参与者清理（可选，`closeGraceMin > 0` 时才生效）。
 *
 * 语义：提议关闭后给了每个人 `graceMs` 的响应窗口；窗口过去仍未在讨论组里出现
 * （`lastSeenAt` 早于提议时刻）且没有确认的人，视为已离开并从确认集合里移除。
 * 每次移除都写一条系统消息，所以"为什么某人没确认"在文档里查得到。
 *
 * 注意：这个函数只在有人调用 `plaza_confirm_close` 时被触发 —— 广场没有后台
 * 定时器，不会自己把组关掉。
 * @param group - 讨论组。
 * @param stamp - 当前时间。
 * @param graceMs - 宽限毫秒数（0 / 非法 = 严格模式，什么都不做）。
 * @param options - `{ except }`：本次行动者，永不清理。
 */
export function pruneIdleParticipants(group, stamp, graceMs, options = {}) {
  const unchanged = { group, removed: [] }
  if (!Number.isFinite(graceMs) || graceMs <= 0) return unchanged
  if (group.status !== STATUS_CLOSING || group.close === null) return unchanged
  const now = Date.parse(stamp)
  const closeAt = Date.parse(group.close.at)
  if (Number.isNaN(now) || Number.isNaN(closeAt)) return unchanged
  if (now < closeAt + graceMs) return unchanged
  const removed = []
  const keep = []
  for (const participant of group.participants) {
    if (participant.key === options.except) { keep.push(participant); continue }
    if (participant.vote === 'confirm') { keep.push(participant); continue }
    const seen = Date.parse(participant.lastSeenAt)
    if (!Number.isNaN(seen) && seen >= closeAt) { keep.push(participant); continue }
    removed.push(participant)
  }
  if (removed.length === 0) return unchanged
  const minutes = Math.max(1, Math.round(graceMs / 60_000))
  let next = { ...group, participants: keep, updatedAt: stamp }
  next = pushSystem(next, removed
    .map((participant) => `${authorText(participant)} 超过 ${minutes} 分钟未响应关闭确认，视为已离开`)
    .join('；'), stamp)
  let closed = false
  if (keep.length === 0) {
    next = closeGroup(next, stamp, 'abandoned')
    next = pushSystem(next, '已无参与者可确认，讨论组自动关闭', stamp)
    closed = true
  } else if (allConfirmed(keep)) {
    next = closeGroup(next, stamp, 'all-confirmed')
    next = pushSystem(next, '参与讨论的 Agent 已全部确认，讨论组已关闭', stamp)
    closed = true
  }
  return { group: next, removed, closed }
}

/**
 * 确认关闭；全员确认后关闭。
 * @param group - 讨论组。
 * @param group - 讨论组。
 * @param actor - 确认者（身份对象，或工作区/sessionId 组成的 key）。
 * @param stamp - 时间戳。
 * @param options - `{ graceMs }`：失联参与者宽限（0 = 严格）。
 */
export function planConfirmClose(group, actor, stamp, options = {}) {
  if (group.status === STATUS_CLOSED) throw plazaError('group-closed', `讨论组 ${group.id} 已关闭`)
  if (group.status !== STATUS_CLOSING) {
    throw plazaError('not-closing', `讨论组 ${group.id} 不在关闭确认中，无需确认`)
  }
  const key = keyOf(actor)
  const participant = findParticipant(group, key)
  if (participant === undefined) {
    throw plazaError('not-participant', `会话不是讨论组 ${group.id} 的参与者，无法确认关闭；先 plaza_join`)
  }
  const participants = group.participants.map((entry) => entry.key === key
    ? { ...entry, vote: 'confirm', lastSeenAt: stamp }
    : entry)
  let next = { ...group, participants, updatedAt: stamp }
  const pruned = pruneIdleParticipants(next, stamp, options.graceMs, { except: key })
  next = pruned.group
  const pending = pendingConfirmations(next)
  if (allConfirmed(next.participants)) {
    if (next.status !== STATUS_CLOSED) {
      next = closeGroup(next, stamp, 'all-confirmed')
      next = pushSystem(next, `${authorText(participant)} 确认关闭，讨论组已关闭（只读）`, stamp)
    }
  } else {
    next = pushSystem(next, `${authorText(participant)} 确认关闭，仍待 ${pending.length} 位参与者确认`, stamp)
  }
  return { group: next, closed: next.status === STATUS_CLOSED, pruned: pruned.removed }
}

/**
 * 撤回关闭提议：closing → open，清空投票，保留一次审计记录。
 * @param group - 讨论组。
 * @param actor - 撤回者（身份对象，或工作区/sessionId 组成的 key）。
 * @param reason - 撤回原因。
 * @param stamp - 时间戳。
 */
export function planCancelClose(group, actor, reason, stamp) {
  if (group.status === STATUS_CLOSED) throw plazaError('group-closed', `讨论组 ${group.id} 已关闭，不能撤回`)
  if (group.status !== STATUS_CLOSING) {
    throw plazaError('not-closing', `讨论组 ${group.id} 不在关闭确认中，没有可撤回的提议`)
  }
  const key = keyOf(actor)
  const participant = findParticipant(group, key)
  if (participant === undefined) {
    throw plazaError('not-participant', `会话不是讨论组 ${group.id} 的参与者，不能撤回关闭提议`)
  }
  const participants = group.participants.map((entry) => ({ ...entry, vote: null, lastSeenAt: entry.key === key ? stamp : entry.lastSeenAt }))
  const text = oneLine(reason)
  let next = {
    ...group,
    status: STATUS_OPEN,
    participants,
    close: { ...(group.close ?? {}), canceledBy: key, canceledAt: stamp, cancelReason: text },
    updatedAt: stamp,
  }
  next = pushSystem(next, `${authorText(participant)} 撤回关闭提议，讨论继续${text.length > 0 ? `（${text}）` : ''}`, stamp)
  return { group: next }
}

/**
 * 人类把讨论组标记为长期讨论组（或取消标记）。
 *
 * 这是**人类决定**，不暴露给 Agent 工具：长期组的生命周期由人掌握。标记只在
 * `open` 状态允许；关闭确认中要先撤回提议，已关闭则不可改。
 * @param group - 讨论组。
 * @param standing - 是否长期。
 * @param actor - 操作者（人类身份）。
 * @param stamp - 时间戳。
 */
export function planSetStanding(group, standing, actor, stamp) {
  if (group.status === STATUS_CLOSED) throw plazaError('group-closed', `讨论组 ${group.id} 已关闭，不能再改长期标记`)
  if (group.status === STATUS_CLOSING) {
    throw plazaError('close-pending', `讨论组 ${group.id} 正在关闭确认中；先 plaza_cancel_close 撤回，再改长期标记`)
  }
  const on = standing === true
  if (group.standing === on) return { group, changed: false }
  let next = { ...group, standing: on, updatedAt: stamp }
  next = pushSystem(next, `${authorText(actor)} ${on ? '将讨论组标记为长期讨论组' : '取消长期讨论组标记'}`, stamp)
  return { group: next, changed: true }
}

/**
 * 人类结束长期讨论组：直接关闭（只读），无需 Agent 确认。
 *
 * 这是长期组唯一的关闭方式 —— Agent 的 `plaza_propose_close` 对长期组会抛
 * `standing-group`。普通讨论组不能走这条路径（必须全员确认）。
 * @param group - 讨论组。
 * @param actor - 人类身份。
 * @param reason - 结束原因。
 * @param stamp - 时间戳。
 */
export function planHumanClose(group, actor, reason, stamp) {
  if (group.status === STATUS_CLOSED) throw plazaError('group-closed', `讨论组 ${group.id} 已关闭`)
  if (group.standing !== true) {
    throw plazaError('not-standing', `讨论组 ${group.id} 不是长期讨论组；普通讨论组必须走全员确认关闭流程`)
  }
  const text = oneLine(reason)
  let next = closeGroup({
    ...group,
    close: { by: participantKey(actor), at: stamp, reason: text },
  }, stamp, 'human')
  next = pushSystem(next, `${authorText(actor)} 决定结束长期讨论，讨论组已关闭（只读）${text.length > 0 ? `（${text}）` : ''}`, stamp)
  return { group: next }
}

/**
 * 人类归档 / 取消归档一个**已关闭**的讨论组。
 *
 * 归档只是「从列表里收起来」的展示状态：不写系统消息、不改 `updatedAt`
 * （那是内容更新时间），因为已关闭的组是只读的，归档不应在讨论记录里追加内容。
 * 未关闭的组不能归档；归档可随时撤销，`archivedAt` 只在归档期间存在。
 * @param group - 讨论组。
 * @param archived - true = 归档，false = 取消归档。
 * @param stamp - 时间戳。
 */
export function planArchive(group, archived, stamp) {
  if (group.status !== STATUS_CLOSED) {
    throw plazaError('not-closed', `讨论组 ${group.id} 还没关闭，不能归档；请先走完关闭流程`)
  }
  const on = archived === true
  if ((group.archived === true) === on) return { group, changed: false }
  if (on) {
    return { group: { ...group, archived: true, archivedAt: stamp }, changed: true }
  }
  const next = { ...group, archived: false }
  delete next.archivedAt
  return { group: next, changed: true }
}

/**
 * 标记已读到第 `uptoSeq` 条。
 * @param group - 讨论组。
 * @param actor - 读者（身份对象，或工作区/sessionId 组成的 key）。
 * @param uptoSeq - 目标序号；省略表示读到最新。
 * @param stamp - 时间戳。
 */
export function planMarkRead(group, actor, uptoSeq, stamp) {
  const key = keyOf(actor)
  const participant = findParticipant(group, key)
  if (participant === undefined) return { group, changed: false, unread: 0 }
  const ceiling = Number.isInteger(uptoSeq) ? Math.min(uptoSeq, lastSeq(group)) : lastSeq(group)
  const target = Math.max(participant.lastReadSeq, Math.max(0, ceiling))
  if (target === participant.lastReadSeq) {
    const participants = group.participants.map((entry) => entry.key === key ? { ...entry, lastSeenAt: stamp } : entry)
    return { group: { ...group, participants }, changed: false, unread: Math.max(0, lastSeq(group) - target) }
  }
  const participants = group.participants.map((entry) => entry.key === key
    ? { ...entry, lastReadSeq: target, lastSeenAt: stamp }
    : entry)
  return { group: { ...group, participants }, changed: true, unread: Math.max(0, lastSeq(group) - target) }
}

/**
 * 给工具 / 面板用的摘要视图。
 *
 * `writing` 与 `lock` 来自锁文件（节点外的东西），所以由调用方传入。
 * @param group - 讨论组。
 * @param lock - 锁摘要或 undefined。
 * @param options - `{ identity, path }`；identity 是 `{ workspace, sessionId }`。
 */
export function summarizeGroup(group, lock, options = {}) {
  const identity = options.identity
  const participant = findParticipant(group, identity)
  const tail = group.messages[group.messages.length - 1]
  const summary = {
    id: group.id,
    title: group.title,
    status: group.status,
    statusLabel: STATUS_LABEL[group.status],
    standing: group.standing === true,
    archived: group.archived === true,
    ...(typeof group.archivedAt === 'string' ? { archivedAt: group.archivedAt } : {}),
    writing: lock !== undefined,
    participants: group.participants.map((entry) => ({
      key: entry.key,
      sessionId: entry.sessionId,
      name: entry.name,
      workspace: entry.workspace,
      lastReadSeq: entry.lastReadSeq,
      ...(entry.vote === null || entry.vote === undefined ? {} : { vote: entry.vote }),
    })),
    participantCount: group.participants.length,
    messageCount: lastSeq(group),
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    youAreParticipant: participant !== undefined,
    yourUnread: unreadOf(group, identity),
    ...(group.close === null ? {} : { close: group.close }),
  }
  if (lock !== undefined) {
    summary.lock = {
      holder: {
        key: participantKey(lock.holder),
        sessionId: lock.holder.sessionId,
        name: lock.holder.name,
        workspace: lock.holder.workspace,
      },
      purpose: lock.purpose,
      acquiredAt: lock.acquiredAt,
      expiresAt: new Date(lock.expiresAtMs).toISOString(),
    }
  }
  if (participant !== undefined && participant.vote !== null && participant.vote !== undefined) {
    summary.yourVote = participant.vote
  }
  if (group.status === STATUS_CLOSING) {
    summary.pendingConfirmations = pendingConfirmations(group).map((entry) => ({
      key: entry.key,
      sessionId: entry.sessionId,
      name: entry.name,
      workspace: entry.workspace,
    }))
  }
  if (tail !== undefined) {
    summary.lastMessage = { seq: tail.seq, at: tail.at, author: tail.author, excerpt: truncate(oneLine(tail.body), 160) }
  }
  if (typeof options.path === 'string') summary.path = options.path
  return summary
}

/**
 * 讨论组的健康检查：状态与投票是否自洽。
 * 返回问题列表（空数组 = 正常）；工具的自检与测试都用它。
 * @param group - 讨论组。
 */
export function validateGroup(group) {
  const problems = []
  if (!GROUP_ID_PATTERN.test(group.id)) problems.push('id 非法')
  if (!STATUSES.includes(group.status)) problems.push('status 非法')
  if (typeof group.standing !== 'boolean') problems.push('standing 非法')
  if (group.archived === true && group.status !== STATUS_CLOSED) {
    problems.push('归档状态只允许出现在已关闭的讨论组上')
  }
  if (group.status === STATUS_CLOSING && group.close === null) problems.push('关闭确认中却缺少 close 记录')
  if (group.status === STATUS_CLOSED && (group.close === null || typeof group.close.closedAt !== 'string')) {
    problems.push('已关闭却缺少 close.closedAt')
  }
  const seen = new Set()
  for (const participant of group.participants) {
    if (seen.has(participant.key)) problems.push(`参与者重复：${participant.key}`)
    seen.add(participant.key)
    if (participant.key !== participantKey(participant)) {
      problems.push(`参与者 key 与工作区/sessionId 不一致：${participant.key} != ${participantKey(participant)}`)
    }
  }
  for (let index = 0; index < group.messages.length; index += 1) {
    if (group.messages[index].seq !== index + 1) problems.push(`消息序号不连续：第 ${index + 1} 条是 ${group.messages[index].seq}`)
  }
  return problems
}
