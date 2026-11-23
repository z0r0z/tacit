// The Bitcoin transactions of a swap of plain sats (dapp/adaptor-btc-tx.js pickSats / lockSats / claimSats / refundSats): the lock is
// the funding transaction, the claim and the refund each one transaction out of the lock output, with no commit, no payload and no
// Tacit kit (the builder here is made without one). Signatures are checked against the BIP-341 sighashes, the sats are accounted to
// the satoshi, and the lock is found again from the key and the chain. Offline.
//   node tests/adaptor-btc-sats-tx.test.mjs

import assert from 'node:assert/strict';
import { sha256, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
import { SECP_N, bigintToBytes32, verifySchnorr } from '../dapp/bulletproofs.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx } from '../dapp/adaptor-btc-tx.js';
import { deriveLock, claimSecret } from '../dapp/adaptor-btc-lock.js';
import * as X from '../dapp/adaptor-xswap.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const te = (s) => new TextEncoder().encode(s);
const scalar = (tag) => (BigInt('0x' + bytesToHex(sha256(te(tag)))) % (SECP_N - 1n)) + 1n;
const fetched = [];
globalThis.fetch = async (input) => { fetched.push(String(input?.url ?? input)); throw new Error('offline test: ' + fetched.at(-1)); };

const wallet = (name) => makeBtcWallet({ priv: bigintToBytes32(scalar(name)), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 1 }).prims;
const userPrims = wallet('user-wallet'), lpPrims = wallet('lp-wallet');
const user = makeAdaptorBtcTx({ prims: userPrims }), lp = makeAdaptorBtcTx({ prims: lpPrims });

const FEE_RATE = 3, CSV = 144, VALUE = 100_000, DUST = 546;
const coin = (tag, value) => ({ txid: bytesToHex(sha256(te('coin/' + tag))), vout: 0, value });
const sumOut = (tx) => tx.outputs.reduce((s, o) => s + o.value, 0);

const userSeed = sha256(te('user-seed'));
const lpPub = lpPrims.wallet.pub, userXonly = userPrims.wallet.xonly();
const coins = [coin('user-a', 180_000)];
const swapId = X.swapIdOf(coins[0].txid, coins[0].vout);
const sec = X.deriveSwapSecrets({ seed: userSeed, swapId });
const lock = deriveLock({ prims: userPrims, claimerPub: lpPub, T: sec.T, lockerXonly: userXonly, csvBlocks: CSV });
const hint = X.lockHintScript({ seed: userSeed, swapId, claimerPub: lpPub, csvBlocks: CSV, value: VALUE });
const lockPair = user.lockSats({ lock, amount: VALUE, hint, coins, feeRate: FEE_RATE });
const lockOut = { txid: lockPair.revealTxid, vout: 0, value: VALUE };

test('the lock is one ordinary transaction: the lock output first, the recovery hint behind it, the rest back to the wallet, no commit', () => {
  assert.equal(lockPair.commitHex, null);
  assert.equal(lockPair.commitTx, null);
  const tx = lockPair.revealTx, outs = tx.outputs;
  assert.deepEqual(tx.inputs.map((i) => `${i.txid}:${i.vout}`), coins.map((c) => `${c.txid}:${c.vout}`));
  assert.equal(bytesToHex(outs[0].script), bytesToHex(lock.spk), 'vout 0 pays the lock');
  assert.equal(outs[0].value, VALUE, 'with exactly the amount');
  assert.equal(outs[1].value, 0, 'the hint carries no sats');
  assert.equal(bytesToHex(outs[2].script), bytesToHex(userPrims.p2wpkhScript(userPrims.wallet.pub)), 'the change returns to the wallet');
  assert.equal(tx.version, 2);
  assert.ok(tx.inputs.every((i) => i.sequence === 0xfffffffd), 'it can be replaced by fee');
  assert.ok(tx.inputs.every((i) => i.witness.length === 2 && i.witness[1].length === 33), 'each input carries a P2WPKH witness');
});

test('the sats balance to the satoshi and the fee covers the real size at the quoted rate', () => {
  const tx = lockPair.revealTx;
  assert.equal(coins[0].value - sumOut(tx), lockPair.revealFee);
  assert.ok(lockPair.revealFee >= Math.ceil(user.vsizeOf(tx) * FEE_RATE));
  assert.ok(tx.outputs.every((o) => o.value === 0 || o.value > DUST), 'no dust output');
  assert.equal(X.swapIdFromLockTx({ vin: tx.inputs }, { sats: true }) .length, 36, 'the swap id is the first coin\'s outpoint');
  assert.equal(bytesToHex(X.swapIdFromLockTx({ vin: tx.inputs }, { sats: true })), bytesToHex(swapId));
});

test('a lock is found again from the key and the chain alone', () => {
  const got = X.recoverBtcLock({ prims: userPrims, seed: userSeed, swapId, lockerXonly: userXonly, outputs: lockPair.revealTx.outputs });
  assert.equal(got.vout, 0);
  assert.equal(got.value, BigInt(VALUE));
  assert.equal(got.csvBlocks, CSV);
  assert.equal(bytesToHex(got.lock.spk), bytesToHex(lock.spk));
});

test('a change too small to be a coin goes to the fee, and a coin of dust size, which may carry a note, is never spent', () => {
  const snug = [coin('snug', VALUE + 700)];
  const p = user.lockSats({ lock, amount: VALUE, hint, coins: snug, feeRate: FEE_RATE });
  assert.equal(p.revealTx.outputs.length, 2, 'lock and hint only');
  assert.equal(snug[0].value - sumOut(p.revealTx), p.revealFee);
  assert.ok(p.revealFee >= Math.ceil(user.vsizeOf(p.revealTx) * FEE_RATE));
  const dust = coin('could-be-a-note', DUST);
  const picked = user.pickSats({ amount: VALUE, satsUtxos: [dust, coin('plain', 150_000)], feeRate: FEE_RATE });
  assert.deepEqual(picked.map((c) => c.txid), [coin('plain', 150_000).txid], 'the dust coin is left alone');
});

test('pickSats takes the fewest coins that cover the amount and the fee, in the order the wallet lists them', () => {
  const list = [coin('p1', 60_000), coin('p2', 50_000), coin('p3', 40_000)];
  assert.deepEqual(user.pickSats({ amount: VALUE, satsUtxos: list, feeRate: FEE_RATE }).map((c) => c.txid), [list[0].txid, list[1].txid]);
  assert.deepEqual(user.pickSats({ amount: 50_000, satsUtxos: list, feeRate: FEE_RATE }).map((c) => c.txid), [list[0].txid]);
  // the fee is part of what must be covered: a coin that holds exactly the amount is not enough
  assert.deepEqual(user.pickSats({ amount: 60_000, satsUtxos: list, feeRate: FEE_RATE }).map((c) => c.txid), [list[0].txid, list[1].txid]);
});

test('the builder refuses what it cannot make: too few sats, an amount too small to be claimed or refunded', () => {
  assert.throws(() => user.pickSats({ amount: VALUE, satsUtxos: [coin('small', 30_000)], feeRate: FEE_RATE }), /not enough sats for the lock \(need \d+, have 30000\)/);
  assert.throws(() => user.lockSats({ lock, amount: VALUE, hint, coins: [coin('small', 30_000)], feeRate: FEE_RATE }), /not enough sats for the lock/);
  assert.throws(() => user.lockSats({ lock, amount: 19_999, hint, coins, feeRate: FEE_RATE }), /holds at least 20000 sats/);
  assert.throws(() => user.pickSats({ amount: 19_999, satsUtxos: coins, feeRate: FEE_RATE }), /holds at least 20000 sats/);
  assert.throws(() => user.lockSats({ lock, amount: VALUE, hint, coins: [], feeRate: FEE_RATE }), /needs a coin/);
});

const claimSk = claimSecret({ dClaimer: lpPrims.wallet.priv, t: sec.t, lock });
const claimPair = lp.claimSats({ lockOut, lock, sk: claimSk, feeRate: FEE_RATE });

test('the claim is one key-path spend of the lock, signed under the lock output key, paying the claimer\'s own address the amount less the fee', () => {
  assert.equal(claimPair.commitHex, null);
  const tx = claimPair.revealTx;
  assert.equal(tx.inputs.length, 1);
  assert.equal(`${tx.inputs[0].txid}:${tx.inputs[0].vout}`, `${lockOut.txid}:0`);
  const w = tx.inputs[0].witness;
  assert.equal(w.length, 1);
  assert.equal(w[0].length, 64);
  assert.ok(verifySchnorr(w[0], lpPrims.tapSighashKeyPath(tx, 0, [{ value: VALUE, script: lock.spk }], 0x00), lock.outputXonly), 'verifies under the lock output key');
  assert.equal(tx.outputs.length, 1);
  assert.equal(bytesToHex(tx.outputs[0].script), bytesToHex(lpPrims.p2wpkhScript(lpPrims.wallet.pub)));
  assert.equal(tx.outputs[0].value, VALUE - claimPair.revealFee, 'the fee comes out of the lock output');
  assert.ok(claimPair.revealFee >= Math.ceil(lp.vsizeOf(tx) * FEE_RATE), 'and covers the real size');
  assert.equal(tx.inputs[0].sequence, 0xfffffffd);
});

test('a key that does not open the lock cannot build a claim', () => {
  assert.throws(() => lp.claimSats({ lockOut, lock, sk: bigintToBytes32(scalar('wrong')), feeRate: FEE_RATE }), /does not verify/);
});

const refundPair = user.refundSats({ lockOut, lock, dLocker: userPrims.wallet.priv, feeRate: FEE_RATE });

test('the refund is a script-path spend: nSequence is the timelock, the control block opens to the lock key, the amount less the fee comes back', () => {
  assert.equal(refundPair.commitHex, null);
  const tx = refundPair.revealTx, inp = tx.inputs[0];
  assert.equal(tx.version, 2);
  assert.equal(inp.sequence, CSV);
  const [sig, leaf, control] = inp.witness;
  assert.ok(verifySchnorr(sig, userPrims.tapSighash(tx, 0, [{ value: VALUE, script: lock.spk }], userPrims.tapLeafHash(leaf), 0x00), userXonly));
  assert.equal(bytesToHex(userPrims.tweakedOutputKey(control.slice(1), userPrims.tapLeafHash(leaf)).Q_xonly), bytesToHex(lock.outputXonly), 'the control block opens to the lock key');
  assert.equal(control[0] & 1, lock.parity, 'with the output key\'s parity');
  assert.equal(bytesToHex(tx.outputs[0].script), bytesToHex(userPrims.p2wpkhScript(userPrims.wallet.pub)));
  assert.equal(tx.outputs[0].value, VALUE - refundPair.revealFee);
  assert.ok(refundPair.revealFee >= Math.ceil(user.vsizeOf(tx) * FEE_RATE));
  assert.throws(() => lp.refundSats({ lockOut, lock, dLocker: lpPrims.wallet.priv, feeRate: FEE_RATE }), /not the refund key/);
});

test('a refund rebuilt from the key and the chain alone spends the same lock by the same path', () => {
  const got = X.recoverBtcLock({ prims: userPrims, seed: userSeed, swapId, lockerXonly: userXonly, outputs: lockPair.revealTx.outputs });
  const again = user.refundSats({ lockOut: { txid: lockPair.revealTxid, vout: got.vout, value: lockPair.revealTx.outputs[got.vout].value }, lock: got.lock, dLocker: userPrims.wallet.priv, feeRate: FEE_RATE });
  assert.equal(again.revealTxid, refundPair.revealTxid, 'the same transaction, to the byte, as a signature is deterministic');
});

test('a lock output that would be dust after the fee, or is dust already, is refused rather than built', () => {
  assert.throws(() => lp.claimSats({ lockOut: { ...lockOut, value: 20_000 }, lock, sk: claimSk, feeRate: 1000 }), /does not cover the fee/);
  assert.throws(() => user.refundSats({ lockOut: { ...lockOut, value: 20_000 }, lock, dLocker: userPrims.wallet.priv, feeRate: 1000 }), /does not cover the fee/);
  assert.throws(() => lp.claimSats({ lockOut: { ...lockOut, value: DUST }, lock, sk: claimSk, feeRate: FEE_RATE }), /no spendable amount/);
});

test('a pair with nothing to commit is broadcast as its reveal alone', async () => {
  const sent = [], stages = [];
  const prims = { ...userPrims, broadcast: async (h) => { sent.push(['commit', h]); }, broadcastWithRetry: async (h) => { sent.push(['reveal', h]); } };
  const b = makeAdaptorBtcTx({ prims });
  const r = await b.broadcastPair(lockPair, { onStage: (s) => stages.push(s) });
  assert.deepEqual(sent, [['reveal', lockPair.revealHex]]);
  assert.deepEqual(stages, ['reveal']);
  assert.equal(r.revealTxid, lockPair.revealTxid);
});

test('the offer of a sats lock names no blinding, and the checks take the output\'s value in place of a note', () => {
  const offer = X.makeBtcLockOffer({
    swapId, asset: X.SATS_ASSET, value: VALUE, txid: lockPair.revealTxid, vout: 0, csvBlocks: CSV, lockerXonly: userXonly, T: sec.T, claimerPub: lpPub,
    evm: { asset: '0x' + 'a1'.repeat(32), amount: 3_700_000n, recipient: bytesToHex(userXonly), rOut: sec.rOut },
  });
  assert.equal(offer.btc.rLock, undefined);
  const chain = { spk: bytesToHex(lock.spk), value: VALUE, confirmations: 1, noteInputs: lockPair.revealTx.inputs.map((i) => ({ txid: i.txid, vout: i.vout })) };
  const expect = { btcAsset: X.SATS_ASSET, btcValue: BigInt(VALUE), evmAsset: offer.evm.asset, evmAmount: 3_700_000n };
  const ok = X.verifyBtcLockOffer(offer, { prims: lpPrims, myClaimerPub: lpPub, expect, chain, minCsv: 72 });
  assert.deepEqual(ok.reasons, []);
  assert.ok(ok.ok);
  const short = X.verifyBtcLockOffer(offer, { prims: lpPrims, myClaimerPub: lpPub, expect, chain: { ...chain, value: VALUE - 1 }, minCsv: 72 });
  assert.match(short.reasons.join(';'), /does not hold the quoted amount of sats/);
  const more = X.verifyBtcLockOffer(offer, { prims: lpPrims, myClaimerPub: lpPub, expect, chain: { ...chain, value: VALUE + 1 }, minCsv: 72 });
  assert.match(more.reasons.join(';'), /does not hold the quoted amount of sats/);
  const wrongSpk = X.verifyBtcLockOffer(offer, { prims: lpPrims, myClaimerPub: lpPub, expect, chain: { ...chain, spk: bytesToHex(userPrims.p2wpkhScript(userPrims.wallet.pub)) }, minCsv: 72 });
  assert.match(wrongSpk.reasons.join(';'), /does not pay the lock/);
  const otherCoin = X.verifyBtcLockOffer(offer, { prims: lpPrims, myClaimerPub: lpPub, expect, chain: { ...chain, noteInputs: [{ txid: coin('elsewhere', 1).txid, vout: 0 }] }, minCsv: 72 });
  assert.match(otherCoin.reasons.join(';'), /swap id is not the outpoint/);
  // a note's offer still names its blinding, and a sats offer that names one is malformed
  const named = { ...offer, btc: { ...offer.btc, rLock: bytesToHex(bigintToBytes32(sec.rLock)) } };
  assert.match(X.verifyBtcLockOffer(named, { prims: lpPrims, myClaimerPub: lpPub, expect, chain, minCsv: 72 }).reasons.join(';'), /malformed offer: lock blinding/);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} adaptor-btc-sats-tx checks passed`);
process.exit(process.exitCode || 0);
