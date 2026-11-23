// Bitcoin for ETH and ETH for Bitcoin, the whole way, in both directions: the pair client the swap tile uses (dapp/fastbridge-pair.js) against a provider that sells
// pool ETH for sats (dapp/fastbridge-provider.js) and one that sells sats for pool ETH (dapp/fastbridge-reverse-provider.js), both priced from a live rate feed
// (dapp/fastbridge-rate.js), in the simulated Bitcoin and pool of tests/lib/chain-sim.mjs on one virtual clock with the same machines as the TAC bridge. The sim's
// pool asset stands in for ETH. The user's page judges every quote against its own reading of the market.
//   node tests/fastbridge-pair.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx } from '../dapp/adaptor-btc-tx.js';
import { makeLpService } from '../dapp/fastbridge-provider.js';
import { makeReverseService } from '../dapp/fastbridge-reverse-provider.js';
import { makeCounter } from '../dapp/fastbridge-http.js';
import { termsOf } from '../dapp/fastbridge-client.js';
import { makePairClient, SATS_ASSET, rateOf, describeFwd } from '../dapp/fastbridge-pair.js';
import { makeRateFeed } from '../dapp/fastbridge-rate.js';
import * as X from '../dapp/adaptor-xswap.js';
import { bigintToBytes32 } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { te, scalar, fetched } from './lib/btc-sim.mjs';
import { makeClock, makeBitcoinSim, makeEvmSim, makeEvmParty, partyKeys, pool, sha256, ASSET } from './lib/chain-sim.mjs';
import { memStore } from './lib/fastbridge-world.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const SATS = 100_000n;
const UNITS = 3_600_000n;                                         // 0.036 ETH in pool units

