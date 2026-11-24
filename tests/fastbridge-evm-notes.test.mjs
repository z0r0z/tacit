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
  // whether a lock of an amount can be made: a note of exactly the amount needs no cut, so nothing is kept back for one (a note just shielded for a swap)
  held.notes = [note(9, '897')];
  assert.equal(await evm.available(), 890n, 'available keeps the cut fee back even then');
  assert.equal(await evm.covers(897n), true, 'but a note of exactly 897 covers a lock of 897');
  assert.equal(await evm.covers(895n), false, '895 has to be cut from it, and 897 does not hold 895 and the fee');
  assert.equal(await evm.covers(890n), true, 'up to what it holds less the fee');
  held.notes = [note(1, '400'), note(2, '500')];
  assert.equal(await evm.covers(893n), true, 'notes that are cut: the amount and the fee');
  assert.equal(await evm.covers(894n), false);
  held.notes = [];
  assert.equal(await evm.covers(1n), false, 'nothing held covers nothing');
  // any other failure is not papered over
  ux.transfer = async () => { throw new Error('the relay did not take the job'); };
  held.notes = [note(8, '1000')];
  await assert.rejects(prep, /relay did not take the job/);
});

test('a take of a note that waits is replaced from the same coins at a rate that outpays the pair, once the refund is near and not before', async () => {
  const { makeEthereumLocker } = await import('../dapp/fastbridge-el.js');
  const { makeBtcWallet } = await import('../dapp/bitcoin-taproot-wallet.js');
  const adaptor = await import('../dapp/adaptor-signature.js');
  const { prims } = makeBtcWallet({ priv: new Uint8Array(32).fill(9), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => {}, fetchFeeRate: async () => 1 });
  const t = 0x4242n, T = adaptor.adaptorPoint(t);
  let tip = 900000, n = 0;
  const built = [], sent = [];
  const c1 = { txid: 'c1'.repeat(32), vout: 0, value: 20000 }, c2 = { txid: 'c2'.repeat(32), vout: 1, value: 90000 };
  const btc = {
    prims, wallet: { pub: prims.wallet.pub, priv: prims.wallet.priv, xonly: prims.wallet.pub.slice(1) },
    tip: async () => tip, status: async () => ({ confirmations: 0, height: 0 }), feeRate: async () => 10, satsUtxos: async () => [c2], coinsIn: async () => [],
    fetchTx: async () => ({}), broadcast: async (p) => { sent.push(p.txid); },
    tx: {
      vsizeOf: () => 150,
      claimTransfer: ({ satsUtxos, feeRate }) => { n++; built.push({ feeRate, first: satsUtxos[0].txid }); return { commitTx: { inputs: [{ txid: satsUtxos[0].txid, vout: satsUtxos[0].vout }] }, commitTxid: 'aa'.repeat(31) + String(n).padStart(2, '0'), revealTxid: 'bb'.repeat(31) + String(n).padStart(2, '0'), commitHex: '00', revealHex: '00', commitFee: 150 * feeRate, revealFee: 600 * feeRate }; },
    },
  };
  const recs = new Map();
  const store = { get: async (id) => (recs.has(id) ? JSON.parse(JSON.stringify(recs.get(id))) : null), put: async (r) => { recs.set(r.id, JSON.parse(JSON.stringify(r))); }, list: async () => [...recs.values()] };
  let clock = 10000;
  const el = makeEthereumLocker({ seed: new Uint8Array(32), now: () => clock, policy: {}, store, quotes: { get: async () => null }, btc, evm: { now: async () => clock }, counter: {} });
  const id = 'cd'.repeat(36);
  const rec = {
    v: 1, role: 'el', id, phase: 'taking', created: 1, updated: 1, t: '0x' + t.toString(16), lockTxid: 'dd'.repeat(32), lockVout: 0, lockValue: 546, csvBlocks: 144, lockHeight: 899900,
    offer: { T: '0x' + T.toHex(true), btc: { asset: 'ab'.repeat(32), lockerXonly: '11'.repeat(32), value: '1000', rLock: '05' } },
    take: { txid: 'bb'.repeat(32), commitTxid: 'aa'.repeat(32), commitHex: '00', revealHex: '00', at: 0, feeRate: 10, fee: 7500, commitVsize: 150, bumps: 0, coins: [c1] }, takes: ['bb'.repeat(32)],
  };
  await store.put(rec);
  let r = await el.step(rec);
  assert.equal(built.length, 0, 'with the refund 43 blocks away a slow take is left to confirm');
  tip = 899900 + 144 - 1 - 30;
  r = await el.step(r);
  assert.equal(built.length, 1, 'with the refund 30 blocks away it is replaced');
  assert.equal(built[0].first, c1.txid, 'from the coin the waiting commit spent first, so the new commit replaces it');
  assert.ok(built[0].feeRate * 150 >= 7500 + 150, 'the new commit alone pays more than the pair it replaces');
  assert.deepEqual(r.takes.length, 2, 'both takes are watched: either landing ends the swap');
  assert.equal(sent.at(-1), r.take.txid);
  clock += 100;
  r = await el.step(r);
  assert.equal(built.length, 1, 'a replacement waits takeBumpSecs before the next');
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} pool adapter note checks passed`);
process.exit(process.exitCode || 0);
