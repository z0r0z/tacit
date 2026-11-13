// The pool module's Ethereum reads (confidential-pool-ux.js rpc and its event logs) over the public nodes of eth-nodes.js, with every node stood in
// for: a node that resets the connection is passed over, and rests for the next page of the visit; a revert is the contract's answer and ends the
// call at once; a node's own refusal of a send ("insufficient funds") reaches the caller in its words; the connected wallet is asked only once every
// public node has failed, and only for reads; nothing answering says so plainly; a node's widest range of logs is learned, and kept for the next page.
//   node tests/pool-eth-reads.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { ETH_NODES, ETH_LOG_NODES } from '../dapp/eth-nodes.js';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { setActiveNetwork } = await import('../dapp/confidential-deployments.js');
setActiveNetwork('mainnet');
const _cat = (a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (k, ...m) => hmac(nobleSha256, k, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

// A world of nodes: each URL answers by `nodes[url](method, params)` -> result | { error } | 'reset'.
function world(nodes) {
  const asked = [];
  const fetchImpl = async (url, opts) => {
    const { method, params } = JSON.parse(opts.body);
    asked.push([url, method]);
    const f = nodes[url];
    const out = f ? await f(method, params) : 'reset';
    if (out === 'reset') throw new TypeError('Failed to fetch');
    const body = out && out.error ? { jsonrpc: '2.0', id: 1, error: out.error } : { jsonrpc: '2.0', id: 1, result: out };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { asked, ux: () => makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'mainnet', fetchImpl, logStore: null }),
    uxWith: (extra) => makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'mainnet', fetchImpl, logStore: null, ...extra }) };
}
const only = (host, f) => Object.fromEntries(ETH_NODES.map((u) => [u, u === host ? f : () => 'reset']));

test('a node that resets is passed over, and rests for the next page: it is asked last there', async () => {
  mem.clear();
  const w = world({ ...only(ETH_NODES[1], () => '0x10') });
  assert.equal(await w.ux().rpc('eth_blockNumber', []), '0x10');
  assert.equal(w.asked[0][0], ETH_NODES[0], 'the first node is asked first');
  const w2 = world({ ...only(ETH_NODES[1], () => '0x11') });
  assert.equal(await w2.ux().rpc('eth_blockNumber', []), '0x11');
  assert.equal(w2.asked[0][0], ETH_NODES[1], 'a new page of the visit starts from the node that answered');
});

test('a revert ends the call at once; a node\'s refusal of a send reaches the caller in its words', async () => {
  mem.clear();
  const w = world(Object.fromEntries(ETH_NODES.map((u) => [u, () => ({ error: { code: 3, message: 'execution reverted' } })])));
  await assert.rejects(() => w.ux().rpc('eth_call', [{ to: '0x' + '11'.repeat(20), data: '0x' }, 'latest']), /execution reverted/);
  assert.equal(w.asked.length, 1, 'one node asked: the contract answered');
  mem.clear();
  const w2 = world(Object.fromEntries(ETH_NODES.map((u) => [u, () => ({ error: { code: -32000, message: 'insufficient funds for gas * price + value' } })])));
  await assert.rejects(() => w2.ux().rpc('eth_sendRawTransaction', ['0x01']), (e) => /insufficient funds/.test(e.message) && e.kind === 'rpc');
});

test('the connected wallet is asked once every public node has failed, for reads only; with none, the page is told plainly', async () => {
  mem.clear();
  const w = world({});
  const ux = w.ux();
  const asked = [];
  ux.useWallet(() => ({ request: async ({ method }) => { asked.push(method); return '0x2a'; } }));
  assert.equal(await ux.rpc('eth_blockNumber', []), '0x2a');
  assert.deepEqual(asked, ['eth_blockNumber']);
  assert.ok(w.asked.length >= ETH_NODES.length, 'every public node was asked first');
  await assert.rejects(() => ux.rpc('eth_sendRawTransaction', ['0x01']), (e) => e.unreachable === true && /public nodes did not answer/.test(e.message));
  assert.deepEqual(asked, ['eth_blockNumber'], 'a send never goes through the wallet\'s node');
  ux.useWallet(() => ({ isWalletConnect: true, request: async () => '0x1' }));
  await assert.rejects(() => ux.rpc('eth_blockNumber', []), (e) => e.unreachable === true, 'nor a read through WalletConnect');
});

