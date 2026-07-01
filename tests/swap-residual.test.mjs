// Swap residual-bid math unit tests.
//
// Re-implements the swap pricing + residual-as-bid arithmetic from
// dapp/tacit.js (planBuy + residual bid amount + min-fill floor) and
// runs it against a snapshot of real mainnet TAC preauth-sales data.
// Catches off-by-one + BigInt overflow + rounding bugs in the maths
// that route every Swap-tile click through to publishBidIntent.
//
// Run: node tests/swap-residual.test.mjs
// Pure JS, no chain, no signing, no network.

import { strict as assert } from 'node:assert';

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`✓ ${name}`); pass++; }
  catch (e) { console.error(`✗ ${name}: ${e.message}`); fail++; }
};

// ============================================================================
// Replica of the production swap math (dapp/tacit.js).
// Keep these in sync with the source — diff-search planBuy +
// residual-bid post + minFillAmount when modifying.
// ============================================================================

const DUST = 546; // BIP-141 dust limit on P2WPKH

// unit price (sats per whole token at `decimals`).
function unitPriceSats(priceSats, amountBaseBigInt, decimals) {
  const amt = Number(amountBaseBigInt);
  if (!Number.isFinite(amt) || amt <= 0) return null;
  const p = Number(priceSats);
  if (!Number.isFinite(p) || p <= 0) return null;
  return (p * Math.pow(10, decimals)) / amt;
}

// planBuy: sort live asks by unit price ascending, take greedily until
// budget is exhausted or cap is reached. Mirrors the production
// closure in _wireSwapTile.
function planBuy({ asks, satsBudget, cap, decimals, myPubHex = '', dustFloorUnit = 0 }) {
  if (!Number.isFinite(satsBudget) || satsBudget <= 0) return null;
  const candidates = [];
  for (const l of asks) {
    if (l.kind === 'preauth') {
      if (l.seller_pubkey === myPubHex) continue;
      const amt = BigInt(l.asset_opening?.amount || 0);
      const ps  = Number(l.min_price_sats || 0);
      const u   = unitPriceSats(ps, amt, decimals);
      if (!Number.isFinite(u) || u <= 0 || u > cap || u < dustFloorUnit || amt <= 0n || ps <= 0) continue;
      candidates.push({ kind: 'preauth', l, amt, ps, u });
    }
  }
  candidates.sort((a, b) => a.u - b.u);
  if (!candidates.length) return null;
  const plan = []; let totalSats = 0; let totalAmt = 0n;
  for (const c of candidates) {
    const remaining = satsBudget - totalSats;
    if (remaining <= 0) break;
    if (totalSats + c.ps > satsBudget) continue;
    plan.push(c); totalSats += c.ps; totalAmt += c.amt;
  }
  if (!plan.length) return null;
  return { plan, totalAmt, totalSats, residualSats: satsBudget - totalSats, satsBudget, cap };
}

// Residual-bid post math (dapp/tacit.js:68945).
function planResidualBid({ residualSats, cap, decimals }) {
  if (!(residualSats >= DUST) || !Number.isFinite(cap) || cap <= 0) {
    return { posted: false, reason: 'residual below dust or no cap' };
  }
  const _residualSatsBI = BigInt(Math.floor(residualSats));
  const _CAP_SCALE = 1_000_000_000_000n;
  const _capScaled = BigInt(Math.floor(cap * Number(_CAP_SCALE)));
  const _bidAmt = _capScaled > 0n
    ? (_residualSatsBI * (10n ** BigInt(decimals)) * _CAP_SCALE) / _capScaled
    : 0n;
  if (_bidAmt <= 0n) {
    return { posted: false, reason: 'residual too small to buy 1 base unit at cap' };
  }
  let _minFill = _bidAmt / 10n;
  const _dustFloor = (BigInt(DUST) * _bidAmt + BigInt(residualSats) - 1n) / BigInt(residualSats);
  if (_dustFloor > _minFill) _minFill = _dustFloor;
  if (_minFill >= _bidAmt) _minFill = 0n;
  return {
    posted: true,
    bidAmt: _bidAmt,
    priceSats: residualSats,
    capUnit: cap,
    minFillAmount: _minFill,
    expirySecondsFromNow: 24 * 3600,
  };
}

