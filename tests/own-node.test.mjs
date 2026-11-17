// dapp/own-node.js: the reader's own node (127.0.0.1:8545) in the one list of Ethereum nodes. What the check says of a node that is down, on another chain, behind or in step; that turning it
// on puts it first in eth-nodes.js ETH_NODES in place and off takes it out; that a node that is down or behind when the page loads (or later) is taken out and the setting stays on; that wide
// log ranges and numbered-block state reads are not sent to it; and, through the real hedgedRpc, that reads go to it alone while it answers and to the public nodes when it does not.
//
// Run: node --test tests/own-node.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const store = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m }; };
const { ETH_NODES, refuses } = await import('../dapp/eth-nodes.js');
const { hedgedRpc } = await import('../dapp/trade/rpc.js');
const PUBLIC = [...ETH_NODES];
const load = async (init, fetchImpl = async () => { throw new TypeError('Failed to fetch'); }) => {
  Object.defineProperty(globalThis, 'localStorage', { value: store(init), configurable: true, writable: true });
  globalThis.fetch = fetchImpl;
  return import('../dapp/own-node.js?t=' + Math.random());
};
const reply = (result) => ({ json: async () => ({ jsonrpc: '2.0', id: 1, result }), status: 200 });
const node = ({ chain = '0x1', block = 1000 } = {}) => async (_u, init) => { const { method } = JSON.parse(init.body); return reply(method === 'eth_chainId' ? chain : '0x' + block.toString(16)); };
const settle = async (ok) => { for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); };
const clean = (m) => { m.disableOwnNode(); assert.deepEqual(ETH_NODES, PUBLIC, 'the list is back to the public nodes'); };

test('the check names a node that is down, on another chain, behind, or in step', async () => {
  const m = await load();
  const down = await m.checkOwnNode({ call: async () => { throw Object.assign(new Error('Failed to fetch'), { unreachable: true }); }, head: async () => 1000 });
  assert.equal(down.ok, false); assert.equal(down.up, false); assert.equal(down.unreachable, true);
  assert.match(m.ownNodeSay(down), /Nothing answered at 127\.0\.0\.1:8545.*CORS/);

  const said = await m.checkOwnNode({ call: async () => { throw new Error('method not found'); }, head: async () => 1000 });
  assert.equal(said.unreachable, false);
  assert.match(m.ownNodeSay(said), /said: method not found/);

  const other = await m.checkOwnNode({ call: async (method) => (method === 'eth_chainId' ? '0xaa36a7' : '0x10'), head: async () => 16 });
  assert.equal(other.ok, false); assert.equal(other.chain, 11155111);
  assert.match(m.ownNodeSay(other), /chain 11155111, not Ethereum/);

  const behind = await m.checkOwnNode({ call: async (method) => (method === 'eth_chainId' ? '0x1' : '0x384'), head: async () => 1000 });
  assert.equal(behind.ok, false); assert.equal(behind.behind, 100);
  assert.match(m.ownNodeSay(behind), /100 blocks behind Ethereum \(at block 900\)/);

  const step = await m.checkOwnNode({ call: async (method) => (method === 'eth_chainId' ? '0x1' : '0x3e6'), head: async () => 1000 });
  assert.equal(step.ok, true); assert.equal(step.behind, 2);
  assert.equal(m.ownNodeSay(step), 'Answering at block 998, 2 behind the public nodes.');

  const six = await m.checkOwnNode({ call: async (method) => (method === 'eth_chainId' ? '0x1' : '0x3e8'), head: async () => 1006 });
  const seven = await m.checkOwnNode({ call: async (method) => (method === 'eth_chainId' ? '0x1' : '0x3e8'), head: async () => 1007 });
  assert.deepEqual([six.ok, seven.ok], [true, false], 'six blocks behind is in step, seven is not');

  const blind = await m.checkOwnNode({ call: async (method) => (method === 'eth_chainId' ? '0x1' : '0x3e8'), head: async () => { throw new Error('no public node'); } });
  assert.equal(blind.ok, true); assert.equal(blind.behind, null);
  assert.equal(m.ownNodeSay(blind), 'Answering at block 1,000.');
});

