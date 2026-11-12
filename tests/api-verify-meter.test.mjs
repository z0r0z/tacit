// The routes that check a signature or ask the explorer for an anonymous caller take the caller's allowance for that work before they do it: a
// client that sends them in a flood is slowed, another client is not, and a caller with the box token is not metered.
//   node tests/api-verify-meter.test.mjs
import assert from 'node:assert';
import worker from '../worker/src/index.js';

const A = 'ab'.repeat(32), T = 'cd'.repeat(32), M = '02' + 'ee'.repeat(32), I = 'ef'.repeat(16);
const ROUTES = [
  ['attest', `/assets/${A}/attest`], ['mint attest', `/assets/${A}/mints/${T}/attest`], ['utxo opening', `/utxos/${T}/0/opening`],
  ['listing', `/assets/${A}/listings`], ['listing claim', `/assets/${A}/listings/${T}/0/claim`],
  ['range listing', `/assets/${A}/listings-range`], ['range listing claim', `/assets/${A}/listings-range/${M}/claim`],
  ['atomic intent', `/assets/${A}/atomic-intents`], ['atomic intent claim', `/assets/${A}/atomic-intents/${I}/claim`],
  ['tx batch', '/chain/txs/batch'], ['outspend batch', '/chain/outspends/batch'], ['holdings', '/holdings'],
];
const TOKEN = 'box-token-box-token-box-token';
let n = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };
globalThis.fetch = async () => new Response('{}', { status: 404 });     // nothing reaches an explorer
const ctx = { waitUntil() {}, passThroughOnException() {} };

for (const [label, path] of ROUTES) {
  const store = new Map();
  const env = { CONFIDENTIAL_BOX_TOKEN: TOKEN, REGISTRY_KV: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, list: async () => ({ keys: [], list_complete: true }) } };
  const post = async (ip, extra = {}) => (await worker.fetch(new Request(`https://api.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip, ...extra }, body: '{}' }), env, ctx)).status;
  const codes = []; for (let i = 0; i < 90; i++) codes.push(await post('198.51.100.7'));
  const first = codes.indexOf(429);
  ok(first >= 25 && first <= 70 && codes.slice(0, first).every((c) => c !== 429), `${label}: a flood is slowed after its allowance (first 429 at request ${first + 1})`);
  ok(await post('198.51.100.8') !== 429, `${label}: another client is not slowed`);
  ok(await post('198.51.100.7', { Authorization: `Bearer ${TOKEN}` }) !== 429, `${label}: a caller with the box token is not metered`);
}
console.log(`${n} ok`);
process.exit(0);
