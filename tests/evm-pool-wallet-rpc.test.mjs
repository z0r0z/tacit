// jsonRpc over several nodes, and the wallet's log scan against nodes with different eth_getLogs range limits.
import assert from 'node:assert/strict';
import { jsonRpc, makeEvmPoolWallet, evmPoolKeys, recipientOf, logFailure, sealNote, openNote, paymentKey, sealState, openState, mergePlan, feedStart } from '../dapp/evm-pool-wallet.js';
import { poolAsset } from '../dapp/evm-pool-zk.js';
import { makeEvmPoolZk } from '../dapp/evm-pool-zk.js';
import { receiveKeys, receiveBoxAddress, RECEIVE_FEE_BPS } from '../dapp/evm-pool-gateway.js';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from 'poseidon-lite';
import { keccak_256 } from '@noble/hashes/sha3';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });

// A pool on chain 8453 kept as chain logs and as the keeper feed's events, one transaction a block. Its leaves go into a
// reference tree, whose root at each size is what rootSize answers.
const POOLF = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTERF = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const ASSETF = poolAsset({ chainId: 8453n, pool: POOLF, token: '0x0000000000000000000000000000000000000000' });
const topic = (sig) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex');
const T_TRANSACT = topic('Transact(bytes32,bytes32,bytes32,bytes32,uint256,bytes32,address,int256,address,uint256,bytes,bytes)');
const T_RECEIVED = topic('Received(address,uint256,uint256,uint256,uint256,uint256)');
const w64 = (x) => BigInt.asUintN(256, BigInt(x)).toString(16).padStart(64, '0');
function fakePool() {
  const tree = zk.incTree(), sizeOf = new Map([[tree.root, 0]]), logs = [], events = [];
  let block = 0;
  const pool = {
    logs, events, sizeOf, get tip() { return block; }, set tip(b) { block = b; }, get root() { return tree.root; }, get size() { return tree.size; },
    // The next block's transaction: spends `nf`, inserts the two leaves `out` (or none) with their memos.
    transact({ nf = [0n, 0n], out = null, memo = [null, null] } = {}) {
      block++;
      const firstIndex = tree.size, [o0, o1] = out ?? [0n, 0n], tx = '0x' + w64(block);
      if (out) { tree.append(out.map(BigInt)); sizeOf.set(tree.root, tree.size); }
      const m = memo.map((x) => Buffer.from(x ?? []).toString('hex')), pad = (h) => h + '0'.repeat((64 - (h.length % 64)) % 64);
      const body0 = w64(m[0].length / 2) + pad(m[0]);
      logs.push({ address: POOLF, blockNumber: '0x' + block.toString(16), transactionHash: tx, logIndex: '0x0', topics: [T_TRANSACT, '0x' + w64(nf[0]), '0x' + w64(nf[1])],
        data: '0x' + [o0, o1, firstIndex, 0, 0, 0, 0, 0, 320, 320 + body0.length / 2].map(w64).join('') + body0 + w64(m[1].length / 2) + pad(m[1]) });
      events.push({ kind: 'transact', block, tx, firstIndex, nf0: String(nf[0]), nf1: String(nf[1]), outLeaf0: String(o0), outLeaf1: String(o1), memo0: '0x' + m[0], memo1: '0x' + m[1] });
      return { block, firstIndex, tx };
    },
    // The next block's sweep of receive box `i` of `keys` into a note of `value`: its Transact and the router's Received.
    sweep(keys, i, value, rho = 77n + BigInt(i)) {
      const { npk } = receiveKeys(zk, keys.zkWallet, i), box = receiveBoxAddress(npk, RECEIVE_FEE_BPS, ROUTERF);
      const t = pool.transact({ out: [zk.leafOf(ASSETF, value, npk, rho), 0n] });
      logs.push({ address: ROUTERF, blockNumber: '0x' + t.block.toString(16), transactionHash: t.tx, logIndex: '0x1', topics: [T_RECEIVED, '0x' + w64(BigInt(box)), '0x' + w64(0)],
        data: '0x' + [t.firstIndex, value, rho, 3].map(w64).join('') });
      events.push({ kind: 'received', block: t.block, tx: t.tx, box: box.toLowerCase(), n: '0', index: t.firstIndex, value: String(value), rho: String(rho), fee: '3' });
      return t;
    },
  };
  return pool;
}
// A node over `pool`: eth_getLogs by address and first topic (each one or a list) within the range, every filter kept in
// `seen`; rootSize from the pool's roots; a receipt with the logs of its transaction.
const nodeOf = (pool, seen = []) => async (m, p) => {
  if (m === 'eth_blockNumber') return '0x' + pool.tip.toString(16);
  if (m === 'eth_getLogs') {
    const f = p[0], at = [f.address].flat().map((a) => a.toLowerCase()), t0 = [f.topics?.[0] ?? []].flat().map((t) => t.toLowerCase());
    seen.push(f);
    return pool.logs.filter((l) => at.includes(l.address.toLowerCase()) && (!t0.length || t0.includes(l.topics[0]))
      && Number(l.blockNumber) >= Number(f.fromBlock) && Number(l.blockNumber) <= Number(f.toBlock));
  }
  if (m === 'eth_call') return '0x' + w64(pool.sizeOf.get(BigInt('0x' + p[0].data.slice(-64))) ?? 0);
  if (m === 'eth_getTransactionReceipt') { const l = pool.logs.filter((x) => x.transactionHash === p[0]); return l.length ? { status: '0x1', logs: l } : null; }
  return '0x0';
};
// The keeper's /events over `pool`, `page` blocks at a time.
const feedOf = (pool, page = Infinity) => async (url) => {
  const from = Number(new URL(url).searchParams.get('from')), through = Math.min(pool.tip, from + page - 1);
  return { ok: true, status: 200, headers: new Map(), json: async () => ({ chainId: 8453, pool: POOLF, through, events: pool.events.filter((e) => e.block >= from && e.block <= through) }) };
};

// Fake nodes: `limit` is the widest eth_getLogs range served; `err(range)` shapes the refusal like the real node.
const TIP = 10_000;
function nodes(spec, calls) {
  return async (url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    const node = spec[url];
    calls.push([url, method]);
    const reply = (x) => ({ json: async () => ({ jsonrpc: '2.0', id, ...x }) });
    if (node.down) throw new Error('fetch failed');
    if (method === 'eth_blockNumber') return reply({ result: '0x' + TIP.toString(16) });
    if (method === 'eth_call') return reply({ error: { code: 3, message: 'execution reverted', data: '0x12345678' } });
    if (method === 'eth_getLogs') {
      const range = Number(BigInt(params[0].toBlock) - BigInt(params[0].fromBlock)) + 1;
      if (range > node.limit) return reply({ error: node.err(node.limit) });
      return reply({ result: [] });
    }
    return reply({ result: '0x0' });
  };
}
const SPEC = {
  tenderly: { limit: 1000, err: (l) => ({ code: -32602, message: 'invalid params', data: `Block range too large for public access: maximum ${l} blocks` }) },
  drpc: { limit: 10_000, err: () => ({ code: 35, message: 'ranges over 10000 blocks are not supported on free plan' }) },
  base: { limit: 2000, err: (l) => ({ code: -32614, message: `eth_getLogs is limited to a ${l.toLocaleString('en-US')} range` }) },
};

await check('a node that never answers is given up on after the timeout, and the next one serves', async () => {
  const calls = [];
  const hang = (url, init) => new Promise((res, rej) => { calls.push(url); init.signal?.addEventListener('abort', () => rej(init.signal.reason)); });
  const rpc = jsonRpc(['silent', 'drpc'], (url, init) => (url === 'silent' ? hang(url, init) : nodes(SPEC, calls)(url, init)), { timeoutMs: 50 });
  const t0 = Date.now(), alive = setInterval(() => {}, 1000);   // Node's AbortSignal.timeout timer does not hold the process open
  try { assert.equal(await rpc('eth_blockNumber'), '0x' + TIP.toString(16)); } finally { clearInterval(alive); }
  assert.ok(Date.now() - t0 < 2000, 'failed over within the timeout');
  assert.deepEqual(calls.map((c) => (Array.isArray(c) ? c[0] : c)), ['silent', 'drpc']);
});