function pairWorld({ providerMarket = 35.6, clientMarket = 35.6, confs = 1, userSats = 200_000 } = {}) {
  const clock = makeClock(), btc = makeBitcoinSim(clock), evm = makeEvmSim(clock);
  const wallet = (name) => makeBtcWallet({ priv: bigintToBytes32(scalar(name + '/btc-wallet')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 });
  const uW = wallet('user'), lW = wallet('lp'), rW = wallet('lp-reverse');
  const uKeys = partyKeys('user'), lKeys = partyKeys('lp');
  const uEvm = makeEvmParty({ evm, keys: uKeys, clock }), lEvm = makeEvmParty({ evm, keys: lKeys, clock });
  // stable coins, gone from the lists once a transaction spends them
  const coinsOf = (tag, values) => values.map((v, i) => ({ txid: bytesToHex(sha256(te(`${tag}/${i}`))), vout: 0, value: v }));
  const uCoins = coinsOf('user', userSats ? [userSats] : []), rCoins = coinsOf('reverse', [2_000_000]);
  const unspent = (cs) => () => cs.filter((c) => !btc.spends.has(`${c.txid}:${c.vout}`));
  const uBtc = btc.adapter({ prims: uW.prims, builder: makeAdaptorBtcTx({ prims: uW.prims }), sats: unspent(uCoins) });
  const lBtc = btc.adapter({ prims: lW.prims, builder: makeAdaptorBtcTx({ prims: lW.prims }), sats: unspent([]) });
  const rBtc = btc.adapter({ prims: rW.prims, builder: makeAdaptorBtcTx({ prims: rW.prims }), sats: unspent(rCoins) });
  for (const a of [lBtc, rBtc]) { a.resolveNote = async () => { throw new Error('a lock of sats has no note'); }; a.crossLaneBlocked = async () => { throw new Error('a lock of sats has no note'); }; }

  const base = { now: evm.now, lockPosition: evm.lockPosition, jobStatus: evm.jobStatus, submit: evm.submit, lockSpent: evm.lockSpentFn, findClaim: evm.findClaim, lockNullifier: pool.nullifier };
  const lEvmCtx = { ...base, lockOp: lEvm.lockOp, refundOp: lEvm.refundOp, refundKey: lEvm.refundKey, available: lEvm.available };
  const rBlEvm = { now: evm.now, lockPosition: evm.lockPosition, recipient: lEvm.recipient, claimOp: lEvm.claimOp, submit: evm.submit, claimStatus: evm.jobStatus };
  const uEvmCtx = { ...base, recipient: uEvm.recipient, claimOp: uEvm.claimOp, claimStatus: evm.jobStatus, lockOp: uEvm.lockOp, refundOp: uEvm.refundOp, refundKey: uEvm.refundKey, available: uEvm.available };

  // the market, as the provider reads it and as the user's page does
  const market = { provider: providerMarket, client: clientMarket, providerDown: false };
  const feedOf = (read) => makeRateFeed({ sources: [async () => read(), async () => read()], now: clock.now, maxAgeSecs: 3600 });
  const providerFeed = feedOf(() => { if (market.providerDown) throw new Error('down'); return market.provider; }), clientFeed = feedOf(() => market.client);

  const w = { clock, btc, evm, uW, lW, rW, uKeys, lKeys, uEvm, lEvm, uBtc, rBtc, uCoins, rCoins, market, providerFeed, clientFeed, up: { lp: true, offers: true }, stores: { lp: memStore(), rv: { swaps: memStore(), quotes: memStore(), offers: memStore(), evmOffers: memStore() } } };
  w.fwd = makeLpService({
    seed: lKeys.seed, btc: lBtc, evm: lEvmCtx, swaps: w.stores.lp, quoteStore: memStore(), now: clock.now,
    config: {
      claimPub: bytesToHex(lW.wallet.pub), csvBlocks: 144,
      quote: { btcAsset: SATS_ASSET, evmAsset: ASSET, minAmount: 20_000, maxAmount: 10_000_000, feeBps: 30, flatFee: 500, validSecs: 600, rate: () => providerFeed.rate() },
      policy: { minCsv: 72, minConfsFor: () => confs, evmWindowSecs: 4 * 3600, minClaimSecs: 3600, claimSlackSecs: 7200, roundSecs: 600, refundMarginSecs: 600, maxOfferAgeSecs: 3600, minAmount: 20_000, maxAmount: 10_000_000 },
    },
  });
  w.rev = makeReverseService({
    seed: lKeys.seed, btc: rBtc, evm: rBlEvm, ...w.stores.rv, now: clock.now,
    inventory: { notes: async () => unspent(rCoins)().map((c) => ({ ...c, amount: BigInt(c.value) })) },
    config: { quote: { btcAsset: SATS_ASSET, evmAsset: ASSET, minAmount: 1_000_000n, maxAmount: 50_000_000n, feeBps: 30, flatFee: 10_000n, validSecs: 600, rate: () => providerFeed.rate() }, csvBlocks: 96, evmWindowSecs: 4 * 3600, maxOpen: 2, minConfsFor: () => confs, refreshSecs: 0 },
  });
  w.provider = { id: 'lp1', name: 'Test provider', ref: { kind: 'http', base: 'http://lp', claimPub: bytesToHex(lW.wallet.pub) } };
  w.discover = async () => {
    const [f, r] = [await w.fwd.handle({ method: 'GET', path: '/info' }), await w.rev.handle({ method: 'GET', path: '/reverse/info' })];
    return [{ ...w.provider, assets: { btcAsset: f.body.btcAsset, evmAsset: f.body.evmAsset }, terms: termsOf(f.body), reverse: { feeBps: r.body.feeBps, flatFee: BigInt(r.body.flatFee), minAmount: BigInt(r.body.minAmount), maxAmount: BigInt(r.body.maxAmount), available: r.body.available == null ? null : BigInt(r.body.available) } }];
  };
  const mems = new Map();
  w.mems = mems;
  const memNamed = (n) => { if (!mems.has(n)) mems.set(n, memStore()); return mems.get(n); };
  w.makePair = (over = {}) => makePairClient({
    btc: uBtc, evm: uEvmCtx, seed: uKeys.seed, now: clock.now, ethAsset: ASSET, feed: clientFeed, discover: w.discover,
    counterFor: () => makeCounter(async (method, path, body) => { if (!w.up.lp || (!w.up.offers && /^\/(offer|extend)/.test(path))) throw new Error('the provider is unreachable'); const r = await w.fwd.handle({ method, path, body }); return { status: r.status, body: r.body }; }),
    reverseCallFor: () => async (method, path, body) => { if (!w.up.lp) throw new Error('the provider is unreachable'); const r = await w.rev.handle({ method, path, body }); return { status: r.status, body: r.body }; },
    stores: { fwd: memNamed('fwd'), index: memNamed('index'), swaps: (id) => memNamed('swaps:' + id), quotes: (id) => memNamed('quotes:' + id) }, ...over,
  });
  w.pair = w.makePair();
  let ticks = 0;
  w.step = async () => {
    await providerFeed.refresh().catch(() => {}); await clientFeed.refresh().catch(() => {});
    if (w.up.lp) { await w.fwd.tick(); await w.rev.tick(); }
    await w.pair.pump(); evm.process();
  };
  w.run = async (until, max = 2000) => {
    for (let i = 0; i < max; i++) {
      if (await until()) return i;
      await w.step();
      clock.advance(60); ticks++;
      if (ticks % 10 === 0) btc.mine(1, { advance: false });
    }
    throw new Error('did not finish: ' + JSON.stringify((await w.pair.records()).map((r) => [r.dir, r.state, r.title])));
  };
  w.first = async () => (await w.pair.records())[0];
  // the market has to be read before the provider can quote, and the pool note has to be there for the payout
  w.ready = async () => { await providerFeed.refresh(); await clientFeed.refresh(); };
  return w;
}

test('Bitcoin for ETH, all the way: the quote is judged against the market, the sats are locked, the provider locks ETH, the claim publishes the secret, and the user ends with the ETH and the provider with the sats', async () => {
  const w = pairWorld();
  await w.ready();
  const out = w.fwd.quoter.price(SATS).evmAmount;
  assert.equal(out, 3_531_520n, '(100,000 - 0.30% - 500) sats at 35.6 ETH per BTC: 99,200 x 35.6 pool units');
  w.lEvm.fund(out, 'inv0');
  assert.deepEqual((await w.pair.providers()).map((p) => [p.id, p.dirs]), [['lp1', ['b2e', 'e2b']]]);
  const ref = await w.pair.reference();
  assert.equal(ref.ethPerBtc, 35.6);
  const q = await w.pair.quote({ dir: 'b2e', amount: SATS });
  assert.deepEqual([q.dir, q.pay, q.get, q.provider.id, q.blocked], ['b2e', SATS, out, 'lp1', null]);
  assert.equal(q.market, 35.6);
  assert.equal(q.vsMarketBps, -80, '0.30% and a flat 500 sats is 0.80% under the market');
  assert.deepEqual(q.warnings, [], 'under the 1% it says nothing of');
  assert.ok(q.networkFeeSats > 0 && q.networkFeeSats < 2000);
  assert.ok(Math.abs(q.rate - 35.3152) < 1e-9);
  assert.equal((await w.pair.balances()).sats, 200_000n);

  const { id } = await w.pair.start(q);
  assert.match(id, /^[0-9a-f]{72}$/);
  assert.equal((await w.pair.balances()).sats, 0n, 'the coin that funded the lock is spoken for');
  await w.run(async () => (await w.first())?.state === 'done');
  const rec = await w.first();
  assert.equal((await w.mems.get('fwd').list())[0].extended, true, 'the provider held its payout through the lock\'s confirmation: a lock of one input is a lock');
  assert.deepEqual([rec.dir, rec.pay, rec.get, rec.title], ['b2e', SATS, out, 'Done']);
  assert.deepEqual(rec.steps.map((s) => s.state), ['done', 'done', 'done', 'done']);
  assert.deepEqual(w.evm.submitted.map((j) => j.type), ['adaptorlock', 'adaptorclaim']);
  assert.equal(w.evm.locks.leaves.length, 1);
  const lock = (await w.pair.records())[0].lockTxid;
  assert.ok(w.btc.spends.get(`${lock}:0`), 'the lock was spent by the provider\'s take');
  assert.equal(w.btc.broadcasts.length, 2, 'the user\'s lock and the provider\'s take: two ordinary transactions');
  // the ETH note is the user's, of the exact payout, found from its own derivation
  const sec = X.deriveSwapSecrets({ seed: w.uKeys.seed, swapId: hexToBytes(id) });
  const O = pool.commitXY(out, '0x' + bytesToHex(bigintToBytes32(sec.rOut)));
  assert.ok(w.evm.notes.leaves.some((l) => bytesToHex(l) === strip(pool.leaf(ASSET, O.cx, O.cy, pool.nkToOwner(w.uKeys.nkOut)))));
});
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();

test('ETH for Bitcoin, all the way: the provider locks sats first, the user locks pool ETH once that lock is confirmed, the provider claims, and the user takes the sats', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  const q = await w.pair.quote({ dir: 'e2b', amount: UNITS });
  // 30 bps and 10,000 units of 3,600,000 is 20,800; what is left, 3,579,200 units, buys sats at 35.6 units each
  assert.deepEqual([q.dir, q.pay, q.get], ['e2b', UNITS, 100_539n]);
  assert.equal(q.vsMarketBps, Math.round((35.6 / (3_600_000 / 100_539) - 1) * 10000));
  assert.ok(q.vsMarketBps < 0 && q.vsMarketBps > -100);
  assert.equal(q.blocked, null);
  assert.equal(q.networkFeeSats, null, 'the provider pays for its own lock, and the take comes out of it');
  assert.equal((await w.pair.balances()).eth, UNITS);
  const { id } = await w.pair.start(q);
  assert.match(id, /^[0-9a-f]{72}$/);
  const asked = await w.pair.records();
  assert.equal(asked[0].title === 'Asking the provider' || asked[0].dir === 'e2b', true, 'the press is followed by something on the page at once');
  await w.run(async () => (await w.pair.records()).some((r) => r.dir === 'e2b' && r.state === 'done'));
  const rec = (await w.pair.records()).find((r) => r.dir === 'e2b' && r.state === 'done');
  assert.deepEqual([rec.pay, rec.get, rec.title], [UNITS, 100_539n, 'Done']);
  assert.deepEqual(rec.steps.map((s) => s.state), ['done', 'done', 'done', 'done']);
  assert.deepEqual(w.evm.submitted.map((j) => j.type), ['adaptorlock', 'adaptorclaim'], 'the user locked and the provider claimed');
  const take = [...w.btc.txs.values()].find((e) => e.esplora.vout.some((o) => o.scriptpubkey === bytesToHex(w.uW.prims.p2wpkhScript(w.uW.wallet.pub))));
  assert.ok(take, 'the sats are at the user\'s Bitcoin address');
  assert.ok(take.esplora.vout[0].value > 100_000 && take.esplora.vout[0].value < 100_539, 'the payout less the fee of the take, out of the lock');
  assert.equal((await w.pair.balances()).eth, 0n, 'the ETH left the private balance');
});

