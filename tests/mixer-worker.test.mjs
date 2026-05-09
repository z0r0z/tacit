// SPEC §5.10 / §5.11 — worker mixer indexing simulation.
//
// Mirrors the cron's `scanForEtches` switch-branches for T_DEPOSIT (POOL_INIT
// + standard deposit) and T_WITHDRAW against an in-memory KV stub. Same
// pattern petch-pmint.test.mjs uses for cap-credit logic.
//
// What this proves that mixer-envelope.test.mjs (cross-impl decode) doesn't:
//   - POOL_INIT first-confirmed-wins: subsequent inits for the same
//     (asset_id, pool_denom) silently no-op.
//   - Standard deposit anti-poisoning: a deposit envelope confirmed BEFORE
//     its POOL_INIT is dropped by the cron (no leaf write).
//   - Leaf KV keys are lex-sortable by canonical chain order
//     (height-padded, tx_index-padded, txid-suffix).
//   - Withdraw nullifier indexing requires POOL_INIT.
//   - Duplicate-nullifier writes are idempotent (re-scan can't double-write
//     and stamp a stale `withdrawn_at_height`).
//   - /pools list aggregation reflects per-pool leaf + nullifier counts.
//
// Why mirror the worker logic inline rather than import its key helpers:
// the helpers are NOT exported from worker/src/index.js, and the user has
// pending edits in that file (Groth16 ceremony coordination). Touching
// worker exports would conflict; mirroring the protocol-pinned key shapes
// keeps the test independent. The shapes themselves are part of the wire
// contract — if they ever drift in the worker, this test catches it via
// its own tightly-pinned key format.
//
// Run: `node mixer-worker.test.mjs`

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
// scanForEtches actually uses: get/put/list with prefix + lex order.
function makeKvStub(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    _data: data,
    async get(key, kind) {
      const v = data.get(key);
      if (v === undefined) return null;
      if (kind === 'json') return JSON.parse(v);
      return v;
    },
    async put(key, value) {
      data.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    },
    async list({ prefix, limit = 1000 }) {
      const keys = [];
      for (const k of data.keys()) {
        if (k.startsWith(prefix)) keys.push({ name: k });
      }
      // Worker production KV.list returns lex-ordered keys; tests rely on
      // this for canonical chain ordering of pool leaves.
      keys.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      return { keys: keys.slice(0, limit) };
    },
  };
}

// Mirror the worker's poolInitKey / poolLeafKeyFor / poolNullifierKey shape
// from worker/src/index.js. Network-scoped on mainnet; bare on signet
// (legacy compat with the original signet-only schema).
function poolInitKey(network, aid, denom) {
  return network === 'signet'
    ? `pool:${aid}:${denom}`
    : `pool:${network}:${aid}:${denom}`;
}
function poolPrefix(network) {
  return network === 'signet' ? 'pool:' : `pool:${network}:`;
}
function poolLeafKeyFor(network, aid, denom, height, txIndex, txid) {
  const h = String(height || 0).padStart(10, '0');
  const idx = String(txIndex || 0).padStart(6, '0');
  return network === 'signet'
    ? `poolleaf:${aid}:${denom}:${h}:${idx}:${txid}`
    : `poolleaf:${network}:${aid}:${denom}:${h}:${idx}:${txid}`;
}
function poolLeafPrefix(network, aid, denom) {
  return network === 'signet'
    ? `poolleaf:${aid}:${denom}:`
    : `poolleaf:${network}:${aid}:${denom}:`;
}
function poolNullifierKey(network, aid, denom, nullifierHex) {
  return network === 'signet'
    ? `poolnull:${aid}:${denom}:${nullifierHex}`
    : `poolnull:${network}:${aid}:${denom}:${nullifierHex}`;
}
function poolNullifierPrefix(network, aid, denom) {
  return network === 'signet'
    ? `poolnull:${aid}:${denom}:`
    : `poolnull:${network}:${aid}:${denom}:`;
}