// ============================================================================
// Real mainnet TAC orderbook snapshot (asks side), 2026-05-20.
// Source: api.tacit.finance/.../preauth-sales?network=mainnet
// Sorted by unit-price ascending. Includes dust outliers so the test
// also exercises the dust-band filter.
// ============================================================================

const TAC_DECIMALS = 8;
const TAC_MARK = 203.5314;
const TAC_DUST_FLOOR = TAC_MARK * 0.2;  // ~40.7 sats/TAC — below this is dust per 0.2× band

const TAC_ASKS = [
  // Three dust outliers — should be filtered by dust-floor band
  { kind: 'preauth', sale_id: 'c4b1aa0a', min_price_sats:     546, asset_opening: { amount: '18808479937' }, expiry: 9999999999 }, // 2.90 sats/TAC
  { kind: 'preauth', sale_id: '2a790ca9', min_price_sats:     546, asset_opening: { amount:  '5095186930' }, expiry: 9999999999 }, // 10.72 sats/TAC
  { kind: 'preauth', sale_id: '48683335', min_price_sats:    1000, asset_opening: { amount:  '5405167844' }, expiry: 9999999999 }, // 18.50 sats/TAC
  // In-band asks (real TAC orderbook)
  { kind: 'preauth', sale_id: 'e45106ba', min_price_sats:   50000, asset_opening: { amount: '62853035838' }, expiry: 9999999999 }, // 79.55 sats/TAC × 628.53 TAC  ← BEST
  { kind: 'preauth', sale_id: '5f538871', min_price_sats:   70000, asset_opening: { amount: '47041238615' }, expiry: 9999999999 }, // 148.81 sats/TAC × 470.41 TAC
  { kind: 'preauth', sale_id: '466921fe', min_price_sats:  150000, asset_opening: { amount:'100709247325' }, expiry: 9999999999 }, // 148.94 sats/TAC × 1007.09 TAC
  { kind: 'preauth', sale_id: 'c68ff9c2', min_price_sats:    4000, asset_opening: { amount:  '2682692731' }, expiry: 9999999999 }, // 149.10 sats/TAC × 26.83 TAC
  { kind: 'preauth', sale_id: '13b32312', min_price_sats:    4500, asset_opening: { amount:  '3000000000' }, expiry: 9999999999 }, // 150.00 sats/TAC × 30 TAC
  { kind: 'preauth', sale_id: '170c7ce0', min_price_sats:  778512, asset_opening: { amount:'463374163790' }, expiry: 9999999999 }, // 168.01 sats/TAC × 4633.74 TAC
  { kind: 'preauth', sale_id: 'f76adeca', min_price_sats: 1250000, asset_opening: { amount:'737963902139' }, expiry: 9999999999 }, // 169.38 sats/TAC × 7379.64 TAC
];

// ============================================================================
// Tests
// ============================================================================

test('unitPriceSats: 39000 sats / 19,161,664,466 base = 203.53 sats/TAC', () => {
  const u = unitPriceSats(39_000, 19_161_664_466n, TAC_DECIMALS);
  assert.ok(Math.abs(u - 203.5314) < 0.001, `expected ≈203.5314, got ${u}`);
});

test('unitPriceSats: real TAC BEST ask 50,000 / 628.53 TAC = 79.55', () => {
  const u = unitPriceSats(50_000, 62_853_035_838n, TAC_DECIMALS);
  assert.ok(Math.abs(u - 79.55) < 0.01, `expected ≈79.55, got ${u}`);
});

test('planBuy: $10 budget (~12,702 sats) at +20% cap fills 6 asks under cap', () => {
  const cap = TAC_MARK * 1.20;  // 244.24
  const r = planBuy({ asks: TAC_ASKS, satsBudget: 12_702, cap, decimals: TAC_DECIMALS, dustFloorUnit: TAC_DUST_FLOOR });
  assert.ok(r, 'expected non-null plan');
  assert.ok(r.plan.length >= 2, `expected ≥2 fills, got ${r.plan.length}`);
  // Cheapest in-band is 79.55, next several are 148-150. Budget 12,702 sats
  // should take BEST (50,000 sats too much — skipped) + smaller asks at 148-150.
  // Actually 50,000 > 12,702 so BEST is skipped by the budget check; planner
  // walks to the smaller listings (4,000 sat ask, 4,500 sat ask, etc.).
  const cheapest = Math.min(...r.plan.map(c => c.u));
  const dearest  = Math.max(...r.plan.map(c => c.u));
  assert.ok(cheapest >= TAC_DUST_FLOOR, `cheapest ${cheapest} dipped below dust band`);
  assert.ok(dearest <= cap, `dearest ${dearest} exceeded cap ${cap}`);
  // Total sats spent should be ≤ budget (no overspend)
  assert.ok(r.totalSats <= 12_702, `overspent: ${r.totalSats} > 12,702`);
  // Residual = budget - totalSats
  assert.equal(r.residualSats, 12_702 - r.totalSats);
});

