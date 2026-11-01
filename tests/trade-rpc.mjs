#!/usr/bin/env node
// dapp/trade/rpc.js: the nodes are asked in order, a slow one is hedged with the next, a failing one is skipped at once, a revert ends the call,
// and the losers are cancelled. A scripted `fetch` stands in for the nodes; hedgeMs is shortened so it runs in milliseconds.
import assert from 'node:assert';
import { hedgedRpc, hedgeDelay, bodyType, takeEarly } from '../dapp/trade/rpc.js';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const HOSTS = ['https://a', 'https://b', 'https://c'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// plan: host → { wait: ms before answering, result | error | throws | hang }
function nodes(plan) {
  const log = { asked: [], aborted: [], types: {} };
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    const p = plan[url] || {}, i = log.asked.push(url) - 1; log.types[url] = init.headers['content-type'];
    const abort = () => { log.aborted.push(url); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    if (init.signal.aborted) return abort();
    init.signal.addEventListener('abort', abort);
    if (p.hang) return;
    setTimeout(() => (p.throws ? reject(new Error(p.throws)) : resolve({ json: async () => (p.bare ? p.bare : p.error ? { jsonrpc: '2.0', id: 1, error: p.error } : { jsonrpc: '2.0', id: 1, result: p.result ?? url }) })), p.wait ?? 0);
  });
  return { log, fetchImpl };
}
const rpc = (plan, o = {}) => { const x = nodes(plan); return hedgedRpc(HOSTS, 'eth_call', [], { hedgeMs: 40, fetchImpl: x.fetchImpl, ...o }).then((v) => ({ v, log: x.log }), (e) => Promise.reject(Object.assign(e, { log: x.log }))); };

