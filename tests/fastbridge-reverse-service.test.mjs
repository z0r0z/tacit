// The reverse direction (Ethereum -> Bitcoin) as a provider and a user: dapp/fastbridge-reverse-provider.js, which sells TAC it holds on Bitcoin, and
// dapp/fastbridge-reverse-client.js, which sends private TAC from the pool. They talk through the provider's own routes (`handle`), in the simulated Bitcoin
// and pool of tests/fastbridge-sim.test.mjs on one virtual clock, with the same machines as the other direction. Unlike tests/fastbridge-reverse.test.mjs
// (which runs the machines alone, with equal amounts), the amounts here differ by the provider's fee, as a real swap's do.
//   node tests/fastbridge-reverse-service.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import * as X from '../dapp/adaptor-xswap.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx, tacitKit } from '../dapp/adaptor-btc-tx.js';
import { makeReverseService } from '../dapp/fastbridge-reverse-provider.js';
import { makeReverseClient, makeReverseCounter } from '../dapp/fastbridge-reverse-client.js';
import { bigintToBytes32 } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { tacit, te, scalar, etchNote, fetched } from './lib/btc-sim.mjs';
import { makeClock, makeBitcoinSim, makeEvmSim, makeEvmParty, partyKeys, pool, sha256, ASSET } from './lib/chain-sim.mjs';
import { memStore, VALUE } from './lib/fastbridge-world.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const SEND = 3000n;                                   // what the user sends; the provider keeps 30 bps and 200 of it: 209, so the user takes 2,791

