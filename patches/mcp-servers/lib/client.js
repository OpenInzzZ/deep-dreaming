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
 * needs no yml edit and no restart — this page writes the whole `servers` array
 * through the shared settings form, and the host half reconciles its mounted
 * children when the Loader reports the volatile update (a volatile-only config
 * diff deliberately does NOT re-run `apply()`).
 *
 * Hand-written to the client-bundle contract (no build step): the shell loads
 * this file through `window.__ModuleLoader__.load` and answers every
 * `require()` from the frozen module table, so only seed words appear here and
 * there is no JSX — `jsx()` / `jsxs()` only.
 *
 * Request headers are edited as key/value rows, not as a JSON blob. The stored
 * shape is still the plain `{ name: value }` map the Host's schema expects, so
 * neither the config nor the mounted clients change — only this editor does.
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
  headers: '请求头',
  headersHint: '留空表示不带额外头。需要鉴权的服务在这里加一行：名称填 Authorization，值填 Bearer <token>。',
  headersEmpty: '还没有请求头。',
  headerAdd: '添加请求头',
  headerName: '请求头名称',
  headerValue: '请求头值',
  headerNamePlaceholder: 'Authorization',
  headerValuePlaceholder: 'Bearer <token>',
  headerRemove: '删除这一行请求头',
  timeout: '单次调用超时（毫秒）',
  timeoutHint: '留空按 90000 处理；IDEA 冷分析一个文件约 3.6 秒。',
  enabled: '启用',
  enabledHint: '关掉后不再连接该服务，其工具随之消失（不需要重启桌面端）。',
  errorName: '名称不合法：只允许字母、数字、下划线、短横线，且不超过 32 个字符。',
  errorDuplicate: '名称已被另一个服务使用。',
  errorUrl: '地址必须以 http:// 或 https:// 开头。',
  errorHeaderName: '请求头名称不能为空，也不能含空格或冒号。',
  errorHeaderValue: '请求头值不能包含换行符。',
  errorHeaderDuplicate: '这一行与上面的请求头重名了（名称不区分大小写）。',
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
  headers: 'Request headers',
  headersHint: 'Blank means no extra headers. For an authenticated server add a row: name Authorization, value Bearer <token>.',
  headersEmpty: 'No request headers yet.',
  headerAdd: 'Add header',
  headerName: 'Header name',
  headerValue: 'Header value',
  headerNamePlaceholder: 'Authorization',
  headerValuePlaceholder: 'Bearer <token>',
  headerRemove: 'Remove this header row',
  timeout: 'Per-call timeout (ms)',
  timeoutHint: 'Blank means 90000; a cold IDEA analysis of one file takes about 3.6s.',
  enabled: 'Enabled',
  enabledHint: 'Turning this off disconnects the server and drops its tools, without restarting the app.',
  errorName: 'Invalid name: letters, digits, underscore and dash only, at most 32 characters.',
  errorDuplicate: 'Another server already uses this name.',
  errorUrl: 'The endpoint must start with http:// or https://.',
  errorHeaderName: 'A header name is required, and cannot contain spaces or colons.',
  errorHeaderValue: 'A header value cannot contain line breaks.',
  errorHeaderDuplicate: 'This name is already used by a row above (header names are case-insensitive).',
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

/** A user-filled header name must be an RFC 7230 token — the only shape `fetch` accepts. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** One blank row of the key/value header editor. */
function blankHeaderRow() {
  return { name: '', value: '' };
}

/** An empty draft for the add form. `headers` is the row list the editor renders. */
function emptyDraft() {
  return { serverName: '', url: '', headers: [blankHeaderRow()], toolCallTimeoutMs: '', failOnStartupError: false, enabled: true };
}

/** Pre-fill the edit form from a stored server (blank timeout means "use the default"). */
function draftOf(server) {
  return {
    serverName: server?.serverName ?? '',
    url: server?.url ?? '',
    headers: headerRowsOf(server?.headers),
    toolCallTimeoutMs: server?.toolCallTimeoutMs === undefined ? '' : String(server.toolCallTimeoutMs),
    failOnStartupError: server?.failOnStartupError === true,
    enabled: server?.enabled !== false,
  };
}

