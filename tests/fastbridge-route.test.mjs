// The fast bridge as a way in for the front page's Bridge tab (dapp/fast/route.js): whether a provider can match the size of a note, the
// best quote among those that can, why not when none does, what the lock costs, the bridge begun with exactly the note picked, and the
// words the tab shows for each.
//   node tests/fastbridge-route.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { makeFastRoute, capOf, takes, minutesFor, shown, whyRow, confirmText, failMessage, shortText } from '../dapp/fast/route.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const TAC = 10n ** 8n;
const terms = (over = {}) => ({ minAmount: 10n * TAC, maxAmount: 1000n * TAC, feeBps: 30, flatFee: TAC, available: null, ...over });
const provider = (name, over = {}) => ({ id: name, name, ref: { kind: 'http', claimPub: name }, terms: terms(over) });
const note = { txid: 'ab'.repeat(32), vout: 1, amount: 100n * TAC };

// a session the way fast/wire.js openFast gives one
function session({ failFor = new Map(), minConfs = 1, cost = { short: false, fee: 3100, take: 8046, total: 11146 } } = {}) {
  const calls = { asked: [], costs: [], starts: [] };
  return {
    calls,
    quoteAll: async (ps, units) => {
      calls.asked.push({ names: ps.map((p) => p.name), units });
      const quotes = [], failed = [];
      for (const p of ps) {
        if (failFor.has(p.name)) { failed.push({ provider: p, error: new Error(failFor.get(p.name)) }); continue; }
        const fee = (units * BigInt(p.terms.feeBps)) / 10000n + p.terms.flatFee;
        quotes.push({ provider: p, quote: { id: 'q' + p.name, btcValue: units, evmAmount: units - fee, fee, minConfs, validUntil: 9e9 } });
      }
      quotes.sort((a, b) => (a.quote.evmAmount > b.quote.evmAmount ? -1 : 1));
      return { quotes, failed };
    },
    cost: async (o) => { calls.costs.push(o); return cost; },
    start: async (o) => { calls.starts.push(o); return { rec: {} }; },
    records: async () => [{ id: 'x' }],
    run: ({ onChange }) => { onChange([{ id: 'x' }]); return () => { calls.stopped = true; }; },
  };
}
const routeOf = (providers, sess, over = {}) => makeFastRoute({ discover: async () => providers, open: async () => sess, ...over });

test('what a provider takes: its most, or less when it says so, and the amounts between its least and that', () => {
  assert.equal(capOf(terms()), 1000n * TAC); assert.equal(capOf(terms({ available: 300n * TAC })), 300n * TAC); assert.equal(capOf(terms({ available: 5000n * TAC })), 1000n * TAC);
  assert.equal(takes(terms(), 10n * TAC), true); assert.equal(takes(terms(), 9n * TAC), false); assert.equal(takes(terms({ available: 50n * TAC }), 60n * TAC), false); assert.equal(takes(terms({ available: 0n }), 10n * TAC), false);
  assert.deepEqual([minutesFor(1), minutesFor(2), minutesFor(3), minutesFor(undefined)], [15, 25, 35, 15]);
});

test('a provider that takes the size is the way: the best quote of those that can, asked once for all of them', async () => {
  const s = session();
  const fr = routeOf([provider('Slow', { feeBps: 50 }), provider('Cheap', { feeBps: 20 }), provider('Small', { feeBps: 10, maxAmount: 50n * TAC })], s);
  const o = await fr.offer(100n * TAC);
  assert.equal(o.ok, true); assert.equal(o.provider.name, 'Cheap'); assert.equal(o.quotes.length, 2);
  assert.deepEqual(s.calls.asked, [{ names: ['Slow', 'Cheap'], units: 100n * TAC }], 'a provider that does not take 100 is not asked');
  assert.equal(o.quote.evmAmount, 100n * TAC - (100n * TAC * 20n) / 10000n - TAC); assert.equal(o.minutes, 15);
  assert.equal((await routeOf([provider('Big')], session({ minConfs: 2 })).offer(100n * TAC)).minutes, 25, 'a provider that waits for two confirmations takes longer');
});

