// Bitcoin for ETH and ETH for Bitcoin, the whole way, in both directions: the pair client the swap tile uses (dapp/fastbridge-pair.js) against a provider that sells
// pool ETH for sats (dapp/fastbridge-provider.js) and one that sells sats for pool ETH (dapp/fastbridge-reverse-provider.js), both priced from a live rate feed
// (dapp/fastbridge-rate.js), in the simulated Bitcoin and pool of tests/lib/chain-sim.mjs on one virtual clock with the same machines as the TAC bridge. The sim's
// pool asset stands in for ETH. The user's page judges every quote against its own reading of the market.
//   node tests/fastbridge-pair.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { makePairClient, SATS_ASSET, ETH_ASSET, rateOf, describeFwd, describeRev, busyLine, missedLine } from '../dapp/fastbridge-pair.js';
import { saveCopy, loadCopy, signed } from '../dapp/fast/pair-keep.js';
import { makeLocalStore } from '../dapp/fastbridge-client.js';
import { secp, hmac, sha256 as sha256h } from '../dapp/vendor/tacit-deps.min.js';
import { makeRateFeed } from '../dapp/fastbridge-rate.js';
import * as X from '../dapp/adaptor-xswap.js';
import { deriveLock } from '../dapp/adaptor-btc-lock.js';
import { bigintToBytes32 } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { fetched, te } from './lib/btc-sim.mjs';
import { pool, sha256, ASSET } from './lib/chain-sim.mjs';
import { memStore } from './lib/fastbridge-world.mjs';
import { pairWorld, SATS, UNITS, strip } from './lib/pair-world.mjs';
import { namedProvider } from '../dapp/fastbridge-pair.js';
import { OWN_PROVIDERS } from '../dapp/fastbridge-board.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('ETH for Bitcoin is asked only of a provider the site names (its own keys, or one /fast/lp.json lists); Bitcoin for ETH of any', async () => {
  const w = pairWorld();
  await w.ready();
  w.providerNamed = false;                                        // an ad on a board, from a key the site does not name
  assert.deepEqual((await w.pair.providers()).map((p) => [p.id, p.dirs, p.e2b]), [['lp1', ['b2e'], null]]);
  await assert.rejects(() => w.pair.quote({ dir: 'e2b', amount: UNITS }), /no provider is offering ETH for Bitcoin/);
  w.providerNamed = true;
  assert.deepEqual((await w.pair.providers()).map((p) => [p.id, p.dirs]), [['lp1', ['b2e', 'e2b']]]);
  const own = Object.keys(OWN_PROVIDERS)[1];
  assert.equal(namedProvider({ id: own, ref: { kind: 'mailbox', claimPub: own } }), true, 'the site\'s own key, from a board ad');
  assert.equal(namedProvider({ id: 'ab'.repeat(33), ref: { kind: 'mailbox', claimPub: 'ab'.repeat(33) } }), false, 'any other key from a board ad');
  assert.equal(namedProvider({ id: 'ab'.repeat(33), http: true, ref: { kind: 'http', claimPub: 'ab'.repeat(33) } }), true, 'one lp.json lists (served over HTTP)');
  assert.equal(namedProvider({ id: 'ab'.repeat(33), pinned: true, ref: { kind: 'mailbox', claimPub: 'ab'.repeat(33) } }), true, 'one lp.json pins');
  const open = w.makePair({ e2bFrom: () => true });
  w.providerNamed = false;
  assert.deepEqual((await open.providers()).map((p) => p.dirs), [['b2e', 'e2b']], 'a page may widen it');
});

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
  assert.ok(q.takeFeeSats >= 500 && q.takeFeeSats < 3000, `the fee of taking the sats is in the quote, so what arrives can be said (${q.takeFeeSats})`);
  assert.equal((await w.pair.balances()).eth, UNITS);
  const { id } = await w.pair.start(q);
  assert.match(id, /^[0-9a-f]{72}$/);
  const asked = await w.pair.records();
  assert.equal(asked[0].title === 'The provider is locking BTC for you' || asked[0].dir === 'e2b', true, 'the press is followed by something on the page at once');
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

test('a market price that rests on one source is not used to judge a quote: the quote is blocked, whatever that source says', async () => {
  const w = pairWorld({ providerMarket: 35.6, clientMarket: 35.6 });
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  for (const read of [35.6, 33]) {
    const pair = w.makePair({ feed: makeRateFeed({ sources: [async () => read], minSources: 1, now: w.clock.now }) });
    const q = await pair.quote({ dir: 'b2e', amount: SATS });
    assert.match(q.blocked || '', /could not be confirmed by more than one source/, `a single source reading ${read}`);
    assert.equal(q.vsMarketBps, null);
    await assert.rejects(() => pair.start(q), /more than one source/);
  }
  assert.equal(w.btc.broadcasts.length, 0, 'nothing was sent');
});

test('a market price far from the last good one is not used until it holds: the quote is blocked, and the last reading is kept across clients', async () => {
  const w = pairWorld({ providerMarket: 35.6, clientMarket: 35.6 });
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  let kept = null;
  const memo = { get: () => kept, put: (m) => { kept = m; } };
  const feedAt = (v) => makeRateFeed({ sources: [async () => v, async () => v], now: w.clock.now });
  assert.equal((await w.makePair({ feed: feedAt(35.6), memo }).quote({ dir: 'b2e', amount: SATS })).blocked, null);
  assert.equal(kept.ethPerBtc, 35.6);
  const far = await w.makePair({ feed: feedAt(29), memo }).quote({ dir: 'b2e', amount: SATS });
  assert.match(far.blocked || '', /far from the last one/);
  const near = await w.makePair({ feed: feedAt(35.2), memo }).quote({ dir: 'b2e', amount: SATS });
  assert.equal(near.blocked, null, 'a move of about one percent is taken');
});