await check('any failing node is skipped: a down node, then a range refusal, then one that serves', async () => {
  const calls = [];
  const rpc = jsonRpc(['down', 'tenderly', 'drpc'], nodes({ down: { down: true }, ...SPEC }, calls));
  assert.deepEqual(await rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x1387' }]), []); // 5000 blocks
  assert.deepEqual(calls.map((c) => c[0]), ['down', 'tenderly', 'drpc']);
});

await check('a revert is final at the first node', async () => {
  const calls = [];
  const rpc = jsonRpc(['drpc', 'base'], nodes(SPEC, calls));
  await assert.rejects(rpc('eth_call', [{}, 'latest']), (e) => e.rpc.data === '0x12345678');
  assert.equal(calls.length, 1);
});

await check('when every node refuses, the error carries them all', async () => {
  const rpc = jsonRpc(['tenderly', 'base'], nodes(SPEC, []));
  await assert.rejects(rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x1387' }]), (e) => e.all.length === 2);
});

await check('the scan takes the widest limit a node names (in message or data) and rotates to that node', async () => {
  for (const [urls, want] of [[['tenderly', 'base'], 2000], [['tenderly'], 1000], [['base', 'tenderly'], 2000]]) {
    const calls = [];
    const w = makeEvmPoolWallet({
      zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(7)), prove: null,
      chain: { chainId: 8453, pool: '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc: jsonRpc(urls, nodes(SPEC, calls)), deployBlock: 0, confirmations: 0, logChunk: 5000 },
    });
    await w.sync();
    const served = calls.filter(([u, m]) => m === 'eth_getLogs' && SPEC[u].limit >= want).length;
    // One log stream (the pool's and the router's events together), ceil(10001 / want) chunks served by that node, plus its refusals.
    assert.ok(served >= Math.ceil((TIP + 1) / want) && served < Math.ceil((TIP + 1) / want) + 6, `${urls}: ${served} calls for a ${want}-block step`);
  }
});

await check('a log query failure is read node by node: a named limit narrows, a result cap shrinks, a rate limit waits', async () => {
  const fail = (...msgs) => Object.assign(new Error(msgs[0]), { all: msgs.map((m) => ({ message: m })) });
  const drpcFree = 'ranges over 10000 blocks are not supported on free plan', baseRange = 'eth_getLogs is limited to a 2,000 range';
  assert.deepEqual(logFailure(fail(baseRange, drpcFree), 2_000_000), { step: 10000 });
  assert.deepEqual(logFailure(fail(baseRange, drpcFree), 10000), { step: 2000 });
  assert.deepEqual(logFailure(fail('Block range too large for public access: maximum 1000 blocks'), 2000), { step: 1000 });
  // One node rate-limited beside one that refuses every historical range: wait, never narrow below the working limit.
  assert.deepEqual(logFailure(fail('over rate limit', drpcFree), 2000), { busy: true });
  assert.deepEqual(logFailure(fail('You reached Public endpoint rate limit, please upgrade to paid plan'), 2000), { busy: true });
  assert.deepEqual(logFailure(fail('query returned more than 10000 results'), 2000), { step: 500 });
  assert.equal(logFailure(fail('execution reverted'), 2000), null);
  // A node that refuses every historical range beside one that failed for some other reason: narrow, as before.
  assert.deepEqual(logFailure(fail('upstream request timed out', drpcFree), 5000), { step: 1250 });
  assert.deepEqual(logFailure(fail('Bad Gateway', drpcFree), 5000), { step: 1250 });
});

await check('a scan through a rate-limited node beside one that refuses every range keeps its window', async () => {
  const calls = [];
  let n = 0;
  const spec = { base: { limit: 2000, err: (l) => ({ code: -32614, message: `eth_getLogs is limited to a ${l.toLocaleString('en-US')} range` }) }, drpc: { limit: 0, err: () => ({ code: 35, message: 'ranges over 10000 blocks are not supported on free plan' }) } };
  const inner = nodes(spec, calls);
  const fetchImpl = async (url, init) => {
    const { method, id } = JSON.parse(init.body);
    if (url === 'base' && method === 'eth_getLogs' && ++n % 3 === 0) return { json: async () => ({ jsonrpc: '2.0', id, error: { code: -32016, message: 'over rate limit' } }) };
    return inner(url, init);
  };
  const alive = setInterval(() => {}, 1000);
  try {
    const w = makeEvmPoolWallet({
      zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(8)), prove: null,
      chain: { chainId: 8453, pool: '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc: jsonRpc(['base', 'drpc'], fetchImpl), deployBlock: 0, confirmations: 0, logChunk: 2000 },
    });
    await w.sync();
  } finally { clearInterval(alive); }
  const windows = calls.filter(([u, m]) => u === 'base' && m === 'eth_getLogs').length;
  assert.ok(windows < 3 * Math.ceil((TIP + 1) / 2000) + 6, `${windows} base windows for a 10,001-block stream at 2,000 blocks`);
});

await check('state saved with every leaf and nullifier loads as a tree of unspent notes only', async () => {
  const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(9));
  const asset = poolAsset({ chainId: 8453n, pool: POOL, token: '0x0000000000000000000000000000000000000000' });
  const self = { V: keys.V, A: keys.A, N: keys.N };
  const hex = (b) => '0x' + Buffer.from(b).toString('hex');
  const mine = [5n, 7n].map((v) => { const o = sealNote(zk, { to: self, value: v, asset }); return { ...o, leaf: zk.leafOf(asset, o.v, o.npk, o.rho) }; });
  const leaves = [11n, mine[0].leaf, 13n, 17n, mine[1].leaf, 19n];
  const idx = [1, 4];
  const notes = mine.map((m, k) => { const o = openNote(zk, keys, { memo: m.memo, leaf: m.leaf, asset }); return { index: idx[k], leaf: m.leaf.toString(), v: o.v.toString(), rho: o.rho.toString(), s: hex(o.s), kind: 'memo' }; });
  const k1 = zk.ownedKeys(keys.zkWallet, Buffer.from(notes[1].s.slice(2), 'hex'));
  const spentNf = zk.nullifier(k1.nk, mine[1].leaf, 4).toString();
  const saved = new Map();
  const skey = `tacit-evm-pool-v1:8453:${POOL.toLowerCase()}:${keys.address}`;
  saved.set(skey, JSON.stringify({ block: 100, leaves: leaves.map(String), notes, spent: ['123', spentNf], nextRefund: 1 }));
  const store = { get: (k) => saved.get(k), set: (k, v) => saved.set(k, v) };
  const rpc = async (m) => (m === 'eth_blockNumber' ? '0x64' : []);
  const w = makeEvmPoolWallet({ zk, keys, prove: null, store, chain: { chainId: 8453, pool: POOL, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc, deployBlock: 0, confirmations: 0 } });
  const sum = await w.sync();
  assert.equal(sum.balance, 5n, 'the spent note is dropped');
  assert.equal(sum.leaves, 6);
  const w2 = makeEvmPoolWallet({ zk, keys, prove: null, store: { get: () => JSON.stringify({ block: 100, leaves: leaves.map(String), notes, spent: [spentNf] }), set: (k, v) => saved.set('new', v) }, chain: { chainId: 8453, pool: POOL, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc: async (m) => (m === 'eth_blockNumber' ? '0x6e' : []), deployBlock: 0, confirmations: 0 } });
  await w2.sync();
  const now = JSON.parse(openState(keys.v, saved.get('new')));
  assert.ok(now.tree && !now.leaves && !now.spent, 'saved again as a tree, with no leaves or nullifier list');
  assert.deepEqual(Object.keys(now.tree.tracked), ['1'], 'only the unspent note keeps a path');
  assert.equal(now.tree.root, zk.tree(leaves).root.toString());
});

await check('a note seen spent is kept three days for the holding reward, apart from the balance, and then forgotten', async () => {
  const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(9));
  const asset = poolAsset({ chainId: 8453n, pool: POOL, token: '0x0000000000000000000000000000000000000000' });
  const self = { V: keys.V, A: keys.A, N: keys.N };
  const hex = (b) => '0x' + Buffer.from(b).toString('hex');
  const mine = [5n, 7n].map((v) => { const o = sealNote(zk, { to: self, value: v, asset }); return { ...o, leaf: zk.leafOf(asset, o.v, o.npk, o.rho) }; });
  const leaves = [11n, mine[0].leaf, 13n, 17n, mine[1].leaf, 19n];
  const idx = [1, 4];
  const notes = mine.map((m, k) => { const o = openNote(zk, keys, { memo: m.memo, leaf: m.leaf, asset }); return { index: idx[k], leaf: m.leaf.toString(), v: o.v.toString(), rho: o.rho.toString(), s: hex(o.s), kind: 'memo' }; });
  const k1 = zk.ownedKeys(keys.zkWallet, Buffer.from(notes[1].s.slice(2), 'hex'));
  const nf1 = zk.nullifier(k1.nk, mine[1].leaf, 4);
  const word = (x) => BigInt(x).toString(16).padStart(64, '0');
  // A Transact that spends the second note and inserts nothing (no leaves, so nothing needs a memo).
  const spend = { address: POOL, blockNumber: '0x65', transactionHash: '0x' + 'ab'.repeat(32), logIndex: '0x0',
    topics: ['0x' + Buffer.from(keccak_256(new TextEncoder().encode('Transact(bytes32,bytes32,bytes32,bytes32,uint256,bytes32,address,int256,address,uint256,bytes,bytes)'))).toString('hex'), '0x' + word(nf1), '0x' + word(0)],
    data: '0x' + [0, 0, 6, 0, 0, 0, 0, 0, 0x140, 0x160, 0, 0].map(word).join('') };
  const saved = new Map();
  const skey = `tacit-evm-pool-v1:8453:${POOL.toLowerCase()}:${keys.address}`;
  saved.set(skey, JSON.stringify({ block: 100, leaves: leaves.map(String), notes, nextRefund: 1 }));
  const store = { get: (k) => saved.get(k), set: (k, v) => saved.set(k, v) };
  let spendServed = false;
  const rpc = async (m, params) => {
    if (m === 'eth_blockNumber') return '0x65';
    if (m === 'eth_getLogs') { const t0 = [params[0].topics?.[0]].flat().map((t) => String(t).toLowerCase()); if (t0.includes(spend.topics[0]) && !spendServed) { spendServed = true; return [spend]; } return []; }
    return '0x0';
  };
  const mk = () => makeEvmPoolWallet({ zk, keys, prove: null, store, chain: { chainId: 8453, pool: POOL, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc, deployBlock: 0, confirmations: 0 } });
  const w = mk();
  assert.deepEqual(w.holdingNotes().map((x) => x.index).sort(), [1, 4], 'before the spend, both notes are held');
  const sum = await w.sync();
  assert.equal(spendServed, true, 'the spend was read');
  assert.equal(sum.balance, 5n, 'the balance is what is left');
  assert.deepEqual(w.notes().map((x) => x.index), [1], 'a spend reads only the note still held');
  const held = w.holdingNotes();
  assert.deepEqual(held.map((x) => x.index).sort(), [1, 4], 'the holding round still has the note it spent');
  const gone = held.find((x) => x.index === 4);
  assert.ok(gone.sk && gone.nk && gone.nf === nf1.toString() && gone.leaf === mine[1].leaf.toString() && gone.v === '7', 'with its keys and value, derived again from the wallet');
  const at = JSON.parse(openState(keys.v, saved.get(skey)));
  assert.ok(at.recentSpent.length === 1 && !at.recentSpent[0].sk && !at.recentSpent[0].nk && !at.recentSpent[0].nf, 'saved without its keys');
  assert.deepEqual(mk().holdingNotes().map((x) => x.index).sort(), [1, 4], 'and still there after a reload');
  assert.deepEqual(mk().notes().map((x) => x.index), [1], 'the balance after a reload does not see it');
  // Three days on it is forgotten.
  at.recentSpent[0].spentAt = Date.now() - 4 * 864e5;
  saved.set(skey, sealState(keys.v, JSON.stringify(at)));
  assert.deepEqual(mk().holdingNotes().map((x) => x.index), [1], 'after three days it is no longer offered');
});

