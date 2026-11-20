/**
 * Browser half of the temp-session patch: on load the host half eagerly
 * registers the user-level temp directory (default `~/.dsh/tmp-workspaces/`)
 * as a real Workspace titled "临时会话". It then appears as a workspace group
 * in the sidebar browser — users can click its "+" or "新会话" row just like
 * any project.
 *
 * The shortcut now lives directly under the New Session button: the
 * `sidebar.session.action` HOC wraps that row's content, and this module
 * returns the shipped button followed by a "临时会话" row (in the rail it
 * stacks a 36px icon below the New Session icon). The sidebar footer is left
 * to discussion-plaza.
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
const { IconSparkleRegular } = require('@deepseek-ai/dsh-client-ui-primitives');

const PLUGIN_ID = '@local/dsh-client-ui-temp-session';
const NS = 'sidebar.tempSession';

/* Injected once per page; the module loader tracks `style[data-plugin]` tags
   and removes them when the bundle unloads, and the `data-plugin-css` key
   keeps a re-injection (hot reload) from stacking a second copy. */
const CSS = [
  /* Wide: the HOC wrapper becomes the New Session row's single flex child, so
     it owns the width and stacks the shipped button above our 34px row. */
  '.ts-stack{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px}',
  '.ts-rail-layer{display:flex;flex-direction:column;align-items:flex-start;gap:4px}',
  /* Wrap: claim the row width inside the stack (the old footer was a flex row). */
  '.ts-wrap{flex:none;min-width:0;display:flex;flex-direction:column}',
  /* Wide row: compact 34px rhythm, transparent so it reads as a secondary action. */
  '.ts-btn{flex:none;display:flex;align-items:center;gap:8px;width:100%;height:34px;margin:0;padding:6px 10px;box-sizing:border-box;border:none;border-radius:12px;background:transparent;cursor:pointer;overflow:hidden;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px}',
  '.ts-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.ts-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
  '.ts-btn[disabled]{opacity:.6;cursor:default}',
  /* Rail: the same 36x36 circle box as the other rail controls. */
  '.ts-btn.ts-rail{width:36px;height:36px;margin:8px 0 10px;justify-content:center;gap:0;padding:0;border-radius:50%}',
  '.ts-wrap.ts-rail-wrap{flex:none;align-items:center}',
  '.ts-label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
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
 * One row under the New Session button: wide shows icon + label, rail only the
 * icon. Clicking calls the host `/temp-session` ensure endpoint, then starts a
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
        jsx(IconSparkleRegular, { size: wide ? 16 : 18 }, 'icon'),
        wide ? jsx('span', { className: 'ts-label', children: busy ? t('busy') : t('label') }, 'label') : null,
      ],
    }, 'temp-session-action'),
  ] });
}

/**
 * `sidebar.session.action` HOC: keep the shipped New Session button and append
 * the temp-session row directly below it. Wide uses a column stack; the rail
 * stacks the icon under the New Session icon (the row is already a column).
 */
function TempSessionLayer({ wide, children, startTempSession, t }) {
  const action = jsx(TempSessionAction, { wide: wide === true, startTempSession, t }, 'temp-session-action')
  const row = React.isValidElement(children) ? React.cloneElement(children, { key: 'new-session' }) : children
  return jsxs('div', {
    className: wide === true ? 'ts-stack' : 'ts-rail-layer',
    children: [row, action],
  })
}

/** Contribute the temp-session row under the New Session button. */
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

  ctx.slots.inject('sidebar.session.action', () => ctx.slots.register({
    name: 'sidebar.session.action',
    id: 'temp-session',
    order: -10,
    locale: NS,
    inject: () => ({ startTempSession }),
  }, TempSessionLayer))
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
