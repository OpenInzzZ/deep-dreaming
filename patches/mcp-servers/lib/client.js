/**
 * mcp-servers — browser half: the 「MCP 服务」 settings page.
 *
 * Why this page exists at all: dsh 0.2.0-rc.2 ships **no** generic editor for a
 * plugin's own Config. The plugin page can host one per row through the keyed
 * `plugins.row.config` slot, but that slot has a declaring party and a consumer
 * only — no contributor anywhere in the shipped runtime (checked against the
 * checkout and against `resources/app.asar`), so a row's detail page renders no
 * form. The Host still serves the namespace (`settings.describe` / `mutate`),
 * so the missing piece is purely UI: this file is that UI, registered on the
 * shipped `settings.section` seat exactly like the official account section.
 *
 * Data rides the shipped settings transport, never a private channel: the page
 * takes the `mcp-servers` namespace's shared form from `ctx.configForms` and
 * writes the whole `servers` array through its path operator
 * (`mutate([{ op: 'set', path: ['servers'], value }], revision)`), while reads
 * ride the same form's snapshot. The Host stays the single fact source and
 * concurrent edits fence on the revision.
 *
 * The list lives in *config*, not in loader rows: adding a server therefore
 * needs no yml edit and no restart — a config-only diff re-runs `apply()` on
 * the fiber, which mounts one child of the official MCP client per entry.
 *
 * Hand-written to the client-bundle contract (no build step): the shell loads
 * this file through `window.__ModuleLoader__.load` and answers every
 * `require()` from the frozen module table, so only seed words appear here and
 * there is no JSX — `jsx()` / `jsxs()` only.
 */
