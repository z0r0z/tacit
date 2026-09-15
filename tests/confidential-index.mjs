#!/usr/bin/env node
// Public pool index (worker/src/confidential-index.js), against a fake chain whose logs and settle calldata are
// encoded here by hand — not by the modules under test. Covers chain order; lock rows only for calls an event
// corroborates (a failed relayer call is dropped); direct settle and both relaySettle overloads; the confirmation
// lag; resumable windows; rewriting after a state rollback; endpoint failover; refusing to skip an unserved
// transaction; one refresh at a time; cursor paging; and the lock set checked against the pool's own
// lockNextLeafIndex/lockRoot slots — a decoy settle in a wrapper contract's calldata set aside, a nested lock an
// earlier match confirmed kept, a mismatch nothing explains, an unreadable slot, and a state stored before the
// index kept its lock rows.
//
// Run: node tests/confidential-index.mjs

import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialIndex } from '../worker/src/confidential-index.js';
import { makeConfidentialLockScan } from '../dapp/confidential-lock-scan.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const utf8 = (s) => new TextEncoder().encode(s);
const kh = (s) => '0x' + Buffer.from(keccak_256(utf8(s))).toString('hex');
const b32 = (label) => kh('b32:' + label);
const memo = (label) => kh('memo:' + label) + 'ab'; // 33 bytes, like a real note memo's leading point
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const strip = (h) => String(h).replace(/^0x/, '');
const hx = (v) => '0x' + v.toString(16);
const selector = (sig) => Buffer.from(keccak_256(utf8(sig)).subarray(0, 4)).toString('hex');

// ── independent ABI encoding ──
const encBytes = (h) => { const b = strip(h); return word(b.length / 2) + b + '0'.repeat((64 - (b.length % 64)) % 64); };
const encB32s = (xs) => word(xs.length) + xs.map((x) => strip(x).padStart(64, '0')).join('');
function encBytesArr(xs) {
  const es = xs.map(encBytes);
  let off = xs.length * 32, head = '';
  for (const e of es) { head += word(off); off += e.length / 2; }
  return word(xs.length) + head + es.join('');
}
// PublicValues as the pool decodes it: an offset word, then one head word per field. Only the four arrays the
// index reads get tails (3 nullifiers, 4 leaves, 17 lockLeaves, 18 lockNullifiers); every other word is zero.
function encPv({ nullifiers = [], leaves = [], lockLeaves = [], lockNullifiers = [] }) {
  const FIELDS = 36;
  const arrays = { 3: nullifiers, 4: leaves, 17: lockLeaves, 18: lockNullifiers };
  let head = '', tail = '';
  for (let f = 0; f < FIELDS; f++) {
    if (arrays[f]) { head += word(FIELDS * 32 + tail.length / 2); tail += encB32s(arrays[f]); }
    else head += word(0);
  }
  return '0x' + word(32) + head + tail;
}
function settleTuple({ publicValues, proof = '0x' + 'ee'.repeat(8), memos }) {
  const a = encBytes(publicValues), b = encBytes(proof), c = encBytesArr(memos);
  return word(96) + word(96 + a.length / 2) + word(96 + (a.length + b.length) / 2) + a + b + c;
}
function callsArray(calls) {
  const ts = calls.map(settleTuple);
  let off = ts.length * 32, head = '';
  for (const t of ts) { head += word(off); off += t.length / 2; }
  return word(ts.length) + head + ts.join('');
}
const SIG = {
  settle: 'settle(bytes,bytes,bytes[])',
  relay: 'relaySettle((bytes,bytes,bytes[])[],address[],uint256[],address[],uint256[])',
  seeded: 'relaySettle((bytes32,bytes32,uint32)[],(bytes,bytes,bytes[])[],address[],uint256[],address[],uint256[])',
};
const settleInput = (call) => '0x' + selector(SIG.settle) + settleTuple(call);
// Trailing relaySettle params: no fee assets, no minOuts, one recipient at 100%.
const FEE_TAIL = [word(0), word(0), word(1) + word('0x' + '11'.repeat(20)), word(1) + word(10000)];
function withHeads(sel, parts) {
  let off = parts.length * 32, head = '';
  for (const p of parts) { head += word(off); off += p.length / 2; }
  return '0x' + sel + head + parts.join('');
}
const relayInput = (calls) => withHeads(selector(SIG.relay), [callsArray(calls), ...FEE_TAIL]);
const seededInput = (calls) => withHeads(selector(SIG.seeded), [word(0), callsArray(calls), ...FEE_TAIL]);

