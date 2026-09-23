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

const CACHE_VERSION = 'v1-ipfs-cid-verified-immutable-66f1ccf5';
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
    // stale caches taking up quota.
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
      || path.startsWith('/fonts/')
      || path === '/tacit.svg'
      || path === '/tacit.png'
      || path === '/tacit-dark.png') {
    return { cache: STATIC_CACHE, mode: 'cache-first' };
  }

  return null;
}

// Content-addressed (immutable) data. We detect by URL pattern rather than
// origin since WORKER_BASE is a configurable host — which is exactly why a
// URL pattern alone is not enough to earn a permanent cache entry. An
// /ipfs/<cid> URL is a *claim* that the bytes hash to <cid>; storing the
// gateway's answer forever under that name without checking makes a lying
// or coerced gateway's answer permanent, and content addressing is the one
// case where the client can check for itself. So we check.
//
// /chain/tx/<txid> stays pattern-matched: a confirmed tx body is immutable,
// and the response is the worker's JSON rendering of the tx rather than the
// preimage of the txid, so there is nothing to hash-check here. Nothing
// executable is fetched this way and the dapp re-polls mempool-aware paths
// until confirmation lands.
function _isImmutableTxPath(url) {
  return /^\/chain\/tx\/[0-9a-f]{64}$/i.test(url.pathname);
}

// Exact /ipfs/<cid> only. A trailing sub-path (/ipfs/<cid>/thumb.png)
// addresses a file *inside* a DAG: the returned bytes are not the preimage
// of the CID in the URL, so they can never be verified from the response
// alone and must not be cached immutably.
function _ipfsCid(url) {
  const m = /^\/ipfs\/([A-Za-z0-9]+)$/.exec(url.pathname);
  return m ? m[1] : null;
}

// Multibase base32 (RFC 4648 lowercase, no padding). Returns bytes, or
// null on any character outside the alphabet.
const _B32_ALPHA = 'abcdefghijklmnopqrstuvwxyz234567';
function _b32Decode(str) {
  const out = [];
  let bits = 0, value = 0;
  for (let i = 0; i < str.length; i++) {
    const idx = _B32_ALPHA.indexOf(str[i]);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

// The expected sha2-256 digest for a CIDv1 whose codec is raw, or null for
// every other CID shape. Specifically null for:
//   - CIDv0 (`Qm…`, base58btc, always dag-pb) — the bytes on the wire are
//     the unixfs *file*, while the CID commits to a dag-pb node wrapping
//     it, so sha256(response) does not equal the digest in the CID;
//   - CIDv1 dag-pb (0x70) — same reason;
//   - any multihash other than sha2-256/32, and any multibase other than
//     base32-lower.
// A null is not a verdict that the content is bad, only that this worker
// cannot check it — callers fall through to an ordinary uncached network
// fetch rather than minting a permanent cache entry on trust.
function _rawSha256Digest(cid) {
  if (!/^b[a-z2-7]{20,}$/.test(cid)) return null;      // multibase prefix 'b' = base32 lower
  const bytes = _b32Decode(cid.slice(1));
  if (!bytes || bytes.length !== 36) return null;      // 1+1+2+32
  if (bytes[0] !== 0x01) return null;                  // CID version 1
  if (bytes[1] !== 0x55) return null;                  // multicodec: raw
  if (bytes[2] !== 0x12 || bytes[3] !== 0x20) return null; // multihash: sha2-256, 32 bytes
  return bytes.subarray(4);
}

function _bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
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

  // Confirmed-tx bodies: pattern-matched, immutable, nothing to verify.
  if (_isImmutableTxPath(url)) {
    event.respondWith(_cacheFirst(req, IMMUTABLE_CACHE));
    return;
  }

  // /ipfs/<cid>: only the shapes we can actually verify get the immutable
  // cache. Everything else (CIDv0, dag-pb, sub-paths, exotic multihashes)
  // is left entirely alone — no respondWith, so the browser fetches it
  // normally and the SW mints no permanent entry it cannot vouch for.
  const cid = _ipfsCid(url);
  if (cid) {
    const expected = _rawSha256Digest(cid);
    if (expected) {
      event.respondWith(_cacheFirstVerifiedIpfs(req, expected));
      return;
    }
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

// Cache-first for /ipfs/<cid> where <cid> is a CIDv1 raw/sha2-256 CID: the
// bytes are hashed and compared against the digest in the CID before they
// are allowed into the immutable cache. Three outcomes:
//   digest matches  → served and cached forever (the cache name now means
//                     what it says: these bytes ARE that content);
//   digest differs  → nothing is cached and the request fails with 502.
//                     A raw CID whose body does not hash to it is not a
//                     stale answer, it is a wrong one, so fail closed
//                     rather than hand the page substituted content;
//   unreadable body → served through untouched and NOT cached. Opaque
//                     responses (an <img src> is a no-cors request) have
//                     no readable body, so there is nothing to check;
//                     serving them is the status quo, caching them is not.
async function _cacheFirstVerifiedIpfs(req, expected) {
  const cache = await caches.open(IMMUTABLE_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;              // only verified bytes are ever in here

  const resp = await fetch(req);          // network error propagates, as before
  if (!resp || !resp.ok) return resp;
  if (resp.type !== 'basic' && resp.type !== 'cors' && resp.type !== 'default') return resp;

  let buf;
  try { buf = await resp.clone().arrayBuffer(); }
  catch { return resp; }

  let digest;
  try { digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf)); }
  catch { return resp; }

  if (!_bytesEqual(digest, expected)) {
    return new Response('ipfs: response does not hash to the requested CID', {
      status: 502,
      statusText: 'CID mismatch',
      headers: { 'content-type': 'text/plain' }
    });
  }

  try { await cache.put(req, resp.clone()); } catch { /* quota — fine */ }
  return resp;
}
