// SPEC §5.8 / §5.9 — permissionless mint (T_PETCH / T_PMINT) end-to-end
// simulation against the worker's actual cap-counting logic.
//
// What this validates that other tests don't:
//   - Confirmation-depth gate (≥3 default) correctly partitions tip-state
//     mints (pending) from credited ones.
//   - Canonical chain ordering (lexicographic by zero-padded height in the
//     KV key) — equivalent to (height, txid) order — produces deterministic
//     cap-overflow decisions when N mints would exceed the cap.
//   - Cap-overflow loser is the canonically-later mint, not an earlier one.
//   - Reorg simulation: removing a credited mint from the KV stub and
//     re-running loadCanonicalPmints promotes the next-eligible mint into
//     the freed slot (covers the SPEC §10 *T_PMINT reorg sensitivity* path).
//   - Worker-side cumulative_minted matches dapp-side (count × mint_limit).
//   - A wrong tip → "unknown_depth" status (worker degrades gracefully when
//     mempool.space is unreachable).
//
// Run: `node petch-pmint.test.mjs`

import {
  decodeCPetchPayload, decodeCPmintPayload,
  T_PETCH, T_PMINT,
  PMINT_CONFIRMATION_DEPTH, loadCanonicalPmints,
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

// In-memory KV stub matching the worker's REGISTRY_KV interface surface
// loadCanonicalPmints actually uses: list({ prefix, limit }) returning
// { keys: [{ name }] } and get(name, 'json') returning the parsed value.
// This is the smallest shim that lets us test the real production logic
// without bringing up Cloudflare's miniflare runtime.
function makeKvStub(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    _data: data,
    async list({ prefix, limit = 1000 }) {
      const keys = [];
      // Lex-sort matches the production KV.list contract; consumers depend
      // on this for canonical chain ordering when keys embed zero-padded
      // height (see pmintKeyFor in worker/src/index.js).
      const sorted = Array.from(data.keys()).filter(k => k.startsWith(prefix)).sort();
      for (const k of sorted.slice(0, limit)) keys.push({ name: k });
      return { keys };
    },
    async get(key, type) {
      const v = data.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    set(key, jsonValue) { data.set(key, JSON.stringify(jsonValue)); },
    delete(key) { data.delete(key); },
  };
}

const ASSET = 'a'.repeat(64);
// Build a synthetic pmint event matching the cron's record shape (see the
// T_PMINT branch in scanRecentBlocks). Key embeds zero-padded
// (height, tx_index, txid) — SPEC §5.9 *Cap-overflow ordering* mandates
// (height, tx_index) as the canonical sort. txid is a tiebreaker only used
// if a malformed indexer somehow produces duplicate (height, tx_index).
// signet uses the un-namespaced legacy prefix `pmint:{aid}:`.
const pmintKey = (aid, height, txIndex, txid) =>
  `pmint:${aid}:${String(height).padStart(10, '0')}:${String(txIndex).padStart(6, '0')}:${txid}`;
const mintEvent = (height, txIndex, txid) => ({
  asset_id: ASSET,
  etch_txid: 'e'.repeat(64),
  mint_txid: txid,
  mint_vout: 0,
  tx_index: txIndex,
  commitment: '02' + 'cc'.repeat(32),
  amount: '100',
  blinding: '01' + '00'.repeat(31),
  minted_at_height: height,
  minted_at: 1700000000 + height,
  kind: 'pmint',
  network: 'signet',
});

console.log('SPEC §5.8 / §5.9 — T_PETCH / T_PMINT end-to-end:');

// ---------------------------------------------------------------------------
// CONFIRMATION DEPTH — the depth-≥3 gate is the load-bearing v1 mitigation
// for the reorg-sensitivity issue called out in SPEC §10. Verify the partition.
// ---------------------------------------------------------------------------
await test(`PMINT_CONFIRMATION_DEPTH is the SPEC §5.9 default (3)`, () => {
  return PMINT_CONFIRMATION_DEPTH === 3;
});

await test('mints at depth < 3 surface as "pending"', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  // Tip at 100; mints at heights 98, 99, 100 → depths 2, 1, 0 → all pending.
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 99,  0, 'b'.repeat(64)), mintEvent(99,  0, 'b'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 98,  0, 'c'.repeat(64)), mintEvent(98,  0, 'c'.repeat(64)));
  const r = await loadCanonicalPmints(env, 'signet', ASSET, 100, '1000', '100');
  return r.events.length === 3
    && r.events.every(e => e.status === 'pending')
    && r.cumulative_minted === '0';
});