test('a provider that quotes far under the market is blocked, and pressing start sends nothing', async () => {
  const w = pairWorld({ providerMarket: 33, clientMarket: 35.6 });   // the provider reads ETH at 33 per BTC while the page reads 35.6: 7.3% under
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const q = await w.pair.quote({ dir: 'b2e', amount: SATS });
  assert.ok(q.vsMarketBps < -300);
  assert.match(q.blocked, /^the provider quotes \d\.\d% under the market$/);
  await assert.rejects(() => w.pair.start(q), /under the market/);
  assert.equal(w.btc.broadcasts.length, 0, 'nothing was sent');
  assert.equal((await w.pair.records()).length, 0);
});

test('the same for ETH for Bitcoin: a provider that thinks BTC dear is blocked, and one that thinks it cheap is not (that is better for the user)', async () => {
  const dear = pairWorld({ providerMarket: 38, clientMarket: 35.6 });       // the user pays 38 units a sat against a market of 35.6
  await dear.ready();
  dear.uEvm.fund(UNITS, 'inv0');
  const r = await dear.pair.quote({ dir: 'e2b', amount: UNITS });
  assert.ok(r.vsMarketBps < -300 && r.blocked, String(r.vsMarketBps));
  const cheap = pairWorld({ providerMarket: 33, clientMarket: 35.6 });
  await cheap.ready();
  cheap.uEvm.fund(UNITS, 'inv0');
  const c = await cheap.pair.quote({ dir: 'e2b', amount: UNITS });
  assert.ok(c.vsMarketBps > 0 && c.blocked === null, String(c.vsMarketBps));
});

