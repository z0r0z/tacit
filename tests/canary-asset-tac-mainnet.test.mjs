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
// Result
// ------------------------------------------------------------
console.log(`\n=== ${pass} passed · ${fail} failed · ${skipped} skipped ===`);
if (fail > 0) {
  console.log(`\nCanary failed for asset ${ASSET.asset_id}. If this is a deliberate change,`);
  console.log(`update the pinned fixtures in tests/canary-asset-tac-mainnet.test.mjs.`);
  console.log(`If unexpected, revert the change that broke this asset's invariants.`);
  process.exit(1);
}
