#!/usr/bin/env node
// Gas-priced relay quote + profitability guard (worker/src/relay-quote.js).
// Run: node tests/relay-quote.test.mjs
import assert from 'node:assert';
import { floorWei, floorInFeeUnits, isProfitable, feeLegsOf, feeAssetOf, passesFloor, totalFee, decodePoolState, ammUsdPerUnit, ammUsdPerUnitBest, AMM_PRICE_DEFAULTS } from '../worker/src/relay-quote.js';

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const GAS = 20000000000n;       // 20 gwei
const WPU = 10000000000n;       // 1e10 wei per in-system cETH unit (unitScale @ tacitDecimals 8)

// ── gas-priced floor (replaces bps-of-value) ──
{
  const fw = floorWei({ gasPriceWei: GAS, effects: 2n, marginBps: 0n }); // 360000 gas × 20 gwei
  assert.strictEqual(fw, 360000n * GAS, 'floorWei = settleGas × gasPrice at 0 margin');
  assert.strictEqual(floorWei({ gasPriceWei: GAS, effects: 2n, marginBps: 1000n }), fw + fw / 10n, '10% margin');
  ok('floorWei = settleGas × gasPrice (+ margin) — flat, not value-proportional');
}

// ── convert to the fee asset's in-system units ──
{
  const floor = floorInFeeUnits({ gasPriceWei: GAS, weiPerFeeUnit: WPU, effects: 2n, marginBps: 0n });
  assert.strictEqual(floor, (360000n * GAS) / WPU, 'floor in in-system cETH units = floorWei / weiPerFeeUnit');
  ok('floorInFeeUnits converts the wei floor into fee-asset units (ceil)');
}

// ── profitability guard (don't settle at a loss; subsidize is opt-in) ──
{
  const floor = (360000n * GAS) / WPU;
  assert.strictEqual(isProfitable({ feeOffered: floor, gasPriceWei: GAS, weiPerFeeUnit: WPU }), true, 'exactly covers gas');
  assert.strictEqual(isProfitable({ feeOffered: floor - 1n, gasPriceWei: GAS, weiPerFeeUnit: WPU }), false, 'just below = loss');
  assert.strictEqual(isProfitable({ feeOffered: 0n, gasPriceWei: GAS, weiPerFeeUnit: WPU }), false, 'fee=0 not profitable');
  assert.strictEqual(isProfitable({ feeOffered: 0n, gasPriceWei: GAS, weiPerFeeUnit: WPU, subsidize: true }), true, 'fee=0 subsidized (loss-leader)');
  ok('isProfitable gates on the gas-priced floor (+ subsidize override)');
}

// ── declared-fee extraction per op type (gate BEFORE proving) ──
{
  assert.deepStrictEqual(feeLegsOf('transfer', { fee: '30' }), [{ value: 30n }], 'transfer single fee');
  assert.deepStrictEqual(feeLegsOf('route', { fee: '30' }), [{ value: 30n }], 'route single fee');
  assert.deepStrictEqual(feeLegsOf('swap', { intents: [{ fee: '5' }, { fee: '0' }] }), [{ value: 5n }], 'swap per-intent');
  assert.deepStrictEqual(feeLegsOf('otc', { feeA: '7', feeB: '11' }), [{ value: 7n }, { value: 11n }], 'otc two fees');
  for (const t of ['wrap', 'bridgemint', 'farmbond', 'adaptorlock', 'adaptorclaim', 'cdptopup'])
    assert.deepStrictEqual(feeLegsOf(t, {}), [], `${t} fee-less by design`);
  ok('feeLegsOf extracts the declared fee legs per op type (incl. fee-less ops → [])');
}

// ── bridgemint carries a fee (v_burn − v_out, paid to the settler); fee 0 is a self-mint ──
{
  assert.deepStrictEqual(feeLegsOf('bridgemint', { asset: '0xaa', fee: 1200 }), [{ value: 1200n }], 'bridgemint single fee leg');
  assert.deepStrictEqual(feeLegsOf('bridgemint', { asset: '0xaa', fee: '1200' }), [{ value: 1200n }], 'bridgemint string fee');
  assert.deepStrictEqual(feeLegsOf('bridgemint', { asset: '0xaa', fee: 0 }), [], 'bridgemint fee 0 has no leg');
  assert.strictEqual(totalFee('bridgemint', { fee: 0 }), 0n, 'a zero-fee bridgemint stays fee-less (free budget)');
  assert.strictEqual(feeAssetOf('bridgemint', { asset: '0xaa' }), '0xaa', 'bridgemint: fee paid in op.asset');
  const floor = (360000n * GAS) / WPU;
  assert.strictEqual(passesFloor({ type: 'bridgemint', op: { fee: '0' }, gasPriceWei: GAS, weiPerFeeUnit: WPU }), true, 'zero-fee bridgemint is still accepted as a subsidy');
  assert.strictEqual(passesFloor({ type: 'bridgemint', op: { fee: String(floor) }, gasPriceWei: GAS, weiPerFeeUnit: WPU }), true, 'fee at the floor clears');
  assert.strictEqual(passesFloor({ type: 'bridgemint', op: { fee: '100' }, gasPriceWei: GAS, weiPerFeeUnit: WPU }), false, 'a fee below the floor is held to it like any fee-paying op');
  ok('bridgemint is a fee-carrying op; a zero fee keeps the subsidised path');
}

