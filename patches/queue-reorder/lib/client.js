/**
 * queue-reorder 的浏览器半：给**官方**队列坞的待发消息行挂上拖拽排序。
 *
 * 这个插件刻意不遮蔽官方 `conversation.input.dock` 的 `queue` 项。旧补丁
 * （已归档的 ui-queue-tools）是整坞接管：同 id + priority -10 压过官方那一项，
 * 代价是官方之后为这个坞新增的任何能力都会被挡住，且每版都要人工对齐。这里换
 * 一种形态——官方坞照常渲染（多行编辑 / steer / 附件 chip / 折叠计数全是官方
 * 的），我们只在它渲染出来的行上加拖拽。
 *
 * 做法：
 *
 * 1. 在同一个 `conversation.input.dock` 槽位注册**另一个 id**（`queue-reorder`，
 *    order 30，排在官方 queue:20 之后），组件渲染 `null`。list 槽按 id 分格，
 *    同 id 才是遮蔽，所以两项并存。它存在的唯一目的，是拿到会话作用域的标准
 *    props：`useProjection('inbox')` 给出待发消息 id，`useSession` 给出本地提交
 *    回显与可变更判据。
 * 2. 每次渲染后装饰官方 DOM：给 `[data-queue-dock] li`（排除
 *    `[data-submission-echo]` 的本地回显行）打上 `data-queue-reorder-id` 与
 *    `draggable`。React 按 key 复用/移动节点，属性跟着消息走，所以即使某次
 *    装饰滞后，节点上的 id 仍然是对的。
 * 3. document 上装一次捕获阶段的 dragstart/dragover/drop/dragend 代理。落点用
 *    「被落中的那一行的消息 id」换算成宿主 `next-turn` 索引；真正换顺序的是宿主
 *    半的 `/queue-reorder/reorder`（inbox.splice），成功后
 *    `agent/inbox/spliced` 事件广播给所有客户端，所以这里不做任何乐观重排。
 *
 * 为什么依赖官方 DOM 形状：官方 `QueueDock.tsx` 的行是 `<li key={row.id}>`，
 * **不带**消息 id（id 只存在于 React 的 key 里），所以只能靠顺序对齐：官方渲染
 * 的持久行顺序 = `inbox['next-turn']` 减去已进 transcript 的本地提交，本文件
 * 逐字复刻这条过滤（`visibleQueue`）。该契约由
 * `tests/official-dock-contract.mjs` 盯住：官方源码里一旦 `data-queue-dock` /
 * `data-submission-echo` 或行元素不再是 `li`，测试就失败，提醒按新版改这里。
 */
window.__ModuleLoader__.load({ id: '@local/dsh-client-queue-reorder', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useEffect } = React;

const PLUGIN_ID = '@local/dsh-client-queue-reorder';

/* 只注入一次；模块加载器按 `style[data-plugin]` 记名并在卸载时移除，
   `data-plugin-css` 键让热重载不会叠第二份。视觉全部挂在属性选择器上 ——
   React 从不管理这些属性，所以它的重渲染不会把它们抹掉。 */
const CSS = [
  '[data-queue-dock] li[data-queue-reorder-id]{cursor:grab}',
  '[data-queue-dock] li[data-queue-reorder-dragging]{opacity:.45}',
  '[data-queue-dock] li[data-queue-reorder-over]{outline:2px dashed var(--dsw-alias-state-business-primary);outline-offset:-2px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent)}',
].join('\n');
(function () {
  if (typeof document === 'undefined') return
  const tagId = PLUGIN_ID + '/queue-reorder.css'
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
})();

/** 简体中文字典，同时是键的权威来源。 */
const zh = {
  reorderFailed: '排序失败：这条消息可能已经开始发送。',
  reorderUnavailable: '排序失败：排序服务未加载（重启 DSH 后恢复）。',
};

/** 英文字典，键与中文字典一一对应。 */
const en = {
  reorderFailed: 'Reorder failed: this message may have already started sending.',
  reorderUnavailable: 'Reorder failed: the reorder service is not loaded (recovers after restarting DSH).',
};

/** 本插件拥有的字典命名空间。 */
const NS = 'queue.reorder';

/** 本坞渲染的 placement：每一条 `toIndex` 都是相对 `next-turn` 列表的。 */
const QUEUED_PLACEMENT = 'queued';

/** 共享空数组：稳定引用让依赖比较保持安静。 */
const EMPTY = [];

/** 官方 QueueDock 的根节点标记。 */
const DOCK_SELECTOR = '[data-queue-dock]';
/** 本地排队回显行：宿主还没为它发布 inbox 行，因此不可重排。 */
const ECHO_ATTRIBUTE = 'data-submission-echo';
/** 行上的消息 id 属性（由本插件写，React 不管理）。 */
const ID_ATTRIBUTE = 'data-queue-reorder-id';

/** 服务依赖：槽位表、字典、会话作用域。 */
const inject = ['slots', 'locale', 'sessions'];

/** 传输层自身失败（fetch 抛错、非 2xx、路由根本没注册）与宿主侧拒绝区分开。 */
const transportError = (message) => Object.assign(new Error(message), { code: 'transport' });

/**
 * 调一次宿主半的 `/queue-reorder` 前缀路由。
 *
 * 同源、JSON 进 JSON 出 —— 宿主侧的围栏就是这么要求的。
 */
const call = async (endpoint, args) => {
  let response
  try {
    response = await fetch('/queue-reorder/' + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: args ?? {} }),
    })
  } catch (error) {
    throw transportError('rpc ' + endpoint + ' failed: ' + String(error?.message ?? error))
  }
  if (!response.ok) throw transportError('rpc ' + endpoint + ' failed: HTTP ' + String(response.status))
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