// ── the chain ──
const POOL = '0x0000000098A73197B3255aD9db1ed8544410f5Ba';
const RELAYER = '0x00000000705D345449950e900271F27E7fEEABc5';
const WRAPPER = '0x' + '22'.repeat(20);
// Who a transaction was sent to: settle → the pool, relaySettle → the relayer, anything else → a wrapper contract.
const toOf = (input) => {
  const sel = strip(input).slice(0, 8);
  if (sel === selector(SIG.settle)) return POOL;
  return sel === selector(SIG.relay) || sel === selector(SIG.seeded) ? RELAYER : WRAPPER;
};
// The pool's lock tree is the note tree's construction over the lock leaves in append order.
const cpool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256: (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest()) });
const lockRoot = (leaves) => { const t = new cpool.Tree(); for (const l of leaves) t.insert(l); return t.root(); };
const ETH_ID = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const DEPLOY = 100;
const T = {
  leaves: kh('LeavesInserted(uint256,bytes32[],bytes[])'),
  spent: kh('NullifiersSpent(bytes32[])'),
  wrap: kh('Wrap(bytes32,bytes32,uint256)'),
};
const log = (block, logIndex, tx, topics, data) => ({ address: POOL, blockNumber: hx(block), logIndex: hx(logIndex), transactionHash: tx, topics, data: '0x' + data });
const leavesLog = (block, li, tx, first, leaves, memos) => {
  const a = encB32s(leaves);
  return log(block, li, tx, [T.leaves, '0x' + word(first)], word(64) + word(64 + a.length / 2) + a + encBytesArr(memos));
};
const spentLog = (block, li, tx, nus) => log(block, li, tx, [T.spent], word(32) + encB32s(nus));
const wrapLog = (block, li, tx, id, asset, amount) => log(block, li, tx, [T.wrap, id, asset], word(amount));

const txh = (s) => kh('tx:' + s);
const TW = txh('wrap'), T1 = txh('lock'), T2 = txh('batch'), T3 = txh('seeded'), T4 = txh('late');
const TXS = {
  [TW]: settleInput({ publicValues: encPv({ leaves: [b32('w1')] }), memos: [memo('w1')] }),
  // a lock paid for by spending a note: no ordinary leaf, so NullifiersSpent is what corroborates it
  [T1]: settleInput({ publicValues: encPv({ nullifiers: [b32('n1')], lockLeaves: [b32('L1')] }), memos: [memo('L1')] }),
  [T2]: relayInput([
    { publicValues: encPv({ nullifiers: [b32('na')], leaves: [b32('a1'), b32('a2')] }), memos: [memo('a1'), memo('a2')] },
    // the relayer's try/catch skipped this call: it is in the calldata but emitted nothing
    { publicValues: encPv({ nullifiers: [b32('nb')], leaves: [b32('b1')], lockLeaves: [b32('L2')] }), memos: [memo('b1'), memo('L2')] },
    // a claim: spends a lock nullifier, mints the claimed note
    { publicValues: encPv({ leaves: [b32('c1')], lockNullifiers: [b32('LN1')] }), memos: [memo('c1')] },
  ]),
  [T3]: seededInput([
    { publicValues: encPv({ nullifiers: [b32('ne')], leaves: [b32('e1')], lockLeaves: [b32('L3'), b32('L4')] }), memos: [memo('e1'), memo('L3'), memo('L4')] },
  ]),
  [T4]: settleInput({ publicValues: encPv({ leaves: [b32('f1')] }), memos: [memo('f1')] }),
};
const LOGS = [
  wrapLog(120, 0, TW, b32('dep1'), ETH_ID, 123456),
  leavesLog(120, 1, TW, 0, [b32('w1')], [memo('w1')]),
  spentLog(150, 0, T1, [b32('n1')]),
  spentLog(160, 2, T2, [b32('na')]),
  leavesLog(160, 3, T2, 1, [b32('a1'), b32('a2')], [memo('a1'), memo('a2')]),
  leavesLog(160, 5, T2, 3, [b32('c1')], [memo('c1')]),
  spentLog(700, 0, T3, [b32('ne')]),
  leavesLog(700, 1, T3, 4, [b32('e1')], [memo('e1')]),
  leavesLog(1098, 0, T4, 5, [b32('f1')], [memo('f1')]),
];
// The leaves the pool actually appended to its lock tree, by block, in append order: what slots 84/85 answer.
const LOCKS = [{ block: 150, leaf: b32('L1') }, { block: 700, leaf: b32('L3') }, { block: 700, leaf: b32('L4') }];
const BASE = LOCKS.map((l) => l.leaf);

