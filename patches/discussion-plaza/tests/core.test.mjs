/**
 * discussion-plaza 的纯逻辑测试（不碰文件系统、不碰 Cordis）。
 *
 * 覆盖的是这个补丁最容易写错、且错了不会报错的地方：
 *   - Markdown 文档的渲染 / 解析往返（front matter 是 JSON，消息头带 seq）
 *   - 消息解析的两个防御：代码块里的伪标题、seq 对不上的伪标题
 *   - 关闭状态机（提议 / 确认 / 撤回 / 退出 / 失联宽限）
 *   - 未读计数、参与者身份、集合上限与 id 格式
 *
 * 从仓库根运行：
 *   node patches/discussion-plaza/tests/core.test.mjs
 */
import assert from 'node:assert/strict'
import {
  DOC_VERSION,
  GROUP_ID_PATTERN,
  MAX_PARTICIPANTS,
  STATUS_CLOSED,
  STATUS_CLOSING,
  STATUS_LABEL,
  STATUS_OPEN,
  allConfirmed,
  authorText,
  createGroupId,
  findParticipant,
  formatStamp,
  normalizeBody,
  normalizeGroup,
  nowIso,
  parseDoc,
  parseMessages,
  pendingConfirmations,
  planAppend,
  planCancelClose,
  planConfirmClose,
  planHumanClose,
  planJoin,
  planLeave,
  planMarkRead,
  planProposeClose,
  planSetStanding,
  pruneIdleParticipants,
  renderDoc,
  sanitizeName,
  sanitizeTitle,
  summarizeGroup,
  unreadOf,
  validateGroup,
} from '../lib/protocol.js'

let passed = 0
let failed = 0

/**
 * 跑一个同步用例并记账。
 * @param label - 用例名。
 * @param run - 用例体。
 */
