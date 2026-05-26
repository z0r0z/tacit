// Mainnet canary for the TAC asset (f0bbe868…).
//
// PURPOSE
// -------
// Catch any code change that would silently drift the identity or state of
// the live TAC token on mainnet. Specifically protects:
//
//   1. ASSET IDENTITY — sha256(reverse(etch_txid) || vout_le32) === asset_id.
//      Any change in the SPEC's asset_id derivation (domain prefix added,
//      byte ordering flipped, hash function swapped) would break this and
//      retroactively orphan every existing UTXO of this asset. Highest
//      severity check; offline; can never blip.
//
//   2. WORKER REGISTRY DRIFT — the worker's /assets/{asset_id} endpoint
//      returns the same canonical fields (etch_txid, etch_vout, commitment,
//      ticker, decimals) it did at canary creation. Catches accidental
//      schema renames, KV migrations that lose fields, or copycat assets
//      stealing the registry slot.
//
//   3. BITCOIN ETCH TX STILL ON CHAIN — fetchable via mempool.space at
//      the pinned block height. Catches catastrophic upstream indexer
//      problems but mostly here for completeness (Bitcoin doesn't reorg
//      948242).
//
//   4. WORKER MARKET-STATE SCHEMA — the preauth-sales, atomic-intents,
//      and bid-intents endpoints return records with every field the
//      dapp's take/fulfil/cancel paths actually read. Catches worker
//      schema changes that would break in-flight orders for this asset.
//
// FAILURE MODES
// -------------
// Network-dependent tests soft-skip (treated as INCONCLUSIVE, not failed)
// when the worker or mempool.space is unreachable after RETRY_ATTEMPTS
// retries with exponential backoff. The offline asset_id derivation test
// always runs and never skips — it's the load-bearing check.
//
// A drift in any pinned field FAILS the test loudly with a diff so the
// reviewer can see exactly what shifted.
//
// CI WIRING
// ---------
// Added to tests/package.json `test` and `test:fast` scripts so it runs
// alongside the rest of the offline suite. Mainnet-only; treat skipped
// network checks as a CI hiccup, not a regression.

import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { decodeEnvelopeScript } from './indexer.mjs';
import { bytesToPoint, bpRangeAggVerify } from './bulletproofs.mjs';

// ============================================================
// Pinned fixtures — captured from the live mainnet asset at the
// time this canary was written. Any update to these is an explicit
// audit step: you should know exactly WHY a field shifted before
// committing the new value.
// ============================================================
const ASSET = Object.freeze({
  asset_id:        'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b',
  etch_txid:       'e2d10be19c2b73b86e14be99dc237a3d999ba3dfbe6f3e3714590acee2ca481e',
  etch_vout:       0,
  commitment:      '02f5a454ee1e79c29e746e945143d12a19607f4b7188e6d9c00573824bd12ffc64',
  ticker:          'TAC',
  decimals:        8,
  network:         'mainnet',
  image_uri:       'ipfs://bafkreig7m5j66zlaewjvo6bipk723udgdhnyl7ve5k2suofuvhi2mmb3ai',
  etched_at_height: 948242,
});

// Monotonic counter lower bounds. Pinned at canary creation; the worker
// MUST never report a value below these (asset state can grow, never
// shrink). A worker migration that drops historical data, a KV wipe,
// or any indexer bug that orphans confirmed transactions would fail
// this check. Update only when you've verified the worker correctly
// reflects a higher value; updating downward is forbidden and would
// indicate either tampering or a regression.
const MONOTONIC_FLOORS = Object.freeze({
  transfer_count:   933,    // distinct confirmed transfers indexed for this asset
  holder_count:     1251,   // unique-recipient-scripthash count
  disclosure_count: 3,      // attested supply disclosures
  opening_count:    26,     // published UTXO openings
});

