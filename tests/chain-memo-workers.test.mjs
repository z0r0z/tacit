// The Tacit chain's memos opened in workers (dapp/confidential-chain-memo-worker.js, confidential-chain-memo-workers.js, and the `openMany` option of
// makeChainWallet's scan): whatever the workers do, fail to do or take too long over, scan returns the notes it returns with none.
//   node --test tests/chain-memo-workers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from '../dapp/vendor/tacit-poseidon.min.js';
import { makeChainWallet, assetField } from '../dapp/tacit-chain-wallet.js';
import { makeBtcPoolZk } from '../dapp/btc-pool-zk.js';
import { openMemo, sealMemo } from '../dapp/tacit-chain-memo.js';
import { makeChainMemoWorkers } from '../dapp/confidential-chain-memo-workers.js';

const poseidon = (xs) => ({ 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 })[xs.length](xs);
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const asset = assetField(Uint8Array.from([...new Array(12).fill(0), ...Buffer.from(TAC.slice(2), 'hex')]));
const chain = '0x' + '07'.repeat(32);
const Z = makeBtcPoolZk({ poseidon });
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const make = (openMany = null) => makeChainWallet({ poseidon, prover: null, chain, asset, openMany });
const w0 = make();
const alice = w0.keys(new Uint8Array(32).fill(0xa1)), bob = w0.keys(new Uint8Array(32).fill(0xb2));

// 90 notes: 7 for Alice with the leaf her key makes of them, 2 for Alice under a leaf that is not hers (refused by the leaf check), the rest Bob's.
const rows = [];
for (let i = 0; i < 90; i++) {
  const toAlice = [3, 11, 25, 26, 40, 57, 88].includes(i), wrong = [14, 60].includes(i);
  const to = toAlice || wrong ? alice : bob;
  const sealed = sealMemo(w0.address(to), BigInt(1000 + i) * 10n ** 8n, new Uint8Array(32).fill(i + 1));
  const own = Z.ownedKeys(to.zk, sealed.s);
  const leaf = wrong ? 12345n + BigInt(i) : Z.leafOf(asset, BigInt(1000 + i) * 10n ** 8n, own.npk, own.rho);
  rows.push({ leaf: '0x' + leaf.toString(16).padStart(64, '0'), memo: hx(sealed.memo) });
}
const leader = (pageSize = 200) => ({
  notes: async (from, limit) => { const take = rows.slice(from, from + Math.min(limit, pageSize)); return { leaves: take.map((r) => r.leaf), memos: take.map((r) => r.memo), next: from + take.length, total: rows.length }; },
  spent: async (nf) => nf === spentNf,
});
let spentNf = null;
const base = await w0.scan(alice, leader());
const json = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v));
spentNf = base.notes[1].nullifier;
const withSpent = await w0.scan(alice, leader());
spentNf = null;

test('the scan finds Alice\'s seven notes, and none of the others\'', () => {
  assert.deepStrictEqual(base.notes.map((n) => n.index), [3, 11, 25, 26, 40, 57, 88]);
  assert.strictEqual(withSpent.spent.length, 1);
});

// A stand-in worker that runs the same openMemo in this thread, a tick later.
function fake({ failAt = null, hangAt = null, shortAt = null, undefAt = null, made = [], opts = {} } = {}) {
  let n = 0;
  return makeChainMemoWorkers({
    available: () => true, count: () => 3, chunk: 12, minMemos: 8, chunkMs: 20e3, idleMs: 40, ...opts,
    make: () => {
      if (opts.makeThrows) throw new Error('no workers here');
      const w = { ended: false, onmessage: null, onerror: null, terminate() { this.ended = true; },
        postMessage({ id, secret, memos }) {
          const nth = n++;
          setTimeout(() => {
            if (w.ended || nth === hangAt) return;
            if (nth === failAt) return w.onerror?.(new Error('boom'));
            const opened = memos.map((m) => openMemo(m, secret));
            if (nth === undefAt) opened.fill(undefined);
            w.onmessage?.({ data: { id, opened: nth === shortAt ? opened.slice(1) : opened } });
          }, 1);
        } };
      made.push(w);
      return w;
    },
  });
}
const scan = (openMany, pageSize) => make(openMany).scan(alice, leader(pageSize));

