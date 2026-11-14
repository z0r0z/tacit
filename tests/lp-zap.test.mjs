#!/usr/bin/env node
// The ETH → private LP zap's sizing (dapp/lp-zap.js) against the pool's own arithmetic (TacitPublicAmm's swap and add, the pool's pro-rata
// remove): with nothing in between, it mints exactly the shares its note commits to; with any trade, add or remove landing first, it mints at
// most that many, so with minShares set to them the transaction mints exactly them or reverts, and no deposit is left a note cannot open.
//   node tests/lp-zap.test.mjs
import { zapPlan, zapPlanFor, zapSplitPlan, zapSplitSearch, zapWorth, zapCalldata, zapSettleCalldata, ammOut, addShares, foundingPlan } from '../dapp/lp-zap.js';

let n = 0; const ok = (c, m) => { if (c) { n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };
let seed = 7n; const rnd = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return seed >> 11n; };
const between = (lo, hi) => lo + (rnd() % (hi - lo + 1n));
const U = 10n ** 10n, FEE = 30n;

// the pool, in units: a swap (fee off the input, the whole input joins), a public add (floors, takes the ceiling, refunds the rest), a remove
const swap = (st, x, aIn, fee = FEE) => { const out = aIn ? ammOut(st.ra, st.rb, x, fee) : ammOut(st.rb, st.ra, x, fee); if (!out) return false; if (aIn) { st.ra += x; st.rb -= out; } else { st.rb += x; st.ra -= out; } return out; };
const add = (st, a, b) => { const r = addShares(a, b, st.ra, st.rb, st.t); if (!r.s) return 0n; st.ra += r.takeA; st.rb += r.takeB; st.t += r.s; return r.s; };
const remove = (st, s) => { if (s <= 0n || s >= st.t) return; st.ra -= (s * st.ra) / st.t; st.rb -= (s * st.rb) / st.t; st.t -= s; };
// the zap as the chain runs it: the swap must pay at least its floor (a unit over the B leg), the add must mint at least minShares →
// minted with what comes back (always some), or null (reverted)
function run(st, p, fee = FEE) {
  const out = swap(st, p.swapIn / U, true, fee);
  if (!out || out < p.floor / U) return null;
  const minted = add(st, p.ethLeg / U, p.bLeg / U);
  return minted >= p.shares && out - p.bLeg / U >= 1n ? minted : { short: minted };
}
const pool = () => { const ra = between(10n ** 6n, 10n ** 11n), price = between(1n, 10n ** 6n), rb = ra * price / between(1n, 1000n) + 1000n, t = (BigInt(Math.floor(Math.sqrt(Number(ra) * Number(rb)))) * between(500n, 1000n)) / 1000n + 1001n; return { ra, rb, t }; };

// the live pools as read on 2026-10-25
const LIVE = { 'tETH/TAC': { ra: 352091440n, rb: 5158198427799n, t: 41755593789n }, 'tETH/cUSD': { ra: 140465504n, rb: 261567636242n, t: 6028128243n }, 'tETH/cBTC': { ra: 78939932n, rb: 1398178n, t: 10476485n } };
for (const [name, st0] of Object.entries(LIVE)) for (const eth of ['0.003', '0.05', '0.5', '2']) {
  const wei = BigInt(Math.round(Number(eth) * 1e8)) * U, p = zapPlan({ eth: wei, ra: st0.ra, rb: st0.rb, total: st0.t });
  const st = { ...st0 }, m = p && run(st, p);
  ok(p && m === p.shares && p.value <= wei && p.value % U === 0n && p.bLeg % U === 0n && p.spare >= U && p.floor === p.bLeg + U, `${name} ${eth} ETH mints exactly the ${p?.shares} shares it commits to (${typeof m === 'bigint' ? m : JSON.stringify(m)})`);
}

