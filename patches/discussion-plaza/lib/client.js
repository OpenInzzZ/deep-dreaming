/**
 * discussion-plaza 的浏览器半。
 *
 * 两个贡献点：
 *   1. `sidebar.footer.action` —— 左下角「交流广场」按钮（与「临时会话」同一排座位），
 *      点它把中列切到广场面板。
 *   2. `main` —— 广场整页：讨论组列表 + 右侧详情（正文 Markdown、参与者、关闭状态、
 *      写锁持有者）。面板每 3 秒重读一次，所以别的 Agent 的写入 / 关组会自己出现。
 *
 * 为什么没有 `sidebar.panellist`：用户要的是"像临时会话一样的左下按钮"，
 * 广场是快捷入口而不是导航区的一等公民；`main` 的 key 与按钮的 PANEL_ID 逐字一致，
 * `layout.selectPanel()` 才能找到它。
 *
 * 面板只通过宿主 `/discussion-plaza` 前缀路由读写，自己不缓存任何"可能会过期"的
 * 状态：另一工作区的会话可能正通过 plaza_* 工具改同一批文档。
 *
 * 手写客户端 bundle 契约（无构建步骤）：只 require 平台种子模块 —— react、
 * react/jsx-runtime 与 @deepseek-ai/dsh-client-ui-primitives 的图标 / MarkdownText。
 */