test('no provider takes it, and why: none online, none for that size (and what they take), a fee over the limit, none answering', async () => {
  assert.deepEqual(await routeOf([], session()).offer(100n * TAC), { ok: false, why: 'none' });
  const small = await routeOf([provider('A'), provider('B', { minAmount: 50n * TAC, maxAmount: 200n * TAC })], session()).offer(5n * TAC);
  assert.deepEqual([small.ok, small.why, small.min, small.max], [false, 'size', 10n * TAC, 1000n * TAC]);
  const full = await routeOf([provider('A', { available: 20n * TAC })], session()).offer(100n * TAC);
  assert.deepEqual([full.why, full.max], ['size', 20n * TAC], 'what is left of a provider counts, not what it takes in all');
  const dear = await routeOf([provider('A')], session({ failFor: new Map([['A', 'the quote\'s fee is above the limit this page accepts']]) })).offer(100n * TAC);
  assert.equal(dear.why, 'dear');
  const quiet = await routeOf([provider('A'), provider('B')], session({ failFor: new Map([['A', 'the provider did not answer in time'], ['B', 'the quote\'s fee is above the limit this page accepts']]) })).offer(100n * TAC);
  assert.equal(quiet.why, 'busy', 'one that did not answer is not a fee that is too high');
  const broken = await makeFastRoute({ discover: async () => [provider('A')], open: async () => { throw new Error('wallet locked'); } }).offer(100n * TAC);
  assert.deepEqual([broken.ok, broken.why], [false, 'error']);
});

test('a high fee is not a reason to leave the regular bridge: the tile prefers the quote within 5%, and says so when every quote is over it', async () => {
  const fr = routeOf([provider('Dear', { feeBps: 800, flatFee: 0n }), provider('Fair', { feeBps: 50 })], session());
  const o = await fr.offer(100n * TAC);
  assert.equal(o.ok, true); assert.equal(o.provider.name, 'Fair'); assert.deepEqual(o.quotes.map((x) => x.provider.name), ['Fair'], 'the dear one is not kept behind it');
  const only = await routeOf([provider('Dear', { feeBps: 800, flatFee: 0n })], session()).offer(100n * TAC);
  assert.deepEqual([only.ok, only.why], [false, 'dear'], 'quoted, but dearer than the tile prefers');
});

test('the key\'s own provider is not one to bridge with', async () => {
  const s = session();
  const fr = routeOf([provider('Mine', { feeBps: 1 }), provider('Other', { feeBps: 40 })], s, { ownId: () => 'Mine' });
  assert.equal((await fr.offer(100n * TAC)).provider.name, 'Other'); assert.deepEqual(s.calls.asked[0].names, ['Other']);
  assert.deepEqual(await routeOf([provider('Mine')], session(), { ownId: () => 'Mine' }).offer(100n * TAC), { ok: false, why: 'none' });
});

test('the providers are read once for a while, and again after it; one that goes leaves the ones read standing when the read fails', async () => {
  let reads = 0, up = true, t = 0;
  const fr = makeFastRoute({ discover: async () => { reads++; if (!up) throw new Error('down'); return [provider('A')]; }, open: async () => session(), refreshMs: 1000, now: () => t });
  await fr.offer(100n * TAC); await fr.offer(100n * TAC); assert.equal(reads, 1);
  t = 1500; up = false;
  assert.equal((await fr.offer(100n * TAC)).ok, true, 'a read that fails keeps the list it had'); assert.equal(reads, 2);
});

test('providers gone: one empty read keeps the list (a board may not have answered), a second in a row empties it, and the tab stops offering them', async () => {
  let list = [provider('A')], t = 0;
  const fr = makeFastRoute({ discover: async () => list, open: async () => session(), refreshMs: 1000, now: () => t });
  assert.equal((await fr.offer(100n * TAC)).ok, true);
  list = []; t = 1500;
  assert.equal((await fr.offer(100n * TAC)).ok, true, 'one empty read: the provider stands');
  t = 3000;
  assert.equal((await fr.offer(100n * TAC)).why, 'none', 'two in a row: none online');
  list = [provider('B')]; t = 4500;
  assert.equal((await fr.offer(100n * TAC)).provider.name, 'B', 'a provider back is offered at once');
});

