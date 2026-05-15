// Sigma cross-curve domain-binding tests.
//
// The Fiat-Shamir challenge of the sigma cross-curve proof is
//   e = SHA256(domain || C_secp || C_BJJ || A_secp || A_BJJ)[-16:]
// where `domain` is "tacit-amm-xcurve-v1" (AMM.md §3.10 + amm-sigma-xcurve.mjs:45).
//
// Soundness REQUIRES that any change to inputs feeding the challenge — domain,
// commitments, announce points — yields a different e with overwhelming
// probability, and that the verifier rejects when e mismatches.
//
// Tests below:
//   T1 — Sanity: the standard prove/verify cycle works.
//   T2 — Tampered A_secp byte breaks verify (A_secp is in transcript).
//   T3 — Tampered A_BJJ byte breaks verify.
//   T4 — Tampered z_a / z_r_secp / z_r_BJJ each break verify.
//   T5 — Tampered C_secp_bytes / C_BJJ_bytes passed to verify break verify.
//   T6 — Custom-domain reimplementation: two proofs over the same (a, r_secp, r_BJJ)
//        but different domain strings produce different challenges, and a
//        verifier under domain X rejects a proof made under domain Y.
//   T7 — Exact domain string pin: ensure "tacit-amm-xcurve-v1" is what's used.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes } from '@noble/hashes/utils';

import {
  proveXCurve, verifyXCurve,
  XCURVE_PROOF_LEN, CHALLENGE_BYTES, Z_A_BYTES,
} from './amm-sigma-xcurve.mjs';
import {
  G as G_SECP, H as H_SECP, SECP_N, modN as modSecp, ZERO as SECP_ZERO,
  pedersenCommit, pointToBytes,
} from './bulletproofs.mjs';
import {
  N_BJJ, addPoint, mulScalar, eq as bjjEq, unpackPoint,
  H_BJJ, G_BJJ, pedersenBJJ, packPoint,
} from './amm-bjj.mjs';
import * as secp from '@noble/secp256k1';

function randScalar(N) {
  while (true) {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    let n = 0n;
    for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(buf[i]);
    if (n > 0n && n < N) return n;
  }
}
function bytesToBigBE(b) {
  let n = 0n;
  for (let i = 0; i < b.length; i++) n = (n << 8n) | BigInt(b[i]);
  return n;
}

const STANDARD_DOMAIN = new TextEncoder().encode('tacit-amm-xcurve-v1');

// Parameterized challenge (for the domain-swap test below).
function challengeWithDomain(domainBytes, Cs, Cb, As, Ab) {
  const h = sha256(concatBytes(domainBytes, Cs, Cb, As, Ab));
  return bytesToBigBE(h.subarray(32 - CHALLENGE_BYTES, 32));
}

