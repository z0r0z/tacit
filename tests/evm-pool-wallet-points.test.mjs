// Catch-up points: a wallet with nothing read starts at the newest point the registry keeps and the pool vouches for, finds the notes after
// it at once, and reads the history behind it afterwards into a second state that takes the first one's place when their trees agree.
// A point that names the wrong block, or a root the pool never held, is passed over.
//   node tests/evm-pool-wallet-points.test.mjs
import assert from 'node:assert/strict';
import { makeEvmPoolWallet, evmPoolKeys, sealNote } from '../dapp/evm-pool-wallet.js';
import { makeEvmPoolZk, poolAsset } from '../dapp/evm-pool-zk.js';
import { poseidon2, poseidon3, poseidon4, poseidon5, poseidon7 } from 'poseidon-lite';
import { keccak_256 } from '@noble/hashes/sha3';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const P = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5, 7: poseidon7 };
const zk = makeEvmPoolZk({ poseidon: (xs) => P[xs.length](xs) });
const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9', ROUTER = '0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5';
const REG = '0x00000000c3267616ed5e0daa6f6490d109d6844d';
const ASSET = poolAsset({ chainId: 8453n, pool: POOL, token: '0x0000000000000000000000000000000000000000' });
const topic = (sig) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex');
const sel = (sig) => topic(sig).slice(2, 10);
const T_TRANSACT = topic('Transact(bytes32,bytes32,bytes32,bytes32,uint256,bytes32,address,int256,address,uint256,bytes,bytes)');
const w64 = (x) => BigInt.asUintN(256, BigInt(x)).toString(16).padStart(64, '0');

// A pool on chain 8453, one transaction a block, as chain logs and as the keeper feed's events; the registry beside it keeps points posted
// with post(size, block, filled) (any block and edge, as a poster may name them), answering latest() and pointAt(size).
function fakePool() {
  const tree = zk.incTree(), sizeOf = new Map([[tree.root, 0]]), sizeAt = [0], logs = [], events = [], points = new Map();
  let block = 0, latest = 0;
  const pool = {
    get tip() { return block; }, get size() { return tree.size; }, get root() { return tree.root; }, logs, events,
    transact({ nf = [0n, 0n], out = null, memo = [null, null] } = {}) {
      block++;
      const firstIndex = tree.size, [o0, o1] = out ?? [0n, 0n], tx = '0x' + w64(block);
      if (out) { tree.append(out.map(BigInt)); sizeOf.set(tree.root, tree.size); }
      sizeAt[block] = tree.size;
      const m = memo.map((x) => Buffer.from(x ?? []).toString('hex')), pad = (h) => h + '0'.repeat((64 - (h.length % 64)) % 64);
      const body0 = w64(m[0].length / 2) + pad(m[0]);
      logs.push({ address: POOL, blockNumber: '0x' + block.toString(16), transactionHash: tx, logIndex: '0x0', topics: [T_TRANSACT, '0x' + w64(nf[0]), '0x' + w64(nf[1])],
        data: '0x' + [o0, o1, firstIndex, 0, 0, 0, 0, 0, 320, 320 + body0.length / 2].map(w64).join('') + body0 + w64(m[1].length / 2) + pad(m[1]) });
      events.push({ kind: 'transact', block, tx, firstIndex, nf0: String(nf[0]), nf1: String(nf[1]), outLeaf0: String(o0), outLeaf1: String(o1), memo0: '0x' + m[0], memo1: '0x' + m[1] });
      return { block, firstIndex, tx };
    },
    edge: () => ({ size: tree.size, filled: tree.toJSON().filled.map(BigInt) }),
    post(size, at, filled) { points.set(size, { block: at, prev: latest, filled }); if (size > latest) latest = size; },
  };
  pool.node = (seen = [], { history = true } = {}) => async (m, p) => {
    if (m === 'eth_blockNumber') return '0x' + block.toString(16);
    if (m === 'eth_getLogs') {
      const f = p[0], at = [f.address].flat().map((a) => a.toLowerCase()), t0 = [f.topics?.[0] ?? []].flat().map((t) => t.toLowerCase());
      seen.push(f);
      return logs.filter((l) => at.includes(l.address.toLowerCase()) && (!t0.length || t0.includes(l.topics[0])) && Number(l.blockNumber) >= Number(f.fromBlock) && Number(l.blockNumber) <= Number(f.toBlock));
    }
    if (m === 'eth_call') {
      const to = p[0].to.toLowerCase(), d = p[0].data.slice(2), s = d.slice(0, 8);
      if (to === REG) {
        if (s === sel('latest()')) return '0x' + w64(latest);
        if (s === sel('pointAt(uint256)')) { const q = points.get(Number(BigInt('0x' + d.slice(8)))); return '0x' + [q?.block ?? 0, q?.prev ?? 0, ...(q?.filled ?? Array(32).fill(0n))].map(w64).join(''); }
        return '0x';
      }
      if (s === sel('nextIndex()')) { if (!history) throw new Error('missing trie node'); const b = p[1] === 'latest' ? block : Number(p[1]); return '0x' + w64(sizeAt[Math.min(b, block)] ?? 0); }
      return '0x' + w64(sizeOf.get(BigInt('0x' + d.slice(-64))) ?? 0);
    }
    return '0x0';
  };
  pool.feed = async (url) => {
    const from = Number(new URL(url).searchParams.get('from'));
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ chainId: 8453, pool: POOL, through: block, events: events.filter((e) => e.block >= from) }) };
  };
  return pool;
}

