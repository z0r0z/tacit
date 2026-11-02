import { makeKeySession, signInSheet } from '/trade/key.js?cb=ef6b24d1';
import { makeTacitSession } from '/tacit-session.js?cb=a2d34bb2';
import { getUx, forgetUx } from '/trade/poolux.js?cb=ac4a1175';
import { makeHttpCounter } from '/fastbridge-http.js?cb=11295986';
import { mountFast } from '/fast/ui.js?cb=0168ba89';
import { openFast } from '/fast/wire.js?cb=6dab14bf';
import { secp, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';

// The fast bridge page: TAC held on Bitcoin goes to the key's private balance through a liquidity provider (docs/FAST-BRIDGE.md).
// The providers are the ones /fast/lp.json names, each with the key it signs for; a provider run on this machine can be named in the
// address (?lp=<url>&claimPub=<hex>) when the page is open from localhost.
const TACIT_URL = '/tacit.js?cb=262f9a47';

async function providers() {
  const q = new URLSearchParams(location.search);
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && q.get('lp')) return [{ name: 'Local provider', base: q.get('lp'), claimPub: q.get('claimPub') || null }];
  try {
    const r = await fetch('/fast/lp.json', { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
    const j = r.ok ? await r.json() : null;
    return Array.isArray(j?.providers) ? j.providers : [];
  } catch { return []; }
}

let ui = null;
const keyS = makeKeySession({ moved: (why) => ui?.lock(why) });
const TS = makeTacitSession({ url: TACIT_URL, key: () => (keyS.unlocked ? { pubHex: keyS.key.pubHex, priv: bytesToHex(keyS.priv()) } : null), secp, bytesToHex, hexToBytes });
keyS.onChange(() => { if (!keyS.unlocked) { TS.drop(); forgetUx(); } });

ui = mountFast({
  root: document.getElementById('gate'),
  providers: await providers(),
  keyS,
  signIn: () => signInSheet(keyS, { why: 'Open your Tacit wallet to bridge TAC from Bitcoin.' }),
  info: (p) => makeHttpCounter({ base: p.base }).info(),
  open: async ({ provider }) => {
    const pubHex = keyS.key.pubHex, priv = keyS.priv(), ux = await getUx();
    return TS.withKey((T) => openFast({ T, withKey: (fn) => TS.withKey(fn, pubHex), ux, priv, pubHex, lp: provider }), pubHex);
  },
});
