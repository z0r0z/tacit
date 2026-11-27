#!/usr/bin/env node
// dapp/vault/math.js: the vault page's arithmetic. Every figure the page suggests (what can be borrowed, withdrawn or repaid, what must be added to
// reach 400%, the price a vault is liquidated at) is checked against a second, separate transcription of TacVault.sol's own tests (_borrow,
// _withdraw, repay, liquidate, redeem), on thousands of random vaults: an amount the page offers is accepted by that model, and one more unit is not.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../dapp/vault/math.js';
import { frontPage } from './lib/front-page.mjs';

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const { BPS, WAD } = M;
const E18 = 10n ** 18n;
const min = (a, b) => (a < b ? a : b);

// ── the contract, as written ──
const model = {
  value: (tac, price) => tac * price / WAD,
  borrowOk({ collateral, debt, totalDebt, amount, feeBps, minDebt, pB, mint, cap }) {                     // TacVault._borrow, past the auction check
    if (amount === 0n) return false;
    const fee = amount * feeBps / BPS, d = debt + amount + fee;
    if (d < minDebt) return false;
    if (totalDebt + amount + fee > cap) return false;
    return !(d * mint > model.value(collateral, pB) * BPS);                                            // _requireBorrowHealthy
  },
  withdrawOk({ collateral, debt, amount, pB, mint }) {                                                   // TacVault._withdraw
    amount = min(amount, collateral);
    if (amount === 0n) return false;
    const c = collateral - amount;
    return debt === 0n || !(debt * mint > model.value(c, pB) * BPS);
  },
  repayOk({ debt, amount, minDebt, balance }) {                                                          // TacVault.repay (the burn needs the balance)
    const paid = min(amount, debt);
    if (paid === 0n) return false;
    const left = debt - paid;
    return !(left !== 0n && left < minDebt) && paid <= balance;
  },
  zone({ collateral, debt, price, liq }) {                                                               // liquidate's test, then redeem's
    if (debt === 0n) return 'none';
    const v = model.value(collateral, price);
    if (v * BPS < debt * liq) return 'liquidation';
    return v * BPS / debt >= 2n * liq ? 'safe' : 'redemption';
  },
};

// ── a small deterministic generator, so a failure repeats ──
let seed = 0x9e3779b97f4a7c15n;
const next = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return seed >> 11n; };
const rnd = (lo, hi) => lo + next() % (hi - lo + 1n);
const log = (lo, hi) => { const a = BigInt(lo.toString().length), b = BigInt(hi.toString().length); const d = rnd(a, b); return min(hi, rnd(10n ** (d - 1n), 10n ** d - 1n)); };

// a random vault and its market: TAC at a price between a hundredth of a cent and a few dollars (per 1e18), a few fee settings
function vault() {
  const pB = log(10n ** 13n, 5n * 10n ** 18n), pL = pB + pB * rnd(0n, 400n) / 10000n;
  const collateral = log(10n ** 15n, 10n ** 27n), mint = 35000n, liq = 20000n, minDebt = [100n * E18, E18 / 25n][Number(rnd(0n, 1n))];
  const feeBps = [0n, 50n, 100n, 500n][Number(rnd(0n, 3n))];
  const maxD = model.value(collateral, pB) * BPS / mint;
  const debt = rnd(0n, 3n) === 0n ? 0n : min(maxD * rnd(0n, 110n) / 100n, maxD * 2n);                 // some vaults are already past the line
  const totalDebt = debt + log(1n, 10n ** 26n), cap = totalDebt + (rnd(0n, 4n) === 0n ? 0n : log(1n, 10n ** 27n));
  return { collateral, debt: debt >= minDebt || debt === 0n ? debt : 0n, pB, pL, mint, liq, minDebt, feeBps, totalDebt, cap };
}

