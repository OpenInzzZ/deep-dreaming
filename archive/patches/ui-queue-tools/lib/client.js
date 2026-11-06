/**
 * Browser half of the ui-queue-tools patch: an enhanced queue dock.
 *
 * Shadow target: the shipped `conversation.input.dock` entry of DSH
 * 0.2.1-rc.2 (same id "queue", lower priority — the slot registry renders the
 * lowest live priority, so this registrant replaces the official queue strip).
 * This file reproduces the shipped QueueDock's behavior: durable-row
 * attachments (image thumbnails loaded through `ctx.uiConversation.imageUrl`
 * and file chips), locally queued submission echoes with their own text and
 * attachments, inline edit/remove/steer, the collapsible header, and queue
 * actions for continuable subagents. Keep it in sync when the shipped dock
 * changes; the official source is
 * `packages/client/ui-conversation/src/client/queue/QueueDock.tsx`.
 *
 * On top of that it adds:
 *
 * 1. Hovering a queued message preview shows the FULL text (a Tooltip on the
 *    CSS-ellipsized preview).
 * 2. Rows are draggable: dropping one on another reorders the pending queue
 *    through the host half's `/queue` prefix route, declaring the `queued`
 *    placement the drop index was computed on (Inbox.splice on that list); the
 *    durable event stream then refreshes every client, so the dock needs no
 *    optimistic local reorder.
 *
 * Props arrive from the slot renderer (`useSession`, `useProjection`,
 * `renderFactorySlot`, `t`) plus this registrant's inject face (`updateQueue`,
 * `notify`, `loadImage`, `reorder`).
 */
