// Unit tests for the hosted-watchtower key custody (fulfiller/watchtower-crypto.mjs).
//
// Pins: (1) the dedicated bid key derives deterministically from the buyer's
// main key; (2) the symmetric ECDH encrypt-to-service round-trips
// (client encrypt with mainPriv→servicePub == server decrypt with
// servicePriv→ownerPub); (3) the decrypted scalar is range-checked; (4) a wrong
// service key / tampered ciphertext does NOT recover the original key (the
// watchtower's pubkey cross-check then rejects it).
//
// Run: `node tests/watchtower-crypto.test.mjs`

import {
  deriveBidPrivkey, encryptBidKeyToService, decryptBidKeyWithService,
  pubkeyFor, servicePubFromSk,
} from '../fulfiller/watchtower-crypto.mjs';
import * as secp from '../fulfiller/node_modules/@noble/secp256k1/index.js';
import { hexToBytes, bytesToHex } from '../fulfiller/node_modules/@noble/hashes/utils.js';

let pass = 0, fail = 0;
function test(label, fn) {
  try { const ok = fn(); if (ok) { console.log(`  PASS  ${label}`); pass++; } else { console.log(`  FAIL  ${label}`); fail++; } }
  catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

// Deterministic test keys (no randomness so the run is reproducible).
const MAIN_SK    = hexToBytes('11'.repeat(32));
const SERVICE_SK = hexToBytes('22'.repeat(32));
const MAIN_PUB    = secp.getPublicKey(MAIN_SK, true);
const SERVICE_PUB = secp.getPublicKey(SERVICE_SK, true);
const ASSET_ID = 'ab'.repeat(32);
const BID_ID   = 'cd'.repeat(16);

test('bid key derives deterministically from the main key', () => {
  const a = deriveBidPrivkey(MAIN_SK, ASSET_ID, BID_ID);
  const b = deriveBidPrivkey(MAIN_SK, ASSET_ID, BID_ID);
  return a.length === 32 && bytesToHex(a) === bytesToHex(b);
});

test('different bid_id / asset_id derive different keys', () => {
  const base = bytesToHex(deriveBidPrivkey(MAIN_SK, ASSET_ID, BID_ID));
  const diffBid = bytesToHex(deriveBidPrivkey(MAIN_SK, ASSET_ID, 'ce'.repeat(16)));
  const diffAsset = bytesToHex(deriveBidPrivkey(MAIN_SK, 'ac'.repeat(32), BID_ID));
  return base !== diffBid && base !== diffAsset;
});

test('derived key is a valid secp256k1 scalar (usable pubkey)', () => {
  const k = deriveBidPrivkey(MAIN_SK, ASSET_ID, BID_ID);
  const pub = pubkeyFor(k);
  return pub.length === 33 && (pub[0] === 0x02 || pub[0] === 0x03);
});

test('encrypt-to-service round-trips (client→server) and recovers the bid key', () => {
  const bidPriv = deriveBidPrivkey(MAIN_SK, ASSET_ID, BID_ID);
  // client: encrypt with main priv -> service pub
  const enc = encryptBidKeyToService(bidPriv, MAIN_SK, SERVICE_PUB, ASSET_ID, BID_ID);
  // server: decrypt with service priv -> owner (main) pub
  const dec = decryptBidKeyWithService(enc, SERVICE_SK, MAIN_PUB, ASSET_ID, BID_ID);
  return bytesToHex(dec) === bytesToHex(bidPriv);
});

test('ciphertext is not the plaintext (XOR keystream actually applied)', () => {
  const bidPriv = deriveBidPrivkey(MAIN_SK, ASSET_ID, BID_ID);
  const enc = encryptBidKeyToService(bidPriv, MAIN_SK, SERVICE_PUB, ASSET_ID, BID_ID);
  return enc !== bytesToHex(bidPriv) && /^[0-9a-f]{64}$/.test(enc);
});

test('decrypted pubkey matches the registered bid_pubkey (the integrity cross-check)', () => {
  const bidPriv = deriveBidPrivkey(MAIN_SK, ASSET_ID, BID_ID);
  const bidPub = bytesToHex(pubkeyFor(bidPriv));            // what the record stores
  const enc = encryptBidKeyToService(bidPriv, MAIN_SK, SERVICE_PUB, ASSET_ID, BID_ID);
  const dec = decryptBidKeyWithService(enc, SERVICE_SK, MAIN_PUB, ASSET_ID, BID_ID);
  return bytesToHex(pubkeyFor(dec)) === bidPub;
});

test('wrong service key recovers a DIFFERENT key (cross-check would reject)', () => {
  const bidPriv = deriveBidPrivkey(MAIN_SK, ASSET_ID, BID_ID);
  const bidPub = bytesToHex(pubkeyFor(bidPriv));
  const enc = encryptBidKeyToService(bidPriv, MAIN_SK, SERVICE_PUB, ASSET_ID, BID_ID);
  const wrongSvc = hexToBytes('33'.repeat(32));
  let recoveredPub;
  try { recoveredPub = bytesToHex(pubkeyFor(decryptBidKeyWithService(enc, wrongSvc, MAIN_PUB, ASSET_ID, BID_ID))); }
  catch { return true; } // out-of-range scalar is also an acceptable rejection
  return recoveredPub !== bidPub;
});

test('tampered ciphertext does not recover the bid key', () => {
  const bidPriv = deriveBidPrivkey(MAIN_SK, ASSET_ID, BID_ID);
  const enc = encryptBidKeyToService(bidPriv, MAIN_SK, SERVICE_PUB, ASSET_ID, BID_ID);
  const tampered = (enc.slice(0, 2) === 'ff' ? '00' : 'ff') + enc.slice(2);
  let dec;
  try { dec = bytesToHex(decryptBidKeyWithService(tampered, SERVICE_SK, MAIN_PUB, ASSET_ID, BID_ID)); }
  catch { return true; }
  return dec !== bytesToHex(bidPriv);
});

test('servicePubFromSk matches getPublicKey', () => {
  return servicePubFromSk(SERVICE_SK) === bytesToHex(SERVICE_PUB);
});

console.log(`\n${pass + fail} tests, ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