await check('a relayer quote for another chain or pool, an unexpected address, or an excessive fee is refused', async () => {
  const POOLA = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', RELAYER = '0xfA2afbaB631C7Eda7CeA6AE1440605C504E322Ec';
  const good = { chainId: 8453, pool: POOLA, relayer: RELAYER, fee: '5000000000000' };
  const walletFor = (q) => makeEvmPoolWallet({
    zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(5)), prove: null, store: null, keeper: 'https://k.test',
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => q }),
    chain: { chainId: 8453, pool: POOLA, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc: async () => '0x0', deployBlock: 0, confirmations: 0, relayer: RELAYER },
  });
  assert.equal((await walletFor(good).quote()).fee, good.fee);
  for (const [why, q] of [
    ['chain', { ...good, chainId: 1 }], ['pool', { ...good, pool: '0x1111111111111111111111111111111111111111' }],
    ['relayer', { ...good, relayer: '0x2222222222222222222222222222222222222222' }],
    ['fee', { ...good, fee: (10n ** 18n).toString() }], ['fee format', { ...good, fee: '-1' }],
  ]) await assert.rejects(() => walletFor(q).quote(), /nothing was signed/, why);
});

await check('saved state is ciphertext at rest, opens only under its own key, and fails its tag if altered; plain JSON still loads', async () => {
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(9));
  const text = JSON.stringify({ block: 5, notes: [{ v: '123456789' }] });
  const sealedText = sealState(keys.v, text);
  assert.ok(sealedText.startsWith('enc1:') && !sealedText.includes('123456789'));
  assert.equal(openState(keys.v, sealedText), text);
  assert.equal(openState(keys.v + 1n, sealedText), null);
  assert.equal(openState(keys.v, sealedText.slice(0, -2) + (sealedText.endsWith('00') ? '11' : '00')), null);
  assert.notEqual(sealState(keys.v, text), sealedText, 'a fresh nonce each time');
  assert.equal(openState(keys.v, text), text);
});

await check('a spend built again from the same note takes another one-time key, and attempt 0 is the plain derivation', async () => {
  const k = evmPoolKeys(zk, new Uint8Array(32).fill(5)), nf = 12345n;
  const e0 = paymentKey(k, { chainId: 1, nf, k: 0 });
  assert.equal(e0, paymentKey(k, { chainId: 1, nf, k: 0, attempt: 0 }));
  const seen = new Set([e0]);
  for (let a = 1; a < 16; a++) seen.add(paymentKey(k, { chainId: 1, nf, k: 0, attempt: a }));
  assert.equal(seen.size, 16);
});

await check('the router log read names no receive box, so a node does not see which boxes are one wallet\'s', async () => {
  const POOLA = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTERA = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
  const seen = [];
  const rpc = async (m, params) => { if (m === 'eth_getLogs') seen.push(params[0]); return m === 'eth_blockNumber' ? '0x64' : []; };
  const w = makeEvmPoolWallet({ zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(5)), prove: null, store: null, chain: { chainId: 8453, pool: POOLA, router: ROUTERA, rpc, deployBlock: 0, confirmations: 0 } });
  await w.sync();
  const router = seen.filter((f) => [f.address].flat().includes(ROUTERA));
  assert.ok(router.length > 0);
  for (const f of router) assert.equal(f.topics.length, 1, 'only the event signature');
});

await check('a call starts at the node that answered last, so one that stopped answering costs one timeout, not one per call', async () => {
  const calls = [];
  const hang = (url, init) => new Promise((res, rej) => { calls.push(url); init.signal?.addEventListener('abort', () => rej(init.signal.reason)); });
  const rpc = jsonRpc(['silent', 'drpc'], (url, init) => (url === 'silent' ? hang(url, init) : (calls.push(url), nodes(SPEC, [])(url, init))), { timeoutMs: 50 });
  const alive = setInterval(() => {}, 1000);
  try { await rpc('eth_blockNumber'); await rpc('eth_blockNumber'); await rpc('eth_blockNumber'); } finally { clearInterval(alive); }
  assert.deepEqual(calls, ['silent', 'drpc', 'drpc', 'drpc']);
});

await check('a recipient address is decoded once and read back the same', async () => {
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(7));
  let decodes = 0;
  const pool = { decodeAddress: (a) => { decodes++; return keys.pool.decodeAddress(a); } };
  const first = recipientOf({ pool }, keys.address), again = recipientOf({ pool }, `  ${keys.address}\n`);
  assert.equal(decodes, 1);
  assert.deepEqual(again, first);
  assert.notEqual(again, first, 'each caller gets its own record');
});

await check('a relayed spend whose quote is above the fee shown is refused before anything is built', async () => {
  const POOLA = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', RELAYER = '0xfA2afbaB631C7Eda7CeA6AE1440605C504E322Ec';
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(5));
  const rpc = async (m) => (m === 'eth_blockNumber' ? '0x64' : m === 'eth_getLogs' ? [] : '0x0');
  const w = makeEvmPoolWallet({
    zk, keys, prove: null, store: null, keeper: 'https://k.test',
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ chainId: 8453, pool: POOLA, relayer: RELAYER, fee: '5000000000000' }) }),
    chain: { chainId: 8453, pool: POOLA, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc, deployBlock: 0, confirmations: 0, relayer: RELAYER },
  });
  const to = evmPoolKeys(zk, new Uint8Array(32).fill(6)).address;
  await assert.rejects(() => w.send({ to, amount: 1n, via: 'relay', maxFee: 4_000_000_000_000n }), (e) => e.feeMoved === 5_000_000_000_000n && /fee went up/.test(e.message));
  await assert.rejects(() => w.withdraw({ to: '0x1111111111111111111111111111111111111111', amount: 1n, via: 'relay', maxFee: 1n }), (e) => e.feeMoved === 5_000_000_000_000n);
  await assert.rejects(() => w.send({ to, amount: 1n, via: 'relay', maxFee: 6_000_000_000_000n }), (e) => e.feeMoved === undefined);
});

await check('merging plans: none when two notes cover it, one fee per merge, nothing when merges cannot', async () => {
  assert.equal(mergePlan([5n, 3n], 8n, 1n), 0);
  assert.equal(mergePlan([9n], 9n, 1n), 0);
  assert.equal(mergePlan([4n, 3n, 3n], 9n, 1n), 1, 'merging 4+3 leaves 6, and 6+3 covers it');
  assert.equal(mergePlan([4n, 3n, 3n], 10n, 1n), null, 'the second merge leaves one note of 8');
  assert.equal(mergePlan([1n, 1n], 3n, 2n), null, 'a merge that costs its whole note');
  assert.equal(mergePlan([], 1n, 0n), null);
  assert.equal(mergePlan(Array(10).fill(5n), 40n, 0n), 6, 'ten notes of 5 reach 40 only after six merges, though no single merge shows it');
  assert.equal(mergePlan(Array(10).fill(5n), 51n, 0n), null, 'and cannot reach more than they hold');
  assert.equal(mergePlan([2n, 2n, 2n, 2n, 2n, 2n, 2n, 2n, 2n], 100n, 0n), null, 'no more than 8 merges');
});

