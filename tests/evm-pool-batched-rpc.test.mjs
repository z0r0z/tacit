// batchedRpc: the calls several wallets make at once go out as one batched request, a repeated call once, and a call the batch
// fails (or a batch no node takes) is asked again on its own.
import assert from 'node:assert/strict';
import { jsonRpc, batchedRpc } from '../dapp/evm-pool-wallet.js';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
// A node answering eth_blockNumber, eth_chainId and eth_call (a revert for data 0xdead), refusing batches when told to.
function node({ batches = true } = {}) {
  const seen = [];
  const answer = (c) => (c.method === 'eth_blockNumber' ? { result: '0x10' } : c.method === 'eth_chainId' ? { result: '0x1' }
    : c.params?.[0]?.data === '0xdead' ? { error: { code: 3, message: 'execution reverted' } } : { result: '0x' + c.params[0].data.slice(2).padStart(64, '0') });
  const fetchImpl = async (url, { body }) => {
    const b = JSON.parse(body);
    seen.push(Array.isArray(b) ? b.map((c) => c.method) : b.method);
    if (Array.isArray(b) && !batches) return { status: 200, json: async () => ({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch requests are not supported' } }) };
    const one = (c) => ({ jsonrpc: '2.0', id: c.id, ...answer(c) });
    return { status: 200, json: async () => (Array.isArray(b) ? b.map(one) : one(b)) };
  };
  return { seen, fetchImpl };
}

await check('calls made together go as one batch, a repeated one once', async () => {
  const nd = node(), r = batchedRpc(jsonRpc('https://a', nd.fetchImpl));
  const out = await Promise.all([r('eth_blockNumber'), r('eth_blockNumber'), r('eth_chainId'), r('eth_call', [{ to: '0x1', data: '0x01' }, 'latest'])]);
  assert.deepEqual(out, ['0x10', '0x10', '0x1', '0x' + '1'.padStart(64, '0')]);
  assert.equal(nd.seen.length, 1);
  assert.deepEqual(nd.seen[0], ['eth_blockNumber', 'eth_chainId', 'eth_call']);
});

await check('a call the batch fails is asked again alone, and its error is the one jsonRpc gives', async () => {
  const nd = node(), r = batchedRpc(jsonRpc('https://a', nd.fetchImpl));
  const [a, b] = await Promise.allSettled([r('eth_blockNumber'), r('eth_call', [{ to: '0x1', data: '0xdead' }, 'latest'])]);
  assert.equal(a.value, '0x10');
  assert.equal(b.status, 'rejected');
  assert.match(b.reason.message, /reverted/);
  assert.deepEqual(nd.seen, [['eth_blockNumber', 'eth_call'], 'eth_call']);
});

await check('a node that takes no batches: each call goes alone', async () => {
  const nd = node({ batches: false }), r = batchedRpc(jsonRpc('https://a', nd.fetchImpl));
  const out = await Promise.all([r('eth_blockNumber'), r('eth_chainId')]);
  assert.deepEqual(out, ['0x10', '0x1']);
  assert.deepEqual(nd.seen, [['eth_blockNumber', 'eth_chainId'], 'eth_blockNumber', 'eth_chainId']);
});

await check('one call alone is not batched, and a call with options goes straight through', async () => {
  const nd = node(), r = batchedRpc(jsonRpc('https://a', nd.fetchImpl));
  assert.equal(await r('eth_chainId'), '0x1');
  assert.equal(await r('eth_blockNumber', [], { found: true }), '0x10');
  assert.deepEqual(nd.seen, ['eth_chainId', 'eth_blockNumber']);
});

await check('more calls than a batch takes go in several', async () => {
  const nd = node(), r = batchedRpc(jsonRpc('https://a', nd.fetchImpl), { max: 3 });
  const out = await Promise.all([1, 2, 3, 4, 5].map((i) => r('eth_call', [{ to: '0x1', data: '0x0' + i }, 'latest'])));
  assert.equal(out.length, 5);
  assert.deepEqual(nd.seen.map((x) => (Array.isArray(x) ? x.length : 1)), [3, 2]);
});

await check('the node that answered last is the one jsonRpc names', async () => {
  const nd = node(), inner = jsonRpc(['https://a', 'https://b'], async (url, init) => { if (url === 'https://a') throw new TypeError('fetch failed'); return nd.fetchImpl(url, init); });
  const r = batchedRpc(inner);
  assert.equal(r.node, undefined);
  await r('eth_chainId');
  assert.equal(r.node, 'https://b');
  assert.equal(r.node, inner.node);
});

console.log(`${n} passed`);
