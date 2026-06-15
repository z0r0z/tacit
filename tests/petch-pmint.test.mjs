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
  refreshPetchProgress, refreshAndStorePetchProgress, readPetchProgress,
  markPetchDirty, petchProgressKey, petchDirtyKey,
  pmintCommitmentOpens, pedersenCommit,
} from '../worker/src/index.js';

// Local hex helper — keeps the test free of a direct noble import so the
// only crypto contract under test is the worker's own pedersenCommit output.
const pointToCompressedHex = p =>
  Array.from(p.toRawBytes(true)).map(b => b.toString(16).padStart(2, '0')).join('');

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
// loadCanonicalPmints + the snapshot helpers actually use: list({ prefix,
// limit, cursor }) returning { keys, list_complete, cursor }, get(name,
// 'json') returning the parsed value, put(name, stringValue, options?) for
// writes, and delete(name). This is the smallest shim that lets us test the
// real production logic without bringing up Cloudflare's miniflare runtime.
function makeKvStub(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    _data: data,
    async list({ prefix, limit = 1000, cursor = null } = {}) {
      // Lex-sort matches the production KV.list contract; consumers depend
      // on this for canonical chain ordering when keys embed zero-padded
      // height (see pmintKeyFor in worker/src/index.js).
      const sorted = Array.from(data.keys()).filter(k => k.startsWith(prefix)).sort();
      const startIdx = cursor ? Number(cursor) : 0;
      const slice = sorted.slice(startIdx, startIdx + limit);
      const nextIdx = startIdx + slice.length;
      const list_complete = nextIdx >= sorted.length;
      return {
        keys: slice.map(name => ({ name })),
        list_complete,
        cursor: list_complete ? null : String(nextIdx),
      };
    },
    async get(key, type) {
      const v = data.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, stringValue /* , options */) { data.set(key, stringValue); },
    set(key, jsonValue) { data.set(key, JSON.stringify(jsonValue)); },
    async delete(key) { data.delete(key); },
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
  // Tip at 100; mints at heights 99, 100, 100 → depths 2, 1, 1 → all pending.
  // Bitcoin convention: a tx in block N has 1 confirmation when tip==N.
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 1, 'b'.repeat(64)), mintEvent(100, 1, 'b'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 99,  0, 'c'.repeat(64)), mintEvent(99,  0, 'c'.repeat(64)));
  const r = await loadCanonicalPmints(env, 'signet', ASSET, 100, '1000', '100');
  return r.events.length === 3
    && r.events.every(e => e.status === 'pending')
    && r.cumulative_minted === '0';
});

await test('mints at depth ≥ 3 are credited up to cap', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  // Tip at 200; mints at 100..104 (depths 101..97 — all ≥ 3). Cap = 1000,
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
  // Tip at 104. Mints at 100, 101, 102, 103, 104 → depths 5, 4, 3, 2, 1.
  // First three credit (depth ≥ 3), last two pending.
  for (let i = 0; i < 5; i++) {
    env.REGISTRY_KV.set(pmintKey(ASSET, 100 + i, 0, String.fromCharCode(97 + i).repeat(64)), mintEvent(100 + i, 0, String.fromCharCode(97 + i).repeat(64)));
  }
  const r = await loadCanonicalPmints(env, 'signet', ASSET, 104, '1000', '100');
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
// REORG RE-CONFIRM DE-DUP — a reorg can re-confirm the same T_PMINT at a new
// (height, tx_index) while the cron's forward-only scan leaves the prior
// canonical key in place. Both keys share one mint_txid. Counting both would
// consume two cap slots for a single on-chain mint, double-counting it toward
// the cap and displacing a legitimate distinct mint into overflow. The
// read-side recompute (the SSOT) must de-dup by txid: one mint, one slot.
// ---------------------------------------------------------------------------
await test('loadCanonicalPmints de-dups a re-confirmed mint (one txid → one cap slot)', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  // Cap = 200, limit = 100 → 2 slots. 'a' appears at TWO canonical positions
  // (100 and 101 — a reorg re-confirm); 'b' is a distinct later mint.
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 101, 0, 'a'.repeat(64)), mintEvent(101, 0, 'a'.repeat(64))); // duplicate txid
  env.REGISTRY_KV.set(pmintKey(ASSET, 102, 0, 'b'.repeat(64)), mintEvent(102, 0, 'b'.repeat(64)));
  const r = await loadCanonicalPmints(env, 'signet', ASSET, 200, '200', '100');
  // Without de-dup: 'a'@100 + 'a'@101 fill the cap (double-count) and 'b'
  // overflows. With de-dup: 'a'@100 credits, 'a'@101 is 'duplicate' (skipped),
  // 'b' credits — cap holds exactly two DISTINCT mints.
  return r.events.length === 3
    && r.events[0].mint_txid === 'a'.repeat(64) && r.events[0].status === 'credited'
    && r.events[1].mint_txid === 'a'.repeat(64) && r.events[1].status === 'duplicate'
    && r.events[2].mint_txid === 'b'.repeat(64) && r.events[2].status === 'credited'
    && r.credited_count === '2'
    && r.cumulative_minted === '200';
});

