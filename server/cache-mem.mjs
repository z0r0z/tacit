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

// Charged size of an entry: body bytes plus the key string and per-entry
// Map/object/header overhead. Without the constant, zero/tiny-body entries
// (cache keys are request-derived, so their count is unbounded) would never
// count against the cap and could grow the map past memory long before
// eviction ran.
const ENTRY_OVERHEAD = 512;

export function createCacheStorage({ maxBytes = 256 * 1024 * 1024, maxEntries = 100_000 } = {}) {
  const entries = new Map(); // url -> { status, headers: [[k,v]], body: Buffer, size, expiresAt }
  let totalBytes = 0;

  function evictUntilFits() {
    for (const [url, e] of entries) {
      if (totalBytes <= maxBytes && entries.size <= maxEntries) break;
      entries.delete(url);
      totalBytes -= e.size;
    }
  }

  function drop(url) {
    const e = entries.get(url);
    if (!e) return false;
    entries.delete(url);
    totalBytes -= e.size;
    return true;
  }

  const cache = {
    async put(reqOrUrl, response) {
      const url = keyOf(reqOrUrl);
      const ttl = ttlFrom(response.headers);
      const body = Buffer.from(await response.arrayBuffer());
      drop(url);
      if (ttl === 0) return;
      const size = body.byteLength + url.length * 2 + ENTRY_OVERHEAD;
      entries.set(url, {
        status: response.status,
        headers: [...response.headers],
        body,
        size,
        expiresAt: Date.now() + ttl,
      });
      totalBytes += size;
      evictUntilFits();
    },

    async match(reqOrUrl) {
      const url = keyOf(reqOrUrl);
      const e = entries.get(url);
      if (!e) return undefined;
      if (e.expiresAt <= Date.now()) { drop(url); return undefined; }
      entries.delete(url); // re-insert: Map order doubles as LRU recency
      entries.set(url, e);
      // Stream the stored bytes instead of handing the Buffer to Response,
      // which would copy the whole body on every hit. The view is read-only
      // by contract; each match gets its own one-shot stream.
      const view = new Uint8Array(e.body.buffer, e.body.byteOffset, e.body.byteLength);
      const body = new ReadableStream({
        start(c) { c.enqueue(view); c.close(); },
      });
      return new Response(body, { status: e.status, headers: e.headers });
    },

    async delete(reqOrUrl) {
      return drop(keyOf(reqOrUrl));
    },
  };

  return { default: cache };
}
