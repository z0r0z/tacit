// Scoring: probe records in, a per-role score, a weight for the pages and a leaderboard out. A pure function of the records and the clock.
//
// An endpoint keeps, per UTC day and role, the counts agg[day][role] = { n, a, v, c, f, fn, h, ms }:
//   n probes, a answered, v with a verdict, c correct, fn heads judged for freshness, f of them fresh, h hard failures, ms total latency
// and a list of strike times. Points are not paid anywhere: `score` is what a day's points would be (POINTS_ENABLED in credits.mjs turns the rest on).
import { BASE, ROLES, KIND_OF, diversity } from '../../dapp/nodes-list.js';

export const DAY = 86400;
export const dayOf = (t) => Math.floor(t / DAY);
export const RULES = {
  shadowSecs: 24 * 3600,          // an endpoint accrues nothing and is not listed for its first day of probes
  rampDays: 14,                    // weight rises from the probation weight to full over this many clean days
  probation: 0.1,
  minUptime: 0.8,                  // below this a day scores nothing for the role
  minProbes: 6,                    // fewer probes than this in a day and the day does not count
  strikeLimit: 3, strikeWindow: 30 * DAY, cooldown: 7 * DAY,
  keepDays: 60,
  targets: { 'eth-reads': 6, 'eth-logs': 4, 'eth-proofs': 3, 'eth-archive': 3, 'btc-esplora': 6, 'btc-index': 3 },   // healthy nodes per role after which a new one earns less
};

export function addRecord(ep, rec, now) {
  const d = String(dayOf(rec.at ?? now)), role = rec.role;
  ep.agg ||= {}; ep.strikes ||= [];
  const a = ((ep.agg[d] ||= {})[role] ||= { n: 0, a: 0, v: 0, c: 0, f: 0, fn: 0, h: 0, ms: 0 });
  a.n++;
  if (rec.answered) { a.a++; a.ms += rec.ms || 0; }
  if (rec.answered && rec.ok != null) { a.v++; if (rec.ok) a.c++; }
  if (rec.fresh != null) { a.fn++; if (rec.fresh) a.f++; }
  if (rec.hard) { a.h++; ep.lastHard = rec.at ?? now; ep.strikes.push(rec.at ?? now); }
  if (rec.answered && !rec.hard && rec.ok !== false) ep.lastOk = rec.at ?? now;
  // old days go, so the state stays bounded
  const keep = dayOf(now) - RULES.keepDays;
  for (const k of Object.keys(ep.agg)) if (+k < keep) delete ep.agg[k];
  ep.strikes = ep.strikes.filter((t) => t > now - RULES.strikeWindow);
  return ep;
}

const sum = (ep, role, from, to) => {
  const t = { n: 0, a: 0, v: 0, c: 0, f: 0, fn: 0, h: 0, ms: 0 };
  for (const [d, roles] of Object.entries(ep.agg || {})) if (+d >= from && +d <= to && roles[role]) for (const k of Object.keys(t)) t[k] += roles[role][k];
  return t;
};

// one role over [from, to] days: the fractions that make a score
export function roleStats(ep, role, from, to = from) {
  const s = sum(ep, role, from, to);
  const uptime = s.n ? s.a / s.n : 0;
  const correct = s.v ? s.c / s.v : null;                        // null: nothing was judged
  const fresh = s.fn ? s.f / s.fn : null;
  return { ...s, uptime, correct, fresh, latency: s.a ? Math.round(s.ms / s.a) : null };
}
// what a day's points would be for one endpoint's role: BASE * uptime * correct^2 * freshness; nothing under the uptime floor, none with a hard fail, none unjudged
export function dayScore(ep, role, day, scarcity = 1) {
  const s = roleStats(ep, role, day);
  if (s.n < RULES.minProbes || s.uptime < RULES.minUptime || s.h > 0 || s.correct == null) return 0;
  const freshF = s.fresh == null ? 1 : 0.5 + 0.5 * s.fresh;
  return BASE[role] * s.uptime * s.correct ** 2 * freshF * scarcity;
}

// status of an endpoint now: shadow (first day), listed, delisted (strikes) -> and the weight the pages give it
export function standing(ep, now) {
  const age = now - (ep.firstSeen ?? now);
  const strikes = (ep.strikes || []).filter((t) => t > now - RULES.strikeWindow);
  if (strikes.length >= RULES.strikeLimit && now - Math.max(...strikes) < RULES.cooldown) return { state: 'removed', weight: 0, reliability: 0, cleanDays: 0, strikes: strikes.length };
  if (age < RULES.shadowSecs) return { state: 'shadow', weight: 0, reliability: 0, cleanDays: 0, strikes: strikes.length };
  // reliability: the share of the last fourteen days' probes that were answered and not wrong
  const to = dayOf(now), from = to - RULES.rampDays;
  let n = 0, good = 0;
  for (const role of ep.roles || []) {
    const s = sum(ep, role, from, to);
    n += s.n; good += Math.max(0, s.a - (s.v - s.c) - s.h);
  }
  const reliability = n ? good / n : 0;
  const sinceHard = ep.lastHard ? (now - ep.lastHard) / DAY : Infinity;
  const cleanDays = Math.min(sinceHard, age / DAY);
  const ramp = Math.min(1, RULES.probation + (1 - RULES.probation) * (cleanDays / RULES.rampDays));
  const recent = (ep.lastOk ?? 0) > now - 3600 * 3;               // answered well in the last three hours
  const weight = recent && reliability >= 0.5 ? Math.round(ramp * reliability * 1000) / 1000 : 0;
  return { state: weight > 0 ? (cleanDays >= RULES.rampDays ? 'listed' : 'probation') : 'down', weight, reliability, cleanDays: Math.floor(cleanDays), strikes: strikes.length };
}

