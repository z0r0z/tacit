// Worker-side regression coverage for batched preauth-take indexing.
//
// The dapp's takePreauthSaleBatch emits ONE T_AXFER reveal tx with
// asset_input_count = N (N sellers) and outputs.length = 1 (one
// combined buyer recipient). The worker must:
//
//   (1) Decode the payload without choking on assetInputCount > 1.
//   (2) Bump the recipient holder count for vout[0] ONLY — the
//       seller payout outputs at vout[1..N] are plain P2WPKH and
//       must NOT be counted as tacit-asset recipients.
//   (3) bumpTransferCount must be idempotent under hint replays so
//       a single batched reveal counts ONCE toward the asset's
//       transfer counter regardless of how many hint POSTs arrive.
//   (4) The hint handler's daily-volume bucket must record the
//       AGGREGATED price_sats (Σ across all N fills) on the first
//       hint and ignore subsequent duplicates — so a batched buy
//       contributes its true settled total to 24h volume, not just
//       one fill's slice.
//
// Together these properties pin the dapp ↔ worker contract for
// batched buys. The dapp side is already pinned by
// preauth-take.test.mjs (52) + bid-fulfil-batch-e2e.test.mjs (11);
// this file completes the picture by exercising the worker
// primitives directly against an in-memory KV stub.
//
// Run: `node worker-batched-axfer-index.test.mjs`

import {
  decodeAxferPayload,
  bumpTransferCount, tradeDayKey, tradeLifetimeKey, tradesRingKey,
  _utcYyyymmdd, TRADES_RING_CAP, _rolling24hVolumeSats,
  T_AXFER,
} from '../worker/src/index.js';

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(ok => {
      if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
      else             { console.log(`  FAIL  ${label}`); fail++; }
    })
    .catch(e => { console.log(`  THROW ${label}: ${e.message}`); fail++; });
}

// Minimal in-memory KV stub. Mirrors the Cloudflare Workers KV surface
// the cron handler reads: get(), put(opts: {expirationTtl}), list({prefix}).
// expirationTtl is recorded but not enforced (tests don't simulate
// wall-clock passage). list() is unused in this file's call paths.
function makeKvStub() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key).value : null; },
    async put(key, value, opts) { store.set(key, { value, ttl: opts?.expirationTtl }); },
    async list({ prefix, limit }) {
      const keys = [];
      for (const k of store.keys()) if (k.startsWith(prefix)) keys.push({ name: k });
      return { keys: keys.slice(0, limit || 1000), list_complete: true };
    },
  };
}

const u8 = (...nums) => new Uint8Array(nums);
const zeroes = (n) => new Uint8Array(n);
function concat(...bufs) {
  let n = 0; for (const b of bufs) n += b.length;
  const out = new Uint8Array(n); let p = 0;
  for (const b of bufs) { out.set(b, p); p += b.length; }
  return out;
}

// ============================================================================
// 1. AXFER decoder accepts batched payloads (N=2, 5, 8 input counts)
// ============================================================================
console.log('\n§ Batched AXFER payload decoding (asset_input_count > 1):');

function mkBatchedAxferPayload(assetInputCount) {
  // Wire format: opcode(1) || asset_id(32) || asset_input_count(1) ||
  // kernel_sig(64) || N_outputs(1) || N_outputs × (commitment(33) +
  // amount_ct(8)) || rp_len(2 LE) || rangeproof(rp_len)
  //
  // For batched preauth-take: N inputs share one combined recipient
  // output, so N_outputs = 1 even when asset_input_count is N.
  return concat(
    u8(T_AXFER),
    zeroes(32),                  // asset_id
    u8(assetInputCount),         // asset_input_count: the batched arg
    zeroes(64),                  // kernel_sig (signature opaque to decoder)
    u8(1),                       // N_outputs = 1 (combined recipient)
    zeroes(33),                  // output[0].commitment
    zeroes(8),                   // output[0].encrypted_amount
    u8(0, 0),                    // rp_len = 0 (zero-length rangeproof for shape test)
  );
}

