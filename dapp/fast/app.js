import { openBtcWallet } from '/trade/btc-session.js?cb=e18cdf04';
import { isPasskeyAvailable } from '/prf-wallet.js';
import { makeKeySession, signInSheet } from '/trade/key.js?cb=26d9c07b';
import { makeTacitSession } from '/tacit-session.js?cb=a2d34bb2';
import { getUx as loadUx, forgetUx } from '/trade/poolux.js?cb=39bc83e6';
import { onMainnet, connectedInjected } from '/eth-nodes.js';
import { mountFast } from '/fast/ui.js?cb=8c0b458c';
import { mountProvide } from '/fast/provide.js?cb=05e506f6';
import { mountBound } from '/fast/bound.js?cb=862c8d6e';
import { openFast, openProvider, openBound, discoverProviders, PROVIDER_DEFAULTS } from '/fast/wire.js?cb=3197d845';
import { makeWants } from '/fast/want.js?cb=3dad1fd3';
import { secp, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';

// The fast bridge page: TAC held on Bitcoin goes to the key's private balance through a provider, and any key can be a provider
// (docs/FAST-BRIDGE.md). The providers are the ones /fast/lp.json names, each with the key it signs for, and the ones that post
// their ads on the boards it names. A provider run on this machine can be named in the address
// (?lp=<url>&claimPub=<hex>&board=<url>) when the page is open from localhost.
const TACIT_URL = '/tacit.js?cb=63fac4ae';

async function lists() {
  const q = new URLSearchParams(location.search);
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && (q.get('lp') || q.get('board'))) {
    return { providers: q.get('lp') ? [{ name: 'Local provider', base: q.get('lp'), claimPub: q.get('claimPub') || null }] : [], boards: q.get('board') ? [q.get('board')] : [] };
  }
  try {
    const r = await fetch('/fast/lp.json', { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
    const j = r.ok ? await r.json() : null;
    return { providers: Array.isArray(j?.providers) ? j.providers : [], boards: Array.isArray(j?.boards) ? j.boards : [] };
  } catch { return { providers: [], boards: [] }; }
}
const LISTS = await lists();

// what a key provides is kept in this browser, apart from the swaps of the same key as a user
const OPEN_PREFIX = (pub) => `tacit-fastlp-v1:mainnet:${pub}:swaps:`;
const ENDED = ['done', 'refunded', 'rejected', 'aborted', 'lost'];
const hasOpen = (pub) => {
  try {
    const p = OPEN_PREFIX(pub);
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(p) && !ENDED.includes(JSON.parse(localStorage.getItem(k)).phase)) return true; }
  } catch { /* nothing kept */ }
  return false;
};
const SETTINGS = (pub) => `tacit-fastlp-settings-v1:${pub}`;
const settings = {
  get: (pub) => { try { return JSON.parse(localStorage.getItem(SETTINGS(pub))); } catch { return null; } },
  set: (pub, v) => { try { localStorage.setItem(SETTINGS(pub), JSON.stringify(v)); } catch { /* a convenience */ } },
};

let ui = null, TS = null;
// The pool module reads Ethereum through public nodes and, as the last of them, the wallet this page opened the key with (while it is on
// mainnet), else a wallet the site is already connected to: a provider whose public nodes refuse it keeps working through its own wallet.
const walletRead = onMainnet(() => keyS.walletProvider?.() || null);
// the wallet a settle the relay holds is sent from: the one the key was opened with, else one the site is connected to (it is asked to be on mainnet)
const sendWallet = () => keyS.walletProvider?.() || connectedInjected();
// while the wallet is asked to send a settle the relay holds, the page says why it opened
let asking = 0;
const ask = (on) => {
  asking = Math.max(0, asking + (on ? 1 : -1));
  const el = document.getElementById('fx-wallet'); if (el) el.hidden = !asking;
  if (on) notify('The relay is holding a step of your bridge: confirm it in your wallet.');
};
const getUx = async () => { const ux = await loadUx(); ux.useWallet(() => walletRead() || connectedInjected()); return ux; };
// a Bitcoin wallet opens the key through tacit.js, which this page loads for the bridge anyway
const keyS = makeKeySession({ moved: (why) => ui?.lock(why), ways: { btc: (k) => TS.turn(() => openBtcWallet(TS.T, { k, tPriv: TS.tPriv, passkey: isPasskeyAvailable() })) } });
TS = makeTacitSession({ url: TACIT_URL, key: () => (keyS.unlocked ? { pubHex: keyS.key.pubHex, priv: bytesToHex(keyS.priv()) } : null), secp, bytesToHex, hexToBytes });
keyS.onChange(() => { if (!keyS.unlocked) { TS.drop(); forgetUx(); } });

// a want kept while no provider takes the amount, and the notification when one can (asked for with the press that starts waiting)
const wants = Object.assign(makeWants({ boards: LISTS.boards, providers: LISTS.providers }), {
  ask: async () => { try { if (typeof Notification === 'function' && Notification.permission === 'default') await Notification.requestPermission(); } catch { /* the page says it as well */ } },
});
const notify = (text) => {
  try { if (document.hidden && typeof Notification === 'function' && Notification.permission === 'granted') { const n = new Notification('Fast bridge', { body: text, tag: 'tacit-fast-want', icon: '/favicon.svg' }); n.onclick = () => { focus(); n.close(); }; } } catch { /* the page says it */ }
};

// /fast/#with=<id>: a provider's pairing link (fast/fmt.js pairId), kept for this visit
const PIN = (/^#with=([0-9a-f]{16})$/i.exec(location.hash) || [])[1]?.toLowerCase() || null;
ui = mountFast({
  root: document.getElementById('gate'), keyS, wants, notify, pinned: () => PIN,
  signIn: () => signInSheet(keyS, { icons: true, why: 'Open your Tacit wallet to bridge or provide TAC.' }),
  discover: () => discoverProviders(LISTS),
  open: async () => {
    const pubHex = keyS.key.pubHex, priv = keyS.priv(), ux = await getUx();
    return TS.withKey((T) => openFast({ T, withKey: (fn) => TS.withKey(fn, pubHex), ux, priv, pubHex, wallet: sendWallet, ask }), pubHex);
  },
});

mountBound({
  root: document.getElementById('ready'), keyS,
  open: async () => {
    const pubHex = keyS.key.pubHex, priv = keyS.priv(), ux = await getUx();
    return TS.withKey((T) => openBound({ T, withKey: (fn) => TS.withKey(fn, pubHex), ux, priv, pubHex }), pubHex);
  },
});

const provide = mountProvide({
  base: PROVIDER_DEFAULTS, notify, ask: () => wants.ask(), root: document.getElementById('provide'), keyS, hasOpen, settings, waiting: () => wants.waiting(),
  open: async () => {
    const pubHex = keyS.key.pubHex, priv = keyS.priv(), ux = await getUx();
    return TS.withKey((T) => openProvider({ T, ux, priv, pubHex, boards: LISTS.boards, wallet: sendWallet, ask }), pubHex);
  },
});
// a page closed while it provides, or while a swap it provides is open, leaves that swap untended
window.addEventListener('beforeunload', (e) => { if (provide.busy()) { e.preventDefault(); e.returnValue = ''; } });