const keys = evmPoolKeys(zk, new Uint8Array(32).fill(21)), self = { V: keys.V, A: keys.A, N: keys.N };
const them = evmPoolKeys(zk, new Uint8Array(32).fill(22)), other = { V: them.V, A: them.A, N: them.N };
const pay = (pool, to, v) => { const o = sealNote(zk, { to, value: v, asset: ASSET }); return pool.transact({ out: [o.leaf, 5n], memo: [o.memo, null] }); };
// 30 transactions (60 leaves): notes of the wallet's at blocks 4 (100) and 25 (7), the rest someone else's
function history() {
  const pool = fakePool();
  for (let i = 1; i <= 30; i++) pay(pool, i === 4 ? self : i === 25 ? self : other, i === 4 ? 100n : i === 25 ? 7n : 1n);
  return pool;
}
const memStore = () => { const kv = new Map(); return { kv, get: (k) => kv.get(k) ?? null, set: (k, v) => kv.set(k, v) }; };
const wallet = (pool, { store = memStore(), seen = [], feed = false, history: h = true, partial = true } = {}) => makeEvmPoolWallet({
  zk, keys, prove: null, store, feed, keeper: feed ? 'https://k.test' : null, fetchImpl: pool.feed, partial,
  chain: { chainId: 8453, pool: POOL, router: ROUTER, rpc: pool.node(seen, { history: h }), deployBlock: 1, confirmations: 0 },
});
const firstFrom = (seen) => Math.min(...seen.map((f) => Number(f.fromBlock)));

await check('a wallet with nothing read starts at the newest point, finds the notes after it at once, and the history behind it brings the rest', async () => {
  const pool = fakePool();
  for (let i = 1; i <= 20; i++) pay(pool, i === 4 ? self : other, i === 4 ? 100n : 1n);
  const e = pool.edge(); pool.post(e.size, pool.tip, e.filled);
  for (let i = 21; i <= 30; i++) pay(pool, i === 25 ? self : other, i === 25 ? 7n : 1n);
  const seen = [], store = memStore(), W = wallet(pool, { store, seen });
  const s = await W.sync();
  assert.equal(s.balance, 7n, 'only the note after the point, at first');
  assert.deepEqual(s.behind, { size: 40, block: 20 });
  assert.equal(firstFrom(seen), 21, 'no log before the point is read for it');
  assert.equal(s.leaves, pool.size);
  assert.equal(await W.backfill(), true, 'the history behind it is taken in');
  const t = await W.sync();
  assert.equal(t.balance, 107n, 'both notes');
  assert.equal(t.behind, null);
  assert.equal(store.kv.get(`tacit-evm-pool-v1:8453:${POOL.toLowerCase()}:${keys.address}:back`), '', 'the second state is gone');
  // a note found behind the point can be spent: its path is in the tree that continues
  assert.ok(W.notes().every((x) => x.index != null));
});

await check('the same with the keeper feed, and a later wallet on the same store goes on from the whole history', async () => {
  const p2 = fakePool();
  for (let i = 1; i <= 20; i++) pay(p2, i === 4 ? self : other, i === 4 ? 100n : 1n);
  const edge = p2.edge(); p2.post(edge.size, p2.tip, edge.filled);
  for (let i = 21; i <= 30; i++) pay(p2, i === 25 ? self : other, i === 25 ? 7n : 1n);
  const store = memStore(), W = wallet(p2, { store, feed: true });
  assert.equal((await W.sync()).balance, 7n);
  const W2 = wallet(p2, { store, feed: true });
  assert.ok((await W2.sync()).behind, 'a second wallet on the store starts behind the point too');
  assert.equal(await W.backfill(), true);
  const s2 = await W2.sync();
  assert.equal(s2.behind, null, 'the second wallet takes the whole history the first one joined');
  assert.equal(s2.balance, 107n);
});

