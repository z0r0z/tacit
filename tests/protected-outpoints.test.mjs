#!/usr/bin/env node
// cBTC lock reservations must come from the pool, not from this browser (dapp/confidential-deployments.js).
//
// A cBTC lock is a plain spendable P2TR output. Spending it outside a redemption is folded as a rug and
// slashes the escrow with no cure path, so the one thing coin selection must never do is pick one up. A
// registry that lives only in local storage is empty on a second device, in a private window and after a
// cache clear — exactly the sessions where the user has no idea a lock exists. This pins that the set is
// rebuilt from cbtcLockVBtc / cbtcLockSpent / cbtcLockRedeemed, and that a retired lock is released.
//
// Run: node tests/protected-outpoints.test.mjs

import assert from 'node:assert';

// The registry reads local storage lazily, so the stub only has to exist before the first call.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const KEY = 'tacit-protected-outpoints-v1';
const {
  protectOutpoint, unprotectOutpoint, isProtectedOutpoint,
  listProtectedOutpoints, listReservedLocks, reservedLockSats, syncProtectedOutpoints,
} = await import('../dapp/confidential-deployments.js');

let n = 0; const ok = (s) => { n++; console.log('  ok -', s); };
const TXID_A = 'aa'.repeat(32);
const TXID_B = 'bb'.repeat(32);
const TXID_C = 'cc'.repeat(32);

// ── 1. a reservation round-trips through storage, and carries the lock's value ──
{
  protectOutpoint(TXID_A, 1, 25000n);
  assert.ok(isProtectedOutpoint(TXID_A, 1), 'the lock outpoint is reserved');
  assert.ok(!isProtectedOutpoint(TXID_A, 0), 'a different vout of the same tx is not');
  assert.deepStrictEqual(listProtectedOutpoints(), [`${TXID_A}:1`], 'the exclude set is txid:vout strings');
  assert.deepStrictEqual(listReservedLocks(), [{ txid: TXID_A, vout: 1, sats: 25000n }], 'the value rides along for the UI');
  assert.strictEqual(reservedLockSats(), 25000n, 'and totals');
  // Re-registering without a value (the pre-confirmation path) must not erase a value the chain gave us.
  protectOutpoint(TXID_A, 1);
  assert.strictEqual(reservedLockSats(), 25000n, 'a value-less re-registration keeps the known value');
  unprotectOutpoint(TXID_A, 1);
  assert.ok(!isProtectedOutpoint(TXID_A, 1), 'released');
  ok('a reservation persists with its value, and a value-less re-registration does not erase it');
}

// ── 2. a cleared cache is refilled from the pool's own records — the second-device case ──
{
  store.clear();
  assert.deepStrictEqual(listProtectedOutpoints(), [], 'nothing local, as on a device that never saw the lock');
  // Two locks the pool has recorded; one already redeemed, one not a lock at all.
  const chain = {
    [`${TXID_A}:1`]: { vBtc: 25000n, spent: false, redeemed: false },
    [`${TXID_B}:1`]: { vBtc: 90000n, spent: false, redeemed: true },
    [`${TXID_C}:0`]: { vBtc: 0n, spent: false, redeemed: false },
  };
  const lockState = async (txid, vout) => chain[`${txid}:${vout}`] || { vBtc: 0n };
  const r = await syncProtectedOutpoints({
    lockOutputs: [{ txid: TXID_A, vout: 1 }, { txid: TXID_B, vout: 1 }, { txid: TXID_C, vout: 0 }],
    lockState,
  });
  assert.ok(isProtectedOutpoint(TXID_A, 1), 'the live lock is reserved with no help from local storage');
  assert.ok(!isProtectedOutpoint(TXID_B, 1), 'a redeemed lock is not reserved');
  assert.ok(!isProtectedOutpoint(TXID_C, 0), 'an ordinary output the pool has no record of is left spendable');
  assert.strictEqual(reservedLockSats(), 25000n, 'the reserved total is the chain’s value');
  assert.deepStrictEqual(r.reserved.map((x) => x.txid), [TXID_A], 'the sync reports what it reserved');
  assert.deepStrictEqual(r.released.map((x) => x.txid), [TXID_B], 'and what it released');
  ok('the reserved set is rebuilt from cbtcLockVBtc / cbtcLockSpent / cbtcLockRedeemed alone');
}

// ── 3. redemption is what unreserves — no separate client hand-off to miss ──
{
  const chain = { [`${TXID_A}:1`]: { vBtc: 25000n, spent: false, redeemed: false } };
  const lockState = async (txid, vout) => chain[`${txid}:${vout}`] || { vBtc: 0n };
  const outs = [{ txid: TXID_A, vout: 1 }];
  await syncProtectedOutpoints({ lockOutputs: outs, lockState });
  assert.ok(isProtectedOutpoint(TXID_A, 1), 'reserved while live');
  chain[`${TXID_A}:1`].redeemed = true;
  await syncProtectedOutpoints({ lockOutputs: outs, lockState });
  assert.ok(!isProtectedOutpoint(TXID_A, 1), 'a redeemed lock stops being reserved forever');
  // A lock the chain reports as already spent is equally retired — reserving it protects nothing.
  chain[`${TXID_A}:1`].redeemed = false; chain[`${TXID_A}:1`].spent = true;
  protectOutpoint(TXID_A, 1, 25000n);
  await syncProtectedOutpoints({ lockOutputs: outs, lockState });
  assert.ok(!isProtectedOutpoint(TXID_A, 1), 'an already-spent lock is released too');
  await assert.rejects(() => syncProtectedOutpoints({ lockOutputs: outs }), /needs lockState/, 'refuses to sync without a chain reader');
  ok('a redeemed or already-spent lock is released by the same chain read that reserves a live one');
}

// ── 4. a set written by an older build still loads ──
{
  store.clear();
  store.set(KEY, JSON.stringify([`${TXID_A}:1`]));
  // The module caches the parsed set, so re-import it fresh to read what storage holds.
  const m = await import(`../dapp/confidential-deployments.js?legacy=${Date.now()}`);
  assert.ok(m.isProtectedOutpoint(TXID_A, 1), 'a bare array of keys is still a reserved set');
  assert.strictEqual(m.reservedLockSats(), 0n, 'with no value until the chain supplies one');
  ok('a reservation set written before locks carried their value still loads');
}

console.log(`\n${n}/4 protected-outpoint checks passed`);
