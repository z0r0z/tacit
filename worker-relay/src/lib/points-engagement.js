// What a UTC day's points count for, beyond what each activity scored: a weight per kind of activity, and a multiplier
// for an address that has been active across kinds and on more than one day this week. Both read only public activity
// and apply from a given UTC day forward, so a settled day is never re-priced.
//
// Weights: "20730:cbtcmint=3,cusdmint=2;20760:off" — from each day, those activities count that many times over; a
// later entry replaces an earlier one, and "off" ends them.
// Address caps: "20741:evmpooldeposit=5;20800:off" — from each day, the ETH of that activity an address can count in one UTC day
// (all chains together); points for ETH past it count for nothing that day (they stay in the address's all-time total). A
// later entry replaces an earlier one, and "off" ends them. It limits repeating one deposit many times a day, not how much
// an address can hold, and reads only public deposits.
// Share caps: "20741:evmpooldeposit=0.5;20800:off" — from each day, that activity's points together can be at most that share of
// the day's budget, whoever earns them (the budget is what the pot is before the per-point ceiling trims what is paid, so on a
// day when few others hold points the activity is paid most of what is paid): when more would be counted, every address's points
// for it are scaled by the same factor,
// so the rest of the day is split as it would have been and the capped activity cannot take more than its share however much
// of it there is. Where the TAC-per-point ceiling is in force that is a budget of points (share x the day's budget / the
// ceiling); without one, a share of the day's points. Nothing is limited per address or per deposit, so doing more of it
// still earns more of its share.
// Engagement: "20730:0.25,0.25,2,25;20760:off" — from each day, an address's counted points are multiplied by
// 1 + kindStep for each other kind of activity it has had in the past 7 days (up to maxKinds of them) + returnStep when
// it was active on more than one of those days. A kind counts once it has earned minPoints in the week, and a day counts
// as active once the address has earned minPoints on it; points are counted at their weight, so an activity weighted 0
// is neither a kind nor a day.

// The kinds of activity: where the program is used, not which contract. An activity that is not listed is its own kind.
export const KIND_OF = {
  wrap: 'private', evmpooldeposit: 'private', btcpool: 'private', holding: 'private',
  zswapeth: 'swap',
  cbtcmint: 'borrow', cbtchold: 'borrow', cusdmint: 'borrow',
  weiname: 'names',
  pmbet: 'markets', pmcreate: 'markets',
};
export const kindOf = (activity) => KIND_OF[activity] ?? activity;
export const WEEK_DAYS = 7;

const entries = (raw) => String(raw || '').split(';').map((s) => s.trim()).filter(Boolean);
const bySchedule = (list) => list.sort((a, b) => a.fromDay - b.fromDay);

export function parseCategoryWeights(raw, log = () => {}) {
  const out = [];
  for (const part of entries(raw)) {
    try {
      const m = part.match(/^(\d+):(.+)$/);
      if (!m) throw new Error('expected <day>:<activity>=<weight>,… or <day>:off');
      const weights = {};
      if (m[2].trim().toLowerCase() !== 'off') {
        for (const kv of m[2].split(',').map((s) => s.trim()).filter(Boolean)) {
          const [act, w] = kv.split('=').map((s) => s.trim());
          const weight = Number(w);
          if (!/^[a-z0-9_]+$/.test(act || '') || !(weight >= 0) || weight > 20 || !Number.isFinite(weight)) throw new Error(`"${kv}" is not <activity>=<weight from 0 to 20>`);
          weights[act] = weight;
        }
      }
      out.push({ fromDay: Number(m[1]), weights });
    } catch (err) {
      log(`ignoring POINTS_CATEGORY_WEIGHTS entry "${part}": ${err.message}`);
    }
  }
  return bySchedule(out);
}

// The weight of each activity on `day` ({} when none applies); of two entries for one day the later one listed wins.
export function categoryWeightsForDay(schedule, day) {
  let weights = {};
  for (const e of schedule) if (e.fromDay <= day) weights = e.weights;
  return weights;
}

