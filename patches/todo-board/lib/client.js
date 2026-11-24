/**
 * todo-board 的浏览器半。
 *
 * 两个贡献点，是宿主里「左侧导航行 + 中列整页」这一对**成对座位**：
 *   1. `sidebar.panellist` —— 左侧边栏导航区（插件 / 自动化任务 / 记忆 那一组）里的
 *      一行「工作清单」。宿主自己的 `PanelRow` 负责按钮、点击、`aria-current` 与
 *      「更多」排在其后，插件只交一颗 glyph，不自己造按钮、不自己调 `selectPanel`。
 *   2. `main` —— 点这一行之后占用中列整页的面板。
 *
 * 为什么必须是这一对：宿主点面板行时调 `layout.selectPanel(id)`，它按 `options.key`
 * 在 `main` 槽里找 entry，对不上就直接抛
 * `layout.selectPanel: main panel "x" is not registered`
 * （`ui-layout/src/client/service.ts:74`）。所以侧栏的 `id` 与 `main` 的 `key` 必须
 * 逐字相同，且 `main` 要**无条件**注册 —— 布局里存着 `activePanelId="todo-board"`
 * 时会话恢复就要用上它。
 *
 * 详情页是**整页自己的右侧栏**，不是平台右侧边栏的 tab。平台的
 * `ui-sidebar-right` 只在「中列显示会话」时有 on-screen session：
 * `client/index.ts` 里 `show(activePanelId === null ? selectedSession : undefined)`，
 * `RightbarRoot` 也在 `activePanelId !== null` 时隐藏会话内容。本补丁的清单本身
 * 就是那个 `main` 面板，所以 `sidebarRight.openTab()` 在这里必然抛
 * `sidebarRight: no session surface is mounted` —— 这条路上没有可用的 tab 座位。
 * 详情改成页内右侧一栏：留在清单里、用平台的 `MarkdownText` 渲染、
 * 与三份镜像同源（`renderItemDoc`），也就不再随宿主的右栏语义漂移。
 *
 * 面板只通过宿主 `/todo-board` 前缀路由读写，不缓存任何"可能会过期"的状态：
 * 每次动作之后重新 `view`，因为同一份清单可能正被**另一个工作区的会话**通过
 * 工具改写。
 *
 * 手写客户端 bundle 契约（无构建步骤）：只 require 平台种子模块 —— `react`、
 * `react/jsx-runtime` 与 `@deepseek-ai/dsh-client-ui-primitives` 的图标。
 */