function chain({ head = 1100, fail = null, extraLogs = [], extraTxs = {}, extraLocks = [] } = {}) {
  const logs = LOGS.concat(extraLogs), txs = { ...TXS, ...extraTxs }, locks = LOCKS.concat(extraLocks);
  const c = { head, seen: [] };
  c.rpc = async (method, params) => {
    c.seen.push(method);
    if (fail && fail(method, params)) throw new Error(`endpoint refused ${method}`);
    if (method === 'eth_blockNumber') return hx(c.head);
    if (method === 'eth_getLogs') {
      const f = params[0], lo = Number(BigInt(f.fromBlock)), hi = Number(BigInt(f.toBlock));
      assert.strictEqual(f.address, POOL);
      assert.ok(hi - lo + 1 <= 500, 'a window inside the range cap');
      assert.ok(hi <= c.head, 'never past the head');
      // Served newest-first: the index must order rows itself.
      return logs.filter((l) => { const b = Number(BigInt(l.blockNumber)); return b >= lo && b <= hi; }).reverse();
    }
    if (method === 'eth_getTransactionByHash') return txs[params[0]] ? { hash: params[0], input: txs[params[0]], to: toOf(txs[params[0]]) } : null;
    if (method === 'eth_getStorageAt') {
      const [addr, slot, tag] = params, at = Number(BigInt(tag));
      assert.strictEqual(addr, POOL);
      assert.ok(at <= c.head - 6, 'read at a confirmed block');
      const leaves = locks.filter((l) => l.block <= at).map((l) => l.leaf);
      if (slot === '0x54') return '0x' + word(leaves.length);
      if (slot === '0x55') return lockRoot(leaves);
      throw new Error(`unexpected slot ${slot}`);
    }
    throw new Error(`unexpected ${method}`);
  };
  return c;
}
function memStore() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } };
}
let clockT = 1000;
const now = () => clockT;
const mk = ({ rpcs, storage = memStore(), budgetMs = 1e9, page = 4, lockRootOf = lockRoot }) =>
  makeConfidentialIndex({ storage, rpcs, pool: POOL, deployBlock: DEPLOY, keccak256: keccak_256, now, page, budgetMs, lockRootOf });

assert.strictEqual(selector(SIG.settle), '717fd7f2');
assert.strictEqual(selector(SIG.relay), 'fcccb833');
assert.strictEqual(selector(SIG.seeded), 'e2b28725');