test('two readers in a page (the same module loaded twice) ask the nodes for a range of logs once', async () => {
  mem.clear();
  const head = 30_000_000;
  const w = world({ [ETH_NODES[0]]: () => 'reset', ...Object.fromEntries(ETH_LOG_NODES.map((u) => [u, (method, params) => {
    if (method === 'eth_blockNumber') return '0x' + head.toString(16);
    if (method === 'eth_getLogs') return [];
    return '0x0';
  }])) });
  const a = w.ux(), b = w.ux();
  const ask = (ux) => ux.fetchEvents({ fromBlock: head - 120_000, toBlock: head });
  await Promise.all([ask(a), ask(b)]);
  const logCalls = w.asked.filter(([, m]) => m === 'eth_getLogs');
  assert.equal(logCalls.length, 3, 'a hundred and twenty thousand blocks in three ranges, each asked once though two readers wanted it');
  // asked again soon after: each reader re-reads only the last blocks, which are not final yet, and the two share that one read
  await Promise.all([ask(a), ask(b)]);
  assert.equal(w.asked.filter(([, m]) => m === 'eth_getLogs').length, 4, 'one more read, for both');
});

test('a node with a quota of its own is asked for logs before the key every visitor shares', async () => {
  mem.clear();
  const head = 30_000_000;
  const w = world(Object.fromEntries(ETH_LOG_NODES.map((u) => [u, (method) => (method === 'eth_blockNumber' ? '0x' + head.toString(16) : method === 'eth_getLogs' ? [] : '0x0')])));
  await w.ux().fetchEvents({ fromBlock: head - 30_000, toBlock: head });
  const first = w.asked.find(([, m]) => m === 'eth_getLogs')[0];
  assert.ok(!first.includes('nodereal'), 'the shared key was not the first asked: ' + first);
  assert.ok(w.asked.filter(([u, m]) => m === 'eth_getLogs' && u.includes('nodereal')).length === 0, 'and not asked at all while another served it');
});

test('log nodes are tried wide first, and among the wide ones the shared key after the rest; the nodes of a few blocks come last of all', async () => {
  mem.clear();
  const head = 30_000_000, order = [];
  const w = world(Object.fromEntries(ETH_LOG_NODES.map((u) => [u, (method) => {
    if (method === 'eth_blockNumber') return '0x' + head.toString(16);
    if (method === 'eth_getLogs') { order.push(u); return { error: { code: -32000, message: 'service temporarily unavailable' } }; }
    return '0x0';
  }])));
  await w.ux().fetchEvents({ fromBlock: head - 3_000, toBlock: head }).catch(() => {});
  const seen = [...new Set(order)];
  const at = (frag) => seen.findIndex((u) => u.includes(frag));
  assert.ok(at('rpc.mevblocker.io') >= 0 && at('nodereal') >= 0 && at('stakely') >= 0, 'every node was tried: ' + seen.join(' '));
  assert.ok(at('rpc.mevblocker.io') < at('nodereal'), 'a node with a quota of its own before the shared key');
  assert.ok(at('nodereal') < at('stakely') && at('nodereal') < at('1rpc.io'), 'the shared key (wide) before the nodes of 25 and 50 blocks');
});

test('a node that is certain to refuse a range is not asked, and one whose quota is used up is not asked again during its rest', async () => {
  mem.clear();
  const head = 30_000_000, asked = {};
  const w = world(Object.fromEntries(ETH_LOG_NODES.map((u) => [u, (method) => {
    if (method === 'eth_blockNumber') return '0x' + head.toString(16);
    if (method !== 'eth_getLogs') return '0x0';
    asked[u] = (asked[u] || 0) + 1;
    return u.includes('nodereal') ? { error: { code: -32005, message: 'You have reached the maximum API usage limit of public. If you need more, upgrade' } } : { error: { code: -32000, message: 'service temporarily unavailable' } };
  }])));
  const ux = w.ux();
  // a range far behind the head: publicnode keeps recent blocks only and says so with a 403, which is known
  await ux.fetchEvents({ fromBlock: head - 400_000, toBlock: head - 380_000 }).catch(() => {});
  assert.equal(asked['https://ethereum-rpc.publicnode.com'], undefined, 'publicnode was not asked for blocks it does not serve');
  const nodereal = Object.keys(asked).find((u) => u.includes('nodereal'));
  assert.equal(asked[nodereal], 1, 'nodereal was asked once, said its quota was used up, and was not asked again');
  await ux.fetchEvents({ fromBlock: head - 370_000, toBlock: head - 360_000 }).catch(() => {});
  assert.equal(asked[nodereal], 1, 'nor for the next range, while it rests');
});

