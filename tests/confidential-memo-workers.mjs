#!/usr/bin/env node
// The worker path of the memo scan (dapp/confidential-memo-probe.js, confidential-memo-worker.js, confidential-memo-workers.js,
// and the `filter` option of scanSliced): ruling memos out off the page's thread must only save work. Whatever the workers say, fail
// to say, or take too long to say, the scan finds exactly the notes the plain scan finds, and the page opens in full only the memos
// the probe did not rule out.
//
// Run: node tests/confidential-memo-workers.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { randomScalar, G } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialMemo } from '../dapp/confidential-memo.js';
import { makeMemoProbe } from '../dapp/confidential-memo-probe.js';
import { makeMemoWorkers, startWorker } from '../dapp/confidential-memo-workers.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const m = makeConfidentialMemo({ secp, sha256, keccak256 });
const probe = makeMemoProbe({ secp, sha256, keccak256 });
const pool = makeConfidentialPool({ secp, sha256, keccak256 });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const pubHex = (priv) => '0x' + Buffer.from(G.multiply(priv).toRawBytes(true)).toString('hex');
const ASSET = '0x' + 'a5'.repeat(32);
const ZERO = '0x' + '00'.repeat(32);
const hex32 = (i) => '0x' + BigInt(i).toString(16).padStart(64, '0');
const nullifierOf = (note, leaf) => pool.nativeNu(note.owner, note.secret, leaf);
const mkLeaf = (nt) => { const c = m.commitXY(nt.value, nt.blinding); return m.leafHash(nt.asset, c.cx, c.cy, nt.owner); };
const mk = (value, nk) => ({ value, blinding: randomScalar(), secret: nk, asset: ASSET, owner: pool.nkToOwner(nk) });
const ev = (nt, to, i) => ({ leaf: mkLeaf(nt), leafIndex: i, memo: m.encodeMemo(m.sealMemo(to, nt, randomScalar)) });
const plainJson = (a) => JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

const rPriv = randomScalar(), rPub = pubHex(rPriv);
const sPriv = randomScalar(), sPub = pubHex(sPriv);

// A pool of memos: strangers' notes, a few of the key's own (an owned note, a bearer note, a receive-code payment) among them, and
// the shapes that are not memos at all.
const NOISE = 150;
const events = [];
for (let i = 0; i < NOISE; i++) events.push(ev(mk(BigInt(1000 + i), hex32(5000 + i)), sPub, i));
const own = [mk(11n, hex32(1)), mk(12n, hex32(2))];
const bearer = { value: 13n, blinding: randomScalar(), secret: ZERO, asset: ASSET, owner: ZERO };
events.splice(10, 0, ev(own[0], rPub, 10));
events.splice(77, 0, ev(own[1], rPub, 77));
events.splice(120, 0, ev(bearer, rPub, 120));
events.splice(30, 0, { leaf: events[0].leaf, leafIndex: 30, memo: '0x' }, { leaf: undefined, memo: undefined }, null, { leaf: events[0].leaf, leafIndex: 31, memo: '0x' + 'zz'.repeat(169) }, { leaf: events[0].leaf, leafIndex: 32, memo: { ephemeralPub: '0x1', ciphertext: '0x' } });
const wanted = events.filter((e) => e && [own[0], own[1], bearer].some((nt) => e.leaf === mkLeaf(nt))).map((e) => e.leafIndex);
assert.strictEqual(wanted.length, 3);