test('a quote under 2.5% under the market is allowed with no warning (it is the fee), and between 2.5% and 3% with one that says how far', async () => {
  const w = pairWorld({ providerMarket: 35.0, clientMarket: 35.6 });    // about 2.5% under, with the fees
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const q = await w.pair.quote({ dir: 'b2e', amount: SATS });
  assert.equal(q.blocked, null);
  assert.ok(q.vsMarketBps < -100 && q.vsMarketBps > -300);
  assert.equal(q.warnings.length, q.vsMarketBps < -250 ? 1 : 0);
  if (q.warnings.length) assert.match(q.warnings[0], /^this is 2\.\d% worse than the market price$/);
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
  await assert.rejects(() => w.pair.quote({ dir: 'b2e', amount: SATS }), /no price right now/);
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
  assert.equal(q.blocked, null, 'the price is not what is wrong');
  assert.equal(q.short.have, 100300n);
  assert.equal(q.short.need - q.pay, BigInt(q.networkFeeSats), 'the fee it needs is still said');
  assert.ok(q.networkFeeSats > 0);
  await assert.rejects(() => w.pair.start(q), /holds 100300 sats and this needs \d+, the amount and the network fee/);
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

test('a note of exactly the amount (one just shielded for the swap) starts an ETH-for-Bitcoin swap, though what is available keeps a cut fee back', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'exact');
  // the pool side as fastbridge-evm.js has it: `available` keeps back the fee of cutting a note, `covers` knows a note of exactly the amount needs no cut
  const FEE = 5000n, free = () => w.uEvm.holdings.filter((h) => !h.used);
  const sum = () => free().reduce((s, h) => s + h.amount, 0n);
  const evm = { ...w.uEvmCtx, available: async () => (sum() > FEE ? sum() - FEE : 0n), covers: async (a) => free().some((h) => h.amount === BigInt(a)) || sum() >= BigInt(a) + FEE };
  const before = w.makePair({ evm: { ...evm, covers: undefined } });
  await assert.rejects(async () => before.start(await before.quote({ dir: 'e2b', amount: UNITS })), /private ETH does not cover/, 'judged by `available` alone, the exact note is refused');
  w.pair = w.makePair({ evm });
  const q = await w.pair.quote({ dir: 'e2b', amount: UNITS });
  const r = await w.pair.start(q);
  assert.ok(r && r.id, 'with `covers`, the swap starts');
  assert.equal((await w.rev.handle({ method: 'GET', path: '/reverse/info' })).body.open, 1, 'and the provider was asked to lock');
  assert.equal(await w.pair.covers(UNITS), true);
  assert.equal(await w.pair.covers(UNITS - 1n), false, 'a lock of less has to be cut, and the note does not hold the fee too');
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
  // the lock is the provider's to answer (it took no offer here): the swap is kept as waiting for its offer, and falls to the timelock refund when none comes
  assert.equal((await fresh.records())[0].title, 'Checking your swap…', 'no offer seen: never said as the provider sending ETH');
  w.btc.mine(143);
  for (let i = 0; i < 60 && (await fresh.records())[0].state !== 'returned'; i++) { await fresh.pump(); w.btc.mine(1); w.clock.advance(60); }
  assert.equal((await fresh.records())[0].state, 'returned');
  assert.equal((await fresh.records())[0].title, 'Returned');
});

test('a lock of sats never takes a coin the wallet\'s holdings scan finds a note on, and with no answer from the scan nothing is locked or reserved', async () => {
  const w = pairWorld({ userSats: [300_000, 200_000] });
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const carrier = w.uCoins[0];                                     // the larger coin, which a lock would take first
  const noted = new Map([['asset', { utxos: [{ utxo: { txid: carrier.txid, vout: carrier.vout } }] }]]);
  const off = w.makePair({ holdings: async () => { throw new Error('the explorers did not answer'); } });
  const q0 = await off.quote({ dir: 'b2e', amount: SATS });
  await assert.rejects(() => off.start(q0), /could not be checked for notes/);
  assert.equal((await w.mems.get('fwd').list()).length, 0, 'nothing was stored or sent');
  const pair = w.makePair({ holdings: async () => noted });
  const q = await pair.quote({ dir: 'b2e', amount: SATS });
  const { id } = await pair.start(q);
  const rec = await w.mems.get('fwd').get(id);
  assert.ok(rec.feeInputs.length > 0);
  assert.ok(rec.feeInputs.every((i) => i.txid !== carrier.txid), 'the coin with the note on it stays where it is');
  const { noteOutpoints } = await import('../dapp/fastbridge-pair.js');
  const h = new Map([['a', { utxos: [{ utxo: { txid: 'aa', vout: 1 } }], ghosts: [{ txid: 'bb', vout: 0 }], pending: [{ utxo: { txid: 'cc', vout: 2 } }] }]]);
  h.unclassified = ['dd:3'];
  assert.deepEqual([...noteOutpoints(h)].sort(), ['aa:1', 'bb:0', 'cc:2', 'dd:3']);
});

test('a lock whose send failed is not sent once its quote has run out, and the page says plainly that nothing left the address', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const send = w.uBtc.broadcast;
  w.uBtc.broadcast = async () => { throw new Error('broadcast refused: no explorer answered'); };
  const q = await w.pair.quote({ dir: 'b2e', amount: SATS });
  const { id } = await w.pair.start(q);
  const rec = await w.mems.get('fwd').get(id);
  assert.equal(rec.validUntil, Number(q.expiresAt), 'the record keeps the quote\'s end');
  assert.equal(rec.phase, 'built');
  w.clock.advance(Number(q.expiresAt) - w.clock.now() + 601);
  w.uBtc.broadcast = send;                                          // the explorers answer again, too late
  await w.pair.pump();
  const r = (await w.pair.records()).find((x) => x.id === id);
  assert.equal((await w.mems.get('fwd').get(id)).phase, 'aborted');
  assert.deepEqual([r.state, r.title], ['stopped', 'Stopped']);
  assert.match(r.detail, /never left your Bitcoin address/);
  assert.equal(w.btc.spends.has(`${w.uCoins[0].txid}:${w.uCoins[0].vout}`), false, 'the coin was not spent');
  assert.deepEqual(await w.pair.heldCoins(), [], 'and is free for the next swap');
});