await check('mergePlan agrees with the loop prepare() ran before it, merge for merge, over random notes, needs and fees', async () => {
  // That loop: take one note, or two, covering `need`; else merge the two largest (the new note is their sum less `fee`),
  // and stop when they cannot pay the fee, when fewer than two notes are left, or after eight rounds, the last of which
  // merges without looking again. → merges made, or null.
  const loop = (values, need, fee) => {
    let u = values.map(BigInt);
    for (let guard = 0; guard < 8; guard++) {
      const asc = [...u].sort((a, b) => (a < b ? -1 : 1));
      if (asc.some((v) => v >= need)) return guard;
      for (let i = asc.length - 1; i > 0; i--) for (let j = i - 1; j >= 0; j--) if (asc[i] + asc[j] >= need) return guard;
      const desc = [...u].sort((a, b) => (b < a ? -1 : 1));
      if (desc.length < 2 || desc[0] + desc[1] <= fee) return null;
      u = [desc[0] + desc[1] - fee, ...desc.slice(2)];
    }
    return null;
  };
  let seed = 12345;
  const rand = (m) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % m; };
  let reachable = 0, merged = 0;
  for (let i = 0; i < 20_000; i++) {
    const values = Array.from({ length: rand(11) }, () => BigInt(1 + rand(50)));
    const need = BigInt(1 + rand(300)), fee = BigInt(rand(6));
    const want = loop(values, need, fee);
    assert.equal(mergePlan(values, need, fee), want, `${values} need ${need} fee ${fee}`);
    if (want != null) reachable++;
    if (want > 0) merged++;
  }
  assert.ok(reachable > 2000 && merged > 500, `the cases cover both outcomes and real merges (${reachable} reachable, ${merged} merging)`);
});

await check('a spend that merging cannot cover is refused before a merge is paid for', async () => {
  const POOLA = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', RELAYER = '0xfA2afbaB631C7Eda7CeA6AE1440605C504E322Ec';
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(5));
  const E12 = 10n ** 12n, fee = E12;
  const notes = [4n, 3n, 3n].map((v, index) => ({ index, leaf: String(1000 + index), v: String(v * E12), rho: String(index + 1), s: '0x02' + String(index + 1).padStart(2, '0').repeat(32), block: 90, tx: '0x' + '00'.repeat(32), kind: 'memo' }));
  const kv = new Map([[`tacit-evm-pool-v1:8453:${POOLA.toLowerCase()}:${keys.address}`, JSON.stringify({ block: 100, leaves: notes.map((x) => x.leaf), notes, nextRefund: 1, attempts: {} })]]);
  const urls = [];
  const rpc = async (m) => (m === 'eth_blockNumber' ? '0x64' : m === 'eth_getLogs' ? [] : '0x0');
  const w = makeEvmPoolWallet({
    zk, keys, prove: null, keeper: 'https://k.test', store: { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) },
    fetchImpl: async (url) => { urls.push(url.replace('https://k.test', '')); return { ok: true, status: 200, headers: new Map(), json: async () => ({ chainId: 8453, pool: POOLA, relayer: RELAYER, fee: fee.toString() }) }; },
    chain: { chainId: 8453, pool: POOLA, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc, deployBlock: 0, confirmations: 0, relayer: RELAYER },
  });
  const to = evmPoolKeys(zk, new Uint8Array(32).fill(6)).address;
  assert.equal((await w.sync()).balance, 10n * E12, 'the seeded notes are the wallet\'s');
  // 9 + fee needs 10: two merges leave one note of 8 (4+3-1 = 6, then 6+3-1 = 8)
  await assert.rejects(() => w.send({ to, amount: 9n * E12, via: 'relay' }), /not enough in the pool for this amount and its fee/);
  assert.deepEqual([...new Set(urls.filter((u) => !u.startsWith('/quote') && !u.startsWith('/events')))], [], 'nothing past the quote was asked of the relayer');
});

await check('the quote can be priced for a spend that burns more gas, and toV1 holds a relayed fee to maxFee', async () => {
  const POOLA = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', RELAYER = '0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0';
  const urls = [];
  const rpc = async (m) => (m === 'eth_blockNumber' ? '0x64' : m === 'eth_getLogs' ? [] : '0x0');
  const w = makeEvmPoolWallet({
    zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(5)), prove: null, store: null, keeper: 'https://k.test',
    fetchImpl: async (url) => { urls.push(url.replace('https://k.test', '')); return { ok: true, status: 200, headers: new Map(), json: async () => ({ chainId: 1, pool: POOLA, relayer: RELAYER, fee: '5000000000000' }) }; },
    chain: { chainId: 1, pool: POOLA, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc, deployBlock: 0, confirmations: 0, relayer: RELAYER },
  });
  await w.quote();
  await w.quote(700_000);
  assert.deepEqual(urls.filter((u) => u.startsWith('/quote')), ['/quote', '/quote?gas=700000']);
  await assert.rejects(() => w.toV1({ amount: 10n ** 12n, commit: '0x' + '11'.repeat(32), via: 'relay', maxFee: 4_000_000_000_000n }), (e) => e.feeMoved === 5_000_000_000_000n && /fee went up/.test(e.message));
  assert.ok(urls.includes('/quote?gas=700000'), 'toV1 asked for the quote priced for its own gas');
});

await check('toV1 counts its hour-long deadline from the chain time it is given', async () => {
  const POOLA = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', RELAYER = '0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0';
  const calls = [];
  const rpc = async (m, p) => { if (m === 'eth_call') calls.push(p[0].data); return m === 'eth_blockNumber' ? '0x64' : m === 'eth_getLogs' ? [] : '0x0'; };
  const w = makeEvmPoolWallet({
    zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(5)), prove: null, store: null, keeper: 'https://k.test',
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ chainId: 1, pool: POOLA, relayer: RELAYER, fee: '5000000000000' }) }),
    chain: { chainId: 1, pool: POOLA, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc, deployBlock: 0, confirmations: 0, relayer: RELAYER },
  });
  const now = 1_900_000_000;
  await assert.rejects(() => w.toV1({ amount: 10n ** 12n, commit: '0x' + '11'.repeat(32), via: 'relay', now }), /not enough in the pool/);
  const box = calls.find((d) => d && d.length === 10 + 64 * 8);                   // wrapBoxOf(the wrap intent, eight words)
  assert.equal(BigInt('0x' + box.slice(10 + 64 * 6, 10 + 64 * 7)), BigInt(now + 3600), 'the intent\'s deadline is that time plus an hour');
});

await check('a feed page is kept as soon as it checks, so a feed that fails partway loses only the page it was reading', async () => {
  const POOLA = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
  const kv = new Map(), store = { get: (k) => kv.get(k) ?? null, set: (k, v) => kv.set(k, v) };
  const page = { chainId: 8453, pool: POOLA, through: 50, events: [{ kind: 'transact', block: 40, tx: '0x' + '00'.repeat(32), firstIndex: 0,
    nf0: '0', nf1: '0', outLeaf0: '11', outLeaf1: '12', memo0: '0x', memo1: '0x' }] };
  const make = (feedUp) => {
    const asked = [];
    const rpc = async (m, p) => { if (m === 'eth_getLogs') asked.push(Number(p[0].fromBlock)); return m === 'eth_blockNumber' ? '0x64' : m === 'eth_getLogs' ? [] : '0x' + '2'.padStart(64, '0'); };
    const w = makeEvmPoolWallet({
      zk, keys: evmPoolKeys(zk, new Uint8Array(32).fill(5)), prove: null, store, keeper: 'https://k.test',
      fetchImpl: async (url) => { if (!url.includes('/events?from=1') || !feedUp) throw new Error('feed down'); return { ok: true, status: 200, headers: new Map(), json: async () => page }; },
      chain: { chainId: 8453, pool: POOLA, router: '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5', rpc, deployBlock: 1, confirmations: 0 },
    });
    return { w, asked };
  };
  const a = make(true);
  await a.w.sync();
  assert.equal(a.asked[0], 51, 'the chain-log scan starts after the page the feed gave, though the next page failed');
  const b = make(false);
  await b.w.sync();
  assert.deepEqual(b.asked, [], 'and a wallet made again from what was stored has nothing left to read');
});

