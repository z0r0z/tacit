// POST /ceremony/<hash>/upload-token: a client address is given so many signed upload links a day, counted before one is asked of the pin service,
// and a finalized ceremony gives none.
//   node tests/ceremony-upload-token.test.mjs
import assert from 'node:assert';
import worker from '../worker/src/index.js';
const hash = 'ab'.repeat(32);
let signed = 0, finalized = false;
globalThis.fetch = async (url) => {
  if (String(url).startsWith('https://uploads.pinata.cloud/v3/files/sign')) { signed++; return new Response(JSON.stringify({ data: 'https://uploads.pinata.cloud/signed/x' }), { status: 200 }); }
  return new Response('{}', { status: 404 });
};
const up = new Map();
const env = {
  PINATA_JWT: 'dummy', CEREMONY_TOKENS_PER_DAY: '5',
  UPLOAD_KV: { get: async (k) => up.get(k) ?? null, put: async (k, v) => { up.set(k, v); } },
  REGISTRY_KV: { get: async (k, t) => (k.includes('ceremony') ? (t === 'json' ? { finalized, head_cid: 'x' } : '{}') : null), put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const mint = async (ip) => (await worker.fetch(new Request(`https://api.test/ceremony/${hash}/upload-token`, { method: 'POST', headers: { 'CF-Connecting-IP': ip } }), env, ctx)).status;
let n = 0; const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };
const codes = await Promise.all(Array.from({ length: 12 }, () => mint('203.0.113.9')));
ok(codes.filter((c) => c === 200).length === 5 && codes.filter((c) => c === 429).length === 7, `parallel requests from one address get the day's five (${codes.sort().join(',')})`);
ok(signed === 5, `the pin service was asked for five links, not twelve (${signed})`);
ok(await mint('203.0.113.10') === 200, 'another address is given its own');
finalized = true;
const before = signed;
ok(await mint('203.0.113.11') === 409 && signed === before, 'a finalized ceremony gives none and asks nothing of the pin service');
console.log(`${n} ok`);
process.exit(0);