// ── fee-leg asset, for the types with one unambiguous answer (pinned against each builder's own field
// names — dapp/confidential-pool-ux.js / confidential-lp.js / confidential-route.js) ──
{
  assert.strictEqual(feeAssetOf('transfer', { asset: '0xaa' }), '0xaa', 'transfer: op.asset');
  assert.strictEqual(feeAssetOf('unwrap', { asset: '0xaa' }), '0xaa', 'unwrap: op.asset');
  assert.strictEqual(feeAssetOf('sendunwrap', { asset: '0xaa' }), '0xaa', 'sendunwrap: op.asset');
  assert.strictEqual(feeAssetOf('bridgeburn', { asset: '0xaa' }), '0xaa', 'bridgeburn: op.asset');
  assert.strictEqual(feeAssetOf('lp', { assetA: '0xaa', assetB: '0xbb' }), '0xaa', 'lp: fee carved from assetA');
  assert.strictEqual(feeAssetOf('lpremove', { assetA: '0xaa', assetB: '0xbb' }), '0xaa', 'lpremove: assetA');
  assert.strictEqual(feeAssetOf('lpbond', { assetA: '0xaa', assetB: '0xbb' }), '0xaa', 'lpbond: assetA');
  assert.strictEqual(feeAssetOf('route', { asset0: '0xaa' }), '0xaa', 'route: op.asset0 (the start asset)');
  // Types with no single answer (per-intent / two distinct legs) or that were never verified against a real
  // op shape: null, not a guess — a caller must treat null as "can't price this, pass it through ungated".
  assert.strictEqual(feeAssetOf('swap', { intents: [{ asset: '0xaa' }] }), null, 'swap: per-intent, no single asset');
  assert.strictEqual(feeAssetOf('otc', { assetA: '0xaa', assetB: '0xbb' }), null, 'otc: two distinct fee legs');
  assert.strictEqual(feeAssetOf('cdpmint', { asset: '0xaa' }), null, 'cdpmint: not verified — null, not a guess');
  ok('feeAssetOf resolves the fee-leg asset only where a single verified answer exists');
}

// ── the submit-time gate ──
{
  const floor = (360000n * GAS) / WPU;
  assert.strictEqual(passesFloor({ type: 'transfer', op: { fee: String(floor) }, gasPriceWei: GAS, weiPerFeeUnit: WPU }), true, 'transfer clears');
  assert.strictEqual(passesFloor({ type: 'transfer', op: { fee: '100' }, gasPriceWei: GAS, weiPerFeeUnit: WPU }), false, 'transfer below floor rejected');
  assert.strictEqual(passesFloor({ type: 'wrap', op: {}, gasPriceWei: GAS, weiPerFeeUnit: WPU }), true, 'wrap (fee-less) always passes');
  assert.strictEqual(passesFloor({ type: 'transfer', op: { fee: '0' }, gasPriceWei: GAS, weiPerFeeUnit: WPU, subsidize: true }), true, 'fee=0 + subsidize passes');
  assert.strictEqual(passesFloor({ type: 'transfer', op: { fee: '0' }, gasPriceWei: GAS, weiPerFeeUnit: WPU }), false, 'fee=0 without subsidy rejected');
  ok('passesFloor gates relayed submits by the gas-priced floor');
}

