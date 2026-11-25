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
import { pairWorld, UNITS } from './lib/pair-world.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const SEND = 3000n;                                   // what the user sends; the provider keeps 30 bps and 200 of it: 209, so the user takes 2,791

// The provider (a service over a Bitcoin note of 5,000), a user (private TAC of exactly what it sends), and each side's records.
function world({ funded = true, maxOpen = 2, maxLocked = null, confs = 1, notes = 1, sameAsset = false, config: over = {} } = {}) {
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
  const lBlEvm = { now: evm.now, lockPosition: evm.lockPosition, recipient: lEvm.recipient, claimOp: lEvm.claimOp, submit: evm.submit, claimStatus: evm.jobStatus , findClaim: evm.findClaim, lockNullifier: pool.nullifier };
  const uElEvm = { ...base, lockOp: uEvm.lockOp, refundOp: uEvm.refundOp, refundKey: uEvm.refundKey, available: uEvm.available };
  const w = { clock, btc, evm, etch, uW, lW, uKeys, lKeys, uEvm, lEvm, uBtc, lBtc, inventory, stores: {}, alerts: [], logs: [] };
  const mk = () => ({ swaps: w.stores.swaps ||= memStore(), quotes: w.stores.quotes ||= memStore(), offers: w.stores.offers ||= memStore(), evmOffers: w.stores.evmOffers ||= memStore() });
  w.config = {
    csvBlocks: 144, evmWindowSecs: 4 * 3600, maxOpen, maxLocked, minConfsFor: () => confs, refreshSecs: 0, ...over,
    quote: { btcAsset: bytesToHex(etch.asset), evmAsset: sameAsset ? bytesToHex(etch.asset) : ASSET, minAmount: 1000n, maxAmount: 1_000_000n, feeBps: 30, flatFee: 200n, validSecs: 600, ...(over.quote || {}) },
  };
  w.makeService = (inv, config = w.config) => makeReverseService({
    seed: lKeys.seed, btc: lBtc, evm: lBlEvm, ...mk(), inventory: inv || { notes: async () => inventory }, now: clock.now,
    log: (x) => w.logs.push(x), alert: (x) => w.alerts.push(x), config,
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
const rawQuote = (w, amount = SEND) => w.call('POST', '/reverse/quote', { amount: String(amount), claimPub: claimPubOf(w) });
const rawStart = (w, quoteId) => w.call('POST', '/reverse/start', { quoteId });
async function assertTerminalAtStable(w, phase) {
  const rec = await w.lpSwap();
  assert.equal(rec.phase, phase); assert.equal(rec.terminalAt, rec.updated, 'terminalAt is the transition timestamp');
  assert.ok(Number.isInteger(rec.terminalAt));
  const terminalAt = rec.terminalAt, laterUpdated = rec.updated + 600;
  await w.stores.swaps.put({ ...rec, updated: laterUpdated, unrelated: 'later write' });
  w.service = w.makeService(); await w.service.start();
  const health = await w.service.tick();
  assert.equal(health.tickOk, true); assert.equal(health.swapsReadable, true);
  const later = await w.lpSwap();
  assert.equal(later.terminalAt, terminalAt, 'a later write and restart do not move terminalAt');
  assert.equal(later.updated, laterUpdated); assert.equal(later.unrelated, 'later write');
}

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
    if (l && l.phase === 'offered' && !restarted) {
      assert.deepEqual(l.noteInputs.map(({ txid, vout, amount }) => ({ txid, vout, amount })), [{ txid: w.inventory[0].txid, vout: 0, amount: '5000' }], 'the new record conserves the exact amount of every note input');
      restarted = true;
      await w.stores.swaps.put({ ...l, noteInputs: l.noteInputs.map(({ txid, vout }) => ({ txid, vout })) });
      w.service = w.makeService(); await w.service.start();
    }
    return l && l.phase === 'done' && (await w.userSwap())?.phase === 'done';
  });
  assert.ok(restarted, 'the provider was restarted mid-swap');
  const lp = await w.lpSwap(), user = await w.userSwap();
  assert.equal(lp.amount, '2791'); assert.equal(lp.evmAmount, '3000', 'the provider locked 2,791 on Bitcoin for 3,000 in the pool');
  assert.deepEqual(lp.noteInputs.map(({ txid, vout }) => ({ txid, vout })), [{ txid: w.inventory[0].txid, vout: 0 }], 'an active legacy record without input amounts still completes after a restart');
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

test('same-asset TAC sales enforce the proceeds floor at the raw quote and again at start with the current config', async () => {
  const w = world({ sameAsset: true, config: { minProceedsBps: 11000 } });
  const below = await rawQuote(w);
  assert.equal(below.status, 503); assert.equal(below.body.retry, true); assert.match(below.body.error, /proceeds.*11000 bps minimum/);
  assert.throws(() => w.service.price(SEND), /proceeds.*11000 bps minimum/);
  assert.deepEqual(await w.stores.swaps.list(), []);
  for (const minProceedsBps of [null, 9999, 10000.5, 1000001, '10000']) {
    assert.throws(() => w.makeService(null, { ...w.config, minProceedsBps }), /minProceedsBps must be an integer from 10000 through 1000000/);
  }

  const par = world({ sameAsset: true, config: { quote: { feeBps: 0, flatFee: 0n } } });
  assert.deepEqual(par.service.price(SEND), { evmAmount: SEND, btcValue: SEND, fee: 0n }, 'the exact par boundary passes');
  const made = await rawQuote(par), q = made.body;
  assert.equal(made.status, 200); assert.equal(q.btcValue, '3000');
  par.config.minProceedsBps = 10001;
  assert.throws(() => par.service.price(SEND), /10001 bps minimum/);
  const raised = await rawQuote(par);
  assert.equal(raised.status, 503); assert.match(raised.body.error, /10001 bps minimum/);
  const started = await rawStart(par, q.id);
  assert.equal(started.body.ok, false); assert.equal(started.body.retry, true); assert.match(started.body.why, /10001 bps minimum/);
  assert.deepEqual(await par.stores.swaps.list(), [], 'a quote made before the floor rose cannot start below the new floor');
  const info = (await par.call('GET', '/reverse/info')).body;
  assert.equal(info.minProceedsBps, 10001); assert.equal(info.available, '0');
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

test('done and refunded terminalAt survive a later record write and a provider restart', async () => {
  const done = world();
  const qt = await done.client.quote(SEND);
  await done.client.start({ quote: qt });
  await done.run(async () => (await done.lpSwap())?.phase === 'done' && (await done.userSwap())?.phase === 'done');
  await assertTerminalAtStable(done, 'done');

  const refunded = world();
  const abandoned = await refunded.client.quote(SEND);
  await refunded.client.start({ quote: abandoned });
  let lp = await refunded.lpSwap();
  for (let i = 0; i < 2500 && lp.phase !== 'refunded'; i++) {
    await refunded.service.tick(); refunded.evm.process(); refunded.clock.advance(60);
    if ((i + 1) % 10 === 0) refunded.btc.mine(1, { advance: false });
    lp = await refunded.lpSwap();
  }
  await assertTerminalAtStable(refunded, 'refunded');
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

test('an unreadable swap record pauses new sales with a throttled alert while its readable swaps keep ticking', async () => {
  const w = world({ notes: 2 });
  const q1 = (await rawQuote(w)).body, q2 = (await rawQuote(w)).body;
  const started = await rawStart(w, q1.id);
  assert.equal(started.body.ok, true);
  let corrupt = false;
  w.stores.swaps.problems = () => corrupt ? [{ id: 'deadbeef', error: 'corrupt JSON at a private path' }] : [];
  corrupt = true;
  const circuit = await w.service.tick(); await w.service.tick();
  assert.equal(circuit.tickOk, true, 'a corrupt record does not stop a clean pass over readable records');
  assert.equal(circuit.swapsReadable, false); assert.equal(circuit.unreadableSwaps, 1);
  assert.equal(w.alerts.filter((a) => /record cannot be read/.test(a.msg)).length, 1, 'repeat ticks and requests do not repeat the alert inside alertSecs');
  const quote = await rawQuote(w), start = await rawStart(w, q2.id);
  assert.equal(quote.status, 503); assert.match(quote.body.error, /swap record cannot be read/);
  assert.equal(start.body.ok, false); assert.equal(start.body.retry, true); assert.match(start.body.why, /swap record cannot be read/);
  for (let i = 0; i < 4 && (await w.lpSwap()).phase !== 'offered'; i++) {
    w.btc.mine(1, { advance: false }); w.clock.advance(60); await w.service.tick();
  }
  assert.equal((await w.lpSwap()).id, started.body.swapId);
  assert.equal((await w.lpSwap()).phase, 'offered', 'the readable lock still advances while the circuit is closed to new sales');
  const info = (await w.call('GET', '/reverse/info')).body;
  assert.equal(info.health.ok, false); assert.ok(info.health.blockers.includes('swap-records'));
  assert.equal(info.health.swapsReadable, false); assert.equal(info.health.unreadableSwaps, 1);
  assert.ok(!JSON.stringify(info).includes('private path'), 'operator detail stays in alerts, not public health');
  corrupt = false; await w.service.tick();
  assert.equal(w.service.health.swapsReadable, true);
  assert.equal((await rawQuote(w)).status, 200, 'a clean record scan reopens new sales');
});

test('failed ticks close new sales until a clean tick, including a swap step that throws', async () => {
  const w = world(), q = (await rawQuote(w)).body, store = w.stores.swaps, list = store.list.bind(store);
  let down = true;
  store.list = async () => { if (down) throw new Error('store offline'); return list(); };
  const failed = await w.service.tick(); await w.service.tick();
  assert.notEqual(failed, w.service.health, 'tick returns a health summary snapshot');
  assert.equal(failed.tickOk, false); assert.match(failed.lastError, /store offline/);
  assert.equal(w.service.health.tickOk, false); assert.match(w.service.health.lastError, /store offline/);
  assert.equal(w.alerts.filter((a) => /tick failed/.test(a.msg)).length, 1, 'repeated failures alert once per alert window');
  down = false;
  assert.match((await rawQuote(w)).body.error, /last tick failed/);
  assert.match((await rawStart(w, q.id)).body.why, /last tick failed/);
  const blocked = (await w.call('GET', '/reverse/info')).body;
  assert.equal(blocked.health.ok, false); assert.ok(blocked.health.blockers.includes('tick'));
  const clean = await w.service.tick();
  assert.equal(clean.tickOk, true); assert.equal(clean.lastError, null); assert.equal(clean.lastTick, w.clock.now());
  assert.equal(w.service.health.tickOk, true); assert.equal(w.service.health.lastError, null);
  assert.equal((await rawStart(w, q.id)).body.ok, true, 'the first clean tick reopens starts');

  const step = w.service.bl.step.bind(w.service.bl);
  let stepDown = true;
  w.service.bl.step = async (rec) => { if (stepDown) throw new Error('step offline'); return step(rec); };
  await w.service.tick();
  assert.equal(w.service.health.tickOk, false, 'a failed readable swap step also fails closed for new sales');
  stepDown = false; await w.service.tick();
  assert.equal(w.service.health.tickOk, true, 'and its next clean step clears that state');
});

test('the fee ceiling refuses only new quotes and first starts while an existing swap reaches its claim', async () => {
  const w = world({ notes: 2, config: { maxFeeRate: 3 } });
  const qt = await w.client.quote(SEND), spare = (await rawQuote(w)).body;
  const { swapId } = await w.client.start({ quote: qt });
  w.lBtc.feeRate = async () => 9;
  const dear = await rawQuote(w), blocked = await rawStart(w, spare.id);
  assert.equal(dear.status, 503); assert.match(dear.body.error, /9 sat\/vB.*above.*3 sat\/vB ceiling/);
  assert.equal(blocked.body.ok, false); assert.equal(blocked.body.retry, true); assert.match(blocked.body.why, /above.*ceiling/);
  assert.equal((await w.stores.swaps.list()).length, 1, 'the refused start made no second lock');
  assert.deepEqual((await rawStart(w, qt.id)).body, { ok: true, swapId }, 'an idempotent retry is not a new start');
  const info = (await w.call('GET', '/reverse/info')).body;
  assert.equal(info.maxFeeRate, 3); assert.equal(info.health.feeRate, 9); assert.equal(info.health.feeRateOk, false);
  assert.ok(info.health.blockers.includes('fee-rate'));
  w.lBtc.feeRate = async () => null;
  assert.match((await rawQuote(w)).body.error, /cannot read the current Bitcoin fee rate/);
  await w.run(async () => (await w.lpSwap())?.phase === 'done' && (await w.userSwap())?.phase === 'done');
  assert.equal((await w.lpSwap()).phase, 'done', 'ticks and the pool claim never consult the new-sale fee gate');
  w.lBtc.feeRate = async () => 3;
  assert.equal((await rawQuote(w)).status, 200, 'a usable rate at the ceiling reopens sales');
});

test('a note lock uses the prechecked fee rate exactly once, and a direct above-ceiling locker start stores and broadcasts nothing', async () => {
  const w = world({ config: { maxFeeRate: 3 } }), q = (await rawQuote(w)).body;
  let reads = 0;
  const built = [];
  w.lBtc.feeRate = async () => ++reads === 1 ? 3 : 9;
  const lockTransfer = w.lBtc.tx.lockTransfer;
  w.lBtc.tx.lockTransfer = (args) => { built.push(args.feeRate); return lockTransfer(args); };
  const started = await rawStart(w, q.id);
  assert.equal(started.body.ok, true); assert.equal(reads, 1, 'the locker did not take a second, higher rate');
  assert.deepEqual(built, [3], 'the exact accepted rate reached the transaction builder');
  assert.equal((await w.stores.swaps.list()).length, 1); assert.equal(w.btc.broadcasts.length, 1);

  const direct = world();
  assert.equal(await direct.lBtc.feeRate(0, { allowStale: false }), 3, 'the precheck accepts the ceiling rate');
  await assert.rejects(() => direct.service.bl.start({
    asset: direct.etch.asset, amount: 2791n, notes: [direct.inventory[0]], counterClaimPub: direct.uW.wallet.pub,
    evmAsset: ASSET, evmAmount: SEND, quoteId: null, feeRate: 9, maxFeeRate: 3,
  }), /the fee rate 9 sat\/vB is above the 3 sat\/vB ceiling/);
  assert.deepEqual(await direct.stores.swaps.list(), []); assert.equal(direct.btc.broadcasts.length, 0);
});

test('a plain-sats pair lock uses the prechecked fee rate exactly once, and a direct above-ceiling locker start stores and broadcasts nothing', async () => {
  const w = pairWorld({ revConfig: { maxFeeRate: 3 } });
  await w.ready();
  const body = { amount: String(UNITS), claimPub: bytesToHex(w.uW.wallet.pub) };
  assert.equal((await w.rev.handle({ method: 'POST', path: '/reverse/quote', body })).status, 200);
  const q = (await w.stores.rv.quotes.list())[0];
  let reads = 0;
  const built = [];
  w.rBtc.feeRate = async () => ++reads === 1 ? 3 : 9;
  const lockSats = w.rBtc.tx.lockSats;
  w.rBtc.tx.lockSats = (args) => { built.push(args.feeRate); return lockSats(args); };
  const started = await w.rev.handle({ method: 'POST', path: '/reverse/start', body: { quoteId: q.id } });
  assert.equal(started.body.ok, true); assert.equal(reads, 1, 'the sats locker did not take a second, higher rate');
  assert.deepEqual(built, [3], 'the exact accepted rate reached the plain-sats builder');
  assert.equal((await w.stores.rv.swaps.list()).length, 1); assert.equal(w.btc.broadcasts.length, 1);
  assert.deepEqual((await w.stores.rv.swaps.list())[0].noteInputs, [], 'plain sats keep noteInputs empty');

  const direct = pairWorld();
  assert.equal(await direct.rBtc.feeRate(0, { allowStale: false }), 3, 'the pair precheck accepts the ceiling rate');
  await assert.rejects(() => direct.rev.bl.start({
    asset: hexToBytes(X.SATS_ASSET), amount: 100_000n, counterClaimPub: direct.uW.wallet.pub,
    evmAsset: ASSET, evmAmount: UNITS, quoteId: null, feeRate: 9, maxFeeRate: 3,
  }), /the fee rate 9 sat\/vB is above the 3 sat\/vB ceiling/);
  assert.deepEqual(await direct.stores.rv.swaps.list(), []); assert.equal(direct.btc.broadcasts.length, 0);
});

test('a read of its notes that fails is remembered for ten seconds, so a stream of requests while an explorer is down is not a stream of scans, and it never reads as an empty address', async () => {
  const w = world();
  let calls = 0, broken = true;
  const svc = w.makeService({ notes: async () => { calls++; if (broken) throw new Error('explorer down'); return w.inventory; } });
  const get = async () => (await svc.handle({ method: 'GET', path: '/reverse/info' })).body;
  const quote = async () => svc.handle({ method: 'POST', path: '/reverse/quote', body: { amount: '3000', claimPub: claimPubOf(w) } });
  const first = await get();
  assert.equal(first.available, null, 'not available is not "no TAC" (0)'); assert.equal(first.open, null); assert.equal(calls, 1);
  assert.equal(first.health.inventoryOk, false); assert.ok(first.health.blockers.includes('inventory'));
  assert.equal(w.alerts.filter((a) => /inventory cannot be read/.test(a.msg)).length, 1, 'a scan failure alerts the operator');
  for (let i = 0; i < 20; i++) await get();
  assert.equal(calls, 1, 'twenty more reads inside the window did not ask the explorers');
  assert.equal(w.alerts.filter((a) => /inventory cannot be read/.test(a.msg)).length, 1, 'and did not repeat the alert');
  const q = await quote();
  assert.equal(q.status, 500, 'a quote is not given on a list it could not read'); assert.equal(calls, 1, 'and it did not scan either');
  w.clock.advance(9); await get(); assert.equal(calls, 1, 'nine seconds on: still remembered');
  w.clock.advance(2); await get(); assert.equal(calls, 2, 'eleven: it tries again');
  broken = false; w.clock.advance(11);
  const healed = await get();
  assert.equal(healed.available, '5215', 'and when it reads again the notes are there (this world keeps no good read, so each answer reads)');
  assert.equal(healed.health.inventoryOk, true); assert.ok(!healed.health.blockers.includes('inventory'));
  assert.ok(calls >= 3);
  assert.equal((await quote()).status, 200, 'and a quote is given');
  // a start (which makes the list stale) does not carry an old failure forward
  const v = world();
  let fail = false, n = 0;
  const svc2 = v.makeService({ notes: async () => { n++; if (fail) throw new Error('down'); return v.inventory; } });
  const qa = (await svc2.handle({ method: 'POST', path: '/reverse/quote', body: { amount: '3000', claimPub: claimPubOf(v) } })).body;
  fail = true; v.clock.advance(61);
  await svc2.handle({ method: 'GET', path: '/reverse/info' });
  const afterFail = n;
  fail = false;
  await svc2.start();
  assert.equal((await svc2.handle({ method: 'GET', path: '/reverse/info' })).body.available, '5215', 'start() forgets the failure');
  assert.ok(n > afterFail); assert.ok(qa.id);
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