// ───────────────── 1. one refresh indexes everything past the lag, in chain order ─────────────────
let FULL;
{
  const c = chain();
  const idx = mk({ rpcs: [c.rpc] });
  await idx.refresh();
  const r = await idx.read({});
  FULL = r.entries;
  assert.strictEqual(r.indexedToBlock, 1094, 'head 1100 less the 6-block lag');
  assert.strictEqual(r.headBlock, 1100);
  assert.strictEqual(r.synced, true);
  assert.deepStrictEqual(r.entries.map((e) => e.type),
    ['wrap', 'leaves', 'nullifiers', 'locks', 'nullifiers', 'leaves', 'leaves', 'locks', 'nullifiers', 'leaves', 'locks']);
  assert.deepStrictEqual(r.entries.map((e) => e.seq), [...Array(11).keys()]);
  const locks = r.entries.filter((e) => e.type === 'locks')
    .map(({ first, lockLeaves, lockMemos, lockNullifiers, tx, via }) => ({ first, lockLeaves, lockMemos, lockNullifiers, tx, via }));
  assert.deepStrictEqual(locks, [
    { first: 0, lockLeaves: [b32('L1')], lockMemos: [memo('L1')], lockNullifiers: [], tx: T1, via: 'pool' },
    { first: 1, lockLeaves: [], lockMemos: [], lockNullifiers: [b32('LN1')], tx: T2, via: 'relayer' },
    { first: 1, lockLeaves: [b32('L3'), b32('L4')], lockMemos: [memo('L3'), memo('L4')], lockNullifiers: [], tx: T3, via: 'relayer' },
  ]);
  assert.ok(!JSON.stringify(r.entries).includes(strip(b32('L2'))), 'the skipped relayer call adds no lock');
  assert.deepStrictEqual(r.counts, { leaves: 5, nullifiers: 3, wraps: 1, crossOuts: 0, lockLeaves: 3, lockNullifiers: 1 });
  assert.deepStrictEqual(r.lockSet, { count: 3, root: lockRoot(BASE), verified: true, block: 1094 }, 'the rows reproduce the pool\'s lock tree');
  assert.ok(!r.entries.some((e) => 'excluded' in e));
  assert.deepStrictEqual(r.entries[0], { seq: 0, type: 'wrap', block: 120, tx: TW, logIndex: 0, depositId: b32('dep1'), assetId: ETH_ID, amount: '123456' });
  assert.deepStrictEqual(r.entries[5], { seq: 5, type: 'leaves', block: 160, tx: T2, logIndex: 3, first: 1, leaves: [b32('a1'), b32('a2')], memos: [memo('a1'), memo('a2')] });
  assert.strictEqual(r.entries[7].logIndex, 5, 'the claim\'s lock row follows the event that corroborated it');
  assert.ok(!r.entries.some((e) => e.tx === T4), 'a block inside the lag is not indexed yet');
  ok('one refresh: chain order, corroborated lock rows only, both relaySettle overloads, the confirmation lag, and the pool\'s lock root reproduced');

  c.head = 1200;
  clockT += 20000;
  await idx.fresh();
  const r2 = await idx.read({ from: 11 });
  assert.strictEqual(r2.entries.length, 1);
  assert.deepStrictEqual(r2.entries[0], { seq: 11, type: 'leaves', block: 1098, tx: T4, logIndex: 0, first: 5, leaves: [b32('f1')], memos: [memo('f1')] });
  assert.strictEqual(r2.counts.leaves, 6);
  assert.deepStrictEqual(r2.lockSet, { count: 3, root: lockRoot(BASE), verified: true, block: 1194 });
  ok('a later refresh appends what the head has since buried');
}

// ───────────────── 2. windows resume; a rolled-back state rewrites the same rows ─────────────────
{
  const c = chain();
  const storage = memStore();
  const idx = mk({ rpcs: [c.rpc], storage, budgetMs: 0 });
  await idx.refresh();
  let r = await idx.read({});
  assert.strictEqual(r.indexedToBlock, 599, 'one 500-block window');
  assert.strictEqual(r.synced, false);
  assert.strictEqual(r.total, 8);
  const snapshot = new Map(storage.m);
  await idx.refresh();
  r = await idx.read({});
  assert.strictEqual(r.indexedToBlock, 1094);
  assert.deepStrictEqual(r.entries, FULL);
  // A crash after the second window's pages were written but before its state was: the state reverts, the
  // newer pages stay, and the next refresh rewrites those rows in place.
  const stateKey = [...storage.m.keys()].find((k) => k.endsWith(':state'));
  storage.m.set(stateKey, snapshot.get(stateKey));
  await idx.refresh();
  r = await idx.read({});
  assert.deepStrictEqual(r.entries, FULL);
  assert.strictEqual(r.total, 11);
  ok('a refresh cut short resumes from the stored block, and a rolled-back state rewrites rows instead of duplicating them');
}