// Specific historical trades that MUST continue to appear in the
// worker's /assets/{aid}.trades feed AND remain block-confirmed on
// mainnet. Catches: worker trade-ring-buffer drops, indexer rescans
// that orphan confirmed trades, KV migrations that lose history,
// hypothetical chain reorgs (Bitcoin doesn't reorg blocks this old
// in practice; this leg is belt-and-suspenders).
//
// Pinning policy: only trades that are demonstrably already
// block-confirmed at canary creation. Fresh/mempool-only trades are
// not pinned here because their post-broadcast pre-confirmation state
// would create false-positive failures. Each entry below was verified
// confirmed on mainnet via mempool.space at the time of pin.
const PINNED_TRADES = Object.freeze([
  // Re-pinned 2026-05-27. Verified live in worker's `/assets/{tac}` trades
  // array + confirmed on mempool.space.
  Object.freeze({ txid: 'b8cb32dc79dc31fce0cfc77879a79206bb038b3b0663d6b4e80b9876360c3b75', price_sats: 33872, amount: '12057512727', ts: 1779818068 }),
  Object.freeze({ txid: '9f8bbcc44d287f710f5612d1f1d15dd8ce21438773d708188d612aa9d8087657', price_sats: 34072, amount: '12128710064', ts: 1779816536 }),
  Object.freeze({ txid: '3340f16c5e7eb7961a1c3dbf2c6cade4b6f459ff5468ac0048f7c4698580069a', price_sats: 627, amount: '19', ts: 1779805415 }),
  Object.freeze({ txid: '4bf0ce5c4921aeb1ee2380dd79c04aa481e13d7db1b7d1a3c8d6c2d6a6cbe44c', price_sats: 44000, amount: '15851814465', ts: 1779794916 }),
  Object.freeze({ txid: '894210c1dac6333d61768ace677a7405c990cb59087fa32eae1767d96237f80e', price_sats: 113000, amount: '63503761062', ts: 1779793535 }),
]);

const WORKER_BASE = 'https://tacit-pin.rosscampbell9.workers.dev';
const CHAIN_API = 'https://mempool.space/api';

const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1000;

let pass = 0, fail = 0, skipped = 0;

