// The front page's warning for a pool priced away from the market (dapp/index.html, dapp/front/sheets.js): the acknowledgement a deposit is held to (lossGate, lossOk) asks sooner and
// says why, the pool is said as a line and a row of the card's receipt, and every place that holds a deposit to its cost passes the pool's verdict. The real source is cut out of the page
// (the technique of tests/zap-page-flows.test.mjs); the thresholds are lp-zap.js's own (tests/lp-zap.test.mjs).
//   node --test tests/off-market-page.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ackFor, offMarket } from '../dapp/lp-zap.js';

const page = readFileSync(new URL('../dapp/index.html', import.meta.url), 'utf8'), sheets = readFileSync(new URL('../dapp/front/sheets.js', import.meta.url), 'utf8');
const cut = (src, a, b) => { const s = src.indexOf(a), e = src.indexOf(b, s + a.length); assert.ok(s >= 0 && e > s, `the source has ${a}`); return src.slice(s, e); };
const make = (src, names, stubs, returns) => new Function(...names, `${src}\nreturn { ${returns} };`)(...names.map((k) => stubs[k]));
// the page's html tag, as far as these functions use it: the pieces joined, nested fragments flattened
const html = (strings, ...vals) => ({ s: strings.reduce((a, str, i) => a + str + (i < vals.length ? (vals[i]?.s ?? vals[i]) : ''), '') });
const pctFmt = (x) => (x >= 99.5 && x < 99.95 ? `${x.toFixed(1)}%` : `${x >= 10 ? Math.round(x) : x.toFixed(1)}%`);      // the page's own (dapp/index.html)

const gate = make(cut(page, 'const acked = {};', '\nconst RPC_HEALTH'), ['html', 'ackFor', 'pctFmt'], { html, ackFor, pctFmt }, 'lossGate, lossOk, wireAck, acked');
const tick = (checked) => ({ type: 'checkbox', value: 'on', checked }), typedIn = (value) => ({ type: 'text', value, checked: false });      // what the page's inputs hold
const box = (o) => ({ querySelector: () => o });
const OFF = offMarket(1.41);

test('an ordinary pool is held to a tick from 15% and a typed number from 30%, as before', () => {
  assert.equal(gate.lossGate('a', 4, 'deposit').s, '', 'under 15%: nothing');
  assert.match(gate.lossGate('a', 20, 'deposit').s, /type="checkbox"[\s\S]*I accept losing about 20% of this deposit to the pool’s price move\./);
  assert.match(gate.lossGate('a', 31, 'deposit').s, /Type <b>31<\/b> to accept losing about 31% of this deposit to the pool’s price move\./);
  assert.equal(gate.lossOk(box(null), 14), true); assert.equal(gate.lossOk(box(null), 20), false, 'no input drawn, a 20% cost is not accepted');
  assert.equal(gate.lossOk(box(tick(true)), 20), true); assert.equal(gate.lossOk(box(tick(false)), 20), false);
  assert.equal(gate.lossOk(box(typedIn('31')), 31), true); assert.equal(gate.lossOk(box(typedIn(' 31 ')), 31), true); assert.equal(gate.lossOk(box(typedIn('30')), 31), false);
  assert.equal(gate.lossOk(box(tick(true)), 31), false, 'a tick is not a typed number at 30% and over');
});

test('a pool off the market is held to a tick from 5% and a typed number from 15%, and the line says the pool is off', () => {
  assert.equal(gate.lossGate('a', 4, 'deposit', OFF).s, '', 'under 5%: nothing');
  const tickLine = gate.lossGate('b', 8, 'deposit', OFF).s;
  assert.match(tickLine, /type="checkbox"/); assert.match(tickLine, /I accept losing about 8% of this deposit: this pool is priced 41% off the market\./);
  const typedLine = gate.lossGate('c', 19, 'deposit', OFF).s;
  assert.match(typedLine, /Type <b>19<\/b> to accept losing about 19% of this deposit: this pool is priced 41% off the market\./); assert.doesNotMatch(typedLine, /type="checkbox"/);
  assert.equal(gate.lossOk(box(null), 4, OFF), true, 'a cost under 5% asks nothing');
  assert.equal(gate.lossOk(box(tick(true)), 8, OFF), true); assert.equal(gate.lossOk(box(tick(false)), 8, OFF), false);
  assert.equal(gate.lossOk(box(tick(true)), 19, OFF), false, 'the 1 ETH zap into a pool this far off needs the number, not a tick');
  assert.equal(gate.lossOk(box(typedIn('19')), 19, OFF), true); assert.equal(gate.lossOk(box(typedIn('18')), 19, OFF), false);
  assert.equal(gate.lossOk(box(null), 19, OFF), false, 'no input drawn, nothing is accepted');
});

test('wireAck keeps what was accepted for the same percent and clears it when the input is wrong', () => {
  let calls = 0; const el = { type: 'text', value: '', addEventListener(n, f) { this[n] = f; } };
  gate.wireAck({ querySelector: () => el }, 'k', 19, () => { calls++; });
  el.value = '19'; el.input(); assert.equal(gate.acked.k, 19); el.value = '9'; el.change(); assert.equal(gate.acked.k, null); assert.equal(calls, 2);
});