{
  const { v, log } = await rpc({});
  assert.equal(v, 'https://a'); assert.deepEqual(log.asked, ['https://a']);
  ok('a node that answers in time is the only one asked');
}
{
  const { v, log } = await rpc({ 'https://a': { bare: { code: 429, message: 'rate limited' } } });
  assert.equal(v, 'https://b'); assert.deepEqual(log.asked, ['https://a', 'https://b']);
  ok('a reply with neither a result nor an error is a node that failed, not an answer: the next node is asked');
}
{
  const { v, log } = await rpc({ 'https://a': { wait: 15 } });
  assert.equal(v, 'https://a'); assert.equal(log.asked.length, 1);
  ok('an answer that arrives before the hedge starts nothing else');
}
{
  const t0 = Date.now();
  const { v, log } = await rpc({ 'https://a': { hang: true } });
  assert.equal(v, 'https://b'); assert.deepEqual(log.asked, ['https://a', 'https://b']);
  assert.ok(Date.now() - t0 < 400, `the next node is asked after the hedge, not after the timeout (${Date.now() - t0} ms)`);
  await sleep(10); assert.deepEqual(log.aborted, ['https://a'], 'and the one that hung is cancelled');
  ok('a node that hangs is hedged with the next after hedgeMs, and cancelled once another has answered');
}
{
  const { v, log } = await rpc({ 'https://a': { wait: 200, result: 'late' }, 'https://b': { wait: 5, result: 'quick' } });
  assert.equal(v, 'quick'); await sleep(10); assert.ok(log.aborted.includes('https://a'));
  ok('the first answer wins, even from a later node');
}
{
  const t0 = Date.now();
  const { v, log } = await rpc({ 'https://a': { throws: 'network down' } }, { hedgeMs: 5000 });
  assert.equal(v, 'https://b'); assert.deepEqual(log.asked, ['https://a', 'https://b']); assert.ok(Date.now() - t0 < 200, 'no waiting on the hedge');
  ok('a node that fails is skipped at once, with no wait');
}
{
  const { v, log } = await rpc({ 'https://a': { error: { code: -32005, message: 'archive requests need a token' } }, 'https://b': { error: { code: 403, message: 'forbidden' } } });
  assert.equal(v, 'https://c'); assert.equal(log.asked.length, 3);
  ok('nodes that answer with an error are passed over until one answers');
}
{
  await assert.rejects(rpc({ 'https://a': { error: { code: 3, message: 'execution reverted: NoRoute' } } }), (e) => /reverted/.test(e.message) && e.revert === true && e.log.asked.length === 1);
  await assert.rejects(rpc({ 'https://a': { error: { code: -32000, message: 'Execution reverted' } } }), (e) => e.revert === true && e.log.asked.length === 1);
  ok('a revert ends the call at once and is marked as one (no other node is asked)');
}
{
  await assert.rejects(rpc({ 'https://a': { throws: 'one' }, 'https://b': { error: { message: 'two' } }, 'https://c': { throws: 'three' } }), (e) => e.message === 'three' && e.log.asked.length === 3);
  await assert.rejects(hedgedRpc([], 'eth_call', []), /no RPC answered/);
  ok('when every node fails the last failure is the answer, and with no nodes there is one at once');
}
{
  // one hedge, not a cascade: nodes that are all slow are not each sent the same heavy read
  const x = nodes({ 'https://a': { hang: true }, 'https://b': { hang: true }, 'https://c': { wait: 5, result: 'third' } });
  const done = hedgedRpc(HOSTS, 'eth_call', [], { hedgeMs: 40, timeoutMs: 400, fetchImpl: x.fetchImpl });
  await sleep(220); assert.deepEqual(x.log.asked, ['https://a', 'https://b'], 'the second node is the hedge, and no third is asked while those two are still out');
  assert.equal(await done, 'third'); assert.deepEqual(x.log.asked, ['https://a', 'https://b', 'https://c']);
  ok('there is one hedge: with two hung nodes the third is asked only when the first has timed out, never more requests than nodes');
}
{
  const x = nodes({ 'https://a': { hang: true } });
  const done = hedgedRpc(HOSTS, 'eth_call', [], { hedgeMs: 0, timeoutMs: 120, fetchImpl: x.fetchImpl });
  await sleep(80); assert.deepEqual(x.log.asked, ['https://a'], 'with the hedge off one node is asked at a time');
  assert.equal(await done, 'https://b');
  ok('a hedge of 0 asks one node at a time, as before');
}
{
  const set = (v) => { globalThis.localStorage = { getItem: () => v }; };
  assert.equal(hedgeDelay(), 2500, 'no storage at all');
  set(null); assert.equal(hedgeDelay(), 2500); set('0'); assert.equal(hedgeDelay(), 0); set('800'); assert.equal(hedgeDelay(), 800); set('abc'); assert.equal(hedgeDelay(), 2500); set('-5'); assert.equal(hedgeDelay(), 0);
  delete globalThis.localStorage;
  ok('the delay is 2.5 s, and a browser can set it (0 switches hedging off)');
}
{
  const { log } = await rpc({ 'https://a': { hang: true }, 'https://b': { hang: true }, 'https://c': { hang: true } }, { timeoutMs: 60, lastTimeoutMs: 80 }).catch((e) => ({ log: e.log, err: e }));
  assert.equal(log.asked.length, 3); assert.equal(log.aborted.length, 3, 'each hung request times out and is cancelled');
  ok('requests that never answer time out');
}
{
  assert.equal(bodyType('https://ethereum-rpc.publicnode.com'), 'text/plain;charset=UTF-8'); assert.equal(bodyType('https://eth.drpc.org'), 'text/plain;charset=UTF-8'); assert.equal(bodyType('https://mainnet.gateway.tenderly.co'), 'text/plain;charset=UTF-8');
  assert.equal(bodyType('https://1rpc.io/eth'), 'application/json', 'a node that refuses text/plain is sent JSON'); assert.equal(bodyType('not a url'), 'application/json');
  for (const u of ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org']) assert.equal(bodyType(u), 'text/plain;charset=UTF-8', `${u} takes a plain body`);
  assert.equal(bodyType('https://rpc.mainnet.chain.robinhood.com'), 'application/json', 'https://rpc.mainnet.chain.robinhood.com wants JSON');
  const { log } = await rpc({ 'https://a': { throws: 'down' } });
  assert.equal(log.types['https://a'], 'application/json', 'an unknown node is sent JSON, as before');
  ok('the nodes that take a plain-text body are sent one (no preflight request); the rest are sent JSON');
}
// ── takeEarly: a read the page's head sent to the first node is taken once, by the call that asks for exactly it ──
{
  const later = (ms, v, fail) => new Promise((res, rej) => setTimeout(() => (fail ? rej(fail) : res(v)), ms));
  const calls = [], rpc = (hosts, method, params, o = {}) => { calls.push({ hosts: hosts.join(), method, o: JSON.stringify(o) }); return Promise.resolve(`nodes:${hosts.length}`); };
  const store = new Map([['eth_call[{"to":"0x1"},"latest"]', later(5, 'early')], ['eth_gasPrice[]', later(5, null, new Error('down'))],
    ['eth_chainId[]', later(5, null, Object.assign(new Error('execution reverted'), { revert: true }))], ['eth_blockNumber[]', new Promise(() => {})]]);
  const o = { hedgeMs: 40, store, rpc };
  assert.equal(await takeEarly(HOSTS, 'eth_call', [{ to: '0x1' }, 'latest'], o), 'early'); assert.equal(calls.length, 0, 'its answer, no node asked');
  assert.equal(await takeEarly(HOSTS, 'eth_call', [{ to: '0x1' }, 'latest'], o), 'nodes:3', 'once: the next call asks all the nodes');
  assert.equal(await takeEarly(HOSTS, 'eth_call', [{ to: '0x2' }, 'latest'], o), 'nodes:3', 'another call is not given it');
  calls.length = 0;
  assert.equal(await takeEarly(HOSTS, 'eth_gasPrice', [], o), 'nodes:2', 'a failed early read: the other nodes are asked');
  assert.deepEqual(calls[0], { hosts: 'https://b,https://c', method: 'eth_gasPrice', o: '{}' }, 'as usual, the first (which the head asked) left out');
  await assert.rejects(takeEarly(HOSTS, 'eth_chainId', [], o), /reverted/, 'a revert is the answer');
  assert.equal(calls.length, 1, 'a revert is not asked again');
  const t0 = Date.now();
  assert.equal(await takeEarly(HOSTS, 'eth_blockNumber', [], o), 'nodes:2');
  assert.ok(Date.now() - t0 < 300, 'an early read still out after the hedge time: the next node is asked beside it');
  assert.deepEqual(calls[1], { hosts: 'https://b,https://c', method: 'eth_blockNumber', o: '{"hedgeMs":0}' }, 'and no other unless it fails: never more requests at once than hedgedRpc makes');
  assert.equal(store.size, 0, 'each is taken once');
  assert.equal(await takeEarly(HOSTS, 'eth_call', [], { store: undefined, rpc }), 'nodes:3', 'no early reads at all: the nodes');
}
ok('a read sent from the head is taken once by the call that asks for exactly it; a failed one falls to the other nodes, a slow one is hedged once (no more requests at once than before), a revert is the answer');
console.log(`\n${n} trade-rpc checks passed`);
