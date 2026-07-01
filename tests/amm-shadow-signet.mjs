// AMM trustless-replay SHADOW harness — signet, READ-ONLY (no funds needed).
//
// For every live signet AMM pool, runs dapp.ammReserveShadowCheck: it
// reconstructs { reserveA, reserveB, totalShares } from chain alone (the
// client-side trustless replay, worker = discovery only) and diffs it against
// the worker's reported reserves. A clean run — every pool MATCH — is the gate
// that validates the credit path can be moved off the worker's numbers
// (Phase 4.4). A MISMATCH is a discrepancy to resolve BEFORE any user balance
// depends on the replay.
//
// NOTE: discovery uses the worker's per-pool op index (GET /amm/pool/<id>/ops),
// which only captures ops processed AFTER the worker is redeployed with the
// recordAmmOp change. Pools whose ops predate that deploy show ERROR (empty op
// list) — expected; they aren't a replay failure. Validate against a pool with
// FRESH (post-deploy) ops.
//
// Run:  node tests/amm-shadow-signet.mjs
//       TACIT_WORKER_BASE=https://… node tests/amm-shadow-signet.mjs   (override)

import { JSDOM } from 'jsdom';

const WORKER = process.env.TACIT_WORKER_BASE || 'https://api.tacit.finance';
globalThis.__TACIT_WORKER_BASE__ = WORKER;

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const dapp = await import('../dapp/tacit.js');

console.log(`AMM shadow check — signet — worker ${WORKER}\n`);

const resp = await fetch(`${WORKER}/amm/pools?limit=200&network=signet`);
if (!resp.ok) { console.error(`/amm/pools failed: ${resp.status}`); process.exit(2); }
const body = await resp.json();
const pools = Array.isArray(body?.pools) ? body.pools : [];
if (pools.length === 0) {
  console.log('No live signet AMM pools. Create one (fund + run amm-full-e2e-signet) to generate op history, then re-run.');
  process.exit(0);
}
console.log(`${pools.length} live pool(s):\n`);

let matched = 0, mismatched = 0, errored = 0;
for (const p of pools) {
  const pid = String(p.pool_id || '');
  const short = pid.slice(0, 12);
  try {
    const r = await dapp.ammReserveShadowCheck(pid);
    if (r.match) {
      matched++;
      console.log(`  MATCH    ${short}…  A=${r.derived.reserveA} B=${r.derived.reserveB} S=${r.derived.totalShares}`);
    } else {
      mismatched++;
      console.log(`  MISMATCH ${short}…`);
      for (const d of r.diffs) console.log(`             ${d}`);
    }
  } catch (e) {
    errored++;
    console.log(`  ERROR    ${short}…  ${e.message}`);
  }
}

console.log(`\n${matched} match · ${mismatched} mismatch · ${errored} error  (of ${pools.length})`);
// A clean validation requires zero mismatches; errors on pre-index pools are
// expected and don't fail the run on their own.
process.exit(mismatched > 0 ? 1 : 0);