function test(label, run) {
  try {
    run()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${label}`)
    console.error(error)
  }
}

const A = { sessionId: 's-a', name: 'A', workspace: 'alpha' }
const B = { sessionId: 's-b', name: 'B', workspace: 'beta' }
const C = { sessionId: 's-c', name: 'C', workspace: 'gamma' }
const HUMAN = { sessionId: 'human', name: '人类', workspace: '本机' }
const T0 = '2026-11-20T05:40:00.000Z'
const T1 = '2026-11-20T05:41:00.000Z'
const T2 = '2026-11-20T05:42:00.000Z'
const T3 = '2026-11-20T05:43:00.000Z'

/**
 * 建一个测试用讨论组。
 * @param participants - 参与者身份数组。
 * @param messages - 消息数组。
 * @param patch - 额外元数据。
 */
function makeGroup(participants = [A], messages = [], patch = {}) {
  const stamp = T0
  return normalizeGroup({
    version: 1,
    id: 'dg_abcde_123456',
    title: '接口对齐',
    status: STATUS_OPEN,
    createdAt: stamp,
    updatedAt: stamp,
    createdBy: A,
    participants: participants.map((identity) => ({
      sessionId: identity.sessionId,
      name: identity.name,
      workspace: identity.workspace,
      joinedAt: stamp,
      lastSeenAt: stamp,
      lastReadSeq: 0,
      vote: null,
    })),
    close: null,
    ...patch,
  }, messages)
}

// --- 基础清洗 ----------------------------------------------------------------

test('oneLine / sanitizeTitle 把换行与多余空白压平', () => {
  assert.equal(sanitizeTitle('  第一行\n第二行  '), '第一行 第二行')
  assert.equal(sanitizeTitle(''), '')
  assert.equal(sanitizeTitle('x'.repeat(200)).length, 120)
})

test('sanitizeName 截断到 40 个码点且不切坏代理对', () => {
  assert.equal(sanitizeName('😀'.repeat(60)).length, 80) // 每个 emoji 两个 UTF-16 单元
  assert.equal(Array.from(sanitizeName('😀'.repeat(60))).length, 40)
})

test('normalizeBody 统一换行并去掉首尾空行', () => {
  assert.equal(normalizeBody('\r\n\r\n第一段\r\n第二段\r\n\r\n'), '第一段\n第二段')
})

test('authorText 同名时不重复写工作区', () => {
  assert.equal(authorText({ workspace: 'alpha', name: 'A' }), 'alpha · A')
  assert.equal(authorText({ workspace: 'alpha', name: 'alpha' }), 'alpha')
  assert.equal(authorText({ workspace: '', name: 'A' }), 'A')
})

test('createGroupId 符合 id 形状且避让已占用值', () => {
  const taken = new Set()
  const first = createGroupId(taken, Date.parse(T0))
  assert.match(first, GROUP_ID_PATTERN)
  taken.add(first)
  for (let index = 0; index < 20; index += 1) {
    const id = createGroupId(taken, Date.parse(T0))
    assert.match(id, GROUP_ID_PATTERN)
    assert.ok(!taken.has(id))
    taken.add(id)
  }
})

test('formatStamp 输出本地时间戳', () => {
  assert.match(formatStamp(T0), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
})

// --- 文档往返 ----------------------------------------------------------------

test('renderDoc → parseDoc 往返保留元数据与消息', () => {
  const group = makeGroup([A, B], [
    { seq: 1, at: formatStamp(T0), author: authorText(A), body: '第一段\n\n- 列表\n- 第二项' },
    { seq: 2, at: formatStamp(T1), author: authorText(B), body: '```js\nconsole.log("hi")\n```' },
  ])
  const text = renderDoc(group)
  assert.ok(text.startsWith('---\n'))
  assert.ok(text.includes('\n---\n\n# 接口对齐\n'))
  const parsed = parseDoc(text)
  assert.equal(parsed.group.id, group.id)
  assert.equal(parsed.group.version, DOC_VERSION)
  assert.equal(parsed.group.title, '接口对齐')
  assert.equal(parsed.group.status, STATUS_OPEN)
  assert.equal(parsed.group.participants.length, 2)
  assert.equal(parsed.messages.length, 2)
  assert.equal(parsed.messages[0].body, '第一段\n\n- 列表\n- 第二项')
  assert.equal(parsed.messages[1].body, '```js\nconsole.log("hi")\n```')
  assert.deepEqual(validateGroup(parsed.group), [])
})

test('代码块里的伪消息头不会截断正文', () => {
  const body = [
    '这里引用文档格式：',
    '',
    '```markdown',
    '## 2 · 2026-11-20 13:41:00 · beta · B',
    '这条只是引用',
    '```',
    '',
    '结束。',
  ].join('\n')
  const group = makeGroup([A], [{ seq: 1, at: formatStamp(T0), author: authorText(A), body }])
  const parsed = parseDoc(renderDoc(group))
  assert.equal(parsed.messages.length, 1)
  assert.equal(parsed.messages[0].body, body)
})

test('围栏外 seq 对不上的伪消息头也被当成正文', () => {
  const body = '## 9 · 2026-11-20 13:41:00 · beta · B\n这条不是第 2 条'
  const group = makeGroup([A], [{ seq: 1, at: formatStamp(T0), author: authorText(A), body }])
  const parsed = parseDoc(renderDoc(group))
  assert.equal(parsed.messages.length, 1)
  assert.equal(parsed.messages[0].body, body)
})

test('parseDoc 对缺少 front matter / 坏 JSON 报 group-corrupt', () => {
  assert.throws(() => parseDoc('# 没有 front matter'), (error) => error.code === 'group-corrupt')
  assert.throws(() => parseDoc('---\n{ 不是 json }\n---\n\n# x'), (error) => error.code === 'group-corrupt')
  assert.throws(() => parseDoc('---\n{"id":"bad"}\n---\n\n# x'), (error) => error.code === 'group-corrupt')
})

