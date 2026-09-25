// Relayer for the Bitcoin-native shielded pool (DESIGN-btc-shielded-pool.md §6, SPEC §3.10).
// Quotes a per-asset fee, binds exit_vout slots of a fixed carrier layout at submit time, admits payloads only
// when the proof verifies against the local replayed root, the nullifiers are free, and one output is fully
// received by the relayer's pool wallet, then carries them in one commit/reveal pair funded from its own BTC.
//
// Keys: BTC_POOL_RELAYER_BTC_KEY (funding + envelope signing) and BTC_POOL_RELAYER_POOL_SEED (pool wallet).
// Both are read once and removed from process.env.

import { randomBytes } from 'node:crypto';
import { secp, sha256, keccak_256, hmac, hexToBytes, bytesToHex, concatBytes } from '../../../dapp/vendor/tacit-deps.min.js';
import { makeBtcShieldedPool } from '../../../dapp/btc-shielded-pool.js';
import { makeBtcWallet } from '../../../dapp/bitcoin-taproot-wallet.js';
import { parseTx, decodeEnvelopeScript } from './btc-pool-chain.js';

// RFC 6979 nonces for the ECDSA commit-input signatures.
if (!secp.etc.hmacSha256Sync) secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, concatBytes(...m));

export const ANCHOR_WINDOW = 144;
const T_BTC_SPEND = 0x6d;
const ENVELOPE_DUST = 330;
const OP_RETURN_EMPTY = Uint8Array.of(0x6a);
const MAX_BODY_BYTES = 16 * 1024;
const P2WPKH_IN_VB = 68;
const P2WPKH_OUT_VB = 31;
const TERMINAL = new Set(['confirmed', 'dropped', 'rejected', 'replayed-elsewhere']);
const CARRIER_DONE = new Set(['confirmed', 'dropped', 'empty', 'cancelled']);

const strip = (h) => String(h).replace(/^0x/i, '').toLowerCase();
const toHex = (v) => (v == null ? null : typeof v === 'string' ? strip(v) : bytesToHex(v));
const newId = () => randomBytes(16).toString('hex');
const bpm = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });

export class RelayError extends Error {
  constructor(status, message, extra = null) { super(message); this.status = status; this.extra = extra; }
}
const bad = (m) => new RelayError(400, m);

// abi.encode(uint16 1, bytes32 root, bytes32 keccak(body)).
export function spendPublicValues(root, body) {
  const v = new Uint8Array(32);
  v[31] = 1;
  return concatBytes(v, typeof root === 'string' ? hexToBytes(strip(root)) : root, keccak_256(body));
}

// ── BIP-341 script-path sighash, SIGHASH_DEFAULT, any input index ──
const tagged = (tag, ...m) => { const t = sha256(new TextEncoder().encode(tag)); return sha256(concatBytes(t, t, ...m)); };
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
const u64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; };
const compact = (n) => (n < 0xfd ? Uint8Array.of(n) : n <= 0xffff ? Uint8Array.of(0xfd, n & 0xff, n >> 8) : concatBytes(Uint8Array.of(0xfe), u32(n)));
export function tapScriptSighash(tx, inputIdx, prevouts, leafHash) {
  const rev = (h) => hexToBytes(h).reverse();
  return tagged('TapSighash', concatBytes(
    Uint8Array.of(0x00, 0x00), u32(tx.version), u32(tx.locktime),
    sha256(concatBytes(...tx.inputs.flatMap((i) => [rev(i.txid), u32(i.vout)]))),
    sha256(concatBytes(...prevouts.map((p) => u64(p.value)))),
    sha256(concatBytes(...prevouts.flatMap((p) => [compact(p.script.length), p.script]))),
    sha256(concatBytes(...tx.inputs.map((i) => u32(i.sequence ?? 0xffffffff)))),
    sha256(concatBytes(...tx.outputs.flatMap((o) => [u64(o.value), compact(o.script.length), o.script]))),
    Uint8Array.of(0x02), u32(inputIdx), leafHash, Uint8Array.of(0x00), u32(0xffffffff),
  ));
}

// Standard output scripts only, so every carrier stays relayable.
export function isStandardSpk(s) {
  const n = s.length;
  return (n === 34 && s[0] === 0x51 && s[1] === 0x20)
    || (n === 22 && s[0] === 0x00 && s[1] === 0x14)
    || (n === 34 && s[0] === 0x00 && s[1] === 0x20)
    || (n === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac)
    || (n === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87);
}

// nf hex → keccak(body) hex (null when the envelope does not parse) for every T_BTC_SPEND envelope of a tx.
export function spendsOfTx(tx) {
  const out = new Map();
  for (const i of tx.vin) {
    if (!i.witness || i.witness.length !== 3) continue;
    const env = decodeEnvelopeScript(i.witness[1]);
    if (!env || env.opcode !== T_BTC_SPEND) continue;
    const p = env.payload;
    if (p.length < 38) continue;
    let body = null;
    try { body = bytesToHex(keccak_256(bpm.parseSpend(p, { full: true }).body)); } catch { /* nullifiers still count */ }
    const n = p[37];
    for (let j = 0; j < n && 38 + 32 * (j + 1) <= p.length; j++) out.set(bytesToHex(p.subarray(38 + 32 * j, 70 + 32 * j)), body);
  }
  return out;
}
export const spendNullifiersOfTx = (tx) => new Set(spendsOfTx(tx).keys());

// Pool view over a live indexer: committed tip, retained roots, replayed nullifier set, plus the chain tip and
// the spends seen in blocks the replay has not reached yet (indexer `trackAhead`).
export function poolViewFromIndexer(ix) {
  const rootHex = (r) => (r == null ? null : typeof r === 'string' ? strip(r) : bytesToHex(r));
  return {
    tip: () => ix.state.tip,
    chainTip: () => ix.chainTip,
    rootAt: (h) => rootHex(ix.state.roots.get(h)),
    isSpent: (nf) => ix.state.nullifiers.has(strip(nf)),
    spentBy: (nf) => ix.state.nullifiers.get(strip(nf))?.txid ?? null,
    pendingSpend: (nf) => {
      const t = ix.state.tip ?? -1;
      for (const [h, b] of ix.ahead || []) if (h > t) { const r = b.nfs.get(strip(nf)); if (r) return r; }
      return null;
    },
    aheadComplete: () => (typeof ix.aheadComplete === 'function' ? ix.aheadComplete() : true),
  };
}