/**
 * 官方坞渲染出来的持久行顺序。
 *
 * 逐字复刻官方 `QueueDock.tsx` 的 `queue` useMemo：`inbox['next-turn']`，减去
 * 那些已经在 transcript 里回显过的本地提交（否则同一批消息会渲染两次）。本地
 * 提交回显行排在持久行之后并带 `data-submission-echo` 标记，所以 DOM 里非回显
 * `li` 的序号就是这里的序号。
 *
 * @param inbox - 会话的 inbox 投影。
 * @param pendingSubmissions - 会话的本地提交列表。
 * @returns 持久待发消息，顺序与官方坞一致。
 */
function visibleQueue(inbox, pendingSubmissions) {
  const rows = inbox !== null && typeof inbox === 'object' && Array.isArray(inbox['next-turn'])
    ? inbox['next-turn']
    : EMPTY;
  const inChat = new Set(
    (Array.isArray(pendingSubmissions) ? pendingSubmissions : EMPTY)
      .filter((item) => item?.placement === 'transcript')
      .map((item) => item.requestId),
  );
  if (inChat.size === 0) return rows;
  return rows.filter(({ source }) => (
    source == null || typeof source !== 'object' || source.kind !== 'user'
    || typeof source.rpcId !== 'string' || !inChat.has(source.rpcId)
  ));
}

/** `id` 在 inbox `next-turn` 列表里的下标；找不到返回 -1（宿主自己的坐标系）。 */
function nextTurnIndexOf(inbox, id) {
  const durable = inbox !== null && typeof inbox === 'object' && Array.isArray(inbox['next-turn'])
    ? inbox['next-turn']
    : EMPTY;
  return durable.findIndex((row) => row?.id === id);
}

/**
 * 当前可见的持久行，按官方坞的顺序（本地回显行被排除）。
 * @returns 官方坞里的持久 `li` 元素。
 */
function queueRowElements() {
  if (typeof document === 'undefined') return [];
  return [...document.querySelectorAll(DOCK_SELECTOR + ' li')]
    .filter((li) => !li.hasAttribute(ECHO_ATTRIBUTE));
}

/** 行里是否正在内联编辑（官方 InlineEditor 是 textarea）。 */
function rowIsEditing(li) {
  return li.querySelector('textarea, input') !== null;
}

/**
 * 按 id 表装饰官方坞的持久行。
 *
 * 只有「可拖拽确实成立」时才打标记：超过一行、行数与 id 数对得上、且该行不在
 * 编辑态（拖拽会抢掉 textarea 的文本选择）。行数与 id 数对不上时说明官方坞的
 * 渲染形状变了，任何基于序号的对齐都可能把消息搬到错误位置 —— 宁可不排序。
 *
 * @param ids - 当前持久待发消息 id，顺序与官方坞一致。
 * @param enabled - 该会话是否允许重排（与官方坞的 queueMutable 同义）。
 * @returns 打过标记的行元素。
 */
