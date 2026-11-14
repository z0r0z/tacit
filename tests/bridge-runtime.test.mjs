// A token the pool escrows, bridged to Bitcoin like cUSDT (dapp/bridge/runtime.js, the tracker's registry in dapp/bridge/track.js): the limits a price gives,
// the route a row shows, and that a record of such a token is never read as TAC or as a built-in whose name it borrows.
import { bridgeLimits, bridgeDp, bridgeRoute, bridgeLimitEntry, BRIDGE_MIN_USD, BRIDGE_CAP_USD } from '../dapp/bridge/runtime.js';
import { ROUTES, LIMITS, addBridgeAsset, limitLine, outRow, inRow, CUSDT_ID } from '../dapp/bridge/track.js';

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };

// ---- limits from a price ----
{
  const spx = bridgeLimits({ usdPerToken: 0.5, tdec: 8 });
  ok(spx && spx.capRaw === 200_000_000_000n && spx.minRaw === 400_000_000n, `a 50-cent 8-decimal token: $1,000 is 2,000 tokens, $2 is 4 (${spx?.minRaw}..${spx?.capRaw})`);
  const wbtc = bridgeLimits({ usdPerToken: 100_000, tdec: 8 });
  ok(wbtc && wbtc.capRaw === 1_000_000n && wbtc.minRaw === 2_000n, 'a $100,000 token: 0.01 of it is the cap, 0.00002 the minimum');
  const usdt = bridgeLimits({ usdPerToken: 1, tdec: 6 });
  ok(usdt && usdt.capRaw === 1_000_000_000n && usdt.minRaw === 2_000_000n, 'a dollar token at six decimals: 1,000 and 2');
  const odd = bridgeLimits({ usdPerToken: 0.0000123, tdec: 8 });
  ok(odd && odd.capRaw.toString().replace(/0+$/, '').length <= 2 && odd.minRaw.toString().replace(/0+$/, '').length <= 2, 'limits are rounded to two significant digits');
  ok(odd && odd.capRaw >= odd.minRaw * 10n, 'and the cap stays far above the minimum');
  const down = bridgeLimits({ usdPerToken: 3, tdec: 8 }), cap = 1000 / 3 * 1e8;
  ok(down && Number(down.capRaw) <= cap, 'the cap is rounded down, never above $1,000');
  ok(down && Number(down.minRaw) >= 2 / 3 * 1e8, 'the minimum is rounded up, never below $2');
  ok(bridgeLimits({ usdPerToken: 3000, tdec: 0 }) === null, 'a token whose smallest unit is worth more than the whole range has no limit');
  ok(bridgeLimits({ usdPerToken: 0, tdec: 8 }) === null && bridgeLimits({ usdPerToken: NaN, tdec: 8 }) === null && bridgeLimits({ usdPerToken: -1, tdec: 8 }) === null && bridgeLimits({ usdPerToken: Infinity, tdec: 8 }) === null, 'no price, a bad price: no limit');
  ok(bridgeLimits({ usdPerToken: 1, tdec: 9 }) === null && bridgeLimits({ usdPerToken: 1, tdec: 1.5 }) === null, 'a precision Tacit does not use: no limit');
  const cheap = bridgeLimits({ usdPerToken: 1e-7, tdec: 8 });
  ok(cheap && cheap.capRaw === 10n ** 18n && cheap.minRaw === 2_000_000_000_000_000n, 'a very cheap token has its cap held to a u64 of units');
  ok(bridgeLimits({ usdPerToken: 1e-15, tdec: 8 }) === null, 'one so cheap that $2 of it overflows a note has no limit');
  ok(bridgeLimits({ usdPerToken: 1e-13, tdec: 8 }) === null, 'a price below a millionth of a millionth of a dollar is not priced');
  ok(BRIDGE_MIN_USD === 2 && BRIDGE_CAP_USD === 1000, 'the range is $2 to $1,000, a start like the others');
  ok(bridgeDp(0.5, 8) === 2 && bridgeDp(5, 8) === 4 && bridgeDp(100_000, 8) === 6 && bridgeDp(5000, 3) === 3, 'a cheap token shows fewer decimals, a dear one more, never more than it has');
}