test('turning it on puts it first in the list, in place; turning it off takes it out; a refused node changes nothing', async () => {
  const m = await load();
  const list = ETH_NODES;
  const refused = await m.enableOwnNode({ call: async () => { throw Object.assign(new Error('nope'), { unreachable: true }); }, head: async () => 1000 });
  assert.equal(refused.ok, false);
  assert.equal(m.ownNodeOn(), false); assert.deepEqual(ETH_NODES, PUBLIC);
  assert.equal(globalThis.localStorage.getItem('tacit-own-node-v1'), null, 'a node that was refused is not remembered');

  const r = await m.enableOwnNode({ call: async (method) => (method === 'eth_chainId' ? '0x1' : '0x3e8'), head: async () => 1000 });
  try {
    assert.equal(r.ok, true);
    assert.equal(ETH_NODES, list, 'the same array, so every module holding it sees the change');
    assert.equal(ETH_NODES[0], m.OWN_NODE); assert.equal(ETH_NODES.length, PUBLIC.length + 1);
    assert.equal(m.ownNodeOn(), true); assert.equal(m.ownNodeUsed(), true);
    assert.equal(globalThis.localStorage.getItem('tacit-own-node-v1'), '1');
    await m.enableOwnNode({ call: async (method) => (method === 'eth_chainId' ? '0x1' : '0x3e8'), head: async () => 1000 });
    assert.equal(ETH_NODES.filter((u) => u === m.OWN_NODE).length, 1, 'turned on twice, in the list once');
  } finally { m.disableOwnNode(); }
  assert.deepEqual(ETH_NODES, PUBLIC); assert.equal(m.ownNodeOn(), false);
  assert.equal(globalThis.localStorage.getItem('tacit-own-node-v1'), '0');
});

test('a stored choice is in the list from the first read; a node that is down or behind is taken out and the choice stays', async () => {
  let m = await load({ 'tacit-own-node-v1': '1' }, node({ block: 1000 }));
  try {
    assert.equal(m.ownNodeOn(), true); assert.equal(ETH_NODES[0], m.OWN_NODE, 'in the list before the first check has answered');
    // the check at load reads the public head through hedgedRpc, whose fetch here is the same stub (head 1000, the node's own block): in step
    await settle(() => m.ownNodeLast());
    assert.equal(m.ownNodeLast().ok, true);
    assert.equal(m.ownNodeUsed(), true);
  } finally { clean(m); }

  m = await load({ 'tacit-own-node-v1': '1' });
  try {
    assert.equal(m.ownNodeOn(), true);
    await settle(() => !m.ownNodeUsed());
    assert.equal(m.ownNodeUsed(), false, 'a node that does not answer is taken out');
    assert.equal(m.ownNodeOn(), true, 'the setting stays on');
    assert.equal(globalThis.localStorage.getItem('tacit-own-node-v1'), '1');
  } finally { clean(m); }

  // 40 blocks behind the public nodes: out as well
  m = await load({ 'tacit-own-node-v1': '1' }, async (url, init) => { const { method } = JSON.parse(init.body); return reply(method === 'eth_chainId' ? '0x1' : url === 'http://127.0.0.1:8545' ? '0x3e8' : '0x410'); });
  try {
    await settle(() => m.ownNodeLast());
    assert.equal(m.ownNodeLast().behind, 40); assert.equal(m.ownNodeUsed(), false, 'a node 40 blocks behind is taken out');
  } finally { clean(m); }

  m = await load({ 'tacit-own-node-v1': '0' });
  assert.equal(m.ownNodeOn(), false); assert.deepEqual(ETH_NODES, PUBLIC);
});

test('nothing reaches for 127.0.0.1 until it is turned on', async () => {
  let asked = 0;
  const m = await load({}, async () => { asked++; throw new TypeError('x'); });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(asked, 0); assert.equal(m.ownNodeOn(), false); assert.deepEqual(ETH_NODES, PUBLIC);
});

