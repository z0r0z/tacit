// How the site is used, as counts: a page names something that happened (the trade page opened, the Bitcoin lane chosen, a lot checked) and the API adds one to that day's total for the
// name (worker/src/metrics.js). Nothing goes with the name: no address, no identifier, no cookie (the request carries no credentials), and the API never reads who sent it.
// It is not sent: off the live site (an http page, localhost, a page with no real browser, as the headless one a service runs), by a browser that sends Do Not Track or Global
// Privacy Control, by automation (navigator.webdriver), or when the visitor has switched it off: localStorage 'tacit-metrics' set to '0'.
// The names are the API's list; one that is not on it is not sent (a mistyped name counts nothing, there or here).

const API = 'https://api.tacit.finance';
export const EVENTS = [
  'trade_view', 'trade_via_menu', 'trade_via_chip', 'trade_via_lander', 'trade_via_assets', 'trade_via_share',
  'lane_btc', 'lane_eth', 'lane_cmp', 'lane_btc_link', 'btc_alt_click',
  'buy_btc_click', 'bid_btc_click', 'sell_btc_click', 'list_btc_click', 'btc_sheet_open',
  'lot_check_start', 'lot_check_pass', 'lot_check_fail', 'btc_bought', 'btc_sold', 'btc_listed',
];
export const SOURCES = ['menu', 'chip', 'lander', 'assets', 'share'];     // where a link to the trade page says it was followed from (?src=)
const LIST = new Set(EVENTS);

export function enabled(env = globalThis) {
  try {
    const loc = env.location, nav = env.navigator;
    if (!loc || loc.protocol !== 'https:' || /^(localhost|127\.|\[::1\])/.test(loc.hostname || '')) return false;
    if (!nav || nav.webdriver === true) return false;
    if (nav.doNotTrack === '1' || env.doNotTrack === '1' || nav.msDoNotTrack === '1' || nav.globalPrivacyControl === true) return false;
    try { if (env.localStorage && env.localStorage.getItem('tacit-metrics') === '0') return false; } catch { /* no storage: counted */ }
    if (env.document && env.document.visibilityState === 'prerender') return false;
    return true;
  } catch { return false; }
}

// A counter bound to an environment (the page's own, or one a test gives it). count(name) never throws and never waits; { once: true } sends a name once per page.
export function makeCount(env = globalThis, { base = API } = {}) {
  const seen = new Set();
  return function count(name, { once = false } = {}) {
    try {
      if (!LIST.has(name) || !enabled(env)) return false;
      if (once) { if (seen.has(name)) return false; seen.add(name); }
      const url = `${base}/metrics/event`;
      if (typeof env.navigator.sendBeacon === 'function' && env.navigator.sendBeacon(url, name)) return true;
      if (typeof env.fetch === 'function') { env.fetch(url, { method: 'POST', body: name, keepalive: true, credentials: 'omit', mode: 'cors' }).catch(() => {}); return true; }
    } catch { /* counting is never the page's trouble */ }
    return false;
  };
}
export const count = makeCount();