test('normalizeGroup 丢弃没有 sessionId 的参与者并去重', () => {
  const group = normalizeGroup({
    id: 'dg_abcde_123456',
    title: 't',
    participants: [
      { sessionId: 's-a', name: 'A', workspace: 'alpha' },
      { name: '没有 id' },
      { sessionId: 's-a', name: 'A2', workspace: 'alpha' },
    ],
  }, [])
  assert.equal(group.participants.length, 1)
  assert.equal(group.participants[0].name, 'A', '重复的参与者标识保留先出现的那条')
  assert.equal(group.participants[0].key, 'alpha/s-a')
})

test('参与者标识是「工作区/sessionId」：同 sessionId 换工作区算另一个参与者', () => {
  const group = makeGroup([A])
  const same = planJoin(group, { sessionId: 's-a', name: 'A', workspace: 'alpha' }, T1)
  assert.equal(same.joined, false, '同工作区同 sessionId 是同一人')
  const other = planJoin(group, { sessionId: 's-a', name: 'A', workspace: 'other' }, T1)
  assert.equal(other.joined, true, '不同工作区的同 sessionId 是另一个参与者')
  assert.deepEqual(other.group.participants.map((entry) => entry.key).sort(), ['alpha/s-a', 'other/s-a'])
  assert.equal(findParticipant(other.group, A).key, 'alpha/s-a')
})

// --- 状态机 ------------------------------------------------------------------

test('append 自动加入、seq 连续、作者自己的消息不算未读', () => {
  const group = makeGroup([])
  const { group: next, message, joined } = planAppend(group, A, '你好', T0)
  assert.equal(joined, true)
  assert.equal(message.seq, 1)
  assert.equal(next.participants.length, 1)
  assert.equal(unreadOf(next, 's-a'), 0, '作者不应把自己刚写的那条算成未读')
  assert.equal(next.messages.length, 1)
  assert.equal(next.participants[0].joinedAt, T0, '加入时间就是审计记录')
})

test('append 空正文、关闭确认中、已关闭都拒绝', () => {
  assert.throws(() => planAppend(makeGroup([A]), A, '   ', T0), (error) => error.code === 'empty-message')
  const closing = makeGroup([A], [], { status: STATUS_CLOSING, close: { by: 's-a', at: T0, reason: '' } })
  assert.throws(() => planAppend(closing, A, 'x', T0), (error) => error.code === 'close-pending')
  const closed = makeGroup([A], [], { status: STATUS_CLOSED, close: { by: 's-a', at: T0, reason: '', closedAt: T0 } })
  assert.throws(() => planAppend(closed, A, 'x', T0), (error) => error.code === 'group-closed')
})

test('join 幂等且拒绝加入关闭确认中的讨论组', () => {
  const once = planJoin(makeGroup([]), A, T0)
  assert.equal(once.joined, true)
  const twice = planJoin(once.group, A, T1)
  assert.equal(twice.joined, false)
  const closing = makeGroup([A], [], { status: STATUS_CLOSING, close: { by: 's-a', at: T0, reason: '' } })
  assert.throws(() => planJoin(closing, B, T1), (error) => error.code === 'close-pending')
})

test('单参与者提议关闭立即关闭', () => {
  const group = makeGroup([A])
  const { group: next } = planProposeClose(group, A, '没有别的议题了', T1)
  assert.equal(next.status, STATUS_CLOSED)
  assert.equal(next.close.closedReason, 'single-participant')
  assert.equal(typeof next.close.closedAt, 'string')
  assert.deepEqual(allConfirmed(next.participants), true)
})

test('多参与者必须全员确认才关闭', () => {
  let group = makeGroup([A, B])
  group = planAppend(group, B, 'B 的观点', T0).group
  const proposed = planProposeClose(group, A, '汇总完毕', T1).group
  assert.equal(proposed.status, STATUS_CLOSING)
  assert.equal(pendingConfirmations(proposed).length, 1, '提议者已自动确认')
  const afterA = planConfirmClose(proposed, A, T2).group
  assert.equal(afterA.status, STATUS_CLOSING, 'A 重复确认不应关闭')
  const { group: closed, closed: isClosed } = planConfirmClose(afterA, B, T3)
  assert.equal(isClosed, true)
  assert.equal(closed.status, STATUS_CLOSED)
  assert.equal(closed.close.closedReason, 'all-confirmed')
  assert.deepEqual(validateGroup(closed), [])
})