// ── the zones ──
{
  const base = { collateral: 1000n * E18, price: E18, liq: 20000n };                                    // 1000 TAC at 1.0
  assert.equal(M.zoneOf({ ...base, debt: 0n }), 'none');
  assert.equal(M.zoneOf({ ...base, debt: 500n * E18 }), 'redemption');                                   // 1000 against 500 owed is exactly 200%
  ok('a vault at exactly 200% is not yet in liquidation (the test is "value × 10000 < debt × 20000"); one unit of debt more is');
  assert.equal(M.zoneOf({ ...base, debt: 500n * E18 + 1n }), 'liquidation');
  assert.equal(M.zoneOf({ ...base, debt: 250n * E18 }), 'safe');
  assert.equal(M.zoneOf({ ...base, debt: 250n * E18 + 1n }), 'redemption');
  ok('at exactly 400% a vault is safe (redemption refuses a ratio of twice the liquidation ratio or more), one unit of debt more is not');
  let bad = 0;
  for (let i = 0; i < 5000; i++) {
    const v = vault(); if (v.debt === 0n) continue;
    const a = { collateral: v.collateral, debt: v.debt, price: v.pL, liq: v.liq };
    if (M.zoneOf(a) !== model.zone(a)) bad++;
  }
  assert.equal(bad, 0);
  ok('5,000 random vaults: the zone is the one the contract\'s liquidate and redeem tests give');
}

// ── adding TAC to reach 400% ──
{
  let checked = 0, tight = 0;
  for (let i = 0; i < 5000; i++) {
    const v = vault(); if (v.debt === 0n || v.pL === 0n) continue;
    for (const dp of [2, 4]) {
      const N = M.topUp({ collateral: v.collateral, debt: v.debt, price: v.pL, bps: 2n * v.liq, dp });
      const z = (extra) => model.zone({ collateral: v.collateral + extra, debt: v.debt, price: v.pL, liq: v.liq });
      assert.equal(z(N) === 'safe', true, `adding ${N} reaches 400%`);
      assert.equal(N % (10n ** BigInt(18 - dp)), 0n, 'rounded up to the decimals shown');
      if (N > 0n) { const less = N - 10n ** BigInt(18 - dp); if (less >= 0n && z(less) !== 'safe') tight++; else if (less >= 0n) assert.fail('one unit less would have been enough'); }
      else assert.equal(M.zoneOf({ collateral: v.collateral, debt: v.debt, price: v.pL, liq: v.liq }), 'safe');
      checked++;
    }
  }
  assert.ok(checked > 3000 && tight > 300);
  ok(`${checked} top-ups: adding the amount shown reaches 400% at the liquidation view, and one unit less (at the decimals shown) does not`);
  assert.equal(M.topUp({ collateral: 1000n * E18, debt: 500n * E18, price: E18, bps: 40000n }), 1000n * E18);
  assert.equal(M.topUp({ collateral: 1000n * E18, debt: 0n, price: E18, bps: 40000n }), 0n);
  ok('the worked case: 1,000 TAC at 1.0 against 500 owed needs 1,000 more TAC for 400%; no debt needs none');
}

