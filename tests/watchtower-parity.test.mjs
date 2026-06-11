// Cross-implementation parity for the hosted-watchtower wire format. Pins that
// the THREE copies of the crypto + auth message agree:
//   • dapp (client) — dapp/tacit.js
//   • orchestrator/CLI — fulfiller/watchtower-crypto.mjs
//   • worker (verifier) — worker/src/index.js  (via accept/reject of a real sig)
//
// Part A: the dapp's derive + encrypt produce byte-identical output to the
// fulfiller module, and the service key decrypts what the dapp encrypted (the
// real custody round-trip).
// Part B: a registration signed with the dapp's watchtowerRegisterMsg is ACCEPTED
// by the worker (so dapp msg == worker msg), stored, and cancellable with the
// dapp's cancel message. A real BIP-340 signature, end to end, no broadcast.
//
// Run: `node tests/watchtower-parity.test.mjs`

import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { createMemDriver } from '../server/driver-mem.mjs';
import { createCacheStorage } from '../server/cache-mem.mjs';
import { buildEnv } from '../server/harness.mjs';
import * as wtc from '../fulfiller/watchtower-crypto.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage; globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator; globalThis.__TACIT_NO_INIT__ = true;
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

// Import the dapp BEFORE defining globalThis.caches — the dapp's service-worker
// load path keys off caches and stalls under jsdom when it's present.
const dapp = await import('../dapp/tacit.js');
// The worker needs caches.default at import time.
globalThis.caches = createCacheStorage({ maxBytes: 16 * 1024 * 1024 });
const worker = (await import('../worker/src/index.js')).default;
const env = buildEnv(createMemDriver(), { extra: { WATCHTOWER_REGISTER_ENABLED: 'true' } });
const ctx = { waitUntil: () => {} };

let pass = 0, fail = 0;
async function test(label, fn) {
  try { const ok = await fn(); if (ok) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; } }
  catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

const MAIN_SK = hexToBytes('11'.repeat(32));
const MAIN_PUB = secp.getPublicKey(MAIN_SK, true);
const SERVICE_SK = hexToBytes('22'.repeat(32));
const SERVICE_PUB = secp.getPublicKey(SERVICE_SK, true);
const ASSET = 'ab'.repeat(32);
const BID = 'cd'.repeat(16);
const h160 = (pub) => bytesToHex(ripemd160(sha256(pub)));

// dapp uses the loaded wallet for ensurePrivkey + signing.
dapp.wallet.priv = MAIN_SK;
dapp.wallet.pub = MAIN_PUB;

// ---- Part A: crypto parity (dapp <-> fulfiller) ----
await test('derive: dapp bid key == fulfiller bid key', () => {
  const a = dapp.deriveWatchtowerBidKey(MAIN_SK, ASSET, BID);
  const b = wtc.deriveBidPrivkey(MAIN_SK, ASSET, BID);
  return bytesToHex(a) === bytesToHex(b);
});

await test('encrypt: dapp ciphertext == fulfiller ciphertext', () => {
  const bk = wtc.deriveBidPrivkey(MAIN_SK, ASSET, BID);
  const a = dapp.encryptWatchtowerBidKey(bk, MAIN_SK, SERVICE_PUB, ASSET, BID);
  const b = wtc.encryptBidKeyToService(bk, MAIN_SK, SERVICE_PUB, ASSET, BID);
  return a === b && /^[0-9a-f]{64}$/.test(a);
});

await test('service key decrypts what the dapp encrypted (custody round-trip)', () => {
  const bk = dapp.deriveWatchtowerBidKey(MAIN_SK, ASSET, BID);
  const enc = dapp.encryptWatchtowerBidKey(bk, MAIN_SK, SERVICE_PUB, ASSET, BID);
  const rec = wtc.decryptBidKeyWithService(enc, SERVICE_SK, MAIN_PUB, ASSET, BID);
  return bytesToHex(rec) === bytesToHex(bk);
});

// ---- Part B: dapp-signed registration accepted by the worker ----
const bidKey = dapp.deriveWatchtowerBidKey(MAIN_SK, ASSET, BID);
const bidPub = secp.getPublicKey(bidKey, true);
const enc = dapp.encryptWatchtowerBidKey(bidKey, MAIN_SK, SERVICE_PUB, ASSET, BID);
const expiry = 2_000_000_000;
const regFields = {
  network: 'signet', assetIdHex: ASSET, bidIdHex: BID, bidPubHex: bytesToHex(bidPub),
  ownerPubHex: bytesToHex(MAIN_PUB), encBidPrivkeyHex: enc, bidPriceSats: 50000,
  bidAmountBaseStr: '1000', decimals: 0, expiry, fundingTxidHex: '11'.repeat(32), fundingVout: 0,
};
const regBody = {
  asset_id: ASSET, bid_id: BID, owner_pubkey: bytesToHex(MAIN_PUB), bid_pubkey: bytesToHex(bidPub),
  enc_bid_privkey: enc, bid_price_sats: 50000, bid_amount_base: '1000', decimals: 0, expiry,
  funding_outpoint: { txid: '11'.repeat(32), vout: 0 },
  auth_sig: bytesToHex(dapp.signSchnorr(dapp.watchtowerRegisterMsg(regFields), MAIN_SK)),
};
async function call(method, path, body) {
  const init = { method };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  const resp = await worker.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  let json; try { json = JSON.parse(await resp.text()); } catch { json = {}; }
  return { status: resp.status, json };
}

await test('worker ACCEPTS a registration signed with the dapp register message', async () => {
  const r = await call('POST', '/watchtower/bids?network=signet', regBody);
  return r.status === 200 && r.json.ok === true;
});

await test('a tampered field makes the dapp signature fail at the worker (403)', async () => {
  const r = await call('POST', '/watchtower/bids?network=signet', { ...regBody, bid_price_sats: 50001 });
  return r.status === 403;
});

await test('GET returns the stored registration (slimmed of the ciphertext key)', async () => {
  const r = await call('GET', `/watchtower/bids?network=signet&owner=${bytesToHex(MAIN_PUB)}`);
  return r.status === 200 && r.json.bids.length === 1
    && r.json.bids[0].bid_id === BID && r.json.bids[0].enc_bid_privkey === undefined;
});

await test('worker ACCEPTS a cancel signed with the dapp cancel message', async () => {
  const ownerH160 = h160(MAIN_PUB);
  const cancelSig = bytesToHex(dapp.signSchnorr(dapp.watchtowerCancelMsg('signet', ownerH160, BID), MAIN_SK));
  const r = await call('DELETE', `/watchtower/bids/${BID}?network=signet`, { owner_pubkey: bytesToHex(MAIN_PUB), cancel_sig: cancelSig });
  return r.status === 200 && r.json.ok === true;
});

console.log(`\n${pass + fail} tests, ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
