// What a farm position row says it holds (dapp/farm/holdings.js, drawn by dapp/rewards/farms.js): a person who zapped in sees their share of the pool and the two coins it is worth,
// not only a pair name and the TAC earned. The figures below are a real position's: a 1 ETH zap into the tETH / cUSD farm bonded 1,493,460,173 shares of a pool that held
// 8,667,505,254 shares, 292,396,557 units of tETH and 260,203,937,871 units of cUSD (a unit is a hundred-millionth of the coin).
//   node --test tests/farm-position-holds.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { holdingOf, pctText, unitsText } from '../dapp/farm/holdings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const POOL = { totalShares: 8667505254n, reserveA: 292396557n, reserveB: 260203937871n };

test('a real position: its share of the pool and the two coins that share is worth', () => {
  const h = holdingOf({ shares: 1493460173n, reserves: POOL });
  assert.equal(h.a, 50381580n);                 // 0.5038 tETH
  assert.equal(h.b, 44834610038n);              // 448.3 cUSD
  assert.ok(Math.abs(h.pct - 17.2305) < 0.0001, String(h.pct));
  assert.equal(pctText(h.pct), '17.2%');
  assert.equal(unitsText(h.a), '0.5038');
  assert.equal(unitsText(h.b), '448.346');
});

test('shares and reserves as strings, numbers or bigints give the same answer', () => {
  const want = holdingOf({ shares: 1493460173n, reserves: POOL });
  const s = holdingOf({ shares: '1493460173', reserves: { totalShares: '8667505254', reserveA: '292396557', reserveB: '260203937871' } });
  assert.deepEqual(s, want);
  assert.deepEqual(holdingOf({ shares: 5917666, reserves: { totalShares: 8667505254, reserveA: 292396557, reserveB: 260203937871 } }), holdingOf({ shares: 5917666n, reserves: POOL }));
});

test('a small position reads as small, not as nothing', () => {
  const h = holdingOf({ shares: 5917666n, reserves: POOL });   // the canary's 0.004 ETH zap
  assert.equal(pctText(h.pct), '0.07%');
  assert.equal(unitsText(h.a), '0.002');           // 199,631 units: 0.002 tETH
  assert.equal(pctText(0.004), 'under 0.01%');
  assert.equal(unitsText(1n), 'under 0.0001');
  assert.equal(pctText(100), '100%');
});

test('what cannot be read as numbers gives nothing, never a wrong figure', () => {
  assert.equal(holdingOf({ shares: 0n, reserves: POOL }), null);
  assert.equal(holdingOf({ shares: 10n, reserves: { ...POOL, totalShares: 0n } }), null);
  assert.equal(holdingOf({ shares: 'x', reserves: POOL }), null);
  assert.equal(holdingOf({ shares: 10n, reserves: null }), null);
  assert.equal(holdingOf({}), null);
  assert.equal(holdingOf(), null);
});

test('a pool read from before the position counted never says it holds more than the whole pool', () => {
  const h = holdingOf({ shares: 9000000000n, reserves: POOL });
  assert.equal(h.pct, 100);
  assert.equal(h.a, POOL.reserveA);
  assert.equal(h.b, POOL.reserveB);
});

test('the positions panel draws it: a share line and a holds line under the earned line, from the pool it already read', () => {
  const src = readFileSync(path.join(here, '..', 'dapp', 'rewards', 'farms.js'), 'utf8');
  assert.match(src, /from '\/farm\/holdings\.js/, 'the panel imports the helper');
  assert.match(src, /holdingOf\(\{ shares: pos\.shares/, 'a row asks for its own position\'s holding');
  assert.match(src, /Your share<\/dt>/);
  assert.match(src, /Holds about<\/dt>/);
  assert.match(src, /of the pool/);
});
