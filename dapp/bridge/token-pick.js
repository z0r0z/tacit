// Any ERC-20 on the bridge page's tile.
//
// The pool escrows any token, and a token crosses to Bitcoin and back the way cUSDT does (dapp/bridge/runtime.js); the tile's tabs are the five assets this page explains. A token
// outside them is named by its address: pasted, or one this browser has bridged (readRuntime). Its symbol and decimals are read from the token itself, the tile shows its steps,
// and its button opens the front page on that token's bridge (`#card=bridge:xw0x…` to Bitcoin, `#card=bridge:xb0x…` back), where a token not yet in the pool opens on its Shield tab.

export const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const isAddr = (s) => ADDR.test(String(s || '').trim());
export const norm = (s) => String(s || '').trim().toLowerCase();
export const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// The tile's own address in the page's hash: #0x… arrives from Bitcoin (as #tac does), #0x…/out goes to Bitcoin.
export const tokenHash = (addr, dir) => `#${norm(addr)}${dir === 'out' ? '/out' : ''}`;
export function parseTokenHash(hash) {
  const [a, d] = String(hash || '').replace(/^#/, '').toLowerCase().split('/');
  return ADDR.test(a || '') ? { addr: a, dir: d === 'out' ? 'out' : 'in' } : null;
}

// Where the button goes: the front page's bridge on this token. A link to Bitcoin starts from the wallet (the first press makes it private, the next bridges it).
export const tokenStart = (addr, dir) => `/#card=bridge:${dir === 'out' ? 'xw' : 'xb'}${norm(addr)}`;

// A token's own name for itself is text from an unknown contract: it is kept to what a symbol is, or the address stands in for it.
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._$+-]{0,11}$/;
export const safeSymbol = (s, addr) => (SAFE.test(String(s || '').trim()) ? String(s).trim() : shortAddr(norm(addr)));

// The string an ERC-20 answers for symbol() or name(): an ABI string, or a bytes32 for the older tokens (MKR, SAI).
export function decodeString(hex) {
  const h = String(hex || '').replace(/^0x/, '');
  if (h.length < 64 || /[^0-9a-fA-F]/.test(h)) return '';
  const bytes = (s) => { const out = []; for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16)); return out; };
  const text = (arr) => { const clean = arr.filter((b) => b !== 0); return clean.every((b) => b >= 32 && b < 127) ? String.fromCharCode(...clean) : ''; };
  if (h.length === 64) return text(bytes(h));
  const off = parseInt(h.slice(0, 64), 16), len = off === 32 ? parseInt(h.slice(64, 128), 16) : -1;
  if (len < 0 || len > 128 || h.length < 128 + len * 2) return '';
  return text(bytes(h.slice(128, 128 + len * 2)));
}

// → { addr, ticker, name, dec } or null when the address is no token (no code, or no symbol). `call(to, data)` is an eth_call returning the hex answer.
export async function readToken({ call, addr }) {
  const a = norm(addr);
  if (!isAddr(a)) return null;
  const [sym, nm, dec] = await Promise.all([call(a, '0x95d89b41'), call(a, '0x06fdde03'), call(a, '0x313ce567')].map((p) => Promise.resolve(p).catch(() => null)));
  const symbol = decodeString(sym);
  if (!symbol) return null;
  const d = dec && /^0x[0-9a-fA-F]+$/.test(dec) ? Number(BigInt(dec)) : NaN;
  if (!Number.isInteger(d) || d < 0 || d > 36) return null;
  return { addr: a, ticker: safeSymbol(symbol, a), name: decodeString(nm).slice(0, 40), dec: d };
}

// The tile's route for a token (the shape dapp/bridge/track.js ROUTES has): its steps, and where each direction's button goes.
export function tokenRoute(token, bridgeRoute) {
  // a note holds at most 8 decimals of a token (the pool's unit), whatever the token itself has
  const dec = Math.min(8, token.dec ?? 8);
  const base = bridgeRoute({ ticker: token.ticker, icon: `tk-x${token.addr}`, dp: Math.min(dec, 4), dec, addr: token.addr });
  base.in = { ...base.in, start: tokenStart(token.addr, 'in') };
  base.out = { ...base.out, start: tokenStart(token.addr, 'out') };
  return base;
}
