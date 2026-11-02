// The page's client (dapp/fastbridge-client.js) against the LP service on a socket and the simulated Bitcoin and pool: the
// terms and quotes it accepts and refuses, the notes it picks, a whole swap, a swap carried on by a new instance, a swap that
// ends in the refund, a lock found again from the key alone, and the words for each phase.
//   node tests/fastbridge-client.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { realFetch } from './lib/real-fetch.mjs';
import { bigintToBytes32 } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import * as X from '../dapp/adaptor-xswap.js';
import { makeHttpCounter } from '../dapp/fastbridge-http.js';
import { makeFastBridgeClient, makeLocalStore, describe } from '../dapp/fastbridge-client.js';
import { fetched } from './lib/btc-sim.mjs';
import { pool, ASSET } from './lib/chain-sim.mjs';
import { VALUE, memStore } from './lib/fastbridge-world.mjs';
import { closers, configFor, serve, httpWorld } from './lib/lp-harness.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const pinsOf = (w) => ({ claimPub: bytesToHex(w.lW.wallet.pub), btcAsset: bytesToHex(w.etch.asset), evmAsset: ASSET });
function clientFor(w, lp, over = {}) {
  return makeFastBridgeClient({ lp, btc: w.uBtc, evm: w.uEvmCtx, store: w.userStore, seed: w.uKeys.seed, now: w.clock.now, pins: pinsOf(w), ...over });
}
const counterAt = (base) => makeHttpCounter({ base, fetchImpl: realFetch });
const NET = VALUE - (VALUE * 30n) / 10000n - 200n;
const feeConfig = (w) => configFor(w, { quote: { feeBps: 30, flatFee: 200 } });

// a provider that answers what a test says, for the quotes a real one would not give
function fakeLp(w, over = {}) {
  const good = { id: 'a'.repeat(32), btcAsset: bytesToHex(w.etch.asset), btcValue: String(VALUE), evmAsset: ASSET, evmAmount: String(NET), claimPub: bytesToHex(w.lW.wallet.pub), csvBlocks: 144, evmWindowSecs: 14400, minConfs: 1, created: w.clock.now(), validUntil: w.clock.now() + 600 };
  return { info: async () => ({ claimPub: good.claimPub, btcAsset: good.btcAsset, evmAsset: good.evmAsset, minAmount: '1000', maxAmount: '1000000', feeBps: 30, flatFee: '200', csvBlocks: 144, evmWindowSecs: 14400 }), quote: async () => ({ ...good, ...over }), sendOffer: async () => ({ ok: true }), getEvmOffer: async () => null };
}

test('terms and quote: the provider\'s numbers, the fee in base units, and a refusal for a key or asset the page did not pin', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(NET, 'net');
  const s = await serve(w, { config: feeConfig(w) });
  const fb = clientFor(w, counterAt(s.base));
  const t = await fb.terms();
  assert.equal(t.claimPub, bytesToHex(w.lW.wallet.pub));
  assert.deepEqual([t.minAmount, t.maxAmount, t.feeBps, t.flatFee, t.csvBlocks], [1000n, 1_000_000n, 30, 200n, 144]);
  const q = await fb.quote(VALUE);
  assert.deepEqual([q.btcValue, q.evmAmount, q.fee, q.csvBlocks], [VALUE, NET, VALUE - NET, 144]);
  const other = (k, v) => clientFor(w, counterAt(s.base), { pins: { ...pinsOf(w), [k]: v } });
  await assert.rejects(() => other('claimPub', '02' + 'ab'.repeat(32)).terms(), /key is not the one this page expects/);
  await assert.rejects(() => other('claimPub', '02' + 'ab'.repeat(32)).quote(VALUE), /key is not the one this page expects/);
  await assert.rejects(() => other('btcAsset', 'cd'.repeat(32)).terms(), /asset is not the one this page expects/);
  await assert.rejects(() => other('evmAsset', 'cd'.repeat(32)).quote(VALUE), /asset is not the one this page expects/);
  assert.equal((await clientFor(w, counterAt(s.base), { pins: {} }).terms()).claimPub, bytesToHex(w.lW.wallet.pub), 'with nothing pinned the provider\'s own terms stand');
});

