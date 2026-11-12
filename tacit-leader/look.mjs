// How often a shield with no deposit yet is looked at. While it is young its owner is sending the deposit, so it is looked at every step; after that
// every minute, and after ten minutes every five: a shield that stays unfunded costs the leader less and less, and one that is funded late is taken
// in a few minutes later at most. A funded one is forgotten here (it is looked at each step, as it is taken into the block).
export function makeLooks({ young = 120_000, mid = 600_000, everyMid = 60_000, everyOld = 300_000 } = {}) {
  const m = new Map();                                   // id -> { first, last }
  const every = (age) => (age < young ? 0 : age < mid ? everyMid : everyOld);
  return {
    due(id, t) { const a = m.get(id); return !a || t - a.last >= every(t - a.first); },
    aged(id, t) { const a = m.get(id); return !!a && t - a.first >= young; },
    saw(id, t, funded) { if (funded) m.delete(id); else m.set(id, { first: m.get(id)?.first ?? t, last: t }); },
    prune(ids) { for (const id of [...m.keys()]) if (!ids.has(id)) m.delete(id); },
    get size() { return m.size; },
  };
}
