// The rows a UTC day's pot is split by. Settlement, the day so far, the board and an address's history by day all
// read a day through here, so what is shown is what settlement pays.
//
// Before any weight, multiplier or bond check applies to a day, its rows are exactly the store's sums by address, so
// days already settled re-split to the same figures. From the first of those days on, a day counts each activity at
// its weight, times the address's multiplier for the week (lib/points-engagement.js), with a released bond left out and an
// address's ETH of a capped activity counted only up to its limit for the day, and a share-capped activity's points together
// scaled down to its share of the day. Where groups share the day (lib/points-budgets.js) each row also carries its points by activity.
import { categoryWeightsForDay, engagementForDay, addressDayCapsForDay, categoryShareCapsForDay, netOfPayoutsForDay, countedShare, countedRows, WEEK_DAYS } from './points-engagement.js';
import { budgetsForDay } from './points-budgets.js';

// onTime: only the rows a settlement could have seen (not marked late), so a settled day's own split is reproduced.
// netOfPayoutsSchedule: the activities whose ETH counts only net of what the pool paid the address that day (lib/points-engagement.js).
export function makeCounted({ store, weightSchedule = [], engagementSchedule = [], addressDayCaps = [], shareCapSchedule = [], netOfPayoutsSchedule = [], budgetSchedule = [], potFor = null, bondHoldFromDay = 0, onTime = false }) {
  const opt = { onTime };
  return {
    // The groups the day's pot is shared by (lib/points-budgets.js), [] when none.
    groupsFor: (day) => budgetsForDay(budgetSchedule, day),
    // withGroups: carry each row's points by activity even where no group is in force (to say what a coming schedule would pay).
    rows(day, { withGroups = false } = {}) {
      const weights = categoryWeightsForDay(weightSchedule, day), spec = engagementForDay(engagementSchedule, day), caps = addressDayCapsForDay(addressDayCaps, day), shareCaps = categoryShareCapsForDay(shareCapSchedule, day);
      const start = day * 86400, end = start + 86400;
      const byActivity = withGroups || budgetsForDay(budgetSchedule, day).length > 0;
      const net = netOfPayoutsForDay(netOfPayoutsSchedule, day);
      if (!byActivity && !Object.keys(weights).length && !spec && !Object.keys(caps).length && !Object.keys(shareCaps).length && !net.size && !(bondHoldFromDay && day >= bondHoldFromDay)) {
        return store.dayPointsByAddress(start, end, opt).map((r) => ({ ...r, rawPoints: r.dayPoints, factor: 1, kinds: 0, activeDays: 0 }));
      }
      const dayRows = store.dayActivityPoints(start, end, opt);
      // An address's ETH of a limited activity counts up to its limit, and where the activity is counted net of payouts, only what it put in
      // beyond what the pool paid it that day.
      const paid = net.size ? store.dayPayoutsByAddress(start, end, opt) : null;
      for (const activity of new Set([...Object.keys(caps), ...net])) {
        const totals = store.dayAmountsByAddress(activity, start, end, opt);
        for (const r of dayRows) {
          if (r.activity !== activity) continue;
          r.capFactor = countedShare(totals.get(r.address) ?? 0n, { limitWei: caps[activity] ?? null, paidWei: net.has(activity) ? (paid.get(r.address) ?? 0n) : null });
        }
      }
      const weekRows = spec ? store.weekActivityPoints((day - WEEK_DAYS + 1) * 86400, end, opt) : [];
      // With the day's budget and ceiling known, a share of the pot is a number of points; otherwise it is a share of the points.
      const pointCaps = {}, pot = potFor && Object.keys(shareCaps).length ? potFor(day) : null;
      if (pot && pot.maxWeiPerPoint && pot.budgetWei > 0n) for (const [a, share] of Object.entries(shareCaps)) pointCaps[a] = (share * Number(pot.budgetWei)) / Number(pot.maxWeiPerPoint);
      const groups = budgetsForDay(budgetSchedule, day), where = new Map();
      groups.forEach((g) => g.activities.forEach((a) => where.set(a, g.name)));
      return countedRows({ dayRows, weekRows, weights, spec, shareCaps, pointCaps, withBy: byActivity, groupOf: groups.length ? (a) => where.get(a) ?? 'open' : null });
    },
  };
}
