/**
 * Browser half of the session-cleanup patch: a configuration card inside
 * 设置 → 插件 → 插件配置 (the `settings.plugin.item` slot).
 *
 * The card reads and writes the Host-registered settings namespace
 * `session-cleanup` through the Host's fenced prefix route
 * (`POST /session-cleanup/getConfig|setConfig|resetConfig`, see the `call`
 * helper below). It renders the same fields the plugin consumes — enabled,
 * maxAgeDays, maxTotalMB, keepSessions, intervalMinutes, dryRun, sessionsRoot
 * — with staged edits validated per field against the Host schema before save,
 * and a save that writes each field through the scope (the Host applies
 * changes live and rebuilds its cleanup timer).
 *
 * There is deliberately NO per-field reset-to-base: the Host RPC exposes the
 * resolved config only, never which layer (schema default / composition entry
 * / user document) supplied each value, so a per-field "重置" cannot know the
 * base to return to. 恢复默认 (reset-all, backed by the resetConfig endpoint)
 * is the honest equivalent; a permanently disabled button is not.
 *
 * The card renders nothing while the namespace is unavailable (a deployment
 * without the Host plugin shows no trace), mirroring the shipped cards.
 */
window.__ModuleLoader__.load({ id: '@local/dsh-plugin-session-cleanup', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useEffect, useState } = React;
const { jsx, jsxs } = require('react/jsx-runtime');
const { IconChevronDownOutline14 } = require('@deepseek-ai/dsh-client-ui-primitives');

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
  '.sc-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
  '.sc-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
  '.sc-field+.sc-field{border-top:1px solid var(--dsw-alias-border-l2)}',
  '.sc-field-head{align-items:center;gap:8px;display:flex}',
  '.sc-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
  '.sc-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}',
  '.sc-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
  '.sc-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
  '.sc-invalid{border-color:var(--dsw-alias-state-error-primary)}',
  '.sc-invalid-text{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:1.5}',
  '.sc-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
  '.sc-toggle{accent-color:var(--dsw-alias-brand-primary);width:16px;height:16px}',
  '.sc-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
  '.sc-failed{min-width:0;color:var(--dsw-alias-state-error-primary);flex:1;margin:0;font-size:12px;line-height:1.5}',
  '.sc-discard,.sc-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
  '.sc-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}',
  '.sc-save{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}',
  '.sc-save:disabled,.sc-discard:disabled{opacity:.5;cursor:default}',
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
  description: '按保留天数/总容量定期清理归档会话,跳过活跃会话。',
  unsaved: '未保存',
  collapse: '收起',
  expand: '展开',
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  saveFailed: '保存失败,请重试。',
  invalidNumber: '请输入有效数字',
  invalidNonNegative: '请输入不小于 0 的数字',
  invalidInterval: '清理间隔至少为 1 分钟',
  resetAll: '恢复默认',
  enabled: '启用',
  enabledHint: '关闭后停止定期清理。',
  maxAgeDays: '保留天数',
  maxAgeDaysHint: '超过该天数的归档会话可删;0 = 不按天数清理。',
  maxTotalMB: '总容量上限 (MB)',
  maxTotalMBHint: '会话目录总占用超过该值时按最旧优先删除;0 = 不限制。',
  keepSessions: '最少保留会话数',
  keepSessionsHint: '超龄规则仅作用于最旧超出部分,最近的会话受此保护。',
  intervalMinutes: '清理间隔 (分钟)',
  intervalMinutesHint: '启动时总会先清理一次,之后按此间隔执行。',
  dryRun: '演练模式',
  dryRunHint: '只报告将要删除的会话,不实际删除。',
  sessionsRoot: '会话根目录',
  sessionsRootHint: '留空使用 $DSH_HOME/sessions。',
};