// random pools and amounts, nothing in between: exact
let plans = 0;
for (let i = 0; i < 4000; i++) {
  const st0 = pool(), eth = between(3n, st0.ra / 2n + 3n) * U, p = zapPlan({ eth, ra: st0.ra, rb: st0.rb, total: st0.t });
  if (!p) continue;
  plans++;
  const st = { ...st0 }, m = run(st, p);
  ok(m === p.shares, `random pool ${i}: mints exactly ${p.shares} (${typeof m === 'bigint' ? m : JSON.stringify(m)}; ${JSON.stringify({ ...st0, eth: String(eth) }, (k, v) => (typeof v === 'bigint' ? String(v) : v))})`);
}
ok(plans > 3000, `most random pools take a zap (${plans} of 4000)`);

// anything landing first: never more than the shares committed to, so with minShares it is those shares or a revert
let exact = 0, reverted = 0;
for (let i = 0; i < 12000; i++) {
  const st0 = pool(), eth = between(3n, st0.ra / 3n + 3n) * U, p = zapPlan({ eth, ra: st0.ra, rb: st0.rb, total: st0.t });
  if (!p) continue;
  const st = { ...st0 };
  for (let k = 0, ops = Number(between(1n, 3n)); k < ops; k++) {
    const kind = rnd() % 4n;
    if (kind === 0n) swap(st, between(1n, st.ra / 5n + 1n), true);
    else if (kind === 1n) swap(st, between(1n, st.rb / 5n + 1n), false);
    else if (kind === 2n) add(st, between(1n, st.ra / 4n + 1n), between(1n, st.rb / 4n + 1n));
    else remove(st, between(1n, st.t / 4n + 1n));
  }
  const before = { ...st }, out = swap(st, p.swapIn / U, true);
  const minted = out ? addShares(p.ethLeg / U, p.bLeg / U, st.ra, st.rb, st.t).s : 0n;
  ok(minted <= p.shares, `race ${i}: the add would mint ${minted}, over the ${p.shares} committed to (${JSON.stringify(before, (k, v) => (typeof v === 'bigint' ? String(v) : v))})`);
  const m = run({ ...before }, p);
  if (m === p.shares) exact++; else reverted++;
}
ok(exact > 0 && reverted > 0, `with something landing first a zap is exact or reverts (${exact} exact, ${reverted} reverted)`);