test('the connected wallet serves a log read of the pool\'s own events when every public node has failed, and never one that names an address', async () => {
  mem.clear();
  const head = 30_000_000, bad = Object.fromEntries(ETH_LOG_NODES.map((u) => [u, (method) => (method === 'eth_blockNumber' ? '0x' + head.toString(16) : 'reset')]));
  // the pool's events by kind: nothing in the filter says whose key is reading
  const w = world(bad), ux = w.ux(), seen = [];
  ux.useWallet(() => ({ request: async ({ method, params }) => { seen.push([method, JSON.stringify(params[0].topics || [])]); return []; } }));
  const events = await ux.fetchEvents({ fromBlock: head - 8_000, toBlock: head });
  assert.ok(Array.isArray(events));
  assert.ok(seen.length > 0 && seen.every(([m]) => m === 'eth_getLogs'), 'the wallet was asked, for logs only: ' + JSON.stringify(seen));
  assert.ok(w.asked.filter(([, m]) => m === 'eth_getLogs').length >= ETH_LOG_NODES.length - 1, 'every public node was tried first');
  // a filter on an address (an account derived from the Tacit key) is never sent to the wallet's provider, which would learn whose account it is:
  // cbtcBonds reads the engine's postings for the key's own accounts
  const nodes3 = { ...bad };
  const w2 = world(nodes3), ux2 = w2.ux(), seen2 = [];
  ux2.useWallet(() => ({ request: async ({ method, params }) => { seen2.push([method, JSON.stringify(params[0].topics || null)]); return method === 'eth_blockNumber' ? '0x' + head.toString(16) : []; } }));
  await assert.rejects(() => ux2.cbtcBonds('0x' + '07'.repeat(32), { btcHistory: { lockOutputs: [] } }), /./, 'with every public node down the read fails rather than going to the wallet');
  assert.deepEqual(seen2.filter(([m]) => m === 'eth_getLogs'), [], 'the wallet was never asked for logs that name an account');
  assert.ok(w2.asked.some(([, m]) => m === 'eth_getLogs'), 'the public nodes were tried');
});

test('a node\'s widest range of logs is learned from its refusal and kept for the next page', async () => {
  mem.clear();
  const head = 30_000_000;
  const logNode = (cap) => (method, params) => {
    if (method === 'eth_blockNumber') return '0x' + head.toString(16);
    if (method !== 'eth_getLogs') return '0x0';
    const span = parseInt(params[0].toBlock, 16) - parseInt(params[0].fromBlock, 16) + 1;
    return span > cap ? { error: { code: -32005, message: `exceed maximum block range: ${cap}` } } : [];
  };
  const nodes = { ...Object.fromEntries([...ETH_NODES, ...ETH_LOG_NODES].map((u) => [u, () => 'reset'])), [ETH_LOG_NODES[1]]: logNode(20000), [ETH_NODES[0]]: (m) => (m === 'eth_blockNumber' ? '0x' + head.toString(16) : 'reset') };
  const w = world(nodes);
  await w.ux().fetchEvents({ fromBlock: head - 99_999, toBlock: head });
  const kept = Object.entries(JSON.parse(mem.get('tacit-pool-rpc-span-v1:1') || '{}'));
  assert.deepEqual(kept, [[ETH_LOG_NODES[1], 20000]], 'the range it serves is kept');
  const w2 = world(nodes);
  await w2.ux().fetchEvents({ fromBlock: head - 99_999, toBlock: head });
  const spans = w2.asked.filter(([u, m]) => u === ETH_LOG_NODES[1] && m === 'eth_getLogs');
  assert.equal(spans.length, 5, 'the next page asks in ranges it serves, with no refusal first');
});

// The Wrap scan of one asset (nextWrapIndex) reads the pool's whole history of that asset's deposits through the log nodes. The wide nodes fail in
// patches (mevblocker "service temporarily unavailable", the shared key's quota, BuidlGuidl's per-origin quota), and the nodes of 25 and 50 blocks
// cannot carry it: they answered last, and their word ("method not available") was what the card showed.
const DEPLOY = 25_998_736, TAC_KEY = '0x' + '11'.repeat(32);
const NARROW = (u) => u.includes('stakely') || u.includes('1rpc.io');
const range = (p) => [parseInt(p[0].fromBlock, 16), parseInt(p[0].toBlock, 16)];

