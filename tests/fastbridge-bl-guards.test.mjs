// The Bitcoin locker's guards: a claim is carried on while any time is left even when the lock has been spent, a side that has been paid on Ethereum
// leaves the Bitcoin lock to the counterparty (it is refunded only when the pool shows no claim), a lock that reached the chain moves on whatever an earlier
// send was told, one that never went out is not sent after its quote, and a refund never pays more than its ceiling.
//   node tests/fastbridge-bl-guards.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import * as X from '../dapp/adaptor-xswap.js';
import { makeBitcoinLocker } from '../dapp/fastbridge-bl.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { bigintToBytes32 } from '../dapp/bulletproofs.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const T0 = 1_800_000_000;
const lpPrims = makeBtcWallet({ priv: bigintToBytes32(12345n) }).prims;
const userPrims = makeBtcWallet({ priv: bigintToBytes32(67890n) }).prims;
const hexOf = (u) => Buffer.from(u).toString('hex');
const LOCK = 'cc'.repeat(32);

function world({ btc = {}, evm = {}, policy = {} } = {}) {
  const w = { now: T0, tip: 110, spent: null, sent: [], submits: [], recs: new Map() };
  const store = { get: async (id) => w.recs.get(id) && structuredClone(w.recs.get(id)), put: async (r) => { w.recs.set(r.id, structuredClone(r)); }, list: async () => [...w.recs.values()] };
  w.store = store;
  w.ctx = {
    seed: new Uint8Array(32).fill(9), now: () => w.now, store,
    policy: { csvBlocks: 96, minClaimSecs: 3600, offerWaitSecs: 7200, maxEvmWindowSecs: 6 * 3600, ...policy },
    btc: {
      prims: lpPrims, wallet: { pub: lpPrims.wallet.pub, priv: lpPrims.wallet.priv, xonly: lpPrims.wallet.xonly() },
      status: async (txid) => (txid === LOCK ? { confirmations: w.tip - 100 + 1, height: 100 } : { confirmations: 0, height: 0 }),
      tip: async () => w.tip, outspend: async () => w.spent, satsUtxos: async () => [], feeRate: async () => 5,
      broadcast: async (p) => { w.sent.push(p.txid || p.revealTxid || 'tx'); },
      tx: {
        refundTransfer: () => ({ revealTxid: 'ee'.repeat(32), commitTxid: 'ff'.repeat(32), commitHex: '00', revealHex: '11', commitFee: 400, revealFee: 300 }),
        refundSats: (a) => { w.refundArgs = a; return { revealTxid: 'ee'.repeat(32), commitTxid: null, commitHex: null, revealHex: '11' }; },
      },
      ...btc,
    },
    evm: { now: async () => w.now, lockPosition: async () => ({ lIndex: 0 }), lockNullifier: (l) => '0x' + l, ...evm },
    counter: {},
  };
  w.bl = makeBitcoinLocker(w.ctx);
  return w;
}
const rec = (over = {}) => ({
  v: 1, role: 'bl', id: 'ab'.repeat(36), phase: 'claimed', asset: '11'.repeat(32), amount: '1000000', evmAsset: '22'.repeat(32), evmAmount: '990000', csvBlocks: 96,
  counterClaimPub: hexOf(userPrims.wallet.pub), lock: { txid: LOCK, vout: 0, value: 546 }, evmOffer: { deadline: T0 + 7200, lockLeaf: 'dd'.repeat(32) }, claimStartedAt: T0 - 600, ...over,
});

test('while claiming, a spent lock is not the end: the claim is sent again until it lands, and the swap ends as paid', async () => {
  const w = world({ evm: { submit: async (type) => { w.submits.push(type); return { jobId: 'j' + w.submits.length }; }, claimStatus: async () => w.claim } });
  w.spent = 'bb'.repeat(32);            // the counterparty took the Bitcoin with the t that left in the first attempt
  w.claim = 'failed';
  await w.store.put(rec({ phase: 'claiming', claim: { op: { k: 1 }, jobId: 'j0' } }));
  let r;
  for (let i = 0; i < 4; i++) { w.now += 60; r = await w.bl.step({ id: rec().id }); }
  assert.equal(r.phase, 'claiming', 'not done: the claim has not landed');
  assert.ok(w.submits.length >= 2, `the claim was sent again (${w.submits.length})`);
  w.claim = 'settled';
  r = await w.bl.step({ id: rec().id });
  assert.equal(r.phase, 'claimed');
  r = await w.bl.step({ id: rec().id });
  assert.equal(r.phase, 'done');
  assert.equal(r.takenBy, w.spent);
});

test('a claim that could not land before the deadline, on a lock already taken, ends as the counterparty having taken it', async () => {
  const w = world({ evm: { submit: async () => ({ jobId: 'jx' }), claimStatus: async () => 'failed' } });
  w.spent = 'bb'.repeat(32);
  await w.store.put(rec({ phase: 'claiming', claim: { op: { k: 1 }, jobId: 'j0' } }));
  w.now = T0 + 7300;                     // past the Ethereum deadline
  let r;
  for (let i = 0; i < 4; i++) r = await w.bl.step({ id: rec().id });
  assert.equal(r.phase, 'counter-took');
});