// the leaderboard: every endpoint with its standing and per-role last-day and 24 h figures, then operators ranked by what their endpoints score
export function board(endpoints, now) {
  const today = dayOf(now);
  const live = endpoints.map((ep) => ({ ep, st: standing(ep, now) }));
  const healthy = Object.fromEntries(ROLES.map((r) => [r, live.filter(({ ep, st }) => !ep.baseline && st.weight > 0 && ep.roles.includes(r)).length]));
  const scarcity = (r) => 1 / (1 + healthy[r] / RULES.targets[r]);
  const nodes = live.map(({ ep, st }) => {
    const roles = ep.roles.map((role) => {
      const w = roleStats(ep, role, today - 1, today);        // the last day and a bit: the figures the page shows
      return { role, uptime: w.uptime, correct: w.correct, fresh: w.fresh, latency: w.latency, probes: w.n, hard: w.h, score: dayScore(ep, role, today - 1, scarcity(role)) };
    });
    return { id: ep.id, url: ep.url, kind: ep.kind, name: ep.name || null, operator: ep.operator, baseline: !!ep.baseline, own: !!ep.own, fronted: !!ep.fronted, ip: ep.ip || null, asn: ep.asn || null, ...st, lastOk: ep.lastOk || null, roles, score: roles.reduce((a, r) => a + r.score, 0) };
  });
  const by = new Map();
  for (const n of nodes) { if (!by.has(n.operator)) by.set(n.operator, []); by.get(n.operator).push(n); }
  const operators = [...by.entries()].map(([operator, ns]) => {
    // an operator's endpoints share what they score: the ones on one /24 or ASN count once, then a quarter for the second machine, a twentieth for the rest
    const counted = ns.filter((n) => !n.fronted && n.state !== 'shadow' && n.state !== 'removed');
    const d = diversity(counted.map((n) => ({ ...n, score: n.score })));
    const score = d.reduce((a, e) => a + e.score * e.share, 0);
    const ups = ns.flatMap((n) => n.roles.filter((r) => r.probes)).map((r) => r.uptime);
    const cs = ns.flatMap((n) => n.roles.filter((r) => r.correct != null)).map((r) => r.correct);
    const fs = ns.flatMap((n) => n.roles.filter((r) => r.fresh != null)).map((r) => r.fresh);
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    return { operator, baseline: ns.every((n) => n.baseline), own: ns.some((n) => n.own), name: ns.find((n) => n.name)?.name || null, endpoints: ns.length, roles: [...new Set(ns.flatMap((n) => n.roles.map((r) => r.role)))], uptime: avg(ups), correct: avg(cs), fresh: avg(fs), score };
  }).sort((a, b) => b.score - a.score || (b.uptime ?? 0) - (a.uptime ?? 0));
  operators.forEach((o, i) => { o.rank = i + 1; });
  return { nodes, operators };
}

// The list the pages read: community nodes that are out of shadow and not removed, with a weight, and the group that tells two voters of one machine or one
// operator from two operators.
export function listFrom(endpoints, now) {
  const out = [];
  for (const ep of endpoints) {
    if (ep.baseline || ep.fronted) continue;
    const st = standing(ep, now);
    if (st.weight <= 0) continue;
    out.push({ id: ep.id, url: ep.url, kind: ep.kind, roles: ep.roles.filter((r) => KIND_OF[r] === ep.kind), operator: ep.operator.slice(0, 16), group: groupOf(ep), weight: st.weight, reliability: Math.round(st.reliability * 1000) / 1000, lastOk: ep.lastOk || 0 });
  }
  // two endpoints of one /24 or ASN share a group whoever runs them, and one operator's endpoints share one too
  return collapseGroups(out);
}
export const groupOf = (ep) => (ep.asn ? `as${ep.asn}` : ep.ip ? `net${String(ep.ip).split('.').slice(0, 3).join('.')}` : `op${ep.operator.slice(0, 12)}`);
export function collapseGroups(nodes) {
  // union-find over group name and operator: nodes linked by either collapse to one group
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const link = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); parent.set(find(a), find(b)); };
  for (const n of nodes) link('g:' + n.group, 'o:' + n.operator);
  return nodes.map((n) => ({ ...n, group: find('g:' + n.group).replace(/^[go]:/, '').slice(0, 40) }));
}
