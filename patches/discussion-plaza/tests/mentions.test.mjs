/**
 * discussion-plaza 的点名解析测试（纯逻辑）。
 *
 * 关键边界：`@alpha` 不能误中 `@alphabet`；发送者自己不能唤醒；显式 `wake` 与
 * 正文 `@提及` 二选一；重复提及只算一次。
 *
 * 从仓库根运行：
 *   node patches/discussion-plaza/tests/mentions.test.mjs
 */
import assert from 'node:assert/strict'
import { MAX_WAKE_TARGETS, hasMention, presentWakeTarget, resolveWakeTargets } from '../lib/mentions.js'

let passed = 0
let failed = 0

/**
 * 跑一个用例并记账。
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

const A = { key: 'alpha/s-a', sessionId: 's-a', workspace: 'alpha', name: 'A' }
const B = { key: 'beta/s-b', sessionId: 's-b', workspace: 'beta', name: 'B' }
const C = { key: 'gamma/s-c', sessionId: 's-c', workspace: 'gamma', name: 'Sitewalk 负责人' }
const group = { participants: [A, B, C] }
const sender = { sessionId: 's-a', workspace: 'alpha', name: 'A' }

test('正文 @工作区 命中参与者', () => {
  const targets = resolveWakeTargets(group, '请 @beta 看一下这个结论', sender)
  assert.deepEqual(targets.map(({ participant }) => participant.key), ['beta/s-b'])
  assert.equal(targets[0].via, 'mention')
})

test('@key 与 @名称 都能命中', () => {
  assert.deepEqual(
    resolveWakeTargets(group, '请 @beta/s-b 确认', sender).map(({ participant }) => participant.key),
    ['beta/s-b'],
  )
  assert.deepEqual(
    resolveWakeTargets(group, '请 @Sitewalk 负责人 确认', sender).map(({ participant }) => participant.key),
    ['gamma/s-c'],
  )
  assert.deepEqual(
    resolveWakeTargets(group, '请 @B 确认', sender).map(({ participant }) => participant.key),
    ['beta/s-b'],
  )
})

test('提及边界：@alpha 不误中 @alphabet / @alphax', () => {
  assert.equal(hasMention('@alphabet', 'alpha'), false)
  assert.equal(hasMention('@alphax', 'alpha'), false)
  assert.equal(hasMention('@alpha 你好', 'alpha'), true)
  assert.equal(hasMention('@alpha，你好', 'alpha'), true)
  assert.equal(hasMention('@alpha。', 'alpha'), true)
  assert.equal(hasMention('@alpha', 'alpha'), true)
})

test('发送者自己不会被点名唤醒', () => {
  assert.deepEqual(resolveWakeTargets(group, '@alpha 我自己', sender), [])
})

test('显式 wake 优先于正文提及；wake: [] 表示明确不唤醒', () => {
  assert.deepEqual(
    resolveWakeTargets(group, '正文里 @beta 但显式点 gamma', sender, ['gamma']).map(({ participant }) => participant.key),
    ['gamma/s-c'],
  )
  assert.deepEqual(
    resolveWakeTargets(group, '正文里 @beta', sender, ['@beta']).map(({ participant }) => participant.key),
    ['beta/s-b'],
  )
  assert.deepEqual(resolveWakeTargets(group, '正文里 @beta', sender, []), [])
})

test('重复提及只算一次', () => {
  const targets = resolveWakeTargets(group, '@beta 和 @beta/s-b 以及 @beta', sender)
  assert.equal(targets.length, 1)
})

test('拼错的提及不会命中任何人', () => {
  assert.deepEqual(resolveWakeTargets(group, '@nobody 你好', sender), [])
})

test('presentWakeTarget 只暴露 key/workspace/name', () => {
  assert.deepEqual(presentWakeTarget(B), { key: 'beta/s-b', workspace: 'beta', name: 'B' })
  assert.ok(MAX_WAKE_TARGETS > 0)
})

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'} — ok ${passed} / fail ${failed}`)
if (failed > 0) process.exitCode = 1
