// The relays anyone has listed in the relay registry, and how a page takes them.
//
// The registry (contracts/src/RelayRegistry.sol, on Ethereum) holds a stake of TAC for each relay a person lists: the relay's own key lists it, so the
// address a wallet pins is the one that made the entry. A page reads the list the way it reads any other chain data, takes a few of the entries at
// random (so no relay is asked by everyone, and a page does not hand a visitor's address to a crowd), and hands them to the wallet next to the relay it
// ships with. Nothing here decides who may relay: a listed relay has to answer with the address it was listed under, and a spend goes through the
// cheapest of those that do (evm-pool-relays.js).

import { relaysOf } from './evm-pool-relays.js';

export const RELAY_REGISTRY = '0x00000000000299F48Fb844626ab96c6A20059a01';
export const MAX_RELAYS_ASKED = 5;      // the relays a spend asks for a quote, the page's own among them
export const MAX_PAGES = 6;             // calls to `list` for one chain (each looks at up to 500 places and returns up to 100 entries)
export const MAX_ENTRIES = 300;         // entries kept from the list before the draw
export const GRACE_MS = 4_000;          // once one relay has quoted, the others have this long more

const SEL_LIST = '0xd4d25113';          // list(uint64,uint256,uint256) -- checked against the contract's ABI in the tests
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

// list(chainId, start, max) → { relayers, stakes, urls, next }, or null for an answer that is not the shape the contract returns (a node that lies or fails
// is not trusted with more than being ignored).
export function decodeList(hex) {
  if (typeof hex !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)) return null;
  const h = hex.slice(2), size = h.length / 2;
  const at = (byte) => (byte >= 0 && byte + 32 <= size ? BigInt(`0x${h.slice(byte * 2, byte * 2 + 64)}`) : null);
  const num = (byte, max) => { const v = at(byte); return v !== null && v <= BigInt(max) ? Number(v) : null; };
  const offA = num(0, size), offS = num(32, size), offU = num(64, size), next = at(96);
  if (offA === null || offS === null || offU === null || next === null) return null;
  const lenA = num(offA, 1000), lenS = num(offS, 1000), lenU = num(offU, 1000);
  if (lenA === null || lenA !== lenS || lenA !== lenU) return null;
  const relayers = [], stakes = [], urls = [];
  for (let i = 0; i < lenA; i++) {
    const a = at(offA + 32 + 32 * i), s = at(offS + 32 + 32 * i), uo = num(offU + 32 + 32 * i, size);
    if (a === null || s === null || uo === null || a >= 1n << 160n) return null;
    const base = offU + 32 + uo, ul = num(base, 1000);
    if (ul === null || base + 32 + ul > size) return null;
    const bytes = h.slice((base + 32) * 2, (base + 32 + ul) * 2);
    let url = '';
    for (let j = 0; j < bytes.length; j += 2) url += String.fromCharCode(parseInt(bytes.slice(j, j + 2), 16));
    relayers.push(`0x${a.toString(16).padStart(40, '0')}`);
    stakes.push(s);
    urls.push(url);
  }
  return { relayers, stakes, urls, next: next > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(next) };
}

// Every entry listed for `chainId`, a page of the registry at a time. `call(to, data)` → the hex an eth_call returns (the page's own node reader). A page
// that cannot be read ends the read with what was read before it, and a registry that cannot be read at all gives [].
export async function readRegistry({ call, chainId, registry = RELAY_REGISTRY, pages = MAX_PAGES, entries = MAX_ENTRIES }) {
  const out = [];
  let start = 0;
  for (let p = 0; p < pages && out.length < entries; p++) {
    let page = null;
    try { page = decodeList(await call(registry, `${SEL_LIST}${word(chainId)}${word(start)}${word(100)}`)); } catch { page = null; }
    if (!page) break;
    for (let i = 0; i < page.relayers.length && out.length < entries; i++) out.push({ relayer: page.relayers[i], url: page.urls[i], stake: page.stakes[i] });
    if (page.next === null || page.next <= start) break;      // a node that does not move on is not followed
    start = page.next;
  }
  return out;
}

