// Shared burn-deposit provenance enrichment + admission logic, used both by the scan attester
// (reflection-attest.js, at fold time) and by the public POST /reflection/burndep/check endpoint (a holder
// or a UI verifying a bundle BEFORE broadcasting/registering it). Kept in one place so the two can never
// diverge on what "admitted" means — a check that passes here and then fails at fold time (or the reverse)
// would be worse than not having the check at all.
//
// Also carries the persistent Bitcoin-header cache (`reflection:hdrs:{network}:{chunk}`) that lets a
// registered bundle skip carrying its own multi-thousand-entry provHeaders array: TAC's own etch sits
// ~21k blocks behind the chain tip today, and POST /reflection/burndep caps a submitted chain at 4,032
// headers (worker/src/index.js MAX_HEADERS) — a holder physically cannot submit a chain that reaches from
// the etch to the batch anchor. buildOrExtendProvHeaders fills that gap server-side from a chain the worker fetches
// and verifies for itself (headers are public data with self-checking PoW linkage, so there is nothing a
// holder could have gotten wrong here that this doesn't independently re-derive).
import { splitBlockTxs } from './bitcoin-block-parse.js';

export const HEADER_CHUNK = 1000;
const MAX_HEADER_EXTEND = 4032; // ~4 weeks of Bitcoin blocks — mirrors index.js's registration cap
// Sanity ceiling on a FRESH (no-provHeaders-submitted) chain build, independent of any per-chunk cache
// state: a chain from a legitimate etch to today's tip is a few tens of thousands of headers; anything
// claiming to need more than this is not worth building here (mirrors the existing extend-path philosophy
// — a burn that can't complete this way simply stays pending, never blocks the lane).
const MAX_FRESH_CHAIN = 60_000;