// ── mempool sources ──
// Spends of pool nullifiers in the mempool, keyed by txid. `listTxids` returns null when the mempool is too
// large to track; entries then age out after `staleMs`.
export function makeMempoolTracker({ listTxids, txHex, maxFetchPerRefresh = 200, staleMs = 30 * 60_000, now = () => Date.now(), log = () => {} }) {
  const byTx = new Map(); // txid → { spends: Map nf → body, at }
  let backoffUntil = 0, backoffMs = 0;
  const limited = (e) => e && (e.status === 429 || /\b429\b|rate.?limit/i.test(String(e.message || '')));
  const backoff = () => { backoffMs = Math.min(10 * 60_000, backoffMs ? backoffMs * 2 : 30_000); backoffUntil = now() + backoffMs; };
  const self = {
    complete: false,
    async refresh() {
      if (now() < backoffUntil) return;
      let ids;
      try { ids = await listTxids(); } catch (e) { if (limited(e)) backoff(); throw e; }
      if (ids == null) {
        self.complete = false;
        for (const [t, r] of byTx) if (now() - r.at > staleMs) byTx.delete(t);
        log('mempool too large to track; skipped');
        return;
      }
      const set = new Set(ids);
      for (const t of byTx.keys()) if (!set.has(t)) byTx.delete(t);
      let fetched = 0;
      for (const t of set) {
        if (byTx.has(t)) continue;
        if (fetched >= maxFetchPerRefresh) { self.complete = false; backoffMs = 0; return; }
        fetched++;
        try { byTx.set(t, { spends: spendsOfTx(parseTx(hexToBytes(strip(await txHex(t)))).tx), at: now() }); } catch (e) {
          if (limited(e)) { backoff(); self.complete = false; return; }
        }
      }
      backoffMs = 0;
      self.complete = true;
    },
    spender(nf, ignore = new Set()) {
      for (const [t, r] of byTx) if (!ignore.has(t) && r.spends.has(nf)) return { txid: t, body: r.spends.get(nf) };
      return null;
    },
    conflict(nfs, ignore = new Set()) {
      for (const n of nfs) { const s = self.spender(n, ignore); if (s) return s.txid; }
      return null;
    },
    size: () => byTx.size,
  };
  return self;
}