test('the lock\'s cost and the bridge itself are for exactly the note picked, with the provider that was quoted', async () => {
  const s = session();
  const fr = routeOf([provider('A')], s);
  const o = await fr.offer(100n * TAC);
  assert.deepEqual(await fr.cost(o, note), { short: false, fee: 3100, take: 8046, total: 11146 });
  assert.deepEqual(s.calls.costs[0].only, [{ txid: note.txid, vout: 1 }]); assert.equal(s.calls.costs[0].provider.name, 'A'); assert.equal(s.calls.costs[0].quote.id, 'qA');
  await fr.start(o, note);
  assert.deepEqual(s.calls.starts[0].only, [{ txid: note.txid, vout: 1 }]); assert.equal(s.calls.starts[0].quotes[0].quote.id, 'qA');
  const bare = routeOf([provider('A')], { ...session(), cost: undefined });
  assert.equal(await bare.cost(await bare.offer(100n * TAC), note), null, 'a session that cannot price a lock says so');
  assert.deepEqual(await fr.records(), [{ id: 'x' }]);
  let seen = null; const stop = fr.run((l) => { seen = l; }); await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, [{ id: 'x' }]); stop(); assert.equal(s.calls.stopped, true);
});

test('what the tab shows for an offer: the arrival, the fee, the Bitcoin cost, the time and what happens if it stalls', async () => {
  const o = await routeOf([provider('Tacit')], session()).offer(100n * TAC);
  o.cost = { short: false, fee: 3100, take: 8046, total: 11146 };
  const v = shown(o);
  assert.equal(v.out, '98.7'); assert.equal(v.go, 'Bridge fast'); assert.equal(v.fast, true); assert.equal(v.warn, false); assert.equal(v.line, '');
  assert.deepEqual(v.rc.map((r) => r.slice(0, 2)), [['Arrives', '98.7 private TAC on Ethereum'], ['Provider fee', '1.3 TAC (1.30%)'], ['Bitcoin fee', '≈ 11,146 sats'], ['Time', 'about 15 minutes'], ['If it stalls', 'the lock returns to your address after about a day']]);
  assert.equal(v.rc[2][3], '8,046 sats of it is the provider’s take'); assert.equal(v.rc[1][3], 'Tacit');
  o.cost = { short: true, have: 1200, need: 11146 };
  const lacking = shown(o);
  assert.equal(lacking.warn, true); assert.match(lacking.line, /holds 1,200 sats for fees, short of the 11,146 sats this needs/);
  o.cost = null;
  assert.equal(shown(o).rc[2][1], 'in sats', 'a cost that was not read is not made up');
  assert.match(confirmText(o, '100 TAC'), /^Bridging 100 TAC locks it on Bitcoin until Tacit has paid you 98\.7 private TAC in the pool, in about 15 minutes\. If it does not, the lock returns to your address after about a day\. Press again to bridge\.$/);
  o.cost = { total: 11146 };
  assert.match(confirmText(o, '100 TAC'), /for about 11,146 sats in Bitcoin fees/);
});

test('why the fast bridge is not offered is one row of the regular receipt, and nothing when there is nothing to say', () => {
  assert.deepEqual(whyRow({ ok: false, why: 'size', min: 10n * TAC, max: 1000n * TAC }), ['Fast bridge', 'providers take 10 to 1,000 TAC now']);
  assert.deepEqual(whyRow({ ok: false, why: 'dear' }), ['Fast bridge', 'the providers’ fee is over 5% at this size; the fast page can still bridge it']);
  assert.deepEqual(whyRow({ ok: false, why: 'busy' }), ['Fast bridge', 'the providers did not answer']);
  for (const o of [null, { ok: true }, { ok: false, why: 'none' }, { ok: false, why: 'error' }]) assert.equal(whyRow(o), null);
});

test('a failure is said in the page\'s words: the sats the builder lacks, a note in a bridge, a provider that cannot take it', () => {
  assert.match(failMessage(new Error('adaptor-btc-tx: not enough sats to fund the commit (need 9000, have 250)')), /holds 250 sats for fees, short of the 9,000 sats this needs/);
  assert.equal(failMessage(new Error('fastbridge: this note is already part of a swap')), 'This note is already in a bridge.');
  assert.match(failMessage(new Error('the provider cannot hold that amount')), /Use the regular bridge/);
  assert.equal(failMessage(new Error('')), 'Something went wrong. Try again.'); assert.equal(failMessage(new Error('x'.repeat(300))).length, 200);
  assert.match(shortText({ have: 0, need: 5 }), /holds 0 sats/);
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} fast route checks passed`);
process.exit(process.exitCode || 0);