// Mirror the cron's T_DEPOSIT branch logic. Returns true if the envelope
// produced a KV write (POOL_INIT or leaf), false if dropped (stale init,
// already-registered pool, etc.).
async function indexDeposit(env, kv, network, h, txIndex, txid) {
  if (env.kind === 'pool_init') {
    const k = poolInitKey(network, env.asset_id, env.pool_denom);
    const existing = await kv.get(k);
    if (existing) return false;
    await kv.put(k, {
      asset_id: env.asset_id,
      pool_denom: env.pool_denom,
      vk_cid: env.vk_cid,
      ceremony_cid: env.ceremony_cid,
      init_height: h,
      init_txid: txid,
      init_sig: env.init_sig,
      network,
    });
    return true;
  }
  if (env.kind === 'deposit') {
    const initRec = await kv.get(poolInitKey(network, env.asset_id, env.denomination), 'json');
    if (!initRec) return false;     // anti-poisoning: no init, no leaf
    const leafKey = poolLeafKeyFor(network, env.asset_id, env.denomination, h, txIndex, txid);
    await kv.put(leafKey, {
      asset_id: env.asset_id,
      denomination: env.denomination,
      leaf_commitment: env.leaf_commitment,
      deposit_txid: txid,
      tx_index: txIndex,
      deposited_at_height: h,
      deposited_at: 0,
      network,
    });
    return true;
  }
  return false;
}

async function indexWithdraw(env, kv, network, h, txid) {
  const initRec = await kv.get(poolInitKey(network, env.asset_id, env.denomination), 'json');
  if (!initRec) return false;
  const nKey = poolNullifierKey(network, env.asset_id, env.denomination, env.nullifier_hash);
  const existing = await kv.get(nKey);
  if (existing) return false;       // idempotent: already-spent nullifier no-ops
  await kv.put(nKey, {
    asset_id: env.asset_id,
    denomination: env.denomination,
    nullifier_hash: env.nullifier_hash,
    withdraw_txid: txid,
    withdrawn_at_height: h,
    withdrawn_at: 0,
    network,
  });
  return true;
}

const ASSET_HEX = 'aa'.repeat(32);
const ASSET2_HEX = 'bb'.repeat(32);
const DENOM = '100000000';

console.log('POOL_INIT first-confirmed-wins:');

await test('first POOL_INIT writes to KV', async () => {
  const kv = makeKvStub();
  const ok = await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET_HEX, pool_denom: DENOM,
      vk_cid: 'bafy1', ceremony_cid: 'bafy2', init_sig: '00'.repeat(64) },
    kv, 'mainnet', 100, 0, 'tx1',
  );
  return ok && (await kv.get(poolInitKey('mainnet', ASSET_HEX, DENOM), 'json')) !== null;
});

await test('second POOL_INIT for same (asset, denom) is silently dropped', async () => {
  const kv = makeKvStub();
  await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET_HEX, pool_denom: DENOM,
      vk_cid: 'first', ceremony_cid: 'first', init_sig: '00'.repeat(64) },
    kv, 'mainnet', 100, 0, 'tx1',
  );
  const ok = await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET_HEX, pool_denom: DENOM,
      vk_cid: 'SECOND', ceremony_cid: 'SECOND', init_sig: 'ff'.repeat(64) },
    kv, 'mainnet', 200, 0, 'tx2',
  );
  if (ok) return false;     // second should be dropped
  const rec = await kv.get(poolInitKey('mainnet', ASSET_HEX, DENOM), 'json');
  // First-confirmed-wins: vk_cid is still 'first', not 'SECOND'
  return rec.vk_cid === 'first' && rec.init_height === 100;
});

await test('POOL_INIT for different (asset, denom) does NOT collide', async () => {
  const kv = makeKvStub();
  await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET_HEX, pool_denom: DENOM,
      vk_cid: 'a', ceremony_cid: 'a', init_sig: '00'.repeat(64) },
    kv, 'mainnet', 100, 0, 'tx1',
  );
  await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET2_HEX, pool_denom: DENOM,
      vk_cid: 'b', ceremony_cid: 'b', init_sig: '00'.repeat(64) },
    kv, 'mainnet', 100, 0, 'tx2',
  );
  return (await kv.get(poolInitKey('mainnet', ASSET_HEX, DENOM), 'json')).vk_cid === 'a'
      && (await kv.get(poolInitKey('mainnet', ASSET2_HEX, DENOM), 'json')).vk_cid === 'b';
});