await test('refreshPetchProgress de-dups a re-confirmed mint (cap snapshot)', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 101, 0, 'a'.repeat(64)), mintEvent(101, 0, 'a'.repeat(64))); // duplicate txid
  env.REGISTRY_KV.set(pmintKey(ASSET, 102, 0, 'b'.repeat(64)), mintEvent(102, 0, 'b'.repeat(64)));
  const snap = await refreshPetchProgress(env, 'signet', ASSET, 200, {
    cap_amount: '200', mint_limit: '100', mint_start_height: 0, mint_end_height: 0, etched_at_height: 99,
  });
  // The duplicate is skipped entirely (not credited, not overflow). The cap
  // holds two distinct mints and the frontier sits at 'b'@102, not 'a'@101.
  return snap.credited_count === 2
    && snap.credited_amount === '200'
    && snap.cap_overflow_count === 0
    && snap.last_credited_height === 102;
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
// PENDING-GUARD — defense for an old worker bug where handleAssetHint wrote
// unconfirmed PMINTs into the canonical pmint:* namespace with
// minted_at_height=null. The pre-fix `Number(null) || 0 = 0` then computed
// depth = tip + 1 and credited those orphans toward the cap. Both the
// `pending: true` flag and a non-integer height must short-circuit the
// depth math.
// ---------------------------------------------------------------------------
await test('pending: true entries are never credited, even at canonically-early position', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  // Stale orphan at height 0 (lex-sorts ahead of every real mint), with the
  // exact shape an old handleAssetHint hint-write produced.
  env.REGISTRY_KV.set(pmintKey(ASSET, 0, 0, 'a'.repeat(64)), {
    ...mintEvent(0, 0, 'a'.repeat(64)),
    minted_at_height: null,
    pending: true,
  });
  // Real confirmed mint at height 100.
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'b'.repeat(64)), mintEvent(100, 0, 'b'.repeat(64)));
  const r = await loadCanonicalPmints(env, 'signet', ASSET, 200, '1000', '100');
  const orphan = r.events.find(e => e.mint_txid === 'a'.repeat(64));
  const real = r.events.find(e => e.mint_txid === 'b'.repeat(64));
  return orphan && orphan.status === 'pending' && orphan.credited === false
    && real && real.status === 'credited' && real.credited === true
    && r.cumulative_minted === '100';
});