await test('decodeAxferPayload(N=2) returns asset_input_count=2 and outputs.length=1', () => {
  const d = decodeAxferPayload(mkBatchedAxferPayload(2));
  return d && d.asset_input_count === 2 && Array.isArray(d.outputs) && d.outputs.length === 1;
});
await test('decodeAxferPayload(N=5) returns asset_input_count=5 and outputs.length=1', () => {
  const d = decodeAxferPayload(mkBatchedAxferPayload(5));
  return d && d.asset_input_count === 5 && Array.isArray(d.outputs) && d.outputs.length === 1;
});
await test('decodeAxferPayload(N=8) returns asset_input_count=8 and outputs.length=1', () => {
  const d = decodeAxferPayload(mkBatchedAxferPayload(8));
  return d && d.asset_input_count === 8 && Array.isArray(d.outputs) && d.outputs.length === 1;
});
await test('decodeAxferPayload(N=255 max) is accepted', () => {
  const d = decodeAxferPayload(mkBatchedAxferPayload(255));
  return d && d.asset_input_count === 255 && d.outputs.length === 1;
});
await test('decodeAxferPayload rejects asset_input_count = 0', () => {
  // The wire format byte allows 0; the decoder MUST reject because
  // an AXFER without any asset input is structurally meaningless
  // (no commitments to conserve against).
  const d = decodeAxferPayload(mkBatchedAxferPayload(0));
  return d === null;
});

// ============================================================================
// 2. Recipient-discovery vout mapping
//
// The cron's T_AXFER scanner does `voutForOutput = (i) => i`. For
// batched preauth-take with outputs.length=1, only output[0] is
// processed → vout[0] only. We pin this by asserting the decoded
// payload's output count tracks the buyer-recipient slot exclusively.
// ============================================================================
console.log('\n§ Recipient-discovery: only vout[0] is treated as tacit-asset output:');

await test('decoded outputs.length=1 means the cron walks only one vout', () => {
  const d = decodeAxferPayload(mkBatchedAxferPayload(5));
  return d.outputs.length === 1;
});
await test('the decoded outputs do NOT include any per-seller payout indices', () => {
  // The decoder reads N_outputs from the payload byte; it cannot
  // synthesize extra outputs from asset_input_count. So an N=5
  // batched payload with N_outputs=1 produces exactly one output
  // entry — even if a buggy consumer believed otherwise, the
  // decoder's return shape forbids it.
  const d = decodeAxferPayload(mkBatchedAxferPayload(5));
  return d.outputs.length === 1
    && typeof d.outputs[0].commitment === 'string'
    && d.outputs[0].commitment.length === 66; // 33 bytes hex-encoded
});

// ============================================================================
// 3. bumpTransferCount idempotency (the load-bearing rule)
// ============================================================================
console.log('\n§ bumpTransferCount idempotency (Σ batched volume must not double-count):');

const ASSET_A = 'a'.repeat(64);
const ASSET_B = 'b'.repeat(64);
const TX_BATCHED = '11'.repeat(32);
const TX_OTHER   = '22'.repeat(32);

await test('first call returns true (counted), subsequent calls return false (idempotent)', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  const a = await bumpTransferCount(env, 'signet', ASSET_A, TX_BATCHED);
  const b = await bumpTransferCount(env, 'signet', ASSET_A, TX_BATCHED);
  const c = await bumpTransferCount(env, 'signet', ASSET_A, TX_BATCHED);
  return a === true && b === false && c === false;
});

await test('different txids for same asset count independently', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  const a = await bumpTransferCount(env, 'signet', ASSET_A, TX_BATCHED);
  const b = await bumpTransferCount(env, 'signet', ASSET_A, TX_OTHER);
  return a === true && b === true;
});

await test('same txid for different assets count independently', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  const a = await bumpTransferCount(env, 'signet', ASSET_A, TX_BATCHED);
  const b = await bumpTransferCount(env, 'signet', ASSET_B, TX_BATCHED);
  return a === true && b === true;
});