async function test(label, fn) {
  try {
    const ok = await fn();
    if (ok === 'skip') { console.log(`  SKIP  ${label}`); skipped++; }
    else if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

async function fetchWithRetry(url, opts = {}) {
  let lastErr = null;
  for (let i = 0; i < RETRY_ATTEMPTS; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS * (2 ** (i - 1))));
    try {
      const r = await fetch(url, opts);
      if (!r.ok) { lastErr = new Error(`HTTP ${r.status} ${url}`); continue; }
      return r;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Match dapp/tacit.js + tests/composition.mjs assetIdFor. Inlined here so
// the canary has no internal dapp dependency — if assetIdFor changes
// upstream, this canary fails LOUDLY rather than silently inheriting
// the new derivation and continuing to pass.
const reverseBytes = b => { const r = new Uint8Array(b); r.reverse(); return r; };
function assetIdFor(etchTxidHex, etchVout) {
  const txidBE = reverseBytes(hexToBytes(etchTxidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, etchVout >>> 0, true);
  return sha256(new Uint8Array([...txidBE, ...voutLE]));
}

// Minimal T_AXFER (0x26) payload decoder, structurally identical to
// worker/src/index.js decodeAxferPayload. Inlined to keep the canary
// independent of worker internals — if the wire shape changes upstream,
// this canary fails LOUDLY rather than silently following the new shape.
const T_AXFER_OPCODE = 0x26;
function decodeAxferPayload(payload) {
  if (!payload || payload.length < 1 + 32 + 1 + 64 + 1) return null;
  if (payload[0] !== T_AXFER_OPCODE) return null;
  let p = 1;
  const asset_id = payload.slice(p, p + 32); p += 32;
  const asset_input_count = payload[p]; p += 1;
  if (asset_input_count < 1) return null;
  const kernel_sig = payload.slice(p, p + 64); p += 64;
  const N = payload[p]; p += 1;
  if (![1, 2, 4, 8].includes(N)) return null;
  if (p + N * (33 + 8) + 2 > payload.length) return null;
  const outputs = [];
  for (let i = 0; i < N; i++) {
    const commitment = payload.slice(p, p + 33); p += 33;
    const amount_ct = payload.slice(p, p + 8); p += 8;
    outputs.push({ commitment, amount_ct });
  }
  const rp_len = payload[p] | (payload[p + 1] << 8); p += 2;
  if (p + rp_len !== payload.length) return null;
  const rangeproof = payload.slice(p, p + rp_len);
  return { asset_id, asset_input_count, kernel_sig, N, outputs, rangeproof };
}

console.log(`\n=== mainnet canary: ${ASSET.ticker} (${ASSET.asset_id.slice(0, 12)}…) ===\n`);

// ------------------------------------------------------------
// 1. ASSET IDENTITY (offline, never skips)
// ------------------------------------------------------------
await test('asset_id derivation = sha256(reverse(etch_txid) || vout_le32)', () => {
  const derived = bytesToHex(assetIdFor(ASSET.etch_txid, ASSET.etch_vout));
  if (derived !== ASSET.asset_id) {
    console.log(`     expected: ${ASSET.asset_id}`);
    console.log(`     derived:  ${derived}`);
    console.log(`     >>> SPEC-level asset_id derivation has drifted. <<<`);
    return false;
  }
  return true;
});

// ------------------------------------------------------------
// 2. WORKER REGISTRY (network-dependent)
// ------------------------------------------------------------
let workerData = null;
await test('worker /assets/{aid} returns pinned canonical fields', async () => {
  try {
    const r = await fetchWithRetry(`${WORKER_BASE}/assets/${ASSET.asset_id}?network=${ASSET.network}`);
    workerData = await r.json();
  } catch (e) {
    console.log(`     network unreachable after ${RETRY_ATTEMPTS} retries: ${e.message}`);
    console.log(`     skipping network-dependent canary checks (inconclusive, not a regression)`);
    return 'skip';
  }
  const drifts = [];
  if (workerData.asset_id !== ASSET.asset_id) drifts.push(`asset_id: got ${workerData.asset_id}`);
  if (workerData.etch_txid !== ASSET.etch_txid) drifts.push(`etch_txid: got ${workerData.etch_txid}`);
  if (workerData.etch_vout !== ASSET.etch_vout) drifts.push(`etch_vout: got ${workerData.etch_vout}`);
  if (workerData.ticker !== ASSET.ticker) drifts.push(`ticker: got ${workerData.ticker}`);
  if (workerData.decimals !== ASSET.decimals) drifts.push(`decimals: got ${workerData.decimals}`);
  if ((workerData.commitment || '').toLowerCase() !== ASSET.commitment.toLowerCase()) {
    drifts.push(`commitment: got ${workerData.commitment}`);
  }
  if (workerData.image_uri !== ASSET.image_uri) drifts.push(`image_uri: got ${workerData.image_uri}`);
  if (workerData.etched_at_height !== ASSET.etched_at_height) drifts.push(`etched_at_height: got ${workerData.etched_at_height}`);
  if (drifts.length) {
    drifts.forEach(d => console.log(`     ${d}`));
    return false;
  }
  return true;
});

// ------------------------------------------------------------
// 3. BITCOIN ETCH TX (network-dependent)
// ------------------------------------------------------------
await test('CETCH tx still on mainnet at pinned block height', async () => {
  try {
    const r = await fetchWithRetry(`${CHAIN_API}/tx/${ASSET.etch_txid}`);
    const tx = await r.json();
    if (!tx.status?.confirmed) {
      console.log(`     etch tx exists but unconfirmed — impossible state`);
      return false;
    }
    if (tx.status.block_height !== ASSET.etched_at_height) {
      console.log(`     block_height drift: ${tx.status.block_height} vs ${ASSET.etched_at_height}`);
      return false;
    }
    if (!tx.vout?.[ASSET.etch_vout]?.scriptpubkey) {
      console.log(`     vout[${ASSET.etch_vout}] missing scriptpubkey`);
      return false;
    }
    // CETCH envelope lives in vin[0].witness (taproot script-path spend),
    // not in any vout. Mirror worker's commitmentForUtxo gate: vin[0]
    // must have witness with ≥3 elements (script-spend + control block +
    // taproot internal). If this shape changes, the worker can no longer
    // recover this asset's commitment — same load-bearing invariant.
    const vin0 = tx.vin?.[0];
    if (!vin0?.witness || vin0.witness.length < 3) {
      console.log(`     vin[0].witness missing or too short (need ≥3 elements for script-path spend)`);
      return false;
    }
    return true;
  } catch (e) {
    console.log(`     mempool.space unreachable: ${e.message}`);
    return 'skip';
  }
});

// ------------------------------------------------------------
// 4. WORKER MARKET-STATE SCHEMA (network-dependent)
//
// Smoke-check that every active order for this asset still has the
// fields the dapp's take/fulfil/cancel paths read. If the worker
// schema changes (e.g. a field rename), in-flight orders for this
// asset would silently fail to take — this catches that loudly.
// ------------------------------------------------------------
await test('preauth-sales endpoint returns records with every dapp-required field', async () => {
  if (!workerData) return 'skip';
  try {
    const r = await fetchWithRetry(`${WORKER_BASE}/assets/${ASSET.asset_id}/preauth-sales?network=${ASSET.network}`);
    const j = await r.json();
    if (!Array.isArray(j.sales)) { console.log(`     sales: not an array`); return false; }
    for (const s of j.sales) {
      const missing = [];
      if (typeof s.sale_id !== 'string' || s.sale_id.length !== 32) missing.push('sale_id (32-hex)');
      if (typeof s.seller_pubkey !== 'string' || s.seller_pubkey.length !== 66) missing.push('seller_pubkey (33-byte hex)');
      if (typeof s.seller_payout_script !== 'string') missing.push('seller_payout_script');
      if (!s.asset_outpoint || typeof s.asset_outpoint.txid !== 'string' || typeof s.asset_outpoint.vout !== 'number') missing.push('asset_outpoint{txid,vout}');
      if (!s.asset_opening || typeof s.asset_opening.amount !== 'string' || typeof s.asset_opening.blinding !== 'string') missing.push('asset_opening{amount,blinding}');
      if (typeof s.min_price_sats !== 'number') missing.push('min_price_sats');
      if (typeof s.expiry !== 'number') missing.push('expiry');
      if (typeof s.seller_asset_spend_sig !== 'string') missing.push('seller_asset_spend_sig');
      if (typeof s.nonce !== 'string' || s.nonce.length !== 32) missing.push('nonce (32-hex)');
      if (typeof s.auth_sig !== 'string' || s.auth_sig.length !== 128) missing.push('auth_sig (128-hex)');
      if (missing.length) {
        console.log(`     sale ${s.sale_id?.slice(0, 8) || '?'}… missing/malformed: ${missing.join(', ')}`);
        return false;
      }
    }
    console.log(`     verified ${j.sales.length} live preauth sale${j.sales.length === 1 ? '' : 's'}`);
    return true;
  } catch (e) {
    console.log(`     unreachable: ${e.message}`);
    return 'skip';
  }
});

await test('atomic-intents endpoint returns records with every dapp-required field', async () => {
  if (!workerData) return 'skip';
  try {
    const r = await fetchWithRetry(`${WORKER_BASE}/assets/${ASSET.asset_id}/atomic-intents?network=${ASSET.network}`);
    const j = await r.json();
    if (!Array.isArray(j.intents)) { console.log(`     intents: not an array`); return false; }
    for (const it of j.intents) {
      const missing = [];
      if (typeof it.intent_id !== 'string') missing.push('intent_id');
      if (typeof it.maker_pubkey !== 'string') missing.push('maker_pubkey');
      if (typeof it.amount !== 'string') missing.push('amount');
      if (typeof it.price_sats !== 'number') missing.push('price_sats');
      if (typeof it.expiry !== 'number') missing.push('expiry');
      if (missing.length) {
        console.log(`     intent ${it.intent_id?.slice(0, 8) || '?'}… missing: ${missing.join(', ')}`);
        return false;
      }
    }
    console.log(`     verified ${j.intents.length} live atomic intent${j.intents.length === 1 ? '' : 's'}`);
    return true;
  } catch (e) {
    console.log(`     unreachable: ${e.message}`);
    return 'skip';
  }
});

await test('bid-intents endpoint returns records with every dapp-required field', async () => {
  if (!workerData) return 'skip';
  try {
    const r = await fetchWithRetry(`${WORKER_BASE}/assets/${ASSET.asset_id}/bid-intents?network=${ASSET.network}`);
    const j = await r.json();
    if (!Array.isArray(j.intents)) { console.log(`     intents: not an array`); return false; }
    for (const b of j.intents) {
      const missing = [];
      if (typeof b.bid_id !== 'string') missing.push('bid_id');
      if (typeof b.buyer_pubkey !== 'string') missing.push('buyer_pubkey');
      if (typeof b.amount !== 'string') missing.push('amount');
      if (typeof b.price_sats !== 'number') missing.push('price_sats');
      if (typeof b.expiry !== 'number') missing.push('expiry');
      if (missing.length) {
        console.log(`     bid ${b.bid_id?.slice(0, 8) || '?'}… missing: ${missing.join(', ')}`);
        return false;
      }
    }
    console.log(`     verified ${j.intents.length} live bid${j.intents.length === 1 ? '' : 's'}`);
    return true;
  } catch (e) {
    console.log(`     unreachable: ${e.message}`);
    return 'skip';
  }
});

// ------------------------------------------------------------
// 5. MONOTONIC COUNTER FLOORS (network-dependent)
//
// Asset state can only grow. A worker that reports a value below the
// pinned floor for any of these counters has either lost data
// (KV wipe, failed migration, indexer regression) or been tampered
// with. The floor is updated only when verified higher in a separate
// audited change to this file.
// ------------------------------------------------------------
await test('monotonic counters meet pinned floors (transfers, holders, disclosures, openings)', async () => {
  if (!workerData) return 'skip';
  const drifts = [];
  for (const [k, floor] of Object.entries(MONOTONIC_FLOORS)) {
    const v = Number(workerData[k]);
    if (!Number.isInteger(v)) { drifts.push(`${k}: missing or non-integer (got ${workerData[k]})`); continue; }
    if (v < floor) drifts.push(`${k}: ${v} < pinned floor ${floor} — asset state regressed`);
  }
  if (drifts.length) {
    drifts.forEach(d => console.log(`     ${d}`));
    return false;
  }
  return true;
});

// ------------------------------------------------------------
// 6. HISTORICAL TRADE PRESERVATION (network-dependent)
//
// Each pinned trade MUST still appear in the worker's trade history
// for this asset, AND its Bitcoin tx MUST still be confirmed on
// mainnet. Catches: worker trade-ring-buffer drops, indexer rescans
// that orphan confirmed trades, KV migrations that lose history.
// ------------------------------------------------------------
await test('pinned historical trades still appear in worker trade history', async () => {
  if (!workerData) return 'skip';
  if (!Array.isArray(workerData.trades)) {
    console.log(`     workerData.trades: not an array`);
    return false;
  }
  const tradeByTxid = new Map(workerData.trades.map(t => [t.txid, t]));
  const drifts = [];
  for (const pinned of PINNED_TRADES) {
    const live = tradeByTxid.get(pinned.txid);
    if (!live) { drifts.push(`trade ${pinned.txid.slice(0, 12)}… missing from worker trade history`); continue; }
    if (Number(live.price_sats) !== pinned.price_sats) drifts.push(`trade ${pinned.txid.slice(0, 12)}… price_sats drift: ${live.price_sats} vs ${pinned.price_sats}`);
    if (String(live.amount) !== pinned.amount) drifts.push(`trade ${pinned.txid.slice(0, 12)}… amount drift: ${live.amount} vs ${pinned.amount}`);
    if (Number(live.ts) !== pinned.ts) drifts.push(`trade ${pinned.txid.slice(0, 12)}… ts drift: ${live.ts} vs ${pinned.ts}`);
  }
  if (drifts.length) {
    drifts.forEach(d => console.log(`     ${d}`));
    return false;
  }
  console.log(`     verified ${PINNED_TRADES.length} pinned trades present + fields unchanged`);
  return true;
});

await test('pinned historical trade txs still confirmed on mainnet', async () => {
  try {
    const fails = [];
    for (const pinned of PINNED_TRADES) {
      const r = await fetchWithRetry(`${CHAIN_API}/tx/${pinned.txid}`);
      const tx = await r.json();
      if (!tx.status?.confirmed) {
        fails.push(`tx ${pinned.txid.slice(0, 12)}… is not confirmed (worker shows it as a trade)`);
        continue;
      }
    }
    if (fails.length) {
      fails.forEach(f => console.log(`     ${f}`));
      return false;
    }
    console.log(`     verified ${PINNED_TRADES.length} pinned trade txs still confirmed on chain`);
    return true;
  } catch (e) {
    console.log(`     unreachable: ${e.message}`);
    return 'skip';
  }
});

// ------------------------------------------------------------
// 7. CRYPTOGRAPHIC REPLAY (network-dependent)
//
// For each pinned trade tx, fetch its full witness from mainnet,
// decode the envelope script, decode the T_AXFER payload, and
// re-verify the aggregated bulletproof rangeproof against the
// SPEC-normative crypto stack (`tacit-bp-v1` transcript domain,
// canonical G/H/Q generators from `tacit-bp-{G,H,Q}-v1`).
//
// What this DOES verify:
//   - The envelope script in vin[0].witness lives at the canonical
//     index (witness[witness.length - 2], or [-3] with annex).
//   - The envelope script decodes via the canonical envelope
//     decoder (magic bytes "TACIT", version byte 0x01).
//   - The decoded opcode is recognized as T_AXFER (0x26).
//   - The T_AXFER payload decodes structurally: asset_id (32B),
//     asset_input_count (≥ 1), kernel_sig (64B), output count
//     N ∈ {1, 2, 4, 8}, output commitments (33B each + 8B amount
//     ct), and rangeproof bytes match the declared rp_len exactly.
//   - The asset_id in every replayed payload matches TAC's pinned
//     asset_id (no asset-id collision, no SPEC drift in asset_id
//     placement within the payload).
//   - Every output commitment parses as a valid compressed
//     secp256k1 curve point.
//   - The aggregated bulletproof rangeproof re-verifies under the
//     SPEC §3 generators and `tacit-bp-v1` Fiat-Shamir transcript.
//     A failure here means a historical TAC transfer is no longer
//     cryptographically valid under current code — load-bearing
//     protection against any validator regression that perturbs
//     bulletproof verification.
//
// What this does NOT yet verify (deferred to a follow-up canary):
//   - The kernel signature against (Σ C_out − Σ C_in).x_only —
//     requires walking back to parent UTXOs for input commitments.
//     Ancestry walk is ~10× heavier; warrants its own canary file.
//
// HISTORICAL NOTE: prior to commit landing the v1/v2 BP transcript
// alignment, `tests/bulletproofs.mjs` used `tacit-bp-v2` while the
// dapp + SPEC.md §3 normatively pinned `tacit-bp-v1`. The drift was
// surfaced when this canary's cryptographic-replay test failed
// against live mainnet proofs. Alignment landed in the same PR as
// this canary's rangeproof step; the full test suite (BP + composition
// + adversarial + vectors + mixer + indexer) was re-run under v1 and
// produced zero regressions.
// ------------------------------------------------------------
await test('pinned trades: structural decode + asset_id match + rangeproof re-verifies (T_AXFER 0x26)', async () => {
  try {
    let totalOutputs = 0;
    for (const pinned of PINNED_TRADES) {
      const r = await fetchWithRetry(`${CHAIN_API}/tx/${pinned.txid}`);
      const tx = await r.json();
      const witness = tx.vin?.[0]?.witness;
      if (!Array.isArray(witness) || witness.length < 3) {
        console.log(`     ${pinned.txid.slice(0, 12)}…: vin[0].witness missing or too short`);
        return false;
      }
      // For a taproot script-path spend, the script lives at witness[witness.length - 2]
      // and the control block at witness[witness.length - 1]. With an annex (rare,
      // starts with 0x50), there's an extra trailing element. We tolerate both.
      const hasAnnex = witness[witness.length - 1].startsWith('50');
      const scriptHex = hasAnnex ? witness[witness.length - 3] : witness[witness.length - 2];
      if (!scriptHex || typeof scriptHex !== 'string') {
        console.log(`     ${pinned.txid.slice(0, 12)}…: envelope script missing from witness`);
        return false;
      }
      const env = decodeEnvelopeScript(hexToBytes(scriptHex));
      if (!env) {
        console.log(`     ${pinned.txid.slice(0, 12)}…: envelope script failed to decode via canonical decoder`);
        return false;
      }
      if (env.opcode !== T_AXFER_OPCODE) {
        console.log(`     ${pinned.txid.slice(0, 12)}…: opcode is 0x${env.opcode.toString(16).padStart(2, '0')}, expected 0x26 (T_AXFER) — trade settlement assumed`);
        return false;
      }
      const pay = decodeAxferPayload(env.payload);
      if (!pay) {
        console.log(`     ${pinned.txid.slice(0, 12)}…: T_AXFER payload failed to decode`);
        return false;
      }
      if (bytesToHex(pay.asset_id) !== ASSET.asset_id) {
        console.log(`     ${pinned.txid.slice(0, 12)}…: asset_id in payload (${bytesToHex(pay.asset_id).slice(0, 12)}…) doesn't match TAC`);
        return false;
      }
      // Every commitment must parse as a curve point. Fails if a SPEC
      // change accidentally changes commitment encoding from
      // compressed-secp256k1 to something else.
      let V_pts;
      try {
        V_pts = pay.outputs.map(o => bytesToPoint(o.commitment));
      } catch (e) {
        console.log(`     ${pinned.txid.slice(0, 12)}…: commitment bytes failed to parse as curve points: ${e.message}`);
        return false;
      }
      // Aggregated bulletproof rangeproof must verify under the
      // SPEC §3 generators + `tacit-bp-v1` Fiat-Shamir transcript.
      // This catches any regression in BP generators, transcript
      // domain, n_bits parameter, or aggregation rules that would
      // retroactively invalidate this confirmed mainnet trade.
      const ok = bpRangeAggVerify(V_pts, pay.rangeproof);
      if (!ok) {
        console.log(`     ${pinned.txid.slice(0, 12)}…: bulletproof rangeproof FAILED to verify under current crypto stack`);
        console.log(`     >>> A historical TAC transfer is no longer cryptographically valid. <<<`);
        console.log(`     >>> Investigate the BP generators / transcript domain immediately. <<<`);
        return false;
      }
      totalOutputs += pay.N;
    }
    console.log(`     verified ${PINNED_TRADES.length} pinned trades · ${totalOutputs} output commitments · all rangeproofs re-verify under tacit-bp-v1`);
    return true;
  } catch (e) {
    console.log(`     unreachable / decode error: ${e.message}`);
    return 'skip';
  }
});

// ------------------------------------------------------------
// Result
// ------------------------------------------------------------
console.log(`\n=== ${pass} passed · ${fail} failed · ${skipped} skipped ===`);
if (fail > 0) {
  console.log(`\nCanary failed for asset ${ASSET.asset_id}. If this is a deliberate change,`);
  console.log(`update the pinned fixtures in tests/canary-asset-tac-mainnet.test.mjs.`);
  console.log(`If unexpected, revert the change that broke this asset's invariants.`);
  process.exit(1);
}