window.__ModuleLoader__.load({ id: '@local/dsh-client-ui-queue-tools', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useEffect, useId, useMemo, useState } = React;
const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
const {
  FileTypeIcon, fileSizeText, IconChevronDownOutlineMedium, IconChevronUpOutlineMedium, IconCloseOutlineRegular,
  IconEditOutlineRegular, IconQueueOutlineMedium, IconSendOutlineMedium, IconTrashOutlineRegular, IconCheckOutlineRegular,
  Tooltip,
} = require('@deepseek-ai/dsh-client-ui-primitives');

const PLUGIN_ID = '@local/dsh-client-ui-queue-tools';

/* Injected once per page; the module loader tracks `style[data-plugin]` tags
   and removes them when the bundle unloads. Rules mirror the shipped
   QueueDock.module.css with this plugin's own class names. */
const CSS = [
  '.qt-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px);padding:0 var(--dsh-composer-dock-inset);flex:none}',
  '.qt-panel{position:relative;isolation:isolate;overflow:hidden;width:100%;padding:2px 0;border-radius:var(--dsw-radius-lg) var(--dsw-radius-lg) 0 0;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
  '.qt-panel:after{border:.5px solid var(--dsw-alias-border-l1);border-radius:inherit;content:"";pointer-events:none;border-bottom:none;position:absolute;inset:0}',
  '.qt-header{box-sizing:border-box;width:100%;height:36px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:0 0;border:none;border-radius:var(--dsw-radius-md);align-items:center;gap:10px;padding:4px 12px;display:flex}',
  '.qt-header:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}',
  '.qt-header:disabled{cursor:default}',
  '.qt-lead{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}',
  '.qt-count{min-width:0;font-family:Inter, var(--dsw-font-family);flex:auto;font-size:13px;font-weight:500;line-height:24px}',
  '.qt-chevron{width:14px;height:14px;color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}',
  '.qt-list{max-height:180px;margin:0;padding:0;list-style:none;overflow-y:auto}',
  '.qt-row{box-sizing:border-box;border-radius:var(--dsw-radius-md);align-items:center;gap:10px;width:100%;min-height:36px;padding:4px 5px 4px 12px;display:flex}',
  '.qt-row+.qt-row{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}',
  '.qt-row[draggable="true"]{cursor:grab}',
  '.qt-row[draggable="true"]:active{cursor:grabbing}',
  '.qt-row-dragging{opacity:.45}',
  '.qt-row-over{outline:2px dashed var(--dsw-alias-state-business-primary);outline-offset:-2px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent)}',
  '.qt-attachments{display:flex;flex:none;gap:4px;min-width:0;max-width:55%;overflow:hidden}',
  '.qt-file{display:inline-flex;flex:0 1 180px;align-items:center;gap:4px;min-width:74px;height:24px;padding:0 6px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);box-sizing:border-box}',
  '.qt-fileIcon{display:inline-flex;flex:none;width:16px;height:16px}',
  '.qt-fileName{min-width:0;overflow:hidden;color:var(--dsw-alias-label-primary-dimmed);font:var(--dsw-font-xs-13);text-overflow:ellipsis;white-space:nowrap}',
  '.qt-fileSize{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;white-space:nowrap}',
  '.qt-thumb{width:24px;height:24px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-base);object-fit:cover;box-sizing:border-box;display:inline-block}',
  '.qt-preview,.qt-editor{min-width:0;font:var(--dsw-font-xs-13);font-family:Inter, var(--dsw-font-family);flex:auto}',
  '.qt-preview{color:var(--dsw-alias-label-primary-dimmed);text-overflow:ellipsis;white-space:nowrap;word-break:break-word;overflow:hidden}',
  '.qt-row-editing{align-items:flex-start;padding-top:6px}',
  '.qt-editor{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);min-height:28px;max-height:112px;color:var(--dsw-alias-label-primary);border-radius:6px;outline:none;padding:4px 8px;resize:none;overflow-y:auto;font:var(--dsw-font-xs-13);font-family:Inter, var(--dsw-font-family);line-height:18px}',
  '.qt-editor:focus{border-color:var(--dsw-alias-state-business-primary)}',
  '.qt-status{flex:none;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);white-space:nowrap}',
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
  image: '排队消息图片',
  file: '排队文件 {name}',
  edit: '编辑排队消息',
  'edit.unsupported': '包含非文本内容，暂不支持编辑',
  save: '保存排队消息',
  cancelEdit: '取消编辑',
  remove: '删除排队消息',
  steer: '插话发送',
  'steer.unavailable': '仅运行中可插话发送',
  sending: '正在发送…',
  editFailed: '编辑失败：这条消息可能已经开始发送。',
  removeFailed: '删除失败：这条消息可能已经开始发送。',
  steerFailed: '插话发送失败，请重试。',
  reorderFailed: '排序失败：这条消息可能已经开始发送。',
  reorderUnavailable: '排序失败：排序服务未加载（重启 dsh 后恢复）。',
};

/** English dictionary checked against the Chinese key set. */
const en = {
  count: '{n} queued messages',
  image: 'Queued message image',
  file: 'Queued file {name}',
  edit: 'Edit queued message',
  'edit.unsupported': 'Contains non-text content; editing is not supported yet',
  save: 'Save queued message',
  cancelEdit: 'Cancel editing',
  remove: 'Remove queued message',
  steer: 'Steer queued message',
  'steer.unavailable': 'Steering is available only while the agent is running',
  sending: 'Sending…',
  editFailed: 'Edit failed: this message may have already started sending.',
  removeFailed: 'Removal failed: this message may have already started sending.',
  steerFailed: 'Steering failed. Try again.',
  reorderFailed: 'Reorder failed: this message may have already started sending.',
  reorderUnavailable: 'Reorder failed: the reorder service is not loaded (recovers after a dsh restart).',
};

/** Dictionary namespace owned by this plugin. */
const NS = 'queue.tools';

/** The one placement this dock renders (`next-turn` rows). Every `toIndex` it
 *  sends is relative to that list, and the host validates it as such. */
const QUEUED_PLACEMENT = 'queued';

/** Shared empty list: a stable identity keeps the useMemo dependencies calm. */
const EMPTY = [];

/** Text-rendering facts handed to the shipped `conversation.user.text` factory,
 *  matching the official dock (collapse runs of whitespace, trim the ends). */
const QUEUE_TEXT_FACTS = Object.freeze({ collapseWhitespace: true, trimWhitespace: true });

/**
 * The row's text when editing can round-trip it, `null` otherwise.
 *
 * Only an all-text message can be edited through the queue action, so anything
 * carrying an image, file or tool block is reported as unsupported instead of
 * silently losing that content on save.
 */
function textOf(content) {
  if (!Array.isArray(content) || content.length === 0) return null;
  if (!content.every((block) => block !== null && typeof block === 'object' && block.type === 'text')) return null;
  return content.map((block) => block.text).join('');
}

/**
 * The plain-text preview of one row: the concatenated text blocks. Attachments
 * render as their own thumbnails/chips beside it, exactly like the shipped
 * dock, so an image/file block contributes no marker text here.
 */
function textPreviewOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block !== null && typeof block === 'object' && block.type === 'text' ? String(block.text) : ''))
    .join('');
}

