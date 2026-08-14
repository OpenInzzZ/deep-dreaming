/**
 * Browser half of the ui-queue-tools patch: an enhanced queue dock.
 *
 * Shadows the shipped `conversation.input.dock` entry (same id "queue", lower
 * priority — the slot registry renders the lowest live priority, so this
 * registrant replaces the official queue strip):
 *
 * 1. Hovering a queued message preview shows the FULL text (the shipped dock
 *    truncates the preview to 200 chars and has no full-text affordance).
 * 2. Each row gains move-up / move-down buttons that reorder the pending
 *    queue through the host half's `/queue` RPC channel (Inbox.splice on the
 *    agent's next-turn list); the durable event stream then refreshes every
 *    client, so the dock needs no optimistic local reorder.
 *
 * All other shipped behavior (collapse header, edit, remove, steer) is
 * reproduced verbatim; the component receives the same props the slot
 * renderer supplies (`useSession`, `t`) plus this registrant's inject face.
 */
window.__ModuleLoader__.load({ id: '@local/dsh-client-ui-queue-tools', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useEffect, useId, useMemo, useState } = React;
const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
const { IconChevronDownOutline14, IconChevronUpOutline14, IconCloseOutline16, IconEditOutline16, IconQueueOutline14, IconSendOutline14, IconTrashOutline16, IconCheckOutline16, Tooltip } = require('@deepseek-ai/dsh-client-ui-primitives');

const PLUGIN_ID = '@local/dsh-client-ui-queue-tools';

/* Injected once per page; the module loader tracks `style[data-plugin]` tags
   and removes them when the bundle unloads. Rules mirror the shipped
   QueueDock.module.css with this plugin's own class names. */
const CSS = [
  '.qt-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px);padding:0 var(--dsh-composer-dock-inset);flex:none}',
  '.qt-panel{background:var(--dsw-specific-tip);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px 12px 0 0;width:100%;padding:2px 0;position:relative;overflow:hidden}',
  '.qt-panel:after{border:1px solid var(--dsw-alias-border-l1);border-radius:inherit;content:"";pointer-events:none;border-bottom:none;position:absolute;inset:0}',
  '.qt-header{box-sizing:border-box;width:100%;height:36px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:0 0;border:none;border-radius:8px;align-items:center;gap:10px;padding:4px 12px;display:flex}',
  '.qt-header:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}',
  '.qt-header:disabled{cursor:default}',
  '.qt-lead{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}',
  '.qt-count{min-width:0;font-family:Inter, var(--dsw-font-family);flex:auto;font-size:13px;font-weight:500;line-height:24px}',
  '.qt-chevron{width:14px;height:14px;color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}',
  '.qt-list{max-height:180px;margin:0;padding:0;list-style:none;overflow-y:auto}',
  '.qt-row{box-sizing:border-box;border-radius:8px;align-items:center;gap:10px;width:100%;height:36px;padding:4px 5px 4px 12px;display:flex}',
  '.qt-row+.qt-row{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}',
  '.qt-row[draggable="true"]{cursor:grab}',
  '.qt-row[draggable="true"]:active{cursor:grabbing}',
  '.qt-row-dragging{opacity:.45}',
  '.qt-row-over{outline:2px dashed var(--dsw-alias-state-business-primary);outline-offset:-2px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent)}',
  '.qt-preview,.qt-editor{min-width:0;font:var(--dsw-font-xs-13);font-family:Inter, var(--dsw-font-family);flex:auto}',
  '.qt-preview{color:var(--dsw-alias-label-primary-dimmed);text-overflow:ellipsis;white-space:nowrap;word-break:break-word;overflow:hidden}',
  '.qt-editor{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);height:28px;color:var(--dsw-alias-label-primary);border-radius:6px;outline:none;padding:0 8px}',
  '.qt-editor:focus{border-color:var(--dsw-alias-state-business-primary)}',
  '.qt-actions{flex:none;align-items:center;gap:10px;display:flex}',
  '.qt-actions .qt-action-group{display:inline-flex;align-items:center;gap:2px}',
  '.qt-action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;place-items:center;padding:0;display:grid}',
  '.qt-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.qt-action:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}',
  '.qt-action:disabled{cursor:default;opacity:.45}',
].join('\n');
(function () {
  if (typeof document === 'undefined') return
  const tagId = PLUGIN_ID + '/queue-tools.css'
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
})();

/** Simplified Chinese dictionary and key source of truth. */
const zh = {
  count: '{n} 条排队消息',
  edit: '编辑排队消息',
  'edit.unsupported': '包含非文本内容，暂不支持编辑',
  save: '保存排队消息',
  cancelEdit: '取消编辑',
  remove: '删除排队消息',
  steer: '插话发送',
  'steer.unavailable': '仅运行中可插话发送',
  editFailed: '编辑失败：这条消息可能已经开始发送。',
  removeFailed: '删除失败：这条消息可能已经开始发送。',
  steerFailed: '插话发送失败，请重试。',
  reorderFailed: '排序失败：这条消息可能已经开始发送。',
};

/** English dictionary checked against the Chinese key set. */
const en = {
  count: '{n} queued messages',
  edit: 'Edit queued message',
  'edit.unsupported': 'Contains non-text content; editing is not supported yet',
  save: 'Save queued message',
  cancelEdit: 'Cancel editing',
  remove: 'Remove queued message',
  steer: 'Steer queued message',
  'steer.unavailable': 'Steering is available only while the agent is running',
  editFailed: 'Edit failed: this message may have already started sending.',
  removeFailed: 'Removal failed: this message may have already started sending.',
  steerFailed: 'Steering failed. Try again.',
  reorderFailed: 'Reorder failed: this message may have already started sending.',
};

/** Dictionary namespace owned by this plugin. */
const NS = 'queue.tools';

/** Services required by the queue-dock registration. */
const inject = ['slots', 'locale', 'connection', 'conversation', 'sessions'];

/**
 * Enhanced queue strip: the shipped dock plus full-text hover preview
 * (Tooltip, same affordance as the action buttons) and drag-to-reorder.
 * Props arrive from the slot renderer (`useSession`, `t`) and this
 * registrant's inject face (`updateQueue`, `notify`, `reorder`).
 */
function QueueToolsDock({ useSession, updateQueue, notify, reorder, t }) {
  const inbox = useSession((s) => s.queue);
  const queue = useMemo(() => inbox.filter((row) => row.placement === 'queued'), [inbox]);
  const running = useSession((s) => s.running);
  const queueMutable = useSession((s) => s.subagent === null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(null);
  const [collapsed, setCollapsed] = useState(true);
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const listId = useId();

  useEffect(() => {
    if (queue.length === 0 && !collapsed) setCollapsed(true);
    if (editing !== null && (!queueMutable || !queue.some((row) => row.id === editing.id))) setEditing(null);
  }, [collapsed, editing, queue, queueMutable]);

  if (queue.length === 0) return null;
  const interactionActive = queueMutable && (editing !== null || busy !== null);
  const expanded = !collapsed || interactionActive;
  const listVisible = queue.length === 1 || expanded;
  const canReorder = queueMutable && queue.length > 1;

  const applyAction = async (itemId, action, failure) => {
    setBusy(itemId);
    try {
      await updateQueue(itemId, action);
      return true;
    } catch {
      notify('error', failure);
      return false;
    } finally {
      setBusy((current) => current === itemId ? null : current);
    }
  };

  const applyReorder = async (itemId, toIndex) => {
    setBusy(itemId);
    try {
      await reorder(itemId, toIndex);
    } catch {
      notify('error', t('reorderFailed'));
    } finally {
      setBusy((current) => current === itemId ? null : current);
    }
  };

  const endDrag = () => {
    setDraggingId(null);
    setDragOverId(null);
  };

  const saveEdit = async () => {
    if (editing === null || editing.text.trim() === '') return;
    if (await applyAction(editing.id, {
      kind: 'edit',
      content: [{ type: 'text', text: editing.text }],
    }, t('editFailed'))) setEditing(null);
  };

  return jsx('div', { className: 'qt-dock', 'data-queue-dock': '', children: jsxs('div', { className: 'qt-panel', children: [
    queue.length > 1 ? jsxs('button', {
      type: 'button',
      className: 'qt-header',
      'aria-controls': listId,
      'aria-expanded': expanded,
      disabled: interactionActive ? true : undefined,
      onClick: () => { setCollapsed((value) => !value) },
      children: [
        jsx('span', { className: 'qt-lead', 'aria-hidden': true, children: jsx(IconQueueOutline14, {}) }, 'lead'),
        jsx('span', { className: 'qt-count', children: t('count', { n: queue.length }) }, 'count'),
        jsx('span', { className: 'qt-chevron', 'aria-hidden': true, children: expanded ? jsx(IconChevronDownOutline14, {}) : jsx(IconChevronUpOutline14, {}) }, 'chevron'),
      ],
    }, 'header') : null,
    jsx('ul', {
      id: listId,
      className: 'qt-list',
      hidden: !listVisible,
      children: listVisible ? queue.map((row, index) => jsxs('li', {
        className: 'qt-row' + (draggingId === row.id ? ' qt-row-dragging' : '') + (dragOverId === row.id && draggingId !== null && draggingId !== row.id ? ' qt-row-over' : ''),
        draggable: canReorder && editing?.id !== row.id ? true : undefined,
        'aria-grabbed': draggingId === row.id ? true : undefined,
        onDragStart: (event) => {
          if (!canReorder) return
          setDraggingId(row.id)
          try { event.dataTransfer.effectAllowed = 'move' } catch { /* jsdom has no dataTransfer */ }
        },
        onDragOver: (event) => {
          if (draggingId === null || draggingId === row.id) return
          event.preventDefault()
          try { event.dataTransfer.dropEffect = 'move' } catch { /* jsdom */ }
          setDragOverId(row.id)
        },
        onDrop: (event) => {
          if (draggingId === null || draggingId === row.id) return
          event.preventDefault()
          const fromIndex = queue.findIndex((candidate) => candidate.id === draggingId)
          if (fromIndex >= 0 && fromIndex !== index) void applyReorder(draggingId, index)
          endDrag()
        },
        onDragEnd: endDrag,
        children: [
          queue.length === 1 ? jsx('span', { className: 'qt-lead', 'aria-hidden': true, children: jsx(IconQueueOutline14, {}) }, 'lead') : null,
          editing?.id === row.id ? jsx('input', {
            autoFocus: true,
            className: 'qt-editor',
            'aria-label': t('edit'),
            value: editing.text,
            onChange: (event) => { setEditing({ id: row.id, text: event.currentTarget.value }) },
            onKeyDown: (event) => {
              if (event.key === 'Escape') { setEditing(null); return }
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void saveEdit();
              }
            },
          }, 'editor') : jsx(Tooltip, {
            label: row.text ?? row.preview,
            side: 'bottom',
            delayMs: 500,
            maxWidth: 480,
            children: jsx('span', {
              className: 'qt-preview',
              children: row.preview,
            }, 'preview'),
          }, 'preview-tip'),
          queueMutable ? jsx('div', { className: 'qt-actions', children: editing?.id === row.id ? jsxs(Fragment, { children: [
            jsx(Tooltip, { label: t('save'), side: 'bottom', delayMs: 500, children: jsx('button', {
              type: 'button',
              className: 'qt-action',
              'aria-label': t('save'),
              disabled: busy !== null || editing.text.trim() === '',
              onClick: () => { void saveEdit() },
              children: jsx(IconCheckOutline16, { size: 14 }),
            }, 'save') }),
            jsx(Tooltip, { label: t('cancelEdit'), side: 'bottom', delayMs: 500, children: jsx('button', {
              type: 'button',
              className: 'qt-action',
              'aria-label': t('cancelEdit'),
              disabled: busy !== null,
              onClick: () => { setEditing(null) },
              children: jsx(IconCloseOutline16, { size: 14 }),
            }, 'cancel') }),
          ] }) : jsxs(Fragment, { children: [
            jsx(Tooltip, { label: t('edit'), side: 'bottom', delayMs: 500, disabled: row.text === null, children: jsx('button', {
              type: 'button',
              className: 'qt-action',
              'aria-label': t('edit'),
              title: row.text === null ? t('edit.unsupported') : undefined,
              disabled: busy !== null || row.text === null,
              onClick: (event) => {
                // Drop focus so the button's focus-triggered tooltip cannot
                // linger when the row swaps into edit mode.
                if (event.currentTarget.blur) event.currentTarget.blur()
                if (row.text !== null) setEditing({ id: row.id, text: row.text })
              },
              onMouseDown: (event) => {
                // Prevent mouse clicks from focusing the button at all (the
                // focus-triggered tooltip popping up on click is the reported
                // glitch); keyboard Tab focus keeps working.
                if (event.preventDefault) event.preventDefault()
              },
              children: jsx(IconEditOutline16, { size: 14 }),
            }, 'edit') }),
            jsx(Tooltip, { label: t('remove'), side: 'bottom', delayMs: 500, children: jsx('button', {
              type: 'button',
              className: 'qt-action',
              'aria-label': t('remove'),
              disabled: busy !== null,
              onClick: () => { void applyAction(row.id, { kind: 'remove' }, t('removeFailed')) },
              children: jsx(IconTrashOutline16, { size: 14 }),
            }, 'remove') }),
            jsx(Tooltip, { label: t('steer'), side: 'bottom', delayMs: 500, disabled: !running, children: jsx('button', {
              type: 'button',
              className: 'qt-action',
              'aria-label': t('steer'),
              title: running ? undefined : t('steer.unavailable'),
              disabled: busy !== null || !running,
              onClick: () => { void applyAction(row.id, { kind: 'steer' }, t('steerFailed')) },
              children: jsx(IconSendOutline14, {}),
            }, 'steer') }),
          ] }) }, 'actions') : null,
        ],
      }, row.id)) : null,
    }, 'list'),
  ] }) });
}

/** Contribute the enhanced queue dock, shadowing the shipped entry. */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-queue-tools: dictionaries')

  const reorder = async (sessionId, itemId, toIndex) => {
    const result = await ctx.connection.rpc.call('/queue', 'reorder', { args: { sessionId, itemId, toIndex } })
    if (!result.ok) {
      throw new Error('queue reorder failed: ' + result.error.code + ': ' + result.error.message)
    }
    return result.value
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'queue',
    order: 20,
    priority: -10,
    locale: NS,
    inject: (sessionId) => {
      const actx = ctx.sessions.scope(sessionId)
      if (actx === undefined) throw new Error(`queue dock: session "${sessionId}" resolved no scope`)
      const conversation = actx.get('conversation')
      if (conversation === undefined) throw new Error('queue dock: conversation service unavailable')
      return {
        updateQueue: (itemId, action) => conversation.updateQueue(itemId, action),
        notify: (level, text) => {
          conversation.input.for(actx).notify(level, text)
        },
        reorder: (itemId, toIndex) => reorder(sessionId, itemId, toIndex),
      }
    },
  }, QueueToolsDock))
}

module.exports = { apply, inject, NS };
return module.exports;
} });
