/**
 * Browser half of dsh-project-memory: collapsible "memory phase" cards for the
 * MCP Reference Memory tools.
 *
 * Registers `tool.call.toolview` for the official reference server's nine tools
 * (mcp__reference_memory__search_nodes / read_graph / open_nodes /
 * create_entities / add_observations / create_relations / delete_entities /
 * delete_observations / delete_relations), so every memory action in a session
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
const {
  DisclosureRow,
  IconListPenOutlineRegular,
  IconSearchOutlineRegular,
  IconChecklistOutlineMedium,
  IconSparkleRegular,
  IconDatabaseOutlineRegular,
  IconPlusOutlineRegular,
  IconLinkOutlineRegular,
  IconTrashOutlineRegular,
} = require('@deepseek-ai/dsh-client-ui-primitives');

const PLUGIN_ID = 'dsh-project-memory';
const TOOL_PREFIX = 'mcp__reference_memory__';

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

/** Display titles and leading icons per reference-memory MCP tool name. */
const TITLES = {
  'mcp__reference_memory__search_nodes': '记忆 · 检索',
  'mcp__reference_memory__read_graph': '记忆 · 读取图谱',
  'mcp__reference_memory__open_nodes': '记忆 · 打开实体',
  'mcp__reference_memory__create_entities': '记忆 · 新建实体',
  'mcp__reference_memory__add_observations': '记忆 · 追加观察',
  'mcp__reference_memory__create_relations': '记忆 · 新建关联',
  'mcp__reference_memory__delete_entities': '记忆 · 删除实体',
  'mcp__reference_memory__delete_observations': '记忆 · 删除观察',
  'mcp__reference_memory__delete_relations': '记忆 · 删除关联',
};
const ICONS = {
  'mcp__reference_memory__search_nodes': IconSearchOutlineRegular,
  'mcp__reference_memory__read_graph': IconDatabaseOutlineRegular,
  'mcp__reference_memory__open_nodes': IconChecklistOutlineMedium,
  'mcp__reference_memory__create_entities': IconPlusOutlineRegular,
  'mcp__reference_memory__add_observations': IconListPenOutlineRegular,
  'mcp__reference_memory__create_relations': IconLinkOutlineRegular,
  'mcp__reference_memory__delete_entities': IconTrashOutlineRegular,
  'mcp__reference_memory__delete_observations': IconTrashOutlineRegular,
  'mcp__reference_memory__delete_relations': IconTrashOutlineRegular,
};

/** The result text blocks of a settled tool node, in order. */
function textBlocks(block) {
  const content = block.content
  if (!Array.isArray(content)) return []
  return content
    .map((chunk) => (chunk !== null && typeof chunk === 'object' && chunk.type === 'text' ? String(chunk.text) : ''))
    .filter((text) => text.length > 0)
}

/** Concatenate the result text blocks of a settled tool node. */
function resultText(texts) {
  return texts.join('\n')
}

/** Parse the first text block as the JSON payload the reference server returns. */
function payloadOf(texts) {
  if (texts.length === 0) return null
  try {
    return JSON.parse(texts[0])
  } catch {
    return null
  }
}

/** One-line collapsed summary: counts for graph tools, first line otherwise. */
function summarize(name, running, texts, isError) {
  if (running) return '运行中…'
  if (isError) return '失败'
  const data = payloadOf(texts)
  if (name === TOOL_PREFIX + 'search_nodes' || name === TOOL_PREFIX + 'read_graph' || name === TOOL_PREFIX + 'open_nodes') {
    if (data !== null && Array.isArray(data.entities)) {
      if (data.entities.length === 0) return '无结果'
      const relations = Array.isArray(data.relations) ? data.relations.length : 0
      return `${data.entities.length} 个实体 · ${relations} 条关系`
    }
    return '无结果'
  }
  if (name === TOOL_PREFIX + 'create_entities' && Array.isArray(data)) {
    return data.length === 0 ? '未新建(实体已存在)' : `新建 ${data.length} 个实体`
  }
  if (name === TOOL_PREFIX + 'add_observations' && Array.isArray(data)) {
    const added = data.reduce((total, item) => total + (Array.isArray(item?.addedObservations) ? item.addedObservations.length : 0), 0)
    return added === 0 ? '无新增观察' : `追加 ${added} 条观察`
  }
  if (name === TOOL_PREFIX + 'create_relations' && Array.isArray(data)) {
    return data.length === 0 ? '无新增关系' : `新建 ${data.length} 条关系`
  }
  const first = (texts[0] ?? '').split('\n')[0].trim()
  return first.slice(0, 60) || '完成'
}

/**
 * Collapsible card for one reference-memory tool call, styled like the shipped
 * "Think" reasoning row (DisclosureRow primitive).
 * @param props.block - frozen RunningToolCall or settled ToolResultNode.
 */
function MemoryToolCard({ block, callId }) {
  const running = !('kind' in block) || block.kind !== 'tool-result';
  const name = running ? block.name : (block.call?.name ?? '');
  const title = TITLES[name] ?? '记忆';
  const Icon = ICONS[name] ?? IconListPenOutlineRegular;
  const texts = running ? [] : textBlocks(block);
  const text = running ? '' : resultText(texts);
  const isError = !running && block.isError === true;
  const [open, setOpen] = useState(false);

  const state = running ? 'running' : (isError ? 'error' : 'ok');
  const summary = summarize(name, running, texts, isError);

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

/** Contribute the collapsible memory cards for the reference-memory tools. */
function apply(ctx) {
  for (const key of Object.keys(TITLES)) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
      { name: 'tool.call.toolview', key },
      MemoryToolCard,
    ))
  }
}

module.exports = { apply, inject: ['slots'], TITLES };
return module.exports;
} });
