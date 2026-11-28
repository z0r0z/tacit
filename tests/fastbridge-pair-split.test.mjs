// Bitcoin for ETH across several providers, the whole way: the pair client (dapp/fastbridge-pair.js) quotes a split, sends ONE Bitcoin transaction with a lock output for each
// provider, and each lock is a swap of its own with its own provider (dapp/fastbridge-provider.js), in the simulated Bitcoin and pool of tests/lib/chain-sim.mjs on one virtual
// clock (tests/lib/pair-world-multi.mjs). The cases: a split that goes through, a provider that cannot hold its share before anything is sent, a provider that goes quiet after
// the send (its leg is returned by its own timelock while the others finish), a page closed after the send (the legs found again from the key), the vout binding at the
// provider, and an old provider (not asked for a share).
//   node tests/fastbridge-pair-split.test.mjs        (Node 22)
import assert from 'node:assert/strict';
import * as X from '../dapp/adaptor-xswap.js';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { fetched } from './lib/btc-sim.mjs';
import { multiWorld } from './lib/pair-world-multi.mjs';
import { describeBatch } from '../dapp/fastbridge-pair.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const NAMES = ['Alpha', 'Bravo', 'Charlie'];
// every provider holds enough for its largest share (what the ads show), and a note of exactly what each planned leg pays out (what its lock is made from)
const ample = (w) => { for (const n of NAMES) w.fund(n, 150_000n, 'cap'); };
const fundLegs = (w, q) => { for (const l of q.split.legs) w.fund(l.provider.name, l.pay, 'leg'); };
const txsPaying = (w, spk) => [...w.btc.txs.values()].filter((e) => e.esplora.vout.some((o) => o.scriptpubkey === spk));

test('an amount no provider takes is quoted as a split of three, with the plan shown, and goes through: one transaction, three swaps, one card, all the ETH', async () => {
  const w = multiWorld();
  await w.ready(); ample(w);
  const q = await w.pair.quote({ dir: 'b2e', amount: 400_000n });
  assert.ok(q.split, 'a split is quoted');
  assert.deepEqual(q.split.legs.map((l) => [l.provider.name, l.pay]), [['Alpha', 150_000n], ['Bravo', 150_000n], ['Charlie', 100_000n]]);
  assert.equal(q.pay, 400_000n);
  assert.equal(q.get, q.split.legs.reduce((t, l) => t + l.get, 0n), 'the total is what the legs pay');
  assert.equal(q.provider.name, '3 providers');
  assert.equal(q.split.single, null, 'no one provider can take it');
  assert.equal(q.blocked, null);
  assert.ok(q.networkFeeSats > 0, 'one network fee for the one transaction');
  fundLegs(w, q);
  const r = await w.pair.start(q);
  assert.equal(r.ids.length, 3);
  assert.equal(new Set(r.ids).size, 3, 'a swap id for each');
  assert.equal(w.btc.broadcasts.length, 1, 'ONE Bitcoin transaction pays all three locks');
  const [lockTx] = [...w.btc.txs.values()];
  assert.equal(lockTx.esplora.vout.filter((o) => o.scriptpubkey.startsWith('5120')).length, 3);
  const cards = await w.pair.records();
  assert.equal(cards.length, 1, 'one card for the three swaps');
  assert.equal(cards[0].title, 'Swapping across 3 providers');
  assert.equal(cards[0].batch.legs.length, 3);
  await w.run(async () => (await w.pair.records())[0]?.state === 'done');
  const card = (await w.pair.records())[0];
  assert.equal(card.title, 'Done');
  assert.equal(card.got, q.get, 'the done card sums what came to the private balance');
  assert.deepEqual(card.batch.legs.map((l) => l.state), ['done', 'done', 'done']);
  assert.equal(w.evm.submitted.filter((j) => j.type === 'adaptorlock').length, 3);
  assert.equal(w.evm.submitted.filter((j) => j.type === 'adaptorclaim').length, 3);
  // the providers took their locks: three more transactions, each spending its own output
  assert.equal(w.btc.broadcasts.length, 4);
  const lockTxid = [...w.btc.txs.keys()][0];
  for (const k of [0, 1, 2]) assert.ok(w.btc.spends.get(`${lockTxid}:${k}`), `output ${k} was taken by its provider`);
  // each provider's own record names its own output and the total the transaction locked
  for (const [k, n] of NAMES.entries()) {
    const [rec] = await w.p[n].store.list();
    assert.equal(rec.lockVout, k);
    assert.equal(rec.lockTotal, 400_000, `${n} weighs its confirmations by the whole 400,000 the transaction locks`);
  }
});

