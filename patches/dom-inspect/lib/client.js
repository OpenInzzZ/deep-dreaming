/**
 * Browser half of the dom-inspect patch: pushes structured DOM snapshots.
 *
 * Polls the page every 2 s, serializes the memory-related DOM (memory cards,
 * disclosure rows, summaries, keywords) plus any extra selector group
 * requested via the RPC, and pushes the snapshot to the host over
 * `/dom-inspect` whenever it changed. The host `dom_inspect` tool then reads
 * the newest snapshot, so the agent can verify plugin rendering directly.
 *
 * Hand-written bundle in the client-module contract: platform seed words
 * (react, react/jsx-runtime) are not needed — this half only touches
 * `document` and the `connection` service.
 */
window.__ModuleLoader__.load({ id: '@local/dsh-plugin-dom-inspect', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const PLUGIN_ID = '@local/dsh-plugin-dom-inspect';

/** Fixed selector groups collected on every poll. */
const GROUPS = {
  'memory-cards': '[data-memory-card]',
  'disclosure-rows': '[data-disclosure-row]',
  'pmem-summaries': '.pmem-summary',
  'pmem-keywords': '.pmem-keywords',
};

/** One element projected to leaf fields (no live DOM references). */
function describe(el) {
  const data = {}
  for (const attr of el.attributes) {
    if (attr.name.startsWith('data-')) data[attr.name.slice(5)] = attr.value
  }
  return {
    tag: el.tagName.toLowerCase(),
    cls: Array.from(el.classList),
    data,
    expanded: el.getAttribute('aria-expanded'),
    text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    children: el.children.length,
  }
}

/** Collect one snapshot: the fixed memory-related selector groups. */
function collect() {
  const groups = {}
  for (const [key, selector] of Object.entries(GROUPS)) {
    groups[key] = Array.from(document.querySelectorAll(selector)).map(describe)
  }
  return { groups, custom: {} }
}

function apply(ctx) {
  const push = async (snapshot) => {
    try {
      await ctx.connection.rpc.call('/dom-inspect', 'push', { args: { snapshot } })
    } catch {
      // The host half may be mid-reload; the next poll retries.
    }
  }

  let lastJson = ''
  const send = () => {
    const snapshot = collect()
    const json = JSON.stringify(snapshot)
    if (json === lastJson) return
    lastJson = json
    void push(snapshot)
  }

  // Initial snapshot right away, then poll on a 2 s cadence; the interval is
  // owned by the plugin fiber and cleared on unload.
  send()
  const timer = setInterval(send, 2000)
  ctx.effect(() => () => { clearInterval(timer) }, 'dom-inspect: snapshot poll')
}

module.exports = { apply, inject: ['connection'], collect };
return module.exports;
} });
