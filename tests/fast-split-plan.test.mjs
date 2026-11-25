// The plan for a swap of Bitcoin for ETH that several providers fill (dapp/fast/split-plan.js), the swap ids and the hint of a transaction that holds several locks
// (dapp/adaptor-xswap.js legSwapId, lockBatchHintScript, recoverBtcBatch), and the transaction builder's several locks (dapp/adaptor-btc-tx.js lockSatsMany).
//   node tests/fast-split-plan.test.mjs        (Node 22)
import assert from 'node:assert/strict';
import { planSplit, getFrom, RATE_ONE, OUTPUT_VB } from '../dapp/fast/split-plan.js';
import * as X from '../dapp/adaptor-xswap.js';
import { deriveLock } from '../dapp/adaptor-btc-lock.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx } from '../dapp/adaptor-btc-tx.js';
import { bigintToBytes32 } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { scalar } from './lib/btc-sim.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const P = (id, o = {}) => ({ id, min: 20_000n, max: 150_000n, available: null, feeBps: 30, flatFee: 500n, rate: RATE_ONE * 36n, ...o });

test('one provider that can take the whole amount is the plan, and a split is not offered over it for no gain', () => {
  const r = planSplit({ amount: 100_000n, providers: [P('a'), P('b'), P('c')], feeRate: 3 });
  assert.deepEqual(r.best.legs.map((l) => [l.id, l.amount]), [['a', 100_000n]]);
  assert.equal(r.best.split, false);
  assert.equal(r.single.get, getFrom(P('a'), 100_000n));
});

test('an amount above any one provider is split, each leg inside its provider\'s limits, and the legs add up to the amount to the satoshi', () => {
  const r = planSplit({ amount: 400_000n, providers: [P('a'), P('b'), P('c')], feeRate: 3 });
  assert.equal(r.single, null, 'no provider takes 400,000');
  assert.equal(r.best.split, true);
  assert.deepEqual(r.best.legs.map((l) => [l.id, l.amount]), [['a', 150_000n], ['b', 150_000n], ['c', 100_000n]]);
  assert.equal(r.best.legs.reduce((t, l) => t + l.amount, 0n), 400_000n);
  assert.equal(r.best.extraFeeSats, BigInt(Math.ceil(2 * OUTPUT_VB * 3)), 'two more outputs in the one transaction');
});