function stampRows(ids, enabled) {
  const rows = queueRowElements();
  const aligned = enabled !== false && rows.length === ids.length && rows.length > 1;
  for (let index = 0; index < rows.length; index += 1) {
    const li = rows[index];
    if (aligned && !rowIsEditing(li)) {
      li.setAttribute(ID_ATTRIBUTE, String(ids[index]));
      li.setAttribute('draggable', 'true');
    } else {
      // 清掉旧值：一行从上一次渲染继承下来的 id 会让 drop 落到别的消息上。
      li.removeAttribute(ID_ATTRIBUTE);
      li.removeAttribute('draggable');
    }
  }
  return rows;
}

/* 最近一次渲染给出的 id 表与可拖判据。打标记不只发生在 React 渲染后：
   展开/折叠队列坞是官方坞自己的 local state，行随 `listVisible` 挂载/卸载，
   而这些都不会让本组件重渲染。所以这里存一份「最新的表」，让 DOM 观察者
   与 pointerdown 都能在渲染之外重新打标记（单会话槽位，同时只有一个在活实例）。 */
let currentStamp = { ids: EMPTY, enabled: true };

/** 按最近一次渲染的 id 表重新装饰官方行（可脱离 React 调用）。 */
function stampNow() {
  // 还没有任何渲染给过表（或队列为空）时什么都不做。若在这里照常执行，
  // `stampRows([], …)` 的「行数与 id 数对不上」分支会把已有标记**清掉**，
  // 于是一次 pointerdown 就能把可拖拽状态抹掉。
  if (currentStamp.ids.length === 0) return [];
  return stampRows(currentStamp.ids, currentStamp.enabled);
}

/** 从一次事件的 target 向上找最近的队列行（不限是否已打标记）。 */
function rowFromEvent(event) {
  const target = event?.target;
  if (target === null || typeof target !== 'object' || typeof target.closest !== 'function') return null;
  return target.closest(DOCK_SELECTOR + ' li');
}

/**
 * 把拖拽行为挂到 document 上。
 *
 * 事件代理而不是逐节点监听：行会随 React 重渲染被复用/移动，代理只装一次，新行
 * 靠 `stampRows()` 打标记就能立即参与。
 *
 * @param options - `{ latest, reorder, onError }`；`latest()` 返回当前会话的最新
 *   `{ inbox }`（拖放发生在 React 渲染之外，读不到 props）；
 *   `reorder(itemId, toIndex)` 走宿主端点；`onError(error)` 汇报一次失败。
 * @returns 卸载函数。
 */
