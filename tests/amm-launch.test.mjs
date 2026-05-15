// Tests for the launch-bundle reference module (amm-launch.mjs).

import { sha256 } from '@noble/hashes/sha256';
import { MINIMUM_LIQUIDITY } from './amm-min-liq.mjs';
import { previewLaunch, buildLaunchBundle } from './amm-launch.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

const cBTC = sha256(new TextEncoder().encode('tacit-launch-test-cbtc'));
const PREDICTED_NEW = sha256(new TextEncoder().encode('tacit-launch-test-T1'));

console.log('previewLaunch — happy path (well-sized pool)');
{
  const p = previewLaunch({
    tokenType: 'T_PETCH',
    cbtcSeedAmount: 1_000_000n,    // 0.01 BTC seed
    tokenSeedAmount: 100_000n,     // 100K tokens
    feeBps: 30,
    cbtcAssetId: cBTC,
    newAssetIdPredicted: PREDICTED_NEW,
  });
  test('valid preview', () => p.valid === true);
  test('initial price = cBTC / token = 10', () => p.initialPriceCBTCPerToken === 10);
  test('lpInitShares returns isqrt(1M · 100K) = 316,227',
       () => p.initialShares.total_shares === 316_227n);
  test('founder gets total − MIN_LIQ',
       () => p.initialShares.founder_shares === 316_227n - MINIMUM_LIQUIDITY);
  test('locked = MIN_LIQ',
       () => p.initialShares.locked_shares === MINIMUM_LIQUIDITY);
  test('MIN_LIQ assessment severity = ok for this size',
       () => p.minLiqLockAssessment.severity === 'ok');
  test('poolId computed (both asset_ids known)',
       () => p.poolId instanceof Uint8Array && p.poolId.length === 32);
  test('lpAssetId computed',
       () => p.lpAssetId instanceof Uint8Array && p.lpAssetId.length === 32);
  test('estimatedFees populated',
       () => p.estimatedFees.total_vbytes > 0
          && p.estimatedFees.sats_at_10sv > 0
          && p.estimatedFees.sats_at_50sv > p.estimatedFees.sats_at_10sv);
  test('no pool-size warnings (busy-mempool fee notice is acceptable info)',
       () => !p.warnings.some(w => /Thin pool|Small pool|MIN_LIQ/.test(w)));
  test('no blocking errors', () => p.blockingErrors.length === 0);
}

console.log('\npreviewLaunch — thin pool warns');
{
  const p = previewLaunch({
    tokenType: 'T_PETCH',
    cbtcSeedAmount: 5_000n,
    tokenSeedAmount: 5_000n,       // isqrt(25M) = 5000 → locked_bps ≈ 2000 (20%)
    feeBps: 30,
    cbtcAssetId: cBTC,
    newAssetIdPredicted: PREDICTED_NEW,
  });
  test('thin pool flagged as severity=high',
       () => p.minLiqLockAssessment.severity === 'high');
  test('thin pool surfaces a warning',
       () => p.warnings.some(w => /Thin pool|MIN_LIQ/.test(w)));
  test('thin pool still valid (founder accepts trade-off)',
       () => p.valid === true);
}

console.log('\npreviewLaunch — pool too small rejects');
{
  const p = previewLaunch({
    tokenType: 'T_PETCH',
    cbtcSeedAmount: 1_000n,
    tokenSeedAmount: 1_000n,       // isqrt(1M) = 1000 = MIN_LIQ → reject (zero founder shares)
    feeBps: 30,
    cbtcAssetId: cBTC,
    newAssetIdPredicted: PREDICTED_NEW,
  });
  test('pool ≤ MIN_LIQ rejected', () => p.valid === false);
  test('blockingError mentions Pool too small',
       () => p.blockingErrors.some(e => /Pool too small/.test(e)));
}