test('wide log ranges and numbered-block state reads are not sent to it', async () => {
  const own = 'http://127.0.0.1:8545';
  const range = (n) => [{ fromBlock: '0x100', toBlock: '0x' + (0x100 + n - 1).toString(16) }];
  assert.equal(refuses(own, 'eth_getLogs', range(512)), false, '512 blocks it serves');
  assert.equal(refuses(own, 'eth_getLogs', range(513)), true, '513 it does not');
  assert.equal(refuses(own, 'eth_call', [{ to: '0x' + '11'.repeat(20) }, 'latest']), false);
  assert.equal(refuses(own, 'eth_call', [{ to: '0x' + '11'.repeat(20) }, '0x1000']), true, 'old state it does not');
});

test('reads go to it alone while it answers, and to the public nodes when it does not', async () => {
  const m = await load();
  await m.enableOwnNode({ call: async (method) => (method === 'eth_chainId' ? '0x1' : '0x3e8'), head: async () => 1000 });
  try {
    const hit = [];
    const up = async (url, init) => { hit.push(new URL(url).host); return reply('0x2a'); };
    for (let i = 0; i < 4; i++) assert.equal(await hedgedRpc(ETH_NODES, 'eth_getBalance', ['0x' + '22'.repeat(20), 'latest'], { fetchImpl: up, hedgeMs: 50 }), '0x2a');
    assert.deepEqual([...new Set(hit)], ['127.0.0.1:8545'], 'only the own node was asked');

    hit.length = 0;
    const down = async (url) => { hit.push(new URL(url).host); if (url === m.OWN_NODE) throw new TypeError('Failed to fetch'); return reply('0x2b'); };
    assert.equal(await hedgedRpc(ETH_NODES, 'eth_getBalance', ['0x' + '22'.repeat(20), 'latest'], { fetchImpl: down, hedgeMs: 50 }), '0x2b');
    assert.equal(hit[0], '127.0.0.1:8545'); assert.notEqual(hit[1], '127.0.0.1:8545'); assert.equal(hit.length, 2, 'asked first, then one public node answered');

    hit.length = 0;
    await hedgedRpc(ETH_NODES, 'eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2000' }], { fetchImpl: up, hedgeMs: 50 });
    assert.notEqual(hit[0], '127.0.0.1:8545', 'a wide log range goes to a public node first');
  } finally { clean(m); }
});

test('a reader that sticks to the node that answered last starts again at the own node when it joins the list, and leaves it when it goes', async () => {
  const { jsonRpc } = await import('../dapp/json-rpc.js');
  const m = await load();
  const hit = [], who = '0x' + '22'.repeat(20);
  const f = async (url) => { const host = new URL(url).host; hit.push(host); if (host === 'ethereum-rpc.publicnode.com') throw new TypeError('down'); return reply('0x2a'); };
  const rpc = jsonRpc(ETH_NODES, f);
  try {
    await rpc('eth_getBalance', [who, 'latest']);
    hit.length = 0; await rpc('eth_getBalance', [who, 'latest']);
    assert.equal(hit[0], 'rpc.mevblocker.io', 'it sticks to the node that answered last');
    await m.enableOwnNode({ call: async (method) => (method === 'eth_chainId' ? '0x1' : '0x3e8'), head: async () => 1000 });
    hit.length = 0; await rpc('eth_getBalance', [who, 'latest']);
    assert.equal(hit[0], '127.0.0.1:8545', 'with the own node new at the head of the list it starts there');
    hit.length = 0; await rpc('eth_getBalance', [who, 'latest']);
    assert.deepEqual(hit, ['127.0.0.1:8545'], 'and stays there while it answers');
    m.disableOwnNode();
    hit.length = 0; await rpc('eth_getBalance', [who, 'latest']);
    assert.equal(hit[0], 'ethereum-rpc.publicnode.com', 'with it gone it starts at the head of the public list again');
  } finally { clean(m); }
});
