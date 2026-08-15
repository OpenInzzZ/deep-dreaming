/**
 * Browser half of dsh-project-memory: collapsible "memory phase" cards.
 *
 * Registers `tool.call.toolview` for the three project-memory tools
 * (project_memory_save / search / list), so every memory action in a session
 * renders as one collapsible card. The card reuses the shipped `DisclosureRow`
 * primitive — the same component the official "Think" reasoning row is built
 * on — so the memory phase looks and behaves exactly like the Think rows:
 * leading icon + title + one-line summary, expanding reveals the full result.
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
const { DisclosureRow, IconListPenOutline16, IconSearchOutline16, IconChecklistOutline14 } = require('@deepseek-ai/dsh-client-ui-primitives');

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
  '.pmem-keywords{flex:none;max-width:45%;margin-left:8px;color:var(--dsw-alias-label-caption);font-size:12px;line-height:24px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
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

/** Display titles and leading icons per wire tool name. */
const TITLES = {
  project_memory_save: '记忆 · 保存/更新',
  project_memory_search: '记忆 · 检索',
  project_memory_list: '记忆 · 浏览',
};
const ICONS = {
  project_memory_save: IconListPenOutline16,
  project_memory_search: IconSearchOutline16,
  project_memory_list: IconChecklistOutline14,
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
    if (m !== null) {
      const action = /\bsaved:/.test(first) ? '保存' : '更新'
      return '已' + action + ':' + m[1].trim()
    }
    return first || '完成'
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

/** Memory keywords shown on the collapsed row (up to 3): the save call's
 * `keywords` argument, or the first hit's keywords line in a search/list
 * result. */
function keywordsOf(block, name, running, text) {
  const raw = running ? block.argsRaw : (block.call?.argsRaw ?? '')
  if (name === 'project_memory_save') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed.keywords)) {
        const keywords = parsed.keywords.map(String).filter((k) => k.length > 0).slice(0, 3)
        if (keywords.length > 0) return keywords
      }
    } catch { /* fall through to the text parse below */ }
  }
  const m = /keywords:\s*(.+)$/m.exec(text)
  if (m !== null) {
    return m[1].split(/[、,，]/).map((k) => k.trim()).filter((k) => k.length > 0).slice(0, 3)
  }
  return []
}

/**
 * Collapsible card for one project-memory tool call, styled like the shipped
 * "Think" reasoning row (DisclosureRow primitive).
 * @param props.block - frozen RunningToolCall or settled ToolResultNode.
 */
function MemoryToolCard({ block, callId }) {
  const running = !('kind' in block) || block.kind !== 'tool-result';
  const name = running ? block.name : (block.call?.name ?? 'project_memory_save');
  const title = TITLES[name] ?? '记忆';
  const Icon = ICONS[name] ?? IconListPenOutline16;
  const text = running ? '' : resultText(block);
  const isError = !running && block.isError === true;
  // Always collapsed by default — including running calls — so memory
  // activity stays a quiet summary row unless the user expands it.
  const [open, setOpen] = useState(false);

  const state = running ? 'running' : (isError ? 'error' : 'ok');
  const summary = summarize(name, running, text, isError);
  const args = argsOf(block, running);
  const keywords = keywordsOf(block, name, running, text);

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
        keywords.length > 0
          ? jsx('span', { className: 'pmem-keywords', children: keywords.join('、') }, 'keywords')
          : null,
      ] }),
      children: jsxs('div', { className: 'pmem-body', children: [
        args.length > 0 ? jsx('pre', { className: 'pmem-args', children: args }, 'args') : null,
        running
          ? jsx('p', { className: 'pmem-text', children: '执行中…' }, 'running')
          : jsx('p', { className: 'pmem-text', 'data-tone': isError ? 'error' : undefined, children: text || '无输出' }, 'text'),
      ] }, 'body'),
    }),
  }, callId);
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
