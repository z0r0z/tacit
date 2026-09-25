// Relayer for the Bitcoin-native shielded pool (DESIGN-btc-shielded-pool.md §6, SPEC §3.10).
// Quotes a per-asset fee, assigns exit_vout slots in a fixed carrier layout, admits payloads only when the
// proof verifies against the local replayed root, the nullifiers are free, and one output is fully received
// by the relayer's pool wallet, then carries them in one commit/reveal pair funded from its own BTC.
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

const strip = (h) => String(h).replace(/^0x/i, '').toLowerCase();
const hx = (b) => '0x' + bytesToHex(b);
const newId = () => randomBytes(16).toString('hex');

export class RelayError extends Error {
  constructor(status, message) { super(message); this.status = status; }
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

// Pool view over a live indexer: committed tip, retained roots, replayed nullifier set.
export function poolViewFromIndexer(ix) {
  const rootHex = (r) => (r == null ? null : typeof r === 'string' ? strip(r) : bytesToHex(r));
  return {
    tip: () => ix.state.tip,
    rootAt: (h) => rootHex(ix.state.roots.get(h)),
    isSpent: (nf) => ix.state.nullifiers.has(strip(nf)),
  };
}

// Nullifiers of pool spends currently in the mempool, keyed by txid. Incremental over /mempool/txids.
export function makeMempoolWatch({ bases, fetchImpl = fetch, maxFetchPerRefresh = 200, timeoutMs = 15000 }) {
  const list = bases.map((b) => b.replace(/\/$/, ''));
  const byTx = new Map();
  async function get(path) {
    let last;
    for (const b of list) {
      try {
        const r = await fetchImpl(b + path, { signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) return (await r.text()).trim();
        last = new Error(`${path} -> ${r.status}`);
      } catch (e) { last = e; }
    }
    throw last;
  }
  return {
    async refresh() {
      const ids = new Set(JSON.parse(await get('/mempool/txids')));
      for (const t of byTx.keys()) if (!ids.has(t)) byTx.delete(t);
      let fetched = 0;
      for (const t of ids) {
        if (byTx.has(t) || fetched >= maxFetchPerRefresh) continue;
        fetched++;
        try { byTx.set(t, spendNullifiersOfTx(parseTx(hexToBytes(await get(`/tx/${t}/hex`))).tx)); } catch { /* retried next refresh */ }
      }
    },
    conflict(nfs, ignore = new Set()) {
      for (const [t, set] of byTx) if (!ignore.has(t) && nfs.some((n) => set.has(n))) return t;
      return null;
    },
  };
}

export function spendNullifiersOfTx(tx) {
  const out = new Set();
  for (const i of tx.vin) {
    if (!i.witness || i.witness.length !== 3) continue;
    const env = decodeEnvelopeScript(i.witness[1]);
    if (!env || env.opcode !== T_BTC_SPEND) continue;
    const p = env.payload;
    if (p.length < 38) continue;
    const n = p[37];
    for (let j = 0; j < n && 38 + 32 * (j + 1) <= p.length; j++) out.add(bytesToHex(p.subarray(38 + 32 * j, 70 + 32 * j)));
  }
  return out;
}

// chain: { utxos(address), feeRate(), broadcast(hex), txStatus(txid) → { confirmed, block_height } | null }
// pool:  { tip(), rootAt(h) → hex|null, isSpent(nfHex) }
// verifier: { enabled, verify({ proof, publicValues }) → bool }
// mempool: { refresh(), conflict(nfs, ignoreTxids) → txid|null } (optional)
export function createRelayer({
  network = 'signet', btcKey, poolSeed, fees, pool, verifier, chain, mempool = null,
  exitSats = 546, batchMs = 60_000, maxPayloads = 16, maxSlots = 8, anchorHeadroom = 6,
  maxFeeRate = 50, dropAfterMs = 6 * 3600_000, maxPending = 256, now = () => Date.now(), log = () => {},
} = {}) {
  if (!(btcKey instanceof Uint8Array) || btcKey.length !== 32) throw new Error('relayer BTC key must be 32 bytes');
  if (!(poolSeed instanceof Uint8Array) || poolSeed.length !== 32) throw new Error('relayer pool seed must be 32 bytes');
  const bp = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });
  const wallet = bp.walletFromSeed(poolSeed, network);
  const btcPriv = BigInt('0x' + bytesToHex(btcKey));
  const { prims } = makeBtcWallet({ priv: btcKey, hrp: network === 'mainnet' ? 'bc' : 'tb', fetchUtxos: chain.utxos, broadcastTx: chain.broadcast, fetchFeeRate: chain.feeRate });
  const fundAddress = prims.wallet.address();
  const changeSpk = prims.p2wpkhScript(prims.wallet.pub);
  const envKey = prims.wallet.xonly();
  const feeTable = new Map([...(fees instanceof Map ? fees : Object.entries(fees || {}))].map(([a, f]) => [strip(a), BigInt(f)]));

