// The result of a synchronous load, kept for `ttlMs` (ttlMs 0 keeps nothing). At most `max` keys: the oldest go first. A load that throws is not kept.
export function makeTtlMemo({ ttlMs, max = 100, now = () => Date.now() }) {
  const m = new Map();                     // key -> { at, v }
  return (key, load) => {
    if (!(ttlMs > 0)) return load();
    const t = now(), hit = m.get(key);
    if (hit && t - hit.at < ttlMs) return hit.v;
    const v = load();
    m.delete(key);
    m.set(key, { at: t, v });
    while (m.size > max) m.delete(m.keys().next().value);
    return v;
  };
}
