/**
 * ui-settings-model-capabilities — browser half: per-model capability
 * configuration for hand-declared `llm-pi-ai` routes.
 *
 * Two capabilities, one surface. The shipped Models section renders a model
 * row with id/name, context window, output cap, and a 输入类型 checkbox pair
 * (`input`), and its provider editor states outright that reasoning effort is
 * absent because "effort is a per-MODEL capability". A hand-declared route can
 * therefore only express thinking by hand-editing its configuration file. This
 * plugin fills that seat through the section's own extension point: the keyed
 * `settings.models.provider-card` slot (dispatched with `entryKey` = the
 * provider row's settings namespace), so one registration here lands on every
 * pi-ai provider card.
 *
 *   - THINKING writes `reasoningEfforts` — `false` disables reasoning, a level
 *     map declares the offered levels and their wire spellings, absence
 *     inherits the installed catalog.
 *   - IMAGE INPUT writes `input` — `['text','image']` claims vision,
 *     `['text']` corrects a gateway that does not serve what the catalog
 *     records, and REMOVING the key restores inheritance (the catalog entry,
 *     then the route's `defaultInput`). The shipped checkbox cannot express
 *     that third state: it renders the inherited list and writes it back as a
 *     declaration the moment one box is touched, which pins an inherited model
 *     to a snapshot of the catalog. This card keeps the distinction visible —
 *     an empty array through the config schema's materialization is the
 *     adapter's own spelling of "no answer here", while a stored `input` is a
 *     declaration — and offers all three states as one segmented control.
 *
 * Data rides the shipped settings transport, never a private channel: the
 * plugin takes the `llm-pi-ai` namespace's shared form from `ctx.configForms`
 * and writes through that form's path operator —
 * `form.mutate([{ op: 'set', path: [...providerPath, 'models'], value }])` —
 * while reads ride the same form's snapshot (`form.getSnapshot()` and
 * `form.subscribe()`), so the Host stays the single fact source and concurrent
 * edits fence on the revision. The form already owns the underlying
 * `remote.settings` calls on the *provider's* fiber, which is why this half
 * injects `configForms` rather than `remote.settings` itself.
 *
 * The service was named `settingsScope` up to 0.1.7-alpha.1; it was renamed to
 * `configForms` and its single `bind({ namespace })` entry point became
 * `get(entryId)` (the settings namespace of a Host plugin entry IS its loader
 * entry id). Declaring the old name is not a soft failure: Cordis keeps the
 * entry pending on a service nobody provides, so this half never activated.
 *
 * Hand-written in the client-bundle contract (no build step): the shell's
 * module loader receives this file through `window.__ModuleLoader__.load` and
 * answers every `require()` from the frozen module table. Only platform seed
 * words are used: `react`, `react/jsx-runtime`, and the shared primitives
 * (`Switch`, `Input`, `SegmentedControl`, icons).
 */
