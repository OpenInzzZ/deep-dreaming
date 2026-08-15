/**
 * Browser half of dsh-project-memory: collapsible "memory phase" cards.
 *
 * Registers `tool.call.toolview` for the three project-memory tools
 * (project_memory_save / search / list), so every memory action in a session
 * renders as one collapsible card — header shows the memory badge + title +
 * a one-line summary, expanding reveals the full result text. This mirrors
 * the collapsible rows the shipped UI uses for terminal runs and tool calls,
 * giving the session-end memory review a compact, distinguishable "memory
 * phase" look.
 *
 * Hand-written bundle in the client-module contract: only platform seed
 * words (react, react/jsx-runtime) plus the slots service on the ctx.
 */
window.__ModuleLoader__.load({ id: 'dsh-project-memory', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useEffect, useState } = React;
const { jsx, jsxs } = require('react/jsx-runtime');

const PLUGIN_ID = 'dsh-project-memory';

/* Collapsible memory-card styles; theme variables only. */
const CSS = [
  '.pmem-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
  '.pmem-card+.pmem-card{margin-top:6px}',
  '.pmem-head{display:flex;align-items:center;gap:10px;width:100%;min-height:40px;padding:6px 12px;background:0 0;border:0;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}',
  '.pmem-head:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.pmem-head:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
  '.pmem-badge{flex:none;display:inline-flex;align-items:center;min-height:18px;padding:0 7px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:18px;font-weight:600}',
  '.pmem-title{flex:none;font-size:13px;font-weight:600;line-height:20px}',
  '.pmem-dot{flex:none;width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-label-tertiary)}',
  '.pmem-dot[data-state="running"]{background:var(--dsw-alias-state-business-primary)}',
  '.pmem-dot[data-state="ok"]{background:var(--dsw-alias-state-success-primary)}',
  '.pmem-dot[data-state="error"]{background:var(--dsw-alias-state-error-primary)}',
  '.pmem-summary{min-width:0;flex:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.pmem-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform 140ms var(--ds-ease-in-out);font-size:10px}',
  '.pmem-head[data-open="true"] .pmem-chevron{transform:rotate(180deg)}',
  '.pmem-body{border-top:1px solid var(--dsw-alias-border-l2);padding:10px 14px 12px;background:var(--dsw-alias-bg-layer-1)}',
  '.pmem-args{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;margin:0 0 8px}',
  '.pmem-text{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;margin:0}',
  '.pmem-text[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
].join('\n');
(function () {
  if (typeof document === 'undefined') return
  const tagId = PLUGIN_ID + '/memory-card.css'
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
})();

/** Display titles per wire tool name (the "memory phase" label). */
const TITLES = {
  project_memory_save: '记忆 · 保存',
  project_memory_search: '记忆 · 检索',
  project_memory_list: '记忆 · 浏览',
};

/** Concatenate the result text blocks of a settled tool node. */
function resultText(block) {
  const content = block.content
  if (!Array.isArray(content)) return ''
  return content
    .map((chunk) => (chunk !== null && typeof chunk === 'object' && chunk.type === 'text' ? String(chunk.text) : ''))
    .join('')
}

/** One-line collapsed summary: saved title / hit count / first line. */
function summarize(name, running, text, isError) {
  if (running) return '运行中…'
  if (isError) return '失败'
  const first = text.split('\n')[0].trim()
  if (name === 'project_memory_save') {
    const m = /(?:saved|updated):\s*(.+?)\s*\[/.exec(first)
    return m !== null ? '已' + (first.startsWith('saved') ? '保存' : '更新') + ':' + m[1].trim() : (first || '完成')
  }
  if (name === 'project_memory_search') {
    if (first === 'No project memories found.') return '无结果'
    const m = /^(.+?)\s+\[/.exec(first)
    return m !== null ? m[1].trim() : (first || '完成')
  }
  return first || '完成'
}

/** Arguments of a call (running node or settled node's backfilled head). */
function argsOf(block, running) {
  const raw = running ? block.argsRaw : (block.call?.argsRaw ?? '')
  if (typeof raw !== 'string' || raw.length === 0) return ''
  try {
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') {
      const summary = {}
      for (const key of ['title', 'query', 'category', 'limit']) {
        if (parsed[key] !== undefined) summary[key] = parsed[key]
      }
      if (Object.keys(summary).length > 0) return JSON.stringify(summary, null, 2)
    }
    return raw
  } catch {
    return raw
  }
}

/**
 * Collapsible card for one project-memory tool call.
 * @param props.block - frozen RunningToolCall or settled ToolResultNode.
 */
function MemoryToolCard({ block, callId }) {
  const running = !('kind' in block) || block.kind !== 'tool-result';
  const name = running ? block.name : (block.call?.name ?? 'project_memory_save');
  const title = TITLES[name] ?? '记忆';
  const text = running ? '' : resultText(block);
  const isError = !running && block.isError === true;
  const [open, setOpen] = useState(false);
  useEffect(() => { if (running) setOpen(true) }, [running]);

  const summary = summarize(name, running, text, isError);
  const args = argsOf(block, running);

  return jsxs('div', { className: 'pmem-card', 'data-memory-card': '', children: [
    jsxs('button', {
      type: 'button',
      className: 'pmem-head',
      'data-open': open ? 'true' : undefined,
      'aria-expanded': open,
      'aria-label': title + ':' + summary,
      onClick: () => { setOpen(!open) },
      children: [
        jsx('span', { className: 'pmem-badge', children: '记忆' }, 'badge'),
        jsx('span', { className: 'pmem-title', children: title }, 'title'),
        jsx('span', { className: 'pmem-dot', 'data-state': running ? 'running' : (isError ? 'error' : 'ok'), 'aria-hidden': true }, 'dot'),
        jsx('span', { className: 'pmem-summary', children: summary }, 'summary'),
        jsx('span', { className: 'pmem-chevron', 'aria-hidden': true, children: '▾' }, 'chevron'),
      ],
    }, 'head'),
    open ? jsxs('div', { className: 'pmem-body', children: [
      args.length > 0 ? jsx('pre', { className: 'pmem-args', children: args }, 'args') : null,
      running
        ? jsx('p', { className: 'pmem-text', children: '执行中…' }, 'running')
        : jsx('p', { className: 'pmem-text', 'data-tone': isError ? 'error' : undefined, children: text || '无输出' }, 'text'),
    ] }, 'body') : null,
  ] }, callId);
}

/** Contribute the collapsible memory cards for the three memory tools. */
function apply(ctx) {
  for (const key of ['project_memory_save', 'project_memory_search', 'project_memory_list']) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
      { name: 'tool.call.toolview', key },
      MemoryToolCard,
    ))
  }
}

module.exports = { apply, inject: ['slots'], TITLES };
return module.exports;
} });