await test('non-integer minted_at_height short-circuits depth math', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  env.REGISTRY_KV.set(pmintKey(ASSET, 0, 0, 'a'.repeat(64)), {
    ...mintEvent(0, 0, 'a'.repeat(64)),
    minted_at_height: null,   // no `pending` flag — the height check alone must catch this
  });
  const r = await loadCanonicalPmints(env, 'signet', ASSET, 200, '1000', '100');
  return r.events.length === 1
    && r.events[0].status === 'pending'
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

// ---------------------------------------------------------------------------
// CAP-PROGRESS SNAPSHOT — the O(1) read layer replacing loadCanonicalPmints
// for /petch-assets reads. Validates that the snapshot's aggregate fields
// match loadCanonicalPmints' canonical computation across the same scenarios
// covered above (depth gating, cap-overflow, last_credited tracking).
// ---------------------------------------------------------------------------
const PETCH = {
  asset_id: ASSET,
  ticker: 'FAIR',
  decimals: 0,
  cap_amount: '1000',
  mint_limit: '100',
  mint_start_height: 0,
  mint_end_height: 0,
  etched_at_height: 50,
};

await test('snapshot: empty asset yields zero counts + scan-complete', async () => {
  // Under the tightened bootstrapped semantic (issue #31), an empty asset
  // with an open mint window and an unmet cap is NOT bootstrapped — the cap
  // counter can still change with the next block. Only snapshot_scan_complete
  // is true (the KV scan itself terminated cleanly).
  const env = { REGISTRY_KV: makeKvStub() };
  const snap = await refreshPetchProgress(env, 'signet', ASSET, 200, PETCH);
  return snap.credited_count === 0
    && snap.credited_amount === '0'
    && snap.cap_overflow_count === 0
    && snap.canonical_count === 0
    && snap.last_credited_height === null
    && snap.last_credited_tx_index === null
    && snap.last_credited_txid === null
    && snap.snapshot_scan_complete === true
    && snap.bootstrapped === false
    && snap.cap_counter_final === false
    && snap.truncated === false
    && snap.schema_version === 1;
});

await test('snapshot: null tip refuses to refresh (returns null)', async () => {
  // SPEC §5.9 depth-3 credit gate needs a tip. Without it, refreshing would
  // either over-credit (count every confirmed mint regardless of depth) or
  // silently misclassify. Better to keep the existing snapshot.
  const env = { REGISTRY_KV: makeKvStub() };
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  const r = await refreshPetchProgress(env, 'signet', ASSET, null, PETCH);
  return r === null;
});

await test('snapshot: null petch metadata refuses to refresh (returns null)', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  const r = await refreshPetchProgress(env, 'signet', ASSET, 200, null);
  return r === null;
});

await test('snapshot: mixed pending/credited matches loadCanonicalPmints', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  // Tip 104; mints at 100..104; first 3 credit, last 2 pending. Same as the
  // earlier "mixed pending + credited" loadCanonicalPmints test.
  for (let i = 0; i < 5; i++) {
    env.REGISTRY_KV.set(pmintKey(ASSET, 100 + i, 0, String.fromCharCode(97 + i).repeat(64)),
                         mintEvent(100 + i, 0, String.fromCharCode(97 + i).repeat(64)));
  }
  const lc = await loadCanonicalPmints(env, 'signet', ASSET, 104, '1000', '100');
  const snap = await refreshPetchProgress(env, 'signet', ASSET, 104, PETCH);
  return snap.credited_count === 3
    && snap.credited_amount === lc.cumulative_minted
    && snap.pending_count === 2
    && snap.canonical_count === 5
    && snap.last_credited_height === 102
    && snap.last_credited_tx_index === 0
    && snap.last_credited_txid === 'c'.repeat(64);
});

await test('snapshot: cap-overflow recorded with txid + count', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  // Cap 200, limit 100 → only 2 mints fit. Third is overflow.
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 101, 0, 'b'.repeat(64)), mintEvent(101, 0, 'b'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 102, 0, 'c'.repeat(64)), mintEvent(102, 0, 'c'.repeat(64)));
  const tinyPetch = { ...PETCH, cap_amount: '200' };
  const snap = await refreshPetchProgress(env, 'signet', ASSET, 200, tinyPetch);
  return snap.credited_count === 2
    && snap.credited_amount === '200'
    && snap.cap_overflow_count === 1
    && Array.isArray(snap.cap_overflow_txids)
    && snap.cap_overflow_txids.length === 1
    && snap.cap_overflow_txids[0] === 'c'.repeat(64)
    && snap.last_credited_height === 101
    && snap.last_credited_txid === 'b'.repeat(64);
});

await test('snapshot: refreshAndStorePetchProgress persists under petchProgressKey', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  const snap = await refreshAndStorePetchProgress(env, 'signet', ASSET, 200, PETCH);
  const stored = await readPetchProgress(env, 'signet', ASSET);
  // Stored snapshot must round-trip identically through KV.
  return snap.credited_count === 1
    && stored !== null
    && stored.credited_count === 1
    && stored.credited_amount === '100'
    && stored.schema_version === 1
    && stored.last_credited_txid === 'a'.repeat(64);
});

await test('snapshot: readPetchProgress returns null for missing snapshot', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  const r = await readPetchProgress(env, 'signet', ASSET);
  return r === null;
});