// a split swap: part through this pool, part through another venue that pays at least its floor (anything from there up). With nothing in
// between it mints exactly the shares committed to and some B comes back; with anything landing first on this pool, never more than them
{
  let splits = 0, exactS = 0, revS = 0;
  for (let i = 0; i < 6000; i++) {
    const st0 = pool(), eth = between(10n, st0.ra / 2n + 10n) * U, base = zapPlan({ eth, ra: st0.ra, rb: st0.rb, total: st0.t });
    if (!base || base.swapIn / U < 2n) continue;
    const x = base.swapIn / U, ammX = between(1n, x - 1n), extX = x - ammX;
    // the other venue: a pool of its own, near this one's price, paying out on its own curve
    const depth = between(st0.ra / 4n + 1n, st0.ra * 4n + 1n), ext = { ra: depth, rb: depth * st0.rb / st0.ra + 1n };
    const extOut = ammOut(ext.ra, ext.rb, extX, FEE) || 0n, extMin = (extOut * between(9500n, 10000n)) / 10000n;
    const p = zapSplitPlan({ eth, ra: st0.ra, rb: st0.rb, total: st0.t, ammIn: ammX * U, extIn: extX * U, extMin: extMin * U });
    if (!p) continue;
    splits++;
    const runSplit = (st, paid) => {
      const out = swap(st, ammX, true);
      if (!out || out + paid < p.floor / U) return null;
      const minted = add(st, p.ethLeg / U, p.bLeg / U);
      return minted >= p.shares && out + paid - p.bLeg / U >= 1n ? minted : { short: minted };
    };
    const quiet = runSplit({ ...st0 }, extMin + between(0n, extOut - extMin));
    ok(quiet === p.shares && p.value <= eth && p.spare >= U, `split ${i}: with nothing in between it mints exactly ${p.shares} (${typeof quiet === 'bigint' ? quiet : JSON.stringify(quiet)})`);
    const st = { ...st0 };
    for (let k = 0, ops = Number(between(1n, 3n)); k < ops; k++) {
      const kind = rnd() % 4n;
      if (kind === 0n) swap(st, between(1n, st.ra / 5n + 1n), true);
      else if (kind === 1n) swap(st, between(1n, st.rb / 5n + 1n), false);
      else if (kind === 2n) add(st, between(1n, st.ra / 4n + 1n), between(1n, st.rb / 4n + 1n));
      else remove(st, between(1n, st.t / 4n + 1n));
    }
    const before = { ...st }, o = swap(st, ammX, true), minted = o ? addShares(p.ethLeg / U, p.bLeg / U, st.ra, st.rb, st.t).s : 0n;
    ok(minted <= p.shares, `split race ${i}: the add would mint ${minted}, over the ${p.shares} committed to`);
    const m = runSplit({ ...before }, extMin);
    if (m === p.shares) exactS++; else revS++;
  }
  ok(splits > 3000 && revS > 0, `split zaps are exact, or revert with something landing first (${splits} splits, ${exactS} exact, ${revS} reverted)`);
  // splitting the swap with a venue about as deep keeps more of a 1 ETH deposit than swapping all of it in the pool, and sends about all of it
  const L = LIVE['tETH/TAC'], eth = 10n ** 18n, inPool = zapPlan({ eth, ra: L.ra, rb: L.rb, total: L.t }), ext = { ra: L.ra * 11n / 10n, rb: L.rb * 11n / 10n };
  const quote = async (X) => {          // the division of X between the two that pays the most B
    let top = null;
    for (let f = 1n; f < 40n; f++) {
      const ammX = (X / U) * f / 40n, extX = X / U - ammX, o = ammOut(L.ra, L.rb, ammX, FEE) + ammOut(ext.ra, ext.rb, extX, FEE);
      if (!top || o > top.o) top = { o, ammIn: ammX * U, extIn: extX * U, extOut: ammOut(ext.ra, ext.rb, extX, FEE) * U };
    }
    return top;
  };
  const best = await zapSplitSearch({ eth, ra: L.ra, rb: L.rb, total: L.t, x0: inPool.swapIn, quote }), wIn = zapWorth({ ra: L.ra, rb: L.rb, total: L.t }, inPool);
  ok(best && best.worth.perSent > wIn.perSent + 0.015 && best.plan.value * 1000n >= eth * 995n, `a 1 ETH zap into tETH/TAC split with a venue as deep keeps ${best ? (best.worth.perSent * 100).toFixed(2) : '—'}% of what it sends, against ${(wIn.perSent * 100).toFixed(2)}% all in the pool`);

  // what the search takes, whatever the quotes: a plan that sends at least 99.5% of the ETH and sends back no more than 1% of it as TAC
  // beyond the slippage room, or none (the zap then swaps all in the pool). A quote that fails, and a venue cheaper and much deeper than
  // the pool (whose extra TAC would look like gain at the pool's price), must not make it buy TAC only to send it back
  const fits = (b) => !b || (Number(b.plan.left) <= Number(eth) * 0.005 && b.plan.backA <= Number(eth) * 0.01);
  let n3 = 0;
  const flaky = async (X) => (++n3 === 3 ? null : quote(X));
  const b1 = await zapSplitSearch({ eth, ra: L.ra, rb: L.rb, total: L.t, x0: inPool.swapIn, quote: flaky });
  ok(fits(b1), `with a quote that fails, the search takes a plan that sends about all of it and little back, or none (${b1 ? `${b1.plan.backA / 1e18} ETH of TAC back` : 'none'})`);
  const cheap = { ra: L.ra * 20n, rb: (L.rb * 20n * 105n) / 100n };
  const quoteCheap = async (X) => {
    let top = null;
    for (let f = 1n; f < 40n; f++) {
      const ammX = (X / U) * f / 40n, extX = X / U - ammX, o = ammOut(L.ra, L.rb, ammX, FEE) + ammOut(cheap.ra, cheap.rb, extX, FEE);
      if (!top || o > top.o) top = { o, ammIn: ammX * U, extIn: extX * U, extOut: ammOut(cheap.ra, cheap.rb, extX, FEE) * U };
    }
    return top;
  };
  const b2 = await zapSplitSearch({ eth, ra: L.ra, rb: L.rb, total: L.t, x0: inPool.swapIn, quote: quoteCheap });
  ok(b2 && fits(b2), `with a venue 5% cheaper and twenty times as deep, the search takes the balanced split, not one that buys TAC to send back (${b2 ? `${(b2.plan.backA / 1e18).toFixed(5)} ETH of TAC back, ${(Number(b2.plan.left) / 1e18).toFixed(5)} ETH left` : 'none'})`);
}