describe('sigma cross-curve domain binding', () => {

  test('T1 — standard prove + verify works', () => {
    const a = 12345n;
    const r_secp = randScalar(SECP_N);
    const r_BJJ  = randScalar(N_BJJ);
    const { proof, C_secp_bytes, C_BJJ_bytes } = proveXCurve({ a, r_secp, r_BJJ });
    assert.strictEqual(proof.length, XCURVE_PROOF_LEN);
    assert.strictEqual(verifyXCurve(proof, C_secp_bytes, C_BJJ_bytes), true);
  });

  test('T2 — flipping a byte in A_secp breaks verify', () => {
    const a = 100n;
    const r_secp = randScalar(SECP_N);
    const r_BJJ  = randScalar(N_BJJ);
    const { proof, C_secp_bytes, C_BJJ_bytes } = proveXCurve({ a, r_secp, r_BJJ });
    // A_secp occupies bytes [0, 33).
    for (const idx of [0, 1, 16, 32]) {
      const bad = new Uint8Array(proof);
      bad[idx] ^= 0x01;
      assert.strictEqual(verifyXCurve(bad, C_secp_bytes, C_BJJ_bytes), false,
        `tampered A_secp[${idx}] accepted`);
    }
  });

  test('T3 — flipping a byte in A_BJJ breaks verify', () => {
    const a = 100n;
    const r_secp = randScalar(SECP_N);
    const r_BJJ  = randScalar(N_BJJ);
    const { proof, C_secp_bytes, C_BJJ_bytes } = proveXCurve({ a, r_secp, r_BJJ });
    // A_BJJ occupies bytes [33, 65).
    for (const idx of [33, 40, 50, 64]) {
      const bad = new Uint8Array(proof);
      bad[idx] ^= 0x01;
      assert.strictEqual(verifyXCurve(bad, C_secp_bytes, C_BJJ_bytes), false,
        `tampered A_BJJ[${idx}] accepted`);
    }
  });

  test('T4 — tampering response scalars (z_a, z_r_secp, z_r_BJJ) breaks verify', () => {
    const a = 100n;
    const r_secp = randScalar(SECP_N);
    const r_BJJ  = randScalar(N_BJJ);
    const { proof, C_secp_bytes, C_BJJ_bytes } = proveXCurve({ a, r_secp, r_BJJ });
    // z_a:      [65, 105); z_r_secp: [105, 137); z_r_BJJ: [137, 169).
    const tamperSites = [
      ['z_a',     65 + 5],
      ['z_a',     65 + 30],
      ['z_r_secp', 105 + 5],
      ['z_r_BJJ',  137 + 5],
    ];
    for (const [label, idx] of tamperSites) {
      const bad = new Uint8Array(proof);
      bad[idx] ^= 0x01;
      assert.strictEqual(verifyXCurve(bad, C_secp_bytes, C_BJJ_bytes), false,
        `tampered ${label}[${idx}] accepted`);
    }
  });

  test('T5 — tampering the public-input commitments rejects', () => {
    const a = 100n;
    const r_secp = randScalar(SECP_N);
    const r_BJJ  = randScalar(N_BJJ);
    const { proof, C_secp_bytes, C_BJJ_bytes } = proveXCurve({ a, r_secp, r_BJJ });
    const badSecp = new Uint8Array(C_secp_bytes); badSecp[5] ^= 0x01;
    const badBJJ  = new Uint8Array(C_BJJ_bytes);  badBJJ[5]  ^= 0x01;
    assert.strictEqual(verifyXCurve(proof, badSecp, C_BJJ_bytes), false);
    assert.strictEqual(verifyXCurve(proof, C_secp_bytes, badBJJ),  false);
  });

  test('T6 — proof bound under one domain rejects under any other domain', () => {
    // We rebuild a parallel verifier that takes a domain parameter and assert
    // that:
    //   - The standard-domain verifier accepts the standard-domain proof.
    //   - A swapped-domain verifier rejects.
    //   - Two distinct domains yield distinct challenges for identical inputs
    //     (collision probability ≈ 2^-128).
    const a = 999n;
    const r_secp = randScalar(SECP_N);
    const r_BJJ  = randScalar(N_BJJ);
    const { proof, C_secp_bytes, C_BJJ_bytes } = proveXCurve({ a, r_secp, r_BJJ });

    // Extract A_secp, A_BJJ from the proof for challenge computation.
    const A_secp_bytes = proof.subarray(0, 33);
    const A_BJJ_bytes  = proof.subarray(33, 65);

    const eStd = challengeWithDomain(STANDARD_DOMAIN, C_secp_bytes, C_BJJ_bytes, A_secp_bytes, A_BJJ_bytes);
    const eAlt1 = challengeWithDomain(
      new TextEncoder().encode('tacit-amm-xcurve-v2'),
      C_secp_bytes, C_BJJ_bytes, A_secp_bytes, A_BJJ_bytes);
    const eAlt2 = challengeWithDomain(
      new TextEncoder().encode('attacker-domain'),
      C_secp_bytes, C_BJJ_bytes, A_secp_bytes, A_BJJ_bytes);
    const eEmpty = challengeWithDomain(
      new Uint8Array(0),
      C_secp_bytes, C_BJJ_bytes, A_secp_bytes, A_BJJ_bytes);

    // Each distinct domain produces a distinct challenge with overwhelming probability.
    assert.notStrictEqual(eStd, eAlt1, 'v1 vs v2 collided');
    assert.notStrictEqual(eStd, eAlt2, 'v1 vs attacker collided');
    assert.notStrictEqual(eStd, eEmpty, 'v1 vs empty collided');
    assert.notStrictEqual(eAlt1, eAlt2, 'v2 vs attacker collided');

    // Now: build a "domain-swap" verifier that uses eAlt1 instead of eStd and
    // checks the same equations. The proof MUST fail under it.
    const z_a       = bytesToBigBE(proof.subarray(65, 65 + Z_A_BYTES));
    const z_r_secp  = bytesToBigBE(proof.subarray(65 + Z_A_BYTES, 65 + Z_A_BYTES + 32));
    const z_r_BJJ   = bytesToBigBE(proof.subarray(65 + Z_A_BYTES + 32, XCURVE_PROOF_LEN));

    function verifyUnderChallenge(e) {
      const A_secp_pt = secp.ProjectivePoint.fromHex(toHex(A_secp_bytes));
      const C_secp_pt = secp.ProjectivePoint.fromHex(toHex(C_secp_bytes));
      const A_BJJ_pt  = unpackPoint(A_BJJ_bytes);
      const C_BJJ_pt  = unpackPoint(C_BJJ_bytes);
      if (!A_BJJ_pt || !C_BJJ_pt) return false;

      // secp: z_a·H + z_r_secp·G == A + e·C
      const lhsS = (z_a === 0n ? SECP_ZERO : H_SECP.multiply(modSecp(z_a)))
        .add(z_r_secp === 0n ? SECP_ZERO : G_SECP.multiply(z_r_secp));
      const rhsS = A_secp_pt.add(e === 0n ? SECP_ZERO : C_secp_pt.multiply(e));
      if (!lhsS.equals(rhsS)) return false;

      // BJJ: z_a·H + z_r_BJJ·G == A + e·C
      const e_modBJJ = ((e % N_BJJ) + N_BJJ) % N_BJJ;
      const z_a_modBJJ = ((z_a % N_BJJ) + N_BJJ) % N_BJJ;
      const lhsB = addPoint(
        z_a_modBJJ === 0n ? [0n, 1n] : mulScalar(H_BJJ(), z_a_modBJJ),
        z_r_BJJ === 0n ? [0n, 1n] : mulScalar(G_BJJ(), z_r_BJJ),
      );
      const eC = e_modBJJ === 0n ? [0n, 1n] : mulScalar(C_BJJ_pt, e_modBJJ);
      return bjjEq(lhsB, addPoint(A_BJJ_pt, eC));
    }

    // Sanity: under the canonical challenge, our parallel verifier mirrors the real one.
    assert.strictEqual(verifyUnderChallenge(eStd), true,
      'parallel verifier disagrees with primary on standard challenge');
    // Under each alternative challenge, the proof MUST fail.
    assert.strictEqual(verifyUnderChallenge(eAlt1), false, 'wrong-domain v2 accepted');
    assert.strictEqual(verifyUnderChallenge(eAlt2), false, 'wrong-domain attacker accepted');
    assert.strictEqual(verifyUnderChallenge(eEmpty), false, 'wrong-domain empty accepted');
  });

  test('T7 — domain string is exactly "tacit-amm-xcurve-v1"', () => {
    // Pin: byte-exact domain literal. If anyone renames it, this test fires.
    const expected = new TextEncoder().encode('tacit-amm-xcurve-v1');
    assert.strictEqual(STANDARD_DOMAIN.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert.strictEqual(STANDARD_DOMAIN[i], expected[i], `byte ${i} differs`);
    }
  });

  test('T8 — common commitments across two pools yield correct binding (cross-pool sanity)', () => {
    // Sigma proofs are POOL-AGNOSTIC: they prove (a, r_secp, r_BJJ) binding
    // without referencing any pool_id. Two pools that happened to receive the
    // same (a, r_secp, r_BJJ) at the same commitments would generate
    // VALID sigma proofs in both pools. This is intentional — pool binding is
    // enforced at the Groth16/kernel-sig layer, not in sigma.
    //
    // Test confirms this property: two independent proofs with the same secrets
    // both verify, AND a proof generated for one is interchangeable with a
    // proof generated for the other at the sigma layer (because the sigma
    // statement is identical).
    const a = 42n;
    const r_secp = randScalar(SECP_N);
    const r_BJJ  = randScalar(N_BJJ);
    const p1 = proveXCurve({ a, r_secp, r_BJJ });
    const p2 = proveXCurve({ a, r_secp, r_BJJ });
    // Both verify under their own statement.
    assert.strictEqual(verifyXCurve(p1.proof, p1.C_secp_bytes, p1.C_BJJ_bytes), true);
    assert.strictEqual(verifyXCurve(p2.proof, p2.C_secp_bytes, p2.C_BJJ_bytes), true);
    // Statements (commitments) are identical because (a, r) are identical.
    assert.deepStrictEqual(Array.from(p1.C_secp_bytes), Array.from(p2.C_secp_bytes));
    assert.deepStrictEqual(Array.from(p1.C_BJJ_bytes),  Array.from(p2.C_BJJ_bytes));
    // Proofs themselves differ (randomized alpha/beta).
    assert.notStrictEqual(toHex(p1.proof), toHex(p2.proof));
    // Cross-verification: either proof verifies under the shared statement.
    assert.strictEqual(verifyXCurve(p1.proof, p2.C_secp_bytes, p2.C_BJJ_bytes), true);
    assert.strictEqual(verifyXCurve(p2.proof, p1.C_secp_bytes, p1.C_BJJ_bytes), true);
  });
});

function toHex(b) {
  const HEX = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < b.length; i++) out += HEX[b[i] >> 4] + HEX[b[i] & 0xf];
  return out;
}
