// own-nodes/gateway.mjs: the keyed trace path (INTERNAL_TRACE=1). What it pins: off by default and never for visitors; only the three forms
// dapp/fastbridge-evm.js makeTxTracer sends get through (the pool-calls JavaScript tracer for an allowed pool, callTracer, trace_transaction), any other
// JavaScript or option is refused before the node sees it; the timeout is capped; an answer over the size cap is refused; traces run a few at a time;
// and the gateway's copy of the pool tracer is the dapp's, character for character.
//
// Run: node --test tests/own-node-trace.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeGateway, poolCallsTracer } from '../own-nodes/gateway.mjs';
import { poolCallsTracer as dappTracer } from '../dapp/fastbridge-evm.js';

const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const TX = '0x' + 'ab'.repeat(32);
const KEY = 'trace-key-0123456789abcdef';
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const body = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)); });

const node = { seen: [], big: 0, delay: 0 };
const eth = http.createServer(async (req, res) => {
  const p = JSON.parse(await body(req));
  const one = async (r) => {
    node.seen.push(r);
    if (node.delay) await new Promise((x) => setTimeout(x, node.delay));
    const result = r.method === 'debug_traceTransaction' ? (node.big ? { type: 'CALL', input: '0x' + 'ff'.repeat(node.big) } : [{ to: POOL.toLowerCase(), input: '0x1234' }])
      : r.method === 'trace_transaction' ? [] : '0x1';
    return { jsonrpc: '2.0', id: r.id, result };
  };
  const out = Array.isArray(p) ? await Promise.all(p.map(one)) : await one(p);
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
});
const ethPort = await listen(eth);
const start = async (o = {}) => {
  const g = makeGateway({ ethUpstream: `http://127.0.0.1:${ethPort}`, origins: ['https://tacit.finance'], internalKeys: [KEY], internalTrace: true, tracePools: [POOL], ...o });
  const port = await listen(g.server);
  return { base: `http://127.0.0.1:${port}`, g, stop: () => g.server.close() };
};
const call = async (url, method, params, id = 1) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json();
const jsTrace = [TX, { tracer: poolCallsTracer(POOL), timeout: '60s' }];
const callTrace = [TX, { tracer: 'callTracer', timeout: '60s', tracerConfig: { onlyTopCall: false, withLog: false } }];

test('the gateway\'s pool tracer is the dapp\'s, character for character', () => {
  assert.equal(poolCallsTracer(POOL), dappTracer(POOL));
});

test('off unless INTERNAL_TRACE, and never for a visitor or a wrong key', async () => {
  const off = await start({ internalTrace: false });
  try {
    node.seen.length = 0;
    assert.equal((await call(`${off.base}/k/${KEY}/eth`, 'debug_traceTransaction', jsTrace)).error.code, -32601);
  } finally { off.stop(); }
  const on = await start();
  try {
    for (const m of [['debug_traceTransaction', jsTrace], ['debug_traceTransaction', callTrace], ['trace_transaction', [TX]]]) {
      assert.equal((await call(`${on.base}/eth`, ...m)).error.code, -32601, 'visitor: ' + m[0]);
    }
    assert.equal((await fetch(`${on.base}/k/wrong-key-0123456789abcd/eth`, { method: 'POST', body: '{}' })).status, 403);
    assert.deepEqual(node.seen, [], 'nothing reached the node');
  } finally { on.stop(); }
});