// a share count fixed first (zapPlanFor), so the note's proof can be made before the zap is sent: at any reserves, supply and fee its legs
// mint exactly those shares by the pool's arithmetic, the swap pays at least its floor, no zap for them under zapPlan's rules sends a unit
// less, it never sends more than zapPlan does for the shares zapPlan finds, and anything landing first leaves it exact or reverted
{
  // the least zap for S whose swap is x units, by zapPlan's rules as written: legs that each floor to S at the reserves the swap leaves, the
  // B leg a unit under what the swap pays → the units it sends, or 0n when no legs fit
  const sendsAt = (st, S, x, fee) => {
    const out = ammOut(st.ra, st.rb, x, fee);
    if (out < 2n) return 0n;
    const ra2 = st.ra + x, rb2 = st.rb - out, a = (S * ra2 + st.t - 1n) / st.t, b = (S * rb2 + st.t - 1n) / st.t;
    return (a * st.t) / ra2 === S && (b * st.t) / rb2 === S && b <= out - 1n ? x + a : 0n;
  };
  const show = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v));
  // the plan as sent: exactly S, the swap over its floor, legs and value in whole units, and no smaller swap that fits (`all`: every one
  // from the first, else the 600 under it)
  const check = (st0, S, fee, p, label, all = false) => {
    const m = run({ ...st0 }, p, fee), x = p.swapIn / U, V = p.value / U;
    ok(m === S && p.shares === S && p.out >= p.floor && p.floor === p.bLeg + U && p.spare >= U && p.value === p.swapIn + p.ethLeg && p.value % U === 0n && p.bLeg % U === 0n && p.out % U === 0n,
      `${label}: zapPlanFor mints exactly ${S} (${typeof m === 'bigint' ? m : show(m)}), its swap paying ${p.out / U} over the floor ${p.floor / U} (${show({ ...st0, fee })})`);
    let cheaper = null;
    for (let x2 = all || x <= 600n ? 1n : x - 600n; x2 < x && !cheaper; x2++) { const v = sendsAt(st0, S, x2, fee); if (v && v < V) cheaper = { x2, v }; }
    ok(!cheaper && sendsAt(st0, S, x, fee) === V, `${label}: no zap for ${S} sends less than ${V} units (${cheaper ? `a swap of ${cheaper.x2} sends ${cheaper.v}` : ''}; ${show({ ...st0, fee })})`);
  };
  const fees = [1n, 5n, 30n, 100n, 300n, 1000n];
  // small pools, every smaller swap tried; and within maxEth, a null is right (no swap that fits sends that little)
  const small = () => { const ra = between(500n, 20000n), rb = (ra * between(1n, 4000n)) / between(1n, 400n) + 300n, t = (BigInt(Math.floor(Math.sqrt(Number(ra) * Number(rb)))) * between(500n, 1000n)) / 1000n + 50n; return { ra, rb, t }; };
  let smallPlans = 0, smallNull = 0;
  for (let i = 0; i < 500; i++) {
    const st0 = small(), fee = fees[Number(rnd() % 6n)], S = between(1n, st0.t / between(1n, 40n) + 1n), cap = between(2n, st0.ra) * U;
    const p = zapPlanFor({ shares: S, ra: st0.ra, rb: st0.rb, total: st0.t, feeBps: fee, maxEth: cap });
    if (p) { smallPlans++; check(st0, S, fee, p, `small pool ${i}`, true); ok(p.value <= cap && p.left === cap - p.value, `small pool ${i}: within maxEth, and left is what it does not send`); continue; }
    smallNull++;
    let fits = null;
    for (let x = 1n; !fits && x + (S * (st0.ra + x)) / st0.t <= cap / U; x++) if (sendsAt(st0, S, x, fee) && sendsAt(st0, S, x, fee) * U <= cap) fits = x;
    ok(!fits, `small pool ${i}: no zap for ${S} within ${cap / U} units, yet a swap of ${fits} fits (${show({ ...st0, fee })})`);
  }
  ok(smallPlans > 200 && smallNull > 20, `small pools: ${smallPlans} planned, ${smallNull} with no exact zap within maxEth`);

  // random pools (half with tETH the larger side, so the B leg is the coarse one) and fees: for the shares zapPlan finds, never more ETH
  // than zapPlan sends; for any other count, exact or none
  const either = (i) => { const p = pool(); return i % 2 ? p : { ra: p.rb, rb: p.ra, t: p.t }; };
  let same = 0, less = 0, anyPlans = 0, anyNull = 0;
  for (let i = 0; i < 3000; i++) {
    const st0 = either(i), fee = fees[Number(rnd() % 6n)], eth = between(3n, st0.ra / 2n + 3n) * U, z = zapPlan({ eth, ra: st0.ra, rb: st0.rb, total: st0.t, feeBps: fee });
    if (z) {
      const p = zapPlanFor({ shares: z.shares, ra: st0.ra, rb: st0.rb, total: st0.t, feeBps: fee, maxEth: eth });
      ok(p && p.value <= z.value && p.left === eth - p.value, `random pool ${i}: zapPlanFor(${z.shares}) sends ${p?.value} wei, over zapPlan's ${z.value}`);
      if (p) { check(st0, z.shares, fee, p, `random pool ${i}`); if (p.value === z.value) same++; else less++; }
    }
    const S = between(1n, 10n ** between(1n, BigInt(String(st0.t).length)));
    const q = zapPlanFor({ shares: S, ra: st0.ra, rb: st0.rb, total: st0.t, feeBps: fee });
    if (q) { anyPlans++; check(st0, S, fee, q, `random pool ${i}, ${S} shares`); } else anyNull++;
  }
  ok(same + less > 2500, `zapPlanFor(zapPlan's shares) never sends more than zapPlan (${same} the same, ${less} less)`);
  ok(anyPlans > 1500, `any share count: ${anyPlans} exact, ${anyNull} with no exact zap`);

  // the use: S planned at one moment, the pool moved by trades, adds and removes, S planned again at the new reserves: exactly S; and a
  // swap landing first after that leaves it exact or reverted
  let moved = 0, movedNull = 0, mExact = 0, mRev = 0;
  for (let i = 0; i < 3000; i++) {
    const st0 = either(i), fee = fees[Number(rnd() % 6n)], eth = between(3n, st0.ra / 3n + 3n) * U, z = zapPlan({ eth, ra: st0.ra, rb: st0.rb, total: st0.t, feeBps: fee });
    if (!z) continue;
    const st = { ...st0 };
    for (let k = 0, ops = Number(between(1n, 3n)); k < ops; k++) {
      const kind = rnd() % 4n;
      if (kind === 0n) swap(st, between(1n, st.ra / 5n + 1n), true, fee);
      else if (kind === 1n) swap(st, between(1n, st.rb / 5n + 1n), false, fee);
      else if (kind === 2n) add(st, between(1n, st.ra / 4n + 1n), between(1n, st.rb / 4n + 1n));
      else remove(st, between(1n, st.t / 4n + 1n));
    }
    const p = zapPlanFor({ shares: z.shares, ra: st.ra, rb: st.rb, total: st.t, feeBps: fee });
    if (!p) { movedNull++; continue; }
    moved++;
    check(st, z.shares, fee, p, `moved pool ${i}`);
    const race = { ...st };
    if (rnd() % 2n) swap(race, between(1n, race.ra / 5n + 1n), true, fee); else swap(race, between(1n, race.rb / 5n + 1n), false, fee);
    const before = { ...race }, o = swap(race, p.swapIn / U, true, fee), minted = o ? addShares(p.ethLeg / U, p.bLeg / U, race.ra, race.rb, race.t).s : 0n;
    ok(minted <= z.shares, `moved pool ${i}: with a swap landing first the add would mint ${minted}, over ${z.shares}`);
    if (run(before, p, fee) === z.shares) mExact++; else mRev++;
  }
  ok(moved > 2000 && mRev > 0, `S planned again after the pool moves: ${moved} exact, ${movedNull} with no exact zap; a swap landing first then: ${mExact} exact, ${mRev} reverted`);

  // the live pools: the shares 0.05 ETH buys, planned again with the other coin 3% dearer or cheaper, take more or less ETH and are exact
  for (const [name, st0] of Object.entries(LIVE)) {
    const z = zapPlan({ eth: 5n * 10n ** 16n, ra: st0.ra, rb: st0.rb, total: st0.t }), up = { ...st0 }, down = { ...st0 };
    swap(up, (st0.ra * 15n) / 1000n, true); swap(down, (st0.rb * 15n) / 1000n, false);
    const pu = zapPlanFor({ shares: z.shares, ra: up.ra, rb: up.rb, total: up.t }), pd = zapPlanFor({ shares: z.shares, ra: down.ra, rb: down.rb, total: down.t });
    ok(pu && pd && run({ ...up }, pu) === z.shares && run({ ...down }, pd) === z.shares && pu.value > z.value && pd.value < z.value,
      `${name}: ${z.shares} shares for 0.05 ETH, planned again with the other coin 3% dearer sends ${pu && (Number(pu.value) / 1e18).toFixed(6)} ETH, 3% cheaper ${pd && (Number(pd.value) / 1e18).toFixed(6)}`);
  }
  // fewer shares than a unit of the smaller side is worth: in tETH/cBTC (cBTC the smaller side, its reserve only falling with the swap) no
  // zap mints them; in tETH/TAC (tETH the smaller side) only one that swaps far more ETH than they are worth, which maxEth refuses
  const C = LIVE['tETH/cBTC'], T = LIVE['tETH/TAC'];
  ok([1n, 2n, 6n].every((S) => !zapPlanFor({ shares: S, ra: C.ra, rb: C.rb, total: C.t })) && !!zapPlanFor({ shares: 7n, ra: C.ra, rb: C.rb, total: C.t }),
    'tETH/cBTC: no zap mints under 7 shares (a unit of cBTC is worth about 7.5)');
  ok(!zapPlanFor({ shares: 1n, ra: T.ra, rb: T.rb, total: T.t, maxEth: 10n ** 18n }) && zapPlanFor({ shares: 1n, ra: T.ra, rb: T.rb, total: T.t }).value > 10n ** 20n,
    'tETH/TAC: one share takes over 100 ETH (a unit of tETH is worth about 118), so a 1 ETH cap has no zap for it');
}