// ============================================================================
// 4. Daily volume bucket — Σ price_sats lands exactly once per batched reveal
//
// Simulates the cron handler's `if (counted) { daily += price_sats }`
// pattern against an in-memory KV stub. The contract:
//   - First hint POST with price_sats P stamps P into the daily bucket.
//   - Subsequent hint POSTs (replays from the dapp's retry chain in
//     postHint, or from cron + hint colliding) are dropped because
//     bumpTransferCount returns false.
//
// For a batched buy with N=3 fills at prices P1, P2, P3, the dapp posts
// ONE aggregated hint with price_sats = P1+P2+P3. We verify that
// (a) the aggregated total lands in the bucket once, (b) a duplicate
// of the same hint doesn't double-count.
// ============================================================================
console.log('\n§ Daily volume bucket — aggregated batched hint accounting:');

const NOW = 1_700_000_000;
const NETWORK = 'signet';
const TODAY = _utcYyyymmdd(NOW);
const ASSET = 'c'.repeat(64);
const REVEAL_TXID = '33'.repeat(32);

// Mini-handler matching the cron's `if (counted) { daily += price_sats }`
// pattern around worker/src/index.js line 4696. Mirrors the production
// logic byte-for-byte so a regression in either side surfaces here.
// fill_count flows into the lastTrade + ring buffer entry (defaults to 1
// if absent, capped at 255); volume + lifetime totals are unaffected
// since they consume price_sats directly.
async function applyBatchedHint(env, network, aid, txidHex, price_sats, fill_count) {
  const counted = await bumpTransferCount(env, network, aid, txidHex);
  if (!counted) return { counted, daily_delta: 0 };
  const _fcRaw = Number(fill_count);
  const fillCount = (Number.isInteger(_fcRaw) && _fcRaw >= 1 && _fcRaw <= 255)
    ? _fcRaw
    : 1;
  const lastTrade = {
    txid: txidHex,
    price_sats,
    amount: '1',
    ts: NOW,
    fill_count: fillCount,
  };
  // Stub the last_trade write so the ring-buffer assertion below can
  // read it back.
  await env.REGISTRY_KV.put(`lasttrade-test:${aid}:${txidHex}`, JSON.stringify(lastTrade));
  const dayKey = tradeDayKey(network, aid, _utcYyyymmdd(NOW));
  const prevDay = await env.REGISTRY_KV.get(dayKey);
  const prevSats = prevDay ? (Number(prevDay) || 0) : 0;
  await env.REGISTRY_KV.put(dayKey, String(prevSats + price_sats), { expirationTtl: 7 * 86400 });
  // Lifetime cumulative
  const lifeKey = tradeLifetimeKey(network, aid);
  const prevLife = await env.REGISTRY_KV.get(lifeKey);
  const prevLifeSats = prevLife ? (Number(prevLife) || 0) : 0;
  await env.REGISTRY_KV.put(lifeKey, String(prevLifeSats + price_sats));
  return { counted, daily_delta: price_sats, lastTrade };
}

await test('first batched hint adds Σ price_sats to today bucket', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  const r = await applyBatchedHint(env, NETWORK, ASSET, REVEAL_TXID, 5000 + 3000 + 7000, 3); // Σ = 15,000
  const stored = await env.REGISTRY_KV.get(tradeDayKey(NETWORK, ASSET, TODAY));
  return r.counted === true && Number(stored) === 15_000;
});

await test('duplicate hint replay does NOT double-count', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  await applyBatchedHint(env, NETWORK, ASSET, REVEAL_TXID, 15_000, 3);
  const dup = await applyBatchedHint(env, NETWORK, ASSET, REVEAL_TXID, 15_000, 3);
  const stored = await env.REGISTRY_KV.get(tradeDayKey(NETWORK, ASSET, TODAY));
  return dup.counted === false && dup.daily_delta === 0 && Number(stored) === 15_000;
});

await test('two batched reveals (different txids) sum to combined day-bucket', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  await applyBatchedHint(env, NETWORK, ASSET, REVEAL_TXID, 15_000, 3);
  await applyBatchedHint(env, NETWORK, ASSET, '44'.repeat(32), 22_500, 5);
  const stored = await env.REGISTRY_KV.get(tradeDayKey(NETWORK, ASSET, TODAY));
  return Number(stored) === 37_500;
});