test('a wrap scan that fails says what the wide nodes said, not what a node of a few blocks said last', async () => {
  mem.clear();
  const head = DEPLOY + 100_000;
  const w = world(Object.fromEntries(ETH_LOG_NODES.map((u) => [u, (method) => (method === 'eth_blockNumber' ? '0x' + head.toString(16)
    : method === 'eth_getLogs' ? { error: { code: -32000, message: NARROW(u) ? 'method not available' : 'service temporarily unavailable' } } : '0x0')])));
  await assert.rejects(() => w.ux().nextWrapIndex({ walletPriv: TAC_KEY, ticker: 'TAC' }),
    (e) => /could not read this asset's wrap deposits \(service temporarily unavailable\).*pass an explicit index/.test(e.message), 'the wide nodes\' word, in the same shape');
});

test('a wrap scan that meets a bad patch of the nodes tries again by itself, and a later try picks up where the last stopped', async () => {
  mem.clear();
  const head = DEPLOY + 100_000, realNow = Date.now;
  let failing = 12, outage = false;
  const asks = [];
  const mk = () => world(Object.fromEntries(ETH_LOG_NODES.map((u) => [u, (method, params) => {
    if (method === 'eth_blockNumber') return '0x' + head.toString(16);
    if (method !== 'eth_getLogs') return '0x0';
    const [from, to] = range(params);
    asks.push([u, from, to]);
    if (failing > 0) { failing--; return { error: { code: -32000, message: 'service temporarily unavailable' } }; }
    if (outage && to >= DEPLOY + 60_000) return { error: { code: -32000, message: NARROW(u) ? 'method not available' : 'service temporarily unavailable' } };
    return [];
  }])));
  try {
    assert.equal(await mk().ux().nextWrapIndex({ walletPriv: TAC_KEY, ticker: 'TAC' }), 0, 'the first requests failed and the scan still came back');
    // a scan that is read part-way, with the rest down: the first range is read, then the nodes fail
    mem.clear(); asks.length = 0; outage = true; failing = 0;
    const ux = mk().ux();
    await assert.rejects(() => ux.nextWrapIndex({ walletPriv: TAC_KEY, ticker: 'TAC' }), /could not read this asset's wrap deposits/);
    assert.ok(asks.some(([, from]) => from === DEPLOY), 'the first range was read');
    // the nodes come back a minute later: the ranges already read are not read again
    outage = false; asks.length = 0;
    Date.now = () => realNow() + 60_000;
    assert.equal(await ux.nextWrapIndex({ walletPriv: TAC_KEY, ticker: 'TAC' }), 0);
    assert.ok(asks.length > 0, 'the rest was read');
    assert.equal(asks.filter(([, from]) => from === DEPLOY).length, 0, 'the range already read was not read again');
  } finally { Date.now = realNow; }
});

// The wallet's own pass of the pool (fetchEvents: every event of the pool in one query, from its deploy block) already holds every Wrap log. A read of one
// asset's deposits for the next wrap index takes what that pass finished and asks the nodes only for the blocks after it.
const WRAP_T = '0x' + Buffer.from(keccak_256(new TextEncoder().encode('Wrap(bytes32,bytes32,uint256)'))).toString('hex');
const POOL_A = '0x000000000Ed1eabD231Be41d93b719056F7febFC'.toLowerCase();
const wrapLogAt = (built, asset, block) => ({ address: POOL_A, topics: [WRAP_T, built.depositId, asset], data: '0x' + BigInt(built.amount).toString(16).padStart(64, '0'), blockNumber: '0x' + block.toString(16), logIndex: '0x0', transactionHash: '0x' + 'ab'.repeat(32) });
function wrapWorld(head, logs, asks) {
  return world(Object.fromEntries(ETH_LOG_NODES.map((u) => [u, (method, params) => {
    if (method === 'eth_blockNumber') return '0x' + head.toString(16);
    if (method !== 'eth_getLogs') return '0x0';
    const [from, to] = range(params);
    asks.push([u, from, to]);
    const [t0, , asset] = params[0].topics;
    if (!(Array.isArray(t0) ? t0.includes(WRAP_T) : t0 === WRAP_T)) return [];
    return logs.filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= from && b <= to && (!asset || l.topics[2] === asset); });
  }])));
}
function twoWraps(head) {
  const ux0 = world({}).ux(), asset = ux0.assetByTicker.TAC.assetId.toLowerCase();
  const first = ux0.buildWrap({ walletPriv: TAC_KEY, amountWei: (5n * 10n ** 18n).toString(), ticker: 'TAC', index: 0 });
  const second = ux0.buildWrap({ walletPriv: TAC_KEY, amountWei: (7n * 10n ** 18n).toString(), ticker: 'TAC', index: 1 });
  // index 0 long ago (inside what the wallet's pass finished), index 1 a few blocks ago (inside the last blocks, which it does not call final)
  return [wrapLogAt(first, asset, DEPLOY + 10), wrapLogAt(second, asset, head - 10)];
}

