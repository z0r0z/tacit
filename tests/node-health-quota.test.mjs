// trade/rpc.js nodeHealth: readers that share a record learn a refusal once, a key that has used up its quota rests longer than a busy node, and the rest is
// carried to the next page; hedgedRpc rests a node that says its key's usage limit is reached.
//   node tests/node-health-quota.test.mjs

import assert from 'node:assert/strict';
import { nodeHealth, hedgedRpc, QUOTA } from '../dapp/trade/rpc.js';

let failed = 0;
const test = async (name, fn) => { try { await fn(); console.log('  ok - ' + name); } catch (e) { failed++; console.log('  FAIL - ' + name + '\n' + e.stack); } };
const A = 'https://a.example', B = 'https://b.example';
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };

await test('what counts as a used-up quota', () => {
  for (const msg of ['You have reached the maximum API usage limit of public. If you need more, upgrade', 'Daily limit exceeded', 'quota exhausted', 'API usage limit']) assert.ok(QUOTA.test(msg), msg);
  for (const msg of ['service temporarily unavailable', 'execution reverted', 'ranges over 10000 blocks are not supported', 'Archive requests require a personal token']) assert.ok(!QUOTA.test(msg), msg);
});

await test('readers that share a key have one record: a node one found refusing is asked last by the other', () => {
  let t = 1000; const now = () => t;
  const one = nodeHealth({ now, key: 'k-shared', shared: true }), two = nodeHealth({ now, key: 'k-shared', shared: true });
  assert.equal(one, two);
  one.fail(A, 'quota');
  assert.deepEqual(two.order([A, B]), [B, A]);
  const apart = nodeHealth({ now, key: 'k-apart' }), other = nodeHealth({ now, key: 'k-apart' });
  assert.notEqual(apart, other, 'without `shared`, each is its own (as before)');
  apart.fail(A, 'down');
  assert.deepEqual(other.order([A, B]), [A, B]);
  assert.notEqual(nodeHealth({ now, key: 'k-other', shared: true }), one, 'another key is another record');
});

await test('readers given the same fetch share a record, those given another do not (a page has one fetch; separate worlds stay apart)', () => {
  let t = 0; const now = () => t;
  const f1 = () => {}, f2 = () => {};
  const a = nodeHealth({ now, key: 'k-scope', shared: f1 }), b = nodeHealth({ now, key: 'k-scope', shared: f1 }), c = nodeHealth({ now, key: 'k-scope', shared: f2 });
  assert.equal(a, b);
  assert.notEqual(a, c);
  a.fail(A, 'down');
  assert.deepEqual(b.order([A, B]), [B, A]);
  assert.deepEqual(c.order([A, B]), [A, B]);
  assert.equal(nodeHealth({ now, key: 'k-scope', shared: true }), nodeHealth({ now, key: 'k-scope', shared: true }), 'true: the whole page');
  assert.notEqual(nodeHealth({ now, key: 'k-scope', shared: true }), a);
});

await test('a node whose quota is used up rests a minute, doubling to five; one that is merely busy rests less and never over two minutes', () => {
  let t = 0; const now = () => t;
  const h = nodeHealth({ now });
  h.fail(A, 'quota'); t = 59e3; assert.equal(h.order([A, B])[0], B, 'rests at 59 s'); t = 60e3; assert.equal(h.order([A, B])[0], A, 'rests a minute');
  t = 0; h.fail(A, 'quota'); t = 119e3; assert.equal(h.order([A, B])[0], B, 'two in a row: two minutes'); t = 120e3; assert.equal(h.order([A, B])[0], A);
  t = 0; h.fail(A, 'quota'); t = 239e3; assert.equal(h.order([A, B])[0], B); t = 240e3; assert.equal(h.order([A, B])[0], A, 'three in a row: four minutes');
  t = 0; h.fail(A, 'quota'); t = 299e3; assert.equal(h.order([A, B])[0], B); t = 300e3; assert.equal(h.order([A, B])[0], A, 'never over five minutes');
  const g = nodeHealth({ now }); t = 0;
  for (let i = 0; i < 6; i++) { t = 0; g.fail(A, 'limited'); }
  t = 119e3; assert.equal(g.order([A, B])[0], B); t = 120e3; assert.equal(g.order([A, B])[0], A, 'a busy node is still capped at two minutes');
  g.ok(A); assert.deepEqual(g.order([A, B]), [A, B], 'forgiven once it answers');
});