// ── the probe: never rules out a memo openMemo opens; rules out the strangers' ──
{
  for (const e of events) {
    if (!e) continue;
    const opens = !!m.openMemo(rPriv, e.leaf, e.memo);
    const might = probe.maybeMine(rPriv, e.memo);
    assert.ok(!opens || might, `the probe lets through every memo openMemo opens (leaf index ${e.leafIndex})`);
  }
  const stranger = events.filter((e) => e && typeof e.memo === 'string' && e.memo.length > 100 && !wanted.includes(e.leafIndex) && /^0x[0-9a-f]+$/.test(e.memo));
  assert.ok(stranger.length >= NOISE - 5 && stranger.every((e) => !probe.maybeMine(rPriv, e.memo)), 'and rules out the memos sealed to somebody else');
  assert.ok(probe.maybeMine(rPriv, events.find((e) => e && e.leafIndex === 77).memo), 'an owned note passes');
  assert.ok(probe.maybeMine(rPriv, events.find((e) => e && e.leafIndex === 120).memo), 'a bearer note passes');
  assert.strictEqual(probe.maybeMine(rPriv, '0x'), false, 'an empty memo does not');
  assert.strictEqual(probe.maybeMine(rPriv, null), false, 'nor null');
  assert.strictEqual(probe.maybeMine(rPriv, { ephemeralPub: '0x1', ciphertext: '0x' }), false, 'nor a malformed one');
  // a receive-code payment: the owner is one its receive key derives, and the secret slot carries a tag and an index
  const receiveNk = hex32(424242), receiveOwner = pool.nkToOwner(receiveNk);
  const rc = { value: 14n, blinding: randomScalar(), secret: m.receiveSecret(3), asset: ASSET, owner: receiveOwner };
  const rcMemo = m.encodeMemo(m.sealMemo(rPub, rc, randomScalar));
  assert.ok(probe.maybeMine(rPriv, rcMemo), 'a receive memo passes');
  assert.strictEqual(m.openMemo(rPriv, mkLeaf(rc), rcMemo)?.receiveIndex, 3, 'and still opens, as a receive memo, through the shared probe');
  ok('the probe lets through every memo openMemo opens and rules out the memos sealed to others');
}

const plain = m.scan(rPriv, events, [], nullifierOf);
assert.deepStrictEqual(plain.map((x) => x.leafIndex), wanted, 'the plain scan finds the three notes');

// A stand-in worker that runs the same probe in this thread, a tick later.
function fakeWorkers({ failAt = null, hangAt = null, shortAt = null, made = [], opts = {} } = {}) {
  let asked = 0;
  return makeMemoWorkers({
    available: () => true, count: () => 3, chunk: 16, minMemos: 8, chunkMs: 20e3, ...opts,
    make: () => {
      if (opts.makeThrows) throw new Error('no workers here');
      const w = { ended: false, terminate() { this.ended = true; }, onmessage: null, onerror: null,
        postMessage({ id, key, memos }) {
          const nth = asked++;
          setTimeout(() => {
            if (w.ended) return;
            if (nth === hangAt) return;
            if (nth === failAt) return w.onerror?.(new Error('boom'));
            const said = Int8Array.from(memos, (x) => (probe.maybeMine(key, x) ? 1 : 0));
            w.onmessage?.({ data: { id, said: nth === shortAt ? said.subarray(1) : said } });
          }, 1);
        } };
      made.push(w);
      return w;
    },
  });
}
const withFilter = async (filter, key = rPriv, evs = events) => {
  let opened = 0;
  const spy = { ...secp, ProjectivePoint: new Proxy(secp.ProjectivePoint, { get: (t, k) => (k === 'fromHex' ? (h) => { opened++; return t.fromHex(h); } : t[k]) }) };
  const mc = makeConfidentialMemo({ secp: spy, sha256, keccak256 });
  const got = await mc.scanSliced(key, evs, [], nullifierOf, { filter });
  return { got, opened };
};

// ── parity and saved work ──
{
  const made = [];
  const base = await withFilter(null);
  assert.strictEqual(plainJson(base.got), plainJson(plain), 'without a filter, the scan is the plain scan');
  const r = await withFilter(fakeWorkers({ made }));
  assert.strictEqual(plainJson(r.got), plainJson(plain), 'with workers, the same notes in the same order');
  assert.ok(base.opened >= NOISE && r.opened <= wanted.length + 1, `the page opened ${r.opened} memos in full instead of ${base.opened}`);
  assert.ok(made.length === 3 && made.every((w) => w.ended), 'three workers were made for the scan, and all of them were ended after it');
  const other = await withFilter(fakeWorkers(), sPriv);
  assert.strictEqual(other.got.length, NOISE, 'another key reads the same list on its own, through the same workers');
  ok('with workers the scan finds the same notes, and the page opens only the memos the probe let through');
}

