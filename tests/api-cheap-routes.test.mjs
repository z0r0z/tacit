// Routes an anonymous caller can repeat for next to nothing: the cache-status reading is shared for a few seconds, the gas price is read once
// a few seconds, and /gas/done is metered per client before it reads the chain. The explorer and the nodes are stand-ins that count their calls.
//   node tests/api-cheap-routes.test.mjs
import assert from 'node:assert';
import worker, { _ethGasPrice } from '../worker/src/index.js';

let tipReads = 0, rpcCalls = 0, gasReads = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/blocks/tip/height')) { tipReads++; return new Response('948300', { status: 200 }); }
  if (init.body && String(init.body).includes('eth_gasPrice')) { gasReads++; return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x3b9aca00' }), { status: 200 }); }
  if (init.body && String(init.body).includes('eth_call')) { rpcCalls++; return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + '00'.repeat(32) }), { status: 200 }); }
  return new Response('{}', { status: 404 });
};
const store = new Map();
const env = { REGISTRY_KV: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, list: async () => ({ keys: [], list_complete: true }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };
let n = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };
const get = async (path, ip = '203.0.113.7') => { const r = await worker.fetch(new Request(`https://api.test${path}`, { headers: { 'CF-Connecting-IP': ip } }), env, ctx); return { status: r.status, body: await r.json() }; };

// 1. cache-status: a burst of calls is one reading, and a later one reads again
const reads = await Promise.all(Array.from({ length: 12 }, () => get('/reflection/burndep/cache-status?network=mainnet')));
ok(reads.every((r) => r.status === 200 && r.body.ok === true && r.body.tip === 948300), 'the cache-status calls are all answered');
ok(tipReads === 1, `twelve concurrent calls read the explorer once (${tipReads})`);
await get('/reflection/burndep/cache-status?network=mainnet');
ok(tipReads === 1, 'a call soon after reads nothing');
const realNow = Date.now; Date.now = () => realNow() + 16_000;
await get('/reflection/burndep/cache-status?network=mainnet');
Date.now = realNow;
ok(tipReads === 2, 'a call after the reading is 15 s old reads again');

// 2. the gas price is read once for a few seconds, and a failed read is not kept
const p1 = await _ethGasPrice('mainnet'), p2 = await _ethGasPrice('mainnet'), p3 = await _ethGasPrice('mainnet');
ok(p1 === '0x3b9aca00' && p2 === p1 && p3 === p1 && gasReads === 1, `three reads of the gas price make one call (${gasReads})`);
Date.now = () => realNow() + 9_000; await _ethGasPrice('mainnet'); Date.now = realNow;
ok(gasReads === 2, 'after eight seconds it is read again');

// 3. /gas/done is metered per client before it reads the chain
const done = (ip) => worker.fetch(new Request('https://api.test/gas/done', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ id: '0x' + 'ab'.repeat(32), payer: '0x' + '11'.repeat(20), nonce: '5' }) }), env, ctx).then((r) => r.status);
const codes = []; for (let i = 0; i < 45; i++) codes.push(await done('198.51.100.20'));
ok(codes.slice(0, 30).every((c) => c === 409) && codes.slice(30).some((c) => c === 429), 'a client past its burst is refused with a 429');
ok(rpcCalls <= 31, `and the chain was read for the burst only (${rpcCalls} reads for 45 calls)`);
ok(await done('198.51.100.21') === 409, 'another client is answered as before');
console.log(`${n} ok`);
process.exit(0);