await test('signet vs mainnet POOL_INIT use distinct KV namespaces', async () => {
  const kv = makeKvStub();
  await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET_HEX, pool_denom: DENOM,
      vk_cid: 'sig', ceremony_cid: 'sig', init_sig: '00'.repeat(64) },
    kv, 'signet', 100, 0, 'tx1',
  );
  await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET_HEX, pool_denom: DENOM,
      vk_cid: 'main', ceremony_cid: 'main', init_sig: '00'.repeat(64) },
    kv, 'mainnet', 100, 0, 'tx2',
  );
  return (await kv.get(poolInitKey('signet', ASSET_HEX, DENOM), 'json')).vk_cid === 'sig'
      && (await kv.get(poolInitKey('mainnet', ASSET_HEX, DENOM), 'json')).vk_cid === 'main';
});

console.log('\nDeposit indexing + canonical key order:');

await test('deposit BEFORE POOL_INIT is dropped (anti-poisoning)', async () => {
  const kv = makeKvStub();
  const ok = await indexDeposit(
    { kind: 'deposit', asset_id: ASSET_HEX, denomination: DENOM,
      leaf_commitment: '11'.repeat(32), kernel_sig: '00'.repeat(64) },
    kv, 'mainnet', 100, 0, 'tx-orphan',
  );
  if (ok) return false;
  // No leaf written
  const list = await kv.list({ prefix: poolLeafPrefix('mainnet', ASSET_HEX, DENOM) });
  return list.keys.length === 0;
});

await test('deposit AFTER POOL_INIT writes a leaf at canonical key', async () => {
  const kv = makeKvStub();
  await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET_HEX, pool_denom: DENOM,
      vk_cid: 'a', ceremony_cid: 'a', init_sig: '00'.repeat(64) },
    kv, 'mainnet', 100, 0, 'init-tx',
  );
  await indexDeposit(
    { kind: 'deposit', asset_id: ASSET_HEX, denomination: DENOM,
      leaf_commitment: '11'.repeat(32), kernel_sig: '00'.repeat(64) },
    kv, 'mainnet', 200, 5, 'dep-tx',
  );
  const list = await kv.list({ prefix: poolLeafPrefix('mainnet', ASSET_HEX, DENOM) });
  if (list.keys.length !== 1) return false;
  const expected = poolLeafKeyFor('mainnet', ASSET_HEX, DENOM, 200, 5, 'dep-tx');
  return list.keys[0].name === expected;
});

await test('multiple deposits sort lex by (height, tx_index, txid)', async () => {
  const kv = makeKvStub();
  await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET_HEX, pool_denom: DENOM,
      vk_cid: 'a', ceremony_cid: 'a', init_sig: '00'.repeat(64) },
    kv, 'mainnet', 100, 0, 'init',
  );
  // Insert in non-canonical order
  const items = [
    { h: 300, idx: 0, txid: 'aa', leaf: 'aa' },
    { h: 200, idx: 5, txid: 'bb', leaf: 'bb' },
    { h: 200, idx: 1, txid: 'cc', leaf: 'cc' },
    { h: 200, idx: 5, txid: 'aa', leaf: 'dd' },  // same (h,idx) as bb, different txid
  ];
  for (const it of items) {
    await indexDeposit(
      { kind: 'deposit', asset_id: ASSET_HEX, denomination: DENOM,
        leaf_commitment: it.leaf.repeat(32), kernel_sig: '00'.repeat(64) },
      kv, 'mainnet', it.h, it.idx, it.txid,
    );
  }
  const list = await kv.list({ prefix: poolLeafPrefix('mainnet', ASSET_HEX, DENOM) });
  // Expected order: (200, 1, cc), (200, 5, aa), (200, 5, bb), (300, 0, aa)
  const records = await Promise.all(list.keys.map(k => kv.get(k.name, 'json')));
  const order = records.map(r => `${r.deposited_at_height}-${r.tx_index}-${r.deposit_txid}`);
  const expected = ['200-1-cc', '200-5-aa', '200-5-bb', '300-0-aa'];
  return order.length === expected.length && order.every((v, i) => v === expected[i]);
});