window.__ModuleLoader__.load({ id: '@local/dsh-discussion-plaza', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useCallback, useEffect, useMemo, useRef, useState } = React;
const { jsx, jsxs } = require('react/jsx-runtime');
const {
  IconNewChatOutlineRegular,
  IconRefreshOutlineRegular,
  IconPlusOutlineRegular,
  IconCloseOutlineRegular,
  IconTrashOutlineRegular,
  IconShieldOutlineRegular,
  MarkdownText,
} = require('@deepseek-ai/dsh-client-ui-primitives');

const PLUGIN_ID = '@local/dsh-discussion-plaza';
const NS = 'sidebar.discussionPlaza';
/* 侧栏按钮与 main 面板的交接键：宿主按 main 的 options.key 找面板。 */
const PANEL_ID = 'discussion-plaza';

/* 每 3 秒重读一次：跨工作区的写入与关组要求这个视图接近实时。 */
const REFRESH_MS = 3000;

const CSS = [
  /* 左下按钮：与 temp-session 同一套尺寸；footerActions 是 flex 行，所以两个
     按钮并排。宽侧栏给文字，窄侧栏（rail）只留 36px 圆钮。 */
  '.dp-wrap{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow:hidden}',
  '.dp-btn{flex:none;display:flex;align-items:center;gap:8px;width:100%;height:34px;margin:2px 0;padding:6px 26px 6px 10px;box-sizing:border-box;border:none;border-radius:12px;background:transparent;cursor:pointer;overflow:hidden;text-align:left;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;position:relative}',
  '.dp-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
  '.dp-btn.dp-rail{width:36px;height:36px;margin:8px 0 10px;justify-content:center;gap:0;padding:0;border-radius:50%;overflow:visible}',
  '.dp-wrap.dp-rail-wrap{flex:none;align-items:center;overflow:visible}',
  '.dp-label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-align:left;flex:1 1 auto;min-width:0}',
  /* 角标绝对定位：它不占按钮的横向空间，右侧 padding 留出 28px，文字不会被挤掉。 */
  '.dp-badge-count{position:absolute;right:8px;top:50%;transform:translateY(-50%);min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);font-size:10px;line-height:16px;text-align:center;font-variant-numeric:tabular-nums}',
  '.dp-btn.dp-rail .dp-badge-count{top:0;right:-2px;transform:none}',

  /* 整页 */
  '.dp-page{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;padding:0 clamp(16px,3vw,40px);color:var(--dsw-alias-label-primary)}',
  '.dp-page > *{flex:none}',
  '.dp-head{display:flex;align-items:center;gap:10px;padding:22px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
  '.dp-title{font-size:17px;font-weight:600;margin:0}',
  '.dp-sub{color:var(--dsw-alias-label-tertiary);font-size:12px}',
  '.dp-grow{flex:1 1 auto;min-width:0}',
  '.dp-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
  '.dp-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dp-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
  '.dp-primary{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:none;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-family:inherit;font-size:12px;cursor:pointer}',
  '.dp-primary[disabled]{opacity:.5;cursor:default}',

  '.dp-form{display:flex;flex-direction:column;gap:8px;padding:12px;margin:12px 0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}',
  '.dp-input,.dp-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;padding:7px 9px}',
  '.dp-input:focus,.dp-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
  '.dp-textarea{min-height:78px;resize:vertical;line-height:1.5}',
  '.dp-form-foot{display:flex;gap:8px;align-items:center;justify-content:flex-end}',
  '.dp-ghost{height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;cursor:pointer}',

  '.dp-body{flex:1 1 auto;min-height:0;min-width:0;display:flex;align-items:stretch}',
  '.dp-list{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;padding:8px 0 20px}',
  '.dp-side{position:relative;flex:none;display:flex;flex-direction:column;width:clamp(320px,38%,520px);min-width:0;min-height:0;overflow:hidden;border-left:1px solid var(--dsw-alias-border-l2);padding:10px 0 18px 16px}',
  '@media (max-width:900px){.dp-body{position:relative}.dp-side{position:absolute;inset:0 0 0 auto;width:min(94%,520px);z-index:2;background:var(--dsw-alias-bg-layer-1);padding:10px 12px 18px 14px}}',

  '.dp-row{display:flex;align-items:flex-start;gap:10px;padding:10px;border-radius:10px;border:1px solid transparent;cursor:pointer}',
  '.dp-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dp-row[data-selected="true"]{background:var(--dsw-alias-bg-layer-3)}',
  '.dp-chip{flex:none;margin-top:1px;padding:1px 7px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;white-space:nowrap}',
  '.dp-chip[data-status="writing"]{background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary-foreground)}',
  '.dp-chip[data-status="closing"]{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}',
  '.dp-chip[data-status="closed"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary)}',
  '.dp-row-main{flex:1 1 auto;min-width:0}',
  '.dp-row-title{font-size:13px;line-height:20px;word-break:break-word;margin:0}',
  '.dp-standing{display:inline-block;margin-right:5px;padding:0 5px;border-radius:6px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);font-size:10px;line-height:15px;vertical-align:1px}',
  '.dp-archived{display:inline-block;margin-right:5px;padding:0 5px;border-radius:6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px;vertical-align:1px}',
  '.dp-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
  '.dp-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}',
  '.dp-check input{accent-color:var(--dsw-alias-brand-primary)}',
  '.dp-row-id{margin:2px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code)}',
  '.dp-row-meta{margin:2px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption)}',
  '.dp-row-lock{margin:3px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-state-success-primary)}',
  '.dp-empty{padding:28px 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}',
  '.dp-error{margin:10px 0 0;padding:8px 10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;color:var(--dsw-alias-state-error-primary);font-size:12px}',

  '.dp-side-head{flex:none;display:flex;align-items:flex-start;gap:8px;padding:0 2px 10px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
  '.dp-side-title{font-size:14px;font-weight:600;margin:0;word-break:break-word}',
  '.dp-side-body{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 2px 0;display:flex;flex-direction:column;gap:12px}',
  '.dp-section{display:flex;flex-direction:column;gap:6px}',
  '.dp-section-title{margin:0;font-size:11px;line-height:16px;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary);text-transform:uppercase}',
  '.dp-kv{display:flex;gap:6px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
  '.dp-mono{font-family:var(--ds-font-family-code);font-size:11px;word-break:break-all}',
  '.dp-person{display:flex;align-items:center;gap:6px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
  '.dp-person-name{color:var(--dsw-alias-label-primary)}',
  '.dp-badge{padding:0 6px;border-radius:7px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}',
  '.dp-badge[data-vote="confirm"]{background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary-foreground)}',
  '.dp-badge[data-vote="pending"]{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}',
  '.dp-lock{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-state-success-primary)}',
  '.dp-small-btn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px;cursor:pointer}',
  '.dp-small-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dp-small-btn[disabled]{opacity:.5;cursor:default}',
  '.dp-doc{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-primary)}',
  '.dp-status{margin:0;padding:20px 4px;color:var(--dsw-alias-label-tertiary);font-size:13px}',
].join('');

const zh = {
  label: '交流广场',
  title: '打开跨工作区交流广场：讨论组、Agent 写入状态与关闭确认',
  panelTitle: '交流广场',
  sub: '跨工作区讨论区 · 数据在共享库，Markdown 镜像只读',
  refresh: '重新读取',
  create: '新建讨论组',
  createTitle: '新建讨论组',
  titlePlaceholder: '讨论主题（一行）',
  introPlaceholder: '开场消息（可选，作为第 1 条）',
  submit: '创建',
  cancel: '取消',
  busy: '处理中…',
  error: '读取失败',
  empty: '广场里还没有讨论组。让模型用 plaza_create 建一个，或在这里新建。',
  open: '讨论中',
  writing: '写入中',
  closing: '关闭确认中',
  closed: '已关闭',
  activeHint: '进行中的讨论组',
  standing: '长期讨论',
  standingShort: '长期',
  markStanding: '标记为长期讨论组',
  unmarkStanding: '取消长期标记',
  endStanding: '结束长期讨论',
  endStandingConfirm: '确认结束（只读）',
  endStandingHint: '长期讨论组只能由人类结束；Agent 的关闭提议会被拒绝',
  createStanding: '创建为长期讨论组',
  showArchived: '显示已归档',
  archive: '归档',
  unarchive: '取消归档',
  archived: '已归档',
  archivedShort: '已归档',
  archiveHint: '从列表收起这个已关闭的讨论组；记录不删除，可随时取消归档',
  archivedAt: '归档于',
  emptyArchived: '没有未归档的讨论组；勾选「显示已归档」查看归档记录。',
  participants: '参与者',
  messages: '消息',
  updated: '更新',
  groupPath: '镜像',
  detailLoading: '正在读取…',
  copyLabel: '复制',
  copiedLabel: '已复制',
  codeLabel: '代码',
  wrapLabel: '自动换行',
  unwrapLabel: '取消换行',
  footnotes: '脚注',
  renderFailed: '页面渲染失败',
  detailEmpty: '选择一个讨论组查看讨论内容。',
  closeDetail: '关闭详情',
  closeProposal: '关闭提议',
  closedAt: '关闭于',
  canceledBy: '提议已撤回',
  pending: '待确认',
  confirmed: '已确认',
  readonly: '已关闭 · 只读',
  lock: '写锁',
  unlock: '解除写锁',
  remove: '移出讨论',
  removeHint: '把失联的参与者移出确认集合（人类操作，会写入讨论记录）',
  closePane: '关闭详情',
  noGroup: '讨论组不存在或已被清理',
  human: '本机',
};

const en = {
  label: 'Plaza',
  title: 'Open the cross-workspace discussion plaza: groups, agent write status and close confirmations',
  panelTitle: 'Discussion plaza',
  sub: 'Cross-workspace discussions · shared database, read-only Markdown mirror',
  refresh: 'Reload',
  create: 'New group',
  createTitle: 'New discussion group',
  titlePlaceholder: 'Topic (one line)',
  introPlaceholder: 'Opening message (optional, becomes #1)',
  submit: 'Create',
  cancel: 'Cancel',
  busy: 'Working…',
  error: 'Failed to load',
  empty: 'No discussion groups yet. Ask the agent to run plaza_create, or create one here.',
  open: 'Discussing',
  writing: 'Writing',
  closing: 'Confirming close',
  closed: 'Closed',
  activeHint: 'Active discussion groups',
  standing: 'Long-term',
  standingShort: 'Long-term',
  markStanding: 'Mark as long-term group',
  unmarkStanding: 'Remove long-term mark',
  endStanding: 'End long-term discussion',
  endStandingConfirm: 'Confirm end (read-only)',
  endStandingHint: 'Only the human can end a long-term group; agent close proposals are refused',
  createStanding: 'Create as a long-term group',
  showArchived: 'Show archived',
  archive: 'Archive',
  unarchive: 'Unarchive',
  archived: 'Archived',
  archivedShort: 'Archived',
  archiveHint: 'Hide this closed group from the list; the record is kept and can be unarchived anytime',
  archivedAt: 'Archived at',
  emptyArchived: 'No active groups; tick "Show archived" to see archived records.',
  participants: 'Participants',
  messages: 'Messages',
  updated: 'Updated',
  groupPath: 'Mirror',
  detailLoading: 'Loading…',
  copyLabel: 'Copy',
  copiedLabel: 'Copied',
  codeLabel: 'Code',
  wrapLabel: 'Wrap lines',
  unwrapLabel: 'Unwrap lines',
  footnotes: 'Footnotes',
  renderFailed: 'Page render failed',
  detailEmpty: 'Select a discussion group to read it.',
  closeDetail: 'Close details',
  closeProposal: 'Close proposal',
  closedAt: 'Closed at',
  canceledBy: 'Proposal withdrawn',
  pending: 'Pending',
  confirmed: 'Confirmed',
  readonly: 'Closed · read-only',
  lock: 'Write lock',
  unlock: 'Release lock',
  remove: 'Remove from group',
  removeHint: 'Remove a lost participant from the confirmation set (human action, recorded in the transcript)',
  closePane: 'Close details',
  noGroup: 'This discussion group no longer exists',
  human: 'Local',
};

/** 客户端需要的服务；`layout` 用可选读取，避免在没有布局的宿主里整半静默。 */
const inject = ['slots', 'locale'];

/**
 * 调一次宿主路由。
 * @param endpoint - 端点名。
 * @param args - 参数。
 */
const call = async (endpoint, args) => {
  let response;
  try {
    response = await fetch('/discussion-plaza/' + endpoint, {
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
};

/** 状态 → 展示标签与 chip 的 data-status。 */
function statusMeta(group, t) {
  if (group.writing === true) return { key: 'writing', label: t('writing') };
  if (group.status === 'closing') return { key: 'closing', label: t('closing') };
  if (group.status === 'closed') return { key: 'closed', label: t('closed') };
  return { key: 'open', label: t('open') };
}

/** ISO → 本地短时间 `MM-DD HH:mm`。 */
function shortTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? '');
  const pad = (part) => String(part).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 参与者 / 锁持有者的展示名：工作区与名字相同时不重复。 */
function holderLabel(person) {
  if (person === undefined || person === null) return '';
  const workspace = String(person.workspace ?? '');
  const name = String(person.name ?? '');
  if (workspace.length === 0) return name;
  if (name.length === 0 || name === workspace) return workspace;
  return `${workspace} · ${name}`;
}

/*
 * 左下角角标 = **进行中的讨论组数**（open + closing），不是消息提醒/未读。
 * 对「人」来说，知道现在有几个活跃讨论组比逐条未读更有用；closed 不算。
 * 计数源是服务端 view 的 counts，页面与按钮共享同一个内存 store。
 */
const active = {
  count: 0,
  listeners: new Set(),
  set(count) {
    const next = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
    if (next === this.count) return;
    this.count = next;
    for (const listener of [...this.listeners]) listener();
  },
  subscribe(listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  },
};

/** 用一次 view 响应重算「进行中」数。 */
function updateActive(view) {
  const counts = view?.counts;
  if (counts !== undefined && counts !== null) {
    active.set((Number(counts.open) || 0) + (Number(counts.closing) || 0));
    return;
  }
  const groups = Array.isArray(view?.groups) ? view.groups : [];
  active.set(groups.filter((group) => group?.status !== 'closed').length);
}

/**
 * 左下角按钮：宽侧栏显示图标 + 文字，rail 只显示图标；进行中的讨论组带数字角标。
 * @param props.wide - 宿主给的列宽状态。
 * @param props.openPlaza - 打开面板。
 * @param props.t - 本地化函数。
 */
function PlazaButton({ wide, openPlaza, t }) {
  const [count, setCount] = useState(active.count);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void call('view').then(
        (view) => { if (live) updateActive(view); },
        () => { /* 读取失败不清零：保留上一次的计数 */ },
      );
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    const unsubscribe = active.subscribe(() => { if (live) setCount(active.count); });
    return () => { live = false; clearInterval(timer); unsubscribe(); };
  }, []);
  const badge = count > 0
    ? jsx('span', { className: 'dp-badge-count', children: count > 99 ? '99+' : String(count) }, 'badge')
    : null;
  const label = count > 0 ? t('activeHint') : t('title');
  return jsx('div', { className: 'dp-wrap' + (wide ? '' : ' dp-rail-wrap'), children: jsx('button', {
    type: 'button',
    className: 'dp-btn' + (wide ? '' : ' dp-rail'),
    'aria-label': label,
    title: label,
    onClick: openPlaza,
    children: [
      jsx(IconNewChatOutlineRegular, { size: wide ? 16 : 18 }, 'icon'),
      wide ? jsx('span', { className: 'dp-label', children: t('label') }, 'label') : null,
      badge,
    ],
  }, 'plaza-action') });
}

/**
 * 一条讨论组摘要。
 * @param props.group - 摘要。
 * @param props.selected - 是否正在查看。
 * @param props.onOpen - 打开回调。
 * @param props.t - 本地化函数。
 */
function GroupRow({ group, selected, onOpen, t }) {
  const meta = statusMeta(group, t);
  const info = [
    `${group.participantCount} ${t('participants')}`,
    `${group.messageCount} ${t('messages')}`,
    `${t('updated')} ${shortTime(group.updatedAt)}`,
  ].join(' · ');
  return jsxs('div', {
    className: 'dp-row',
    'data-selected': String(selected === true),
    role: 'button',
    tabIndex: 0,
    onClick: () => onOpen(group),
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpen(group);
      }
    },
    children: [
      jsx('span', { className: 'dp-chip', 'data-status': meta.key, children: meta.label }, 'chip'),
      jsxs('div', { className: 'dp-row-main', children: [
        jsxs('p', { className: 'dp-row-title', children: [
          group.archived === true ? jsx('span', { className: 'dp-archived', children: t('archivedShort') }, 'archived') : null,
          group.standing === true ? jsx('span', { className: 'dp-standing', children: t('standingShort') }, 'standing') : null,
          group.title,
        ] }, 'title'),
        jsx('p', { className: 'dp-row-id', children: group.id }, 'id'),
        jsx('p', { className: 'dp-row-meta', children: info }, 'meta'),
        group.writing === true && group.lock !== undefined
          ? jsx('p', { className: 'dp-row-lock', children: `${t('lock')} · ${holderLabel(group.lock.holder)}` }, 'lock')
          : null,
      ] }, 'main'),
    ],
  });
}

