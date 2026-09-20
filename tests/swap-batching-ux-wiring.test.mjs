// The swap coordinator is mounted in confidential-pool-ux.js and reachable as ux.swapBatched.
//
// tests/confidential-swap-coordinator.mjs already proves the coordinator itself: two intents collapse into
// one OP_SWAP, the assembled op passes the guest-mirror verifyBatch, each trader gets their own slice. What
// that test cannot catch is the mount — the coordinator was written months ago and never constructed, so
// `makeConfidentialSwap` appeared nowhere in ux and `ux.swapBatched` did not exist. This test pins the
// wiring so it cannot silently come undone: the export is present, the deps it needs are the ones ux
// actually has, and the pool's live root read that feeds `reservesFor` uses the right selector.
//
// Most checks are source-level, but the important one is not: mounting the coordinator means CONSTRUCTING it
// at ux init, so a dependency declared later in the module body would be in its temporal dead zone and throw
// on load — taking the whole dapp with it. No source-level check catches that, so the last case builds the
// real ux against stubs.
//
// Run: node tests/swap-batching-ux-wiring.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ux = readFileSync(join(ROOT, 'dapp/confidential-pool-ux.js'), 'utf8');
const coord = readFileSync(join(ROOT, 'dapp/confidential-swap-coordinator.js'), 'utf8');

let pass = 0, fail = 0;
const test = (label, fn) => {
  try { fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const ok = (c, m) => { if (!c) throw new Error(m); };

console.log('swap-batching ux wiring:\n');

test('ux imports the coordinator and the swap assembler it needs', () => {
  ok(/import \{ makeConfidentialSwapCoordinator \} from '\.\/confidential-swap-coordinator\.js'/.test(ux), 'coordinator import');
  ok(/import \{ makeConfidentialSwap \} from '\.\/confidential-swap\.js'/.test(ux), 'assembler import');
});

test('ux constructs the coordinator', () => {
  ok(/makeConfidentialSwapCoordinator\(\{/.test(ux), 'coordinator not constructed');
  ok(/makeConfidentialSwap\(\{ keccak256, pool \}\)/.test(ux), 'assembler not constructed with ux deps');
});

test('every dependency the coordinator requires is supplied', () => {
  // The coordinator throws at construction if any of these is missing, so a mount that omits one is a
  // runtime failure the moment a swap is queued rather than at load.
  const required = ['swap', 'pool', 'kernelSign', 'reservesFor', 'submitBatch', 'chainBindingHex', 'ephRand'];
  ok(/if \(!swap \|\| !pool \|\| !kernelSign \|\| !reservesFor \|\| !submitBatch \|\| !chainBindingHex \|\| !ephRand\)/.test(coord),
    'coordinator guard changed — update this list');
  const block = ux.slice(ux.indexOf('makeConfidentialSwapCoordinator({'), ux.indexOf('const swapBatched'));
  // Accept both `dep: value` and the ES shorthand `dep,` — both supply it.
  for (const d of required) ok(new RegExp(`\\b${d}\\s*[:,]`).test(block), `dep not supplied: ${d}`);
});

test('the batch submits as an OP_SWAP through the relay', () => {
  const block = ux.slice(ux.indexOf('submitBatch:'), ux.indexOf('const swapBatched'));
  ok(/relay\.settle\(/.test(block), 'submitBatch does not go through relay.settle');
  ok(/type: 'swap'/.test(block), "submitBatch must submit type 'swap' (OP_SWAP), not route");
});

test('ux exposes swapBatched / pending / flush', () => {
  for (const f of ['swapBatched', 'swapBatchPending', 'swapBatchFlush']) {
    ok(new RegExp(`\\b${f}\\b`).test(ux.slice(ux.lastIndexOf('return {'))), `not exported: ${f}`);
  }
});

test('reservesFor feeds the coordinator the live pool root, via the right selector', () => {
  ok(/async function poolCurrentRoot\(\)/.test(ux), 'poolCurrentRoot helper missing');
  ok(/spendRoot: await poolCurrentRoot\(\)/.test(ux), 'reservesFor does not supply the live root');
  const sel = '0x' + Buffer.from(keccak_256(new TextEncoder().encode('currentRoot()'))).toString('hex').slice(0, 8);
  ok(sel === '0xfdab463d', `currentRoot() selector drifted: ${sel}`);
  ok(/_selector\('currentRoot\(\)'\)/.test(ux), 'poolCurrentRoot does not call currentRoot()');
});

test('mounting it did not change the default swap path', () => {
  // Availability is not activation. The swap tab still routes through ux.route; flipping that is a caller
  // decision, and batching only buys privacy when peers trade the same pool inside the window.
  const tab = readFileSync(join(ROOT, 'dapp/confidential-swap-tab.js'), 'utf8');
  ok(/ux\.route\(/.test(tab), 'swap tab no longer calls ux.route — if that was deliberate, update this test');
});

// The one that actually matters: does ux still construct with the coordinator mounted?
const asyncTest = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};

await asyncTest('ux constructs with the coordinator mounted (no TDZ, no missing dep)', async () => {
  globalThis.fetch = globalThis.fetch || (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }));
  globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const secp = await import('@noble/secp256k1');
  const { sha256 } = await import('@noble/hashes/sha256');
  const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
  const built = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: globalThis.fetch, network: 'mainnet' });
  for (const f of ['swapBatched', 'swapBatchPending', 'swapBatchFlush', 'poolCurrentRoot']) {
    ok(typeof built[f] === 'function', `${f} is not callable on the built ux`);
  }
  ok(typeof built.route === 'function', 'route disappeared — the default swap path must stay intact');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