const hexBytes = (h) => {
  const s = String(h).replace(/^0x/, '');
  if (s.length % 2) throw new Error('burndep-admission: odd hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
// Bare (no 0x) hex — esplora block-hash path segments (/block/<hash>, /block/<hash>/raw, .../header) take
// this form, never 0x-prefixed; mixing the two up makes a real request 404. record.blockHash and the
// bare text apiText itself returns (fetchHeaderAt's own `hash`) are already bare; this is only needed where
// a hash is computed HERE from raw bytes (double-sha256 of a header) rather than taken from a response body.
const bareHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const reverseBytes = (b) => Uint8Array.from(b).reverse();

// deps = {secp, keccak256, sha256}; api = apiText(env, path, opts, network); apiRawBytes(env, path, network);
// kit = makeBurnDepositKit(deps) (or a test double carrying {assembler, admitBurnDeposit, computeTxidInternal}).
// headerChunk overrides HEADER_CHUNK — test-only seam (mining a real 1000-header easy-PoW chain per test
// run would work but is wasteful; production always uses the default).
export function makeBurndepAdmission({ env, api, apiRawBytes, network, kit, deps, headerChunk = HEADER_CHUNK }) {
  const dsha = (b) => deps.sha256(deps.sha256(b));

  // ── Block-level witness (BIP141 inclusion proof) for one protocol tx, from a cached whole-block fetch ──
  const blockWitnessCache = new Map();
  async function blockWitness(record, txHex) {
    let hash = record.blockHash ? String(record.blockHash).replace(/^0x/, '') : null;
    if (!hash && record.blockHeight != null) hash = (await api(env, `/block-height/${record.blockHeight}`, {}, network)).trim();
    if (!hash) throw new Error('burn-deposit provenance record requires blockHash or blockHeight');
    let block = blockWitnessCache.get(hash);
    if (!block) {
      // One cached /block/<hash>/raw fetch + local split, instead of a per-tx hex request per tx (a mainnet
      // block is thousands of txs). wtxid = dsha of the full (witness-carrying) tx bytes.
      const parsed = splitBlockTxs(await apiRawBytes(env, `/block/${hash}/raw`, network), dsha);
      block = {
        coinbase: parsed[0].rawHex,
        blockTxids: parsed.map((t) => reverseBytes(hexBytes(t.txidDisplay))),
        blockWtxids: parsed.map((t) => dsha(hexBytes(t.rawHex))),
      };
      blockWitnessCache.set(hash, block);
    }
    const txid = kit.computeTxidInternal(txHex).toLowerCase();
    const index = block.blockTxids.findIndex((id) => bytesToHex(id) === txid);
    if (index <= 0) throw new Error('burn-deposit protocol tx absent from block or at coinbase index');
    return { ...block, index };
  }

  // Bounded-concurrency map: a deep provenance chain's hops each confirm in a DIFFERENT block, so
  // blockWitness's cache (keyed by hash) buys nothing across them — every hop is a fresh multi-MB
  // `/block/<hash>/raw` fetch + split. Firing them all via Promise.all spikes heap by hundreds of MB for a
  // chain a few dozen hops deep and can kill the request mid-response. A small chunk keeps peak memory
  // bounded regardless of chain depth.
  const CONCURRENCY = 3;
  async function mapLimit(items, fn) {
    const out = new Array(items.length);
    let i = 0;
    async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); } }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    return out;
  }

  // ── A provenance transaction's place in its block, worked out once and kept for good: the fields
  // assembler.inclusionOf takes (index, txid path and block root, wtxid path, coinbase and its path) and the transaction's
  // bytes exactly as its block holds them. Confirmed history does not change, so an entry never expires: a hop then costs
  // one block read ever, instead of one for every check and every batch that carries its deposit, which for a history of
  // a few hundred transfers is hundreds of multi-MB block reads from the mirrors the whole service shares.
  const inclusionKey = (txidInternal) => `burndepwit:${network}:${String(txidInternal).replace(/^0x/, '').toLowerCase()}`;
  async function keptInclusion(txidInternal) {
    if (!env.REGISTRY_KV) return null;
    try {
      const v = await env.REGISTRY_KV.get(inclusionKey(txidInternal), 'json');
      return v && v.proof && typeof v.tx === 'string' ? v : null;
    } catch { return null; }
  }
  async function blockHashOf(record) {
    let hash = record.blockHash ? String(record.blockHash).replace(/^0x/, '') : null;
    if (!hash && record.blockHeight != null) hash = (await api(env, `/block-height/${record.blockHeight}`, {}, network)).trim();
    if (!hash) throw new Error('burn-deposit provenance record requires blockHash or blockHeight');
    return hash.toLowerCase();
  }
  // records: [{ record, field }] where record[field] is the protocol tx (`tx`, or a cmint's `revealTx`). Each comes back
  // with `proof` and the block's own bytes in `field`: a record whose bytes differ from the block's only outside the txid
  // (its witness) is made exact, and one that is not in its block at all throws, as before.
  // `onProgress(done, total)` hears how many of the records have their place in a block (kept before, or read now), once the kept
  // ones are counted and again after each block read: a caller that waits on a deep history can say how far it is.
  async function withInclusion(records, onProgress = null) {
    const out = new Array(records.length);
    const misses = [];
    let done = 0;
    const tell = () => { if (onProgress) { try { onProgress(done, records.length); } catch { /* a closed view */ } } };
    await mapLimit(records.map((_, i) => i), async (i) => {
      const { record, field } = records[i];
      const txid = kit.computeTxidInternal(record[field]).toLowerCase();
      const kept = await keptInclusion(txid);
      if (kept) { out[i] = { ...record, [field]: kept.tx, proof: kept.proof }; done++; }
      else misses.push({ i, txid });
    });
    tell();
    const byBlock = new Map();
    for (const m of misses) {
      const hash = await blockHashOf(records[m.i].record);
      if (!byBlock.has(hash)) byBlock.set(hash, []);
      byBlock.get(hash).push(m);
    }
    // One block at a time per worker, and only its few needed entries kept after it is split: peak memory stays a few
    // blocks whatever the depth.
    await mapLimit([...byBlock.keys()], async (hash) => {
      const parsed = splitBlockTxs(await apiRawBytes(env, `/block/${hash}/raw`, network), dsha);
      const blockTxids = parsed.map((t) => reverseBytes(hexBytes(t.txidDisplay)));
      const blockWtxids = parsed.map((t) => dsha(hexBytes(t.rawHex)));
      for (const m of byBlock.get(hash)) {
        const index = blockTxids.findIndex((id) => bytesToHex(id) === m.txid);
        if (index <= 0) throw new Error('burn-deposit protocol tx absent from block or at coinbase index');
        const proof = kit.assembler.inclusionOf({ blockTxids, blockWtxids, coinbase: parsed[0].rawHex, index }, 'provenance');
        const { record, field } = records[m.i];
        out[m.i] = { ...record, [field]: parsed[index].rawHex, proof };
        if (env.REGISTRY_KV) await env.REGISTRY_KV.put(inclusionKey(m.txid), JSON.stringify({ proof, tx: parsed[index].rawHex }), { expirationTtl: 180 * 86400 }).catch(() => {});   // read again from the block if it is gone
        done++;
      }
      tell();
    });
    return out;
  }

  async function enrichBurnDeposit(bundle, onProgress = null) {
    // etch is OPTIONAL (see buildBurnDepositCtx / cxfer-core ProvenanceBlob): a bundle relying solely on
    // pool-membership shortcuts carries no etch at all, so there is nothing to fetch witness data for.
    const cx = bundle.cxfers || [], cm = bundle.cmints || [];
    const placed = await withInclusion([
      ...(bundle.etch ? [{ record: bundle.etch, field: 'tx' }] : []),
      ...cx.map((record) => ({ record, field: 'tx' })),
      ...cm.map((record) => ({ record, field: 'revealTx' })),
    ], onProgress);
    const etch = bundle.etch ? placed.shift() : null;
    const cxfers = placed.splice(0, cx.length);
    const cmints = placed;
    // The burn tx's OWN witness-commitment inclusion proof — a separate BIP141 authentication from the
    // provenance/etch chain above (that proves the BURNED NOTE is real supply; this proves the 0x2B burn
    // ENVELOPE itself is really confirmed in its block). Required unconditionally by write_stdin.
    const burnTxWitness = bundle.burnTxWitness ? { ...bundle.burnTxWitness, ...(await blockWitness(bundle.burnTxWitness, bundle.burnTxWitness.tx)) } : null;
    return { ...bundle, etch, cxfers, cmints, burnTxWitness };
  }

  // ── Persistent header cache: reflection:hdrs:{network}:{chunkIndex} → JSON array of HEADER_CHUNK 80-byte
  // header hexes (0x-prefixed), for heights [chunkIndex*HEADER_CHUNK .. +HEADER_CHUNK-1]. Headers are
  // immutable public chain data once confirmed, so entries never expire and are never invalidated — the
  // same posture as burndep-live-tracer.js's own permanent resolveShallow cache. Only ever fetched for
  // heights the caller has already decided are safely below a real chain tip (a reorg below the anchor a
  // batch commits to would be a Bitcoin-consensus-breaking event, wildly out of scope here).
  const chunkKey = (chunkIndex) => `reflection:hdrs:${network}:${chunkIndex}`;
  // A naive one-height-at-a-time fetch (two calls each: /block-height, then /block/<hash>/header) needs 2,000
  // requests for a 1,000-header chunk — confirmed live against mempool.space to trigger a 429 within ~15s at
  // even modest concurrency, long before a single chunk completes. esplora's bulk /blocks/:height instead
  // returns 10 full block summaries (walking backward) per call, carrying every field a header needs, so this
  // reconstructs the raw header locally instead — 100 calls per chunk, not 2,000. Byte-exact against
  // /block/<hash>/header confirmed directly, and self-checking regardless (dsha of the reconstructed bytes
  // must equal the block's own listed id, which the caller below verifies) since it's assembled from JSON
  // fields rather than read as opaque bytes.
  const WINDOW_CONCURRENCY = 3; // confirmed live: safe; 8-way concurrent hit a 429 in ~15s, this doesn't
  const WINDOW_RETRIES = 3;
  function headerFromBlockSummary(b) {
    const buf = new Uint8Array(80);
    const view = new DataView(buf.buffer);
    view.setUint32(0, b.version >>> 0, true);
    buf.set(reverseBytes(hexBytes(b.previousblockhash)), 4);
    buf.set(reverseBytes(hexBytes(b.merkle_root)), 36);
    view.setUint32(68, b.timestamp >>> 0, true);
    view.setUint32(72, b.bits >>> 0, true);
    view.setUint32(76, b.nonce >>> 0, true);
    return buf;
  }
  async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  // One /blocks/<topHeight> call -> up to 10 real, PoW-self-checked headers for [topHeight-9..topHeight].
  // Retries a transient failure (timeout/429/5xx) a few times with backoff, since one flaky call out of the
  // ~100 a chunk needs must not sink the whole chunk (see ensureChunk's own per-window error handling too —
  // this is the first line of defense, that's the second).
  async function fetchHeaderWindow(topHeight) {
    let lastErr;
    for (let attempt = 0; attempt < WINDOW_RETRIES; attempt++) {
      try {
        const blocks = JSON.parse(await api(env, `/blocks/${topHeight}`, {}, network));
        const out = new Map();
        for (const b of blocks) {
          const bytes = headerFromBlockSummary(b);
          const hash = bareHex(reverseBytes(dsha(bytes)));
          if (hash !== String(b.id).toLowerCase().replace(/^0x/, '')) throw new Error(`reconstructed header does not match block ${b.height}'s own id`);
          out.set(b.height, bytesToHex(bytes));
        }
        return out;
      } catch (e) { lastErr = e; if (attempt < WINDOW_RETRIES - 1) await sleep(500 * 2 ** attempt); }
    }
    throw lastErr;
  }

  // Returns { headers, complete } for one chunk, fetching whatever is fetchable up to maxTipHeight.
  // `headers` covers [base..min(base+headerChunk-1, maxTipHeight)] and is always usable by the caller for
  // that range THIS call, even when `complete` is false (maxTipHeight fell inside the chunk, so its upper
  // heights don't exist yet) — a caller only asking up to maxTipHeight anyway loses nothing by that. Only a
  // `complete` (full headerChunk-sized) result is ever written to the KV cache: a partial one is by
  // definition not yet final and would wrongly look "cached" to a LATER call asking for a wider range.
  async function ensureChunk(chunkIndex, maxTipHeight) {
    const key = chunkKey(chunkIndex);
    const raw = await env.REGISTRY_KV.get(key);
    if (raw) { try { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length === headerChunk) return { headers: arr, complete: true }; } catch { /* fall through and rebuild */ } }
    const base = chunkIndex * headerChunk;
    const top = Math.min(base + headerChunk - 1, maxTipHeight);
    if (top < base) return { headers: [], complete: false }; // this chunk is entirely above what's safe to fetch right now
    // headerChunk is always a multiple of 10 in production (1000) — base is therefore 10-aligned, so windows
    // of exactly 10 tile it cleanly; a caller-supplied non-multiple-of-10 headerChunk (tests only) still works,
    // it just leaves one small overlapping tail window, which is harmless (the map dedupes by height).
    const windowTops = [];
    for (let h = base + 9; h <= top; h += 10) windowTops.push(h);
    if (!windowTops.length || windowTops[windowTops.length - 1] !== top) windowTops.push(top);
    const byHeight = new Map();
    let wi = 0;
    let sawError = null;
    const workers = Array.from({ length: Math.min(WINDOW_CONCURRENCY, windowTops.length) }, async () => {
      while (wi < windowTops.length && !sawError) {
        const t = windowTops[wi++];
        try { for (const [h, hex] of await fetchHeaderWindow(t)) if (h >= base && h <= top) byHeight.set(h, hex); }
        catch (e) { sawError = e; }
      }
    });
    await Promise.all(workers);
    if (sawError) throw sawError; // a chunk that couldn't be fully fetched this attempt is retried whole next tick/call — no partial write
    const headers = [];
    for (let h = base; h <= top; h++) headers.push(byHeight.get(h));
    const complete = headers.length === headerChunk && headers.every(Boolean);
    if (complete) await env.REGISTRY_KV.put(key, JSON.stringify(headers));
    return { headers, complete };
  }

  // Headers for [fromHeight..toHeight] inclusive, via the chunk cache. Throws only if a chunk STRICTLY
  // BEFORE the range's own end can't be completed (the caller's range genuinely reaches past it, so all of
  // it is needed) — the one chunk touching toHeight itself is used as far as it reaches even when the chunk
  // as a whole isn't complete yet, since that's exactly as far as this call ever needed it to reach.
  async function getHeadersRangeCached(fromHeight, toHeight) {
    if (toHeight < fromHeight) return [];
    const firstChunk = Math.floor(fromHeight / headerChunk);
    const lastChunk = Math.floor(toHeight / headerChunk);
    const out = [];
    for (let c = firstChunk; c <= lastChunk; c++) {
      const { headers, complete } = await ensureChunk(c, toHeight);
      if (!complete && c !== lastChunk) throw new Error(`burndep-admission: header chunk ${c} not yet available (range reaches past it)`);
      if (!headers.length) throw new Error(`burndep-admission: header chunk ${c} not yet available up to height ${toHeight}`);
      const base = c * headerChunk;
      const lo = Math.max(fromHeight, base) - base;
      const hi = Math.min(toHeight, base + headerChunk - 1) - base;
      if (hi >= headers.length) throw new Error(`burndep-admission: header chunk ${c} does not yet reach height ${toHeight}`);
      for (let k = lo; k <= hi; k++) out.push(headers[k]);
    }
    return out;
  }

  // Cron-driven warm-up: fill up to `budgetChunks` missing/incomplete chunks in [floorHeight, tipHeight],
  // lowest first. Safe to call repeatedly and concurrently with itself (chunk writes are idempotent —
  // last-fetch-wins on the same immutable data), and safe to call before any bundle ever needs the range
  // (a warm cache costs nothing at fold/check time beyond a KV read).
  async function warmHeaderChunks(floorHeight, tipHeight, { budgetChunks = 2 } = {}) {
    let filled = 0;
    const firstChunk = Math.floor(floorHeight / headerChunk);
    const lastChunk = Math.floor(tipHeight / headerChunk);
    for (let c = firstChunk; c <= lastChunk && filled < budgetChunks; c++) {
      const key = chunkKey(c);
      const raw = await env.REGISTRY_KV.get(key);
      if (raw) { try { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length === headerChunk) continue; } catch { /* rebuild */ } }
      const { complete } = await ensureChunk(c, tipHeight);
      if (complete) filled++;
    }
    return { filled };
  }

  // The block height a header's own bytes commit to (via its own hash), read from the chain, never taken
  // on trust from a bundle field — a provenance record's blockHeight is caller-supplied and unverified
  // (see enrichBurnDeposit's own blockWitness, which accepts either blockHash or blockHeight for the SAME
  // reason: it's only ever used to look up a hash, and the tx-inclusion check that follows is what actually
  // authenticates the block).
  const heightOfHash = new Map(); // a confirmed block's height does not change: every bundle's etch is the same block
  async function heightOfBlockHash(hash) {
    const key = String(hash).replace(/^0x/, '').toLowerCase();
    if (heightOfHash.has(key)) return heightOfHash.get(key);
    const json = JSON.parse(await api(env, `/block/${key}`, {}, network));
    const h = Number(json.height);
    if (!Number.isInteger(h) || h < 0) throw new Error('burndep-admission: could not resolve block height');
    heightOfHash.set(key, h);
    return h;
  }

  // A bundle's provenance header chain must end at the batch's anchor block, which keeps moving: a burn
  // left pending is completed in a later batch, so any chain is extended forward from wherever it currently
  // ends to `anchorHeight`. Two cases:
  //   (a) the bundle already carries a (holder- or previously-server-built) provHeaders chain — extend it,
  //       bounded to MAX_HEADER_EXTEND so an old or short chain never requires fetching the whole remaining
  //       history in one call (mirrors the original guard this replaces).
  //   (b) the bundle carries no chain at all (the common case for a bundle straight out of buildBurndepBundle
  //       / POST /reflection/burndep/trace, which never includes one — a holder-submitted chain longer than
  //       MAX_HEADERS(4032) is rejected at registration anyway, and TAC's own etch is already ~21k blocks
  //       behind tip) — build one FRESH from the etch height to anchorHeight via the header cache.
  // Either way: a chain that can't be completed right now (missing cache chunks, or the caller data doesn't
  // resolve) leaves the bundle UNCHANGED rather than throwing — a bad or incomplete bundle must never be
  // able to stop the batch; it just stays pending until a later call (once more chunks are warm, or the
  // holder registers a better bundle) succeeds.
  async function buildOrExtendProvHeaders(bundle, anchorHeight) {
    if (anchorHeight == null) return bundle;
    const hs = bundle.provHeaders;
    if (Array.isArray(hs) && hs.length) {
      const last = String(hs[hs.length - 1]).replace(/^0x/, '');
      if (!/^[0-9a-fA-F]{160}$/.test(last)) return bundle;
      const lastHash = bareHex(reverseBytes(dsha(hexBytes(last))));
      let lastHeight;
      try { lastHeight = await heightOfBlockHash(lastHash); } catch { return bundle; }
      if (!Number.isInteger(lastHeight) || lastHeight >= anchorHeight) return bundle;
      if (anchorHeight - lastHeight > MAX_HEADER_EXTEND) return bundle;
      try {
        const extra = await getHeadersRangeCached(lastHeight + 1, anchorHeight);
        return { ...bundle, provHeaders: [...hs, ...extra] };
      } catch { return bundle; }
    }
    if (!bundle.etch || !bundle.etch.blockHash) return bundle; // nothing to anchor a fresh chain to
    let etchHeight;
    try { etchHeight = await heightOfBlockHash(bundle.etch.blockHash); } catch { return bundle; }
    if (!Number.isInteger(etchHeight) || etchHeight > anchorHeight) return bundle;
    if (anchorHeight - etchHeight > MAX_FRESH_CHAIN) return bundle;
    try {
      const chain = await getHeadersRangeCached(etchHeight, anchorHeight);
      return { ...bundle, provHeaders: chain };
    } catch { return bundle; }
  }

  // The admission decision itself — a pure pass-through to the kit, kept here only so callers never have
  // to know the kit's exact shape.
  function admit(args) { return kit.admitBurnDeposit(args); }

  return { blockWitness, enrichBurnDeposit, buildOrExtendProvHeaders, getHeadersRangeCached, warmHeaderChunks, admit, headerChunk };
}
