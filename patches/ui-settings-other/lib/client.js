/**
 * Browser half of the ui-settings-other patch: an "Other" settings section
 * with a restart-service button and a live runtime-status block.
 *
 * Hand-written in the client-bundle contract (no build step): the shell's
 * module loader receives this file through `window.__ModuleLoader__.load` and
 * answers every `require()` from the frozen module table. Only platform seed
 * words are used: `react`, `react/jsx-runtime`, and `Modal` from
 * `@deepseek-ai/dsh-client-ui-primitives`. Everything else (slots, locale)
 * arrives as services on the `apply(ctx)` context.
 *
 * The section registers into the `settings.section` slot (same seat as the
 * shipped General / Models / Plugins / Agent presets pages) under id `other`,
 * ordered last. Every host call goes through the `/app` prefix route as a
 * fenced JSON `fetch` (the host half registers it — see `createRpcRoute`
 * there); `ctx.connection.rpc.call` cannot work in this dsh version.
 *
 * The restart drops the page's own connection (the host process is the one
 * being replaced), so the flow is built around that:
 *   - every path that really disconnects the service asks for confirmation
 *     first (plain restart, 强制重启, and 等待空闲后重启 — the latter two used
 *     to fire with no prompt);
 *   - after the request is accepted, a three-stage progress bar reports what
 *     the page can still observe on its own origin (请求 → 旧服务停止 →
 *     新服务就绪), degrading to an explicit "unknown" when the replacement is
 *     not reachable from here (the script may have moved to another port).
 *
 * Deliberately absent: a "reload user plugins" button (rewriting the patch
 * layer's comments never re-mounts anything — `Entry.update` deep-compares
 * options and returns early on an unchanged patch list) and a "stop service"
 * button (stopping is a CLI/desktop action via `stop-dsh.ps1`; the single
 * destructive control here is the restart button). Do not re-add either one
 * without a mechanism that actually works. The idle auto-stop configuration
 * card is gone with the feature itself — this patch owns no settings anymore.
 *
 * The status block polls `/app/status` every 10 s and shows the live process
 * snapshot (pid, ports, uptime, memory, versions, running sessions) with a
 * manual refresh button. That cadence is only real while the page is visible —
 * a background tab gets its timers throttled, so the block also re-reads when
 * the tab becomes visible again and whenever the restart flow reports the
 * replacement is up (see StatusBlock).
 */