test('the three forms the dapp sends pass with the timeout capped; the answer comes back under the caller\'s id', async () => {
  const { base, stop } = await start({ traceTimeoutSec: 20 });
  try {
    node.seen.length = 0;
    const a = await call(`${base}/k/${KEY}/eth`, 'debug_traceTransaction', jsTrace, 9);
    assert.deepEqual(a, { jsonrpc: '2.0', id: 9, result: [{ to: POOL.toLowerCase(), input: '0x1234' }] });
    assert.equal(node.seen[0].params[1].timeout, '20s', '60s asked, 20s sent');
    assert.equal(node.seen[0].params[1].tracer, poolCallsTracer(POOL));
    assert.ok(Array.isArray((await call(`${base}/k/${KEY}/eth`, 'debug_traceTransaction', callTrace)).result));
    assert.deepEqual(node.seen[1].params[1], { tracer: 'callTracer', tracerConfig: { onlyTopCall: false, withLog: false }, timeout: '20s' });
    assert.deepEqual((await call(`${base}/k/${KEY}/eth`, 'trace_transaction', [TX])).result, []);
    assert.equal((await call(`${base}/k/${KEY}/eth`, 'debug_traceTransaction', [TX, { tracer: 'callTracer', timeout: '5s' }])).error, undefined);
    assert.equal(node.seen[3].params[1].timeout, '5s', 'a shorter timeout is kept');
  } finally { stop(); }
});

test('any other tracer, option or shape is refused before the node', async () => {
  const { base, stop } = await start();
  try {
    node.seen.length = 0;
    const refused = [
      [TX, { tracer: '{ result: function () { while (true) {} }, fault: function () {} }' }],
      [TX, { tracer: poolCallsTracer('0x' + '11'.repeat(20)) }],                            // the pool tracer, for a pool not allowed
      [TX, { tracer: poolCallsTracer(POOL) + ' ' }],
      [TX, { tracer: 'prestateTracer' }],
      [TX, { tracer: 'callTracer', tracerConfig: { onlyTopCall: 'no' } }],
      [TX, { tracer: 'callTracer', tracerConfig: { diffMode: true } }],
      [TX, { tracer: 'callTracer', reexec: 100000 }],
      [TX, { tracer: poolCallsTracer(POOL), tracerConfig: {} }],
      [TX],
      ['0x1234', { tracer: 'callTracer' }],
      [TX, { tracer: 'callTracer' }, 'extra'],
    ];
    for (const p of refused) {
      const j = await call(`${base}/k/${KEY}/eth`, 'debug_traceTransaction', p);
      assert.equal(j.error?.code, -32602, JSON.stringify(p).slice(0, 80));
    }
    assert.equal((await call(`${base}/k/${KEY}/eth`, 'trace_transaction', [TX, 'x'])).error.code, -32602);
    for (const m of ['debug_traceCall', 'debug_traceBlockByNumber', 'trace_block', 'trace_filter', 'trace_replayTransaction']) {
      assert.equal((await call(`${base}/k/${KEY}/eth`, m, [TX])).error.code, -32601, m);
    }
    assert.deepEqual(node.seen, []);
  } finally { stop(); }
});

test('an answer over the size cap is refused; traces run a few at a time', async () => {
  const { base, g, stop } = await start({ traceMaxBytes: 10_000, traceConcurrency: 2 });
  try {
    node.big = 20_000;
    const j = await call(`${base}/k/${KEY}/eth`, 'debug_traceTransaction', callTrace);
    assert.equal(j.error.code, -32000); assert.match(j.error.message, /larger than 10000/);
    node.big = 0; node.delay = 150;
    const all = await Promise.all([1, 2, 3, 4].map((i) => call(`${base}/k/${KEY}/eth`, 'debug_traceTransaction', jsTrace, i)));
    assert.equal(all.filter((x) => x.result).length, 2);
    assert.equal(all.filter((x) => x.error?.code === -32005).length, 2);
    assert.equal(g.counters.traced, 2);
  } finally { node.delay = 0; node.big = 0; stop(); }
});

test('a batch mixing a trace and reads answers each in place', async () => {
  const { base, stop } = await start();
  try {
    const r = await (await fetch(`${base}/k/${KEY}/eth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([
      { jsonrpc: '2.0', id: 'a', method: 'eth_chainId', params: [] },
      { jsonrpc: '2.0', id: 'b', method: 'debug_traceTransaction', params: jsTrace },
      { jsonrpc: '2.0', id: 'c', method: 'eth_blockNumber', params: [] },
    ]) })).json();
    assert.deepEqual(r.map((x) => x.id), ['a', 'b', 'c']);
    assert.ok(Array.isArray(r[1].result)); assert.equal(r[0].result, '0x1');
  } finally { stop(); }
});

test.after(() => eth.close());