  const quotes = new Map();   // quoteId → { asset, fee, batch, slot, used, expiresAt }
  const payloads = new Map(); // id → record
  const holds = new Map();    // nf hex → payload id
  const reservedUtxos = new Set();
  const carriers = [];
  let batch = null;

  const openBatch = () => {
    if (!batch || batch.closed) batch = { id: newId(), openedAt: now(), closesAt: now() + batchMs, slots: [], payloads: [], closed: false };
    return batch;
  };
  const feeFor = (asset) => {
    const f = feeTable.get(strip(asset));
    if (f == null) throw bad('asset not relayed');
    return f;
  };
  const minAnchor = () => { const t = pool.tip(); return t == null ? null : t + 1 - ANCHOR_WINDOW + anchorHeadroom; };
  const used = (b) => b.slots.length + b.payloads.filter((p) => !p.slot).length;
  const heldCount = () => [...payloads.values()].filter((p) => p.state === 'held' || p.state === 'carried' || p.state === 'broadcast').length;

  function release(p, state, reason) {
    for (const nf of p.nullifiers) if (holds.get(nf) === p.id) holds.delete(nf);
    p.state = state;
    if (reason) p.reason = reason;
  }

  function info() {
    const b = batch && !batch.closed ? batch : null;
    return {
      network, address: wallet.addressString, fundAddress,
      fees: Object.fromEntries([...feeTable].map(([a, f]) => ['0x' + a, f.toString()])),
      exitSats, minAnchor: minAnchor(), anchorPolicy: 'tip - 6, rounded down to a multiple of 6',
      batch: b ? { id: b.id, closesAt: b.closesAt, slotsLeft: maxSlots - b.slots.length } : null,
      verifierEnabled: !!verifier?.enabled, pending: heldCount(),
    };
  }