function installDrag({ latest, reorder, onError }) {
  if (typeof document === 'undefined') return () => {};
  let draggingId = null;
  let dragSource = null;
  // HTML5 拖拽的 dragstart 目标是可拖拽元素本身，拿不到「按在了哪个子元素上」，
  // 只能靠按下时记一笔，用来区分「拖行」与「点官方的编辑/删除/插话按钮」。
  let pressed = null;

  const clearOver = () => {
    const current = document.querySelector(DOCK_SELECTOR + ' li[data-queue-reorder-over]');
    if (current !== null) current.removeAttribute('data-queue-reorder-over');
    return current;
  };

  const clearDrag = () => {
    const marked = document.querySelector(DOCK_SELECTOR + ' li[data-queue-reorder-dragging]');
    if (marked !== null) marked.removeAttribute('data-queue-reorder-dragging');
    draggingId = null;
    dragSource = null;
    clearOver();
  };

  /* 一次拖拽（或一次点击）结束就把按下记录清掉。留着它会让下一次从文字区域起手的
     拖拽被误判成「按在按钮上」而拒绝 —— 那同样是时灵时不灵的一种。 */
  const onPointerUp = () => { pressed = null; };

  const onPointerDown = (event) => {
    pressed = event?.target !== null && typeof event?.target === 'object' ? event.target : null;
    // 兜底：点进官方坞时立刻补一次标记。展开坞是官方自己的 local state，
    // 那一刻行刚插进 DOM、`draggable` 还没写上；而在 pointerdown 里写上就来得及，
    // 浏览器的 dragstart 要等鼠标真正移动才触发。没有这一步，用户点开坞后
    // 马上拖会「拖不动」，得等下一次 inbox 变化才灵。
    const row = pressed !== null && typeof pressed.closest === 'function'
      ? pressed.closest(DOCK_SELECTOR)
      : null;
    if (row !== null) stampNow();
  };

  const onDragStart = (event) => {
    const row = rowFromEvent(event);
    if (row === null) return;
    // 标记可能还没打上（官方坞刚展开、行刚插进 DOM）。dragstart 是最后的时机，
    // 这里同步补一次而不是直接放弃 —— 否则就是用户看到的「要等一下才能拖」。
    if (!row.hasAttribute(ID_ATTRIBUTE)) stampNow();
    if (!row.hasAttribute(ID_ATTRIBUTE)) return;
    // 按在按钮/输入框上不算拖行，让官方坞自己的交互照常工作。
    if (pressed !== null && typeof pressed.closest === 'function' && row.contains(pressed)
      && pressed.closest('button, textarea, input') !== null) {
      event.preventDefault();
      return;
    }
    // 编辑态下拖拽会抢走 textarea 的选区；而官方编辑态不会触发我们的重渲染，
    // 所以这里再守一道。
    if (rowIsEditing(row)) {
      event.preventDefault();
      return;
    }
    draggingId = row.getAttribute(ID_ATTRIBUTE);
    dragSource = row;
    row.setAttribute('data-queue-reorder-dragging', '1');
    try { event.dataTransfer.effectAllowed = 'move'; } catch { /* jsdom 没有 dataTransfer */ }
  };

  const onDragOver = (event) => {
    if (draggingId === null) return;
    const row = rowFromEvent(event);
    if (row === null || row === dragSource || !row.hasAttribute(ID_ATTRIBUTE)) {
      clearOver();
      return;
    }
    // preventDefault 是允许 drop 的唯一办法。
    event.preventDefault();
    try { event.dataTransfer.dropEffect = 'move'; } catch { /* jsdom */ }
    if (!row.hasAttribute('data-queue-reorder-over')) {
      clearOver();
      row.setAttribute('data-queue-reorder-over', '1');
    }
  };

  const onDrop = (event) => {
    if (draggingId === null) return;
    const row = rowFromEvent(event);
    const itemId = draggingId;
    if (row === null || !row.hasAttribute(ID_ATTRIBUTE)) return clearDrag();
    event.preventDefault();
    const toItemId = row.getAttribute(ID_ATTRIBUTE);
    clearDrag();
    if (toItemId === itemId) return;
    // 宿主按 `next-turn` 自身的下标 splice：把「落到哪条消息上」换算成宿主索引。
    // 落到目标行 = 占据目标行原来的位置（向下拖时落到目标之后，向上拖时落到目标
    // 之前），与「把这条消息放到那一行」的直觉一致。
    const toIndex = nextTurnIndexOf(latest().inbox, toItemId);
    if (toIndex < 0) return;
    Promise.resolve()
      .then(() => reorder(itemId, toIndex))
      .catch((error) => { onError(error); });
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerUp, true);
  document.addEventListener('dragstart', onDragStart, true);
  document.addEventListener('dragover', onDragOver, true);
  document.addEventListener('drop', onDrop, true);
  document.addEventListener('dragend', clearDrag, true);
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('pointercancel', onPointerUp, true);
    document.removeEventListener('dragstart', onDragStart, true);
    document.removeEventListener('dragover', onDragOver, true);
    document.removeEventListener('drop', onDrop, true);
    document.removeEventListener('dragend', clearDrag, true);
    clearDrag();
    pressed = null;
  };
}

/**
 * 队列坞的拖拽装饰组件：自己不渲染任何东西。
 *
 * 打标记有两条通路，因为**官方坞的展开/折叠不会触发本组件重渲染**：
 *
 *  1. 渲染后（`ids`/`enabled` 变了）——覆盖「队列里增删了消息」；
 *  2. MutationObserver 观察官方坞子树——覆盖「展开/折叠时行刚插进 DOM」。
 *     折叠态下 `rowCount > 1` 的坞根本不渲染行，展开时行是新节点，而这次
 *     展开是官方坞自己的 local state，本组件收不到任何信号。少了这条通路，
 *     用户点开坞后要等下一次 inbox 变化才能拖。
 *
 * 第 3 条兜底在 `installDrag` 的 pointerdown 里（见那里）。
 */