window.__ModuleLoader__.load({ id: '@local/dsh-client-mcp-servers', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useState, useSyncExternalStore } = React;
const { jsx, jsxs } = require('react/jsx-runtime');
const { Switch, Input } = require('@deepseek-ai/dsh-client-ui-primitives');

const PLUGIN_ID = '@local/dsh-client-mcp-servers';

/** Locale namespace of this page's copy. */
const NS = 'mcpServers';

/** Settings namespace of the umbrella entry — a section's namespace IS its loader entry id. */
const ENTRY_ID = 'mcp-servers';

/** `serverName` becomes the tool prefix `mcp__<serverName>__<tool>`; the official client reserves it globally. */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const zh = {
  nav: 'MCP 服务',
  title: '外部 MCP 服务',
  description: '这里列出的每个服务都会挂进 dsh，模型即可像调用原生工具一样使用它们的工具（工具名前缀 mcp__<名称>__）。',
  empty: '还没有服务。点「添加服务」填一个名称与地址。',
  add: '添加服务',
  edit: '编辑',
  remove: '删除',
  save: '保存',
  cancel: '取消',
  saving: '保存中…',
  saveFailed: '保存失败：配置可能被其它窗口改动过，请重试。',
  loading: '读取配置…',
  name: '服务名称',
  nameHint: '字母、数字、下划线或短横线，最长 32 个字符，且不能与其它服务重名。',
  url: '服务地址',
  urlHint: 'Streamable HTTP 端点，例如 http://127.0.0.1:64342/stream',
  headers: '请求头（JSON）',
  headersHint: '留空表示不带额外头。需要鉴权的服务写在这里，例如 {"Authorization": "Bearer <token>"}。',
  timeout: '单次调用超时（毫秒）',
  timeoutHint: '留空按 90000 处理；IDEA 冷分析一个文件约 3.6 秒。',
  enabled: '启用',
  enabledHint: '关掉后不再连接该服务，其工具随之消失（不需要重启桌面端）。',
  errorName: '名称不合法：只允许字母、数字、下划线、短横线，且不超过 32 个字符。',
  errorDuplicate: '名称已被另一个服务使用。',
  errorUrl: '地址必须以 http:// 或 https:// 开头。',
  errorHeaders: '请求头必须是 JSON 对象，且每个值都是字符串，例如 {"Authorization": "Bearer ..."}。',
  errorTimeout: '超时至少 1000 毫秒。',
  stateOn: '运行中',
  stateOff: '已停用',
  ariaEnabled: '启用 {server}',
};

const en = {
  nav: 'MCP Servers',
  title: 'External MCP servers',
  description: 'Every server listed here is mounted into dsh; its tools become available to the model as mcp__<name>__…',
  empty: 'No servers yet. Choose Add server and fill a name and an endpoint.',
  add: 'Add server',
  edit: 'Edit',
  remove: 'Remove',
  save: 'Save',
  cancel: 'Cancel',
  saving: 'Saving…',
  saveFailed: 'Could not save: the configuration changed elsewhere. Try again.',
  loading: 'Loading configuration…',
  name: 'Server name',
  nameHint: 'Letters, digits, underscore or dash, up to 32 characters, unique across servers.',
  url: 'Endpoint',
  urlHint: 'A Streamable HTTP endpoint, e.g. http://127.0.0.1:64342/stream',
  headers: 'Request headers (JSON)',
  headersHint: 'Blank means no extra headers. An authenticated server\u2019s headers go here, e.g. {"Authorization": "Bearer <token>"}.',
  timeout: 'Per-call timeout (ms)',
  timeoutHint: 'Blank means 90000; a cold IDEA analysis of one file takes about 3.6s.',
  enabled: 'Enabled',
  enabledHint: 'Turning this off disconnects the server and drops its tools, without restarting the app.',
  errorName: 'Invalid name: letters, digits, underscore and dash only, at most 32 characters.',
  errorDuplicate: 'Another server already uses this name.',
  errorUrl: 'The endpoint must start with http:// or https://.',
  errorHeaders: 'Request headers must be a JSON object whose values are all strings, e.g. {"Authorization": "Bearer ..."}.',
  errorTimeout: 'The timeout must be at least 1000 ms.',
  stateOn: 'Running',
  stateOff: 'Disabled',
  ariaEnabled: 'Enable {server}',
};

/** Services required by the registration. */
const inject = ['slots', 'locale', 'configForms'];

/** The servers array of one snapshot; a namespace that never loaded reads as empty. */
function serversOf(value) {
  return Array.isArray(value?.servers) ? value.servers : [];
}

/** An empty draft for the add form. `headers` is the JSON text the user types. */
function emptyDraft() {
  return { serverName: '', url: '', headers: '', toolCallTimeoutMs: '', failOnStartupError: false, enabled: true };
}

/** Pre-fill the edit form from a stored server (blank timeout means "use the default"). */
function draftOf(server) {
  const headers = server?.headers;
  return {
    serverName: server?.serverName ?? '',
    url: server?.url ?? '',
    headers: headers && Object.keys(headers).length > 0 ? JSON.stringify(headers) : '',
    toolCallTimeoutMs: server?.toolCallTimeoutMs === undefined ? '' : String(server.toolCallTimeoutMs),
    failOnStartupError: server?.failOnStartupError === true,
    enabled: server?.enabled !== false,
  };
}

/**
 * Parse the headers textarea.
 *
 * @returns `{ ok: true, value }` with an omitted `value` for blank input (so the
 *   Host default `{}` wins), or `{ ok: false }` when the text is not a JSON
 *   object of strings. Returning a flag — not a thrown error — keeps the caller
 *   in charge of which copy key to show.
 */
function parseHeaders(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return { ok: true };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
  for (const value of Object.values(parsed)) {
    if (typeof value !== 'string') return { ok: false };
  }
  return { ok: true, value: parsed };
}

/**
 * Validate a draft against the other servers.
 *
 * @returns the dictionary key of the first violation, or null when the draft is
 *   acceptable. Returning a key (not a sentence) keeps the copy in the locale
 *   tables and makes the check testable without a DOM.
 */
function validateDraft(draft, servers, index) {
  if (!NAME_PATTERN.test(draft.serverName ?? '')) return 'errorName';
  if (servers.some((row, at) => at !== index && row?.serverName === draft.serverName)) return 'errorDuplicate';
  if (!/^https?:\/\//.test(draft.url ?? '')) return 'errorUrl';
  if (!parseHeaders(draft.headers).ok) return 'errorHeaders';
  const text = String(draft.toolCallTimeoutMs ?? '').trim();
  if (text !== '' && (!Number.isFinite(Number(text)) || Number(text) < 1000)) return 'errorTimeout';
  return null;
}

/** Turn a draft into a stored server entry (blank timeout is omitted so the Host default applies). */
function serverOf(draft) {
  const text = String(draft.toolCallTimeoutMs ?? '').trim();
  const headers = parseHeaders(draft.headers);
  return {
    serverName: draft.serverName.trim(),
    url: draft.url.trim(),
    failOnStartupError: draft.failOnStartupError === true,
    enabled: draft.enabled !== false,
    ...(headers.ok && headers.value !== undefined ? { headers: headers.value } : {}),
    ...(text === '' ? {} : { toolCallTimeoutMs: Number(text) }),
  };
}

/** Replace the server at `index` (appending when it is out of range). */
function replaceAt(servers, index, next) {
  return index >= 0 && index < servers.length
    ? servers.map((row, at) => (at === index ? next : row))
    : [...servers, next];
}

/** Drop the server at `index`. */
function removeAt(servers, index) {
  return servers.filter((row, at) => at !== index);
}

const CSS = [
  '.ms-wrap{display:flex;flex-direction:column;gap:16px;max-width:720px}',
  '.ms-head{display:flex;flex-direction:column;gap:4px}',
  '.ms-title{margin:0;font-size:16px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.ms-desc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
  '.ms-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
  '.ms-row{display:flex;align-items:center;gap:12px;margin:0;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}',
  '.ms-row-main{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
  '.ms-row-name{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.ms-state{font-size:11px;line-height:16px;font-weight:400;padding:0 6px;border-radius:6px;color:var(--dsw-alias-label-caption);background:var(--dsw-alias-bg-layer-3)}',
  '.ms-state-on{color:var(--dsw-alias-state-success-primary)}',
  '.ms-row-url{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.ms-actions{display:flex;align-items:center;gap:4px;flex:none}',
  '.ms-form{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
  '.ms-field{display:flex;flex-direction:column;gap:4px}',
  '.ms-label{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.ms-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}',
  '.ms-error{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary)}',
  '.ms-control{display:block;width:100%;max-width:420px}',
  '.ms-input{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px}',
  '.ms-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
  '.ms-input:disabled{opacity:.6}',
  '.ms-switch-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
  '.ms-foot{display:flex;align-items:center;gap:8px}',
  '.ms-foot-spacer{flex:1}',
  '.ms-button{font-size:12px;line-height:18px;padding:6px 12px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);cursor:pointer}',
  '.ms-button-ghost{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
  '.ms-link{font-size:12px;line-height:18px;padding:4px 8px;border-radius:6px;border:none;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
  '.ms-link:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.ms-button:disabled,.ms-link:disabled{opacity:.5;cursor:default}',
].join('\n');

/** One labelled field: label above the control, hint or error below it. */
function Field({ label, hint, error, children }) {
  return jsxs('label', { className: 'ms-field', children: [
    jsx('span', { className: 'ms-label', children: label }, 'label'),
    jsx('span', { className: 'ms-control', children: children }, 'control'),
    error ? jsx('span', { className: 'ms-error', role: 'alert', children: error }, 'error')
      : (hint ? jsx('span', { className: 'ms-hint', children: hint }, 'hint') : null),
  ] });
}

/** The add / edit form. `onSubmit` receives the validated draft. */
function ServerForm({ t, draft, onChange, onSubmit, onCancel, saving }) {
  const errorOf = (key) => (draft.touched && draft.errorKey === key ? t(draft.errorKey) : null);
  const blocked = saving || (draft.errorKey !== null && draft.errorKey !== undefined);
  return jsxs('div', { className: 'ms-form', children: [
    jsx(Field, {
      label: t('name'),
      hint: t('nameHint'),
      error: errorOf('errorName'),
      children: jsx(Input, { className: 'ms-input', value: draft.serverName, placeholder: 'idea', disabled: saving, onChange: (event) => onChange({ ...draft, serverName: event.target.value, touched: true }) }),
    }, 'name'),
    jsx(Field, {
      label: t('url'),
      hint: t('urlHint'),
      error: errorOf('errorUrl'),
      children: jsx(Input, { className: 'ms-input', value: draft.url, placeholder: 'http://127.0.0.1:64342/stream', disabled: saving, onChange: (event) => onChange({ ...draft, url: event.target.value, touched: true }) }),
    }, 'url'),
    jsx(Field, {
      label: t('headers'),
      hint: t('headersHint'),
      error: errorOf('errorHeaders'),
      children: jsx(Input, { className: 'ms-input', value: draft.headers, placeholder: '{"Authorization": "Bearer ..."}', disabled: saving, onChange: (event) => onChange({ ...draft, headers: event.target.value, touched: true }) }),
    }, 'headers'),
    jsx(Field, {
      label: t('timeout'),
      hint: t('timeoutHint'),
      error: errorOf('errorTimeout'),
      children: jsx(Input, { className: 'ms-input', value: draft.toolCallTimeoutMs, placeholder: '90000', disabled: saving, onChange: (event) => onChange({ ...draft, toolCallTimeoutMs: event.target.value, touched: true }) }),
    }, 'timeout'),
    jsxs('div', { className: 'ms-switch-row', children: [
      jsx('span', { className: 'ms-label', children: t('enabled') }, 'label'),
      jsx(Switch, { checked: draft.enabled, disabled: saving, label: t('enabled'), onChange: (next) => onChange({ ...draft, enabled: next }) }, 'switch'),
    ] }, 'enabled'),
    jsxs('div', { className: 'ms-foot', children: [
      jsx('span', { className: 'ms-foot-spacer' }, 'spacer'),
      jsx('button', { type: 'button', className: 'ms-link', disabled: saving, onClick: onCancel, children: t('cancel') }, 'cancel'),
      jsx('button', { type: 'button', className: 'ms-button', disabled: blocked, onClick: () => onSubmit(draft), children: saving ? t('saving') : t('save') }, 'save'),
    ] }, 'foot'),
  ] });
}

/** The page body: the server list plus one inline editor. */
function McpServersPage({ t, scope }) {
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  );
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const servers = serversOf(snapshot.value);
  if (snapshot.status === 'loading') return jsx('p', { className: 'ms-desc', children: t('loading') }, 'loading');

  /**
   * Write the whole list back in one operation.
   *
   * The Host fences on the revision the editor read, so a stale page cannot
   * clobber a newer document silently: `mutate` answers false and the form says
   * so instead of pretending it landed.
   */
  const commit = async (next) => {
    setSaving(true);
    setFailed(false);
    setDraft(null);
    try {
      const ok = await scope.mutate([{ op: 'set', path: ['servers'], value: next }], snapshot.revision);
      if (!ok) setFailed(true);
      return ok;
    } finally {
      setSaving(false);
    }
  };

  const submit = (value) => {
    const errorKey = validateDraft(value, servers, draft.index);
    if (errorKey !== null) { setDraft({ ...value, index: draft.index, errorKey, touched: true }); return }
    void commit(replaceAt(servers, draft.index, serverOf(value)));
  };

  return jsxs('section', { className: 'ms-wrap', children: [
    jsxs('div', { className: 'ms-head', children: [
      jsx('h2', { className: 'ms-title', children: t('title') }, 'title'),
      jsx('p', { className: 'ms-desc', children: t('description') }, 'desc'),
    ] }, 'head'),
    failed ? jsx('p', { className: 'ms-error', role: 'status', children: t('saveFailed') }, 'failed') : null,
    servers.length === 0 && draft === null ? jsx('p', { className: 'ms-desc', children: t('empty') }, 'empty') : null,
    jsx('ul', { className: 'ms-list', children: servers.map((server, index) => jsx('li', { className: 'ms-row', children: jsxs('div', { className: 'ms-row-main', children: [
      jsxs('span', { className: 'ms-row-name', children: [
        server.serverName,
        jsx('span', { className: 'ms-state' + (server.enabled === false ? '' : ' ms-state-on'), children: server.enabled === false ? t('stateOff') : t('stateOn') }, 'state'),
      ] }, 'name'),
      jsx('span', { className: 'ms-row-url', children: server.url }, 'url'),
      jsxs('div', { className: 'ms-actions', children: [
        jsx(Switch, {
          checked: server.enabled !== false,
          disabled: saving,
          label: t('ariaEnabled', { server: server.serverName }),
          onChange: (next) => { void commit(replaceAt(servers, index, { ...server, enabled: next })) },
        }, 'switch'),
        jsx('button', { type: 'button', className: 'ms-link', disabled: saving, onClick: () => setDraft({ ...draftOf(server), index }), children: t('edit') }, 'edit'),
        jsx('button', { type: 'button', className: 'ms-link', disabled: saving, onClick: () => { void commit(removeAt(servers, index)) }, children: t('remove') }, 'remove'),
      ] }, 'actions'),
    ] }, 'main') }, server.serverName ?? String(index))) }, 'list'),
    draft === null
      ? jsx('div', { className: 'ms-actions', children: jsx('button', { type: 'button', className: 'ms-button', disabled: saving, onClick: () => setDraft({ ...emptyDraft(), index: -1 }), children: t('add') }, 'add') }, 'add')
      : jsx(ServerForm, { t, draft, saving, onChange: setDraft, onSubmit: submit, onCancel: () => setDraft(null) }, 'form'),
  ] });
}

/** Contribute the page to the Settings navigation. */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-servers: dictionaries');
  const t = ctx.locale.bind(NS);
  const scope = ctx.configForms.get(ENTRY_ID);
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: ENTRY_ID,
    order: 60,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ scope }),
  }, McpServersPage));
}

/* Inject once per page; the module loader tracks style[data-plugin] tags and
   removes them when the bundle unloads, so the data-plugin-css id is the guard
   against a second copy of this sheet (hot reload, double materialization). */
(function () {
  if (typeof document === 'undefined') return;
  const tagId = PLUGIN_ID + '/mcp-servers.css';
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
  const style = document.createElement('style');
  style.dataset.plugin = PLUGIN_ID;
  style.dataset.pluginCss = tagId;
  style.textContent = CSS;
  document.head.appendChild(style);
})();

module.exports = { apply, inject, NS, ENTRY_ID, serversOf, emptyDraft, draftOf, parseHeaders, validateDraft, serverOf, replaceAt, removeAt };
return module.exports;
}});