test('a quote between 1% and 3% under the market is allowed with a warning that says how far', async () => {
  const w = pairWorld({ providerMarket: 35.0, clientMarket: 35.6 });    // 1.7% under, and 0.8% more of fees
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const q = await w.pair.quote({ dir: 'b2e', amount: SATS });
  assert.equal(q.blocked, null);
  assert.equal(q.warnings.length, 1);
  assert.match(q.warnings[0], /^this is 2\.\d% worse than the market price$/);
});

test('when the page cannot read the market it says so and blocks: a price nobody can check is not shown as fair', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const dead = makeRateFeed({ sources: [async () => { throw new Error('down'); }, async () => { throw new Error('down'); }], now: w.clock.now });
  const pair = w.makePair({ feed: dead });
  assert.equal(await pair.reference(), null);
  const q = await pair.quote({ dir: 'b2e', amount: SATS });
  assert.equal(q.market, null);
  assert.equal(q.vsMarketBps, null);
  assert.match(q.blocked, /market price could not be read/);
  await assert.rejects(() => pair.start(q), /could not be read/);
});

test('a provider with no price of its own right now is asked again later, in words; an amount no provider takes is said so', async () => {
  const w = pairWorld();
  await w.ready();
  w.market.providerDown = true;
  w.clock.advance(4000);                                           // the provider's last read has aged out
  await w.clientFeed.refresh();
  await assert.rejects(() => w.pair.quote({ dir: 'b2e', amount: SATS }), /no price for this pair right now/);
  w.market.providerDown = false; await w.providerFeed.refresh();
  await assert.rejects(() => w.pair.quote({ dir: 'b2e', amount: 5_000n }), /no provider takes that amount/);
  await assert.rejects(() => w.pair.quote({ dir: 'b2e', amount: 0n }), /enter an amount/);
  await assert.rejects(() => w.pair.quote({ dir: 'sideways', amount: 1n }), /direction/);
});

