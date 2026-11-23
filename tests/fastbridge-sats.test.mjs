// A swap of plain Bitcoin (sats, no Tacit note) for a pool asset, Bitcoin -> Ethereum, by the same two role machines as the TAC bridge
// (dapp/fastbridge-bl.js, dapp/fastbridge-el.js): the user locks sats in one ordinary transaction to the LP's key plus T, the LP locks a
// pool note to T, the user claims on the pool and the claim publishes t, and the LP takes the sats with it. The simulated Bitcoin and pool
// of tests/lib/chain-sim.mjs on one virtual clock, the real adaptor messages and the real Bitcoin builders. The two sides are not equal
// (100,000 sats for 3,700,000 units), and the LP never needs a coin, a note or the note validator.
//   node tests/fastbridge-sats.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import * as X from '../dapp/adaptor-xswap.js';
import { deriveLock, claimSecret } from '../dapp/adaptor-btc-lock.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx } from '../dapp/adaptor-btc-tx.js';
import { makeBitcoinLocker } from '../dapp/fastbridge-bl.js';
import { makeEthereumLocker } from '../dapp/fastbridge-el.js';
import { makeFastBridgeClient } from '../dapp/fastbridge-client.js';
import { bigintToBytes32 } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { te, scalar, fetched } from './lib/btc-sim.mjs';
import { makeClock, makeBitcoinSim, makeEvmSim, makeEvmParty, partyKeys, pool, sha256, ASSET } from './lib/chain-sim.mjs';
import { memStore } from './lib/fastbridge-world.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();

const SATS = 100_000n, OUT = 3_700_000n;
const CSV = 144;