// the calldata: the zap's selector, the legs, the shares as minShares, the swap's floor a unit over the B leg, the router paid the swap;
// a plan for a share count fixed first goes in unchanged
{
  const L = LIVE['tETH/TAC'], z = zapPlan({ eth: 5n * 10n ** 16n, ra: L.ra, rb: L.rb, total: L.t });
  for (const p of [z, zapPlanFor({ shares: z.shares, ra: L.ra + 10n ** 6n, rb: L.rb, total: L.t })]) {
    const router = '0x000000005dA3E3B73726af3c774Deeb9472D4992', amm = '0x00000000E36C7EC997CC59DCda9E03673B448119', tac = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
    const cd = zapCalldata({ plan: p, router, amm, tokenB: tac, assetA: '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', assetB: '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', deadline: 2n ** 40n, commit: '0x' + 'ab'.repeat(32) });
    const w = (i) => BigInt('0x' + cd.slice(10 + i * 64, 10 + (i + 1) * 64));
    const floorWord = p.floor.toString(16).padStart(64, '0'), swapAt = cd.indexOf('cfdf9dcc');
    ok(cd.startsWith('0xf9d1fa01') && w(2) === p.ethLeg && w(3) === p.bLeg && w(4) === p.shares && w(7) === 256n && cd.includes('5f3bd1c8') && swapAt > 0 && cd.slice(swapAt + 8 + 3 * 64, swapAt + 8 + 4 * 64) === p.swapIn.toString(16).padStart(64, '0') && cd.slice(swapAt + 8 + 4 * 64, swapAt + 8 + 5 * 64) === floorWord && cd.toLowerCase().includes(amm.slice(2).toLowerCase()),
      `the calldata carries the legs, the shares as minShares, and the swap through the pool with its floor a unit over the B leg (${p === z ? 'zapPlan' : 'zapPlanFor'})`);
  }
}
// the one-transaction zap (an LP voucher sent): ConfidentialRouter.zapETHIntoFarm with the share note's proof, byte for byte as cast encodes
// it, its swap leg the same bytes zapETHIntoShieldedLP carries
{
  const { readFileSync } = await import('node:fs');
  const fx = JSON.parse(readFileSync(new URL('./fixtures/lp-zap/zap-settle-calldata.json', import.meta.url), 'utf8')), a = fx.args;
  const plan = Object.fromEntries(Object.entries(a.plan).map(([k, v]) => [k, BigInt(v)]));
  const got = zapSettleCalldata({ ...a, plan, deadline: BigInt(a.deadline) }), plain = zapCalldata({ ...a, plan, deadline: BigInt(a.deadline) });
  ok(got === fx.calldata && got.startsWith('0xc4294fac'), 'zapSettleCalldata is zapETHIntoFarm as cast encodes it');
  ok(got.includes(plain.slice(10 + 9 * 64)), 'and its swap leg is the plain zap\'s');
}

