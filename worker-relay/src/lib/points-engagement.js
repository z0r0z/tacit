// What a UTC day's points count for, beyond what each activity scored: a weight per kind of activity, and a multiplier
// for an address that has been active across kinds and on more than one day this week. Both read only public activity
// and apply from a given UTC day forward, so a settled day is never re-priced.
//
// Weights: "20730:cbtcmint=3,cusdmint=2;20760:off" — from each day, those activities count that many times over; a
// later entry replaces an earlier one, and "off" ends them.
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
// dayRows: [{ address, activity, points }] for the day; weekRows: [{ address, day, activity, points }] for the 7 days
// ending with it. dayPoints is the points the day's pot is split by: each activity's points times its weight, summed,
// times the address's multiplier. rawPoints is what the activities scored.
export function countedRows({ dayRows, weekRows = [], weights = {}, spec = null }) {
  const byAddress = new Map();
  for (const r of [...dayRows].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : a.activity < b.activity ? -1 : a.activity > b.activity ? 1 : 0))) {
    const e = byAddress.get(r.address) ?? { counted: 0, raw: 0 };
    e.counted += r.points * (weights[r.activity] ?? 1);
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
  const out = [];
  for (const [address, e] of byAddress) {
    const w = week.get(address);
    const kinds = w ? [...w.kinds.values()].filter((p) => p >= spec.minPoints && p > 0).length : 0;
    const activeDays = w ? [...w.days.values()].filter((p) => p >= spec.minPoints && p > 0).length : 0;
    const factor = engagementFactor(spec, { kinds, activeDays });
    out.push({ address, dayPoints: e.counted * factor, rawPoints: e.raw, factor, kinds, activeDays });
  }
  return out;
}