/** English dictionary checked against the Chinese key set. */
const en = {
  title: 'Session cleanup',
  description: 'Periodically clean archived sessions by age / total size, skipping live ones.',
  unsaved: 'Unsaved',
  collapse: 'Collapse',
  expand: 'Expand',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saveFailed: 'Save failed. Try again.',
  invalidNumber: 'Enter a valid number',
  invalidNonNegative: 'Enter a number of 0 or more',
  invalidInterval: 'Interval must be at least 1 minute',
  resetAll: 'Restore defaults',
  enabled: 'Enabled',
  enabledHint: 'Turn off to stop periodic cleanup.',
  maxAgeDays: 'Max age (days)',
  maxAgeDaysHint: 'Archived sessions older than this can be removed; 0 = no age rule.',
  maxTotalMB: 'Size cap (MB)',
  maxTotalMBHint: 'Oldest sessions are removed first when the total exceeds this; 0 = no cap.',
  keepSessions: 'Minimum kept sessions',
  keepSessionsHint: 'The age rule only applies to the oldest excess; recent sessions stay.',
  intervalMinutes: 'Interval (minutes)',
  intervalMinutesHint: 'A cleanup always runs at startup, then on this interval.',
  dryRun: 'Dry run',
  dryRunHint: 'Only report what would be removed, never delete.',
  sessionsRoot: 'Sessions root',
  sessionsRootHint: 'Leave empty for $DSH_HOME/sessions.',
};

/** Dictionary namespace owned by this plugin. */
const NS = 'session-cleanup.card';

/** Services required by the card registration. */
const inject = ['slots', 'locale'];

/**
 * Field descriptors: which knob the card renders and how to validate it.
 *
 * `min` mirrors the Host `Config` schema (session-cleanup.mjs) field by field:
 * `intervalMinutes` is the only number there with a lower bound
 * (`z.number().min(1)` — 0 would spin setInterval at ~1ms); the other three are
 * plain `z.number()`. The card is therefore never looser than the Host, so a
 * value it accepts can no longer come back as a generic "保存失败" after the
 * fact: 0 is the documented "off" sentinel for maxAgeDays/maxTotalMB and a
 * negative count is meaningless, so those three keep the `min: 0` floor the
 * Host itself does not enforce.
 *
 * `invalid` names the dictionary key shown under that field when its bound is
 * violated; a missing/unparsable number always reports `invalidNumber`.
 */
const FIELDS = [
  { key: 'enabled', type: 'boolean' },
  { key: 'maxAgeDays', type: 'number', min: 0, invalid: 'invalidNonNegative' },
  { key: 'maxTotalMB', type: 'number', min: 0, invalid: 'invalidNonNegative' },
  { key: 'keepSessions', type: 'number', min: 0, invalid: 'invalidNonNegative' },
  { key: 'intervalMinutes', type: 'number', min: 1, invalid: 'invalidInterval' },
  { key: 'dryRun', type: 'boolean' },
  { key: 'sessionsRoot', type: 'text' },
];

/**
 * Validate one staged field against its Host-schema constraint.
 * @returns the dictionary key of the message to show, or null when valid.
 */
function fieldErrorKey(field, text) {
  if (field === undefined || field.type !== 'number') return null
  const parsed = Number(text)
  if (text.trim() === '' || !Number.isFinite(parsed)) return 'invalidNumber'
  if (field.min !== undefined && parsed < field.min) return field.invalid
  return null
}

/** One labelled field row with staged text and its own validation message. */
function Field({ field, label, hint, text, error, disabled, onChange }) {
  return jsxs('div', { className: 'sc-field', children: [
    jsxs('div', { className: 'sc-field-head', children: [
      jsx('label', { className: 'sc-label', htmlFor: 'sc-' + field.key, children: label }, 'label'),
    ] }, 'head'),
    field.type === 'boolean'
      ? jsx('input', {
          id: 'sc-' + field.key,
          type: 'checkbox',
          className: 'sc-toggle',
          checked: text === 'true',
          disabled,
          onChange: (event) => { onChange(event.currentTarget.checked ? 'true' : 'false') },
        }, 'control')
      : jsx('input', {
          id: 'sc-' + field.key,
          type: field.type === 'number' ? 'number' : 'text',
          className: 'sc-input' + (error ? ' sc-invalid' : ''),
          value: text,
          disabled,
          onChange: (event) => { onChange(event.currentTarget.value) },
        }, 'control'),
    error ? jsx('p', { className: 'sc-invalid-text', children: error }, 'invalid') : null,
    jsx('p', { className: 'sc-hint', children: hint }, 'hint'),
  ] });
}