test('a quote the page will not show: unreadable, for another amount, a payout above the amount, a fee over the limit, a timelock out of range, too little time', async () => {
  const { w } = httpWorld();
  const cases = [
    [{ id: 7 }, /not readable/], [{ claimPub: 'zz' }, /not readable/], [{ btcValue: String(VALUE + 1n) }, /different amount/],
    [{ evmAmount: String(VALUE + 1n) }, /payout is out of range/], [{ evmAmount: '0' }, /payout is out of range/], [{ evmAmount: '12' }, /fee is above the limit/],
    [{ csvBlocks: 10 }, /timelock is out of range/], [{ csvBlocks: 5000 }, /timelock is out of range/], [{ validUntil: w.clock.now() + 30 }, /expires too soon/],
    [{ btcValue: 'ten' }, /not a number/],
  ];
  for (const [over, re] of cases) await assert.rejects(() => clientFor(w, fakeLp(w, over)).quote(VALUE), re, JSON.stringify(over));
  const ok = await clientFor(w, fakeLp(w)).quote(VALUE);
  assert.equal(ok.evmAmount, NET);
  const loose = await clientFor(w, fakeLp(w, { evmAmount: '12' }), { policy: { maxFeeBps: 10000 } }).quote(VALUE);
  assert.equal(loose.evmAmount, 12n, 'the fee limit is the page\'s to set');
});

test('notes to lock: the smallest one that covers the amount, else the largest first, and none when they do not cover it', async () => {
  const { w } = httpWorld();
  const fb = clientFor(w, fakeLp(w));
  const n = (amount, i) => ({ txid: String(i).repeat(64), vout: 0, value: 546, amount, blinding: 1n });
  const pick = fb.pickNotes([n(900n, 1), n(5000n, 2), n(7000n, 3), n(20n, 4)], 5000n);
  assert.deepEqual([pick.notes.length, pick.notes[0].amount, pick.change], [1, 5000n, 0n]);
  const some = fb.pickNotes([n(900n, 1), n(3000n, 2), n(2500n, 3), n(20n, 4)], 5000n);
  assert.deepEqual([some.notes.map((x) => x.amount), some.change], [[3000n, 2500n], 500n]);
  assert.equal(fb.pickNotes([n(900n, 1), n(20n, 2)], 5000n), null);
  assert.equal(fb.pickNotes([], 5000n), null);
  const many = Array.from({ length: 9 }, (_, i) => n(100n, i + 1));
  assert.equal(fb.pickNotes(many, 800n), null, 'more inputs than one lock takes');
  assert.deepEqual(fb.pickNotes(many, 600n).notes.length, 6);
});

test('a whole swap through the client: quote, start, the steps in words, the pool note in the user\'s hands', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(NET, 'net');
  const s = await serve(w, { config: feeConfig(w) });
  ref.base = s.base;
  const fb = clientFor(w, counterAt(s.base));
  w.userTick = () => fb.tick();
  const q = await fb.quote(VALUE);
  const rec = await fb.start({ quote: q, notes: [w.note] });
  assert.equal((await fb.records())[0].title, 'Locking on Bitcoin');
  const titles = new Set();
  await w.run(async () => { const r = (await fb.records())[0]; if (r) titles.add(r.title); return r?.phase === 'done' && (await w.lp())?.phase === 'done'; });
  const last = (await fb.records())[0];
  assert.deepEqual([last.title, last.ended, last.at, last.receive, last.returned], ['Done', true, 3, String(NET), false]);
  for (const t of ['Waiting for Bitcoin', 'Waiting for the pool lock', 'Claiming in the pool']) assert.ok(titles.has(t), `${t} was shown (${[...titles].join(', ')})`);
  const sec = X.deriveSwapSecrets({ seed: w.uKeys.seed, swapId: hexToBytes(rec.id) });
  const O = pool.commitXY(NET, '0x' + bytesToHex(bigintToBytes32(sec.rOut)));
  assert.ok(w.poolHolds(pool.leaf(ASSET, O.cx, O.cy, pool.nkToOwner(w.uKeys.nkOut))), 'the net amount is in the pool for the user');
  assert.deepEqual((await fb.tick()).map((r) => r.phase), ['done'], 'a finished swap is left alone');
  // the same note cannot start a second swap
  await assert.rejects(() => fb.start({ quote: q, notes: [w.note] }), /already part of a swap/);
});