// ───────────────── 3. failover and refusals ─────────────────
{
  const dead = chain({ fail: (m) => m === 'eth_getLogs' });
  const live = chain();
  const idx = mk({ rpcs: [dead.rpc, live.rpc] });
  await idx.refresh();
  assert.deepStrictEqual((await idx.read({})).entries, FULL);

  const partial = chain({ fail: (m, p) => m === 'eth_getLogs' && Number(BigInt(p[0].fromBlock)) > 599 });
  const idx2 = mk({ rpcs: [partial.rpc, chain().rpc] });
  await idx2.refresh();
  assert.deepStrictEqual((await idx2.read({})).entries, FULL, 'the next endpoint resumes after the first one\'s stored window');

  const c = chain();
  const unserved = async (m, p) => (m === 'eth_getTransactionByHash' ? null : c.rpc(m, p));
  const idx3 = mk({ rpcs: [unserved] });
  await assert.rejects(idx3.refresh(), /was not served/);
  const r = await idx3.read({});
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.indexedToBlock, DEPLOY - 1, 'nothing is skipped past');
  ok('a failing endpoint hands over to the next, and an unserved settle tx stops the refresh rather than being skipped');
}

// ───────────────── 4. one refresh at a time; freshness ─────────────────
{
  const c = chain();
  const idx = mk({ rpcs: [c.rpc] });
  const a = idx.refresh(), b = idx.refresh();
  assert.strictEqual(a, b, 'concurrent callers share one refresh');
  await a;
  assert.strictEqual(c.seen.filter((m) => m === 'eth_blockNumber').length, 1);
  c.seen.length = 0;
  clockT += 5000;
  await idx.fresh();
  assert.strictEqual(c.seen.length, 0, 'fresh enough: no RPC');
  clockT += 12001;
  await idx.fresh();
  assert.ok(c.seen.includes('eth_blockNumber'));
  ok('one refresh at a time, and none while the index is fresh');
}

// ───────────────── 5. paging ─────────────────
{
  const idx = mk({ rpcs: [chain().rpc] });
  await idx.refresh();
  let r = await idx.read({ from: 2, limit: 3 });
  assert.deepStrictEqual(r.entries.map((e) => e.seq), [2, 3, 4]);
  assert.strictEqual(r.next, 5);
  r = await idx.read({ from: 9 });
  assert.deepStrictEqual(r.entries.map((e) => e.seq), [9, 10]);
  assert.strictEqual(r.next, 11);
  r = await idx.read({ from: 99 });
  assert.deepStrictEqual(r.entries, []);
  assert.strictEqual(r.next, 11);
  r = await idx.read({ from: 'x', limit: 5000 });
  assert.strictEqual(r.entries.length, 11);
  ok('the cursor pages across storage pages and clamps a bad cursor or limit');
}

// ───────────────── 6. the PublicValues reader agrees with the dapp decoder ─────────────────
{
  const idx = mk({ rpcs: [] });
  const pv = encPv({ nullifiers: [b32('x')], leaves: [b32('y'), b32('z')], lockLeaves: [b32('L')], lockNullifiers: [b32('N')] });
  const mine = idx.pvFields(pv);
  const dapp = makeConfidentialLockScan({ pool: null }).decodePublicValuesLockFields(pv);
  assert.deepStrictEqual(mine.nullifiers, dapp.nullifiers);
  assert.deepStrictEqual(mine.leaves, dapp.leaves);
  assert.deepStrictEqual(mine.lockLeaves, dapp.lockLeaves);
  assert.deepStrictEqual(mine.lockNullifiers, [b32('N')]);
  assert.throws(() => idx.pvFields('0x' + word(32) + word(0)), /too short/);
  assert.throws(() => idx.pvFields('0x' + word(32) + word(36 * 32).repeat(36) + word(2n ** 200n)), /overruns/);
  await assert.rejects(idx.refresh(), /no RPC endpoint/);
  ok('the index reads the same PublicValues fields the dapp lock scanner does, and refuses a malformed one');
}

