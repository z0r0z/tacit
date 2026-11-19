// A fixed pool's deposits, in leaf order, for building its tree.
//
// History comes first from the wallet-read gateway through the private route (`history`: pages of leaves it keeps from the chain's logs, so no outside host sees which pool is read),
// then, if that does not answer, from a published chunk cache (gzip files of logs, each with a sha256 in a manifest; the file is checked against it), then from the chain alone.
// The last stretch, from where the history ends to the chain's tip, comes from the wallet's own node. Nothing read here is trusted: the tree built from it has to land on a root the pool
// knows, and the caller checks that before it proves anything (and reads again from the chain if it does not).

import { keccak_256, sha256, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';

export const CHUNK_CACHES = Object.freeze({
  1: 'https://saga.0000000000.org',
  11155111: 'https://saga.0000000000.org/sepolia',
});

const DEPOSIT_TOPIC = '0x' + bytesToHex(keccak_256(new TextEncoder().encode('Deposit(bytes32,uint32,uint256)')));
const num = (hex) => Number(BigInt(hex));
const streamKey = (chainId, denomination) => `tornado-cash-${chainId}-eth-${denomination}`;

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// A deposit log, from either source, as { index, commitment, block } or null.
function depositOf({ topics, data, blockNumber }) {
  if (!topics || topics[0]?.toLowerCase() !== DEPOSIT_TOPIC || topics.length < 2) return null;
  return { index: Number(BigInt('0x' + data.slice(2, 66))), commitment: topics[1].toLowerCase(), block: num(blockNumber) };
}

// The cache's deposits for one pool: { deposits, upTo } where `upTo` is the first block it does not cover.
export async function readChunkCache({ base, chainId, denomination, address, fetchImpl = globalThis.fetch.bind(globalThis), onProgress = () => {} }) {
  const manifest = await (await fetchImpl(`${base}/index.json`)).json();
  const entry = manifest.availableProtocols?.[streamKey(chainId, denomination)];
  if (!entry) throw new Error('the chunk cache has no stream for this pool');
  if (!entry.trackedAddresses?.some((a) => a.toLowerCase() === address.toLowerCase())) throw new Error('the chunk cache tracks another address for this pool');
  const parts = [...entry.chunks, ...(entry.hotHead ? [entry.hotHead] : [])];
  const deposits = [];
  let upTo = 0, done = 0;
  for (const part of parts) {
    const res = await fetchImpl(`${base}/${part.file}`);
    if (!res.ok) throw new Error(`the chunk cache did not give ${part.file}`);
    const raw = await gunzip(new Uint8Array(await res.arrayBuffer()));
    const digest = '0x' + bytesToHex(sha256(raw));
    if (digest !== String(part.digest.data).toLowerCase()) throw new Error(`a cache file does not match its digest (${part.file})`);
    const from = num(part.fromBlock), to = num(part.toBlock);
    let prev = null;
    for (const line of new TextDecoder().decode(raw).split('\n')) {
      if (!line) continue;
      const ev = JSON.parse(line);
      const at = [num(ev.blockNumber), num(ev.logIndex)];
      if (prev && (at[0] < prev[0] || (at[0] === prev[0] && at[1] <= prev[1]))) throw new Error('cache events out of order');
      prev = at;
      if (at[0] < from || at[0] >= to) throw new Error('a cache event is outside its file\'s blocks');
      const d = depositOf(ev);
      if (d) deposits.push(d);
    }
    upTo = Math.max(upTo, to);
    onProgress({ done: ++done, of: parts.length });
  }
  return { deposits, upTo };
}

// Logs of the pool's deposits in [from, to), asking a node in pieces and halving a piece it refuses.
export async function readTail({ getLogs, address, from, to, piece = 20000 }) {
  const out = [];
  const grab = async (a, b) => {
    try {
      for (const log of await getLogs({ address, topics: [DEPOSIT_TOPIC], fromBlock: '0x' + a.toString(16), toBlock: '0x' + (b - 1).toString(16) })) {
        const d = depositOf(log);
        if (d) out.push(d);
      }
    } catch (e) {
      if (b - a <= 1) throw e;
      const mid = a + Math.floor((b - a) / 2);
      await grab(a, mid); await grab(mid, b);
    }
  };
  for (let a = from; a < to; a += piece) await grab(a, Math.min(a + piece, to));
  return out;
}

// The pool's leaves from the gateway's history, a page at a time: { deposits, upTo } as the chunk cache gives them. `history({ pool, from, n })` → a page ({ total, upTo, from, n, leaves } with
// the leaves as base64) or null.
export const HISTORY_PAGE = 16384;
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export async function readHistory({ history, pool, onProgress = () => {} }) {
  const first = await history({ pool: pool.address, from: 0, n: HISTORY_PAGE });
  if (!first || !Number.isInteger(first.total) || first.total < 1 || !Number.isInteger(first.upTo)) throw new Error('the history is not ready');
  const pages = Math.max(1, Math.ceil(first.total / HISTORY_PAGE)), deposits = [];
  let page = first, got = 0;
  for (;;) {
    const bytes = fromBase64(String(page.leaves || ''));
    if (page.from !== got || !Number.isInteger(page.n) || page.n < 1 || bytes.length !== page.n * 32) throw new Error('a page of the history is wrong');
    for (let i = 0; i < page.n; i++) deposits.push({ index: got + i, commitment: '0x' + bytesToHex(bytes.subarray(i * 32, (i + 1) * 32)), block: 0 });
    got += page.n;
    onProgress({ done: Math.ceil(got / HISTORY_PAGE), of: pages });
    if (got >= first.total) break;
    page = await history({ pool: pool.address, from: got, n: HISTORY_PAGE });
    if (!page) throw new Error('a page of the history is missing');
  }
  return { deposits, upTo: first.upTo };
}

// All the pool's commitments, 32 bytes each in leaf order, and how many. Throws if the leaf numbers are not 0..n-1.
export async function fixedPoolLeaves({ chainId, pool, getLogs, blockNumber, base = CHUNK_CACHES[chainId], history = null, fetchImpl, onProgress }) {
  const denomination = (Number(pool.denomination / 10n ** 15n) / 1000).toString();
  let deposits = [], upTo = pool.deployBlock;
  if (history) {
    try { ({ deposits, upTo } = await readHistory({ history, pool, onProgress })); }
    catch { deposits = []; upTo = pool.deployBlock; }   // not ready, or not there: the published cache is next
  }
  if (!deposits.length && base) {
    try {
      ({ deposits, upTo } = await readChunkCache({ base, chainId, denomination, address: pool.address, fetchImpl, onProgress }));
    } catch (e) {
      // no cache, or a bad one: the node alone gives the history (slow on a chain with a long one)
      deposits = []; upTo = pool.deployBlock;
      onProgress?.({ note: `cache: ${e.message}` });
    }
  }
  const tip = await blockNumber();
  const tail = await readTail({ getLogs, address: pool.address, from: upTo, to: tip + 1 });
  const byIndex = new Map();
  for (const d of [...deposits, ...tail]) byIndex.set(d.index, d.commitment);
  const n = byIndex.size;
  const bytes = new Uint8Array(n * 32);
  for (let i = 0; i < n; i++) {
    const c = byIndex.get(i);
    if (!c) throw Object.assign(new Error(`leaf ${i} is missing from the deposits read`), { untrusted: true });
    bytes.set(hexToBytes(c.slice(2)), i * 32);
  }
  return { bytes, count: n };
}
