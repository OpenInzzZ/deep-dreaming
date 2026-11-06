/**
 * Browser half of the session-cleanup patch.
 *
 * 自动清理已整体移除：这个插件现在只做一件事——**手动物理删除已归档会话**。
 * 两个入口共用同一套 Host 端点（`POST /session-cleanup/<endpoint>`）：
 *
 *   1. 设置页 `settings.section`（id `session-cleanup`）：一张「已归档会话」
 *      列表，带大小与目录，可逐条或批量勾选删除；删除前弹出二次确认，
 *      列出将删除的会话、目录与总占用。
 *   2. 会话行的右键菜单（`sidebar.workspaces.session.menu.item`）：仅当该会话
 *      已归档时出现「删除归档会话」，点击同样走二次确认弹窗。
 *
 * 已归档的权威来源是 Host 的 `workspaceRegistry.archivedSessionIds`，客户端
 * 从不自行推断。菜单项判断「是否已归档」用的是官方提供的 `hooks.archived`
 * 观察值（`PinSessionInjected` 同款），因此不额外复制归档状态。
 *
 * 为什么用自建 fenced 路由而不是 settings 文档：删除是动作而不是配置，
 * 而且卡片的数据路径不该依赖 Host 如何接线 settings（见补丁 README）。
 */
window.__ModuleLoader__.load({ id: '@local/dsh-plugin-session-cleanup', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useEffect, useState, useMemo, useCallback } = React;
const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
const {
  IconChevronDownOutlineMedium,
  IconTrashOutlineMedium,
  Modal,
} = require('@deepseek-ai/dsh-client-ui-primitives');

const PLUGIN_ID = '@local/dsh-plugin-session-cleanup';

const CSS = [
  '.sc-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}',
  '.sc-card:hover{border-color:var(--dsw-alias-label-dimmed)}',
  '.sc-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
  '.sc-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
  '.sc-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
  '.sc-head-text{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
  '.sc-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
  '.sc-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
  '.sc-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
  '.sc-chevron-open{transform:rotate(180deg)}',
  '.sc-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
  '.sc-toolbar{align-items:center;gap:8px;padding:12px 0;display:flex;flex-wrap:wrap}',
  '.sc-summary{min-width:0;color:var(--dsw-alias-label-secondary);flex:1;font-size:13px;line-height:1.5}',
  '.sc-list{max-height:320px;overflow-y:auto;margin:0;padding:0;list-style:none}',
  '.sc-row{align-items:flex-start;gap:10px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l2);display:flex}',
  '.sc-row:first-child{border-top:0}',
  '.sc-check{accent-color:var(--dsw-alias-brand-primary);width:16px;height:16px;flex:none;margin-top:2px}',
  '.sc-row-text{min-width:0;flex:1;flex-direction:column;gap:2px;display:flex}',
  '.sc-row-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5;word-break:break-all}',
  '.sc-row-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;word-break:break-all}',
  '.sc-row-live{color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:1.5}',
  '.sc-danger,.sc-plain{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
  '.sc-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:0 0}',
  '.sc-danger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.sc-plain{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}',
  '.sc-danger:disabled,.sc-plain:disabled{opacity:.5;cursor:default}',
  '.sc-empty{color:var(--dsw-alias-label-tertiary);margin:0;padding:12px 0;font-size:13px;line-height:1.5}',
  '.sc-failed{min-width:0;color:var(--dsw-alias-state-error-primary);flex:1;margin:0;font-size:12px;line-height:1.5}',
  '.sc-confirm-line{color:var(--dsw-alias-label-secondary);margin:0 0 6px;font-size:13px;line-height:1.6}',
  '.sc-confirm-path{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:12px;line-height:1.5;word-break:break-all}',
  '.sc-confirm-warn{color:var(--dsw-alias-state-error-primary);margin:10px 0 0;font-size:13px;line-height:1.6}',
].join('\n');
(function () {
  if (typeof document === 'undefined') return
  const tagId = PLUGIN_ID + '/session-cleanup-card.css'
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
})();

/** Simplified Chinese dictionary and key source of truth. */
const zh = {
  title: '会话清理',
  description: '手动删除已归档会话，释放磁盘占用。不再自动清理。',
  unsaved: '未保存',
  collapse: '收起',
  expand: '展开',
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  saveFailed: '保存失败,请重试。',
  resetAll: '恢复默认',
  enabled: '启用',
  enabledHint: '关闭后不列出也不允许删除归档会话。',
  sessionsRoot: '会话根目录',
  sessionsRootHint: '留空使用 $DSH_HOME/sessions。',
  archivedList: '已归档会话',
  refresh: '刷新',
  loading: '加载中…',
  empty: '没有可删除的已归档会话。',
  selectAll: '全选',
  clearAll: '取消全选',
  selectedCount: '已选 {n} 项',
  deleteSelected: '删除所选',
  deleteOne: '删除',
  live: '正在运行，不可删除',
  totalBytes: '共 {size}',
  loadFailed: '读取已归档会话失败。',
  deleteFailed: '删除失败,请重试。',
  confirmTitle: '确认删除已归档会话',
  confirmIntro: '以下会话目录将被永久删除，其中包括日志与附件等全部产物：',
  confirmWarn: '此操作不可撤销，删除后无法恢复。',
  confirmMore: '…以及另外 {n} 项',
  confirmDelete: '永久删除',
  confirmCancel: '取消',
  deleting: '删除中…',
  deletedOne: '已删除 1 个会话，释放 {size}',
  deletedMany: '已删除 {n} 个会话，释放 {size}',
  refused: '有 {n} 项被拒绝（可能正在运行或已不在归档中）。',
  menuDelete: '删除归档会话',
};

/** English dictionary checked against the Chinese key set. */
const en = {
  title: 'Session cleanup',
  description: 'Manually delete archived sessions to reclaim disk space. Nothing runs automatically.',
  unsaved: 'Unsaved',
  collapse: 'Collapse',
  expand: 'Expand',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saveFailed: 'Save failed. Try again.',
  resetAll: 'Restore defaults',
  enabled: 'Enabled',
  enabledHint: 'When off, archived sessions are neither listed nor deletable.',
  sessionsRoot: 'Sessions root',
  sessionsRootHint: 'Leave empty for $DSH_HOME/sessions.',
  archivedList: 'Archived sessions',
  refresh: 'Refresh',
  loading: 'Loading…',
  empty: 'No archived sessions to delete.',
  selectAll: 'Select all',
  clearAll: 'Clear selection',
  selectedCount: '{n} selected',
  deleteSelected: 'Delete selected',
  deleteOne: 'Delete',
  live: 'Running — cannot be deleted',
  totalBytes: '{size} total',
  loadFailed: 'Could not read archived sessions.',
  deleteFailed: 'Delete failed. Try again.',
  confirmTitle: 'Delete archived sessions',
  confirmIntro: 'These session directories will be permanently deleted, including logs and attachments:',
  confirmWarn: 'This cannot be undone.',
  confirmMore: '…and {n} more',
  confirmDelete: 'Delete permanently',
  confirmCancel: 'Cancel',
  deleting: 'Deleting…',
  deletedOne: 'Deleted 1 session, freed {size}',
  deletedMany: 'Deleted {n} sessions, freed {size}',
  refused: '{n} item(s) refused (running, or no longer archived).',
  menuDelete: 'Delete archived session',
};

/** Dictionary namespace owned by this plugin. */
const NS = 'session-cleanup.card';

/** Services required by the card registration. */
const inject = ['slots', 'locale'];

/** Human-readable byte size (mirrors the Host helper, which is host-side only). */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return (value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[index]
}

/** Fill `{name}` placeholders in a dictionary string. */
function fill(text, params) {
  if (params === undefined) return text
  return String(text).replace(/\{(\w+)\}/g, (whole, key) => (key in params ? String(params[key]) : whole))
}

/**
 * Identity shown as a row's title.
 *
 * A session's real title lives in its event log (`session/title`), not in the
 * header, so it is unavailable without decompressing the log — which this
 * plugin deliberately never does (the list only stats and removes directories).
 * The project directory plus the age is the strongest identifier already on
 * hand, and it is what disambiguates two sessions of the same project.
 * @param item - one `listArchived` row.
 */
function rowTitle(item) {
  if (typeof item.project === 'string' && item.project.length > 0) {
    // `--D-GitHub-deep-dreaming--` is the storage's project key; strip its
    // decorators and leading separator dashes to get the readable name back.
    const readable = item.project.replace(/^--/, '').replace(/--$/, '').replace(/^-+/, '')
    return readable.length > 0 ? readable : item.project
  }
  return item.id
}

/** When the session was last touched, or '' when unknown. */
function rowWhen(item) {
  if (!Number.isFinite(item.mtimeMs) || item.mtimeMs <= 0) return ''
  const at = new Date(item.mtimeMs)
  const pad = (n) => String(n).padStart(2, '0')
  return (at.getMonth() + 1) + '-' + pad(at.getDate()) + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes())
}

