// Any token the pool escrows crosses to Bitcoin and back the way cUSDT does: under its own pool id with no Bitcoin link (a returning note resolves
// straight to the escrow), by the same burn, proof and mint as every bridged asset. What a runtime token still needs is what a built-in one has by hand:
// a limit for a crossing, the steps its row shows, and a name. The limits come from its market price (a crossing is a start, raised once round trips
// have been through, as for the others): a token no market prices has no limit, and no new crossing.
export const BRIDGE_MIN_USD = 2, BRIDGE_CAP_USD = 1000;
const MAX_RAW = 10n ** 18n;   // a note's value is a u64

// two significant digits: down for a limit's top, up for its bottom
function twoSig(x, up) {
  const s = x.toString();
  if (s.length <= 2) return x;
  const cut = 10n ** BigInt(s.length - 2), q = x / cut;
  return (up && x % cut ? q + 1n : q) * cut;
}

// The smallest and largest crossing in the token's Tacit units (tdec decimals), or null when the price or the precision leaves no sensible range.
// Exact integer arithmetic on the price at a millionth of a millionth of a dollar: a float turns $2 at $100,000 a token into 2,001 units of 2,000.
export function bridgeLimits({ usdPerToken, tdec, minUsd = BRIDGE_MIN_USD, capUsd = BRIDGE_CAP_USD }) {
  const p = Number(usdPerToken);
  if (!(p > 0) || !Number.isFinite(p) || !Number.isInteger(tdec) || tdec < 0 || tdec > 8) return null;
  const P = BigInt(Math.round(p * 1e12));
  if (P <= 0n) return null;
  const U = 10n ** 12n, ONE = 10n ** BigInt(tdec), ceilDiv = (x, y) => (x + y - 1n) / y;
  let cap = (BigInt(capUsd) * U * ONE) / P, min = ceilDiv(BigInt(minUsd) * U * ONE, P);
  if (min < 1n) min = 1n;
  if (cap > MAX_RAW) cap = MAX_RAW;
  cap = twoSig(cap, false); min = twoSig(min, true);
  return cap >= min * 10n ? { minRaw: min, capRaw: cap } : null;
}

// How many decimals a figure of this token shows: fewer for a cheap token, more for a dear one.
export const bridgeDp = (usdPerToken, tdec) => Math.min(tdec, usdPerToken >= 100 ? 6 : usdPerToken >= 1 ? 4 : 2);

const STEPS_OUT = ['Burned on Ethereum', 'Proven for Bitcoin', 'Sent to Bitcoin', 'Arrived'];
const STEPS_IN = ['Burned on Bitcoin', 'Confirmed', 'Proven on Ethereum', 'Minted privately'];

// The tracker's route entry (dapp/bridge/track.js ROUTES) for a token: its row names, where a row's link sends the page (the bridge tab: its deep-link
// grammar names only the built-in sources), and the steps.
export function bridgeRoute({ ticker, icon, dp, dec }) {
  return {
    ticker, icon, dp, ...(dec != null && dec !== 8 ? { dec } : {}),
    in: { start: '/#bridge', href: '/#bridge', go: `Bring ${ticker} back`, steps: STEPS_IN },
    out: { start: '/#bridge', href: '/#bridge', go: `Bridge ${ticker}`, steps: STEPS_OUT },
  };
}

// The tracker's limits entry: a crossing to Bitcoin between the least and the most, and back up to the most.
export const bridgeLimitEntry = ({ minRaw, capRaw }) => ({ in: { max: capRaw }, out: { min: minRaw, max: capRaw } });

// ── What a page that has not met the token keeps of it ──
// The front page learns a token's name, mark and limits as it meets it; the /bridge/ page and the next visit read this to show a crossing of it by
// name, in its own mark, with the steps and the limit that crossing started under, not as TAC (the tracker's fallback).
export const RUNTIME_STORE = 'tacit-bridge-runtime-v1';
const MAX_SAVED = 64;
const ADDR = /^0x[0-9a-f]{40}$/, HEX64 = /^[0-9a-f]{64}$/;

// A token with no logo of its own is a colour of its address under its first two letters.
export const markColor = (id) => { let h = 7; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 38% 48%)`; };
export const runtimeIcon = (addr) => `tk-x${addr}`;
// A logo is a path on this site; anything else is not drawn.
const ownLogo = (v) => (/^\/(?!\/)/.test(String(v || '')) ? String(v) : '');

// The sprite <symbol> for a token's mark: its logo clipped to a circle, or the letter mark.
export function runtimeSymbol(doc, { addr, logo, sym }) {
  const ns = 'http://www.w3.org/2000/svg', id = runtimeIcon(addr);
  const el = (n, a = {}) => { const e = doc.createElementNS(ns, n); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); return e; };
  const s = el('symbol', { id, viewBox: '0 0 32 32' });
  if (ownLogo(logo)) {
    const clip = el('clipPath', { id: `${id}-c` }); clip.append(el('circle', { cx: 16, cy: 16, r: 16 }));
    s.append(clip, el('image', { href: logo, width: 32, height: 32, 'clip-path': `url(#${id}-c)`, preserveAspectRatio: 'xMidYMid slice' }));
  } else {
    const t = el('text', { x: 16, y: 21, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 600, fill: '#fff', 'font-family': 'sans-serif' });
    t.textContent = String(sym || '?').slice(0, 2).toUpperCase();
    s.append(el('circle', { cx: 16, cy: 16, r: 16, fill: markColor(addr) }), t);
  }
  return s;
}

// What is kept of a token: where it is (its key is 'x' and its address), what it is called and drawn as, how it is shown, and the limits of a crossing.
function entry(e) {
  const addr = String(e?.addr || '').toLowerCase(), id = String(e?.id || '').replace(/^0x/i, '').toLowerCase();
  const dp = Number(e?.dp), dec = Number(e?.dec), ticker = String(e?.ticker || '').slice(0, 40), sym = String(e?.sym || '').slice(0, 40);
  if (!ADDR.test(addr) || !HEX64.test(id) || !ticker || !Number.isInteger(dp) || dp < 0 || dp > 8 || !Number.isInteger(dec) || dec < 0 || dec > 8) return null;
  let minRaw, capRaw;
  try { minRaw = BigInt(e.minRaw ?? 0); capRaw = BigInt(e.capRaw ?? 0); } catch { return null; }
  if (minRaw < 0n || capRaw < 0n || capRaw > MAX_RAW || minRaw > capRaw) return null;
  return { key: `x${addr}`, id, addr, ticker, sym: sym || ticker, logo: ownLogo(e.logo), dp, dec, minRaw, capRaw };
}
export function readRuntime(storage) {
  let raw;
  try { raw = JSON.parse(storage.getItem(RUNTIME_STORE) || '[]'); } catch { return []; }
  return (Array.isArray(raw) ? raw : []).map(entry).filter(Boolean).slice(-MAX_SAVED);
}
export function saveRuntime(storage, e) {
  const one = entry(e);
  if (!one) return false;
  try {
    const rest = readRuntime(storage).filter((x) => x.key !== one.key);
    const out = [...rest, one].slice(-MAX_SAVED).map((x) => ({ ...x, minRaw: String(x.minRaw), capRaw: String(x.capRaw) }));
    storage.setItem(RUNTIME_STORE, JSON.stringify(out));
    return true;
  } catch { return false; }
}
