// The ceremony attestations are cached by the limit the handler applies, never by the text of the parameter: a limit written as a path does not
// reach another route's cache entry, and a limit the handler would not take shares the default's.
//   node tests/ceremony-cache-key.test.mjs
import assert from 'node:assert';
import { createCacheStorage } from '../server/cache-mem.mjs';
import worker from '../worker/src/index.js';

globalThis.caches = createCacheStorage({ maxBytes: 16 * 1024 * 1024 });
const store = new Map();
const env = { REGISTRY_KV: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, list: async () => ({ keys: [], list_complete: true }) } };
const pending = [];
const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); }, passThroughOnException() {} };
const hash = 'ab'.repeat(32);
const get = async (query) => { const r = await worker.fetch(new Request(`https://api.test/ceremony/${hash}/attestations${query}`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } }), env, ctx); await Promise.all(pending.splice(0)); return r; };
const cached = async (path) => !!(await caches.default.match(new Request(`https://_ceremony-cache_/${path}`, { method: 'GET' })));
let n = 0; const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };

await get(`?limit=${encodeURIComponent(`../../state/${hash}`)}`);
ok(!(await cached(`state/${hash}`)), 'a limit written as a path does not put anything in the state route\'s cache entry');
ok(!(await cached(`stats/${hash}`)), 'nor in the stats route\'s');
ok(await cached(`attestations/${hash}/100`), 'it is cached under the limit the handler applies, the default');
await get('?limit=20');
ok(await cached(`attestations/${hash}/20`), 'a limit the handler takes has its own entry');
await get('?limit=999999');
await get('?limit=abc');
ok(!(await cached(`attestations/${hash}/999999`)) && !(await cached(`attestations/${hash}/abc`)), 'a limit the handler would not take has no entry of its own');
console.log(`${n} ok`);
process.exit(0);
