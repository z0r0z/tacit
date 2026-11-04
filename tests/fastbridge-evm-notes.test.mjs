// The pool adapter's choice of the note a lock is made from (dapp/fastbridge-evm.js lockOp): a swap that builds its lock again after the
// relay lost or failed the first try uses the first try's note, so the two cannot both land as two locks of one swap; a swap that
// ends without a lock gives its note back; another swap is never given a note a swap holds.
//   node tests/fastbridge-evm-notes.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { secp, keccak_256, hmac, sha256 } from '../dapp/vendor/tacit-deps.min.js';
import { makeFastBridgeEvm } from '../dapp/fastbridge-evm.js';

const ASSET = 'ab'.repeat(32);
const note = (n, value = '1000') => ({ leaf: '0x' + String(n).padStart(64, '0'), value, root: '0x00', cx: '0x01', cy: '0x02', owner: '0x03', blinding: '0x04', leafIndex: n, path: [], secret: '0x05' });
function adapter(held) {
  const built = [];
  const ux = {
    pool: { leaf: (a, x, y, o) => '0x' + String(x).padStart(64, '0'), nullifier: (l) => l },
    rpc: async () => null, identity: () => ({ pubHex: '03' }), chainBindingHex: () => '0x00',
    balance: async () => ({ byAsset: { ['0x' + ASSET]: { notes: held.notes } } }),
  };
  const adaptor = { buildAdaptorLock: (a) => { built.push(a); return { lockLeaf: '0x' + 'e'.repeat(64), nCx: a.nNote.cx, nCy: a.nNote.cy, locker: a.nNote.owner }; } };
  const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256: (k, m) => hmac(sha256, k, m), walletPriv: new Uint8Array(32).fill(1), seed: new Uint8Array(32), asset: ASSET, poolAddress: '0x' + '11'.repeat(20), adaptor });
  const args = (prefer) => ({ rec: { offer: { evm: { amount: '1000' } } }, rEvmLock: 5n, T: secp.ProjectivePoint.BASE, deadline: 1, recipient: '0x' + '22'.repeat(32), refundXonly: new Uint8Array(32), prefer });
  return { evm, built, args };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a note is given to one swap at a time, and another swap takes the next of the size', async () => {
  const held = { notes: [note(1), note(2), note(3, '500')] };
  const { evm, args } = adapter(held);
  const a = await evm.lockOp(args(null)), b = await evm.lockOp(args(null));
  assert.equal(a.noteLeaf, note(1).leaf); assert.equal(b.noteLeaf, note(2).leaf);
  assert.equal(await evm.lockOp(args(null)), null, 'no third note of the size');
});

test('a lock built again is built from the same note, even though it is reserved, and a note no longer held is waited for, not replaced', async () => {
  const held = { notes: [note(1), note(2)] };
  const { evm, args } = adapter(held);
  const first = await evm.lockOp(args(null));
  const again = await evm.lockOp(args(first.noteLeaf));
  assert.equal(again.noteLeaf, first.noteLeaf, 'the same note: two tries cannot both be spent');
  held.notes = [note(2)];                                             // the first try landed after all, and its note is spent
  assert.equal(await evm.lockOp(args(first.noteLeaf)), null, 'no other note is used: the pool shows the first lock by its leaf');
});

test('a swap that ends with no lock gives its note back; a restart remembers the notes swaps hold', async () => {
  const held = { notes: [note(1)] };
  const { evm, args } = adapter(held);
  const a = await evm.lockOp(args(null));
  assert.equal(await evm.lockOp(args(null)), null, 'held by the swap');
  evm.release({ rec: { lockNote: a.noteLeaf } });
  assert.equal((await evm.lockOp(args(null))).noteLeaf, note(1).leaf, 'free again');
  const fresh = adapter(held);
  fresh.evm.reserve({ phase: 'locking', lockNote: note(1).leaf, lock: null });
  assert.equal(await fresh.evm.lockOp(fresh.args(null)), null, 'after a restart the note is still the swap\'s');
  fresh.evm.reserve({ phase: 'aborted', lockNote: note(1).leaf });
  assert.equal(await fresh.evm.available(), 0n, 'the reserved note is not counted as free');
});