// ── AMM fallback pricing (public pool reserves against a directly valued asset) ──
{
  const FEE = '0x' + '11'.repeat(32), REF = '0x' + '22'.repeat(32), OTHER = '0x' + '33'.repeat(32);
  const w = (v) => BigInt(v).toString(16).padStart(64, '0');
  const enc = ({ init = 1, a, b, ra, rb, fee = 30, shares = 1000 }) => '0x' + w(init) + w(a) + w(b) + w(ra) + w(rb) + w(fee) + w(shares);
  const st = decodePoolState(enc({ a: FEE, b: REF, ra: 4_000_000n, rb: 1_000_000n }));
  assert.deepStrictEqual(st, { assetA: FEE, assetB: REF, reserveA: 4_000_000n, reserveB: 1_000_000n, feeBps: 30, totalShares: 1000n }, 'decodes pools(bytes32)');
  assert.strictEqual(decodePoolState(enc({ init: 0, a: FEE, b: REF, ra: 1, rb: 1 })), null, 'uninitialized pool is null');
  assert.strictEqual(decodePoolState('0x' + '00'.repeat(64)), null, 'short answer is null');
  assert.strictEqual(decodePoolState(null), null, 'missing answer is null');

  // 4 fee units per ref unit, ref worth $0.01/unit: spot $0.0025/unit, 20% haircut → $0.002. Depth: 1e6 × $0.01 = $10k.
  const px = ammUsdPerUnit({ state: st, feeAsset: FEE, refAsset: REF, refUsdPerUnit: 0.01 });
  assert.ok(Math.abs(px - 0.002) < 1e-12, `haircut spot price, got ${px}`);
  assert.strictEqual(AMM_PRICE_DEFAULTS.haircutBps, 2000, 'default haircut is 20%');
  // orientation does not matter
  const flipped = decodePoolState(enc({ a: REF, b: FEE, ra: 1_000_000n, rb: 4_000_000n }));
  assert.ok(Math.abs(ammUsdPerUnit({ state: flipped, feeAsset: FEE, refAsset: REF, refUsdPerUnit: 0.01 }) - 0.002) < 1e-12, 'either orientation');
  assert.ok(Math.abs(ammUsdPerUnit({ state: st, feeAsset: FEE.toUpperCase().replace('0X', '0x'), refAsset: REF, refUsdPerUnit: 0.01, haircutBps: 0 }) - 0.0025) < 1e-12, 'case-insensitive ids, zero haircut = spot');
  ok('AMM price: decodes pool state and values the fee asset at a haircut below spot');

  // fail closed
  const nul = (args, why) => assert.strictEqual(ammUsdPerUnit({ state: st, feeAsset: FEE, refAsset: REF, refUsdPerUnit: 0.01, ...args }), null, why);
  nul({ minDepthUsd: 10_001 }, 'reference side shallower than the minimum depth');
  nul({ refAsset: OTHER }, 'pool is not the requested pair');
  nul({ feeAsset: REF }, 'fee asset equal to reference asset');
  nul({ refUsdPerUnit: 0 }, 'no reference price');
  nul({ refUsdPerUnit: NaN }, 'non-finite reference price');
  nul({ haircutBps: 10000 }, 'haircut of 100% is rejected');
  nul({ haircutBps: 1.5 }, 'non-integer haircut is rejected');
  nul({ minDepthUsd: 0 }, 'a zero depth requirement is not accepted');
  nul({ state: null }, 'no pool');
  nul({ state: decodePoolState(enc({ a: FEE, b: REF, ra: 0n, rb: 1_000_000n })) }, 'empty fee-side reserve');
  nul({ state: decodePoolState(enc({ a: FEE, b: REF, ra: 1n << 64n, rb: 1_000_000n })) }, 'reserve beyond u64');
  nul({ state: decodePoolState(enc({ a: FEE, b: REF, ra: 4_000_000n, rb: 1_000_000n, shares: 0 })) }, 'pool with no outstanding shares');
  nul({ state: { ...st, reserveA: 4_000_000 } }, 'non-bigint reserve');
  ok('AMM price fails closed on shallow, mismatched, empty or malformed pools');

  // across candidates: the lowest qualifying reading wins; unqualified ones are ignored
  const deep = { state: st, refAsset: REF, refUsdPerUnit: 0.01 };                                                  // $0.002
  const deeper = { state: decodePoolState(enc({ a: FEE, b: OTHER, ra: 1_000_000n, rb: 1_000_000n })), refAsset: OTHER, refUsdPerUnit: 0.01 }; // $0.008
  const shallow = { state: decodePoolState(enc({ a: FEE, b: OTHER, ra: 1n, rb: 1_000n })), refAsset: OTHER, refUsdPerUnit: 0.01 }; // $10 spot, $10 deep
  assert.ok(Math.abs(ammUsdPerUnitBest({ feeAsset: FEE, candidates: [deeper, deep] }) - 0.002) < 1e-12, 'lowest of the qualifying readings');
  assert.ok(Math.abs(ammUsdPerUnitBest({ feeAsset: FEE, candidates: [shallow, deeper] }) - 0.008) < 1e-12, 'a shallow pool cannot inflate or set the price');
  assert.strictEqual(ammUsdPerUnitBest({ feeAsset: FEE, candidates: [shallow, null, { state: null }] }), null, 'no qualifying pool → unpriced');
  assert.strictEqual(ammUsdPerUnitBest({ feeAsset: FEE }), null, 'no candidates → unpriced');
  ok('AMM price across pools: the lowest deep-enough reading, else unpriced');
}

console.log(`\n${n}/${n} relay-quote checks passed`);