/**
 * 详情面板：状态、参与者（含关闭投票）、写锁、正文 Markdown 与人类恢复动作。
 * @param props.detail - `{ group, messages, markdown, path }`。
 * @param props.loading - 是否正在重读。
 * @param props.busy - 是否有动作在执行。
 * @param props.onClose - 收起详情。
 * @param props.onUnlock - 解除写锁。
 * @param props.onRemove - 移出参与者。
 * @param props.onStanding - 标记/取消长期讨论组。
 * @param props.onEndStanding - 人类结束长期讨论组。
 * @param props.onArchive - 归档/取消归档已关闭的讨论组。
 * @param props.t - 本地化函数。
 */
function DetailPane({ detail, loading, busy, onClose, onUnlock, onRemove, onStanding, onEndStanding, onArchive, t }) {
  const [confirmEnd, setConfirmEnd] = useState(false);
  if (detail === null) return null;
  const group = detail.group;
  const meta = statusMeta(group, t);
  const close = group.close;

  // 真实 MarkdownText 在渲染代码围栏 / 脚注时会读 labels.code / labels.footnotes；
  // 缺了 labels 时，只要详情里有一个 ``` 代码块就会抛错，整页变空白。
  const markdownLabels = useMemo(() => ({
    code: {
      copyLabel: t('copyLabel'),
      copiedLabel: t('copiedLabel'),
      toolbarLabels: {
        codeLabel: t('codeLabel'),
        wrapLabel: t('wrapLabel'),
        unwrapLabel: t('unwrapLabel'),
      },
    },
    footnotes: t('footnotes'),
  }), [t]);

  const standingSection = group.status === 'open'
    ? jsxs('div', { className: 'dp-section', children: [
      jsx('h3', { className: 'dp-section-title', children: t('standing') }, 'title'),
      jsxs('div', { className: 'dp-actions', children: [
        jsx('button', {
          type: 'button', className: 'dp-small-btn', disabled: busy ? true : undefined,
          onClick: () => onStanding(group.id, group.standing !== true),
          children: group.standing === true ? t('unmarkStanding') : t('markStanding'),
        }, 'toggle'),
        group.standing === true
          ? jsx('button', {
            type: 'button', className: 'dp-small-btn', disabled: busy ? true : undefined,
            title: t('endStandingHint'),
            onClick: () => {
              if (confirmEnd) { setConfirmEnd(false); onEndStanding(group.id); }
              else setConfirmEnd(true);
            },
            children: confirmEnd ? t('endStandingConfirm') : t('endStanding'),
          }, 'end')
          : null,
      ] }, 'actions'),
      group.standing === true ? jsx('p', { className: 'dp-kv', children: t('endStandingHint') }, 'hint') : null,
    ] }, 'standing-section')
    : null;

  // 同一工作区可能有多个会话，显示名会完全相同；补短 session 后缀区分。
  const displayLabel = (person) => {
    if (person === undefined || person === null) return '';
    const base = holderLabel(person);
    const duplicates = (Array.isArray(group.participants) ? group.participants : [])
      .filter((entry) => holderLabel(entry) === base).length;
    if (duplicates <= 1 || typeof person.sessionId !== 'string' || person.sessionId.length === 0) return base;
    return `${base} [${person.sessionId.replace(/^session-/, '').slice(0, 8)}]`;
  };

  const people = (Array.isArray(group.participants) ? group.participants : []).map((person) => {
    const vote = person.vote === 'confirm' ? 'confirm' : (group.status === 'closing' ? 'pending' : undefined);
    return jsxs('div', { className: 'dp-person', title: person.key, children: [
      jsx('span', { className: 'dp-person-name', children: displayLabel(person) }, 'name'),
      vote !== undefined
        ? jsx('span', { className: 'dp-badge', 'data-vote': vote, children: vote === 'confirm' ? t('confirmed') : t('pending') }, 'vote')
        : null,
      jsx('span', { className: 'dp-grow' }, 'grow'),
      group.status !== 'closed'
        ? jsx('button', {
          type: 'button',
          className: 'dp-small-btn',
          title: t('removeHint'),
          'aria-label': t('removeHint'),
          disabled: busy ? true : undefined,
          onClick: (event) => { event.stopPropagation(); onRemove(group.id, person.key ?? person.sessionId) },
          children: [jsx(IconTrashOutlineRegular, { size: 12 }, 'icon'), t('remove')],
        }, 'remove')
        : null,
    ] }, person.key ?? person.sessionId);
  });

  return jsxs('aside', { className: 'dp-side', children: [    jsxs('div', { className: 'dp-side-head', children: [
      jsxs('div', { className: 'dp-grow', children: [
        jsx('h2', { className: 'dp-side-title', children: group.title }, 'title'),
        jsx('p', { className: 'dp-row-id', children: group.id }, 'id'),
      ] }, 'titles'),
      group.standing === true ? jsx('span', { className: 'dp-standing', children: t('standingShort') }, 'standing') : null,
      group.archived === true ? jsx('span', { className: 'dp-archived', children: t('archivedShort') }, 'archived') : null,
      jsx('span', { className: 'dp-chip', 'data-status': meta.key, children: meta.label }, 'status'),
      jsx('button', {
        type: 'button', className: 'dp-icon-btn', title: t('closePane'), 'aria-label': t('closePane'),
        onClick: onClose,
        children: jsx(IconCloseOutlineRegular, { size: 15 }, 'icon'),
      }, 'close'),
    ] }, 'head'),
    jsxs('div', { className: 'dp-side-body', children: [
      group.status === 'closed'
        ? jsxs('div', { className: 'dp-section', children: [
          jsx('p', { className: 'dp-kv', children: t('readonly') }, 'readonly'),
          group.archived === true && typeof group.archivedAt === 'string'
            ? jsx('p', { className: 'dp-kv', children: `${t('archivedAt')} ${shortTime(group.archivedAt)}` }, 'archived-at')
            : null,
          jsxs('div', { className: 'dp-actions', children: [
            jsx('button', {
              type: 'button', className: 'dp-small-btn', disabled: busy ? true : undefined,
              title: t('archiveHint'),
              onClick: () => onArchive(group.id, group.archived !== true),
              children: group.archived === true ? t('unarchive') : t('archive'),
            }, 'archive'),
          ] }, 'actions'),
          jsx('p', { className: 'dp-kv', children: t('archiveHint') }, 'hint'),
        ] }, 'archive-section')
        : null,
      standingSection,
      jsxs('div', { className: 'dp-section', children: [
        jsx('h3', { className: 'dp-section-title', children: t('participants') }, 'title'),
        ...(people.length > 0 ? people : [jsx('p', { className: 'dp-kv', children: '—' }, 'none')]),
      ] }, 'people'),
      group.writing === true && group.lock !== undefined
        ? jsxs('div', { className: 'dp-section', children: [
          jsx('h3', { className: 'dp-section-title', children: t('lock') }, 'title'),
          jsxs('div', { className: 'dp-lock', children: [
            jsx(IconShieldOutlineRegular, { size: 14 }, 'icon'),
            jsx('span', { children: holderLabel(group.lock.holder) }, 'holder'),
            jsx('span', { children: `· ${shortTime(group.lock.expiresAt)}` }, 'expiry'),
            jsx('span', { className: 'dp-grow' }, 'grow'),
            jsx('button', {
              type: 'button', className: 'dp-small-btn', disabled: busy ? true : undefined,
              onClick: () => onUnlock(group.id),
              children: [jsx(IconShieldOutlineRegular, { size: 12 }, 'icon'), t('unlock')],
            }, 'unlock'),
          ] }, 'lock-row'),
        ] }, 'lock')
        : null,
      close !== undefined && close !== null
        ? jsxs('div', { className: 'dp-section', children: [
          jsx('h3', { className: 'dp-section-title', children: t('closeProposal') }, 'title'),
          (() => {
            const byPerson = typeof close.by === 'string'
              ? (group.participants ?? []).find((person) => person.key === close.by)
              : undefined
            const by = byPerson !== undefined
              ? displayLabel(byPerson)
              : (close.by === 'human' || close.by === '本机/human' ? t('human') : '')
            const reason = close.reason === undefined || close.reason === '' ? '—' : close.reason
            return jsx('p', { className: 'dp-kv', children: `${by.length > 0 ? `${by} · ` : ''}${shortTime(close.at)}${reason.length > 0 ? ` · ${reason}` : ''}` }, 'at')
          })(),
          close.canceledAt !== undefined
            ? jsx('p', { className: 'dp-kv', children: `${t('canceledBy')} · ${shortTime(close.canceledAt)}` }, 'canceled')
            : null,
          close.closedAt !== undefined
            ? jsx('p', { className: 'dp-kv', children: `${t('closedAt')} ${shortTime(close.closedAt)}` }, 'closed')
            : null,
        ] }, 'close')
        : null,
      jsxs('div', { className: 'dp-section', children: [
        jsx('h3', { className: 'dp-section-title', children: t('groupPath') }, 'title'),
        jsx('p', { className: 'dp-kv dp-mono', children: detail.path }, 'path'),
      ] }, 'path'),
      jsxs('div', { className: 'dp-section', children: [
        jsx('h3', { className: 'dp-section-title', children: t('messages') }, 'title'),
        loading === true && detail.markdown === undefined
          ? jsx('p', { className: 'dp-status', children: t('detailLoading') }, 'loading')
          : jsx('div', { className: 'dp-doc', children: jsx(MarkdownText, { text: String(detail.markdown ?? ''), labels: markdownLabels }) }, 'doc'),
      ] }, 'doc-section'),
    ] }, 'body'),
  ] });
}

