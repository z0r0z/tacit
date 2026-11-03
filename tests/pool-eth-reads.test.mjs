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
  return { asked, ux: () => makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'mainnet', fetchImpl, logStore: null }) };
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