test('撤回关闭提议回到讨论中并清空投票', () => {
  const group = planProposeClose(makeGroup([A, B]), A, '结束', T1).group
  const reopened = planCancelClose(group, B, '还有一个问题', T2).group
  assert.equal(reopened.status, STATUS_OPEN)
  assert.deepEqual(reopened.participants.map((entry) => entry.vote), [null, null])
  assert.equal(reopened.close.canceledBy, 'beta/s-b')
  assert.equal(reopened.close.cancelReason, '还有一个问题')
  // 撤回之后可以继续发言
  const next = planAppend(reopened, B, '继续讨论', T3).group
  assert.equal(next.messages.length > reopened.messages.length, true)
})

test('长期讨论组：人类标记，Agent 关组被拒，人类可直接结束', () => {
  const marked = planSetStanding(makeGroup([A, B]), true, HUMAN, T1)
  assert.equal(marked.changed, true)
  assert.equal(marked.group.standing, true)
  assert.equal(marked.group.status, STATUS_OPEN)
  assert.ok(marked.group.messages.some((message) => message.body.includes('标记为长期讨论组')))
  assert.throws(() => planProposeClose(marked.group, A, '结束', T2), (error) => error.code === 'standing-group')
  const closed = planHumanClose(marked.group, HUMAN, '项目收尾', T3)
  assert.equal(closed.group.status, STATUS_CLOSED)
  assert.equal(closed.group.standing, true)
  assert.equal(closed.group.close.closedReason, 'human')
  assert.ok(closed.group.messages.some((message) => message.body.includes('结束长期讨论')))
  // 取消标记
  const unmarked = planSetStanding(marked.group, false, HUMAN, T2)
  assert.equal(unmarked.group.standing, false)
  // 普通组不能走人类直接结束
  assert.throws(() => planHumanClose(makeGroup([A]), HUMAN, '', T1), (error) => error.code === 'not-standing')
  // 关闭确认中不能改长期标记
  const closing = planProposeClose(makeGroup([A, B]), A, '结束', T1).group
  assert.throws(() => planSetStanding(closing, true, HUMAN, T2), (error) => error.code === 'close-pending')
})

test('summarizeGroup 带出长期标记', () => {
  const standing = planSetStanding(makeGroup([A]), true, HUMAN, T1).group
  const summary = summarizeGroup(standing, undefined, { identity: A })
  assert.equal(summary.standing, true)
  const normal = summarizeGroup(makeGroup([A]), undefined, { identity: A })
  assert.equal(normal.standing, false)
})


test('关闭确认中有人退出，剩下的都确认就关闭', () => {
  let group = makeGroup([A, B, C])
  group = planProposeClose(group, A, '结束', T1).group
  assert.equal(pendingConfirmations(group).length, 2)
  const left = planLeave(group, C, T2)
  assert.equal(left.closed, false)
  assert.equal(left.group.participants.length, 2)
  const confirmed = planConfirmClose(left.group, B, T3)
  assert.equal(confirmed.closed, true)
})

test('关闭确认中所有参与者都退出，讨论组自动关闭（abandoned）', () => {
  const group = planProposeClose(makeGroup([A, B]), A, '结束', T1).group
  const afterA = planLeave(group, A, T2)
  assert.equal(afterA.closed, false, 'B 还没确认，不能关闭')
  const afterB = planLeave(afterA.group, B, T3)
  assert.equal(afterB.closed, true)
  assert.equal(afterB.group.status, STATUS_CLOSED)
  assert.equal(afterB.group.close.closedReason, 'abandoned')
})