window.__ModuleLoader__.load({ id: '@local/dsh-client-ui-settings-model-capabilities', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useId, useState, useSyncExternalStore } = React;
const { jsx, jsxs } = require('react/jsx-runtime');
const {
  Switch, Input, SegmentedControl, IconChevronDownOutlineMedium,
} = require('@deepseek-ai/dsh-client-ui-primitives');

const PLUGIN_ID = '@local/dsh-client-ui-settings-model-capabilities';

/** Locale namespace of this plugin's copy. */
const NS = 'modelCapabilities';

/** Settings namespace owning hand-declared pi-ai routes (the slot's key). */
const PI_AI_NS = 'llm-pi-ai';

/** Declared effort vocabulary, escalation order (mirrors the pi-ai profile schema). */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Levels staged in when a model is switched on; mirrors the known-good profile. */
const DEFAULT_LEVELS = { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' };

/** Request modalities the pi-ai profile schema accepts, in schema order. */
const MODALITIES = ['text', 'image'];

/** The three image-input states the card offers (a stored value is a declaration). */
const INPUT_STATES = ['inherit', 'text', 'image'];

/** What each state stores: `undefined` removes the key, restoring inheritance. */
const INPUT_MODALITIES = {
  inherit: undefined,
  text: ['text'],
  image: ['text', 'image'],
};

const CSS = [
  '.mc-card{display:flex;flex-direction:column;gap:10px;margin-top:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2)}',
  '.mc-head{display:flex;flex-direction:column;gap:2px}',
  '.mc-title{font-size:13px;line-height:20px;font-weight:600}',
  '.mc-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.mc-model{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}',
  '.mc-row{display:flex;align-items:center;gap:10px}',
  '.mc-cap{display:flex;align-items:center;gap:10px}',
  '.mc-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}',
  '.mc-state{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
  '.mc-expand{appearance:none;display:flex;align-items:center;gap:2px;font:inherit;font-size:12px;line-height:1.5;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:3px 8px;color:var(--dsw-alias-label-secondary);background:0 0}',
  '.mc-expand:hover:enabled{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-interactive-bg-hover)}',
  '.mc-expand:disabled{opacity:.5;cursor:default}',
  '.mc-chevron{transition:transform .16s}',
  '.mc-chevron-open{transform:rotate(180deg)}',
  '.mc-levels{display:flex;flex-direction:column;gap:6px;border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-3)}',
  '.mc-level{display:flex;align-items:center;gap:10px}',
  '.mc-level-name{flex:none;width:44px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.mc-wire{flex:1;min-width:0}',
  '.mc-cap-label{flex:none;width:44px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
  /* The shipped track is an inline-grid sized to its widest label, so a flex
     parent would leave it hugging that width; filling the row keeps the three
     segments as wide as the level editor below them. */
  '.mc-seg{flex:1;min-width:0;justify-self:stretch}',
  '.mc-foot{display:flex;align-items:center;gap:8px}',
  '.mc-error{flex:1;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
  '.mc-spacer{flex:1}',
  '.mc-save,.mc-discard{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:4px 12px;font-size:12px;line-height:1.5}',
  '.mc-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}',
  '.mc-save{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}',
  /* The theme ships no on-business/on-accent foreground alias (design-platform.css
     defines only the label-* family plus `--dsw-alias-label-primary-foreground`,
     the on-fill color the shipped Button.primary pairs with its fill), so the blue
     business fill borrows that on-fill foreground instead of a literal #fff: white
     on deepseek-500 in light mode, near-black on deepseek-400 in dark mode. */
  '.mc-save:disabled,.mc-discard:disabled{opacity:.5;cursor:default}',
].join('\n');

/** Simplified Chinese dictionary for the capability card. */
const zh = {
  title: '模型能力',
  hint: '思考开启后该模型在输入框的模型菜单中出现「推理等级」；图片输入决定该模型能否接收图片，选「跟随上游」则不声明，沿用上游目录或路由默认。',
  keys: '思考',
  stateOn: '思考已开启',
  stateOff: '思考已关闭',
  stateInherit: '未配置',
  levels: '档位',
  collapse: '收起',
  input: '图片',
  'input.inherit': '跟随上游',
  'input.text': '仅文本',
  'input.image': '支持图片',
  save: '保存',
  discard: '放弃',
  saving: '保存中…',
  invalid: '至少保留一个思考档位，且发送值不能为空',
  saveFailed: '保存失败：配置未生效',
  offNote: '不发送参数',
  'level.off': '关闭',
  'level.minimal': '最低',
  'level.low': '低',
  'level.medium': '中',
  'level.high': '高',
  'level.xhigh': '超高',
  'level.max': '最高',
  'aria.enabled': '{model} 思考开关',
  'aria.input': '{model} 图片输入',
  'aria.levels': '{model} 档位设置',
  'aria.wire': '{level} 发送值',
};

/** English dictionary checked against the Chinese key set. */
const en = {
  title: 'Capabilities',
  hint: 'Thinking adds a Reasoning level row to this model in the composer model menu; image input decides whether the model takes images — pick “Inherit” to declare nothing and keep the installed catalog or the route default.',
  keys: 'Thinking',
  stateOn: 'Thinking on',
  stateOff: 'Thinking off',
  stateInherit: 'Not configured',
  levels: 'Levels',
  collapse: 'Collapse',
  input: 'Images',
  'input.inherit': 'Inherit',
  'input.text': 'Text only',
  'input.image': 'Images',
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
  'aria.input': '{model} image input',
  'aria.levels': '{model} level editor',
  'aria.wire': '{level} wire value',
};

/** Services required by the registrations. */
const inject = ['slots', 'locale', 'configForms'];

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

/** One layer's `models` array for a provider path; `[]` when that layer has none. */
function modelsAt(root, path) {
  const section = sectionAt(root, path);
  return Array.isArray(section?.models) ? section.models : [];
}

/** One model entry of a layer by id; undefined when that layer does not carry it. */
function entryOf(models, id) {
  return models.find((candidate) => candidate?.id === id);
}

/**
 * The staged image-input state of one model.
 *
 * A stored `input` is a declaration (`[]` included, which the config schema
 * materializes for an absent array and the adapter reads as "no answer here" —
 * the same spelling an absent one produces), while a model the user layer does
 * not carry is answered by the section the Host resolved for it.
 * @param entry - the model entry in the layer under test.
 * @returns 'inherit' | 'text' | 'image'.
 */
function stateOfInput(entry) {
  const declared = entry?.input;
  if (!Array.isArray(declared)) return 'inherit';
  if (declared.includes('image')) return 'image';
  // `[]` and `['text']` are the same claim about the endpoint.
  return 'text';
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
      // pi-ai lets `off` carry a wire value (e.g. `none`, the README promise
      // the adapter test pins) and rejects an empty string on any level, so a
      // stored `off: ''` collapses to the "send nothing" spelling on read.
      levels[level] = wire === null || (level === 'off' && wire === '') ? null : String(wire);
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
    const wire = state.levels[level];
    // `off` writes what it staged: null means "supported, send nothing" while
    // a value (e.g. `none`) rides the wire — pi-ai keeps both in the map.
    // Other levels must carry a value; validState gates that before a save.
    config[level] = level === 'off'
      ? (wire === null || wire === '' ? null : String(wire))
      : wire;
  }
  return config;
}

/** Whether a staged state satisfies the profile schema (≥1 thinking level, non-empty wires, known modalities). */
function validState(state) {
  const input = state.input;
  if (input !== undefined && !(Array.isArray(input) && input.length > 0
    && input.every((modality) => MODALITIES.includes(modality)))) return false;
  if (state.enabled !== true) return true;
  // pi-ai: only `off` may carry null (or a value like `none`); an empty string
  // is rejected on every level, and at least one thinking level must exist.
  if ('off' in state.levels) {
    const off = state.levels.off;
    if (off !== null && !(typeof off === 'string' && off.length > 0)) return false;
  }
  const thinking = LEVELS.filter((level) => level !== 'off' && level in state.levels);
  if (thinking.length === 0) return false;
  return thinking.every((level) => typeof state.levels[level] === 'string' && state.levels[level].length > 0);
}

/**
 * Stable serialization of a staged state for dirty comparison.
 *
 * The image half is prefixed so a declaration is never equal to the inherited
 * state: `input` absent (inherit) and `input: undefined` (staged to inherit,
 * which writes the key away) have to compare equal, while `['text']` — the
 * same effective modalities for a hand-declared model, and a different
 * declaration — must not.
 */
function canonical(state) {
  const levels = {};
  for (const level of LEVELS) if (level in state.levels) levels[level] = state.levels[level];
  const input = state.input === undefined ? 'inherit' : `declared:${state.input.join('+')}`;
  return JSON.stringify({ enabled: state.enabled === true, levels, input });
}

/**
 * Apply the staged states over the models array; models without a stage pass
 * through untouched. An inherited image state (or one staged on a model whose
 * profile does not state it) REMOVES the key rather than storing the empty
 * list, so the profile keeps inheriting instead of pinning today's catalog.
 */
function applyDrafts(models, drafts) {
  return models.map((model) => {
    const state = drafts[model.id];
    if (state === undefined) return model;
    const next = { ...model, reasoningEfforts: levelsToConfig(state) };
    if (state.input === undefined) delete next.input;
    else next.input = [...state.input];
    return next;
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
  // Clearing the `off` input means "send nothing" — pi-ai spells that null;
  // an empty string would be rejected by the profile schema.
  const next = level === 'off' && wire === '' ? null : wire;
  const levels = {};
  for (const name of LEVELS) {
    if (!(name in state.levels)) continue;
    levels[name] = name === level ? next : state.levels[name];
  }
  return { ...state, levels };
}

/** Stage one image-input state ('inherit' | 'text' | 'image'). */
function withInput(state, input) {
  const next = { ...state };
  const modalities = INPUT_MODALITIES[input];
  if (modalities === undefined) delete next.input;
  else next.input = [...modalities];
  return next;
}

/** One provider card's per-model capability editor. */
function ModelCapabilitiesCard({ provider, t, scope }) {
  // The scope's methods are unbound class methods (this-bound to the
  // controller), so both reads must arrive as method calls.
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  );
  // `useId` keeps the segmented control's tab ids unique per provider card (the
  // slot dispatches one instance per card), and the sanitized model id keeps
  // them readable; the position disambiguates two rows sharing an id.
  const cardId = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const [drafts, setDrafts] = useState({});
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);

  const path = Array.isArray(provider?.settingsPath) ? provider.settingsPath : [];
  const models = modelsAt(snapshot.value, path);
  const stored = modelsAt(snapshot.user, path);
  const readOnly = snapshot.writable === false || snapshot.status !== 'ready';

  const stateOfModel = (model) => ({
    ...stateOf(model.reasoningEfforts),
    input: INPUT_MODALITIES[stateOfInput(entryOf(stored, model.id) ?? model)],
  });
  const staged = (model) => drafts[model.id] ?? stateOfModel(model);
  const dirty = models.some((model) => drafts[model.id] !== undefined
    && canonical(drafts[model.id]) !== canonical(stateOfModel(model)));

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
      if (state === undefined || canonical(state) === canonical(stateOfModel(model))) continue;
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
      // compare the folded section: unchanged capabilities means refusal.
      const freshModels = modelsAt(scope.getSnapshot().value, path);
      const landed = ids.every((id) => {
        const model = entryOf(freshModels, id);
        // The staged shape is rebuilt from the fresh entry, so a write that
        // landed reads back as the staged state and a refused one cannot.
        return model !== undefined
          && canonical(stateOfModel(model)) === canonical(pending[id]);
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
  const thinkingLabel = (state) => state.enabled
    ? t('stateOn')
    : state.configured ? t('stateOff') : t('stateInherit');
  const inputValue = (state) => INPUT_STATES.find((value) => {
    const modalities = INPUT_MODALITIES[value];
    if (modalities === undefined) return state.input === undefined;
    return state.input !== undefined && modalities.join('+') === state.input.join('+');
  }) ?? 'inherit';

  return jsxs('div', { className: 'mc-card', children: [
    jsxs('div', { className: 'mc-head', children: [
      jsx('span', { className: 'mc-title', children: t('title') }, 'title'),
      jsx('span', { className: 'mc-hint', children: t('hint') }, 'hint'),
    ] }, 'head'),
    ...models.map((model, index) => {
      const state = staged(model);
      const name = String(model.name ?? model.id);
      const open = openId === model.id && state.enabled;
      const locked = readOnly || busy;
      return jsxs('div', { className: 'mc-model', children: [
        jsxs('div', { className: 'mc-row', children: [
          jsx('span', { className: 'mc-name', title: name, children: name }, 'name'),
          jsx('span', { className: 'mc-state', children: thinkingLabel(state) }, 'state'),
          jsx(Switch, {
            checked: state.enabled,
            disabled: locked,
            label: t('aria.enabled', { model: name }),
            onChange: (next2) => {
              edit(model, (current) => ({ ...current, enabled: next2 }));
              if (next2) setOpenId(model.id);
            },
          }, 'switch'),
          jsx('button', {
            type: 'button',
            className: 'mc-expand',
            'aria-expanded': open,
            'aria-label': t('aria.levels', { model: name }),
            disabled: locked || !state.enabled,
            onClick: () => { setOpenId(open ? null : model.id) },
            children: [
              jsx(IconChevronDownOutlineMedium, { className: open ? 'mc-chevron mc-chevron-open' : 'mc-chevron' }, 'chevron'),
              jsx('span', { children: open ? t('collapse') : t('levels') }, 'label'),
            ],
          }, 'expand'),
        ] }, 'row'),
        !open ? null : jsx('div', { className: 'mc-levels', children: LEVELS.map((level) => {
          const member = level in state.levels;
          return jsxs('div', { className: 'mc-level', children: [
            jsx(Switch, {
              checked: member,
              disabled: locked,
              label: levelName(level),
              onChange: (next2) => { edit(model, (current) => withLevel(current, level, next2)) },
            }, 'switch'),
            jsx('span', { className: 'mc-level-name', children: levelName(level) }, 'label'),
            // Every level edits a wire value, `off` included: pi-ai keeps a
            // declared `off: none` in the map for dispatch (the README promise
            // for gateways that think by default), and an empty box means the
            // null spelling — supported, send nothing.
            jsx(Input, {
              className: 'mc-wire',
              value: member ? state.levels[level] ?? '' : '',
              placeholder: level === 'off' ? t('offNote') : level,
              disabled: locked || !member,
              'aria-label': t('aria.wire', { level: levelName(level) }),
              onChange: (event) => { edit(model, (current) => withWire(current, level, event.target.value)) },
            }, 'wire'),
          ] }, level);
        }) }, 'levels'),
        jsxs('div', { className: 'mc-cap', children: [
          jsx('span', { className: 'mc-cap-label', children: t('input') }, 'label'),
          // Three states, one control: the third (inherited) is the point —
          // clearing the declaration is what lets a catalog model keep
          // following the catalog instead of pinning today's answer.
          jsx(SegmentedControl, {
            id: `${cardId}-${index}`,
            className: 'mc-seg',
            value: inputValue(state),
            disabled: locked,
            label: t('aria.input', { model: name }),
            options: INPUT_STATES.map((value) => ({ value, label: t('input.' + value) })),
            onChange: (next2) => { edit(model, (current) => withInput(current, next2)) },
          }, 'input'),
        ] }, 'input-row'),
      ] }, String(model.id));
    }),
    jsxs('div', { className: 'mc-foot', children: [
      failed === null
        ? jsx('span', { className: 'mc-spacer' }, 'spacer')
        : jsx('span', { className: 'mc-error', children: failed }, 'error'),
      jsx('button', {
        type: 'button',
        className: 'mc-discard',
        disabled: busy || !dirty,
        onClick: discard,
        children: t('discard'),
      }, 'discard'),
      jsx('button', {
        type: 'button',
        className: 'mc-save',
        disabled: busy || !dirty,
        onClick: () => { void save() },
        children: busy ? t('saving') : t('save'),
      }, 'save'),
    ] }, 'foot'),
  ] });
}

/** Contribute the capability card to every pi-ai provider card. */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'model-capabilities: dictionaries')
  const scope = ctx.configForms.get(PI_AI_NS)
  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: PI_AI_NS,
    locale: NS,
    inject: () => ({ scope }),
  }, ModelCapabilitiesCard))
}

/* Inject once per page; the module loader tracks style[data-plugin] tags and
   removes them when the bundle unloads, so the data-plugin-css id is the guard
   against a second copy of this sheet (hot reload, double materialization). */
(function () {
  if (typeof document === 'undefined') return
  const tagId = PLUGIN_ID + '/model-capabilities.css'
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
  const style = document.createElement('style');
  style.dataset.plugin = PLUGIN_ID;
  style.dataset.pluginCss = tagId;
  style.textContent = CSS;
  document.head.appendChild(style);
})();

module.exports = {
  apply, inject, NS, PI_AI_NS, LEVELS, INPUT_STATES,
  stateOf, levelsToConfig, validState, canonical, applyDrafts, withLevel, withWire, withInput,
  sectionAt, modelsAt, entryOf, stateOfInput,
};
return module.exports;
}});