const pointed = () => {
  const pool = fakePool();
  for (let i = 1; i <= 20; i++) pay(pool, i === 4 ? self : other, i === 4 ? 100n : 1n);
  const e = pool.edge(); pool.post(e.size, pool.tip, e.filled);
  for (let i = 21; i <= 30; i++) pay(pool, i === 25 ? self : other, i === 25 ? 7n : 1n);
  return pool;
};

await check('a wallet that is not partial reads from the first block, and finishes a state another page began at a point before sync returns', async () => {
  const pool = pointed(), seen = [], store = memStore();
  const W = wallet(pool, { partial: false, seen });
  const s = await W.sync();
  assert.equal(s.balance, 107n, 'the whole balance');
  assert.equal(s.behind, null);
  assert.equal(firstFrom(seen), 1, 'read from the first block, no point used');
  // a partial wallet begins the state, a plain one on the same store completes it
  const P = wallet(pool, { store });
  assert.equal((await P.sync()).balance, 7n);
  const seen2 = [], Q = wallet(pool, { store, partial: false, seen: seen2 });
  const q = await Q.sync();
  assert.equal(q.balance, 107n, 'never the short balance');
  assert.equal(q.behind, null);
  assert.equal(Math.min(...seen2.map((f) => Number(f.fromBlock))) <= 20, true, 'it read what is behind the point');
  assert.equal((await wallet(pool, { store }).sync()).behind, null, 'the state is whole for the next wallet');
});

await check('a plain wallet whose read of the history behind a point fails throws, not a short balance', async () => {
  const pool = pointed(), store = memStore();
  await wallet(pool, { store }).sync();
  const node = pool.node(), fail = async (m, p) => { if (m === 'eth_getLogs' && Number(p[0].fromBlock) <= 20) throw new Error('node down'); return node(m, p); };
  const W = makeEvmPoolWallet({ zk, keys, prove: null, store, partial: false, chain: { chainId: 8453, pool: POOL, router: ROUTER, rpc: fail, deployBlock: 1, confirmations: 0 } });
  await assert.rejects(W.sync(), /older history could not be read/);
});

await check('a point whose block is later than when the tree had its count is passed over, where a node says the count then', async () => {
  const pool = fakePool();
  for (let i = 1; i <= 10; i++) pay(pool, other, 1n);
  const e = pool.edge();
  for (let i = 11; i <= 30; i++) pay(pool, i === 25 ? self : i === 4 ? self : other, i === 25 ? 7n : 1n);
  pool.post(e.size, 15, e.filled);                       // the tree had 20 leaves at block 10, 30 by block 15
  const W = wallet(pool), s = await W.sync();
  assert.equal(s.behind, null, 'read from the first block');
  assert.equal(s.balance, 7n);
});

await check('where no node says the old count, the point with the wrong block is found out by its first leaf and passed over for the one before', async () => {
  const pool = fakePool();
  for (let i = 1; i <= 6; i++) pay(pool, i === 4 ? self : other, i === 4 ? 100n : 1n);
  const e0 = pool.edge(); pool.post(e0.size, pool.tip, e0.filled);          // a good point at block 6 (12 leaves)
  for (let i = 7; i <= 10; i++) pay(pool, other, 1n);
  const e = pool.edge();
  for (let i = 11; i <= 30; i++) pay(pool, i === 25 ? self : other, i === 25 ? 7n : 1n);
  pool.post(e.size, 15, e.filled);                                          // 20 leaves, said to be at block 15 (it was 10)
  const W = wallet(pool, { history: false }), s = await W.sync();
  assert.deepEqual(s.behind, { size: 12, block: 6 }, 'the point before it');
  assert.equal(s.balance, 7n);
  assert.equal(s.leaves, pool.size);
  assert.equal(await W.backfill(), true);
  assert.equal((await W.sync()).balance, 107n);
});

await check('a point whose block is earlier than when the tree had its count: the leaves the edge holds are not taken twice', async () => {
  const pool = fakePool();
  for (let i = 1; i <= 20; i++) pay(pool, i === 18 ? self : other, i === 18 ? 100n : 1n);
  const e = pool.edge();                                 // 40 leaves at block 20
  for (let i = 21; i <= 30; i++) pay(pool, i === 25 ? self : other, i === 25 ? 7n : 1n);
  pool.post(e.size, 16, e.filled);                       // said to be block 16 (32 leaves then)
  const W = wallet(pool), s = await W.sync();
  assert.deepEqual(s.behind, { size: 40, block: 16 });
  assert.equal(s.leaves, pool.size, 'the tree is the pool\'s');
  assert.equal(s.balance, 7n, 'the note at block 18 is behind the edge');
  assert.equal(await W.backfill(), true);
  assert.equal((await W.sync()).balance, 107n);
});

