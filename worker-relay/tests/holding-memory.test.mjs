// The holding reward on a pool as big as Base's (2026-10-31: 134,304 leaves and 263,270 spent notes, about 7,000 more leaves a day). The points service runs in a
// heap of about 256 MB, and three things it does with a pool each held every one of its events as rows at once (the state at a snapshot, the check of the events
// read, and a client's read of the snapshot, which also kept the object it made the text from, up to sixteen of them): from 2026-10-30 it ran out of heap about
// twice a day, a minute after somebody read a snapshot. They now read the events one at a time and keep only the text that is sent, to a size. This checks that
// nothing the service answers has changed (against the state function and the handler as they were), that what is kept is bounded, and that a pool larger than
// Base's is read and answered inside a heap of 96 MB, where the old code needed over 256.
//   node worker-relay/tests/holding-memory.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import v8 from 'node:v8';
import { openStore } from '../src/lib/points-store.js';
import { poolStateAt, isZero, emptyRootOf, HoldingStateError } from '../src/lib/holding-state.js';
import { smtRoot } from '../src/lib/evm-pool-snapshot.js';
import { createHolding } from '../src/lib/holding-service.js';

const POOL = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';
const ZERO = `0x${'0'.repeat(64)}`;
const stubHash = (xs) => xs.reduce((a, x) => (a * 1_000_003n + BigInt(x) + 1n) % (1n << 61n), 7n);
const vk = { protocol: 'groth16', nPublic: 7 };
const hexWords = (n) => { const b = randomBytes(32 * n); return Array.from({ length: n }, (_, i) => `0x${b.toString('hex', i * 32, i * 32 + 32)}`); };

// A pool's events as the store keeps them: `events` of them, each with two spent notes, every other one inserting a pair of leaves, in (block, logIndex) order.
function* syntheticEvents(events) {
  let size = 0;
  const per = 5;
  for (let i = 0; i < events; i += 2000) {
    const n = Math.min(2000, events - i), w = hexWords(n * per);
    for (let j = 0; j < n; j++) {
      const at = i + j, leaves = at % 2 === 0;
      yield { block: 1000 + Math.floor(at / 3), logIndex: at % 3, firstIndex: String(leaves ? size : 0), outLeaf0: leaves ? w[j * per] : ZERO, outLeaf1: leaves ? w[j * per + 1] : ZERO,
        nf0: w[j * per + 2], nf1: w[j * per + 3], newRoot: w[j * per + 4] };
      if (leaves) size += 2;
    }
  }
}
const batches = function* (it, n = 5000) { let b = []; for (const e of it) { b.push(e); if (b.length === n) { yield b; b = []; } } if (b.length) yield b; };

// poolStateAt as it was before: every event copied, parsed and sorted.
function oldPoolStateAt({ events, block, hash, emptyRoot, nfRoot = true }) {
  const sorted = [...events].map((e) => ({
    block: Number(e.block), logIndex: Number(e.logIndex), firstIndex: BigInt(e.firstIndex), leaves: [BigInt(e.outLeaf0), BigInt(e.outLeaf1)],
    nfs: [BigInt(e.nf0), BigInt(e.nf1)], newRoot: BigInt(e.newRoot),
  })).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  let root = BigInt(emptyRoot), size = 0n;
  const nullifiers = [];
  for (const e of sorted) {
    if (e.block > block) break;
    if (e.leaves[0] !== 0n || e.leaves[1] !== 0n) {
      if (e.firstIndex !== size) throw new HoldingStateError(`Transact at index ${e.firstIndex} in block ${e.block}, expected ${size}: an event is missing`);
      size += 2n;
    }
    root = e.newRoot;
    for (const nf of e.nfs) if (nf !== 0n) nullifiers.push(nf);
  }
  if (new Set(nullifiers).size !== nullifiers.length) throw new HoldingStateError('a nullifier appears twice');
  return { block, root, size: Number(size), nullifiers, nfRoot: nfRoot ? smtRoot(nullifiers, hash) : null };
}
const outcome = (f) => { try { return { ok: f() }; } catch (e) { return { err: `${e.constructor.name}: ${e.message}` }; } };

