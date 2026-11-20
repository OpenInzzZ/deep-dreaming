/**
 * discussion-plaza 的「点名」解析（纯逻辑，不碰 Cordis）。
 *
 * 发言正文里写 `@工作区`（例如 `@taikoo-ai-platform`）或显式给 `wake: [...]`，
 * 就点名了参与者。只有被点名的参与者会被唤醒；没点名就只留在广场里等下一次
 * 拉取（人看左下角角标）。这样默认安静，需要对方回应时才付出一个模型 turn。
 *
 * 匹配顺序：参与者 key（工作区/sessionId）→ 工作区名 → 显示名。token 后面必须是
 * 空白/常见标点/结尾，避免 `@alpha` 误中 `@alphabet`。
 */
import { MAX_PARTICIPANTS, participantKey } from './protocol.js'

/** 一次发言最多唤醒多少人，防止一条消息把全组拉起来。 */
export const MAX_WAKE_TARGETS = 8

/** 正则转义。 */
export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 提及 token 之后允许的边界字符（不含字母数字，避免前缀误中）。 */
const MENTION_BOUNDARY = '(?=$|[\\s，,。.；;：:、!！?？)）\\]】])'

/**
 * 正文里有没有 `@token`（带边界）。
 * @param body - 发言正文。
 * @param token - 工作区 / key / 名称。
 */
export function hasMention(body, token) {
  if (typeof body !== 'string' || typeof token !== 'string' || token.length === 0) return false
  return new RegExp(`@${escapeRegExp(token)}${MENTION_BOUNDARY}`).test(body)
}

/**
 * 解析被点名的参与者。
 *
 * - 显式 `wake` 数组存在时只按它解析（`wake: []` 表示明确不唤醒）；
 * - 否则按正文里的 `@工作区` / `@key` / `@名称` 解析；
 * - 永远排除发送者自己；
 * - 结果按参与者顺序去重，带 `via`（`explicit` / `mention`）。
 *
 * @param group - 讨论组（用其 participants）。
 * @param body - 发言正文。
 * @param sender - 发送者身份（含 key）。
 * @param explicit - 显式 wake 列表（可选）。
 * @returns `[{ participant, via }]`
 */
export function resolveWakeTargets(group, body, sender, explicit) {
  const participants = Array.isArray(group?.participants) ? group.participants : []
  const senderKey = typeof sender === 'string' ? sender : participantKey(sender)
  const chosen = new Map()
  const add = (participant, via) => {
    if (participant.key === senderKey || chosen.has(participant.key)) return
    chosen.set(participant.key, { participant, via })
  }

  if (Array.isArray(explicit)) {
    for (const raw of explicit) {
      const value = String(raw ?? '').trim().replace(/^@/, '')
      if (value.length === 0) continue
      for (const participant of participants) {
        if (participant.key === value || participant.workspace === value || participant.name === value) {
          add(participant, 'explicit')
        }
      }
    }
    return [...chosen.values()]
  }

  for (const participant of participants) {
    if (participant.key === senderKey) continue
    for (const token of [participant.key, participant.workspace, participant.name]) {
      if (token.length === 0) continue
      if (hasMention(body, token)) {
        add(participant, 'mention')
        break
      }
    }
  }
  return [...chosen.values()]
}

/** 唤醒结果 / 提及对象的对外形状（工具输出 schema 与 render 共用）。 */
export function presentWakeTarget(participant) {
  return {
    key: participant.key,
    workspace: participant.workspace,
    name: participant.name,
  }
}

/** 参与者列表里最多能点名多少人（导出给文档与测试）。 */
export const MAX_WAKE_PARTICIPANTS = MAX_PARTICIPANTS
