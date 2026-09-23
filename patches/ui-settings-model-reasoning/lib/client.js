/**
 * ui-settings-model-reasoning — browser half: per-model thinking configuration
 * for hand-declared `llm-pi-ai` routes.
 *
 * The shipped Models settings section deliberately leaves reasoning effort out
 * of its editors ("effort is a per-MODEL capability"), yet a hand-declared
 * route cannot express it in the UI either — only `settings.yaml` can. This
 * plugin fills that seat through the section's own extension point: the keyed
 * `settings.models.provider-card` slot (dispatched with `entryKey` = the
 * provider row's settings namespace), so one registration here lands on every
 * pi-ai provider card.
 *
 * Data rides the shipped settings transport, never a private channel: the
 * plugin binds `ctx.settingsScope` to the `llm-pi-ai` namespace and writes
 * through that scope's path operator —
 * `scope.mutate([{ op: 'set', path: [...providerPath, 'models'], value }])` —
 * while reads ride the same scope's describe mirror (`scope.getSnapshot()` and
 * `scope.subscribe()`), so the Host stays the single fact source and concurrent
 * edits fence on the revision. The scope controller owns the underlying
 * `remote.settings` calls, which is why this half injects `settingsScope`
 * rather than `remote.settings` itself.
 *
 * Hand-written in the client-bundle contract (no build step): the shell's
 * module loader receives this file through `window.__ModuleLoader__.load` and
 * answers every `require()` from the frozen module table. Only platform seed
 * words are used: `react`, `react/jsx-runtime`, and the shared primitives
 * (`Switch`, `Input`, icons).
 */