console.log('\npreviewLaunch — input validation');
{
  test('rejects fee_bps > 1000', () => {
    const p = previewLaunch({
      cbtcSeedAmount: 1_000_000n, tokenSeedAmount: 100_000n,
      feeBps: 1001, cbtcAssetId: cBTC,
    });
    return !p.valid && p.blockingErrors.some(e => /feeBps must be/.test(e));
  });
  test('rejects non-bigint seed amount', () => {
    const p = previewLaunch({
      cbtcSeedAmount: 1_000_000, // number, not bigint
      tokenSeedAmount: 100_000n,
      cbtcAssetId: cBTC,
    });
    return !p.valid && p.blockingErrors.some(e => /cbtcSeedAmount/.test(e));
  });
  test('rejects bad cbtcAssetId length', () => {
    const p = previewLaunch({
      cbtcSeedAmount: 1_000_000n, tokenSeedAmount: 100_000n,
      cbtcAssetId: new Uint8Array(16),
    });
    return !p.valid && p.blockingErrors.some(e => /cbtcAssetId/.test(e));
  });
  test('rejects unknown tokenType', () => {
    const p = previewLaunch({
      cbtcSeedAmount: 1_000_000n, tokenSeedAmount: 100_000n,
      tokenType: 'WHATEVER',
      cbtcAssetId: cBTC,
    });
    return !p.valid && p.blockingErrors.some(e => /tokenType/.test(e));
  });
}

console.log('\npreviewLaunch — protocol fee surfacing');
{
  const p = previewLaunch({
    cbtcSeedAmount: 1_000_000n, tokenSeedAmount: 100_000n,
    feeBps: 30, protocolFeeBps: 200,
    cbtcAssetId: cBTC, newAssetIdPredicted: PREDICTED_NEW,
  });
  test('protocol_fee_bps > 0 surfaces a warning',
       () => p.warnings.some(w => /Protocol fee/.test(w)));
  test('protocol_fee_bps > 0 still valid', () => p.valid === true);
}

console.log('\npreviewLaunch — missing newAssetIdPredicted');
{
  const p = previewLaunch({
    cbtcSeedAmount: 1_000_000n, tokenSeedAmount: 100_000n,
    cbtcAssetId: cBTC,
    // newAssetIdPredicted intentionally omitted
  });
  test('still valid (warns that poolId / lpAssetId pending)',
       () => p.valid === true);
  test('poolId is null until newAssetId known',
       () => p.poolId === null);
  test('lpAssetId is null until poolId known',
       () => p.lpAssetId === null);
  test('warning surfaces the predict-asset-id dependency',
       () => p.warnings.some(w => /newAssetIdPredicted/.test(w)));
}

console.log('\nbuildLaunchBundle — happy path');
{
  const b = buildLaunchBundle({
    tokenType: 'T_PETCH',
    cbtcSeedAmount: 1_000_000n,
    tokenSeedAmount: 100_000n,
    feeBps: 30,
    cbtcAssetId: cBTC,
    newAssetIdPredicted: PREDICTED_NEW,
  });
  test('plan = launch-bundle-v1', () => b.plan === 'launch-bundle-v1');
  test('bundle valid', () => b.valid === true);
  test('tx1 = T_PETCH', () => b.tx1.envelope === 'T_PETCH');
  test('tx2 = POOL_INIT', () => b.tx2.envelope === 'POOL_INIT');
  test('tx2 depends on tx1', () => b.tx2.dependsOnTx1 === true);
  test('broadcastStrategy = mempool-package',
       () => b.broadcastStrategy.method === 'mempool-package');
  test('tx2.poolParams.deltaA = cbtcSeedAmount',
       () => b.tx2.poolParams.deltaA === 1_000_000n);
  test('tx2.poolParams.deltaB = tokenSeedAmount',
       () => b.tx2.poolParams.deltaB === 100_000n);
}

console.log('\nbuildLaunchBundle — rejection on bad input');
{
  const b = buildLaunchBundle({
    cbtcSeedAmount: 1_000n,    // too small
    tokenSeedAmount: 1_000n,
    cbtcAssetId: cBTC,
  });
  test('rejects when preview is invalid', () => b.valid === false);
  test('still returns preview with blockingErrors',
       () => b.preview.blockingErrors.length > 0);
}

console.log('\nbuildLaunchBundle — CETCH variant');
{
  const b = buildLaunchBundle({
    tokenType: 'CETCH',
    cbtcSeedAmount: 1_000_000n,
    tokenSeedAmount: 100_000n,
    feeBps: 30,
    cbtcAssetId: cBTC,
    newAssetIdPredicted: PREDICTED_NEW,
  });
  test('CETCH variant: tx1 = CETCH', () => b.tx1.envelope === 'CETCH');
  test('CETCH variant: same bundle plan + valid', () => b.valid === true);
}

console.log(`\n${pass}/${pass + fail} launch-bundle tests passed`);
if (fail > 0) process.exit(1);
