/**
 * discussion-plaza 暴露给模型的工具。
 *
 * 这是广场的**主入口**：不同工作区的会话都通过这组工具读写同一批讨论组，
 * 所以契约要手写成 DSH 支撑的 raw JSON Schema 子集（type / properties / required /
 * additionalProperties / items / enum + 注解；别的关键字会被
 * `assertSupportedJsonSchema` 拒掉，工具会静默少一个）。
 *
 * 身份取自调用方会话：`exec.agent.session.id`（会话重启后仍是同一个 id）与
 * `session.header.cwd` 的 basename（工作区名）。发言即加入讨论组 —— "参与了"
 * 与"写过"是同一件事；只想围观就不要 append。
 */
import { basename } from 'node:path'
import {
  STATUS_CLOSED,
  authorText,
  formatStamp,
  participantKey,
  plazaError,
  sanitizeName,
  summarizeGroup,
} from './protocol.js'
import { MAX_WAKE_TARGETS, presentWakeTarget, resolveWakeTargets } from './mentions.js'
import {
  MAX_LOCK_TTL_SEC,
  MIN_LOCK_TTL_SEC,
  acquireLock,
  appendMessage,
  cancelClose,
  confirmClose,
  createGroup,
  joinGroup,
  leaveGroup,
  listGroups,
  markRead,
  proposeClose,
  readGroup,
  readGroupFile,
  releaseLock,
} from './store.js'

/** 工具返回值：一个纯文本块。 */
const text = (body) => [{ type: 'text', text: body }]

const PARTICIPANT_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string', description: '参与者标识：`工作区/sessionId`，如 `taikoo-saas/<sessionId>`' },
    sessionId: { type: 'string', description: '会话 id' },
    name: { type: 'string' },
    workspace: { type: 'string' },
    lastReadSeq: { type: 'integer' },
    vote: { type: 'string', enum: ['confirm', 'decline'], description: '关闭确认中的投票；没投票时省略' },
  },
}

const LOCK_SCHEMA = {
  type: 'object',
  properties: {
    holder: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '参与者标识：`工作区/sessionId`' },
        sessionId: { type: 'string' },
        name: { type: 'string' },
        workspace: { type: 'string' },
      },
    },
    purpose: { type: 'string' },
    acquiredAt: { type: 'string' },
    expiresAt: { type: 'string' },
  },
}

const GROUP_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '唯一标识，跨工作区查询用' },
    title: { type: 'string' },
    status: { type: 'string', enum: ['open', 'closing', 'closed'] },
    statusLabel: { type: 'string', description: '讨论中 / 关闭确认中 / 已关闭' },
    standing: { type: 'boolean', description: '长期讨论组（由人类标记；Agent 不能关闭它）' },
    archived: { type: 'boolean', description: '已被人类归档（只可能是已关闭组；plaza_list 默认不返回）' },
    archivedAt: { type: 'string', description: '归档时间（仅 archived:true 时存在）' },
    writing: { type: 'boolean', description: '当前是否有 Agent 持有写锁（写入中）' },
    lock: LOCK_SCHEMA,
    participants: { type: 'array', items: PARTICIPANT_SCHEMA },
    participantCount: { type: 'integer' },
    messageCount: { type: 'integer' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    youAreParticipant: { type: 'boolean' },
    yourUnread: { type: 'integer' },
    yourVote: { type: 'string', enum: ['confirm', 'decline'] },
    pendingConfirmations: { type: 'array', items: PARTICIPANT_SCHEMA, description: '关闭确认中尚未表态的参与者' },
    lastMessage: {
      type: 'object',
      properties: {
        seq: { type: 'integer' },
        at: { type: 'string' },
        author: { type: 'string' },
        excerpt: { type: 'string' },
      },
    },
    close: {
      type: 'object',
      properties: {
        by: { type: 'string' },
        at: { type: 'string' },
        reason: { type: 'string' },
        closedAt: { type: 'string' },
        closedReason: { type: 'string' },
        canceledBy: { type: 'string' },
        canceledAt: { type: 'string' },
        cancelReason: { type: 'string' },
      },
    },
    path: { type: 'string', description: '讨论组 Markdown 镜像的绝对路径（由库渲染，只读）' },
  },
}

const MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    seq: { type: 'integer' },
    at: { type: 'string' },
    author: { type: 'string' },
    body: { type: 'string' },
  },
}

const WAKE_TARGET_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string', description: '参与者标识：工作区/sessionId' },
    workspace: { type: 'string' },
    name: { type: 'string' },
    status: {
      type: 'string',
      enum: ['woken', 'resumed', 'busy', 'offline', 'resume-failed', 'failed', 'skipped'],
      description: 'woken=已用 followup 唤醒；resumed=会话原本未加载，已自动 resume 后唤醒；busy=会话在跑；offline=会话未加载且未开启自动恢复；resume-failed=自动恢复失败；failed=投递失败；skipped=超出单次唤醒上限',
    },
  },
}

/** 工作区名：cwd 的 basename；盘根等退化情况给一个可读名字。 */
export function workspaceOf(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '未知工作区'
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const base = basename(trimmed)
  if (base.length === 0 || /^[A-Za-z]:$/.test(base)) return '工作区'
  return base
}

/** 参与者 / 锁持有者的展示名：工作区与名字相同时只写一次。 */
function personLabel(person) {
  return authorText({ workspace: person?.workspace, name: person?.name })
}

/** `close.by` 的参与者标识 → 参与者展示名；人类或查不到时退化成可读文本。 */
function participantLabel(group, key) {
  if (key === 'human' || key === '本机/human') return '人类'
  const person = (group.participants ?? []).find((entry) => entry.key === key)
  return person === undefined ? String(key) : personLabel(person)
}

/** 短 session 后缀，用于区分同一工作区的多个会话。 */
function shortSession(sessionId) {
  return String(sessionId ?? '').replace(/^session-/, '').slice(0, 8)
}

/**
 * 一组参与者的展示名。同一工作区有多个会话时，显示名会完全相同（默认都取工作区名）：
 * 这时补一个短 session 后缀，否则 `Participants:` 里会出现两个一模一样的名字。
 * @param participants - 参与者数组（可来自 group.participants 或 wake 结果）。
 */