// ───────────────── 7. a settle nested in another contract's call ─────────────────
{
  // What a searcher's (or a smart account's) resend looks like: its own selector, then the relay's settle
  // calldata carried as a `bytes` argument.
  const wrap = (inner) => '0x' + selector('execute(address,uint256,bytes)') + word('0x' + '22'.repeat(20)) + word(0) + word(96) + encBytes(inner);
  const TN = txh('nested'), TG = txh('nested-ghost');
  const claim = { publicValues: encPv({ leaves: [b32('g1')], lockNullifiers: [b32('LN2')] }), memos: [memo('g1')] };
  const ghost = { publicValues: encPv({ nullifiers: [b32('ng')], lockLeaves: [b32('L9')] }), memos: [memo('L9')] };
  const c = chain({
    extraTxs: { [TN]: wrap(settleInput(claim)), [TG]: wrap(settleInput(ghost)) },
    // The ghost's transaction emits an event, but not one its nested call would have produced.
    extraLogs: [leavesLog(800, 0, TN, 5, [b32('g1')], [memo('g1')]), spentLog(801, 0, TG, [b32('someone-else')])],
  });
  const idx = mk({ rpcs: [c.rpc] });
  await idx.refresh();
  const r = await idx.read({});
  const nested = r.entries.filter((e) => e.tx === TN);
  assert.deepStrictEqual(nested.map((e) => e.type), ['leaves', 'locks']);
  assert.deepStrictEqual(nested[1].lockNullifiers, [b32('LN2')]);
  assert.deepStrictEqual(nested[1].lockLeaves, []);
  assert.ok(!JSON.stringify(r.entries).includes(strip(b32('L9'))), 'an uncorroborated nested call adds nothing');
  assert.strictEqual(r.counts.lockNullifiers, 2);
  assert.strictEqual(nested[1].via, 'nested');
  assert.strictEqual(r.lockSet.verified, true);

  const scan = makeConfidentialLockScan({ pool: null });
  assert.strictEqual(scan.decodeNestedSettles(settleInput(claim)).length, 0, 'a direct settle is not a nested one');
  // An aligned settle selector whose memo count is absurd is dropped without decoding.
  const hostile = '0x' + 'aabbccdd' + word(0) + selector(SIG.settle) + word(96) + word(128) + word(160) + word(0) + word(0) + word(2n ** 200n);
  assert.deepStrictEqual(scan.decodeNestedSettles(hostile), []);
  ok('a settle nested in another contract\'s call is found and corroborated like a direct one; junk is dropped');
}

// ── contract calldata carrying settles ──
const multicall = (inputs) => '0x' + selector('multicall(bytes[])') + word(32) + encBytesArr(inputs);
// An account's execute(pool, 0, settle) under an outer entry call: two selectors ahead of the settle, which so
// starts 4 bytes past a word boundary.
const viaAccount = (inner) => {
  const exec = '0x' + selector('execute(address,uint256,bytes)') + word(POOL) + word(0) + word(96) + encBytes(inner);
  return '0x' + selector('handleOp(bytes)') + word(32) + encBytes(exec);
};
// A settle that spends a note and appends one lock leaf, sent to the pool or wrapped.
const lockTx = (label, block, wrap = (x) => x) => ({
  tx: { [txh(label)]: wrap(settleInput({ publicValues: encPv({ nullifiers: [b32('n-' + label)], lockLeaves: [b32(label)] }), memos: [memo(label)] })) },
  log: spentLog(block, 0, txh(label), [b32('n-' + label)]),
  lock: { block, leaf: b32(label) },
});
// A contract that forwards `real` (an ordinary transfer) and carries, ahead of it, a decoy with the same leaves,
// memos and nullifiers plus a lock leaf the pool never appended.
const real = { publicValues: encPv({ nullifiers: [b32('nr')], leaves: [b32('r1')] }), memos: [memo('r1')] };
const decoy = { publicValues: encPv({ nullifiers: [b32('nr')], leaves: [b32('r1')], lockLeaves: [b32('FAKE')] }), memos: [memo('r1'), memo('FAKE')] };
const forgedAt = (label, block) => ({
  tx: { [txh(label)]: multicall([settleInput(decoy), settleInput(real)]) },
  logs: [spentLog(block, 0, txh(label), [b32('nr')]), leavesLog(block, 1, txh(label), 5, [b32('r1')], [memo('r1')])],
});
const lockRows = (r) => r.entries.filter((e) => e.type === 'locks');
const keptLeaves = (r) => lockRows(r).filter((e) => !e.excluded).flatMap((e) => e.lockLeaves);