test('of two providers the better quote wins, and one that fails to answer does not stop the other', async () => {
  const w = pairWorld();
  await w.ready();
  const mk = (id, btcValue, ok = true) => ({ id, name: id, ref: { kind: 'http', base: id, claimPub: '02' + '11'.repeat(32) }, pinned: true, assets: { btcAsset: SATS_ASSET, evmAsset: ASSET }, terms: { minAmount: 1n, maxAmount: 10n ** 12n, available: null }, reverse: { feeBps: 0, flatFee: 0n, minAmount: 1n, maxAmount: 10n ** 12n, available: null }, ok, btcValue });
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

test('the provider holds its payout through a lock\'s confirmation only for a transaction that is the quote\'s lock: the quoted amount to the Taproot output its terms make', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const q = await w.fwd.handle({ method: 'POST', path: '/quote', body: { amount: String(SATS) } });
  const id = q.body.id;
  assert.equal((await w.fwd.handle({ method: 'POST', path: '/reserve', body: { quoteId: id } })).body.ok, true);
  const tx = (n, outs) => { const txid = bytesToHex(sha256(te('tx' + n))); w.btc.addConfirmed({ txid, esplora: { txid, vin: [{ txid: bytesToHex(sha256(te('in' + n))), vout: 0, witness: [] }], vout: outs } }); return txid; };
  // the lock's terms: an adaptor point the user holds, the user's refund key, the provider's claim key and the quote's timelock
  const T = X.deriveSwapSecrets({ seed: w.uKeys.seed, swapId: new Uint8Array(36).fill(7) }).T;
  const terms = { T: bytesToHex(T.toRawBytes(true)), lockerXonly: bytesToHex(w.uBtc.wallet.xonly) };
  const lockSpk = bytesToHex(deriveLock({ prims: w.lW.prims, claimerPub: w.lW.wallet.pub, T, lockerXonly: w.uBtc.wallet.xonly, csvBlocks: q.body.csvBlocks }).spk);
  const p2wpkh = '0014' + '11'.repeat(20), p2tr = '5120' + '22'.repeat(32);
  const ext = async (txid, lock = terms) => (await w.fwd.handle({ method: 'POST', path: '/extend', body: { quoteId: id, txid, ...(lock ? { lock } : {}) } })).body;
  assert.match((await ext(tx(1, [{ scriptpubkey: p2wpkh, value: 100_000 }]))).why, /does not pay the quoted amount to a Taproot lock/, 'the right amount, to the wrong kind of output');
  assert.match((await ext(tx(2, [{ scriptpubkey: lockSpk, value: 99_999 }]))).why, /does not pay the quoted amount/, 'the lock\'s output with another amount');
  assert.match((await ext(tx(3, [{ scriptpubkey: p2tr, value: 100_000 }]))).why, /does not pay the quoted amount to a Taproot lock of this quote/, 'any other Taproot output of exactly the amount (a payment to oneself) holds nothing');
  assert.match((await ext(tx(4, [{ scriptpubkey: lockSpk, value: 100_000 }]), null)).why, /names no lock/, 'an extension without the lock\'s terms holds nothing');
  assert.equal((await ext(tx(5, [{ scriptpubkey: lockSpk, value: 100_000 }, { scriptpubkey: '6a00', value: 0 }]))).ok, true, 'the lock: the output its terms make, of exactly the amount');
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

test('a swap that has waited ten minutes on Ethereum nodes that do not agree says so in plain words, and one that has not says nothing of it', () => {
  const fwd = { id: 'x', phase: 'claimed', amount: '100000', evmAmount: '3531520', csvBlocks: 144, created: 5, lockAt: 1000 };
  assert.match(describeFwd({ ...fwd, nodesSince: 1000 }, () => 1700).detail, /Ethereum nodes this page reads disagree/);
  assert.doesNotMatch(describeFwd({ ...fwd, nodesSince: 1000 }, () => 1300).detail, /Ethereum nodes/);
  assert.doesNotMatch(describeFwd(fwd, () => 1700).detail, /Ethereum nodes/);
  const rev = { id: 'y', phase: 'offered', created: 5, deadline: 9000, offer: { evm: { amount: '1' }, btc: { value: '2' } } };
  assert.match(describeRev({ ...rev, nodesSince: 1000 }, () => 1700).detail, /A refund still goes out on time/);
  assert.doesNotMatch(describeRev({ ...rev, phase: 'done', nodesSince: 1000 }, () => 1700).detail, /Ethereum nodes/);
});

// ── a swap found again from the key is listed as the chains show it, from the first list after recover() (before any pump) ──
const freshStores = () => { const m = new Map(), named = (n) => { if (!m.has(n)) m.set(n, memStore()); return m.get(n); }; return { fwd: named('fwd'), index: named('index'), swaps: (id) => named('swaps:' + id), quotes: (id) => named('quotes:' + id) }; };
async function stepWorld(w, pairs, { lp = true } = {}) {
  await w.providerFeed.refresh().catch(() => {}); await w.clientFeed.refresh().catch(() => {});
  if (lp) { await w.fwd.tick(); await w.rev.tick(); }
  for (const p of pairs) await p.pump();
  w.evm.process();
}
async function e2bUntil(w, pair, phase) {
  const recOf = async () => (await w.mems.get('swaps:lp1').list())[0];
  for (let i = 0; i < 400 && (await recOf())?.phase !== phase; i++) { await stepWorld(w, [pair]); w.clock.advance(60); if (i % 10 === 9) w.btc.mine(1, { advance: false }); }
  assert.equal((await recOf()).phase, phase);
  return recOf();
}

test('found again from the key: a Bitcoin-for-ETH swap that completed is listed as done at once, never as returning', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  await w.pair.start(await w.pair.quote({ dir: 'b2e', amount: SATS }));
  await w.run(async () => (await w.first())?.state === 'done');
  const fresh = w.makePair({ stores: freshStores() });
  assert.equal(await fresh.recover(), 1);
  const [r] = await fresh.records();
  assert.deepEqual([r.dir, r.state, r.title], ['b2e', 'done', 'Done']);
  assert.equal(r.detail, 'The ETH is in your private balance.');
  assert.equal(r.refundAt, null);
});

test('found again from the key: while the swaps found are read one by one, each is listed as being checked, never first as returning', async () => {
  const w = pairWorld({ userSats: [200_000, 200_000] });
  await w.ready();
  for (let i = 0; i < 2; i++) {
    w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv' + i);
    await w.pair.start(await w.pair.quote({ dir: 'b2e', amount: SATS }));
    await w.run(async () => (await w.pair.records()).filter((r) => r.state === 'done').length === i + 1);
  }
  // what a page listing the swaps would show when the first step of the first one is written
  const st = freshStores(), put = st.fwd.put;
  let shown = null;
  st.fwd.put = async (r) => { if (!shown && r.phase !== 'refund-wait' && (await st.fwd.list()).length === 2) shown = (await st.fwd.list()).map((x) => describeFwd(x).title); return put(r); };
  const fresh = w.makePair({ stores: st });
  assert.equal(await fresh.recover(), 2);
  assert.deepEqual(shown, ['Checking', 'Checking'], 'the second swap is listed as being checked while the first is read');
  assert.deepEqual((await fresh.records()).map((r) => [r.state, r.title]), [['done', 'Done'], ['done', 'Done']]);
});

test('found again from the key: an ETH-for-Bitcoin swap whose BTC was taken on another page is listed as done at once', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  await w.pair.start(await w.pair.quote({ dir: 'e2b', amount: UNITS }));
  await w.run(async () => (await w.pair.records()).some((r) => r.dir === 'e2b' && r.state === 'done'));
  const sent = w.btc.broadcasts.length;
  w.uBtc.feeRate = async () => 7;                                   // fees moved since: a take built now is not the one that was sent
  const fresh = w.makePair({ stores: freshStores() });
  assert.equal(await fresh.recover(), 1);
  const [r] = await fresh.records();
  assert.deepEqual([r.dir, r.state, r.title, r.refundAt, r.backBy], ['e2b', 'done', 'Done', null, null]);
  assert.equal(w.btc.broadcasts.length, sent, 'nothing was sent again');
});

test('found again from the key: an ETH-for-Bitcoin swap the provider claimed is listed as taking the BTC, with no return of the ETH promised', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  await w.pair.start(await w.pair.quote({ dir: 'e2b', amount: UNITS }));
  const old = await e2bUntil(w, w.pair, 'offered');
  for (let i = 0; i < 60 && !w.evm.lockSpent.has(old.lock.lockNu); i++) { await stepWorld(w, []); w.clock.advance(60); }
  assert.ok(w.evm.lockSpent.has(old.lock.lockNu), 'the provider claimed; the old page is gone before it took the BTC');
  const fresh = w.makePair({ stores: freshStores() });
  assert.equal(await fresh.recover(), 1);
  const [r] = await fresh.records();
  assert.deepEqual([r.dir, r.state, r.title, r.refundAt], ['e2b', 'working', 'Your BTC is on its way', null]);
});