await test('snapshot: readPetchProgress rejects wrong schema_version', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  // Simulate a legacy v0 snapshot (no schema_version) being read by current code.
  await env.REGISTRY_KV.put(petchProgressKey('signet', ASSET),
    JSON.stringify({ credited_count: 99, schema_version: 0 }));
  const r = await readPetchProgress(env, 'signet', ASSET);
  // Must reject — otherwise old fields would surface and break new consumers.
  return r === null;
});


await test('snapshot: markPetchDirty writes dirty marker under petchDirtyKey', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  await markPetchDirty(env, 'signet', ASSET);
  const v = env.REGISTRY_KV._data.get(petchDirtyKey('signet', ASSET));
  return v === '1';
});

await test('snapshot: orphan entries excluded from credited count', async () => {
  const env = { REGISTRY_KV: makeKvStub() };
  // Legacy height-0 orphan; a real canonical entry at height 100 with depth ≥ 3.
  env.REGISTRY_KV.set(pmintKey(ASSET, 0,   0, 'o'.repeat(64)), mintEvent(0,   0, 'o'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  const snap = await refreshPetchProgress(env, 'signet', ASSET, 200, PETCH);
  // Orphan must NOT credit (it's pending forever until promoter fixes it).
  // Canonical entry credits at depth ≥ 3.
  return snap.credited_count === 1
    && snap.credited_amount === '100'
    && snap.orphan_count === 1
    && snap.last_credited_txid === 'a'.repeat(64);
});

await test('snapshot: last_credited advances past cap_overflow gaps', async () => {
  // Cap-overflow doesn't advance last_credited_* — the next-credited mint
  // does. SPEC §5.9 *Cap-overflow ordering*: overflow mints occupy a
  // canonical slot but don't get credit, so position-based lookups must
  // treat them as gaps rather than as the new frontier.
  const env = { REGISTRY_KV: makeKvStub() };
  // Cap 200 + limit 100 in this PETCH. Sequence: credit, credit (cap full),
  // overflow at height 102. last_credited should be (101, 0, 'b...').
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 101, 0, 'b'.repeat(64)), mintEvent(101, 0, 'b'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 102, 0, 'c'.repeat(64)), mintEvent(102, 0, 'c'.repeat(64)));
  const tinyPetch = { ...PETCH, cap_amount: '200' };
  const snap = await refreshPetchProgress(env, 'signet', ASSET, 200, tinyPetch);
  return snap.last_credited_height === 101
    && snap.last_credited_txid === 'b'.repeat(64)
    && snap.cap_overflow_count === 1;
});

// ---------------------------------------------------------------------------
// COMMITMENT OPENING — SPEC §5.9 step 5. T_PMINT envelopes ship public
// (amount, blinding) so any indexer can verify pedersenCommit(amount, blinding)
// equals the declared commitment. Issue #31 Problem #3: the cron + hint paths
// previously skipped this check, so structurally-valid envelopes with forged
// commitments would land in canonical KV and credit toward the cap. The dapp
// always re-checked client-side, so a worker that skipped it was silently more
// permissive than every wallet.
// ---------------------------------------------------------------------------
await test('pmintCommitmentOpens accepts a matching (amount, blinding) opening', () => {
  const amount = 100n;
  const blinding = 1n + (1n << 200n);   // non-trivial, comfortably below curve order
  const C = pedersenCommit(amount, blinding);
  const commitmentHex = pointToCompressedHex(C);
  const blindingHex = blinding.toString(16).padStart(64, '0');
  return pmintCommitmentOpens('100', blindingHex, commitmentHex) === true;
});

await test('pmintCommitmentOpens rejects a mismatched amount', () => {
  // Build a valid (amount, blinding, C) tuple, then flip the amount. The
  // commitment no longer opens to the new amount — gate must reject.
  const blinding = 7n;
  const C = pedersenCommit(100n, blinding);
  const commitmentHex = pointToCompressedHex(C);
  const blindingHex = blinding.toString(16).padStart(64, '0');
  return pmintCommitmentOpens('200', blindingHex, commitmentHex) === false;
});

await test('pmintCommitmentOpens rejects a mismatched blinding', () => {
  const C = pedersenCommit(100n, 7n);
  const commitmentHex = pointToCompressedHex(C);
  const wrongBlinding = '08' + '00'.repeat(31);
  return pmintCommitmentOpens('100', wrongBlinding, commitmentHex) === false;
});

