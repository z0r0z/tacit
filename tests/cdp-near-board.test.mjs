// tools/cdp-near-board.mjs: what the liquidation keeper says about cUSD loans close to their line, with the loans, the price and the engine's ratio put in.
//   node tests/cdp-near-board.test.mjs
import assert from 'node:assert/strict';
import { boardPlan, loanTag } from '../tools/cdp-near-board.mjs';

const E8 = 10n ** 8n, LEAF = (n) => '0x' + n.toString(16).padStart(64, '0');
const L = (leaf, cusd, sats) => ({ leaf, debt: BigInt(Math.round(cusd * 1e8)), sats: BigInt(sats) });
// 0.002 cBTC against 110 cUSD is the loan of the 11-12 liquidation; the engine's line is 130%
const loan = L('0xab12cd34' + 'e'.repeat(56), 110, 200000);
const at = (usd, o = {}) => ({ price: BigInt(Math.round(usd * 1e8)), liqBps: 13000n, ...o });

assert.equal(loanTag(loan.leaf), 'ab12cd34'); assert.equal(loanTag('AB12CD34' + 'e'.repeat(56)), 'AB12CD34', 'the first eight digits, 0x or not');
assert.equal(loanTag(LEAF(0xdeadbeefn)), '00000000');

// a loan well clear says nothing; one that comes near says how far bitcoin must fall, rounded down
assert.deepEqual(boardPlan([loan], at(120000)), { lines: [], keep: [] }, '218%: nothing to say');
let p = boardPlan([loan], at(74000));
assert.deepEqual(p.lines, ['cUSD loan ab12cd34: 110.00 cUSD against 0.002 cBTC, at 134% against a 130% line. Bitcoin falling 3% from $74,000 liquidates it.']);
assert.deepEqual(p.keep, [loan.leaf.toLowerCase()]);
// under the line (the 11-12 price): it can be liquidated now, and 129.96% is not said as 130%
p = boardPlan([loan], at(71482.1));
assert.deepEqual(p.lines, ['cUSD loan ab12cd34: 110.00 cUSD against 0.002 cBTC, at 129% against a 130% line. It can be liquidated now.']);
assert.match(boardPlan([loan], at(71600)).lines[0], /Bitcoin falling less than 1% from \$71,600 liquidates it\./);

// told once: the same loan, still near, is not said again; clear by more than the margin it is forgotten, and said again when it returns
const first = boardPlan([loan], at(74000));
assert.deepEqual(boardPlan([loan], at(74000, { seen: first.keep })), { lines: [], keep: first.keep }, 'already said');
const caps = { ...loan, leaf: '0x' + loan.leaf.slice(2).toUpperCase() };
assert.deepEqual(boardPlan([caps], at(74000, { seen: first.keep })).lines, [], 'a leaf written in capitals is the same loan');
// at $80,300 the loan is at 146%: bitcoin 11% from the line, no longer near but inside the 3-point margin, so it is still remembered and not said again
const hover = boardPlan([loan], at(80300, { seen: first.keep }));
assert.deepEqual(hover.lines, []); assert.deepEqual(hover.keep, first.keep, 'just clear of the line it hovers at: remembered');
assert.deepEqual(boardPlan([loan], at(80300)).lines, [], 'and not near for a first time either');
const clear = boardPlan([loan], at(90000, { seen: first.keep }));
assert.deepEqual(clear, { lines: [], keep: [] }, 'well clear again: forgotten');
assert.equal(boardPlan([loan], at(74000, { seen: clear.keep })).lines.length, 1, 'and said again when it comes back');
assert.deepEqual(boardPlan([], at(74000, { seen: first.keep })), { lines: [], keep: [] }, 'a loan that is gone is forgotten');

// several loans, each on its own; amounts written with their cents and every digit of a bitcoin
const big = L(LEAF(0x1234abcdn), 1234.5, 123456789);
p = boardPlan([loan, big, L(LEAF(2n), 50, 5_000_000)], at(74000));
assert.equal(p.lines.length, 1, 'the other two are at 7,400%: only the first is near');
p = boardPlan([big], at(1000));
assert.match(p.lines[0], /^cUSD loan 00000000: /, 'named by the first eight digits of its leaf (a small number is padded with zeros)');
assert.match(p.lines[0], /1,234\.50 cUSD against 1\.23456789 cBTC, at 100% against a 130% line\. It can be liquidated now\.$/);

// the debt is what the engine says it is owed now, so a position with a fee accrued is judged on that (the keeper passes currentDebt as `debt`)
assert.equal(boardPlan([loan], at(90000)).lines.length, 0, '110 owed against $180 is 163%: nothing');
assert.match(boardPlan([{ ...loan, debt: loan.debt * 120n / 100n }], at(90000)).lines[0], /^cUSD loan ab12cd34: 132\.00 cUSD against 0\.002 cBTC, at 136% against a 130% line\. Bitcoin falling 4% from \$90,000/, '132 owed against $180 is 136%: near');

console.log('cdp-near-board: all checks passed');