// ── what can be borrowed ──
{
  let withRoom = 0, atEdge = 0, zero = 0;
  for (let i = 0; i < 6000; i++) {
    const v = vault(), room = M.sharedRoom({ debtCeiling: v.cap, depthCeiling: M.MAX_UINT, totalDebt: v.totalDebt });
    const L = M.borrowLimit({ collateral: v.collateral, debt: v.debt, pB: v.pB, mint: v.mint, feeBps: v.feeBps, room, minDebt: v.minDebt });
    const m = (amount) => model.borrowOk({ ...v, amount });
    if (L.amount > 0n) { withRoom++; assert.equal(m(L.amount), true, `the limit ${L.amount} goes through`); if (!m(L.amount + 1n)) atEdge++; else assert.fail('one more unit should be refused'); }
    else { zero++; // nothing can be borrowed: no amount tried passes
      for (const a of [1n, 10n ** 12n, v.minDebt, v.minDebt * 2n]) assert.equal(m(a), false, `no amount works when the limit is zero (${a})`);
    }
    // the check the page runs on a typed amount agrees with the contract
    const a = rnd(0n, 1n) ? log(1n, 10n ** 27n) : L.amount + rnd(0n, 3n) - 1n;
    if (a > 0n) assert.equal(M.checkBorrow({ amount: a, collateral: v.collateral, debt: v.debt, pB: v.pB, mint: v.mint, feeBps: v.feeBps, room, minDebt: v.minDebt }).ok, m(a), `checkBorrow(${a}) is the contract's answer`);
  }
  assert.ok(withRoom > 1500 && zero > 300 && atEdge === withRoom);
  ok(`${withRoom} random limits go through and one unit more is refused (${zero} had no room, and nothing passes there); typed amounts are judged as the contract judges them`);
  // the fee rides on top: borrowing 1,000 at 1% owes 1,010 and the borrower gets 1,000
  const c = M.checkBorrow({ amount: 1000n * E18, collateral: 10000n * E18, debt: 0n, pB: E18, mint: 35000n, feeBps: 100n, room: 10n ** 30n, minDebt: 100n * E18 });
  assert.equal(c.fee, 10n * E18); assert.equal(c.owe, 1010n * E18); assert.equal(c.ok, true);
  ok('the fee preview: borrowing 1,000 at 1% costs 10 and leaves 1,010 owed, with 1,000 received');
  // the smallest borrow that gets a new vault to its minimum debt is accepted, one unit under is not
  for (const feeBps of [0n, 50n, 100n, 500n]) {
    const least = M.amountForAtLeast(100n * E18, feeBps), d = (a) => a + M.feeOf(a, feeBps);
    assert.ok(d(least) >= 100n * E18 && d(least - 1n) < 100n * E18, `least borrow at ${feeBps} bps`);
  }
  ok('the least borrow to reach the minimum debt is exact at each fee');
  assert.equal(M.sharedRoom({ debtCeiling: M.MAX_UINT, depthCeiling: 500n, totalDebt: 100n }), 400n);
  assert.equal(M.sharedRoom({ debtCeiling: 300n, depthCeiling: 500n, totalDebt: 100n }), 200n);
  assert.equal(M.sharedRoom({ debtCeiling: 300n, depthCeiling: 500n, totalDebt: 700n }), 0n);
  ok('the room is the lesser of the owner\'s ceiling and the depth share, less the debt, never below zero');
  // the binding limit is named
  const bound = (own, room) => M.borrowLimit({ collateral: own, debt: 0n, pB: E18, mint: 35000n, feeBps: 0n, room, minDebt: 0n }).binding;
  assert.equal(bound(3500n * E18, 100n * E18), 'room'); assert.equal(bound(350n * E18, 10n ** 30n), 'own');
  ok('which limit binds (the vault\'s TAC or the market\'s room) is told apart');
}

// ── what can be withdrawn ──
{
  let n1 = 0, edge = 0;
  for (let i = 0; i < 6000; i++) {
    const v = vault();
    const w = M.withdrawLimit({ collateral: v.collateral, debt: v.debt, pB: v.pB, mint: v.mint });
    const m = (amount) => model.withdrawOk({ collateral: v.collateral, debt: v.debt, amount, pB: v.pB, mint: v.mint });
    if (w > 0n) { n1++; assert.equal(m(w), true); if (w < v.collateral) { assert.equal(m(w + 1n), false); edge++; } }
    else if (v.collateral > 0n) assert.equal(m(1n), false, 'nothing can leave when the limit is zero');
  }
  assert.ok(n1 > 2000 && edge > 1000);
  ok(`${n1} random withdraw limits are accepted, and one unit more is refused (${edge} with a debt that binds)`);
  assert.equal(M.withdrawLimit({ collateral: 5n * E18, debt: 0n, pB: 0n, mint: 35000n }), 5n * E18);
  ok('with no debt all the TAC can leave, with no price needed');
}