// ───────────────── 8. a decoy in a wrapper contract's calldata is set aside by the pool's own lock root ─────────────────
{
  const F = forgedAt('forged', 800), L5 = lockTx('L5', 900), L6 = lockTx('L6', 1150, viaAccount);
  const c = chain({ extraTxs: { ...F.tx, ...L5.tx, ...L6.tx }, extraLogs: [...F.logs, L5.log, L6.log], extraLocks: [L5.lock, L6.lock] });
  const idx = mk({ rpcs: [c.rpc] });
  await idx.refresh();
  let r = await idx.read({});
  const want = [...BASE, b32('L5')];
  assert.deepStrictEqual(r.lockSet, { count: 4, root: lockRoot(want), verified: true, block: 1094 });
  assert.deepStrictEqual(lockRows(r).map((e) => [e.via, e.first, e.excluded === true]),
    [['pool', 0, false], ['relayer', 1, false], ['relayer', 1, false], ['nested', 3, true], ['pool', 3, false]]);
  assert.deepStrictEqual(lockRows(r).find((e) => e.tx === txh('forged')).lockLeaves, [b32('FAKE')], 'the excluded row stays in the stream');
  assert.deepStrictEqual(keptLeaves(r), want);
  assert.ok(!keptLeaves(r).includes(b32('FAKE')), 'the decoy\'s leaf is not in the lock set');
  assert.deepStrictEqual(r.counts, { leaves: 6, nullifiers: 5, wraps: 1, crossOuts: 0, lockLeaves: 4, lockNullifiers: 1 }, 'an excluded row is out of the counts');
  const l5 = lockRows(r).find((e) => e.tx === txh('L5'));
  assert.strictEqual((await idx.read({ from: l5.seq, limit: 1 })).entries[0].first, 3, 'positions skip the excluded row on any page');
  ok('a decoy blob ahead of a wrapper\'s real call wins corroboration, and the pool\'s lock root sets it aside');

  c.head = 1200;
  clockT += 20000;
  await idx.fresh();
  r = await idx.read({});
  assert.deepStrictEqual(r.lockSet, { count: 5, root: lockRoot([...want, b32('L6')]), verified: true, block: 1194 });
  const last = lockRows(r).at(-1);
  assert.deepStrictEqual([last.via, last.first, last.excluded, last.lockLeaves], ['nested', 4, undefined, [b32('L6')]]);
  assert.strictEqual(lockRows(r).find((e) => e.tx === txh('forged')).excluded, true);
  assert.strictEqual(r.counts.lockLeaves, 5);
  ok('the exclusion holds, and a later nested lock the pool did append (4 bytes past a word boundary) is kept');
}

// ───────────────── 9. a nested lock an earlier match confirmed is not set aside with a later decoy ─────────────────
{
  const L6 = lockTx('L6', 750, viaAccount), F = forgedAt('forged-late', 1150), L7 = lockTx('L7', 1160);
  const c = chain({ extraTxs: { ...L6.tx, ...F.tx, ...L7.tx }, extraLogs: [L6.log, ...F.logs, L7.log], extraLocks: [L6.lock, L7.lock] });
  const idx = mk({ rpcs: [c.rpc] });
  await idx.refresh();
  let r = await idx.read({});
  assert.strictEqual(r.lockSet.verified, true);
  assert.deepStrictEqual(keptLeaves(r), [...BASE, b32('L6')]);
  c.head = 1200;
  clockT += 20000;
  await idx.fresh();
  r = await idx.read({});
  const want = [...BASE, b32('L6'), b32('L7')];
  assert.deepStrictEqual(r.lockSet, { count: 5, root: lockRoot(want), verified: true, block: 1194 });
  assert.deepStrictEqual(lockRows(r).filter((e) => e.via === 'nested').map((e) => [e.lockLeaves[0], e.excluded === true]),
    [[b32('L6'), false], [b32('FAKE'), true]]);
  assert.deepStrictEqual(keptLeaves(r), want);
  ok('only nested rows past the last matching check are candidates to set aside');
}