test('with workers, the same notes and the same spent ones', async () => {
  const made = [];
  const r = await scan(fake({ made }));
  assert.strictEqual(json(r), json(base));
  assert.ok(made.length >= 2, 'workers were made');
  spentNf = base.notes[1].nullifier;
  try { assert.strictEqual(json(await scan(fake())), json(withSpent), 'and the spent one is named spent'); } finally { spentNf = null; }
});

test('whatever the workers do, the notes are the same', async () => {
  const same = async (name, openMany, page) => assert.strictEqual(json(await scan(openMany, page)), json(base), name);
  await same('a runner that says nothing', async () => null);
  await same('a runner that throws', async () => { throw new Error('nope'); });
  await same('a runner that does not know any memo', async (memos) => memos.map(() => undefined));
  await same('workers that cannot be made', fake({ opts: { makeThrows: true } }));
  await same('Workers that are not there', makeChainMemoWorkers({ available: () => false }));
  await same('a worker that fails on one chunk', fake({ failAt: 2 }));
  await same('a worker that never answers', fake({ hangAt: 1, opts: { chunkMs: 400 } }));
  await same('a worker whose answer is too short', fake({ shortAt: 0 }));
  await same('a worker that opens nothing, undefined throughout', fake({ undefAt: 1 }));
  await same('pages of 30', fake(), 30);
});

test('a page of a few memos is opened here: no workers are started for it', async () => {
  const made = [];
  const r = await make(fake({ made })).scan(alice, { notes: async () => ({ leaves: rows.slice(0, 5).map((x) => x.leaf), memos: rows.slice(0, 5).map((x) => x.memo), next: 5, total: 5 }), spent: async () => false });
  assert.strictEqual(made.length, 0);
  assert.deepStrictEqual(r.notes.map((n) => n.index), [3]);
});

test('the workers are kept between pages, then ended', async () => {
  const made = [];
  const keep = fake({ made, opts: { idleMs: 150 } });
  await scan(keep, 30);
  const first = made.length;
  assert.ok(made.every((w) => !w.ended), 'alive between pages');
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(made.every((w) => w.ended), 'ended once the scan is quiet');
  assert.ok(first >= 2);
});

test('the shipped worker file, run in threads, finds the same notes', async () => {
  const workerFile = fileURLToPath(new URL('../dapp/confidential-chain-memo-worker.js', import.meta.url));
  const boot = `const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t) };
    const held = []; let up = false;
    parentPort.on('message', (data) => { if (up) globalThis.self.onmessage({ data }); else held.push(data); });
    import(${JSON.stringify('file://' + workerFile)}).then(() => { up = true; for (const d of held.splice(0)) globalThis.self.onmessage({ data: d }); }, (e) => parentPort.postMessage({ failed: String(e) }));`;
  const threads = [];
  spentNf = null;
  const real = makeChainMemoWorkers({
    available: () => true, count: () => 2, chunk: 16, minMemos: 8, chunkMs: 60e3, idleMs: 100,
    make: () => {
      const t = new ThreadWorker(boot, { eval: true });
      const w = { onmessage: null, onerror: null, postMessage: (x) => t.postMessage(x), terminate: () => t.terminate() };
      t.on('message', (data) => { if (data.failed) return w.onerror?.(new Error(data.failed)); w.onmessage?.({ data }); });
      t.on('error', (e) => w.onerror?.(e));
      threads.push(t);
      return w;
    },
  });
  assert.strictEqual(json(await scan(real)), json(base), 'the shipped worker finds what the wallet finds');
  assert.strictEqual(threads.length, 2);
  await new Promise((r) => setTimeout(r, 400));
});
