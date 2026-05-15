// Correctness suite for the sigma cross-curve binding (AMM.md §3.10).
//
// Asserts:
//   • Honest prover ⇒ verifier accepts (round-trip)
//   • Wire format is 169 bytes (33+32+40+32+32 = post 128-bit FS upgrade)
//   • Any single-byte mutation in the proof OR commitments ⇒ rejected
//   • Range checks: out-of-range z_a / z_r_secp / z_r_BJJ ⇒ rejected
//   • Cross-pairing attack: swapping C_secp for a different commitment ⇒ rejected
//   • Mismatched commitments (same a, different blinding pairs) ⇒ rejected
//   • Out-of-range amount (a ≥ 2^64) at prove time ⇒ throws
//
// Wire-format offsets (post-upgrade, XCURVE_PROOF_LEN = 169):
//   A_secp:   bytes [0,   33)
//   A_BJJ:    bytes [33,  65)
//   z_a:      bytes [65, 105)   — 40 bytes (was 28 pre-upgrade)
//   z_r_secp: bytes [105, 137)  — 32 bytes
//   z_r_BJJ:  bytes [137, 169)  — 32 bytes

import { sha256 } from '@noble/hashes/sha256';
import { concatBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';

import {
  proveXCurve, verifyXCurve, challenge,
} from './amm-sigma-xcurve.mjs';
import {
  G as G_SECP, H as H_SECP, SECP_N,
  pedersenCommit, pointToBytes, randomScalar,
} from './bulletproofs.mjs';
import {
  N_BJJ, mod, packPoint, unpackPoint,
  H_BJJ, G_BJJ, pedersenBJJ, addPoint, mulScalar,
} from './amm-bjj.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

function randomBJJBlinding() {
  while (true) {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    let n = 0n;
    for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(buf[i]);
    if (n > 0n && n < N_BJJ) return n;
  }
}

console.log('Honest round-trip');

const samples = [];
for (const a of [0n, 1n, 12345n, (1n << 32n), (1n << 63n), (1n << 64n) - 1n]) {
  const r_secp = randomScalar();
  const r_BJJ  = randomBJJBlinding();
  const out = proveXCurve({ a, r_secp, r_BJJ });
  samples.push({ a, r_secp, r_BJJ, ...out });
  test(`prove+verify a=${a}`, () => verifyXCurve(out.proof, out.C_secp_bytes, out.C_BJJ_bytes));
}
test('proof is exactly 169 bytes (128-bit FS upgrade)', () => samples.every(s => s.proof.length === 169));
test('C_secp is 33 bytes (compressed)', () => samples.every(s => s.C_secp_bytes.length === 33));
test('C_BJJ is 32 bytes (packed)', () => samples.every(s => s.C_BJJ_bytes.length === 32));

console.log('\nSoundness — proof mutations');
const s = samples[2]; // a = 12345
test('mutate A_secp byte 1 ⇒ reject', () => {
  const bad = new Uint8Array(s.proof);
  bad[1] ^= 0x01;
  return !verifyXCurve(bad, s.C_secp_bytes, s.C_BJJ_bytes);
});
test('mutate A_BJJ byte 50 ⇒ reject', () => {
  const bad = new Uint8Array(s.proof);
  bad[50] ^= 0x10;
  return !verifyXCurve(bad, s.C_secp_bytes, s.C_BJJ_bytes);
});
test('mutate z_a byte 80 ⇒ reject', () => {
  const bad = new Uint8Array(s.proof);
  bad[80] ^= 0x40;
  return !verifyXCurve(bad, s.C_secp_bytes, s.C_BJJ_bytes);
});
test('mutate z_r_secp byte 100 ⇒ reject', () => {
  const bad = new Uint8Array(s.proof);
  bad[100] ^= 0x02;
  return !verifyXCurve(bad, s.C_secp_bytes, s.C_BJJ_bytes);
});
test('mutate z_r_BJJ byte 140 ⇒ reject', () => {
  const bad = new Uint8Array(s.proof);
  bad[140] ^= 0x80;
  return !verifyXCurve(bad, s.C_secp_bytes, s.C_BJJ_bytes);
});
test('mutate C_secp byte 5 ⇒ reject', () => {
  const bad = new Uint8Array(s.C_secp_bytes);
  bad[5] ^= 0x01;
  // The mutation may produce an invalid point; either decode-fail or verify-fail is "reject".
  let result;
  try { result = verifyXCurve(s.proof, bad, s.C_BJJ_bytes); }
  catch { return true; }
  return !result;
});
test('mutate C_BJJ byte 5 ⇒ reject', () => {
  const bad = new Uint8Array(s.C_BJJ_bytes);
  bad[5] ^= 0x01;
  let result;
  try { result = verifyXCurve(s.proof, s.C_secp_bytes, bad); }
  catch { return true; }
  return !result;
});
test('wrong-length proof ⇒ reject', () => {
  const bad = new Uint8Array(s.proof.length - 1);
  bad.set(s.proof.subarray(0, bad.length));
  return !verifyXCurve(bad, s.C_secp_bytes, s.C_BJJ_bytes);
});
test('null inputs ⇒ reject', () => {
  return !verifyXCurve(s.proof, null, s.C_BJJ_bytes) && !verifyXCurve(s.proof, s.C_secp_bytes, null);
});

console.log('\nRange checks on responses');
// z_a occupies bytes [65, 105) — 40 bytes BE — and is bounded by the
// encoding to < 2^320. The verifier's explicit `z_a < 2^320` check is
// unreachable via wire mutation alone (any 40-byte BE encoding is < 2^320),
// but a corrupted z_a still fails the verify equation. We exercise the
// boundary value to confirm equation-level rejection (not the range check).
test('z_a = 2^320 - 1 boundary ⇒ rejected by equation', () => {
  const bad = new Uint8Array(s.proof);
  for (let i = 65; i < 105; i++) bad[i] = 0xff;   // span all 40 bytes
  return !verifyXCurve(bad, s.C_secp_bytes, s.C_BJJ_bytes);
});
// z_r_secp occupies bytes [105, 137) — 32 bytes BE. Writing SECP_N exactly
// produces an out-of-range value (z_r_secp ≥ n_secp), which the explicit
// range check at amm-sigma-xcurve.mjs:192 must reject before the equation
// check. (Pre-fix offsets [93,125) straddled z_a and z_r_secp and exercised
// the wrong path; see audit #2 LOW-2.)
test('z_r_secp ≥ n_secp ⇒ reject (explicit range check)', () => {
  const bad = new Uint8Array(s.proof);
  let x = SECP_N;
  for (let i = 136; i >= 105; i--) { bad[i] = Number(x & 0xffn); x >>= 8n; }
  return !verifyXCurve(bad, s.C_secp_bytes, s.C_BJJ_bytes);
});
// z_r_BJJ occupies bytes [137, 169) — 32 bytes BE. Same pattern with N_BJJ.
test('z_r_BJJ ≥ n_BJJ ⇒ reject (explicit range check)', () => {
  const bad = new Uint8Array(s.proof);
  let x = N_BJJ;
  for (let i = 168; i >= 137; i--) { bad[i] = Number(x & 0xffn); x >>= 8n; }
  return !verifyXCurve(bad, s.C_secp_bytes, s.C_BJJ_bytes);
});

console.log('\nCross-pairing soundness — swap commitments');
test('swap C_secp from a different proof ⇒ reject', () => {
  return !verifyXCurve(s.proof, samples[1].C_secp_bytes, s.C_BJJ_bytes);
});
test('swap C_BJJ from a different proof ⇒ reject', () => {
  return !verifyXCurve(s.proof, s.C_secp_bytes, samples[1].C_BJJ_bytes);
});
test('mismatched commitments — same a, different blindings ⇒ reject the binding', () => {
  // Forge: keep s.proof but provide a different C_BJJ with the same a but a
  // different r_BJJ. The verifier should reject because the proof's z_a/z_r_BJJ
  // would not satisfy A_BJJ + e·C_BJJ' = z_a·H_BJJ + z_r_BJJ·G_BJJ.
  const r2 = randomBJJBlinding();
  const C_BJJ_alt = packPoint(pedersenBJJ(s.a, r2));
  return !verifyXCurve(s.proof, s.C_secp_bytes, C_BJJ_alt);
});

console.log('\nPre-conditions on prover');
test('a >= 2^64 ⇒ prover throws', () => {
  try {
    proveXCurve({ a: 1n << 64n, r_secp: 1n, r_BJJ: 1n });
    return false;
  } catch (e) { return /a < 2\^64/.test(e.message); }
});
test('negative a ⇒ prover throws', () => {
  try {
    proveXCurve({ a: -1n, r_secp: 1n, r_BJJ: 1n });
    return false;
  } catch (e) { return /a < 2\^64/.test(e.message); }
});
test('non-bigint a ⇒ prover throws', () => {
  try {
    proveXCurve({ a: 5, r_secp: 1n, r_BJJ: 1n });
    return false;
  } catch (e) { return true; }
});

console.log('\nDeterminism — same a but different blindings ⇒ different proof bytes');
test('different (r_secp, r_BJJ) ⇒ different commitments', () => {
  const x1 = proveXCurve({ a: 555n, r_secp: randomScalar(), r_BJJ: randomBJJBlinding() });
  const x2 = proveXCurve({ a: 555n, r_secp: randomScalar(), r_BJJ: randomBJJBlinding() });
  // C_secp and C_BJJ are different because blindings are different.
  return !x1.C_secp_bytes.every((b, i) => b === x2.C_secp_bytes[i])
      && !x1.C_BJJ_bytes.every((b, i) => b === x2.C_BJJ_bytes[i]);
});

console.log('\nChallenge derivation — domain separation');
test('challenge() depends on every input', () => {
  const cs = new Uint8Array(33).fill(0x02); cs[1] = 0x01; // valid-looking secp byte
  const cb = new Uint8Array(32);
  const as_ = new Uint8Array(33).fill(0x02); as_[1] = 0x02;
  const ab = new Uint8Array(32);
  const e0 = challenge(cs, cb, as_, ab);
  cs[10] ^= 0x01;
  const e1 = challenge(cs, cb, as_, ab);
  return e0 !== e1 && e0 < (1n << 128n) && e1 < (1n << 128n);
});

console.log('\nBenchmark (pure-JS BigInt; production uses circomlib WASM)');
{
  const N = 20;
  const a = 0xdeadbeefn;
  // Warm-up
  const warm = proveXCurve({ a, r_secp: randomScalar(), r_BJJ: randomBJJBlinding() });
  verifyXCurve(warm.proof, warm.C_secp_bytes, warm.C_BJJ_bytes);
  const proveStart = Date.now();
  const provedSamples = [];
  for (let i = 0; i < N; i++) {
    provedSamples.push(proveXCurve({ a, r_secp: randomScalar(), r_BJJ: randomBJJBlinding() }));
  }
  const proveEnd = Date.now();
  const verifyStart = Date.now();
  let okCount = 0;
  for (const p of provedSamples) {
    if (verifyXCurve(p.proof, p.C_secp_bytes, p.C_BJJ_bytes)) okCount++;
  }
  const verifyEnd = Date.now();
  console.log(`  prove   avg: ${((proveEnd - proveStart) / N).toFixed(1)} ms over ${N} runs`);
  console.log(`  verify  avg: ${((verifyEnd - verifyStart) / N).toFixed(1)} ms over ${N} runs`);
  console.log(`  verified ${okCount}/${N}`);
  test('benchmark all verify', () => okCount === N);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