// ---- the tracker's registry ----
{
  const id = '45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48', other = '9'.repeat(64);
  const lim = bridgeLimits({ usdPerToken: 0.5, tdec: 8 });
  const route = bridgeRoute({ ticker: 'SPX', icon: 'tk-x0xe0f6', dp: 2, dec: 8 });
  ok(route.out.start === '/#bridge' && route.in.href === '/#bridge' && route.out.go === 'Bridge SPX' && route.in.go === 'Bring SPX back', 'its rows link to the bridge tab, named for the token');
  ok(route.out.steps.length === 4 && route.in.steps.length === 4 && route.dec === undefined, 'the same four steps each way; eight decimals is the default and not repeated');
  ok(bridgeRoute({ ticker: 'XYZ', icon: 'i', dp: 2, dec: 6 }).dec === 6, 'a six-decimal token says so');
  ok(addBridgeAsset({ key: 'x0xe0f6', id, route, limits: bridgeLimitEntry(lim) }) === true, 'a token is added with its route and limits');
  ok(ROUTES.x0xe0f6 === route && LIMITS.x0xe0f6.out.max === lim.capRaw && LIMITS.x0xe0f6.in.max === lim.capRaw && LIMITS.x0xe0f6.out.min === lim.minRaw, 'both tables carry it');
  ok(limitLine('x0xe0f6', 'out') === '4 to 2,000 SPX a bridge while it is new', `its limit line reads ${limitLine('x0xe0f6', 'out')}`);
  // a record of it is its own: the row names its key, its steps and its link, not TAC's (the tracker's fallback)
  const out = outRow({ id: 'o1', stage: 'settled', path: 'reflected', source: { assetId: '0x' + id, ticker: 'SPX', amount: '100000000' } });
  ok(out.asset === 'x0xe0f6' && out.href === route.out.href && out.steps === route.out.steps && out.amount === 100_000_000n, 'a crossing out of it is its own row: key, link and steps');
  const back = inRow({ id: 'i1', stage: 'rfolded', source: { assetId: '0x' + id, ticker: 'SPX', amount: '100000000' } });
  ok(back.asset === 'x0xe0f6' && back.href === route.in.href && back.steps === route.in.steps, 'and so is a crossing back');
  // an id nothing named still reads as TAC; a built-in id still reads as itself
  ok(outRow({ id: 'o2', stage: 'settled', source: { assetId: '0x' + other, ticker: '???', amount: '1' } }).asset === 'tac', 'an id nothing named still reads as TAC');
  ok(outRow({ id: 'o3', stage: 'settled', source: { assetId: '0x' + CUSDT_ID, ticker: 'cUSDT', amount: '1' } }).asset === 'cusdt', 'cUSDT still reads as cUSDT');
  // an id nothing named is still TAC, and a built-in is never overwritten
  ok(addBridgeAsset({ key: 'tac', id: other, route, limits: bridgeLimitEntry(lim) }) === false && ROUTES.tac.ticker === 'TAC', 'a built-in key is never taken over');
  ok(addBridgeAsset({ key: 'bad', id: 'nothex', route, limits: bridgeLimitEntry(lim) }) === false && addBridgeAsset({ key: 'bad', id: other, route: null, limits: bridgeLimitEntry(lim) }) === false, 'a bad id or an empty route is refused');
  // updating the same token (its price arrived) replaces its limits
  const lim2 = bridgeLimits({ usdPerToken: 1, tdec: 8 });
  ok(addBridgeAsset({ key: 'x0xe0f6', id, route, limits: bridgeLimitEntry(lim2) }) === true && LIMITS.x0xe0f6.out.max === lim2.capRaw, 'the same token can be updated in place');
}

// ---- a token that borrows a built-in's name is not that built-in ----
{
  // the tracker reads a record's asset by id before its ticker: a token calling itself cBTC, tETH, cUSD, cUSDT or TAC is routed by its own key
  const id = '77'.repeat(32), mine = bridgeRoute({ ticker: 'cBTC (7777…)', icon: 'tk-x', dp: 2, dec: 8 });
  addBridgeAsset({ key: 'x0x7777', id, route: mine, limits: bridgeLimitEntry(bridgeLimits({ usdPerToken: 2, tdec: 8 })) });
  for (const ticker of ['cBTC', 'tETH', 'cUSD', 'cUSDT', 'TAC']) {
    const o = outRow({ id: 'o', stage: 'settled', source: { assetId: '0x' + id, ticker, amount: '1' } }), i = inRow({ id: 'i', stage: 'rfolded', source: { assetId: '0x' + id, ticker, amount: '1' } });
    ok(o.asset === 'x0x7777' && i.asset === 'x0x7777' && o.href === mine.out.href, `a token that calls itself "${ticker}" is still routed as its own`);
  }
  ok(ROUTES.cbtc.ticker === 'cBTC' && ROUTES.teth.ticker === 'tETH' && ROUTES.cusd.ticker === 'cUSD' && ROUTES.cusdt.ticker === 'cUSDT' && ROUTES.tac.ticker === 'TAC', 'the built-ins are untouched');
}

console.log(`\n${n} bridge-runtime checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