window.__ModuleLoader__.load({ id: '@local/dsh-todo-board', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useCallback, useEffect, useMemo, useRef, useState } = React;
const { jsx, jsxs } = require('react/jsx-runtime');
const {
  IconChecklistOutlineRegular,
  IconRefreshOutlineRegular,
  IconPlusOutlineRegular,
  IconCheckOutlineRegular,
  IconArchiveOutlineRegular,
  IconCloseOutlineRegular,
  MarkdownText,
} = require('@deepseek-ai/dsh-client-ui-primitives');

const PLUGIN_ID = '@local/dsh-todo-board';
const NS = 'sidebar.todoBoard';
/* 侧栏行的 id 与 main 的 key 必须逐字相同，见文件头注释。 */
const PANEL_ID = 'todo-board';
/* 详情栏宽度的记忆键：拖过一次之后，下次打开还是那个宽度。 */
const DETAIL_WIDTH_KEY = 'todo-board.detailWidth';
const DETAIL_MIN_WIDTH = 260;
const DETAIL_MAX_WIDTH = 720;

/**
 * 把宽度夹进可用的范围。上限还要让列表留出至少 `reserve` 像素，否则拖到最宽
 * 时列表会被挤成一条线。
 * @param value - 期望宽度（px）。
 * @param reserve - 列表至少要留下的宽度（px）；省略时用固定上限。
 */
function clampDetailWidth(value, reserve) {
  const cap = typeof reserve === 'number' && Number.isFinite(reserve)
    ? Math.max(DETAIL_MIN_WIDTH, Math.min(DETAIL_MAX_WIDTH, Math.round(reserve)))
    : DETAIL_MAX_WIDTH;
  return Math.max(DETAIL_MIN_WIDTH, Math.min(cap, Math.round(value)));
}

/**
 * 读出上次拖出来的宽度。读不到、坏值、或宿主禁用了 localStorage 时返回 null，
 * 调用方回落到 CSS 里的默认宽度。
 */
function readSavedDetailWidth() {
  try {
    const raw = window.localStorage.getItem(DETAIL_WIDTH_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? clampDetailWidth(value) : null;
  } catch {
    return null;
  }
}

/**
 * 记住宽度。存不进去不是错误（隐私模式 / 配额满），下次用默认宽度而已。
 * @param value - 宽度（px）。
 */
function saveDetailWidth(value) {
  try {
    window.localStorage.setItem(DETAIL_WIDTH_KEY, String(Math.round(value)));
  } catch {
    /* 记不住就算了：它只是体验偏好，不影响详情栏本身。 */
  }
}

/**
 * 忘掉拖出来的宽度，回到 CSS 的默认比例。
 */
function clearSavedDetailWidth() {
  try {
    window.localStorage.removeItem(DETAIL_WIDTH_KEY);
  } catch {
    /* 同 saveDetailWidth：记不住不影响功能。 */
  }
}

/*
 * 侧栏那颗 dot 与中列整页是两个独立注册，各自 mount：页面里写完之后要让侧栏重新
 * 读一次未办数，否则那颗点会一直停在打开前的状态。
 */
const changes = {
  listeners: new Set(),
  emit() { for (const listener of changes.listeners) listener() },
  subscribe(listener) {
    changes.listeners.add(listener)
    return () => { changes.listeners.delete(listener) }
  },
};

const CSS = [
  /* 侧栏行里的 glyph：宿主自己的 PanelRow 已给出行高、圆角与 hover，这里只做定位。 */
  '.tb-glyph{position:relative;display:inline-flex;align-items:center;justify-content:center}',
  '.tb-dot{position:absolute;top:-2px;right:-3px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary)}',

  /* 中列整页：占满 main 列，头部固定、正文自己滚。 */
  '.tb-page{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;padding:0 clamp(16px,3vw,40px);color:var(--dsw-alias-label-primary)}',
  '.tb-page > *{flex:none}',
  '.tb-head{display:flex;align-items:center;gap:10px;padding:22px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
  '.tb-title{font-size:17px;font-weight:600;margin:0}',
  '.tb-sub{color:var(--dsw-alias-label-tertiary);font-size:12px}',
  '.tb-grow{flex:1 1 auto;min-width:0}',
  '.tb-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
  '.tb-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.tb-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',

  '.tb-toolbar{display:flex;align-items:center;gap:8px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
  '.tb-tabs{display:flex;gap:4px}',
  '.tb-tab{border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:20px;padding:3px 10px;cursor:pointer}',
  '.tb-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.tb-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-weight:600}',
  '.tb-input{height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;padding:0 8px;min-width:0}',
  '.tb-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
  '.tb-search{width:180px}',
  /* 「一键归档」：两段式按钮，第二段（确认态）用错误色，避免误触清空整页。 */
  '.tb-action{flex:none;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;cursor:pointer}',
  '.tb-action:hover{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
  '.tb-action[data-armed="true"]{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}',
  '.tb-action[disabled]{opacity:.5;cursor:default}',

  /*
   * 正文区是两栏：左列列表自己滚，右列详情栏固定宽度。详情栏不是平台右侧边栏
   * （那一列在整页面板激活时不存在），见文件头注释。
   */
  '.tb-body{flex:1 1 auto;min-height:0;min-width:0;display:flex;align-items:stretch}',
  '.tb-list{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;padding:8px 0 20px}',
  '.tb-side{position:relative;flex:none;display:flex;flex-direction:column;width:clamp(300px,32%,440px);min-width:0;min-height:0;overflow:hidden;border-left:1px solid var(--dsw-alias-border-l2);padding:10px 0 18px 16px}',
  /*
   * 详情栏左边缘的拖拽手柄。命中区比可见线宽：5px 的线很难点中，所以手柄做成
   * 9px 宽、可见线居中；悬停 / 拖动时用品牌色，让"这里能拖"是看得见的。
   */
  '.tb-side-resize{position:absolute;top:0;bottom:0;left:-4px;width:9px;cursor:col-resize;touch-action:none;z-index:3}',
  '.tb-side-resize::after{content:"";position:absolute;top:0;bottom:0;left:4px;width:1px;background:transparent;transition:background .12s ease}',
  '.tb-side-resize:hover::after,.tb-side-resize[data-dragging="true"]::after{background:var(--dsw-alias-brand-primary)}',
  '.tb-side-head{flex:none;display:flex;align-items:center;gap:8px;padding:0 2px 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
  '.tb-side-title{font-size:13px;font-weight:600;margin:0}',
  '.tb-side-body{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 2px 0}',
  '.tb-side-body .markdown{font-size:13px;line-height:1.65}',
  '.tb-side-status{margin:0;padding:20px 4px;color:var(--dsw-alias-label-tertiary);font-size:13px}',
  '.tb-side-error{margin:0;padding:20px 4px;color:var(--dsw-alias-state-error-primary);font-size:13px}',
  /*
   * 窄窗口放不下两栏时，详情栏盖在列表上（右侧抽屉）。给它一个不透明底，否则
   * 列表文字会从下面透出来。
   */
  '@media (max-width:860px){.tb-body{position:relative}.tb-side{position:absolute;inset:0 0 0 auto;width:min(92%,420px);z-index:2;background:var(--dsw-alias-bg-layer-1);padding:10px 12px 18px 14px}.tb-side-resize{display:none}}',
  '.tb-empty{padding:28px 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}',
  /*
   * 行首有两列数字，语义不同，不要合并：
   * `tb-index` 是这份可见列表里的位置（1 起，切 tab / 搜索后重排），
   * `tb-num` 是创建时分配的稳定引用编号（`#N`，与镜像同源，允许空洞）。
   * 位置序号刻意做得更小、更淡、不带 `#`：这样"第几条"和"引用哪一条"一眼分得开，
   * 不会再把 `#15` 误读成列表的第 15 行。
   * `user-select:none`: 复制标题时不该把这列粘进去。
   */
  '.tb-index{flex:none;min-width:20px;margin-top:2px;text-align:right;font-family:var(--ds-font-family-code);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption);user-select:none}',
  '.tb-row{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border-radius:10px;border:1px solid transparent;cursor:pointer}',
  /*
   * 引用编号 `#N`：对齐 Markdown 一级标题的字号（主题里 `--dsw-font-markdown-h1` 是
   * 700 21px/30px，见 ui-theme/src/styles/gradient-shadow-text.css:65），这样它
   * 才是行首的视觉锚点，而不是一行小灰字。行高收到 26px 是为了不让每条行被
   * 撑高太多；`tabular-nums` 让 #1 / #10 / #100 的数字位对齐。
   *
   * `margin-top:-5px` 是基线对齐：21px/26px 的首行基线在块内约 19px 处，
   * 13px/20px 的标题在约 14px 处，差 5px —— 不补的话数字会整体坐低，
   * 看起来像另起一行。
   */
  '.tb-num{flex:none;min-width:52px;margin-top:-5px;text-align:right;font-family:var(--ds-font-family-code);font-size:21px;line-height:26px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}',
  '.tb-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.tb-row[data-kind="done"] .tb-row-title{color:var(--dsw-alias-label-secondary)}',
  /* 详情栏正开着的那一条：与 hover 同一个底色，但常驻。 */
  '.tb-row[data-selected="true"]{background:var(--dsw-alias-bg-layer-3)}',
  '.tb-badge{flex:none;margin-top:1px;padding:1px 7px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;white-space:nowrap}',
  '.tb-badge[data-kind="done"]{background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary-foreground)}',
  '.tb-badge[data-kind="branch"]{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}',
  '.tb-row-main{flex:1 1 auto;min-width:0}',
  '.tb-row-title{font-size:13px;line-height:20px;word-break:break-word;margin:0}',
  '.tb-row-meta{margin:2px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);font-family:var(--ds-font-family-code)}',
  '.tb-row-title[data-detail="true"]{cursor:pointer}',
  /* 整行都是打开详情的命中区，所以高亮跟着行的 hover 走，而不是只跟着标题。 */
  '.tb-row:hover .tb-row-title[data-detail="true"]{color:var(--dsw-alias-brand-primary)}',
  '.tb-detail{min-width:0;color:var(--dsw-alias-label-primary)}',
  '.tb-row-actions{flex:none;display:flex;gap:2px;opacity:0;pointer-events:none}',
  /*
   * 动作按钮只在悬停 / 键盘聚焦时出现并接收指针：不这样，透明按钮仍会吃掉
   * 行右侧那一小块点击，用户点卡片却什么都没发生。
   */
  '.tb-row:hover .tb-row-actions,.tb-row:focus-within .tb-row-actions{opacity:1;pointer-events:auto}',

  '.tb-add{display:flex;gap:8px;align-items:center;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
  '.tb-add-input{flex:1 1 240px}',
  '.tb-select{height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;padding:0 6px}',
  '.tb-primary{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border:none;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-family:inherit;font-size:12px;cursor:pointer}',
  '.tb-primary[disabled]{opacity:.5;cursor:default}',
  '.tb-error{margin:0;padding:8px 0;color:var(--dsw-alias-state-error-primary);font-size:12px;border-top:1px solid var(--dsw-alias-border-l2)}',
].join('');

const zh = {
  label: '工作清单',
  title: '打开跨项目待办 / 已办 / 功能分支清单（所有工作区共享）',
  panelTitle: '工作清单',
  filterTodo: '待办',
  filterDone: '已办',
  filterBranch: '功能分支',
  search: '搜索标题、正文…',
  refresh: '重新读取',
  empty: '这份清单还是空的 —— 让模型用 workboard_add 记一条，或在下面直接新增。',
  addPlaceholder: '新增一条待办…',
  add: '新增',
  addKindTodo: '待办',
  addKindDone: '已办',
  addKindBranch: '功能分支',
  complete: '标记完成',
  archive: '归档',
  archiveAll: '一键归档',
  archiveAllConfirm: '确认归档',
  archiveAllHint: '把「已办」里所有条目归档（软删除：从列表与镜像消失，仍可在 board.json 中查回）',
  sections: '正文小节',
  error: '读取失败',
  busy: '处理中…',
  detailTitle: '详情',
  detailClose: '关闭详情',
  detailResize: '拖动调整详情栏宽度（双击恢复默认）',
  detailReset: '恢复默认宽度',
  detailLoading: '正在读取…',
  detailMissing: '这条事项已经不在了。',
  copyLabel: '复制',
  copiedLabel: '已复制',
  codeLabel: '代码',
  wrapLabel: '自动换行',
  unwrapLabel: '取消换行',
  footnotes: '脚注',
};

const en = {
  label: 'Work board',
  title: 'Open the cross-project TODO / DONE / feature-branch board (shared by every workspace)',
  panelTitle: 'Work board',
  filterTodo: 'TODO',
  filterDone: 'DONE',
  filterBranch: 'Branches',
  search: 'Search titles and bodies…',
  refresh: 'Reload',
  empty: 'The board is empty — ask the agent to run workboard_add, or add one below.',
  addPlaceholder: 'Add a TODO…',
  add: 'Add',
  addKindTodo: 'TODO',
  addKindDone: 'DONE',
  addKindBranch: 'Branch',
  complete: 'Complete',
  archive: 'Archive',
  archiveAll: 'Archive all',
  archiveAllConfirm: 'Confirm archive',
  archiveAllHint: 'Archive every DONE item (soft delete: it leaves the list and mirrors, and stays queryable in board.json)',
  sections: 'Body sections',
  error: 'Load failed',
  busy: 'Working…',
  detailTitle: 'Details',
  detailClose: 'Close details',
  detailResize: 'Drag to resize the detail column (double-click to reset)',
  detailReset: 'Reset width',
  detailLoading: 'Loading…',
  detailMissing: 'This item is gone.',
  copyLabel: 'Copy',
  copiedLabel: 'Copied',
  codeLabel: 'Code',
  wrapLabel: 'Wrap lines',
  unwrapLabel: 'Unwrap lines',
  footnotes: 'Footnotes',
};

/** 需要槽位与语言包：中列整页由宿主的 main 槽渲染，行文字跟随当前语言。 */
const inject = ['slots', 'locale'];

/**
 * 一次 `/todo-board` 调用。同源 POST + JSON，宿主路由的围栏要求如此；
 * 返回体是 `{ ok, value }` 信封，失败时把机器可读的 code 挂在 Error 上。
 * @param endpoint - 端点名。
 * @param args - 参数。
 */
const call = async (endpoint, args) => {
  let response;
  try {
    response = await fetch('/todo-board/' + endpoint, {
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
 * 侧栏导航行里的 glyph。宿主自己渲染按钮与标签，这里只交图标；有未办事项时
 * 右上角加一颗点（行内空间只有 16/18px，放不下数字，数字在整页头部）。
 * @param props.size - 宿主请求的边长。
 */
function BoardGlyph({ size }) {
  const [pending, setPending] = useState(null);

  useEffect(() => {
    let live = true;
    const read = () => {
      void call('view').then(
        (view) => { if (live) setPending(view?.summary?.counts?.todo ?? 0) },
        () => { if (live) setPending(null) },
      );
    };
    read();
    // 整页里新增/完成之后会广播一次；不订阅的话这颗点会停在打开前的状态。
    const stop = changes.subscribe(read);
    return () => { live = false; stop() };
  }, []);

  return jsxs('span', { className: 'tb-glyph', children: [
    jsx(IconChecklistOutlineRegular, { size: size ?? 16 }, 'icon'),
    typeof pending === 'number' && pending > 0 ? jsx('span', { className: 'tb-dot' }, 'dot') : null,
  ] });
}

/**
 * 当前是否选中了一段文字。行上的点击要放它一马：用户拖着标题选一段路径去复制时，
 * 不该顺手把详情栏弹出来。
 */
function hasTextSelection() {
  try {
    const selection = window.getSelection();
    return selection !== null && typeof selection.toString === 'function' && selection.toString().length > 0;
  } catch {
    return false;
  }
}

/**
 * 一条事项：序号列 + 引用编号 + 状态 + 标题行 + 元信息 + 动作。
 *
 * 正文不在这里展开 —— 点这一条的任意位置会在整页右侧的详情栏里渲染同一份 Markdown，
 * 因为事项正文里本来就写着 `**背景**`、表格、代码块与反引号路径，用 `white-space:
 * pre-wrap` 当纯文本陈列等于把这些语法原样丢给用户看。
 * @param props.item - 事项。
 * @param props.index - 在当前可见列表里的位置（1 起，仅用于显示）。
 * @param props.selected - 是否正开着它的详情。
 * @param props.onComplete - 完成回调。
 * @param props.onArchive - 归档回调。
 * @param props.onOpen - 打开详情回调。
 * @param props.t - 本地化函数。
 */
function ItemRow({ item, index, selected, onComplete, onArchive, onOpen, t }) {
  const sections = item.sections ?? {};
  const names = Object.keys(sections);
  const badge = item.kind === 'done' ? '✅' : (item.kind === 'branch' ? (item.module ?? '分支') : (item.status || 'TODO'));
  // 元信息保持一行：来源项目 + 模块 + 日期 + 功能分支标记。项目仍然留在这里
  // （跨项目清单需要知道一条事项从哪来），去掉的是它作为**分组标题**的那一份 ——
  // 同一个名字在每组上方再写一遍纯属重复。
  const meta = [item.project, item.module, item.date, item.flags === undefined ? null : flagText(item.flags)].filter((part) => typeof part === 'string' && part.length > 0).join(' · ');

  return jsxs('div', {
    className: 'tb-row',
    'data-kind': item.kind,
    'data-selected': String(selected === true),
    // 整张卡片都是打开详情的命中区（不再只有标题那几个字）；行内的动作按钮自己
    // stopPropagation，拖选文字时也不当作点击。
    onClick: () => {
      if (hasTextSelection()) return;
      onOpen(item);
    },
    children: [
      // 位置序号：当前可见列表里的第几条（切 tab / 搜索后会重新从 1 排）。
      // 与右边那个 `#N` 是两种东西：一个讲"排第几"，一个讲"引用哪一条"。
      jsx('span', { className: 'tb-index', 'aria-hidden': 'true', children: String(index) }, 'index'),
      // 引用编号：创建时分配的稳定编号（删除/完成后不回填，允许空洞），
      // 与 Markdown 镜像里的编号同源（`item.number`）。
      jsx('span', { className: 'tb-num', title: '#' + String(item.number ?? '?'), children: '#' + String(item.number ?? '?') }, 'num'),
      jsx('span', { className: 'tb-badge', 'data-kind': item.kind, children: badge }, 'badge'),
      jsxs('div', { className: 'tb-row-main', children: [
        jsx('p', {
          className: 'tb-row-title',
          'data-detail': 'true',
          role: 'button',
          tabIndex: 0,
          // 鼠标点击交给行容器处理（标题 -> 行 -> onOpen）；这里只留键盘入口。
          onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(item) } },
          children: item.title,
        }, 'title'),
        meta.length > 0 ? jsx('p', { className: 'tb-row-meta', children: meta }, 'meta') : null,
        names.length > 0
          ? jsx('p', { className: 'tb-row-meta', children: t('sections') + '：' + names.join(' / ') }, 'secnames')
          : null,
      ] }, 'main'),
      jsxs('div', { className: 'tb-row-actions', children: [
        item.kind === 'todo'
          ? jsx('button', {
              type: 'button', className: 'tb-icon-btn', title: t('complete'), 'aria-label': t('complete'),
              // 动作按钮不能把点击冒泡给行容器：完成一条不该顺手打开它的详情。
              onClick: (event) => { event.stopPropagation(); onComplete(item) },
              children: jsx(IconCheckOutlineRegular, { size: 15 }),
            }, 'complete')
          : null,
        jsx('button', {
          type: 'button', className: 'tb-icon-btn', title: t('archive'), 'aria-label': t('archive'),
          onClick: (event) => { event.stopPropagation(); onArchive(item) },
          children: jsx(IconArchiveOutlineRegular, { size: 15 }),
        }, 'archive'),
      ] }, 'actions'),
    ],
  });
}

/**
 * 功能分支标记显示名。`Nacos` 是产品名，大写会写错。
 */
const FLAG_LABEL = { ddl: 'DDL', sql: 'SQL', nacos: 'Nacos' }

/**
 * 功能分支标记的短文本：`DDL+SQL` / `无DDL`。
 * @param flags - `{ ddl, sql, nacos }`。
 */
function flagText(flags) {
  const parts = []
  for (const name of ['ddl', 'sql', 'nacos']) {
    // 不能一律 toUpperCase：`Nacos` 是产品名，`NACOS` 在源文档里不存在。
    parts.push((flags?.[name] === true ? '' : '无') + FLAG_LABEL[name])
  }
  return parts.join(' ')
}

/**
 * 中列整页：清单本体。
 * @param props.t - 本地化函数（`locale: NS` 给的座椅）。
 */
function BoardPage({ t }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 三个 tab 就是三种清单：待办 / 已办 / 功能分支。默认停在「待办」——
  // 「全部」那一档在没有项目分组之后只是把三类混在一条流里，反而更难找。
  const [kind, setKind] = useState('todo');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [draftKind, setDraftKind] = useState('todo');
  // 详情栏正开着的那一条；null 表示详情栏收起。只存 id：正文由 DetailPane
  // 自己去 `/todo-board/detail` 取，清单刷新时不必把正文再搬一遍。
  const [selectedId, setSelectedId] = useState(null);
  // 「一键归档」的两段式确认态：第一下只亮按钮，第二下才真正落到宿主。
  const [archiveAllArmed, setArchiveAllArmed] = useState(false);
  // 详情栏宽度：null = 还没拖过，交给 CSS 的 clamp(300px,32%,440px) 随窗口缩放；
  // 拖过之后是固定 px，并记进 localStorage（下次打开还是这个宽度）。
  const [sideWidth, setSideWidth] = useState(() => readSavedDetailWidth());
  const [resizing, setResizing] = useState(false);
  // 列表 + 详情栏的容器：拖拽时用它算「列表至少要留多宽」。
  const bodyRef = useRef(null);
  const sideWidthRef = useRef(sideWidth);
  sideWidthRef.current = sideWidth;
  const dragStopRef = useRef(null);

  const reload = useCallback(async () => {
    try {
      const next = await call('view');
      setView(next);
      setError('');
      changes.emit();
    } catch (cause) {
      setError(String(cause?.message ?? cause));
    }
  }, []);

  useEffect(() => { void reload() }, [reload]);

  // 一键归档的确认态：切 tab 时收起，5 秒内没再点也收起——这个按钮会清空整个
  // 「已办」tab，不能让「点过一次」永久留在武装状态。
  useEffect(() => { setArchiveAllArmed(false) }, [kind]);
  useEffect(() => {
    if (archiveAllArmed === false) return undefined;
    const timer = setTimeout(() => setArchiveAllArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [archiveAllArmed]);

  const items = view?.items ?? [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      // 三个 tab 就是三个 kind，没有「全部」这一档。
      if (item.kind !== kind) return false;
      if (needle.length === 0) return true
      const haystack = [item.title, item.project, item.module, item.status, ...Object.values(item.sections ?? {})]
        .filter((part) => typeof part === 'string')
        .join('\n')
        .toLowerCase()
      return haystack.includes(needle)
    })
  }, [items, kind, query]);

  /*
   * 不再按项目分组：这是**跨项目**清单，项目名当分组标题等于把一个横切的
   * 维度竖着摆回去，每个 tab 里还会被切成一堆只有一两行的块（用户明确要求去掉）。
   * 项目仍留在每行的元信息里，需要时看得见来源。排序交给 store 的 `sortItems`
   * （kind → number），界面不再重排；编号稳定，允许空洞。
   */
  const rows = filtered;

  // 条目被完成 / 归档 / 在别处删掉之后，详情栏不能继续挂着一条列表里已经没有的事项。
  useEffect(() => {
    if (selectedId === null) return
    if (items.some((item) => item.id === selectedId)) return
    setSelectedId(null)
  }, [items, selectedId]);

  const act = useCallback(async (run) => {
    setBusy(true);
    try {
      await run();
      await reload();
      setError('');
    } catch (cause) {
      setError(String(cause?.message ?? cause));
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const onAdd = () => {
    const title = draft.trim();
    if (title.length === 0) return
    void act(async () => {
      await call('add', { title, kind: draftKind, project: view?.items?.[0]?.project });
      setDraft('');
    })
  };

  /**
   * 打开详情栏。`DetailPane` 按 id 自己去 `/todo-board/detail` 取正文 —— 清单快照
   * 里只有小节原文，排版交给详情栏的 `MarkdownText`。
   * @param item - 被点的事项。
   */
  const onOpen = (item) => { setSelectedId(item.id) };

  /**
   * 开始拖拽详情栏宽度。指针移动挂在 window 上：拖出详情栏、甚至拖出窗口时仍然
   * 跟手；`pointercancel`（触控被系统接管）也要结束，否则会一直拖下去。
   * @param event - 手柄上的 `pointerdown`。
   */
  const onResizeStart = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    const body = bodyRef.current;
    const aside = event.currentTarget.parentElement;
    if (body === null || aside === null) return;
    const startX = event.clientX;
    // jsdom 没有布局，getBoundingClientRect 会给 0；退回 state / 默认中值。
    const startWidth = aside.getBoundingClientRect().width || sideWidthRef.current || 360;
    // 列表至少留 240px，拖到最宽也不能把它挤没。容器还没布局（jsdom）时用固定上限。
    const bodyWidth = body.getBoundingClientRect().width;
    const cap = bodyWidth > 0 ? clampDetailWidth(bodyWidth - 240) : DETAIL_MAX_WIDTH;
    const move = (moveEvent) => {
      const next = clampDetailWidth(startWidth + (startX - moveEvent.clientX), cap);
      // 同时写 ref：pointerup 可能紧跟 pointermove，不能等 React 提交再读。
      sideWidthRef.current = next;
      setSideWidth(next);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.style.userSelect = '';
      dragStopRef.current = null;
      setResizing(false);
      if (sideWidthRef.current !== null) saveDetailWidth(sideWidthRef.current);
    };
    dragStopRef.current = stop;
    setResizing(true);
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  /** 双击手柄：回到 CSS 的默认比例，并把记住的宽度删掉。 */
  const onResetWidth = () => {
    setSideWidth(null);
    sideWidthRef.current = null;
    clearSavedDetailWidth();
  };

  // 拖到一半关掉详情栏（组件卸载）时，别把 window 监听和 body 的 user-select 留下。
  useEffect(() => () => {
    if (dragStopRef.current !== null) dragStopRef.current();
  }, []);

  const counts = view?.summary?.counts ?? { todo: 0, done: 0, branch: 0 };

  return jsxs('section', { className: 'tb-page', 'data-plugin-panel': '', children: [
    jsxs('div', { className: 'tb-head', children: [
      jsx(IconChecklistOutlineRegular, { size: 18 }, 'icon'),
      jsx('h1', { className: 'tb-title', children: t('panelTitle') }, 'title'),
      jsx('span', {
        className: 'tb-sub',
        // 不用 t(key, params)：`locale.bind` 返回的 t 只做字典查表，没有插值约定，
        // 依赖它会在别的宿主上悄悄渲染出 key 本身。
        children: [
          `${counts.todo} ${t('filterTodo')}`,
          `${counts.done} ${t('filterDone')}`,
          `${counts.branch} ${t('filterBranch')}`,
        ].join(' · '),
      }, 'sub'),
      jsx('span', { className: 'tb-grow' }, 'grow'),
      jsx('button', {
        type: 'button', className: 'tb-icon-btn', title: t('refresh'), 'aria-label': t('refresh'),
        onClick: () => { void reload() }, disabled: busy ? true : undefined,
        children: jsx(IconRefreshOutlineRegular, { size: 15 }),
      }, 'refresh'),
    ] }, 'head'),
    jsxs('div', { className: 'tb-toolbar', children: [
      jsxs('div', { className: 'tb-tabs', children: [
        // 只有三种清单：待办 / 已办 / 功能分支。原先还有个「全部」把三类混在
        // 一条流里，既没法按序号定位，也和这三个 tab 重复（用户明确要求去掉）。
        jsx('button', { type: 'button', className: 'tb-tab', 'data-active': String(kind === 'todo'), onClick: () => setKind('todo'), children: t('filterTodo') + ' ' + counts.todo }, 'todo'),
        jsx('button', { type: 'button', className: 'tb-tab', 'data-active': String(kind === 'done'), onClick: () => setKind('done'), children: t('filterDone') + ' ' + counts.done }, 'done'),
        jsx('button', { type: 'button', className: 'tb-tab', 'data-active': String(kind === 'branch'), onClick: () => setKind('branch'), children: t('filterBranch') + ' ' + counts.branch }, 'branch'),
      ] }, 'tabs'),
      jsx('span', { className: 'tb-grow' }, 'grow'),
      // 一键归档只出现在「已办」tab：其他两个清单有条目级动作，不需要批量清空。
      // 两段式：第一下进入确认态，第二下才调用宿主；归档是软删除，可在
      // board.json / `workboard_list includeArchived: true` 里查回。
      kind === 'done' && counts.done > 0
        ? jsx('button', {
            type: 'button',
            className: 'tb-action',
            'data-action': 'archive-all',
            'data-armed': String(archiveAllArmed === true),
            title: t('archiveAllHint'),
            disabled: busy ? true : undefined,
            onClick: () => {
              if (archiveAllArmed === false) { setArchiveAllArmed(true); return }
              void act(async () => {
                await call('archiveAll', { kind: 'done' })
                setArchiveAllArmed(false)
              })
            },
            children: archiveAllArmed === true
              ? t('archiveAllConfirm') + ' ' + String(counts.done)
              : t('archiveAll') + ' ' + String(counts.done),
          }, 'archive-all')
        : null,
      jsx('input', {
        className: 'tb-input tb-search', type: 'search', value: query, placeholder: t('search'),
        'aria-label': t('search'), onChange: (event) => setQuery(event.target.value),
      }, 'search'),
    ] }, 'toolbar'),
    jsxs('div', { className: 'tb-body', ref: bodyRef, children: [
      jsx('div', { className: 'tb-list', children: rows.length === 0
        ? jsx('p', { className: 'tb-empty', children: view === null ? t('busy') : t('empty') }, 'empty')
        : rows.map((item, index) => jsx(ItemRow, {
            item,
            // 序号按**可见列表**数：这个位置会随切 tab / 搜索重排，`#N` 不会。
            index: index + 1,
            selected: item.id === selectedId,
            t,
            onOpen,
            onComplete: (target) => { void act(() => call('complete', { id: target.id })) },
            onArchive: (target) => { void act(() => call('archive', { id: target.id })) },
          }, item.id)) }, 'list'),
      selectedId === null
        ? null
        : jsx(DetailPane, {
            id: selectedId,
            t,
            width: sideWidth,
            resizing,
            onResizeStart,
            onResizeReset: onResetWidth,
            onClose: () => setSelectedId(null),
          }, 'detail'),
    ] }, 'body'),
    jsxs('div', { className: 'tb-add', children: [
      jsx('select', {
        className: 'tb-select', value: draftKind, 'aria-label': t('add'),
        onChange: (event) => setDraftKind(event.target.value),
        children: [
          jsx('option', { value: 'todo', children: t('addKindTodo') }, 'todo'),
          jsx('option', { value: 'done', children: t('addKindDone') }, 'done'),
          jsx('option', { value: 'branch', children: t('addKindBranch') }, 'branch'),
        ],
      }, 'kind'),
      jsx('input', {
        className: 'tb-input tb-add-input', value: draft, placeholder: t('addPlaceholder'),
        'aria-label': t('addPlaceholder'),
        onChange: (event) => setDraft(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter') onAdd() },
      }, 'draft'),
      jsx('button', {
        type: 'button', className: 'tb-primary', onClick: onAdd,
        // `view === null` 时不能新增：新条目要沿用清单里第一个条目的 project，
        // 读不到清单就只会落进「未归类」，把跨项目分组搅乱。
        disabled: busy || view === null || draft.trim().length === 0 ? true : undefined,
        children: [jsx(IconPlusOutlineRegular, { size: 14 }, 'icon'), t('add')],
      }, 'add'),
    ] }, 'add'),
    error.length > 0 ? jsx('p', { className: 'tb-error', role: 'alert', children: t('error') + '：' + error }, 'error') : null,
  ] });
}

/**
 * 整页右侧的详情栏。
 *
 * 按 id 自己去 `/todo-board/detail` 取正文：那个端点直接返回**渲染用的 Markdown**
 * （与三份镜像里那一段同源，都是 `renderItemDoc`），交给平台的 `MarkdownText` 渲染。
 *
 * 为什么用 MarkdownText 而不是自己排版：事项正文里就有 `**背景**`、表格、代码块和
 * 反引号路径，纯文本陈列等于把语法丢给用户看。
 *
 * 左边缘是一条拖拽手柄：宽度由 BoardPage 持有（它才知道列表要留多宽），这里只负责
 * 把指针事件交上去并显示「可拖」的反馈。
 * @param props.id - 正开着的事项 id。
 * @param props.width - 拖出来的宽度（px）；`null` 表示用 CSS 里的默认比例。
 * @param props.resizing - 是否正在拖动（用来点亮手柄）。
 * @param props.onResizeStart - `pointerdown` 回调，开始一次拖拽。
 * @param props.onResizeReset - 双击手柄：恢复默认宽度。
 * @param props.onClose - 收起详情栏。
 * @param props.t - 本地化函数。
 */
function DetailPane({ id, width, resizing, onResizeStart, onResizeReset, onClose, t }) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    // 换一条事项时先清空，免得旧正文在新内容到手前闪一下。
    setDoc(null);
    setError('');
    (async () => {
      try {
        const next = await call('detail', { id });
        if (live) { setDoc(next); setError(''); }
      } catch (cause) {
        if (live) setError(String(cause?.message ?? cause));
      }
    })();
    return () => { live = false };
  }, [id]);

  const labels = useMemo(() => ({
    code: {
      copyLabel: t('copyLabel'),
      copiedLabel: t('copiedLabel'),
      toolbarLabels: { codeLabel: t('codeLabel'), wrapLabel: t('wrapLabel'), unwrapLabel: t('unwrapLabel') },
    },
    footnotes: t('footnotes'),
  }), [t]);

  let content;
  if (error.length > 0) {
    content = jsx('p', { className: 'tb-side-error', role: 'alert', children: error });
  } else if (doc === null) {
    content = jsx('p', { className: 'tb-side-status', role: 'status', children: t('detailLoading') });
  } else if (typeof doc.markdown !== 'string') {
    content = jsx('p', { className: 'tb-side-status', children: t('detailMissing') });
  } else {
    // 注意 jsx 的第三参是 key、不是 children：正文必须写进 props.children，
    // 否则 `.tb-detail` 会渲染成一个空 div（测试里表现为「等不到 .markdown」）。
    content = jsx('div', { className: 'tb-detail', children: jsx(MarkdownText, { text: doc.markdown, labels }) });
  }

  return jsxs('aside', {
    className: 'tb-side',
    'data-detail-id': id,
    // 拖过之后是固定 px；没拖过就让 CSS 的 clamp 决定（随窗口缩放）。
    style: typeof width === 'number' ? { width: width + 'px' } : undefined,
    children: [
      jsx('span', {
        className: 'tb-side-resize',
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': t('detailResize'),
        title: t('detailResize'),
        'data-dragging': String(resizing === true),
        onPointerDown: onResizeStart,
        onDoubleClick: onResizeReset,
      }, 'resize'),
      jsxs('div', { className: 'tb-side-head', children: [
        jsx('h2', { className: 'tb-side-title', children: t('detailTitle') }, 'title'),
        jsx('span', { className: 'tb-grow' }, 'grow'),
        jsx('button', {
          type: 'button', className: 'tb-icon-btn', title: t('detailClose'), 'aria-label': t('detailClose'),
          onClick: onClose,
          children: jsx(IconCloseOutlineRegular, { size: 15 }),
        }, 'close'),
      ] }, 'head'),
      jsx('div', { className: 'tb-side-body', children: content }, 'body'),
    ],
  });
}

/**
 * 客户端入口：字典 + 侧栏导航行 + 中列整页（成对座位）。
 * @param ctx - 客户端上下文。
 */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'todo-board: dictionaries')
  const t = ctx.locale.bind(NS)

  // 中列整页与侧栏那一行各自等自己的座位被声明。`slots.register` 面对未声明的槽位
  // 会直接抛 `slot "main" is not declared`（`ui-slots/src/index.ts:1269`），所以不能
  // 在 apply 里裸注册。
  //
  // 两者的 id/key 必须逐字相同：宿主点面板行时调 `layout.selectPanel(id)`，它按
  // `options.key` 在 main 槽里找 entry，对不上就抛
  // `main panel "todo-board" is not registered`（`ui-layout/src/client/service.ts:74`）。
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, BoardPage))

  // 侧栏那一行等宿主声明了面板列表座位再挂：没有人消费的槽位注册了也不会显示。
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    // 排在 插件(0) / 自动化任务(10) 之后、记忆(60) 之前；「更多」由宿主永远排在
    // 所有面板之后，所以落在它上方是 order 之外的结构保证。
    order: 20,
    locale: NS,
    label: () => t('label'),
  }, BoardGlyph))
}

(function () {
  if (typeof document === 'undefined') return
  const tagId = PLUGIN_ID + '/todo-board.css'
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