// What a key and its wallet hold, as the Portfolio sheet groups it. The front page keeps one row for each thing held (its "Your Tacit"
// items); this sorts those rows into the places they are held, splits TAC into its private and its public part, and counts a pool's
// liquidity once whether it is farming or not. Pure: no DOM and no network, so it runs in a test.
const PLACES = [['private', 'Private'], ['pay', 'Pay pool'], ['lp', 'Liquidity'], ['public', 'Public'], ['bitcoin', 'On Bitcoin'], ['earned', 'Rewards'], ['owed', 'Loans']];
const EARNED = new Set(['pts', 'air', 'farm', 'rtac']);
const ON_BITCOIN = /^(btc|btc-.+|sats-.+|tethbtc|usdtbtc|tacbridged)$/;
// The order of a group's rows: the asset a place is known for first, the rest as the page lists them.
const FIRST = ['teth', 'tac', 'ctac', 'dev', 'devtac', 'tacpub', 'btc', 'pts', 'farm', 'rtac', 'air'];
const rank = (r) => { const i = FIRST.indexOf(r.key); return i < 0 ? FIRST.length + (/^(tethbtc|usdtbtc|tacbridged)$/.test(r.key) ? 1 : 0) : i; };

export function placeOf(it) {
  const k = it.key;
  if (/^lpf?-/.test(k) || k === 'pubf') return 'lp';
  if (EARNED.has(k)) return 'earned';
  if (k === 'loans') return 'owed';
  if (ON_BITCOIN.test(k)) return 'bitcoin';
  if (/^dev/.test(k)) return 'pay';
  return typeof it.meta === 'string' && /^(public|on Ethereum)/.test(it.meta) ? 'public' : 'private';
}

// A row's own line under its name: where it is held is its group's name, so only what that does not say is kept.
function noteOf(it, place) {
  if (it.where != null) return it.where;
  const m = it.meta;
  if (typeof m !== 'string') return m || '';
  if (place === 'bitcoin') return m.replace(/^Secret Sats, private on Bitcoin$/, 'Secret Sats').replace(/^(?:bridged to|on) Bitcoin(?: · )?/, '');
  return m.replace(/^(?:private|public)(?: on this device)?(?:,\s*|\s+(?=on )|$)/, '');
}

// `usd(row)`: what a row is worth in dollars, null when it is not counted or not known; `amount(v, dec, max)` writes an amount;
// `hasKey`: a Tacit wallet is open (with only a connected wallet there is no private side to show).
export function portfolio(items, { usd = () => null, amount = (v) => String(v), hasKey = true } = {}) {
  const by = Object.fromEntries(PLACES.map(([id]) => [id, []])), pools = new Map();
  for (const it of items || []) {
    if (it.key === 'tac') {
      const priv = it.priv ?? null, pub = it.v != null && priv != null ? it.v - priv : null;
      const base = { ...it, meta: '', note: '' };
      if (hasKey) by.private.push({ ...base, v: priv, place: 'private' });
      if (!hasKey || pub == null || pub > 0n) by.public.push({ ...base, key: 'tacpub', kind: 'tac', v: pub, noteVals: null, place: 'public' });
      continue;
    }
    const lp = /^(lpf?)-(.+)$/.exec(it.key);
    if (lp) {
      const p = pools.get(lp[2]) || {};
      p[lp[1] === 'lpf' ? 'farming' : 'loose'] = it;
      if (!pools.has(lp[2])) { pools.set(lp[2], p); by.lp.push(p); }
      continue;
    }
    const place = placeOf(it);
    by[place].push({ ...it, place, note: it.key === 'pubf' ? 'public farm' : noteOf(it, place) });
  }
  by.lp = by.lp.map((p) => {
    if (p.place) return p;
    const { farming: f, loose: l } = p, one = f || l, known = (!f || f.v != null) && (!l || l.v != null);
    const part = (x) => amount(x.v, x.dec, x.max);
    return { ...one, key: `lp-${one.key.replace(/^lpf?-/, '')}`, place: 'lp', ring: !!f, v: known ? (f?.v ?? 0n) + (l?.v ?? 0n) : null,
      note: f && l ? (known ? `${part(f)} farming · ${part(l)} not farmed` : 'partly farming') : f ? 'farming' : 'not farmed' };
  });
  const groups = [];
  for (const [id, name] of PLACES) {
    const rows = by[id].map((r, i) => [r, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([r]) => r);
    if (!rows.length) continue;
    let sum = null;
    for (const r of rows) { r.usd = usd(r); if (r.usd != null) sum = (sum ?? 0) + r.usd; }
    groups.push({ id, name, rows, usd: sum });
  }
  return groups;
}
