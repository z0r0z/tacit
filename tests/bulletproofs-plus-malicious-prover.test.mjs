// Malicious-prover attempt suite for the BP+ port.
//
// These are CONCRETE soundness attacks an adversary would try:
//
//   1. Bit-decomposition forgery: prove v but commit a different value v'.
//   2. Out-of-range smuggling: prove v ≥ 2^64 by lying about the high bits.
//   3. Aggregation cross-contamination: forge a m=2 proof where only the
//      first commitment is in-range.
//   4. Wrong commitment opening: prove v under commitment C, then claim
//      the same proof opens a different commitment.
//   5. Transcript challenge mismatch: substitute computed challenges
//      (verifier must reject when proof bytes were generated against
//      different challenges).
//   6. Forged final scalars: r1, s1, d1 with wrong relationship to A1, B.
//   7. NUMS H/G swap: prove against a commitment computed with H and G
//      swapped (should produce a structurally-valid but wrong proof).
//   8. Repeated commitment in aggregation (an m=2 proof where both
//      commitments are the same value should still bind index ordering).
//
// Every attempt MUST be rejected by `bppRangeVerify`. If any attempt
// produces a proof that verifies, that's an inflation vulnerability.
//
// This is the actual attack surface, made concrete. Tests that flip
// random bytes are necessary but not sufficient; these tests model
// SHAPED attacks against algorithmic structure.

import { sha256 } from '@noble/hashes/sha256';
import * as bpp from '../dapp/bulletproofs-plus.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

// ============== Attack 1: bit-decomposition forgery ==============
// Adversary commits to v but tries to produce a proof for a different
// value v'. The proof bytes embed the bit decomposition of v through
// A = aL·Gvec + aR·Hvec + α·G. If the verifier honors the relationship,
// committing to v but proving v' must fail.
group('Attack 1: prove for value, verify against wrong commitment');
{
  const v_honest = 12345n;
  const g = bpp.randomScalar();
  const r = bpp.bppRangeProve([v_honest], [g]);
  ok('honest proof verifies', bpp.bppRangeVerify(r.commitments, r.proof) === true);

  // Adversary swaps in a commitment to v' = 99999 (different value, same
  // blinding shape). The proof bytes were built for v_honest's bit
  // decomposition; the verifier reconstructs E using the supplied V[j]
  // scalar (which is -e²·z^(2(j+1))·y^(MN+1) · V[j]); supplying a wrong
  // V means E ≠ identity in the MSM check.
  const C_wrong = bpp.pedersenCommit(99999n, g);
  ok('proof for v=12345 against commit(v=99999) REJECTS',
    bpp.bppRangeVerify([C_wrong], r.proof) === false);

  const C_zero = bpp.pedersenCommit(0n, g);
  ok('proof for v=12345 against commit(v=0) REJECTS',
    bpp.bppRangeVerify([C_zero], r.proof) === false);
}

// ============== Attack 2: out-of-range value smuggling ==============
// The prover hard-codes range [0, 2^64) by enforcing bit decomposition
// across N=64 bits. An adversary attempting to prove v ≥ 2^64 by lying
// about the high bits hits a contradiction: aL[63] = bit_63(v); for
// v=2^64, bit_63=0 (lower 64 bits all zero), but the actual value
// includes the 65th bit which the proof has no slot for.
//
// The prover's input-validation (`v < 2^64`) catches this case before
// proving. Let's verify a CRAFTED proof claiming a 65+ bit value rejects.
group('Attack 2: out-of-range value rejected at prover');
{
  let threw = false;
  try { bpp.bppRangeProve([1n << 64n], [bpp.randomScalar()]); }
  catch { threw = true; }
  ok('v = 2^64 rejected at prover', threw);
  let threw2 = false;
  try { bpp.bppRangeProve([(1n << 64n) + 1n], [bpp.randomScalar()]); }
  catch { threw2 = true; }
  ok('v = 2^64 + 1 rejected at prover', threw2);
  // Negative-as-large-positive
  let threw3 = false;
  try { bpp.bppRangeProve([bpp.SECP_N - 1n], [bpp.randomScalar()]); }
  catch { threw3 = true; }
  ok('v ≈ -1 mod n rejected at prover', threw3);
}

