// The swap card's Bitcoin and Ethereum lane (dapp/swap/atomic.js) driven by the REAL pair client (dapp/fastbridge-pair.js) over the simulated Bitcoin and pool, the real
// providers and the real rate feed (tests/lib/pair-world.mjs): what the lane reads from the engine (the quote, the records, the balances, the providers) and says on the
// page, in both directions, a quote that must not be started, and a Bitcoin address that cannot pay. tests/swap-atomic-lane.test.mjs runs the lane in a browser against
// stand-ins of the same shape; this is the check that the stand-ins are the shape the engine really gives. The lane's DOM is jsdom's.
//   node tests/swap-atomic-engine.test.mjs        (Node 22)

import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fetched } from './lib/btc-sim.mjs';
import { pairWorld, SATS, UNITS } from './lib/pair-world.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
const { makeAtomicLane } = await import('../dapp/swap/atomic.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 4000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) { const v = await fn(); if (v) return v; } throw new Error('never: ' + what); };

// the lane over a world: a door that is always open and hands out the world's own pair client
function mount(w, { dir = 'b2e' } = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const calls = { signIn: 0, fund: 0 };
  const door = { load: async () => {}, get unlocked() { return true; }, signIn: async () => { calls.signIn++; }, fund() { calls.fund++; }, open: async () => ({ pair: w.pair }) };
  const lane = makeAtomicLane({ host, door, dir, now: w.clock.now });
  const $ = (id) => host.querySelector(`#${id}`);
  const text = (id) => ($(id)?.textContent || '').replace(/\s+/g, ' ').trim();
  return { host, lane, door, calls, $, text, done: () => { lane.hide(); host.remove(); } };
}
const go = (m) => m.$('a-go');
// the receipt as { label: value }
const rows = (m) => Object.fromEntries([...m.host.querySelectorAll('#a-rcpt > div')].map((d) => [d.querySelector('dt').textContent, d.querySelector('dd').textContent]));
const setAmount = (m, amt) => { m.$('a-amt').value = amt; m.$('a-amt').dispatchEvent(new dom.window.Event('input', { bubbles: true })); };

test('Bitcoin for ETH on the page, from the real engine: the balance, the quote against the market, one press, and the swap finished in the lane\'s own words', async () => {
  const w = pairWorld();
  await w.ready();
  const out = w.fwd.quoter.price(SATS).evmAmount;
  w.lEvm.fund(out, 'inv0');
  const m = mount(w);
  await m.lane.show();
  await until(() => /Balance 0\.002 BTC/.test(m.text('a-bal')), 'the balance of the Bitcoin address');
  assert.equal(m.text('a-pay-coin'), 'BTC');
  assert.equal(m.text('a-get-coin'), 'ETH');
  m.lane.set({ amt: '0.001' });
  await until(() => go(m).dataset.act === 'swap', 'a quote the lane will start');
  assert.equal(go(m).textContent, 'Swap BTC → ETH');
  assert.equal(m.text('a-out'), '0.0353152', '3,531,520 pool units, as the provider priced it');
  const r = rows(m);
  assert.equal(r.Price, '1 BTC = 35.315 ETH');
  assert.equal(r.Market, '1 BTC = 35.6 ETH');
  assert.equal(r['You get'], '0.80% less than the market price');
  assert.equal(r.Provider, 'Test provider', 'the provider, and no fee it did not name');
  assert.match(r['Bitcoin fee'], /^about \d+ sats$/);
  assert.match(r.Time, /^about \d+ minutes$/);
  assert.equal(r['If it stops'], 'your BTC returns to you');
  go(m).click();
  const sent = await until(() => !m.$('a-sent').hidden && m.text('a-sent'), 'the swap under way');
  assert.match(sent, /0\.001 BTC → about 0\.0353152 ETH/);
  assert.equal(m.$('a-amt').value, '', 'the amount is cleared once it is sent');
  assert.equal(w.btc.broadcasts.length >= 1, true);
  await w.run(async () => (await w.first())?.state === 'done');
  await m.lane.show();                                                // the lane reads what the engine now says
  const done = m.text('a-sent');
  assert.match(done, /Done/);
  assert.match(done, /0\.001 BTC → 0\.0353152 ETH/);
  assert.deepEqual([...m.host.querySelectorAll('#a-sent [data-step]')].map((li) => li.className), ['done', 'done', 'done', 'done']);
  assert.deepEqual([...m.host.querySelectorAll('#a-sent [data-step]')].map((li) => li.dataset.step), ['lock', 'match', 'claim', 'take']);
  assert.deepEqual(w.evm.submitted.map((j) => j.type), ['adaptorlock', 'adaptorclaim']);
  m.done();
});

test('ETH for Bitcoin on the page, from the real engine: a flip, the provider locks first, and the swap finished', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  const m = mount(w);
  await m.lane.show();
  m.host.querySelector('#a-flip').click();
  assert.equal(m.text('a-pay-coin'), 'ETH');
  await until(() => /Balance 0\.036 ETH/.test(m.text('a-bal')), 'the private ETH balance');
  m.lane.set({ amt: '0.036' });
  await until(() => go(m).dataset.act === 'swap', 'a quote the lane will start');
  assert.equal(go(m).textContent, 'Swap ETH → BTC');
  // the provider locks 100,539 sats; the user takes them with a transaction that pays its own fee out of the lock (550 sats in this world), so 99,989 arrive and that is what is shown
  assert.equal(m.text('a-out'), '0.00099989');
  const r = rows(m);
  assert.match(r['Bitcoin fee'], /^about 550 sats, from the lock when you take it$/);
  assert.equal(r.Price, '1 ETH = 0.027928 BTC');
  assert.equal(r.Market, '1 ETH = 0.02809 BTC');
  assert.equal(r['You get'], '0.58% less than the market price');
  // (the provider pays for its own lock; the user's take comes out of it, and its fee is the row above)
  assert.equal(r['If it stops'], 'your ETH returns to your private balance');
  go(m).click();
  await until(() => !m.$('a-sent').hidden, 'the swap under way');
  await w.run(async () => (await w.pair.records()).some((r) => r.dir === 'e2b' && r.state === 'done'));
  await m.lane.show();
  const done = m.text('a-sent');
  assert.match(done, /Done/);
  assert.match(done, /0\.036 ETH → 0\.00100539 BTC/);
  assert.deepEqual([...m.host.querySelectorAll('#a-sent [data-step]')].map((li) => li.dataset.step), ['lock', 'match', 'claim', 'take']);
  assert.equal([...m.host.querySelectorAll('#a-sent [data-step]')].every((li) => li.className === 'done'), true);
  m.done();
});

