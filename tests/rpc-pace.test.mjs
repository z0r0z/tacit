// dapp/rpc-pace.js: a page never has more requests in flight to a rate-limited public node than it serves; the rest wait in order, a cancelled one
// leaves the queue unsent, and a node or method with no limit is not touched. Then through the real clients (hedgedRpc, jsonRpc).
//   node tests/rpc-pace.test.mjs

import assert from 'node:assert/strict';
import { pace, busy } from '../dapp/rpc-pace.js';
import { hedgedRpc } from '../dapp/trade/rpc.js';
import { jsonRpc } from '../dapp/evm-pool-wallet.js';

let failed = 0;
const test = async (name, fn) => { try { await fn(); console.log('  ok - ' + name); } catch (e) { failed++; console.log('  FAIL - ' + name + '\n' + e.stack); } };
const NODEREAL = 'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7', BASE = 'https://mainnet.base.org', OTHER = 'https://ethereum-rpc.publicnode.com';
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// a node that answers after `ms`, and notes how many requests it has at once
function node(ms = 10) {
  const n = { now: 0, max: 0, started: [], done: [] };
  n.send = (tag) => { n.started.push(tag); n.now++; n.max = Math.max(n.max, n.now); return tick(ms).then(() => { n.now--; n.done.push(tag); return tag; }); };
  return n;
}