test('once the pool shows this side\'s claim, the Bitcoin lock is never refunded, however long the timelock has run', async () => {
  const w = world({ evm: { findClaim: async () => ['0x' + '77'.repeat(32)] } });
  await w.store.put(rec());
  w.tip = 100 + 96 - 1; w.now += 16 * 3600;
  const r = await w.bl.step({ id: rec().id });
  assert.equal(r.phase, 'done');
  assert.equal(r.refund, undefined);
  assert.deepEqual(w.sent, []);
});

test('with no claim in the pool, the timelock still returns the note; a claim that cannot be read yet is waited for, not guessed', async () => {
  const w = world({ evm: { findClaim: async () => [] } });
  await w.store.put(rec());
  w.tip = 100 + 96 - 1;
  let r = await w.bl.step({ id: rec().id });
  assert.ok(r.refund, 'a lock whose pool lock was refunded, not claimed, goes back');
  assert.equal(w.sent.length, 1);

  const v = world({ evm: { findClaim: async () => { throw new Error('the lock is spent, and the settle that spent it is not found yet'); } } });
  await v.store.put(rec());
  v.tip = 100 + 96 - 1;
  r = await v.bl.step({ id: rec().id });
  assert.equal(r.phase, 'claimed');
  assert.equal(r.refund, undefined);
  assert.match(r.lastError, /not found yet/);
  assert.deepEqual(v.sent, []);
});

test('before the timelock, a claimed lock is left alone and nothing is asked of the pool', async () => {
  let asked = 0;
  const w = world({ evm: { findClaim: async () => { asked++; return []; } } });
  await w.store.put(rec());
  const r = await w.bl.step({ id: rec().id });
  assert.equal(r.phase, 'claimed');
  assert.equal(asked, 0);
});

test('a lock that reached the chain moves on, though the send of it was never answered and a second send is refused', async () => {
  const w = world({ btc: { broadcast: async () => { throw new Error('bad-txns-inputs-missingorspent'); }, fetchTx: async () => ({ txid: LOCK }) } });
  await w.store.put(rec({ phase: 'built', validUntil: T0 + 60, lock: { txid: LOCK, vout: 0, commitHex: '00', revealHex: '11' } }));
  const r = await w.bl.step({ id: rec().id });
  assert.equal(r.phase, 'broadcast');
  assert.equal(r.lastError, undefined);
});

test('a lock that never went out is sent while its quote stands and is dropped, unsent, once the quote has run out', async () => {
  const w = world({ btc: { status: async () => ({ confirmations: 0, height: 0 }), fetchTx: async () => null } });
  await w.store.put(rec({ phase: 'built', validUntil: T0 + 300, lock: { txid: LOCK, vout: 0, commitHex: '00', revealHex: '11' } }));
  let r = await w.bl.step({ id: rec().id });
  assert.equal(r.phase, 'broadcast');
  assert.equal(w.sent.length, 1);

  const v = world({ btc: { status: async () => ({ confirmations: 0, height: 0 }), fetchTx: async () => null } });
  await v.store.put(rec({ phase: 'built', validUntil: T0 - 3600, lock: { txid: LOCK, vout: 0, commitHex: '00', revealHex: '11' } }));
  r = await v.bl.step({ id: rec().id });
  assert.equal(r.phase, 'aborted');
  assert.deepEqual(v.sent, []);
});

test('a refund of plain sats takes at most its share of the lock as its fee, and a refund of a note is not built at a rate over its ceiling', async () => {
  const w = world();
  await w.store.put(rec({ phase: 'refund-wait', asset: X.SATS_ASSET, lock: { txid: LOCK, vout: 0, value: 100000 } }));
  w.tip = 100 + 96 - 1;
  await w.bl.step({ id: rec().id });
  assert.equal(w.refundArgs.maxFee, 25000, 'a quarter of the lock');

  const v = world({ btc: { tx: { refundTransfer: () => ({ revealTxid: 'ee'.repeat(32), commitTxid: 'ff'.repeat(32), commitHex: '00', revealHex: '11', commitFee: 150000, revealFee: 90000 }) } } });
  await v.store.put(rec({ phase: 'refund-wait' }));
  v.tip = 100 + 96 - 1;
  const r = await v.bl.step({ id: rec().id });
  assert.equal(r.refund, undefined, 'nothing is stored or sent at that rate');
  assert.match(r.lastError, /more than this side pays/);
  assert.deepEqual(v.sent, []);

  const ok = world();
  await ok.store.put(rec({ phase: 'refund-wait' }));
  ok.tip = 100 + 96 - 1;
  assert.ok((await ok.bl.step({ id: rec().id })).refund, 'at an ordinary rate it is built');
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} locker guard checks passed`);
process.exit(process.exitCode || 0);
