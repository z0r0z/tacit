// Regression test for the low-rate overpay bug: when mempool.hourFee was
// e.g. 1.4 sat/vB, the old getFeeRate would ceil the API value to 2 and
// then apply a 5%/10% margin on top, returning 3 sat/vB — ~2× the actual
// clearing rate. mempool.space's audit flagged these as "Overpaid 2x"
// (see e.g. mempool.space tx ebc322a8b611f95f9723ec4ffc961d38e3812b72cb7bc34dba1dc44c9e6df15e).
//
// New behavior:
//   1. base is held as a float (no early ceil)
//   2. tier margins only apply when base ≥ 5 sat/vB (no spike to hedge
//      against at low mempool depth)
//   3. min-relay floor of 1 sat/vB still enforced
//
// This file uses a fresh module load so the per-(net,tier) rate cache
// inside getFeeRate is empty; bundling these cases into fee-tier.test.mjs
// would hit cached values from the prior MOCK_FEES.

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;

// Low-rate mempool (post-halving, post-Ordinals-cooldown): hourFee in
// fractional territory. Reproduces the mainnet conditions on 2026-05-18.
const MOCK_FEES = {
  fastestFee: 2,
  halfHourFee: 1.5,
  hourFee: 1.4,
  economyFee: 1,
  minimumFee: 1,
};
const MOCK_FEE_ESTIMATES = { '1': 2, '2': 1.8, '3': 1.6, '6': 1.4, '12': 1.2, '25': 1 };

globalThis.fetch = async (url) => {
  if (typeof url !== 'string') url = String(url);
  if (url.endsWith('/v1/fees/recommended')) return { ok: true, json: async () => MOCK_FEES };
  if (url.endsWith('/fee-estimates')) return { ok: true, json: async () => MOCK_FEE_ESTIMATES };
  if (url.endsWith('/blocks/tip/height')) return { ok: true, text: async () => '900000' };
  return { ok: false, status: 404, text: async () => 'mock denied', json: async () => ({}) };
};

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(t) { console.log(`\n${t}:`); }

group('Low-rate mempool: no compounded overpay');
{
  const r_econ = await dapp.getFeeRate('economy');
  ok(`economy at economyFee=1 → ${r_econ} sat/vB (expected 1, min-relay floor)`,
    r_econ === 1);

  const r_std = await dapp.getFeeRate('standard');
  ok(`standard at hourFee=1.4 → ${r_std} sat/vB (expected 1.4, margin skipped <5)`,
    r_std === 1.4);

  const r_pri = await dapp.getFeeRate('priority');
  ok(`priority at fastestFee=2 → ${r_pri} sat/vB (expected 2, margin skipped <5)`,
    r_pri === 2);

  // The whole point: at low base rates we no longer pay ~2× the API quote.
  // Old code would have returned 3 sat/vB here (ceil(1.4)=2 → ceil(2×1.05)=3).
  ok(`standard rate is not ≥ 2× hourFee (got ${r_std} vs API 1.4)`,
    r_std < 1.4 * 2);
}

group('feeFor effective rate matches quoted rate');
{
  const rate = await dapp.getFeeRate('standard'); // 1.4
  // Typical reveal tx ~526 vbytes (matches the overpay tx in the bug report)
  const fee = dapp.feeFor(526, rate);
  // 526 * 1.4 = 736.4 → ceil = 737. Effective rate = 737/526 ≈ 1.401.
  // The 500-sat min floor in feeFor doesn't kick in here.
  ok(`feeFor(526, 1.4) = 737 sats (got ${fee})`,
    fee === 737);

  const effective = fee / 526;
  ok(`effective rate ${effective.toFixed(3)} sat/vB stays within 1% of quoted 1.4`,
    Math.abs(effective - 1.4) / 1.4 < 0.01);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