function QueueReorderDock({ useProjection, useSession, reorder, notify, t }) {
  const inbox = useProjection('inbox');
  const pendingSubmissions = useSession((s) => s.pendingSubmissions);
  // 与官方坞同一条可变更判据：可续接的子代理会话同样接受队列变更。
  const queueMutable = useSession((s) => s.subagent === null || s.subagent?.address?.mode === 'continuable');
  const queue = visibleQueue(inbox, pendingSubmissions);
  const ids = queue.map((row) => row?.id).filter((id) => typeof id === 'string');
  const enabled = queueMutable !== false;

  // 拖放与 DOM 观察都发生在渲染之外，只能通过这个读取器拿「最新」的值。
  const latest = { inbox };
  const latestRef = React.useRef(latest);
  latestRef.current = latest;
  currentStamp = { ids, enabled };

  // 每次渲染后打一次（行已经在 DOM 里的常规路径）。
  useEffect(() => {
    stampNow();
  });

  // document 级拖拽代理 + 官方坞子树的观察者，都只装一次。
  useEffect(() => {
    const unobserve = observeDock();
    const uninstall = installDrag({
      latest: () => latestRef.current,
      reorder,
      onError: (error) => {
        notify('error', error?.code === 'transport' ? t('reorderUnavailable') : t('reorderFailed'));
      },
    });
    return () => {
      unobserve();
      uninstall();
    };
  }, []);

  return null;
}

/**
 * 观察官方坞的子树，行一插进来就补标记。
 *
 * 只观察 `childList`（展开/折叠插拔行、React 重排行都是子节点变动），不观察
 * `attributes`：`stampNow()` 自己会写属性，监听属性会原地打转。回调用 microtask
 * 合并，避免一次批量更新里反复扫描。
 *
 * @returns 停止观察的函数。
 */
function observeDock() {
  if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return () => {};
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => {
      queued = false;
      stampNow();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return () => { observer.disconnect(); };
}

/** 贡献队列坞的拖拽装饰，官方坞保持原位（不遮蔽）。 */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'queue-reorder: dictionaries')

  const reorder = async (sessionId, itemId, toIndex) => {
    try {
      return await call('reorder', { sessionId, itemId, toIndex, placement: QUEUED_PLACEMENT })
    } catch (error) {
      // 保留本插件自己的失败措辞，同时把传输层的机器可读字段透传出去。
      const wrapped = new Error('queue reorder failed: ' + String(error?.message ?? error))
      wrapped.code = error?.code
      wrapped.details = error?.details
      throw wrapped
    }
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    // 与官方 queue:20 不同的 id —— 这是「不遮蔽」的关键：list 槽按 id 分格，
    // 同 id 才遮蔽。order 30 只决定这一格排在官方坞之后。
    id: 'queue-reorder',
    order: 30,
    locale: NS,
    inject: (sessionId) => {
      const actx = ctx.sessions.scope(sessionId)
      if (actx === undefined) throw new Error(`queue-reorder: session "${sessionId}" resolved no scope`)
      const conversation = actx.get('conversation')
      if (conversation === undefined) throw new Error('queue-reorder: conversation service unavailable')
      return {
        // 每条 toIndex 都相对 `next-turn` 计算，宿主据此可以拒掉别的列表。
        reorder: (itemId, toIndex) => reorder(sessionId, itemId, toIndex),
        notify: (level, text) => { conversation.input.for(actx).notify(level, text) },
      }
    },
  }, QueueReorderDock))
}

// 可测试的纯逻辑与装配件一并导出（契约测试直接驱动它们）。
module.exports = {
  apply,
  inject,
  NS,
  visibleQueue,
  nextTurnIndexOf,
  stampRows,
  stampNow,
  observeDock,
  installDrag,
  queueRowElements,
  queuedPlacement: QUEUED_PLACEMENT,
  dockSelector: DOCK_SELECTOR,
  echoAttribute: ECHO_ATTRIBUTE,
  idAttribute: ID_ATTRIBUTE,
};
return module.exports;
} });