// ── what can be repaid ──
{
  let all = 0, part = 0;
  for (let i = 0; i < 6000; i++) {
    const minDebt = [100n * E18, E18 / 25n][Number(rnd(0n, 1n))], debt = rnd(0n, 3n) === 0n ? 0n : minDebt + log(0n, 10n ** 25n), balance = rnd(0n, 2n) === 0n ? debt + log(0n, 10n ** 20n) : log(0n, debt + 1n);
    const L = M.repayLimit({ debt, balance, minDebt });
    const m = (amount) => model.repayOk({ debt, amount, minDebt, balance });
    if (L.max > 0n) { assert.equal(m(L.max), true, 'what can be repaid goes through'); L.all ? all++ : part++; if (!L.all && L.max < balance) assert.equal(m(L.max + 1n), false); }
    else if (debt > 0n) for (const a of [1n, debt / 2n, balance]) if (a > 0n) assert.equal(m(a) && a < debt, false, 'with a zero limit no part-repayment passes');
    const a = log(1n, debt + 10n ** 20n);
    if (debt > 0n) { const c = M.checkRepay({ amount: a, debt, balance, minDebt }); assert.equal(c.ok, m(a), `checkRepay(${a})`); assert.equal(c.all, a >= debt); }
  }
  assert.ok(all > 500 && part > 500);
  ok(`${all} full and ${part} partial repayments the page offers are accepted, and what it refuses the contract refuses`);
  // short of the fee: borrowed 1,000 (received), owe 1,010, hold 1,000: nothing partial leaves a debt of 0 or 100+, so only all works
  const L = M.repayLimit({ debt: 101n * E18, balance: 100n * E18, minDebt: 100n * E18 });
  assert.equal(L.all, false); assert.equal(L.max, E18);
  const c = M.checkRepay({ amount: 100n * E18, debt: 101n * E18, balance: 100n * E18, minDebt: 100n * E18 });
  assert.equal(c.ok, false); assert.equal(c.why, 'min');
  ok('a vault that owes 101 of a 100 minimum and holds 100 can repay 1 or all 101, not 100 (the page says so)');
}

// ── the health bar ──
{
  assert.equal(M.barPos(20000), 0.25); assert.equal(M.barPos(40000), 0.75); assert.equal(M.barPos(35000), 0.625);
  assert.equal(M.barPos(5000), 0); assert.equal(M.barPos(1e9), 1);
  ok('the bar runs 100% to 500%: 200% sits a quarter in, the 350% line five eighths, 400% three quarters; ratios off the ends pin to the ends');
  assert.equal(M.borrowLineBps({ mint: 35000n, pL: E18, pB: E18 }), 35000n);
  assert.equal(M.borrowLineBps({ mint: 35000n, pL: 11n * E18 / 10n, pB: E18 }), 38500n);
  assert.equal(M.borrowLineBps({ mint: 35000n, pL: E18, pB: 0n }), 35000n);
  ok('the borrowing line is at 350% when both prices agree, and moves right by how much the borrow price is below the liquidation price');
  // a vault standing on the line, in the bar's terms, can borrow nothing more: its ratio at the liquidation view equals the line
  let on = 0;
  for (let i = 0; i < 12000; i++) {
    const v = vault(); if (v.debt === 0n) continue;
    const ratioL = Number(M.ratioBps(M.valueOf(v.collateral, v.pL), v.debt)), line = Number(M.borrowLineBps({ mint: v.mint, pL: v.pL, pB: v.pB }));
    const borrowRoom = M.borrowLimit({ collateral: v.collateral, debt: v.debt, pB: v.pB, mint: v.mint, feeBps: 0n, room: 10n ** 40n, minDebt: 0n }).amount;
    if (ratioL < line * 0.999) { assert.equal(borrowRoom, 0n, `left of the line there is no room (${ratioL} < ${line})`); on++; }
    if (ratioL > line * 1.001) assert.ok(borrowRoom > 0n, `right of the line there is room (${ratioL} > ${line})`);
  }
  assert.ok(on > 50);
  ok('the marker is left of the borrowing line when this vault has no room to borrow, and right of it when it has');
}

