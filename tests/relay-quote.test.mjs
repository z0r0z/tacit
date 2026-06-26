#!/usr/bin/env node
// Gas-priced relay quote + profitability guard (worker/src/relay-quote.js).
// Run: node tests/relay-quote.test.mjs
import assert from 'node:assert';
import { floorWei, floorInFeeUnits, isProfitable, feeLegsOf, passesFloor } from '../worker/src/relay-quote.js';

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

console.log(`\n${n}/${n} relay-quote checks passed`);