test('what a provider holds caps its leg; the rest goes to the others', () => {
  const r = planSplit({ amount: 450_000n, providers: [P('a', { available: 60_000n }), P('b', { max: 300_000n }), P('c', { available: 0n, min: 0n }), P('d')], feeRate: 1 });
  const by = Object.fromEntries(r.best.legs.map((l) => [l.id, l.amount]));
  assert.ok((by.a ?? 0n) <= 60_000n && by.b <= 300_000n && !by.c, JSON.stringify(by, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  assert.equal(r.best.legs.reduce((t, l) => t + l.amount, 0n), 450_000n);
});

test('no group of at most four providers can fill an amount that needs five: no plan', () => {
  const five = ['a', 'b', 'c', 'd', 'e'].map((id) => P(id, { max: 100_000n }));
  assert.equal(planSplit({ amount: 450_000n, providers: five, feeRate: 1 }).best, null);
  assert.equal(planSplit({ amount: 450_000n, providers: five, feeRate: 1, policy: { maxLegs: 5 } }).best.legs.length, 5);
});

test('a leg is never under the smallest leg: a flat fee does not dominate it', () => {
  // 120,000 split in two would be two legs of 60,000; with a 70,000 floor, a split into two is not allowed, and one provider takes it
  const r = planSplit({ amount: 120_000n, providers: [P('a'), P('b')], feeRate: 1, policy: { minLegSats: 70_000n } });
  assert.equal(r.best.legs.length, 1);
  assert.ok(r.options.every((o) => o.legs.every((l) => l.amount >= 70_000n)));
  // and a provider's own minimum is a floor over the common one
  const s = planSplit({ amount: 300_000n, providers: [P('a', { min: 100_000n }), P('b'), P('c')], feeRate: 1 });
  assert.ok(s.options.every((o) => o.legs.every((l) => (l.id !== 'a' || l.amount >= 100_000n) && l.amount >= 50_000n)));
});

test('a cheaper provider is filled first, and a split is chosen over one provider only when it gives more by enough to be worth the added locks', () => {
  const cheap = P('cheap', { feeBps: 5, flatFee: 100n, max: 60_000n }), dear = P('dear', { feeBps: 80, flatFee: 500n });
  const r = planSplit({ amount: 150_000n, providers: [dear, cheap], feeRate: 2 });
  assert.equal(r.single.legs[0].id, 'dear', 'the only one that takes it all');
  assert.equal(r.best.split, true, 'cheap takes its 60,000 at 5 bps and dear the 90,000: more than dear alone');
  const by = Object.fromEntries(r.best.legs.map((l) => [l.id, l.amount]));
  assert.equal(by.cheap, 60_000n);
  assert.equal(by.dear, 90_000n);
  assert.ok(r.best.net > r.single.net);
  // the same fees but a gain under the threshold stays with one provider
  const same = planSplit({ amount: 100_000n, providers: [P('a', { feeBps: 30 }), P('b', { feeBps: 29 })], feeRate: 50 });
  assert.equal(same.best.split, false, 'a one basis point difference does not pay for a second lock and its fee');
});

test('a better rate is worth more than a lower fee: the plan weighs what each provider pays out, not the fee alone', () => {
  const a = P('a', { rate: RATE_ONE * 36n, feeBps: 30 }), b = P('b', { rate: RATE_ONE * 35n, feeBps: 0, flatFee: 0n });
  const r = planSplit({ amount: 100_000n, providers: [a, b], feeRate: 1 });
  assert.equal(r.best.legs[0].id, 'a');
});

test('integer money: the total is the sum of what each leg pays, and nothing is lost to rounding that the legs do not show', () => {
  const r = planSplit({ amount: 333_333n, providers: [P('a', { rate: 1234567890123456789n }), P('b', { rate: 998877665544332211n }), P('c')], feeRate: 7 });
  assert.equal(r.best.get, r.best.legs.reduce((t, l) => t + l.get, 0n));
  for (const l of r.best.legs) assert.equal(typeof l.amount, 'bigint');
});

test('swap ids: the lock at output 0 is named as ever; every other output of the one transaction has an id of its own, none shared', () => {
  const txid = 'ab'.repeat(32);
  assert.equal(bytesToHex(X.legSwapId(txid, 3, 0)), bytesToHex(X.swapIdOf(txid, 3)), 'a lone lock is unchanged');
  const ids = [0, 1, 2, 3].map((k) => bytesToHex(X.legSwapId(txid, 3, k)));
  assert.equal(new Set(ids).size, 4);
  assert.ok(ids.every((i) => /^[0-9a-f]{72}$/.test(i)));
  // another coin of the same transaction never lands on one of these ids
  const other = new Set([0, 1, 2, 3].map((k) => bytesToHex(X.legSwapId(txid, 4, k))));
  assert.ok(ids.every((i) => !other.has(i)));
  assert.throws(() => X.legSwapId(txid, 1 << 24, 1), /out of range/);
  assert.throws(() => X.legSwapId(txid, 0, 256), /output 0 to 255/);
  // each id derives its own secret: two providers never share t
  const seed = new Uint8Array(32).fill(7);
  const ts = ids.map((i) => X.deriveSwapSecrets({ seed, swapId: hexToBytes(i) }).t);
  assert.equal(new Set(ts.map(String)).size, 4);
});

const wallet = (n) => makeBtcWallet({ priv: bigintToBytes32(scalar(n)), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 });

test('the offer check accepts the id of the lock\'s own output and no other; a lone lock\'s id is as it was', () => {
  const u = wallet('u'), c1 = wallet('c1'), c2 = wallet('c2'), seed = new Uint8Array(32).fill(9);
  const first = { txid: 'cd'.repeat(32), vout: 1 };
  const expect = { btcAsset: X.SATS_ASSET, btcValue: 50_000n, evmAsset: 'ee'.repeat(32), evmAmount: 1_000n };
  const legOf = (k, cw) => {
    const swapId = X.legSwapId(first.txid, first.vout, k), sec = X.deriveSwapSecrets({ seed, swapId });
    const lock = deriveLock({ prims: u.prims, claimerPub: cw.wallet.pub, T: sec.T, lockerXonly: u.prims.wallet.pub.slice(1), csvBlocks: 144 });
    const offer = X.makeBtcLockOffer({ swapId, asset: X.SATS_ASSET, value: 50_000n, rLock: null, txid: '11'.repeat(32), vout: k, csvBlocks: 144, lockerXonly: u.prims.wallet.pub.slice(1), T: sec.T, claimerPub: cw.wallet.pub, evm: { asset: expect.evmAsset, amount: 1_000n, recipient: 'aa'.repeat(32), rOut: sec.rOut } });
    return { offer, lock, swapId };
  };
  for (const [k, cw] of [[0, c1], [1, c2]]) {
    const { offer, lock } = legOf(k, cw);
    const chain = { spk: bytesToHex(lock.spk), value: 50_000, confirmations: 1, noteInputs: [first] };
    const v = X.verifyBtcLockOffer(offer, { prims: u.prims, myClaimerPub: cw.wallet.pub, expect, chain, minConfs: 0, minCsv: 72 });
    assert.equal(v.ok, true, `output ${k}: ${v.reasons}`);
    // the same offer is refused if it claims another output's id
    const wrong = { ...offer, swapId: bytesToHex(X.legSwapId(first.txid, first.vout, k === 0 ? 1 : 0)) };
    const bad = X.verifyBtcLockOffer(wrong, { prims: u.prims, myClaimerPub: cw.wallet.pub, expect, chain, minConfs: 0, minCsv: 72 });
    assert.ok(!bad.ok && /swap id is not the outpoint/.test(bad.reasons.join()));
  }
});

test('the batch hint opens only under the key, names each lock by a fingerprint of its provider\'s key, and the locks are found again only by the exact script their key makes', () => {
  const u = wallet('u'), cs = ['c1', 'c2', 'c3'].map(wallet), seed = new Uint8Array(32).fill(5);
  const first = { txid: 'ef'.repeat(32), vout: 0 };
  const legs = cs.map((c, k) => {
    const sec = X.deriveSwapSecrets({ seed, swapId: X.legSwapId(first.txid, first.vout, k) });
    return { claimerPub: c.wallet.pub, csvBlocks: 144, lock: deriveLock({ prims: u.prims, claimerPub: c.wallet.pub, T: sec.T, lockerXonly: u.prims.wallet.pub.slice(1), csvBlocks: 144 }) };
  });
  const hint = X.lockBatchHintScript({ seed, swapId: X.legSwapId(first.txid, first.vout, 0), legs });
  assert.ok(hint.length <= 80, `the hint fits what a node relays (${hint.length} bytes)`);
  const outputs = [...legs.map((l, k) => ({ scriptpubkey: bytesToHex(l.lock.spk), value: 50_000 + k })), { scriptpubkey: bytesToHex(hint), value: 0 }];
  const keys = cs.map((c) => bytesToHex(c.wallet.pub));
  const found = X.recoverBtcBatch({ prims: u.prims, seed, first, lockerXonly: u.prims.wallet.pub.slice(1), outputs, claimerKeys: keys });
  assert.deepEqual(found.legs.map((l) => [l.vout, l.claimerPub, l.csvBlocks, l.value]), keys.map((k, i) => [i, k, 144, BigInt(50_000 + i)]));
  assert.equal(found.unknown.length, 0);
  // a key the page does not know leaves its leg unknown, the others found
  const part = X.recoverBtcBatch({ prims: u.prims, seed, first, lockerXonly: u.prims.wallet.pub.slice(1), outputs, claimerKeys: [keys[0], keys[2]] });
  assert.deepEqual([part.legs.map((l) => l.vout), part.unknown.map((l) => l.vout)], [[0, 2], [1]]);
  // another key's seed opens nothing, and a transaction without a hint is not a batch
  assert.equal(X.recoverBtcBatch({ prims: u.prims, seed: new Uint8Array(32).fill(6), first, lockerXonly: u.prims.wallet.pub.slice(1), outputs, claimerKeys: keys }), null);
  assert.equal(X.recoverBtcBatch({ prims: u.prims, seed, first, lockerXonly: u.prims.wallet.pub.slice(1), outputs: outputs.slice(0, 3), claimerKeys: keys }), null);
  // a single lock's hint is not mistaken for a batch's
  const single = X.lockHintScript({ seed, swapId: X.legSwapId(first.txid, first.vout, 0), claimerPub: cs[0].wallet.pub, csvBlocks: 144, value: 50_000n, bare: true });
  assert.equal(X.readBatchHint({ seed, swapId: X.legSwapId(first.txid, first.vout, 0), script: single }), null);
});

test('the builder makes one transaction with a lock output for each leg, in order, then the hint, then the change; it signs every coin and pays the fee of all of it', () => {
  const u = wallet('u'), cs = ['c1', 'c2'].map(wallet), builder = makeAdaptorBtcTx({ prims: u.prims }), seed = new Uint8Array(32).fill(3);
  const coins = [{ txid: '01'.repeat(32), vout: 0, value: 300_000 }, { txid: '02'.repeat(32), vout: 1, value: 200_000 }];
  const picked = builder.pickSatsMany({ amounts: [150_000, 150_000], satsUtxos: coins, feeRate: 3 });
  assert.equal(picked.length, 2, 'the first coin cannot pay both and the fee');
  const legs = cs.map((c, k) => ({ amount: 150_000, lock: deriveLock({ prims: u.prims, claimerPub: c.wallet.pub, T: X.deriveSwapSecrets({ seed, swapId: X.legSwapId(picked[0].txid, picked[0].vout, k) }).T, lockerXonly: u.prims.wallet.pub.slice(1), csvBlocks: 144 }) }));
  const hint = X.lockBatchHintScript({ seed, swapId: X.legSwapId(picked[0].txid, picked[0].vout, 0), legs: legs.map((l, k) => ({ claimerPub: cs[k].wallet.pub, csvBlocks: 144 })) });
  const pair = builder.lockSatsMany({ legs, hint, coins: picked, feeRate: 3 });
  const o = pair.revealTx.outputs;
  assert.deepEqual([o[0].value, o[1].value, o[2].value], [150_000, 150_000, 0]);
  assert.equal(bytesToHex(o[0].script), bytesToHex(legs[0].lock.spk));
  assert.equal(bytesToHex(o[1].script), bytesToHex(legs[1].lock.spk));
  assert.equal(o.length, 4, 'two locks, the hint, the change');
  assert.equal(pair.revealTx.inputs.reduce((t, i) => t + 1, 0), 2);
  assert.equal(500_000 - o.reduce((t, x) => t + x.value, 0), pair.revealFee, 'what the outputs leave is the fee');
  assert.throws(() => builder.lockSatsMany({ legs: [legs[0]], hint, coins: picked, feeRate: 3 }), /at least two/);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} split checks passed`);
process.exit(process.exitCode || 0);