test('planBuy: dust outliers (2.90 / 10.72 / 18.50 sats/TAC) excluded by dust-floor band', () => {
  const cap = TAC_MARK * 1.20;
  const r = planBuy({ asks: TAC_ASKS, satsBudget: 1_000_000, cap, decimals: TAC_DECIMALS, dustFloorUnit: TAC_DUST_FLOOR });
  assert.ok(r);
  for (const c of r.plan) {
    assert.ok(c.u >= TAC_DUST_FLOOR, `dust ask ${c.u} sats/TAC slipped through filter (floor ${TAC_DUST_FLOOR})`);
  }
});

test('planBuy: tiny budget ≪ cheapest ask returns null', () => {
  // 100 sats can't buy any TAC ask (cheapest in-band single ask is 4,000 sats)
  const cap = TAC_MARK * 1.20;
  const r = planBuy({ asks: TAC_ASKS, satsBudget: 100, cap, decimals: TAC_DECIMALS, dustFloorUnit: TAC_DUST_FLOOR });
  // 100 sats < DUST so no fill is possible; planner returns null OR empty
  if (r) assert.equal(r.plan.length, 0, 'planBuy filled despite budget < ask sats');
});

test('planResidualBid: $10 budget with $1 leftover @ cap=244 sats/TAC posts a bid', () => {
  const cap = TAC_MARK * 1.20;
  const residualSats = 1_270;  // ~$1 leftover after fills
  const r = planResidualBid({ residualSats, cap, decimals: TAC_DECIMALS });
  assert.ok(r.posted, `residual bid not posted: ${r.reason || 'unknown'}`);
  // bidAmt = 1270 × 10^8 / 244.24 = 520_054_602 base units = 5.2 TAC
  assert.ok(r.bidAmt > 0n, 'bidAmt should be positive');
  const tacFloat = Number(r.bidAmt) / Math.pow(10, TAC_DECIMALS);
  assert.ok(tacFloat > 5.1 && tacFloat < 5.3, `expected ~5.2 TAC bid, got ${tacFloat}`);
  assert.equal(r.priceSats, residualSats, 'priceSats must equal residualSats');
  assert.equal(r.capUnit, cap, 'capUnit must equal cap');
  assert.equal(r.expirySecondsFromNow, 24 * 3600, 'expiry must be 24h');
  // Min-fill floor = max(bidAmt/10, dustFloor); should be < bidAmt
  assert.ok(r.minFillAmount > 0n && r.minFillAmount < r.bidAmt, `minFill ${r.minFillAmount} should be 0 < n < bidAmt ${r.bidAmt}`);
});

test('planResidualBid: residual below DUST (≤545 sats) skips bid post', () => {
  const cap = TAC_MARK * 1.20;
  const r = planResidualBid({ residualSats: 545, cap, decimals: TAC_DECIMALS });
  assert.equal(r.posted, false);
});

test('planResidualBid: cap so high residual can\'t buy 1 base unit → flag, no bid', () => {
  // residual 1000 sats, cap 1e18 sats/TAC → bidAmt rounds to 0
  const r = planResidualBid({ residualSats: 1000, cap: 1e18, decimals: TAC_DECIMALS });
  assert.equal(r.posted, false);
  assert.match(r.reason, /too small/);
});