// ── the child: a pool bigger than Base's, in a heap of 96 MB ──
if (process.argv[2] === '--big') {
  const EVENTS = 150_000, CHAIN = 8453, EPOCH = 20800;
  const dir = mkdtempSync(join(tmpdir(), 'holdmem-'));
  try {
    const store = openStore(join(dir, 'big.db'));
    let last = 0;
    for (const b of batches(syntheticEvents(EVENTS))) { store.saveHoldingEvents(CHAIN, b); last = b[b.length - 1].block; }
    const leaves = EVENTS, spent = EVENTS * 2;       // every other event inserts a pair of leaves, and every event spends two notes
    const stats = { events: EVENTS, leaves, spent };
    const mb = (n) => Math.round(n / 1048576);
    const emptyRoot = emptyRootOf(stubHash);
    let t = performance.now();
    const state = poolStateAt({ events: store.holdingEventsIter(CHAIN, last), ordered: true, block: last, hash: stubHash, emptyRoot, nfRoot: false });
    stats.stateMs = Math.round(performance.now() - t);
    assert.equal(state.size, leaves);
    assert.equal(state.nullifiers.length, spent);
    stats.heapAfterStateMB = mb(v8.getHeapStatistics().used_heap_size);
    state.nullifiers.length = 0;

    const holding = createHolding({ store, hash: stubHash, groth16: {}, nowSec: () => EPOCH * 86400, log: () => {}, clients: {}, cfg: { enabled: true, rate: 500, buckets: [1n], pool: POOL, vkey: vk, chains: [{ chainId: CHAIN, deployBlock: 1 }] } });
    for (const epoch of [EPOCH, EPOCH + 1, EPOCH + 2]) store.saveHoldingSnapshot({ epoch, chainId: CHAIN, block: last, moment: 1, root: '1', nfRoot: '2', size: leaves, nullifiers: spent, takenAt: 1 });
    t = performance.now();
    const r = holding.nullifiers(CHAIN, EPOCH, { client: 'a' });
    stats.textMs = Math.round(performance.now() - t);
    assert.equal(r.status, 200);
    stats.textMB = mb(r.bytes.length);
    const count = (b) => { let n = 0, i = -1; while ((i = b.indexOf('"0x', i + 1)) !== -1) n += 1; return n; };
    assert.equal(count(r.bytes), leaves + spent, 'every leaf and every spent note is in the answer');
    stats.heapAfterTextMB = mb(v8.getHeapStatistics().used_heap_size);
    t = performance.now();
    assert.equal(holding.nullifiers(CHAIN, EPOCH, { client: 'b' }).bytes, r.bytes);
    stats.cachedMs = Math.round(performance.now() - t);
    // two more snapshots read in a row, as two clients (or one asking for two days) do: what is kept stays within its size
    assert.equal(holding.nullifiers(CHAIN, EPOCH + 1, { client: 'c' }).status, 200);
    assert.equal(holding.nullifiers(CHAIN, EPOCH + 2, { client: 'd' }).status, 200);
    stats.heapAfterThreeMB = mb(v8.getHeapStatistics().used_heap_size);
    stats.maxRssMB = mb(process.resourceUsage().maxRSS * 1024);
    process.stdout.write(`${JSON.stringify(stats)}\n`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  process.exit(0);
}

let n = 0;
const ok = (s) => { n += 1; console.log(`ok - ${s}`); };

// ── isZero ──
for (const x of [ZERO, '0x0', '0x00', '0X00', '0', '000', 0n]) assert.equal(isZero(x), true, String(x));
for (const x of ['0x1', `0x${'0'.repeat(63)}1`, '10', '0010', '0x10', 1n, 2n ** 253n, `0x${'f'.repeat(64)}`]) assert.equal(isZero(x), false, String(x));
for (const x of [ZERO, '0x0', '0', '0010', '0x10', 5n, 0n]) assert.equal(isZero(x), BigInt(x) === 0n, `agrees with BigInt: ${String(x)}`);
ok('a zero word is told from any other without making a bigint, in hex, in decimal text and as a bigint');

// ── poolStateAt: the same state, and the same refusals, as before ──
{
  const emptyRoot = emptyRootOf(stubHash);
  const events = [...syntheticEvents(600)];
  const want = (over = {}) => outcome(() => oldPoolStateAt({ events, block: 99999, hash: stubHash, emptyRoot, ...over }));
  const got = (over = {}, input = events, ordered = true) => outcome(() => poolStateAt({ events: input, ordered, block: 99999, hash: stubHash, emptyRoot, ...over }));
  assert.deepEqual(got(), want(), 'events in order, read as they come');
  const shuffled = events.map((e, i) => [Math.sin(i * 12.9898) * 43758.5453 % 1, e]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  assert.deepEqual(got({}, shuffled, false), want(), 'events in any order, sorted first');
  assert.deepEqual(got({ block: 1100 }), want({ block: 1100 }), 'the state at an earlier block');
  assert.deepEqual(got({ nfRoot: false }).ok.nfRoot, null);
  assert.deepEqual(got({ block: 5 }, []), outcome(() => oldPoolStateAt({ events: [], block: 5, hash: stubHash, emptyRoot })), 'an empty pool is the empty tree');
  const missing = events.filter((_, i) => i !== 40);
  assert.deepEqual(got({}, missing), outcome(() => oldPoolStateAt({ events: missing, block: 99999, hash: stubHash, emptyRoot })), 'an event missing from the middle is refused with the same words');
  assert.match(got({}, missing).err, /an event is missing/);
  const twice = events.map((e, i) => (i === 7 ? { ...e, nf0: events[3].nf0 } : e));
  assert.deepEqual(got({}, twice), outcome(() => oldPoolStateAt({ events: twice, block: 99999, hash: stubHash, emptyRoot })), 'a spent note twice is refused with the same words');
  assert.match(got({}, twice).err, /appears twice/);
  const both = twice.filter((_, i) => i !== 200);
  assert.match(got({}, both).err, /an event is missing/, 'a missing event is said before a repeated one, as it was');
  assert.deepEqual(got({}, both), outcome(() => oldPoolStateAt({ events: both, block: 99999, hash: stubHash, emptyRoot })));
  const asBig = events.map((e) => ({ ...e, firstIndex: BigInt(e.firstIndex), outLeaf0: BigInt(e.outLeaf0), outLeaf1: BigInt(e.outLeaf1), nf0: BigInt(e.nf0), nf1: BigInt(e.nf1), newRoot: BigInt(e.newRoot) }));
  assert.deepEqual(got({}, asBig), want(), 'bigints are read as before');
  let closed = false;
  function* source() { try { yield* missing; } finally { closed = true; } }
  assert.equal(got({}, source()).err.includes('an event is missing'), true);
  assert.equal(closed, true, 'a refusal lets go of the rows it was reading');
  ok('the state at a snapshot, and every refusal, are what they were, read in order or sorted');
}

// ── the real store's iterator: a refusal lets go of it ──
{
  const d = mkdtempSync(join(tmpdir(), 'holdmem-'));
  try {
    const st = openStore(join(d, 'i.db'));
    const evs = [...syntheticEvents(60)].filter((_, i) => i !== 20);          // one event missing from the middle
    st.saveHoldingEvents(1, evs);
    const last = evs[evs.length - 1].block;
    const refused = outcome(() => poolStateAt({ events: st.holdingEventsIter(1, last), ordered: true, block: last, hash: stubHash, emptyRoot: emptyRootOf(stubHash), nfRoot: false }));
    assert.match(refused.err, /an event is missing/);
    assert.equal(st.holdingEvents(1).length, 59, 'the statement is free again (it is busy while an iterator is open)');
    assert.equal([...st.holdingEventsIter(1, last)].length, 59);
    assert.deepEqual([...st.holdingEventsIter(1, last)].map((e) => [e.block, e.logIndex]), st.holdingEvents(1).map((e) => [e.block, e.logIndex]), 'the same rows in the same order');
    ok('a refused state lets go of the rows it was reading, and the iterator gives the rows holdingEvents gives');
  } finally { rmSync(d, { recursive: true, force: true }); }
}

// ── the handler: the same text, kept to a size ──
const dir = mkdtempSync(join(tmpdir(), 'holdmem-'));
try {
  const CHAIN = 1, EPOCH = 20800;
  const mk = (store, over = {}) => createHolding({ store, hash: stubHash, groth16: {}, nowSec: () => EPOCH * 86400, log: () => {}, clients: {}, cfg: { enabled: true, rate: 500, buckets: [1n], pool: POOL, vkey: vk, chains: [{ chainId: CHAIN, deployBlock: 1 }], ...over } });
  const store = openStore(join(dir, 's.db'));
  const events = [...syntheticEvents(900)];
  // the awkward rows too: a pair with only its second leaf, spends with no leaves, an event that moves nothing, decimal text from bigints
  events[10] = { ...events[10], outLeaf0: ZERO, outLeaf1: events[10].outLeaf0 === ZERO ? ZERO : events[10].outLeaf0 };
  events[11] = { ...events[11], nf0: ZERO, nf1: ZERO };
  events[12] = { ...events[12], nf0: BigInt(events[12].nf0) };          // stored as decimal text, which the answer carries as it is
  for (const b of batches(events, 300)) store.saveHoldingEvents(CHAIN, b);
  const last = events[events.length - 1].block;
  const leaves = events.filter((e) => !isZero(e.outLeaf0) || !isZero(e.outLeaf1)).length * 2;
  const spent = events.reduce((s, e) => s + (isZero(e.nf0) ? 0 : 1) + (isZero(e.nf1) ? 0 : 1), 0);
  const snap = { epoch: EPOCH, chainId: CHAIN, block: last, moment: 5, root: '123', nfRoot: '456', size: leaves, nullifiers: spent, takenAt: 1 };
  assert.equal(store.saveHoldingSnapshot(snap), true);
  const holding = mk(store);
  // the text as the handler made it before: the rows as an array, an object of them, JSON.stringify
  const before = (s) => {
    const nfs = [], lv = [];
    for (const e of store.holdingEvents(s.chainId, s.block)) {
      for (const nf of [e.nf0, e.nf1]) if (BigInt(nf) !== 0n) nfs.push(nf);
      if (BigInt(e.outLeaf0) !== 0n || BigInt(e.outLeaf1) !== 0n) lv.push(e.outLeaf0, e.outLeaf1);
    }
    return JSON.stringify({ epoch: s.epoch, chainId: s.chainId, block: s.block, root: s.root, nfRoot: s.nfRoot, size: s.size, leaves: lv, nullifiers: nfs });
  };
  const r = holding.nullifiers(CHAIN, EPOCH, { client: 'a' });
  assert.equal(r.status, 200);
  assert.equal(Buffer.isBuffer(r.bytes), true);
  assert.equal(r.bytes.toString(), before(snap), 'what is sent is byte for byte what it was');
  assert.equal(r.text, before(snap), 'and so is the text, made when asked for');
  assert.deepEqual(JSON.parse(r.text).leaves.length, leaves);
  assert.deepEqual(JSON.parse(r.text).nullifiers.length, spent);
  const again = holding.nullifiers(CHAIN, EPOCH, { client: 'b' });
  assert.equal(again.bytes, r.bytes, 'built once for a snapshot that never changes');
  assert.equal(again.text, r.text);
  assert.equal(again.body, r.body, 'one object for a snapshot, made when asked for');
  assert.deepEqual(r.body, JSON.parse(r.text));
  assert.deepEqual(Object.keys(r), ['status', 'bytes'], 'the string and the object are not made by anything that only copies the reply');
  assert.deepEqual(Object.keys({ ...r }), ['status', 'bytes']);
  const src = readFileSync(new URL('../src/points-indexer.js', import.meta.url), 'utf8');
  assert.match(src, /res\.end\(r\.bytes \?\? r\.text \?\? JSON\.stringify\(r\.body\)\)/, 'the route sends the bytes, not a string made of them');
  ok('a client reads the same bytes as before, the string and the object only when they are asked for, and the route sends the bytes');

  const wrong = { ...snap, epoch: EPOCH + 1, size: leaves + 2 };
  store.saveHoldingSnapshot(wrong);
  assert.equal(holding.nullifiers(CHAIN, EPOCH + 1, { client: 'c' }).status, 500, 'events that do not give the snapshot are not served');
  assert.equal(holding.nullifiers(CHAIN, EPOCH + 9, { client: 'c' }).status, 404);
  ok('events that do not give the snapshot are still refused');

  // what is kept: room for two texts, five snapshots read, the earliest read go first
  const bytes = r.bytes.length;
  const small = openStore(join(dir, 'c.db'));
  for (const b of batches(events, 300)) small.saveHoldingEvents(CHAIN, b);
  for (let i = 0; i < 5; i++) small.saveHoldingSnapshot({ ...snap, epoch: EPOCH + i });
  let reads = 0;
  const iter = small.holdingEventsIter;
  small.holdingEventsIter = (...a) => { reads += 1; return iter(...a); };
  const lru = mk(small, { bodyCacheBytes: bytes * 2 + 100, readBurst: 1000, readsPerMin: 1000, allReadsPerMin: 1000 });
  const get = (e) => lru.nullifiers(CHAIN, EPOCH + e, { client: 'x' });
  for (let e = 0; e < 5; e++) assert.equal(get(e).status, 200);
  assert.equal(reads, 5, 'each snapshot is built once');
  get(4); get(3);
  assert.equal(reads, 5, 'the two read last are kept');
  get(0);
  assert.equal(reads, 6, 'one let go long ago is built again');
  get(3);
  assert.equal(reads, 6, 'the one read more recently of the two kept stays');
  get(4);
  assert.equal(reads, 7, 'and the one read less recently was the one to go');
  ok('what is kept of the snapshots read is bounded, the one read longest ago going first');
} finally { rmSync(dir, { recursive: true, force: true }); }

// ── a pool larger than Base's, in a heap of 96 MB ──
{
  const t = performance.now();
  const run = spawnSync(process.execPath, ['--max-old-space-size=96', fileURLToPath(import.meta.url), '--big'], { encoding: 'utf8', timeout: 600_000, maxBuffer: 1 << 20 });
  const out = (run.stdout || '').trim().split('\n').pop();
  assert.equal(run.status, 0, `the heap of 96 MB held (exit ${run.status}${run.signal ? `, ${run.signal}` : ''}): ${(run.stderr || '').split('\n').filter((l) => /FATAL|heap|Error/.test(l)).slice(0, 2).join(' | ')}`);
  const s = JSON.parse(out);
  assert.equal(s.leaves, 150_000);
  assert.equal(s.spent, 300_000);
  ok(`${s.leaves.toLocaleString('en-US')} leaves and ${s.spent.toLocaleString('en-US')} spent notes in a heap of 96 MB: state ${s.stateMs} ms, text ${s.textMB} MB in ${s.textMs} ms, again from what is kept in ${s.cachedMs} ms; heap in use ${s.heapAfterStateMB} MB after the state, ${s.heapAfterTextMB} after the text, ${s.heapAfterThreeMB} after three snapshots; peak resident ${s.maxRssMB} MB; ${Math.round((performance.now() - t) / 1000)} s with the pool made`);
}

console.log(`\n${n} holding-memory checks passed`);