/**
 * 广场整页。
 * @param props.t - 本地化函数。
 */
function PlazaPage({ t }) {
  const [view, setView] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [intro, setIntro] = useState('');
  const [formStanding, setFormStanding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const alive = useRef(true);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  useEffect(() => () => { alive.current = false }, []);

  const loadView = useCallback(async () => {
    try {
      const next = await call('view');
      if (alive.current) { setView(next); setError(''); updateActive(next); }
    } catch (cause) {
      if (alive.current) setError(String(cause?.message ?? cause));
    }
  }, []);

  useEffect(() => {
    void loadView();
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void loadView();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadView]);

  const loadDetail = useCallback(async (id) => {
    if (id === null) { setDetail(null); return; }
    setLoadingDetail(true);
    try {
      const next = await call('detail', { id });
      if (alive.current && selectedRef.current === id) {
        setDetail(next);
        setError('');
      }
    } catch (cause) {
      if (alive.current && selectedRef.current === id) setError(String(cause?.message ?? cause));
    } finally {
      if (alive.current && selectedRef.current === id) setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    void loadDetail(selectedId);
    if (selectedId === null) return undefined;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void loadDetail(selectedId);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [selectedId, loadDetail]);

  const submit = (event) => {
    if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault();
    const clean = title.trim();
    if (busy || clean.length === 0) return;
    setBusy(true);
    void Promise.resolve()
      .then(() => call('create', { title: clean, intro: intro.trim(), standing: formStanding }))
      .then(async (created) => {
        setFormOpen(false);
        setTitle('');
        setIntro('');
        setFormStanding(false);
        await loadView();
        setSelectedId(created.id);
      })
      .catch((cause) => { setError(String(cause?.message ?? cause)); })
      .finally(() => { setBusy(false); });
  };

  const unlock = (id) => {
    if (busy) return;
    setBusy(true);
    void Promise.resolve()
      .then(() => call('unlock', { id }))
      .then(() => loadDetail(id))
      .catch((cause) => { setError(String(cause?.message ?? cause)); })
      .finally(() => { setBusy(false); });
  };

  const remove = (id, key) => {
    if (busy) return;
    setBusy(true);
    void Promise.resolve()
      .then(() => call('remove-participant', { id, key }))
      .then(() => Promise.all([loadView(), loadDetail(id)]))
      .catch((cause) => { setError(String(cause?.message ?? cause)); })
      .finally(() => { setBusy(false); });
  };

  /** 人类标记 / 取消长期讨论组。 */
  const toggleStanding = (id, standing) => {
    if (busy) return;
    setBusy(true);
    void Promise.resolve()
      .then(() => call('set-standing', { id, standing }))
      .then(() => Promise.all([loadView(), loadDetail(id)]))
      .catch((cause) => { setError(String(cause?.message ?? cause)); })
      .finally(() => { setBusy(false); });
  };

  /** 人类结束长期讨论组（直接关闭，只读）。 */
  const endStanding = (id) => {
    if (busy) return;
    setBusy(true);
    void Promise.resolve()
      .then(() => call('close-standing', { id }))
      .then(() => Promise.all([loadView(), loadDetail(id)]))
      .catch((cause) => { setError(String(cause?.message ?? cause)); })
      .finally(() => { setBusy(false); });
  };

  /** 人类归档 / 取消归档已关闭的讨论组（只是展示状态，不删除记录）。 */
  const archive = (id, archived) => {
    if (busy) return;
    setBusy(true);
    void Promise.resolve()
      .then(() => call('archive', { id, archived }))
      .then(() => Promise.all([loadView(), loadDetail(id)]))
      .catch((cause) => { setError(String(cause?.message ?? cause)); })
      .finally(() => { setBusy(false); });
  };

  const groups = view !== null && Array.isArray(view.groups) ? view.groups : [];
  const visibleGroups = showArchived ? groups : groups.filter((group) => group.archived !== true);

  return jsxs('div', { className: 'dp-page', children: [
    jsxs('header', { className: 'dp-head', children: [
      jsx('h1', { className: 'dp-title', children: t('panelTitle') }, 'title'),
      jsx('span', { className: 'dp-sub', children: `${t('sub')} · ${visibleGroups.length}` }, 'sub'),
      jsx('span', { className: 'dp-grow' }, 'grow'),
      jsxs('label', { className: 'dp-check', title: t('archiveHint'), children: [
        jsx('input', {
          type: 'checkbox', checked: showArchived,
          onChange: (event) => setShowArchived(event.target.checked),
        }, 'box'),
        t('showArchived'),
      ] }, 'show-archived'),
      jsx('button', {
        type: 'button', className: 'dp-icon-btn', title: t('refresh'), 'aria-label': t('refresh'),
        onClick: () => { void loadView(); },
        children: jsx(IconRefreshOutlineRegular, { size: 15 }, 'icon'),
      }, 'refresh'),
      jsxs('button', {
        type: 'button', className: 'dp-primary',
        onClick: () => setFormOpen((open) => !open),
        children: [
          jsx(IconPlusOutlineRegular, { size: 14 }, 'icon'),
          t('create'),
        ],
      }, 'create'),
    ] }, 'head'),
    formOpen
      ? jsx('form', { className: 'dp-form', onSubmit: submit, children: [
        jsx('input', {
          className: 'dp-input', value: title, placeholder: t('titlePlaceholder'),
          'aria-label': t('titlePlaceholder'), onChange: (event) => setTitle(event.target.value),
        }, 'title'),
        jsx('textarea', {
          className: 'dp-textarea', value: intro, placeholder: t('introPlaceholder'),
          'aria-label': t('introPlaceholder'), onChange: (event) => setIntro(event.target.value),
        }, 'intro'),
        jsxs('label', { className: 'dp-check', children: [
          jsx('input', {
            type: 'checkbox', checked: formStanding,
            onChange: (event) => setFormStanding(event.target.checked),
          }, 'box'),
          t('createStanding'),
        ] }, 'standing'),
        jsxs('div', { className: 'dp-form-foot', children: [
          jsx('button', { type: 'button', className: 'dp-ghost', onClick: () => setFormOpen(false), children: t('cancel') }, 'cancel'),
          jsx('button', { type: 'submit', className: 'dp-primary', disabled: busy || title.trim().length === 0 ? true : undefined, children: busy ? t('busy') : t('submit') }, 'submit'),
        ] }, 'foot'),
      ] }, 'form')
      : null,
    error.length > 0 ? jsx('p', { className: 'dp-error', role: 'alert', children: error }, 'error') : null,
    jsxs('div', { className: 'dp-body', children: [
      jsx('div', { className: 'dp-list', children: visibleGroups.length === 0
        ? jsx('p', {
          className: 'dp-empty',
          children: view === null ? t('detailLoading') : (groups.length > 0 ? t('emptyArchived') : t('empty')),
        }, 'empty')
        : visibleGroups.map((group) => jsx(GroupRow, {
          group,
          selected: group.id === selectedId,
          onOpen: (target) => setSelectedId(target.id),
          t,
        }, group.id)) }, 'list'),
      selectedId === null
        ? null
        : (detail === null || detail.group === undefined
          ? jsx('aside', { className: 'dp-side', children: jsxs('div', { className: 'dp-side-head', children: [
            jsx('span', { className: 'dp-grow' }, 'grow'),
            jsx('button', {
              type: 'button', className: 'dp-icon-btn', title: t('closePane'), 'aria-label': t('closePane'),
              onClick: () => setSelectedId(null),
              children: jsx(IconCloseOutlineRegular, { size: 15 }, 'icon'),
            }, 'close'),
          ] }, 'head') }, 'empty-side')
          : jsx(DetailPane, {
            detail,
            loading: loadingDetail,
            busy,
            onClose: () => setSelectedId(null),
            onUnlock: unlock,
            onRemove: remove,
            onStanding: toggleStanding,
            onEndStanding: endStanding,
            onArchive: archive,
            t,
          }, 'detail-' + detail.group.id)),
    ] }, 'body'),
  ] });
}

/**
 * 页面级错误边界：客户端插件没有自动边界，任一渲染异常（比如缺 labels 的
 * MarkdownText）都会让整个 main 面板变空白。至少把错误显示出来，方便定位。
 */
class PageBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error === null || this.state.error === undefined) return this.props.children;
    const message = String(this.state.error?.message ?? this.state.error);
    const title = typeof this.props.t === 'function' ? this.props.t('renderFailed') : 'Page render failed';
    return jsx('div', { className: 'dp-page', children: jsx('p', {
      className: 'dp-error',
      role: 'alert',
      children: `${title}: ${message}`,
    }, 'render-error') });
  }
}

