// SPEC §5.10 / §5.11.4 invariant 1 — Conservation, pool-reserve floor.
//
// The reserve `(# included leaves − # spent nullifiers)` is a hard floor: an
// indexer MUST refuse a T_WITHDRAW whose acceptance would drive it negative.
// One deposit appends one leaf, one withdraw burns one note, so on an honest
// pool the reserve never goes negative — only a forged proof (a retained
// per-pool ceremony trapdoor) can produce that. The floor bounds such a
// forgery to the pool's real deposits (Tornado's blast radius) instead of
// letting it mint unbounded supply.
//
// The dapp's T_WITHDRAW validator enforces this via mixerReserveWouldBreach,
// after the Groth16 + Pedersen + bind_hash + recent-root checks. Those upper
// gates need real proof fixtures to drive; the reserve decision itself is a
// pure function of pool state (leaf count, spent-nullifier set), so this file
// exercises it directly through the exported helper — the same call the
// validator makes.
//
// What this validates:
//   - empty pool rejects any withdraw (0 leaves → reserve floor at 0)
//   - the k-th distinct withdraw is allowed iff k ≤ leaf_count (boundary)
//   - the (leaf_count + 1)-th distinct withdraw is rejected
//   - re-validating an already-spent nullifier passes (idempotent — the
//     genuine final withdraw, mirrored by scanPools, must still credit)
//   - the floor is per-pool (marking nullifiers in pool A never gates pool B)
//
// Note on the canonicalLeafCount branch: mixerReserveWouldBreach takes the
// LARGER of the locally-applied tree size and the worker's authoritative
// included-leaf count. poolMerkleTrees is module-private (no write-backdoor),
// so this file drives the leaves.length path via mixerAppendLeaf. The
// canonicalLeafCount term can only ever RELAX the bound (Math.max), so it
// cannot introduce a false-reject the leaves path doesn't already cover — its
// sole purpose is to keep a transient scanPools leaf-apply lag from locking a
// live withdraw.
//
// Run: `node mixer-reserve-floor.test.mjs`

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;

import { bytesToHex } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');

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

let _aidCounter = 0;
function nextAid() {
  _aidCounter++;
  return bytesToHex(new Uint8Array(32).fill(_aidCounter & 0xff));
}
let _nullCounter = 0;
function nextNullifier() {
  _nullCounter++;
  const b = new Uint8Array(32);
  new DataView(b.buffer).setUint32(28, _nullCounter, false);
  return b;
}
function leafBytes(seed) {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (seed * 17 + i * 7) & 0xff;
  return out;
}
// Mark a nullifier spent and return its hex (the form the validator/helper use).
function spend(aidHex, denom, owner) {
  const n = nextNullifier();
  dapp.mixerMarkNullifierSpent(aidHex, denom, n, owner);
  return bytesToHex(n);
}

console.log('Pool-reserve floor (SPEC §5.11.4 invariant 1, Conservation):');

await test('empty pool: any withdraw would breach (reserve floor at 0)', () => {
  const aidHex = nextAid();
  const denom = 100n;
  dapp.mixerRegisterPool(aidHex, denom, new Uint8Array(8), new Uint8Array(8), 0, 'a'.repeat(64));
  // 0 leaves, 0 spent → projected 1 > 0 → breach.
  return dapp.mixerReserveWouldBreach(aidHex, denom, bytesToHex(nextNullifier())) === true;
});

await test('k-th distinct withdraw allowed iff k ≤ leaf_count (boundary)', () => {
  const aidHex = nextAid();
  const denom = 100n;
  dapp.mixerRegisterPool(aidHex, denom, new Uint8Array(8), new Uint8Array(8), 0, 'b'.repeat(64));
  for (let i = 1; i <= 3; i++) dapp.mixerAppendLeaf(aidHex, denom, leafBytes(i)); // 3 leaves
  spend(aidHex, denom, 'aa'.repeat(32)); // 1st withdraw
  spend(aidHex, denom, 'bb'.repeat(32)); // 2nd withdraw — spent = 2, leaves = 3
  // 3rd distinct withdraw: projected 3, leaves 3 → 3 > 3 is false → allowed.
  return dapp.mixerReserveWouldBreach(aidHex, denom, bytesToHex(nextNullifier())) === false;
});

await test('(leaf_count + 1)-th distinct withdraw is rejected', () => {
  const aidHex = nextAid();
  const denom = 100n;
  dapp.mixerRegisterPool(aidHex, denom, new Uint8Array(8), new Uint8Array(8), 0, 'c'.repeat(64));
  for (let i = 1; i <= 3; i++) dapp.mixerAppendLeaf(aidHex, denom, leafBytes(i)); // 3 leaves
  spend(aidHex, denom, 'aa'.repeat(32));
  spend(aidHex, denom, 'bb'.repeat(32));
  spend(aidHex, denom, 'cc'.repeat(32)); // spent = 3 = leaves (pool fully drained)
  // 4th distinct withdraw: projected 4 > 3 → breach. This is the forged-proof
  // case the floor exists to reject.
  return dapp.mixerReserveWouldBreach(aidHex, denom, bytesToHex(nextNullifier())) === true;
});

await test('re-validating an already-spent nullifier passes (idempotent)', () => {
  const aidHex = nextAid();
  const denom = 100n;
  dapp.mixerRegisterPool(aidHex, denom, new Uint8Array(8), new Uint8Array(8), 0, 'd'.repeat(64));
  dapp.mixerAppendLeaf(aidHex, denom, leafBytes(1)); // 1 leaf
  const nHex = spend(aidHex, denom, 'dd'.repeat(32)); // the pool's single (final) withdraw
  // Pool now fully drained (1 leaf, 1 spent). scanPools mirrored this nullifier,
  // so validateOutpoint re-validates the user's OWN final withdraw. It must
  // still pass: the nullifier is already counted, projected = 1, not > 1.
  return dapp.mixerReserveWouldBreach(aidHex, denom, nHex) === false;
});

await test('floor is per-pool (pool A spends do not gate pool B)', () => {
  const aidA = nextAid();
  const aidB = nextAid();
  const denom = 100n;
  dapp.mixerRegisterPool(aidA, denom, new Uint8Array(8), new Uint8Array(8), 0, 'e'.repeat(64));
  dapp.mixerRegisterPool(aidB, denom, new Uint8Array(8), new Uint8Array(8), 0, 'f'.repeat(64));
  dapp.mixerAppendLeaf(aidB, denom, leafBytes(1)); // pool B: 1 leaf, 0 spent
  // Drain pool A hard (0 leaves, several spends).
  spend(aidA, denom, '11'.repeat(32));
  spend(aidA, denom, '22'.repeat(32));
  // Pool B still has reserve for its single withdraw — A's state is isolated.
  return dapp.mixerReserveWouldBreach(aidB, denom, bytesToHex(nextNullifier())) === false &&
         dapp.mixerReserveWouldBreach(aidA, denom, bytesToHex(nextNullifier())) === true;
});

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
