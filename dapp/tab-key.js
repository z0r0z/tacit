// The Tacit key kept for one browser tab, so one sign-in opens it on every page of tacit.finance the tab goes to. It lives in sessionStorage:
// this tab only (another tab, or another site, cannot read it), gone when the tab closes, dropped as the key is locked (or the wallet that
// opened it switches accounts or locks), and dropped after IDLE with no page of the site used. It is never put in localStorage.
//   Pages: tabKeyWrite(k) as a key opens, tabKeyClear() as it locks, tabKeyRead() as a page opens (null: sign in as before), tabKeyWatch() once.
const K = 'tacit-tab-key-v1';
export const IDLE = 30 * 60e3;
const FIELDS = ['mode', 'priv', 'pubHex', 'address', 'label', 'credentialId'];

function raw() { try { return JSON.parse(sessionStorage.getItem(K) || 'null'); } catch { return null; } }

/// The key this tab opened, while it is still fresh: { mode, priv (hex), pubHex, address?, label?, credentialId? }, or null.
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
  try { sessionStorage.setItem(K, JSON.stringify(rec)); } catch { /* a tab that cannot keep it signs in on each page, as before */ }
}
export function tabKeyClear() { try { sessionStorage.removeItem(K); } catch { /* nothing kept */ } }

// a press, a key or the page shown again keeps it fresh (once a minute at most); one already past IDLE is dropped, not revived
let last = 0;
function touch() {
  const now = Date.now();
  if (now - last < 60e3) return;
  last = now;
  const j = raw();
  if (!j) return;
  if (!(now - (j.at || 0) < IDLE)) { tabKeyClear(); return; }
  j.at = now;
  try { sessionStorage.setItem(K, JSON.stringify(j)); } catch { /* kept as it was */ }
}
export function tabKeyWatch() {
  for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, touch, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) touch(); });
}