// founding a tETH pool for a token: legs cut to whole pool units, the ETH leg at the quoted rate, shares = isqrt less the 1000 locked
{
  const isq = (v) => { let x = v, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + v / x) / 2n; } return x; };
  const E10 = 10n ** 10n, swapIn = 5n * 10n ** 16n;
  const p8 = foundingPlan({ swapIn, amountOut: 1234567890123n, amountLimit: 1222222222222n, unitB: 1n });
  ok(p8 && p8.bLeg === 1222222222222n && p8.ethLeg % E10 === 0n && p8.ethLeg <= swapIn && p8.value === swapIn + p8.ethLeg, 'an 8-decimal token (scale 1): the token leg is the least the swap brings, the ETH leg whole pool units');
  ok(p8.shares === isq((p8.ethLeg / E10) * p8.bLeg) - 1000n && p8.total === p8.shares + 1000n, 'its shares are isqrt(vA·vB) less the 1000 the founding add locks');
  const r8 = Number(p8.bLeg) / Number(p8.ethLeg), q8 = 1234567890123 / Number(swapIn);
  ok(Math.abs(r8 / q8 - 1) < 0.0001, 'and the two legs stand at the quoted rate');
  const p18 = foundingPlan({ swapIn, amountOut: 123456789123456789123n, amountLimit: 122222222222222222222n, unitB: E10 });
  ok(p18 && p18.bLeg % E10 === 0n && p18.bLeg <= 122222222222222222222n, 'an 18-decimal token (scale 1e10): its leg is cut to whole pool units');
  ok(foundingPlan({ swapIn: 2n * E10, amountOut: 100n, amountLimit: 99n, unitB: 1n }) === null, 'too small a pool (its shares not over the 1000 locked) is refused');
  ok(foundingPlan({ swapIn, amountOut: 2n ** 70n, amountLimit: 2n ** 70n, unitB: 1n }) === null, 'a leg beyond a u64 of pool units is refused');
  ok(foundingPlan({ swapIn, amountOut: 100n, amountLimit: 200n, unitB: 1n }) === null && foundingPlan({ swapIn: 0n, amountOut: 1n, amountLimit: 1n, unitB: 1n }) === null, 'a quote that makes no sense is refused');
}

console.log(`${n} checks`);