test('the confirmations a leg waits for are those of the total the transaction moves, not of its own share', async () => {
  // a provider asks one confirmation under 1,000,000 sats' worth and three above: a share of 150,000 would take one; the transaction's total of 400,000 is weighed too
  const tier = (v) => (v >= 300_000n ? 3 : 1);
  const w = multiWorld({ providers: ['Alpha', 'Bravo', 'Charlie'].map((name) => ({ name, feeBps: 30, flatFee: 500, minAmount: 20_000, maxAmount: 150_000, minConfsFor: tier })) });
  await w.ready(); ample(w);
  const q = await w.pair.quote({ dir: 'b2e', amount: 400_000n });
  fundLegs(w, q);
  await w.pair.start(q);
  const txid = [...w.btc.txs.keys()][0];
  w.btc.mine(1);
  for (let i = 0; i < 6; i++) { await w.step(); }
  for (const n of NAMES) assert.equal((await w.p[n].store.list()).filter((r) => r.phase !== 'accepted').length, 0, `${n} has not locked ETH on one confirmation`);
  w.btc.mine(2);
  await w.run(async () => (await w.pair.records())[0]?.state === 'done');
  assert.ok(txid);
});

test('a provider that cannot hold its share before the send: nothing is sent, it is struck, and the next quote is of the others', async () => {
  const w = multiWorld();
  await w.ready(); ample(w); ample(w); ample(w); ample(w); ample(w);       // (more: what the failed start held at Alpha is not available to the next quote)
  const q = await w.pair.quote({ dir: 'b2e', amount: 280_000n });
  assert.deepEqual(q.split.legs.map((l) => l.provider.name), ['Alpha', 'Bravo'], 'two providers fill 280,000');
  w.ctl.Bravo.refuseReserve = true;
  await assert.rejects(() => w.pair.start(q), (e) => e.requote === true && /cannot hold its share/.test(e.message));
  assert.equal(w.btc.broadcasts.length, 0, 'nothing was sent');
  assert.equal((await w.pair.records()).length, 0);
  const q2 = await w.pair.quote({ dir: 'b2e', amount: 280_000n });
  assert.deepEqual(q2.split.legs.map((l) => l.provider.name), ['Alpha', 'Charlie'], 'the plan is made again without it');
  assert.equal(q2.pay, 280_000n);
  fundLegs(w, q2);
  await w.pair.start(q2);
  await w.run(async () => (await w.pair.records())[0]?.state === 'done');
  assert.equal((await w.pair.records())[0].got, q2.get);
});

test('a provider that goes quiet after the send: its leg is returned by its own timelock, the others finish, and the card says so plainly', async () => {
  const w = multiWorld();
  await w.ready(); ample(w);
  const q = await w.pair.quote({ dir: 'b2e', amount: 400_000n });
  fundLegs(w, q);
  w.ctl.Bravo.stallOffers = true;
  await w.pair.start(q);
  const lockTxid = [...w.btc.txs.keys()][0];
  const ok = async () => { const c = (await w.pair.records())[0]; return c.batch.legs.filter((l) => l.state === 'done').length === 2; };
  await w.run(ok);
  let card = (await w.pair.records())[0];
  assert.equal(card.state, 'working', 'the card goes on while one part waits');
  assert.match(card.detail, /Each part is its own swap/);
  const b = card.batch.legs.find((l) => l.provider === 'Bravo');
  assert.ok(b.state === 'working' && b.refundAt > 0, 'Bravo\'s part says when its BTC returns');
  assert.ok(!w.btc.spends.get(`${lockTxid}:1`), 'the lock of the quiet provider is unspent');
  // its timelock runs (144 blocks) and the page returns that BTC
  w.btc.mine(150);
  await w.run(async () => (await w.pair.records())[0].state !== 'working');
  card = (await w.pair.records())[0];
  assert.equal(card.state, 'done');
  assert.match(card.title, /^Done: 2 of 3 parts$/);
  assert.match(card.detail, /did not go through; that BTC is back/);
  assert.deepEqual(card.batch.legs.map((l) => [l.provider, l.state]), [['Alpha', 'done'], ['Bravo', 'returned'], ['Charlie', 'done']]);
  const done = q.split.legs.filter((l) => l.provider.name !== 'Bravo').reduce((t, l) => t + l.get, 0n);
  assert.equal(card.got, done, 'what the two that went through paid');
  assert.ok(w.btc.spends.get(`${lockTxid}:1`), 'the refund spent Bravo\'s output');
});