// ───────────────── 10. a mismatch that setting nested rows aside does not explain ─────────────────
{
  const F = forgedAt('forged', 800);
  // A lock-only call that spends nothing emits no event, so the pool has a leaf the index has no row for.
  const c = chain({ extraTxs: F.tx, extraLogs: F.logs, extraLocks: [{ block: 900, leaf: b32('unseen') }] });
  const idx = mk({ rpcs: [c.rpc] });
  await idx.refresh();
  const r = await idx.read({});
  assert.deepStrictEqual(r.lockSet, { count: 4, root: lockRoot([...BASE, b32('unseen')]), verified: false, block: 1094 });
  assert.ok(!r.entries.some((e) => 'excluded' in e), 'nothing is set aside when that does not reproduce the root');
  assert.deepStrictEqual(keptLeaves(r), [...BASE, b32('FAKE')]);
  assert.strictEqual(r.counts.lockLeaves, 4);
  ok('a mismatch nothing explains reads verified false and excludes nothing');
}

// ───────────────── 11. an unreadable slot, or no tree function, never holds up indexing ─────────────────
{
  let down = true;
  const c = chain({ fail: (m) => down && m === 'eth_getStorageAt' });
  const idx = mk({ rpcs: [c.rpc] });
  await idx.refresh();
  let r = await idx.read({});
  assert.deepStrictEqual(r.entries, FULL);
  assert.strictEqual(r.indexedToBlock, 1094);
  assert.deepStrictEqual(r.lockSet, { count: null, root: null, verified: null, block: 1094 });
  down = false;
  clockT += 20000;
  await idx.fresh();
  r = await idx.read({});
  assert.strictEqual(r.lockSet.verified, true, 'the next refresh checks again');

  const c2 = chain();
  const idx2 = mk({ rpcs: [c2.rpc], lockRootOf: null });
  await idx2.refresh();
  r = await idx2.read({});
  assert.deepStrictEqual(r.entries, FULL);
  assert.deepStrictEqual(r.lockSet, { count: null, root: null, verified: null, block: 1094 });
  assert.ok(!c2.seen.includes('eth_getStorageAt'), 'no tree function: the slots are not read');
  ok('a storage read error or a missing tree function leaves the check unanswered and the index complete');
}

// ───────────────── 12. a state stored before the index kept its lock rows ─────────────────
{
  const F = forgedAt('forged', 800);
  const c = chain({ extraTxs: F.tx, extraLogs: F.logs });
  const storage = memStore();
  const idx = mk({ rpcs: [c.rpc], storage });
  await idx.refresh();
  const before = await idx.read({});
  assert.strictEqual(before.lockSet.verified, true);
  // What an earlier version stored: no lock record or check in the state, no `via` on the rows.
  for (const [k, v] of storage.m) {
    if (k.endsWith(':state')) {
      const { locks, lockExclude, lockAnchor, lockSet, ...old } = JSON.parse(v);
      storage.m.set(k, JSON.stringify(old));
    } else storage.m.set(k, JSON.stringify(JSON.parse(v).map(({ via, ...row }) => row)));
  }
  const old = await idx.read({});
  assert.ok(old.entries.every((e) => !('via' in e) && !('excluded' in e)));
  assert.deepStrictEqual(old.lockSet, { count: null, root: null, verified: null, block: null });
  clockT += 20000;
  await idx.fresh();
  const after = await idx.read({});
  assert.deepStrictEqual(after.entries, before.entries);
  assert.deepStrictEqual(after.counts, before.counts);
  assert.deepStrictEqual(after.lockSet, before.lockSet);
  ok('an older stored state is brought up once: lock record rebuilt from its rows, `via` read back, check rerun');
}

console.log(`\n${n} confidential-index checks passed.`);
