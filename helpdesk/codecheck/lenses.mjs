// Tacit's review lenses. A lens is one kind of mistake this codebase has actually made (amounts in the wrong unit, a BigInt pushed through Number, a call
// that is not awaited, hex read in the wrong order, a boundary off by one, text from the network put in the page, a main-network value on a test network),
// the lines that can hold it, and the one question a reviewer is asked about them. A small model does far better with one question about 17 lines than with
// "find bugs" in 110, and a snippet answers fast enough for a laptop.

export const PRIMER = `Context: Tacit is a browser dapp for private payments and swaps between Bitcoin and Ethereum. Amounts are BigInt in the smallest unit: sats (8 decimals) on Bitcoin, wei (18) on Ethereum, TAC and other tokens each with their own decimals (USDT has 6). Bitcoin transaction ids are shown big-endian and serialized little-endian. Everything from a server, a node or a URL is untrusted. The code is plain browser JavaScript (ES modules, no framework).`;

export const LENSES = [
  { id: 'units', title: 'units and decimals', ask: 'Is a quantity in one unit (sats, wei, a token with N decimals, a display string) combined with, compared to or passed as another unit, or scaled by the wrong power of ten?',
    sites: [/\b(?:parseUnits|formatUnits|toFixed|decimals|sats|satoshis?|wei|gwei|ether)\b/i, /\b1e(?:6|8|18)\b/, /\b10n\s*\*\*/, /\b100_?000_?000\b/] },
  { id: 'bigint', title: 'BigInt and Number', ask: 'Is a BigInt turned into a Number (losing precision above 2^53), mixed with a Number in arithmetic (a TypeError), or compared or serialized in a way that breaks for large values?',
    sites: [/\bNumber\(/, /\bparseInt\(/, /\bparseFloat\(/, /\bBigInt\(/, /\b\d+n\b/, /\bMath\.(?:floor|round|ceil|max|min)\(/] },
  { id: 'async', title: 'promises and failures', ask: 'Is a promise used without await, an error swallowed so later state is wrong, or one failed call left to abort or silently corrupt a whole flow?',
    sites: [/\bfetch\(/, /\.then\(/, /\bcatch\s*(?:\(\w*\))?\s*\{\s*\}/, /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(?:null|undefined|\{\s*\}|\[\s*\])/, /\bawait\b/, /\bPromise\.(?:all|race|any)\(/] },
  { id: 'encoding', title: 'hex, bytes and byte order', ask: 'Is hex, base58, bech32 or a byte string handled wrongly: a 0x prefix, an offset, a length, little- versus big-endian, a missing zero pad?',
    sites: [/\.slice\(\s*2\b/, /\b0x\b/, /\.reverse\(\)/, /\btoString\(16\)/, /\bpadStart\(/, /\b(?:hexToBytes|bytesToHex|fromHex|toHex|bech32|base58)\w*\(/i, /\bendian\b/i] },
  { id: 'bounds', title: 'boundaries and thresholds', ask: 'Is a comparison off by one, or a threshold (dust, fee, minimum, maximum, length, index, slice bound) wrong exactly at its boundary or for zero and empty?',
    sites: [/[<>]=?\s*\d/, /\.length\s*[-+<>]/, /\.(?:slice|substring|splice)\(/, /\b(?:dust|min|max)[A-Z_a-z]*\b/, /\[\s*\w+\s*[-+]\s*1\s*\]/] },
  { id: 'untrusted', title: 'untrusted text', ask: 'Does text from a network, a server, a node, a URL or another user reach innerHTML, a link, a script, a log or a signed message without being escaped or checked?',
    sites: [/\binnerHTML\b/, /\binsertAdjacentHTML\(/, /\bouterHTML\b/, /\.href\s*=/, /\blocation\.(?:href|assign|replace)\b/, /\bdocument\.write\(/, /\bnew URL\(/] },
  { id: 'state', title: 'stored state', ask: 'Is a stored value read, changed and written back without care for a second writer, deleted before it is known to be safe, or left half-updated when a step fails?',
    sites: [/\blocalStorage\.(?:setItem|removeItem)\(/, /\bsessionStorage\.(?:setItem|removeItem)\(/, /\bindexedDB\b/, /\.(?:put|delete)\(\s*['"`\w]/] },
  { id: 'network', title: 'networks and chains', ask: 'Can a main-network value be used on a test network or the reverse (signet, mainnet, sepolia, a chain id, an address prefix), or a chain id be taken from the wrong place?',
    sites: [/\b(?:signet|mainnet|testnet|sepolia)\b/i, /\bchainId\b/, /\bnetwork\s*[=!]==?/] },
];
export const LENS = Object.fromEntries(LENSES.map((l) => [l.id, l]));

const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;
const numbered = (lines, from, to) => lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n');

// Where each lens has something to look at: the snippet around every matching line (radius lines each way), overlapping snippets of one lens merged (a snippet
// stops growing at maxSpan lines: a job over what a node accepts is no job).
// `weight` is how many lenses have a match in the snippet: code that touches units and BigInt and a fetch at once is looked at first.
export function sites(src, { radius = 8, perLens = 60, maxSpan = 40 } = {}) {
  const lines = src.split('\n'), hits = new Map();   // lens id -> [line numbers]
  lines.forEach((l, i) => { if (COMMENT.test(l)) return; for (const lens of LENSES) if (lens.sites.some((re) => re.test(l))) { if (!hits.has(lens.id)) hits.set(lens.id, []); hits.get(lens.id).push(i + 1); } });
  const out = [];
  for (const [lens, ns] of hits) {
    const merged = [];
    for (const line of ns) {
      const s = Math.max(1, line - radius), e = Math.min(lines.length, line + radius), last = merged[merged.length - 1];
      if (last && s <= last.end + 1 && e - last.start + 1 <= maxSpan) last.end = Math.max(last.end, e);
      else if (merged.length < perLens) merged.push({ lens, start: s, end: e, line });
    }
    out.push(...merged);
  }
  for (const s of out) { s.weight = new Set(out.filter((o) => o.start <= s.end && o.end >= s.start).map((o) => o.lens)).size; s.text = numbered(lines, s.start, s.end); }
  return out.sort((a, b) => b.weight - a.weight || a.start - b.start || (a.lens < b.lens ? -1 : 1));
}
export const snippet = (src, start, end) => numbered(src.split('\n'), Math.max(1, start), Math.min(src.split('\n').length, end));