await check('a point whose edge folds to a root the pool never held is not used', async () => {
  const pool = history(), e = pool.edge();
  e.filled[3] += 1n;
  pool.post(e.size, pool.tip, e.filled);
  const s = await wallet(pool).sync();
  assert.equal(s.behind, null);
  assert.equal(s.balance, 107n);
});

await check('historyFrom: the point while the history behind it is unread, kept once it is read and holds nothing of the key\'s, else the first block', async () => {
  const mk = (mineBefore) => {
    const pool = fakePool();
    for (let i = 1; i <= 20; i++) pay(pool, mineBefore && i === 4 ? self : other, mineBefore && i === 4 ? 100n : 1n);
    const e = pool.edge(); pool.post(e.size, pool.tip, e.filled);
    for (let i = 21; i <= 30; i++) pay(pool, i === 25 ? self : other, i === 25 ? 7n : 1n);
    return pool;
  };
  const W = wallet(mk(false));
  await W.sync();
  assert.deepEqual(W.historyFrom(), { size: 40, block: 20, partial: true });
  assert.equal(await W.backfill(), true);
  assert.deepEqual(W.historyFrom(), { size: 40, block: 20, partial: false }, 'nothing of the key\'s behind the point');
  const V = wallet(mk(true));
  await V.sync();
  assert.equal(await V.backfill(), true);
  assert.equal(V.historyFrom(), null, 'a note behind the point: its history starts at the first block');
  assert.equal(wallet(history()).historyFrom(), null, 'a wallet that read from the first block');
});

await check('no registry, or another pool: read from the first block as before', async () => {
  const pool = history();
  const s = await wallet(pool).sync();
  assert.equal(s.behind, null);
  assert.equal(s.balance, 107n);
  const W = makeEvmPoolWallet({ zk, keys, prove: null, store: null, chain: { chainId: 8453, pool: POOL, router: ROUTER, rpc: pool.node(), deployBlock: 1, confirmations: 0, points: null } });
  assert.equal((await W.sync()).balance, 107n);
});

await check('a note younger than the confirmations stays in view, and can be chosen, across the join of the history behind a point', async () => {
  const pool = pointed(), store = memStore();
  const W = makeEvmPoolWallet({ zk, keys, prove: null, store, partial: true, chain: { chainId: 8453, pool: POOL, router: ROUTER, rpc: pool.node(), deployBlock: 1, confirmations: 2 } });
  assert.equal((await W.sync()).balance, 7n);
  pay(pool, self, 9n);                                   // a note in the newest block, within the confirmations
  const s = await W.sync();
  assert.equal(s.balance, 16n, 'in view, not yet kept');
  assert.equal(s.block, pool.tip - 2);
  await W.readBack();
  assert.equal(await W.adopt(), true);
  const t = W.summary();
  assert.equal(t.behind, null);
  assert.equal(t.balance, 116n, 'the whole history, with the young note still in view');
  assert.ok(W.notes().some((x) => x.v === '9'), 'it can be chosen for a spend');
});

await check('a refund box taken while a read is under way keeps its number when the read\'s state is kept', async () => {
  const pool = history(), node = pool.node(), store = memStore();
  let during = null;
  const rpc = async (m, p) => { if (m === 'eth_call' && during) { const f = during; during = null; await f(); } return node(m, p); };
  const chain = { chainId: 8453, pool: POOL, router: ROUTER, rpc, deployBlock: 1, confirmations: 0 };
  const W = makeEvmPoolWallet({ zk, keys, prove: null, store, partial: false, chain });
  await W.sync();
  pay(pool, other, 1n);                                  // a leaf to absorb, so the read asks the pool about the tree's root before it keeps the state
  let box = null;
  during = async () => { box = await W.refundBox(); };
  await W.sync();
  assert.ok(box, 'the box was taken during the read');
  assert.notEqual(await W.refundBox(), box, 'the next refund box is a new one');
  assert.notEqual(await makeEvmPoolWallet({ zk, keys, prove: null, store, partial: false, chain }).refundBox(), box, 'and so for a wallet made from the stored state');
});

console.log(`${n} checks passed`);
