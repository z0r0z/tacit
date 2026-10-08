// A token bucket per key, and the key a request is counted under. Standalone (the points service image holds only worker-relay).

// allow(key) → boolean: `burst` requests at once, refilled at `perMin` a minute; at most `maxKeys` keys are tracked, and a full
// table refuses a new key rather than grow.
export function makeTokenBucket({ perMin, burst, maxKeys = 10_000, now = () => Date.now() }) {
  const buckets = new Map();
  const fill = (b, t) => { b.tokens = Math.min(burst, b.tokens + ((t - b.at) * perMin) / 60_000); b.at = t; };
  return (key) => {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxKeys) for (const [k, v] of buckets) { fill(v, t); if (v.tokens >= burst) buckets.delete(k); }
      if (buckets.size >= maxKeys) return false;
      b = { tokens: burst, at: t };
      buckets.set(key, b);
    }
    fill(b, t);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

// An IPv6 client is counted by its /64, which one subscriber holds in full and could otherwise rotate through.
export function ipKey(addr) {
  const a = String(addr).trim().toLowerCase();
  if (!a.includes(':') || /^(::ffff:)?\d+\.\d+\.\d+\.\d+$/.test(a)) return a;
  const [h, t = ''] = a.split('::'), head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const full = a.includes('::') ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return `${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// The right-most forwarded hop is the one the fronting proxy appended; earlier hops are client-supplied.
export function clientKey(req) {
  const f = req.headers?.['x-forwarded-for'];
  if (f) { const k = String(f).split(',').pop().trim(); if (k) return ipKey(k); }
  return ipKey(req.socket?.remoteAddress || 'unknown');
}
