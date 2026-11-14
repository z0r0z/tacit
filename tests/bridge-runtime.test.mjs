// A token the pool escrows, bridged to Bitcoin like cUSDT (dapp/bridge/runtime.js, the tracker's registry in dapp/bridge/track.js): the limits a price gives,
// the route a row shows, and that a record of such a token is never read as TAC or as a built-in whose name it borrows.
import { bridgeLimits, bridgeDp, bridgeRoute, bridgeLimitEntry, BRIDGE_MIN_USD, BRIDGE_CAP_USD, RUNTIME_STORE, saveRuntime, readRuntime, runtimeSymbol, runtimeIcon, markColor } from '../dapp/bridge/runtime.js';
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

// ---- what is kept for a page that has not met the token ----
{
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, raw: m }; };
  const addr = '0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c', id = '45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48';
  const e = { addr, id, ticker: 'SPX', sym: 'SPX', logo: '/assets/tokens/spx.png', dp: 2, dec: 8, minRaw: 400_000_000n, capRaw: 200_000_000_000n };
  const st = mem();
  ok(readRuntime(st).length === 0, 'nothing kept reads as nothing');
  ok(saveRuntime(st, e) === true, 'a token is kept');
  const [back] = readRuntime(st);
  ok(back && back.key === `x${addr}` && back.id === id && back.ticker === 'SPX' && back.logo === '/assets/tokens/spx.png' && back.minRaw === 400_000_000n && back.capRaw === 200_000_000_000n, 'it reads back whole, its limits as BigInts');
  ok(typeof JSON.parse(st.raw.get(RUNTIME_STORE))[0].capRaw === 'string', 'its limits are kept as strings');
  saveRuntime(st, { ...e, capRaw: 100_000_000_000n });
  ok(readRuntime(st).length === 1 && readRuntime(st)[0].capRaw === 100_000_000_000n, 'the same token again replaces its record');
  saveRuntime(st, { ...e, addr: '0x' + 'ab'.repeat(20), ticker: 'XYZ' });
  ok(readRuntime(st).length === 2, 'another token is another record');
  // a record kept for the bridge tab's dark token: no limits, still read
  saveRuntime(st, { ...e, addr: '0x' + 'cd'.repeat(20), ticker: 'NOPRICE', minRaw: 0n, capRaw: 0n });
  ok(readRuntime(st).some((x) => x.ticker === 'NOPRICE' && x.capRaw === 0n), 'a token with no limit is kept as well');
  // what is not a token is not kept: a bad address, id, name, precision or limits
  const bad = mem();
  for (const [what, x] of [['an address that is not one', { ...e, addr: '0x12' }], ['an id that is not 64 hex', { ...e, id: 'nothex' }], ['no name', { ...e, ticker: '' }], ['nine decimals', { ...e, dec: 9 }],
    ['a negative display precision', { ...e, dp: -1 }], ['a minimum above the cap', { ...e, minRaw: 5n, capRaw: 4n }], ['a limit past a note', { ...e, capRaw: 10n ** 19n }], ['a limit that is not a number', { ...e, capRaw: 'abc' }]]) {
    ok(saveRuntime(bad, x) === false && readRuntime(bad).length === 0, `${what} is not kept`);
  }
  // a logo is a path on this site, never another one
  saveRuntime(bad, { ...e, logo: 'https://evil.example/x.png' });
  saveRuntime(bad, { ...e, addr: '0x' + 'ef'.repeat(20), logo: '//evil.example/x.png' });
  ok(readRuntime(bad).every((x) => x.logo === ''), 'a logo off this site is dropped, and the token still kept');
  // damaged storage reads as none, and a storage that refuses is not a crash
  const dmg = mem(); dmg.setItem(RUNTIME_STORE, '{not json');
  ok(readRuntime(dmg).length === 0, 'damaged storage reads as nothing');
  dmg.setItem(RUNTIME_STORE, JSON.stringify([{ nope: 1 }, null, 5, { ...e, minRaw: '1', capRaw: '2' }]));
  ok(readRuntime(dmg).length === 1, 'a record that is not one is skipped, the rest read');
  ok(saveRuntime({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } }, e) === false && readRuntime({ getItem: () => { throw new Error('blocked'); } }).length === 0, 'a blocked storage keeps nothing and does not throw');
  // the cap on how many are kept: the newest stay
  const many = mem();
  for (let i = 0; i < 70; i++) saveRuntime(many, { ...e, addr: '0x' + i.toString(16).padStart(40, '0'), ticker: `T${i}` });
  const kept = readRuntime(many);
  ok(kept.length === 64 && kept[63].ticker === 'T69' && kept[0].ticker === 'T6', 'at most 64 are kept, the newest');
}

