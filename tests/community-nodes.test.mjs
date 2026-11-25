// How a page uses community nodes: nothing without a pinned key, only a verified list, fee reads as a last resort, public data only, two independent
// groups before a quorum read answers, the browser's switch, and the relay body that names no address.
//   /Users/z/.nvm/versions/node/v22.22.3/bin/node --test tests/community-nodes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { secp, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
import * as L from '../dapp/nodes-list.js';
import { makeCommunity, nodesOnly, TAIL_METHODS, communityTail } from '../dapp/community-nodes.js';
import { hedgedRpc } from '../dapp/trade/rpc.js';

const T = 1_800_000_000;
const priv = (n) => new Uint8Array(32).fill(n);
const pub = (n) => bytesToHex(secp.getPublicKey(priv(n), true));
const node = (i, group, over = {}) => ({ id: i.toString(16).padStart(16, '0'), url: `https://n${i}.example`, kind: 'eth', roles: ['eth-reads'], operator: 'op' + i, group, weight: 0.5, reliability: 0.9, lastOk: T, ...over });
const listOf = (nodes, signer = 9, at = T) => L.signDoc('list', { v: 1, at, until: at + 1500, signer: pub(signer), nodes }, priv(signer));
const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
// a fetch that serves the list and the relay: `answers[id]` is what that node says to a public read
function net(doc, answers = {}) {
  const calls = [];
  const fetchImpl = async (url, o = {}) => {
    calls.push([url, o]);
    if (url.endsWith('/list')) return { ok: true, json: async () => doc };
    const body = JSON.parse(o.body);
    const a = answers[body.node];
    if (a === undefined) return { ok: false, json: async () => ({ error: 'x' }) };
    return { ok: true, json: async () => ({ status: 200, text: body.path ? String(a) : JSON.stringify({ result: a }) }) };
  };
  return { fetchImpl, calls };
}
const make = (n, o = {}) => makeCommunity({ fetchImpl: n.fetchImpl, now: () => T, pubs: [pub(9)], off: () => false, cache: mem(), ...o });

test('with no key pinned nothing is asked and nothing is offered', async () => {
  const n = net(listOf([node(1, 'a')]));
  const c = makeCommunity({ fetchImpl: n.fetchImpl, now: () => T, pubs: [], off: () => false, cache: mem() });
  assert.deepEqual(c.tail('eth_gasPrice', []), []);
  await c.load();
  assert.equal(n.calls.length, 0);
  assert.deepEqual(L.PROBER_PUBS, ['0395b90336f231fa491b9519eed9d06d3e2359ba848fd54c26255dac127dc1f34a'], 'the shipped build pins the prober key');
});

test('a verified list gives fee reads as extra last hosts, one per independent group; nothing else', async () => {
  const n = net(listOf([node(1, 'a'), node(2, 'a', { weight: 0.9 }), node(3, 'b'), node(4, 'c'), node(5, 'd')]), { [node(2, 'a').id]: '0x5' });
  const c = make(n);
  c.tail('eth_gasPrice', []);                 // starts the load
  await c.ready; await c.load();
  const hosts = c.tail('eth_gasPrice', []);
  assert.equal(hosts.length, 3, 'at most three');
  assert.equal(hosts[0].id, 'community/' + node(2, 'a').id, 'the best weight of a group stands for it, best first');
  assert.equal(new Set(hosts.map((h) => h.id)).size, 3);
  assert.equal(await hosts[0].send('eth_gasPrice', [], new AbortController().signal), '0x5');
  const relay = n.calls.find(([u]) => u.endsWith('/relay'));
  assert.deepEqual(JSON.parse(relay[1].body), { node: node(2, 'a').id, method: 'eth_gasPrice', params: [] });
  assert.equal(relay[1].credentials, 'omit');
  for (const [m, p] of [['eth_getBalance', ['0x00000000219ab540356cBB839Cbe05303d7705Fa', 'latest']], ['eth_call', [{}, 'latest']], ['eth_getLogs', [{}]], ['eth_getTransactionReceipt', ['0x' + '1'.repeat(64)]], ['eth_blockNumber', []], ['eth_sendRawTransaction', ['0x00']], ['eth_getTransactionCount', ['0x0', 'latest']]]) assert.deepEqual(c.tail(m, p), [], m);
  assert.ok(!TAIL_METHODS.has('eth_getBalance') && !TAIL_METHODS.has('eth_getLogs') && !TAIL_METHODS.has('eth_call'));
});

test('a list that does not verify is ignored and the built-ins stand alone; a poisoned cache too', async () => {
  const good = listOf([node(1, 'a')]);
  for (const bad of [{ ...good, nodes: [node(1, 'a', { url: 'https://evil.example' })] }, listOf([node(1, 'a')], 8), listOf([node(1, 'a')], 9, T - 5000), { v: 1 }, 'x']) {
    const c = make(net(bad));
    await c.load();
    assert.deepEqual(c.nodes(), []); assert.deepEqual(c.tail('eth_gasPrice', []), []);
  }
  const cache = mem(); cache.setItem('tacit-nodes-list-v1', JSON.stringify({ ...good, nodes: [node(9, 'z')] }));
  { const t = make(net(null), { cache }); await t.ready; assert.deepEqual(t.nodes(), [], 'a tampered cache entry is not believed'); }
  cache.setItem('tacit-nodes-list-v1', JSON.stringify(good));
  { const t = make(net(null), { cache }); await t.ready; assert.equal(t.nodes().length, 1, 'a verified cache entry is'); }
  // a list that fails to verify drops what an earlier good list gave
  let doc = good; const c = makeCommunity({ fetchImpl: async () => ({ ok: true, json: async () => doc }), now: () => { return T + (doc === good ? 0 : 1300); }, pubs: [pub(9)], off: () => false, cache: mem() });
  await c.load(); assert.equal(c.nodes().length, 1);
  doc = { ...good, nodes: [node(1, 'a', { url: 'https://evil.example' })] };
  await c.load(); assert.deepEqual(c.nodes(), []);
});