/** Secondary line: last-seen time, size, and the raw session id for reference. */
function rowMeta(item) {
  const parts = []
  const when = rowWhen(item)
  if (when !== '') parts.push(when)
  parts.push(formatBytes(item.size ?? 0))
  parts.push(item.id)
  return parts.join(' · ')
}

/** One labelled configuration field. */
function Field({ fieldKey, label, hint, children, disabled }) {
  return jsxs('div', { className: 'sc-field', children: [
    jsx('div', { className: 'sc-field-head', children: [
      jsx('label', { className: 'sc-label', htmlFor: 'sc-' + fieldKey, children: label }, 'label'),
    ] }, 'head'),
    children(disabled),
    jsx('p', { className: 'sc-hint', children: hint }, 'hint'),
  ] });
}

/**
 * The destructive confirmation dialog, shared by the settings list and the
 * session-row menu item. It names exactly what will disappear and how much
 * space that reclaims before the user can commit.
 */
function ConfirmDelete({ t, open, items, busy, onCancel, onConfirm }) {
  if (!open) return null
  const shown = items.slice(0, 8)
  const rest = items.length - shown.length
  const total = items.reduce((sum, item) => sum + (item.size ?? 0), 0)
  return jsx(Modal, {
    open,
    onClose: busy ? () => {} : onCancel,
    title: t('confirmTitle'),
    closeLabel: t('confirmCancel'),
    footer: jsxs(Fragment, { children: [
      jsx('button', { type: 'button', className: 'sc-plain', disabled: busy, onClick: onCancel, children: t('confirmCancel') }, 'cancel'),
      jsx('button', { type: 'button', className: 'sc-danger', disabled: busy, onClick: () => { void onConfirm() }, children: busy ? t('deleting') : t('confirmDelete') }, 'confirm'),
    ] }),
    children: jsxs(Fragment, { children: [
      jsx('p', { className: 'sc-confirm-line', children: t('confirmIntro') }, 'intro'),
      jsxs('p', { className: 'sc-confirm-line', children: [t('totalBytes', { size: formatBytes(total) }), ' · ', t('selectedCount', { n: items.length })] }, 'meta'),
      ...shown.map((item) => jsx('p', { className: 'sc-confirm-path', children: item.dir ?? item.id }, item.id)),
      rest > 0 ? jsx('p', { className: 'sc-confirm-path', children: t('confirmMore', { n: rest }) }, 'rest') : null,
      jsx('p', { className: 'sc-confirm-warn', children: t('confirmWarn') }, 'warn'),
    ] }),
  })
}

