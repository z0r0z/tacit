// TAC as the pages show it (8 places) and as a person types it. Shared by the bridge and the provider panels.

export const DEC = 8, ONE = 10n ** BigInt(DEC);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export function fmtTac(units, max = 4) {
  const n = BigInt(units), whole = n / ONE, frac = (n % ONE).toString().padStart(DEC, '0');
  const short = frac.slice(0, max).replace(/0+$/, '');
  const text = (k) => `${group(String(whole))}${k ? `.${k}` : ''}`;
  return n > 0n && whole === 0n && !short ? text(frac.replace(/0+$/, '')) : text(short);
}
export function parseTac(text) {
  const t = String(text).trim().replace(/,/g, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  if (f.length > DEC) return null;
  const n = BigInt(w || '0') * ONE + BigInt(f.padEnd(DEC, '0') || '0');
  return n > 0n ? n : null;
}

// A read that failed because no node answered (the pool module's `unreachable`, or the browser's own words for a connection that failed), not because of what was asked.
export const slowNet = (e) => !!e && (e.unreachable === true || /public nodes did not answer|failed to fetch|networkerror|load failed|network request failed/i.test(String(e.message || e)));