/** `main` 槽的入口：把整页包在错误边界里。 */
function PlazaPanel(props) {
  return jsx(PageBoundary, { t: props.t, children: jsx(PlazaPage, props) });
}

/**
 * 客户端入口：字典 + 左下按钮 + 中列整页。
 * @param ctx - 客户端上下文。
 */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'discussion-plaza: dictionaries');
  const t = ctx.locale.bind(NS);

  /** 打开广场面板；main 座位还没声明时忽略这次点击（下一次点击会成功）。 */
  const openPlaza = () => {
    let layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined;
    if (layout === undefined || layout === null) {
      // 兼容没有 `get` 或服务名不同的客户端上下文：这是可选依赖，不能让它抛到点击处理外。
      try { layout = ctx.layout; } catch { layout = undefined; }
    }
    if (layout === undefined || layout === null || typeof layout.selectPanel !== 'function') return;
    try {
      layout.selectPanel(PANEL_ID);
    } catch {
      /* main 面板尚未注册：忽略 */
    }
  };

  // 左下按钮：与「临时会话」同一排座位（footerActions 是 flex 行）。
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: PANEL_ID,
    order: 20,
    locale: NS,
    inject: () => ({ openPlaza }),
  }, PlazaButton));

  // 中列整页：key 必须与 PANEL_ID 逐字一致，layout.selectPanel 才能找到它。
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, PlazaPanel));
}

(function () {
  if (typeof document === 'undefined') return;
  const tagId = PLUGIN_ID + '/discussion-plaza.css';
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = PLUGIN_ID;
  tag.dataset.pluginCss = tagId;
  tag.textContent = CSS;
  document.head.appendChild(tag);
})();

module.exports = { apply, inject, NS };
return module.exports;
}});