/**
 * Durable attachment references carried by one queued row. Inbox projections
 * are wire data despite their typed face, so an image/file block without a
 * reference is skipped rather than trusted.
 */
function queueAttachments(content) {
  const attachments = [];
  if (!Array.isArray(content)) return attachments;
  for (const block of content) {
    if (block?.type === 'image' && block.attachment !== undefined) attachments.push({ type: 'image', attachment: block.attachment });
    if (block?.type === 'file' && block.attachment !== undefined) attachments.push({ type: 'file', attachment: block.attachment });
  }
  return attachments;
}

/** Index of `id` inside the projection's `next-turn` list (the Host's space). */
function nextTurnIndexOf(inbox, id) {
  const durable = inbox !== null && typeof inbox === 'object' && Array.isArray(inbox['next-turn']) ? inbox['next-turn'] : [];
  return durable.findIndex((row) => row?.id === id);
}

/** Services required by the queue-dock registration. */
const inject = ['slots', 'locale', 'sessions', 'uiConversation'];

/**
 * A failure of the transport itself (fetch threw, non-2xx, the route is not
 * registered at all) as opposed to a host-side refusal: the host half is then
 * not live in this process, which callers surface differently.
 */
const transportError = (message) => Object.assign(new Error(message), { code: 'transport' });

/**
 * One call to the host half over its `/queue` prefix route.
 *
 * This used to be a Connection RPC call, which cannot work in this dsh version:
 * the Connection registry throws `cannot get property "webServer" without
 * inject` for every plugin outside the connection package, so the channel never
 * exists and the request would land on the SPA fallback. The host half registers
 * that route itself (see `createRpcRoute` there) and answers the same
 * `{ ok, value }` / `{ ok, error }` envelope.
 *
 * Same-origin by construction, JSON in and out — the host's fence requires it.
 */
const call = async (endpoint, args) => {
  let response
  try {
    response = await fetch('/queue/' + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: args ?? {} }),
    })
  } catch (error) {
    throw transportError('rpc ' + endpoint + ' failed: ' + String(error?.message ?? error))
  }
  if (!response.ok) throw transportError('rpc ' + endpoint + ' failed: HTTP ' + String(response.status))
  const envelope = await response.json()
  if (envelope === null || typeof envelope !== 'object' || envelope.ok !== true) {
    const error = new Error(
      'rpc ' + endpoint + ' failed: ' +
      String(envelope?.error?.code ?? 'malformed') + ': ' + String(envelope?.error?.message ?? 'malformed envelope'),
    )
    error.code = envelope?.error?.code
    error.details = envelope?.error?.details
    throw error
  }
  return envelope.value
}

/** One durable queued image as a fixed-size thumbnail; a load failure keeps the
 *  empty placeholder. Mirrors the shipped dock's QueueThumb. */
