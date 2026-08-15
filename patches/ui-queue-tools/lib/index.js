/**
 * Host half of the ui-queue-tools patch: a queue-reorder RPC endpoint.
 *
 * Exposes a dedicated Connection RPC channel `/queue` (the shared `/api`
 * channel is exclusively owned by the Typert gateway). The `reorder` endpoint
 * moves one still-pending queued message within the agent's `next-turn` inbox
 * list using the Inbox's standard `splice` semantics, so the durable
 * `agent/inbox/spliced` event stream broadcasts the new order to every client
 * exactly like an append/remove would.
 *
 * The queue dock only ever renders `next-turn` items (placement "queued"), so
 * the target index is relative to that one list — no cross-list math needed.
 *
 * Deliberately dependency-free apart from `node:child_process`-free code: the
 * host entry imports nothing but the injected services.
 */

/** Locate one pending message's list position, or undefined when not pending. */
function locate(agent, itemId) {
  const inbox = agent.inbox
  if (inbox.nextTurn.some((message) => message.id === itemId)) {
    return { target: 'next-turn', from: inbox.nextTurn.findIndex((message) => message.id === itemId) }
  }
  if (inbox.nextStep.some((message) => message.id === itemId)) {
    return { target: 'next-step', from: inbox.nextStep.findIndex((message) => message.id === itemId) }
  }
  return undefined
}

const notFound = (itemId) => ({
  ok: false,
  error: {
    code: 'queue-item-not-found',
    message: 'queued item is no longer pending',
    details: { itemId },
  },
})

/**
 * Move one pending queue item to `toIndex` (0-based FINAL position in the
 * same pending list, i.e. where the item should sit after the move).
 * @param agent - live agent whose inbox owns the item.
 * @param itemId - pending message id.
 * @param toIndex - target final position.
 */
export function reorderQueueItem(agent, itemId, toIndex) {
  const found = locate(agent, itemId)
  if (found === undefined) return notFound(itemId)
  const { target, from } = found
  const inbox = agent.inbox
  const list = () => (target === 'next-turn' ? inbox.nextTurn : inbox.nextStep)

  const removed = inbox.splice(target, from, 1, [])
  if (removed.length === 0) return notFound(itemId)

  // The removal already shifted later items left by one, so the insertion
  // position equals the requested final position directly (no from offset).
  let to = Number.isInteger(toIndex) ? toIndex : from
  to = Math.max(0, Math.min(to, list().length))
  inbox.splice(target, to, 0, removed)
  return { ok: true, value: { accepted: true, to } }
}

/** Handle one endpoint on the `/queue` channel. */
async function handleEndpoint(endpoint, payload) {
  if (endpoint !== 'reorder') {
    return {
      ok: false,
      error: { code: 'bad-request', message: `unknown endpoint: ${endpoint}`, details: {} },
    }
  }
  const args = payload?.args
  const sessionId = args?.sessionId
  const itemId = args?.itemId
  const toIndex = args?.toIndex
  if (typeof sessionId !== 'string' || typeof itemId !== 'string' || !Number.isInteger(toIndex)) {
    return {
      ok: false,
      error: {
        code: 'bad-request',
        message: 'reorder requires sessionId (string), itemId (string), toIndex (integer)',
        details: {},
      },
    }
  }
  const agent = this.agents.get(sessionId)
  if (agent === undefined) {
    return {
      ok: false,
      error: {
        code: 'queue-item-not-found',
        message: 'session has no live agent',
        details: { sessionId },
      },
    }
  }
  return reorderQueueItem(agent, itemId, toIndex)
}

/** Cordis plugin entry: register the `/queue` RPC channel on the Connection. */
export function apply(ctx) {
  // `ctx.inject` returns a thenable Fiber; returning it from `apply` makes
  // Cordis treat it as an Effect and fail with TypeError('Invalid effect').
  // The child fiber's disposer is registered on the parent automatically.
  ctx.inject(['connection', 'agents'], (ctx) => {
    const bound = handleEndpoint.bind({ agents: ctx.agents })
    return ctx.connection.rpc.handle('/queue', bound, { authority: 'loopback' })
  })
}

export { handleEndpoint }