  // { asset, exitScriptPubKey? } → quote. An exit slot is a fixed vout of the next carrier.
  function quote({ asset, exitScriptPubKey } = {}) {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(String(asset || ''))) throw bad('asset must be 32 bytes hex');
    const fee = feeFor(asset);
    const q = { id: newId(), asset: strip(asset), fee, batch: null, slot: null, used: false, expiresAt: now() + Math.max(batchMs, 600_000) };
    if (exitScriptPubKey != null) {
      const b = openBatch();
      let spk;
      try { spk = hexToBytes(strip(exitScriptPubKey)); } catch { throw bad('exitScriptPubKey must be hex'); }
      if (!isStandardSpk(spk)) throw bad('exitScriptPubKey is not a standard output script');
      if (b.slots.length >= maxSlots || used(b) >= maxPayloads) throw new RelayError(503, `carrier full until ${b.closesAt}`);
      q.slot = { vout: b.slots.length, spk, quoteId: q.id, payloadId: null };
      q.batch = b;
      q.expiresAt = b.closesAt;
      b.slots.push(q.slot);
    }
    quotes.set(q.id, q);
    return {
      quoteId: q.id, asset: '0x' + q.asset, fee: fee.toString(), address: wallet.addressString,
      exitVout: q.slot ? q.slot.vout : null, exitSats: q.slot ? exitSats : null,
      batchId: q.batch ? q.batch.id : null, expiresAt: q.expiresAt, minAnchor: minAnchor(),
    };
  }

  // { payload: hex (body ‖ proof_len ‖ proof), quoteId? } → { id, batchId }.
  async function submit({ payload, quoteId } = {}) {
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
      if ((q.batch && q.batch.closed) || now() >= q.expiresAt) throw bad('quote expired');
      if (q.asset !== asset) throw bad('quote is for another asset');
    }
    const fee = q ? q.fee : feeFor(asset);

    if (s.exit) {
      if (!q || !q.slot) throw bad('an exit needs a quote with an assigned exit_vout');
      if (s.exit.exitVout !== q.slot.vout) throw bad('exit_vout does not match the assigned slot');
      if (strip(s.exit.destSpkHash) !== strip(bp.exitDestHash(q.slot.spk))) throw bad('dest_spk_hash does not match the quoted script');
    } else if (q && q.slot) throw bad('quote reserved an exit slot but the spend has no exit');

    const tip = pool.tip();
    if (tip == null) throw new RelayError(503, 'pool replay not ready');
    if (s.hAnchor > tip) throw bad('h_anchor is ahead of the replayed tip');
    if (s.hAnchor < minAnchor()) throw bad('h_anchor too old');
    const root = pool.rootAt(s.hAnchor);
    if (!root) throw bad('no root retained for h_anchor');

    for (const nf of nfs) {
      if (pool.isSpent(nf)) throw bad('nullifier already spent');
      if (holds.has(nf)) throw bad('nullifier held by another pending payload');
    }
    if (mempool) {
      const own = new Set(carriers.map((c) => c.revealTxid).filter(Boolean));
      const t = mempool.conflict(nfs, own);
      if (t) throw bad('nullifier conflicts with a mempool transaction');
    }

    const got = s.outputs.map((o) => bp.tryReceive(wallet, o)).filter(Boolean);
    if (!got.length) throw bad('no output is received by the relayer');
    const feeNote = got.reduce((a, b) => (b.value > a.value ? b : a));
    if (feeNote.value < fee) throw bad('fee output below the quoted fee');

    if (!verifier || !verifier.enabled || typeof verifier.verify !== 'function') throw new RelayError(503, 'proof verifier unavailable');

    // Reserve before the async proof check so concurrent submits cannot share a nullifier or a quote.
    const p = {
      id: newId(), state: 'verifying', nullifiers: nfs, payload: bytes, hAnchor: s.hAnchor, root, asset,
      slot: q ? q.slot : null, quoteId: q ? q.id : null, fee: feeNote.value, feeLeaf: feeNote.leaf, receivedAt: now(),
    };
    for (const nf of nfs) holds.set(nf, p.id);
    if (q) q.used = true;
    payloads.set(p.id, p);
    let ok;
    try {
      ok = await verifier.verify({ proof: hexToBytes(strip(s.proof)), publicValues: spendPublicValues(root, s.body) });
    } catch (e) {
      ok = null;
      log(`verifier error: ${e?.message || e}`);
    }
    const fail = (status, m) => { release(p, 'rejected', m); payloads.delete(p.id); if (q) q.used = false; throw new RelayError(status, m); };
    if (ok === null) fail(503, 'proof verifier error');
    if (ok !== true) fail(400, 'proof does not verify against the replayed root');
    if (pool.rootAt(s.hAnchor) !== root) fail(409, 'root changed during verification');
    const b = q && q.slot ? q.batch : openBatch();
    if (b.closed) fail(400, 'quote expired');
    if (!p.slot && used(b) >= maxPayloads) fail(503, 'carrier full, retry after it is broadcast');
    p.state = 'held';
    p.batch = b;
    b.payloads.push(p);
    if (p.slot) p.slot.payloadId = p.id;
    log(`payload ${p.id} held for batch ${b.id}`);
    return { id: p.id, batchId: b.id, closesAt: b.closesAt };
  }

  function status(id) {
    const p = payloads.get(String(id));
    if (!p) return null;
    return { id: p.id, state: p.state, reason: p.reason || null, carrier: p.carrier?.revealTxid || null, commit: p.carrier?.commitTxid || null };
  }

  // Still valid for the next two blocks: anchor inside the window, nullifiers free, root unchanged.
  function stillValid(p, ignoreTxids) {
    const tip = pool.tip();
    if (p.hAnchor < tip + 2 - ANCHOR_WINDOW) return 'h_anchor expired';
    if (pool.rootAt(p.hAnchor) !== p.root) return 'root no longer retained';
    if (p.nullifiers.some((n) => pool.isSpent(n))) return 'nullifier spent';
    if (mempool && mempool.conflict(p.nullifiers, ignoreTxids)) return 'mempool conflict';
    return null;
  }

  // Outputs keep every signed exit_vout in place. A slot without a live exit pays the relayer; trailing
  // unused slots are trimmed, which moves no live exit.
  function layout(slots, live) {
    const liveIds = new Set(live.map((p) => p.id));
    const outs = slots.map((sl) => ({ value: exitSats, script: sl.payloadId && liveIds.has(sl.payloadId) ? sl.spk : changeSpk, live: !!(sl.payloadId && liveIds.has(sl.payloadId)) }));
    while (outs.length && !outs[outs.length - 1].live) outs.pop();
    if (!outs.length) return [{ value: 0, script: OP_RETURN_EMPTY }];
    return outs.map(({ value, script }) => ({ value, script }));
  }

  // Commit: relayer UTXOs → one P2TR envelope output per payload (+ change). Reveal: those outputs as
  // vin[0..k-1], each a script-path spend of its Tacit envelope leaf, paying the fixed layout.
  async function buildCarrier(live, outputs) {
    const envs = live.map((p) => {
      const script = prims.encodeEnvelopeScript(envKey, p.payload);
      const leaf = prims.tapLeafHash(script);
      const { Q_xonly, parity } = prims.tweakedOutputKey(prims.TAP_NUMS, leaf);
      return { script, leaf, spk: prims.p2trScript(Q_xonly), cb: prims.controlBlock(prims.TAP_NUMS, parity) };
    });
    let rate = Number(await chain.feeRate());
    if (!Number.isFinite(rate) || rate <= 0) rate = 1;
    rate = Math.min(rate, maxFeeRate);

    const base = 4 + 1 + 41 * envs.length + compact(outputs.length).length + outputs.reduce((a, o) => a + 8 + compact(o.script.length).length + o.script.length, 0) + 4;
    const wit = 2 + envs.reduce((a, e) => a + 1 + 65 + compact(e.script.length).length + e.script.length + 1 + e.cb.length, 0);
    const revealVb = Math.ceil((base * 4 + wit) / 4) + 2;
    const revealFee = Math.ceil(revealVb * rate);
    const outSum = outputs.reduce((a, o) => a + o.value, 0);
    const envVals = envs.map((_, i) => (i === 0 ? 0 : ENVELOPE_DUST));
    envVals[0] = Math.max(ENVELOPE_DUST, outSum + revealFee - ENVELOPE_DUST * (envs.length - 1));
    const commitNeed = envVals.reduce((a, v) => a + v, 0);

    const utxos = (await chain.utxos(fundAddress))
      .filter((u) => u.value > prims.DUST && !reservedUtxos.has(`${u.txid}:${u.vout}`))
      .sort((a, b) => b.value - a.value);
    const picked = []; let total = 0, commitFee = 0;
    const commitVb = (n) => prims.estCommitVb(n) + 43 * (envs.length - 1);
    for (const u of utxos) {
      picked.push(u); total += u.value;
      commitFee = Math.ceil(commitVb(picked.length) * rate);
      if (total >= commitNeed + commitFee) break;
    }
    if (total < commitNeed + commitFee) throw new RelayError(503, `relayer funding short: need ${commitNeed + commitFee} sats`);
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
      commitTx, revealTx, commitTxid, revealTxid: prims.txid(revealTx), picked,
      commitHex: bytesToHex(prims.serializeTx(commitTx)), revealHex: bytesToHex(prims.serializeTx(revealTx)),
      revealFee, commitFee,
    };
  }

  async function attempt(c) {
    const ignore = new Set(carriers.map((x) => x.revealTxid).filter(Boolean));
    for (const p of c.payloads) {
      if (p.state !== 'carried') continue;
      const why = stillValid(p, ignore);
      if (why) release(p, 'dropped', why);
    }
    const live = c.payloads.filter((p) => p.state === 'carried');
    if (!live.length) { c.state = 'empty'; return c; }
    const outputs = layout(c.slots, live);
    const built = await buildCarrier(live, outputs);
    for (const u of built.picked) reservedUtxos.add(`${u.txid}:${u.vout}`);
    Object.assign(c, { commitTxid: built.commitTxid, revealTxid: built.revealTxid, commitHex: built.commitHex, revealHex: built.revealHex, outputs, live: live.map((p) => p.id), utxos: built.picked.map((u) => `${u.txid}:${u.vout}`) });
    try {
      await chain.broadcast(built.commitHex);
    } catch (e) {
      for (const k of c.utxos) reservedUtxos.delete(k);
      c.commitTxid = c.revealTxid = null;
      c.lastError = String(e?.message || e);
      throw e;
    }
    c.state = 'committed';
    await chain.broadcast(built.revealHex);
    c.state = 'broadcast';
    c.broadcastAt = now();
    for (const p of live) { p.state = 'broadcast'; p.carrier = c; }
    log(`carrier ${c.revealTxid}: ${live.length} spend(s), ${outputs.length} output(s)`);
    return c;
  }

  // Closes the open batch and carries its payloads.
  async function flush() {
    const b = batch;
    if (!b || b.closed) return null;
    b.closed = true;
    batch = null;
    for (const sl of b.slots) quotes.delete(sl.quoteId);
    if (!b.payloads.length) return null;
    const c = { id: b.id, slots: b.slots, payloads: b.payloads, state: 'building', createdAt: now() };
    for (const p of b.payloads) { p.state = 'carried'; p.carrier = c; }
    carriers.push(c);
    try { await attempt(c); } catch (e) { c.lastError = String(e?.message || e); log(`carrier ${c.id} not broadcast: ${c.lastError}`); }
    return c;
  }

  // Tracks carriers: retries unbroadcast ones, finalizes confirmed ones once the replay has passed them,
  // and drops ones that never confirm.
  async function tick() {
    if (mempool) { try { await mempool.refresh(); } catch (e) { log(`mempool refresh failed: ${e?.message || e}`); } }
    if (batch && !batch.closed && now() >= batch.closesAt) await flush();
    for (const q of [...quotes.values()]) if ((q.batch && q.batch.closed) || now() >= q.expiresAt) quotes.delete(q.id);
    for (const c of carriers) {
      try {
        if (c.state === 'building') await attempt(c);
        else if (c.state === 'committed') { await chain.broadcast(c.revealHex); c.state = 'broadcast'; c.broadcastAt = now(); for (const id of c.live) { const p = payloads.get(id); p.state = 'broadcast'; } }
        else if (c.state === 'broadcast') {
          const st = await chain.txStatus(c.revealTxid).catch(() => null);
          if (st && st.confirmed) {
            const tip = pool.tip();
            if (tip != null && tip >= st.block_height) {
              for (const id of c.live) {
                const p = payloads.get(id);
                if (p.nullifiers.every((n) => pool.isSpent(n))) release(p, 'confirmed');
                else release(p, 'rejected', 'not accepted by replay');
              }
              for (const k of c.utxos) reservedUtxos.delete(k);
              c.state = 'confirmed';
              c.height = st.block_height;
            }
          } else if (!st && now() - c.broadcastAt > dropAfterMs) {
            for (const id of c.live) release(payloads.get(id), 'dropped', 'carrier not confirmed');
            for (const k of c.utxos) reservedUtxos.delete(k);
            c.state = 'dropped';
          } else if (!st) {
            await chain.broadcast(c.commitHex).catch(() => {});
            await chain.broadcast(c.revealHex).catch(() => {});
          }
        }
      } catch (e) { c.lastError = String(e?.message || e); }
    }
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
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/$/, '');
    if (!p.startsWith(PREFIX)) return false;
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return true;
    }
    try {
      let m;
      if (p === `${PREFIX}/info` && req.method === 'GET') send(200, info());
      else if (p === `${PREFIX}/quote` && req.method === 'POST') send(200, quote(await readBody(req)));
      else if (p === `${PREFIX}/submit` && req.method === 'POST') send(200, await submit(await readBody(req)));
      else if ((m = p.match(/^\/btc-pool\/relay\/status\/([0-9a-f]{32})$/)) && req.method === 'GET') {
        const s = status(m[1]);
        send(s ? 200 : 404, s || { error: 'unknown payload' });
      } else send(404, { error: 'not found' });
    } catch (e) {
      send(e instanceof RelayError ? e.status : 500, { error: e instanceof RelayError ? e.message : 'internal error' });
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

  return { info, quote, submit, status, flush, tick, handle, wrap, start, stop, address: wallet.addressString, fundAddress, _state: { payloads, holds, carriers, quotes } };
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
  };
}

