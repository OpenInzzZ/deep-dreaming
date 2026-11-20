/**
 * discussion-plaza 的存储层测试：真文件、真锁、真并发。
 *
 * 这一层最容易出的问题是**丢失更新**与**死锁**：
 *   - 两个会话同时 append，后写的把先写的覆盖掉（读-改-写没有互斥）
 *   - 进程崩溃后锁永远不释放（没有租约）
 *   - 过期锁被别人回收后，旧持有者仍能写（没有 fencing token）
 * 所以用例刻意同时开多个写者、把锁文件 mtime 拨到过去、用旧 token 重试。
 *
 * 从仓库根运行：
 *   node patches/discussion-plaza/tests/store.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, utimes, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as store from '../lib/store.js'
import { GROUP_ID_PATTERN, parseDoc, validateGroup } from '../lib/protocol.js'

const A = { sessionId: 's-a', name: 'A', workspace: 'alpha' }
const B = { sessionId: 's-b', name: 'B', workspace: 'beta' }
const HUMAN = { sessionId: 'human', name: '人类', workspace: '本机' }

const sandbox = await mkdtemp(join(tmpdir(), 'plaza-store-'))
const paths = store.plazaPaths(join(sandbox, 'plaza'))

let passed = 0
let failed = 0

/**
 * 跑一个异步用例并记账。
 * @param label - 用例名。
 * @param run - 用例体。
 */