test('the claim of a lock is read only from a settle the pool or its relayer was called with, not from bytes inside another contract\'s call', async () => {
  const POOL = '0x' + '11'.repeat(20), nu = '0x' + 'aa'.repeat(32);
  const txs = { '0xdecoy': { input: '0xdead', to: '0x' + '99'.repeat(20) }, '0xnested': { input: '0xbeef', to: POOL }, '0xtip': { input: '0xf00d', to: '0x' + '99'.repeat(20) }, '0xreal': { input: '0xcafe', to: POOL } };
  const direct = { '0xdead': false, '0xbeef': false, '0xf00d': true, '0xcafe': true };
  const ux = {
    pool: { nullifier: (l) => l, leaf: () => '0x00' },
    rpc: async (m, a) => (m === 'eth_getStorageAt' ? '0x01' : m === 'eth_getTransactionByHash' ? txs[a[0]] || null : null),
    identity: () => ({}), chainBindingHex: () => '0x00',
    fetchEvents: async () => Object.keys(txs).map((txHash) => ({ txHash, type: 'NullifiersSpent' })),
    lockScan: {
      decodeSettleCalls: (input) => ({ calls: [{ publicValues: input }], direct: direct[input] }),
      decodePublicValuesAdaptorFields: (pv) => ({ lockNullifiers: [nu], adaptorClaimS: [pv === '0xcafe' ? '0x07' : '0xbad'] }),
    },
  };
  const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256: (k, m) => hmac(sha256, k, m), walletPriv: new Uint8Array(32).fill(1), seed: new Uint8Array(32), asset: ASSET, poolAddress: POOL });
  assert.deepEqual(await evm.findClaim(nu), ['0x07'], 'the decoys come first in chain order and are passed over');
  // with only decoys the lock is spent and no settle that did it is found: that is waited on, never taken for a refund or a lost claim
  delete txs['0xreal'];
  const again = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256: (k, m) => hmac(sha256, k, m), walletPriv: new Uint8Array(32).fill(1), seed: new Uint8Array(32), asset: ASSET, poolAddress: POOL });
  await assert.rejects(() => again.findClaim(nu), /settle that spent it is not found yet/);
});

test('a note of the exact size is cut with no fee first, from one note or several, and pays the relay only when the free settles are used up', async () => {
  const held = { notes: [note(1, '400'), note(2, '500'), note(3, '300')] };
  const calls = [];
  let refuseFree = false;
  const ux = {
    pool: { leaf: () => '0x00', nullifier: (l) => l }, rpc: async () => null, identity: () => ({ pubHex: '03ab' }), chainBindingHex: () => '0x00',
    balance: async () => ({ byAsset: { ['0x' + ASSET]: { notes: held.notes } } }),
    poolTickerOf: () => 'cTAC', quoteOpFee: async () => 7n, ladderFee: (f) => BigInt(f),
    transfer: async (a) => { calls.push(a); if (refuseFree && a.fee === 0n) throw new Error('free relayed settles for today are used up (300/300)'); },
  };
  const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256: (k, m) => hmac(sha256, k, m), walletPriv: new Uint8Array(32).fill(1), seed: new Uint8Array(32), asset: ASSET, poolAddress: '0x' + '11'.repeat(20), adaptor: {} });
  const prep = () => evm.prepare({ rec: { offer: { evm: { amount: '897' } } } });
  await prep();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].notes.map((n) => n.value), ['500', '400'], 'with no fee 900 covers 897: the largest first');
  assert.deepEqual([calls[0].amount, calls[0].fee, calls[0].recipientPubHex], [897n, 0n, '03ab']);
  // one note that covers it alone is used alone
  held.notes = [note(4, '1000'), note(5, '300')]; calls.length = 0;
  await prep();
  assert.deepEqual(calls[0].notes.map((n) => n.value), ['1000']);
  // the day's free settles used up: the relay's fee is paid, out of the notes
  held.notes = [note(1, '400'), note(2, '500'), note(3, '300')]; calls.length = 0; refuseFree = true;
  await prep();
  assert.deepEqual(calls.map((c) => c.fee), [0n, 7n]);
  assert.deepEqual(calls[1].notes.map((n) => n.value), ['500', '400', '300'], 'with the fee 904 is needed: all three');
  // a note of the size already there: nothing is cut; not enough in all: said, nothing sent
  held.notes = [note(6, '897')]; calls.length = 0; refuseFree = false;
  await prep(); assert.equal(calls.length, 0);
  held.notes = [note(7, '100')];
  await assert.rejects(prep, /short of 897/); assert.equal(calls.length, 0);
  // what a new lock can use leaves room for the relay's fee of a cut, read once for a while
  held.notes = [note(1, '400'), note(2, '500')];
  assert.equal(await evm.available(), 893n, '900 held, less the 7 a cut may cost');
  held.notes = [note(3, '5')];
  assert.equal(await evm.available(), 0n, 'never below nothing');
  // any other failure is not papered over
  ux.transfer = async () => { throw new Error('the relay did not take the job'); };
  held.notes = [note(8, '1000')];
  await assert.rejects(prep, /relay did not take the job/);
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} pool adapter note checks passed`);
process.exit(process.exitCode || 0);
