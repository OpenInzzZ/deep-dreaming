/**
 * Browser half of the ui-settings-other patch: an "Other" settings section
 * with a restart-service button.
 *
 * Hand-written in the client-bundle contract (no build step): the shell's
 * module loader receives this file through `window.__ModuleLoader__.load` and
 * answers every `require()` from the frozen module table. Only platform seed
 * words are used: `react`, `react/jsx-runtime`, and the icon set from
 * `@deepseek-ai/dsh-client-ui-primitives`. Everything else (slots, locale,
 * connection) arrives as services on the `apply(ctx)` context.
 *
 * The section registers into the `settings.section` slot (same seat as the
 * shipped General / Models / Plugins / Agent presets pages) under id `other`,
 * ordered last. The restart button calls the host half through the dedicated
 * `/app` RPC channel (`ctx.connection.rpc.call('/app', 'restart', …)`); the
 * host respawns the dsh process and exits the current one, so the page will
 * briefly disconnect — the copy tells the user to refresh afterwards.
 */
window.__ModuleLoader__.load({ id: '@local/dsh-client-ui-settings-other', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useEffect, useState } = React;
const { jsx, jsxs } = require('react/jsx-runtime');

const PLUGIN_ID = '@local/dsh-client-ui-settings-other';

/* Injected once per page; the module loader tracks `style[data-plugin]` tags
   and removes them when the bundle unloads. */
const CSS = [
  '.so-section{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary)}',
  '.so-card{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px 16px;background:var(--dsw-alias-bg-layer-3)}',
  '.so-card h3{margin:0;font-size:14px;line-height:20px;font-weight:600}',
  '.so-card p{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
  '.so-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
  '.so-btn{height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}',
  '.so-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.so-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
  '.so-btn[disabled]{opacity:.55;cursor:default}',
  '.so-btn.so-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-error-primary)}',
  '.so-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.so-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
  '.so-status[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}',
].join('\n');
(function () {
  if (typeof document === 'undefined') return
  const tagId = PLUGIN_ID + '/settings-other.css'
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
})();

/** Simplified Chinese dictionary and key source of truth. */
const zh = {
  nav: '其他',
  serviceTitle: '服务',
  serviceDesc: '重启 dsh 服务进程。当前连接会短暂断开,重启完成后刷新页面即可继续使用。',
  restart: '重启服务',
  confirmPrompt: '确定要重启服务吗?当前会话将被中断。',
  confirm: '确认重启',
  cancel: '取消',
  restarting: '正在重启…',
  scheduled: '已请求重启,服务即将断开,请稍后刷新页面。',
  error: '重启请求失败,请重试。',
  retry: '重试',
  busy: '有 {n} 个会话正在运行,重启会中断它们。',
  busyActionWait: '等待空闲后重启',
  busyActionForce: '强制重启',
  waiting: '等待会话结束…(剩余 {n})',
};

/** English dictionary checked against the Chinese key set. */
const en = {
  nav: 'Other',
  serviceTitle: 'Service',
  serviceDesc: 'Restart the dsh service process. The current connection drops briefly; refresh the page after the restart completes.',
  restart: 'Restart service',
  confirmPrompt: 'Restart the service? The current session will be interrupted.',
  confirm: 'Restart',
  cancel: 'Cancel',
  restarting: 'Restarting…',
  scheduled: 'Restart requested. The service is disconnecting; refresh the page shortly.',
  error: 'The restart request failed. Please try again.',
  retry: 'Retry',
  busy: '{n} session(s) are running; restarting will interrupt them.',
  busyActionWait: 'Restart when idle',
  busyActionForce: 'Force restart',
  waiting: 'Waiting for sessions… ({n} remaining)',
};

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.other';

/** Services required by the Settings registration. */
const inject = ['slots', 'locale', 'connection'];

/**
 * Phase state machine:
 *   idle -> confirm -> calling -> scheduled | error
 *   idle -> busy (sessions running) -> waiting (poll until idle) | calling(force)
 */
function OtherSection({ restart, status, t }) {
  const [phase, setPhase] = useState('idle');
  const [busyInfo, setBusyInfo] = useState(null);
  const [waitTimer, setWaitTimer] = useState(null);

  useEffect(() => () => {
    if (waitTimer !== null) clearInterval(waitTimer);
  }, [waitTimer]);

  const trigger = (force) => {
    setPhase('calling')
    void Promise.resolve().then(() => restart(force)).then(
      (result) => {
        if (result.scheduled) setPhase('scheduled')
        else if (result.busy) { setBusyInfo(result.busy); setPhase('busy') }
        else setPhase('error')
      },
      () => { setPhase('error') },
    )
  };

  const startWaiting = () => {
    setPhase('waiting')
    const timer = setInterval(() => {
      void Promise.resolve().then(() => status()).then(
        (value) => {
          if (value.running === 0) {
            clearInterval(timer)
            setWaitTimer(null)
            trigger(false)
          } else {
            setBusyInfo({ running: value.running })
          }
        },
        () => { /* transient poll failure: keep waiting */ },
      )
    }, 2000)
    setWaitTimer(timer)
  };

  const stopWaiting = () => {
    if (waitTimer !== null) clearInterval(waitTimer)
    setWaitTimer(null)
    setPhase('idle')
  };

  const tone = phase === 'error' ? 'error' : phase === 'scheduled' ? 'ok' : undefined;

  return jsx('div', { className: 'so-section', children: [
    jsx('div', { className: 'so-card', children: [
      jsx('h3', { children: t('serviceTitle') }, 'title'),
      jsx('p', { children: t('serviceDesc') }, 'desc'),
      jsx('div', { className: 'so-row', children: [
        phase === 'confirm'
          ? jsxs(React.Fragment, { children: [
              jsx('span', { className: 'so-status', 'data-tone': 'error', children: t('confirmPrompt') }, 'prompt'),
              jsx('button', { type: 'button', className: 'so-btn so-danger', onClick: () => { trigger(false) }, children: t('confirm') }, 'confirm'),
              jsx('button', { type: 'button', className: 'so-btn', onClick: () => { setPhase('idle') }, children: t('cancel') }, 'cancel'),
            ] }, 'confirm-row')
          : jsx('button', {
              type: 'button',
              className: 'so-btn so-danger',
              disabled: phase === 'calling' ? true : undefined,
              onClick: () => { if (phase === 'idle') setPhase('confirm') },
              children: phase === 'calling' ? t('restarting') : t('restart'),
            }, 'restart'),
        phase === 'busy' || phase === 'waiting'
          ? jsxs(React.Fragment, { children: [
              jsx('span', { className: 'so-status', 'data-tone': 'error', children: phase === 'waiting'
                ? t('waiting', { n: busyInfo?.running ?? 0 })
                : t('busy', { n: busyInfo?.running ?? 0 }) }, 'busy-status'),
              phase === 'busy'
                ? jsx('button', { type: 'button', className: 'so-btn', onClick: startWaiting, children: t('busyActionWait') }, 'wait')
                : null,
              phase === 'busy'
                ? jsx('button', { type: 'button', className: 'so-btn so-danger', onClick: () => { trigger(true) }, children: t('busyActionForce') }, 'force')
                : null,
              jsx('button', { type: 'button', className: 'so-btn', onClick: stopWaiting, children: t('cancel') }, 'busy-cancel'),
            ] }, 'busy-row')
          : null,
      ] }, 'row'),
      phase === 'scheduled' || phase === 'error'
        ? jsx('p', { className: 'so-status', 'data-tone': tone, children: phase === 'scheduled' ? t('scheduled') : t('error') }, 'status')
        : null,
      phase === 'error'
        ? jsx('button', { type: 'button', className: 'so-btn', onClick: () => { setPhase('idle') }, children: t('retry') }, 'retry')
        : null,
    ] }, 'card'),
  ] });
}

/** Contribute the Other settings section with the restart-service button. */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-other: dictionaries')

  const t = ctx.locale.bind(NS)
  const restart = async (force) => {
    const result = await ctx.connection.rpc.call('/app', 'restart', { args: force ? { force: true } : {} })
    if (result.ok) return { scheduled: true }
    if (result.error.code === 'sessions-running') {
      return { busy: { running: result.error.details.running } }
    }
    throw new Error('restart failed: ' + result.error.code + ': ' + result.error.message)
  }
  const status = async () => {
    const result = await ctx.connection.rpc.call('/app', 'status', { args: {} })
    if (!result.ok) throw new Error('status failed: ' + result.error.code + ': ' + result.error.message)
    return result.value
  }
  const injected = () => ({ restart, status })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'other',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, OtherSection))
}

module.exports = { apply, inject, NS };
return module.exports;
} });