await test('the rest is kept for the next page, up to five minutes for a quota', () => {
  let t = 10_000; const now = () => t; const store = mem();
  const first = nodeHealth({ now, store, key: 'k-store' });
  first.fail(A, 'quota'); first.fail(A, 'quota'); first.fail(B, 'down');
  t = 12_000;
  const next = nodeHealth({ now, store, key: 'k-store' });
  assert.equal(next.order([A, 'https://c.example'])[0], 'https://c.example', 'the quota rest is still on');
  t = 10_000 + 119e3; assert.equal(nodeHealth({ now, store, key: 'k-store' }).order([A, 'https://c.example'])[0], 'https://c.example', 'two minutes in, still resting');
  t = 10_000 + 121e3; assert.equal(nodeHealth({ now, store, key: 'k-store' }).order([A, 'https://c.example'])[0], A, 'rested');
  // a stored quota rest longer than any is cut to five minutes, a stored rest of any other kind to two
  const base = t, long = mem(); long.setItem('k-long', JSON.stringify({ 'q!a.example': base + 3_600e3, 'b.example': base + 3_600e3 }));
  const cut = nodeHealth({ now, store: long, key: 'k-long' });
  t = base + 119e3; assert.deepEqual(cut.order([A, B, 'https://c.example']), ['https://c.example', A, B], 'both rest at 119 s');
  t = base + 121e3; assert.deepEqual(cut.order([A, B, 'https://c.example']), [B, 'https://c.example', A], 'B (any other kind) rested at two minutes; A (quota) still rests');
  t = base + 299e3; assert.equal(cut.order([A, 'https://c.example'])[0], 'https://c.example');
  t = base + 301e3; assert.equal(cut.order([A, 'https://c.example'])[0], A, 'the quota rest ends at five minutes');
  // what a quota rest is stored as, and that it is forgiven when the node answers
  const wrote = mem(); const w = nodeHealth({ now, store: wrote, key: 'k-w' }); t = base; w.fail(A, 'quota'); w.fail(B, 'down');
  assert.deepEqual(Object.keys(JSON.parse(wrote.getItem('k-w'))).sort(), ['b.example', 'q!a.example']);
  w.ok(A); assert.deepEqual(Object.keys(JSON.parse(wrote.getItem('k-w'))), ['b.example']);
});

await test('hedgedRpc rests a node that says its usage limit is reached, so the next calls ask the others first', async () => {
  let t = 0; const now = () => t; const health = nodeHealth({ now });
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push(url); const body = JSON.parse(init.body);
    return url === A
      ? { status: 429, json: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: -32005, message: 'You have reached the maximum API usage limit of public. If you need more, upgrade' } }) }
      : { status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: 'ok' }) };
  };
  assert.equal(await hedgedRpc([A, B], 'eth_blockNumber', [], { fetchImpl, hedgeMs: 0, health }), 'ok');
  assert.deepEqual(asked, [A, B], 'the first call was refused by A and answered by B');
  asked.length = 0;
  for (let i = 0; i < 3; i++) await hedgedRpc([A, B], 'eth_blockNumber', [], { fetchImpl, hedgeMs: 0, health });
  assert.deepEqual(asked, [B, B, B], 'A is not asked while it rests');
  t = 61e3; asked.length = 0;
  await hedgedRpc([A, B], 'eth_blockNumber', [], { fetchImpl, hedgeMs: 0, health });
  assert.deepEqual(asked, [A, B], 'a minute later it is asked again');
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