function QueueThumb({ attachment, loadImage, label }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    if (typeof loadImage !== 'function') return () => { alive = false };
    Promise.resolve(loadImage(attachment)).then(
      (resolved) => { if (alive) setUrl(resolved) },
      () => { /* placeholder retained; the durable transcript surfaces read errors */ },
    );
    return () => { alive = false };
  }, [attachment, loadImage]);
  return url === null
    ? jsx('span', { className: 'qt-thumb', 'aria-hidden': true }, 'thumb')
    : jsx('img', { className: 'qt-thumb', src: url, alt: label }, 'thumb');
}

/** Compact file identity used beside queue thumbnails. */
function QueueFile({ attachment, label }) {
  const name = typeof attachment?.name === 'string' ? attachment.name : '';
  const size = typeof attachment?.bytes === 'number' && typeof fileSizeText === 'function'
    ? fileSizeText(attachment.bytes)
    : '';
  return jsxs('span', { className: 'qt-file', 'aria-label': label, title: name, children: [
    jsx('span', { className: 'qt-fileIcon', 'aria-hidden': true, children: jsx(FileTypeIcon, { path: name, size: 16 }) }, 'icon'),
    jsx('span', { className: 'qt-fileName', children: name }, 'name'),
    size === '' ? null : jsx('span', { className: 'qt-fileSize', children: size }, 'size'),
  ] });
}

/**
 * Enhanced queue strip: the shipped dock (attachments, pending echoes, inline
 * edit/remove/steer, collapsible header, continuable-subagent actions) plus a
 * full-text hover preview and drag-to-reorder.
 */