await check('a feed read builds the tree a transaction at a time would, in about a hash per leaf, and keeps the same note paths', async () => {
  const POOLA = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTERA = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
  const hashes = { two: 0 };
  const zkc = makeEvmPoolZk({ poseidon: (xs) => { if (xs.length === 2) hashes.two++; return P[xs.length](xs); } });
  const keys = evmPoolKeys(zkc, new Uint8Array(32).fill(7));
  const asset = poolAsset({ chainId: 8453n, pool: POOLA, token: '0x0000000000000000000000000000000000000000' });
  const self = { V: keys.V, A: keys.A, N: keys.N };
  const hex = (b) => '0x' + Buffer.from(b).toString('hex');
  const TIP = 200, SPEND_AT = 60;
  // 120 blocks, one transaction each: every 17th pays this wallet in its first output, block 30 has one output, and
  // block 60 spends the first paid note and inserts nothing. The same feed is replayed into a tree one append at a time.
  const events = [], leaves = [], owned = [], ref = zkc.incTree(), sizeOfRoot = new Map([[ref.root, 0]]);
  let index = 0;
  for (let b = 1; b <= 120; b++) {
    const tx = '0x' + b.toString(16).padStart(64, '0');
    if (b === SPEND_AT) {
      const k = zkc.ownedKeys(keys.zkWallet, openNote(zkc, keys, { memo: owned[0].memo, leaf: owned[0].leaf, asset }).s);
      events.push({ kind: 'transact', block: b, tx, firstIndex: index, nf0: String(zkc.nullifier(k.nk, owned[0].leaf, owned[0].index)), nf1: '0', outLeaf0: '0', outLeaf1: '0', memo0: '0x', memo1: '0x' });
      continue;
    }
    let l0 = BigInt(1000 + b), l1 = b === 30 ? 0n : BigInt(5000 + b), memo0 = '0x';
    if (b % 17 === 0) {
      const o = sealNote(zkc, { to: self, value: BigInt(b), asset });
      l0 = zkc.leafOf(asset, o.v, o.npk, o.rho); memo0 = hex(o.memo);
      owned.push({ index, v: BigInt(b), leaf: l0, memo: o.memo });
    }
    events.push({ kind: 'transact', block: b, tx, firstIndex: index, nf0: String(900000 + b), nf1: '0', outLeaf0: String(l0), outLeaf1: String(l1), memo0, memo1: '0x' });
    leaves.push(l0, l1);
    ref.append([l0, l1], owned.filter((o) => o.index === index).map((o) => o.index));
    index += 2; sizeOfRoot.set(ref.root, index);
  }
  const kept = owned.slice(1);
  for (const o of owned.slice(0, 1)) ref.untrack(o.index);
  // The feed is read in pages of 40 blocks; the node's rootSize is what the pool held after each transaction.
  const fetchImpl = async (url) => {
    const from = Number(new URL(url).searchParams.get('from')), through = Math.min(from + 39, TIP);
    const page = { chainId: 8453, pool: POOLA, through, events: events.filter((e) => e.block >= from && e.block <= through) };
    return { ok: true, status: 200, headers: new Map(), json: async () => page };
  };
  const rpc = async (m, p) => {
    if (m === 'eth_blockNumber') return '0x' + TIP.toString(16);
    if (m === 'eth_getLogs') return [];
    if (m === 'eth_call') return '0x' + BigInt(sizeOfRoot.get(BigInt('0x' + p[0].data.slice(-64))) ?? 0).toString(16).padStart(64, '0');
    return '0x0';
  };
  const kv = new Map();
  const w = makeEvmPoolWallet({ zk: zkc, keys, prove: null, keeper: 'https://k.test', fetchImpl, store: { get: (k) => kv.get(k) ?? null, set: (k, v) => kv.set(k, v) },
    chain: { chainId: 8453, pool: POOLA, router: ROUTERA, rpc, deployBlock: 1, confirmations: 0 } });
  hashes.two = 0;
  const sum = await w.sync();
  assert.equal(sum.leaves, leaves.length);
  assert.equal(sum.balance, kept.reduce((a, o) => a + o.v, 0n), 'the note spent in block 60 is gone and the rest are held');
  assert.ok(hashes.two < 4 * leaves.length, `${hashes.two} two-input hashes for ${leaves.length} leaves`);
  const now = JSON.parse(openState(keys.v, [...kv.values()].pop()));
  assert.equal(now.tree.root, ref.root.toString(), 'the same root as a transaction at a time');
  assert.equal(now.tree.root, zkc.tree(leaves).root.toString(), 'and as a tree built from all the leaves');
  assert.deepEqual(Object.keys(now.tree.tracked).map(Number), kept.map((o) => o.index), 'a path for each unspent note only');
  for (const o of kept) {
    const path = now.tree.tracked[o.index];
    assert.deepEqual(path, ref.path(o.index).map(String), `note ${o.index} keeps the path a transaction at a time gives`);
    let h = o.leaf;
    for (let d = 0; d < path.length; d++) h = (o.index >> d) & 1 ? P[2]([BigInt(path[d]), h]) : P[2]([h, BigInt(path[d])]);
    assert.equal(h.toString(), now.tree.root, `note ${o.index}'s path leads to the root`);
  }
  // A page whose second transaction skips a pair is not kept: the tree stays empty and the chain-log scan (here empty) has nothing to add.
  const gap = events.slice(0, 2).map((e, i) => (i ? { ...e, firstIndex: 4 } : e));
  const w2 = makeEvmPoolWallet({ zk: zkc, keys, prove: null, keeper: 'https://k.test', store: { get: () => null, set: () => {} },
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ chainId: 8453, pool: POOLA, through: TIP, events: gap }) }),
    chain: { chainId: 8453, pool: POOLA, router: ROUTERA, rpc, deployBlock: 1, confirmations: 0 } });
  assert.equal((await w2.sync()).leaves, 0, 'a page with a leaf out of order is refused whole');
});

await check('a batch goes to one node in one request and comes back in order, with null and per-call errors kept apart', async () => {
  const seen = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body); seen.push([url, Array.isArray(body) ? body.length : 1]);
    const answers = body.map((x) => (x.params[0] === 'bad' ? { jsonrpc: '2.0', id: x.id, error: { code: -32000, message: 'limit' } } : { jsonrpc: '2.0', id: x.id, result: x.params[0] === 'none' ? null : `${x.method}:${x.params[0]}` }));
    return { json: async () => answers.reverse() };                              // a node may answer in any order
  };
  const rpc = jsonRpc(['a', 'b'], f);
  const out = await rpc.batch([{ method: 'm', params: ['1'] }, { method: 'm', params: ['none'] }, { method: 'm', params: ['bad'] }, { method: 'k', params: ['4'] }]);
  assert.deepEqual(seen, [['a', 4]], 'one request, to the first node');
  assert.equal(out[0], 'm:1'); assert.equal(out[1], null); assert.ok(out[2] instanceof Error && out[2].rpc.code === -32000); assert.equal(out[3], 'k:4');
});

await check('a node that refuses batches is passed over, and not asked again by the next one', async () => {
  const seen = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body); seen.push([url, Array.isArray(body)]);
    if (url === 'nobatch' && Array.isArray(body)) return { json: async () => ({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch requests are not allowed' } }) };
    const one = (x) => ({ jsonrpc: '2.0', id: x.id, result: x.params[0] });
    return { json: async () => (Array.isArray(body) ? body.map(one) : one(body)) };
  };
  const rpc = jsonRpc(['nobatch', 'ok'], f);
  assert.deepEqual(await rpc.batch([{ method: 'm', params: ['x'] }]), ['x']);
  assert.deepEqual(await rpc.batch([{ method: 'm', params: ['y'] }]), ['y']);
  assert.deepEqual(seen.map((x) => x.join(':')), ['nobatch:true', 'ok:true', 'ok:true'], 'the refusing node was asked once');
  assert.equal(await rpc('m', ['z']), 'z', 'a call alone still works, from the node that took the batch');
});

await check('a node that answers every call of a batch with an error counts as failed, and when no node takes it the batch throws', async () => {
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    return { json: async () => body.map((x) => (url === 'busy' || url === 'worse' ? { jsonrpc: '2.0', id: x.id, error: { code: 429, message: 'request limit reached' } } : { jsonrpc: '2.0', id: x.id, result: 1 })) };
  };
  assert.deepEqual(await jsonRpc(['busy', 'fine'], f).batch([{ method: 'm' }, { method: 'm' }]), [1, 1]);
  await assert.rejects(jsonRpc(['busy', 'worse'], f).batch([{ method: 'm' }]), (e) => e.all.length === 2);
  await assert.rejects(jsonRpc(['down'], async () => { throw new Error('fetch failed'); }).batch([{ method: 'm' }]), /fetch failed/);
});

await check('a record known to exist is asked of the next node when one answers null, and null comes back only when none has it', async () => {
  const asked = [];
  const f = async (url, init) => {
    const x = JSON.parse(init.body); asked.push(url);
    if (url === 'down') throw new Error('fetch failed');
    return { json: async () => ({ jsonrpc: '2.0', id: x.id, result: url === 'recent' ? null : url === 'full' ? { tx: x.params[0] } : null }) };
  };
  const rpc = jsonRpc(['recent', 'full'], f);
  assert.equal(await rpc('eth_getTransactionReceipt', ['0xa']), null, 'without the option a null is the answer, as before');
  assert.deepEqual(asked, ['recent']);
  asked.length = 0;
  assert.deepEqual(await rpc('eth_getTransactionReceipt', ['0xa'], { found: true }), { tx: '0xa' });
  assert.deepEqual(asked, ['recent', 'full']);
  asked.length = 0;
  assert.deepEqual(await rpc('eth_getTransactionReceipt', ['0xb'], { found: true }), { tx: '0xb' });
  assert.deepEqual(asked, ['full'], 'the next call starts at the node that had it');
  assert.equal(await jsonRpc(['recent', 'recent2'], f)('eth_getTransactionReceipt', ['0xa'], { found: true }), null, 'null when no node has it');
  assert.equal(await jsonRpc(['down', 'recent'], f)('eth_getTransactionReceipt', ['0xa'], { found: true }), null, 'a node that is down and one that has none is still null');
  await assert.rejects(jsonRpc(['down'], f)('eth_getTransactionReceipt', ['0xa'], { found: true }), /fetch failed/, 'but every node failing is an error, not a null');
});