test('a page closed after the send: the legs are found again from the key, each is read from the chain, and the lock nobody took is returned', async () => {
  const w = multiWorld();
  await w.ready(); ample(w);
  const q = await w.pair.quote({ dir: 'b2e', amount: 400_000n });
  fundLegs(w, q);
  for (const n of NAMES) w.ctl[n].stallOffers = true;
  await w.pair.start(q);
  w.btc.mine(1);
  assert.equal(w.btc.broadcasts.length, 1);
  // a new page of the same key: none of the records
  const ms = () => new Map(), mem = (m) => ({ get: async (k) => m.get(k) ?? null, put: async (r) => { m.set(r.id, r); }, list: async () => [...m.values()], delete: async (k) => { m.delete(k); } });
  const named = new Map(), nm = (n) => { if (!named.has(n)) named.set(n, mem(ms())); return named.get(n); };
  const fresh = w.makePair({ stores: { fwd: mem(ms()), index: mem(ms()), swaps: (id) => nm('s' + id), quotes: (id) => nm('q' + id) } });
  const n = await fresh.recover();
  assert.equal(n, 3, 'the three legs are found');
  const cards = await fresh.records();
  assert.equal(cards.length, 1, 'regrouped as one card');
  assert.equal(cards[0].batch.n, 3);
  w.btc.mine(150);
  for (let i = 0; i < 12; i++) { await fresh.pump(); w.clock.advance(60); }
  const end = (await fresh.records())[0];
  assert.equal(end.state, 'returned', `every part returned: ${end.title}`);
  const lockTxid = [...w.btc.txs.keys()][0];
  for (const k of [0, 1, 2]) assert.ok(w.btc.spends.get(`${lockTxid}:${k}`), `output ${k} was refunded from the key alone`);
});

test('a provider answers only the output that pays its own lock script: an offer that names another provider\'s output, or a swap id of another output, is refused; its own is taken', async () => {
  const w = multiWorld();
  await w.ready(); ample(w);
  const q = await w.pair.quote({ dir: 'b2e', amount: 400_000n });
  fundLegs(w, q);
  w.ctl.Alpha.stallOffers = true;                     // (Alpha is not told by the page; the offer is made here)
  await w.pair.start(q);
  w.btc.mine(1);
  await w.step();
  const ext = w.calls.find((c) => c.name === 'Alpha' && c.path === '/extend');
  const mine = ext && ext.body.offer;
  assert.ok(mine && mine.btc.vout === 0, 'the extension carries the offer for output 0');
  // Bravo's offer is for output 1; sent to Alpha with output 1 named, it does not pay Alpha's script
  const bravo = w.calls.find((c) => c.name === 'Bravo' && c.path === '/extend').body.offer;
  assert.equal(bravo.btc.vout, 1);
  const quoteIdA = ext.body.quoteId;
  const asAlpha = { ...bravo, claimerPub: mine.claimerPub };
  const r1 = await w.p.Alpha.svc.handle({ method: 'POST', path: '/offer', body: { quoteId: quoteIdA, offer: asAlpha } });
  assert.equal(r1.body.ok, false);
  // Alpha's own offer, naming Bravo's output (vout 1) with the id of output 1: the script at that output is Bravo's
  const wrongVout = { ...mine, btc: { ...mine.btc, vout: 1 }, swapId: bravo.swapId };
  const r2 = await w.p.Alpha.svc.handle({ method: 'POST', path: '/offer', body: { quoteId: quoteIdA, offer: wrongVout } });
  assert.equal(r2.body.ok, false, 'another output is not Alpha\'s lock');
  // Alpha's own offer with the id of the first coin alone (output 0 named by an id of output 1) is refused too
  const wrongId = { ...mine, swapId: bravo.swapId };
  const r3 = await w.p.Alpha.svc.handle({ method: 'POST', path: '/offer', body: { quoteId: quoteIdA, offer: wrongId } });
  assert.equal(r3.body.ok, false);
  assert.match(String(r3.body.why), /swap id is not the outpoint/);
  assert.equal((await w.p.Alpha.store.list()).length, 0, 'none of them made a swap');
  const r4 = await w.p.Alpha.svc.handle({ method: 'POST', path: '/offer', body: { quoteId: quoteIdA, offer: mine } });
  assert.equal(r4.body.ok, true, String(r4.body.why));
  assert.equal((await w.p.Alpha.store.list())[0].lockVout, 0);
});