// Esplora: /mempool/txids, skipped when larger than `maxTxids`.
export function makeMempoolWatch({ bases, fetchImpl = fetch, maxFetchPerRefresh = 200, maxTxids = 20_000, timeoutMs = 15000, now, log }) {
  const list = bases.map((b) => b.replace(/\/$/, ''));
  const maxBytes = maxTxids * 70 + 2;
  async function get(path, limit = Infinity) {
    let last;
    for (const b of list) {
      try {
        const r = await fetchImpl(b + path, { signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) {
          if (Number(r.headers?.get?.('content-length') || 0) > limit) { try { await r.body?.cancel?.(); } catch { /* ignore */ } return null; }
          const t = (await r.text()).trim();
          return t.length > limit ? null : t;
        }
        last = Object.assign(new Error(`${path} -> ${r.status}`), { status: r.status });
        if (r.status === 429) break;
      } catch (e) { last = e; }
    }
    throw last;
  }
  return makeMempoolTracker({
    listTxids: async () => { const t = await get('/mempool/txids', maxBytes); if (t == null) return null; const ids = JSON.parse(t); return ids.length > maxTxids ? null : ids; },
    txHex: (t) => get(`/tx/${t}/hex`),
    maxFetchPerRefresh, now, log,
  });
}

export function makeBitcoindRpc({ url, user = null, pass = null, fetchImpl = fetch, timeoutMs = 20000 }) {
  const u = new URL(url);
  const auth = user != null ? `${user}:${pass ?? ''}` : u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null;
  u.username = ''; u.password = '';
  const endpoint = u.toString();
  let id = 0;
  return async (method, params = []) => {
    const r = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Basic ' + Buffer.from(auth).toString('base64') } : {}) },
      body: JSON.stringify({ jsonrpc: '1.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => null);
    if (!j) throw Object.assign(new Error(`${method} -> ${r.status}`), { status: r.status });
    if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`), { status: r.status });
    return j.result;
  };
}

// bitcoind: getrawmempool + getrawtransaction.
export function makeBitcoindMempool({ rpc, maxFetchPerRefresh = 5000, maxTxids = 500_000, now, log }) {
  return makeMempoolTracker({
    listTxids: async () => { const ids = await rpc('getrawmempool', [false]); return ids.length > maxTxids ? null : ids; },
    txHex: (t) => rpc('getrawtransaction', [t, false]),
    maxFetchPerRefresh, now, log,
  });
}

// ── admission helpers ──
export function makeRateLimiter({ perMin = 30, burst = 10, maxClients = 10_000, now = () => Date.now() } = {}) {
  const buckets = new Map();
  const fill = (b, t) => { b.tokens = Math.min(burst, b.tokens + ((t - b.at) * perMin) / 60_000); b.at = t; };
  return (key) => {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxClients) for (const [k, v] of buckets) { fill(v, t); if (v.tokens >= burst) buckets.delete(k); }
      if (buckets.size >= maxClients) return false;
      b = { tokens: burst, at: t };
      buckets.set(key, b);
    }
    fill(b, t);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

export function clientKey(req) {
  const f = req.headers?.['x-forwarded-for'];
  // The right-most hop is the one the fronting proxy appended; earlier hops are client-supplied.
  if (f) { const k = String(f).split(',').pop().trim(); if (k) return k; }
  return req.socket?.remoteAddress || 'unknown';
}

function makeSemaphore(n) {
  let active = 0;
  const waiting = [];
  const run = async (fn) => {
    if (active >= n) await new Promise((r) => waiting.push(r));
    else active++;
    try { return await fn(); } finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
  run.active = () => active;
  return run;
}

// chain:    { utxos(address), feeRate(), broadcast(hex), txStatus(txid) → { confirmed, block_height } | null,
//             outspend?(txid, vout) → { spent } }
// pool:     { tip(), rootAt(h) → hex|null, isSpent(nfHex), chainTip?(), spentBy?(nf) → txid|null,
//             pendingSpend?(nf) → { txid, body }|null, aheadComplete?() }
// verifier: { enabled, verify({ proof, publicValues }) → bool }
// mempool:  { refresh(), conflict(nfs, ignoreTxids) → txid|null, spender?(nf, ignoreTxids) → { txid, body }|null }
// persist:  { save(payloadRecs, carrierRecs), load() → { payloads, carriers } } (optional)
export function createRelayer({
  network = 'signet', btcKey, poolSeed, fees, pool, verifier, chain, mempool = null, persist = null,
  exitSats = 546, batchMs = 60_000, maxPayloads = 16, maxSlots = 8, anchorMargin = 6, anchorHeadroom,
  bumpWithin = 3, maxReplayLag = 12,
  maxFeeRate = 50, dropAfterMs = 6 * 3600_000, maxPending = 256, maxVerify = 2,
  maxQuotes = 1024, maxQuotesPerClient = 8, quoteTtlMs = 600_000, retainMs = 24 * 3600_000,
  rateLimit = null, now = () => Date.now(), log = () => {},
} = {}) {
  if (!(btcKey instanceof Uint8Array) || btcKey.length !== 32) throw new Error('relayer BTC key must be 32 bytes');
  if (!(poolSeed instanceof Uint8Array) || poolSeed.length !== 32) throw new Error('relayer pool seed must be 32 bytes');
  if (anchorHeadroom != null) anchorMargin = anchorHeadroom;
  const bp = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });
  const wallet = bp.walletFromSeed(poolSeed, network);
  const btcPriv = BigInt('0x' + bytesToHex(btcKey));
  const { prims } = makeBtcWallet({ priv: btcKey, hrp: network === 'mainnet' ? 'bc' : 'tb', fetchUtxos: chain.utxos, broadcastTx: chain.broadcast, fetchFeeRate: chain.feeRate });
  const fundAddress = prims.wallet.address();
  const changeSpk = prims.p2wpkhScript(prims.wallet.pub);
  const envKey = prims.wallet.xonly();
  const feeTable = new Map([...(fees instanceof Map ? fees : Object.entries(fees || {}))].map(([a, f]) => [strip(a), BigInt(f)]));
  const verifySlot = makeSemaphore(Math.max(1, maxVerify));

  const quotes = new Map();   // quoteId → { asset, fee, spk, client, used, expiresAt }
  const payloads = new Map(); // id → record
  const holds = new Map();    // nf hex → payload id
  const reservedUtxos = new Set();
  const carriers = [];
  let batch = null;

  // ── persistence ──
  const pRec = (p) => ({
    id: p.id, state: p.state, reason: p.reason || null, nullifiers: p.nullifiers, payload: bytesToHex(p.payload),
    hAnchor: p.hAnchor, root: p.root, asset: p.asset, bodyHash: p.bodyHash, fee: String(p.fee), feeLeaf: toHex(p.feeLeaf),
    slot: p.slot ? { vout: p.slot.vout, spk: bytesToHex(p.slot.spk) } : null, quoteId: p.quoteId, receivedAt: p.receivedAt,
    batchId: p.batch?.id || null, carrierId: p.carrier?.id || null, foreignTxid: p.foreignTxid || null,
    feeViaForeign: p.feeViaForeign ?? null, updatedAt: now(),
  });
  const cRec = (c) => ({
    id: c.id, state: c.state, createdAt: c.createdAt, updatedAt: now(),
    slots: c.slots.map((sl, v) => (sl ? { vout: v, spk: bytesToHex(sl.spk), payloadId: sl.payloadId } : null)).filter(Boolean),
    payloadIds: c.payloads.map((p) => p.id), live: c.live || [],
    commitHex: c.commitHex || null, revealHex: c.revealHex || null, commitTxid: c.commitTxid || null, revealTxid: c.revealTxid || null,
    cancelHex: c.cancelHex || null, cancelTxid: c.cancelTxid || null,
    outputs: (c.outputs || []).map((o) => ({ value: o.value, script: bytesToHex(o.script) })),
    utxos: c.utxos || [], picked: c.picked || [], rate: c.rate ?? null, commitFee: c.commitFee ?? null, revealFee: c.revealFee ?? null,
    broadcastAt: c.broadcastAt ?? null, height: c.height ?? null, replaced: c.replaced || [], failures: c.failures || 0,
    bumpedAt: c.bumpedAt ?? null, needsReplace: !!c.needsReplace, lastError: c.lastError || null,
  });
  const save = (c, ...ps) => { if (persist) persist.save(ps.filter(Boolean).map(pRec), c ? [cRec(c)] : []); };

  const openBatch = () => {
    if (!batch || batch.closed) batch = { id: newId(), openedAt: now(), closesAt: now() + batchMs, slots: [], payloads: [], closed: false };
    return batch;
  };
  const feeFor = (asset) => {
    const f = feeTable.get(strip(asset));
    if (f == null) throw bad('asset not relayed');
    return f;
  };
  // Next-block reference: the chain tip when known, else the replayed tip.
  const chainRef = () => {
    const t = pool.tip(), c = pool.chainTip ? pool.chainTip() : null;
    return c == null ? t : t == null ? c : Math.max(c, t);
  };
  const minAnchor = () => { const r = chainRef(); return r == null ? null : r + 1 - ANCHOR_WINDOW + anchorMargin; };
  const heldCount = () => { let n = 0; for (const p of payloads.values()) if (p.state === 'verifying' || p.state === 'held' || p.state === 'carried' || p.state === 'broadcast') n++; return n; };
  const freeVout = (b) => { for (let v = 0; v < maxSlots; v++) if (!b || !b.slots[v]) return v; return null; };
  const trimSlots = (b) => { while (b.slots.length && !b.slots[b.slots.length - 1]) b.slots.length--; };
  const ownTxids = () => {
    const s = new Set();
    for (const c of carriers) { if (c.revealTxid) s.add(c.revealTxid); for (const t of c.replaced || []) s.add(t); }
    return s;
  };

  function release(p, state, reason) {
    for (const nf of p.nullifiers) if (holds.get(nf) === p.id) holds.delete(nf);
    p.state = state;
    if (reason) p.reason = reason;
    p.updatedAt = now();
    save(null, p);
  }

  // Spend of `nf` by a transaction other than the relayer's own carriers.
  function spentElsewhere(nf, own) {
    const by = pool.spentBy ? pool.spentBy(nf) : null;
    if (by && !own.has(by)) return { txid: by, body: null };
    const pend = pool.pendingSpend ? pool.pendingSpend(nf) : null;
    if (pend && !own.has(pend.txid)) return pend;
    if (mempool) {
      if (mempool.spender) { const m = mempool.spender(nf, own); if (m) return m; }
      else { const t = mempool.conflict([nf], own); if (t) return { txid: t, body: null }; }
    }
    return null;
  }

  function info() {
    const b = batch && !batch.closed ? batch : null;
    return {
      network, address: wallet.addressString, fundAddress,
      fees: Object.fromEntries([...feeTable].map(([a, f]) => ['0x' + a, f.toString()])),
      exitSats, minAnchor: minAnchor(), anchorPolicy: 'tip - 6, rounded down to a multiple of 6',
      batch: b ? { id: b.id, closesAt: b.closesAt, exitVout: freeVout(b), slotsLeft: maxSlots - b.slots.filter(Boolean).length } : null,
      verifierEnabled: !!verifier?.enabled, pending: heldCount(),
    };
  }

  function pruneQuotes() {
    const t = now();
    for (const [id, q] of quotes) if (t >= q.expiresAt) quotes.delete(id);
  }

  // { asset, exitScriptPubKey? } → quote. exitVout is provisional; the slot is bound at submit.
  function quote({ asset, exitScriptPubKey } = {}, client = null) {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(String(asset || ''))) throw bad('asset must be 32 bytes hex');
    const fee = feeFor(asset);
    let spk = null;
    if (exitScriptPubKey != null) {
      try { spk = hexToBytes(strip(exitScriptPubKey)); } catch { throw bad('exitScriptPubKey must be hex'); }
      if (!isStandardSpk(spk)) throw bad('exitScriptPubKey is not a standard output script');
    }
    pruneQuotes();
    if (client != null) {
      let n = 0, oldest = null;
      for (const [id, q] of quotes) if (!q.used && q.client === client) { n++; if (oldest == null) oldest = id; }
      if (n >= maxQuotesPerClient && oldest != null) quotes.delete(oldest);
    }
    let open = 0;
    for (const q of quotes.values()) if (!q.used) open++;
    if (open >= maxQuotes) throw new RelayError(503, 'quote table full, retry shortly');
    const q = { id: newId(), asset: strip(asset), fee, spk, client, used: false, expiresAt: now() + quoteTtlMs };
    quotes.set(q.id, q);
    const b = batch && !batch.closed ? batch : null;
    const v = spk ? freeVout(b) : null;
    return {
      quoteId: q.id, asset: '0x' + q.asset, fee: fee.toString(), address: wallet.addressString,
      exitVout: spk ? (v ?? 0) : null, exitSats: spk ? exitSats : null,
      batchId: b ? b.id : null, expiresAt: q.expiresAt, minAnchor: minAnchor(),
    };
  }

  // { payload: hex (body ‖ proof_len ‖ proof), quoteId? } → { id, batchId }.
  async function submit({ payload, quoteId } = {}, client = null) {
    let bytes, s;
    try { bytes = hexToBytes(strip(payload)); } catch { throw bad('payload must be hex'); }
    if (bytes.length > MAX_BODY_BYTES) throw bad('payload too large');
    try { s = bp.parseSpend(bytes, { full: true }); } catch (e) { throw bad(`non-canonical spend: ${e.message}`); }
    if (heldCount() >= maxPending) throw new RelayError(503, 'relayer busy');
    const asset = strip(s.asset);
    const nfs = s.nullifiers.map(strip);

    let q = null;
    if (quoteId != null) {
      q = quotes.get(String(quoteId));
      if (!q) throw bad('unknown quote');
      if (q.used) throw bad('quote already used');
      if (now() >= q.expiresAt) throw bad('quote expired');
      if (q.asset !== asset) throw bad('quote is for another asset');
    }
    const fee = q ? q.fee : feeFor(asset);

    if (s.exit) {
      if (!q || !q.spk) throw bad('an exit needs a quote with an exit script');
      if (strip(s.exit.destSpkHash) !== strip(bp.exitDestHash(q.spk))) throw bad('dest_spk_hash does not match the quoted script');
    } else if (q && q.spk) throw bad('quote is for an exit but the spend has none');

    const tip = pool.tip();
    if (tip == null) throw new RelayError(503, 'pool replay not ready');
    const ref = chainRef();
    if (ref - tip > maxReplayLag) throw new RelayError(503, 'pool replay behind the chain tip');
    if (pool.aheadComplete && !pool.aheadComplete()) throw new RelayError(503, 'chain view catching up, retry shortly');
    if (s.hAnchor > tip) throw bad('h_anchor is ahead of the replayed tip');
    if (s.hAnchor < minAnchor()) throw bad('h_anchor too old');
    const root = pool.rootAt(s.hAnchor);
    if (!root) throw bad('no root retained for h_anchor');

    const own = ownTxids();
    for (const nf of nfs) {
      if (pool.isSpent(nf)) throw bad('nullifier already spent');
      if (pool.pendingSpend && pool.pendingSpend(nf)) throw bad('nullifier spent in a recent block');
      if (holds.has(nf)) throw bad('nullifier held by another pending payload');
    }
    if (mempool && mempool.conflict(nfs, own)) throw bad('nullifier conflicts with a mempool transaction');

    const got = s.outputs.map((o) => bp.tryReceive(wallet, o)).filter(Boolean);
    if (!got.length) throw bad('no output is received by the relayer');
    const feeNote = got.reduce((a, b) => (b.value > a.value ? b : a));
    if (feeNote.value < fee) throw bad('fee output below the quoted fee');

    if (!verifier || !verifier.enabled || typeof verifier.verify !== 'function') throw new RelayError(503, 'proof verifier unavailable');

    // Bind the batch, exit slot, nullifiers and quote before the async proof check.
    let b = openBatch();
    if (b.payloads.length >= maxPayloads) throw new RelayError(503, `carrier full until ${b.closesAt}`);
    const p = {
      id: newId(), state: 'verifying', nullifiers: nfs, payload: bytes, hAnchor: s.hAnchor, root, asset,
      bodyHash: bytesToHex(keccak_256(s.body)), slot: null, quoteId: q ? q.id : null, fee: feeNote.value,
      feeLeaf: feeNote.leaf, receivedAt: now(), batch: b,
    };
    if (s.exit) {
      const v = s.exit.exitVout, free = freeVout(b);
      if (free == null) throw new RelayError(503, `no exit slot left until ${b.closesAt}`);
      if (!(v < maxSlots && !b.slots[v] && v <= b.slots.length)) {
        throw new RelayError(409, 'exit_vout is not free in the open carrier; re-sign with exitVout', { exitVout: free, batchId: b.id });
      }
      p.slot = { vout: v, spk: q.spk, payloadId: p.id };
      b.slots[v] = p.slot;
    }
    b.payloads.push(p);
    for (const nf of nfs) holds.set(nf, p.id);
    if (q) q.used = true;
    payloads.set(p.id, p);

    let ok;
    try {
      ok = await verifySlot(() => verifier.verify({ proof: hexToBytes(strip(s.proof)), publicValues: spendPublicValues(root, s.body) }));
    } catch (e) {
      ok = null;
      log(`verifier error: ${e?.message || e}`);
    }
    const fail = (status, m) => {
      for (const nf of nfs) if (holds.get(nf) === p.id) holds.delete(nf);
      const bb = p.batch;
      if (p.slot && bb.slots[p.slot.vout] === p.slot) { delete bb.slots[p.slot.vout]; trimSlots(bb); }
      const i = bb.payloads.indexOf(p); if (i >= 0) bb.payloads.splice(i, 1);
      payloads.delete(p.id);
      if (q) q.used = false;
      throw new RelayError(status, m);
    };
    if (ok === null) fail(503, 'proof verifier error');
    if (ok !== true) fail(400, 'proof does not verify against the replayed root');
    if (pool.rootAt(s.hAnchor) !== root) fail(409, 'root changed during verification');
    if (b.closed) {
      if (p.slot) fail(409, 'carrier closed during verification; request a new quote');
      const i = b.payloads.indexOf(p); if (i >= 0) b.payloads.splice(i, 1);
      b = openBatch();
      if (b.payloads.length >= maxPayloads) fail(503, 'carrier full, retry after it is broadcast');
      b.payloads.push(p);
      p.batch = b;
    }
    p.state = 'held';
    save(null, p);
    log(`payload ${p.id} held for batch ${b.id}`);
    return { id: p.id, batchId: b.id, closesAt: b.closesAt };
  }

  function status(id) {
    const p = payloads.get(String(id));
    if (!p) return null;
    return {
      id: p.id, state: p.state, reason: p.reason || null, carrier: p.carrier?.revealTxid || null, commit: p.carrier?.commitTxid || null,
      ...(p.foreignTxid ? { foreignTxid: p.foreignTxid, feeViaForeign: p.feeViaForeign ?? null } : {}),
    };
  }

  // Still valid for the next two blocks: anchor inside the window, nullifiers free, root unchanged.
  function stillValid(p, own) {
    if (p.hAnchor < chainRef() + 2 - ANCHOR_WINDOW) return 'h_anchor expired';
    if (pool.rootAt(p.hAnchor) !== p.root) return 'root no longer retained';
    if (p.nullifiers.some((n) => pool.isSpent(n))) return 'nullifier spent';
    if (p.nullifiers.some((n) => { const x = pool.pendingSpend && pool.pendingSpend(n); return x && !own.has(x.txid); })) return 'nullifier spent';
    if (mempool && mempool.conflict(p.nullifiers, own)) return 'mempool conflict';
    return null;
  }

  // Outputs keep every signed exit_vout in place. A slot without a live exit pays the relayer; trailing
  // unused slots are trimmed, which moves no live exit.
  function layout(slots, live) {
    const liveIds = new Set(live.map((p) => p.id));
    const outs = [];
    for (let v = 0; v < slots.length; v++) {
      const sl = slots[v];
      const on = !!(sl && sl.payloadId && liveIds.has(sl.payloadId));
      outs.push({ value: exitSats, script: on ? sl.spk : changeSpk, live: on });
    }
    while (outs.length && !outs[outs.length - 1].live) outs.pop();
    if (!outs.length) return [{ value: 0, script: OP_RETURN_EMPTY }];
    return outs.map(({ value, script }) => ({ value, script }));
  }

  async function currentRate() {
    let rate = Number(await chain.feeRate());
    if (!Number.isFinite(rate) || rate <= 0) rate = 1;
    return Math.min(rate, maxFeeRate);
  }

  // Commit: relayer UTXOs → one P2TR envelope output per payload (+ change). Reveal: those outputs as
  // vin[0..k-1], each a script-path spend of its Tacit envelope leaf, paying the fixed layout.
  // `force` inputs are always spent (a replacement conflicts with every input of the one it replaces);
  // `replaces` is the fee of the replaced commit + reveal, which the new commit exceeds by 1 sat/vB.
  async function buildCarrier(live, outputs, { rate = null, force = null, replaces = 0 } = {}) {
    const envs = live.map((p) => {
      const script = prims.encodeEnvelopeScript(envKey, p.payload);
      const leaf = prims.tapLeafHash(script);
      const { Q_xonly, parity } = prims.tweakedOutputKey(prims.TAP_NUMS, leaf);
      return { script, leaf, spk: prims.p2trScript(Q_xonly), cb: prims.controlBlock(prims.TAP_NUMS, parity) };
    });
    if (rate == null) rate = await currentRate();

    const base = 4 + 1 + 41 * envs.length + compact(outputs.length).length + outputs.reduce((a, o) => a + 8 + compact(o.script.length).length + o.script.length, 0) + 4;
    const wit = 2 + envs.reduce((a, e) => a + 1 + 65 + compact(e.script.length).length + e.script.length + 1 + e.cb.length, 0);
    const revealVb = Math.ceil((base * 4 + wit) / 4) + 2;
    const revealFee = Math.ceil(revealVb * rate);
    const outSum = outputs.reduce((a, o) => a + o.value, 0);
    const envVals = envs.map((_, i) => (i === 0 ? 0 : ENVELOPE_DUST));
    envVals[0] = Math.max(ENVELOPE_DUST, outSum + revealFee - ENVELOPE_DUST * (envs.length - 1));
    const commitNeed = envVals.reduce((a, v) => a + v, 0);

    const forced = force || [];
    const forcedKeys = new Set(forced.map((u) => `${u.txid}:${u.vout}`));
    const utxos = (await chain.utxos(fundAddress))
      .filter((u) => u.value >= prims.DUST && !reservedUtxos.has(`${u.txid}:${u.vout}`) && !forcedKeys.has(`${u.txid}:${u.vout}`))
      .sort((a, b) => b.value - a.value);
    const picked = [...forced];
    let total = forced.reduce((a, u) => a + u.value, 0);
    const commitVb = (n) => prims.estCommitVb(n) + 43 * (envs.length - 1);
    const feeAt = (n) => Math.max(Math.ceil(commitVb(n) * rate), replaces ? replaces + commitVb(n) : 0);
    let commitFee = picked.length ? feeAt(picked.length) : 0;
    for (const u of utxos) {
      if (picked.length && total >= commitNeed + commitFee) break;
      picked.push(u); total += u.value;
      commitFee = feeAt(picked.length);
    }
    if (!picked.length || total < commitNeed + commitFee) throw new RelayError(503, `relayer funding short: need ${commitNeed + commitFee} sats`);
    const change = total - commitNeed - commitFee;
    const commitTx = {
      version: 2, locktime: 0,
      inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
      outputs: [...envs.map((e, i) => ({ value: envVals[i], script: e.spk })), ...(change >= prims.DUST ? [{ value: change, script: changeSpk }] : [])],
    };
    prims.signCommitInputs(commitTx, picked, changeSpk);
    const commitTxid = prims.txid(commitTx);

    const revealTx = {
      version: 2, locktime: 0,
      inputs: envs.map((_, i) => ({ txid: commitTxid, vout: i, sequence: 0xfffffffd, witness: [] })),
      outputs,
    };
    const prevouts = envs.map((e, i) => ({ value: envVals[i], script: e.spk }));
    envs.forEach((e, i) => {
      const sig = bp.schnorrSign(tapScriptSighash(revealTx, i, prevouts, e.leaf), btcPriv);
      revealTx.inputs[i].witness = [sig, e.script, e.cb];
    });
    return {
      commitTxid, revealTxid: prims.txid(revealTx), rate,
      picked: picked.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, ...(u.scriptpubkey ? { scriptpubkey: u.scriptpubkey } : {}) })),
      commitHex: bytesToHex(prims.serializeTx(commitTx)), revealHex: bytesToHex(prims.serializeTx(revealTx)),
      revealFee: (commitNeed - outSum), commitFee,
    };
  }

  function adopt(c, built, live, outputs) {
    if (c.revealTxid && c.revealTxid !== built.revealTxid) (c.replaced ||= []).push(c.revealTxid);
    for (const k of c.utxos || []) reservedUtxos.delete(k);
    Object.assign(c, {
      commitTxid: built.commitTxid, revealTxid: built.revealTxid, commitHex: built.commitHex, revealHex: built.revealHex,
      outputs, live: live.map((p) => p.id), picked: built.picked, utxos: built.picked.map((u) => `${u.txid}:${u.vout}`),
      rate: built.rate, commitFee: built.commitFee, revealFee: built.revealFee, state: 'signed', failures: 0, needsReplace: false,
    });
    for (const k of c.utxos) reservedUtxos.add(k);
    for (const p of live) p.carrier = c;
  }

  // Broadcast; an error is ambiguous until the tx status says otherwise. `absent` marks a provable miss.
  async function pushTx(hex, txid) {
    try { await chain.broadcast(hex); return; } catch (e) {
      const st = await chain.txStatus(txid).catch(() => undefined);
      if (st) return;
      e.absent = st === null;
      throw e;
    }
  }
  async function inputsUnspent(c) {
    if (typeof chain.outspend !== 'function') return false;
    for (const u of c.picked || []) {
      const r = await chain.outspend(u.txid, u.vout).catch(() => null);
      if (!r || r.spent !== false) return false;
    }
    return true;
  }

  // Moves a signed carrier forward with its stored bytes. A commit is rebuilt (on the same inputs) only
  // after an identical rebroadcast failed, the commit is absent, and its inputs are unspent.
  async function advance(c) {
    if (c.state === 'signed') {
      try { await pushTx(c.commitHex, c.commitTxid); } catch (e) {
        c.failures = (c.failures || 0) + 1;
        c.lastError = String(e?.message || e);
        if (e.absent && c.failures >= 2 && (await inputsUnspent(c))) c.state = 'building';
        save(c);
        throw e;
      }
      c.state = 'committed';
      c.failures = 0;
      save(c);
    }
    if (c.state === 'committed') {
      await pushTx(c.revealHex, c.revealTxid);
      c.state = 'broadcast';
      c.broadcastAt = now();
      const live = c.live.map((id) => payloads.get(id)).filter(Boolean);
      for (const p of live) if (p.state === 'carried' || p.state === 'broadcast') { p.state = 'broadcast'; p.carrier = c; }
      save(c, ...live);
      log(`carrier ${c.revealTxid}: ${c.live.length} spend(s), ${c.outputs.length} output(s)`);
    }
    if (c.state === 'cancelling') {
      await pushTx(c.cancelHex, c.cancelTxid);
      c.state = 'cancelled';
      save(c);
      log(`carrier ${c.id}: commit returned to the relayer by ${c.cancelTxid}`);
    }
  }

  async function attempt(c) {
    const own = ownTxids();
    for (const p of c.payloads) {
      if (p.state !== 'carried') continue;
      const why = stillValid(p, own);
      if (why) release(p, 'dropped', why);
    }
    const live = c.payloads.filter((p) => p.state === 'carried');
    if (!live.length) { c.state = 'empty'; save(c); return c; }
    const outputs = layout(c.slots, live);
    const built = await buildCarrier(live, outputs, c.picked?.length ? { force: c.picked } : {});
    adopt(c, built, live, outputs);
    save(c, ...live);
    await advance(c);
    return c;
  }

  // Replaces the unconfirmed commit (and so the reveal) with one carrying `live` at `rate`.
  async function replace(c, live, rate) {
    const outputs = layout(c.slots, live);
    const built = await buildCarrier(live, outputs, { rate, force: c.picked, replaces: (c.commitFee || 0) + (c.revealFee || 0) });
    adopt(c, built, live, outputs);
    save(c, ...live);
    log(`carrier ${c.id}: replaced at ${rate} sat/vB`);
    await advance(c);
  }

  // Spends the commit's inputs back to the relayer, which drops the reveal.
  async function cancel(c, rest, reason) {
    const picked = c.picked || [];
    const total = picked.reduce((a, u) => a + u.value, 0);
    const vb = 11 + P2WPKH_IN_VB * picked.length + P2WPKH_OUT_VB;
    const fee = Math.max(Math.ceil(vb * (await currentRate())), (c.commitFee || 0) + (c.revealFee || 0) + vb);
    if (!picked.length || total - fee < prims.DUST) throw new Error('commit inputs cannot fund a replacement');
    const tx = {
      version: 2, locktime: 0,
      inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
      outputs: [{ value: total - fee, script: changeSpk }],
    };
    prims.signCommitInputs(tx, picked, changeSpk);
    c.cancelHex = bytesToHex(prims.serializeTx(tx));
    c.cancelTxid = prims.txid(tx);
    c.state = 'cancelling';
    c.needsReplace = false;
    save(c);
    for (const p of rest) release(p, 'dropped', reason);
    await advance(c);
  }

  // Unconfirmed carrier: payloads whose nullifier another tx spent leave it; a carrier whose earliest anchor
  // is close to expiry is fee-bumped up to maxFeeRate, then returned to the relayer.
  async function watch(c, st) {
    const own = ownTxids();
    const live = c.live.map((id) => payloads.get(id)).filter((p) => p && p.state === 'broadcast');
    let changed = false;
    for (const p of live) {
      if (pool.spentBy && p.nullifiers.every((n) => own.has(pool.spentBy(n)))) { release(p, 'confirmed', 'carried by an earlier version of the carrier'); continue; }
      let f = null;
      for (const nf of p.nullifiers) if ((f = spentElsewhere(nf, own))) break;
      if (!f) continue;
      p.foreignTxid = f.txid;
      p.feeViaForeign = f.body == null ? null : f.body === p.bodyHash;
      release(p, 'replayed-elsewhere', `nullifier spent by ${f.txid}`);
      log(`payload ${p.id}: nullifier spent by ${f.txid}${p.feeViaForeign ? ' (same body, fee output included)' : ''}`);
      changed = true;
    }
    if (changed) c.needsReplace = true;
    changed = !!c.needsReplace;
    const rest = live.filter((p) => p.state === 'broadcast');
    if (!changed && !rest.length) {
      for (const k of c.utxos) reservedUtxos.delete(k);
      c.state = 'confirmed';
      save(c);
      return;
    }
    const ref = chainRef();
    const left = rest.length ? Math.min(...rest.map((p) => p.hAnchor)) + ANCHOR_WINDOW - ref : Infinity;
    const expiring = left <= bumpWithin && c.bumpedAt !== ref;
    if (changed || expiring || left <= 0) {
      const cst = await chain.txStatus(c.commitTxid).catch(() => undefined);
      if (cst === undefined) return;
      if (cst && cst.confirmed) {
        if (changed) { c.needsReplace = false; save(c); }
        return;
      }
      if (!rest.length) return cancel(c, rest, 'carrier emptied');
      if (left <= 0 || (expiring && c.rate >= maxFeeRate)) return cancel(c, rest, 'h_anchor expiring before confirmation');
      let rate = Math.max(c.rate || 1, await currentRate());
      if (expiring) { rate = Math.min(maxFeeRate, Math.max(Math.ceil((c.rate || 1) * 1.25), (c.rate || 1) + 1, rate)); c.bumpedAt = ref; }
      return replace(c, rest, rate);
    }
    if (!st) {
      if (now() - c.broadcastAt > dropAfterMs) {
        for (const p of rest) release(p, 'dropped', 'carrier not confirmed');
        for (const k of c.utxos) reservedUtxos.delete(k);
        c.state = 'dropped';
        save(c);
      } else {
        await chain.broadcast(c.commitHex).catch(() => {});
        await chain.broadcast(c.revealHex).catch(() => {});
      }
    }
  }

  function finalize(c, st) {
    const tip = pool.tip();
    if (tip == null || tip < st.block_height) return;
    const own = ownTxids();
    for (const id of c.live) {
      const p = payloads.get(id);
      if (!p || p.state !== 'broadcast') continue;
      const by = p.nullifiers.map((n) => (pool.spentBy ? pool.spentBy(n) : pool.isSpent(n) ? c.revealTxid : null));
      if (by.every((t) => t === c.revealTxid)) release(p, 'confirmed');
      else {
        const other = by.find((t) => t && !own.has(t));
        if (other) { p.foreignTxid = other; p.feeViaForeign = null; release(p, 'replayed-elsewhere', `nullifier spent by ${other}`); }
        else release(p, 'rejected', 'not accepted by replay');
      }
    }
    for (const k of c.utxos) reservedUtxos.delete(k);
    c.state = 'confirmed';
    c.height = st.block_height;
    save(c);
  }

  // Closes the open batch and carries its payloads.
  async function flush() {
    const b = batch;
    if (!b || b.closed) return null;
    b.closed = true;
    batch = null;
    const held = b.payloads.filter((p) => p.state === 'held');
    if (!held.length) return null;
    const c = { id: b.id, slots: b.slots, payloads: held, state: 'building', createdAt: now() };
    for (const p of held) { p.state = 'carried'; p.carrier = c; }
    carriers.push(c);
    save(c, ...held);
    try { await attempt(c); } catch (e) { c.lastError = String(e?.message || e); log(`carrier ${c.id} not broadcast: ${c.lastError}`); }
    return c;
  }

  function pruneMemory() {
    const cut = now() - retainMs;
    for (let i = carriers.length - 1; i >= 0; i--) {
      const c = carriers[i];
      if (CARRIER_DONE.has(c.state) && (c.broadcastAt ?? c.createdAt) < cut && c.payloads.every((p) => TERMINAL.has(p.state))) carriers.splice(i, 1);
    }
    for (const [id, p] of payloads) if (TERMINAL.has(p.state) && (p.updatedAt ?? p.receivedAt) < cut) payloads.delete(id);
    if (persist?.prune && now() - lastDbPrune > 3600_000) { lastDbPrune = now(); persist.prune(cut); }
  }
  let lastDbPrune = 0;

  // Tracks carriers: retries unbroadcast ones with their stored bytes, replaces or cancels ones that can no
  // longer confirm as built, finalizes confirmed ones once the replay has passed them.
  async function tick() {
    if (mempool) { try { await mempool.refresh(); } catch (e) { log(`mempool refresh failed: ${e?.message || e}`); } }
    if (batch && !batch.closed && now() >= batch.closesAt) await flush();
    pruneQuotes();
    for (const c of carriers) {
      try {
        if (c.state === 'building') await attempt(c);
        else if (c.state === 'signed' || c.state === 'committed' || c.state === 'cancelling') await advance(c);
        else if (c.state === 'broadcast') {
          const st = await chain.txStatus(c.revealTxid).catch(() => undefined);
          if (st && st.confirmed) finalize(c, st);
          else await watch(c, st);
        }
      } catch (e) { c.lastError = String(e?.message || e); }
    }
    pruneMemory();
  }

  // ── resume ──
  if (persist) {
    const { payloads: pr = [], carriers: cr = [] } = persist.load() || {};
    for (const r of pr) {
      if (r.state === 'verifying') continue;
      const p = {
        id: r.id, state: r.state, reason: r.reason || undefined, nullifiers: r.nullifiers, payload: hexToBytes(r.payload),
        hAnchor: r.hAnchor, root: r.root, asset: r.asset, bodyHash: r.bodyHash, fee: BigInt(r.fee), feeLeaf: r.feeLeaf,
        slot: r.slot ? { vout: r.slot.vout, spk: hexToBytes(r.slot.spk), payloadId: r.id } : null,
        quoteId: r.quoteId, receivedAt: r.receivedAt, updatedAt: r.updatedAt, foreignTxid: r.foreignTxid || undefined,
        feeViaForeign: r.feeViaForeign, _batchId: r.batchId,
      };
      payloads.set(p.id, p);
      if (!TERMINAL.has(p.state)) for (const nf of p.nullifiers) holds.set(nf, p.id);
    }
    for (const r of cr) {
      const slots = [];
      for (const sl of r.slots) slots[sl.vout] = { vout: sl.vout, spk: hexToBytes(sl.spk), payloadId: sl.payloadId };
      const c = {
        ...r, slots, payloads: r.payloadIds.map((id) => payloads.get(id)).filter(Boolean),
        outputs: r.outputs.map((o) => ({ value: o.value, script: hexToBytes(o.script) })),
      };
      delete c.payloadIds;
      for (const k of ['commitHex', 'revealHex', 'commitTxid', 'revealTxid', 'cancelHex', 'cancelTxid', 'lastError']) if (c[k] == null) delete c[k];
      for (const p of c.payloads) p.carrier = c;
      carriers.push(c);
      if (c.state !== 'confirmed' && c.state !== 'dropped' && c.state !== 'empty') for (const k of c.utxos) reservedUtxos.add(k);
    }
    const held = [...payloads.values()].filter((p) => p.state === 'held');
    if (held.length) {
      const b = openBatch();
      b.id = held[0]._batchId || b.id;
      for (const p of held) {
        if (p.slot) { if (b.slots[p.slot.vout]) { release(p, 'dropped', 'slot conflict on resume'); continue; } b.slots[p.slot.vout] = p.slot; }
        p.batch = b;
        b.payloads.push(p);
      }
    }
    for (const p of payloads.values()) delete p._batchId;
    if (pr.length || cr.length) log(`resumed ${held.length} held payload(s), ${carriers.filter((c) => !CARRIER_DONE.has(c.state)).length} open carrier(s)`);
  }

  // ── HTTP ──
  const PREFIX = '/btc-pool/relay';
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let n = 0; const chunks = [];
      req.on('data', (c) => { n += c.length; if (n > MAX_BODY_BYTES * 2 + 1024) { reject(new RelayError(413, 'body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(bad('body must be JSON')); } });
      req.on('error', reject);
    });
  }
  let limiter = () => true;
  const setRateLimit = (opts) => { limiter = makeRateLimiter({ now, ...opts }); };
  if (rateLimit) setRateLimit(rateLimit);
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/$/, '');
    if (!p.startsWith(PREFIX)) return false;
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ...(code === 429 ? { 'Retry-After': '10' } : {}) });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return true;
    }
    try {
      let m;
      const client = clientKey(req);
      const limited = (route) => { if (!limiter(`${route} ${client}`)) throw new RelayError(429, 'rate limited'); };
      if (p === `${PREFIX}/info` && req.method === 'GET') send(200, info());
      else if (p === `${PREFIX}/quote` && req.method === 'POST') { limited('quote'); send(200, quote(await readBody(req), client)); }
      else if (p === `${PREFIX}/submit` && req.method === 'POST') { limited('submit'); send(200, await submit(await readBody(req), client)); }
      else if ((m = p.match(/^\/btc-pool\/relay\/status\/([0-9a-f]{32})$/)) && req.method === 'GET') {
        const s = status(m[1]);
        send(s ? 200 : 404, s || { error: 'unknown payload' });
      } else send(404, { error: 'not found' });
    } catch (e) {
      send(e instanceof RelayError ? e.status : 500, e instanceof RelayError ? { error: e.message, ...(e.extra || {}) } : { error: 'internal error' });
      if (!(e instanceof RelayError)) log(`relay handler error: ${e?.message || e}`);
    }
    return true;
  }
  const wrap = (next) => async (req, res) => { if (!(await handle(req, res))) next(req, res); };

  let timer = null;
  const start = (intervalMs = 5000) => {
    if (timer) return;
    let busy = false;
    timer = setInterval(async () => { if (busy) return; busy = true; try { await tick(); } finally { busy = false; } }, intervalMs);
    timer.unref?.();
  };
  const stop = () => { if (timer) clearInterval(timer); timer = null; };

  return {
    info, quote, submit, status, flush, tick, handle, wrap, start, stop, setRateLimit,
    address: wallet.addressString, fundAddress,
    _state: { payloads, holds, carriers, quotes, reservedUtxos, get batch() { return batch; }, verifyActive: () => verifySlot.active() },
  };
}

// ── env ──
export function parseFees(s) {
  if (!s) return new Map();
  const t = String(s).trim();
  const entries = t.startsWith('{') ? Object.entries(JSON.parse(t)) : t.split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split(':'));
  const m = new Map();
  for (const [a, f] of entries) {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(String(a).trim())) throw new Error(`BTC_POOL_RELAYER_FEES: bad asset ${a}`);
    if (!/^\d+$/.test(String(f).trim())) throw new Error(`BTC_POOL_RELAYER_FEES: bad fee for ${a}`);
    m.set(strip(String(a).trim()), BigInt(String(f).trim()));
  }
  return m;
}

export function makeEsploraRelayChain(bases, { fetchImpl = fetch, feeTarget = '3', timeoutMs = 20000 } = {}) {
  const list = (Array.isArray(bases) ? bases : String(bases).split(',')).map((b) => b.trim().replace(/\/$/, '')).filter(Boolean);
  async function req(path, init) {
    let last;
    for (const b of list) {
      try {
        const r = await fetchImpl(b + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        const text = (await r.text()).trim();
        if (r.ok) return text;
        last = Object.assign(new Error(`${path} -> ${r.status} ${text.slice(0, 200)}`), { status: r.status });
        if (init?.method === 'POST' && r.status === 400) throw last;
      } catch (e) { last = e; if (e.status === 400 && init?.method === 'POST') break; }
    }
    throw last;
  }
  return {
    utxos: async (addr) => JSON.parse(await req(`/address/${addr}/utxo`)),
    feeRate: async () => { const f = JSON.parse(await req('/fee-estimates')); return Number(f[feeTarget] ?? f['6'] ?? 1); },
    broadcast: (hex) => req('/tx', { method: 'POST', body: hex, headers: { 'Content-Type': 'text/plain' } }),
    txStatus: async (txid) => { try { return JSON.parse(await req(`/tx/${txid}/status`)); } catch (e) { if (e.status === 404) return null; throw e; } },
    outspend: async (txid, vout) => JSON.parse(await req(`/tx/${txid}/outspend/${vout}`)),
  };
}

// Returns null when the relayer keys are not configured. Removes the key variables from env.
export function startBtcPoolRelayerFromEnv({ ix, store = null, verifier, network, esploraBases, log = console.log, env = process.env }) {
  const kHex = env.BTC_POOL_RELAYER_BTC_KEY, sHex = env.BTC_POOL_RELAYER_POOL_SEED;
  delete env.BTC_POOL_RELAYER_BTC_KEY;
  delete env.BTC_POOL_RELAYER_POOL_SEED;
  if (!kHex || !sHex) return null;
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(kHex) || !/^(0x)?[0-9a-fA-F]{64}$/.test(sHex)) throw new Error('relayer keys must be 32-byte hex');
  if (network === 'mainnet' && env.BTC_POOL_RELAYER_ENABLE_MAINNET !== '1') throw new Error('relayer on mainnet requires BTC_POOL_RELAYER_ENABLE_MAINNET=1');
  const bases = String(esploraBases).split(',').map((s) => s.trim()).filter(Boolean);
  const num = (k, d) => (env[k] != null && env[k] !== '' ? Number(env[k]) : d);

  // Mempool source: esplora (default on signet), bitcoind (default on mainnet), or off.
  let source = env.BTC_POOL_RELAYER_MEMPOOL || (env.BTC_POOL_RELAYER_MEMPOOL_WATCH === '0' ? 'off' : network === 'mainnet' ? 'bitcoind' : 'esplora');
  let mempool = null;
  if (source === 'bitcoind') {
    if (!env.BTC_POOL_BITCOIND_URL) throw new Error('BTC_POOL_RELAYER_MEMPOOL=bitcoind requires BTC_POOL_BITCOIND_URL');
    const rpc = makeBitcoindRpc({ url: env.BTC_POOL_BITCOIND_URL, user: env.BTC_POOL_BITCOIND_USER ?? null, pass: env.BTC_POOL_BITCOIND_PASS ?? null });
    mempool = makeBitcoindMempool({ rpc, maxFetchPerRefresh: num('BTC_POOL_RELAYER_MEMPOOL_FETCH', 5000), log });
  } else if (source === 'esplora') {
    mempool = makeMempoolWatch({ bases, maxTxids: num('BTC_POOL_RELAYER_MEMPOOL_MAX_TXIDS', 20_000), maxFetchPerRefresh: num('BTC_POOL_RELAYER_MEMPOOL_FETCH', 200), log });
  } else if (source !== 'off') throw new Error('BTC_POOL_RELAYER_MEMPOOL must be esplora, bitcoind or off');

  ix.trackAhead = spendsOfTx;
  const r = createRelayer({
    network,
    btcKey: hexToBytes(strip(kHex)),
    poolSeed: hexToBytes(strip(sHex)),
    fees: parseFees(env.BTC_POOL_RELAYER_FEES),
    pool: poolViewFromIndexer(ix),
    verifier,
    chain: makeEsploraRelayChain(bases, { feeTarget: env.BTC_POOL_RELAYER_FEE_TARGET || '3' }),
    mempool,
    persist: store && store.relay ? store.relay : null,
    exitSats: num('BTC_POOL_RELAYER_EXIT_SATS', 546),
    batchMs: num('BTC_POOL_RELAYER_BATCH_SECS', 60) * 1000,
    maxPayloads: num('BTC_POOL_RELAYER_MAX_PAYLOADS', 16),
    maxSlots: num('BTC_POOL_RELAYER_MAX_EXITS', 8),
    maxFeeRate: num('BTC_POOL_RELAYER_MAX_FEE_RATE', 50),
    maxPending: num('BTC_POOL_RELAYER_MAX_PENDING', 256),
    maxVerify: num('BTC_POOL_RELAYER_MAX_VERIFY', 2),
    maxQuotes: num('BTC_POOL_RELAYER_MAX_QUOTES', 1024),
    maxQuotesPerClient: num('BTC_POOL_RELAYER_MAX_QUOTES_PER_CLIENT', 8),
    quoteTtlMs: num('BTC_POOL_RELAYER_QUOTE_TTL_SECS', 600) * 1000,
    anchorMargin: num('BTC_POOL_RELAYER_ANCHOR_MARGIN', 6),
    bumpWithin: num('BTC_POOL_RELAYER_BUMP_WITHIN', 3),
    maxReplayLag: num('BTC_POOL_RELAYER_MAX_REPLAY_LAG', 12),
    log,
  });
  r.setRateLimit({ perMin: num('BTC_POOL_RELAYER_RATE_PER_MIN', 30), burst: num('BTC_POOL_RELAYER_RATE_BURST', 10) });
  r.start();
  log(`relayer enabled: pool address ${r.address}, funding ${r.fundAddress}, mempool ${source}`);
  return r;
}
