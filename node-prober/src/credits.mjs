// Points for operators, switched off. The feed is what the points service reads when a nodes campaign is configured (POINTS_ENABLED=1 here and
// the schedule, pocket and feed URL there); with it off the feed says so and carries nothing, and nothing in the proof-mining or ceremony pots changes.
// One credit per paying address per finished day, ids `pn:day:<day>:<address>`, from the published scores only.
import { board, dayOf } from './score.mjs';

export const CAPS = { operatorShare: 0.05 };   // one operator's share of a day's points, at most

export function credits({ endpoints, day, now, enabled }) {
  if (!enabled) return { enabled: false, day, credits: [] };
  if (day >= dayOf(now)) return { enabled: true, day, done: false, credits: [] };
  const eps = endpoints.filter((e) => !e.baseline);
  // the day's figures, as of the day's end
  const b = board(eps, (day + 1) * 86400 + 3600);
  const pay = new Map(eps.map((e) => [e.operator, e.payTo]));
  const rows = b.operators.filter((o) => pay.get(o.operator) && o.score > 0).map((o) => ({ address: pay.get(o.operator).toLowerCase(), points: o.score }));
  const merged = new Map();
  for (const r of rows) merged.set(r.address, (merged.get(r.address) || 0) + r.points);
  let total = [...merged.values()].reduce((a, x) => a + x, 0);
  // the cap needs more than one payee to mean anything: with fewer than 1/cap payees the share is the whole pot's and nothing is cut
  const cut = merged.size * CAPS.operatorShare >= 1 ? total * CAPS.operatorShare : Infinity;
  const out = [...merged].map(([address, p]) => ({ id: `pn:day:${day}:${address}`, address, points: Math.round(Math.min(p, cut) * 1000) / 1000 }));
  total = out.reduce((a, x) => a + x.points, 0);
  return { enabled: true, day, done: true, total, credits: out };
}