test('found again from the key: an ETH-for-Bitcoin swap whose ETH was refunded is listed as returned at once', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  await w.pair.start(await w.pair.quote({ dir: 'e2b', amount: UNITS }));
  const old = await e2bUntil(w, w.pair, 'offered');
  w.up.lp = false;                                                  // the provider never claims
  w.clock.advance(old.deadline - w.clock.now() + 700);
  for (let i = 0; i < 30 && (await w.mems.get('swaps:lp1').list())[0].phase !== 'refunded'; i++) { await stepWorld(w, [w.pair], { lp: false }); w.clock.advance(60); }
  assert.equal((await w.mems.get('swaps:lp1').list())[0].phase, 'refunded');
  const fresh = w.makePair({ stores: freshStores() });
  assert.equal(await fresh.recover(), 1);
  const [r] = await fresh.records();
  assert.deepEqual([r.dir, r.state, r.title], ['e2b', 'returned', 'Returned']);
});

test('found again from the key while the chains cannot be read: listed as being checked, never as returning or waiting, and resolved by the next pass', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  await w.pair.start(await w.pair.quote({ dir: 'b2e', amount: SATS }));
  await w.run(async () => (await w.first())?.state === 'done');
  const outspend = w.uBtc.outspend;
  w.uBtc.outspend = async () => { throw new Error('explorer down'); };
  const fresh = w.makePair({ stores: freshStores() });
  assert.equal(await fresh.recover(), 1);
  const [r] = await fresh.records();
  assert.deepEqual([r.state, r.title, r.refundAt, r.backBy], ['working', 'Checking', null, null]);
  assert.ok(r.steps.every((s) => s.state === 'todo'));
  w.uBtc.outspend = outspend;
  await fresh.pump();
  assert.deepEqual((await fresh.records()).map((x) => [x.state, x.title]), [['done', 'Done']]);
});

// ── a copy of the swaps read back from a file ──
// The copy's prefix names the key's public key, so a file that carries it may come from anywhere: only a copy the key signed is read, and a swap is locked only once checked here.
const copyWorld = () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
  const priv = secp.utils.randomPrivateKey(), pub = secp.getPublicKey(priv, true), pubHex = bytesToHex(pub);
  const prefix = `tacit-fastbridge-pair-v1:mainnet:${pubHex}:`;
  const macOf = (k) => { const key = hmac(sha256h, k, new TextEncoder().encode('tacit-btc-eth-swaps-copy-v1')); return (t) => bytesToHex(hmac(sha256h, key, new TextEncoder().encode(t))); };
  const NOW = Math.floor(Date.now() / 1000), t = 0x1234567890abcdefn, Tpt = secp.ProjectivePoint.BASE.multiply(t);
  const id = 'ab'.repeat(36), other = 'elsewhere', payee = '07'.repeat(32);
  const foreignItems = {
    [`${prefix}providers:${other}`]: JSON.stringify({ id: other, name: 'Tacit', ref: { kind: 'mailbox', boardBase: 'https://board.example', gateway: '02' + 'ee'.repeat(32), claimPub: '03' + 'ee'.repeat(32) } }),
    [`${prefix}${other}:quotes:q1`]: JSON.stringify({ id: 'q1', swapId: 'cd'.repeat(36), btcValue: '1000', evmAmount: '150000000', validUntil: NOW + 9999, lockerXonly: 'dd'.repeat(32), startedAt: NOW }),
    [`${prefix}${other}:swaps:${id}`]: JSON.stringify({
      v: 1, role: 'el', id, phase: 'locking', created: NOW - 60, updated: NOW - 60, quoteId: null, csvBlocks: 144, deadline: NOW + 4 * 3600, checked: 'ff'.repeat(32),
      lockTxid: 'cc'.repeat(32), lockVout: 0, lockValue: 1000,
      offer: { v: 1, swapId: id, T: bytesToHex(Tpt.toRawBytes(true)), claimerPub: pubHex,
        btc: { asset: SATS_ASSET, value: '1000', txid: 'cc'.repeat(32), vout: 0, csvBlocks: 144, lockerXonly: 'dd'.repeat(32) },
        evm: { asset: ETH_ASSET, amount: '150000000', recipient: payee, rOut: '09'.repeat(32) } },
    }),
  };
  const did = { locks: [], submits: [], calls: [] };
  let leaf = null, locked = false;
  const evm = {
    now: async () => NOW, refundKey: async () => ({ xonly: new Uint8Array(32).fill(5) }),
    lockNullifier: (l) => { leaf = l; return '0x' + 'cd'.repeat(32); }, lockPosition: async () => (locked ? 1 : null),
    lockOp: async (args) => { did.locks.push({ amount: args.rec.offer.evm.amount, recipient: args.recipient }); return { op: { amount: args.rec.offer.evm.amount }, lockLeaf: leaf }; },
    submit: async (kind, op) => { did.submits.push({ kind, op }); locked = true; return { jobId: 'job1' }; },
    jobStatus: async () => 'done', available: async () => 200000000n, findClaim: async () => null,
  };
  const stores = { fwd: makeLocalStore(`${prefix}fwd:`, storage), index: makeLocalStore(`${prefix}providers:`, storage), swaps: (i) => makeLocalStore(`${prefix}${i}:swaps:`, storage), quotes: (i) => makeLocalStore(`${prefix}${i}:quotes:`, storage) };
  const pair = makePairClient({
    btc: { wallet: { pub } }, evm, seed: new Uint8Array(32).fill(1), stores, discover: async () => [], counterFor: () => ({}),
    reverseCallFor: (ref) => async (method, path, body) => { did.calls.push({ ref, method, path, body }); return { status: 200, body: { ok: true } }; },
    feed: { current: () => null, refresh: async () => null },
  });
  return { mem, storage, priv, prefix, macOf, foreignItems, did, pair, id, NOW };
};
const lockedNothing = (did) => { assert.deepEqual(did.locks, []); assert.deepEqual(did.submits, []); assert.ok(!did.calls.some((c) => /evm-offer$/.test(c.path)), 'no pre-signature is sent'); };

test('a copy of the swaps that this key did not save is not read: no MAC, a MAC under another key, or the wallet not open; nothing is put back and nothing is locked', async () => {
  const w = copyWorld();
  const file = { v: 2, kind: 'tacit-btc-eth-swaps', prefix: w.prefix, at: w.NOW, items: w.foreignItems };
  assert.throws(() => loadCopy(JSON.stringify(file), w.prefix, w.storage), /Open your Tacit wallet/);
  assert.throws(() => loadCopy(JSON.stringify(file), w.prefix, w.storage, w.macOf(w.priv)), /saved before copies were signed/);
  assert.throws(() => loadCopy('not json at all', w.prefix, w.storage, w.macOf(w.priv)), /^Error: This file is not a swaps backup: it could not be read\.$/);
  const otherKey = secp.utils.randomPrivateKey();
  const signedByOther = { v: 2, kind: 'tacit-btc-eth-swaps', prefix: w.prefix, at: w.NOW, items: w.foreignItems };
  assert.throws(() => loadCopy(JSON.stringify({ ...signedByOther, mac: w.macOf(otherKey)(signed(signedByOther)) }), w.prefix, w.storage, w.macOf(w.priv)), /not saved by this wallet/);
  assert.equal(w.mem.size, 0);
  for (let i = 0; i < 3; i++) await w.pair.pump();
  lockedNothing(w.did);
});

