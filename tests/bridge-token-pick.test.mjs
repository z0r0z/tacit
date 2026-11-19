// Any ERC-20 on the bridge page's tile (dapp/bridge/token-pick.js): the address, the name read from the token, the page's own hash, and where the button goes.
//
// 2026-11-19: JPYC went from Ethereum to Bitcoin through the front page, since the pool escrows any token and a token crosses the way cUSDT does; the bridge page's tabs are five fixed
// assets, with no way to start another. A token is named by its address, its symbol and decimals are read from the token itself (text from an unknown contract, so it is kept to what a
// symbol is), and the button opens the front page on that token's bridge.
//
// Run: node tests/bridge-token-pick.test.mjs
import { bridgeRoute as realRoute } from '../dapp/bridge/runtime.js';
import { isAddr, norm, shortAddr, tokenHash, parseTokenHash, tokenStart, safeSymbol, decodeString, readToken, tokenRoute } from '../dapp/bridge/token-pick.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
const test = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; } };

const JPYC = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const hex = (s) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
const abiString = (s) => '0x' + '20'.padStart(64, '0') + s.length.toString(16).padStart(64, '0') + hex(s).padEnd(Math.ceil(s.length / 32) * 64, '0');
const bytes32 = (s) => '0x' + hex(s).padEnd(64, '0');
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

await test('an address is 0x and 40 hex characters, in any case, with spaces around it forgiven', () => {
  ok(isAddr(JPYC) && isAddr(JPYC.toLowerCase()) && isAddr(`  ${JPYC}\n`), 'a good address was refused');
  for (const bad of ['', '0x', '0x1234', JPYC.slice(0, -1), JPYC + '0', JPYC.replace('0x', '0X'), 'E7C3D8C9a439feDe00D2600032D5dB0Be71C3c29', '0x' + 'g'.repeat(40), null, undefined]) ok(!isAddr(bad), `accepted ${bad}`);
  ok(norm(`  ${JPYC} `) === JPYC.toLowerCase() && shortAddr(norm(JPYC)) === '0xe7c3…3c29', shortAddr(norm(JPYC)));
});

await test('the page\'s hash names the token and the way: #0x… arrives from Bitcoin, #0x…/out goes to it', () => {
  ok(tokenHash(JPYC, 'out') === `#${JPYC.toLowerCase()}/out` && tokenHash(JPYC, 'in') === `#${JPYC.toLowerCase()}`, 'hash');
  ok(JSON.stringify(parseTokenHash(`#${JPYC}/out`)) === JSON.stringify({ addr: JPYC.toLowerCase(), dir: 'out' }), 'parse out');
  ok(parseTokenHash(`#${JPYC.toLowerCase()}`).dir === 'in', 'parse in');
  for (const t of ['#tac', '#tac/out', '#', '', '#0x1234', '#cusdt/out']) ok(parseTokenHash(t) === null, `read ${t} as a token`);
});

await test('the button opens the front page on the token\'s bridge: from the wallet to Bitcoin (xw), or back from Bitcoin (xb), in lower case', () => {
  ok(tokenStart(JPYC, 'out') === `/#card=bridge:xw${JPYC.toLowerCase()}`, tokenStart(JPYC, 'out'));
  ok(tokenStart(JPYC, 'in') === `/#card=bridge:xb${JPYC.toLowerCase()}`, tokenStart(JPYC, 'in'));
});

await test('a token\'s own symbol is kept to what a symbol is; anything else is the address', () => {
  ok(safeSymbol('JPYC', JPYC) === 'JPYC' && safeSymbol(' stETH ', JPYC) === 'stETH' && safeSymbol('1INCH', JPYC) === '1INCH' && safeSymbol('USD₮0', JPYC) === '0xe7c3…3c29', 'accepted or refused wrongly');
  for (const evil of ['<img src=x onerror=alert(1)>', 'A B', '', 'x'.repeat(13), '"><script>', 'Tacit — send ETH here', null]) ok(safeSymbol(evil, JPYC) === '0xe7c3…3c29', `kept ${evil}`);
});

await test('an ABI string, and the older bytes32, both read; nonsense reads as nothing', () => {
  ok(decodeString(abiString('JPYC')) === 'JPYC' && decodeString(abiString('JPY Coin')) === 'JPY Coin', 'ABI string');
  ok(decodeString(bytes32('MKR')) === 'MKR', 'bytes32');
  for (const bad of ['0x', '', null, '0x1234', abiString('JPYC').slice(0, 100), '0x' + 'zz'.repeat(40), '0x' + '00'.repeat(32), '0x' + word(64).slice(2) + word(9999).slice(2)]) ok(decodeString(bad) === '', `read ${String(bad).slice(0, 30)}`);
  ok(decodeString('0x' + '20'.padStart(64, '0') + '02'.padStart(64, '0') + '0102'.padEnd(64, '0')) === '', 'control bytes are not a symbol');
});