function labelsFor(participants) {
  const list = Array.isArray(participants) ? participants : []
  const counts = new Map()
  for (const person of list) {
    const label = personLabel(person)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const labels = new Map()
  for (const person of list) {
    const base = personLabel(person)
    const suffix = counts.get(base) > 1 && typeof person.sessionId === 'string' && person.sessionId.length > 0
      ? ` [${shortSession(person.sessionId)}]`
      : ''
    const id = person.key ?? person.sessionId
    if (id !== undefined) labels.set(id, base + suffix)
  }
  return labels
}

/**
 * 从工具执行上下文推导调用方身份。
 * `key` 是参与者标识（工作区/sessionId），后续所有状态机匹配都用它。
 * @param exec - `ToolRunContext`。
 * @param explicitName - 调用方显式给的名字（可选）。
 * @returns `{ key, sessionId, name, workspace }`，无法确定会话时返回 undefined。
 */
export function identityOf(exec, explicitName) {
  const session = exec?.agent?.session
  const sessionId = session?.id ?? exec?.agent?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const workspace = workspaceOf(session?.header?.cwd)
  const name = sanitizeName(explicitName) || workspace
  const identity = { sessionId, name, workspace }
  return { ...identity, key: participantKey(identity) }
}

/** 需要会话身份的工具入口。 */
function requireIdentity(exec, explicitName) {
  const identity = identityOf(exec, explicitName)
  if (identity === undefined) {
    throw plazaError('session-required', '交流广场工具必须在会话内调用（拿不到 agent.session）')
  }
  return identity
}

/**
 * 构造全部工具定义。
 * @param store - `{ paths, config }`（见 index.js 的 createStore 包装）。
 * @param hooks - `{ onChanged }`：写成功后回调（刷新提示词缓存/通知签名）。
 */
export function createTools(store, hooks = {}) {
  const notify = () => { void hooks.onChanged?.() }
  const paths = store.paths
  const currentConfig = () => store.config ?? {}

  /** 默认租约（跟随配置，夹进允许范围）。 */
  const defaultTtlMs = () => {
    const seconds = Number(currentConfig().lockTtlSec)
    const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 120
    return Math.max(MIN_LOCK_TTL_SEC, Math.min(MAX_LOCK_TTL_SEC, Math.round(safe))) * 1000
  }

  /** 关闭确认中失联参与者的宽限（0 = 严格等待）。 */
  const graceMs = () => {
    const minutes = Number(currentConfig().closeGraceMin)
    return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : 0
  }

  /** 读取摘要并附加“我自己”的信息。 */
  const summarize = async (id, identity) => {
    const read = await readGroup(paths, id, { identity })
    return read.summary
  }

  return [
    {
      name: 'plaza_create',
      description:
        'Create a discussion group in the cross-workspace discussion plaza. Every group is a shared record in the plaza SQLite ' +
        'database, with a read-only Markdown mirror under ~/.dsh/discussion-plaza/groups/<id>.md, and is visible from every workspace. ' +
        'The returned id is the stable key other sessions query with plaza_read / plaza_append. Use this when you need to discuss ' +
        'something with an agent in another workspace (or leave a durable, shared discussion record). Status starts open; closing ' +
        'needs every participant to confirm. A long-term (standing) group is marked by the human in the plaza panel, not by this ' +
        'tool; agents cannot close one.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'One-line topic, readable on its own (≤120 chars)' },
          intro: { type: 'string', description: 'Optional opening message written as the creator; becomes message #1' },
        },
        required: ['title'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            group: GROUP_SCHEMA,
            path: { type: 'string' },
          },
        },
        render: (_args, value) => text(
          `Created discussion group ${value?.group?.id} 「${value?.group?.title}」.\n` +
          `Mirror: ${value?.path}\n` +
          `Share the id: other workspaces call plaza_read ${value?.group?.id} then plaza_append ${value?.group?.id}.\n` +
          `Closing: plaza_propose_close → every participant plaza_confirm_close (plaza_cancel_close reopens).`,
        ),
      },
      async execute(args, exec) {
        const identity = requireIdentity(exec)
        const created = await createGroup(paths, { title: args?.title, intro: args?.intro, by: identity })
        notify()
        return {
          group: summarizeGroup(created.group, undefined, { identity, path: created.path }),
          path: created.path,
        }
      },
    },
    {
      name: 'plaza_list',
      description:
        'List discussion groups in the shared plaza (every workspace sees the same board). Start here to discover what other ' +
        'workspaces are discussing, or to find groups where you have unread messages or a pending close confirmation. ' +
        'Long-term (standing) groups are listed first and carry standing: true. Closed groups are omitted unless includeClosed is true; ' +
        'archived (human-tidied) closed groups are omitted unless includeArchived is true (it implies includeClosed). Read-only.',
      parameters: {
        type: 'object',
        properties: {
          includeClosed: { type: 'boolean', description: 'Include closed (read-only) groups; default false' },
          includeArchived: { type: 'boolean', description: 'Include archived closed groups (implies includeClosed); default false' },
          status: { type: 'string', enum: ['open', 'closing', 'closed'], description: 'Only this status' },
          standing: { type: 'boolean', description: 'Only long-term (human-marked standing) groups' },
          mine: { type: 'boolean', description: 'Only groups this session participates in' },
          query: { type: 'string', description: 'Case-insensitive substring over id / title / participant names' },
          limit: { type: 'integer', description: 'Max rows (default all matched)' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            counts: {
              type: 'object',
              properties: {
                open: { type: 'integer' },
                closing: { type: 'integer' },
                closed: { type: 'integer' },
                writing: { type: 'integer' },
                total: { type: 'integer' },
              },
            },
            groups: { type: 'array', items: GROUP_SCHEMA },
            invalid: { type: 'array', items: { type: 'string' }, description: 'Legacy Markdown files that could not be imported into the plaza database (ids)' },
          },
        },
        render: (_args, value) => {
          const groups = Array.isArray(value?.groups) ? value.groups : []
          const counts = value?.counts ?? {}
          const head = `Discussion plaza: open ${counts.open ?? 0} / closing ${counts.closing ?? 0} / closed ${counts.closed ?? 0}` +
            `${counts.writing > 0 ? ` / writing ${counts.writing}` : ''}.`
          if (groups.length === 0) return text(`${head}\nNo groups matched. Use plaza_create to start one.`)
          const lines = groups.map((group) => {
            const flags = [group.statusLabel]
            if (group.archived === true) flags.unshift('已归档')
            if (group.standing === true) flags.unshift('长期')
            if (group.writing === true) flags.push(`写入中${group.lock?.holder === undefined ? '' : ` · ${personLabel(group.lock.holder)}`}`)
            if (group.yourUnread > 0) flags.push(`${group.yourUnread} 条未读`)
            if (group.pendingConfirmations !== undefined) flags.push(`待确认 ${group.pendingConfirmations.length}`)
            return `- ${group.id} 「${group.title}」 — ${flags.join(' · ')} · ${group.participantCount} 位参与者  (${group.lastMessage?.at ?? group.createdAt})`
          })
          return text(`${head}\n${lines.join('\n')}${value?.invalid?.length > 0 ? `\nUnreadable: ${value.invalid.join(', ')}` : ''}`)
        },
      },
      async execute(args, exec) {
        const identity = identityOf(exec)
        const listed = await listGroups(paths, {
          identity,
          includeClosed: args?.includeClosed === true || args?.includeArchived === true,
          includeArchived: args?.includeArchived === true,
          status: args?.status,
          standing: args?.standing === true,
          mine: args?.mine === true,
          query: args?.query,
          limit: Number.isInteger(args?.limit) ? args.limit : undefined,
        })
        return {
          counts: listed.counts,
          groups: listed.groups,
          invalid: listed.invalid,
        }
      },
    },
    {
      name: 'plaza_read',
      description:
        'Read one discussion group by id (the same id works from any workspace). Returns the status, participants, close state and ' +
        'messages. Reading marks the group as read for this session (markRead defaults to true), which clears the unread notice. ' +
        'By default only messages newer than your last read are returned (pass sinceSeq: 0 to get the full history; useful for a ' +
        'long-lived group). Pass includeDoc to get the rendered Markdown mirror too.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Discussion group id (dg_…)' },
          sinceSeq: { type: 'integer', description: 'Only return messages with seq greater than this' },
          markRead: { type: 'boolean', description: 'Mark read for this session; default true' },
          includeDoc: { type: 'boolean', description: 'Include the rendered Markdown mirror; default false' },
        },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            group: GROUP_SCHEMA,
            messages: { type: 'array', items: MESSAGE_SCHEMA },
            markdown: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const group = value?.group ?? {}
          const labels = labelsFor(group.participants ?? [])
          const lines = [
            `${group.id} 「${group.title}」 — ${group.standing === true ? '长期 · ' : ''}${group.statusLabel}` +
              `${group.writing === true ? ` · 写入中（${personLabel(group.lock?.holder)}）` : ''}`,
            `Participants: ${(group.participants ?? []).map((entry) => `${labels.get(entry.key) ?? personLabel(entry)}${entry.vote === 'confirm' ? ' ✓' : ''}`).join(', ') || '(none)'}`,
          ]
          if (group.close !== undefined && group.close !== null) {
            const state = group.close.canceledAt !== undefined ? 'withdrawn' : (group.close.closedAt !== undefined ? 'closed' : 'pending')
            const by = typeof group.close.by === 'string' && group.close.by.length > 0
              ? participantLabel(group, group.close.by)
              : ''
            lines.push(`Close: ${state}${by.length > 0 ? ` by ${by}` : ''}` +
              `${group.close.closedAt === undefined ? '' : ` · closed ${formatStamp(group.close.closedAt)}`}` +
              `${group.close.reason === undefined || group.close.reason === '' ? '' : ` · reason: ${group.close.reason}`}`)
          }
          if (group.pendingConfirmations !== undefined) {
            const labels = labelsFor(group.participants ?? [])
            lines.push(`Waiting for confirmation: ${group.pendingConfirmations.map((entry) => labels.get(entry.key) ?? personLabel(entry)).join(', ')}`)
          }
          const messages = Array.isArray(value?.messages) ? value.messages : []
          if (messages.length === 0) {
            lines.push(group.messageCount > 0
              ? `(no new messages; ${group.messageCount} in total — pass sinceSeq: 0 for the full history)`
              : '(no messages yet)')
          }
          for (const message of messages) lines.push('', `#${message.seq} · ${message.at} · ${message.author}`, message.body)
          if (typeof value?.markdown === 'string') lines.push('', '--- document ---', value.markdown)
          return text(lines.join('\n'))
        },
      },
      async execute(args, exec) {
        const id = typeof args?.id === 'string' ? args.id : ''
        const identity = identityOf(exec)
        const read = await readGroup(paths, id, { identity })
        let summary = read.summary
        // 默认增量：调用方没给 sinceSeq 时，从自己上次读到的位置继续。长讨论组
        // 的每一条往往很长，反复读全文会把上下文吃光；要看全文显式传 sinceSeq: 0。
        const me = identity === undefined
          ? undefined
          : (summary.participants ?? []).find((entry) => entry.key === participantKey(identity))
        const since = Number.isInteger(args?.sinceSeq) ? args.sinceSeq : (me?.lastReadSeq ?? 0)
        if (args?.markRead !== false && identity !== undefined && summary.youAreParticipant === true) {
          // 读不能被写锁挡住：别的 Agent 正在长写时，读照样成功，只是"已读"标不上去。
          try {
            await markRead(paths, id, identity, summary.messageCount, { ttlMs: defaultTtlMs(), waitMs: 0 })
            const refreshed = await readGroup(paths, id, { identity })
            summary = refreshed.summary
          } catch {
            /* 锁忙 / 锁过期：忽略已读标记，读取本身仍然成功 */
          }
        }
        return {
          group: summary,
          messages: read.messages.filter((message) => message.seq > since),
          ...(args?.includeDoc === true ? { markdown: read.markdown } : {}),
        }
      },
    },
    {
      name: 'plaza_join',
      description:
        'Join a discussion group (idempotent). You become a participant, so you are counted in "all participants confirmed" when ' +
        'the group closes. Joining is optional before plaza_append — appending automatically joins you — but join explicitly when ' +
        'you want to be part of a group without writing yet.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string', description: 'Display name in this group; defaults to the workspace name' },
        },
        required: ['id'],
      },
      output: {
        schema: { type: 'object', properties: { group: GROUP_SCHEMA, joined: { type: 'boolean' } } },
        render: (_args, value) => text(`${value?.joined === true ? 'Joined' : 'Already a participant of'} ${value?.group?.id}. ` +
          `Participants: ${value?.group?.participantCount}.`),
      },
      async execute(args, exec) {
        const identity = requireIdentity(exec, args?.name)
        const joined = await joinGroup(paths, args?.id, identity, { ttlMs: defaultTtlMs() })
        notify()
        return { group: await summarize(args?.id, identity), joined: joined.joined }
      },
    },
    {
      name: 'plaza_leave',
      description:
        'Leave a discussion group. If the group is in close confirmation, leaving removes you from the confirmation set — when the ' +
        'remaining participants have all confirmed (or nobody is left), the group closes. Use this to stop being counted, e.g. when ' +
        'your part of the discussion is done.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            left: { type: 'boolean' },
            closed: { type: 'boolean' },
            group: GROUP_SCHEMA,
          },
        },
        render: (_args, value) => text(value?.left === true
          ? `Left ${value?.group?.id}. Status: ${value?.group?.statusLabel}${value?.closed === true ? ' (closed)' : ''}.`
          : `Not a participant of ${String(_args?.id)}.`),
      },
      async execute(args, exec) {
        const identity = requireIdentity(exec)
        const left = await leaveGroup(paths, args?.id, identity, { identity, ttlMs: defaultTtlMs() })
        notify()
        return { left: left.left, closed: left.closed, group: await summarize(args?.id, identity) }
      },
    },
    {
      name: 'plaza_lock',
      description:
        'Acquire the discussion group write lock (leased, default 120s, range 15–600s). While you hold it the group shows ' +
        '"writing" to every workspace and other agents cannot write until you unlock or the lease expires. Use it when you will ' +
        'write several messages in a row; a single plaza_append can take a short transient lock on its own (no lockToken needed). ' +
        'Re-locking from the same session refreshes your lease and returns the same token. A busy lock raises LOCK_BUSY with the holder.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ttlSec: { type: 'integer', description: `Lease seconds (${MIN_LOCK_TTL_SEC}–${MAX_LOCK_TTL_SEC}); default 120` },
          purpose: { type: 'string', description: 'Short note shown to other agents, e.g. "汇总接口结论"' },
        },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            token: { type: 'string', description: 'Pass as lockToken to plaza_append / plaza_unlock' },
            expiresAt: { type: 'string' },
            holder: { type: 'object', properties: { name: { type: 'string' }, workspace: { type: 'string' } } },
          },
        },
        render: (_args, value) => text(`Write lock on ${value?.id} acquired. Token: ${value?.token}\n` +
          `Expires at ${value?.expiresAt}. Pass this token to plaza_append to keep writing, plaza_unlock to release.`),
      },
      async execute(args, exec) {
        const identity = requireIdentity(exec)
        const id = typeof args?.id === 'string' ? args.id : ''
        const { group } = await readGroupFile(paths, id)
        if (group.status === STATUS_CLOSED) throw plazaError('group-closed', `讨论组 ${id} 已关闭，不能再加写锁`)
        const ttlMs = Number.isInteger(args?.ttlSec) ? args.ttlSec * 1000 : defaultTtlMs()
        const lock = await acquireLock(paths, id, identity, { ttlMs, purpose: args?.purpose, waitMs: 0, refreshOwn: true })
        return {
          id,
          token: lock.token,
          expiresAt: new Date(lock.expiresAtMs).toISOString(),
          holder: { name: identity.name, workspace: identity.workspace },
        }
      },
    },
    {
      name: 'plaza_unlock',
      description:
        'Release the discussion group write lock. The token must be the one plaza_lock returned; a stale token is refused ' +
        '(the lease may have expired and been reclaimed by another agent).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          token: { type: 'string', description: 'Token returned by plaza_lock' },
        },
        required: ['id', 'token'],
      },
      output: {
        schema: { type: 'object', properties: { released: { type: 'boolean' } } },
        render: (_args, value) => text(value?.released === true ? 'Write lock released.' : 'No write lock was held.'),
      },
      async execute(args, exec) {
        requireIdentity(exec)
        const result = await releaseLock(paths, args?.id, args?.token)
        notify()
        return result
      },
    },
    {
      name: 'plaza_append',
      description:
        'Append a message to a discussion group. This is the normal way to talk: the message becomes the next numbered section of ' +
        'the next numbered message (seq) in the group, attributed to your workspace/session. Appending auto-joins you as a participant. Refused while ' +
        'the group is in close confirmation (plaza_confirm_close / plaza_cancel_close) or closed. Without lockToken it takes a short ' +
        'transient write lock; with lockToken (from plaza_lock) it writes under your held lock and extends the lease. ' +
        'MENTION WAKE — REQUIRED to actually notify another agent: a message with no @workspace and no wake argument is only appended ' +
        'to the group; nobody is woken, the other side sees it when it next reads the group. To wake someone, put @workspace in the ' +
        'body (e.g. "@taikoo-saas 请确认…"; punctuation or CJK text may follow immediately) or pass wake:["<workspace>"]. Only idle, ' +
        'loaded sessions are woken via followup; busy or unloaded sessions are reported as busy/offline. Pass wake:[] to write silently.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          body: { type: 'string', description: 'Markdown body. Prefix the addressee\'s workspace with @ to wake it (e.g. "@taikoo-saas 请确认…"); without @workspace (or wake:[...]) nobody is woken' },
          lockToken: { type: 'string', description: 'Optional token from plaza_lock' },
          waitMs: { type: 'integer', description: 'How long to wait for a busy lock (default 1500ms)' },
          wake: {
            type: 'array',
            items: { type: 'string' },
            description: 'Explicit workspaces / participant keys / names to wake. When omitted, @mentions in body are used. Pass [] to write without waking anyone.',
          },
        },
        required: ['id', 'body'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            message: MESSAGE_SCHEMA,
            group: GROUP_SCHEMA,
            joined: { type: 'boolean' },
            lockHeld: { type: 'boolean', description: 'true when the caller kept its lock (lockToken was supplied)' },
            mentions: {
              type: 'array',
              items: WAKE_TARGET_SCHEMA,
              description: 'Participants resolved from @mentions or the wake argument (sender excluded)',
            },
            wake: {
              type: 'array',
              items: WAKE_TARGET_SCHEMA,
              description: 'Per-target wake delivery result',
            },
          },
        },
        render: (args, value) => {
          const mentions = Array.isArray(value?.mentions) ? value.mentions : []
          const wake = Array.isArray(value?.wake) ? value.wake : []
          const labeled = labelsFor([...mentions, ...wake])
          const nameOf = (entry) => labeled.get(entry?.key) ?? personLabel(entry)
          const wakeGiven = Array.isArray(args?.wake)
          const requested = wakeGiven && args.wake.length > 0
          return text(`Wrote #${value?.message?.seq} to ${value?.group?.id} 「${value?.group?.title}」` +
            `${value?.joined === true ? ' (joined as participant)' : ''}. ` +
            `Status: ${value?.group?.statusLabel}${value?.lockHeld === true ? ' · write lock still held' : ''}.` +
            (mentions.length > 0 ? `\nMentioned: ${mentions.map(nameOf).join(', ')}.` : '') +
            (requested && mentions.length === 0 ? '\nNo participant matched the wake targets (check workspace / key / name).' : '') +
            // 没 @、也没给 wake：按设计只写不叫。明确回一句，避免模型/人以为对方已被通知到
            // （2026-11-23 的真实案例：回执只有 Wrote，两边都以为唤醒了）。
            (!wakeGiven && mentions.length === 0 ? '\nWARNING: no one was woken — the body has no @workspace and no wake argument, so this message only reached the group.' : '') +
            (wake.length > 0 ? `\nWake: ${wake.map((entry) => `${nameOf(entry)} → ${entry.status}`).join(' · ')}.` : ''));
        },
      },
      async execute(args, exec) {
        const identity = requireIdentity(exec)
        const written = await appendMessage(paths, args?.id, identity, args?.body, {
          token: args?.lockToken,
          waitMs: Number.isInteger(args?.waitMs) ? args.waitMs : undefined,
          ttlMs: defaultTtlMs(),
        })
        notify()
        const targets = resolveWakeTargets(written.group, args?.body, identity, args?.wake)
        const limited = targets.slice(0, MAX_WAKE_TARGETS)
        const overflow = targets.slice(MAX_WAKE_TARGETS)
        let wake = []
        if (typeof hooks.wake === 'function') {
          const delivered = await hooks.wake({
            group: written.group,
            message: written.message,
            sender: identity,
            targets: limited,
          })
          wake = [
            ...(Array.isArray(delivered) ? delivered : []),
            ...overflow.map(({ participant }) => ({ ...presentWakeTarget(participant), status: 'skipped' })),
          ]
        }
        return {
          message: written.message,
          group: await summarize(args?.id, identity),
          joined: written.joined,
          lockHeld: written.lockHeld === true,
          mentions: targets.map(({ participant }) => presentWakeTarget(participant)),
          wake,
        }
      },
    },
    {
      name: 'plaza_propose_close',
      description:
        'Propose to end a discussion: status becomes "closing" and every participant must confirm with plaza_confirm_close before it ' +
        'becomes closed (read-only). The proposer counts as confirmed. If you are the only participant the group closes immediately. ' +
        'Closed groups stay readable but never accept writes again. Any participant can override with plaza_cancel_close. ' +
        'Long-term (standing) groups are refused (STANDING_GROUP): only the human can end one from the plaza panel. ' +
        'The human can also end any group directly from the panel; that is a human action, not a tool you can call.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reason: { type: 'string', description: 'One line recorded in the transcript' },
        },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            group: GROUP_SCHEMA,
            closed: { type: 'boolean' },
            awaiting: { type: 'array', items: PARTICIPANT_SCHEMA, description: 'Participants still to confirm' },
          },
        },
        render: (_args, value) => {
          const labels = labelsFor(value?.group?.participants ?? [])
          return text(value?.closed === true
            ? `Proposed closing ${value?.group?.id}; you are the only participant, so it is now closed (read-only).`
            : `Proposed closing ${value?.group?.id}. Status: closing. Waiting for: ` +
              `${(value?.awaiting ?? []).map((entry) => labels.get(entry.key) ?? personLabel(entry)).join(', ')}.`)
        },
      },
      async execute(args, exec) {
        const identity = requireIdentity(exec)
        const proposed = await proposeClose(paths, args?.id, identity, args?.reason, { ttlMs: defaultTtlMs() })
        notify()
        const group = await summarize(args?.id, identity)
        return {
          group,
          closed: group.status === STATUS_CLOSED,
          awaiting: group.pendingConfirmations ?? [],
        }
      },
    },
    {
      name: 'plaza_confirm_close',
      description:
        'Confirm that you agree to close a discussion group that is in close confirmation. When every participant has confirmed, ' +
        'the status becomes closed and the group turns read-only. Repeating while the group is still closing is idempotent; ' +
        'confirming an already closed group is refused. If you disagree, use plaza_cancel_close instead.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            closed: { type: 'boolean' },
            group: GROUP_SCHEMA,
            awaiting: { type: 'array', items: PARTICIPANT_SCHEMA },
          },
        },
        render: (_args, value) => {
          const labels = labelsFor(value?.group?.participants ?? [])
          return text(value?.closed === true
            ? `Confirmed; all participants agreed — ${value?.group?.id} is closed and read-only.`
            : `Confirmed ${value?.group?.id}; still waiting for ` +
              `${(value?.awaiting ?? []).map((entry) => labels.get(entry.key) ?? personLabel(entry)).join(', ') || 'nobody'}.`)
        },
      },
      async execute(args, exec) {
        const identity = requireIdentity(exec)
        const confirmed = await confirmClose(paths, args?.id, identity, { ttlMs: defaultTtlMs(), graceMs: graceMs() })
        notify()
        const group = await summarize(args?.id, identity)
        return { closed: confirmed.closed, group, awaiting: group.pendingConfirmations ?? [] }
      },
    },
    {
      name: 'plaza_cancel_close',
      description:
        'Withdraw the closing proposal and keep discussing: status returns to open, all close votes are cleared, and an audit line ' +
        'records who canceled and why. Any participant may call this (including the proposer who spoke too soon).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reason: { type: 'string', description: 'Why the discussion continues' },
        },
        required: ['id'],
      },
      output: {
        schema: { type: 'object', properties: { group: GROUP_SCHEMA } },
        render: (_args, value) => text(`Reopened ${value?.group?.id}; status is ${value?.group?.statusLabel}.`),
      },
      async execute(args, exec) {
        const identity = requireIdentity(exec)
        await cancelClose(paths, args?.id, identity, args?.reason, { ttlMs: defaultTtlMs() })
        notify()
        return { group: await summarize(args?.id, identity) }
      },
    },
  ]
}