test('the switch turns community nodes off for this browser', async () => {
  let off = false;
  const n = net(listOf([node(1, 'a'), node(2, 'b')]));
  const c = make(n, { off: () => off });
  await c.load();
  assert.equal(c.tail('eth_gasPrice', []).length, 2);
  off = true;
  assert.deepEqual(c.tail('eth_gasPrice', []), []);
  await assert.rejects(c.quorumRead('eth', 'eth_blockNumber', []), /not enough/);
  const host = (off = false, c.tail('eth_gasPrice', []))[0]; off = true;
  assert.equal(host.usable('eth_gasPrice', []), false, 'even a host already handed out stops being usable');
  const store = mem(); globalThis.localStorage = store;
  try { assert.equal(nodesOnly.get(), false); nodesOnly.set(true); assert.equal(nodesOnly.get(), true); nodesOnly.set(false); assert.equal(nodesOnly.get(), false); } finally { delete globalThis.localStorage; }
});

test('a quorum read needs two independent groups to agree; one operator on two machines is one voter', async () => {
  const mk = (answers, nodes) => make(net(listOf(nodes), answers));
  const a = node(1, 'a'), a2 = node(2, 'a'), b = node(3, 'b'), c3 = node(4, 'c');
  assert.equal(await mk({ [a.id]: '0x10', [b.id]: '0x10', [c3.id]: '0x11' }, [a, b, c3]).quorumRead('eth', 'eth_blockNumber', []), '0x10');
  await assert.rejects(mk({ [a.id]: '0x10', [a2.id]: '0x10' }, [a, a2]).quorumRead('eth', 'eth_blockNumber', []), /not enough independent/);
  await assert.rejects(mk({ [a.id]: '0x10', [b.id]: '0x11' }, [a, b]).quorumRead('eth', 'eth_blockNumber', []), /did not agree/);
  await assert.rejects(mk({ [a.id]: '0x10', [b.id]: '0x11', [c3.id]: '0x12' }, [a, b, c3]).quorumRead('eth', 'eth_blockNumber', []), /did not agree/);
  await assert.rejects(mk({ [a.id]: '0x10' }, [a, b]).quorumRead('eth', 'eth_blockNumber', []), /did not agree/, 'a node that does not answer is not a vote');
  // a liar in one group against two honest groups loses
  assert.equal(await mk({ [a.id]: '0xbad', [a2.id]: '0xbad', [b.id]: '0x10', [c3.id]: '0x10' }, [a, a2, b, c3]).quorumRead('eth', 'eth_blockNumber', []), '0x10');
  // bitcoin
  const x = node(5, 'a', { kind: 'btc' }), y = node(6, 'b', { kind: 'btc' });
  assert.equal(await mk({ [x.id]: '900000', [y.id]: '900000' }, [x, y]).quorumRead('btc', '/blocks/tip/height', []), '900000');
});

test('a quorum read is refused for anything that is not public data, before a request is made', async () => {
  const n = net(listOf([node(1, 'a'), node(2, 'b')]));
  const c = make(n);
  for (const [k, m, p] of [['eth', 'eth_getBalance', ['0x00000000219ab540356cBB839Cbe05303d7705Fa', 'latest']], ['eth', 'eth_call', [{}, 'latest']], ['eth', 'eth_sendRawTransaction', ['0x00']], ['btc', '/address/1Q2TWHE3GMdB6BZKafqwxXtWAWgFt5Jvm3', []], ['btc', '/scripthash/' + 'ab'.repeat(32), []]]) {
    await assert.rejects(c.quorumRead(k, m, p), /not a public-data read/, m);
  }
  assert.equal(n.calls.filter(([u]) => u.endsWith('/relay')).length, 0);
  assert.equal(n.calls.length, 0, 'not even the list was fetched');
});

test('hedgedRpc races built-in hosts first and takes a community host only after them, for fees only', async () => {
  const seen = [];
  const doc = listOf([node(1, 'a'), node(2, 'b')]);
  const n = net(doc, { [node(1, 'a').id]: '0x1', [node(2, 'b').id]: '0x1' });
  const c = make(n);
  await c.load();
  // the same host objects hedgedRpc is given when the page's instance holds a list
  const fetchImpl = async (u) => { seen.push(u); throw new Error('built-in down'); };
  const tail = c.tail('eth_gasPrice', []);
  const r = await hedgedRpc(['https://built-in.example'].concat(tail), 'eth_gasPrice', [], { hedgeMs: 0, fetchImpl, timeoutMs: 500, lastTimeoutMs: 500 });
  assert.equal(r, '0x1');
  assert.equal(seen[0], 'https://built-in.example', 'the built-in host is asked first');
});