// The provider (a service over a Bitcoin note of 5,000), a user (private TAC of exactly what it sends), and each side's records.
function world({ funded = true, maxOpen = 2, maxLocked = null, confs = 1, notes = 1 } = {}) {
  const clock = makeClock(), btc = makeBitcoinSim(clock), evm = makeEvmSim(clock), kit = tacitKit(tacit);
  const wallet = (name) => makeBtcWallet({ priv: bigintToBytes32(scalar(name + '/btc-wallet')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 });
  const uW = wallet('user'), lW = wallet('lp'), uKeys = partyKeys('user'), lKeys = partyKeys('lp');
  const uEvm = makeEvmParty({ evm, keys: uKeys, clock }), lEvm = makeEvmParty({ evm, keys: lKeys, clock });
  if (funded) uEvm.fund(SEND, 'inv0');
  // the provider's Bitcoin TAC: `notes` notes of 5,000 at its address (etched by one signer, so one asset)
  const inventory = [];
  let etch = null;
  for (let i = 0; i < notes; i++) {
    const r = scalar('lp/note' + i);
    const e = etchNote({ ticker: 'TP', value: VALUE, r, script: lW.prims.p2wpkhScript(lW.wallet.pub), signerD: scalar('etcher') });
    btc.addConfirmed(e);
    if (!etch) etch = e;
    inventory.push({ txid: e.txid, vout: 0, value: 546, amount: VALUE, blinding: r });
  }
  let coinN = 0;
  const sats = () => [{ txid: bytesToHex(sha256(te('coin/' + coinN++))), vout: 0, value: 200_000 }];
  const uBtc = btc.adapter({ prims: uW.prims, builder: makeAdaptorBtcTx({ prims: uW.prims, kit }), sats });
  const lBtc = btc.adapter({ prims: lW.prims, builder: makeAdaptorBtcTx({ prims: lW.prims, kit }), sats });
  const base = { now: evm.now, lockPosition: evm.lockPosition, jobStatus: evm.jobStatus, submit: evm.submit, lockSpent: evm.lockSpentFn, findClaim: evm.findClaim, lockNullifier: pool.nullifier };
  const lBlEvm = { now: evm.now, lockPosition: evm.lockPosition, recipient: lEvm.recipient, claimOp: lEvm.claimOp, submit: evm.submit, claimStatus: evm.jobStatus };
  const uElEvm = { ...base, lockOp: uEvm.lockOp, refundOp: uEvm.refundOp, refundKey: uEvm.refundKey, available: uEvm.available };
  const w = { clock, btc, evm, etch, uW, lW, uKeys, lKeys, uEvm, lEvm, uBtc, lBtc, inventory, stores: {} };
  const mk = () => ({ swaps: w.stores.swaps ||= memStore(), quotes: w.stores.quotes ||= memStore(), offers: w.stores.offers ||= memStore(), evmOffers: w.stores.evmOffers ||= memStore() });
  w.makeService = () => makeReverseService({
    seed: lKeys.seed, btc: lBtc, evm: lBlEvm, ...mk(), inventory: { notes: async () => inventory }, now: clock.now,
    config: { quote: { btcAsset: bytesToHex(etch.asset), evmAsset: ASSET, minAmount: 1000n, maxAmount: 1_000_000n, feeBps: 30, flatFee: 200n, validSecs: 600 }, csvBlocks: 144, evmWindowSecs: 4 * 3600, maxOpen, maxLocked, minConfsFor: () => confs, refreshSecs: 0 },
  });
  w.service = w.makeService();
  w.call = async (method, path, body) => { const r = await w.service.handle({ method, path, body }); return { status: r.status, body: r.body }; };
  w.lp = makeReverseCounter(w.call);
  w.quoteStore = memStore();
  w.client = makeReverseClient({ lp: w.lp, btc: uBtc, evm: uElEvm, store: memStore(), quoteStore: w.quoteStore, seed: uKeys.seed, now: clock.now, policy: { startGraceSecs: 6 * 3600 } });
  let ticks = 0;
  w.step = async () => { await w.service.tick(); await w.client.pump(); evm.process(); };
  w.run = async (until, max = 2000) => {
    for (let i = 0; i < max; i++) {
      if (await until()) return i;
      await w.step();
      clock.advance(60); ticks++;
      if (ticks % 10 === 0) btc.mine(1, { advance: false });
    }
    throw new Error('did not finish');
  };
  w.lpSwap = async () => (await w.stores.swaps.list())[0];
  w.userSwap = async () => (await w.client.records())[0];
  return w;
}
const claimPubOf = (w) => bytesToHex(w.uW.wallet.pub);

test('Ethereum -> Bitcoin through the provider and the user: the amounts differ by the provider\'s fee, a stranger\'s offer is refused, a restart in the middle changes nothing, and each ends with what it should', async () => {
  const w = world();
  const info = await w.lp.info();
  assert.deepEqual([info.direction, info.minAmount, info.maxAmount, info.feeBps, info.flatFee, info.maxOpen, info.open], ['out', '1000', '1000000', 30, '200', 2, 0]);
  assert.equal(info.available, '5215', 'the most a user can send for the 5,000-note: 5,215 less its fee (15 and 200) is exactly 5,000');
  const qt = await w.client.quote(SEND);
  assert.deepEqual([qt.evmAmount, qt.btcValue, qt.fee], [SEND, 2791n, 209n]);
  assert.equal(qt.highFee, true, '209 of 3,000 is 7%, over the 5% the page flags: said, and still quoted');
  const { swapId } = await w.client.start({ quote: qt });
  assert.match(swapId, /^[0-9a-f]{72}$/);
  assert.equal((await w.client.start({ quote: qt })).swapId, swapId, 'asking again for the same quote is the same swap');
  // a stranger who learns the swap id cannot send the swap to its refund with an offer that is not the user's
  const bogus = await w.call('POST', `/reverse/swap/${swapId}/evm-offer`, { evmOffer: { lockLeaf: '11'.repeat(32), deadline: 1, presign: {} } });
  assert.equal(bogus.body.ok, false); assert.match(bogus.body.why, /not in the pool yet/);
  const wrong = await w.call('POST', `/reverse/swap/${swapId}/evm-offer`, { evmOffer: 'x' });
  assert.equal(wrong.body.ok, false);
  // a restart of the provider between the lock and the offer: the records and the offers are in the stores
  let restarted = false;
  await w.run(async () => {
    const l = await w.lpSwap();
    if (l && l.phase === 'offered' && !restarted) { restarted = true; w.service = w.makeService(); await w.service.start(); }
    return l && l.phase === 'done' && (await w.userSwap())?.phase === 'done';
  });
  assert.ok(restarted, 'the provider was restarted mid-swap');
  const lp = await w.lpSwap(), user = await w.userSwap();
  assert.equal(lp.amount, '2791'); assert.equal(lp.evmAmount, '3000', 'the provider locked 2,791 on Bitcoin for 3,000 in the pool');
  assert.ok(user.takeTxid, 'the user took the Bitcoin lock');
  assert.ok(await w.btc.resolveNote(user.takeTxid, 0), 'the user\'s Bitcoin note is valid, by the real note validator');
  const sec = X.deriveSwapSecrets({ seed: w.lKeys.seed, swapId: hexToBytes(swapId) });
  const O = pool.commitXY(SEND, '0x' + bytesToHex(bigintToBytes32(sec.rOut)));
  assert.ok(w.evm.notes.leaves.some((l) => bytesToHex(l) === strip(pool.leaf(ASSET, O.cx, O.cy, pool.nkToOwner(w.lKeys.nkOut)))), 'the provider\'s 3,000 are in the pool');
  assert.equal(w.evm.locks.leaves.length, 1); assert.equal(w.evm.lockSpent.size, 1);
  assert.deepEqual(w.evm.submitted.map((j) => j.type), ['adaptorlock', 'adaptorclaim']);
  const after = await w.lp.info();
  assert.equal(after.open, 0, 'nothing is open any more');
});

test('what the provider refuses, in words: a key that is not a key, an amount out of its range or that does not cover the fee, one it has no TAC for, a quote it does not know or that ran out', async () => {
  const w = world();
  const post = (path, body) => w.call('POST', path, body);
  const cp = claimPubOf(w);
  assert.match((await post('/reverse/quote', { amount: '3000', claimPub: 'zz' })).body.error, /compressed Bitcoin key/);
  assert.match((await post('/reverse/quote', { amount: '3000', claimPub: '02' + '00'.repeat(32) })).body.error, /not a point on the curve/);
  assert.match((await post('/reverse/quote', { amount: '999', claimPub: cp })).body.error, /between 1000 and 1000000/);
  assert.match((await post('/reverse/quote', { amount: '1000001', claimPub: cp })).body.error, /between/);
  assert.equal((await post('/reverse/quote', { amount: 'ten', claimPub: cp })).status, 400);
  assert.equal((await post('/reverse/quote', { amount: '1000', claimPub: cp })).status, 200, 'the least (1,000, less 203) is a quote');
  // more than the one note can pay out: 6,000 less its fee is 5,780, over the 5,000 held
  const big = await post('/reverse/quote', { amount: '6000', claimPub: cp });
  assert.equal(big.status, 503); assert.match(big.body.error, /no TAC on Bitcoin for that amount/); assert.equal(big.body.retry, true);
  assert.equal((await post('/reverse/start', { quoteId: 'aa'.repeat(16) })).body.why, 'unknown quote');
  assert.equal((await post('/reverse/start', {})).status, 400);
  const q = (await post('/reverse/quote', { amount: '3000', claimPub: cp })).body;
  w.clock.advance(601);
  assert.equal((await post('/reverse/start', { quoteId: q.id })).body.why, 'quote expired');
  assert.equal((await w.call('GET', '/reverse/swap/' + 'ab'.repeat(36))).status, 404);
  assert.equal((await w.call('GET', '/reverse/swap/' + 'ab'.repeat(36) + '/offer')).status, 404);
  assert.equal((await w.call('GET', '/reverse/nothing')).status, 404);
});

test('what a provider puts at stake is bounded: only so many sends at once, only so much TAC between them, and a note in a swap is not lent again', async () => {
  const w = world({ maxOpen: 2, notes: 3 });
  const cp = claimPubOf(w), ask = async (amount) => { const r = await w.call('POST', '/reverse/quote', { amount: String(amount), claimPub: cp }); return r.body; };
  const a = await ask(3000), b = await ask(3000), c = await ask(3000);
  const s1 = (await w.call('POST', '/reverse/start', { quoteId: a.id })).body, s2 = (await w.call('POST', '/reverse/start', { quoteId: b.id })).body;
  assert.equal(s1.ok, true); assert.equal(s2.ok, true); assert.notEqual(s1.swapId, s2.swapId);
  const third = (await w.call('POST', '/reverse/start', { quoteId: c.id })).body;
  assert.equal(third.ok, false); assert.equal(third.retry, true); assert.match(third.why, /all the sends it takes at once/);
  const recs = await w.stores.swaps.list();
  assert.equal(recs.length, 2);
  assert.equal(new Set(recs.flatMap((r) => r.noteInputs.map((i) => i.txid + ':' + i.vout))).size, 2, 'each swap spent a note of its own');
  assert.equal((await w.lp.info()).open, 2); assert.equal((await w.lp.info()).available, '0', 'nothing can be sent while two are open');
  assert.match((await w.call('POST', '/reverse/quote', { amount: '3000', claimPub: cp })).body.error, /all the sends it takes at once/, 'and no quote is given for one');
  // a ceiling on the TAC out at once: two notes, room for one swap's 2,791
  const v = world({ maxOpen: 5, maxLocked: 3000n, notes: 3 });
  const x = (await v.call('POST', '/reverse/quote', { amount: '3000', claimPub: claimPubOf(v) })).body, y = (await v.call('POST', '/reverse/quote', { amount: '3000', claimPub: claimPubOf(v) })).body;
  assert.equal((await v.call('POST', '/reverse/start', { quoteId: x.id })).body.ok, true);
  const over = (await v.call('POST', '/reverse/start', { quoteId: y.id })).body;
  assert.equal(over.ok, false); assert.match(over.why, /all the TAC it puts out at once/);
  assert.equal((await v.lp.info()).available, '0', 'what is left under the ceiling (3,000 less the 2,791 out, so 209) is under what the least send would pay out (797)');
});

test('the user\'s side refuses a quote that is not for it: another key, a different amount, a payout over the amount, a timelock out of range, an expired quote, a fee over the limit, a key it did not pin', async () => {
  const w = world();
  const cp = claimPubOf(w), real = await w.lp.quote({ amount: SEND, claimPub: cp });
  const via = (patch, pins) => makeReverseClient({ lp: { quote: async () => ({ ...real, ...patch }) }, btc: w.uBtc, evm: { available: async () => SEND }, store: memStore(), quoteStore: memStore(), seed: w.uKeys.seed, now: w.clock.now, pins });
  assert.equal((await via({}).quote(SEND)).btcValue, 2791n, 'the real one passes');
  const cases = [
    [{ claimPub: '02' + 'ab'.repeat(32) }, /another key/], [{ id: 7 }, /not readable/], [{ evmAmount: '3001' }, /different amount/], [{ btcValue: '3001' }, /payout is out of range/],
    [{ btcValue: '0' }, /payout is out of range/], [{ csvBlocks: 10 }, /timelock is out of range/], [{ csvBlocks: 5000 }, /timelock is out of range/], [{ validUntil: w.clock.now() + 30 }, /expires too soon/],
    [{ btcValue: '100' }, /fee is above the limit/], [{ takeSats: 100 }, /Bitcoin fee is out of range/], [{ takeSats: 99999 }, /Bitcoin fee is out of range/], [{ lockerXonly: 'zz' }, /not readable/], [{ btcValue: 'ten' }, /not a number/],
  ];
  for (const [patch, re] of cases) await assert.rejects(() => via(patch).quote(SEND), re, JSON.stringify(patch));
  await assert.rejects(() => via({}, { lockerPub: '02' + 'cd'.repeat(32) }).quote(SEND), /key is not the one this page expects/);
  await assert.rejects(() => via({}, { btcAsset: 'cd'.repeat(32) }).quote(SEND), /asset is not the one this page expects/);
  assert.equal((await via({ btcValue: String(SEND - (SEND * 8n) / 100n) }).quote(SEND)).highFee, true, 'a fee over 5% is quoted and flagged');
  // a user who does not hold the TAC is stopped before the provider is asked to lock anything
  const poor = makeReverseClient({ lp: { quote: async () => real, start: async () => { throw new Error('the provider must not be asked'); } }, btc: w.uBtc, evm: { available: async () => SEND - 1n }, store: memStore(), quoteStore: memStore(), seed: w.uKeys.seed, now: w.clock.now });
  const pq = await poor.quote(SEND);
  await assert.rejects(() => poor.start({ quote: pq }), /private TAC does not cover that amount/);
});

test('the user who starts and then never completes costs the provider only its timelock: the provider takes its Bitcoin note back, and nothing is locked on the pool', async () => {
  const w = world();
  const qt = await w.client.quote(SEND);
  await w.client.start({ quote: qt });
  // the user goes away: only the provider's side runs, until its timelock has run and its note is back
  let lp = await w.lpSwap();
  for (let i = 0; i < 2500 && lp.phase !== 'refunded'; i++) {
    await w.service.tick(); w.evm.process(); w.clock.advance(60);
    if ((i + 1) % 10 === 0) w.btc.mine(1, { advance: false });
    lp = await w.lpSwap();
  }
  assert.equal(lp.phase, 'refunded'); assert.ok(lp.refund && lp.refund.txid);
  assert.ok(await w.btc.resolveNote(lp.refund.txid, 0), 'the note that came back is valid');
  assert.equal(w.evm.locks.leaves.length, 0, 'the user locked nothing');
  assert.equal(await w.uEvm.available(), SEND, 'and its private TAC is untouched');
  assert.equal((await w.lp.info()).open, 0, 'the provider has its room again');
});

test('a lock offer that is not by the provider\'s key is not taken on: no swap is started on it and the user locks nothing', async () => {
  const w = world();
  const real = w.lp.getOffer;
  w.lp.getOffer = async (id) => { const o = await real(id); return o ? { ...o, btc: { ...o.btc, lockerXonly: 'ab'.repeat(32) } } : o; };
  const qt = await w.client.quote(SEND);
  await w.client.start({ quote: qt });
  await w.run(async () => (await w.quoteStore.get(qt.id)).settled === true);
  const kept = await w.quoteStore.get(qt.id);
  assert.match(kept.gaveUp, /not by the provider's key/);
  assert.deepEqual(await w.client.records(), [], 'no swap was started on it');
  assert.equal(w.evm.locks.leaves.length, 0, 'nothing was locked on the pool');
  assert.equal(await w.uEvm.available(), SEND, 'the user\'s private TAC is untouched');
});

const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  if (ONLY && !ONLY.test(name)) continue;
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${ran} reverse service checks passed`);
process.exit(process.exitCode || 0);
