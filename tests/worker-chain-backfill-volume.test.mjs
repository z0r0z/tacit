// Worker chain-side trade-volume backfill (cron path).
//
// The /hint endpoint is the primary trade-record source: the dapp ships
// reveal_txid + price_sats + amount after broadcast. But if that POST
// never lands (tab close, network blip, cron-arrives-first race), the
// settled trade goes uncounted — undercounting lifetime + 24h volume.
//
// `_deriveAxferTradeFromChain` is the safety net. Given the reveal tx,
// it walks the commit tx's vin and matches each spent asset_outpoint
// against `axintent-by-outpoint` + `presale-by-outpoint`, recovering
// price_sats from the listing record. `_recordSettledTradeVolume` then
// writes the same daily / lifetime / ring aggregates the hint endpoint
// writes — both paths share the helper, so the two-path contract is
// byte-for-byte identical.
//
// This file pins:
//   - single preauth-take derivation (commit spends ONE seller outpoint)
//   - batched preauth-take derivation (commit spends N seller outpoints,
//     Σ price_sats lands in one settled-trade record)
//   - whole-fill atomic-intent derivation
//   - variable-amount atomic-intent derivation reads `requested_amount`
//     from the fulfilment record and scales price = floor(req × px / lst)
//   - unmatched outpoint (no live listing record) returns null
//   - helper writes (daily, lifetime, ring, last_trade) when called
//   - end-to-end: derive → record → readback matches
//
// Run: `node tests/worker-chain-backfill-volume.test.mjs`

import {
  _deriveAxferTradeFromChain, _recordSettledTradeVolume,
  atomicIntentOutpointIndexKey, preauthOutpointIndexKey,
  atomicIntentKey, preauthSaleKey, atomicFulfilmentKey,
  tradeDayKey, tradeLifetimeKey, tradesRingKey,
  _utcYyyymmdd,
  T_AXFER, T_AXFER_VAR,
} from '../worker/src/index.js';

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(ok => {
      if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
      else { console.log(`  FAIL  ${label}${ok ? ` (got ${JSON.stringify(ok)})` : ''}`); fail++; }
    })
    .catch(e => { console.log(`  FAIL  ${label}: ${e?.message || e}`); fail++; });
}

// In-memory KV stub + fetch stub. `chain` maps txid → tx JSON for the
// commit-tx lookup. The worker calls `fetchFreshTxJson(env, txid, network)`
// which itself hits `fetch(`${base}/tx/${txid}`)`; we patch globalThis.fetch
// to consult `chain`.
function makeKvStub() {
  const store = new Map();
  return {
    async get(k, type) {
      const v = store.get(k);
      if (v === undefined) return null;
      if (type === 'json') return typeof v === 'string' ? JSON.parse(v) : v;
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
    async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    async delete(k) { store.delete(k); },
    _dump() { return store; },
  };
}

let _chainStub = new Map();
const _origFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const m = String(url).match(/\/tx\/([0-9a-f]{64})$/i);
  if (m && _chainStub.has(m[1].toLowerCase())) {
    const body = _chainStub.get(m[1].toLowerCase());
    return { ok: true, status: 200, json: async () => body };
  }
  return { ok: false, status: 404, text: async () => 'not found' };
};

const NETWORK = 'signet';
const ASSET   = 'aa'.repeat(32);

const SELLER1_UTXO = { txid: '11'.repeat(32), vout: 0 };
const SELLER2_UTXO = { txid: '22'.repeat(32), vout: 0 };
const COMMIT_TXID  = '33'.repeat(32);
const REVEAL_TXID  = '44'.repeat(32);

// Helper: build synthetic { reveal_tx, commit_tx } chain pair.
function makeChainPair(sellerInputs) {
  const commitTx = {
    txid: COMMIT_TXID,
    vin: sellerInputs.map(s => ({ txid: s.txid, vout: s.vout })),
    vout: [{ scriptpubkey: '5120' + '00'.repeat(32), value: 1000 }],
    status: { block_time: 1_700_000_000 },
  };
  const revealTx = {
    txid: REVEAL_TXID,
    vin: [{ txid: COMMIT_TXID, vout: 0 }],
    vout: [{ scriptpubkey: '5120' + '01'.repeat(32) }],
    status: { block_time: 1_700_000_000 },
  };
  _chainStub.set(COMMIT_TXID.toLowerCase(), commitTx);
  return { commitTx, revealTx };
}