test('a swap record that was not checked on this page (one written into storage, with a made-up check) is never locked against: it stops before anything is locked', async () => {
  const w = copyWorld();
  for (const [k, v] of Object.entries(w.foreignItems)) w.storage.setItem(k, v);
  for (let i = 0; i < 4; i++) await w.pair.pump();
  lockedNothing(w.did);
  const rec = JSON.parse(w.storage.getItem(`${w.prefix}elsewhere:swaps:${w.id}`));
  assert.equal(rec.phase, 'aborted');
  assert.match(rec.why, /not checked on this page/);
});

test('a copy this key saved is read back: swaps whose ETH is locked come back as found from the key, and the providers asked, the quotes and a swap before its ETH is locked do not', async () => {
  const w = copyWorld(), mac = w.macOf(w.priv);
  const offered = { ...JSON.parse(w.foreignItems[`${w.prefix}elsewhere:swaps:${w.id}`]), id: 'ef'.repeat(36), phase: 'offered', lock: { lockLeaf: '0x' + '11'.repeat(32), lockNu: '0x' + '22'.repeat(32) } };
  const fwd = { v: 1, role: 'bl', id: '33'.repeat(36), phase: 'done', created: w.NOW, amount: '1000', evmAmount: '5000', csvBlocks: 144 };
  const src = new Map(Object.entries({ ...w.foreignItems, [`${w.prefix}elsewhere:swaps:${offered.id}`]: JSON.stringify(offered), [`${w.prefix}fwd:${fwd.id}`]: JSON.stringify(fwd) }));
  const srcStorage = { getItem: (k) => src.get(k) ?? null, key: (i) => [...src.keys()][i] ?? null, get length() { return src.size; } };
  const copy = saveCopy(w.prefix, srcStorage, mac);
  assert.equal(loadCopy(JSON.stringify(copy), w.prefix, w.storage, mac), 2);
  assert.deepEqual([...w.mem.keys()].sort(), [`${w.prefix}fwd:${fwd.id}`, `${w.prefix}providers:recovered`, `${w.prefix}recovered:swaps:${offered.id}`].sort());
  assert.equal(JSON.parse(w.storage.getItem(`${w.prefix}providers:recovered`)).ref.kind, 'recovered');
  // a copy whose items were changed after it was signed is not read
  const changed = { ...copy, items: { ...copy.items, [`${w.prefix}fwd:${fwd.id}`]: JSON.stringify({ ...fwd, phase: 'built' }) } };
  assert.throws(() => loadCopy(JSON.stringify(changed), w.prefix, copyWorld().storage, mac), /not saved by this wallet/);
  for (let i = 0; i < 3; i++) await w.pair.pump();
  lockedNothing(w.did);
  assert.ok((await w.pair.records()).some((r) => r.id === offered.id && r.provider === 'Found from your key'));
});

// ── what the page says of a provider's refusal ──
const wordsWorld = ({ quote, reserve }) => {
  const NOW = Math.floor(Date.now() / 1000), claimPub = '02' + 'aa'.repeat(32);
  const provider = { id: claimPub, name: 'Provider aaaaaaaaaaaa', ref: { kind: 'http', base: 'https://p.example', claimPub }, assets: { btcAsset: SATS_ASSET, evmAsset: ETH_ASSET }, terms: { minAmount: 10000n, maxAmount: 100000000n } };
  const good = (sats) => ({ id: 'q1', claimPub, btcAsset: SATS_ASSET, evmAsset: ETH_ASSET, btcValue: String(sats), evmAmount: String(sats * 35n), csvBlocks: 144, validUntil: NOW + 600 });
  const counter = { quote: async (sats) => (quote ? quote(sats) : good(sats)), reserve: async () => reserve() };
  const feed = makeRateFeed({ sources: [async () => 35, async () => 35] });
  return makePairClient({ btc: { wallet: { pub: new Uint8Array(33).fill(2) }, satsUtxos: async () => [{ txid: 'ab'.repeat(32), vout: 0, value: 50_000_000 }] }, evm: {}, seed: new Uint8Array(32), stores: { fwd: memStore() }, discover: async () => [provider], counterFor: () => counter, reverseCallFor: () => null, feed });
};
const PROVIDER_TEXT = 'Send 0.1 BTC to bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh to unlock your swap';

test('a provider\'s refusal is said in the page\'s own words: what its answer says (an address, a link, any text) is not shown', async () => {
  const pair = wordsWorld({ quote: () => { throw Object.assign(new Error(PROVIDER_TEXT), { status: 400 }); } });
  const e = await pair.quote({ dir: 'b2e', amount: 1_000_000n }).then(() => null, (x) => x);
  assert.equal(e && e.message, 'no provider could quote that amount just now');
  const busy = wordsWorld({ quote: () => { throw Object.assign(new Error('rate limited, ' + PROVIDER_TEXT), { status: 429 }); } });
  assert.equal(await busy.quote({ dir: 'b2e', amount: 1_000_000n }).then(() => null, (x) => x.message), 'the provider is busy', 'a refusal of a known kind gets the page\'s sentence for it');
  const held = wordsWorld({ reserve: () => ({ ok: false, why: PROVIDER_TEXT }) });
  const q = await held.quote({ dir: 'b2e', amount: 1_000_000n });
  assert.equal(q.blocked, null);
  const r = await held.start(q).then(() => null, (x) => x.message);
  assert.match(r, /^the provider cannot hold that amount just now/);
});

test('two pages of one key that start at the same moment take turns: one start runs at a time, and each locks a coin of its own', async () => {
  const w = pairWorld({ userSats: [300_000, 300_000] });
  await w.ready();
  for (let i = 0; i < 4; i++) w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount * 2n, 'inv' + i);       // (a provider holds a payout it is not yet backed for up to half of what it has)
  // (the coins are read as an explorer reads them, a moment behind: a start that ran beside another would read the other's coin as free)
  const btc = Object.assign(Object.create(Object.getPrototypeOf(w.uBtc)), w.uBtc, { satsUtxos: async (...a) => { const r = await w.uBtc.satsUtxos(...a); await new Promise((x) => setTimeout(x, 30)); return r; } });
  let queue = Promise.resolve(), inside = 0, most = 0;
  const exclusive = (work) => { const r = queue.then(async () => { most = Math.max(most, ++inside); try { return await work(); } finally { inside--; } }); queue = r.catch(() => {}); return r; };
  const a = w.makePair({ btc, exclusive }), b = w.makePair({ btc, exclusive });
  const [qa, qb] = [await a.quote({ dir: 'b2e', amount: SATS }), await b.quote({ dir: 'b2e', amount: SATS })];
  const got = await Promise.allSettled([a.start(qa), b.start(qb)]);
  assert.equal(most, 1, 'the two starts did not run side by side');
  assert.equal(got.filter((g) => g.status === 'fulfilled').length, 2, JSON.stringify(got.map((g) => g.reason && g.reason.message)));
  const ins = (await w.mems.get('fwd').list()).map((r) => (r.feeInputs || []).map((i) => `${i.txid}:${i.vout}`).join(','));
  assert.equal(ins.length, 2);
  assert.notEqual(ins[0], ins[1], 'each start locked a coin of its own');
});