test('a lone lock is unchanged: its swap id is the first coin and output 0, and a provider answers it as before', async () => {
  const w = multiWorld({ providers: [{ name: 'Alpha', feeBps: 30, flatFee: 500, minAmount: 20_000, maxAmount: 1_000_000 }] });
  await w.ready(); w.fund('Alpha', 100_000n);
  const q = await w.pair.quote({ dir: 'b2e', amount: 100_000n });
  assert.equal(q.split, undefined, 'one provider is the answer');
  const { id } = await w.pair.start(q);
  const first = w.uCoins[0];
  assert.equal(id, bytesToHex(X.swapIdOf(first.txid, first.vout)));
  await w.run(async () => (await w.pair.records())[0]?.state === 'done');
});

test('a provider that does not say it answers a share of a transaction is not asked for one: with it needed, there is no split; a lone swap with it is as ever', async () => {
  const w = multiWorld({ providers: [
    { name: 'Alpha', feeBps: 30, flatFee: 500, minAmount: 20_000, maxAmount: 150_000 },
    { name: 'Bravo', feeBps: 30, flatFee: 500, minAmount: 20_000, maxAmount: 150_000, old: true },
    { name: 'Charlie', feeBps: 30, flatFee: 500, minAmount: 20_000, maxAmount: 150_000 },
  ] });
  await w.ready(); ample(w);
  await assert.rejects(() => w.pair.quote({ dir: 'b2e', amount: 400_000n }), /needs more than one provider, and Bravo: /);
  assert.equal(w.btc.broadcasts.length, 0);
  // 280,000 is filled by the two that do
  const q = await w.pair.quote({ dir: 'b2e', amount: 280_000n });
  assert.deepEqual(q.split.legs.map((l) => l.provider.name), ['Alpha', 'Charlie']);
  // and a lone swap with the old provider is as it was
  const one = await w.pair.quote({ dir: 'b2e', amount: 100_000n });
  assert.equal(one.split, undefined);
});

test('a split is not taken when a leg quotes far under the market, and a renewed total is shown: the quote carries one expiry, the earliest', async () => {
  const w = multiWorld();
  await w.ready(); ample(w);
  const q = await w.pair.quote({ dir: 'b2e', amount: 400_000n });
  assert.equal(q.expiresAt, Math.min(...q.split.legs.map((l) => Number(l.ref.r.validUntil))));
  w.clock.advance(590);
  await assert.rejects(() => w.pair.start(q), /quote expired/);
  assert.equal(w.btc.broadcasts.length, 0);
  // the market moves under the providers' price: the whole quote is blocked, not sent on the strength of the legs that are fine
  w.mk.value = 33;
  w.clock.advance(100);
  await w.providerFeed.refresh(); await w.clientFeed.refresh();
  const again = await w.pair.quote({ dir: 'b2e', amount: 400_000n });
  assert.ok(!again.blocked || again.split, 'a quote is made');
});