test('the pool is said as a line and a row of the receipt, with the pool’s price against the market’s', () => {
  const src = `${cut(page, 'function poolVsMarket(p) {', '\nconst aprShort')}`;
  const ethUsd = 1563, TPX = { v: { usdBtc: 80000, ethBtc: 80000 / ethUsd, mid: 0.0001 } }, CETH_ID = '0x' + 'c3'.repeat(32);
  const f = make(src, ['TPX', 'CETH_ID', 'shownAs', 'pctFmt', 'sig'], { TPX, CETH_ID, shownAs: (k) => k, pctFmt, sig: (v) => String(v) }, 'poolVsMarket, offSay, offRow');
  // cETH/cUSD as it stood before the 1 ETH zap of 11-22: 2.108 tETH against 2,340 cUSD
  const pm = f.poolVsMarket({ pair: 'cETH/cUSD', reserves: { assetA: CETH_ID, reserveA: 210800571, reserveB: 233977873019 } }), off = offMarket(pm.ratio);
  assert.ok(off && off.dear && Math.abs(off.gap - 0.408) < 0.002, `the pool prices cUSD ${Math.round((pm.ratio - 1) * 100)}% over`);
  assert.equal(f.offSay(pm, off), 'This pool is off the market: its price for cUSD is 41% above the market’s. Half of a deposit is swapped at that price, and what stays in the pool is what traders take when they bring the price back.');
  assert.deepEqual(f.offRow(pm), ['Pool price', '1 ETH = 1,110 cUSD here, 1,563 on the market', 'err']);
  const under = f.poolVsMarket({ pair: 'cETH/cUSD', reserves: { assetA: CETH_ID, reserveA: 210800571, reserveB: 233977873019 * 2 } });
  assert.match(f.offSay(under, offMarket(under.ratio)), /its price for cUSD is \d+% below the market’s/, 'a pool pricing the coin under the market says below');
});

test('every place that holds a deposit to its cost passes the pool’s verdict', () => {
  const q = cut(page, 'async function zapQuote(', '\nfunction zapAhead');
  assert.match(q, /off: offMarket\(pm\?\.ratio\), pm,/, 'the zap quote carries the verdict and the pool’s price');
  assert.match(page, /const hxGateOk = \(\) => \{ const g = HX\.q\?\.gate, off = HX\.q\?\.gateOff, box = \$\('#hx-ack'\); return !ackFor\(g, off\) \|\| \(!!box && lossOk\(box, g, off\)\); \};/, 'the card’s press is held to it');
  assert.match(page, /const g = ackFor\(q\.gate, q\.gateOff\) \? q\.gate : 0, view = g \? lossGate\('hx-ackv', g, 'deposit', q\.gateOff\)/, 'and so is the line it draws');
  assert.match(page, /gate: ex \? ex\.gate : ackFor\(HX\.zq\?\.impact, HX\.zq\?\.off\) \? HX\.zq\.impact : 0, gateOff: ex \? ex\.gateOff : HX\.zq\?\.off \|\| null,/, 'the zap’s gate carries it');
  assert.match(page, /gate: worst, gateOff: off,/, 'the private join’s gate carries it');
  assert.match(page, /off: offMarket\(pm\?\.ratio\), over: false, gasShort/, 'the private join’s quote carries it to its sheet');
  assert.match(page, /HX\.zq\?\.off \? `\$\{offSay\(HX\.zq\.pm, HX\.zq\.off\)\}/, 'the card says the pool is off before the zap is sent');
  assert.match(page, /\.\.\.entry, off: offMarket\(poolVsMarket\(p\)\?\.ratio\) \}\);/, 'the pool list knows which pools are off');
  assert.match(page, /c\.off \? html` · <i class="fms-thin fms-off">off the market<\/i>`/, 'a farm chip says so');
  for (const [what, re] of [['the zap sheet’s button', /lossOk\(ackBox, q\.impact \|\| 0, q\.off\); \};\n[\s\S]*?const \{ plan, sp, gas, gp/], ['the zap sheet’s line', /lossGate\(`sz-ackv-\$\{pid\}`, q\.impact, 'deposit', q\.off\)/], ['the zap sheet’s press', /!lossOk\(ackBox, z\.impact \|\| 0, z\.off\)\) return;\n    await zapNow/],
    ['the join sheet’s button', /q\.gasShort \|\| !lossOk\(ackBox, q\.impact \|\| 0, q\.off\)/], ['the join sheet’s line', /lossGate\(`sj-ackv-\$\{pid\}`, worst, 'deposit', q\.off\)/], ['the join sheet’s press', /z\.gasShort \|\| !lossOk\(ackBox, z\.impact \|\| 0, z\.off\)\) return;/]]) assert.match(sheets, re, what);
  assert.doesNotMatch(sheets, /lossOk\(ackBox, (q|z)\.impact \|\| 0\)/, 'no deposit sheet is left holding the old rule');
});
