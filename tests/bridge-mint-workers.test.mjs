// The bridge-mint walk in workers (dapp/confidential-bridge-walk.js, confidential-bridge-worker.js, confidential-bridge-workers.js, and the
// `bridgeWorkers` option of makeConfidentialRecovery): the nullifiers are searched in chunks by workers, and whatever the workers do, fail to do or
// take too long over, walkBridgeMints returns exactly what it returns with none: the same notes in the same order, the same count of
// candidates, the same transactions searched.
//   node --test tests/bridge-mint-workers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialRecovery } from '../dapp/confidential-recovery.js';
import { bppGens, G as BPP_G } from '../dapp/bulletproofs-plus.js';
import { valuePoints, walkNullifiers } from '../dapp/confidential-bridge-walk.js';
import { makeBridgeWorkers } from '../dapp/confidential-bridge-workers.js';

const cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const H = bppGens().H;
const make = (bridgeWorkers = null) => makeConfidentialRecovery({ pool, memo: {}, keccak256: keccak_256, secp, hmac, sha256: nobleSha256, curveOrder: secp.CURVE.n, lockScan: {}, airdrop: {}, cdp: {}, bpp: { H, G: BPP_G }, bridgeWorkers });
const R0 = make();

const PRIV = '0x' + '7a'.repeat(32), ASSET = '0x' + 'a5'.repeat(32);
const priv = Uint8Array.from(Buffer.from('7a'.repeat(32), 'hex'));
const nul = (i) => '0x' + i.toString(16).padStart(64, '0');
function mintLeaf(n, value) {
  const b = R0.deriveBridgeMintBlinding(priv, n);
  const { cx, cy } = pool.commitXY(BigInt(value), b);
  const dn = pool.deriveNote(priv, ASSET, 0);
  return pool.leaf(ASSET, cx, cy, pool.nkToOwner(dn.secret));
}
// 40 nullifiers in one transaction, three of them burns this key's mints came from (one at a value off the round grid), 9 in another with none.
const mine = [[3, 1000], [17, 50], [29, 1234]].map(([i, v]) => ({ i, v, leaf: mintLeaf(nul(1000 + i), v) }));
const tx = { nullifiersOfTx: new Map([['0xaa', Array.from({ length: 40 }, (_, i) => nul(1000 + i))], ['0xbb', Array.from({ length: 9 }, (_, i) => nul(2000 + i))]]) };
const unexplained = () => new Map([['0xaa', mine.map((m) => m.leaf)], ['0xbb', ['0x' + 'ee'.repeat(32)]]]);
const opts = { priv: PRIV, assets: [{ assetId: ASSET }], destIndexes: 1, maxExp: 3, values: ['1234'], maxNullifiers: 64 };
const json = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Set ? [...v].sort() : v));
const walk = (R) => R.walkBridgeMints({ ...opts, tx, unexplained: unexplained() });

const base = await walk(R0);
test('the walk finds the three mints without workers, off the grid too', () => {
  assert.deepStrictEqual(base.found.map((f) => f.burnNullifier).sort(), mine.map((m) => nul(1000 + m.i)).sort());
  assert.ok(base.found.some((f) => f.value === 1234n), 'a value given, not on the grid');
  assert.ok(base.tried > 40 * 300, 'every candidate was tried');
  assert.ok(base.searched.has('0xaa') && base.searched.has('0xbb'));
});

// A stand-in worker that runs the shared code in this thread, a tick later.
function fake({ failAt = null, hangAt = null, shortAt = null, made = [], opts: o = {}, calls = [] } = {}) {
  let n = 0;
  const run = async ({ setup, nulls }) => {
    const pts = await valuePoints({ H, values: setup.values.map(BigInt), roundValues: setup.roundValues, maxExp: setup.maxExp });
    return walkNullifiers({ G: BPP_G, keccak256: keccak_256, deriveBlinding: (p, x) => R0.deriveBridgeMintBlinding(p, x), p: setup.p, owners: setup.owners, pts, nulls: nulls.map((x) => ({ n: x.n, want: new Set(x.want) })) });
  };
  return makeBridgeWorkers({
    available: () => true, count: () => 3, chunkMs: 20e3, idleMs: 40, ...o,
    make: () => {
      if (o.makeThrows) throw new Error('no workers here');
      const w = { ended: false, onmessage: null, onerror: null, terminate() { this.ended = true; },
        postMessage(msg) {
          const nth = n++; calls.push(msg);
          setTimeout(async () => {
            if (w.ended || nth === hangAt) return;
            if (nth === failAt) return w.onerror?.(new Error('boom'));
            const r = await run(msg);
            if (w.ended) return;
            w.onmessage?.({ data: nth === shortAt ? { id: msg.id, found: 'not a list', tried: 1 } : { id: msg.id, found: r.found, tried: r.tried } });
          }, 1);
        } };
      made.push(w);
      return w;
    },
  });
}

