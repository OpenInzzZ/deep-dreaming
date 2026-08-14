/**
 * Browser half of the ui-settings-other patch: an "Other" settings section
 * with a restart-service button and a live runtime-status block, plus a
 * configuration card inside 设置 → 插件 → 插件配置 for the idle auto-stop.
 *
 * Hand-written in the client-bundle contract (no build step): the shell's
 * module loader receives this file through `window.__ModuleLoader__.load` and
 * answers every `require()` from the frozen module table. Only platform seed
 * words are used: `react`, `react/jsx-runtime`, and the icon set from
 * `@deepseek-ai/dsh-client-ui-primitives`. Everything else (slots, locale,
 * connection, settingsScope) arrives as services on the `apply(ctx)` context.
 *
 * The section registers into the `settings.section` slot (same seat as the
 * shipped General / Models / Plugins / Agent presets pages) under id `other`,
 * ordered last. The restart button calls the host half through the dedicated
 * `/app` RPC channel (`ctx.connection.rpc.call('/app', 'restart', …)`); the
 * host respawns the dsh process and exits the current one, so the page will
 * briefly disconnect — the copy tells the user to refresh afterwards.
 *
 * The status block polls `/app/status` every 10 s and shows the live process
 * snapshot (pid, ports, uptime, memory, versions, running sessions, idle
 * auto-stop countdown) with a manual refresh button.
 *
 * The configuration card binds the Host-registered settings namespace
 * `ui-settings-other` through `ctx.settingsScope` and edits the idle
 * auto-stop toggle + idle-minutes threshold with staged edits (the Host
 * applies changes live and rebuilds its monitor). It renders nothing while
 * the namespace is unavailable, mirroring the shipped cards.
 */
window.__ModuleLoader__.load({ id: '@local/dsh-client-ui-settings-other', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useEffect, useState, useSyncExternalStore } = React;
const { jsx, jsxs } = require('react/jsx-runtime');
const { IconChevronDownOutline14 } = require('@deepseek-ai/dsh-client-ui-primitives');

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
  '.so-btn-sm{height:26px;padding:0 10px;font-size:12px}',
  '.so-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.so-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
  '.so-status[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}',
  '.so-status-block{border-top:1px solid var(--dsw-alias-border-l2);margin-top:2px;padding-top:12px;display:flex;flex-direction:column;gap:8px}',
  '.so-info-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
  '.so-status-title{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}',
  '.so-info{display:flex;flex-direction:column;gap:2px}',
  '.so-info-row{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;line-height:20px}',
  '.so-info-label{color:var(--dsw-alias-label-tertiary);flex:none}',
  '.so-info-value{color:var(--dsw-alias-label-primary);font-family:ui-monospace,Consolas,monospace;text-align:right;word-break:break-all}',
  /* configuration card (设置 → 插件 → 插件配置) */
  '.soc-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}',
  '.soc-card:hover{border-color:var(--dsw-alias-label-dimmed)}',
  '.soc-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
  '.soc-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
  '.soc-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
  '.soc-head-text{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
  '.soc-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
  '.soc-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
  '.soc-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
  '.soc-chevron-open{transform:rotate(180deg)}',
  '.soc-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
  '.soc-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
  '.soc-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
  '.soc-field+.soc-field{border-top:1px solid var(--dsw-alias-border-l2)}',
  '.soc-field-head{align-items:center;gap:8px;display:flex}',
  '.soc-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
  '.soc-overridden{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
  '.soc-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}',
  '.soc-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
  '.soc-reset:disabled{cursor:default}',
  '.soc-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}',
  '.soc-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
  '.soc-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
  '.soc-invalid{border-color:var(--dsw-alias-label-error)}',
  '.soc-invalid-text{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}',
  '.soc-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
  '.soc-toggle{accent-color:var(--dsw-alias-brand-primary);width:16px;height:16px}',
  '.soc-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
  '.soc-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}',
  '.soc-discard,.soc-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
  '.soc-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}',
  '.soc-save{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-brand)}',
  '.soc-save:disabled,.soc-discard:disabled{opacity:.5;cursor:default}',
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

/** Simplified Chinese dictionary and key source of truth (settings section). */
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
  statusTitle: '运行状态',
  refresh: '刷新',
  loading: '获取中…',
  infoError: '运行状态获取失败',
  pid: '进程 ID',
  ports: '监听端口',
  uptime: '运行时长',
  memory: '内存占用',
  node: 'Node 版本',
  dshVersion: 'dsh 版本',
  running: '运行中会话',
  idle: '空闲自动停止',
  idleDisabled: '已禁用',
  idleEnabledWith: '已启用 · 剩余 {n} 分钟自动停止',
  unitDay: '天',
  unitHour: '小时',
  unitMin: '分',
  unitSec: '秒',
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
  statusTitle: 'Runtime',
  refresh: 'Refresh',
  loading: 'Loading…',
  infoError: 'Failed to fetch runtime status',
  pid: 'Process ID',
  ports: 'Listening ports',
  uptime: 'Uptime',
  memory: 'Memory',
  node: 'Node',
  dshVersion: 'dsh version',
  running: 'Running sessions',
  idle: 'Idle auto-stop',
  idleDisabled: 'Disabled',
  idleEnabledWith: 'Enabled · stops in {n} min',
  unitDay: 'd',
  unitHour: 'h',
  unitMin: 'm',
  unitSec: 's',
};

