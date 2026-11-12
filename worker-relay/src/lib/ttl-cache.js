// A small read-through cache: one load per key per `ttlMs`, however many ask meanwhile (they share the load in flight); a load that throws is not kept.
// At most `max` keys: the oldest go first.
export function makeTtlCache({ ttlMs, max = 1000, now = () => Date.now() }) {
  const m = new Map();                     // key -> { at, p }
  return {
    get(key, load) {
      const t = now();
      const hit = m.get(key);
      if (hit && t - hit.at < ttlMs) return hit.p;
      const p = Promise.resolve().then(load);
      const ent = { at: t, p };
      m.delete(key);
      m.set(key, ent);
      p.catch(() => { if (m.get(key) === ent) m.delete(key); });
      while (m.size > max) m.delete(m.keys().next().value);
      return p;
    },
    get size() { return m.size; },
  };
}
