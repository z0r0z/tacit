// Tests for the tiered fee-rate selector in dapp/tacit.js getFeeRate().
//
// The tiers are:
//   economy   -> mempool.economyFee   OR blockstream['25']    (no margin)
//   standard  -> mempool.hourFee      OR blockstream['6']     (+5%)
//   priority  -> mempool.fastestFee   OR blockstream['1']     (+10%)
//
// signet has no fee market so the margin is skipped at every tier; the
// raw API quote (or the 2 sat/vB fallback floor) is returned as-is.
//
// User preference lives in localStorage['tacit-fee-tier-v1'] and defaults
// to 'standard'.

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

// Mock fetch so we control the fee-API responses
const MOCK_FEES = {
  fastestFee: 50,
  halfHourFee: 30,
  hourFee: 20,
  economyFee: 5,
  minimumFee: 1,
};
const MOCK_FEE_ESTIMATES = { '1': 50, '2': 40, '3': 30, '6': 20, '12': 10, '25': 5 };

let _fetchCallCount = 0;
globalThis.fetch = async (url, opts) => {
  _fetchCallCount++;
  if (typeof url !== 'string') url = String(url);
  if (url.endsWith('/v1/fees/recommended')) {
    return {
      ok: true,
      json: async () => MOCK_FEES,
    };
  }
  if (url.endsWith('/fee-estimates')) {
    return {
      ok: true,
      json: async () => MOCK_FEE_ESTIMATES,
    };
  }
  if (url.endsWith('/blocks/tip/height')) {
    return { ok: true, text: async () => '900000' };
  }
  // Default deny — anything else trips the test.
  return { ok: false, status: 404, text: async () => 'mock denied', json: async () => ({}) };
};

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

// Helper: wipe the fee-rate cache so each test reads the mock fresh
function clearCaches() {
  // The cache lives inside getFeeRate's closure; we don't have a direct
  // handle. But the cache TTL is 60s, so each test runs with a freshly
  // chosen tier so the (net, tier) cache key differs.
  // We also flip network here when needed via localStorage.
}

group('Tier preference: get/set');
{
  // default when nothing in localStorage
  globalThis.localStorage.removeItem('tacit-fee-tier-v1');
  ok('default tier = standard', dapp.getFeeTierPref() === 'standard');

  // set + get round-trip
  ok('setFeeTierPref(economy) → economy', dapp.setFeeTierPref('economy') === true && dapp.getFeeTierPref() === 'economy');
  ok('setFeeTierPref(priority) → priority', dapp.setFeeTierPref('priority') === true && dapp.getFeeTierPref() === 'priority');
  ok('setFeeTierPref(standard) → standard', dapp.setFeeTierPref('standard') === true && dapp.getFeeTierPref() === 'standard');

  // invalid tier → false, pref unchanged
  ok('setFeeTierPref(garbage) returns false', dapp.setFeeTierPref('garbage') === false);
  ok('pref after garbage is still standard', dapp.getFeeTierPref() === 'standard');

  // invalid localStorage value → falls back to standard
  globalThis.localStorage.setItem('tacit-fee-tier-v1', 'silly');
  ok('invalid stored value → default standard', dapp.getFeeTierPref() === 'standard');
}

group('Rate selection: signet (no margin at any tier)');
{
  globalThis.localStorage.setItem('tacit-network-v1', 'signet');
  // Need to nudge the dapp's NET back to signet — but on signet the
  // fallback floor is 2 and there's no fee-recommend endpoint by default.
  // We rely on the mocked fetch returning the mempool-style values.
  // (NET is closed-over inside the module, so we set localStorage before
  // first call. Since dapp is already imported with default mainnet, we
  // need to force the network resolution at call time — which getFeeRate
  // does by reading NET.name. Setting localStorage AFTER import does NOT
  // change NET because NET is captured at module load. Skip the signet
  // section unless we restart the module.)
  console.log('  (signet rate-selection skipped — NET captured at import time)');
}

group('Rate selection: tier mapping at mock prices');
{
  // dapp loaded with default mainnet (no tacit-network-v1 set originally).
  // Confirm by computing one rate and observing it's in the mainnet
  // range (with margin).
  globalThis.localStorage.setItem('tacit-fee-tier-v1', 'economy');
  const r_econ = await dapp.getFeeRate('economy');
  ok(`economy: mempool.economyFee(5) → ${r_econ} sat/vB (expected 5, no margin)`,
    r_econ === 5);

  globalThis.localStorage.setItem('tacit-fee-tier-v1', 'standard');
  const r_std = await dapp.getFeeRate('standard');
  ok(`standard: ceil(hourFee(20) × 1.05) = 21 → got ${r_std}`,
    r_std === 21);

  globalThis.localStorage.setItem('tacit-fee-tier-v1', 'priority');
  const r_pri = await dapp.getFeeRate('priority');
  ok(`priority: ceil(fastestFee(50) × 1.10) = 55 → got ${r_pri}`,
    r_pri === 55);

  // Explicit tier override wins over localStorage
  globalThis.localStorage.setItem('tacit-fee-tier-v1', 'economy');
  const r_override = await dapp.getFeeRate('priority');
  ok(`explicit priority overrides localStorage(economy): got ${r_override}, expected 55`,
    r_override === 55);
}

group('Tier ordering: priority > standard > economy');
{
  globalThis.localStorage.removeItem('tacit-fee-tier-v1');
  const r_e = await dapp.getFeeRate('economy');
  const r_s = await dapp.getFeeRate('standard');
  const r_p = await dapp.getFeeRate('priority');
  ok(`economy ≤ standard ≤ priority (${r_e} ≤ ${r_s} ≤ ${r_p})`,
    r_e <= r_s && r_s <= r_p);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