window.__ModuleLoader__.load({ id: '@local/dsh-client-ui-settings-other', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useEffect, useState } = React;
const { jsx, jsxs } = require('react/jsx-runtime');
const { Modal } = require('@deepseek-ai/dsh-client-ui-primitives');

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
  '.so-danger-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:0 0 10px}',
  '.so-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
  '.so-status[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}',
  '.so-status-block{border-top:1px solid var(--dsw-alias-border-l2);margin-top:2px;padding-top:12px;display:flex;flex-direction:column;gap:8px}',
  '.so-info-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
  '.so-status-title{font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}',
  '.so-info{display:flex;flex-direction:column;gap:2px}',
  '.so-info-row{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;line-height:20px}',
  '.so-info-label{color:var(--dsw-alias-label-tertiary);flex:none}',
  '.so-info-value{color:var(--dsw-alias-label-primary);font-family:ui-monospace,Consolas,monospace;text-align:right;word-break:break-all}',
  /* restart progress bar */
  '.so-progress{border-top:1px solid var(--dsw-alias-border-l2);margin-top:2px;padding-top:12px;display:flex;flex-direction:column;gap:8px}',
  '.so-progress-track{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);height:6px;overflow:hidden}',
  '.so-progress-fill{background:var(--dsw-alias-brand-primary);height:100%;transition:width .3s ease}',
  '.so-progress-fill[data-state="unknown"]{background:var(--dsw-alias-state-error-primary)}',
  '.so-progress-steps{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.so-progress-step[data-stage-state="done"]{color:var(--dsw-alias-state-success-primary)}',
  '.so-progress-step[data-stage-state="active"]{color:var(--dsw-alias-label-primary)}',
  '.so-progress-step[data-stage-state="unknown"]{color:var(--dsw-alias-state-error-primary)}',
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
  confirmPromptRestart: '确定要重启服务吗?当前服务进程会被停止并重新拉起,连接会短暂断开。',
  confirmPromptForce: '有 {n} 个会话正在运行:强制重启会先取消它们(队列保留),随后停止服务进程。确定继续吗?',
  confirmPromptAuto: '运行中的会话已全部结束,现在重启服务吗?重启期间连接会短暂断开。',
  confirm: '确认重启',
  cancel: '取消',
  restarting: '正在重启…',
  error: '重启请求失败,请重试。',
  retry: '重试',
  busy: '有 {n} 个会话正在运行,重启会中断它们。',
  busyActionWait: '等待空闲后重启',
  busyActionForce: '强制重启',
  waiting: '等待会话结束…(剩余 {n})',
  progressTitle: '重启进度',
  progressRunning: '重启中…',
  progressReadyDone: '服务已就绪',
  stageRequest: '已请求重启',
  stageStop: '旧服务已停止',
  stageReady: '新服务已就绪',
  checkAgain: '重试检测',
  readyCopy: '新服务已就绪:新地址会自动打开(端口可能变化);若端口没变,直接刷新本页即可继续使用。',
  readyUnknown: '约 {n} 秒内未在本地址检测到服务恢复应答 —— 端口很可能已变化:重启脚本会自动打开新地址,也可刷新本页或查看日志目录。',
  versionTitle: 'dsh 版本',
  versionCurrent: '当前版本',
  versionLatest: '最新版本(latest)',
  versionCheck: '检查更新',
  versionChecking: '检查中…',
  versionUpToDate: '已是最新',
  versionAvailable: '有新版本可用:{v}',
  versionUnknown: '—',
  versionFailed: '检查失败,请稍后重试',
  versionError: '检查失败:{reason}',
  update: '更新并重启',
  confirmPromptUpdate: '将安装 dsh {v} 并重启服务:期间会下载新版本、替换当前进程,连接会短暂断开。确定继续吗?',
  updateError: '更新请求失败,请重试。',
  progressTitleUpdate: '更新进度',
  stageRequestUpdate: '已请求更新',
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
  unitDay: '天',
  unitHour: '小时',
  unitMin: '分',
  unitSec: '秒',
  dangerNote: '以下操作会终止 dsh 进程并中断所有运行中的会话,仅在升级 dsh 或修改核心插件时使用;日常调整用户插件(增删行、改 config)只需编辑 cordis.patch.yml,数秒内热生效,改补丁源码才需要重启。',
  createShortcut: '创建桌面快捷方式',
  shortcutBusy: '创建中…',
  shortcutCreated: '快捷方式已创建:',
  shortcutExists: '快捷方式已存在:',
  shortcutFailed: '快捷方式创建失败:',
  shortcutHint: '在桌面创建 dsh-web 快捷方式(鲸鱼娘图标),双击即可启动服务(窗口会显示端口并等待按键)。',
};

