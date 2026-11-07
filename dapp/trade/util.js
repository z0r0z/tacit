// Small helpers the tETH page's modules share: markup, numbers, and the page's reads of the chain and the API.

import { hedgedRpc, shareReads } from '/trade/rpc.js';
import { ETH_NODES } from '/eth-nodes.js';
import { grp, sig, group } from '/trade/fmt.js?cb=32b1744b';

export const API = 'https://api.tacit.finance';
export const RPCS = ETH_NODES;
export const E10 = 10n ** 10n, E18 = 10n ** 18n;

export const $ = (s, r = document) => r.querySelector(s);
export const html = (strings, ...vals) => strings.reduce((a, s, i) => a + s + (i < vals.length ? String(vals[i] ?? '') : ''), '');
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const strip = (h) => String(h).replace(/^0x/, '');
export const word = (v) => BigInt(v).toString(16).padStart(64, '0');
export const wordAt = (hex, i) => BigInt('0x' + (strip(hex).slice(i * 64, (i + 1) * 64) || '0'));
export const now = () => Math.floor(Date.now() / 1000);
export const short = (a, n = 4) => (!a ? '' : a.length > 2 * n + 4 ? `${a.slice(0, n + 2)}…${a.slice(-n)}` : a);

// ── reading the chain ──
// `hosts` orders the nodes asked: a read only one of them serves (a wide log range) names it first, so the others do not each refuse it before it.
// `opts` are hedgedRpc's (`health`, `hedgeMs`). The same read asked for twice at once goes to the nodes once (shareReads).
const shared = shareReads(hedgedRpc);
export const rpc = (method, params, hosts = RPCS, opts) => shared(hosts, method, params, opts);
export const ethCall = (to, data, block = 'latest') => rpc('eth_call', [{ to, data }, block]);
export const api = (path) => fetch(`${API}${path}`, { signal: AbortSignal.timeout(15e3) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

// ── formatting ──
export { grp, sig };
export const usd = (x) => (x == null || !Number.isFinite(x) ? '—' : x >= 1000 ? `$${grp(x, 0)}` : x >= 1 ? `$${x.toFixed(2)}` : `$${x.toPrecision(3)}`);
export const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(Math.abs(x) >= 0.095 ? 0 : d)}%`);
export function fmtUnits(v, dec = 18, max = 4) {
  let n = BigInt(v), neg = n < 0n; if (neg) n = -n;
  const base = 10n ** BigInt(dec), frac = (n % base).toString().padStart(dec, '0').slice(0, max).replace(/0+$/, '');
  return `${neg ? '−' : ''}${group(n / base)}${frac ? `.${frac}` : ''}`;
}
// A bigint as plain digits for an input: no grouping, no trailing zeros.
export const plain = (v, dec = 18) => { const n = BigInt(v), base = 10n ** BigInt(dec), f = (n % base).toString().padStart(dec, '0').replace(/0+$/, ''); return `${n / base}${f ? `.${f}` : ''}`; };
// An amount as the front page reads it: a comma between digits is a thousands separator only where it plainly is one (1,500.25 or 1,000,000),
// a lone comma is a decimal point (0,05), and an ambiguous 1,500 is left unread rather than guessed. Anything else with a comma is unread.
export function parseUnits(text, dec = 18) {
  let t = String(text ?? '').trim().replace(/[_\s]/g, '');
  if (t.includes(',')) {
    if (/^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d*)?$/.test(t) && (t.includes('.') || t.indexOf(',') !== t.lastIndexOf(','))) t = t.replace(/,/g, '');
    else if (/^\d*,\d*$/.test(t) && !/^[1-9]\d{0,2},\d{3}$/.test(t)) t = t.replace(',', '.');
    else return null;
  }
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const [w, f = ''] = t.split('.');
  if (f.length > dec) return null;
  return BigInt(w || '0') * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
}
export const ago = (t) => { const s = Math.max(0, now() - t); return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