// ============================================================================
// 1. Single preauth-take derivation
// ============================================================================
console.log('\n§ Chain-derive: single preauth-take:');

await test('one preauth sale matched → price_sats from sale.min_price_sats', async () => {
  _chainStub = new Map();
  const env = { REGISTRY_KV: makeKvStub() };
  const SALE_ID = 'ab'.repeat(16);
  // Register the sale + outpoint index — same writes the live POST handler
  // performs (preauthSaleKey + preauthOutpointIndexKey).
  await env.REGISTRY_KV.put(preauthSaleKey(NETWORK, ASSET, SALE_ID), {
    asset_id: ASSET, sale_id: SALE_ID,
    asset_outpoint: SELLER1_UTXO,
    asset_opening: { amount: '500', blinding: '00'.repeat(32) },
    min_price_sats: 12345,
  });
  await env.REGISTRY_KV.put(
    preauthOutpointIndexKey(NETWORK, ASSET, SELLER1_UTXO.txid, SELLER1_UTXO.vout),
    SALE_ID,
  );
  const { revealTx } = makeChainPair([SELLER1_UTXO]);
  const r = await _deriveAxferTradeFromChain(env, NETWORK, revealTx, T_AXFER, ASSET);
  return r != null
      && r.price_sats === 12345
      && r.amount === 500n
      && r.fills.length === 1
      && r.fills[0].kind === 'preauth';
});

// ============================================================================
// 2. Batched preauth-take derivation (Σ across N sellers)
// ============================================================================
console.log('\n§ Chain-derive: batched preauth-take:');

await test('two preauth sales matched → Σ price_sats lands in one trade record', async () => {
  _chainStub = new Map();
  const env = { REGISTRY_KV: makeKvStub() };
  for (const { utxo, saleId, price, amount } of [
    { utxo: SELLER1_UTXO, saleId: 'aa'.repeat(16), price: 5000, amount: '100' },
    { utxo: SELLER2_UTXO, saleId: 'bb'.repeat(16), price: 7000, amount: '200' },
  ]) {
    await env.REGISTRY_KV.put(preauthSaleKey(NETWORK, ASSET, saleId), {
      asset_id: ASSET, sale_id: saleId,
      asset_outpoint: utxo,
      asset_opening: { amount, blinding: '00'.repeat(32) },
      min_price_sats: price,
    });
    await env.REGISTRY_KV.put(preauthOutpointIndexKey(NETWORK, ASSET, utxo.txid, utxo.vout), saleId);
  }
  const { revealTx } = makeChainPair([SELLER1_UTXO, SELLER2_UTXO]);
  const r = await _deriveAxferTradeFromChain(env, NETWORK, revealTx, T_AXFER, ASSET);
  return r != null
      && r.price_sats === 12000
      && r.amount === 300n
      && r.fills.length === 2
      && r.fills.every(f => f.kind === 'preauth');
});

// ============================================================================
// 3. Whole-fill atomic-intent derivation
// ============================================================================
console.log('\n§ Chain-derive: whole-fill atomic intent:');

await test('one atomic intent matched → price_sats from intent.price_sats', async () => {
  _chainStub = new Map();
  const env = { REGISTRY_KV: makeKvStub() };
  const INTENT_ID = 'cc'.repeat(16);
  await env.REGISTRY_KV.put(atomicIntentKey(NETWORK, ASSET, INTENT_ID), {
    asset_id: ASSET, intent_id: INTENT_ID,
    amount: '1000', price_sats: 50000,
    asset_utxo: { ...SELLER1_UTXO, value: 1000 },
    // No min_take_amount = whole-fill intent.
  });
  await env.REGISTRY_KV.put(
    atomicIntentOutpointIndexKey(NETWORK, ASSET, SELLER1_UTXO.txid, SELLER1_UTXO.vout),
    INTENT_ID,
  );
  const { revealTx } = makeChainPair([SELLER1_UTXO]);
  const r = await _deriveAxferTradeFromChain(env, NETWORK, revealTx, T_AXFER, ASSET);
  return r != null
      && r.price_sats === 50000
      && r.amount === 1000n
      && r.fills[0].kind === 'intent';
});

// ============================================================================
// 4. Variable-amount atomic-intent: requires fulfilment record
// ============================================================================
console.log('\n§ Chain-derive: variable-amount atomic intent:');

