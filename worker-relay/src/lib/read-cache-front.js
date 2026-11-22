// A short-lived cache in front of the points service's read routes. Each of these answers the same for every visitor, so one answer per route
// and query serves everyone for a few seconds, and requests that arrive while it is being made share it. Anything else (posts, the holding
// routes, health) passes straight through.
import { makeTtlCache } from './ttl-cache.js';

const SHARED_READS = [
  /^\/leaderboard$/, /^\/recent$/, /^\/rewards$/, /^\/tasks$/, /^\/mine$/, /^\/lp$/, /^\/lp\/farms$/, /^\/tokpool$/,
  /^\/points\/0x[0-9a-fA-F]{40}$/, /^\/points\/0x[0-9a-fA-F]{40}\/days$/, /^\/claim\/0x[0-9a-fA-F]{40}$/,
];
const MAX_PARAMS = 4, MAX_KEY = 240;

// A response taken whole: the status, the headers and the body the handler wrote.
function capture() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: '',
    headers,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), [name, value]); },
    getHeader(name) { return headers.get(String(name).toLowerCase())?.[1]; },
    end(body) { if (body !== undefined && body !== null) this.body = body; },
  };
}

function send(res, c, state) {
  res.statusCode = c.statusCode;
  for (const [name, value] of c.headers.values()) res.setHeader(name, value);
  res.setHeader('X-Points-Cache', state);
  res.end(c.body);
}

class NotKept {
  constructor(captured) { this.captured = captured; }
}

export function cacheKey(url) {
  if (!SHARED_READS.some((re) => re.test(url.pathname))) return null;
  const params = [...url.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (params.length > MAX_PARAMS) return null;
  const key = url.pathname + (params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '');
  return key.length > MAX_KEY ? null : key;
}

// `handle(req, res)` is the service's own request handler; `parse(req)` gives its URL (or null). A response with a server error is not kept.
export function withReadCache(handle, { parse, ttlMs = 10_000, max = 1000, now } = {}) {
  if (!(ttlMs > 0)) return handle;
  const cache = makeTtlCache({ ttlMs, max, now });
  return async function front(req, res) {
    if (req.method !== 'GET') return handle(req, res);
    const url = parse(req);
    const key = url ? cacheKey(url) : null;
    if (key === null) return handle(req, res);
    let made = false;
    let c;
    try {
      c = await cache.get(key, async () => {
        made = true;
        const taken = capture();
        await handle(req, taken);
        if (taken.statusCode >= 500) throw new NotKept(taken);
        return taken;
      });
    } catch (e) {
      if (!(e instanceof NotKept)) throw e;
      c = e.captured;
    }
    send(res, c, made ? 'miss' : 'hit');
  };
}
