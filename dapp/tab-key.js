const K = 'tacit-tab-key-v1';
export const IDLE = 30 * 60e3;
const FIELDS = ['mode', 'priv', 'pubHex', 'address', 'label', 'credentialId'];

function raw() { try { return JSON.parse(sessionStorage.getItem(K) || 'null'); } catch { return null; } }

export function tabKeyRead() {
  const j = raw();
  if (!j) return null;
  if (!/^[0-9a-f]{64}$/.test(j.priv || '') || !(Date.now() - (j.at || 0) < IDLE)) { tabKeyClear(); return null; }
  const k = {};
  for (const f of FIELDS) if (j[f] != null) k[f] = j[f];
  return k;
}
export function tabKeyWrite(k) {
  const priv = String(k?.priv || '').toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(priv)) return;
  const rec = { at: Date.now() };
  for (const f of FIELDS) if (k[f] != null) rec[f] = k[f];
  rec.priv = priv;
  try { sessionStorage.setItem(K, JSON.stringify(rec)); } catch { }
  said();
}
export function tabKeyClear() { try { sessionStorage.removeItem(K); } catch { } }
// A page can hold more than one session (the front page's own and the Bitcoin and Ethereum lane's in its swap card): a key opened by one after the
// other has loaded is told to the others in this tab, which open it the way they open it at load (tabKeyRead). The event carries no key.
const EV = 'tacit:tab-key';
function said() { try { dispatchEvent(new Event(EV)); } catch { } }
export function onTabKey(fn) { try { addEventListener(EV, fn); } catch { } return () => { try { removeEventListener(EV, fn); } catch { } }; }

let last = 0;
function touch() {
  const now = Date.now();
  if (now - last < 60e3) return;
  last = now;
  const j = raw();
  if (!j) return;
  if (!(now - (j.at || 0) < IDLE)) { tabKeyClear(); return; }
  j.at = now;
  try { sessionStorage.setItem(K, JSON.stringify(j)); } catch { }
}

// The last time anyone did anything on this page. `IDLE` is enforced against it: the tab's saved key is not only let go of at the next page load, the
// page is told (`onIdle`) so it locks the key it holds in memory, as its sign-in sheets say it does. `busy()` is true while an action runs (a proof,
// a send): a running action counts as use, so a key is never locked out from under it.
let seen = Date.now();
export const IDLE_WHY = 'Your Tacit wallet was locked after 30 minutes without use. Open it again to continue.';
export function tabKeyWatch({ onIdle = null, busy = null } = {}) {
  const bump = () => { seen = Date.now(); touch(); };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, bump, { passive: true, capture: true });
  const check = () => {
    const now = Date.now();
    let working = false;
    try { working = !!busy?.(); } catch { }
    // (while it runs, the tab's saved key is kept fresh too: a page opened from this one in the tab, once the action is done, finds the key still open)
    if (working) { seen = now; touch(); return; }
    if (now - seen < IDLE) return;
    seen = now;
    tabKeyClear();
    try { onIdle?.(IDLE_WHY); } catch { }
  };
  setInterval(check, 30e3);
  document.addEventListener('visibilitychange', () => { if (document.hidden) return; check(); touch(); });
  return check;
}