test('a Bitcoin address that holds too little is told how much it has and needs, and nothing is started', async () => {
  const w = pairWorld({ userSats: 100_300 });
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const q = await w.pair.quote({ dir: 'b2e', amount: SATS });
  assert.match(q.blocked, /^your Bitcoin address holds 100300 sats and this needs \d+, the amount and the network fee$/);
  await assert.rejects(() => w.pair.start(q), /holds 100300 sats/);
  assert.equal(w.btc.broadcasts.length, 0);
});

test('a coin spent between the quote and the press stops a Bitcoin-for-ETH swap with the reason, before anything is reserved or sent', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const q = await w.pair.quote({ dir: 'b2e', amount: SATS });
  assert.equal(q.blocked, null);
  w.btc.spends.set(`${w.uCoins[0].txid}:0`, 'spent elsewhere');       // the user spends the coin from another wallet in the meantime
  await assert.rejects(() => w.pair.start(q), /does not hold that many sats/);
  assert.equal(w.btc.broadcasts.length, 0);
  assert.equal(w.fwd.reservations.size, 0, 'and the provider was not asked to hold its payout');
});

test('private ETH that does not cover the amount stops an ETH-for-Bitcoin swap before anything is asked of the provider', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS - 1n, 'short');
  const q = await w.pair.quote({ dir: 'e2b', amount: UNITS });
  await assert.rejects(() => w.pair.start(q), /private ETH does not cover/);
  assert.equal((await w.rev.handle({ method: 'GET', path: '/reverse/info' })).body.open, 0, 'the provider was never asked to lock');
});

test('the swap is kept: a new page over the same stores shows it, and a lock whose record was lost is found again from the key and taken back on its timelock', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const q = await w.pair.quote({ dir: 'b2e', amount: SATS });
  w.up.offers = false;                                             // the provider holds the payout, then stops answering: the lock is sent and no offer is taken
  await w.pair.start(q);
  await w.run(async () => !!(await w.first())?.lockTxid && w.btc.broadcasts.length > 0 && (await w.btc.status((await w.first()).lockTxid)).confirmations > 0);
  const shown = await w.makePair().records();
  assert.equal(shown.length, 1, 'a new page over the same stores');
  assert.equal(shown[0].dir, 'b2e');
  // a browser with nothing kept: same key, empty stores
  const empty = memStore();
  const fresh = w.makePair({ stores: { fwd: empty, index: memStore(), swaps: () => memStore(), quotes: () => memStore() } });
  assert.deepEqual(await fresh.records(), []);
  assert.equal(await fresh.recover(), 1);
  assert.equal((await fresh.records())[0].title, 'Returning your BTC');
  w.btc.mine(143);
  for (let i = 0; i < 60 && (await fresh.records())[0].state !== 'returned'; i++) { await fresh.pump(); w.btc.mine(1); w.clock.advance(60); }
  assert.equal((await fresh.records())[0].state, 'returned');
  assert.equal((await fresh.records())[0].title, 'Returned');
});