async function test(label, run) {
  try {
    await run()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${label}`)
    console.error(error)
  }
}

/** 新建一个讨论组并返回 id。 */
async function fresh(title = '测试讨论', intro = '开场') {
  const { group } = await store.createGroup(paths, { title, intro, by: A })
  return group.id
}

/** 读文件原文并断言文档自洽。 */
async function assertDocSound(id) {
  const text = await readFile(store.groupPath(paths, id), 'utf8')
  const parsed = parseDoc(text)
  assert.equal(parsed.group.id, id)
  assert.deepEqual(validateGroup(parsed.group), [])
  return parsed
}

await test('createGroup 落盘一份可解析的 Markdown 文档', async () => {
  const id = await fresh('接口对齐', '第一段')
  assert.match(id, GROUP_ID_PATTERN)
  const parsed = await assertDocSound(id)
  assert.equal(parsed.group.title, '接口对齐')
  assert.equal(parsed.group.status, 'open')
  assert.equal(parsed.group.participants.length, 1)
  assert.equal(parsed.group.participants[0].sessionId, 's-a')
  assert.equal(parsed.messages.length, 1)
  assert.equal(parsed.messages[0].body, '第一段')
  assert.equal(parsed.messages[0].author, 'alpha · A')
})

await test('createGroup 拒绝空标题，人类创建不自动成为参与者', async () => {
  await assert.rejects(() => store.createGroup(paths, { title: '  ', by: A }), (error) => error.code === 'title-required')
  const { group } = await store.createGroup(paths, { title: '人类发起的议题', by: HUMAN })
  assert.equal(group.participants.length, 0)
  const listed = await store.listGroups(paths, {})
  assert.equal(listed.groups.find((entry) => entry.id === group.id).participantCount, 0)
})

await test('listGroups 过滤关闭组、query 与 mine', async () => {
  const id = await fresh('唯一关键词讨论组', '')
  const mine = await store.listGroups(paths, { identity: A, query: '唯一关键词' })
  assert.deepEqual(mine.groups.map((entry) => entry.id), [id])
  assert.equal(mine.groups[0].youAreParticipant, true)
  const other = await store.listGroups(paths, { identity: B, query: '唯一关键词' })
  assert.equal(other.groups[0].youAreParticipant, false)
  const closed = await store.proposeClose(paths, id, A, '结束')
  assert.equal(closed.group.status, 'closed')
  assert.equal((await store.listGroups(paths, {})).groups.some((entry) => entry.id === id), false)
  assert.equal((await store.listGroups(paths, { includeClosed: true })).groups.some((entry) => entry.id === id), true)
})

await test('append 自动加入、seq 连续、未读只对别人增加', async () => {
  const id = await fresh('未读测试', '一')
  const second = await store.appendMessage(paths, id, B, '二')
  assert.equal(second.message.seq, 2)
  assert.equal(second.joined, true)
  const asA = await store.readGroup(paths, id, { identity: A })
  assert.equal(asA.summary.yourUnread, 1, 'A 没读 B 的第二条')
  assert.equal(asA.messages.length, 2)
  const asB = await store.readGroup(paths, id, { identity: B })
  assert.equal(asB.summary.yourUnread, 0)
  await assertDocSound(id)
})

await test('并发 append 不丢更新（10 个写者）', async () => {
  const id = await fresh('并发测试', '')
  const writers = Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? A : B))
  await Promise.all(writers.map((identity, index) => store.appendMessage(paths, id, identity, `并发消息 ${index}`, { waitMs: 8000 })))
  const parsed = await assertDocSound(id)
  assert.equal(parsed.messages.length, 10)
  for (let index = 0; index < parsed.messages.length; index += 1) {
    assert.equal(parsed.messages[index].seq, index + 1)
  }
  const bodies = parsed.messages.map((message) => message.body).sort()
  assert.deepEqual(bodies, writers.map((_, index) => `并发消息 ${index}`).sort())
  assert.equal(new Set([A, B].map((identity) => identity.sessionId)).size, 2)
})

await test('锁：第二个写者拿到 lock-busy，释放后可以取到', async () => {
  const id = await fresh('锁测试', '')
  const first = await store.acquireLock(paths, id, A, { ttlMs: 60_000, waitMs: 0 })
  await assert.rejects(
    () => store.acquireLock(paths, id, B, { ttlMs: 60_000, waitMs: 0 }),
    (error) => error.code === 'lock-busy' && error.details.holder.sessionId === 's-a',
  )
  assert.equal((await store.describeLock(paths, id)).holder.name, 'A')
  await store.releaseLock(paths, id, first.token)
  assert.equal(await store.describeLock(paths, id), undefined)
  const second = await store.acquireLock(paths, id, B, { ttlMs: 60_000, waitMs: 0 })
  assert.equal(second.holder.sessionId, 's-b')
  await store.releaseLock(paths, id, second.token)
})

await test('同一会话重复取锁是续约，token 不变', async () => {
  const id = await fresh('续约测试', '')
  const first = await store.acquireLock(paths, id, A, { ttlMs: 60_000, waitMs: 0 })
  await utimes(store.lockPath(paths, id), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000))
  const again = await store.acquireLock(paths, id, A, { ttlMs: 60_000, waitMs: 0, refreshOwn: true })
  assert.equal(again.token, first.token)
  const current = await store.describeLock(paths, id)
  assert.ok(current.expiresAtMs > Date.now() + 55_000, '续约应把 mtime 拉回现在')
  await store.releaseLock(paths, id, first.token)
})

await test('过期锁被回收：新持有者取到锁，旧 token 被 fencing 拒绝', async () => {
  const id = await fresh('过期测试', '')
  const stale = await store.acquireLock(paths, id, A, { ttlMs: 15_000, waitMs: 0 })
  const past = new Date(Date.now() - 60_000)
  await utimes(store.lockPath(paths, id), past, past)
  const freshLock = await store.acquireLock(paths, id, B, { ttlMs: 60_000, waitMs: 0 })
  assert.equal(freshLock.holder.sessionId, 's-b')
  await assert.rejects(
    () => store.appendMessage(paths, id, A, '陈旧写入', { token: stale.token }),
    (error) => error.code === 'lock-not-owner' || error.code === 'lock-expired',
  )
  await store.releaseLock(paths, id, freshLock.token)
})

await test('持锁连续写入（lockToken）后释放', async () => {
  const id = await fresh('长锁测试', '')
  const lock = await store.acquireLock(paths, id, A, { ttlMs: 60_000, waitMs: 0 })
  const one = await store.appendMessage(paths, id, A, '第一条', { token: lock.token })
  const two = await store.appendMessage(paths, id, A, '第二条', { token: lock.token })
  assert.equal(one.lockHeld, true)
  assert.equal(two.lockHeld, true)
  assert.equal((await store.describeLock(paths, id)).token, lock.token, '带 token 写入不应释放锁')
  await store.releaseLock(paths, id, lock.token)
})

await test('关闭流程：提议后不可写，全员确认后只读', async () => {
  const id = await fresh('关闭流程', '')
  await store.joinGroup(paths, id, B)
  const proposed = await store.proposeClose(paths, id, A, '结论已定')
  assert.equal(proposed.group.status, 'closing')
  await assert.rejects(() => store.appendMessage(paths, id, B, '还想说'), (error) => error.code === 'close-pending')
  const confirmed = await store.confirmClose(paths, id, B)
  assert.equal(confirmed.closed, true)
  assert.equal(confirmed.group.status, 'closed')
  await assert.rejects(() => store.appendMessage(paths, id, A, '迟到'), (error) => error.code === 'group-closed')
  await assertDocSound(id)
})

await test('撤回关闭提议后可以继续写', async () => {
  const id = await fresh('撤回流程', '')
  await store.joinGroup(paths, id, B)
  await store.proposeClose(paths, id, A, '结束')
  const canceled = await store.cancelClose(paths, id, B, '还有问题')
  assert.equal(canceled.group.status, 'open')
  const written = await store.appendMessage(paths, id, B, '继续')
  assert.equal(written.message.seq > 1, true)
})

await test('关闭确认中退出：剩余参与者确认即关闭', async () => {
  const id = await fresh('退出流程', '')
  await store.joinGroup(paths, id, B)
  await store.proposeClose(paths, id, A, '结束')
  const left = await store.leaveGroup(paths, id, B, { identity: B })
  assert.equal(left.left, true)
  assert.equal(left.closed, true, 'A 已确认且在，B 退出后应关闭')
  assert.equal(left.group.status, 'closed')
})

await test('失联宽限：confirmClose 在宽限后移除未响应的参与者', async () => {
  const id = await fresh('宽限流程', '')
  await store.joinGroup(paths, id, B)
  await store.proposeClose(paths, id, A, '结束')
  // 把 B 的 lastSeenAt 拨到提议之前，模拟失联。
  const { group } = await store.readGroupFile(paths, id)
  const rewritten = {
    ...group,
    participants: group.participants.map((entry) => entry.sessionId === 's-b'
      ? { ...entry, lastSeenAt: '2020-01-01T00:00:00.000Z' }
      : entry),
  }
  await store.saveGroupFile(paths, rewritten)
  const strict = await store.confirmClose(paths, id, A, { graceMs: 0 })
  assert.equal(strict.closed, false, '严格模式不该放行')
  const lenient = await store.confirmClose(paths, id, A, { graceMs: 1 })
  assert.equal(lenient.closed, true)
  assert.equal(lenient.pruned.length, 1)
  const parsed = await assertDocSound(id)
  assert.equal(parsed.group.participants.some((entry) => entry.sessionId === 's-b'), false)
})

await test('markRead 落盘并清除未读', async () => {
  const id = await fresh('已读测试', '')
  await store.appendMessage(paths, id, B, '给 A 的消息')
  const before = await store.readGroup(paths, id, { identity: A })
  assert.equal(before.summary.yourUnread, 1)
  const marked = await store.markRead(paths, id, A, before.summary.messageCount)
  assert.equal(marked.unread, 0)
  const after = await store.readGroup(paths, id, { identity: A })
  assert.equal(after.summary.yourUnread, 0)
})

await test('人类强制解除写锁 / 移除参与者', async () => {
  const id = await fresh('人类操作', '')
  await store.joinGroup(paths, id, B)
  const lock = await store.acquireLock(paths, id, A, { ttlMs: 60_000, waitMs: 0 })
  const forced = await store.forceUnlock(paths, id)
  assert.equal(forced.released, true)
  assert.equal(forced.holder.sessionId, 's-a')
  const removed = await store.removeParticipant(paths, id, 'beta/s-b', HUMAN)
  assert.equal(removed.left, true)
  const parsed = await assertDocSound(id)
  assert.equal(parsed.group.participants.some((entry) => entry.sessionId === 's-b'), false)
  assert.ok(parsed.messages.some((message) => message.author === '系统' && message.body.includes('移出讨论')))
  await store.releaseLock(paths, id, lock.token).catch(() => undefined)
})

await test('长期讨论组：人类标记/取消、列表置顶、Agent 关闭被拒、人类结束', async () => {
  const id = await fresh('长期组', '开场')
  const marked = await store.setStanding(paths, id, true, HUMAN)
  assert.equal(marked.changed, true)
  assert.equal(marked.group.standing, true)
  const listed = await store.listGroups(paths, {})
  assert.equal(listed.groups[0].id, id, '长期讨论组应排在最前')
  await assert.rejects(() => store.proposeClose(paths, id, A, '结束'), (error) => error.code === 'standing-group')
  const closed = await store.closeStanding(paths, id, HUMAN, '收尾')
  assert.equal(closed.group.status, 'closed')
  assert.equal(closed.group.close.closedReason, 'human')
  assert.equal(closed.group.standing, true)
  await assertDocSound(id)

  const other = await fresh('普通组', '')
  await store.setStanding(paths, other, true, HUMAN)
  const unmarked = await store.setStanding(paths, other, false, HUMAN)
  assert.equal(unmarked.group.standing, false)

  const created = await store.createGroup(paths, { title: '创建即长期', by: HUMAN, standing: true })
  assert.equal(created.group.standing, true)
  assert.equal(created.group.participants.length, 0)
})

await test('非法 id 与坏文档：一个拒绝访问、一个被列出为 invalid', async () => {
  await assert.rejects(() => store.readGroup(paths, '../../etc/passwd'), (error) => error.code === 'group-not-found')
  const corruptId = 'dg_abcde_ffffff'
  await mkdir(paths.groups, { recursive: true })
  await writeFile(store.groupPath(paths, corruptId), '# 没有 front matter\n', 'utf8')
  await assert.rejects(() => store.readGroup(paths, corruptId), (error) => error.code === 'group-corrupt')
  const listed = await store.listGroups(paths, {})
  assert.ok(listed.invalid.includes(corruptId))
})

await test('非法状态迁移给出机器可读错误码', async () => {
  const id = await fresh('错误码', '')
  await assert.rejects(() => store.confirmClose(paths, id, A), (error) => error.code === 'not-closing')
  await assert.rejects(() => store.cancelClose(paths, id, A, 'x'), (error) => error.code === 'not-closing')
  await store.joinGroup(paths, id, B)
  await store.proposeClose(paths, id, A, '结束')
  await assert.rejects(() => store.proposeClose(paths, id, A, '再结束一次'), (error) => error.code === 'close-pending')
  await assert.rejects(
    () => store.confirmClose(paths, id, { sessionId: 's-c', name: 'C', workspace: 'gamma' }),
    (error) => error.code === 'not-participant',
  )
})

await rm(sandbox, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'} — ok ${passed} / fail ${failed}`)
if (failed > 0) process.exitCode = 1