test('a new instance on the same store carries a swap on: the page closed and opened again mid-swap', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(NET, 'net');
  const s = await serve(w, { config: feeConfig(w) });
  ref.base = s.base;
  const first = clientFor(w, counterAt(s.base));
  w.userTick = () => first.tick();
  await first.start({ quote: await first.quote(VALUE), notes: [w.note] });
  await w.run(async () => (await w.user())?.phase === 'offered');
  const second = clientFor(w, counterAt(s.base));
  w.userTick = () => second.tick();
  await w.run(async () => (await w.user())?.phase === 'done' && (await w.lp())?.phase === 'done');
  assert.equal((await second.records())[0].title, 'Done');
  assert.equal(w.evm.locks.leaves.length, 1);
});

test('a provider that goes away: the lock returns on its timelock, said as such, and the note is valid', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(NET, 'net');
  const s = await serve(w, { config: feeConfig(w) });
  ref.base = s.base;
  const fb = clientFor(w, counterAt(s.base));
  w.userTick = () => fb.tick();
  const q = await fb.quote(VALUE);
  await fb.start({ quote: q, notes: [w.note] });
  await s.close(); w.lpOnline = false;
  await w.run(async () => (await w.user())?.phase === 'refund-wait');
  const wait = (await fb.records())[0];
  assert.deepEqual([wait.title, wait.returned, wait.ended], ['Returning to Bitcoin', true, false]);
  assert.match(wait.detail, /could not be reached/);
  w.btc.mine(143);
  await w.run(async () => (await w.user())?.phase === 'refunded');
  const done = (await fb.records())[0];
  assert.deepEqual([done.title, done.returned, done.ended], ['Returned', true, true]);
  assert.ok(await w.noteOf((await w.user()).refund.txid, 0), 'the refund is a valid note');
});

test('a lock the browser has no record of is found again from the key, and taken back on its timelock', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(NET, 'net');
  const s = await serve(w, { config: feeConfig(w) });
  ref.base = s.base;
  const fb = clientFor(w, counterAt(s.base));
  w.userTick = () => fb.tick();
  const q = await fb.quote(VALUE);
  const rec = await fb.start({ quote: q, notes: [w.note] });
  await s.close(); w.lpOnline = false;
  await w.run(async () => !!(await w.user())?.confirmedAt);

  // a new browser: no records, the same key
  const store2 = memStore();
  const fb2 = clientFor(w, counterAt(s.base), { store: store2 });
  assert.deepEqual(await fb2.records(), []);
  const found = await fb2.recover();
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].id, found[0].title, found[0].recovered, found[0].amount], [rec.id, 'Returning to Bitcoin', true, String(VALUE)]);
  assert.equal((await fb2.recover()).length, 0, 'the second look finds nothing new');
  assert.equal((await fb.recover()).length, 0, 'a browser that holds the record is not given a second one');

  w.btc.mine(143);
  for (let i = 0; i < 40 && (await fb2.records())[0].phase !== 'refunded'; i++) { await fb2.tick(); w.btc.mine(1); w.clock.advance(60); }
  const back = (await fb2.records())[0];
  assert.deepEqual([back.title, back.ended], ['Returned', true]);
  assert.ok(await w.noteOf((await store2.get(rec.id)).refund.txid, 0), 'the note came back to the key');
});