window.__ModuleLoader__.load({ id: '@local/dsh-client-ui-settings-model-reasoning', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useState, useSyncExternalStore } = React;
const { jsx, jsxs } = require('react/jsx-runtime');
const { Switch, Input, IconChevronDownOutline14 } = require('@deepseek-ai/dsh-client-ui-primitives');

const PLUGIN_ID = '@local/dsh-client-ui-settings-model-reasoning';

/** Locale namespace of this plugin's copy. */
const NS = 'modelReasoning';

/** Settings namespace owning hand-declared pi-ai routes (the slot's key). */
const PI_AI_NS = 'llm-pi-ai';

/** Declared effort vocabulary, escalation order (mirrors the pi-ai profile schema). */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Levels staged in when a model is switched on; mirrors the known-good profile. */
const DEFAULT_LEVELS = { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' };

const CSS = [
  '.mr-card{display:flex;flex-direction:column;gap:10px;margin-top:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2)}',
  '.mr-head{display:flex;flex-direction:column;gap:2px}',
  '.mr-title{font-size:13px;line-height:20px;font-weight:600}',
  '.mr-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.mr-model{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}',
  '.mr-row{display:flex;align-items:center;gap:10px}',
  '.mr-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}',
  '.mr-state{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
  '.mr-expand{appearance:none;display:flex;align-items:center;gap:2px;font:inherit;font-size:12px;line-height:1.5;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:3px 8px;color:var(--dsw-alias-label-secondary);background:0 0}',
  '.mr-expand:hover:enabled{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-interactive-bg-hover)}',
  '.mr-expand:disabled{opacity:.5;cursor:default}',
  '.mr-chevron{transition:transform .16s}',
  '.mr-chevron-open{transform:rotate(180deg)}',
  '.mr-levels{display:flex;flex-direction:column;gap:6px;border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-3)}',
  '.mr-level{display:flex;align-items:center;gap:10px}',
  '.mr-level-name{flex:none;width:44px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.mr-wire{flex:1;min-width:0}',
  '.mr-off{flex:1;font-size:12px;color:var(--dsw-alias-label-caption)}',
  '.mr-foot{display:flex;align-items:center;gap:8px}',
  '.mr-error{flex:1;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
  '.mr-spacer{flex:1}',
  '.mr-save,.mr-discard{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:4px 12px;font-size:12px;line-height:1.5}',
  '.mr-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}',
  '.mr-save{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}',
  /* The theme ships no on-business/on-accent foreground alias (design-platform.css
     defines only the label-* family plus `--dsw-alias-label-primary-foreground`,
     the on-fill color the shipped Button.primary pairs with its fill), so the blue
     business fill borrows that on-fill foreground instead of a literal #fff: white
     on deepseek-500 in light mode, near-black on deepseek-400 in dark mode. */
  '.mr-save:disabled,.mr-discard:disabled{opacity:.5;cursor:default}',
].join('\n');

/** Simplified Chinese dictionary for the thinking-config card. */
const zh = {
  title: '思考配置',
  hint: '开启后该模型在输入框的模型菜单中出现「推理等级」；可选择档位并设置各自的发送值。',
  stateOn: '思考已开启',
  stateOff: '思考已关闭',
  stateInherit: '未配置',
  levels: '档位',
  collapse: '收起',
  save: '保存',
  discard: '放弃',
  saving: '保存中…',
  invalid: '至少保留一个思考档位,且发送值不能为空',
  saveFailed: '保存失败:配置未生效',
  offNote: '不发送参数',
  'level.off': '关闭',
  'level.minimal': '最低',
  'level.low': '低',
  'level.medium': '中',
  'level.high': '高',
  'level.xhigh': '超高',
  'level.max': '最高',
  'aria.enabled': '{model} 思考开关',
  'aria.levels': '{model} 档位设置',
  'aria.wire': '{level} 发送值',
};

/** English dictionary checked against the Chinese key set. */
const en = {
  title: 'Thinking',
  hint: 'Once on, this model offers a Reasoning level row in the composer model menu; pick levels and their wire values.',
  stateOn: 'Thinking on',
  stateOff: 'Thinking off',
  stateInherit: 'Not configured',
  levels: 'Levels',
  collapse: 'Collapse',
  save: 'Save',
  discard: 'Discard',
  saving: 'Saving…',
  invalid: 'Keep at least one thinking level, and wire values must not be empty',
  saveFailed: 'Save failed: the configuration did not stick',
  offNote: 'Sends nothing',
  'level.off': 'Off',
  'level.minimal': 'Minimal',
  'level.low': 'Low',
  'level.medium': 'Medium',
  'level.high': 'High',
  'level.xhigh': 'Xhigh',
  'level.max': 'Max',
  'aria.enabled': '{model} thinking switch',
  'aria.levels': '{model} level editor',
  'aria.wire': '{level} wire value',
};

/** Services required by the registrations. */
const inject = ['slots', 'locale', 'settingsScope'];

/** Whether a wire value is a plain object (the `reasoningEfforts` map shape). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walk one plain-object path; undefined when any segment is missing. */
function sectionAt(root, path) {
  let current = root;
  for (const segment of Array.isArray(path) ? path : []) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Normalize one model's stored `reasoningEfforts` into a staged state.
 * @param reasoningEfforts - the model entry's field (false | level map | absent).
 * @returns { enabled, levels, configured } — levels only meaningful when enabled.
 */
function stateOf(reasoningEfforts) {
  if (reasoningEfforts === false) return { enabled: false, levels: { ...DEFAULT_LEVELS }, configured: true };
  if (isPlainObject(reasoningEfforts)) {
    const levels = {};
    for (const level of LEVELS) {
      if (!(level in reasoningEfforts)) continue;
      const wire = reasoningEfforts[level];
      levels[level] = wire === null ? null : String(wire);
    }
    return { enabled: true, levels, configured: true };
  }
  return { enabled: false, levels: { ...DEFAULT_LEVELS }, configured: false };
}

/** The `reasoningEfforts` wire value one staged state writes (false disables reasoning). */
function levelsToConfig(state) {
  if (state.enabled !== true) return false;
  const config = {};
  for (const level of LEVELS) {
    if (!(level in state.levels)) continue;
    config[level] = level === 'off' ? null : state.levels[level];
  }
  return config;
}

/** Whether a staged state satisfies the profile schema (≥1 thinking level, non-empty wires). */
function validState(state) {
  if (state.enabled !== true) return true;
  const thinking = LEVELS.filter((level) => level !== 'off' && level in state.levels);
  if (thinking.length === 0) return false;
  return thinking.every((level) => typeof state.levels[level] === 'string' && state.levels[level].length > 0);
}

/** Stable serialization of a staged state for dirty comparison (level order is the vocabulary's). */
function canonical(state) {
  const levels = {};
  for (const level of LEVELS) if (level in state.levels) levels[level] = state.levels[level];
  return JSON.stringify({ enabled: state.enabled === true, levels });
}

/** Apply the staged states over the models array; models without a stage pass through untouched. */
function applyDrafts(models, drafts) {
  return models.map((model) => {
    const state = drafts[model.id];
    if (state === undefined) return model;
    return { ...model, reasoningEfforts: levelsToConfig(state) };
  });
}

/** Toggle one level's membership in a staged state (rebuilt in vocabulary order). */
function withLevel(state, level, member) {
  const levels = {};
  for (const name of LEVELS) {
    if (name === level) {
      if (member) levels[name] = state.levels[name] ?? (name === 'off' ? null : name);
      continue;
    }
    if (name in state.levels) levels[name] = state.levels[name];
  }
  return { ...state, levels };
}

/** Replace one level's wire value inside a staged state. */
function withWire(state, level, wire) {
  const levels = {};
  for (const name of LEVELS) {
    if (!(name in state.levels)) continue;
    levels[name] = name === level ? wire : state.levels[name];
  }
  return { ...state, levels };
}

/** One provider card's thinking-configuration editor. */
function ModelReasoningCard({ provider, t, scope }) {
  // The scope's methods are unbound class methods (this-bound to the
  // controller), so both reads must arrive as method calls.
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  );
  const [drafts, setDrafts] = useState({});
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);

  const path = Array.isArray(provider?.settingsPath) ? provider.settingsPath : [];
  const modelsFrom = (snap) => {
    const section = sectionAt(snap.user, path) ?? sectionAt(snap.value, path);
    return Array.isArray(section?.models) ? section.models : [];
  };
  const models = modelsFrom(snapshot);
  const readOnly = snapshot.writable === false || snapshot.status !== 'ready';

  const staged = (model) => drafts[model.id] ?? stateOf(model.reasoningEfforts);
  const dirty = models.some((model) => drafts[model.id] !== undefined
    && canonical(drafts[model.id]) !== canonical(stateOf(model.reasoningEfforts)));

  const edit = (model, next) => {
    setFailed(null);
    setDrafts((current) => ({ ...current, [model.id]: next(staged(model)) }));
  };
  const discard = () => {
    setDrafts({});
    setFailed(null);
    setOpenId(null);
  };

  const save = async () => {
    if (busy) return;
    setFailed(null);
    const pending = {};
    for (const model of models) {
      const state = drafts[model.id];
      if (state === undefined || canonical(state) === canonical(stateOf(model.reasoningEfforts))) continue;
      if (!validState(state)) {
        setFailed(t('invalid'));
        return;
      }
      pending[model.id] = state;
    }
    const ids = Object.keys(pending);
    if (ids.length === 0) return;
    const next = applyDrafts(models, pending);
    setBusy(true);
    try {
      await scope.mutate([{ op: 'set', path: [...path, 'models'], value: next }]);
      // A refused write only reloads Host state (the scope never rejects), so
      // compare the folded section: unchanged reasoningEfforts means refusal.
      const fresh = modelsFrom(scope.getSnapshot());
      const landed = ids.every((id) => {
        const model = fresh.find((candidate) => candidate.id === id);
        return model !== undefined
          && JSON.stringify(model.reasoningEfforts ?? null) === JSON.stringify(levelsToConfig(pending[id]));
      });
      if (landed) {
        // The write folded into the section: the drafts are now the stored state.
        setDrafts({});
        setOpenId(null);
      } else {
        // A refused write leaves Host state untouched, so the drafts are kept:
        // the user's edits survive and only the failure is surfaced.
        setFailed(t('saveFailed'));
      }
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (snapshot.status !== 'ready' || models.length === 0) return null;

  const levelName = (level) => t('level.' + level);
  const stateLabel = (state) => state.enabled
    ? t('stateOn')
    : state.configured ? t('stateOff') : t('stateInherit');

  return jsxs('div', { className: 'mr-card', children: [
    jsxs('div', { className: 'mr-head', children: [
      jsx('span', { className: 'mr-title', children: t('title') }, 'title'),
      jsx('span', { className: 'mr-hint', children: t('hint') }, 'hint'),
    ] }, 'head'),
    ...models.map((model) => {
      const state = staged(model);
      const name = String(model.name ?? model.id);
      const open = openId === model.id && state.enabled;
      return jsxs('div', { className: 'mr-model', children: [
        jsxs('div', { className: 'mr-row', children: [
          jsx('span', { className: 'mr-name', title: name, children: name }, 'name'),
          jsx('span', { className: 'mr-state', children: stateLabel(state) }, 'state'),
          jsx(Switch, {
            checked: state.enabled,
            disabled: readOnly || busy,
            label: t('aria.enabled', { model: name }),
            onChange: (next2) => {
              edit(model, (current) => ({ ...current, enabled: next2 }));
              if (next2) setOpenId(model.id);
            },
          }, 'switch'),
          jsx('button', {
            type: 'button',
            className: 'mr-expand',
            'aria-expanded': open,
            'aria-label': t('aria.levels', { model: name }),
            disabled: readOnly || busy || !state.enabled,
            onClick: () => { setOpenId(open ? null : model.id) },
            children: [
              jsx(IconChevronDownOutline14, { className: open ? 'mr-chevron mr-chevron-open' : 'mr-chevron' }, 'chevron'),
              jsx('span', { children: open ? t('collapse') : t('levels') }, 'label'),
            ],
          }, 'expand'),
        ] }, 'row'),
        !open ? null : jsx('div', { className: 'mr-levels', children: LEVELS.map((level) => {
          const member = level in state.levels;
          return jsxs('div', { className: 'mr-level', children: [
            jsx(Switch, {
              checked: member,
              disabled: readOnly || busy,
              label: levelName(level),
              onChange: (next2) => { edit(model, (current) => withLevel(current, level, next2)) },
            }, 'switch'),
            jsx('span', { className: 'mr-level-name', children: levelName(level) }, 'label'),
            level === 'off'
              ? jsx('span', { className: 'mr-off', children: t('offNote') }, 'off')
              : jsx(Input, {
                className: 'mr-wire',
                value: member ? state.levels[level] : '',
                placeholder: level,
                disabled: readOnly || busy || !member,
                'aria-label': t('aria.wire', { level: levelName(level) }),
                onChange: (event) => { edit(model, (current) => withWire(current, level, event.target.value)) },
              }, 'wire'),
          ] }, level);
        }) }, 'levels'),
      ] }, String(model.id));
    }),
    jsxs('div', { className: 'mr-foot', children: [
      failed === null
        ? jsx('span', { className: 'mr-spacer' }, 'spacer')
        : jsx('span', { className: 'mr-error', children: failed }, 'error'),
      jsx('button', {
        type: 'button',
        className: 'mr-discard',
        disabled: busy || !dirty,
        onClick: discard,
        children: t('discard'),
      }, 'discard'),
      jsx('button', {
        type: 'button',
        className: 'mr-save',
        disabled: busy || !dirty,
        onClick: () => { void save() },
        children: busy ? t('saving') : t('save'),
      }, 'save'),
    ] }, 'foot'),
  ] });
}

/** Contribute the thinking-configuration card to every pi-ai provider card. */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'model-reasoning: dictionaries')
  const scope = ctx.settingsScope.bind({ namespace: PI_AI_NS })
  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: PI_AI_NS,
    locale: NS,
    inject: () => ({ scope }),
  }, ModelReasoningCard))
}

/* Inject once per page; the module loader tracks style[data-plugin] tags and
   removes them when the bundle unloads, so the data-plugin-css id is the guard
   against a second copy of this sheet (hot reload, double materialization). */
(function () {
  if (typeof document === 'undefined') return
  const tagId = PLUGIN_ID + '/model-reasoning.css'
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
  const style = document.createElement('style');
  style.dataset.plugin = PLUGIN_ID;
  style.dataset.pluginCss = tagId;
  style.textContent = CSS;
  document.head.appendChild(style);
})();

module.exports = { apply, inject, NS, stateOf, levelsToConfig, validState, canonical, applyDrafts, withLevel, withWire, sectionAt };
return module.exports;
}});
