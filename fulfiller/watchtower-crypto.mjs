// Key custody for the hosted watchtower.
//
// The dedicated bid key is the only thing the watchtower can spend, and it
// must never cross the wire or rest in the DB as cleartext. Two primitives:
//
//   1. derive — the buyer derives the dedicated key deterministically from
//      their MAIN key (so it survives a localStorage wipe; reclaim is always
//      re-derivable). The main key is never shared.
//   2. encrypt-to-service — the buyer encrypts the dedicated key to the
//      watchtower SERVICE pubkey using a symmetric ECDH keystream:
//        client: ECDH(mainPriv, servicePub)  ==  server: ECDH(servicePriv, ownerPub)
//      No ephemeral needed — both sides hold a stable keypair and the buyer's
//      main pubkey rides in the (signed) registration record. The API and KV
//      only ever see ciphertext; the cleartext exists only in-process in the
//      Render worker while it signs a take.
//
// Integrity: the registration record's `bid_pubkey` is covered by the buyer's
// main-key auth signature, and the watchtower cross-checks the decrypted key's
// pubkey against it — a tampered ciphertext yields a key whose pubkey differs,
// and the bid is skipped. So no separate MAC is needed on the XOR.
//
// The dapp adds a byte-identical client-side encrypt; a parity test pins it
// against this module (the canonical implementation).

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

// secp256k1 group order.
const SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const te = new TextEncoder();
const DERIVE_TAG = te.encode('tacit-watchtower-bid-key-v1');
const ENC_TAG = te.encode('tacit-watchtower-enc-v1');

function bytesToBig(b) { return BigInt('0x' + bytesToHex(b)); }
function bigTo32(n) {
  let h = n.toString(16); if (h.length > 64) throw new Error('scalar overflow'); h = h.padStart(64, '0');
  return hexToBytes(h);
}
function asBytes32(hexOrBytes, label) {
  const b = typeof hexOrBytes === 'string' ? hexToBytes(hexOrBytes.toLowerCase()) : hexOrBytes;
  if (b.length !== 32) throw new Error(`${label} must be 32 bytes`);
  return b;
}
function asBytes16(hexOrBytes, label) {
  const b = typeof hexOrBytes === 'string' ? hexToBytes(hexOrBytes.toLowerCase()) : hexOrBytes;
  if (b.length !== 16) throw new Error(`${label} must be 16 bytes`);
  return b;
}
function xor32(a, b) {
  const o = new Uint8Array(32);
  for (let i = 0; i < 32; i++) o[i] = a[i] ^ b[i];
  return o;
}

// Deterministic dedicated bid key from the buyer's main key. Re-derivable by
// the buyer (same inputs) so reclaim never depends on stored state.
export function deriveBidPrivkey(mainPriv, assetIdHex, bidIdHex) {
  const m = asBytes32(mainPriv, 'mainPriv');
  const a = asBytes32(assetIdHex, 'asset_id');
  const id = asBytes16(bidIdHex, 'bid_id');
  const h = sha256(concatBytes(DERIVE_TAG, m, a, id));
  // Map the hash into [1, N-1] without modulo bias concerns mattering for a
  // 256-bit hash over a ~256-bit order: reduce, then shift 0 -> 1.
  let s = bytesToBig(h) % SECP_N;
  if (s === 0n) s = 1n;
  return bigTo32(s);
}

// Symmetric ECDH keystream between two stable keypairs. The compressed shared
// point's x-coordinate is the secret; binding asset_id + bid_id domain-
// separates per registration.
function encKeystream(localPriv, remotePub, assetIdHex, bidIdHex) {
  const priv = asBytes32(localPriv, 'priv');
  const pub = typeof remotePub === 'string' ? hexToBytes(remotePub.toLowerCase()) : remotePub;
  if (pub.length !== 33) throw new Error('remotePub must be 33-byte compressed');
  const shared = secp.getSharedSecret(priv, pub, true); // 33-byte compressed point
  const x = shared.slice(1, 33);
  const a = asBytes32(assetIdHex, 'asset_id');
  const id = asBytes16(bidIdHex, 'bid_id');
  return sha256(concatBytes(ENC_TAG, x, a, id));
}

// Client side: encrypt the dedicated key to the service pubkey.
export function encryptBidKeyToService(bidPriv, mainPriv, servicePub, assetIdHex, bidIdHex) {
  const ks = encKeystream(mainPriv, servicePub, assetIdHex, bidIdHex);
  return bytesToHex(xor32(asBytes32(bidPriv, 'bidPriv'), ks));
}

// Server side: recover the dedicated key. ownerPub is the buyer's main pubkey
// from the (signed) registration record. Validates the result is a usable
// scalar; the caller additionally cross-checks the derived pubkey == bid_pubkey.
export function decryptBidKeyWithService(encHex, servicePriv, ownerPub, assetIdHex, bidIdHex) {
  const ct = asBytes32(encHex, 'enc_bid_privkey');
  const ks = encKeystream(servicePriv, ownerPub, assetIdHex, bidIdHex);
  const pt = xor32(ct, ks);
  const s = bytesToBig(pt);
  if (s <= 0n || s >= SECP_N) throw new Error('decrypted bid key out of scalar range [1, N)');
  return pt;
}

export function pubkeyFor(priv) {
  return secp.getPublicKey(asBytes32(priv, 'priv'), true);
}

// Service keypair helper: the service pubkey is published in the dapp config;
// the private key lives only in WATCHTOWER_SERVICE_SK on the Render worker.
export function servicePubFromSk(servicePriv) {
  return bytesToHex(secp.getPublicKey(asBytes32(servicePriv, 'servicePriv'), true));
}
