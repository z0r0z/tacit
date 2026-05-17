// Unit test for computeSatsFragmentation() — the pure threshold logic
// behind the consolidation banner + sweep builder.
//
// Contract:
//   - Returns { fragmented: bool, dustCount, dustTotal, dustUtxos }
//   - dust = UTXOs with value <= SATS_DUST_SHAPE_THRESHOLD (10000 sats)
//   - fragmented = dustCount >= SATS_CONSOLIDATE_MIN_INPUTS (6)
//   - Robust to null / undefined / missing-value inputs

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

const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

const u = (value, txid = 'aa', vout = 0) => ({ txid, vout, value });

group('Threshold + count gates');
{
  // No UTXOs: not fragmented
  const r0 = dapp.computeSatsFragmentation([]);
  ok('empty list → not fragmented',
    r0.fragmented === false && r0.dustCount === 0 && r0.dustTotal === 0);

  // 5 dust UTXOs: below the 6-input minimum → not fragmented
  const r5 = dapp.computeSatsFragmentation([u(500), u(800), u(1200), u(2500), u(7500)]);
  ok('5 dust UTXOs → not fragmented (below MIN_INPUTS)',
    r5.fragmented === false && r5.dustCount === 5 && r5.dustTotal === 500 + 800 + 1200 + 2500 + 7500);

  // 6 dust UTXOs: at threshold → fragmented
  const r6 = dapp.computeSatsFragmentation([u(500), u(800), u(1200), u(2500), u(7500), u(3000)]);
  ok('6 dust UTXOs → fragmented (at MIN_INPUTS)',
    r6.fragmented === true && r6.dustCount === 6);

  // 6 above-threshold UTXOs: NOT dust → not fragmented
  const big = dapp.computeSatsFragmentation([u(20_000), u(30_000), u(40_000), u(50_000), u(60_000), u(100_000)]);
  ok('6 above-threshold UTXOs → not fragmented',
    big.fragmented === false && big.dustCount === 0);

  // Mixed: 4 dust + 3 big → 4 dust but not 6, so not fragmented
  const mix = dapp.computeSatsFragmentation([u(500), u(800), u(1200), u(2500), u(50_000), u(60_000), u(100_000)]);
  ok('4 dust + 3 big → not fragmented (only 4 dust)',
    mix.fragmented === false && mix.dustCount === 4);
}

group('Exact threshold boundary');
{
  // Value exactly at threshold (10000) counts as dust
  const r = dapp.computeSatsFragmentation([u(10_000), u(10_000), u(10_000), u(10_000), u(10_000), u(10_000)]);
  ok('value === SATS_DUST_SHAPE_THRESHOLD counts as dust',
    r.fragmented === true && r.dustCount === 6 && r.dustTotal === 60_000);

  // Value just over threshold doesn't count
  const r2 = dapp.computeSatsFragmentation([u(10_001), u(10_001), u(10_001), u(10_001), u(10_001), u(10_001)]);
  ok('value === SATS_DUST_SHAPE_THRESHOLD + 1 is NOT dust',
    r2.fragmented === false && r2.dustCount === 0);
}

group('Robustness to malformed inputs');
{
  ok('null input → empty result',
    dapp.computeSatsFragmentation(null).dustCount === 0);
  ok('undefined input → empty result',
    dapp.computeSatsFragmentation(undefined).dustCount === 0);
  // Missing value field treated as 0 (which is ≤ threshold, so counts as dust)
  const malformed = dapp.computeSatsFragmentation([{ txid: 'aa', vout: 0 }, u(500), u(500), u(500), u(500), u(500)]);
  ok('UTXO with missing value field counts as dust (≤ threshold)',
    malformed.fragmented === true && malformed.dustCount === 6);
}

group('dustUtxos contents preserved');
{
  const inputs = [u(500, 'aa', 0), u(800, 'bb', 1), u(1200, 'cc', 2), u(2500, 'dd', 3), u(7500, 'ee', 4), u(3000, 'ff', 5)];
  const r = dapp.computeSatsFragmentation(inputs);
  ok('all 6 dust UTXOs returned in dustUtxos',
    r.dustUtxos.length === 6);
  const txids = r.dustUtxos.map(u => u.txid).sort().join(',');
  ok('dustUtxos preserves txid identity',
    txids === 'aa,bb,cc,dd,ee,ff');
}

group('Constants exported');
{
  ok('SATS_DUST_SHAPE_THRESHOLD = 10000', dapp.SATS_DUST_SHAPE_THRESHOLD === 10_000);
  ok('SATS_CONSOLIDATE_MIN_INPUTS = 6', dapp.SATS_CONSOLIDATE_MIN_INPUTS === 6);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
