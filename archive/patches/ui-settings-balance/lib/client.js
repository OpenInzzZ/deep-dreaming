/**
 * Client half of the ui-settings-balance patch: one settings section showing the
 * account balance (recharge wallet + bonus wallets) that the host half reads
 * from DSH's own `deepseekAccount` service.
 *
 * Scope is deliberate: this section ONLY shows balances. It owns no controls,
 * no service lifecycle and no network of its own beyond the single `/app/balance`
 * call — restarting the app, signing in and topping up are all owned by DSH
 * itself, and the panel links to DSH's own account view instead of duplicating it.
 *
 * Balance changes when the user spends credits elsewhere, so the panel re-reads
 * on mount, on an explicit refresh, and when the tab becomes visible again after
 * the longest staleness window. It does NOT poll on a short timer: a surprise
 * re-render of a number the user is reading is worse than a slightly stale one.
 */
window.__ModuleLoader__.load({ id: '@local/dsh-client-ui-settings-balance', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const React = require('react');
const { useEffect, useRef, useState } = React;
const { jsx, jsxs } = require('react/jsx-runtime');
const { IconRefreshOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');

const PLUGIN_ID = '@local/dsh-client-ui-settings-balance';
const NS = 'ui-settings-balance';

/** How long a loaded balance is considered fresh when the tab becomes visible. */
const STALE_AFTER_MS = 5 * 60_000;

/* Injected once per page; the module loader tracks `style[data-plugin]` tags
   and removes them when the bundle unloads. */
const CSS = [
  '.usb-section{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary)}',
  '.usb-card{display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px 16px;background:var(--dsw-alias-bg-layer-3)}',
  '.usb-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
  '.usb-title{margin:0;font-size:14px;line-height:20px;font-weight:600}',
  '.usb-note{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
  '.usb-refresh{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer}',
  '.usb-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.usb-refresh[disabled]{opacity:.5;cursor:default}',
  '.usb-wallets{display:flex;flex-direction:column;gap:8px}',
  '.usb-wallet{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
  '.usb-wallet-label{font-size:13px;color:var(--dsw-alias-label-secondary)}',
  '.usb-wallet-amount{font-family:var(--ds-font-family-code);font-size:16px;font-weight:600}',
  '.usb-status{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
  '.usb-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
  '.usb-status[data-tone="success"]{color:var(--dsw-alias-state-success-primary)}',
  '.usb-signin{font-size:13px;line-height:20px;color:var(--dsw-alias-state-business-primary)}',
].join('\n');

/* Locale dictionaries. Both are required: the locale service refuses a namespace
   whose shipped locales are incomplete. */
const zh = {
  nav: '账户余额',
  title: '账户余额',
  desc: '显示当前 DeepSeek 账户的充值余额与赠金余额。数据来自 dsh 自带的账户服务，凭据不会经过本插件。',
  loading: '读取中…',
  refresh: '刷新',
  recharge: '充值余额',
  bonus: '赠金余额',
  empty: '账户暂无余额记录。',
  signedOut: '尚未登录：请在「账户」设置中登录后再回到本页。',
  unavailable: '宿主未挂载 deepseekAccount 服务，余额不可用。',
  failed: '余额查询失败：',
  updated: '已更新',
  currency: { CNY: '人民币', USD: '美元' },
};

const en = {
  nav: 'Account balance',
  title: 'Account balance',
  desc: 'Shows the recharge and bonus balances of the current DeepSeek account. The data comes from dsh\'s own account service; credentials never pass through this plugin.',
  loading: 'Loading…',
  refresh: 'Refresh',
  recharge: 'Recharge balance',
  bonus: 'Bonus balance',
  empty: 'This account has no balance records.',
  signedOut: 'Not signed in: sign in under the Account settings, then return to this page.',
  unavailable: 'The host has no deepseekAccount service mounted, so balances are unavailable.',
  failed: 'Balance query failed: ',
  updated: 'Updated',
  currency: { CNY: 'CNY', USD: 'USD' },
};

/** One `{ currency, balance }` row. */
function WalletRow({ wallet, label, currencyNames }) {
  const code = typeof wallet?.currency === 'string' ? wallet.currency : '';
  const name = currencyNames?.[code] ?? code;
  return jsxs('div', { className: 'usb-wallet', children: [
    jsx('span', { className: 'usb-wallet-label', children: label + (name === '' ? '' : ' · ' + name) }, 'label'),
    jsx('span', { className: 'usb-wallet-amount', children: String(wallet?.balance ?? '') }, 'amount'),
  ] }, 'wallet-' + code + '-' + label);
}

/**
 * The balance panel.
 *
 * `balance` is the injected host call. Every outcome is rendered from the
 * host's `status` tag: collapsing "signed out" and "query failed" into an empty
 * balance would show a signed-out user as having no money.
 */
function BalanceSection({ balance, t }) {
  const [state, setState] = useState({ phase: 'loading', value: null, error: null });
  const [freshAt, setFreshAt] = useState(null);
  // Distinguishes a manual refresh from a background one, so the button shows a
  // busy state only when the user asked for it.
  const manual = useRef(false);
  const inFlight = useRef(false);

  const load = (isManual) => {
    if (inFlight.current) return;
    inFlight.current = true
    if (isManual) setState((previous) => ({ ...previous, phase: 'loading', error: null }))
    void Promise.resolve()
      .then(() => balance())
      .then(
        (value) => {
          inFlight.current = false
          setState({ phase: 'ready', value, error: null })
          setFreshAt(Date.now())
        },
        (error) => {
          inFlight.current = false
          setState({ phase: 'error', value: null, error: String(error?.message ?? error) })
        },
      )
  };

  useEffect(() => { load(true) }, []);

  // Re-read when the tab returns after the staleness window; a balance the user
  // is currently looking at must not silently change under them.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (freshAt !== null && Date.now() - freshAt < STALE_AFTER_MS) return
      load(false)
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [freshAt]);

  const value = state.value;
  const showLoading = state.phase === 'loading' && value === null;
  const currencyNames = t('currency') ?? {};

  let body;
  if (showLoading) {
    body = jsx('p', { className: 'usb-status', children: t('loading') }, 'loading');
  } else if (state.phase === 'error') {
    body = jsx('p', { className: 'usb-status', 'data-tone': 'error', children: t('failed') + state.error }, 'error');
  } else if (value?.status === 'signed-out') {
    body = jsx('p', { className: 'usb-signin', children: t('signedOut') }, 'signed-out');
  } else if (value?.status === 'unavailable') {
    body = jsx('p', { className: 'usb-status', 'data-tone': 'error', children: value.reason ?? t('unavailable') }, 'unavailable');
  } else if (value?.status === 'failed') {
    body = jsx('p', { className: 'usb-status', 'data-tone': 'error', children: t('failed') + (value.reason ?? '') }, 'failed');
  } else {
    const wallets = Array.isArray(value?.wallets) ? value.wallets : [];
    const bonusWallets = Array.isArray(value?.bonusWallets) ? value.bonusWallets : [];
    const rows = [
      ...wallets.map((wallet, index) => jsx(WalletRow, { wallet, label: t('recharge'), currencyNames }, 'recharge-' + index)),
      ...bonusWallets.map((wallet, index) => jsx(WalletRow, { wallet, label: t('bonus'), currencyNames }, 'bonus-' + index)),
    ];
    body = rows.length === 0
      ? jsx('p', { className: 'usb-status', children: t('empty') }, 'empty')
      : jsx('div', { className: 'usb-wallets', children: rows }, 'wallets');
  }

  return jsx('div', { className: 'usb-section', children: [
    jsx('div', { className: 'usb-card', children: [
      jsxs('div', { className: 'usb-head', children: [
        jsx('h3', { className: 'usb-title', children: t('title') }, 'title'),
        jsx('button', {
          type: 'button',
          className: 'usb-refresh',
          title: t('refresh'),
          'aria-label': t('refresh'),
          disabled: state.phase === 'loading' ? true : undefined,
          onClick: () => { manual.current = true; load(true) },
          children: jsx(IconRefreshOutlineRegular, {}, 'icon'),
        }, 'refresh'),
      ] }, 'head'),
      jsx('p', { className: 'usb-note', children: t('desc') }, 'desc'),
      body,
      freshAt !== null && state.phase === 'ready'
        ? jsx('p', { className: 'usb-status', 'data-tone': 'success', children: t('updated') + ' · ' + new Date(freshAt).toLocaleTimeString() }, 'fresh')
        : null,
    ] }, 'card'),
  ] });
}

/** The single `/app` call this patch makes. Same-origin JSON, fenced host side. */
const call = async (endpoint, args) => {
  let response;
  try {
    response = await fetch('/app/' + endpoint, {
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

/** `webServer`-backed host channel; the slot layer injects nothing by itself. */
const inject = ['slots', 'locale'];

function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-balance: section dictionaries');

  // One <style> tag per bundle; the loader removes it on unload. Guarded so a
  // remount cannot stack duplicates.
  ctx.effect(() => {
    if (document.querySelector('style[data-plugin="' + PLUGIN_ID + '"]') === null) {
      const style = document.createElement('style');
      style.setAttribute('data-plugin', PLUGIN_ID);
      style.setAttribute('data-plugin-css', 'true');
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    return () => {
      const style = document.querySelector('style[data-plugin="' + PLUGIN_ID + '"]');
      if (style !== null) style.remove();
    };
  }, 'ui-settings-balance: styles');

  const t = ctx.locale.bind(NS);
  const balance = () => call('balance', {});

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'balance',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ balance }),
  }, BalanceSection));
}

module.exports = { apply, inject, NS };
return module.exports;
} });