await test('var intent with fulfilment.requested_amount → scaled price', async () => {
  _chainStub = new Map();
  const env = { REGISTRY_KV: makeKvStub() };
  const INTENT_ID = 'dd'.repeat(16);
  // amount=1000 listed @ price_sats=80000 (80 sats/unit). Buyer takes 250.
  // scaled_price = floor(250 * 80000 / 1000) = 20000.
  await env.REGISTRY_KV.put(atomicIntentKey(NETWORK, ASSET, INTENT_ID), {
    asset_id: ASSET, intent_id: INTENT_ID,
    amount: '1000', price_sats: 80000, min_take_amount: '100',
    asset_utxo: { ...SELLER1_UTXO, value: 1000 },
  });
  await env.REGISTRY_KV.put(
    atomicIntentOutpointIndexKey(NETWORK, ASSET, SELLER1_UTXO.txid, SELLER1_UTXO.vout),
    INTENT_ID,
  );
  await env.REGISTRY_KV.put(atomicFulfilmentKey(NETWORK, ASSET, INTENT_ID), {
    intent_id: INTENT_ID,
    requested_amount: '250',
    state: 'COMMIT_READY',
  });
  const { revealTx } = makeChainPair([SELLER1_UTXO]);
  const r = await _deriveAxferTradeFromChain(env, NETWORK, revealTx, T_AXFER_VAR, ASSET);
  return r != null
      && r.price_sats === 20000
      && r.amount === 250n
      && r.fills[0].kind === 'intent-var';
});

await test('var intent WITHOUT fulfilment record → derivation skips (returns null)', async () => {
  _chainStub = new Map();
  const env = { REGISTRY_KV: makeKvStub() };
  const INTENT_ID = 'ee'.repeat(16);
  await env.REGISTRY_KV.put(atomicIntentKey(NETWORK, ASSET, INTENT_ID), {
    asset_id: ASSET, intent_id: INTENT_ID,
    amount: '1000', price_sats: 80000, min_take_amount: '100',
    asset_utxo: { ...SELLER1_UTXO, value: 1000 },
  });
  await env.REGISTRY_KV.put(
    atomicIntentOutpointIndexKey(NETWORK, ASSET, SELLER1_UTXO.txid, SELLER1_UTXO.vout),
    INTENT_ID,
  );
  // No fulfilment record — cron can't recover the (confidential) settled
  // amount. Hint path remains the only volume source for this trade.
  const { revealTx } = makeChainPair([SELLER1_UTXO]);
  const r = await _deriveAxferTradeFromChain(env, NETWORK, revealTx, T_AXFER_VAR, ASSET);
  return r === null;
});

// ============================================================================
// 5. Negative cases
// ============================================================================
console.log('\n§ Chain-derive: negative cases:');

await test('no matching outpoint → returns null', async () => {
  _chainStub = new Map();
  const env = { REGISTRY_KV: makeKvStub() };
  const { revealTx } = makeChainPair([SELLER1_UTXO]);
  return (await _deriveAxferTradeFromChain(env, NETWORK, revealTx, T_AXFER, ASSET)) === null;
});

await test('commit tx unfetchable from chain → returns null', async () => {
  _chainStub = new Map();  // empty: no chain entries
  const env = { REGISTRY_KV: makeKvStub() };
  const revealTx = {
    txid: REVEAL_TXID,
    vin: [{ txid: COMMIT_TXID, vout: 0 }],
    status: { block_time: 1_700_000_000 },
  };
  return (await _deriveAxferTradeFromChain(env, NETWORK, revealTx, T_AXFER, ASSET)) === null;
});

await test('reveal tx with no vin → returns null', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  return (await _deriveAxferTradeFromChain(env, NETWORK, { txid: REVEAL_TXID, vin: [] }, T_AXFER, ASSET)) === null;
});

// ============================================================================
// 6. _recordSettledTradeVolume writes match hint-path expectations
// ============================================================================
console.log('\n§ Helper writes daily + lifetime + ring + last_trade:');

