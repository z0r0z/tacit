// In-process replacement for Cloudflare's `caches.default`. The worker uses
// the Cache API as an SWR layer keyed by synthetic Request URLs
// (https://_market-cache_/… etc.) and decides staleness itself via the
// X-Cached-At header it stamps on stored responses — so the contract here is
// byte-faithful storage and retrieval, not HTTP cache semantics. TTL from
// Cache-Control max-age/s-maxage is honored for eviction; entries without one
// fall back to DEFAULT_TTL_MS. An LRU byte cap bounds memory.

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const keyOf = (reqOrUrl) => (typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url);

function ttlFrom(headers) {
  const cc = headers.get('Cache-Control') || '';
  if (/no-store/i.test(cc)) return 0;
  const m = /s-maxage=(\d+)/i.exec(cc) || /max-age=(\d+)/i.exec(cc);
  return m ? Number(m[1]) * 1000 : DEFAULT_TTL_MS;
}

export function createCacheStorage({ maxBytes = 256 * 1024 * 1024 } = {}) {
  const entries = new Map(); // url -> { status, headers: [[k,v]], body: Buffer, expiresAt }
  let totalBytes = 0;

  function evictUntilFits() {
    for (const [url, e] of entries) {
      if (totalBytes <= maxBytes) break;
      entries.delete(url);
      totalBytes -= e.body.byteLength;
    }
  }

  function drop(url) {
    const e = entries.get(url);
    if (!e) return false;
    entries.delete(url);
    totalBytes -= e.body.byteLength;
    return true;
  }

  const cache = {
    async put(reqOrUrl, response) {
      const url = keyOf(reqOrUrl);
      const ttl = ttlFrom(response.headers);
      const body = Buffer.from(await response.arrayBuffer());
      if (ttl === 0) { drop(url); return; }
      drop(url);
      entries.set(url, {
        status: response.status,
        headers: [...response.headers],
        body,
        expiresAt: Date.now() + ttl,
      });
      totalBytes += body.byteLength;
      evictUntilFits();
    },

    async match(reqOrUrl) {
      const url = keyOf(reqOrUrl);
      const e = entries.get(url);
      if (!e) return undefined;
      if (e.expiresAt <= Date.now()) { drop(url); return undefined; }
      entries.delete(url); // re-insert: Map order doubles as LRU recency
      entries.set(url, e);
      return new Response(e.body, { status: e.status, headers: e.headers });
    },

    async delete(reqOrUrl) {
      return drop(keyOf(reqOrUrl));
    },
  };

  return {
    default: cache,
    async open() { return cache; },
    _stats: () => ({ count: entries.size, totalBytes }),
  };
}
