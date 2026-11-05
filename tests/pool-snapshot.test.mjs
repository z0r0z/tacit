// Snapshots of the pool's history (dapp/pool-snapshot.js) and the page's first read from one (confidential-pool-ux.js), with every node and
// gateway stood in for: a raw-block CID is the sha256 of its bytes and a gateway's other bytes are refused; the pieces cut the same each time,
// so a growing snapshot changes only its last; the trees the logs build are checked against the pool's storage, and a snapshot whose trees
// differ is dropped for a read from launch; a snapshot that holds is used, the rest read from the nodes, and its range read again afterwards,
// what the nodes say replacing it.
//   node tests/pool-snapshot.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { ETH_NODES, ETH_LOG_NODES } from '../dapp/eth-nodes.js';
import { SNAPSHOT, rawCid, cidSha, packPiece, unpackPiece, cutPieces, encodePiece, treesOf, poolTrees, sameTrees, loadSnapshot, pointerCall, readPointer, selectLogs, TREE_SLOTS } from '../dapp/pool-snapshot.js';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { makeConfidentialPool } = await import('../dapp/confidential-pool.js');
const { makeConfidentialEvmLog } = await import('../dapp/confidential-evm-log.js');
const { setActiveNetwork, getConfidentialDeployment } = await import('../dapp/confidential-deployments.js');
setActiveNetwork('mainnet');
const _cat = (a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (k, ...m) => hmac(nobleSha256, k, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const cfg = getConfidentialDeployment('mainnet');
const evmLog = makeConfidentialEvmLog({ keccak256: keccak_256 });
const { Tree } = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const T = evmLog.TOPIC0;
const W = (n) => BigInt(n).toString(16).padStart(64, '0');
const h32 = (n) => '0x' + W(n);
const enc = new TextEncoder();
const hex = (b) => Buffer.from(b).toString('hex');

// The pool's logs, ABI-encoded as the pool emits them.
const bytes32s = (xs) => W(xs.length) + xs.map((x) => x.slice(2)).join('');
function leaves(block, i, first, ls) {
  const memos = ls.map(() => '0x' + 'ab'.repeat(40));
  const memoHead = memos.map((_, k) => W(32 * memos.length + k * (32 + 64))).join('');
  const memoBody = memos.map((m) => W(40) + m.slice(2).padEnd(128, '0')).join('');
  const offMemos = 64 + 32 * (1 + ls.length);
  return { address: cfg.pool, topics: [T.LeavesInserted, h32(first)], data: '0x' + W(64) + W(offMemos) + bytes32s(ls) + W(memos.length) + memoHead + memoBody,
    blockNumber: '0x' + block.toString(16), logIndex: '0x' + i.toString(16), transactionHash: h32(block * 1000 + i) };
}
const locks = (block, i, first, ls) => ({ address: cfg.pool, topics: [T.LockLeavesInserted, h32(first)], data: '0x' + W(32) + bytes32s(ls), blockNumber: '0x' + block.toString(16), logIndex: '0x' + i.toString(16), transactionHash: h32(block * 1000 + i) });
const spent = (block, i, nfs) => ({ address: cfg.pool, topics: [T.NullifiersSpent], data: '0x' + W(32) + bytes32s(nfs), blockNumber: '0x' + block.toString(16), logIndex: '0x' + i.toString(16), transactionHash: h32(block * 1000 + i) });
const cdp = (block, i, leaf) => ({ address: cfg.pool, topics: [T.CdpPositionInserted, leaf], data: '0x', blockNumber: '0x' + block.toString(16), logIndex: '0x' + i.toString(16), transactionHash: h32(block * 1000 + i) });

// A history: note leaves, lock leaves, a position and nullifiers over blocks from the deploy block on.
function history(n, start = Number(cfg.deployBlock) + 10) {
  const out = [];
  let note = 0, lock = 0;
  for (let k = 0; k < n; k++) {
    const b = start + k * 7;
    out.push(leaves(b, 0, note, [h32(1000 + note), h32(1001 + note)])); note += 2;
    if (k % 3 === 0) { out.push(locks(b, 1, lock, [h32(5000 + lock)])); lock += 1; }
    if (k % 4 === 1) out.push(spent(b, 2, [h32(9000 + k)]));
    if (k === 5) out.push(cdp(b, 3, h32(7777)));
  }
  return out;
}
const treesFor = (logs) => treesOf(logs, { decodeLogs: evmLog.decodeLogs, Tree, pool: cfg.pool });

test('a raw-block CID is the sha256 of its bytes, and nothing else is one', () => {
  assert.equal(rawCid(enc.encode('hello world'), sha256), 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e');
  assert.equal(hex(cidSha('bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e')), hex(sha256(enc.encode('hello world'))));
  assert.equal(cidSha('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'), null, 'a dag-pb CID is not a raw block');
  assert.equal(cidSha('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'), null);
});

test('a piece packs and unpacks to the logs the page reads, and the pieces cut the same each time', async () => {
  const logs = history(60);
  const addrs = [cfg.pool, cfg.farm.manager];
  assert.deepEqual(unpackPiece(packPiece(logs, addrs)), logs.map((l) => ({ ...l, address: l.address.toLowerCase(), data: l.data.toLowerCase() })));
  const all = cutPieces(logs, 3000);
  assert.ok(all.length > 3, 'several pieces');
  const sealed = all.slice(0, -1).flat().length;
  const again = cutPieces(logs.slice(0, sealed + 1), 3000);
  assert.deepEqual(again.slice(0, -1), all.slice(0, -1), 'a snapshot that grows keeps its earlier pieces');
  for (const p of all) for (let i = 1; i < p.length; i++) assert.ok(p[i].blockNumber >= p[i - 1].blockNumber);
  const split = await encodePiece(logs, addrs, sha256, 2000);
  assert.ok(split.length > 1 && split.every((p) => p.bytes.length <= 2000), 'a piece over the limit is split');
  assert.equal(split.reduce((s, p) => s + p.n, 0), logs.length);
});

test('the trees the logs build are the pool\'s; leaves out of place are refused', async () => {
  const logs = history(20);
  const t = treesFor(logs);
  assert.equal(t.note.count, 40);
  assert.equal(t.lock.count, 7);
  assert.equal(t.cdp.count, 1);
  const storage = storageFor(t);
  assert.ok(sameTrees(t, await poolTrees(async (slot) => storage[slot])));
  assert.ok(!sameTrees(treesFor(logs.slice(0, -3)), await poolTrees(async (slot) => storage[slot])), 'a history cut short is not the pool\'s');
  assert.throws(() => treesFor(logs.filter((l) => l.topics[0] === T.LeavesInserted).slice(1)), /note leaves at/);
});

// The pool's storage words for trees `t`.
function storageFor(t) {
  const out = {};
  for (const [k, [c, r]] of Object.entries(TREE_SLOTS)) { out['0x' + W(c)] = '0x' + W(t[k].count); out['0x' + W(r)] = t[k].root; }
  return out;
}

// A snapshot of `logs` up to `to`, served by gateways: { cid, files }.
async function snapshotOf(logs, to) {
  const addresses = [cfg.pool, cfg.farm.manager];
  const pieces = [];
  for (const p of cutPieces(logs, 3000)) pieces.push(...await encodePiece(p, addresses, sha256));
  const topics = [T.LeavesInserted, T.NullifiersSpent, T.LockLeavesInserted, T.Wrap, T.CdpPositionInserted, T.CrossOutRecorded, T.Bonded, T.Harvested];
  const manifest = enc.encode(JSON.stringify({ v: 1, chainId: 1, pool: cfg.pool, addresses, topics, deployBlock: Number(cfg.deployBlock), to, pieces: pieces.map(({ cid, n, from, to: t }) => ({ cid, n, from, to: t })), trees: treesFor(logs) }));
  const files = new Map(pieces.map((p) => [p.cid, p.bytes]));
  const cid = rawCid(manifest, sha256);
  files.set(cid, manifest);
  return { cid, files };
}
const gatewayFetch = (files, { lie = new Set() } = {}) => async (url) => {
  const m = String(url).match(/\/ipfs\/(b[a-z2-7]+)/);
  if (!m || !files.has(m[1])) return new Response('no', { status: 404 });
  const host = new URL(url).host;
  const b = files.get(m[1]);
  return new Response(lie.has(host) ? Uint8Array.from(b, (x, i) => (i === 10 ? x ^ 1 : x)) : b, { status: 200 });
};

test('a snapshot loads from the gateways, a gateway\'s other bytes passed over; with every gateway lying it is refused', async () => {
  const logs = history(40);
  const { cid, files } = await snapshotOf(logs, 30_000_000);
  const expect = { chainId: 1, pool: cfg.pool, addresses: [cfg.pool, cfg.farm.manager], topics: [T.LeavesInserted, T.NullifiersSpent] };
  const first = new URL(SNAPSHOT.gateways[0]).host;
  const got = await loadSnapshot(cid, { fetchImpl: gatewayFetch(files, { lie: new Set([first]) }), sha256, expect });
  assert.equal(got.logs.length, logs.length);
  const all = new Set(SNAPSHOT.gateways.map((g) => new URL(g).host));
  await assert.rejects(() => loadSnapshot(cid, { fetchImpl: gatewayFetch(files, { lie: all }), sha256, expect }), /bytes that are not/);
  await assert.rejects(() => loadSnapshot(cid, { fetchImpl: gatewayFetch(files), sha256, expect: { ...expect, pool: '0x' + '11'.repeat(20) } }), /another pool/);
});

test('the record is read from the WNS text record', () => {
  const call = pointerCall(keccak_256);
  assert.equal(call.to, SNAPSHOT.wns);
  assert.equal(call.data.slice(0, 10), '0x' + hex(keccak_256(enc.encode('text(uint256,string)'))).slice(0, 8));
  const v = enc.encode(JSON.stringify({ v: 1, cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e', to: 123 }));
  assert.deepEqual(readPointer('0x' + W(32) + W(v.length) + hex(v).padEnd(Math.ceil(v.length / 32) * 64, '0')), { cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e', to: 123 });
  assert.equal(readPointer('0x' + W(32) + W(0)), null, 'no record yet');
});

// The page, its nodes and gateways stood in for. `chain`: every log on chain; `snap`: what the snapshot holds (up to snapTo); `storage`: the pool's words.
function page({ chain, head, snap, snapTo, storage, lie = false }) {
  const asked = [];
  const record = snap ? (() => { const v = enc.encode(JSON.stringify({ v: 1, cid: snap.cid, to: snapTo })); return '0x' + W(32) + W(v.length) + hex(v).padEnd(Math.ceil(v.length / 32) * 64, '0'); })() : '0x' + W(32) + W(0);
  const node = (method, params) => {
    if (method === 'eth_blockNumber') return '0x' + head.toString(16);
    if (method === 'eth_call' && String(params[0].to).toLowerCase() === SNAPSHOT.wns.toLowerCase()) return record;
    if (method === 'eth_call') return '0x' + W(treesFor(chain).note.count);
    if (method === 'eth_getStorageAt') return storage[params[1]] ?? '0x' + W(0);
    if (method === 'eth_getLogs') {
      const a = parseInt(params[0].fromBlock, 16), b = parseInt(params[0].toBlock, 16);
      asked.push([a, b]);
      return selectLogs(chain, params[0]).filter((l) => { const n = Number(BigInt(l.blockNumber)); return n >= a && n <= b; });
    }
    return null;
  };
  const files = snap ? snap.files : new Map();
  const fetchImpl = async (url, opts) => {
    if (/\/ipfs\//.test(url)) return gatewayFetch(files, { lie: lie ? new Set(SNAPSHOT.gateways.map((g) => new URL(g).host)) : new Set() })(url);
    if (/\/pool\/snapshot$/.test(url)) return new Response('no', { status: 503 });
    const { method, params } = JSON.parse(opts.body);
    const out = node(method, params);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: out }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'mainnet', fetchImpl, logStore: null, snapshotOpts: { auditMs: 0 } });
  return { ux, asked };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test('a first read starts from a snapshot that holds: only the blocks after it are read, then its range again in the background', async () => {
  mem.clear();
  const chain = history(80);
  const head = Number(BigInt(chain[chain.length - 1].blockNumber)) + 500;
  const snapTo = Number(BigInt(chain[100].blockNumber));
  const snap = await snapshotOf(chain.filter((l) => Number(BigInt(l.blockNumber)) <= snapTo), snapTo);
  const { ux, asked } = page({ chain, head, snap, snapTo, storage: storageFor(treesFor(chain)) });
  const evs = await ux.fetchEvents();
  assert.equal(evs.filter((e) => e.type === 'LeavesInserted').length, 80);
  assert.ok(asked[0][0] === snapTo + 1, `the first log read starts after the snapshot (${asked[0][0]})`);
  await settle();
  assert.ok(asked.some(([a]) => a === Number(cfg.deployBlock)), 'its range was read again afterwards');
});

test('a snapshot whose trees differ from the pool\'s is dropped, and the page reads from launch', async () => {
  mem.clear();
  const chain = history(30);
  const head = Number(BigInt(chain[chain.length - 1].blockNumber)) + 500;
  const snapTo = Number(BigInt(chain[40].blockNumber));
  const forged = chain.filter((l) => Number(BigInt(l.blockNumber)) <= snapTo).map((l, i) => (i === 2 ? leaves(Number(BigInt(l.blockNumber)), 0, Number(BigInt(l.topics[1])), [h32(1), h32(2)]) : l));
  assert.equal(forged[2].topics[0], T.LeavesInserted);
  const snap = await snapshotOf(forged, snapTo);
  const { ux, asked } = page({ chain, head, snap, snapTo, storage: storageFor(treesFor(chain)) });
  const evs = await ux.fetchEvents();
  assert.deepEqual(evs.filter((e) => e.type === 'LeavesInserted').flatMap((e) => e.leaves), treesForLeaves(chain));
  assert.ok(asked.some(([a]) => a === Number(cfg.deployBlock)), 'read from launch');
});
const treesForLeaves = (chain) => evmLog.decodeLogs(chain).filter((e) => e.type === 'LeavesInserted').flatMap((e) => e.leaves);

test('a snapshot whose nullifiers differ from the chain\'s holds the trees, and is replaced by what the nodes say once read again', async () => {
  mem.clear();
  const chain = history(30);
  const head = Number(BigInt(chain[chain.length - 1].blockNumber)) + 500;
  const snapTo = Number(BigInt(chain[40].blockNumber));
  const dropped = chain.filter((l) => Number(BigInt(l.blockNumber)) <= snapTo && l.topics[0] !== T.NullifiersSpent);
  const snap = await snapshotOf(dropped, snapTo);
  const { ux } = page({ chain, head, snap, snapTo, storage: storageFor(treesFor(chain)) });
  const before = (await ux.fetchEvents()).filter((e) => e.type === 'NullifiersSpent').length;
  await settle();
  const after = (await ux.fetchEvents()).filter((e) => e.type === 'NullifiersSpent').length;
  assert.ok(before < after, `the nodes' nullifiers replace the snapshot's (${before} -> ${after})`);
  assert.equal(after, chain.filter((l) => l.topics[0] === T.NullifiersSpent).length);
});

test('with every gateway lying, or no record, the page reads from launch as before', async () => {
  mem.clear();
  const chain = history(10);
  const head = Number(BigInt(chain[chain.length - 1].blockNumber)) + 500;
  const snapTo = Number(BigInt(chain[10].blockNumber));
  const snap = await snapshotOf(chain.filter((l) => Number(BigInt(l.blockNumber)) <= snapTo), snapTo);
  for (const p of [page({ chain, head, snap, snapTo, storage: storageFor(treesFor(chain)), lie: true }), page({ chain, head, storage: storageFor(treesFor(chain)) })]) {
    const evs = await p.ux.fetchEvents();
    assert.equal(evs.filter((e) => e.type === 'LeavesInserted').length, 10);
    assert.equal(p.asked[0][0], Number(cfg.deployBlock));
  }
});

// tacit-api's job (worker/src/pool-snapshot-job.js) over a chain stood in for, pinning into a map the gateways serve.
const { makePoolSnapshotJob, SNAPSHOT_JOB } = await import('../worker/src/pool-snapshot-job.js');
function jobWorld(chain, { refuseOver = Infinity, cfg: over = {} } = {}) {
  const kvm = new Map(), files = new Map(), pinned = [];
  let head = 0;
  const rpc = async (method, params) => {
    if (method === 'eth_blockNumber') return '0x' + head.toString(16);
    if (method === 'eth_getLogs') {
      const a = parseInt(params[0].fromBlock, 16), b = parseInt(params[0].toBlock, 16);
      if (b - a + 1 > refuseOver) throw new Error('range too wide');
      return selectLogs(chain, params[0]).filter((l) => { const n = Number(BigInt(l.blockNumber)); return n >= a && n <= b; });
    }
    throw new Error(method);
  };
  const topics = [T.LeavesInserted, T.NullifiersSpent, T.LockLeavesInserted, T.Wrap, T.CdpPositionInserted, T.CrossOutRecorded, T.Bonded, T.Harvested];
  const job = (now) => makePoolSnapshotJob({
    kv: { get: async (k) => kvm.get(k) ?? null, put: async (k, v) => { kvm.set(k, v); } }, rpcs: [rpc],
    pin: async (b) => { const c = rawCid(b, sha256); files.set(c, b); pinned.push(c); return c; },
    fetchImpl: gatewayFetch(files), sha256, keccak256: keccak_256, decodeLogs: evmLog.decodeLogs,
    pool: cfg.pool, manager: cfg.farm.manager, deployBlock: Number(cfg.deployBlock), topics, now, cfg: { ...SNAPSHOT_JOB, final: 0, span: 200, cutChars: 3000, ...over },
  });
  return { kvm, files, pinned, job, setHead: (h) => { head = h; }, topics };
}

test('the job pins a snapshot that loads with the pool\'s trees; a later run re-pins only its last piece and the manifest', async () => {
  const chain = history(400);
  const mid = Number(BigInt(chain[300].blockNumber)), end = Number(BigInt(chain[chain.length - 1].blockNumber));
  const w = jobWorld(chain);
  w.setHead(mid + 400);
  const t0 = Date.now();
  const a = await w.job(() => t0).run();
  assert.equal(a.status, 'published');
  const first = JSON.parse(w.kvm.get('snap:state')).pieces;
  assert.ok(first.length > 2, 'several pieces');
  const on = chain.filter((l) => Number(BigInt(l.blockNumber)) <= a.to);
  assert.ok(sameTrees(JSON.parse(w.kvm.get('snap:pub')).trees, treesFor(on)), 'the manifest names the trees of the logs it holds');
  assert.equal((await w.job(() => t0 + 60_000).run()).status, 'idle', 'nothing new within the hour');
  w.setHead(end + 400);
  w.pinned.length = 0;
  const b = await w.job(() => t0 + 2 * 3600_000).run();
  assert.equal(b.status, 'published');
  const second = JSON.parse(w.kvm.get('snap:state')).pieces;
  assert.deepEqual(second.slice(0, first.length - 1), first.slice(0, -1), 'earlier pieces kept');
  assert.ok(w.pinned.length < second.length, `only the changed pieces pinned (${w.pinned.length} of ${second.length})`);
  const got = await loadSnapshot(b.cid, { fetchImpl: gatewayFetch(w.files), sha256, expect: { chainId: 1, pool: cfg.pool, addresses: [cfg.pool], topics: w.topics } });
  assert.equal(got.logs.length, chain.length);
  assert.ok(sameTrees(treesFor(got.logs), treesFor(chain)));
});

test('the job narrows a range every node refuses, and a run cut short resumes where it stopped', async () => {
  const chain = history(200);
  const end = Number(BigInt(chain[chain.length - 1].blockNumber));
  const w = jobWorld(chain, { refuseOver: 60, cfg: { minSpan: 10, budgetMs: 400 } });
  w.setHead(end + 400);
  let t = Date.now();
  const clock = () => (t += 20);
  const first = await makeShort(w, clock).run();
  assert.equal(first.status, 'behind', 'out of time before the head');
  let r = first;
  for (let i = 0; i < 400 && r.status === 'behind'; i++) r = await makeShort(w, clock).run();
  assert.equal(r.status, 'published');
  const got = await loadSnapshot(r.cid, { fetchImpl: gatewayFetch(w.files), sha256, expect: { chainId: 1, pool: cfg.pool, addresses: [cfg.pool], topics: w.topics } });
  assert.equal(got.logs.length, chain.length);
});
const makeShort = (w, now) => {
  const j = w.job(now);
  return { run: () => j.run() };
};