await test('three wide log queries at once to nodereal, the rest in order as each is done', async () => {
  const n = node(15);
  const all = await Promise.all(Array.from({ length: 10 }, (_, i) => pace(NODEREAL, 'eth_getLogs', () => n.send(i))));
  assert.deepEqual(all, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(n.max, 3, 'never more than three in flight');
  assert.deepEqual(n.started, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'asked in the order they came');
  assert.equal(busy(NODEREAL, 'eth_getLogs'), 0, 'nothing left waiting');
});

await test('another method to the same node, and any method to a node with no limit, is not held back', async () => {
  const n = node(15);
  await Promise.all(Array.from({ length: 12 }, (_, i) => pace(NODEREAL, 'eth_call', () => n.send(i))));
  assert.equal(n.max, 12, 'calls to nodereal are not limited');
  const m = node(15);
  await Promise.all(Array.from({ length: 12 }, (_, i) => pace(OTHER, 'eth_getLogs', () => m.send(i))));
  assert.equal(m.max, 12, 'publicnode is not limited');
  assert.equal(busy(OTHER, 'eth_getLogs'), 0);
  const sync = []; const p = pace(OTHER, 'eth_call', () => { sync.push('sent'); return Promise.resolve(1); });
  assert.deepEqual(sync, ['sent'], 'a node with no limit is sent to at once, with nothing between');
  assert.equal(await p, 1);
});

await test('Base\'s own endpoint is held to four of any kind', async () => {
  const n = node(10);
  await Promise.all(Array.from({ length: 20 }, (_, i) => pace(BASE, i % 2 ? 'eth_call' : 'eth_getBalance', () => n.send(i))));
  assert.equal(n.max, 4);
});

await test('a request that fails frees its place, and its error reaches the caller', async () => {
  const n = node(5);
  const boom = new Error('boom');
  const rs = await Promise.allSettled([0, 1, 2, 3, 4, 5].map((i) => pace(NODEREAL, 'eth_getLogs', () => (i === 1 ? Promise.reject(boom) : i === 2 ? (() => { throw boom; })() : n.send(i)))));
  assert.deepEqual(rs.map((r) => r.status), ['fulfilled', 'rejected', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
  assert.equal(rs[1].reason, boom);
  assert.equal(busy(NODEREAL, 'eth_getLogs'), 0, 'every place was given back');
});

await test('a queued request whose signal aborts is never sent; one already sent is left to its own signal', async () => {
  const n = node(30);
  const ctl = [new AbortController(), new AbortController(), new AbortController(), new AbortController(), new AbortController()];
  const ps = ctl.map((c, i) => pace(NODEREAL, 'eth_getLogs', () => n.send(i), c.signal).then((v) => ['ok', v], (e) => ['err', e.name]));
  await tick(1);
  assert.equal(busy(NODEREAL, 'eth_getLogs'), 5, 'three in flight, two waiting');
  ctl[4].abort(); ctl[0].abort();
  const rs = await Promise.all(ps);
  assert.deepEqual(rs[4], ['err', 'AbortError'], 'the one waiting is cancelled');
  assert.deepEqual(rs[0], ['ok', 0], 'the one already sent finishes (a real fetch would be cancelled by its own signal)');
  assert.deepEqual(n.started, [0, 1, 2, 3], 'the cancelled one was never sent');
  const late = new AbortController(); late.abort();
  assert.equal(await pace(NODEREAL, 'eth_getLogs', () => n.send('late'), late.signal).catch((e) => e.name), 'AbortError', 'already aborted: refused at once');
  assert.ok(!n.started.includes('late'));
  assert.equal(busy(NODEREAL, 'eth_getLogs'), 0);
});

// A fetch that serves a JSON-RPC body and notes concurrency per URL.
function net(ms = 12) {
  const per = new Map();
  const fetchImpl = async (url, init) => {
    const s = per.get(url) || per.set(url, { now: 0, max: 0, calls: 0 }).get(url);
    s.now++; s.calls++; s.max = Math.max(s.max, s.now);
    await tick(ms);
    s.now--;
    const body = JSON.parse(init.body);
    return { status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x1' }) };
  };
  return { per, fetchImpl };
}

await test('through hedgedRpc: a burst of log reads to nodereal never has more than three in flight, and all are answered', async () => {
  const n = net();
  const rs = await Promise.all(Array.from({ length: 14 }, (_, i) => hedgedRpc([NODEREAL], 'eth_getLogs', [{ fromBlock: '0x' + (i + 1).toString(16), toBlock: '0x' + (i + 9).toString(16) }], { fetchImpl: n.fetchImpl, hedgeMs: 0 })));
  assert.equal(rs.length, 14);
  assert.equal(n.per.get(NODEREAL).max, 3);
  assert.equal(n.per.get(NODEREAL).calls, 14);
});

await test('through jsonRpc: the same, and calls to the node are not held to it', async () => {
  const n = net();
  const rpc = jsonRpc([NODEREAL], n.fetchImpl);
  await Promise.all(Array.from({ length: 14 }, (_, i) => rpc('eth_getLogs', [{ fromBlock: '0x' + (i + 1).toString(16), toBlock: '0x' + (i + 9).toString(16) }])));
  assert.equal(n.per.get(NODEREAL).max, 3);
  const m = net();
  const rpc2 = jsonRpc([NODEREAL], m.fetchImpl);
  await Promise.all(Array.from({ length: 14 }, () => rpc2('eth_blockNumber', [])));
  assert.equal(m.per.get(NODEREAL).max, 14);
});

await test('a hedge that is beaten while it waits for a place is dropped unsent', async () => {
  const fast = 'https://ethereum-rpc.publicnode.com';
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    await tick(url === NODEREAL ? 60 : 3);
    const body = JSON.parse(init.body);
    return { status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: url }) };
  };
  // fill nodereal's three places with slow log reads, then a fourth read hedges from the fast node to nodereal: the fast one answers first
  const fill = Array.from({ length: 3 }, () => hedgedRpc([NODEREAL], 'eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2' }], { fetchImpl, hedgeMs: 0 }));
  await tick(1);
  const r = await hedgedRpc([fast, NODEREAL], 'eth_getLogs', [{ fromBlock: '0x5', toBlock: '0x6' }], { fetchImpl, hedgeMs: 1 });
  assert.equal(r, fast);
  await Promise.all(fill);
  assert.equal(seen.filter((u) => u === NODEREAL).length, 3, 'the hedge that never got a place was not sent');
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