test('a provider far under the market: the lane says why in words, the button cannot be pressed, and nothing is sent', async () => {
  const w = pairWorld({ providerMarket: 33, clientMarket: 35.6 });
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const m = mount(w);
  await m.lane.show();
  m.lane.set({ amt: '0.001' });
  await until(() => go(m).textContent === 'Not at this price', 'the blocked quote');
  assert.equal(go(m).disabled, true);
  assert.match(m.text('a-q'), /^The provider quotes \d\.\d% under the market\.$/);
  assert.match(rows(m)['You get'], /^\d\.\d+% less than the market price$/);
  go(m).click();
  await sleep(50);
  assert.equal(w.btc.broadcasts.length, 0, 'nothing was sent');
  assert.equal((await w.pair.records()).length, 0);
  m.done();
});

test('a Bitcoin address that cannot pay the amount and the fee sends the user to add sats, not to a price it does not like', async () => {
  const w = pairWorld({ userSats: 100_300 });
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const m = mount(w);
  await m.lane.show();
  m.lane.set({ amt: '0.001' });
  await until(() => go(m).dataset.act === 'fund', 'the lane offers to add sats');
  assert.equal(go(m).textContent, 'Add sats for the Bitcoin fee');
  assert.match(rows(m)['Bitcoin fee'], /^about \d+ sats$/, 'it says what the fee is');
  assert.doesNotMatch(m.text('a-q'), /market/, 'and does not call it a price');
  go(m).click();
  assert.equal(m.calls.fund, 1, 'pressing it opens the way to add sats');
  assert.equal(w.btc.broadcasts.length, 0, 'and sent nothing');
  m.done();
});

test('the lane\'s limits are the providers\': under the least a provider takes it says the least, and the best price among providers is the one shown', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');
  const m = mount(w);
  await m.lane.show();
  m.lane.set({ amt: '0.0001' });
  await until(() => /^Minimum 0\.0002 BTC$/.test(go(m).textContent), 'the provider\'s least (20,000 sats in this world)');
  assert.equal(go(m).disabled, true);
  m.lane.set({ amt: '0.0003' });
  await until(() => go(m).dataset.act === 'swap', 'a quote at 0.0003 BTC');
  m.lane.set({ amt: '0.002' });
  await until(() => /^Most a provider takes is 0\.001 BTC$/.test(go(m).textContent), 'the most a provider can take now (what its pool ETH backs: 100,000 sats here)');
  m.done();
});

let passed = 0;
for (const [name, fn] of tests) {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} lane and engine checks passed`);
process.exit(process.exitCode || 0);