function satsWorld({ confs = 1, lp: lpOver = {} } = {}) {
  const clock = makeClock(), btc = makeBitcoinSim(clock), evm = makeEvmSim(clock);
  const wallet = (name) => makeBtcWallet({ priv: bigintToBytes32(scalar(name + '/btc-wallet')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 });
  const uW = wallet('user'), lW = wallet('lp'), stranger = wallet('stranger');
  const uKeys = partyKeys('user'), lKeys = partyKeys('lp');
  const uEvm = makeEvmParty({ evm, keys: uKeys, clock }), lEvm = makeEvmParty({ evm, keys: lKeys, clock });
  lEvm.fund(OUT, 'inv0');                                              // the LP holds the pool asset: one note of exactly the payout

  const calls = { userCoins: 0, lpCoins: 0, lpNote: 0, lpGuard: 0 };
  let coinN = 0;
  const coin = () => [{ txid: bytesToHex(sha256(te('coin/' + coinN++))), vout: 0, value: 200_000 }];
  // no Tacit kit: a swap of sats needs none
  const uBtc = btc.adapter({ prims: uW.prims, builder: makeAdaptorBtcTx({ prims: uW.prims }), sats: () => { calls.userCoins++; return coin(); } });
  const lBtc = btc.adapter({ prims: lW.prims, builder: makeAdaptorBtcTx({ prims: lW.prims }), sats: () => { calls.lpCoins++; return coin(); } });
  lBtc.resolveNote = async () => { calls.lpNote++; throw new Error('a lock of sats has no note to resolve'); };
  lBtc.crossLaneBlocked = async () => { calls.lpGuard++; throw new Error('a lock of sats has no note to find consumed'); };
  // the fee rate the LP's explorers estimate, which a test can move
  const market = { feeNow: 3 };
  lBtc.feeRate = async () => market.feeNow;
  // the LP's takes, so that a test can hold them back the way a fee that is too low is
  const takeIds = new Set();
  const claimSats = lBtc.tx.claimSats;
  lBtc.tx.claimSats = (...a) => { const p = claimSats(...a); takeIds.add(p.revealTxid); return p; };
  // a party whose explorers all refuse for a while: what it built stays as it is and is sent again
  const down = { user: false, lp: false };
  for (const [side, adapter] of [['user', uBtc], ['lp', lBtc]]) {
    const send = adapter.broadcast;
    adapter.broadcast = async (...a) => { if (down[side]) throw new Error('every explorer refused the transaction'); return send(...a); };
  }

  const base = { now: evm.now, lockPosition: evm.lockPosition, jobStatus: evm.jobStatus, submit: evm.submit, lockSpent: evm.lockSpentFn, findClaim: evm.findClaim, lockNullifier: pool.nullifier };
  const uEvmCtx = { now: evm.now, lockPosition: evm.lockPosition, recipient: uEvm.recipient, claimOp: uEvm.claimOp, submit: evm.submit, claimStatus: evm.jobStatus };
  const lEvmCtx = { ...base, lockOp: lEvm.lockOp, refundOp: lEvm.refundOp, refundKey: lEvm.refundKey, available: lEvm.available };

  const quote = { id: 'q1', btcAsset: X.SATS_ASSET, btcValue: SATS, evmAsset: ASSET, evmAmount: OUT, validUntil: clock.now() + 3600 };
  const offers = new Map();
  const w = { clock, btc, evm, quote, calls, down, takeIds, market, uW, lW, stranger, uKeys, lKeys, uBtc, lBtc, uEvmCtx, userStore: memStore(), lpStore: memStore(), lpUp: true, userUp: true, tamper: null };
  const toLp = { sendOffer: async (msg) => { if (!w.lpUp) throw new Error('the liquidity provider is unreachable'); return w.lpEl.receive(w.tamper ? w.tamper(msg) : msg); }, getEvmOffer: async (id) => offers.get(id) || null };
  const toUser = { publishEvmOffer: async (id, o) => { offers.set(id, o); } };
  w.toLp = toLp;
  const blPolicy = { csvBlocks: CSV, minClaimSecs: 3600, offerWaitSecs: 2 * 3600, maxEvmWindowSecs: 6 * 3600 };
  w.blPolicy = blPolicy;
  const elPolicy = { minCsv: 72, minConfsFor: () => confs, evmWindowSecs: 4 * 3600, minClaimSecs: 3600, claimSlackSecs: 7200, minAmount: 20_000, maxAmount: 10_000_000, roundSecs: 600, ...lpOver };
  w.boot = () => {
    w.userBl = makeBitcoinLocker({ seed: uKeys.seed, now: clock.now, policy: blPolicy, store: w.userStore, btc: uBtc, evm: uEvmCtx, counter: toLp });
    w.lpEl = makeEthereumLocker({ seed: lKeys.seed, now: clock.now, policy: elPolicy, store: w.lpStore, quotes: { get: async (id) => (id === quote.id ? quote : null) }, btc: lBtc, evm: lEvmCtx, counter: toUser });
  };
  w.boot();
  w.user = async () => (await w.userStore.list())[0];
  w.lp = async () => (await w.lpStore.list())[0];
  w.start = (over = {}) => w.userBl.start({ asset: hexToBytes(X.SATS_ASSET), amount: SATS, counterClaimPub: lW.wallet.pub, evmAsset: ASSET, evmAmount: OUT, quoteId: quote.id, ...over });
  w.step = async () => {
    if (w.userUp) for (const r of await w.userStore.list()) await w.userBl.step(r);
    if (w.lpUp) for (const r of await w.lpStore.list()) await w.lpEl.step(r);
    evm.process();
  };
  let ticks = 0;
  w.run = async (until, max = 2000) => {
    for (let i = 0; i < max; i++) {
      if (await until()) return i;
      await w.step();
      clock.advance(60); ticks++;
      if (ticks % 10 === 0) btc.mine(1, { advance: false });
    }
    throw new Error('did not finish: user ' + JSON.stringify(await w.user()).slice(0, 500) + ' lp ' + JSON.stringify(await w.lp()).slice(0, 500));
  };
  w.poolHolds = (leaf) => evm.notes.leaves.some((l) => bytesToHex(l) === strip(leaf));
  w.lockOf = (rec, claimerPub = lW.wallet.pub) => deriveLock({
    prims: uW.prims, claimerPub, T: X.deriveSwapSecrets({ seed: uKeys.seed, swapId: hexToBytes(rec.id) }).T, lockerXonly: uW.prims.wallet.xonly(), csvBlocks: CSV,
  });
  return w;
}
const p2wpkh = (w) => bytesToHex(w.prims.p2wpkhScript(w.prims.wallet.pub));

test('sats for a pool asset: the user ends with the pool note and the LP with the sats, one lock and one take, and the LP needed no coin, no note and no validator', async () => {
  const w = satsWorld();
  const rec = await w.start();
  assert.equal(rec.lock.commitHex, null, 'the lock is one ordinary transaction');
  assert.equal(rec.noteInputs.length, 0);
  assert.equal(rec.feeInputs.length, 1, 'the coin that funded it is held by the swap');

  // halfway: the LP has locked on the pool and the user has not claimed, so t is secret and the sats are still locked
  await w.run(async () => (await w.lp())?.phase === 'offered');
  assert.equal(w.btc.spends.get(`${rec.lock.txid}:0`), undefined, 'the lock is unspent while t is secret');
  assert.deepEqual(w.evm.submitted.map((j) => j.type), ['adaptorlock']);

  await w.run(async () => (await w.user())?.phase === 'done' && (await w.lp())?.phase === 'done');
  const user = await w.user(), lp = await w.lp();

  // Bitcoin: the LP's take is one key-path spend of the lock, paying its own address the sats less its fee
  assert.equal(lp.take.commitTxid, null);
  assert.equal(lp.take.bumps, 0, 'a take that confirms is never replaced');
  assert.equal(lp.take.feeRate, Math.ceil(3 * 1.5), 'and it starts above the explorers\' estimate, which is 3 sat/vB here');
  assert.equal(user.takenBy, lp.take.txid, 'the user saw the LP take the lock');
  assert.equal(w.btc.spends.get(`${rec.lock.txid}:0`), lp.take.txid);
  const take = await w.btc.fetchTx(lp.take.txid);
  assert.equal(take.vout.length, 1);
  assert.equal(take.vout[0].scriptpubkey, p2wpkh(w.lW), 'to the LP\'s own address');
  const fee = Number(SATS) - take.vout[0].value;
  assert.ok(fee > 0 && fee < 2000, `the fee (${fee} sats) comes out of the lock output`);
  assert.equal(take.vin[0].witness.length, 1);
  assert.equal(take.vin[0].witness[0].length, 128, 'a 64-byte Schnorr signature');
  assert.equal(w.btc.broadcasts.length, 2, 'the lock and the take, and no commit transaction');
  assert.equal(lp.lockValue, Number(SATS));
  const onChainHint = (await w.btc.fetchTx(rec.lock.txid)).vout[1].scriptpubkey;
  assert.equal(onChainHint.length, 90, 'the lock\'s recovery hint is 45 bytes');
  assert.ok(!onChainHint.includes('54585331'), 'and carries no TXS1 marker: nothing on the chain says this is a Tacit lock');
  // the take is exactly the spend of the lock that t opens, at the rate asked for: a signature is deterministic, so the same inputs give the same transaction
  const sec = X.deriveSwapSecrets({ seed: w.uKeys.seed, swapId: hexToBytes(rec.id) });
  const lock = w.lockOf(rec);
  const expected = makeAdaptorBtcTx({ prims: w.lW.prims }).claimSats({
    lockOut: { txid: rec.lock.txid, vout: 0, value: Number(SATS) }, lock, sk: claimSecret({ dClaimer: w.lW.prims.wallet.priv, t: sec.t, lock }), feeRate: 3,
  });
  assert.equal(lp.take.txid, expected.revealTxid, 'the take is the spend of the lock with t');

  // Ethereum: the user holds the pool note of the payout (not of the sats), under one lock that was claimed once
  const O = pool.commitXY(OUT, '0x' + bytesToHex(bigintToBytes32(sec.rOut)));
  assert.ok(w.poolHolds(pool.leaf(ASSET, O.cx, O.cy, pool.nkToOwner(w.uKeys.nkOut))), 'the user\'s note is in the pool');
  assert.equal(user.amount, String(SATS));
  assert.equal(user.evmAmount, String(OUT));
  assert.equal(w.evm.locks.leaves.length, 1, 'one lock for one swap');
  assert.equal(w.evm.lockSpent.size, 1);
  assert.deepEqual(w.evm.submitted.map((j) => j.type), ['adaptorlock', 'adaptorclaim']);

  assert.deepEqual(w.calls, { userCoins: 1, lpCoins: 0, lpNote: 0, lpGuard: 0 }, 'the LP read no coin list, resolved no note and asked no cross-lane guard');
});

test('the LP never answers: the user\'s refund is refused by the chain until the timelock has run, and then returns the sats less the fee, with nothing on the pool', async () => {
  const w = satsWorld();
  w.lpUp = false;
  const rec = await w.start();
  await w.run(async () => (await w.user())?.phase === 'broadcast' && (await w.btc.status(rec.lock.txid)).confirmations > 0);
  const early = w.uBtc.tx.refundSats({ lockOut: { txid: rec.lock.txid, vout: 0, value: rec.lock.value }, lock: w.lockOf(rec), dLocker: w.uW.prims.wallet.priv, feeRate: 3 });
  await assert.rejects(() => w.uBtc.broadcast(early), /non-BIP68-final/, 'consensus refuses a refund before the lock is 144 blocks old');

  await w.run(async () => (await w.user())?.phase === 'refunded');
  const user = await w.user();
  assert.ok(w.btc.tip >= user.lockHeight + CSV - 1, 'not before the timelock');
  assert.equal(user.refund.commitTxid, null);
  assert.equal(w.btc.spends.get(`${rec.lock.txid}:0`), user.refund.txid);
  assert.equal(user.refund.txid, early.revealTxid, 'the refund is the one the key and the chain alone make, to the byte');
  const refund = await w.btc.fetchTx(user.refund.txid);
  assert.equal(refund.vout[0].scriptpubkey, p2wpkh(w.uW), 'back to the user\'s own address');
  const fee = Number(SATS) - refund.vout[0].value;
  assert.ok(fee > 0 && fee < 2000, `less a fee of ${fee} sats`);
  assert.equal(refund.vin[0].witness.length, 3, 'the script path: signature, leaf, control block');
  assert.equal(w.evm.locks.leaves.length, 0, 'nothing was ever locked on the pool');
  assert.deepEqual(w.evm.submitted, []);
  assert.equal(w.calls.userCoins, 1, 'the refund needed no coin of the user\'s');
});

test('the user goes silent after the LP has locked: the LP\'s pool lock refunds at its deadline, the user\'s sats come back by timelock, and neither side loses', async () => {
  const w = satsWorld();
  const rec = await w.start();
  await w.run(async () => (await w.lp())?.phase === 'offered');       // the LP has locked and published its offer
  w.userUp = false;
  await w.run(async () => (await w.lp())?.phase === 'refunded');
  assert.deepEqual(w.evm.submitted.map((j) => j.type), ['adaptorlock', 'adaptorrefund'], 'the LP\'s note came back from the pool lock');
  assert.equal((await w.lp()).take, undefined, 'the LP took no sats: it never learned t');
  assert.equal(w.btc.spends.get(`${rec.lock.txid}:0`), undefined, 'and the sats are still locked to the user\'s refund');

  w.userUp = true;                                                     // the user comes back after the pool deadline: it does not claim (that would publish t late)
  await w.run(async () => (await w.user())?.phase === 'refunded');
  const user = await w.user();
  assert.match(user.why, /too little time left to claim/);
  assert.deepEqual(w.evm.submitted.map((j) => j.type), ['adaptorlock', 'adaptorrefund'], 'no claim was sent');
  assert.equal(w.btc.spends.get(`${rec.lock.txid}:0`), user.refund.txid);
});

test('a lock that holds less than the offer says is refused by what the LP reads from the chain, nothing is locked on the pool, and the user\'s timelock returns the sats', async () => {
  const w = satsWorld();
  // the user locks 90,000 and says 100,000 (the quote), so only the chain read shows it
  w.tamper = (msg) => ({ ...msg, offer: { ...msg.offer, btc: { ...msg.offer.btc, value: String(SATS) } } });
  await w.start({ amount: 90_000n });
  await w.run(async () => (await w.user())?.phase === 'refund-wait');
  const user = await w.user();
  assert.match(user.why, /does not hold the quoted amount of sats/);
  assert.equal(await w.lp(), undefined, 'the LP kept no record of it');
  assert.deepEqual(w.evm.submitted, []);
  await w.run(async () => (await w.user())?.phase === 'refunded');
  assert.equal(w.evm.locks.leaves.length, 0);
});

test('a lock keyed to someone else\'s key is refused, and the user\'s timelock returns the sats', async () => {
  const w = satsWorld();
  const rec = await w.start({ counterClaimPub: w.stranger.wallet.pub });
  assert.notEqual(bytesToHex(w.lockOf(rec).spk), bytesToHex(w.lockOf(rec, w.stranger.wallet.pub).spk), 'the lock is not the one the LP would make');
  await w.run(async () => (await w.user())?.phase === 'refund-wait');
  assert.match((await w.user()).why, /not keyed to my claim key/);
  assert.equal(await w.lp(), undefined);
  assert.deepEqual(w.evm.submitted, []);
  await w.run(async () => (await w.user())?.phase === 'refunded');
});

test('an offer that names a note\'s asset for a quote of sats is refused on the quote, before the output is read as a note', async () => {
  const w = satsWorld();
  w.tamper = (msg) => ({ ...msg, offer: { ...msg.offer, btc: { ...msg.offer.btc, asset: 'ab'.repeat(32), rLock: bytesToHex(bigintToBytes32(scalar('blinding'))) } } });
  await w.start();
  await w.run(async () => (await w.user())?.phase === 'refund-wait');
  assert.match((await w.user()).why, /the Bitcoin side differs from the quote/);
  assert.equal(await w.lp(), undefined);
  assert.deepEqual(w.evm.submitted, []);
  assert.equal(w.calls.lpNote, 0, 'no note was resolved on the word of the offer');
});

test('both machines restart in the middle of a swap, from their stores alone, and the swap completes once', async () => {
  const w = satsWorld();
  const rec = await w.start();
  await w.run(async () => (await w.lp())?.phase === 'offered');
  w.boot();                                                            // new machines over the same stores
  await w.run(async () => (await w.user())?.phase === 'claiming');
  w.boot();
  await w.run(async () => (await w.user())?.phase === 'done' && (await w.lp())?.phase === 'done');
  assert.equal(w.btc.broadcasts.length, 2);
  assert.equal(w.evm.locks.leaves.length, 1);
  assert.deepEqual(w.evm.submitted.map((j) => j.type), ['adaptorlock', 'adaptorclaim']);
  assert.equal(w.btc.spends.get(`${rec.lock.txid}:0`), (await w.lp()).take.txid);
});

test('explorers refuse the LP\'s take for a while: the take it built is kept, sent again and lands once, and is not built again', async () => {
  const w = satsWorld();
  const rec = await w.start();
  await w.run(async () => (await w.lp())?.phase === 'taking');
  w.down.lp = true;
  await w.run(async () => (await w.lp())?.take != null);
  const built = (await w.lp()).take;
  await w.run(async () => w.clock.now() - built.at > 1200);          // well past the ten minutes after which a take whose commit was lost is built again
  const held = await w.lp();
  assert.equal(held.phase, 'taking');
  assert.equal(held.take.txid, built.txid, 'the same transaction, not a new one');
  assert.equal(held.takeRebuilds, undefined, 'a take with no commit has no funding coin to be spent elsewhere, so it is never rebuilt');
  assert.match(held.lastError, /every explorer refused/);
  w.down.lp = false;
  await w.run(async () => (await w.lp())?.phase === 'done');
  assert.equal(w.btc.spends.get(`${rec.lock.txid}:0`), built.txid);
  assert.equal(w.btc.broadcasts.length, 2);
});

test('explorers refuse the user\'s refund for a while: the refund it built is kept and sent again, and is not built again', async () => {
  const w = satsWorld();
  w.lpUp = false;
  const rec = await w.start();
  await w.run(async () => (await w.user())?.phase === 'broadcast');
  w.down.user = true;
  await w.run(async () => (await w.user())?.refund != null);
  const built = (await w.user()).refund;
  await w.run(async () => w.clock.now() - built.at > 1200);
  const held = await w.user();
  assert.equal(held.phase, 'refund-wait');
  assert.equal(held.refund.txid, built.txid);
  assert.equal(held.refundRebuilds, undefined, 'a refund with no commit is never rebuilt');
  assert.match(held.lastError, /every explorer refused/);
  w.down.user = false;
  await w.run(async () => (await w.user())?.phase === 'refunded');
  assert.equal(w.btc.spends.get(`${rec.lock.txid}:0`), built.txid);
});

test('a take that is too cheap to be mined is replaced by one that pays more, again and again, and the swap ends on whichever lands, once', async () => {
  const w = satsWorld();
  w.btc.rbf = true;
  w.btc.holdBack = (id, rate) => w.takeIds.has(id) && rate < 20;        // the market has moved above what the first takes pay
  const rec = await w.start();
  await w.run(async () => (await w.lp())?.phase === 'done');
  const lp = await w.lp();
  assert.ok(lp.take.bumps >= 3, `the take was replaced ${lp.take.bumps} times`);
  assert.equal(lp.takes.length, lp.take.bumps + 1, 'every take it made is kept');
  assert.equal(w.btc.replaced.length, lp.take.bumps, 'and each one that was replaced is gone from the mempool');
  assert.equal(w.btc.spends.get(`${rec.lock.txid}:0`), lp.take.txid, 'the lock was spent by the last take');
  assert.ok(lp.take.feeRate >= 20, 'which pays at least what the market asks');
  const fees = lp.takes.map((id) => w.btc.txs.get(id)).filter(Boolean);
  assert.equal(fees.length, 1, 'only one take is on the chain');
  const spentBy = await w.btc.fetchTx(lp.take.txid);
  assert.ok(Number(SATS) - spentBy.vout[0].value <= Number(SATS) / 2, 'and the fee stays under the share of the lock that the policy allows');
  assert.deepEqual(w.evm.submitted.map((j) => j.type), ['adaptorlock', 'adaptorclaim']);
});

test('when the market is so quiet that the wallet\'s fee floor sets the fee, a take is still raised until it pays more, and lands once the market has moved', async () => {
  const w = satsWorld();
  w.market.feeNow = 1;                                                     // the floor (500 sats) is above what the rate gives
  w.btc.rbf = true;
  w.btc.holdBack = (id, rate) => w.takeIds.has(id) && rate < 12;
  await w.start();
  await w.run(async () => (await w.lp())?.phase === 'done');
  const lp = await w.lp();
  assert.ok(lp.take.bumps >= 2, `replaced ${lp.take.bumps} times`);
  const feesPaid = lp.takes.map((id) => id);
  assert.equal(feesPaid.length, lp.take.bumps + 1);
  assert.ok(lp.take.fee > 500, 'the last take pays more than the floor');
});

test('a take that lands as an earlier one while its replacement is refused still ends the swap', async () => {
  const w = satsWorld();
  w.btc.rbf = false;                                                       // the node refuses to replace: the earlier take is the one that can confirm
  let release = false;
  w.btc.holdBack = (id) => !release && w.takeIds.has(id);                  // no take is mined until released
  await w.start();
  await w.run(async () => (await w.lp())?.take != null && (await w.lp()).take.bumps >= 1);   // a replacement was built, and no node would take it
  release = true;                                                          // now the first take is mined
  await w.run(async () => (await w.lp())?.phase === 'done');
  const lp = await w.lp();
  assert.ok(lp.takes.length >= 2);
  assert.equal(w.btc.spends.get(`${(await w.user()).lock.txid}:0`), lp.takes[0], 'the first take is the one on the chain');
  assert.notEqual(lp.take.txid, lp.takes[0], 'while the record\'s current take is a later one');
});

test('the fee a take may pay is capped, and the bumping stops there instead of spending the lock on fees', async () => {
  const w = satsWorld({ lp: { takeMaxFeeShare: 0.02 } });                  // at most 2% of the lock: 2,000 sats
  w.btc.rbf = true;
  w.btc.holdBack = (id) => w.takeIds.has(id);                              // nothing the LP can pay is enough
  await w.start();
  await w.run(async () => ((await w.lp())?.take?.bumps ?? 0) >= 8, 600);   // 8 is where it gives up, by its count or by the cap
  const lp = await w.lp();
  assert.equal(lp.take.fee, 2000, 'the fee stops at the share of the lock the policy allows');
  const last = await w.btc.fetchTx(lp.take.txid);
  assert.equal(last.vout[0].value + lp.take.fee, Number(SATS), 'and what is left is still the lock less that fee');
  const n = lp.takes.length;
  for (let i = 0; i < 60; i++) { await w.step(); w.clock.advance(60); }
  assert.equal((await w.lp()).takes.length, n, 'no more takes are made once the cap holds');
  assert.notEqual((await w.lp()).phase, 'done');
});

test('the user\'s refund lands first because the LP could not send its take for hours: the LP is told it lost, not that it took', async () => {
  const w = satsWorld();
  const rec = await w.start();
  await w.run(async () => (await w.lp())?.phase === 'taking');
  w.down.lp = true;                                                        // every explorer refuses the LP until long after the timelock
  await w.run(async () => (await w.lp())?.phase === 'lost');
  const lp = await w.lp(), user = await w.user();
  assert.match(lp.why, /spent by another transaction/);
  assert.equal(w.btc.spends.get(`${rec.lock.txid}:0`), user.refund?.txid ?? user.takenBy, 'the lock went back to the user, who had also claimed on the pool');
  assert.ok(!lp.takes.includes(w.btc.spends.get(`${rec.lock.txid}:0`)));
  assert.equal(w.evm.lockSpent.size, 1, 'and the pool lock was claimed: this is the loss a stuck take costs, which is why it is replaced and watched');
});

test('a sats lock the browser has no record of is found again from the key, and taken back on its timelock', async () => {
  const w = satsWorld();
  w.lpUp = false;
  const rec = await w.start();
  await w.run(async () => !!(await w.user())?.confirmedAt);
  const fresh = memStore();
  const fb = makeFastBridgeClient({ lp: w.toLp, btc: w.uBtc, evm: w.uEvmCtx, store: fresh, seed: w.uKeys.seed, policy: w.blPolicy, now: w.clock.now });
  assert.deepEqual(await fb.records(), []);
  const found = await fb.recover();
  assert.equal(found.length, 1, 'a lock with one input and no commit is found');
  assert.equal(found[0].id, rec.id);
  assert.equal(found[0].recovered, true);
  const stored = (await fresh.list())[0];
  assert.equal(stored.asset, X.SATS_ASSET);
  assert.equal(stored.amount, String(SATS));
  assert.deepEqual(stored.noteInputs, []);
  assert.equal((await fb.recover()).length, 0, 'the second look finds nothing new');
  const expected = w.uBtc.tx.refundSats({ lockOut: { txid: rec.lock.txid, vout: 0, value: rec.lock.value }, lock: w.lockOf(rec), dLocker: w.uW.prims.wallet.priv, feeRate: 3 });
  w.btc.mine(143);
  for (let i = 0; i < 40 && (await fresh.list())[0].phase !== 'refunded'; i++) { await fb.tick(); w.btc.mine(1); w.clock.advance(60); }
  const done = (await fresh.list())[0];
  assert.equal(done.phase, 'refunded');
  assert.equal(done.refund.txid, expected.revealTxid, 'by the refund the key and the chain alone make, to the byte');
  assert.equal(w.btc.spends.get(`${rec.lock.txid}:0`), expected.revealTxid);
});

test('a swap of sats refuses what it cannot build: an amount too small to claim or refund, and too few sats in the wallet', async () => {
  const w = satsWorld();
  await assert.rejects(() => w.start({ amount: 19_999n }), /holds at least 20000 sats/);
  await assert.rejects(() => w.start({ amount: 300_000n }), /not enough sats for the lock/);
  assert.equal((await w.userStore.list()).length, 0, 'nothing was kept');
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${ran} sats swap checks passed`);
process.exit(process.exitCode || 0);