// ── whatever the workers do, the notes are the same ──
{
  const same = async (name, filter) => { const r = await withFilter(filter); assert.strictEqual(plainJson(r.got), plainJson(plain), name); return r; };
  await same('a filter that says nothing (null)', async () => null);
  await same('a filter that throws', async () => { throw new Error('nope'); });
  await same('a filter that does not know any memo', async (k, ms) => new Int8Array(ms.length).fill(-1));
  await same('a filter whose answer is the wrong length', async (k, ms) => new Int8Array(ms.length + 1));
  const live = await same('workers that cannot be made', fakeWorkers({ opts: { makeThrows: true } }));
  assert.ok(live.opened >= NOISE, 'the page then opens every memo itself');
  const a = [], b = [], c = [], d = [];
  const failed = await same('a worker that fails on one chunk', fakeWorkers({ failAt: 2, made: a }));
  assert.ok(failed.opened > wanted.length + 1 && failed.opened < NOISE, `only the failed chunk (and its mine) is opened by the page (${failed.opened})`);
  assert.ok(a.every((w) => w.ended), 'and every worker is ended');
  const hung = await same('a worker that never answers', fakeWorkers({ hangAt: 1, made: b, opts: { chunkMs: 1500 } }));
  assert.ok(hung.opened < NOISE && b.every((w) => w.ended), 'the rest is ruled out and the stuck worker is ended');
  await same('a worker whose answer is too short', fakeWorkers({ shortAt: 0, made: c }));
  const small = await withFilter(makeMemoWorkers({ available: () => true, minMemos: 100000, make: () => { throw new Error('should not be made for a small scan'); } }));
  assert.strictEqual(plainJson(small.got), plainJson(plain), 'a scan too small to be worth a worker');
  assert.strictEqual(await makeMemoWorkers({ available: () => false })('0x1', Array(500).fill('0x')), null, 'no Workers: null');
  assert.strictEqual(await makeMemoWorkers({ available: () => true, make: () => { throw new Error('not for a handful'); } })('0x1', ['0x']), null, 'a handful of memos: null, nothing started');
  ok('workers that fail, hang, answer short or are not there leave the notes unchanged');
}

// ── two readers of one pool, one set of workers ──
{
  const made = [];
  const a = fakeWorkers({ made }), b = fakeWorkers({ made });
  const memos = events.map((e) => (e && typeof e.memo === 'string' ? e.memo : '0x'));
  const [x, y] = await Promise.all([a(rPriv, memos), b(rPriv, memos)]);
  assert.ok(x && y && x === y, 'a second request for the same key over the same memos is given the first one\'s answer');
  assert.strictEqual(made.length, 3, 'and starts no workers of its own');
  const z = await a(sPriv, memos);
  assert.ok(z && z !== x && made.length === 6, 'another key over the same memos is its own request');
  const w = await a(rPriv, memos.slice(0, -1));
  assert.ok(w && w !== x && w.length === memos.length - 1, 'so is the same key over other memos');
  const after = await b(rPriv, memos);
  assert.ok(after && after !== x && made.length === 12, 'and once a request has finished, the next one is read afresh');
  ok('a second reader of the same pool waits for the running probe instead of starting its own');
}

