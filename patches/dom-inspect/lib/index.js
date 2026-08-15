/**
 * Host half of the dom-inspect patch: a model tool that returns the latest
 * browser DOM snapshot.
 *
 * The browser half (`./client`) polls the page every 2 s and pushes a
 * structured DOM snapshot over the `/dom-inspect` RPC channel whenever it
 * changes. This host half stores the newest snapshot in memory and exposes
 * it as the `dom_inspect` tool, so the agent can verify how plugins render
 * (memory cards, disclosure rows, an extra selector) without screenshots.
 *
 * Tool args and returns are JSON; the snapshot holds only leaf fields
 * (tag, classes, data-* attributes, truncated text, child count).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dom-inspect'

/** Newest snapshot pushed by the browser page; null until the first push. */
let latest = null

/** Drop the stored snapshot (tests only). */
export function _resetForTests() {
  latest = null
}

/** Snapshot storage endpoint used by the browser half. */
export function apply(ctx) {
  // Statement call on purpose: returning the ctx.inject() thenable Fiber from
  // apply makes Cordis throw TypeError('Invalid effect') (see repo memory).
  ctx.inject(['tools', 'connection'], (ctx) => {
    const disposeRpc = ctx.connection.rpc.handle('/dom-inspect', async (endpoint, payload) => {
      if (endpoint === 'push') {
        const snapshot = payload?.args?.snapshot
        if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
          return { ok: false, error: { code: 'bad-request', message: 'push requires a snapshot object', details: {} } }
        }
        latest = { at: Date.now(), snapshot }
        return { ok: true, value: { accepted: true } }
      }
      return { ok: false, error: { code: 'bad-request', message: `unknown endpoint: ${endpoint}`, details: {} } }
    }, { authority: 'loopback' })

    const disposeTool = ctx.tools.register(defineTool({
      name: 'dom_inspect',
      description: 'Return the latest browser DOM snapshot pushed by the dsh web page: memory cards ([data-memory-card]), disclosure rows ([data-disclosure-row]), memory summaries/keywords. Use it to verify how plugins render (collapsed/expanded state, keywords, notice rows) without screenshots. Returns available:false until the page has pushed a snapshot.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            available: { type: 'boolean', required: true },
            reason: { type: 'string' },
            at: { type: 'string' },
            ageMs: { type: 'integer' },
            groups: {
              type: 'object',
              additionalProperties: false,
              properties: {
                'memory-cards': { type: 'array', items: { type: 'object', additionalProperties: true } },
                'disclosure-rows': { type: 'array', items: { type: 'object', additionalProperties: true } },
                'pmem-summaries': { type: 'array', items: { type: 'object', additionalProperties: true } },
                'pmem-keywords': { type: 'array', items: { type: 'object', additionalProperties: true } },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.available !== true || value.groups === undefined) {
            return [{ type: 'text', text: `DOM snapshot unavailable: ${value.reason ?? 'no snapshot yet'}` }]
          }
          const lines = [`DOM snapshot at ${value.at} (age ${value.ageMs}ms)`]
          const cardCount = (value.groups['memory-cards'] ?? []).length
          const rowCount = (value.groups['disclosure-rows'] ?? []).length
          lines.push(`memory cards: ${cardCount} | disclosure rows: ${rowCount}`)
          for (const card of value.groups['memory-cards'] ?? []) {
            lines.push(`  - ${card.text ?? ''}`.slice(0, 160))
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      execute: async () => {
        if (latest === null) {
          return { available: false, reason: 'no snapshot pushed yet (page not loaded, or the dom-inspect client half is not mounted)' }
        }
        return {
          available: true,
          at: new Date(latest.at).toISOString(),
          ageMs: Date.now() - latest.at,
          groups: latest.snapshot.groups ?? {},
        }
      },
      presentCall: () => ({
        card: 'generic',
        title: 'Inspect browser DOM',
        kind: 'read',
      }),
    }))

    return () => { disposeRpc(); disposeTool() }
  })
}