/** Simplified Chinese dictionary for the 插件配置 card. */
const zhCard = {
  title: '服务(空闲自动停止)',
  description: 'dsh web 持续没有运行中的会话超过设定时长后自动停止服务,可通过桌面快捷方式重新启动。',
  unsaved: '未保存',
  collapse: '收起',
  expand: '展开',
  readOnly: '当前设置为只读,无法保存。',
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  saveFailed: '保存失败,请重试。',
  invalidNumber: '请输入有效数字',
  overridden: '已覆盖',
  reset: '重置',
  resetAll: '恢复默认',
  idleEnabled: '启用空闲自动停止',
  idleEnabledHint: '关闭后服务不会自动停止。',
  idleMinutes: '空闲时长 (分钟)',
  idleMinutesHint: '无运行中会话超过该时长后自动停止服务;默认 120(2 小时)。',
};

/** English dictionary for the 插件配置 card. */
const enCard = {
  title: 'Service (idle auto-stop)',
  description: 'Stop dsh web automatically after no session has been running for a while; restart it from the desktop shortcut.',
  unsaved: 'Unsaved',
  collapse: 'Collapse',
  expand: 'Expand',
  readOnly: 'Settings are read-only and cannot be saved.',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saveFailed: 'Save failed. Try again.',
  invalidNumber: 'Enter a valid number',
  overridden: 'Overridden',
  reset: 'Reset',
  resetAll: 'Restore defaults',
  idleEnabled: 'Idle auto-stop',
  idleEnabledHint: 'When off, the service never stops automatically.',
  idleMinutes: 'Idle minutes',
  idleMinutesHint: 'Stop after this many minutes without a running session; default 120 (2 h).',
};

/** Dictionary namespaces owned by this plugin. */
const NS = 'settings.other';
const CARD_NS = 'settings.other.card';

/** Services required by the registrations. */
const inject = ['slots', 'locale', 'connection'];

/** Compact duration formatting (labels via t()). */
function formatUptime(t, seconds) {
  const s = Math.floor(seconds)
  if (!(s >= 0)) return '—'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return d + ' ' + t('unitDay') + ' ' + h + ' ' + t('unitHour')
  if (h > 0) return h + ' ' + t('unitHour') + ' ' + m + ' ' + t('unitMin')
  if (m > 0) return m + ' ' + t('unitMin') + ' ' + sec + ' ' + t('unitSec')
  return s + ' ' + t('unitSec')
}

/** One label/value row of the runtime snapshot. */
function InfoRow({ label, value }) {
  return jsxs('div', { className: 'so-info-row', children: [
    jsx('span', { className: 'so-info-label', children: label }, 'label'),
    jsx('span', { className: 'so-info-value', children: value }, 'value'),
  ] });
}

