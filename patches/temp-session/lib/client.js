/**
 * Browser half of the temp-session patch: a sidebar-footer action that starts
 * an ad-hoc session bound to a user-level temporary workspace.
 *
 * Hand-written in the client-bundle contract (no build step): the shell's
 * module loader receives this file through `window.__ModuleLoader__.load` and
 * answers every `require()` from the frozen module table. Only platform seed
 * words are used: `react`, `react/jsx-runtime`, and the icon set from
 * `@deepseek-ai/dsh-client-ui-primitives`. Everything else (slots, locale,
 * connection, workspaces) arrives as services on the `apply(ctx)` context.
 *
 * dsh only lets you start a session inside a Workspace (the hero input is
 * inert otherwise). For quick non-project chats this action calls the host
 * half's `/temp-session` channel `ensure` endpoint — which idempotently
 * registers the user-level temp directory (default `~/.dsh/tmp-workspaces/`)
 * as a real Workspace titled "临时会话 / Temporary" — then refreshes the
 * workspace list and starts a new session bound to it. The session appears
 * under the temp workspace group in the sidebar, and agent file operations
 * land in the user-level directory instead of any project.
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
   and removes them when the bundle unloads. */
const CSS = [
  /* Wide footer row: compact 34px rhythm like the settings trigger. */
  '.ts-btn{flex:none;display:flex;align-items:center;gap:8px;width:calc(100% + 8px);height:34px;margin:4px -4px 4px;padding:6px 2px 6px 10px;box-sizing:border-box;border:none;border-radius:12px;background:transparent;cursor:pointer;overflow:hidden;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px}',
  '.ts-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.ts-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
  '.ts-btn[disabled]{opacity:.6;cursor:default}',
  /* Rail: the same 36x36 circle box as the other rail controls. */
  '.ts-btn.ts-rail{width:36px;height:36px;margin:8px 0 10px;justify-content:center;gap:0;padding:0;border-radius:50%}',
  '.ts-label{overflow:hidden;white-space:nowrap}',
  '.ts-error{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary);margin:0 0 2px 10px}',
].join('');

const zh = {
  label: '临时会话',
  title: '发起临时会话(绑定用户级临时目录,不关联项目)',
  busy: '正在创建…',
  error: '发起失败,请重试',
};

/** English dictionary checked against the Chinese key set. */
const en = {
  label: 'Temporary',
  title: 'Start a temporary session (user-level dir, no project)',
  busy: 'Creating…',
  error: 'Failed, retry',
};

/** Services required by the registrations. */
const inject = ['slots', 'locale', 'connection', 'workspaces'];

/**
 * Sidebar-footer action row: wide shows icon + label, rail only the icon.
 * Clicking calls the host `/temp-session` ensure endpoint, refreshes the
 * workspace baseline, then starts a session bound to the temp workspace.
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

  return jsxs('div', { className: 'ts-wrap', children: [
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
  const t = ctx.locale.bind(NS)

  const startTempSession = async () => {
    const result = await ctx.connection.rpc.call('/temp-session', 'ensure', { args: {} })
    if (!result.ok) {
      throw new Error('ensure failed: ' + result.error.code + ': ' + result.error.message)
    }
    // The new workspace must be in the client baseline before connectWorkspace
    // can reuse-or-create its blank session; startSession resolves via the
    // list store, so refresh first.
    await ctx.workspaces.refresh()
    ctx.workspaces.startSession(result.value.workspaceId)
  }

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'temp-session',
    order: -10,
    locale: NS,
    inject: () => ({ startTempSession }),
  }, TempSessionAction))
}

if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.dataset.plugin = PLUGIN_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

module.exports = { apply, inject, NS };
return module.exports;
}});