test('of two providers the better quote wins, and one that fails to answer does not stop the other', async () => {
  const w = pairWorld();
  await w.ready();
  const mk = (id, btcValue, ok = true) => ({ id, name: id, ref: { kind: 'http', base: id, claimPub: '02' + '11'.repeat(32) }, assets: { btcAsset: SATS_ASSET, evmAsset: ASSET }, terms: { minAmount: 1n, maxAmount: 10n ** 12n, available: null }, reverse: { feeBps: 0, flatFee: 0n, minAmount: 1n, maxAmount: 10n ** 12n, available: null }, ok, btcValue });
  const list = [mk('cheap', 100_539n), mk('dear', 99_000n), mk('down', 0n, false)];
  const reply = (p) => async (method, path, body) => {
    if (!p.ok) throw new Error('the provider is unreachable');
    if (path === '/reverse/quote') return { status: 200, body: { id: 'a'.repeat(32), direction: 'out', btcAsset: SATS_ASSET, btcValue: String(p.btcValue), evmAsset: ASSET, evmAmount: body.amount, claimPub: body.claimPub, lockerPub: '02' + '22'.repeat(32), lockerXonly: '22'.repeat(32), csvBlocks: 96, evmWindowSecs: 14400, minConfs: 1, takeSats: 0, created: w.clock.now(), validUntil: w.clock.now() + 600 } };
    return { status: 404, body: { error: 'not found' } };
  };
  const pair = w.makePair({ discover: async () => list, reverseCallFor: (ref) => reply(list.find((p) => p.id === ref.base)) });
  w.uEvm.fund(UNITS, 'inv0');
  const q = await pair.quote({ dir: 'e2b', amount: UNITS });
  assert.deepEqual([q.provider.id, q.get], ['cheap', 100_539n]);
  const onlyDown = w.makePair({ discover: async () => [list[2]], reverseCallFor: (ref) => reply(list.find((p) => p.id === ref.base)) });
  await assert.rejects(() => onlyDown.quote({ dir: 'e2b', amount: UNITS }), /unreachable/);
});

test('the provider holds its payout through a lock\'s confirmation only for a transaction that is a lock: one that pays the quoted amount to a Taproot output', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const q = await w.fwd.handle({ method: 'POST', path: '/quote', body: { amount: String(SATS) } });
  const id = q.body.id;
  assert.equal((await w.fwd.handle({ method: 'POST', path: '/reserve', body: { quoteId: id } })).body.ok, true);
  const tx = (n, outs) => { const txid = bytesToHex(sha256(te('tx' + n))); w.btc.addConfirmed({ txid, esplora: { txid, vin: [{ txid: bytesToHex(sha256(te('in' + n))), vout: 0, witness: [] }], vout: outs } }); return txid; };
  const p2wpkh = '0014' + '11'.repeat(20), p2tr = '5120' + '22'.repeat(32);
  const ext = async (txid) => (await w.fwd.handle({ method: 'POST', path: '/extend', body: { quoteId: id, txid } })).body;
  assert.match((await ext(tx(1, [{ scriptpubkey: p2wpkh, value: 100_000 }]))).why, /does not pay the quoted amount to a Taproot lock/, 'the right amount, to the wrong kind of output');
  assert.match((await ext(tx(2, [{ scriptpubkey: p2tr, value: 99_999 }]))).why, /does not pay the quoted amount/, 'a Taproot output of another amount');
  assert.equal((await ext(tx(3, [{ scriptpubkey: p2tr, value: 100_000 }, { scriptpubkey: '6a00', value: 0 }]))).ok, true, 'the lock: a Taproot output of exactly the amount');
});

test('only providers of this pair are asked: a TAC provider is not offered Bitcoin for ETH, whatever its limits say', async () => {
  const w = pairWorld();
  await w.ready();
  const tac = { id: 'tac', name: 'TAC provider', ref: { kind: 'http', base: 'tac', claimPub: '02' + '33'.repeat(32) }, assets: { btcAsset: 'f0'.repeat(32), evmAsset: 'f0'.repeat(32) }, terms: { minAmount: 1n, maxAmount: 10n ** 12n, available: null } };
  const pair = w.makePair({ discover: async () => [tac] });
  assert.deepEqual(await pair.providers(), []);
  await assert.rejects(() => pair.quote({ dir: 'b2e', amount: SATS }), /no provider is offering Bitcoin for ETH/);
  const none = w.makePair({ discover: async () => [{ ...tac, assets: undefined }] });
  assert.deepEqual(await none.providers(), [], 'one that names no assets is not taken for a provider of this pair either');
});

test('the pair\'s numbers: ETH per BTC from a quote, and the market comparison for each side of a swap', () => {
  assert.equal(rateOf(3_531_520n, 100_000n), 35.3152);
  assert.equal(describeFwd({ id: 'x', phase: 'broadcast', amount: '100000', evmAmount: '3531520', csvBlocks: 144, created: 5, lockAt: 1000 }).refundAt, 1000 + 144 * 600);
});

let passed = 0;
for (const [name, fn] of tests) {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} pair checks passed`);
process.exit(process.exitCode || 0);
