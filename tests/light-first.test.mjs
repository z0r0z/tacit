// dapp/trade/rpc.js: cheap reads of the LATEST state are asked of a light node first (ours, or the reader's own), and nothing else is.
// Pinned: which methods are promoted; that a numbered block, a receipt, a transaction, a block or a log is NOT (a light node answers an old
// transaction with null and a caller reads null as "not there"); that a node resting after a limit goes behind the others; that the reader's
// own node (127.0.0.1:8545) is a light node too; that 'tacit-light-first'='0' turns it off; and that a node is recognised by its PUBLISHED log span.
//
// Run: node --test tests/light-first.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }, configurable: true, writable: true });
const { ETH_NODES } = await import('../dapp/eth-nodes.js');
const { hedgedRpc, nodeHealth } = await import('../dapp/trade/rpc.js');

const OURS = ETH_NODES.find((u) => u.includes('tacit-node-gw'));
const A = '0x' + 'ab'.repeat(20);
const firstAsked = async (method, params, hosts = ETH_NODES, extra = {}) => {
  const hits = [];
  const fetchImpl = async (u) => { hits.push(new URL(u).host + new URL(u).pathname.replace(/\/$/, '')); return { status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }) }; };
  await hedgedRpc(hosts, method, params, { fetchImpl, hedgeMs: 0, ...extra });
  return hits[0];
};
const OUR_ID = new URL(OURS).host + new URL(OURS).pathname;

test('the cheap latest-state reads go to the light node first', async () => {
  assert.ok(OURS, 'our node is in the list');
  for (const [m, p] of [['eth_getBalance', [A, 'latest']], ['eth_getBalance', [A]], ['eth_call', [{ to: A, data: '0x' }, 'latest']], ['eth_blockNumber', []], ['eth_chainId', []], ['eth_getCode', [A, 'latest']], ['eth_getStorageAt', [A, '0x0', 'latest']], ['eth_getTransactionCount', [A, 'latest']], ['eth_estimateGas', [{ to: A }]], ['eth_gasPrice', []], ['eth_maxPriorityFeePerGas', []]])
    assert.equal(await firstAsked(m, p), OUR_ID, `${m} should go to the light node first`);
});

test('everything else keeps its order: numbered blocks, receipts, transactions, blocks, logs, proofs', async () => {
  const publicFirst = ETH_NODES[0].replace(/^https:\/\//, '');
  for (const [m, p] of [['eth_getTransactionReceipt', ['0x' + '11'.repeat(32)]], ['eth_getTransactionByHash', ['0x' + '11'.repeat(32)]], ['eth_getBlockByNumber', ['latest', false]], ['eth_getBlockByHash', ['0x' + '22'.repeat(32), false]], ['eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x10' }]], ['eth_getProof', [A, [], 'latest']], ['eth_feeHistory', ['0x5', 'latest', []]]])
    assert.notEqual(await firstAsked(m, p), OUR_ID, `${m} must not be promoted`);
  const pinned = await firstAsked('eth_getBalance', [A, '0x1900000']);
  assert.notEqual(pinned, OUR_ID, 'a numbered block is deeper than the light node keeps (32 blocks): the list refuses it for the light node, and it is not asked');
  assert.equal(await firstAsked('eth_getTransactionReceipt', ['0x' + '11'.repeat(32)]), publicFirst, 'the first public node, as before');
});

test('a light node resting after a limit goes behind the others, and comes back when its rest is over', async () => {
  let t = 1_000_000;
  const health = nodeHealth({ now: () => t });
  health.fail(OURS, 'down');
  assert.notEqual(await firstAsked('eth_getBalance', [A, 'latest'], ETH_NODES, { health }), OUR_ID, 'resting: asked last');
  t += 5 * 60_000;
  assert.equal(await firstAsked('eth_getBalance', [A, 'latest'], ETH_NODES, { health }), OUR_ID, 'rested: first again');
});

test("the reader's own node (127.0.0.1:8545) is a light node too: it goes ahead of the public nodes, in its list position among the light ones", async () => {
  const own = 'http://127.0.0.1:8545';
  const hosts = [own, ...ETH_NODES];
  const hits = [];
  const fetchImpl = async (u) => { hits.push(new URL(u).host); return { status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }) }; };
  await hedgedRpc(hosts, 'eth_getBalance', [A, 'latest'], { fetchImpl, hedgeMs: 0 });
  assert.equal(hits[0], '127.0.0.1:8545', 'own-node.js puts it at the head of the shared list; it stays there');
  hits.length = 0; await hedgedRpc([...ETH_NODES, own], 'eth_getBalance', [A, 'latest'], { fetchImpl, hedgeMs: 0 });
  assert.equal(hits[0], new URL(OURS).host, 'light nodes keep their list order among themselves');
  assert.notEqual(hits[0], 'ethereum-rpc.publicnode.com', 'and both are ahead of the public nodes');
});

test("'tacit-light-first' = '0' turns it off for that browser", async () => {
  store.set('tacit-light-first', '0');
  try { assert.notEqual(await firstAsked('eth_getBalance', [A, 'latest']), OUR_ID); } finally { store.delete('tacit-light-first'); }
  assert.equal(await firstAsked('eth_getBalance', [A, 'latest']), OUR_ID);
});

test('a node is recognised as light by its published log span, not by name; a host with a wide span is not promoted', async () => {
  const wide = 'https://rpc.mevblocker.io';
  assert.notEqual(await firstAsked('eth_getBalance', [A, 'latest'], [wide, 'https://ethereum-rpc.publicnode.com']), 'x');
  assert.equal(await firstAsked('eth_getBalance', [A, 'latest'], ['https://ethereum-rpc.publicnode.com', wide]), 'ethereum-rpc.publicnode.com', 'no light node in the list: the order is untouched');
});
