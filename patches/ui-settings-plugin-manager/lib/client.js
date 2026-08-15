/**
 * Browser half of the user-level plugin-manager tab.
 *
 * Hand-written in the client-bundle contract (no build step): the shell's
 * module loader receives this file through `window.__ModuleLoader__.load` and
 * answers every `require()` from the frozen module table. Only platform seed
 * words are used: `react`, `react/jsx-runtime`, and the icon set from
 * `@deepseek-ai/dsh-client-ui-primitives`. Everything else (slots, locale,
 * remote) arrives as services on the `apply(ctx)` context.
 *
 * The tab renders the same read-only Host inventory snapshot as the shipped
 * "插件列表" tab (`ctx.remote.pluginInventory.list()`) with three AND-combined
 * filters: category (official/custom), enablement (enabled/disabled), and
 * runtime phase. Provenance is classified from the module specifier:
 * `@deepseek-ai/*` packages and `cordis:` Loader builtins are official;
 * file URLs, paths, and third-party packages are custom.
 */
window.__ModuleLoader__.load({ id: '@local/dsh-client-ui-settings-plugin-manager', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useEffect, useId, useMemo, useState } = React;
const { jsx, jsxs } = require('react/jsx-runtime');
const { IconChevronDownOutline14, IconSearchOutline16 } = require('@deepseek-ai/dsh-client-ui-primitives');

const PLUGIN_ID = '@local/dsh-client-ui-settings-plugin-manager';

/* Injected once per page (idempotent). The module loader records
   `style[data-plugin]` tags at materialization; the HMR path removes them on
   reload, while a plain fiber unload keeps the tag for the page lifetime —
   same behavior as the shipped bundles. */
const CSS = [
  '.pm-section{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary)}',
  '.pm-section .pm-status,.pm-failure p{margin:0}',
  '.pm-status,.pm-failure{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
  '.pm-failure{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-state-error-primary)}',
  '.pm-failure button{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}',
  '.pm-catalog{display:flex;flex-direction:column;gap:12px}',
  '.pm-search{position:relative;display:flex;align-items:center;width:100%;color:var(--dsw-alias-label-tertiary)}',
  '.pm-search>svg{position:absolute;left:12px;pointer-events:none}',
  '.pm-search input{width:100%;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 34px 0 36px;outline:none;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
  '.pm-search input::placeholder{color:var(--dsw-alias-label-tertiary)}',
  '.pm-search input:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}',
  '.pm-filters{display:flex;flex-wrap:wrap;gap:10px}',
  '.pm-filter{display:inline-flex;flex-direction:column;gap:4px;min-width:132px}',
  '.pm-filter-label{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}',
  '.pm-filter select{height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 26px 0 10px;outline:none;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
  '.pm-filter select:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}',
  '.pm-catalog-heading{display:flex;align-items:baseline;gap:7px;padding:0 2px}',
  '.pm-catalog-heading h3{margin:0;font-size:13px;line-height:20px;font-weight:600}',
  '.pm-catalog-heading span{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
  '.pm-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:10px;margin:0;padding:0;list-style:none}',
  '.pm-card{min-width:0;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3)}',
  '.pm-card[data-open="true"]{border-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv1)}',
  '.pm-card-content{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:52px;border:0;padding:12px 14px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
  '.pm-card-content:hover,.pm-card[data-open="true"]>.pm-card-content{background:var(--dsw-alias-interactive-bg-hover)}',
  '.pm-card-content:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
  '.pm-card-title{min-width:0;overflow:hidden;font-size:14px;line-height:20px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}',
  '.pm-card-trailing{display:inline-flex;flex:none;align-items:center;gap:7px;color:var(--dsw-alias-label-tertiary)}',
  '.pm-category-tag{display:inline-flex;align-items:center;min-height:20px;border-radius:5px;padding:1px 6px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:16px;white-space:nowrap}',
  '.pm-category-tag[data-category="custom"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}',
  '.pm-status-dot{display:inline-block;width:7px;height:7px;flex:none;border-radius:999px;background:var(--dsw-alias-label-tertiary)}',
  '.pm-status-dot[data-phase="active"]{background:var(--dsw-alias-state-success-primary)}',
  '.pm-status-dot[data-phase="failed"]{background:var(--dsw-alias-state-error-primary)}',
  '.pm-status-dot[data-phase="loading"]{background:var(--dsw-alias-state-business-primary)}',
  '.pm-config-tag{display:inline-flex;align-items:center;min-height:20px;border-radius:5px;padding:1px 6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}',
  '.pm-config-tag[data-enabled="true"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}',
  '.pm-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform 140ms var(--ds-ease-in-out)}',
  '.pm-card[data-open="true"] .pm-chevron{transform:rotate(180deg)}',
  '.pm-card-details{border-top:1px solid var(--dsw-alias-border-l2);padding:10px 14px 12px;background:var(--dsw-alias-bg-module-platform)}',
  '.pm-entry-value{display:block;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px}',
  '.pm-details{display:grid;grid-template-columns:76px minmax(0,1fr);gap:6px 10px;margin:8px 0 0}',
  '.pm-details div{display:contents}',
  '.pm-details dt{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}',
  '.pm-details dd{min-width:0;margin:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}',
  '.pm-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}',
  '@media (max-width:680px){.pm-cards{grid-template-columns:minmax(0,1fr)}}',
].join('\n');
(function () {
  if (typeof document === 'undefined') return
  const tagId = PLUGIN_ID + '/plugin-manager.css'
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
})();

/** Simplified Chinese dictionary and key source of truth. */
const zh = {
  tab: '插件管理',
  loading: '正在读取插件…',
  error: '暂时无法读取插件。',
  retry: '重试',
  search: '搜索插件',
  catalog: '插件列表',
  empty: '暂无插件。',
  emptySearch: '没有匹配的插件。',
  category: '分类',
  categoryAll: '全部分类',
  official: '官方',
  custom: '自定义',
  enablement: '启用状态',
  enablementAll: '全部',
  enabled: '已启用',
  disabled: '已停用',
  phase: '运行状态',
  phaseAll: '全部',
  unobserved: '未挂载',
  pending: '等待依赖',
  loadingPhase: '加载中',
  active: '已挂载',
  failed: '挂载失败',
  unloading: '卸载中',
  enabledTag: '已启用',
  disabledTag: '已停用',
  configuration: '配置状态',
  cordis: 'Cordis 状态',
};

/** English dictionary checked against the Chinese key set. */
const en = {
  tab: 'Plugin manager',
  loading: 'Reading plugins…',
  error: 'Plugins are temporarily unavailable.',
  retry: 'Retry',
  search: 'Search plugins',
  catalog: 'Plugin list',
  empty: 'No plugins are available.',
  emptySearch: 'No matching plugins.',
  category: 'Category',
  categoryAll: 'All categories',
  official: 'Official',
  custom: 'Custom',
  enablement: 'Enablement',
  enablementAll: 'All',
  enabled: 'Enabled',
  disabled: 'Disabled',
  phase: 'Runtime status',
  phaseAll: 'All',
  unobserved: 'Not mounted',
  pending: 'Waiting for dependencies',
  loadingPhase: 'Loading',
  active: 'Mounted',
  failed: 'Mount failed',
  unloading: 'Unloading',
  enabledTag: 'Enabled',
  disabledTag: 'Disabled',
  configuration: 'Configuration',
  cordis: 'Cordis status',
};

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.pluginManager';

/** Services required by the Settings registration. */
const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory'];

const PHASE_KEYS = { pending: 'pending', loading: 'loadingPhase', active: 'active', failed: 'failed', unloading: 'unloading' };

/** Provenance bucket shown as the plugin's category tag. */
function classifyCategory(moduleName) {
  return moduleName.startsWith('@deepseek-ai/') || moduleName.startsWith('cordis:')
    ? 'official'
    : 'custom';
}

/** Localized accessible label for one root Fiber phase. */
function phaseLabel(phase, t) {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase]);
}

