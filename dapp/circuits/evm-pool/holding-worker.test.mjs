// The holding worker (dapp/holding-prove-worker.js) in a real browser, from the dapp's own files: its imports resolve, its
// Poseidon is the vendor bundles' (eight inputs included), it builds claims from a snapshot and proves one with the pinned key,
// and the points service's verifier accepts the proof. What the node tests cannot show: the page's modules and workers as served.
//   [PLAYWRIGHT=<path to playwright-core>] node holding-worker.test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPoseidon } from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import { makeEvmPoolZk } from '../../evm-pool-zk.js';
import { mulB8, L_BJJ, P_FR } from '../../btc-pool-zk.js';
import { spentSet } from '../../holding-claim.js';
import { verifyHoldingClaim } from '../../../worker-relay/src/lib/holding-claims.js';
import { claimHashOf, DEFAULT_BUCKETS_WEI } from '../../../worker-relay/src/lib/holding-epoch.js';
import { isolationHeaders } from '../../../tools/site-isolation-rules.mjs';

import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT || '/Users/z/zFi/node_modules/playwright-core');   // as tools/weld-check.mjs finds it
const DAPP = fileURLToPath(new URL('../../', import.meta.url));
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.html': 'text/html' };
// served with the headers the site sends: /tac/ is cross-origin isolated and the worker's script carries the embedder policy too
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname), f = path.join(DAPP, p);
  for (const [name, value] of Object.entries(isolationHeaders(p))) res.setHeader(name, value);
  if (p === '/tac/blank.html') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><title>blank</title>'); }
  if (!f.startsWith(DAPP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream'); res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const P = await buildPoseidon();
const zk = makeEvmPoolZk({ poseidon: (xs) => P.F.toObject(P(xs.map(BigInt))) });
const rnd = (m) => { let x = 0n; while (x === 0n) x = BigInt('0x' + crypto.randomBytes(32).toString('hex')) % m; return x; };
const ETH = 10n ** 18n, asset = 424242n, chainId = 8453, epoch = 20800, claimAddress = '0x' + 'ab'.repeat(20);
const mkNote = (v) => { const sk = rnd(L_BJJ), nk = rnd(L_BJJ), rho = rnd(P_FR); return { sk, nk, rho, v, leaf: zk.leafOf(asset, v, zk.npkOf(mulB8(sk), mulB8(nk)), rho) }; };
const notes = Array.from({ length: 40 }, (_, i) => mkNote(i === 11 ? 3n * ETH / 2n : BigInt(i + 1) * ETH / 1000n));
const leaves = notes.map((n) => n.leaf);
const nfs = [0, 5, 20, 30].map((i) => zk.nullifier(notes[i].nk, notes[i].leaf, BigInt(i)));
const snapshot = { root: zk.tree(leaves).root, nfRoot: spentSet(nfs, zk.H).root, size: leaves.length };
const mine = [{ index: 11, ...notes[11] }].map((n) => ({ index: n.index, leaf: String(n.leaf), v: String(n.v), rho: String(n.rho), sk: String(n.sk), nk: String(n.nk) }));
const args = { asset, chainId, epoch, snapshot: { root: String(snapshot.root), nfRoot: String(snapshot.nfRoot), size: snapshot.size }, leaves: leaves.map(String), nullifiers: nfs.map(String), notes: mine, buckets: DEFAULT_BUCKETS_WEI, claimAddress };

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/tac/blank.html`);                                  // an isolated page, as the front page and /tac/ are
  const out = await page.evaluate(async ({ args, pinPath }) => {
    if (!crossOriginIsolated) throw new Error('the page is not cross-origin isolated');
    const w = new Worker('/holding-prove-worker.js', { type: 'module' });
    let id = 0; const wait = new Map();
    w.onmessage = ({ data }) => { const f = wait.get(data.id); wait.delete(data.id); data.ok ? f.res(data) : f.rej(new Error(data.error)); };
    w.onerror = (e) => { for (const f of wait.values()) f.rej(new Error('worker error: ' + (e.message || 'failed to load'))); };
    const call = (msg) => new Promise((res, rej) => { const i = ++id; wait.set(i, { res, rej }); w.postMessage({ ...msg, id: i }); });
    const t0 = performance.now();
    const built = await call({ op: 'build', args });
    const tBuild = performance.now() - t0;
    const pin = await (await fetch(pinPath)).json();
    const get = async (n) => new Uint8Array(await (await fetch('/evm-pool/' + n)).arrayBuffer());
    const [vk, wasm, zkey] = await Promise.all([get(pin.vk), get(pin.wasm), get(pin.zkey)]);
    await call({ op: 'init', wasm, zkey, vk: JSON.parse(new TextDecoder().decode(vk)) });
    const t1 = performance.now();
    const proved = await call({ op: 'prove', input: built.claims[0].input });
    w.terminate();
    return { claims: built.claims, tBuild, tProve: performance.now() - t1, proved };
  }, { args, pinPath: '/evm-pool/holding-pin.json' });
  assert.deepEqual(out.claims.map((c) => [c.index, c.bucketWei]), [[11, String(ETH)]], 'the worker builds the claim a wallet is owed');
  console.log(`   in Chromium: built in ${(out.tBuild / 1000).toFixed(1)} s, proved in ${(out.tProve / 1000).toFixed(1)} s`);
  const vkey = JSON.parse(fs.readFileSync(new URL('../../evm-pool/holding_vk.json', import.meta.url), 'utf8'));
  const v = await verifyHoldingClaim({ claim: { chainId, epoch, claimAddress, proof: out.proved.proof, publicSignals: out.proved.publicSignals }, snapshot: { root: String(snapshot.root), nfRoot: String(snapshot.nfRoot) }, buckets: DEFAULT_BUCKETS_WEI, poolAsset: asset, vkey, groth16: snarkjs.groth16 });
  assert.equal(v.ok, true, String(v.reason));
  assert.equal(BigInt(out.proved.publicSignals[5]), claimHashOf({ chainId, epoch, claimAddress }), 'bound to the payout address');
  assert.deepEqual(errors, [], 'no page or worker errors');
  console.log('ok - in a real browser the worker builds a claim from a snapshot with the page\'s own Poseidon, proves it with the pinned key, and the points service\'s verifier accepts it');
} finally { await browser.close(); server.close(); }
process.exit(0);