test('失联宽限：超过窗口未响应的参与者被移除后才关闭', () => {
  const proposed = planProposeClose(makeGroup([A, B]), A, '结束', T1).group
  // 把 B 的 lastSeenAt 拨到提议之前（模拟失联）。
  const stale = {
    ...proposed,
    participants: proposed.participants.map((entry) => entry.sessionId === 's-b'
      ? { ...entry, lastSeenAt: T0 }
      : entry),
  }
  const strict = planConfirmClose(stale, A, T2, { graceMs: 0 })
  assert.equal(strict.closed, false, '严格模式不应自动放行')
  const lenient = planConfirmClose(stale, A, T2, { graceMs: 1 })
  assert.equal(lenient.pruned.length, 1)
  assert.equal(lenient.closed, true)
  assert.ok(lenient.group.messages.some((entry) => entry.author === '系统' && entry.body.includes('未响应')))
})

test('宽限未到时不清理', () => {
  const proposed = planProposeClose(makeGroup([A, B]), A, '结束', T1).group
  const early = planConfirmClose(proposed, B, T1, { graceMs: 60_000 })
  assert.equal(early.pruned.length, 0)
})

test('pruneIdleParticipants 只在关闭确认中生效', () => {
  const open = makeGroup([A, B])
  const result = pruneIdleParticipants(open, T2, 1)
  assert.equal(result.removed.length, 0)
})

test('markRead 只前进不后退', () => {
  let group = planAppend(makeGroup([A]), A, '一', T0).group
  group = planAppend(group, B, '二', T1).group
  const read = planMarkRead(group, A, 2, T2)
  assert.equal(findParticipant(read.group, A).lastReadSeq, 2)
  const backwards = planMarkRead(read.group, A, 1, T3)
  assert.equal(findParticipant(backwards.group, A).lastReadSeq, 2)
  assert.equal(unreadOf(read.group, A), 0)
})

test('参与者上限', () => {
  const identities = Array.from({ length: MAX_PARTICIPANTS }, (_, index) => ({
    sessionId: `s-${index}`,
    name: `N${index}`,
    workspace: 'alpha',
  }))
  const group = makeGroup(identities)
  assert.throws(() => planJoin(group, { sessionId: 'overflow', name: 'X', workspace: 'beta' }, T1), (error) => error.code === 'too-many-participants')
})

test('summarizeGroup 带出状态、未读、锁与末条消息', () => {
  const group = planAppend(makeGroup([A, B]), B, '摘要正文', T1).group
  const summary = summarizeGroup(group, {
    token: 'lk_x',
    holder: { key: 'beta/s-b', sessionId: 's-b', name: 'B', workspace: 'beta' },
    purpose: 'append',
    acquiredAt: T1,
    expiresAtMs: Date.parse(T1) + 60_000,
  }, { identity: A, path: 'C:/plaza/groups/dg_abcde_123456.md' })
  assert.equal(summary.id, 'dg_abcde_123456')
  assert.equal(summary.statusLabel, STATUS_LABEL[STATUS_OPEN])
  assert.equal(summary.writing, true)
  assert.equal(summary.lock.holder.name, 'B')
  assert.equal(summary.lock.holder.key, 'beta/s-b')
  assert.equal(summary.youAreParticipant, true)
  assert.equal(summary.yourUnread > 0, true)
  assert.equal(summary.participants[0].key, 'alpha/s-a')
  assert.equal(summary.lastMessage.excerpt, '摘要正文')
  assert.equal(summary.path.endsWith('.md'), true)
})

test('validateGroup 抓出关闭状态与记录不一致', () => {
  const broken = makeGroup([A], [], { status: STATUS_CLOSING, close: null })
  assert.ok(validateGroup(broken).some((problem) => problem.includes('close')))
  const closed = makeGroup([A], [], { status: STATUS_CLOSED, close: { by: 's-a', at: T0, reason: '' } })
  assert.ok(validateGroup(closed).some((problem) => problem.includes('closedAt')))
})

test('nowIso 对非法日期回退当前时间', () => {
  assert.match(nowIso('not-a-date'), /^\d{4}-\d{2}-\d{2}T/)
})

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'} — ok ${passed} / fail ${failed}`)
if (failed > 0) process.exitCode = 1