// ── which providers are asked ──
const manyWorld = (n, { behave = () => ({}), strikes = null } = {}) => {
  const NOW = Math.floor(Date.now() / 1000), asked = [];
  const keyOf = (i) => '02' + i.toString(16).padStart(2, '0').repeat(32);
  const ps = Array.from({ length: n }, (_, i) => ({ id: keyOf(i), name: `P${i}`, ref: { kind: 'http', base: `https://p${i}.example`, claimPub: keyOf(i) }, assets: { btcAsset: SATS_ASSET, evmAsset: ETH_ASSET }, terms: { minAmount: 10000n, maxAmount: 100000000n, feeBps: 10 * (i + 1), flatFee: 0n } }));
  const counterFor = (ref) => {
    const i = ps.findIndex((x) => x.ref === ref), b = behave(i) || {};
    return {
      quote: async (sats) => { asked.push(i); if (b.quote) return b.quote(sats); return { id: `q${i}`, claimPub: ps[i].ref.claimPub, btcAsset: SATS_ASSET, evmAsset: ETH_ASSET, btcValue: String(sats), evmAmount: String((sats * (3500n - BigInt(i))) / 100n), csvBlocks: 144, validUntil: NOW + 600 }; },
      reserve: async () => (b.reserve ? b.reserve() : { ok: true }),
    };
  };
  const feed = makeRateFeed({ sources: [async () => 35, async () => 35] });
  const pair = makePairClient({ btc: { wallet: { pub: new Uint8Array(33).fill(2) }, satsUtxos: async () => [{ txid: 'ab'.repeat(32), vout: 0, value: 50_000_000 }] }, evm: {}, seed: new Uint8Array(32), stores: { fwd: memStore() }, discover: async () => ps, counterFor, reverseCallFor: () => null, feed, ...(strikes ? { strikes } : {}) });
  return { pair, asked, ps };
};