await check('a busy or failing node\'s answer to a batch passes it over that once; only a refusal of batches as such is remembered', async () => {
  const err = (error) => ({ jsonrpc: '2.0', id: null, error });
  const replies = [
    ['busy', 429, err({ code: 429, message: 'Too Many Requests' }), true],
    ['down', 503, err({ code: -32603, message: 'upstream unavailable' }), true],
    ['limited', 200, err({ code: -32005, message: 'daily request count exceeded, request rate limited' }), true],
    ['gateway', 200, { message: 'Too many requests, slow down' }, true],
    ['invalid', 200, err({ code: -32600, message: 'Invalid Request' }), false],
    ['nomethod', 400, err({ code: -32601, message: 'the method  does not exist/is not available' }), false],
    ['words', 200, err({ code: -32000, message: 'batch requests are not supported' }), false],
    ['lone', 200, { jsonrpc: '2.0', id: 1, result: '0x1' }, false],
  ];
  for (const [name, status, reply, again] of replies) {
    const asked = [];
    // `name` answers its first batch with `reply` and later ones in full; the other node answers the first batch only.
    const f = async (url, init) => {
      const body = JSON.parse(init.body);
      asked.push(url);
      if (url === name && asked.filter((u) => u === name).length === 1) return { status, json: async () => reply };
      if (url !== name && asked.filter((u) => u !== name).length > 1) throw new Error('fetch failed');
      return { status: 200, json: async () => body.map((x) => ({ jsonrpc: '2.0', id: x.id, result: url })) };
    };
    const rpc = jsonRpc([name, 'other'], f);
    assert.deepEqual(await rpc.batch([{ method: 'm' }]), ['other'], name);
    if (again) assert.deepEqual(await rpc.batch([{ method: 'm' }]), [name], `${name}: asked again`);
    else await assert.rejects(rpc.batch([{ method: 'm' }]), /fetch failed/, `${name}: not asked again`);
    assert.equal(asked.filter((u) => u === name).length, again ? 2 : 1, name);
  }
});

await check('the notes seen spent are the newest spends, by the block that spent them, and a rebuild keeps when each was seen', async () => {
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(13)), self = { V: keys.V, A: keys.A, N: keys.N };
  const pool = fakePool();
  const mine = [];
  const pay = () => {
    const o = sealNote(zk, { to: self, value: 1000n + BigInt(mine.length), asset: ASSETF });
    const { firstIndex } = pool.transact({ out: [o.leaf, 11n], memo: [o.memo, null] });
    mine.push({ index: firstIndex, nf: zk.nullifier(openNote(zk, keys, { memo: o.memo, leaf: o.leaf, asset: ASSETF }).nk, o.leaf, firstIndex) });
  };
  for (let i = 0; i < 30; i++) pay();
  // Spent in pairs swapped (1, 0, 3, 2, …), so the order of the spends is neither the notes' order nor its reverse.
  const order = mine.map((_, i) => i ^ 1);
  for (const i of order) pool.transact({ nf: [mine[i].nf, 0n] });
  // One more note, whose spend the feed the wallet first reads leaves out.
  pay();
  pool.transact({ nf: [mine[30].nf, 0n] });
  const kv = new Map(), store = { get: (k) => kv.get(k) ?? null, set: (k, v) => kv.set(k, v) };
  const feed = async (url) => {
    const from = Number(new URL(url).searchParams.get('from'));
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ chainId: 8453, pool: POOLF, through: pool.tip, events: pool.events.filter((e) => e.block >= from && e.nf0 !== String(mine[30].nf)) }) };
  };
  const mk = () => makeEvmPoolWallet({ zk, keys, prove: null, store, keeper: 'https://k.test', fetchImpl: feed, chain: { chainId: 8453, pool: POOLF, router: ROUTERF, rpc: nodeOf(pool), deployBlock: 1, confirmations: 0 } });
  const w = mk();
  assert.equal((await w.sync()).notes, 1, 'it holds the note whose spend it was not shown');
  const newest = [...order].reverse().slice(0, 24).map((i) => mine[i].index);
  assert.deepEqual(w.holdingNotes().slice(1).map((x) => x.index), newest, 'the 24 spent last, the last first');
  // An hour on, after one more note was paid and spent, the state is rebuilt from the chain's logs.
  const skey = [...kv.keys()][0], at = JSON.parse(openState(keys.v, kv.get(skey))), hourAgo = Date.now() - 3600e3;
  for (const x of at.recentSpent) x.spentAt = hourAgo;
  kv.set(skey, sealState(keys.v, JSON.stringify(at)));
  pay();
  pool.transact({ nf: [mine[31].nf, 0n] });
  const again = mk();
  assert.equal((await again.rescan()).balance, 0n);
  const held = again.holdingNotes();
  assert.deepEqual(held.map((x) => x.index), [mine[31].index, mine[30].index, ...newest.slice(0, 22)], 'the spends seen now first, then those seen before');
  assert.ok(held.slice(0, 2).every((x) => Date.now() - x.spentAt < 60e3), 'a spend after the old state, and one of a note it held, are seen now');
  assert.ok(held.slice(2).every((x) => x.spentAt === hourAgo), 'the earlier ones keep the time they were seen, and no long-past spend is new');
});

await check('a wallet restored from its seed alone finds payments to thirty one-time addresses in a row, from chain logs and from the feed', async () => {
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(11));
  const pool = fakePool();
  let want = 0n;
  for (let i = 1; i <= 30; i++) { pool.sweep(keys, i, 1000n * BigInt(i)); want += 1000n * BigInt(i); }
  pool.tip += 5;
  for (const [how, opts] of [['chain logs', {}], ['the feed in one page', { keeper: 'https://k.test', fetchImpl: feedOf(pool) }], ['the feed ten blocks a page', { keeper: 'https://k.test', fetchImpl: feedOf(pool, 10) }]]) {
    const seen = [];
    const w = makeEvmPoolWallet({ zk, keys, prove: null, store: null, ...opts, chain: { chainId: 8453, pool: POOLF, router: ROUTERF, rpc: nodeOf(pool, seen), deployBlock: 1, confirmations: 0 } });
    const s = await w.sync();
    assert.equal(s.notes, 30, `${how}: a note from every box`);
    assert.equal(s.balance, want, how);
    if (opts.keeper) assert.equal(seen.length, 0, `${how}: read from the feed, with no chain logs left to read`);
    assert.equal(w.watchThrough(30), false, `${how}: box 30 lay inside what was read`);
  }
});

await check('a sweep\'s Transact and Received come from one log query, so a node a block behind cannot split them', async () => {
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(12));
  const pool = fakePool();
  pool.transact({ out: [5n, 6n] });
  pool.sweep(keys, 0, 4242n);
  // Calls go in turn to a node at the tip and one a block behind, which answers a range past its head up to its head.
  const seen = [], inner = nodeOf(pool, seen);
  let calls = 0;
  const rpc = async (m, p) => {
    if (m === 'eth_getLogs' && calls++ % 2) return (await inner(m, p)).filter((l) => Number(l.blockNumber) < pool.tip);
    return inner(m, p);
  };
  const w = makeEvmPoolWallet({ zk, keys, prove: null, store: null, chain: { chainId: 8453, pool: POOLF, router: ROUTERF, rpc, deployBlock: 1, confirmations: 0 } });
  assert.equal((await w.sync()).balance, 4242n, 'the sweep\'s note is found');
  assert.ok(seen.length > 0);
  for (const f of seen) {
    assert.deepEqual(f.address.map((a) => a.toLowerCase()), [POOLF.toLowerCase(), ROUTERF.toLowerCase()], 'the pool and the router in one query');
    assert.deepEqual(f.topics, [[T_TRANSACT, T_RECEIVED]], 'either event, and no receive box named');
  }
});

// Runs `fn` with timers that fire at once and a clock that moves on by each wait; → every wait asked for, in ms.
async function quickly(fn) {
  const set = globalThis.setTimeout, now = Date.now, delays = [];
  let skew = 0;
  globalThis.setTimeout = (f, ms = 0, ...a) => { delays.push(ms); skew += ms; return set(f, 0, ...a); };
  Date.now = () => now() + skew;
  try { await fn(); } finally { globalThis.setTimeout = set; Date.now = now; }
  return delays;
}

