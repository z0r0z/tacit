// The cache in front of the points service's read routes (lib/read-cache-front.js): one answer per route and query for a few seconds, shared by
// requests that arrive while it is made; posts, other routes and server errors are never kept.
//   node worker-relay/tests/points-read-cache.test.mjs
import assert from 'node:assert/strict';
import { withReadCache, cacheKey } from '../src/lib/read-cache-front.js';

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
const parse = (req) => new URL(req.url, 'http://localhost');
const mkReq = (url, method = 'GET') => ({ url, method });
function mkRes() {
  const h = new Map();
  return { statusCode: 200, body: undefined, ended: 0, setHeader(k, v) { h.set(String(k).toLowerCase(), v); }, header: (k) => h.get(k.toLowerCase()), end(b) { this.body = b; this.ended++; } };
}

// A handler like the service's: sets headers, writes a body that changes on every call, counts how often it ran.
function service({ status = 200, delay = 0 } = {}) {
  const s = { calls: 0, urls: [] };
  s.handle = async (req, res) => {
    s.calls++; s.urls.push(req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/leaderboard')) res.setHeader('Cache-Control', 'public, max-age=30');
    if (delay) await new Promise((r) => setTimeout(r, delay));
    res.statusCode = typeof status === 'function' ? status(s.calls) : status;
    res.end(JSON.stringify({ call: s.calls, url: req.url }));
  };
  return s;
}
const get = async (front, url, method) => { const res = mkRes(); await front(mkReq(url, method), res); return res; };

let clock = 1_000;
const now = () => clock;

{ // a second read inside the window is the first one's answer, with the status and headers it had
  const s = service();
  const front = withReadCache(s.handle, { parse, ttlMs: 10_000, now });
  const a = await get(front, '/leaderboard?limit=500');
  const b = await get(front, '/leaderboard?limit=500');
  assert.equal(s.calls, 1);
  assert.equal(a.body, b.body);
  assert.equal(b.statusCode, 200);
  assert.equal(b.header('cache-control'), 'public, max-age=30');
  assert.equal(b.header('access-control-allow-origin'), '*');
  assert.equal(b.header('content-type'), 'application/json');
  assert.equal(a.header('x-points-cache'), 'miss');
  assert.equal(b.header('x-points-cache'), 'hit');
}

{ // the same front, used for every request as production does, answers again once the window has passed
  const s = service();
  const front = withReadCache(s.handle, { parse, ttlMs: 10_000, now });
  clock = 5_000;
  const a = await get(front, `/points/${A}`);
  clock = 14_999;
  const b = await get(front, `/points/${A}`);
  clock = 15_000;
  const c = await get(front, `/points/${A}`);
  assert.equal(s.calls, 2);
  assert.equal(a.body, b.body);
  assert.notEqual(b.body, c.body);
}

{ // requests that arrive while the answer is being made share it
  const s = service({ delay: 30 });
  const front = withReadCache(s.handle, { parse, ttlMs: 10_000, now });
  const all = await Promise.all(Array.from({ length: 25 }, () => get(front, '/recent?limit=40')));
  assert.equal(s.calls, 1);
  assert.equal(new Set(all.map((r) => r.body)).size, 1);
  assert.ok(all.every((r) => r.ended === 1 && r.statusCode === 200));
}

{ // another address, another query, or another letter case of the same address is its own answer
  const s = service();
  const front = withReadCache(s.handle, { parse, ttlMs: 10_000, now });
  await get(front, `/points/${A}`);
  await get(front, `/points/${B}`);
  await get(front, `/points/${A}/days`);
  await get(front, `/claim/${A}`);
  await get(front, `/claim/${A.toUpperCase().replace('0X', '0x')}`);
  await get(front, '/leaderboard?limit=10');
  await get(front, '/leaderboard?limit=500');
  assert.equal(s.calls, 7);
  await get(front, `/points/${A}`);
  await get(front, '/leaderboard?limit=10');
  assert.equal(s.calls, 7);
}

{ // the order of the query's parameters does not make a second answer
  const s = service();
  const front = withReadCache(s.handle, { parse, ttlMs: 10_000, now });
  await get(front, '/lp?farm=x&address=' + A);
  await get(front, '/lp?address=' + A + '&farm=x');
  assert.equal(s.calls, 1);
}

{ // anything not listed goes to the handler every time, and so does any post
  const s = service();
  const front = withReadCache(s.handle, { parse, ttlMs: 10_000, now });
  for (const url of ['/health', '/holding', '/holding/nullifiers/8453/20780', '/supply', '/tvl', '/lp/day/20760']) {
    await get(front, url); await get(front, url);
  }
  assert.equal(s.calls, 12);
  await get(front, '/tasks/claim', 'POST'); await get(front, '/tasks/claim', 'POST');
  await get(front, '/leaderboard', 'POST'); await get(front, '/leaderboard', 'POST');
  assert.equal(s.calls, 16);
  const res = await get(front, '/health');
  assert.equal(res.header('x-points-cache'), undefined);
}

{ // a server error is passed on but not kept: the next read asks the handler again
  const s = service({ status: (n) => (n === 1 ? 500 : 200) });
  const front = withReadCache(s.handle, { parse, ttlMs: 10_000, now });
  const a = await get(front, '/mine');
  const b = await get(front, '/mine');
  const c = await get(front, '/mine');
  assert.equal(a.statusCode, 500);
  assert.equal(b.statusCode, 200);
  assert.equal(c.statusCode, 200);
  assert.equal(s.calls, 2);
}

{ // requests that were waiting on an answer that failed all get that failure, and the next one retries
  const s = service({ status: (n) => (n === 1 ? 503 : 200), delay: 20 });
  const front = withReadCache(s.handle, { parse, ttlMs: 10_000, now });
  const all = await Promise.all([get(front, '/rewards'), get(front, '/rewards'), get(front, '/rewards')]);
  assert.ok(all.every((r) => r.statusCode === 503 && r.ended === 1));
  assert.equal(s.calls, 1);
  assert.equal((await get(front, '/rewards')).statusCode, 200);
}

{ // a not-found or bad-request answer is kept like any other below 500
  const s = service({ status: 404 });
  const front = withReadCache(s.handle, { parse, ttlMs: 10_000, now });
  await get(front, `/points/${A}/days`); await get(front, `/points/${A}/days`);
  assert.equal(s.calls, 1);
}

{ // a window of 0 leaves the handler as it was
  const s = service();
  assert.equal(withReadCache(s.handle, { parse, ttlMs: 0 }), s.handle);
}

{ // queries with many parameters, or very long ones, are not kept (the cache holds a bounded set)
  const s = service();
  const front = withReadCache(s.handle, { parse, ttlMs: 10_000, now });
  await get(front, '/leaderboard?a=1&b=2&c=3&d=4&e=5'); await get(front, '/leaderboard?a=1&b=2&c=3&d=4&e=5');
  await get(front, '/leaderboard?x=' + 'y'.repeat(300)); await get(front, '/leaderboard?x=' + 'y'.repeat(300));
  assert.equal(s.calls, 4);
  assert.equal(cacheKey(new URL('/leaderboard?limit=5', 'http://localhost')), '/leaderboard?limit=5');
  assert.equal(cacheKey(new URL('/health', 'http://localhost')), null);
}

{ // the cache holds at most `max` answers: the oldest go first
  const s = service();
  const front = withReadCache(s.handle, { parse, ttlMs: 10_000, max: 3, now });
  for (let i = 1; i <= 5; i++) await get(front, `/leaderboard?limit=${i}`);
  assert.equal(s.calls, 5);
  await get(front, '/leaderboard?limit=5');
  assert.equal(s.calls, 5);
  await get(front, '/leaderboard?limit=1');
  assert.equal(s.calls, 6);
}

{ // a url the parser refuses goes to the handler, which answers it
  const s = service();
  const front = withReadCache(s.handle, { parse: () => null, ttlMs: 10_000, now });
  await get(front, '/leaderboard'); await get(front, '/leaderboard');
  assert.equal(s.calls, 2);
}

console.log('points-read-cache: ok');