test('a quote asks the best eight providers by their advertised terms, not every provider there is', async () => {
  const w = manyWorld(11);
  const q = await w.pair.quote({ dir: 'b2e', amount: 1_000_000n });
  assert.deepEqual([...w.asked].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(q.provider.name, 'P0');
});

test('a provider that fails is asked after the others for a while, and one that keeps failing is left out; what failed is kept across visits', async () => {
  let kept = {};
  const strikes = { get: () => kept, put: (m) => { kept = m; } };
  const down = (i) => (i === 0 ? { quote: async () => { throw Object.assign(new Error('down'), { status: 503 }); } } : {});
  const w = manyWorld(5, { behave: down, strikes });
  for (let i = 0; i < 3; i++) { w.asked.length = 0; assert.equal((await w.pair.quote({ dir: 'b2e', amount: 1_000_000n })).provider.name, 'P1'); }
  assert.equal(kept[w.ps[0].id].n, 3);
  const again = manyWorld(5, { behave: down, strikes });
  await again.pair.quote({ dir: 'b2e', amount: 1_000_000n });
  assert.ok(!again.asked.includes(0), 'struck three times: not asked while others can be');
  assert.deepEqual([...again.asked].sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('a provider that cannot hold its quote is not given up on: the page is told to ask again, and the next quote is the next best provider\'s', async () => {
  const w = manyWorld(2, { behave: (i) => (i === 0 ? { reserve: () => ({ ok: false, why: 'no' }) } : {}) });
  const q = await w.pair.quote({ dir: 'b2e', amount: 1_000_000n });
  assert.equal(q.provider.name, 'P0');
  const e = await w.pair.start(q).then(() => null, (x) => x);
  assert.ok(e && e.requote, 'the start says to ask again');
  assert.match(e.message, /a new quote is being asked for/);
  assert.equal((await w.pair.quote({ dir: 'b2e', amount: 1_000_000n })).provider.name, 'P1', 'and the provider that failed is asked after the others');
});

test('a Bitcoin fee above 2% of the amount is said with the quote, and a start needs it accepted', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const dear = Object.assign(Object.create(Object.getPrototypeOf(w.uBtc)), w.uBtc, { feeRate: async () => 40 });
  const pair = w.makePair({ btc: dear });
  const q = await pair.quote({ dir: 'b2e', amount: SATS });
  assert.ok(q.highFee && q.highFee.sats === q.networkFeeSats && q.highFee.bps > 200, JSON.stringify(q.highFee));
  await assert.rejects(() => pair.start(q), /the Bitcoin fee is about \d+ sats, \d+\.\d% of the amount: accept it to go on/);
  assert.equal(w.btc.broadcasts.length, 0, 'nothing was sent');
  const cheap = await w.pair.quote({ dir: 'b2e', amount: SATS });
  assert.equal(cheap.highFee, null, 'at the usual rate there is nothing to accept');
});

test('one press: a deposit that is mined but not yet a note starts an ETH-for-Bitcoin swap; the lock waits for the note and is made once it lands, and the swap ends done', async () => {
  const w = pairWorld();
  await w.ready();
  const q = await w.pair.quote({ dir: 'e2b', amount: UNITS });
  await assert.rejects(() => w.pair.start(q), /private ETH does not cover/, 'with nothing private and nothing coming, nothing is asked');
  await assert.rejects(() => w.pair.start(q, { coming: UNITS - 1n }), /private ETH does not cover/, 'a deposit of less than the amount does not cover it');
  assert.equal((await w.rev.handle({ method: 'GET', path: '/reverse/info' })).body.open, 0, 'the provider was not asked');
  const { id } = await w.pair.start(q, { coming: UNITS });
  assert.match(id, /^[0-9a-f]{72}$/, 'a deposit of exactly the amount, mined and landing, starts the swap');
  assert.equal((await w.rev.handle({ method: 'GET', path: '/reverse/info' })).body.open, 1, 'and the provider was asked to lock');
  // the provider locks and the lock confirms; the note has not landed, so no lock of ETH can be made yet
  await w.run(async () => (await w.pair.records()).some((r) => r.id === id && r.title === 'Sending your ETH'));
  for (let i = 0; i < 4; i++) { await w.step(); w.clock.advance(30); }
  assert.deepEqual(w.evm.submitted.filter((j) => j.type === 'adaptorlock'), [], 'nothing is locked before the note is there');
  const waiting = (await w.pair.records()).find((r) => r.id === id);
  assert.equal(waiting.state, 'working');
  assert.ok(waiting.etaSecs > 600 && waiting.etaSecs <= 1050, `one overall time left, to the BTC confirmed (${waiting.etaSecs})`);
  w.uEvm.fund(UNITS, 'landed');                                      // the relay settles the deposit: the note lands
  await w.run(async () => (await w.pair.records()).some((r) => r.id === id && r.state === 'done'));
  const done = (await w.pair.records()).find((r) => r.id === id);
  assert.deepEqual(w.evm.submitted.map((j) => j.type), ['adaptorlock', 'adaptorclaim'], 'the lock was made from the note once it landed, and the provider claimed');
  assert.ok(done.got > 100_000n && done.got < done.get, `what arrived is said: the lock less the take's fee (${done.got} of ${done.get})`);
});

test('the lane\'s words for an ETH-for-Bitcoin swap: the wait for the provider\'s lock is said, and the time left counts down within a step', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  const q = await w.pair.quote({ dir: 'e2b', amount: UNITS });
  const { id } = await w.pair.start(q);
  const first = await w.first();
  assert.deepEqual([first.title, first.etaSecs, first.lockTxid], ['The provider is locking BTC for you', 1710, null], 'asked: the whole swap ahead');
  w.clock.advance(300);
  const later = (await w.pair.records()).find((r) => r.id === id);
  assert.equal(later.etaSecs, 1710 - 300, 'five minutes on, five minutes less');
  // the provider sends its lock and says its txid: the page shows it, and its confirmations, while the lock waits for its block
  await w.rev.tick(); await w.pair.pump();
  const seen = (await w.pair.records()).find((r) => r.id === id);
  assert.equal(seen.title, 'Provider sent BTC');
  assert.match(seen.lockTxid || '', /^[0-9a-f]{64}$/, 'the lock\'s txid, for a link to it');
  assert.match(seen.detail, /Waiting for one Bitcoin confirmation\. A block takes about 10 min/);
  assert.equal(seen.etaSecs, 1650, 'counted from when the lock was seen');
  w.clock.advance(3600);
  const late = (await w.pair.records()).find((r) => r.id === id);
  assert.equal(late.etaSecs, 0, 'an hour without the block: no countdown (one that sat at the same minutes for an hour read as frozen beside the slow-block line, 2026-11-28); the card says why');
  assert.match(late.detail, /No Bitcoin block for|A block came without/, 'and the card says why');
  assert.match(late.detail, /No Bitcoin block for \d+ min\. Blocks come.*Your swap is safe: nothing of yours moves until the provider’s BTC is confirmed\./, 'a slow block is said, and that the swap is safe');
  assert.equal(describeRev({ id, phase: 'taking', phaseAt: 0, offer: { evm: { amount: '1' }, btc: { value: '1' } } }, () => 120).title, 'Your BTC is on its way');
});

test('the note a lock spends is cut to its amount at the start, while the provider\'s lock waits for its block; a deposit still landing is cut for once it lands', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS * 2n, 'big');
  const asked = [];
  const pair = w.makePair({ evm: { ...w.uEvmCtx, prepare: async ({ rec }) => { asked.push(rec.offer.evm.amount); } } });
  await pair.start(await pair.quote({ dir: 'e2b', amount: UNITS }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(asked, [String(UNITS)], 'started from private ETH: the exact note is made at once');
  const fresh = pairWorld();
  await fresh.ready();
  const later = [];
  const p2 = fresh.makePair({ evm: { ...fresh.uEvmCtx, prepare: async ({ rec }) => { later.push(rec.offer.evm.amount); } } });
  await p2.start(await p2.quote({ dir: 'e2b', amount: UNITS }), { coming: UNITS });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(later, [], 'started on a deposit still landing: nothing to cut yet');
  await p2.prepare(UNITS);
  assert.deepEqual(later, [String(UNITS)], 'the page asks once the deposit has landed');
});

test('one press from a Bitcoin wallet: a payment to the address not yet in a block funds the lock at once (the two confirm together), and the swap ends done', async () => {
  const w = pairWorld();
  await w.ready();
  const out = w.fwd.quoter.price(SATS).evmAmount;
  w.lEvm.fund(out, 'inv0');
  // the payment has reached the address but no block has it: the address's confirmed coins do not list it
  const unconfirmed = Object.assign(Object.create(Object.getPrototypeOf(w.uBtc)), w.uBtc, { satsUtxos: async () => [], satsCoins: async () => ({ coins: [], pending: 200_000 }) });
  const pair = w.makePair({ btc: unconfirmed });
  const q = await pair.quote({ dir: 'b2e', amount: SATS });
  assert.ok(q.short && q.short.have === 0n, 'the confirmed coins are short of the lock: the quote says so');
  await assert.rejects(() => pair.start(q), /your Bitcoin address holds 0 sats/, 'with nothing paid in, nothing starts');
  const { id } = await pair.start(q, { coins: [w.uCoins[0]] });
  assert.equal(id, bytesToHex(X.swapIdOf(w.uCoins[0].txid, w.uCoins[0].vout)), 'the lock spends the payment first (the swap is named by it)');
  w.pair = pair;
  await w.run(async () => (await pair.records()).some((r) => r.id === id && r.state === 'done'));
  assert.deepEqual(w.evm.submitted.map((j) => j.type), ['adaptorlock', 'adaptorclaim'], 'the provider locked ETH, the user claimed it');
});

test('the coins a payment made to this address are read from its transaction, in a block or not, and only those still unspent', async () => {
  const wallet = { pub: new Uint8Array(33).fill(2) };
  const mine = '0014' + 'ab'.repeat(20);
  const tx = { vout: [{ scriptpubkey: '0014' + 'cd'.repeat(20), value: 90000 }, { scriptpubkey: mine, value: 150000 }, { scriptpubkey: mine, value: 500 }, { scriptpubkey: mine, value: 70000 }] };
  const btc = { wallet, prims: { p2wpkhScript: () => hexToBytes(mine) }, fetchTx: async (t) => (t === 'ee'.repeat(32) ? tx : null), outspend: async (t, v) => (v === 3 ? 'ff'.repeat(32) : null) };
  const mem = () => ({ list: async () => [], get: async () => null, put: async () => {} });
  const pc = makePairClient({ btc, evm: {}, seed: new Uint8Array(32), discover: async () => [], counterFor: () => null, reverseCallFor: () => null, feed: {}, stores: { fwd: mem(), index: mem(), swaps: () => mem(), quotes: () => mem() } });
  assert.deepEqual(await pc.arriving('ee'.repeat(32)), [{ txid: 'ee'.repeat(32), vout: 1, value: 150000 }], 'its output to this address; not dust, not another address, not one spent');
  assert.deepEqual(await pc.arriving('11'.repeat(32)), [], 'a transaction no explorer has yet: nothing');
  assert.deepEqual(await pc.arriving('not a txid'), []);
});

// ── the tab closed (or the device lost) after the provider locked its ETH: the key, the chain and the provider's published offer finish the swap ──
test('record lost after the provider locked: the swap is found again from the key and the claim is built from key-only data', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  await w.pair.start(await w.pair.quote({ dir: 'b2e', amount: SATS }));
  // the page is gone once the provider's offer for this swap is out (its lock is in the pool) and the user has not claimed
  const rec0 = async () => (await w.mems.get('fwd').list())[0];
  const offerOut = async () => { const r = await rec0(); if (!r) return false; const a = await w.fwd.handle({ method: 'GET', path: '/swap/' + r.id + '/offer' }); return a.status === 200 && a.body.offer !== null; };
  for (let i = 0; i < 800 && !(await offerOut()); i++) { await stepWorld(w, []); w.clock.advance(30); if (i % 20 === 19) w.btc.mine(1, { advance: false }); await w.pair.pump(); }
  const rec = await rec0();
  assert.ok(await offerOut(), 'the provider locked and published its offer');
  assert.ok(!rec.claim, 'the user had not claimed');
  const lost = freshStores();
  const fresh = w.makePair({ stores: lost });
  assert.equal(await fresh.recover(), 1);
  const kept = (await lost.fwd.list())[0];
  assert.equal(kept.id, rec.id);
  assert.ok(kept.recovered && kept.claimFromKey);
  const phase = async () => (await lost.fwd.list())[0].phase;
  for (let i = 0; i < 800 && !['done', 'claimed', 'refund-wait'].includes(await phase()); i++) { await stepWorld(w, [fresh]); w.clock.advance(30); if (i % 20 === 19) w.btc.mine(1, { advance: false }); }
  const end = (await lost.fwd.list())[0];
  assert.ok(['claimed', 'done'].includes(end.phase), 'finished from the key: ' + end.phase + ' ' + (end.why || ''));
  assert.ok(end.claim && end.claim.op, 'the claim was built from the key and the published offer');
  assert.equal(end.evmAmount, String(end.evmOffer.amount));
});

test('a lock found again from the key whose provider never shows an offer: said neutrally, then returned, and the offer is asked for a few times, not every pass', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  await w.pair.start(await w.pair.quote({ dir: 'b2e', amount: SATS }));
  const rec0 = async () => (await w.mems.get('fwd').list())[0];
  for (let i = 0; i < 40 && !((await rec0()).lockConfs > 0 || (await w.btc.status((await rec0()).lock.txid)).confirmations > 0); i++) { w.btc.mine(1, { advance: false }); await w.pair.pump(); }
  let looks = 0;
  const { makeCounter } = await import('../dapp/fastbridge-http.js');
  const lost = freshStores();
  const fresh = w.makePair({ stores: lost, counterFor: () => makeCounter(async (method, path, body) => {
    if (method === 'GET' && /^\/swap\/[0-9a-f]+\/offer$/.test(path)) { looks++; return { status: 200, body: { offer: null } }; }
    const r = await w.fwd.handle({ method, path, body }); return { status: r.status, body: r.body };
  }) });
  assert.equal(await fresh.recover(), 1);
  const titles = new Set();
  for (let i = 0; i < 400; i++) {
    const r = (await fresh.pump())[0];
    titles.add(r.title);
    assert.ok(!/sending ETH/i.test(r.title + r.detail), 'it never says the provider is sending ETH while no offer was seen');
    if (r.title === 'Returning your BTC') break;
    w.clock.advance(15);
  }
  assert.ok(titles.has('Checking your swap…'), 'neutral while it waits: ' + [...titles]);
  assert.equal((await lost.fwd.list())[0].phase, 'refund-wait', 'with no offer after twenty minutes it goes to the refund');
  assert.ok(looks >= 2 && looks <= 10, `the offer was asked for a few times, with a growing gap (${looks})`);
});

