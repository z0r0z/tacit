// Smoke test for the hosted-watchtower registration endpoints in the worker
// (POST/GET/DELETE /watchtower/bids). Drives the real worker fetch handler over
// an in-memory KV (same shim the Render server uses), covering routing, the
// POST flag gate, field validation, the bad-auth rejection, and the empty-owner
// read path. The signed happy-path round-trip is pinned separately by the
// dapp↔worker auth-message parity test (lands with the dapp client side).
//
// Run: `node tests/watchtower-register.test.mjs`

import { createMemDriver } from '../server/driver-mem.mjs';
import { createCacheStorage } from '../server/cache-mem.mjs';
import { buildEnv } from '../server/harness.mjs';
import * as secp from '@noble/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';

globalThis.caches = createCacheStorage({ maxBytes: 32 * 1024 * 1024 });
const worker = (await import('../worker/src/index.js')).default;

let pass = 0, fail = 0;
async function test(label, fn) {
  try { const ok = await fn(); if (ok) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; } }
  catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

const ctx = { waitUntil: () => {} };
const enabledEnv = buildEnv(createMemDriver(), { extra: { WATCHTOWER_REGISTER_ENABLED: 'true' } });
const disabledEnv = buildEnv(createMemDriver(), { extra: {} });

async function call(env, method, path, body) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const resp = await worker.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  let json; try { json = JSON.parse(await resp.text()); } catch { json = {}; }
  return { status: resp.status, json };
}

const OWNER_PUB = bytesToHex(secp.getPublicKey(new Uint8Array(32).fill(7), true));
const BID_PUB = bytesToHex(secp.getPublicKey(new Uint8Array(32).fill(9), true));
const ASSET = 'ab'.repeat(32);
const BID_ID = 'cd'.repeat(16);
const validBody = {
  asset_id: ASSET, bid_id: BID_ID, owner_pubkey: OWNER_PUB, bid_pubkey: BID_PUB,
  enc_bid_privkey: 'ef'.repeat(32), bid_price_sats: 50000, bid_amount_base: '1000', decimals: 0,
  expiry: Math.floor(Date.now() / 1000) + 3600, funding_outpoint: { txid: '11'.repeat(32), vout: 0 },
  auth_sig: '00'.repeat(64), // intentionally invalid signature
};

await test('POST is gated off by default (410)', async () => {
  const r = await call(disabledEnv, 'POST', '/watchtower/bids?network=signet', validBody);
  return r.status === 410;
});

await test('POST with empty body → 400', async () => {
  const r = await call(enabledEnv, 'POST', '/watchtower/bids?network=signet', {});
  return r.status === 400;
});

await test('POST with bad owner_pubkey → 400', async () => {
  const r = await call(enabledEnv, 'POST', '/watchtower/bids?network=signet', { ...validBody, owner_pubkey: 'xyz' });
  return r.status === 400 && /owner_pubkey/.test(r.json.error || '');
});

await test('POST with sub-min price → 400', async () => {
  const r = await call(enabledEnv, 'POST', '/watchtower/bids?network=signet', { ...validBody, bid_price_sats: 0 });
  return r.status === 400 && /bid_price_sats/.test(r.json.error || '');
});

await test('POST with past expiry → 400', async () => {
  const r = await call(enabledEnv, 'POST', '/watchtower/bids?network=signet', { ...validBody, expiry: 100 });
  return r.status === 400 && /expiry/.test(r.json.error || '');
});

await test('POST with well-formed fields but invalid auth_sig → 403', async () => {
  const r = await call(enabledEnv, 'POST', '/watchtower/bids?network=signet', validBody);
  return r.status === 403 && /auth signature/.test(r.json.error || '');
});

await test('GET without owner param → 400', async () => {
  const r = await call(enabledEnv, 'GET', '/watchtower/bids?network=signet');
  return r.status === 400;
});

await test('GET with a valid owner (no registrations) → 200 empty list', async () => {
  const r = await call(enabledEnv, 'GET', `/watchtower/bids?network=signet&owner=${OWNER_PUB}`);
  return r.status === 200 && Array.isArray(r.json.bids) && r.json.bids.length === 0;
});

await test('DELETE a nonexistent bid → 404', async () => {
  const r = await call(enabledEnv, 'DELETE', `/watchtower/bids/${BID_ID}?network=signet`,
    { owner_pubkey: OWNER_PUB, cancel_sig: '00'.repeat(64) });
  return r.status === 404;
});

await test('DELETE with malformed bid_id is not routed (404/400)', async () => {
  const r = await call(enabledEnv, 'DELETE', '/watchtower/bids/nothex?network=signet',
    { owner_pubkey: OWNER_PUB, cancel_sig: '00'.repeat(64) });
  return r.status === 404 || r.status === 400;
});

console.log(`\n${pass + fail} tests, ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