const callFor = (answers) => async (to, data) => { if (answers instanceof Error) throw answers; const a = answers[data]; if (a instanceof Error) throw a; return a ?? null; };
await test('a token is read for its symbol, name and decimals', async () => {
  const t = await readToken({ addr: JPYC, call: callFor({ '0x95d89b41': abiString('JPYC'), '0x06fdde03': abiString('JPY Coin'), '0x313ce567': word(18) }) });
  ok(t.addr === JPYC.toLowerCase() && t.ticker === 'JPYC' && t.name === 'JPY Coin' && t.dec === 18, JSON.stringify(t));
  const usdt = await readToken({ addr: JPYC, call: callFor({ '0x95d89b41': abiString('USDT'), '0x06fdde03': abiString('Tether USD'), '0x313ce567': word(6) }) });
  ok(usdt.dec === 6, 'decimals');
  const mkr = await readToken({ addr: JPYC, call: callFor({ '0x95d89b41': bytes32('MKR'), '0x06fdde03': bytes32('Maker'), '0x313ce567': word(18) }) });
  ok(mkr.ticker === 'MKR' && mkr.name === 'Maker', 'bytes32 token');
});

await test('an address that is not a token reads as none: no code, no symbol, a revert, no decimals, or a silly one', async () => {
  const none = (answers) => readToken({ addr: JPYC, call: callFor(answers) });
  ok(await none({}) === null && await none({ '0x95d89b41': '0x' }) === null, 'no code');
  ok(await none(new Error('network down')) === null, 'a failing call');
  ok(await none({ '0x95d89b41': abiString('JPYC'), '0x313ce567': '0x' }) === null, 'no decimals');
  ok(await none({ '0x95d89b41': abiString('JPYC'), '0x313ce567': word(200) }) === null, 'decimals of 200');
  ok(await none({ '0x95d89b41': abiString('JPYC'), '0x313ce567': 'nope' }) === null, 'decimals that are not a number');
  ok(await readToken({ addr: 'not an address', call: callFor({}) }) === null, 'a bad address');
  const t = await readToken({ addr: JPYC, call: callFor({ '0x95d89b41': abiString('<b>'), '0x06fdde03': abiString('x'), '0x313ce567': word(8) }) });
  ok(t.ticker === '0xe7c3…3c29', 'a symbol that is not a symbol must not be shown');
});

await test('the tile\'s route for a token has the steps both ways and the right button for each', () => {
  const bridgeRoute = ({ ticker, icon, dp, dec }) => ({ ticker, icon, dp, ...(dec != null && dec !== 8 ? { dec } : {}), in: { start: '/#bridge', go: `Bring ${ticker} back`, steps: ['a', 'b'] }, out: { start: '/#bridge', go: `Bridge ${ticker}`, steps: ['c', 'd'] } });
  const r = tokenRoute({ addr: JPYC.toLowerCase(), ticker: 'JPYC', dec: 18 }, bridgeRoute);
  ok(r.ticker === 'JPYC' && r.icon === `tk-x${JPYC.toLowerCase()}` && r.dec === undefined && r.dp === 4, JSON.stringify(r));   // 18 decimals on Ethereum, 8 in a note (the pool's unit, the default)
  const six = tokenRoute({ addr: JPYC.toLowerCase(), ticker: 'USDX', dec: 6 }, bridgeRoute);
  ok(six.dec === 6 && six.dp === 4, 'a six-decimal token keeps six');
  ok(r.out.start === `/#card=bridge:xw${JPYC.toLowerCase()}` && r.in.start === `/#card=bridge:xb${JPYC.toLowerCase()}`, 'buttons');
  ok(r.out.go === 'Bridge JPYC' && r.in.go === 'Bring JPYC back' && r.out.steps.length === 2, 'labels and steps are the shared ones');
});

await test('a kept token\'s rows link to its own card (not the bare #bridge, which the front page sends to /tac/), both ways', () => {
  const a = JPYC.toLowerCase();
  const r = realRoute({ ticker: 'JPYC', icon: 'i', dp: 4, dec: 8, addr: JPYC });
  ok(r.out.href === `/#card=bridge:xw${a}` && r.out.start === r.out.href, `out ${r.out.href}`);
  ok(r.in.href === `/#card=bridge:xb${a}` && r.in.start === r.in.href, `in ${r.in.href}`);
  const t = tokenRoute({ addr: a, ticker: 'JPYC', dec: 18 }, realRoute);
  ok(t.out.href === `/#card=bridge:xw${a}` && t.in.href === `/#card=bridge:xb${a}`, 'the picker\'s route keeps the same links');
  for (const bad of [undefined, '', '0x12', 'nope']) ok(realRoute({ ticker: 'T', icon: 'i', dp: 2, addr: bad }).out.href === '/#bridge', `an address of ${bad} must keep the generic link`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