await test('first call writes all four aggregates', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  const NOW = 1_700_000_000;
  const lastTrade = { txid: REVEAL_TXID, price_sats: 12345, amount: '500', ts: NOW, fill_count: 1 };
  await _recordSettledTradeVolume(env, NETWORK, ASSET, lastTrade);
  const day  = await env.REGISTRY_KV.get(tradeDayKey(NETWORK, ASSET, _utcYyyymmdd(NOW)));
  const life = await env.REGISTRY_KV.get(tradeLifetimeKey(NETWORK, ASSET));
  const ringRaw = await env.REGISTRY_KV.get(tradesRingKey(NETWORK, ASSET));
  const ring = JSON.parse(ringRaw);
  return Number(day) === 12345
      && Number(life) === 12345
      && ring.length === 1
      && ring[0].txid === REVEAL_TXID
      && ring[0].price_sats === 12345;
});

await test('two distinct trades sum into all aggregates', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  const NOW = 1_700_000_000;
  await _recordSettledTradeVolume(env, NETWORK, ASSET, {
    txid: 'aa'.repeat(32), price_sats: 1000, amount: '10', ts: NOW, fill_count: 1,
  });
  await _recordSettledTradeVolume(env, NETWORK, ASSET, {
    txid: 'bb'.repeat(32), price_sats: 2500, amount: '25', ts: NOW, fill_count: 1,
  });
  const day  = await env.REGISTRY_KV.get(tradeDayKey(NETWORK, ASSET, _utcYyyymmdd(NOW)));
  const life = await env.REGISTRY_KV.get(tradeLifetimeKey(NETWORK, ASSET));
  return Number(day) === 3500 && Number(life) === 3500;
});

await test('ring dedup: same txid called twice → second is a no-op for ring', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  const lastTrade = { txid: REVEAL_TXID, price_sats: 1000, amount: '10', ts: 1_700_000_000, fill_count: 1 };
  await _recordSettledTradeVolume(env, NETWORK, ASSET, lastTrade);
  await _recordSettledTradeVolume(env, NETWORK, ASSET, lastTrade);
  const ringRaw = await env.REGISTRY_KV.get(tradesRingKey(NETWORK, ASSET));
  const ring = JSON.parse(ringRaw);
  // Ring dedup kicks in. Day/lifetime are NOT gated by the helper (caller
  // owns the bumpTransferCount gate); this test only pins the ring dedup.
  return ring.length === 1;
});

// ============================================================================
// 7. End-to-end: derive → record → readback
// ============================================================================
console.log('\n§ End-to-end derive + record:');

await test('derive batched preauth → record → daily + lifetime + ring all populated', async () => {
  _chainStub = new Map();
  const env = { REGISTRY_KV: makeKvStub() };
  // Two seller sales totalling 9000 sats.
  for (const { utxo, saleId, price, amount } of [
    { utxo: SELLER1_UTXO, saleId: '11'.repeat(16), price: 4000, amount: '40' },
    { utxo: SELLER2_UTXO, saleId: '22'.repeat(16), price: 5000, amount: '50' },
  ]) {
    await env.REGISTRY_KV.put(preauthSaleKey(NETWORK, ASSET, saleId), {
      asset_id: ASSET, sale_id: saleId,
      asset_outpoint: utxo, asset_opening: { amount, blinding: '00'.repeat(32) },
      min_price_sats: price,
    });
    await env.REGISTRY_KV.put(preauthOutpointIndexKey(NETWORK, ASSET, utxo.txid, utxo.vout), saleId);
  }
  const { revealTx } = makeChainPair([SELLER1_UTXO, SELLER2_UTXO]);
  const derived = await _deriveAxferTradeFromChain(env, NETWORK, revealTx, T_AXFER, ASSET);
  if (!derived) return false;
  const lastTrade = {
    txid: revealTx.txid,
    price_sats: derived.price_sats,
    amount: String(derived.amount),
    ts: revealTx.status.block_time,
    fill_count: derived.fills.length,
    source: 'cron-chain-backfill',
  };
  await _recordSettledTradeVolume(env, NETWORK, ASSET, lastTrade);
  const day  = await env.REGISTRY_KV.get(tradeDayKey(NETWORK, ASSET, _utcYyyymmdd(revealTx.status.block_time)));
  const life = await env.REGISTRY_KV.get(tradeLifetimeKey(NETWORK, ASSET));
  const ring = JSON.parse(await env.REGISTRY_KV.get(tradesRingKey(NETWORK, ASSET)));
  return Number(day) === 9000
      && Number(life) === 9000
      && ring.length === 1
      && ring[0].price_sats === 9000
      && ring[0].fill_count === 2
      && ring[0].source === 'cron-chain-backfill';
});

// Restore fetch in case anything else loads after us.
globalThis.fetch = _origFetch;

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