// ── how a worker is started ──
{
  const made = [], revoked = [];
  class FakeWorker { constructor(u, o) { this.u = u; this.o = o; this.ended = false; made.push(this); } terminate() { this.ended = true; } }
  const env = (isolated) => {
    const o = { crossOriginIsolated: isolated, Worker: FakeWorker, Blob: class { constructor(parts, opts) { this.parts = parts; this.opts = opts; } },
      URL: { createObjectURL: (b) => { o.last = b; return 'blob:test/1'; }, revokeObjectURL: (u) => revoked.push(u) } };
    return o;
  };
  const direct = startWorker('https://x.test/confidential-memo-worker.js', env(false));
  assert.strictEqual(direct.u, 'https://x.test/confidential-memo-worker.js', 'a page that is not isolated starts the script itself');
  assert.deepStrictEqual(direct.o, { type: 'module' });
  const e = env(true);
  const viaBlob = startWorker('https://x.test/confidential-memo-worker.js', e);
  assert.strictEqual(viaBlob.u, 'blob:test/1', 'an isolated page starts a blob');
  assert.deepStrictEqual(viaBlob.o, { type: 'module' }, 'as a module');
  assert.strictEqual(e.last.parts[0], 'import "https://x.test/confidential-memo-worker.js";', 'whose only line imports the real worker by its full address');
  assert.deepStrictEqual(revoked, [], 'the blob is kept while the worker lives');
  viaBlob.terminate();
  assert.ok(viaBlob.ended && revoked.join() === 'blob:test/1', 'and let go when it is ended');
  const noBlob = startWorker('https://x.test/w.js', { crossOriginIsolated: true, Worker: FakeWorker });
  assert.strictEqual(noBlob.u, 'https://x.test/w.js', 'with no way to make a blob the script is started directly');
  class Refuses extends FakeWorker { constructor(u, o) { super(u, o); if (String(u).startsWith('blob:')) throw new Error('blocked'); } }
  const gone = []; const e2 = { ...env(true), Worker: Refuses, URL: { createObjectURL: () => 'blob:test/2', revokeObjectURL: (u) => gone.push(u) } };
  assert.throws(() => startWorker('https://x.test/w.js', e2), /blocked/, 'a page that refuses the blob throws, which the manager treats as no worker');
  assert.deepStrictEqual(gone, ['blob:test/2'], 'without leaving the blob behind');
  ok('an isolated page starts the worker through a blob that imports it, any other page starts the script itself');
}

// ── the real worker file, in a thread ──
{
  const workerFile = fileURLToPath(new URL('../dapp/confidential-memo-worker.js', import.meta.url));
  // A browser holds a message sent to a worker until its script has run; a thread does not, so this holds them the same way.
  const boot = `const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t) };
    const held = []; let up = false;
    parentPort.on('message', (data) => { if (up) globalThis.self.onmessage({ data }); else held.push(data); });
    import(${JSON.stringify('file://' + workerFile)}).then(() => { up = true; for (const d of held.splice(0)) globalThis.self.onmessage({ data: d }); }, (e) => parentPort.postMessage({ failed: String(e) }));`;
  const made = [];
  const filter = makeMemoWorkers({
    available: () => true, count: () => 2, chunk: 40, minMemos: 8, chunkMs: 20e3,
    make: () => {
      const t = new ThreadWorker(boot, { eval: true });
      const w = { onmessage: null, onerror: null, postMessage: (x) => t.postMessage(x), terminate: () => t.terminate() };
      t.on('message', (data) => { if (data.ready) return; if (data.failed) return w.onerror?.(new Error(data.failed)); w.onmessage?.({ data }); });
      t.on('error', (e) => w.onerror?.(e));
      made.push(t);
      return w;
    },
  });
  const r = await withFilter(filter);
  assert.strictEqual(plainJson(r.got), plainJson(plain), 'the shipped worker file finds the same notes');
  assert.ok(r.opened <= wanted.length + 1, `and the page opened ${r.opened} memos in full`);
  const said = await filter(rPriv, events.map((e) => (e && typeof e.memo === 'string' ? e.memo : '0x')));
  assert.ok(said && said.length === events.length && [...said].every((x) => x === 0 || x === 1), 'a filter answer is one entry per memo');
  assert.ok(wanted.every((i) => said[events.findIndex((e) => e && e.leafIndex === i)] === 1), 'it says yes to each of the key\'s own');
  ok('the shipped worker file, run in a thread, finds the same notes and leaves almost nothing for the page to open');
}

console.log(`\n${n}/${n} confidential-memo-workers checks passed`);