test('with workers, the same notes, in the same order, with the same count and the same transactions searched', async () => {
  const made = [], calls = [];
  const r = await walk(make(fake({ made, calls })));
  assert.strictEqual(json(r), json(base));
  assert.ok(made.length === 3, 'three workers were made');
  assert.ok(calls.length === Math.ceil(49 / 6), `the 49 nullifiers went in chunks of six (${calls.length} messages)`);
  assert.ok(calls.every((c) => c.setup.owners[0].asset.assetId === ASSET && c.setup.p instanceof Uint8Array), 'each message carries what the worker needs');
});

test('a few nullifiers are searched here: workers are not started for them', async () => {
  const made = [];
  const small = new Map([['0xaa', Array.from({ length: 8 }, (_, i) => nul(1000 + i))]]);
  const r = await make(fake({ made })).walkBridgeMints({ ...opts, tx: { nullifiersOfTx: small }, unexplained: new Map([['0xaa', [mine[0].leaf]]]) });
  assert.strictEqual(made.length, 0);
  assert.strictEqual(r.found.length, 1);
});

test('whatever the workers do, the notes are the same', async () => {
  const same = async (name, bridgeWorkers) => assert.strictEqual(json(await walk(make(bridgeWorkers))), json(base), name);
  await same('a runner that says nothing', async () => null);
  await same('a runner that throws', async () => { throw new Error('nope'); });
  await same('a runner that answers no chunk', async (job, chunks) => chunks.map(() => null));
  await same('a runner whose answers are malformed', async (job, chunks) => chunks.map(() => ({ found: 3, tried: 'x' })));
  await same('workers that cannot be made', fake({ opts: { makeThrows: true } }));
  await same('Workers that are not there', makeBridgeWorkers({ available: () => false }));
  const made = [];
  await same('a worker that fails on one chunk', fake({ failAt: 2, made }));
  assert.ok(made.some((w) => w.ended), 'the worker that failed was ended, and the others are kept for the next slice');
  await same('a worker that never answers', fake({ hangAt: 1, opts: { chunkMs: 400 } }));
  await same('a worker whose answer is malformed', fake({ shortAt: 0 }));
});

test('two readers asking for the same walk at once run it once', async () => {
  const made = [];
  const shared = fake({ made });
  const [a, b] = await Promise.all([walk(make(shared)), walk(make(shared))]);
  assert.strictEqual(json(a), json(base));
  assert.strictEqual(json(b), json(base));
  assert.strictEqual(made.length, 3, 'one set of workers');
});

test('the workers are kept between the slices of one scan, then ended', async () => {
  const made = [];
  const keep = fake({ made, opts: { idleMs: 800 } });
  const R = make(keep);
  await walk(R);
  const first = made.length;
  await walk(R);
  assert.strictEqual(made.length, first, 'the second slice used the same workers');
  assert.ok(made.every((w) => !w.ended), 'and they are alive right after');
  await new Promise((r) => setTimeout(r, 1800));
  assert.ok(made.every((w) => w.ended), 'they are ended once the scan has been quiet a moment');
  await walk(R);
  assert.ok(made.length > first, 'and a later scan makes new ones');
  await new Promise((r) => setTimeout(r, 1800));
});

test('the shipped worker file, run in threads, finds the same notes', async () => {
  const workerFile = fileURLToPath(new URL('../dapp/confidential-bridge-worker.js', import.meta.url));
  const boot = `const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t) };
    const held = []; let up = false;
    parentPort.on('message', (data) => { if (up) globalThis.self.onmessage({ data }); else held.push(data); });
    import(${JSON.stringify('file://' + workerFile)}).then(() => { up = true; for (const d of held.splice(0)) globalThis.self.onmessage({ data: d }); }, (e) => parentPort.postMessage({ failed: String(e) }));`;
  const threads = [];
  const real = makeBridgeWorkers({
    available: () => true, count: () => 2, chunkMs: 60e3, idleMs: 100,
    make: () => {
      const t = new ThreadWorker(boot, { eval: true });
      const w = { onmessage: null, onerror: null, postMessage: (x) => t.postMessage(x), terminate: () => t.terminate() };
      t.on('message', (data) => { if (data.failed) return w.onerror?.(new Error(data.failed)); w.onmessage?.({ data }); });
      t.on('error', (e) => w.onerror?.(e));
      threads.push(t);
      return w;
    },
  });
  const r = await walk(make(real));
  assert.strictEqual(json(r), json(base), 'the shipped worker finds what the page finds');
  assert.strictEqual(threads.length, 2);
  await new Promise((r2) => setTimeout(r2, 400));
});