// A wallet holding one note of 0.01 ETH on a fake pool, relayed by a stub keeper: s.reserve(n, body) and s.relay(n, body)
// give its answers to the n-th call ([status, body]); s.spend() lands a spend of the note; s.spendAfter(k) lands it at
// the k-th read of the chain's tip from now. s.ready() is the wallet's first sync; s.rescans counts the reads from the
// deploy block after it.
const RELAYER = '0xfA2afbaB631C7Eda7CeA6AE1440605C504E322Ec';
function spender(seed, { sealed = false } = {}) {
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(seed)), self = { V: keys.V, A: keys.A, N: keys.N };
  const pool = fakePool();
  const o = sealNote(zk, { to: self, value: 10n ** 16n, asset: ASSETF });
  const { firstIndex } = pool.transact({ out: [o.leaf, 21n], memo: [o.memo, null] });
  const nf = zk.nullifier(openNote(zk, keys, { memo: o.memo, leaf: o.leaf, asset: ASSETF }).nk, o.leaf, firstIndex);
  const seen = [], inner = nodeOf(pool, seen);
  let proofs = 0, after = 0, base = 0;
  const fromStart = () => seen.filter((f) => Number(f.fromBlock) === 1).length;
  const s = {
    pool, nf, asked: [], feed: null, keeperHeaders: () => null,
    reserve: () => [404, { error: 'this keeper does not queue' }],
    relay: () => [500, { error: 'internal error' }],
    quote: () => [200, { chainId: 8453, pool: POOLF, relayer: RELAYER, fee: '1000000000000' }],
    spend: () => pool.transact({ nf: [nf, 0n] }),
    spendAfter: (k) => { after = k; },
    get proofs() { return proofs; },
    get rescans() { return fromStart() - base; },
    ready: async () => { const sum = await s.w.sync(); base = fromStart(); return sum; },
    count: (path) => s.asked.filter((p) => p === path).length,
  };
  const rpc = async (m, p) => { if (m === 'eth_blockNumber' && after && !--after) s.spend(); return inner(m, p); };
  const fetchImpl = async (url, init) => {
    const path = url.slice('https://k.test'.length).split('?')[0];
    s.asked.push(path);
    const [status, body] = path === '/quote' ? s.quote(s.count(path)) : path === '/reserve' ? s.reserve(s.count(path), JSON.parse(init.body))
      : path === '/relay' ? s.relay(s.count(path), JSON.parse(init.body)) : path === '/cancel' ? [200, { ok: true }]
        : path === '/events' && s.feed ? [200, s.feed(Number(new URL(url).searchParams.get('from')))] : [404, { error: 'not found' }];
    return { ok: status === 200, status, headers: { get: (h) => s.keeperHeaders(h) }, json: async () => body };
  };
  fetchImpl.sealed = sealed;
  s.make = () => (s.w = makeEvmPoolWallet({
    zk, keys, keeper: 'https://k.test', fetchImpl, feed: !!s.feed, store: null,
    prove: async () => { proofs++; return { proof: { pi_a: ['1', '2'], pi_b: [['1', '2'], ['3', '4']], pi_c: ['1', '2'] }, publicSignals: Array(11).fill('0') }; },
    chain: { chainId: 8453, pool: POOLF, router: ROUTERF, rpc, deployBlock: 1, confirmations: 0, relayer: RELAYER },
  }));
  return s;
}
const TO = '0x' + '22'.repeat(20);
const slotOf = (pool) => [200, { id: 'a'.repeat(24), root: String(pool.root), size: String(pool.size), pending: [], oldRoot: String(pool.root), start: String(pool.size) }];
const isSpent = (e) => e.said === true && e.message === 'Those funds were already spent. Check Activity.';

await check('a note the relay already queues a spend of: nothing is proved, and once that spend lands the wallet says the funds were spent', async () => {
  const s = spender(21);
  s.reserve = () => { s.spendAfter(3); return [409, { error: 'a note in this spend is already queued', stale: true }]; };
  s.make();
  await s.ready();
  await quickly(() => assert.rejects(s.w.withdraw({ to: TO, amount: 10n ** 15n, via: 'relay' }), isSpent));
  assert.equal(s.proofs, 0, 'nothing proved');
  assert.equal(s.count('/relay'), 0);
  assert.equal(s.rescans, 0, 'no rebuild from the chain');
  assert.equal((await s.w.sync()).balance, 0n);
});

await check('a queued spend that never lands (a reservation that lapses) is waited out, and the spend then goes through', async () => {
  const s = spender(22);
  // The keeper holds an unfulfilled reservation 90 s, then drops it.
  let since = null;
  s.reserve = () => { since ??= Date.now(); return Date.now() - since < 90_000 ? [409, { error: 'a note in this spend is already queued', stale: true }] : slotOf(s.pool); };
  s.relay = () => [200, { txHash: s.spend().tx }];
  s.make();
  await s.ready();
  let h;
  const waits = await quickly(async () => { h = await s.w.withdraw({ to: TO, amount: 10n ** 15n, via: 'relay' }); });
  assert.match(h, /^0x[0-9a-f]{64}$/);
  assert.equal(s.count('/reserve'), 2);
  assert.equal(s.proofs, 1, 'proved once, after the wait');
  assert.ok(waits.reduce((a, b) => a + b, 0) >= 90_000, 'waited past the time a reservation is held');
});

await check('a note the relay finds spent on chain: nothing is proved, the wallet says so, and only a wallet that cannot see that spend rebuilds', async () => {
  const s = spender(23);
  s.reserve = () => { s.spend(); return [400, { error: 'a note in this spend is already spent' }]; };
  s.make();
  await s.ready();
  await quickly(() => assert.rejects(s.w.withdraw({ to: TO, amount: 10n ** 15n, via: 'relay' }), isSpent));
  assert.equal(s.proofs, 0);
  assert.equal(s.rescans, 0, 'it saw the spend: no rebuild');
  // A feed that left the spend out: the wallet still holds the note after waiting, so it rebuilds from the chain's logs.
  const t = spender(24);
  t.spend();
  t.feed = (from) => ({ chainId: 8453, pool: POOLF, through: t.pool.tip, events: t.pool.events.filter((e) => e.block >= from && e.nf0 !== String(t.nf)) });
  t.reserve = () => [400, { error: 'a note in this spend is already spent' }];
  t.make();
  assert.equal((await t.ready()).balance, 10n ** 16n, 'the feed shows the note unspent');
  await quickly(() => assert.rejects(t.w.withdraw({ to: TO, amount: 10n ** 15n, via: 'relay' }), isSpent));
  assert.equal(t.proofs, 0);
  assert.equal(t.rescans, 1, 'rebuilt once from the chain');
  assert.equal(t.w.summary().balance, 0n, 'and the spent note is gone');
});

await check('a relay that answers AlreadyNullified, or that it is relaying this spend already, is final: one proof, and the wallet says why', async () => {
  const s = spender(25);
  s.relay = () => { s.spend(); return [409, { error: 'AlreadyNullified: re-prove against the pool\'s current root', stale: true }]; };
  s.make();
  await s.ready();
  await quickly(() => assert.rejects(s.w.withdraw({ to: TO, amount: 10n ** 15n, via: 'relay' }), isSpent));
  assert.deepEqual([s.proofs, s.count('/relay'), s.rescans], [1, 1, 0]);
  const t = spender(26);
  t.relay = () => { t.spendAfter(3); return [409, { error: 'this spend is already being relayed', stale: true }]; };
  t.make();
  await t.ready();
  await quickly(() => assert.rejects(t.w.withdraw({ to: TO, amount: 'max', via: 'relay' }), isSpent));
  assert.deepEqual([t.proofs, t.count('/relay'), t.rescans], [1, 1, 0]);
  // Relayed already, and not landed while the wallet waited: it says the spend is on its way, and proves nothing more.
  const u = spender(27);
  u.relay = () => [409, { error: 'this spend is already being relayed', stale: true }];
  u.make();
  await u.ready();
  await quickly(() => assert.rejects(u.w.withdraw({ to: TO, amount: 'max', via: 'relay' }), (e) => e.said && /already on its way/.test(e.message)));
  assert.deepEqual([u.proofs, u.count('/relay'), u.rescans], [1, 1, 0]);
});

await check('the wallet rebuilds from the chain after rounds the pool\'s tree refused, and not after rounds the relay was busy', async () => {
  const s = spender(28);
  s.reserve = () => slotOf(s.pool);
  s.relay = () => [409, { error: 'StaleRoot: re-prove against the pool\'s current root', stale: true }];
  s.make();
  await s.ready();
  await quickly(() => assert.rejects(s.w.withdraw({ to: TO, amount: 10n ** 15n, via: 'relay' }), /the pool kept moving/));
  assert.equal(s.proofs, 8);
  assert.equal(s.count('/cancel'), 8, 'each refused round gives its slot back');
  assert.equal(s.rescans, 1);
  const t = spender(29);
  t.relay = () => [429, { error: 'rate limited' }];
  t.make();
  await t.ready();
  await quickly(() => assert.rejects(t.w.withdraw({ to: TO, amount: 10n ** 15n, via: 'relay' }), /the pool kept moving/));
  assert.equal(t.proofs, 8);
  assert.equal(t.rescans, 0, 'rate limits are no reason to rebuild');
});

await check('a relay that refuses a proven spend for its fee says what the fee is now, as a quote above the fee shown does', async () => {
  const s = spender(30);
  s.reserve = () => slotOf(s.pool);
  s.relay = () => [400, { error: 'fee too low: the fee does not cover the gas', needFee: '7000000000000' }];
  s.make();
  await s.ready();
  await assert.rejects(s.w.withdraw({ to: TO, amount: 10n ** 15n, via: 'relay' }), (e) => e.feeMoved === 7_000_000_000_000n && /fee went up/.test(e.message));
  assert.equal(s.proofs, 1);
  assert.equal(s.count('/cancel'), 1, 'its slot is given back');
});

