// The page's own curated registry, TacitPayRegistry on Ethereum (the one tacit.wei reads): endpoint lists and one word of switches its owner can change
// without a new page. It holds only strings and flags: every entry is checked for its shape here and again as any other input where it is used, and a set
// flag only turns a part off. It is read through two of the page's public nodes that must give the same answer (one node alone could add an entry), kept an
// hour in this browser, and with nothing readable the page's own values stand.
//
// What a page takes from it: `relays` (the keepers entries that name their relayer, `<https base>#0x<relayer>`: relays of their own, reached through the
// private route like the open registry's), `forwarders` (`https://host`) and `nostr` (`wss://host`) for the private route, and `flags` (bit 3: the open
// RelayRegistry is not read).

export const PAY_REGISTRY = '0x0000000000029534a955A164223417fc5f4fA405';
export const READ_SEL = '0x78f142e8';        // read(bytes32[] keys, uint256[] chains) -> (uint256 flags, string[][] lists)
export const FLAG_OPEN_OFF = 3;             // the open RelayRegistry is not read
const KEYS = [['keepers', 1], ['forwarders', 1], ['nostr', 0]];
const CACHE = 'tacit-pay-registry-v1', TTL = 3600_000;

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const keyWord = (s) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('').padEnd(64, '0');

// the call's data: read(keys, chains), two dynamic arrays
export function readCalldata(keys = KEYS) {
  const n = keys.length, a = word(n) + keys.map(([k]) => keyWord(k)).join(''), b = word(n) + keys.map(([, c]) => word(c)).join('');
  return READ_SEL + word(64) + word(64 + 32 * (n + 1)) + a + b;
}

const unhex = (h) => { const s = String(h || '').replace(/^0x/, ''); if (!/^(?:[0-9a-fA-F]{2})*$/.test(s)) throw new Error('not hex'); const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return out; };
const num = (b, at) => { if (at < 0 || at + 32 > b.length) throw new Error('short'); let x = 0n; for (let i = 0; i < 32; i++) x = (x << 8n) | BigInt(b[at + i]); return x; };
const small = (b, at, max) => { const x = num(b, at); if (x > BigInt(max)) throw new Error('too large'); return Number(x); };
function strings(b, at) {
  const n = small(b, at, 64), out = [];
  for (let i = 0; i < n; i++) {
    const o = at + 32 + small(b, at + 32 + 32 * i, b.length), len = small(b, o, 4096);
    if (o + 32 + len > b.length) throw new Error('short');
    out.push(new TextDecoder().decode(b.subarray(o + 32, o + 32 + len)));
  }
  return out;
}
// the reply → { flags, lists } (lists in KEYS' order), or a throw for a reply that is not the shape the contract returns
export function decodeRead(hex, count = KEYS.length) {
  const b = unhex(hex);
  if (b.length < 96 || small(b, 32, b.length) !== 64) throw new Error('not the registry\'s reply');
  const flags = num(b, 0) & ((1n << 64n) - 1n), at = 64, n = small(b, at, 16), lists = [];
  if (n !== count) throw new Error('not the lists asked for');
  for (let i = 0; i < n; i++) lists.push(strings(b, at + 32 + small(b, at + 32 + 32 * i, b.length)));
  return { flags, lists };
}

// the lists as the page takes them: each entry of a shape it can use, a few of each
export function regOf({ flags = 0n, lists = [] }) {
  const [keepers = [], forwarders = [], nostr = []] = lists, strs = (xs) => (Array.isArray(xs) ? xs.filter((x) => typeof x === 'string' && x.length <= 300) : []);
  const relays = [];
  for (const x of strs(keepers)) {
    const m = /^(https:\/\/[\w.-]+(?::\d{1,5})?(?:\/[\w./-]*[\w-])?)#(0x[0-9a-fA-F]{40})$/.exec(x);
    if (m && relays.length < 6 && !relays.some((r) => r.url === `${m[1]}/1/evm-pool/keeper`)) relays.push({ url: `${m[1]}/1/evm-pool/keeper`, relayer: m[2] });
  }
  return {
    flags: BigInt(flags) & ((1n << 64n) - 1n),
    relays,
    forwarders: [...new Set(strs(forwarders).filter((x) => /^https:\/\/[\w.-]+(?::\d{1,5})?$/.test(x)))].slice(0, 6),
    nostr: [...new Set(strs(nostr).filter((x) => /^wss:\/\/[\w.-]+(?::\d{1,5})?$/.test(x)))].slice(0, 6),
  };
}
export const flagOn = (reg, bit) => !!reg && ((BigInt(reg.flags || 0n) >> BigInt(bit)) & 1n) === 1n;

// Read it: `calls` are two (or more) eth_call functions over different nodes (`(to, data) → hex`); the answer is taken only when two give the same bytes.
// `store`: where the last good read is kept (localStorage), with its time. Never throws: null when nothing agreeing could be read and nothing is kept.
export async function readPayRegistry({ calls, store = globalThis.localStorage, now = Date.now, registry = PAY_REGISTRY }) {
  let kept = null;
  try { const o = JSON.parse(store?.getItem(CACHE) || 'null'); if (o && typeof o.hex === 'string' && Number(o.at) <= now()) kept = o; } catch { kept = null; }
  if (kept && now() - Number(kept.at) < TTL) { try { return regOf(decodeRead(kept.hex)); } catch { kept = null; } }
  const data = readCalldata(), got = await Promise.all((calls || []).slice(0, 3).map((f) => Promise.resolve().then(() => f(registry, data)).then((h) => String(h || '').toLowerCase(), () => null)));
  const agreed = got.find((h, i) => h && h !== '0x' && got.some((g, j) => j !== i && g === h));
  if (agreed) {
    try { const r = regOf(decodeRead(agreed)); try { store?.setItem(CACHE, JSON.stringify({ at: now(), hex: agreed })); } catch { } return r; } catch { }
  }
  if (kept) { try { return regOf(decodeRead(kept.hex)); } catch { } }
  return null;
}