// ── the liquidation price ──
{
  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    const v = vault(); if (v.debt === 0n || v.collateral === 0n) continue;
    const p = M.liquidationPriceOf(v.collateral, v.debt, v.liq);
    assert.ok(p * v.collateral * BPS >= v.debt * v.liq * WAD, 'at the price shown the vault is at 200% or better');
    assert.ok((p - 1n) * v.collateral * BPS < v.debt * v.liq * WAD, 'one unit lower it is under');
    checked++;
  }
  ok(`${checked} liquidation prices are the exact threshold, rounded up (the danger is never shown as later than it is)`);
  assert.equal(M.sigTo(123456n, 3, 'up'), 124000n); assert.equal(M.sigTo(123456n, 3, 'down'), 123000n); assert.equal(M.sigTo(99n, 3, 'up'), 99n);
  ok('prices are written to three significant digits, the liquidation price up');
}

// ── writing and reading amounts ──
{
  assert.equal(M.fmtUnits(123999999999999999999n, 18, 2), '123.99');       // down, never up
  assert.equal(M.fmtUnits(1234567n * E18, 18, 2), '1,234,567');
  assert.equal(M.fmtAmount(123456789n * 10n ** 9n, 2), '0.12');
  assert.equal(M.fmtAmount(123n * 10n ** 12n, 2), '0.00012');               // a small amount keeps two significant digits
  assert.equal(M.plain(1500n * E18 + 10n ** 17n), '1500.1');
  assert.equal(M.floorTo(1999999n * 10n ** 12n, 2), 1990000n * 10n ** 12n); assert.equal(M.ceilTo(1000001n * 10n ** 12n, 2), 1010000n * 10n ** 12n);
  assert.equal(M.ceilTo(5n * E18, 2), 5n * E18);
  ok('amounts are written rounding down (never more than there is), the amount to add rounds up, small amounts keep two significant digits');
  assert.equal(M.span(172800), '2 days'); assert.equal(M.span(180000), '2 days 2 h'); assert.equal(M.span(19200), '5 h 20 min'); assert.equal(M.span(7200), '2 h'); assert.equal(M.span(600), '10 min'); assert.equal(M.span(5), '1 min');
  assert.equal(M.clock(75), '1:15'); assert.equal(M.clock(0), '0:00'); assert.equal(M.clock(-5), '0:00'); assert.equal(M.clock(59.2), '1:00');
  ok('the owner-window countdown reads m:ss');

  // decimals: the front page's rule (a comma is a decimal point except where it plainly groups thousands; 1,500 is left unread)
  const CASES = [
    ['0.001', 8, 100000n], ['.5', 8, 50000000n], ['1.', 8, 100000000n], ['1', 8, 100000000n],
    ['0,001', 8, 100000n], ['0,5', 8, 50000000n], ['1,5', 8, 150000000n], ['12,5', 8, 1250000000n], ['10,50', 8, 1050000000n],
    ['1,234.5', 8, 123450000000n], ['1,000,000', 8, 100000000000000n], ['1,000.', 8, 100000000000n],
    ['1,500', 8, null], ['1,2,3', 8, null], ['1,23,456', 8, null],
    ['', 8, null], ['.', 8, null], ['abc', 8, null], ['-1', 8, null], ['0.123456789', 8, null],
  ];
  const trade = eval(`(${/function parseUnits\(text, dec = 18\) \{[\s\S]*?\n\}/.exec(readFileSync(new URL('../dapp/trade/app.js', import.meta.url), 'utf8'))[0]})`);
  const front = eval(`(${/function parseUnits\(s, dec = 18\) \{[\s\S]*?\n\}/.exec(frontPage(new URL('../dapp/index.html', import.meta.url)))[0]})`);
  for (const [text, dec, want] of CASES) {
    assert.equal(M.parseUnits(text, dec), want, `vault ${JSON.stringify(text)}`);
    assert.equal(trade(text, dec), want, `trade ${JSON.stringify(text)}`);
    assert.equal(front(text, dec), want, `front ${JSON.stringify(text)}`);
  }
  assert.equal(M.parseUnits('0,05', 18), 5n * 10n ** 16n);
  ok(`${CASES.length} amounts, decimal commas included, are read as the front page and the trade page read them (their own code is run for the comparison)`);
}

console.log(`${n} checks passed`);