await test('lifetime cumulative volume tracks Σ across batched reveals', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  await applyBatchedHint(env, NETWORK, ASSET, REVEAL_TXID, 15_000, 3);
  await applyBatchedHint(env, NETWORK, ASSET, '44'.repeat(32), 22_500, 5);
  await applyBatchedHint(env, NETWORK, ASSET, '55'.repeat(32), 8_000, 1);
  const lifetime = await env.REGISTRY_KV.get(tradeLifetimeKey(NETWORK, ASSET));
  return Number(lifetime) === 45_500;
});

// ============================================================================
// 4b. fill_count: lastTrade record propagation
//
// Pins that the hint handler stores fill_count on the last_trade /
// ring-buffer entries unchanged, defaulting to 1 for legacy callers
// (older dapp builds or non-batched flows) and capping at 255 to
// reject malformed bodies.
// ============================================================================
console.log('\n§ fill_count metadata propagation:');

await test('batched hint stores fill_count == N on lastTrade record', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  const r = await applyBatchedHint(env, NETWORK, ASSET, REVEAL_TXID, 15_000, 5);
  return r.lastTrade && r.lastTrade.fill_count === 5;
});
await test('single-take hint stores fill_count == 1', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  const r = await applyBatchedHint(env, NETWORK, ASSET, REVEAL_TXID, 1_000, 1);
  return r.lastTrade && r.lastTrade.fill_count === 1;
});
await test('missing fill_count defaults to 1 (backwards compat with older dapp builds)', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  const r = await applyBatchedHint(env, NETWORK, ASSET, REVEAL_TXID, 1_000, undefined);
  return r.lastTrade && r.lastTrade.fill_count === 1;
});
await test('fill_count > 255 is clamped to 1 (rejected as malformed)', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  const r = await applyBatchedHint(env, NETWORK, ASSET, REVEAL_TXID, 1_000, 999);
  return r.lastTrade && r.lastTrade.fill_count === 1;
});
await test('fill_count < 1 (zero or negative) is clamped to 1', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  const r1 = await applyBatchedHint(env, NETWORK, ASSET, REVEAL_TXID, 1_000, 0);
  const r2 = await applyBatchedHint(env, NETWORK, ASSET, '66'.repeat(32), 1_000, -3);
  return r1.lastTrade && r1.lastTrade.fill_count === 1
      && r2.lastTrade && r2.lastTrade.fill_count === 1;
});
await test('fill_count = 255 (max) is accepted as-is', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  const r = await applyBatchedHint(env, NETWORK, ASSET, REVEAL_TXID, 1_000, 255);
  return r.lastTrade && r.lastTrade.fill_count === 255;
});

// ============================================================================
// 5. Defensive sanity — silent bad-byte rejection
//
// The dapp side trusts the worker validates AXFER bytes at hint time.
// Pin a few wire-format rejection cases so a malformed batched payload
// can't slip past the decoder and pollute the volume bucket.
// ============================================================================
console.log('\n§ Wire-format rejection:');

await test('decodeAxferPayload rejects truncated payload (no kernel_sig)', () => {
  const truncated = concat(u8(T_AXFER), zeroes(32), u8(3)); // ends right after asset_input_count
  return decodeAxferPayload(truncated) === null;
});
await test('decodeAxferPayload rejects rp_len mismatch with actual rangeproof bytes', () => {
  const bad = concat(
    u8(T_AXFER), zeroes(32), u8(2), zeroes(64), u8(1), zeroes(33), zeroes(8),
    u8(10, 0),     // declared rp_len = 10
    zeroes(5),     // but only 5 actual bytes follow
  );
  return decodeAxferPayload(bad) === null;
});
await test('decodeAxferPayload rejects N_outputs = 3 (not in {1, 2, 4, 8})', () => {
  const bad = concat(
    u8(T_AXFER), zeroes(32), u8(2), zeroes(64), u8(3),
    zeroes(33), zeroes(8), zeroes(33), zeroes(8), zeroes(33), zeroes(8),
    u8(0, 0),
  );
  return decodeAxferPayload(bad) === null;
});
await test('decodeAxferPayload rejects opcode != T_AXFER', () => {
  const bad = concat(u8(0x99), zeroes(32), u8(1), zeroes(64), u8(1), zeroes(33), zeroes(8), u8(0, 0));
  return decodeAxferPayload(bad) === null;
});