// Returns null when the relayer keys are not configured. Removes the key variables from env.
export function startBtcPoolRelayerFromEnv({ ix, verifier, network, esploraBases, log = console.log, env = process.env }) {
  const kHex = env.BTC_POOL_RELAYER_BTC_KEY, sHex = env.BTC_POOL_RELAYER_POOL_SEED;
  delete env.BTC_POOL_RELAYER_BTC_KEY;
  delete env.BTC_POOL_RELAYER_POOL_SEED;
  if (!kHex || !sHex) return null;
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(kHex) || !/^(0x)?[0-9a-fA-F]{64}$/.test(sHex)) throw new Error('relayer keys must be 32-byte hex');
  if (network === 'mainnet' && env.BTC_POOL_RELAYER_ENABLE_MAINNET !== '1') throw new Error('relayer on mainnet requires BTC_POOL_RELAYER_ENABLE_MAINNET=1');
  const bases = String(esploraBases).split(',').map((s) => s.trim()).filter(Boolean);
  const num = (k, d) => (env[k] != null && env[k] !== '' ? Number(env[k]) : d);
  const r = createRelayer({
    network,
    btcKey: hexToBytes(strip(kHex)),
    poolSeed: hexToBytes(strip(sHex)),
    fees: parseFees(env.BTC_POOL_RELAYER_FEES),
    pool: poolViewFromIndexer(ix),
    verifier,
    chain: makeEsploraRelayChain(bases, { feeTarget: env.BTC_POOL_RELAYER_FEE_TARGET || '3' }),
    mempool: env.BTC_POOL_RELAYER_MEMPOOL_WATCH === '0' ? null : makeMempoolWatch({ bases }),
    exitSats: num('BTC_POOL_RELAYER_EXIT_SATS', 546),
    batchMs: num('BTC_POOL_RELAYER_BATCH_SECS', 60) * 1000,
    maxPayloads: num('BTC_POOL_RELAYER_MAX_PAYLOADS', 16),
    maxSlots: num('BTC_POOL_RELAYER_MAX_EXITS', 8),
    maxFeeRate: num('BTC_POOL_RELAYER_MAX_FEE_RATE', 50),
    log,
  });
  r.start();
  log(`relayer enabled: pool address ${r.address}, funding ${r.fundAddress}`);
  return r;
}