const ETH_WEI = 10n ** 18n;
export function parseAddressDayCaps(raw, log = () => {}) {
  const out = [];
  for (const part of entries(raw)) {
    try {
      const m = part.match(/^(\d+):(.+)$/);
      if (!m) throw new Error('expected <day>:<activity>=<ETH>,… or <day>:off');
      const caps = {};
      if (m[2].trim().toLowerCase() !== 'off') {
        for (const kv of m[2].split(',').map((x) => x.trim()).filter(Boolean)) {
          const [act, v] = kv.split('=').map((x) => x.trim());
          const n = String(v).match(/^(\d+)(?:\.(\d{1,18}))?$/);
          if (!/^[a-z0-9_]+$/.test(act || '') || !n) throw new Error(`"${kv}" is not <activity>=<ETH amount>`);
          const wei = BigInt(n[1]) * ETH_WEI + BigInt((n[2] ?? '').padEnd(18, '0') || '0');
          if (wei <= 0n) throw new Error(`"${kv}": a limit of nothing is a weight of 0 (POINTS_CATEGORY_WEIGHTS)`);
          caps[act] = wei;
        }
      }
      out.push({ fromDay: Number(m[1]), caps });
    } catch (err) {
      log(`ignoring POINTS_ADDRESS_DAY_CAPS entry "${part}": ${err.message}`);
    }
  }
  return bySchedule(out);
}

// The ETH limit of each capped activity on `day` ({ activity: wei }, {} when none applies).
export function addressDayCapsForDay(schedule, day) {
  let caps = {};
  for (const e of schedule) if (e.fromDay <= day) caps = e.caps;
  return caps;
}

// What share of an address's day of `activity` counts: all of it up to the limit, then the limit's share of it.
export const capFactor = (totalWei, limitWei) => (limitWei == null || totalWei <= limitWei ? 1 : Number((limitWei * 1_000_000n) / totalWei) / 1e6);

// The activities whose ETH an address counts only net of what the pool paid that address the same UTC day ("20782:evmpooldeposit"):
// ETH that comes out of the pool and goes back in is not new ETH put in, and the pool's own payout events name who it paid.
// An address that deposits 6 ETH and is paid 6 ETH back counts 0; one paid nothing counts what it deposited.
export function parseNetOfPayouts(raw, log = () => {}) {
  const out = [];
  for (const part of entries(raw)) {
    try {
      const m = part.match(/^(\d+):(.+)$/);
      if (!m) throw new Error('expected <day>:<activity>,… or <day>:off');
      const acts = new Set();
      if (m[2].trim().toLowerCase() !== 'off') {
        for (const a of m[2].split(',').map((x) => x.trim()).filter(Boolean)) {
          if (!/^[a-z0-9_]+$/.test(a)) throw new Error(`"${a}" is not an activity name`);
          acts.add(a);
        }
      }
      out.push({ fromDay: Number(m[1]), acts });
    } catch (err) {
      log(`ignoring POINTS_NET_OF_PAYOUTS entry "${part}": ${err.message}`);
    }
  }
  return bySchedule(out);
}

// The activities counted net of payouts on `day` (a Set, empty when none).
export function netOfPayoutsForDay(schedule, day) {
  let acts = new Set();
  for (const e of schedule) if (e.fromDay <= day) acts = e.acts;
  return acts;
}

// What share of an address's day of `activity` counts: no more than the ETH it put in net of what the pool paid it, and no more than its limit.
export function countedShare(totalWei, { limitWei = null, paidWei = null } = {}) {
  if (totalWei <= 0n) return 1;
  let allowed = totalWei;
  if (paidWei != null) allowed = totalWei > paidWei ? totalWei - paidWei : 0n;
  if (limitWei != null && limitWei < allowed) allowed = limitWei;
  return allowed >= totalWei ? 1 : Number((allowed * 1_000_000n) / totalWei) / 1e6;
}