await test('pmintCommitmentOpens rejects a malformed compressed point', () => {
  // 33-byte hex with a non-curve x coordinate. compressedPointFromHex throws,
  // which the helper must swallow into a false return rather than propagating.
  const malformed = '02' + 'ff'.repeat(32);   // not a valid x for secp256k1
  return pmintCommitmentOpens('100', '07' + '00'.repeat(31), malformed) === false;
});

await test('pmintCommitmentOpens rejects an uncompressed point prefix', () => {
  // 0x04 prefix would be uncompressed (65-byte form). The strict 33-byte parser
  // rejects anything that isn't 02/03 prefix + 32-byte x.
  const wrongPrefix = '04' + 'aa'.repeat(32);
  return pmintCommitmentOpens('100', '07' + '00'.repeat(31), wrongPrefix) === false;
});

await test('pmintCommitmentOpens rejects oversized / undersized hex', () => {
  // 32 bytes (too short) and 34 bytes (too long) must both reject without throwing.
  const tooShort = '02' + 'aa'.repeat(31);
  const tooLong  = '02' + 'aa'.repeat(33);
  return pmintCommitmentOpens('100', '07' + '00'.repeat(31), tooShort) === false
      && pmintCommitmentOpens('100', '07' + '00'.repeat(31), tooLong) === false;
});

// ---------------------------------------------------------------------------
// BOOTSTRAPPED SEMANTIC — issue #31 acceptance criterion #3. `bootstrapped`
// now means "cap counter is authoritative", not just "scan completed".
// Sufficient conditions: capFull OR window-closed at tip.
// ---------------------------------------------------------------------------
await test('snapshot: capFull asset is bootstrapped=true', async () => {
  // Cap = 200, limit = 100 → 2 mints fill the cap exactly. Both credit at
  // depth ≥ 3. credited_amount === cap_amount triggers bootstrapped.
  const env = { REGISTRY_KV: makeKvStub() };
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  env.REGISTRY_KV.set(pmintKey(ASSET, 101, 0, 'b'.repeat(64)), mintEvent(101, 0, 'b'.repeat(64)));
  const fullPetch = { ...PETCH, cap_amount: '200' };
  const snap = await refreshPetchProgress(env, 'signet', ASSET, 200, fullPetch);
  return snap.credited_amount === '200'
    && snap.cap_counter_final === true
    && snap.bootstrapped === true;
});

await test('snapshot: window-closed asset is bootstrapped=true even if cap not full', async () => {
  // mint_end_height=150, tip=200 > 150+3 → window closed, no future pmint can
  // be valid → cap counter can no longer change → bootstrapped.
  const env = { REGISTRY_KV: makeKvStub() };
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  const closedPetch = { ...PETCH, cap_amount: '10000', mint_end_height: 150 };
  const snap = await refreshPetchProgress(env, 'signet', ASSET, 200, closedPetch);
  return snap.credited_amount === '100'    // far short of cap
    && snap.cap_counter_final === true
    && snap.bootstrapped === true;
});

await test('snapshot: open-window mid-mint asset is bootstrapped=false', async () => {
  // The FAIR-shape scenario — cap not yet filled, mint_end_height=0 (open).
  // Even though the scan completed cleanly, the counter is NOT authoritative
  // because the next block can credit more mints. Issue #31 motivating case.
  const env = { REGISTRY_KV: makeKvStub() };
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  const snap = await refreshPetchProgress(env, 'signet', ASSET, 200, PETCH);
  return snap.credited_amount === '100'
    && snap.snapshot_scan_complete === true   // scan itself worked
    && snap.cap_counter_final === false
    && snap.bootstrapped === false;
});

await test('snapshot: window-closed but tip too shallow stays bootstrapped=false', async () => {
  // tip = mint_end_height + 1 — the SPEC §5.9 confirmation-depth gate (3) means
  // a pmint mined AT the end height isn't yet considered final until tip
  // advances past end+confDepth. Helper guards against premature finality.
  const env = { REGISTRY_KV: makeKvStub() };
  env.REGISTRY_KV.set(pmintKey(ASSET, 100, 0, 'a'.repeat(64)), mintEvent(100, 0, 'a'.repeat(64)));
  const closedPetch = { ...PETCH, cap_amount: '10000', mint_end_height: 150 };
  const snap = await refreshPetchProgress(env, 'signet', ASSET, 151, closedPetch);
  return snap.cap_counter_final === false
    && snap.bootstrapped === false;
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