/** English dictionary checked against the Chinese key set. */
const en = {
  nav: 'Other',
  serviceTitle: 'Service',
  serviceDesc: 'Restart the dsh service process. The current connection drops briefly; refresh the page after the restart completes.',
  restart: 'Restart service',
  confirmPromptRestart: 'Restart the service? The current process is stopped and started again, so the connection drops briefly.',
  confirmPromptForce: '{n} session(s) are running: a force restart cancels them first (queued work is kept), then stops the service. Continue?',
  confirmPromptAuto: 'No session is running any more. Restart the service now? The connection drops briefly.',
  confirm: 'Restart',
  cancel: 'Cancel',
  restarting: 'Restarting…',
  error: 'The restart request failed. Please try again.',
  retry: 'Retry',
  busy: '{n} session(s) are running; restarting will interrupt them.',
  busyActionWait: 'Restart when idle',
  busyActionForce: 'Force restart',
  waiting: 'Waiting for sessions… ({n} remaining)',
  progressTitle: 'Restart progress',
  progressRunning: 'Restarting…',
  progressReadyDone: 'Service is ready',
  stageRequest: 'Restart requested',
  stageStop: 'Old service stopped',
  stageReady: 'New service ready',
  checkAgain: 'Check again',
  readyCopy: 'The new service is ready: its address opens automatically (the port may change); if the port stayed the same, just refresh this page.',
  readyUnknown: 'No answer from this address within ~{n}s — the port most likely changed: the restart script opens the new address itself; you can also refresh this page or check the log directory.',
  versionTitle: 'dsh version',
  versionCurrent: 'Current',
  versionLatest: 'Latest (dist-tag)',
  versionCheck: 'Check for updates',
  versionChecking: 'Checking…',
  versionUpToDate: 'Up to date',
  versionAvailable: 'Update available: {v}',
  versionUnknown: '—',
  versionFailed: 'Check failed, try again later',
  versionError: 'Check failed: {reason}',
  update: 'Update and restart',
  confirmPromptUpdate: 'dsh {v} will be installed and the service restarted: the new version is downloaded, this process is replaced, and the connection drops briefly. Continue?',
  updateError: 'The update request failed. Please try again.',
  progressTitleUpdate: 'Update progress',
  stageRequestUpdate: 'Update requested',
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
  unitDay: 'd',
  unitHour: 'h',
  unitMin: 'm',
  unitSec: 's',
  dangerNote: 'The action below terminates the dsh process and interrupts every running session. Use it only to upgrade dsh or change core plugins; everyday user-plugin edits (adding rows, changing config) only need cordis.patch.yml and apply within seconds — patch source changes are what require a restart.',
  createShortcut: 'Create desktop shortcut',
  shortcutBusy: 'Creating…',
  shortcutCreated: 'Shortcut created:',
  shortcutExists: 'Shortcut already exists:',
  shortcutFailed: 'Shortcut creation failed:',
  shortcutHint: 'Creates a dsh-web desktop shortcut (whale-girl icon) that starts the service on double-click (the window shows the port and waits for a key).',
};

/** The one locale namespace owned by this plugin. */
const NS = 'settings.other';

/** Restart stages, in order. Index = how many stages are complete. */
const STAGES = ['stageRequest', 'stageStop', 'stageReady'];

/** Progress polling cadence and the budget after which the last stage gives up. */
const POLL_MS = 1000;
const PROGRESS_BUDGET_MS = 120_000;
/** An update fetches a build, patches it and boots it — minutes, not seconds. */
const UPDATE_BUDGET_MS = 300_000;

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

/**
 * Live runtime snapshot: polls /app/status every 10 s, manual refresh.
 *
 * A background tab has its timers throttled by the browser (Chrome: >=1 min,
 * and slower still after a few minutes), so "every 10 s" only holds while this
 * page is visible — the snapshot can otherwise sit on a pid that no longer
 * exists. Two explicit re-reads make that invisible: returning to the tab
 * refetches once, and `refreshToken` (bumped by the restart flow when the
 * replacement is up) refetches without waiting for the next poll.
 */
function StatusBlock({ status, t, refreshToken }) {
  const [info, setInfo] = useState(null);
  const [failed, setFailed] = useState(false);
  // The reason rides on the element's title: the visible line stays short, but
  // a hover (or devtools) shows the exact RPC error instead of a bare failure.
  const [failReason, setFailReason] = useState('');

  const fetchInfo = () => {
    void Promise.resolve().then(() => status()).then(
      (value) => { setInfo(value); setFailed(false); setFailReason('') },
      (error) => { setFailed(true); setFailReason(String(error?.message ?? error)) },
    )
  };

  useEffect(() => {
    fetchInfo()
    const timer = setInterval(fetchInfo, 10_000)
    const onVisible = () => { if (document.visibilityState === 'visible') fetchInfo() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, []);

  // 0 = the mount read above, so a restart that finished before this section
  // ever rendered does not fetch twice.
  useEffect(() => {
    if (refreshToken > 0) fetchInfo()
  }, [refreshToken]);

  const svc = info?.service ?? {};
  const rows = [
    ['pid', t('pid'), svc.pid !== undefined ? String(svc.pid) : '—'],
    ['ports', t('ports'), svc.ports !== undefined ? (svc.ports.join(', ') || '—') : '—'],
    ['uptime', t('uptime'), svc.uptime !== undefined ? formatUptime(t, svc.uptime) : '—'],
    ['memory', t('memory'), svc.rss !== undefined ? (svc.rss / 1048576).toFixed(1) + ' MB' : '—'],
    ['node', t('node'), svc.node ?? '—'],
    ['dshVersion', t('dshVersion'), svc.version ?? '—'],
    ['running', t('running'), info !== null ? String(info.running ?? 0) : '—'],
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
      ? jsx('span', { className: 'so-status', 'data-tone': 'error', title: failReason, children: t('infoError') }, 'failed')
      : null,
    info !== null
      ? jsx('div', { className: 'so-info', children: rows.map((row) => jsx(InfoRow, { label: row[1], value: row[2] }, row[0])) }, 'info')
      : null,
  ] });
}