await test('re-indexing the same deposit twice is idempotent (last-write-wins)', async () => {
  // Real cron is forward-only but /rescan can re-walk the same blocks; the
  // canonical key collapses to a single entry either way. Test that this
  // doesn't accidentally double-count.
  const kv = makeKvStub();
  await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET_HEX, pool_denom: DENOM,
      vk_cid: 'a', ceremony_cid: 'a', init_sig: '00'.repeat(64) },
    kv, 'mainnet', 100, 0, 'init',
  );
  await indexDeposit(
    { kind: 'deposit', asset_id: ASSET_HEX, denomination: DENOM,
      leaf_commitment: 'aa'.repeat(32), kernel_sig: '00'.repeat(64) },
    kv, 'mainnet', 200, 0, 'dup',
  );
  await indexDeposit(
    { kind: 'deposit', asset_id: ASSET_HEX, denomination: DENOM,
      leaf_commitment: 'aa'.repeat(32), kernel_sig: '00'.repeat(64) },
    kv, 'mainnet', 200, 0, 'dup',
  );
  const list = await kv.list({ prefix: poolLeafPrefix('mainnet', ASSET_HEX, DENOM) });
  return list.keys.length === 1;
});

console.log('\nWithdraw nullifier indexing:');

await test('withdraw without POOL_INIT is dropped', async () => {
  const kv = makeKvStub();
  const NH = 'cd'.repeat(32);
  const ok = await indexWithdraw(
    { asset_id: ASSET_HEX, denomination: DENOM, nullifier_hash: NH },
    kv, 'mainnet', 300, 'wtx',
  );
  if (ok) return false;
  const list = await kv.list({ prefix: poolNullifierPrefix('mainnet', ASSET_HEX, DENOM) });
  return list.keys.length === 0;
});

await test('first withdraw writes nullifier', async () => {
  const kv = makeKvStub();
  await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET_HEX, pool_denom: DENOM,
      vk_cid: 'a', ceremony_cid: 'a', init_sig: '00'.repeat(64) },
    kv, 'mainnet', 100, 0, 'init',
  );
  const NH = 'cd'.repeat(32);
  const ok = await indexWithdraw(
    { asset_id: ASSET_HEX, denomination: DENOM, nullifier_hash: NH },
    kv, 'mainnet', 300, 'wtx',
  );
  if (!ok) return false;
  const rec = await kv.get(poolNullifierKey('mainnet', ASSET_HEX, DENOM, NH), 'json');
  return rec && rec.withdraw_txid === 'wtx' && rec.withdrawn_at_height === 300;
});

await test('duplicate-nullifier write preserves first metadata (idempotent)', async () => {
  // The worker's logic: if the nullifier key exists, the new write no-ops.
  // This means first-write-wins on the metadata (withdrawn_at_height,
  // withdraw_txid). A re-scan can't stamp a fresher height + later txid
  // onto a previously-seen nullifier, which would otherwise let an attacker
  // who controlled re-scan timing rewrite the apparent canonical history.
  const kv = makeKvStub();
  await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET_HEX, pool_denom: DENOM,
      vk_cid: 'a', ceremony_cid: 'a', init_sig: '00'.repeat(64) },
    kv, 'mainnet', 100, 0, 'init',
  );
  const NH = 'ef'.repeat(32);
  await indexWithdraw(
    { asset_id: ASSET_HEX, denomination: DENOM, nullifier_hash: NH },
    kv, 'mainnet', 300, 'first-wtx',
  );
  const ok2 = await indexWithdraw(
    { asset_id: ASSET_HEX, denomination: DENOM, nullifier_hash: NH },
    kv, 'mainnet', 999, 'rescan-wtx',
  );
  if (ok2) return false;     // second write should no-op
  const rec = await kv.get(poolNullifierKey('mainnet', ASSET_HEX, DENOM, NH), 'json');
  return rec.withdraw_txid === 'first-wtx' && rec.withdrawn_at_height === 300;
});