test('two swap ids give unrelated secrets (t, the lock blinding, the claim output blinding)', () => {
  const seed = new Uint8Array(32).fill(7);
  const a = X.deriveSwapSecrets({ seed, swapId: new Uint8Array(36).fill(1) }), b = X.deriveSwapSecrets({ seed, swapId: new Uint8Array(36).fill(2) });
  assert.ok(a.t !== b.t && a.rOut !== b.rOut && a.rLock !== b.rLock && a.t !== a.rOut && a.t !== a.rLock);
});

test('a busy Bitcoin is said on a card that waits for a confirmation, and is not said when the fee for the next block is low', () => {
  assert.equal(busyLine(null), ''); assert.equal(busyLine({ fee: 2 }), ''); assert.equal(busyLine({ fee: null }), '');
  assert.match(busyLine({ fee: 7.6 }), /Bitcoin is busy: the next block takes about 8 sat\/vB or more/);
  const rec = { id: 'a'.repeat(72), role: 'bl', phase: 'broadcast', phaseAt: 0, amount: '26000', provider: 'p', created: 0 };
  assert.match(describeFwd(rec, () => 100, { height: 1, at: 90, fee: 9 }).detail, /Bitcoin is busy/);
  assert.doesNotMatch(describeFwd(rec, () => 100, { height: 1, at: 90, fee: 2 }).detail, /busy/);
});

test('a long wait for a block gives no countdown (the card says why): a slow block, or a block that came without the payment', () => {
  const t0 = 1_000_000, rec = { id: 'a'.repeat(72), role: 'bl', phase: 'broadcast', phaseAt: t0, broadcastAt: t0, amount: '26000', evmAmount: '900000', provider: 'p', created: t0, csvBlocks: 96 };
  const fresh = describeFwd(rec, () => t0 + 120, { height: 10, at: t0 - 60, fee: 2 });
  assert.ok(fresh.etaSecs > 0 && !/block came without/.test(fresh.detail), 'just sent, a normal block time: a countdown, nothing else said');
  const slow = describeFwd(rec, () => t0 + 1800, { height: 10, at: t0 - 60, fee: 2 });
  assert.equal(slow.etaSecs, 0, 'no block for half an hour: the countdown is gone (it said "about 8 min" for 45 minutes on 2026-11-28)');
  assert.match(slow.detail, /No Bitcoin block for 31 min/);
  const missed = describeFwd(rec, () => t0 + 1500, { height: 11, at: t0 + 1200, fee: 4 });
  assert.equal(missed.etaSecs, 0, 'a block came without the payment: no countdown either');
  assert.match(missed.detail, /A block came without your BTC payment: Bitcoin is busy.*This page raises its fee by itself/);
  assert.equal(missedLine({ height: 11, at: t0 + 60 }, t0, 'you'), '', 'a block within two minutes of the send is not counted (block times run off the clock)');
  const rev = { id: 'b'.repeat(72), role: 'el', phase: 'accepted', phaseAt: t0, created: t0, offer: { btc: { value: '22000' }, evm: { amount: '800000' } }, lockConfs: 0 };
  const rm = describeRev(rev, () => t0 + 1500, { height: 11, at: t0 + 1200, fee: 4 });
  assert.equal(rm.etaSecs, 0, 'the provider\'s lock missed a block: no countdown');
  assert.match(rm.detail, /A block came without the provider’s BTC.*The provider raises its fee by itself/);
  assert.ok(describeRev({ ...rev, lockConfs: 1 }, () => t0 + 1500, { height: 11, at: t0 + 1200, fee: 4 }).etaSecs > 0, 'once confirmed, the countdown is back for what follows');
});

let passed = 0;
for (const [name, fn] of tests) {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} pair checks passed`);
process.exit(process.exitCode || 0);
