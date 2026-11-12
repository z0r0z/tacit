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
}
export function tabKeyClear() { try { sessionStorage.removeItem(K); } catch { } }

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
export function tabKeyWatch() {
  for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, touch, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) touch(); });
}