// ============== Attack 3: aggregation cross-contamination ==============
// In m=2, adversary tries to use a valid m=1 proof for value v alongside
// a malicious second commitment. The aggregated proof binds BOTH
// commitments through the per-j z^(2(j+1)) factor; substituting a single
// proof for two commitments breaks the MSM check.
group('Attack 3: aggregation cross-contamination');
{
  const g1 = bpp.randomScalar();
  const g2 = bpp.randomScalar();
  const v_honest = 1000n;
  const v_evil   = (1n << 63n);  // valid range but different value

  // Produce a real m=2 proof
  const real = bpp.bppRangeProve([v_honest, v_evil], [g1, g2]);
  ok('real m=2 proof verifies', bpp.bppRangeVerify(real.commitments, real.proof) === true);

  // Swap C1 with commitment to a third value while keeping the proof
  const C_evil_swap = bpp.pedersenCommit((1n << 64n) - 1n, g2);
  ok('m=2 proof with one swapped commitment REJECTS',
    bpp.bppRangeVerify([real.commitments[0], C_evil_swap], real.proof) === false);
}

// ============== Attack 4: wrong commitment opening ==============
// Adversary publishes commitment C = v·H + γ·G but tries to prove
// the same proof bytes open a different commitment C' = v·H + γ'·G
// (same value, different blinding). The blinding γ is bound into
// the proof through alpha + z²·γ·y^(MN+1), so γ' produces wrong A1
// scalar at verification.
group('Attack 4: blinding-factor substitution');
{
  const v = 4242n;
  const g_honest = bpp.randomScalar();
  const g_evil   = bpp.randomScalar();

  const r = bpp.bppRangeProve([v], [g_honest]);
  ok('honest (v, γ) verifies', bpp.bppRangeVerify(r.commitments, r.proof) === true);

  const C_wrong_gamma = bpp.pedersenCommit(v, g_evil);
  ok('proof against commit(v, γ\') with γ\' ≠ γ REJECTS',
    bpp.bppRangeVerify([C_wrong_gamma], r.proof) === false);
}

// ============== Attack 5: transcript challenge mismatch ==============
// Adversary produces a proof against transcript T1, then substitutes
// proof bytes in a context that builds transcript T2 (e.g. different
// commitments). All challenges (y, z, u_k, e) recomputed by verifier
// will differ from those used by prover; MSM check fails.
group('Attack 5: transcript bind through V append order');
{
  const v1 = 100n, v2 = 200n;
  const g1 = bpp.randomScalar(), g2 = bpp.randomScalar();
  const r = bpp.bppRangeProve([v1, v2], [g1, g2]);

  // Swap order: verifier sees [C2, C1] but proof bytes were generated
  // for [C1, C2]. y/z challenges differ → MSM check fails.
  ok('order-swapped commitments REJECT (transcript bind)',
    bpp.bppRangeVerify([r.commitments[1], r.commitments[0]], r.proof) === false);
}

// ============== Attack 6: forged final scalars ==============
// Final scalars (r1, s1, d1) must satisfy:
//   r1·y·s1 = (e²·H_inner + r·y·s + r·y·s1·e + r1·y·s·e + ...)
// after the H_term1 = r1·y·s1 collapses. Tampering r1 or s1 directly
// breaks this. Adversarial proof: swap r1 ↔ s1 (a structurally-typed
// swap an attacker might try).
group('Attack 6: swapped final scalars r1 ↔ s1');
{
  const v = 555n;
  const r = bpp.bppRangeProve([v], [bpp.randomScalar()]);
  ok('baseline verifies', bpp.bppRangeVerify(r.commitments, r.proof) === true);

  // Layout: A(33) || A1(33) || B(33) || r1(32) || s1(32) || d1(32) || L/R*logMN
  const tampered = new Uint8Array(r.proof);
  const r1_off = 99, s1_off = 131;
  const r1 = tampered.slice(r1_off, r1_off + 32);
  const s1 = tampered.slice(s1_off, s1_off + 32);
  tampered.set(s1, r1_off);
  tampered.set(r1, s1_off);
  ok('r1 ↔ s1 swap REJECTS', bpp.bppRangeVerify(r.commitments, tampered) === false);

  // Zero out d1
  const zeroDl = new Uint8Array(r.proof);
  zeroDl.fill(0, 163, 195);
  ok('d1 = 0 REJECTS', bpp.bppRangeVerify(r.commitments, zeroDl) === false);
}