/** Compact a module specifier without guessing whether its Loader id was generated. */
function moduleShortName(moduleName) {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName;
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^dsh-(?:host-|client-)?/, '');
}

/** Whether an inventory row matches the local catalog query. */
function matches(entry, normalizedQuery) {
  if (normalizedQuery.length === 0) return true
  return [entry.moduleName, entry.entryId]
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery));
}

/** Render the filterable, categorized current Loader inventory. */
function PluginManagerSettingsTab({ list, t, renderSlot }) {
  const catalogId = useId();
  const [request, setRequest] = useState(0);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [enablement, setEnablement] = useState('all');
  const [phase, setPhase] = useState('all');
  const [expanded, setExpanded] = useState(null);
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => list()).then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, request]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredEntries = useMemo(() => {
    if (state.status !== 'ready') return []
    return state.snapshot.entries.filter((entry) => {
      if (category !== 'all' && classifyCategory(entry.moduleName) !== category) return false
      if (enablement === 'enabled' && !entry.enabled) return false
      if (enablement === 'disabled' && entry.enabled) return false
      if (phase !== 'all' && entry.fiberPhase !== phase) return false
      return matches(entry, normalizedQuery)
    })
  }, [category, enablement, phase, normalizedQuery, state]);

  useEffect(() => {
    if (expanded !== null && !filteredEntries.some(entry => entry.entryId === expanded)) {
      setExpanded(null)
    }
  }, [expanded, filteredEntries]);

  const retry = () => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  };

  const phases = Object.keys(PHASE_KEYS);
  const entries = state.status === 'ready' ? state.snapshot.entries : [];
  const hasAny = entries.length > 0;

  return jsx('div', { className: 'pm-section', 'aria-busy': state.status === 'loading', children: [
    state.status === 'loading' ? jsx('p', { className: 'pm-status', children: t('loading') }, 'loading') : null,
    state.status === 'error' ? jsx('div', { className: 'pm-failure', children: [
      jsx('p', { role: 'alert', children: t('error') }, 'error'),
      jsx('button', { type: 'button', onClick: retry, children: t('retry') }, 'retry'),
    ] }, 'failure') : null,
    state.status === 'ready' ? jsx('div', { className: 'pm-catalog', children: [
      jsx('label', { className: 'pm-search', children: [
        jsx(IconSearchOutline16, { 'aria-hidden': true }, 'search-icon'),
        jsx('span', { className: 'pm-visually-hidden', children: t('search') }, 'search-label'),
        jsx('input', {
          type: 'search',
          value: query,
          placeholder: t('search'),
          'aria-label': t('search'),
          onChange: (event) => { setQuery(event.currentTarget.value) },
        }, 'search-input'),
      ] }, 'search'),
      jsx('div', { className: 'pm-filters', children: [
        jsx('label', { className: 'pm-filter', children: [
          jsx('span', { className: 'pm-filter-label', children: t('category') }, 'category-label'),
          jsx('select', {
            value: category,
            'aria-label': t('category'),
            onChange: (event) => { setCategory(event.currentTarget.value) },
            children: [
              jsx('option', { value: 'all', children: t('categoryAll') }, 'category-all'),
              jsx('option', { value: 'official', children: t('official') }, 'category-official'),
              jsx('option', { value: 'custom', children: t('custom') }, 'category-custom'),
            ],
          }, 'category-select'),
        ] }, 'filter-category'),
        jsx('label', { className: 'pm-filter', children: [
          jsx('span', { className: 'pm-filter-label', children: t('enablement') }, 'enablement-label'),
          jsx('select', {
            value: enablement,
            'aria-label': t('enablement'),
            onChange: (event) => { setEnablement(event.currentTarget.value) },
            children: [
              jsx('option', { value: 'all', children: t('enablementAll') }, 'enablement-all'),
              jsx('option', { value: 'enabled', children: t('enabled') }, 'enablement-enabled'),
              jsx('option', { value: 'disabled', children: t('disabled') }, 'enablement-disabled'),
            ],
          }, 'enablement-select'),
        ] }, 'filter-enablement'),
        jsx('label', { className: 'pm-filter', children: [
          jsx('span', { className: 'pm-filter-label', children: t('phase') }, 'phase-label'),
          jsx('select', {
            value: phase,
            'aria-label': t('phase'),
            onChange: (event) => { setPhase(event.currentTarget.value) },
            children: [
              jsx('option', { value: 'all', children: t('phaseAll') }, 'phase-all'),
              ...phases.map(value => jsx('option', { value, children: t(PHASE_KEYS[value]) }, 'phase-' + value)),
            ],
          }, 'phase-select'),
        ] }, 'filter-phase'),
      ] }, 'filters'),
      jsx('div', { className: 'pm-catalog-heading', children: [
        jsx('h3', { children: t('catalog') }, 'catalog-title'),
        jsx('span', { 'data-managed-plugin-count': filteredEntries.length, children: String(filteredEntries.length) }, 'catalog-count'),
      ] }, 'catalog-heading'),
      !hasAny ? jsx('p', { className: 'pm-status', children: t('empty') }, 'empty') : null,
      hasAny && filteredEntries.length === 0 ? jsx('p', { className: 'pm-status', children: t('emptySearch') }, 'empty-search') : null,
      filteredEntries.length > 0 ? jsx('ul', { className: 'pm-cards', children: filteredEntries.map((entry) => {
        const entryCategory = classifyCategory(entry.moduleName)
        const status = phaseLabel(entry.fiberPhase, t)
        const categoryLabel = t(entryCategory)
        const configuration = t(entry.enabled ? 'enabledTag' : 'disabledTag')
        const cardTitle = moduleShortName(entry.moduleName)
        const open = expanded === entry.entryId
        const detailId = catalogId + '-details-' + encodeURIComponent(entry.entryId)
        return jsx('li', {
          className: 'pm-card',
          'data-plugin-entry': entry.entryId,
          'data-open': open ? 'true' : undefined,
          children: [
            jsx('button', {
              className: 'pm-card-content',
              type: 'button',
              'aria-expanded': open,
              'aria-controls': detailId,
              'aria-label': entry.enabled
                ? cardTitle + ', ' + categoryLabel + ', ' + status + ', ' + configuration
                : cardTitle + ', ' + categoryLabel + ', ' + configuration,
              onClick: () => {
                setExpanded(current => current === entry.entryId ? null : entry.entryId)
              },
              children: [
                jsx('strong', { className: 'pm-card-title', title: entry.moduleName, children: cardTitle }, 'title'),
                jsx('span', { className: 'pm-card-trailing', children: [
                  jsx('span', { className: 'pm-category-tag', 'data-category': entryCategory, children: categoryLabel }, 'category'),
                  entry.enabled ? jsx('span', {
                    className: 'pm-status-dot',
                    'data-phase': entry.fiberPhase ?? 'unobserved',
                    role: 'img',
                    'aria-label': status,
                    title: status,
                  }, 'status') : null,
                  jsx('span', { className: 'pm-config-tag', 'data-enabled': entry.enabled ? 'true' : 'false', children: configuration }, 'config'),
                  jsx(IconChevronDownOutline14, { className: 'pm-chevron', size: 12, 'aria-hidden': true }, 'chevron'),
                ] }, 'trailing'),
              ],
            }, 'content'),
            open ? jsx('div', { className: 'pm-card-details', id: detailId, children: [
              jsx('code', { className: 'pm-entry-value', 'data-loader-entry': entry.entryId, children: entry.entryId }, 'entry'),
              jsx('dl', { className: 'pm-details', children: [
                jsx('div', { children: [
                  jsx('dt', { children: t('configuration') }, 'dt-config'),
                  jsx('dd', { children: configuration }, 'dd-config'),
                ] }, 'config-row'),
                entry.enabled ? jsx('div', { children: [
                  jsx('dt', { children: t('cordis') }, 'dt-cordis'),
                  jsx('dd', { children: status }, 'dd-cordis'),
                ] }, 'cordis-row') : null,
              ] }, 'details'),
              // Config cards contributed by the plugin itself — the shipped
              // settings whitelist would refuse custom namespaces, so plugins
              // expose their config over their own RPC channel and register
              // here. `only` filters by the CHILD ENTRY'S REGISTRATION ID, so
              // a contributor must register with id == this entry's module
              // name (e.g. '@local/dsh-plugin-session-cleanup') to be shown
              // on this plugin's card.
              renderSlot('settings.plugin.manager.item', {}, { only: entry.moduleName }),
            ] }, 'details-body') : null,
          ],
        }, entry.entryId)
      }) }, 'cards') : null,
    ] }, 'catalog') : null,
  ] });
}

/** Contribute the lazy filterable plugin tab to the Plugins settings section. */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-plugin-manager: dictionaries')

  const t = ctx.locale.bind(NS)
  const list = async () => {
    const result = await ctx.remote.pluginInventory.list()
    if (!result.ok) {
      throw new Error('pluginInventory.list failed: ' + result.error.code + ': ' + result.error.message)
    }
    return result.value
  }
  const injected = () => ({ list })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'manager',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
    children: { 'settings.plugin.manager.item': {
      kind: 'list',
      scope: 'root',
    } },
  }, PluginManagerSettingsTab))
}

module.exports = { apply, inject, NS };
return module.exports;
} });
