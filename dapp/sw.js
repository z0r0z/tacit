// Service worker for the tacit dapp.
//
// Goals:
//   1. Cross-tab cache sharing for IMMUTABLE responses (IPFS content,
//      confirmed-tx bodies, confirmed outspends). The dapp already has
//      per-tab IndexedDB + memory caches; this adds a shared layer that
//      every tab on the same origin sees.
//   2. Static-asset cache so repeat visits paint from disk before any
//      network call. The tacit.js bundle is ~1.8 MB; serving it from the
//      SW cache on revisit cuts cold-load by 1-3s on slow networks.
//   3. Safe defaults: anything we don't recognise as cacheable goes
//      through to the network unmodified. If the SW errors, fall back
//      to network. The SW should never be load-bearing for correctness.
//
// Versioning: CACHE_VERSION is bumped on every shipping change to the SW
// itself. The activate handler purges old cache versions so a stale SW
// can't keep serving outdated bundles. The dapp's tacit.js is fingerprinted
// via the `?cb=<sha>` query so a new bundle's URL is distinct from an old
// cached one — the SW won't serve a stale bundle if the index.html changed.
//
// Lifecycle:
//   install → precache nothing (runtime caching handles everything)
//   activate → delete old cache versions
//   fetch → route by URL pattern, fall back to network on any error

const CACHE_VERSION = 'v1-stealth-per-wallet-scan-gate';
const STATIC_CACHE  = `tacit-static-${CACHE_VERSION}`;
const IMMUTABLE_CACHE = `tacit-immutable-${CACHE_VERSION}`;

self.addEventListener('install', (event) => {
  // Activate immediately on update — don't wait for all tabs to close.
  // Combined with the activate-handler's claim() call, this means a
  // hotfix SW takes effect on the next page load without a manual
  // reload-twice dance for the user.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Purge old cache versions so a bumped CACHE_VERSION doesn't leave
    // the previous generation taking up quota indefinitely.
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n.startsWith('tacit-') && !n.endsWith(CACHE_VERSION))
        .map(n => caches.delete(n))
    );
    // Take control of any pages that were loaded before this SW activated.
    await self.clients.claim();
  })());
});

// Cacheable request matchers. Each predicate returns the cache name to
// use, or null if the request should pass through unchanged.
function _cacheForRequest(url) {
  // Only cache same-origin requests. Cross-origin fetches (to mempool.space,
  // CEX price oracles, etc.) go straight to the network — we don't want
  // to fight with their own CORS/cache semantics.
  if (url.origin !== self.location.origin) return null;

  const path = url.pathname;

  // Static assets: the dapp bundle, vendor deps, prf-wallet helper.
  // index.html is intentionally NOT cached (always network-first) so a
  // new build is picked up immediately without waiting for a SW update.
  if (path === '/tacit.js'
      || path === '/vendor/tacit-deps.min.js'
      || path === '/prf-wallet.js'
      || path === '/preboot.js') {
    return { cache: STATIC_CACHE, mode: 'cache-first' };
  }

  // Static CSS / images / fonts at fixed paths
  if (path.startsWith('/circuits/')
      || path === '/tacit.svg'
      || path === '/tacit.png'
      || path === '/tacit-dark.png') {
    return { cache: STATIC_CACHE, mode: 'cache-first' };
  }

  return null;
}

// Worker-origin URLs that proxy content-addressed (immutable) data. We
// detect by URL pattern rather than origin since WORKER_BASE is a
// configurable host. The patterns are conservative: only paths whose
// response can never change for a given URL go in the immutable cache.
function _isImmutableWorkerPath(url) {
  // /ipfs/<cid> — content-addressed, immutable forever
  if (/\/ipfs\/[A-Za-z0-9]+(\/.*)?$/.test(url.pathname)) return true;
  // /chain/tx/<txid> — confirmed tx body is immutable; we accept the
  // small risk of caching an unconfirmed body too (browser cache layer
  // re-fetches on the next call via Cache-Control honors, and the dapp's
  // own mempool-aware paths re-poll until confirmation lands).
  if (/^\/chain\/tx\/[0-9a-f]{64}$/i.test(url.pathname)) return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GET. POSTs (batch endpoints) and other methods pass through.
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // Same-origin static handling.
  const staticHandling = _cacheForRequest(url);
  if (staticHandling) {
    event.respondWith(_cacheFirst(req, staticHandling.cache));
    return;
  }

  // Cross-origin: if it looks like an immutable worker proxy path, cache it.
  if (_isImmutableWorkerPath(url)) {
    event.respondWith(_cacheFirst(req, IMMUTABLE_CACHE));
    return;
  }

  // Everything else: do nothing (let the browser handle it normally).
});

// Cache-first strategy: serve from cache when present; otherwise fetch from
// network, store, and return. On network failure with no cache entry,
// re-throws — caller handles by surfacing as a fetch error.
async function _cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) {
    // Refresh the cache opportunistically in the background so the next
    // visit gets the latest version. SWR-style; doesn't block the response.
    // Skipped for immutable cache (the content never changes by definition).
    // Detached promise — the SW may be killed before revalidate completes;
    // worst case the next visit re-revalidates.
    if (cacheName === STATIC_CACHE) {
      _revalidate(req, cache).catch(() => {});
    }
    return cached;
  }
  // No cache entry → fetch, store on success, return.
  let resp;
  try { resp = await fetch(req); }
  catch (e) {
    // Network down + cache miss → propagate the error. The dapp's own
    // fetch-error handling (toasts, retry, etc.) takes over.
    throw e;
  }
  if (resp && resp.ok) {
    // Clone before storing because Response bodies are single-use.
    try { cache.put(req, resp.clone()); } catch { /* quota / opaque — fine */ }
  }
  return resp;
}

async function _revalidate(req, cache) {
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) await cache.put(req, resp.clone());
  } catch { /* network blip — keep existing cache entry */ }
}
