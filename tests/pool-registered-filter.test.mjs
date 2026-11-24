import { test } from 'node:test';
import assert from 'node:assert';
import { withoutShadowRegistrations } from '../dapp/confidential-pool-ux.js';
import { _internal, POOL_ID, TAC, CUSD, CBTC, ZERO } from '../dapp/swap/route.js';

const TAC_ID = POOL_ID[TAC];
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SHADOW = '0x5e3e1bd6fb29a21d0bb0a3a5e6095493ed0ff5f7f5405ae1c5261f191b4ea04b';
const USDC_ID = '0xc05bfed4c4eb61d2b39b643f841b78964ec96715a5795853b94be0dbc569c1d6';

test('a pool-minted token is listed under its shared id only', () => {
  const list = [
    { assetId: TAC_ID, underlying: TAC.toLowerCase() },
    { assetId: SHADOW, underlying: TAC.toLowerCase() },
    { assetId: USDC_ID, underlying: USDC },
  ];
  const out = withoutShadowRegistrations(1, list);
  assert.deepStrictEqual(out.map((x) => x.assetId), [TAC_ID, USDC_ID]);
});

test('every pool-minted token keeps its shared id and loses any other', () => {
  for (const t of [TAC, CUSD, CBTC]) {
    const out = withoutShadowRegistrations(1, [{ assetId: POOL_ID[t], underlying: t }, { assetId: SHADOW, underlying: t.toUpperCase().replace('0X', '0x') }]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].assetId, POOL_ID[t]);
  }
});

test('other chains and empty lists pass through', () => {
  const row = { assetId: SHADOW, underlying: TAC.toLowerCase() };
  assert.deepStrictEqual(withoutShadowRegistrations(8453, [row]), [row]);
  assert.deepStrictEqual(withoutShadowRegistrations(1, []), []);
  assert.deepStrictEqual(withoutShadowRegistrations(1, null), []);
});

test('a public swap is built only between the pool assets the page offers', () => {
  const args = { amountIn: 10n ** 10n, minOut: 1n, deadline: 2n ** 40n, to: '0x000000000000000000000000000000000000dEaD' };
  assert.match(_internal.encSwapPublic({ assetIn: POOL_ID[ZERO], assetOut: TAC_ID, ...args }), /^0xcfdf9dcc/);
  assert.throws(() => _internal.encSwapPublic({ assetIn: POOL_ID[ZERO], assetOut: SHADOW, ...args }), /not offered/);
  assert.throws(() => _internal.encSwapPublic({ assetIn: SHADOW, assetOut: TAC_ID, ...args }), /not offered/);
});