await test('mints at depth ≥ 3 are credited up to cap', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  // Tip at 200; mints at 100..104 (depths 100..96 — all ≥ 3). Cap = 1000,
  // limit = 100 → 10 mints fit. Five mints all credit.
  for (let i = 0; i < 5; i++) {
    env.REGISTRY_KV.set(pmintKey(ASSET, 100 + i, 0, String.fromCharCode(97 + i).repeat(64)), mintEvent(100 + i, 0, String.fromCharCode(97 + i).repeat(64)));
  }
  const r = await loadCanonicalPmints(env, 'signet', ASSET, 200, '1000', '100');
  return r.events.length === 5
    && r.events.every(e => e.status === 'credited')
    && r.cumulative_minted === '500';
});

await test('mixed pending + credited produces correct cumulative', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  // Tip at 105. Mints at 100, 101, 102, 103, 104 → depths 5, 4, 3, 2, 1.
  // First three credit (depth ≥ 3), last two pending.
  for (let i = 0; i < 5; i++) {
    env.REGISTRY_KV.set(pmintKey(ASSET, 100 + i, 0, String.fromCharCode(97 + i).repeat(64)), mintEvent(100 + i, 0, String.fromCharCode(97 + i).repeat(64)));
  }
  const r = await loadCanonicalPmints(env, 'signet', ASSET, 105, '1000', '100');
  const credited = r.events.filter(e => e.status === 'credited').length;
  const pending = r.events.filter(e => e.status === 'pending').length;
  return credited === 3 && pending === 2 && r.cumulative_minted === '300';
});

// ---------------------------------------------------------------------------
// CAP-OVERFLOW — SPEC §5.9 step 5. Canonically-later mints are rejected once
// the cap is reached; earlier mints keep their credit. Test that the loser
// is in fact the LATER mint, not an arbitrary one.
// ---------------------------------------------------------------------------
await test('cap-overflow rejects canonically-later mints, keeps earlier ones', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  // Cap = 200, limit = 100 → only 2 mints fit. Three mints at depth ≥ 3.
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 101, 0, 'b'.repeat(64)), mintEvent(101, 0, 'b'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 102, 0, 'c'.repeat(64)), mintEvent(102, 0, 'c'.repeat(64)));
  const r = await loadCanonicalPmints(env, 'signet', ASSET, 200, '200', '100');
  // First two (heights 100, 101) credit; third (102) is cap_overflow.
  return r.events.length === 3
    && r.events[0].status === 'credited'
    && r.events[1].status === 'credited'
    && r.events[2].status === 'cap_overflow'
    && r.cumulative_minted === '200';
});

// ---------------------------------------------------------------------------
// SAME-BLOCK ORDERING — SPEC §5.9 *Cap-overflow ordering* mandates
// (height, tx_index), NOT (height, txid). Audit fix #2: the v1 implementation
// embedded txid as the tiebreaker, which differs from block tx-position
// order. The two scenarios below exercise the corrected behavior:
//   1. ascending tx_index with ASCENDING txid → lower-index mint wins
//   2. ascending tx_index with DESCENDING txid → still the lower-INDEX mint
//      wins (this is the assertion that catches the audit bug — pre-fix it
//      would pick by txid lex order and prefer the wrong winner).
// ---------------------------------------------------------------------------
await test('same-block ordering uses tx_index even when txid order disagrees', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  // Two mints in block 100, cap fits one. Tx_index 0 is the canonical
  // earlier tx; tx_index 1 is the later. Cross txid order against tx_index
  // (lower index → higher txid) so a buggy txid-only sort would pick the
  // wrong winner.
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'f'.repeat(64)), mintEvent(100, 0, 'f'.repeat(64))); // earlier in block, higher txid
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 1, '0'.repeat(64)), mintEvent(100, 1, '0'.repeat(64))); // later in block, lower txid
  const r = await loadCanonicalPmints(env, 'signet', ASSET, 200, '100', '100');
  // SPEC §5.9: tx_index = 0 wins, regardless of txid lex order.
  return r.events.length === 2
    && r.events[0].mint_txid === 'f'.repeat(64) && r.events[0].status === 'credited'
    && r.events[1].mint_txid === '0'.repeat(64) && r.events[1].status === 'cap_overflow';
});

await test('same-block ordering preserves tx_index even with same txid prefix', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  // Sanity check the canonical-order semantics by varying tx_index alone
  // across three same-block mints. Cap fits the first two; the third is
  // overflow, regardless of how the txids compare.
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 1, 'b'.repeat(64)), mintEvent(100, 1, 'b'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 2, 'c'.repeat(64)), mintEvent(100, 2, 'c'.repeat(64)));
  const r = await loadCanonicalPmints(env, 'signet', ASSET, 200, '200', '100');
  return r.events[0].tx_index === 0 && r.events[0].status === 'credited'
      && r.events[1].tx_index === 1 && r.events[1].status === 'credited'
      && r.events[2].tx_index === 2 && r.events[2].status === 'cap_overflow';
});

