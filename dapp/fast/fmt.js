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

// a provider is named in a pairing link (/fast/#with=…) by 16 hex digits of its claim key, after its first byte
export const pairId = (claimPub) => String(claimPub || '').replace(/^0x/, '').toLowerCase().slice(2, 18);

// a fee over 5% of the amount is a high one: the fast page says so plainly, and the front page's Bridge tab does not prefer such a quote
export const FEE_WARN_BPS = 500n;
// a take on Bitcoin far above what it costs at the current rate (fastbridge-client.js); the quote stands, and a page says so
export const highTake = (q) => !!q.highTake;
// the end of a provider's key, shown beside the name it chose for itself
export const keyTag = (id) => { const h = String(id || '').replace(/^0x/, '').toLowerCase(); return h.length >= 12 ? `${h.slice(2, 8)}…${h.slice(-4)}` : h; };
export const highFee = (q) => (q.highFee != null ? !!q.highFee : BigInt(q.fee) * 10000n > BigInt(q.btcValue) * FEE_WARN_BPS);

// Why a lock was not built: no provider online takes TAC whose history passes through something the bridge's proof does not follow.
const THROUGH = { shielded: 'a move through Bitcoin’s shielded pool', pool: 'a pool or farm trade on Bitcoin', arrived: 'TAC that came over from Ethereum' };
export function lineageText(e) {
  const refused = (e && e.refused) || [], kinds = [...new Set(refused.map((r) => THROUGH[r.through] || 'a transaction'))];
  const sum = refused.reduce((s, r) => s + BigInt(r.amount || 0), 0n), left = e && e.left != null ? BigInt(e.left) : 0n;
  return `${sum > 0n ? `${fmtTac(sum)} TAC of yours` : 'This TAC'} has a history that includes ${kinds.join(' and ') || 'a transaction'}, which the bridge’s proof does not follow, and no provider online takes it right now. Nothing was locked.${left > 0n ? ` Your other TAC on Bitcoin, ${fmtTac(left)}, can still go: try a smaller amount.` : ''}`;
}