test('a wrap read after the wallet\'s own pass of the pool asks only for the blocks after it, and still finds every deposit', async () => {
  mem.clear();
  const head = DEPLOY + 200_000, asks = [];
  const ux = wrapWorld(head, twoWraps(head), asks).ux();
  await ux.fetchEvents({ include: ['wraps'] });
  assert.ok(asks.some(([, from]) => from === DEPLOY), 'the wallet\'s pass read the history');
  asks.length = 0;
  assert.equal(await ux.nextWrapIndex({ walletPriv: TAC_KEY, ticker: 'TAC' }), 2, 'index 0 (read by the pass) and index 1 (in the newest blocks) are both taken');
  assert.ok(asks.length >= 1 && asks.every(([, from]) => from > head - 500), 'only recent blocks were asked for: ' + JSON.stringify(asks.slice(0, 3)));
});

test('a wrap read with no pass of the pool behind it, or one that began later than the deploy block, reads the whole history of the asset', async () => {
  mem.clear();
  const head = DEPLOY + 200_000, asks = [];
  const logs = twoWraps(head);
  assert.equal(await wrapWorld(head, logs, asks).ux().nextWrapIndex({ walletPriv: TAC_KEY, ticker: 'TAC' }), 2);
  assert.ok(asks.some(([, from]) => from === DEPLOY), 'no pass: from the deploy block');
  mem.clear(); asks.length = 0; // the first call kept its index as a hint for the next one
  const ux = wrapWorld(head, logs, asks).ux();
  await ux.fetchEvents({ fromBlock: head - 1000, include: ['wraps'] });
  asks.length = 0;
  assert.equal(await ux.nextWrapIndex({ walletPriv: TAC_KEY, ticker: 'TAC' }), 2, 'a pass of the last 1,000 blocks does not stand for the history');
  assert.ok(asks.some(([, from]) => from === DEPLOY), 'so the history is read from the deploy block');
});

test('the newest blocks of the wallet\'s pass are asked for again: a deposit that a reorg took out of them does not count', async () => {
  mem.clear();
  const head = DEPLOY + 200_000, asks = [], logs = twoWraps(head);
  const ux = wrapWorld(head, logs, asks).ux();
  await ux.fetchEvents({ include: ['wraps'] });
  logs.pop(); // index 1's deposit was in the last blocks of the pass, and is gone from the chain now
  assert.equal(await ux.nextWrapIndex({ walletPriv: TAC_KEY, ticker: 'TAC' }), 1, 'index 1 is free again');
});

test('a record kept in the browser counts only once its own pass has finished; until then the history is read from the nodes', async () => {
  mem.clear();
  const head = DEPLOY + 200_000, asks = [], logs = twoWraps(head);
  // the browser kept a pass up to head - 100 (index 0's deposit inside it); this page's pass is under way, asking the nodes for the blocks since
  const record = { v: 1, finalTo: head - 100, logs: [logs[0]] };
  let release; const gate = new Promise((r) => { release = r; });
  const w = world(Object.fromEntries(ETH_LOG_NODES.map((u) => [u, async (method, params) => {
    if (method === 'eth_blockNumber') return '0x' + head.toString(16);
    if (method !== 'eth_getLogs') return '0x0';
    const [from, to] = range(params), [t0, , asset] = params[0].topics;
    asks.push([u, from, to, Array.isArray(t0) ? 'all' : 'asset']);
    if (Array.isArray(t0)) await gate;
    return logs.filter((l) => { const b = parseInt(l.blockNumber, 16); return b >= from && b <= to && (!asset || l.topics[2] === asset); });
  }])));
  const ux = w.uxWith({ logStore: { get: async (key) => (key.includes('|[[') ? record : null), put: async () => {}, del: async () => {} } }); // the record is the pass of every event (its topics are one list)
  const pass = ux.fetchEvents({ include: ['wraps'] });
  await new Promise((r) => setTimeout(r, 50));
  const idx = await ux.nextWrapIndex({ walletPriv: TAC_KEY, ticker: 'TAC' });
  assert.equal(idx, 2);
  assert.ok(asks.some(([, from, , kind]) => kind === 'asset' && from === DEPLOY), 'the asset\'s deposits were read from the deploy block: ' + JSON.stringify(asks.filter((a) => a[3] === 'asset').slice(0, 2)));
  release(); await pass;
});