function QueueToolsDock({
  useSession, useProjection, updateQueue, notify, loadImage, reorder, renderFactorySlot, t,
}) {
  const inbox = useProjection('inbox');
  const pendingSubmissions = useSession((s) => s.pendingSubmissions) ?? EMPTY;
  const queue = useMemo(() => {
    const rows = inbox !== null && typeof inbox === 'object' && Array.isArray(inbox['next-turn']) ? inbox['next-turn'] : EMPTY;
    // Locally queued submissions that already echoed into the transcript are
    // represented by their durable row; rendering both would duplicate them.
    const inChat = new Set(
      pendingSubmissions.filter((item) => item?.placement === 'transcript').map((item) => item.requestId),
    );
    if (inChat.size === 0) return rows;
    return rows.filter(({ source }) => (
      source == null || typeof source !== 'object' || source.kind !== 'user'
      || typeof source.rpcId !== 'string' || !inChat.has(source.rpcId)
    ));
  }, [inbox, pendingSubmissions]);
  const pendingQueue = useMemo(() => {
    const admitted = new Set();
    for (const row of queue) {
      const source = row?.source;
      if (source != null && typeof source === 'object' && source.kind === 'user' && typeof source.rpcId === 'string') {
        admitted.add(source.rpcId);
      }
    }
    return pendingSubmissions.filter((item) => item?.placement === QUEUED_PLACEMENT && !admitted.has(item?.requestId));
  }, [pendingSubmissions, queue]);
  const rowCount = queue.length + pendingQueue.length;
  const running = useSession((s) => s.running);
  // A continuable subagent session accepts queue mutations too; the shipped
  // dock gates on the same predicate.
  const queueMutable = useSession((s) => s.subagent === null || s.subagent?.address?.mode === 'continuable');
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(null);
  const [collapsed, setCollapsed] = useState(true);
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const listId = useId();

  useEffect(() => {
    if (rowCount === 0 && !collapsed) setCollapsed(true);
    if (editing !== null && (!queueMutable || !queue.some((row) => row.id === editing.id))) setEditing(null);
  }, [collapsed, editing, queue, queueMutable, rowCount]);

  if (rowCount === 0) return null;
  const interactionActive = queueMutable && (editing !== null || busy !== null);
  const expanded = !collapsed || interactionActive;
  const listVisible = rowCount === 1 || expanded;
  // Only admitted durable rows are reorderable. A locally queued submission
  // carries its `requestId`, but the Host has not published a row for it yet,
  // so there is no inbox entry to splice.
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
    } catch (error) {
      notify('error', error?.code === 'transport' ? t('reorderUnavailable') : t('reorderFailed'));
    } finally {
      setBusy((current) => current === itemId ? null : current);
    }
  };

  /**
   * Translate a drop onto `toRow` into a `next-turn` index.
   *
   * The rendered list filters/appends submissions, while the reorder endpoint
   * splices the projection's own `next-turn` list, so the target is resolved
   * back to a durable row and its position inside the projection travels.
   */
  const dropOn = (toRow) => {
    if (draggingId === null || draggingId === toRow.id) return;
    const fromIndex = nextTurnIndexOf(inbox, draggingId);
    const toIndex = nextTurnIndexOf(inbox, toRow.id);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    void applyReorder(draggingId, toIndex);
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

  /** Render the preview through the shipped user-text factory when the slot
   *  supplies one, falling back to plain text in a DOM-free contract test. */
  const renderPreview = (text) => {
    if (typeof renderFactorySlot === 'function') {
      return renderFactorySlot('conversation.user.text', {
        text, facts: QUEUE_TEXT_FACTS, interactive: false, ellipsis: true,
      });
    }
    return text;
  };

  const previewNode = (key, text) => {
    const span = jsx('span', { className: 'qt-preview', children: renderPreview(text) }, 'preview');
    if (text.length === 0) return span;
    // The tooltip carries the UNCUT text: the shipped factory ellipsizes by CSS.
    return jsx(Tooltip, { label: text, side: 'bottom', delayMs: 500, maxWidth: 480, children: span }, key);
  };

  const attachmentsNode = (key, attachments) => jsx('span', { className: 'qt-attachments', children: attachments.map((item, index) => (
    item.type === 'image'
      // A locally queued image already carries a browser preview URL; only the
      // durable inbox row needs the session-authorized loader.
      ? (typeof item.previewUrl === 'string'
        ? jsx('img', { className: 'qt-thumb', src: item.previewUrl, alt: t('image') }, `${item.previewUrl}:${index}`)
        : jsx(QueueThumb, {
          attachment: item.attachment, loadImage, label: t('image'),
        }, `${item.attachment?.attachmentId ?? 'image'}:${index}`))
      : jsx(QueueFile, {
        attachment: item.attachment, label: t('file', { name: item.attachment?.name ?? '' }),
      }, `${item.attachment?.attachmentId ?? item.attachment?.name ?? 'file'}:${index}`)
  )) }, key);

  const editorNode = () => jsx('textarea', {
    autoFocus: true,
    rows: 1,
    className: 'qt-editor',
    'aria-label': t('edit'),
    value: editing.text,
    ref: (el) => {
      // Fit the box to the content once on mount (multiline editing).
      if (el !== null && el.dataset.sized !== '1') {
        el.dataset.sized = '1'
        el.style.height = 'auto'
        el.style.height = el.scrollHeight + 'px'
      }
    },
    onChange: (event) => {
      const el = event.currentTarget
      el.style.height = 'auto'
      el.style.height = el.scrollHeight + 'px'
      setEditing({ id: editing.id, text: el.value })
    },
    onKeyDown: (event) => {
      if (event.key === 'Escape') { setEditing(null); return }
      // Enter submits (official behavior); Shift+Enter inserts a newline.
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        void saveEdit();
      }
    },
  }, 'editor');

  const actionsNode = (row) => (editing?.id === row.id
    ? jsxs(Fragment, { children: [
      jsx(Tooltip, { label: t('save'), side: 'bottom', delayMs: 500, children: jsx('button', {
        type: 'button',
        className: 'qt-action',
        'aria-label': t('save'),
        disabled: busy !== null || editing.text.trim() === '',
        onClick: () => { void saveEdit() },
        children: jsx(IconCheckOutlineRegular, { size: 14 }),
      }, 'save') }),
      jsx(Tooltip, { label: t('cancelEdit'), side: 'bottom', delayMs: 500, children: jsx('button', {
        type: 'button',
        className: 'qt-action',
        'aria-label': t('cancelEdit'),
        disabled: busy !== null,
        onClick: () => { setEditing(null) },
        children: jsx(IconCloseOutlineRegular, { size: 14 }),
      }, 'cancel') }),
    ] })
    : jsxs(Fragment, { children: [
      jsx(Tooltip, { label: t('edit'), side: 'bottom', delayMs: 500, disabled: row.text === null, children: jsx('button', {
        type: 'button',
        className: 'qt-action',
        'aria-label': t('edit'),
        title: row.text === null ? t('edit.unsupported') : undefined,
        disabled: busy !== null || row.text === null,
        onClick: (event) => {
          // Drop focus so the button's focus-triggered tooltip cannot linger
          // when the row swaps into edit mode.
          if (event.currentTarget.blur) event.currentTarget.blur()
          if (row.text !== null) setEditing({ id: row.id, text: row.text })
        },
        onMouseDown: (event) => {
          // Prevent mouse clicks from focusing the button at all (the
          // focus-triggered tooltip popping up on click is the reported
          // glitch); keyboard Tab focus keeps working.
          if (event.preventDefault) event.preventDefault()
        },
        children: jsx(IconEditOutlineRegular, { size: 14 }),
      }, 'edit') }),
      jsx(Tooltip, { label: t('remove'), side: 'bottom', delayMs: 500, children: jsx('button', {
        type: 'button',
        className: 'qt-action',
        'aria-label': t('remove'),
        disabled: busy !== null,
        onClick: () => { void applyAction(row.id, { kind: 'remove' }, t('removeFailed')) },
        children: jsx(IconTrashOutlineRegular, { size: 14 }),
      }, 'remove') }),
      jsx(Tooltip, { label: t('steer'), side: 'bottom', delayMs: 500, disabled: !running, children: jsx('button', {
        type: 'button',
        className: 'qt-action',
        'aria-label': t('steer'),
        title: running ? undefined : t('steer.unavailable'),
        disabled: busy !== null || !running,
        onClick: () => { void applyAction(row.id, { kind: 'steer' }, t('steerFailed')) },
        children: jsx(IconSendOutlineMedium, {}),
      }, 'steer') }),
    ] }));

  const durableRow = (row) => {
    const attachments = queueAttachments(row?.content);
    // `null` (not '') means the row cannot round-trip an edit: content that is
    // not entirely text must not silently lose its attachments on save.
    const text = textOf(row?.content);
    const previewText = textPreviewOf(row?.content);
    const editingThis = editing?.id === row.id;
    const dragClass = (draggingId === row.id ? ' qt-row-dragging' : '')
      + (dragOverId === row.id && draggingId !== null && draggingId !== row.id ? ' qt-row-over' : '');
    return jsxs('li', {
      className: 'qt-row' + (editingThis ? ' qt-row-editing' : '') + dragClass,
      // `false`, never `undefined`: React does not remove an attribute a
      // previous render already set when the new value is undefined.
      draggable: canReorder && !editingThis ? true : false,
      'aria-grabbed': draggingId === row.id ? true : undefined,
      onDragStart: (event) => {
        if (!canReorder || editingThis) return
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
        if (draggingId === null) return
        event.preventDefault()
        dropOn(row)
        endDrag()
      },
      onDragEnd: endDrag,
      children: [
        rowCount === 1 ? jsx('span', { className: 'qt-lead', 'aria-hidden': true, children: jsx(IconQueueOutlineMedium, {}) }, 'lead') : null,
        attachments.length > 0 ? attachmentsNode('attachments', attachments) : null,
        editingThis ? editorNode() : previewNode('preview-tip', previewText),
        queueMutable ? jsx('div', { className: 'qt-actions', children: actionsNode({ ...row, text }) }, 'actions') : null,
      ],
    }, row.id);
  };

  const pendingRow = (submission) => {
    const attachments = Array.isArray(submission?.attachments)
      ? submission.attachments.filter((item) => item?.type === 'image' || item?.type === 'file')
      : [];
    const text = typeof submission?.text === 'string' ? submission.text : '';
    // A locally queued submission has no Host row to act on yet: show its own
    // echo (text + attachments) and a sending status instead of actions.
    return jsxs('li', {
      className: 'qt-row qt-pending-row',
      'data-qt-pending': '1',
      draggable: false,
      children: [
        rowCount === 1 ? jsx('span', { className: 'qt-lead', 'aria-hidden': true, children: jsx(IconQueueOutlineMedium, {}) }, 'lead') : null,
        attachments.length > 0
          ? attachmentsNode('attachments', attachments.map((item) => ({
            type: item.type,
            attachment: item.value ?? item.attachment,
            previewUrl: item.value?.previewUrl,
          })))
          : null,
        previewNode('preview-tip', text),
        jsx('span', { className: 'qt-status', role: 'status', children: t('sending') }, 'status'),
      ],
    }, submission.requestId);
  };

  return jsx('div', { className: 'qt-dock', 'data-queue-dock': '', children: jsxs('div', { className: 'qt-panel', children: [
    rowCount > 1 ? jsxs('button', {
      type: 'button',
      className: 'qt-header',
      'aria-controls': listId,
      'aria-expanded': expanded,
      disabled: interactionActive ? true : undefined,
      onClick: () => { setCollapsed((value) => !value) },
      children: [
        jsx('span', { className: 'qt-lead', 'aria-hidden': true, children: jsx(IconQueueOutlineMedium, {}) }, 'lead'),
        jsx('span', { className: 'qt-count', children: t('count', { n: rowCount }) }, 'count'),
        !listVisible && pendingQueue.length > 0
          ? jsx('span', { className: 'qt-status', role: 'status', children: t('sending') }, 'status')
          : null,
        jsx('span', { className: 'qt-chevron', 'aria-hidden': true, children: expanded ? jsx(IconChevronDownOutlineMedium, {}) : jsx(IconChevronUpOutlineMedium, {}) }, 'chevron'),
      ],
    }, 'header') : null,
    jsx('ul', {
      id: listId,
      className: 'qt-list',
      hidden: !listVisible,
      children: listVisible
        ? [...queue.map(durableRow), ...pendingQueue.map(pendingRow)]
        : null,
    }, 'list'),
  ] }) });
}

/** Contribute the enhanced queue dock, shadowing the shipped entry. */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-queue-tools: dictionaries')

  const reorder = async (sessionId, itemId, toIndex, placement) => {
    try {
      return await call('reorder', { sessionId, itemId, toIndex, placement })
    } catch (error) {
      // Keep this patch's own failure wording while preserving the transport's
      // machine-readable fields for callers that branch on them.
      const wrapped = new Error('queue reorder failed: ' + String(error?.message ?? error))
      wrapped.code = error?.code
      wrapped.details = error?.details
      throw wrapped
    }
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
        // Durable queued images resolve through the shipped session-authorized
        // loader; the shipped dock does the same.
        loadImage: (attachment) => ctx.uiConversation.imageUrl(sessionId, attachment),
        // Every index this dock computes comes from the `queued` rows it
        // renders, so the host can refuse a move onto any other list.
        reorder: (itemId, toIndex) => reorder(sessionId, itemId, toIndex, QUEUED_PLACEMENT),
      }
    },
  }, QueueToolsDock))
}

module.exports = { apply, inject, NS };
return module.exports;
} });