/**
 * The running dsh against the `latest` dist-tag: one read on mount (served
 * from the host's short-lived cache) plus a manual re-check that bypasses it.
 *
 * Read-only: an available update is reported, never applied. Swapping the
 * install the whole patch layer sits on is its own explicit action.
 */
function VersionCard({ versionCheck, onUpdate, busy, refreshToken, t }) {
  const [state, setState] = useState({ status: 'loading' });

  const check = (force) => {
    setState({ status: 'loading' });
    void Promise.resolve().then(() => versionCheck(force)).then(
      (value) => setState({ status: 'ready', value }),
      (error) => setState({ status: 'failed', reason: String(error?.message ?? error) }),
    );
  };
  useEffect(() => { check(false) }, []);
  // The service was replaced (an update or a restart finished): the versions on
  // screen belong to the old process, so re-read instead of waiting for the
  // host's own cache window to expire.
  useEffect(() => {
    if (refreshToken > 0) check(true)
  }, [refreshToken]);

  const value = state.status === 'ready' ? state.value : null;
  const checking = state.status === 'loading';
  const infoRow = (key, label, text) => jsxs('div', { className: 'so-info-row', children: [
    jsx('span', { className: 'so-info-label', children: label }, 'label'),
    jsx('span', { className: 'so-info-value', children: text }, 'value'),
  ] }, key);
  // The host's `error` is a curated reason ("no latest dist-tag", "registry
  // answered HTTP 503") and is shown; a broken transport is not — that message
  // is a developer detail, so it gets the neutral copy.
  const failure = state.status === 'failed'
    ? t('versionFailed')
    : (value !== null && value.error !== null ? t('versionError', { reason: value.error }) : null);

  return jsxs('div', { className: 'so-card', children: [
    jsx('h3', { children: t('versionTitle') }, 'title'),
    jsxs('div', { className: 'so-info', children: [
      infoRow('current', t('versionCurrent'), value?.current ?? (busy ? t('versionChecking') : t('versionUnknown'))),
      infoRow('latest', t('versionLatest'), value?.latest ?? t('versionUnknown')),
    ] }, 'rows'),
    jsx('div', { className: 'so-row', children: [
      jsx('button', {
        type: 'button',
        className: 'so-btn',
        disabled: checking ? true : undefined,
        onClick: () => { check(true) },
        children: checking ? t('versionChecking') : t('versionCheck'),
      }, 'version-check'),
      value !== null && value.hasUpdate
        ? jsx('button', {
            type: 'button',
            className: 'so-btn so-danger',
            disabled: busy ? true : undefined,
            onClick: () => { onUpdate(value.latest) },
            children: t('update'),
          }, 'version-update')
        : null,
      failure !== null
        ? jsx('span', { className: 'so-status so-flow-status', 'data-tone': 'error', children: failure }, 'version-failure')
        : null,
      failure === null && value !== null
        ? jsx('span', {
            className: 'so-status so-flow-status',
            'data-tone': value.hasUpdate ? 'ok' : undefined,
            children: value.hasUpdate ? t('versionAvailable', { v: value.latest }) : t('versionUpToDate'),
          }, 'version-state')
        : null,
    ] }, 'row'),
  ] });
}

/**
 * Phase state machine (the confirm step is a Modal dialog):
 *
 *   idle  -> confirm(restart) -> calling -> progress | busy | error
 *   busy  -> confirm(force)   -> calling ...
 *   busy  -> waiting (poll until the last session ends) -> confirm(auto) -> ...
 *
 * EVERY path that really disconnects the service passes through `confirm`
 * first: 强制重启 and the wait flow's auto-restart used to fire with no prompt
 * at all, which is exactly the moment the service dies.
 */