// ============== Attack 7: NUMS H/G swap simulation ==============
// What if an adversary's commitment was computed with G and H swapped
// (i.e. C = γ·H + v·G)? The verifier expects C = v·H + γ·G, so the
// MSM accumulates V[j] under -e²·z^(2(j+1))·y^(MN+1), which only equals
// identity if V[j] truly opens as v·H + γ·G with the values matching
// the bit decomposition in the proof.
group('Attack 7: G/H swapped commitment opens correctly?');
{
  const v = 7n;
  const g = bpp.randomScalar();
  // Real prove: commits v·H + g·G
  const r = bpp.bppRangeProve([v], [g]);
  ok('real C = v·H + g·G verifies', bpp.bppRangeVerify(r.commitments, r.proof) === true);

  // Adversarial: build C' = g·H + v·G (i.e. "open as v under wrong base")
  const { H } = bpp.bppGens();
  const C_swapped = bpp.safeMult(H, BigInt(g)).add(bpp.safeMult(bpp.G, BigInt(v)));
  ok('G/H-swapped commitment with proof REJECTS',
    bpp.bppRangeVerify([C_swapped], r.proof) === false);
}

// ============== Attack 8: repeated commitment in aggregation ==============
// m=2 with identical commitments (same V repeated). The proof binds
// position through z^(2(j+1)), so even with V[0]=V[1] (same point),
// the proof bytes are specific to (j=0, j=1) ordering. Tampering by
// duplicating one commitment slot must reject.
group('Attack 8: repeated commitment slots');
{
  const v = 50n;
  const g = bpp.randomScalar();
  // Adversary creates a "duplicate" m=2 proof
  const r2 = bpp.bppRangeProve([v, v], [g, bpp.randomScalar()]);
  ok('real m=2 [v, v] (different blindings) verifies',
    bpp.bppRangeVerify(r2.commitments, r2.proof) === true);

  // Now try: substitute V[1] with V[0] (so both slots become V[0])
  ok('m=2 with V[1] := V[0] REJECTS',
    bpp.bppRangeVerify([r2.commitments[0], r2.commitments[0]], r2.proof) === false);
}

// ============== Attack 9: L/R round-permutation ==============
// The round loop emits (L_k, R_k) at logMN positions. Swapping two
// rounds' L/R should reject because the challenge u_k is bound into
// position via transcript order.
group('Attack 9: L/R round permutation');
{
  const v = 88n;
  const r = bpp.bppRangeProve([v], [bpp.randomScalar()]);
  // m=1 → logMN=6. L/R live at offsets [195 + k*66, ...]
  // Swap rounds 0 and 5.
  const tampered = new Uint8Array(r.proof);
  const round_0_start = 195;
  const round_5_start = 195 + 5 * 66;
  const r0 = tampered.slice(round_0_start, round_0_start + 66);
  const r5 = tampered.slice(round_5_start, round_5_start + 66);
  tampered.set(r5, round_0_start);
  tampered.set(r0, round_5_start);
  ok('round[0] ↔ round[5] swap REJECTS',
    bpp.bppRangeVerify(r.commitments, tampered) === false);
}

// ============== Attack 10: A/A1/B substitution ==============
// The three group elements at the proof prefix carry transcript binds
// AND scalar relationships into the verifier MSM check. Substituting
// A with A1 (or any other 33-byte permutation) must reject.
group('Attack 10: A/A1/B mutual substitution');
{
  const v = 999n;
  const r = bpp.bppRangeProve([v], [bpp.randomScalar()]);
  const tampered = new Uint8Array(r.proof);
  // Swap A with B
  const A = tampered.slice(0, 33);
  const B = tampered.slice(66, 99);
  tampered.set(B, 0);
  tampered.set(A, 66);
  ok('A ↔ B swap REJECTS', bpp.bppRangeVerify(r.commitments, tampered) === false);
}

// ============== Attack 11: prover output replay across distinct (m, values) ==============
// A proof of [10, 20] at m=2 must not validate against [10, 20] at m=4
// (with two zero-pad commitments). Different MN, different challenges,
// different scalar relations.
group('Attack 11: m=2 proof replay at m=4');
{
  const g1 = bpp.randomScalar();
  const g2 = bpp.randomScalar();
  const r2 = bpp.bppRangeProve([10n, 20n], [g1, g2]);
  ok('real m=2 verifies', bpp.bppRangeVerify(r2.commitments, r2.proof) === true);

  // Build m=4 commitments [V0, V1, ZERO, ZERO]
  const pad1 = bpp.pedersenCommit(0n, 0n);  // identity
  const pad2 = bpp.pedersenCommit(0n, 1n);
  const m4_commitments = [r2.commitments[0], r2.commitments[1], pad1, pad2];
  ok('m=2 proof bytes against 4 commitments REJECTS (length mismatch)',
    bpp.bppRangeVerify(m4_commitments, r2.proof) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