await check('a busy relay is asked again after the Retry-After it gives, about ten seconds when a page cannot read it, a few times at most', async () => {
  for (const [header, lo, hi] of [[null, 5_000, 15_000], ['2', 1_000, 3_000], ['3600', 15_000, 45_000]]) {
    const s = spender(31);
    s.quote = (n) => (n <= 2 ? [429, { error: 'rate limited' }] : [200, { chainId: 8453, pool: POOLF, relayer: RELAYER, fee: '1000000000000' }]);
    s.keeperHeaders = (h) => (h.toLowerCase() === 'retry-after' ? header : null);
    s.make();
    const waits = await quickly(() => s.w.quote());
    assert.equal(waits.length, 2, `Retry-After ${header}`);
    for (const d of waits) assert.ok(d >= lo && d <= hi, `Retry-After ${header}: waited ${d} ms`);
  }
  const s = spender(32);
  s.quote = () => [429, { error: 'rate limited' }];
  s.make();
  const waits = await quickly(() => assert.rejects(s.w.quote(), /rate limited/));
  assert.equal(waits.length, 4);
  assert.ok(waits.reduce((a, b) => a + b, 0) <= 60_000, 'gives up within a minute');
});

await check('feedStart puts a place at the start of its day\'s cell, counted from the pool\'s first block', () => {
  assert.equal(feedStart(1, 26_069_245, 26_069_245), 26_069_245, 'a new wallet asks from the pool\'s first block');
  assert.equal(feedStart(1, 26_069_245, 26_069_245 + 7_199), 26_069_245, 'the last block of the first cell');
  assert.equal(feedStart(1, 26_069_245, 26_069_245 + 7_200), 26_069_245 + 7_200, 'the first block of the next');
  assert.equal(feedStart(1, 26_069_245, 26_069_245 + 7_200 * 5 + 123), 26_069_245 + 7_200 * 5);
  assert.equal(feedStart(8453, 51_864_014, 51_864_014 + 43_200 * 2 + 1), 51_864_014 + 43_200 * 2, 'Base: a day is 43,200 blocks');
  assert.equal(feedStart(4326, 100, 100 + 86_400 + 9), 100 + 86_400, 'MegaETH: 86,400');
  assert.equal(feedStart(4663, 100, 100 + 830_000 + 9), 100 + 830_000, 'Robinhood Chain: 830,000');
  assert.equal(feedStart(999, 100, 100 + 7_200 + 5), 100 + 7_200, 'a chain not listed gets Ethereum\'s cell');
  assert.equal(feedStart('1', 100, 100 + 7_200 + 5), 100 + 7_200, 'the chain id may be a string');
  assert.equal(feedStart(1, undefined, 7_205), 7_200, 'no first block: counted from 0');
  assert.equal(feedStart(1, 500, 100), 100, 'a place before the first block is left alone');
});

await check('the feed is asked from the start of a cell, the same for every wallet in it, and each wallet ends with what a full read gives', async () => {
  const DEPLOY = 1_000, CELL = 43_200, SECOND = DEPLOY + CELL;       // chain 8453: a cell is a day of blocks from the first; the second starts at 44,200
  const pool = fakePool(), put = (b, f) => { pool.tip = b - 1; return f(); };
  const kA = evmPoolKeys(zk, new Uint8Array(32).fill(21)), kB = evmPoolKeys(zk, new Uint8Array(32).fill(22));
  const other = (b) => put(b, () => pool.transact({ out: [BigInt(b), BigInt(b) + 1n] }));
  other(2_000); other(40_000); put(45_000, () => pool.sweep(kA, 1, 111n)); other(50_000); other(60_000);
  const keeper = (page) => { const asked = [], inner = feedOf(pool, page); return { asked, fetchImpl: async (url) => { asked.push(Number(new URL(url).searchParams.get('from'))); return inner(url); } }; };
  const make = (keys, store, k) => makeEvmPoolWallet({ zk, keys, prove: null, store, keeper: 'https://k.test', fetchImpl: k.fetchImpl,
    chain: { chainId: 8453, pool: POOLF, router: ROUTERF, rpc: nodeOf(pool), deployBlock: DEPLOY, confirmations: 0 } });
  const stores = [new Map(), new Map()], at = (kv) => ({ get: (k) => kv.get(k) ?? null, set: (k, v) => kv.set(k, v) });
  // Two wallets read to different places in the second cell; a new wallet has no place.
  pool.tip = 60_500; await make(kA, at(stores[0]), keeper()).sync();
  pool.tip = 70_000; await make(kB, at(stores[1]), keeper()).sync();
  other(80_000); put(95_000, () => pool.sweep(kA, 1, 222n)); other(100_000);
  pool.tip = 110_000;
  const full = async (keys) => { const k = keeper(); const s = await make(keys, at(new Map()), k).sync(); assert.equal(k.asked[0], DEPLOY, 'a new wallet asks from the pool\'s first block'); return s; };
  const wantA = await full(kA), wantB = await full(kB);
  assert.equal(wantA.balance, 333n);
  const runs = {};
  for (const [how, page] of [['one page', Infinity], ['pages of 10,000 blocks, the first ending before either wallet\'s place', 10_000]]) {
    const a = keeper(page), b = keeper(page);
    const sA = await make(kA, at(new Map(stores[0])), a).sync(), sB = await make(kB, at(new Map(stores[1])), b).sync();
    assert.equal(a.asked[0], SECOND, `${how}: wallet A, at 60,501, asks from the start of its cell`);
    assert.equal(b.asked[0], SECOND, `${how}: wallet B, at 70,001, asks from the same block`);
    assert.deepEqual(a.asked, b.asked, `${how}: and the requests after it are the same too`);
    for (const [who, got, want] of [['A', sA, wantA], ['B', sB, wantB]]) {
      assert.equal(got.leaves, want.leaves, `${how}: ${who} has every leaf`);
      assert.equal(got.notes, want.notes, `${how}: ${who} has its notes`);
      assert.equal(got.balance, want.balance, `${how}: ${who} has its balance`);
    }
    runs[how] = a.asked;
  }
  assert.deepEqual(runs['one page'], [SECOND]);
  assert.deepEqual(runs['pages of 10,000 blocks, the first ending before either wallet\'s place'], [44_200, 54_200, 64_200, 74_200, 84_200, 94_200, 104_200],
    'a page that ends before the wallet\'s place is passed over, and the next request starts where it ended');
});

await check('a wallet ahead of the keeper\'s history asks once from its cell and once past the keeper\'s end, and reads the rest from the chain', async () => {
  const DEPLOY = 1_000, SECOND = DEPLOY + 43_200, HEAD = 55_000;
  const pool = fakePool(), put = (b, f) => { pool.tip = b - 1; return f(); };
  const keys = evmPoolKeys(zk, new Uint8Array(32).fill(23));
  put(45_000, () => pool.sweep(keys, 1, 50n)); put(56_000, () => pool.transact({ out: [7n, 8n] })); put(57_000, () => pool.sweep(keys, 1, 60n));
  // The keeper's history ends at block 55,000.
  const asked = [], fetchImpl = async (url) => {
    const from = Number(new URL(url).searchParams.get('from'));
    asked.push(from);
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ chainId: 8453, pool: POOLF, through: HEAD, events: pool.events.filter((e) => e.block >= from && e.block <= HEAD) }) };
  };
  const kv = new Map(), store = { get: (k) => kv.get(k) ?? null, set: (k, v) => kv.set(k, v) };
  const make = (feed) => makeEvmPoolWallet({ zk, keys, prove: null, store, keeper: 'https://k.test', feed, fetchImpl,
    chain: { chainId: 8453, pool: POOLF, router: ROUTERF, rpc: nodeOf(pool), deployBlock: DEPLOY, confirmations: 0 } });
  pool.tip = 58_000; await make(false).sync();                      // read from the chain alone to 58,000, past where the keeper's history ends
  pool.tip = 70_000; asked.length = 0;
  const s = await make(true).sync();
  assert.deepEqual(asked, [SECOND, HEAD + 1], 'from the start of its cell, then just past the end of the keeper\'s history, and no more');
  assert.equal(s.balance, 110n);
  assert.equal(s.notes, 2);
  assert.equal(s.leaves, pool.size, 'every leaf');
});

await check('on the private route a spend is sent without a reservation, and the same spend on a direct route asks for one', async () => {
  for (const [route, sealed] of [['direct', false], ['private', true]]) {
    const s = spender(sealed ? 23 : 24, { sealed });
    s.relay = (_, body) => { s.relayed = body; return [200, { txHash: s.spend().tx }]; };
    s.make();
    await s.ready();
    await s.w.withdraw({ to: TO, amount: 10n ** 15n, via: 'relay' });
    assert.equal(s.count('/reserve'), sealed ? 0 : 1, `${route}: reservations asked`);
    assert.equal(s.count('/relay'), 1, `${route}: relayed once`);
    assert.ok(!('reservation' in s.relayed), `${route}: no slot named in the relay`);
    assert.equal(s.proofs, 1, `${route}: proved once`);
  }
});

console.log(`\n${n} checks passed`);