test('the card for a mixed state counts what came and what returned (describeBatch)', () => {
  const leg = (k, state, title, o = {}) => ({ id: 'l' + k, state, title, detail: '', pay: 100n, get: 3000n, provider: 'P' + k, at: 10, steps: ['lock', 'match', 'claim', 'take'].map((key, i) => ({ key, title: key, state: state === 'done' ? 'done' : i === 0 ? 'done' : 'todo' })), etaSecs: 600, refundAt: null, backBy: null, batch: { id: 'b', n: 3, k }, lockTxid: 'ab'.repeat(32), ...o });
  const c = describeBatch('b', [leg(0, 'done', 'Done'), leg(1, 'returned', 'Returned'), leg(2, 'working', 'Waiting for Bitcoin')]);
  assert.equal(c.state, 'working');
  assert.equal(c.title, 'Swapping across 3 providers');
  assert.match(c.detail, /one part is returning/);
  const d = describeBatch('b', [leg(0, 'returned', 'Returned'), leg(1, 'returned', 'Returned')]);
  assert.equal(d.state, 'returned');
  assert.equal(d.get, 0n);
});

test('one provider pinned over HTTP and one that is board-only: an amount above the first one\'s availability is split 250,000 + 50,000; when the second does not answer, the page says so', async () => {
  const mk = () => multiWorld({ providers: [
    { name: 'A', feeBps: 20, flatFee: 800, minAmount: 120_000, maxAmount: 1_000_000 },
    { name: 'B', feeBps: 30, flatFee: 1000, minAmount: 50_000, maxAmount: 55_886 }], userSats: [310_000] });
  const w = mk();
  await w.ready(); w.fund('A', 275_989n, 'cap'); w.fund('B', 55_886n, 'cap');
  const q = await w.pair.quote({ dir: 'b2e', amount: 300_000n });
  assert.deepEqual(q.split.legs.map((l) => [l.provider.name, l.pay]), [['A', 250_000n], ['B', 50_000n]]);
  const d = mk();
  await d.ready(); d.fund('A', 275_989n, 'cap'); d.fund('B', 55_886n, 'cap');
  d.ctl.B.down = true;
  await assert.rejects(() => d.pair.quote({ dir: 'b2e', amount: 300_000n }), /needs more than one provider, and B: /);
  assert.equal(d.btc.broadcasts.length, 0);
});

test('a page that looks again from the key finds nothing it already holds (a lock\'s output a swap keeps is that swap), and a swap found on a new page is dated by its block', async () => {
  const w = multiWorld();
  await w.ready(); ample(w);
  const q = await w.pair.quote({ dir: 'b2e', amount: 400_000n });
  fundLegs(w, q);
  for (const n of NAMES) w.ctl[n].stallOffers = true;
  await w.pair.start(q);
  w.btc.mine(1);
  const before = (await w.pair.records()).length;
  assert.equal(await w.pair.recover(), 0, 'the same page finds no swap again: each lock output is held by a swap it keeps');
  assert.equal((await w.pair.records()).length, before, 'and lists no second card');
  w.clock.advance(3 * 86400);
  const ms = () => new Map(), mem = (m) => ({ get: async (k) => m.get(k) ?? null, put: async (r) => { m.set(r.id, r); }, list: async () => [...m.values()], delete: async (k) => { m.delete(k); } });
  const named = new Map(), nm = (n) => { if (!named.has(n)) named.set(n, mem(ms())); return named.get(n); };
  const fresh = w.makePair({ stores: { fwd: mem(ms()), index: mem(ms()), swaps: (id) => nm('s' + id), quotes: (id) => nm('q' + id) } });
  await fresh.recover();
  const card = (await fresh.records())[0];
  assert.ok(card.at <= w.clock.now() - 2 * 86400, `found three days later, it is dated by its block, not by the finding (${w.clock.now() - card.at} s ago)`);
});

let passed = 0;
for (const [name, fn] of tests) {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} split checks passed`);
process.exit(process.exitCode || 0);