/**
 * Stored header map -> editor rows.
 *
 * The editor always opens with one usable row, so a server that has no headers
 * yet shows a row to type into rather than an empty box plus a button.
 */
function headerRowsOf(headers) {
  const map = headers !== null && typeof headers === 'object' && !Array.isArray(headers) ? headers : {};
  const rows = Object.entries(map).map(([name, value]) => ({ name: String(name), value: String(value ?? '') }));
  return rows.length > 0 ? rows : [blankHeaderRow()];
}

/** A row the user has not filled in: both cells blank, therefore ignored on save. */
function isBlankHeaderRow(row) {
  return String(row?.name ?? '').trim() === '' && String(row?.value ?? '').trim() === '';
}

/**
 * Validate one header row on its own.
 *
 * A blank row is "not used yet", not an error; a named row with an empty value
 * is allowed (that is still a legal HTTP header, and refusing it would surprise
 * someone mid-edit).
 *
 * @returns the dictionary key of the violation, or null.
 */
function validateHeaderRow(row) {
  const name = String(row?.name ?? '').trim();
  const value = String(row?.value ?? '').trim();
  if (name === '' && value === '') return null;
  if (!HEADER_NAME_PATTERN.test(name)) return 'errorHeaderName';
  if (/[\r\n]/.test(value)) return 'errorHeaderValue';
  return null;
}

/**
 * Validate the whole row list.
 *
 * Names compare case-insensitively: HTTP header names are, and two rows that
 * differ only in case would otherwise be stored as two map keys and sent twice.
 *
 * @returns `{ key, at }` for the first offending row (`at` is the row index, used
 *   to paint that row) or null when every row is acceptable.
 */
function validateHeaders(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  for (let at = 0; at < list.length; at += 1) {
    if (isBlankHeaderRow(list[at])) continue;
    const key = validateHeaderRow(list[at]);
    if (key !== null) return { key, at };
    const name = String(list[at]?.name ?? '').trim().toLowerCase();
    if (seen.has(name)) return { key: 'errorHeaderDuplicate', at };
    seen.add(name);
  }
  return null;
}

/**
 * Editor rows -> the stored header map.
 *
 * @returns the map, or `undefined` when every row is blank — the key is then
 *   omitted on save so the Host's `{}` default wins. Writing `{}` instead would
 *   be a needless config diff (it changes the server signature and reconnects).
 */
function headersOf(rows) {
  const entries = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (isBlankHeaderRow(row)) continue;
    entries.push([String(row?.name ?? '').trim(), String(row?.value ?? '').trim()]);
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
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
  const headers = validateHeaders(draft.headers);
  if (headers !== null) return headers.key;
  const text = String(draft.toolCallTimeoutMs ?? '').trim();
  if (text !== '' && (!Number.isFinite(Number(text)) || Number(text) < 1000)) return 'errorTimeout';
  return null;
}