// ---------------------------------------------------------------------------
// REORG SIMULATION — SPEC §10 *T_PMINT reorg sensitivity*. Removing a
// credited mint from the KV (simulating reorg-evicted block) must promote
// the next eligible mint into the freed cap slot.
// ---------------------------------------------------------------------------
await test('reorg-evicted credit promotes the next pending mint', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  // Cap = 200, limit = 100 → 2 fit. Three mints at depth ≥ 3.
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 101, 0, 'b'.repeat(64)), mintEvent(101, 0, 'b'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 102, 0, 'c'.repeat(64)), mintEvent(102, 0, 'c'.repeat(64)));
  const before = await loadCanonicalPmints(env, 'signet', ASSET, 200, '200', '100');
  // Initially 'a' and 'b' credit, 'c' is cap_overflow.
  if (before.events[2].status !== 'cap_overflow') return false;
  // Reorg: 'a' is evicted (its block was orphaned). Re-run the cap check.
  env.REGISTRY_KV.delete(pmintKey(ASSET, 100, 0, 'a'.repeat(64)));
  const after = await loadCanonicalPmints(env, 'signet', ASSET, 200, '200', '100');
  // Now 'b' and 'c' credit (only 2 events left, both fit under cap).
  return after.events.length === 2
    && after.events[0].mint_txid === 'b'.repeat(64) && after.events[0].status === 'credited'
    && after.events[1].mint_txid === 'c'.repeat(64) && after.events[1].status === 'credited'
    && after.cumulative_minted === '200';
});

// ---------------------------------------------------------------------------
// TIP UNAVAILABLE — graceful degrade. mempool.space being slow / 522 must
// surface as "unknown_depth" rather than incorrectly crediting tip-state mints.
// ---------------------------------------------------------------------------
await test('tipHeight=null marks every event as unknown_depth (no credit)', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 101, 0, 'b'.repeat(64)), mintEvent(101, 0, 'b'.repeat(64)));
  const r = await loadCanonicalPmints(env, 'signet', ASSET, null, '1000', '100');
  return r.events.every(e => e.status === 'unknown_depth')
    && r.cumulative_minted === '0';
});

// ---------------------------------------------------------------------------
// SHAPE — invariant the dapp's _fetchPmintCredited cache depends on.
// ---------------------------------------------------------------------------
await test('credited events carry mint_txid in canonical hex form', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  const r = await loadCanonicalPmints(env, 'signet', ASSET, 200, '1000', '100');
  return r.events[0].status === 'credited'
    && /^[0-9a-f]{64}$/.test(r.events[0].mint_txid);
});

// ---------------------------------------------------------------------------
// CROSS-MODE GUARDRAIL — SPEC §4 says T_MINT and T_PMINT envelopes are
// non-substitutable. Verify the decoders reject opcode swaps so a forged
// "T_PMINT" claiming a CETCH parent (or vice versa) fails decoding before
// reaching the cap check.
// ---------------------------------------------------------------------------
await test('decodeCPmintPayload rejects payload with T_MINT opcode byte', () => {
  // Build a 138-byte buffer that's structurally valid for T_PMINT EXCEPT for
  // the opcode (T_MINT = 0x24 in place of T_PMINT = 0x28).
  const buf = new Uint8Array(138);
  buf[0] = 0x24;   // wrong opcode
  // Make blinding non-zero so the only failure mode is the opcode mismatch.
  buf[137] = 1;
  return decodeCPmintPayload(buf) === null;
});

await test('decodeCPetchPayload rejects payload with T_CETCH opcode byte', () => {
  // Smallest valid T_PETCH layout (1-char ticker, no image_uri): 30 bytes.
  const buf = new Uint8Array(30);
  buf[0] = 0x21;   // T_CETCH instead of T_PETCH (0x27)
  buf[1] = 1;       // ticker_len
  buf[2] = 0x41;    // 'A'
  // decimals at buf[3] = 0; cap_amount at 4..11 = 0 (would fail cap > 0
  // check); set cap to 100 and limit to 100.
  // amount = 100 LE encoding into bytes 4..11
  const dv = new DataView(buf.buffer);
  dv.setUint32(4, 100, true); dv.setUint32(8, 0, true);   // cap = 100
  dv.setUint32(12, 100, true); dv.setUint32(16, 0, true); // limit = 100
  // start_height (20..23) = 0; end_height (24..27) = 0; img_len (28..29) = 0
  return decodeCPetchPayload(buf) === null;
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