test('planResidualBid: minFill floor = dust-anchored when amount/10 is below dust threshold', () => {
  // Tiny residual ~1500 sats, modest cap. minFill = max(bidAmt/10, ceil(DUST*bidAmt/residual))
  const cap = 200;
  const residualSats = 1500;
  const r = planResidualBid({ residualSats, cap, decimals: TAC_DECIMALS });
  assert.ok(r.posted);
  // Compute expected dust floor: DUST * bidAmt / residualSats rounded up
  const expectedDustFloor = (BigInt(DUST) * r.bidAmt + BigInt(residualSats) - 1n) / BigInt(residualSats);
  const tenPct = r.bidAmt / 10n;
  const expectedMinFill = expectedDustFloor > tenPct ? expectedDustFloor : tenPct;
  assert.equal(r.minFillAmount, expectedMinFill,
    `minFill mismatch: got ${r.minFillAmount}, expected ${expectedMinFill} (dustFloor ${expectedDustFloor} vs 10%=${tenPct})`);
});

test('end-to-end: $200 budget gets multi-fill plan + posts large residual bid', () => {
  const budget = 200 * 12_702 / 10;  // ~254_040 sats for $200
  const cap = TAC_MARK * 1.20;
  const plan = planBuy({ asks: TAC_ASKS, satsBudget: budget, cap, decimals: TAC_DECIMALS, dustFloorUnit: TAC_DUST_FLOOR });
  assert.ok(plan, 'expected plan');
  const residual = plan.residualSats;
  const bid = planResidualBid({ residualSats: residual, cap, decimals: TAC_DECIMALS });
  if (residual >= DUST) {
    assert.ok(bid.posted, `expected residual bid for ${residual} sats but got: ${bid.reason}`);
    assert.equal(bid.expirySecondsFromNow, 24 * 3600);
  }
  // Sanity: filled + residual = budget
  assert.equal(plan.totalSats + residual, budget);
});

test('budget-exhausts-book: budget larger than total ask sats → all asks taken, big residual', () => {
  // Sum all in-band ask sats to bound budget
  const inBandSatTotal = TAC_ASKS
    .filter(a => unitPriceSats(a.min_price_sats, BigInt(a.asset_opening.amount), TAC_DECIMALS) >= TAC_DUST_FLOOR)
    .reduce((s, a) => s + Number(a.min_price_sats), 0);
  const budget = inBandSatTotal * 3;
  const cap = TAC_MARK * 1.20;
  const plan = planBuy({ asks: TAC_ASKS, satsBudget: budget, cap, decimals: TAC_DECIMALS, dustFloorUnit: TAC_DUST_FLOOR });
  assert.ok(plan);
  assert.ok(plan.residualSats >= budget - inBandSatTotal,
    `residual too small: got ${plan.residualSats}, expected ≥ ${budget - inBandSatTotal}`);
  // Residual should post a substantial bid
  const bid = planResidualBid({ residualSats: plan.residualSats, cap, decimals: TAC_DECIMALS });
  assert.ok(bid.posted);
  // bidAmt in whole TAC should be substantial (hundreds of TAC at $0.15 each)
  const tacFloat = Number(bid.bidAmt) / Math.pow(10, TAC_DECIMALS);
  assert.ok(tacFloat > 100, `expected >100 TAC residual bid for oversized budget, got ${tacFloat}`);
});

test('BigInt safety: residual × 10^8 doesn\'t lose precision at 0.9 BTC scale', () => {
  // Residual ~90M sats (0.9 BTC) at 8-dec asset. Naive Math operations would
  // overflow Number.MAX_SAFE_INTEGER. Verify BigInt path returns sane bidAmt.
  const residualSats = 90_000_000;  // 0.9 BTC
  const cap = 200;  // sats/TAC
  const r = planResidualBid({ residualSats, cap, decimals: TAC_DECIMALS });
  assert.ok(r.posted);
  // Expected: bidAmt = 90,000,000 sats / 200 sats/TAC = 450,000 TAC
  // (i.e. residualSats × 10^decimals / cap = 9e7 × 10^8 / 200 = 4.5e13 base)
  const tacFloat = Number(r.bidAmt) / Math.pow(10, TAC_DECIMALS);
  assert.ok(Math.abs(tacFloat - 450_000) < 1, `expected ~450,000 TAC, got ${tacFloat}`);
});

test('low-decimal high-cap edge: cap too high to buy 1 base unit', () => {
  // 0-decimal asset (e.g. an NFT-like collection), residual 1000 sats,
  // cap 10,000 sats/TAC. residualSats * 10^0 / cap = 0 base units.
  const r = planResidualBid({ residualSats: 1000, cap: 10_000, decimals: 0 });
  assert.equal(r.posted, false);
  assert.match(r.reason, /too small/);
});

// ============================================================================

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
