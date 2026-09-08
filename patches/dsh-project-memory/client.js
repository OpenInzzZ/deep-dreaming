/**
 * Browser half of dsh-project-memory: collapsible "memory phase" cards.
 *
 * Registers `tool.call.toolview` for Memorix's MCP tools
 * (mcp__memorix__search / store / context / detail), so every memory action
 * in a session renders as one collapsible card. The card reuses the shipped
 * `DisclosureRow` primitive — the same component the official "Think"
 * reasoning row is built on — so the memory phase looks and behaves exactly
 * like the Think rows: leading icon + title + one-line summary, expanding
 * reveals the full result.
 *
 * Hand-written bundle in the client-module contract: only platform seed
 * words (react, react/jsx-runtime, @deepseek-ai/dsh-client-ui-primitives)
 * plus the slots service on the ctx.
 */
window.__ModuleLoader__.load({ id: 'dsh-project-memory', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useState } = React;
const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
const { DisclosureRow, IconListPenOutline16, IconSearchOutline16, IconChecklistOutline14, IconSparkleOutline16 } = require('@deepseek-ai/dsh-client-ui-primitives');

const PLUGIN_ID = 'dsh-project-memory';

/* Memory-card styles: DisclosureRow supplies the row chrome; these mirror the
   official Think row's summary/body look (tertiary text, 22px body indent). */
const CSS = [
  '.pmem-card{display:flex;flex-direction:column}',
  '.pmem-card+.pmem-card{margin-top:6px}',
  '.pmem-title{font-weight:400}',
  '.pmem-dot{flex:none;width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-label-caption);margin:0 8px}',
  '.pmem-dot[data-state="running"]{background:var(--dsw-alias-state-business-primary)}',
  '.pmem-dot[data-state="ok"]{background:var(--dsw-alias-state-success-primary)}',
  '.pmem-dot[data-state="error"]{background:var(--dsw-alias-state-error-primary)}',
  '.pmem-summary{min-width:0;overflow:hidden;flex:1 1 auto;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;text-overflow:ellipsis;white-space:nowrap}',
  '.pmem-body{padding:4px 0 4px 22px;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px}',
  '.pmem-args{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;margin:0 0 8px}',
  '.pmem-text{color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;margin:0}',
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

/** Display titles and leading icons per Memorix MCP tool name. */
const TITLES = {
  'mcp__memorix__memorix_search': '记忆 · 检索',
  'mcp__memorix__memorix_store': '记忆 · 保存/更新',
  'mcp__memorix__memorix_project_context': '记忆 · 任务上下文',
  'mcp__memorix__memorix_detail': '记忆 · 详情',
};
const ICONS = {
  'mcp__memorix__memorix_search': IconSearchOutline16,
  'mcp__memorix__memorix_store': IconListPenOutline16,
  'mcp__memorix__memorix_project_context': IconSparkleOutline16,
  'mcp__memorix__memorix_detail': IconChecklistOutline14,
};

/** Concatenate the result text blocks of a settled tool node. */
function resultText(block) {
  const content = block.content
  if (!Array.isArray(content)) return ''
  return content
    .map((chunk) => (chunk !== null && typeof chunk === 'object' && chunk.type === 'text' ? String(chunk.text) : ''))
    .join('')
}

/** One-line collapsed summary: first meaningful line of the result. */
function summarize(name, running, text, isError) {
  if (running) return '运行中…'
  if (isError) return '失败'
  const first = text.split('\n')[0].trim()
  if (name === 'mcp__memorix__memorix_search') {
    if (/no (results|memories)/i.test(first)) return '无结果'
    // Try to extract a title-like first line
    const m = /^[-\u2022*]\s*(.+)/.exec(first)
    return m !== null ? m[1].trim().slice(0, 60) : (first.slice(0, 60) || '完成')
  }
  if (name === 'mcp__memorix__memorix_store') {
    // Generic: show the first line truncated
    return first.slice(0, 60) || '完成'
  }
  return first.slice(0, 60) || '完成'
}

/**
 * Collapsible card for one Memorix memory tool call, styled like the shipped
 * "Think" reasoning row (DisclosureRow primitive).
 * @param props.block - frozen RunningToolCall or settled ToolResultNode.
 */
function MemoryToolCard({ block, callId }) {
  const running = !('kind' in block) || block.kind !== 'tool-result';
  const name = running ? block.name : (block.call?.name ?? '');
  const title = TITLES[name] ?? '记忆';
  const Icon = ICONS[name] ?? IconListPenOutline16;
  const text = running ? '' : resultText(block);
  const isError = !running && block.isError === true;
  const [open, setOpen] = useState(false);

  const state = running ? 'running' : (isError ? 'error' : 'ok');
  const summary = summarize(name, running, text, isError);

  return jsx('div', {
    className: 'pmem-card',
    'data-memory-card': '',
    'data-state': state,
    children: jsx(DisclosureRow, {
      icon: jsx(Icon, { size: 14 }),
      title,
      open,
      expandable: true,
      expandOnRowClick: true,
      onToggle: () => { setOpen(!open) },
      rowClassName: 'pmem-row',
      titleClassName: 'pmem-title',
      collapsedContent: jsxs(Fragment, { children: [
        jsx('span', { className: 'pmem-dot', 'data-state': state, 'aria-hidden': true }, 'dot'),
        jsx('span', { className: 'pmem-summary', children: summary }, 'summary'),
      ] }),
      children: jsxs('div', { className: 'pmem-body', children: [
        running
          ? jsx('p', { className: 'pmem-text', children: '执行中…' }, 'running')
          : jsx('p', { className: 'pmem-text', 'data-tone': isError ? 'error' : undefined, children: text || '无输出' }, 'text'),
      ] }, 'body'),
    }),
  }, callId);
}

/** Contribute the collapsible memory cards for Memorix MCP tools. */
function apply(ctx) {
  for (const key of ['mcp__memorix__memorix_search', 'mcp__memorix__memorix_store', 'mcp__memorix__memorix_project_context', 'mcp__memorix__memorix_detail']) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
      { name: 'tool.call.toolview', key },
      MemoryToolCard,
    ))
  }
}

module.exports = { apply, inject: ['slots'], TITLES };
return module.exports;
} });