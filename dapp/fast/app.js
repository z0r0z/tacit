import { openBtcWallet } from '/trade/btc-session.js?cb=0f0a650d';
import { isPasskeyAvailable } from '/prf-wallet.js';
import { makeKeySession, signInSheet } from '/trade/key.js?cb=709c122d';
import { makeTacitSession } from '/tacit-session.js?cb=a2d34bb2';
import { getUx, forgetUx } from '/trade/poolux.js?cb=ac4a1175';
import { mountFast } from '/fast/ui.js?cb=6f7d0555';
import { mountProvide } from '/fast/provide.js?cb=c95bfb67';
import { mountBound } from '/fast/bound.js?cb=0';
import { openFast, openProvider, openBound, discoverProviders } from '/fast/wire.js?cb=3ce66630';
import { secp, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';

// The fast bridge page: TAC held on Bitcoin goes to the key's private balance through a provider, and any key can be a provider
// (docs/FAST-BRIDGE.md). The providers are the ones /fast/lp.json names, each with the key it signs for, and the ones that post
// their ads on the boards it names. A provider run on this machine can be named in the address
// (?lp=<url>&claimPub=<hex>&board=<url>) when the page is open from localhost.
const TACIT_URL = '/tacit.js?cb=262f9a47';

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
// a Bitcoin wallet opens the key through tacit.js, which this page loads for the bridge anyway
const keyS = makeKeySession({ moved: (why) => ui?.lock(why), ways: { btc: (k) => TS.turn(() => openBtcWallet(TS.T, { k, tPriv: TS.tPriv, passkey: isPasskeyAvailable() })) } });
TS = makeTacitSession({ url: TACIT_URL, key: () => (keyS.unlocked ? { pubHex: keyS.key.pubHex, priv: bytesToHex(keyS.priv()) } : null), secp, bytesToHex, hexToBytes });
keyS.onChange(() => { if (!keyS.unlocked) { TS.drop(); forgetUx(); } });

ui = mountFast({
  root: document.getElementById('gate'), keyS,
  signIn: () => signInSheet(keyS, { icons: true, why: 'Open your Tacit wallet to bridge or provide TAC.' }),
  discover: () => discoverProviders(LISTS),
  open: async () => {
    const pubHex = keyS.key.pubHex, priv = keyS.priv(), ux = await getUx();
    return TS.withKey((T) => openFast({ T, withKey: (fn) => TS.withKey(fn, pubHex), ux, priv, pubHex }), pubHex);
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
  root: document.getElementById('provide'), keyS, hasOpen, settings,
  open: async () => {
    const pubHex = keyS.key.pubHex, priv = keyS.priv(), ux = await getUx();
    return TS.withKey((T) => openProvider({ T, ux, priv, pubHex, boards: LISTS.boards }), pubHex);
  },
});
// a page closed while it provides, or while a swap it provides is open, leaves that swap untended
window.addEventListener('beforeunload', (e) => { if (provide.busy()) { e.preventDefault(); e.returnValue = ''; } });
