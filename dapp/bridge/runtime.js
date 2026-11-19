// Any token the pool escrows crosses to Bitcoin and back the way cUSDT does: under its own pool id with no Bitcoin link (a returning note resolves
// straight to the escrow), by the same burn, proof and mint as every bridged asset. What a runtime token still needs is what a built-in one has by hand:
// the steps its row shows, and a name. It has no limit of its own: a new token often has no market to price it, and the bridge needs none. What
// bounds a crossing is what a note can hold, and (in the engine) that it be more than its relay fee. A price, when there is one, only sets how many
// decimals its figures show.
const MAX_RAW = 10n ** 18n;   // a note's value is a u64
export const NO_LIMITS = Object.freeze({ minRaw: 1n, capRaw: MAX_RAW });

// How many decimals a figure of this token shows: fewer for a cheap token, more for a dear one.
export const bridgeDp = (usdPerToken, tdec) => Math.min(tdec, usdPerToken >= 100 ? 6 : usdPerToken >= 1 ? 4 : 2);

const STEPS_OUT = ['Burned on Ethereum', 'Proven for Bitcoin', 'Sent to Bitcoin', 'Arrived'];
const STEPS_IN = ['Burned on Bitcoin', 'Confirmed', 'Proven on Ethereum', 'Minted privately'];

// The tracker's route entry (dapp/bridge/track.js ROUTES) for a token: its row names, where a row's link sends the page (the bridge tab: its deep-link
// grammar names only the built-in sources, so a token with an address links by that), and the steps.
export function bridgeRoute({ ticker, icon, dp, dec, addr }) {
  // a token named by its address opens its own card on the front page (#card=bridge:xw0x… to Bitcoin, xb back); the bare #bridge is the TAC page there
  const to = /^0x[0-9a-fA-F]{40}$/.test(addr || '') ? (k) => `/#card=bridge:x${k}${addr.toLowerCase()}` : () => '/#bridge';
  return {
    ticker, icon, dp, ...(dec != null && dec !== 8 ? { dec } : {}),
    in: { start: to('b'), href: to('b'), go: `Bring ${ticker} back`, steps: STEPS_IN },
    out: { start: to('w'), href: to('w'), go: `Bridge ${ticker}`, steps: STEPS_OUT },
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