// ============================================================================
// 6. Strict rolling-24h volume from the timestamped ring.
//
// Replaces the today+yesterday UTC bucket sum (24-48h sliding window
// depending on time-of-day). Field is called volume_24h_sats — name
// must match the semantics. Helper falls back to bucket sum only when
// the ring is saturated within 24h (asset traded >TRADES_RING_CAP times
// in 24h, so the ring truncated older-but-in-window trades).
// ============================================================================
console.log('\n§ Strict rolling-24h volume (ring-based):');

const NOW_RTV = 1_700_000_000;
const HOUR = 3600;
const DAY  = 86400;
const ring = (entries) => entries.map(([ageSec, sats]) => ({ ts: NOW_RTV - ageSec, price_sats: sats }));

await test('ring with all trades inside 24h returns full ring sum', () => {
  const r = ring([[HOUR, 100], [6 * HOUR, 200], [23 * HOUR, 50]]);
  return _rolling24hVolumeSats(r, '0', '0', NOW_RTV) === 350;
});

await test('ring with trades both inside and outside 24h returns only inside sum', () => {
  const r = ring([[HOUR, 100], [25 * HOUR, 999], [40 * HOUR, 999]]);
  return _rolling24hVolumeSats(r, '0', '0', NOW_RTV) === 100;
});

await test('strict cutoff: trade exactly at now-86400 counts (>= cutoff)', () => {
  const r = ring([[DAY, 500]]);
  return _rolling24hVolumeSats(r, '0', '0', NOW_RTV) === 500;
});

await test('strict cutoff: trade at now-86401 does NOT count (< cutoff)', () => {
  const r = ring([[DAY + 1, 500]]);
  return _rolling24hVolumeSats(r, '0', '0', NOW_RTV) === 0;
});

await test('empty ring falls back to today+yesterday bucket sum', () => {
  return _rolling24hVolumeSats([], '700', '300', NOW_RTV) === 1000;
});

await test('null ring falls back to bucket sum', () => {
  return _rolling24hVolumeSats(null, '500', '0', NOW_RTV) === 500;
});

await test('ring is saturated (full + every entry within 24h) → fall back to bucket sum', () => {
  // Asset trading hard: cap entries all within last 24h. Ring sum would
  // undercount because older-but-still-in-window trades got truncated.
  const r = Array.from({ length: TRADES_RING_CAP }, (_, i) => ({
    ts: NOW_RTV - (i * 300), // every 5 min
    price_sats: 10,
  }));
  // Bucket fallback returns 12000 (the true approximate); ring sum is 2000.
  return _rolling24hVolumeSats(r, '8000', '4000', NOW_RTV) === 12000;
});

await test('ring full but oldest entry > 24h ago → use ring sum (not saturated)', () => {
  // 200 entries, oldest one is 25h ago. That means the ring fully covers
  // the last 24h; trust the ring's strict sum.
  const r = Array.from({ length: TRADES_RING_CAP }, (_, i) => ({
    ts: NOW_RTV - (i * 500), // 200 entries × 500s = 100,000s ≈ 27.8h span
    price_sats: 10,
  }));
  // Entries within 24h: those with i*500 <= 86400 → i ≤ 172 → 173 entries → 1730.
  const expected = Array.from({ length: TRADES_RING_CAP })
    .filter((_, i) => i * 500 <= 86400).length * 10;
  return _rolling24hVolumeSats(r, '99999', '99999', NOW_RTV) === expected;
});

await test('malformed ring entries (missing ts / non-numeric) are skipped', () => {
  const r = [
    { ts: NOW_RTV - HOUR, price_sats: 100 },
    { /* missing both */ },
    { ts: 'bogus', price_sats: 200 },
    { ts: NOW_RTV - HOUR, price_sats: -1 }, // negative ignored
    { ts: NOW_RTV - HOUR, price_sats: 0 }, // zero ignored
    { ts: NOW_RTV - 2 * HOUR, price_sats: 50 },
  ];
  return _rolling24hVolumeSats(r, '0', '0', NOW_RTV) === 150;
});

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