// ---- the /bridge/ page's way in: kept, read, added, and a crossing then reads as the token ----
{
  const m = new Map(), st = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } };
  const addr = '0x' + '5a'.repeat(20), id = '5a'.repeat(32);
  saveRuntime(st, { addr, id, ticker: 'KEPT', sym: 'KEPT', logo: '', dp: 4, dec: 6, minRaw: 2_000_000n, capRaw: 1_000_000_000n });
  for (const e of readRuntime(st)) addBridgeAsset({ key: e.key, id: e.id, route: bridgeRoute({ ticker: e.ticker, icon: runtimeIcon(e.addr), dp: e.dp, dec: e.dec }), limits: bridgeLimitEntry(e) });
  const row = outRow({ id: 'k1', stage: 'settled', source: { assetId: '0x' + id, ticker: 'KEPT', amount: '5000000' } });
  ok(row.asset === `x${addr}` && ROUTES[row.asset].icon === `tk-x${addr}` && ROUTES[row.asset].dec === 6 && row.amount === 5_000_000n, 'a crossing of a kept token reads as that token, in its mark and its decimals');
  ok(limitLine(`x${addr}`, 'out') === '2 to 1,000 KEPT a bridge while it is new', `with the limit it started under (${limitLine(`x${addr}`, 'out')})`);
  const dark = '0x' + '6b'.repeat(20);
  saveRuntime(st, { addr: dark, id: '6b'.repeat(32), ticker: 'DARK', sym: 'DARK', logo: '', dp: 2, dec: 8, minRaw: 0n, capRaw: 0n });
  for (const e of readRuntime(st).filter((x) => x.ticker === 'DARK')) addBridgeAsset({ key: e.key, id: e.id, route: bridgeRoute({ ticker: e.ticker, icon: runtimeIcon(e.addr), dp: e.dp, dec: e.dec }), limits: bridgeLimitEntry(e) });
  ok(limitLine(`x${dark}`, 'out') === '' && limitLine(`x${dark}`, 'in') === '', 'a token with no limit says no limit rather than “up to 0”');
}

// ---- the mark in a page's sprite ----
{
  // a minimal DOM: elements with attributes and children, enough to see what was built
  const doc = { createElementNS: (ns, name) => { const el = { ns, name, attrs: {}, kids: [], textContent: '', setAttribute(k, v) { this.attrs[k] = String(v); }, append(...c) { this.kids.push(...c); } }; return el; } };
  const addr = '0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c';
  const withLogo = runtimeSymbol(doc, { addr, logo: '/assets/tokens/spx.png', sym: 'SPX' });
  ok(withLogo.name === 'symbol' && withLogo.attrs.id === runtimeIcon(addr) && runtimeIcon(addr) === `tk-x${addr}`, 'the symbol is named for the token');
  ok(withLogo.kids.some((k) => k.name === 'image' && k.attrs.href === '/assets/tokens/spx.png') && withLogo.kids.some((k) => k.name === 'clipPath'), 'a logo is drawn, clipped to a circle');
  const letters = runtimeSymbol(doc, { addr, logo: 'https://elsewhere.example/x.png', sym: 'spx' });
  ok(!letters.kids.some((k) => k.name === 'image') && letters.kids.some((k) => k.name === 'text' && k.textContent === 'SP'), 'a logo off this site is not drawn: the first two letters are');
  ok(runtimeSymbol(doc, { addr, logo: '', sym: '' }).kids.some((k) => k.textContent === '?'), 'a token with no name is a question mark');
  ok(markColor(addr) === markColor(addr) && markColor(addr) !== markColor('0x' + '12'.repeat(20)) && /^hsl\(\d+ 38% 48%\)$/.test(markColor(addr)), 'a token’s colour is its address’s, and steady');
}

console.log(`\n${n} bridge-runtime checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
