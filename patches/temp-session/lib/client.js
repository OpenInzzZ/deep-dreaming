/**
 * Browser half of the temp-session patch: on load the host half eagerly
 * registers the user-level temp directory (default `~/.dsh/tmp-workspaces/`)
 * as a real Workspace titled "临时会话". It then appears as a workspace group
 * in the sidebar browser — users can click its "+" or "新会话" row just like
 * any project. The sidebar-footer action is a one-click shortcut that jumps
 * directly to a new session inside that workspace.
 *
 * Hand-written in the client-bundle contract (no build step): the shell's
 * module loader receives this file through `window.__ModuleLoader__.load` and
 * answers every `require()` from the frozen module table. Only platform seed
 * words are used: `react`, `react/jsx-runtime`, and the icon set from
 * `@deepseek-ai/dsh-client-ui-primitives`. Everything else (slots, locale,
 * uiWorkspace) arrives as services on the `apply(ctx)` context.
 *
 * dsh only lets you start a session inside a Workspace (the hero input is
 * inert otherwise). For quick non-project chats the host half idempotently
 * ensures the temp workspace exists; the sidebar shortcut starts a new session
 * bound to it. The session appears under the temp workspace group in the
 * sidebar, and agent file operations land in the user-level directory instead
 * of any project.
 */
window.__ModuleLoader__.load({ id: '@local/dsh-client-ui-temp-session', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useState } = React;
const { jsx, jsxs } = require('react/jsx-runtime');
const { IconSparkle16 } = require('@deepseek-ai/dsh-client-ui-primitives');

const PLUGIN_ID = '@local/dsh-client-ui-temp-session';
const NS = 'sidebar.tempSession';

/* Injected once per page; the module loader tracks `style[data-plugin]` tags
   and removes them when the bundle unloads, and the `data-plugin-css` key
   keeps a re-injection (hot reload) from stacking a second copy. */
const CSS = [
  /* Wrap: the footerActions seat is a flex row, so the wrapper must claim the
     full width — otherwise the button's calc(100% + 8px) collapses to the
     content width and the hover chrome only covers the label (unlike the
     settings trigger, which sits in a block container). */
  '.ts-wrap{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}',
  /* Wide footer row: compact 34px rhythm like the settings trigger. */
  '.ts-btn{flex:none;display:flex;align-items:center;gap:8px;width:calc(100% + 8px);height:34px;margin:4px -4px 4px;padding:6px 2px 6px 10px;box-sizing:border-box;border:none;border-radius:12px;background:transparent;cursor:pointer;overflow:hidden;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px}',
  '.ts-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.ts-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
  '.ts-btn[disabled]{opacity:.6;cursor:default}',
  /* Rail: the same 36x36 circle box as the other rail controls. */
  '.ts-btn.ts-rail{width:36px;height:36px;margin:8px 0 10px;justify-content:center;gap:0;padding:0;border-radius:50%}',
  '.ts-wrap.ts-rail-wrap{flex:none;align-items:center}',
  '.ts-label{overflow:hidden;white-space:nowrap}',
  '.ts-error{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary);margin:0 0 2px 10px}',
].join('');

const zh = {
  label: '临时会话',
  title: '快速发起临时会话(用户级临时目录,不关联项目) — 也可在侧边栏"临时会话"工作组中点击 + 创建',
  busy: '正在创建…',
  error: '发起失败,请重试',
};

/** English dictionary checked against the Chinese key set. */
const en = {
  label: 'Temporary',
  title: 'Quick-start a temporary session (user-level dir, no project) — also available as a workspace group in the sidebar',
  busy: 'Creating…',
  error: 'Failed, retry',
};

/** Services required by the registrations. */
const inject = ['slots', 'locale', 'uiWorkspace'];

/**
 * One call to the host half over its `/temp-session` prefix route.
 *
 * This used to be `ctx.connection.rpc.call('/temp-session', …)`, which cannot
 * work in dsh 0.1.5-rc.1: the Connection registry throws `cannot get property
 * "webServer" without inject` for every plugin outside the connection package,
 * so the channel never exists and the request would land on the SPA fallback.
 * The host half registers that route itself (see `createRpcRoute` there) and
 * answers the same `{ ok, value }` / `{ ok, error }` envelope.
 *
 * Same-origin by construction, JSON in and out — the host's fence requires it.
 */
const call = async (endpoint, args) => {
  let response;
  try {
    response = await fetch('/temp-session/' + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: args ?? {} }),
    });
  } catch (error) {
    throw new Error('rpc ' + endpoint + ' failed: ' + String(error?.message ?? error));
  }
  if (!response.ok) throw new Error('rpc ' + endpoint + ' failed: HTTP ' + String(response.status));
  const envelope = await response.json();
  if (envelope === null || typeof envelope !== 'object' || envelope.ok !== true) {
    const error = new Error(
      'rpc ' + endpoint + ' failed: ' +
      String(envelope?.error?.code ?? 'malformed') + ': ' + String(envelope?.error?.message ?? 'malformed envelope'),
    );
    error.code = envelope?.error?.code;
    error.details = envelope?.error?.details;
    throw error;
  }
  return envelope.value;
}

/**
 * Sidebar-footer action row: wide shows icon + label, rail only the icon.
 * Clicking calls the host `/temp-session` ensure endpoint, then starts a
 * session bound to the temp workspace.
 */
function TempSessionAction({ wide, startTempSession, t }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const run = () => {
    if (busy) return
    setBusy(true); setFailed(false)
    void Promise.resolve().then(() => startTempSession()).then(
      () => { setBusy(false) },
      () => { setBusy(false); setFailed(true) },
    )
  };

  return jsxs('div', { className: 'ts-wrap' + (wide ? '' : ' ts-rail-wrap'), children: [
    failed ? jsx('p', { className: 'ts-error', role: 'alert', children: t('error') }, 'error') : null,
    jsx('button', {
      type: 'button',
      className: 'ts-btn' + (wide ? '' : ' ts-rail'),
      'aria-label': t('title'),
      title: t('title'),
      disabled: busy ? true : undefined,
      onClick: run,
      children: [
        jsx(IconSparkle16, { key: 'icon', size: wide ? 16 : 18 }),
        wide ? jsx('span', { key: 'label', className: 'ts-label', children: busy ? t('busy') : t('label') }, 'label') : null,
      ],
    }, 'temp-session-action'),
  ] });
}

/** Contribute the sidebar-footer temp-session action. */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'temp-session: dictionaries')

  const startTempSession = async () => {
    let value;
    try {
      value = await call('ensure', {});
    } catch (error) {
      // Keep this patch's own failure wording while preserving the transport's
      // machine-readable fields for callers that branch on them.
      const wrapped = new Error('ensure failed: ' + String(error?.message ?? error));
      wrapped.code = error?.code;
      wrapped.details = error?.details;
      throw wrapped;
    }
    // The follow stream auto-delivers the new workspace to the client baseline;
    // no manual refresh needed. Just start the session via uiWorkspace.
    ctx.uiWorkspace.startSession(value.workspaceId);
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'temp-session',
    order: -10,
    locale: NS,
    inject: () => ({ startTempSession }),
  }, TempSessionAction))
}

(function () {
  if (typeof document === 'undefined') return
  const tagId = PLUGIN_ID + '/temp-session.css'
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
})();

module.exports = { apply, inject, NS };
return module.exports;
}});