/** Live runtime snapshot: polls /app/status every 10 s, manual refresh. */
function StatusBlock({ status, t }) {
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(false);

  const fetchInfo = () => {
    void Promise.resolve().then(() => status()).then(
      (value) => { setInfo(value); setFailed(false) },
      () => { setFailed(true) },
    )
  };

  useEffect(() => {
    fetchInfo()
    const timer = setInterval(fetchInfo, 10_000)
    return () => clearInterval(timer)
  }, []);

  const svc = info?.service ?? {};
  const idle = info?.idle;
  const idleValue = () => {
    if (idle === undefined) return '—'
    if (!idle.enabled) return t('idleDisabled')
    const remainingMs = idle.idleMinutes * 60_000 - (Date.now() - (idle.lastBusyAt ?? Date.now()))
    return t('idleEnabledWith', { n: Math.max(0, Math.ceil(remainingMs / 60_000)) })
  };
  const rows = [
    ['pid', t('pid'), svc.pid !== undefined ? String(svc.pid) : '—'],
    ['ports', t('ports'), svc.ports !== undefined ? (svc.ports.join(', ') || '—') : '—'],
    ['uptime', t('uptime'), svc.uptime !== undefined ? formatUptime(t, svc.uptime) : '—'],
    ['memory', t('memory'), svc.rss !== undefined ? (svc.rss / 1048576).toFixed(1) + ' MB' : '—'],
    ['node', t('node'), svc.node ?? '—'],
    ['dshVersion', t('dshVersion'), svc.version ?? '—'],
    ['running', t('running'), info !== null ? String(info.running ?? 0) : '—'],
    ['idle', t('idle'), idleValue()],
  ];

  return jsx('div', { className: 'so-status-block', children: [
    jsxs('div', { className: 'so-info-head', children: [
      jsx('span', { className: 'so-status-title', children: t('statusTitle') }, 'title'),
      jsx('button', { type: 'button', className: 'so-btn so-btn-sm', onClick: fetchInfo, children: t('refresh') }, 'refresh'),
    ] }, 'head'),
    info === null && !failed
      ? jsx('span', { className: 'so-status', children: t('loading') }, 'loading')
      : null,
    failed
      ? jsx('span', { className: 'so-status', 'data-tone': 'error', children: t('infoError') }, 'failed')
      : null,
    info !== null
      ? jsx('div', { className: 'so-info', children: rows.map((row) => jsx(InfoRow, { label: row[1], value: row[2] }, row[0])) }, 'info')
      : null,
  ] });
}

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
      jsx(StatusBlock, { status, t }, 'status-block'),
      jsx('div', { className: 'so-row', children: [
        phase === 'confirm'
          ? jsxs(React.Fragment, { children: [
              jsx('span', { className: 'so-status so-flow-status', 'data-tone': 'error', children: t('confirmPrompt') }, 'prompt'),
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
              jsx('span', { className: 'so-status so-flow-status', 'data-tone': 'error', children: phase === 'waiting'
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
        ? jsx('p', { className: 'so-status so-flow-status', 'data-tone': tone, children: phase === 'scheduled' ? t('scheduled') : t('error') }, 'status')
        : null,
      phase === 'error'
        ? jsx('button', { type: 'button', className: 'so-btn', onClick: () => { setPhase('idle') }, children: t('retry') }, 'retry')
        : null,
    ] }, 'card'),
  ] });
}

/** Field descriptors of the idle auto-stop configuration card. */
const CARD_FIELDS = [
  { key: 'idleEnabled', type: 'boolean' },
  { key: 'idleMinutes', type: 'number' },
];

/** One labelled field row with staged text, override badge, and reset. */
function SettingsField({ field, label, hint, text, overridden, invalid, disabled, onChange, onReset, t }) {
  return jsxs('div', { className: 'soc-field', children: [
    jsxs('div', { className: 'soc-field-head', children: [
      jsx('label', { className: 'soc-label', htmlFor: 'soc-' + field.key, children: label }, 'label'),
      overridden ? jsx('span', { className: 'soc-overridden', children: t('overridden') }, 'overridden') : null,
      jsx('button', {
        type: 'button',
        className: 'soc-reset',
        disabled: disabled || !overridden,
        onClick: onReset,
        children: t('reset'),
      }, 'reset'),
    ] }, 'head'),
    field.type === 'boolean'
      ? jsx('input', {
          id: 'soc-' + field.key,
          type: 'checkbox',
          className: 'soc-toggle',
          checked: text === 'true',
          disabled,
          onChange: (event) => { onChange(event.currentTarget.checked ? 'true' : 'false') },
        }, 'control')
      : jsx('input', {
          id: 'soc-' + field.key,
          type: 'number',
          className: 'soc-input' + (invalid ? ' soc-invalid' : ''),
          value: text,
          disabled,
          min: 1,
          onChange: (event) => { onChange(event.currentTarget.value) },
        }, 'control'),
    invalid ? jsx('p', { className: 'soc-invalid-text', children: t('invalidNumber') }, 'invalid') : null,
    jsx('p', { className: 'soc-hint', children: hint }, 'hint'),
  ] });
}

/** The configuration card shown in 插件配置 / 插件管理 (idle auto-stop settings). */
function ServiceSettingsCard({ t, getConfig, setConfig, resetConfig }) {
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
  const invalid = staged !== null && Object.entries(staged).some(([key, text]) => {
    const field = CARD_FIELDS.find((candidate) => candidate.key === key)
    if (field === undefined || field.type !== 'number') return false
    const parsed = Number(text)
    return text.trim() === '' || !Number.isFinite(parsed) || parsed < 1
  });
  const blocked = !dirty || invalid || saving;

  const textOf = (key) => {
    const field = CARD_FIELDS.find((candidate) => candidate.key === key)
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
    setSaving(true); setFailed(false)
    try {
      const parsed = {}
      for (const [key, text] of Object.entries(staged)) {
        const field = CARD_FIELDS.find((candidate) => candidate.key === key)
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

  return jsxs('li', { className: 'soc-card' + (open ? ' soc-card-open' : ''), children: [
    jsxs('button', {
      type: 'button',
      className: 'soc-header',
      'aria-expanded': open,
      'aria-label': (open ? t('collapse') : t('expand')) + ': ' + t('title'),
      onClick: () => { setOpen(!open) },
      children: [
        jsxs('span', { className: 'soc-head-text', children: [
          jsx('span', { className: 'soc-name', children: t('title') }, 'name'),
          jsx('span', { className: 'soc-description', children: t('description') }, 'desc'),
        ] }, 'head-text'),
        dirty ? jsx('span', { className: 'soc-pending', children: t('unsaved') }, 'pending') : null,
        jsx(IconChevronDownOutline14, { className: 'soc-chevron' + (open ? ' soc-chevron-open' : ''), 'aria-hidden': true }, 'chevron'),
      ],
    }, 'header'),
    open ? jsxs('div', { className: 'soc-body', children: [
      CARD_FIELDS.map((field) => jsx(SettingsField, {
        field,
        label: t(field.key),
        hint: t(field.key + 'Hint'),
        text: textOf(field.key),
        overridden: false,
        invalid: staged !== null && field.key in staged && field.type === 'number'
          ? !(Number.isFinite(Number(staged[field.key])) && Number(staged[field.key]) >= 1)
          : false,
        disabled: saving,
        onChange: (text) => { edit(field.key, text) },
        onReset: () => {},
        t,
      }, field.key)),
      jsxs('div', { className: 'soc-footer', children: [
        failed ? jsx('p', { className: 'soc-failed', role: 'status', children: t('saveFailed') }, 'failed') : null,
        jsx('button', { type: 'button', className: 'soc-discard', disabled: !dirty || saving, onClick: discard, children: t('discard') }, 'discard'),
        jsx('button', { type: 'button', className: 'soc-discard', disabled: saving, onClick: () => { void resetAll() }, children: t('resetAll') }, 'reset-all'),
        jsx('button', { type: 'button', className: 'soc-save', disabled: blocked, onClick: () => { void save() }, children: saving ? t('saving') : t('save') }, 'save'),
      ] }, 'footer'),
    ] }, 'body') : null,
  ] });
}

/** Contribute the Other settings section + the idle auto-stop configuration card. */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-other: section dictionaries')
  ctx.effect(() => ctx.locale.register(CARD_NS, { zh: zhCard, en: enCard }), 'ui-settings-other: card dictionaries')

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

  const cardApi = () => ({
    getConfig: async () => {
      const result = await ctx.connection.rpc.call('/app', 'getSettings', { args: {} })
      if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message)
      return result.value
    },
    setConfig: async (fields) => {
      const result = await ctx.connection.rpc.call('/app', 'setSettings', { args: { fields } })
      if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message)
      return result.value
    },
    resetConfig: async () => {
      const result = await ctx.connection.rpc.call('/app', 'resetSettings', { args: {} })
      if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message)
      return result.value
    },
  })

  // The shipped 插件配置 page (settings.plugin.item).
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: '@local/dsh-client-ui-settings-other',
    order: 30,
    locale: CARD_NS,
    inject: cardApi,
  }, ServiceSettingsCard))

  // The plugin-manager page, keyed by the plugin's module name (the manager
  // renders this slot with `only: entry.moduleName`).
  ctx.slots.inject('settings.plugin.manager.item', () => ctx.slots.register({
    name: 'settings.plugin.manager.item',
    id: '@local/dsh-client-ui-settings-other',
    order: 30,
    locale: CARD_NS,
    inject: cardApi,
  }, ServiceSettingsCard))
}

module.exports = { apply, inject, NS };
return module.exports;
} });