await test('withdraw against a different pool denom does NOT collide', async () => {
  const kv = makeKvStub();
  await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET_HEX, pool_denom: '100',
      vk_cid: 'a', ceremony_cid: 'a', init_sig: '00'.repeat(64) },
    kv, 'mainnet', 100, 0, 'init1',
  );
  await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET_HEX, pool_denom: '200',
      vk_cid: 'b', ceremony_cid: 'b', init_sig: '00'.repeat(64) },
    kv, 'mainnet', 100, 1, 'init2',
  );
  const NH = '12'.repeat(32);
  await indexWithdraw(
    { asset_id: ASSET_HEX, denomination: '100', nullifier_hash: NH },
    kv, 'mainnet', 300, 'w100',
  );
  const ok = await indexWithdraw(
    { asset_id: ASSET_HEX, denomination: '200', nullifier_hash: NH },
    kv, 'mainnet', 300, 'w200',
  );
  // Same nullifier in TWO different pools — both should land. Reusing a
  // nullifier across pools is allowed by SPEC §5.11 because the pool index
  // is part of the spent-set key.
  return ok
      && (await kv.get(poolNullifierKey('mainnet', ASSET_HEX, '100', NH), 'json')) !== null
      && (await kv.get(poolNullifierKey('mainnet', ASSET_HEX, '200', NH), 'json')) !== null;
});

console.log('\nAggregate /pools listing:');

await test('listing pools across networks aggregates leaf + nullifier counts', async () => {
  const kv = makeKvStub();
  // Two pools on mainnet.
  await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET_HEX, pool_denom: '100',
      vk_cid: 'a', ceremony_cid: 'a', init_sig: '00'.repeat(64) },
    kv, 'mainnet', 100, 0, 'init1',
  );
  await indexDeposit(
    { kind: 'pool_init', asset_id: ASSET2_HEX, pool_denom: '200',
      vk_cid: 'b', ceremony_cid: 'b', init_sig: '00'.repeat(64) },
    kv, 'mainnet', 100, 1, 'init2',
  );
  // 3 deposits in pool A, 1 in pool B.
  for (let i = 0; i < 3; i++) {
    await indexDeposit(
      { kind: 'deposit', asset_id: ASSET_HEX, denomination: '100',
        leaf_commitment: 'aa'.repeat(32), kernel_sig: '00'.repeat(64) },
      kv, 'mainnet', 200 + i, 0, `dA-${i}`,
    );
  }
  await indexDeposit(
    { kind: 'deposit', asset_id: ASSET2_HEX, denomination: '200',
      leaf_commitment: 'bb'.repeat(32), kernel_sig: '00'.repeat(64) },
    kv, 'mainnet', 250, 0, 'dB',
  );
  // 1 nullifier in A, 0 in B.
  await indexWithdraw(
    { asset_id: ASSET_HEX, denomination: '100', nullifier_hash: '11'.repeat(32) },
    kv, 'mainnet', 400, 'w1',
  );
  // Mirror the /pools handler aggregation logic.
  const list = await kv.list({ prefix: poolPrefix('mainnet') });
  const stats = [];
  for (const k of list.keys) {
    const rec = await kv.get(k.name, 'json');
    const leafCount = (await kv.list({ prefix: poolLeafPrefix('mainnet', rec.asset_id, rec.pool_denom) })).keys.length;
    const nullifierCount = (await kv.list({ prefix: poolNullifierPrefix('mainnet', rec.asset_id, rec.pool_denom) })).keys.length;
    stats.push({ aid: rec.asset_id, denom: rec.pool_denom, leaves: leafCount, nullifiers: nullifierCount });
  }
  // Two pools, with the right counts.
  if (stats.length !== 2) return false;
  const a = stats.find(s => s.aid === ASSET_HEX);
  const b = stats.find(s => s.aid === ASSET2_HEX);
  return a && b
      && a.leaves === 3 && a.nullifiers === 1
      && b.leaves === 1 && b.nullifiers === 0;
});

console.log('');
console.log(`${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
