#!/usr/bin/env node
// The keeper's chain-read passthrough (src/lib/evm-pool-keeper-rpc.js): only reads, only within limits, errors without a node's address.
//   node worker-relay/tests/keeper-rpc.test.mjs
import assert from 'node:assert/strict';
import { makeRpcPassthrough, ALLOWED, MAX_BATCH, MAX_LOG_RANGE } from '../src/lib/evm-pool-keeper-rpc.js';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const calls = [];
let t = 1_000_000;
const make = (over = {}) => makeRpcPassthrough({
  request: async (method, params) => {
    calls.push([method, params]);
    if (method === 'eth_call' && params[0]?.data === '0xdead') throw Object.assign(new Error('execution reverted at https://eth-mainnet.g.alchemy.com/v2/SECRETKEY'), { code: 3, data: '0x08c379a0' });
    if (method === 'eth_getBalance') return '0x10';
    if (method === 'eth_getTransactionReceipt') return null;
    if (method === 'eth_blockNumber') return '0x1000';
    return '0x1';
  },
  chainId: 1, now: () => t, ...over,
});
const one = (id, method, params = []) => ({ jsonrpc: '2.0', id, method, params });

await check('a read is answered with its id, and a null result is an answer', async () => {
  const p = make(); calls.length = 0;
  assert.deepEqual(await p.handle(one(7, 'eth_getBalance', ['0x' + 'aa'.repeat(20), 'latest'])), { status: 200, body: { jsonrpc: '2.0', id: 7, result: '0x10' } });
  assert.deepEqual((await p.handle(one(8, 'eth_getTransactionReceipt', ['0x' + '11'.repeat(32)]))).body, { jsonrpc: '2.0', id: 8, result: null });
});

await check('a batch is answered in order, and a node error is an answer without the node\'s address', async () => {
  const p = make();
  const r = await p.handle([one(1, 'eth_getBalance', ['0xaa', 'latest']), one(2, 'eth_call', [{ to: '0xaa', data: '0xdead' }, 'latest']), one(3, 'eth_blockNumber')]);
  assert.equal(r.status, 200); assert.equal(r.body.length, 3);
  assert.deepEqual(r.body.map((x) => x.id), [1, 2, 3]);
  assert.equal(r.body[1].error.code, 3); assert.equal(r.body[1].error.data, '0x08c379a0');
  assert.ok(!JSON.stringify(r.body).includes('alchemy') && !JSON.stringify(r.body).includes('SECRETKEY'), 'no node URL or key in an error');
  assert.match(r.body[1].error.message, /execution reverted/);
});

await check('what is not a read, or not on the list, is refused with 403, and so is a state override', async () => {
  const p = make(); calls.length = 0;
  for (const m of ['eth_sendRawTransaction', 'eth_sendTransaction', 'debug_traceCall', 'eth_subscribe', 'personal_sign', 'eth_accounts']) assert.equal((await p.handle(one(1, m, []))).status, 403, m);
  assert.equal((await p.handle(one(1, 'eth_call', [{ to: '0xaa' }, 'latest', { '0xaa': { balance: '0x1' } }]))).status, 403, 'state overrides');
  assert.equal((await p.handle([one(1, 'eth_blockNumber'), one(2, 'eth_sendRawTransaction', ['0x'])])).status, 403, 'one bad call refuses the batch');
  assert.deepEqual(calls, [], 'nothing reached a node');
  assert.ok(!ALLOWED.has('eth_sendRawTransaction') && ![...ALLOWED].some((m) => /^(debug|trace|personal|admin|txpool)_/.test(m)));
});

await check('what is not JSON-RPC is 400, and a batch over the limit is too', async () => {
  const p = make();
  assert.equal((await p.handle('nope')).status, 400); assert.equal((await p.handle(null)).status, 400); assert.equal((await p.handle([])).status, 400);
  assert.equal((await p.handle(Array.from({ length: MAX_BATCH + 1 }, (_, i) => one(i, 'eth_blockNumber')))).status, 400);
  assert.equal((await p.handle(Array.from({ length: MAX_BATCH }, (_, i) => one(i, 'eth_blockNumber')))).status, 200);
});

await check('a log read is carried within its range and refused outside it', async () => {
  const p = make(); calls.length = 0;
  const hex = (x) => '0x' + x.toString(16);
  assert.equal((await p.handle(one(1, 'eth_getLogs', [{ fromBlock: hex(100), toBlock: hex(100 + MAX_LOG_RANGE) }]))).status, 200);
  assert.equal((await p.handle(one(1, 'eth_getLogs', [{ fromBlock: hex(100), toBlock: hex(101 + MAX_LOG_RANGE) }]))).status, 403, 'one block too many');
  assert.equal((await p.handle(one(1, 'eth_getLogs', [{ fromBlock: 'earliest', toBlock: 'latest' }]))).status, 403, 'earliest');
  assert.equal((await p.handle(one(1, 'eth_getLogs', [{ fromBlock: hex(0x1000 - 10), toBlock: 'latest' }]))).status, 200, 'up to latest, head 0x1000');
  const far = makeRpcPassthrough({ request: async (m) => (m === 'eth_blockNumber' ? '0x3000' : '0x1'), chainId: 1, now: () => t });
  assert.equal((await far.handle(one(1, 'eth_getLogs', [{ fromBlock: hex(1), toBlock: 'latest' }]))).status, 403, 'a long way to latest (head 0x3000)');
  assert.equal((await p.handle(one(1, 'eth_getLogs', [{ blockHash: '0x' + '22'.repeat(32) }]))).status, 200, 'one block by hash');
  assert.equal((await p.handle(one(1, 'eth_getLogs', [{ fromBlock: hex(5), toBlock: hex(2) }]))).status, 403, 'backwards');
});

await check('the chain id is served without a node, and the head is read once for a couple of seconds', async () => {
  const p = make(); calls.length = 0;
  assert.equal((await p.handle(one(1, 'eth_chainId'))).body.result, '0x1');
  await p.handle(one(2, 'eth_blockNumber')); await p.handle(one(3, 'eth_blockNumber')); await p.handle(one(4, 'eth_blockNumber'));
  assert.equal(calls.filter((c) => c[0] === 'eth_blockNumber').length, 1, 'three reads of the head, one node call');
  t += 2500; await p.handle(one(5, 'eth_blockNumber'));
  assert.equal(calls.filter((c) => c[0] === 'eth_blockNumber').length, 2, 'and again once it is stale');
  assert.equal(calls.filter((c) => c[0] === 'eth_chainId').length, 0);
  calls.length = 0; await p.handle(one(6, 'eth_getBalance', ['0xaa', 'latest'])); await p.handle(one(7, 'eth_getBalance', ['0xaa', 'latest']));
  assert.equal(calls.length, 2, 'a balance is never shared');
});

await check('a sender has a budget of calls a minute, and another sender has its own', async () => {
  const p = make({ callsPerMin: 60, burst: 10 });
  const batch = (k) => Array.from({ length: k }, (_, i) => one(i, 'eth_getBalance', ['0xaa', 'latest']));
  assert.equal((await p.handle(batch(8), 'fwd-a')).status, 200);
  assert.equal((await p.handle(batch(8), 'fwd-a')).status, 429, 'ten at once, eight spent');
  assert.equal((await p.handle(batch(8), 'fwd-b')).status, 200, 'another sender is not held up');
  t += 10_000;
  assert.equal((await p.handle(batch(8), 'fwd-a')).status, 200, 'and it refills');
});

console.log(`\n${n} checks passed`);
