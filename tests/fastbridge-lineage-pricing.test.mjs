// Class-aware pricing for stuck TAC: the pure classification, the quotes the HTTP service gives by class,
// and enforcement at the offer. Needs Node 22.
//   node tests/fastbridge-lineage-pricing.test.mjs

import assert from 'node:assert/strict';
import { realFetch } from './lib/real-fetch.mjs';
import { classifyVerdicts, makeLineageClassScreen, normalizeLineageFees } from '../dapp/fastbridge-lineage-pricing.js';
import { makeHttpCounter } from '../dapp/fastbridge-http.js';
import { VALUE } from './lib/fastbridge-world.mjs';
import { closers, configFor, serve, call, httpWorld, startSwap, bothDone } from './lib/lp-harness.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const fees = () => normalizeLineageFees({
  defaultClass: 'pool-exit',
  long: { feeBps: 100, flatFee: '0' },
  poolExit: { feeBps: 250, flatFee: '0' },
});

test('lineage classes: clean, long and pool-exit, with the worst note pricing the whole lock', () => {
  const n = (id) => ({ txid: id.repeat(64), vout: 0 });
  const table = (entries) => new Map(entries.map(([id, v]) => [`${id.repeat(64)}:0`, v]));
  assert.equal(classifyVerdicts([n('a')], table([['a', { state: 'tracked' }]])).class, 'clean');
  assert.equal(classifyVerdicts([n('a')], table([['a', { state: 'traced', hops: 20 }]])).class, 'clean');
  assert.equal(classifyVerdicts([n('a')], table([['a', { state: 'long', hops: 256 }]])).class, 'long');
  assert.equal(classifyVerdicts([n('a'), n('b')], table([['a', { state: 'long' }], ['b', { state: 'unprovable', through: 'shielded' }]])).class, 'pool-exit');
  assert.equal(classifyVerdicts([n('a')], table([['a', { state: 'unread' }]])).class, 'unread');
});

test('the class screen retries an unread history, refuses a pool exit only when configured to screen, and otherwise passes the class through', async () => {
  const vet = async (ns) => new Map(ns.map((x) => [`${x.txid}:${x.vout}`, x.txid[0] === 'a' ? { state: 'unprovable', through: 'shielded' } : { state: 'long' }]));
  const inputs = [{ txid: 'a'.repeat(64), vout: 0 }, { txid: 'b'.repeat(64), vout: 1 }];
  const priced = makeLineageClassScreen(vet);
  assert.deepEqual(await priced(inputs), { class: 'pool-exit', notes: [
    { txid: inputs[0].txid, vout: 0, class: 'pool-exit', verdict: { state: 'unprovable', through: 'shielded' } },
    { txid: inputs[1].txid, vout: 1, class: 'long', verdict: { state: 'long' } },
  ] });
  const refused = makeLineageClassScreen(vet, { refusePoolExit: true });
  assert.match((await refused(inputs)).why, /proof does not follow/);
  const down = makeLineageClassScreen(async () => { throw new Error('down'); });
  assert.deepEqual(await down(inputs), { why: 'the history of the notes could not be read just now', retry: true });
});

test('/info and /quote: class fees are added to the base fee, a request that names none uses the conservative default', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(100_000n, 'lineage-quote');
  const s = await serve(w, { config: configFor(w, { quote: { feeBps: 30, flatFee: 200, lineageFees: fees() } }) });
  const info = await call(s.base, 'GET', '/info');
  assert.equal(info.body.lineagePricing.defaultClass, 'pool-exit');
  assert.equal(info.body.lineagePricing.classes.long.feeBps, 100);

  const quote = async (lineage) => (await call(s.base, 'POST', '/quote', { amount: '5000', ...(lineage ? { lineage } : {}) })).body;
  assert.equal((await quote('clean')).evmAmount, String(5000 - (15 + 200)));
  assert.equal((await quote('long')).evmAmount, String(5000 - (15 + 200 + 50)));
  assert.equal((await quote('pool-exit')).evmAmount, String(5000 - (15 + 200 + 125)));
  assert.equal((await quote()).evmAmount, String(5000 - (15 + 200 + 125)), 'no hint is priced as pool-exit');
  assert.equal((await quote('long')).lineage, 'long');
  const bad = await call(s.base, 'POST', '/quote', { amount: '5000', lineage: 'unknown' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /lineage/);
});

test('the offer check enforces the class price: a clean quote cannot be spent as a pool exit, a pool-exit quote goes through', async () => {
  const lf = fees();
  // mispriced: the quote pays the clean price, while the lock really spends a pool-exit note
  {
    const { w, ref } = httpWorld();
    w.lEvm.fund(VALUE, 'lineage-reject');
    const s = await serve(w, { config: configFor(w, { quote: { lineageFees: lf }, policy: { screen: async () => ({ class: 'pool-exit' }) } }) });
    ref.base = s.base;
    const q = await makeHttpCounter({ base: s.base, fetchImpl: realFetch }).quote(VALUE, { lineage: 'clean' });
    await startSwap(w, q);
    await w.run(async () => s.logs.some((l) => /not priced/.test(l.why || '')) || ['refund-wait', 'refunded'].includes((await w.user())?.phase));
    assert.ok(s.logs.some((l) => l.msg === 'offer declined' && /pool-exit.*not priced/.test(l.why || '')), JSON.stringify(s.logs));
    assert.equal(w.evm.locks.leaves.length, 0, 'nothing was locked in the pool');
  }
  // correctly priced: the same note goes through at the price of its class
  {
    const { w, ref } = httpWorld();
    const payout = VALUE - (VALUE * 250n) / 10000n;
    w.lEvm.fund(payout, 'lineage-accept');
    const s = await serve(w, { config: configFor(w, { quote: { lineageFees: lf }, policy: { screen: async () => ({ class: 'pool-exit' }) } }) });
    ref.base = s.base;
    const q = await makeHttpCounter({ base: s.base, fetchImpl: realFetch }).quote(VALUE, { lineage: 'pool-exit' });
    assert.equal(q.evmAmount, String(payout), 'base fee is zero here, so the addition is the whole fee');
    await startSwap(w, q);
    await w.run(bothDone(w));
    assert.equal(w.evm.locks.leaves.length, 1);
    assert.ok((await w.lp()).take, 'the provider took the Bitcoin lock');
  }
});

let passed = 0, ran = 0;
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
for (const [name, fn] of tests) {
  if (ONLY && !ONLY.test(name)) continue;
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
  while (closers.length) { try { await closers.pop()(); } catch { /* already closed */ } }
}
console.log(`\n${passed}/${ran} lineage-pricing checks passed`);
process.exit(process.exitCode || 0);