// `n` of the entries, drawn without repeats and all alike: the minimum stake is what gets a relay listed, and the price it quotes is what gets it used.
export function drawRelays(entries, n, random = Math.random) {
  const pool = [...entries], out = [];
  while (out.length < n && pool.length) out.push(...pool.splice(Math.min(pool.length - 1, Math.floor(random() * pool.length)), 1));
  return out;
}

// The relays a page lists for a chain next to its own: `{ url, relayer }` for each, ready for a wallet's `keepers`. Entries a wallet would not use (not an
// https URL ending `/evm-pool/keeper`, not a public name, a repeat) are left out before the draw, so they take no place in it. `own`: the URL of the relay
// the page ships with, which is never listed twice. `pinned`: false on a page that is not on a real origin (a test, a local page). Never throws.
// The person's choice and the curated lists: `extra` ({ url, relayer }: relays the person added, and those the page's own registry names) are candidates as
// much as the open registry's; `avoid` (URLs) are never asked; `prefer` (URLs) are asked first, before the draw fills the rest; `openOff` leaves the open
// registry unread (its curator's switch), so only `extra` is drawn from.
const norm = (u) => String(u || '').replace(/\/+$/, '').toLowerCase();
export async function openRelays({ call, chainId, own = null, pinned = true, registry = RELAY_REGISTRY, max = MAX_RELAYS_ASKED, random = Math.random, extra = [], prefer = [], avoid = [], openOff = false }) {
  let entries = [];
  if (!openOff) { try { entries = await readRegistry({ call, chainId, registry }); } catch { entries = []; } }
  const mine = own ? norm(own) : null, no = new Set((avoid || []).map(norm)), yes = new Set((prefer || []).map(norm));
  const seen = new Set(), usable = [];
  for (const e of relaysOf({ keepers: [...(extra || []), ...entries], pinned })) {
    const k = norm(e.url);
    if (k === mine || no.has(k) || seen.has(k)) continue;
    seen.add(k); usable.push(e);
  }
  const room = Math.max(0, max - (own ? 1 : 0)), first = usable.filter((e) => yes.has(norm(e.url))).slice(0, room);
  const rest = drawRelays(usable.filter((e) => !first.includes(e)), room - first.length, random);
  return [...first, ...rest].map((e) => ({ url: e.url, relayer: e.relayer }));
}

// A chain's registry entry can point at a multi-keeper. Project only its root native route (or one already projected) to the requested pool; a bare,
// prefixed or unrelated route is not a candidate. Token support is proved by the quote, and the registry's relayer pin and any selection weight stay with the entry.
export function keepersForPool(entries, chainId, poolId) {
  const chain = Number(chainId), id = String(poolId || '');
  if (!Number.isSafeInteger(chain) || chain <= 0 || !new RegExp(`^${chain}-[a-z][a-z0-9]*$`).test(id)) return [];
  const native = `/${chain}/evm-pool/keeper`, target = `/${id}/evm-pool/keeper`, out = [];
  for (const e of entries || []) {
    try {
      const u = new URL(String(e?.url || ''));
      if (u.username || u.password || u.search || u.hash) continue;
      const path = u.pathname.replace(/\/+$/, '');
      if (path === native) u.pathname = target;
      else if (path !== target) continue;
      out.push({ ...e, url: u.href.replace(/\/+$/, '') });
    } catch { /* not a URL a wallet can use */ }
  }
  return out;
}

// A quote from each relay in `entries` (`ask(entry)` → a quote or null), as `{ e, q }`, without waiting on the slowest: all of them when they all answer, and
// otherwise those that had answered `graceMs` after the first did (or when the last has failed). A relay that never answers costs a spend the grace, not
// the time a request waits to give up.
export function collectQuotes(entries, ask, graceMs = GRACE_MS) {
  return new Promise((resolve) => {
    const got = [];
    let pending = entries.length, done = false, timer = null;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve([...got]); };
    if (!pending) return finish();
    for (const e of entries) {
      Promise.resolve().then(() => ask(e)).then(
        (q) => { if (q && !done) { got.push({ e, q }); if (!timer) timer = setTimeout(finish, graceMs); } },
        () => {},
      ).finally(() => { if (--pending === 0) finish(); });
    }
  });
}
