// Boundary tests for prfBytesToScalar in dapp/prf-wallet.js. Pins the four
// load-bearing branches of the deterministic guard so a future refactor of
// the rejection logic can't silently drop the recovery fallback.
//
// The PRF input per credential is constant — if a (vanishing) raw output of
// 0 or ≥ N is ever returned as-is, the user is wedged forever (same passkey
// will reproduce the same bad output, no retry path exists). These vectors
// fail loudly if that property is broken.
//
// jsdom shim mirrors dapp-parity.test.mjs — prf-wallet.js has top-level
// `new TextEncoder()` and a sha256() of a domain string, neither of which
// strictly needs DOM globals, but the vendor bundle expects them at
// import time on some Node versions.
//
// Run: `node prf-wallet.test.mjs`

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;

const { prfBytesToScalar } = await import('../dapp/prf-wallet.js');
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function bigintToBytes32(n) {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}
function isValidScalar(b) {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n > 0n && n < SECP_N;
}

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else             { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  FAIL  ${label} — ${e.message}`); fail++;
  }
}

console.log('prfBytesToScalar boundary vectors:');

// Valid scalars: returned unchanged so determinism is preserved for the
// 1 - 2⁻¹²⁸ of the input space that doesn't need reduction.
test('raw = 1 → returned unchanged', () => {
  const raw = bigintToBytes32(1n);
  const out = prfBytesToScalar(raw);
  return bytesToHex(out) === bytesToHex(raw) && isValidScalar(out);
});

test('raw = N - 1 (max valid) → returned unchanged', () => {
  const raw = bigintToBytes32(SECP_N - 1n);
  const out = prfBytesToScalar(raw);
  return bytesToHex(out) === bytesToHex(raw) && isValidScalar(out);
});

test('raw = some random valid scalar → returned unchanged', () => {
  const raw = hexToBytes('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
  const out = prfBytesToScalar(raw);
  return bytesToHex(out) === bytesToHex(raw) && isValidScalar(out);
});

// Invalid scalars: must be reduced via deterministic fallback. Output must
// never equal the bad input (would mean the guard didn't fire).
test('raw = 0 → reduced to a valid scalar', () => {
  const raw = new Uint8Array(32); // all-zero
  const out = prfBytesToScalar(raw);
  return isValidScalar(out) && bytesToHex(out) !== bytesToHex(raw);
});

test('raw = N (one past max) → reduced to a valid scalar', () => {
  const raw = bigintToBytes32(SECP_N);
  const out = prfBytesToScalar(raw);
  return isValidScalar(out) && bytesToHex(out) !== bytesToHex(raw);
});

test('raw = 2^256 - 1 (max 32-byte value, > N) → reduced to a valid scalar', () => {
  const raw = new Uint8Array(32).fill(0xff);
  const out = prfBytesToScalar(raw);
  return isValidScalar(out) && bytesToHex(out) !== bytesToHex(raw);
});

// Determinism: same input → same output (across calls). The fallback is a
// single sha256 with a fixed domain string, so reduced outputs are stable.
test('reduction is deterministic for raw = 0', () => {
  const raw = new Uint8Array(32);
  const a = prfBytesToScalar(raw);
  const b = prfBytesToScalar(new Uint8Array(32));
  return bytesToHex(a) === bytesToHex(b);
});

test('reduction is deterministic for raw = N', () => {
  const a = prfBytesToScalar(bigintToBytes32(SECP_N));
  const b = prfBytesToScalar(bigintToBytes32(SECP_N));
  return bytesToHex(a) === bytesToHex(b);
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
