// A UTC day's pot and how it splits. Settlement folds each finished day into the reward ledger with splitDayBudget; the
// day so far (/points, /leaderboard?day=today) and an address's history by day (/points/:address/days) are read through
// the same functions, so what is shown is what settlement pays.
import { POINTS_SCALE, applyRateCeiling } from './points-rate-cap.js';
import { allocateDay, groupResult } from './points-budgets.js';

// dayRows: [{ address, dayPoints }] (dayPoints: the points the day is split by). The pot is the day's budget, or less where the TAC-per-point ceiling binds.
// groups (lib/points-budgets.js): where groups share the day the pot is what they are paid together, and `groups` says what each was.
export function dayPot(dayRows, budgetWei, maxWeiPerPoint = null, groups = []) {
  if (groups.length) {
    const a = allocateDay({ rows: dayRows, budgetWei, maxWeiPerPoint, groups });
    return { totalPoints: a.totalPoints, pot: a.totalPoints > 0 ? a.pot : budgetWei, groups: a.groups.map(groupResult) };
  }
  const totalPoints = dayRows.reduce((s, r) => s + r.dayPoints, 0);
  // Before the day's first point nothing has been split, so the pot is its budget; the ceiling only trims a pot there are points to split.
  return { totalPoints, pot: totalPoints > 0 ? applyRateCeiling(budgetWei, BigInt(Math.round(totalPoints * POINTS_SCALE)), maxWeiPerPoint) : budgetWei };
}

// The day so far, ready to be looked up by address: the pot and total points, what the split pays each address, and each address's row. These are
// the figures dayPot and splitDayBudget give and a scan of `dayRows` finds, made once for every address that asks.
export function dayShares(dayRows, budgetWei, maxWeiPerPoint = null, groups = []) {
  const { totalPoints, pot } = dayPot(dayRows, budgetWei, maxWeiPerPoint, groups);
  const paid = splitDayBudget(dayRows, budgetWei, maxWeiPerPoint, groups);
  const byAddress = new Map();
  for (const r of dayRows) { const k = r.address.toLowerCase(); if (!byAddress.has(k)) byAddress.set(k, r); }
  return { totalPoints, pot, paid, row: (address) => byAddress.get(String(address).toLowerCase()) };
}

export function dayBoard(dayRows, { budgetWei, maxWeiPerPoint = null, limit = 100, groups = [] }) {
  const { totalPoints, pot, groups: shared } = dayPot(dayRows, budgetWei, maxWeiPerPoint, groups);
  const ranked = dayRows.filter((r) => r.dayPoints > 0).sort((a, b) => b.dayPoints - a.dayPoints || (a.address < b.address ? -1 : 1));
  // tacWei: what each address would be paid if the day ended now, through the sharing settlement uses.
  const paid = ranked.length ? splitDayBudget(dayRows, budgetWei, maxWeiPerPoint, groups) : new Map();
  return {
    totalPoints,
    dayBudgetWei: pot.toString(),
    taking: ranked.length,
    ...(shared ? { groups: shared } : {}),
    rows: ranked.slice(0, limit).map((r) => ({ address: r.address.toLowerCase(), points: r.dayPoints, tacWei: (paid.get(r.address) ?? 0n).toString() })),
  };
}

// Splits `budgetWei` pro-rata across `rows` ([{address, dayPoints}], dayPoints a JS float — a WEIGHT, never a
// wei amount). Scaling both sides of the ratio by the same factor before doing BigInt division means the
// float's imprecision only ever affects the last few bits of the ratio, never the wei-scale result, and never
// compounds across days (each day's split is independent). Integer division leaves a few wei of dust
// unallocated per day — negligible at TAC's scale and not worth the complexity of redistributing.
// groups (lib/points-budgets.js): where groups share the day, each group is paid its reserved share first, and rows must carry `by` (their points by activity).
export function splitDayBudget(rows, budgetWei, maxWeiPerPoint = null, groups = []) {
  if (groups.length) return allocateDay({ rows, budgetWei, maxWeiPerPoint, groups }).paid;
  const scaled = rows.map((r) => BigInt(Math.round(r.dayPoints * POINTS_SCALE)));
  const totalScaled = scaled.reduce((s, v) => s + v, 0n);
  const deltas = new Map();
  if (totalScaled <= 0n) return deltas;
  const pot = applyRateCeiling(budgetWei, totalScaled, maxWeiPerPoint);
  rows.forEach((r, i) => {
    const share = (pot * scaled[i]) / totalScaled;
    if (share > 0n) deltas.set(r.address, share);
  });
  return deltas;
}

// What each UTC day paid one address, newest first. `dayRowsFor(day)` is that day's [{ address, dayPoints }],
// `budgetFor(day)` its budget, `capFor(day)` its TAC-per-point ceiling, `groupsFor(day)` the groups that share it and `ledgerFor(address)` what the reward ledger
// holds for the address. A day through `lastSettledDay` is final, so its split is kept; the days after it are read afresh
// and marked unsettled.
//
// A settled day's TAC is only given where it can be shown to be what was paid: the days re-split to exactly the ledger's
// total. Activity credited to a day after it settled (or since excluded) moves a re-split, and the ledger, which is what
// is claimed, does not follow it; those days carry points only (`tacWei: null`) and the ledger's total says what was earned.
export function dayHistory({ dayRowsFor, budgetFor, capFor, ledgerFor, groupsFor = () => [] }) {
  const final = new Map();
  const split = (day, settled) => {
    if (settled && final.has(day)) return final.get(day);
    const rows = dayRowsFor(day), budget = budgetFor(day);
    const paid = budget > 0n ? splitDayBudget(rows, budget, capFor(day), groupsFor(day)) : new Map();
    const by = new Map(rows.map((r) => [r.address.toLowerCase(), { points: r.dayPoints, raw: r.rawPoints ?? r.dayPoints, factor: r.factor ?? 1, wei: paid.get(r.address) ?? 0n }]));
    if (settled) final.set(day, by);
    return by;
  };
  return (address, { fromDay, throughDay, lastSettledDay }) => {
    const a = address.toLowerCase(), days = [];
    let resplit = 0n;
    for (let day = fromDay; day <= throughDay; day++) {
      const settled = day <= lastSettledDay, e = split(day, settled).get(a);
      if (!e || !(e.points > 0)) continue;
      if (settled) resplit += e.wei;
      days.push({ day, points: e.points, raw: e.raw, factor: e.factor, wei: e.wei, settled });
    }
    const earnedWei = BigInt(ledgerFor(a) ?? 0), reconciled = resplit === earnedWei;
    return {
      earnedWei: earnedWei.toString(), reconciled,
      days: days.reverse().map((d) => ({ day: d.day, points: d.points, raw: d.raw, factor: d.factor, tacWei: d.settled && !reconciled ? null : d.wei.toString(), settled: d.settled })),
    };
  };
}
