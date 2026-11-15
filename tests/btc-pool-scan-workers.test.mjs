// The first read of the Bitcoin pool's note feed in workers (dapp/btc-pool-scan-worker.js, btc-pool-scan-workers.js, and the `scanWorkers` option of makePoolClient): the leaves are read
// for the wallet by a few workers running the pool's own receive, the page reads only the leaves they do not answer, and whatever the workers do, fail to do or take too long over,
// scanMine returns exactly the notes a read with none returns, in the same form.
//   node --test tests/btc-pool-scan-workers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { makeBtcShieldedPool } from '../dapp/btc-shielded-pool.js';
import { makePoolClient } from '../dapp/btc-pool-client.js';
import { makeBtcScanWorkers } from '../dapp/btc-pool-scan-workers.js';

const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256, ripemd160 });
const ASSET = '0x' + 'ab'.repeat(32);
const seed = (n, m) => Uint8Array.from({ length: 32 }, (_, i) => (n + i * m) & 255);
const alice = () => pool.walletFromSeed(seed(7, 1), 'signet'), A = alice();
const stranger = pool.walletFromSeed(seed(200, 255), 'signet');
const json = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
const pick = (w) => Object.fromEntries(['v', 'vInt', 'A', 'N', 'n', 'a'].filter((k) => w[k] != null).map((k) => [k, w[k]]));
let e = 1n;
const noteTo = (address, value) => { const o = pool.createNote(address, ASSET, value, { network: 'signet', e: e++ + 9000n }); return { leaf: o.leaf, asset: o.asset, pkEph: o.pkEph, ctNote: o.ctNote }; };
const bad = [
  (f) => ({ ...f, pkEph: '0x04' + f.pkEph.slice(4) }),                       // not a compressed key
  (f) => ({ ...f, pkEph: f.pkEph.slice(0, 40) }),                            // too short
  (f) => ({ ...f, ctNote: f.ctNote.slice(0, 20) }),                          // sealed value too short
  (f) => ({ ...f, ctNote: '0x' + 'zz'.repeat(24) }),                         // not hex
  (f) => ({ ...f, ctNote: f.ctNote.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }),   // the tag does not hold
  (f) => ({ ...f, pkEph: undefined }),
];
const N = 150;
const feed = Array.from({ length: N }, (_, i) => {
  const to = i % 13 === 4 || i === 100 ? A.address : i % 29 === 9 ? A.internalAddress : stranger.address;
  let f = { leafIndex: i, txid: 'cd'.repeat(32), height: 100 + i, ...noteTo(to, BigInt(1000 + i)) };
  if (i % 17 === 5) f = { ...bad[(i / 17 | 0) % bad.length](f), leafIndex: i, txid: f.txid, height: f.height };
  if (i === 100) f.leaf = '0x' + 'ee'.repeat(32);                              // opens under the key, but is no note of the wallet: its leaf is not the one its keys give
  return f;
});
const bare = (w, f = feed) => makePoolClient({ store: null, scanWorkers: null }).scanMine(pool, w, f);
const readOwn = (w, f) => { try { return pool.tryReceive(pick(w), f); } catch { return undefined; } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const tiers = () => [alice(), pool.viewWallet(alice()), pool.viewWallet(alice(), { internal: true })];

test('the fixtures hold leaves of every kind: the wallet\'s, its change, a stranger\'s, malformed ones, one that opens but is no note', async () => {
  const notes = await bare(alice());
  assert.ok(notes.length >= 10 && notes.some((n) => n.internal) && notes.some((n) => !n.internal));
  assert.ok(!notes.some((n) => n.leafIndex === 100), 'leaf 100 is not a note');
  assert.ok(notes.every((n) => typeof n.value === 'bigint'), 'a note carries bigints, which a worker\'s answer has to carry too');
});

test('the keys a worker is sent are enough: the note it reads is the note the whole wallet reads', () => {
  for (const w of tiers()) for (const f of feed) assert.strictEqual(json(readOwn(w, f)), json(pool.tryReceive(w, f)), `leaf ${f.leafIndex}`);
});

// Stand-in workers that run the same function in this thread, a tick later.
function fake({ failAt = null, hangAt = null, shortAt = null, undefAt = null, made = [], opts = {}, seen = [] } = {}) {
  let n = 0;
  return makeBtcScanWorkers({
    available: () => true, count: () => 3, chunk: 10, minLeaves: 8, chunkMs: 20e3, idleMs: 800, ...opts,
    make: () => {
      if (opts.makeThrows) throw new Error('no workers here');
      const w = { ended: false, onmessage: null, onerror: null, terminate() { this.ended = true; },
        postMessage({ id, wallet, leaves }) {
          const nth = n++; seen.push({ wallet, leaves });
          setTimeout(() => {
            if (w.ended || nth === hangAt) return;
            if (nth === failAt) return w.onerror?.(new Error('boom'));
            const notes = leaves.map((f) => { try { return pool.tryReceive(wallet, f); } catch { return undefined; } });
            if (nth === undefAt) notes.fill(undefined);
            w.onmessage?.({ data: { id, notes: nth === shortAt ? notes.slice(1) : notes } });
          }, 1);
        } };
      made.push(w);
      return w;
    },
  });
}

test('every answer is the pool\'s own, in order, from workers that are made once and ended when the reads are over', async () => {
  const made = [], seen = [];
  for (const w of tiers()) {
    const r = await fake({ made, seen })(w, feed);
    assert.strictEqual(json(r), json(feed.map((f) => readOwn(w, f))));
  }
  assert.ok(made.length >= 2, `workers were made (${made.length})`);
  await pause(1800);
  assert.ok(made.every((w) => w.ended), 'and ended once it has been quiet');
});

test('a worker is sent the keys the pool\'s receive reads and nothing else of the wallet, and only the feed\'s own fields of each leaf', async () => {
  const seen = [];
  await fake({ seen })(A, feed);
  const keys = new Set(seen.flatMap((m) => Object.keys(m.wallet)));
  assert.deepStrictEqual([...keys].sort(), ['A', 'N', 'a', 'n', 'v', 'vInt'].sort(), 'the view, nullifier and spend keys and the two public keys, not the exit root or the addresses');
  assert.ok(!('exitRoot' in seen[0].wallet) && !('address' in seen[0].wallet));
  assert.ok(seen.every((m) => m.leaves.every((f) => Object.keys(f).sort().join() === 'asset,ctNote,leaf,leafIndex,pkEph')), 'a leaf is sent as the feed gives it, without its transaction');
  const viewSeen = [];
  await fake({ seen: viewSeen })(pool.viewWallet(A), feed);
  assert.deepStrictEqual([...new Set(viewSeen.flatMap((m) => Object.keys(m.wallet)))].sort(), ['A', 'N', 'v'], 'an incoming-only wallet sends only its view key');
});

test('a worker that fails, hangs or answers short leaves those leaves to the page, and the answers it gave stand', async () => {
  const want = feed.map((f) => json(readOwn(A, f)));
  const check = (name, r, losing) => {
    assert.strictEqual(r.length, want.length, name);
    r.forEach((x, i) => assert.ok(x === undefined || json(x) === want[i], `${name}: leaf ${i} is never answered wrongly`));
    assert.ok(r.filter((x) => x === undefined).length >= losing, `${name}: some are left to the page`);
    assert.ok(r.filter((x) => x !== undefined).length > 0, `${name}: the rest are answered`);
  };
  check('a worker that fails on one chunk', await fake({ failAt: 2 })(A, feed), 1);
  check('a worker that never answers', await fake({ hangAt: 1, opts: { chunkMs: 400 } })(A, feed), 1);
  check('a worker whose answer is too short', await fake({ shortAt: 0 })(A, feed), 1);
  const none = await fake({ undefAt: 1 })(A, feed);
  assert.ok(none.some((x) => x === undefined) && none.every((x, i) => x === undefined || json(x) === want[i]));
});

test('no Workers, none that can be made, no view key, or a handful of leaves: the page does them all', async () => {
  assert.strictEqual(await makeBtcScanWorkers({ available: () => false })(A, feed), null);
  assert.strictEqual(await fake()({}, feed), null, 'no view key, nothing to ask');
  assert.strictEqual(await fake()(null, feed), null);
  const none = await fake({ opts: { makeThrows: true } })(A, feed);
  assert.ok(none.every((x) => x === undefined), 'made none, so told nothing');
  const made = [];
  assert.strictEqual(await fake({ made })(A, feed.slice(0, 5)), null);
  assert.strictEqual(made.length, 0, 'workers are not started for a handful');
  assert.ok(Array.isArray(await fake({ made })(A, feed.slice(0, 5), { minLeaves: 3 })), 'a caller can ask for workers for fewer');
  await pause(1000);
});

test('the workers are kept between reads, then ended', async () => {
  const made = [];
  const keep = fake({ made, opts: { idleMs: 800 } });
  await keep(A, feed.slice(0, 40)); await keep(A, feed.slice(40, 100));
  const first = made.length;
  assert.ok(made.every((w) => !w.ended), 'alive after the second read');
  await pause(1800);
  assert.ok(made.every((w) => w.ended), 'ended once the reads have been quiet');
  await keep(A, feed.slice(0, 40));
  assert.ok(made.length > first, 'a later read makes new ones');
  await pause(1800);
});

test('the shipped worker file, run in threads, gives the same notes', async () => {
  const workerFile = fileURLToPath(new URL('../dapp/btc-pool-scan-worker.js', import.meta.url));
  const boot = `const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t) };
    const held = []; let up = false;
    parentPort.on('message', (data) => { if (up) globalThis.self.onmessage({ data }); else held.push(data); });
    import(${JSON.stringify('file://' + workerFile)}).then(() => { up = true; for (const d of held.splice(0)) globalThis.self.onmessage({ data: d }); }, (e) => parentPort.postMessage({ failed: String(e) }));`;
  const threads = [];
  const real = makeBtcScanWorkers({
    available: () => true, count: () => 2, chunk: 25, minLeaves: 8, chunkMs: 60e3, idleMs: 800,
    make: () => {
      const t = new ThreadWorker(boot, { eval: true });
      const w = { onmessage: null, onerror: null, postMessage: (x) => t.postMessage(x), terminate: () => t.terminate() };
      t.on('message', (data) => { if (data.failed) return w.onerror?.(new Error(data.failed)); w.onmessage?.({ data }); });
      t.on('error', (er) => w.onerror?.(er));
      threads.push(t);
      return w;
    },
  });
  for (const w of tiers()) assert.strictEqual(json(await real(w, feed)), json(feed.map((f) => readOwn(w, f))), 'the shipped worker gives the notes the pool gives');
  assert.strictEqual(threads.length, 2);
  await pause(1800);
});

// scanMine with the workers' answers
const counted = () => { const c = { tried: 0, pool: null }; c.pool = { ...pool, scan: (w, b) => { c.tried += b.length; return pool.scan(w, b); } }; return c; };
const withWorkers = (scanWorkers, w, f = feed, c = counted(), store = null) => makePoolClient({ store, scanWorkers }).scanMine(c.pool, w, f).then((notes) => ({ notes, c }));

test('with workers, scanMine returns the same notes, in the same form and order, and the page reads nothing', async () => {
  for (const mk of [alice, () => pool.viewWallet(alice()), () => pool.viewWallet(alice(), { internal: true })]) {
    const r = await withWorkers(fake(), mk());
    assert.strictEqual(json(r.notes), json(await bare(mk())));
    assert.strictEqual(r.c.tried, 0, 'every leaf was read by a worker');
  }
});

test('whatever the workers do, the notes are the same, and a leaf a worker leaves to the page is read by the page', async () => {
  const want = json(await bare(alice()));
  const same = async (name, scanWorkers, tried) => {
    const r = await withWorkers(scanWorkers, alice());
    assert.strictEqual(json(r.notes), want, name);
    if (tried != null) assert.strictEqual(r.c.tried, tried, `${name}: the page read ${r.c.tried}`);
    return r;
  };
  await same('a runner that says nothing', async () => null, N);
  await same('a runner that throws', async () => { throw new Error('nope'); }, N);
  await same('a runner that answers none', async (w, leaves) => leaves.map(() => undefined), N);
  await same('a runner that answers the wrong number', async (w, leaves) => leaves.slice(1).map(() => null), N);
  await same('workers that cannot be made', fake({ opts: { makeThrows: true } }), N);
  await same('Workers that are not there', makeBtcScanWorkers({ available: () => false }), N);
  const failed = await same('a worker that fails on one chunk', fake({ failAt: 2 }));
  assert.ok(failed.c.tried > 0 && failed.c.tried <= 20, `only that chunk's leaves are read here (${failed.c.tried})`);
  await same('a worker that never answers', fake({ hangAt: 1, opts: { chunkMs: 400 } }));
  await same('a worker whose answer is too short', fake({ shortAt: 0 }));
  await same('a worker that works out none of its chunk', fake({ undefAt: 1 }));
  const made = [];
  const few = await withWorkers(fake({ made }), alice(), feed.slice(0, 6));
  assert.strictEqual(few.c.tried, 6, 'a handful of leaves is read here, without starting workers');
  assert.strictEqual(made.length, 0);
});

test('reads that come later use the memory as before, and a feed that grows is read from where it was', async () => {
  const client = makePoolClient({ store: null, scanWorkers: fake() }), c = counted(), w = alice();
  const a = await client.scanMine(c.pool, w, feed.slice(0, 100));
  assert.strictEqual(json(a), json(await bare(alice(), feed.slice(0, 100))));
  const again = await client.scanMine(c.pool, w, feed.slice(0, 100));
  assert.strictEqual(json(again), json(a));
  const grown = await client.scanMine(c.pool, w, feed);
  assert.strictEqual(json(grown), json(await bare(alice())));
  assert.strictEqual(c.tried, 0, 'workers read all of it, the page none');
});

test('with the kept record, a reload opens the kept notes in workers when there are enough of them, and here when there are not', async () => {
  const m = new Map(), store = { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); } };
  const first = await withWorkers(fake(), alice(), feed, counted(), store);
  assert.strictEqual(json(first.notes), json(await bare(alice())));
  const rec = JSON.parse(m.get('tacit-btc-scan-ck-v1')).e[0];
  assert.deepStrictEqual(rec.mine, first.notes.map((n) => n.leafIndex));
  assert.ok(rec.mine.length >= 8);
  const viaWorkers = await withWorkers(fake(), alice(), feed, counted(), store);
  assert.strictEqual(json(viaWorkers.notes), json(first.notes));
  assert.strictEqual(viaWorkers.c.tried, 0, 'the kept notes were opened by workers');
  const here = await withWorkers(null, alice(), feed, counted(), store);
  assert.strictEqual(json(here.notes), json(first.notes));
  assert.strictEqual(here.c.tried, first.notes.length, 'with no workers the page opens them');
  // fewer kept notes than a worker is worth: the page opens them
  const m2 = new Map(), store2 = { get: (k) => (m2.has(k) ? m2.get(k) : null), set: (k, v) => { m2.set(k, v); } };
  const small = feed.slice(0, 30);
  const f2 = await withWorkers(fake(), alice(), small, counted(), store2);
  const kept = JSON.parse(m2.get('tacit-btc-scan-ck-v1')).e[0].mine.length;
  assert.ok(kept > 0 && kept < 8, `${kept} kept notes`);
  const r2 = await withWorkers(fake(), alice(), small, counted(), store2);
  assert.strictEqual(json(r2.notes), json(f2.notes));
  assert.strictEqual(r2.c.tried, kept, 'a handful of kept notes is opened here');
});

test('the page reads leaves in slices, handing the thread back between them, when no worker answers', async () => {
  const c = counted();
  const slow = { ...c.pool, scan: (w, b) => { const t0 = Date.now(); while (Date.now() - t0 < 15); return c.pool.scan(w, b); } };      // each leaf takes longer than a slice
  let yields = 0; const Real = globalThis.MessageChannel;
  globalThis.MessageChannel = class extends Real { constructor() { super(); yields++; } };
  let notes;
  try { notes = await makePoolClient({ store: null, scanWorkers: null }).scanMine(slow, alice(), feed.slice(0, 40)); } finally { globalThis.MessageChannel = Real; }
  assert.strictEqual(json(notes), json(await bare(alice(), feed.slice(0, 40))));
  assert.ok(yields >= 30, `the thread was handed back between leaves (${yields} times)`);
});
