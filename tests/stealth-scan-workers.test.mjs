// The stealth scan's check of a batch of transfers in workers (dapp/stealth-scan-worker.js, stealth-scan-workers.js): for every transfer, true (holds nothing for the key),
// false (holds a credit), or undefined (not told, so the page works it out), and whatever the workers do, fail to do or take too long over, an answer that is given is the
// one the page's own check gives; the rest is left to the page.
//   node --test tests/stealth-scan-workers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { recipientScanTxForStealth } from '../dapp/stealth-scan-core.js';
import { makeStealthWorkers } from '../dapp/stealth-scan-workers.js';
import { walletPriv, walletPub, DOMAIN_FIXTURE as DOMAIN, transfer } from './_stealth-fixtures.mjs';

const key = { walletPriv, walletPub, networkTag: 'mainnet' };
const jobOf = (t) => ({ classifiedInputs: t.classifiedInputs, outputs: t.outputs, domain: DOMAIN, txAnchorHead: t.txAnchorHead });
// 160 transfers, half of which are built to pay the wallet (not all can: a transfer needs an input of an eligible kind); their network tag is the wallet's, so the answer for each is what the page's own check gives with these jobs
const transfers = Array.from({ length: 160 }, (_, i) => transfer({ pay: i % 2 === 0 }));
const jobs = transfers.map(jobOf);
const own = jobs.map((j) => { try { return recipientScanTxForStealth({ ...j, walletPriv, walletPub, networkTag: 'mainnet' }).length === 0; } catch { return undefined; } });
test('the fixtures hold both kinds of transfer', () => assert.ok(own.filter((x) => x === true).length >= 40 && own.filter((x) => x === false).length >= 8, `${own.filter((x) => x === false).length} that hold a credit, ${own.filter((x) => x === true).length} that do not`));

// A stand-in worker that runs the same function in this thread, a tick later.
function fake({ failAt = null, hangAt = null, shortAt = null, undefAt = null, made = [], opts = {} } = {}) {
  let n = 0;
  return makeStealthWorkers({
    available: () => true, count: () => 3, chunk: 10, minJobs: 8, chunkMs: 20e3, idleMs: 800, ...opts,
    make: () => {
      if (opts.makeThrows) throw new Error('no workers here');
      const w = { ended: false, onmessage: null, onerror: null, terminate() { this.ended = true; },
        postMessage({ id, walletPriv: wp, walletPub: wu, networkTag, jobs: js }) {
          const nth = n++;
          setTimeout(() => {
            if (w.ended || nth === hangAt) return;
            if (nth === failAt) return w.onerror?.(new Error('boom'));
            const nothing = js.map((j) => { try { return recipientScanTxForStealth({ ...j, walletPriv: wp, walletPub: wu, networkTag }).length === 0; } catch { return undefined; } });
            if (nth === undefAt) nothing.fill(undefined);
            w.onmessage?.({ data: { id, nothing: nth === shortAt ? nothing.slice(1) : nothing } });
          }, 1);
        } };
      made.push(w);
      return w;
    },
  });
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('every answer is the page\'s own: true where nothing is held, false where a credit is', async () => {
  const made = [];
  const r = await fake({ made })(key, jobs);
  assert.deepStrictEqual(r, own);
  assert.ok(made.length >= 2, 'workers were made');
  await pause(1800);
  assert.ok(made.every((w) => w.ended), 'and ended once it has been quiet');
});

test('a worker that fails, hangs or answers short leaves those transfers to the page, and the answers it gave stand', async () => {
  const check = (name, r, losing) => {
    assert.strictEqual(r.length, own.length, name);
    r.forEach((x, i) => assert.ok(x === undefined || x === own[i], `${name}: transfer ${i} is never answered wrongly`));
    assert.ok(r.filter((x) => x === undefined).length >= losing, `${name}: some are left to the page`);
    assert.ok(r.filter((x) => x !== undefined).length > 0, `${name}: the rest are answered`);
  };
  check('a worker that fails on one chunk', await fake({ failAt: 2 })(key, jobs), 1);
  check('a worker that never answers', await fake({ hangAt: 1, opts: { chunkMs: 400 } })(key, jobs), 1);
  check('a worker whose answer is too short', await fake({ shortAt: 0 })(key, jobs), 1);
  const none = await fake({ undefAt: 1 })(key, jobs);
  assert.ok(none.some((x) => x === undefined) && none.every((x, i) => x === undefined || x === own[i]), 'a worker that works out none of its chunk');
});

test('no Workers, none that can be made, or a handful of transfers: null, and the page does them all', async () => {
  assert.strictEqual(await makeStealthWorkers({ available: () => false })(key, jobs), null);
  const none = await fake({ opts: { makeThrows: true } })(key, jobs);
  assert.ok(none.every((x) => x === undefined), 'made none, so told nothing');
  const made = [];
  assert.strictEqual(await fake({ made })(key, jobs.slice(0, 5)), null);
  assert.strictEqual(made.length, 0, 'workers are not started for a handful');
});

test('the workers are kept between batches, then ended', async () => {
  const made = [];
  const keep = fake({ made, opts: { idleMs: 800 } });
  await keep(key, jobs.slice(0, 30)); await keep(key, jobs.slice(30));
  const first = made.length;
  assert.ok(made.every((w) => !w.ended), 'alive after the second batch');
  await pause(1800);
  assert.ok(made.every((w) => w.ended), 'ended once the scan has been quiet');
  await keep(key, jobs.slice(0, 30));
  assert.ok(made.length > first, 'a later scan makes new ones');
  await pause(1800);
});

test('the shipped worker file, run in threads, gives the same answers', async () => {
  const workerFile = fileURLToPath(new URL('../dapp/stealth-scan-worker.js', import.meta.url));
  const boot = `const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t) };
    const held = []; let up = false;
    parentPort.on('message', (data) => { if (up) globalThis.self.onmessage({ data }); else held.push(data); });
    import(${JSON.stringify('file://' + workerFile)}).then(() => { up = true; for (const d of held.splice(0)) globalThis.self.onmessage({ data: d }); }, (e) => parentPort.postMessage({ failed: String(e) }));`;
  const threads = [];
  const real = makeStealthWorkers({
    available: () => true, count: () => 2, chunk: 16, minJobs: 8, chunkMs: 60e3, idleMs: 800,
    make: () => {
      const t = new ThreadWorker(boot, { eval: true });
      const w = { onmessage: null, onerror: null, postMessage: (x) => t.postMessage(x), terminate: () => t.terminate() };
      t.on('message', (data) => { if (data.failed) return w.onerror?.(new Error(data.failed)); w.onmessage?.({ data }); });
      t.on('error', (e) => w.onerror?.(e));
      threads.push(t);
      return w;
    },
  });
  const r = await real(key, jobs);
  assert.deepStrictEqual(r, own, 'the shipped worker gives the answers the page gives');
  assert.strictEqual(threads.length, 2);
  await pause(1800);
});