/** The archived-session list and its controls. */
function ArchivedList({ t, value, selection, busy, onToggle, onToggleAll, onDelete, onRefresh }) {
  // Only rows with something on disk are actionable. A `missing` entry is an id
  // still sitting in the archive set whose directory is already gone — nothing
  // to delete and nothing to size, so listing it is pure noise. The Host still
  // reports them (its listing is the honest full picture); hiding them here is
  // a presentation decision.
  const items = (value.items ?? []).filter((item) => !item.missing)
  const deletable = items.filter((item) => item.deletable)
  const allSelected = deletable.length > 0 && deletable.every((item) => selection.includes(item.id))
  const selectedItems = items.filter((item) => selection.includes(item.id) && item.deletable)
  const selectedBytes = selectedItems.reduce((sum, item) => sum + (item.size ?? 0), 0)

  return jsxs(Fragment, { children: [
    jsxs('div', { className: 'sc-toolbar', children: [
      jsx('span', { className: 'sc-summary', children: t('totalBytes', { size: formatBytes(value.totalBytes ?? 0) }) }, 'summary'),
      jsx('button', { type: 'button', className: 'sc-plain', disabled: busy, onClick: onRefresh, children: t('refresh') }, 'refresh'),
      deletable.length > 0
        ? jsx('button', { type: 'button', className: 'sc-plain', disabled: busy, onClick: () => { onToggleAll(!allSelected) }, children: allSelected ? t('clearAll') : t('selectAll') }, 'all')
        : null,
      selectedItems.length > 0
        ? jsx('button', { type: 'button', className: 'sc-danger', disabled: busy, onClick: () => { onDelete(selectedItems) }, children: t('deleteSelected') + ' (' + selectedItems.length + ')' }, 'bulk')
        : null,
    ] }, 'toolbar'),
    selection.length > 0
      ? jsx('p', { className: 'sc-hint', children: t('selectedCount', { n: selectedItems.length }) + ' · ' + formatBytes(selectedBytes) }, 'selected')
      : null,
    items.length === 0
      ? jsx('p', { className: 'sc-empty', children: t('empty') }, 'empty')
      : jsx('ul', { className: 'sc-list', children: items.map((item) => jsxs('li', { className: 'sc-row', children: [
          item.deletable
            ? jsx('input', {
                type: 'checkbox',
                className: 'sc-check',
                'aria-label': item.id,
                checked: selection.includes(item.id),
                disabled: busy,
                onChange: (event) => { onToggle(item.id, event.currentTarget.checked) },
              }, 'check')
            : jsx('span', { className: 'sc-check', 'aria-hidden': true }, 'check-space'),
          jsxs('span', { className: 'sc-row-text', children: [
            jsx('span', { className: 'sc-row-title', children: rowTitle(item) }, 'title'),
            jsx('span', { className: 'sc-row-meta', children: rowMeta(item) }, 'meta'),
            item.live ? jsx('span', { className: 'sc-row-live', children: t('live') }, 'live') : null,
          ] }, 'text'),
          item.deletable
            ? jsx('button', {
                type: 'button',
                className: 'sc-danger',
                disabled: busy,
                onClick: () => { onDelete([item]) },
                children: t('deleteOne'),
              }, 'one')
            : null,
        ] }, item.id + ':' + (item.dir ?? ''))) }),
  ] })
}