/** The configuration card shown in 设置 → 插件 → 插件配置 (settings.plugin.item). */
function SessionCleanupCard({ t, getConfig, setConfig, resetConfig }) {
  const [config, setConfigState] = useState({ status: 'loading' });
  const [open, setOpen] = useState(false);
  const [staged, setStaged] = useState(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => getConfig()).then(
      (value) => { if (current) setConfigState({ status: 'ready', value }) },
      () => { if (current) setConfigState({ status: 'error' }) },
    )
    return () => { current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (config.status !== 'ready') return null;
  const value = config.value ?? {};
  const dirty = staged !== null && Object.keys(staged).length > 0;
  // Each staged field is checked against its Host-schema bound before save, so
  // an out-of-range value (e.g. intervalMinutes 0) is reported under that very
  // field instead of surfacing afterwards as a generic "保存失败".
  const errorKeyOf = (field) => {
    if (staged === null || !(field.key in staged)) return null
    return fieldErrorKey(field, staged[field.key])
  };
  const invalid = FIELDS.some((field) => errorKeyOf(field) !== null);
  const blocked = !dirty || invalid || saving;

  const textOf = (key) => {
    const field = FIELDS.find((candidate) => candidate.key === key)
    if (staged !== null && key in staged) return staged[key]
    const current = value[key]
    if (field?.type === 'boolean') return current === true ? 'true' : 'false'
    if (current === undefined || current === null) return ''
    return String(current)
  };
  const edit = (key, text) => {
    setFailed(false)
    setStaged((current) => ({ ...(current ?? {}), [key]: text }))
  };
  const discard = () => { setStaged(null); setFailed(false) };
  const save = async () => {
    if (staged === null) return
    // Belt and braces: the messages are already on screen, so never send a
    // value the Host schema would reject.
    if (invalid) return
    setSaving(true); setFailed(false)
    try {
      const parsed = {}
      for (const [key, text] of Object.entries(staged)) {
        const field = FIELDS.find((candidate) => candidate.key === key)
        parsed[key] = field?.type === 'number' ? Number(text) : field?.type === 'boolean' ? text === 'true' : text
      }
      const next = await setConfig(parsed)
      setConfigState({ status: 'ready', value: next })
      setStaged(null)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  };
  const resetAll = async () => {
    setSaving(true); setFailed(false)
    try {
      const next = await resetConfig()
      setConfigState({ status: 'ready', value: next })
      setStaged(null)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  };

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
        jsx(IconChevronDownOutline14, { className: 'sc-chevron' + (open ? ' sc-chevron-open' : ''), 'aria-hidden': true }, 'chevron'),
      ],
    }, 'header'),
    open ? jsxs('div', { className: 'sc-body', children: [
      FIELDS.map((field) => {
        const errorKey = errorKeyOf(field)
        return jsx(Field, {
          field,
          label: t(field.key),
          hint: t(field.key + 'Hint'),
          text: textOf(field.key),
          error: errorKey === null ? null : t(errorKey),
          disabled: saving,
          onChange: (text) => { edit(field.key, text) },
        }, field.key)
      }),
      jsxs('div', { className: 'sc-footer', children: [
        failed ? jsx('p', { className: 'sc-failed', role: 'status', children: t('saveFailed') }, 'failed') : null,
        jsx('button', { type: 'button', className: 'sc-discard', disabled: !dirty || saving, onClick: discard, children: t('discard') }, 'discard'),
        jsx('button', { type: 'button', className: 'sc-discard', disabled: saving, onClick: () => { void resetAll() }, children: t('resetAll') }, 'reset-all'),
        jsx('button', { type: 'button', className: 'sc-save', disabled: blocked, onClick: () => { void save() }, children: saving ? t('saving') : t('save') }, 'save'),
      ] }, 'footer'),
    ] }, 'body') : null,
  ] });
}

/**
 * One call to the host half over its `/session-cleanup` prefix route.
 *
 * This used to go through the Connection RPC registry (`rpc.call` on the
 * `connection` service), which cannot work in dsh 0.1.5-rc.1: that registry
 * throws `cannot get property "webServer" without inject` for every plugin
 * outside the connection package, so the channel never exists and the request
 * would land on the SPA fallback. The host half registers the prefix route
 * itself (see `createRpcRoute` there) and answers the same `{ ok, value }` /
 * `{ ok, error }` envelope.
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

/** Contribute the cleanup configuration card into 插件配置 + 插件管理. */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-cleanup: card dictionaries')

  const getConfig = () => call('getConfig', {})
  const setConfig = (fields) => call('setConfig', { fields })
  const resetConfig = () => call('resetConfig', {})
  const cardApi = () => ({ getConfig, setConfig, resetConfig })

  // The shipped 插件配置 page (settings.plugin.item). Config cards live only
  // here; the plugin-manager page is enable/disable management only.
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'session-cleanup',
    locale: NS,
    inject: cardApi,
  }, SessionCleanupCard))
}

module.exports = { apply, inject, NS };
return module.exports;
} });