export function parseCategoryShareCaps(raw, log = () => {}) {
  const out = [];
  for (const part of entries(raw)) {
    try {
      const m = part.match(/^(\d+):(.+)$/);
      if (!m) throw new Error('expected <day>:<activity>=<share>,… or <day>:off');
      const caps = {};
      if (m[2].trim().toLowerCase() !== 'off') {
        const kvs = m[2].split(',').map((x) => x.trim()).filter(Boolean);
        if (kvs.length > 1) throw new Error('one activity at a time: each share would be sized from the other\'s points before it is limited');
        for (const kv of kvs) {
          const [act, v] = kv.split('=').map((x) => x.trim());
          const share = Number(v);
          if (!/^[a-z0-9_]+$/.test(act || '') || !(share > 0 && share < 1)) throw new Error(`"${kv}" is not <activity>=<a share above 0 and below 1>`);
          caps[act] = share;
        }
      }
      out.push({ fromDay: Number(m[1]), caps });
    } catch (err) {
      log(`ignoring POINTS_CATEGORY_SHARE_CAPS entry "${part}": ${err.message}`);
    }
  }
  return bySchedule(out);
}

// The largest share of a day each capped activity can take ({ activity: share }, {} when none applies).
export function categoryShareCapsForDay(schedule, day) {
  let caps = {};
  for (const e of schedule) if (e.fromDay <= day) caps = e.caps;
  return caps;
}

export function parseEngagementSchedule(raw, log = () => {}) {
  const out = [];
  for (const part of entries(raw)) {
    try {
      const m = part.match(/^(\d+):(.+)$/);
      if (!m) throw new Error('expected <day>:<kindStep>,<returnStep>,<maxKinds>,<minPoints> or <day>:off');
      if (m[2].trim().toLowerCase() === 'off') { out.push({ fromDay: Number(m[1]), spec: null }); continue; }
      const [kindStep, returnStep, maxKinds, minPoints] = m[2].split(',').map((s) => Number(s.trim()));
      if (![kindStep, returnStep].every((x) => Number.isFinite(x) && x >= 0 && x <= 2)) throw new Error('steps must be between 0 and 2');
      if (!Number.isInteger(maxKinds) || maxKinds < 0 || maxKinds > 8) throw new Error('maxKinds must be a whole number up to 8');
      if (!(minPoints >= 0) || !Number.isFinite(minPoints)) throw new Error('minPoints must be 0 or more');
      out.push({ fromDay: Number(m[1]), spec: { kindStep, returnStep, maxKinds, minPoints } });
    } catch (err) {
      log(`ignoring POINTS_ENGAGEMENT entry "${part}": ${err.message}`);
    }
  }
  return bySchedule(out);
}

export function engagementForDay(schedule, day) {
  let spec = null;
  for (const e of schedule) if (e.fromDay <= day) spec = e.spec;
  return spec;
}

// The multiplier for an address with `kinds` kinds of activity and `activeDays` active days this week.
export function engagementFactor(spec, { kinds, activeDays }) {
  if (!spec) return 1;
  const extra = Math.min(Math.max(kinds - 1, 0), spec.maxKinds);
  return Math.round((1 + spec.kindStep * extra + (activeDays >= 2 ? spec.returnStep : 0)) * 1e6) / 1e6;
}

