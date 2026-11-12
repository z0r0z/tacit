// POST /reflection/burndep: what one client stores in a day is bounded, an identical registration costs nothing, and another client has its own day.
//   node tests/burndep-register-budget.test.mjs
import assert from 'node:assert';
import worker from '../worker/src/index.js';
const store = new Map(), ttls = new Map();
const env = { BURNDEP_DAILY_BYTES: String(3 * 1024 * 1024), REGISTRY_KV: { get: async (k) => store.get(k) ?? null, put: async (k, v, o) => { store.set(k, v); if (o?.expirationTtl) ttls.set(k, o.expirationTtl); }, delete: async (k) => store.delete(k), list: async () => ({ keys: [], list_complete: true }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const txid = (i) => i.toString(16).padStart(64, '0');
const bundle = (pad) => ({ cxfers: [{ blockHash: '0x' + '11'.repeat(32), tx: 'ab'.repeat(pad) }] });
const post = async (ip, id, b) => (await worker.fetch(new Request('https://api.test/reflection/burndep', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ burnTxidDisplay: txid(id), bundle: b }) }), env, ctx)).status;
let n = 0; const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };
const codes = []; for (let i = 1; i <= 6; i++) codes.push(await post('203.0.113.9', i, bundle(500_000)));   // ~1 MB each, 3 MiB allowed
ok(codes.slice(0, 3).every((c) => c === 200) && codes.slice(3).every((c) => c === 429), `a client's registrations stop at its day's bytes (${codes.join(',')})`);
ok(await post('203.0.113.9', 1, bundle(500_000)) === 200, 'registering the same bundle again takes nothing from the day');
ok(await post('203.0.113.10', 50, bundle(500_000)) === 200, 'another client has its own day');
ok(!store.has(`reflection:burndep:mainnet:${txid(4)}`), 'a refused registration is not stored');
ok(await post('203.0.113.9', 60, bundle(10)) === 200, 'a small bundle that fits what is left of the day is taken');
ok(await post('203.0.113.9', 61, bundle(100_000)) === 429, 'one that does not fit is refused');
console.log(`${n} ok`);
process.exit(0);