test('a provider that cannot hold the payout is found out before anything is locked, and one that can holds it through the confirmation', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(NET, 'net');
  w.lBtc.satsUtxos = async () => Array.from({ length: 4 }, (_, i) => ({ txid: String(i).repeat(64), vout: 0, value: 200_000 }));
  const s = await serve(w, { config: feeConfig(w) });
  ref.base = s.base;
  const counter = counterAt(s.base);
  const fb = clientFor(w, counter);
  assert.equal((await fb.terms()).available, VALUE, 'what the provider can take now, in the amount the user pays');
  const q = await fb.quote(VALUE);
  // another user's reservation takes the inventory between the quote and the press
  const other = await counter.quote(VALUE);
  assert.equal((await counter.reserve({ quoteId: other.id })).ok, true);
  await assert.rejects(() => fb.start({ quote: q, notes: [w.note] }), /cannot hold that amount: the provider cannot take that amount right now/);
  assert.deepEqual(await w.userStore.list(), [], 'no lock was built');
  assert.deepEqual(w.btc.broadcasts, [], 'and nothing was sent to Bitcoin');
  // the reservation lapses; the same quote can be taken, and the lock's broadcast extends it
  w.clock.advance(901);
  const rec = await fb.start({ quote: q, notes: [w.note] });
  assert.ok(s.svc.reservations.get(q.id), 'the payout is held');
  w.userTick = () => fb.tick();
  await w.step(); await w.step();
  assert.equal(s.svc.reservations.get(q.id).txid, rec.lock.txid, 'held for the lock that went out');
  assert.equal(s.svc.reservations.get(q.id).until > w.clock.now() + 3600, true);
});

test('the words for each phase, and for one the page does not know', () => {
  const phases = ['built', 'broadcast', 'offered', 'claiming', 'claimed', 'done', 'refund-wait', 'refunded', 'counter-took'];
  const d = phases.map((phase) => describe({ id: 'x', phase, amount: '5', evmAmount: '4', created: 1 }));
  assert.deepEqual(d.map((x) => x.at), [0, 0, 1, 2, 2, 3, 0, 3, 3]);
  assert.deepEqual(d.map((x) => x.ended), [false, false, false, false, false, true, false, true, true]);
  assert.ok(d.every((x) => x.title && x.detail && x.steps.length === 4));
  assert.equal(describe({ id: 'x', phase: 'mystery', created: 1 }).title, 'mystery');
  assert.match(describe({ id: 'x', phase: 'refund-wait', why: 'the counterparty declined: quote expired', created: 1 }).detail, /quote expired/);
  assert.equal(describe({ id: 'x', phase: 'refund-wait', created: 1, lastError: 'explorer down' }).error, 'explorer down');
});

test('swaps kept in localStorage: one entry each, other keys left alone, an entry that is not a swap skipped', async () => {
  const m = new Map();
  const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
  m.set('other', 'x'); m.set('tacit-fb:junk', '{not json');
  const st = makeLocalStore('tacit-fb:', storage);
  await st.put({ id: 'a1', phase: 'built' }); await st.put({ id: 'b2', phase: 'done' });
  assert.deepEqual(await st.get('a1'), { id: 'a1', phase: 'built' });
  assert.equal(await st.get('nope'), null);
  assert.deepEqual((await st.list()).map((r) => r.id).sort(), ['a1', 'b2']);
  await st.put({ id: 'a1', phase: 'broadcast' });
  assert.equal((await st.get('a1')).phase, 'broadcast');
});

test('run(): a pass now and one every interval, handed to onChange, until stopped', async () => {
  const { w } = httpWorld();
  const store = memStore();
  await store.put({ v: 1, role: 'bl', id: 'ab'.repeat(36), phase: 'done', created: 5, amount: '1', evmAmount: '1' });
  const fb = clientFor(w, fakeLp(w), { store });
  const seen = [];
  const stop = fb.run({ everyMs: 5, onChange: (list) => seen.push(list.map((r) => r.title)) });
  await new Promise((r) => setTimeout(r, 60));
  stop();
  const n = seen.length;
  assert.ok(n >= 3, `${n} passes`);
  assert.deepEqual(seen[0], ['Done']);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(seen.length, n, 'no pass after stop');
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
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${ran} fastbridge client checks passed`);
process.exit(process.exitCode || 0);
