// How the Bitcoin side of a fast bridge party reads the explorers (dapp/fastbridge-btc.js, makeEsploraBtcChain): the explorers are shared and rate
// limited, so an explorer that is failing is left alone for a while and asked last, the load is spread over the ones that answer, reads for the same
// path that are under way together are one read, and only so many are out at once. The 404 rule stays: a 404 from one explorer is not an answer
// while another may have the transaction.
//   node tests/fastbridge-btc-reader.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeEsploraBtcChain } from '../dapp/fastbridge-btc.js';

const { prims } = makeBtcWallet({ priv: new Uint8Array(32).fill(7), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
const tid = (n) => n.toString(16).padStart(64, '0');
const json = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const gone = () => json('not found', 404);
const chainOf = (hosts, handler, opts = {}) => {
  let t = 1_000_000; const seen = [];
  const fetchImpl = async (url) => { const u = new URL(url); seen.push(u.hostname); return handler(u, seen.length); };
  const btc = makeEsploraBtcChain({ bases: hosts.map((h) => `https://${h}/api`), prims, builder: null, fetchImpl, nowMs: () => t, ...opts });
  return { btc, seen, later: (ms) => { t += ms; } };
};
const read = (btc, n) => btc.outspend(tid(n), 0);          // a different path for each n: GET /tx/<id>/outspend/0

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('an explorer that rate limits is passed over for the next, and left alone on the reads after it', async () => {
  const { btc, seen } = chainOf(['limited.test', 'calm.test'], (u) => (u.hostname === 'limited.test' ? json('slow down', 429) : json({ spent: false })));
  await read(btc, 1);
  assert.deepEqual(seen, ['limited.test', 'calm.test'], 'the first read tried the limited one and went on');
  await read(btc, 2); await read(btc, 3);
  assert.deepEqual(seen.slice(2), ['calm.test', 'calm.test'], 'the limited one is not asked again while it cools');
});

test('an explorer being left alone is logged once, with its name and why, so a log shows which explorer limited or failed', async () => {
  const lines = [];
  const { btc } = chainOf(['limited.test', 'calm.test'], (u) => (u.hostname === 'limited.test' ? json('slow down', 429) : json({ spent: false })), { log: (o) => lines.push(o) });
  for (let n = 1; n <= 5; n++) await read(btc, n);
  const said = lines.filter((l) => l.msg === 'an explorer is left alone for a while');
  assert.equal(said.length, 1, 'once, not for every read');
  assert.equal(said[0].explorer, 'limited.test');
  assert.equal(said[0].why, 'HTTP 429');
  assert.equal(said[0].forSecs, 20);
});

test('it is asked again when its time has passed, and an answer puts it back among the others', async () => {
  let limited = true;
  const { btc, seen, later } = chainOf(['limited.test', 'calm.test'], (u) => (u.hostname === 'limited.test' && limited ? json('slow down', 429) : json({ spent: false })));
  await read(btc, 1); later(21_000);
  limited = false;
  const before = seen.length;
  await read(btc, 2);
  assert.ok(seen.slice(before).includes('limited.test') || (await read(btc, 3), seen.slice(before).includes('limited.test')), 'asked again after the cool-down');
  const mark = seen.length;
  for (let n = 10; n < 18; n++) await read(btc, n);
  const asked = seen.slice(mark);
  assert.ok(asked.includes('limited.test') && asked.includes('calm.test'), 'and the load is spread over both again');
});

test('a Retry-After longer than the usual wait is kept to', async () => {
  const { btc, seen, later } = chainOf(['limited.test', 'calm.test'], (u) => (u.hostname === 'limited.test' ? json('slow down', 429, { 'retry-after': '120' }) : json({ spent: false })));
  await read(btc, 1);
  later(100_000);
  const a = seen.length; await read(btc, 2); await read(btc, 3);
  assert.ok(!seen.slice(a).includes('limited.test'), 'still cooling 100 s in, as it asked for 120');
  later(21_000);
  const b = seen.length; for (let n = 20; n < 26; n++) await read(btc, n);
  assert.ok(seen.slice(b).includes('limited.test'), 'asked again after the 120 s');
});

test('an explorer that keeps failing waits longer each time', async () => {
  const { btc, seen, later } = chainOf(['down.test', 'calm.test'], (u) => (u.hostname === 'down.test' ? json('bad gateway', 502) : json({ spent: false })));
  await read(btc, 1);                         // fails: 20 s
  later(21_000); const a = seen.length; await read(btc, 2);   // asked again (first in its turn or after calm), fails again: 40 s
  while (!seen.slice(a).includes('down.test')) await read(btc, 100 + seen.length);
  later(25_000); const b = seen.length; await read(btc, 3); await read(btc, 4);
  assert.ok(!seen.slice(b).includes('down.test'), '25 s after the second failure it is still cooling (40 s)');
  later(16_000); const c = seen.length; for (let n = 30; n < 36; n++) await read(btc, n);
  assert.ok(seen.slice(c).includes('down.test'), 'and asked again after the 40 s');
});

test('the explorers are all failing: each is still asked (the cooling ones last), and the error is the last one that answered, not a give-up', async () => {
  const { btc, seen } = chainOf(['a.test', 'b.test'], () => json('slow down', 429));
  await assert.rejects(read(btc, 1), /429/);
  await assert.rejects(read(btc, 2), /429/);
  assert.equal(seen.length, 4, 'both explorers asked on both reads, though both are cooling');
});

test('a recovery shows at once: when the explorers that were cooling answer, reads go on', async () => {
  let up = false;
  const { btc } = chainOf(['a.test', 'b.test'], () => (up ? json({ spent: false }) : json('slow down', 429)));
  await assert.rejects(read(btc, 1), /429/);
  up = true;
  assert.equal(await read(btc, 2), null, 'asked although cooling, since nobody else answers');
});

test('the load is spread: with two explorers that both answer, each is asked first in turn', async () => {
  const { btc, seen } = chainOf(['a.test', 'b.test'], () => json({ spent: false }));
  for (let n = 1; n <= 6; n++) await read(btc, n);
  assert.equal(seen.filter((h) => h === 'a.test').length, 3);
  assert.equal(seen.filter((h) => h === 'b.test').length, 3);
});

test('reads of one path that are under way together are one read', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { btc, seen } = chainOf(['a.test'], async () => { await gate; return json({ spent: false }); });
  const all = Promise.all([read(btc, 7), read(btc, 7), read(btc, 7), read(btc, 7)]);
  await new Promise((r) => setTimeout(r, 5)); release();
  await all;
  assert.equal(seen.length, 1, 'one request for four askers');
  await read(btc, 7);
  assert.equal(seen.length, 2, 'and not kept after: a later read asks again');
});

test('no more reads are out at once than maxReads, however many are asked, and every one is answered', async () => {
  let out = 0, most = 0; const open = [];
  const { btc } = chainOf(['a.test'], async () => { out++; most = Math.max(most, out); await new Promise((r) => open.push(r)); out--; return json({ spent: false }); }, { maxReads: 3 });
  const all = Promise.all(Array.from({ length: 12 }, (_, i) => read(btc, 200 + i)));
  for (let i = 0; i < 40 && open.length < 12; i++) { await new Promise((r) => setTimeout(r, 2)); while (open.length) open.shift()(); }
  while (open.length) open.shift()();
  const done = await Promise.race([all, new Promise((r) => setTimeout(() => r('STUCK'), 3000))]);
  assert.notEqual(done, 'STUCK');
  assert.equal(most, 3, 'three at most at once');
});

test('a slot is given back when a read fails, so one failure does not stop the reads behind it', async () => {
  const { btc } = chainOf(['a.test'], (u) => (u.pathname.includes(tid(300)) ? json('boom', 500) : json({ spent: false })), { maxReads: 1 });
  await assert.rejects(read(btc, 300), /500/);
  assert.equal(await read(btc, 301), null);
  assert.equal(await read(btc, 302), null);
});

test('a 404 from one explorer is not the answer while another has it, and a 404 does not make an explorer cool', async () => {
  const { btc, seen } = chainOf(['lags.test', 'has.test'], (u) => (u.hostname === 'lags.test' ? gone() : json({ spent: true, txid: tid(9) })));
  assert.equal(await read(btc, 1), tid(9));
  const first = seen.length;
  for (let n = 2; n <= 5; n++) await read(btc, n);
  assert.ok(seen.slice(first).includes('lags.test'), 'the explorer that answered 404 is still among those asked first');
});

test('every explorer says 404: the answer is a 404 (a transaction nobody has), and with one down and one 404 it is still the 404', async () => {
  const none = chainOf(['a.test', 'b.test'], () => gone());
  assert.equal(await none.btc.fetchTx(tid(5)), null);
  const mixed = chainOf(['down.test', 'lags.test'], (u) => (u.hostname === 'down.test' ? json('bad gateway', 502) : gone()));
  assert.equal(await mixed.btc.fetchTx(tid(6)), null);
});

test('a 400 (a request of ours that is wrong) does not cool an explorer', async () => {
  const { btc, seen } = chainOf(['a.test', 'b.test'], (u) => (u.hostname === 'a.test' ? json('bad request', 400) : json({ spent: false })));
  for (let n = 1; n <= 4; n++) await read(btc, n);
  assert.ok(seen.filter((h) => h === 'a.test').length >= 2, 'still asked in its turn');
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} reader checks passed`);
process.exit(process.exitCode || 0);