// A day's counted rows, [{ address, dayPoints, rawPoints, factor, kinds, activeDays }].
// dayRows: [{ address, activity, points, capFactor? }] for the day (capFactor: the share of the points that counts); weekRows: [{ address, day, activity, points }] for the 7 days
// ending with it. dayPoints is the points the day's pot is split by: each activity's points times its weight, summed,
// times the address's multiplier. rawPoints is what the activities scored.
export function countedRows({ dayRows, weekRows = [], weights = {}, spec = null, shareCaps = {}, pointCaps = {}, withBy = false, groupOf = null }) {
  const byAddress = new Map();
  for (const r of [...dayRows].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : a.activity < b.activity ? -1 : a.activity > b.activity ? 1 : 0))) {
    const e = byAddress.get(r.address) ?? { counted: 0, raw: 0, by: {} };
    const c = r.points * (r.capFactor ?? 1) * (weights[r.activity] ?? 1);
    e.counted += c;
    e.by[r.activity] = (e.by[r.activity] ?? 0) + c;
    e.raw += r.points;
    byAddress.set(r.address, e);
  }
  const week = new Map();
  if (spec) {
    for (const r of weekRows) {
      // Activity counts toward the week at its weight, so activity that counts for nothing is not activity for the week.
      const pts = r.points * (weights[r.activity] ?? 1);
      const w = week.get(r.address) ?? { kinds: new Map(), days: new Map() };
      w.days.set(r.day, (w.days.get(r.day) ?? 0) + pts);
      w.kinds.set(kindOf(r.activity), (w.kinds.get(kindOf(r.activity)) ?? 0) + pts);
      week.set(r.address, w);
    }
  }
  // Each address's multiplier first: a share is a share of what the day's pot is split by, which is counted points times it.
  const factors = new Map();
  for (const [address] of byAddress) {
    const w = week.get(address);
    const kinds = w ? [...w.kinds.values()].filter((p) => p >= spec.minPoints && p > 0).length : 0;
    const activeDays = w ? [...w.days.values()].filter((p) => p >= spec.minPoints && p > 0).length : 0;
    factors.set(address, { kinds, activeDays, factor: spec ? engagementFactor(spec, { kinds, activeDays }) : 1 });
  }
  // A capped activity's points together are scaled down to its share when they would be more; with nothing else counted
  // there is nothing to share with and they stand.
  const scale = new Map();
  for (const activity of Object.keys(shareCaps).sort()) {
    const share = shareCaps[activity];
    let cat = 0, rest = 0;
    // groupOf: where groups share the day (lib/points-budgets.js) a share cap is a share of the points in the capped activity's own group,
    // since the pay of another group's points is not the pay of this one's; with none, of everything else counted.
    const grp = groupOf ? groupOf(activity) : null;
    for (const [address, e] of byAddress) {
      const f = factors.get(address).factor, c = (e.by[activity] ?? 0) * (scale.get(address)?.[activity] ?? 1);
      let others = e.counted - (e.by[activity] ?? 0);
      if (grp !== null) { others = 0; for (const [a, p] of Object.entries(e.by)) if (a !== activity && groupOf(a) === grp) others += p; }
      cat += c * f; rest += others * f;
    }
    // What the activity may count: the larger of its share of the points (the cap when the others hold many) and, where the
    // TAC-per-point ceiling is in force, a budget of points (its share of the day's pot over the most a point can pay: the
    // cap when the others hold few, where the ceiling trims the pot and a share of points would pay it far less). The activity
    // then earns its share of the pot on a quiet day and on a busy one, and the others are split the rest.
    const byShare = rest > 0 ? (share / (1 - share)) * rest : 0, budget = pointCaps[activity] ?? 0, limit = Math.max(byShare, budget);
    const k = cat > 0 && limit > 0 ? Math.min(1, limit / cat) : 1;
    if (k < 1) for (const [address, e] of byAddress) { const sc = scale.get(address) ?? {}; sc[activity] = (sc[activity] ?? 1) * k; scale.set(address, sc); }
  }
  const out = [];
  for (const [address, e] of byAddress) {
    const { kinds, activeDays, factor } = factors.get(address);
    let counted = e.counted;
    const scaled = scale.get(address) ?? {};
    for (const [activity, k] of Object.entries(scaled)) counted -= (e.by[activity] ?? 0) * (1 - k);
    const row = { address, dayPoints: counted * factor, rawPoints: e.raw, factor, kinds, activeDays };
    // withBy: what each activity counts for after its weight, its share cap and the address's multiplier (these add up to dayPoints), for sharing a day by group.
    if (withBy) row.by = Object.fromEntries(Object.entries(e.by).map(([activity, p]) => [activity, p * (scaled[activity] ?? 1) * factor]));
    out.push(row);
  }
  return out;
}