/** The settings page: enable switch, sessions root, and the archived list. */
function SessionCleanupCard({ t, getConfig, setConfig, resetConfig, listArchived, deleteArchived }) {
  const [config, setConfigState] = useState({ status: 'loading' })
  const [open, setOpen] = useState(false)
  const [staged, setStaged] = useState(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [listing, setListing] = useState({ status: 'idle' })
  const [selection, setSelection] = useState([])
  const [confirming, setConfirming] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)

  const loadList = useCallback(async () => {
    setListing({ status: 'loading' })
    try {
      const value = await listArchived()
      setListing({ status: 'ready', value })
      setSelection((current) => current.filter((id) => (value.items ?? []).some((item) => item.id === id && item.deletable)))
    } catch {
      setListing({ status: 'error' })
    }
  }, [listArchived])

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => getConfig()).then(
      (value) => { if (current) setConfigState({ status: 'ready', value }) },
      () => { if (current) setConfigState({ status: 'error' }) },
    )
    return () => { current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The list is fetched once the card is expanded, and again whenever the
  // plugin is re-enabled (a disabled Host answers with `disabled: true`).
  useEffect(() => {
    if (!open) return
    void loadList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (config.status !== 'ready') return null
  const value = config.value ?? {}
  const enabled = value.enabled !== false
  const dirty = staged !== null && Object.keys(staged).length > 0

  const textOf = (key) => {
    if (staged !== null && key in staged) return staged[key]
    const current = value[key]
    if (typeof current === 'boolean') return current ? 'true' : 'false'
    if (current === undefined || current === null) return ''
    return String(current)
  }
  const edit = (key, text) => {
    setFailed(false)
    setStaged((current) => ({ ...(current ?? {}), [key]: text }))
  }
  const save = async () => {
    if (staged === null) return
    setSaving(true); setFailed(false)
    try {
      const parsed = {}
      for (const [key, text] of Object.entries(staged)) {
        if (key === 'enabled') parsed[key] = text === 'true'
        else parsed[key] = text
      }
      const next = await setConfig(parsed)
      setConfigState({ status: 'ready', value: next })
      setStaged(null)
      if (open) await loadList()
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }
  const resetAll = async () => {
    setSaving(true); setFailed(false)
    try {
      const next = await resetConfig()
      setConfigState({ status: 'ready', value: next })
      setStaged(null)
      if (open) await loadList()
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const runDelete = async (items) => {
    setBusy(true); setNotice(null)
    try {
      const result = await deleteArchived(items.map((item) => item.id))
      setConfirming(null)
      setSelection([])
      const removed = result.removed ?? []
      const freed = formatBytes(result.freedBytes ?? 0)
      if (removed.length > 0) {
        setNotice(removed.length === 1
          ? t('deletedOne', { size: freed })
          : t('deletedMany', { n: removed.length, size: freed }))
      }
      if ((result.refused ?? []).length > 0) {
        setNotice((current) => (current === null ? t('refused', { n: result.refused.length }) : current + ' ' + t('refused', { n: result.refused.length })))
      }
      await loadList()
    } catch {
      setNotice(t('deleteFailed'))
    } finally {
      setBusy(false)
    }
  }

  return jsxs('li', { className: 'sc-card' + (open ? ' sc-card-open' : ''), children: [
    jsxs('button', {
      type: 'button',
      className: 'sc-header',
      'aria-expanded': open,
      'aria-label': (open ? t('collapse') : t('expand')) + ': ' + t('title'),
      onClick: () => { setOpen(!open) },
      children: [
        jsxs('span', { className: 'sc-head-text', children: [
          jsx('span', { className: 'sc-name', children: t('title') }, 'name'),
          jsx('span', { className: 'sc-description', children: t('description') }, 'desc'),
        ] }, 'head-text'),
        dirty ? jsx('span', { className: 'sc-pending', children: t('unsaved') }, 'pending') : null,
        jsx(IconChevronDownOutlineMedium, { className: 'sc-chevron' + (open ? ' sc-chevron-open' : ''), 'aria-hidden': true }, 'chevron'),
      ],
    }, 'header'),
    open ? jsxs('div', { className: 'sc-body', children: [
      jsx(Field, {
        fieldKey: 'enabled',
        label: t('enabled'),
        hint: t('enabledHint'),
        children: (disabled) => jsx('input', {
          id: 'sc-enabled',
          type: 'checkbox',
          className: 'sc-toggle',
          checked: textOf('enabled') === 'true',
          disabled: disabled || saving,
          onChange: (event) => { edit('enabled', event.currentTarget.checked ? 'true' : 'false') },
        }),
      }, 'enabled'),
      jsx(Field, {
        fieldKey: 'sessionsRoot',
        label: t('sessionsRoot'),
        hint: t('sessionsRootHint'),
        children: (disabled) => jsx('input', {
          id: 'sc-sessionsRoot',
          type: 'text',
          className: 'sc-input',
          value: textOf('sessionsRoot'),
          disabled: disabled || saving,
          onChange: (event) => { edit('sessionsRoot', event.currentTarget.value) },
        }),
      }, 'sessionsRoot'),
      jsxs('div', { className: 'sc-footer', children: [
        failed ? jsx('p', { className: 'sc-failed', role: 'status', children: t('saveFailed') }, 'failed') : null,
        jsx('button', { type: 'button', className: 'sc-plain', disabled: !dirty || saving, onClick: () => { setStaged(null); setFailed(false) }, children: t('discard') }, 'discard'),
        jsx('button', { type: 'button', className: 'sc-plain', disabled: saving, onClick: () => { void resetAll() }, children: t('resetAll') }, 'reset-all'),
        jsx('button', { type: 'button', className: 'sc-danger', disabled: !dirty || saving, onClick: () => { void save() }, children: saving ? t('saving') : t('save') }, 'save'),
      ] }, 'footer'),
      jsx('div', { className: 'sc-field', children: jsx('p', { className: 'sc-label', children: t('archivedList') }, 'label') }, 'list-label'),
      listing.status === 'loading' ? jsx('p', { className: 'sc-empty', children: t('loading') }, 'loading') : null,
      listing.status === 'error' ? jsx('p', { className: 'sc-failed', role: 'status', children: t('loadFailed') }, 'load-failed') : null,
      listing.status === 'ready'
        ? jsx(ArchivedList, {
            t,
            value: listing.value,
            selection,
            busy,
            onToggle: (id, on) => {
              setSelection((current) => (on ? [...new Set([...current, id])] : current.filter((item) => item !== id)))
            },
            onToggleAll: (on) => {
              const items = listing.value.items ?? []
              setSelection(on ? items.filter((item) => item.deletable).map((item) => item.id) : [])
            },
            onDelete: (items) => { setConfirming(items) },
            onRefresh: () => { void loadList() },
          })
        : null,
      notice !== null ? jsx('p', { className: 'sc-hint', role: 'status', children: notice }, 'notice') : null,
      jsx(ConfirmDelete, {
        t,
        open: confirming !== null,
        items: confirming ?? [],
        busy,
        onCancel: () => { if (!busy) setConfirming(null) },
        onConfirm: () => { void runDelete(confirming ?? []) },
      }),
    ] }, 'body') : null,
  ] })
}

/**
 * One call to the host half over its `/session-cleanup` prefix route.
 *
 * Same-origin by construction, JSON in and out — the host's fence requires it.
 */
const call = async (endpoint, args) => {
  let response
  try {
    response = await fetch('/session-cleanup/' + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: args ?? {} }),
    })
  } catch (error) {
    throw new Error('rpc ' + endpoint + ' failed: ' + String(error?.message ?? error))
  }
  if (!response.ok) throw new Error('rpc ' + endpoint + ' failed: HTTP ' + String(response.status))
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

/**
 * The session-row menu entry.
 *
 * Renders nothing unless the row's session is archived, so the menu looks
 * unchanged everywhere else. `hooks.archived` is the official observable the
 * shipped Pin/Archive actions read; using it keeps this patch from duplicating
 * archive state.
 */
function SessionDeleteMenuItem({ t, sessionId, displayTitle, useMenuOpenState, hooks }) {
  const [, setMenuOpen] = useMenuOpenState()
  const archived = hooks !== undefined && hooks.archived !== undefined
    ? React.useSyncExternalStore(hooks.archived.subscribe, hooks.archived.getSnapshot, hooks.archived.getSnapshot)
    : undefined
  const [confirming, setConfirming] = useState(null)
  const [busy, setBusy] = useState(false)

  if (archived === undefined || !archived.has(sessionId)) return null

  const openConfirm = () => {
    setMenuOpen(false)
    setConfirming({ item: { id: sessionId, dir: null, size: 0, title: displayTitle } })
  }
  const runDelete = async () => {
    setBusy(true)
    try {
      await call('deleteArchived', { ids: [sessionId] })
      setConfirming(null)
    } catch {
      setConfirming(null)
    } finally {
      setBusy(false)
    }
  }

  return jsxs(Fragment, { children: [
    jsx('button', {
      type: 'button',
      role: 'menuitem',
      onClick: openConfirm,
      children: t('menuDelete'),
    }, 'item'),
    jsx(ConfirmDelete, {
      t,
      open: confirming !== null,
      items: [confirming?.item ?? { id: sessionId, dir: displayTitle }],
      busy,
      onCancel: () => { setConfirming(null) },
      onConfirm: () => { void runDelete() },
    }, 'confirm'),
  ] })
}

/** Contribute the cleanup page and the session-row menu entry. */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-cleanup: card dictionaries')

  const getConfig = () => call('getConfig', {})
  const setConfig = (fields) => call('setConfig', { fields })
  const resetConfig = () => call('resetConfig', {})
  const listArchived = () => call('listArchived', {})
  const deleteArchived = (ids) => call('deleteArchived', { ids })
  const t = ctx.locale.bind(NS)

  // The shipped settings shell's page slot. The card's data path is this
  // plugin's own fenced route, so the page keeps working regardless of how the
  // Host wires its settings service.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'session-cleanup',
    order: 40,
    label: () => t('title'),
    locale: NS,
    inject: () => ({ getConfig, setConfig, resetConfig, listArchived, deleteArchived }),
  }, SessionCleanupCard))

  // The session-row right-click menu. This slot is a legacy React extension
  // position rendered inside the shared menu overlay; the entry owns its own
  // visibility, which is how it only appears for archived rows.
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'session-cleanup-delete',
    order: 900,
    locale: NS,
    inject: () => ({ listArchived, deleteArchived }),
  }, ({ t: bound, ...rest }) => jsx(SessionDeleteMenuItem, { t: bound ?? t, ...rest })))
}

module.exports = { apply, inject, NS };
return module.exports;
} });