function OtherSection({ restart, status, installShortcut, versionCheck, update, t, progressBudgetMs = PROGRESS_BUDGET_MS }) {
  const [phase, setPhase] = useState('idle');
  const [intent, setIntent] = useState('restart'); // 'restart' | 'force' | 'auto'
  const [busyInfo, setBusyInfo] = useState(null);
  const [waitTimer, setWaitTimer] = useState(null);
  const [progress, setProgress] = useState(null); // { stage, state }
  const [retryToken, setRetryToken] = useState(0);
  const [updateVersion, setUpdateVersion] = useState(null);
  // Bumped once the replacement is observed, so neither the runtime snapshot
  // nor the version card keeps showing the replaced process (the old pid, the
  // old dsh version) until their own throttled polls come round.
  const [readyRefresh, setReadyRefresh] = useState(0);
  // The pid of the process that was serving the page when the restart was
  // requested. It survives a re-probe (see 重试检测) because a re-probe has no
  // settle window to capture it in — it is cleared only by a new restart.
  const baselinePid = React.useRef(null);

  useEffect(() => () => {
    if (waitTimer !== null) clearInterval(waitTimer);
  }, [waitTimer]);

  /** Ask before anything that stops the service; `intent` picks the copy. */
  const ask = (next) => { setIntent(next); setPhase('confirm') };

  const trigger = (next) => {
    baselinePid.current = null // a new action: re-capture the pid it replaces
    setPhase('calling')
    const act = next === 'update'
      ? () => update(updateVersion)
      : () => restart(next === 'force')
    void Promise.resolve().then(act).then(
      (result) => {
        if (result.scheduled) {
          setProgress({ stage: 1, state: 'active' })
          setPhase('progress')
        } else if (result.busy) { setBusyInfo(result.busy); setPhase('busy') }
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
            ask('auto')
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

  /**
   * Closing the confirm dialog. Cancel is the safe default, so it lands back on
   * the state the prompt interrupted: the busy view keeps its 等待空闲/强制重启
   * choice (the sessions are still running), everything else goes idle.
   */
  const dismiss = () => { setPhase(intent === 'force' ? 'busy' : 'idle') };

  // Progress driver. The restart script runs in its own process, so the page
  // cannot be told what it sees — the stages come from what this page can still
  // observe on its own origin. During the script's settle window the process
  // that serves this page is still the OLD one, which makes its pid the
  // baseline: a poll that answers with a different pid — or any poll after one
  // that could not connect at all — means the replacement is up. Observing
  // neither within the budget degrades to 'unknown' instead of claiming a
  // readiness the page cannot verify (the script can fall back to another port
  // from the 3080-3100 pool, and the old origin never answers again).
  useEffect(() => {
    if (phase !== 'progress') return undefined
    let cancelled = false
    let timer = null
    let sawDown = false
    // Wall clock, not a tick count: a background tab has its timers throttled
    // (a "1 s" interval can land minutes apart), so counting ticks made the
    // budget mean "120 polls", which stretched to minutes of real time.
    const budget = intent === 'update' ? UPDATE_BUDGET_MS : progressBudgetMs
    const deadline = Date.now() + budget
    const stopPolling = () => { if (timer !== null) { clearInterval(timer); timer = null } }
    const observe = (value) => {
      const pid = value?.service?.pid
      if (sawDown || (baselinePid.current !== null && pid !== baselinePid.current)) {
        stopPolling()
        setProgress({ stage: 3, state: 'ready' })
        setReadyRefresh((token) => token + 1) // show the new pid/version at once
        return
      }
      if (baselinePid.current === null) baselinePid.current = pid
      setProgress({ stage: 1, state: 'active' })
    }
    const probe = () => {
      void Promise.resolve().then(() => status()).then(
        (value) => { if (!cancelled) observe(value) },
        () => {
          if (cancelled) return
          sawDown = true
          setProgress({ stage: 2, state: 'active' })
        },
      )
    }
    const onVisible = () => {
      if (cancelled || document.visibilityState !== 'visible') return
      if (Date.now() > deadline) return
      probe() // returning to the tab must not wait for a throttled tick
    }
    probe() // the baseline read: the old process still answers during the settle
    document.addEventListener('visibilitychange', onVisible)
    timer = setInterval(() => {
      if (cancelled) return
      if (Date.now() > deadline) {
        stopPolling()
        setProgress({ stage: 2, state: 'unknown' })
        return
      }
      probe()
    }, POLL_MS)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      stopPolling()
    }
  }, [phase, retryToken, progressBudgetMs, intent]);

  const [shortcutState, setShortcutState] = useState(null); // null | 'busy' | 'done' | 'failed'
  const [shortcutOutput, setShortcutOutput] = useState('');
  const doShortcut = () => {
    setShortcutState('busy')
    void Promise.resolve().then(() => installShortcut()).then(
      (value) => { setShortcutState('done'); setShortcutOutput(value.output) },
      () => { setShortcutState('failed'); setShortcutOutput('') },
    )
  };

  const progressStage = progress?.stage ?? 1;
  const progressState = progress?.state ?? 'active';
  const isUpdate = intent === 'update';
  const busy = phase === 'calling' || (phase === 'progress' && progressState === 'active');
  const canRestart = phase === 'idle' || phase === 'progress';
  const confirmPrompt = intent === 'force'
    ? t('confirmPromptForce', { n: busyInfo?.running ?? 0 })
    : intent === 'auto'
      ? t('confirmPromptAuto')
      : isUpdate
        ? t('confirmPromptUpdate', { v: updateVersion ?? '' })
        : t('confirmPromptRestart');

  /** Marker state of stage `index`: done / active / pending, or the unknown tail. */
  const stageState = (index) => {
    if (index < progressStage) return 'done'
    if (index > progressStage) return 'pending'
    return progressState === 'ready' ? 'done' : progressState === 'unknown' ? 'unknown' : 'active'
  };

  return jsx('div', { className: 'so-section', children: [
    jsx('div', { className: 'so-card', children: [
      jsx('h3', { children: t('serviceTitle') }, 'title'),
      jsx('p', { children: t('serviceDesc') }, 'desc'),
      jsx(StatusBlock, { status, t, refreshToken: readyRefresh }, 'status-block'),
      jsx('div', { className: 'so-row', children: [
        jsx('button', {
          type: 'button',
          className: 'so-btn',
          disabled: shortcutState === 'busy' ? true : undefined,
          onClick: doShortcut,
          children: shortcutState === 'busy' ? t('shortcutBusy') : t('createShortcut'),
        }, 'create-shortcut'),
        shortcutState === 'done'
          ? jsxs('span', { className: 'so-status so-flow-status', 'data-tone': 'ok', children: [
              t('shortcutCreated') + ' ',
              jsx('code', { children: shortcutOutput }, 'shortcut-output'),
            ] }, 'shortcut-done')
          : null,
        shortcutState === 'failed'
          ? jsx('span', { className: 'so-status so-flow-status', 'data-tone': 'error', children: t('shortcutFailed') + ' ' + shortcutOutput }, 'shortcut-fail')
          : null,
      ] }, 'shortcut-row'),
      jsx('p', { className: 'so-danger-note', children: t('shortcutHint') }, 'shortcut-hint'),
      jsx('p', { className: 'so-danger-note', children: t('dangerNote') }, 'danger-note'),
      jsx('div', { className: 'so-row', children: [
        jsx('button', {
          type: 'button',
          className: 'so-btn so-danger',
          disabled: busy ? true : undefined,
          onClick: () => { if (canRestart) ask('restart') },
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
                ? jsx('button', { type: 'button', className: 'so-btn so-danger', onClick: () => { ask('force') }, children: t('busyActionForce') }, 'force')
                : null,
              jsx('button', { type: 'button', className: 'so-btn', onClick: stopWaiting, children: t('cancel') }, 'busy-cancel'),
            ] }, 'busy-row')
          : null,
      ] }, 'row'),
      phase === 'progress'
        ? jsxs('div', { className: 'so-progress', children: [
            jsxs('div', { className: 'so-info-head', children: [
              jsx('span', { className: 'so-status-title', children: t(isUpdate ? 'progressTitleUpdate' : 'progressTitle') }, 'progress-title'),
              jsx('span', { className: 'so-status', children: progressState === 'ready' ? t('progressReadyDone') : t('progressRunning') }, 'progress-state'),
            ] }, 'progress-head'),
            jsx('div', { className: 'so-progress-track', children: jsx('div', {
              className: 'so-progress-fill',
              'data-stage': String(progressStage),
              'data-state': progressState,
              style: { width: (progressState === 'ready' ? 100 : Math.round((progressStage / STAGES.length) * 100)) + '%' },
            }, 'progress-fill') }, 'progress-track'),
            jsx('div', { className: 'so-progress-steps', children: STAGES.map((key, index) => jsx('span', {
              className: 'so-progress-step',
              'data-stage-state': stageState(index),
              // An update requests an install first, not a restart.
              children: (index + 1) + '. ' + t(index === 0 && isUpdate ? 'stageRequestUpdate' : key),
            }, key)) }, 'progress-steps'),
          ] }, 'progress')
        : null,
      phase === 'progress' && progressState === 'ready'
        ? jsx('p', { className: 'so-status so-flow-status', 'data-tone': 'ok', children: t('readyCopy') }, 'progress-ready')
        : null,
      phase === 'progress' && progressState === 'unknown'
        ? jsxs(React.Fragment, { children: [
            jsx('p', { className: 'so-status so-flow-status', 'data-tone': 'error', children: t('readyUnknown', { n: Math.round(progressBudgetMs / 1000) }) }, 'progress-unknown'),
            jsx('button', {
              type: 'button',
              className: 'so-btn',
              onClick: () => { setProgress({ stage: 2, state: 'active' }); setRetryToken((token) => token + 1) },
              children: t('checkAgain'),
            }, 'progress-retry'),
          ] }, 'progress-unknown-row')
        : null,
      phase === 'error'
        ? jsx('p', { className: 'so-status so-flow-status', 'data-tone': 'error', children: t(isUpdate ? 'updateError' : 'error') }, 'status')
        : null,
      phase === 'error'
        ? jsx('button', { type: 'button', className: 'so-btn', onClick: () => { setPhase('idle') }, children: t('retry') }, 'retry')
        : null,
    ] }, 'card'),
    // Confirm dialog: the last stop before the service really goes down.
    jsx(Modal, {
      open: phase === 'confirm',
      onClose: () => { if (phase === 'confirm') dismiss() },
      title: intent === 'force' ? t('busyActionForce') : isUpdate ? t('update') : t('restart'),
      closeLabel: t('cancel'),
      description: confirmPrompt,
      footer: jsxs(React.Fragment, { children: [
        jsx('button', { type: 'button', className: 'so-btn', onClick: dismiss, children: t('cancel') }, 'cancel'),
        jsx('button', { type: 'button', className: 'so-btn so-danger', onClick: () => { trigger(intent) }, children: t('confirm') }, 'confirm'),
      ] }),
    }, 'restart-modal'),
    jsx(VersionCard, {
      versionCheck,
      busy,
      refreshToken: readyRefresh,
      onUpdate: (v) => { setUpdateVersion(v); ask('update') },
      t,
    }, 'version-card'),
  ] });
}

/**
 * One call to the host half over its `/app` prefix route.
 *
 * This used to be `ctx.connection.rpc.call('/app', …)`, which cannot work in
 * dsh 0.1.5-rc.1: the Connection registry throws `cannot get property
 * "webServer" without inject` for every plugin outside the connection package,
 * so the channel never exists and the request would land on the SPA fallback.
 * The host half registers that route itself (see `createRpcRoute` there) and
 * answers the same `{ ok, value }` / `{ ok, error }` envelope.
 *
 * Same-origin by construction, JSON in and out — the host's fence requires it.
 */
const call = async (endpoint, args) => {
  let response
  try {
    response = await fetch('/app/' + endpoint, {
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

/** Contribute the Other settings section. */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-other: section dictionaries')

  const t = ctx.locale.bind(NS)
  const restart = async (force) => {
    try {
      await call('restart', force ? { force: true } : {})
      return { scheduled: true }
    } catch (error) {
      if (error.code === 'sessions-running') return { busy: { running: error.details?.running ?? 0 } }
      throw error
    }
  }
  const status = () => call('status', {})
  const installShortcut = () => call('installShortcut', {})
  const versionCheck = (force) => call('versionCheck', force ? { force: true } : {})
  const update = async (version) => {
    try {
      await call('update', typeof version === 'string' && version.length > 0 ? { version } : {})
      return { scheduled: true }
    } catch (error) {
      if (error.code === 'sessions-running') return { busy: { running: error.details?.running ?? 0 } }
      throw error
    }
  }
  const injected = () => ({ restart, status, installShortcut, versionCheck, update })

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