/** Turn a draft into a stored server entry (blank timeout is omitted so the Host default applies). */
function serverOf(draft) {
  const text = String(draft.toolCallTimeoutMs ?? '').trim();
  const headers = headersOf(draft.headers);
  return {
    serverName: draft.serverName.trim(),
    url: draft.url.trim(),
    failOnStartupError: draft.failOnStartupError === true,
    enabled: draft.enabled !== false,
    ...(headers === undefined ? {} : { headers }),
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
  '.ms-control-wide{max-width:none}',
  '.ms-headers{display:flex;flex-direction:column;gap:8px}',
  '.ms-header-row{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr) auto;gap:8px;align-items:center}',
  '.ms-header-row-bad .ms-input{border-color:var(--dsw-alias-state-error-primary)}',
  '.ms-header-add{align-self:flex-start}',
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

/**
 * The same layout for a field whose control is a *group* of inputs.
 *
 * The header editor holds several inputs plus buttons, so it cannot live inside
 * the native `<label>` that `Field` renders: a label is meant to wrap a single
 * control, and a button inside one would also forward its click to the first
 * input.
 */
function FieldGroup({ label, hint, error, children }) {
  return jsxs('div', { className: 'ms-field', children: [
    jsx('span', { className: 'ms-label', children: label }, 'label'),
    jsx('div', { className: 'ms-control ms-control-wide', children: children }, 'control'),
    error ? jsx('span', { className: 'ms-error', role: 'alert', children: error }, 'error')
      : (hint ? jsx('span', { className: 'ms-hint', children: hint }, 'hint') : null),
  ] });
}

/** Copy keys that belong to the header editor (they paint the header field, not another one). */
const HEADER_ERROR_KEYS = ['errorHeaderName', 'errorHeaderValue', 'errorHeaderDuplicate'];

/**
 * The key/value editor for the request-header map.
 *
 * Rows are plain `{ name, value }` objects and are addressed by index: the list
 * only ever grows at the end or loses a row, and every cell is controlled, so an
 * index key cannot desynchronise the DOM from the draft. `onChange` receives the
 * next rows array; the parent folds it back into the draft.
 */
function HeaderRows({ t, rows, error, saving, onChange }) {
  const list = Array.isArray(rows) ? rows : [];
  const replace = (at, patch) => onChange(list.map((row, index) => (index === at ? { ...row, ...patch } : row)));
  return jsxs('div', { className: 'ms-headers', children: [
    list.length === 0 ? jsx('span', { className: 'ms-hint', children: t('headersEmpty') }, 'empty') : null,
    ...list.map((row, at) => jsxs('div', {
      className: 'ms-header-row' + (error !== null && error.at === at ? ' ms-header-row-bad' : ''),
      children: [
        jsx(Input, {
          className: 'ms-input',
          value: row.name,
          placeholder: t('headerNamePlaceholder'),
          'aria-label': t('headerName'),
          autoComplete: 'off',
          spellCheck: false,
          disabled: saving,
          onChange: (event) => replace(at, { name: event.target.value }),
        }, 'name'),
        jsx(Input, {
          className: 'ms-input',
          value: row.value,
          placeholder: t('headerValuePlaceholder'),
          'aria-label': t('headerValue'),
          autoComplete: 'off',
          spellCheck: false,
          disabled: saving,
          onChange: (event) => replace(at, { value: event.target.value }),
        }, 'value'),
        jsx('button', {
          type: 'button',
          className: 'ms-link',
          'aria-label': t('headerRemove'),
          disabled: saving,
          onClick: () => onChange(list.filter((_row, index) => index !== at)),
          children: t('remove'),
        }, 'remove'),
      ],
    }, String(at))),
    jsx('button', {
      type: 'button',
      className: 'ms-link ms-header-add',
      disabled: saving,
      onClick: () => onChange([...list, blankHeaderRow()]),
      children: t('headerAdd'),
    }, 'add'),
  ] });
}

/** The add / edit form. `onSubmit` receives the validated draft. */
function ServerForm({ t, draft, onChange, onSubmit, onCancel, saving }) {
  const errorOf = (key) => (draft.touched && draft.errorKey === key ? t(draft.errorKey) : null);
  // Re-derive the offending row while the draft is invalid, so the hint text and
  // the red cell follow edits instead of freezing on the first failed submit.
  const headerError = draft.touched && HEADER_ERROR_KEYS.includes(draft.errorKey) ? validateHeaders(draft.headers) : null;
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
    jsx(FieldGroup, {
      label: t('headers'),
      hint: t('headersHint'),
      error: headerError === null ? null : t(headerError.key),
      children: jsx(HeaderRows, {
        t,
        rows: draft.headers,
        error: headerError,
        saving,
        onChange: (headers) => onChange({ ...draft, headers, touched: true }),
      }),
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
      // Not disabled on an invalid draft: the error keys stay in the draft while
      // the user fixes the field, and a disabled button would then never let the
      // corrected value through. A click revalidates and either saves or repaints
      // the same message.
      jsx('button', { type: 'button', className: 'ms-button', disabled: saving, onClick: () => onSubmit(draft), children: saving ? t('saving') : t('save') }, 'save'),
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

module.exports = { apply, inject, NS, ENTRY_ID, serversOf, emptyDraft, draftOf, blankHeaderRow, headerRowsOf, isBlankHeaderRow, validateHeaderRow, validateHeaders, headersOf, validateDraft, serverOf, replaceAt, removeAt, ServerForm };
return module.exports;
}});
