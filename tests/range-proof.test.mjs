// Tests for the tacit range-proof primitive.
//
// Coverage:
//   • Honest prover, every predicate type ⇒ verifier accepts
//   • Boundary values (a = X for ≥; a = X for ≤; a = X and a = Y for IN_RANGE)
//   • Out-of-range values ⇒ prover refuses to construct
//   • Tampered proof bytes ⇒ verifier rejects
//   • Wrong predicate parameters at verify time ⇒ verifier produces a
//     different `predicate` object so a caller comparing against expected
//     params catches the mismatch
//   • Cross-pairing: GE proof for value X used to verify a different
//     commitment ⇒ rejected
//   • Multi-UTXO aggregate predicate (sum ≥ X) ⇒ accepted
//   • Hidden-vs-hidden comparison ⇒ accepted
//   • Equality (PRED_EQ): correct opening accepted, wrong blinding rejected

import { pedersenCommit, pointToBytes, randomScalar, G, H, modN } from './bulletproofs.mjs';
import {
  proveRange, verifyRange,
  aggregateCommitments, sumCommitmentBytes,
  PRED_GE, PRED_LE, PRED_IN_RANGE, PRED_GT_HIDDEN, PRED_EQ,
} from './range-proof.mjs';

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

// =========================================================================
// PRED_GE: a ≥ X
// =========================================================================
console.log('PRED_GE — a ≥ X');
{
  const a = 1000n, r = randomScalar();
  const C = pointToBytes(pedersenCommit(a, r));

  test('a > X (1000 ≥ 500) ⇒ accepted', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'ge', X: 500n });
    const result = verifyRange(C, proof);
    return result.ok === true && result.predicate.type === 'ge' && result.predicate.X === 500n;
  });

  test('a == X boundary (1000 ≥ 1000) ⇒ accepted', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'ge', X: 1000n });
    return verifyRange(C, proof).ok === true;
  });

  test('a < X (cannot prove 1000 ≥ 2000) ⇒ prover throws', () => {
    try {
      proveRange({ value: a, blinding: r }, { type: 'ge', X: 2000n });
      return false;
    } catch (e) { return /cannot prove/.test(e.message); }
  });

  test('a ≥ 0 (trivial — should accept)', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'ge', X: 0n });
    return verifyRange(C, proof).ok === true;
  });

  test('tampered proof byte ⇒ rejected', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'ge', X: 500n });
    const bad = new Uint8Array(proof); bad[20] ^= 0x01;
    return verifyRange(C, bad).ok === false;
  });

  test('verify with wrong commitment ⇒ rejected', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'ge', X: 500n });
    const otherC = pointToBytes(pedersenCommit(999n, randomScalar()));
    return verifyRange(otherC, proof).ok === false;
  });

  test('verifier returns X so caller can match against expected', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'ge', X: 500n });
    const result = verifyRange(C, proof);
    // Caller's check: predicate.X must equal their expected bound.
    return result.ok && result.predicate.X === 500n && result.predicate.X !== 600n;
  });
}

// =========================================================================
// PRED_LE: a ≤ X
// =========================================================================
console.log('\nPRED_LE — a ≤ X');
{
  const a = 1000n, r = randomScalar();
  const C = pointToBytes(pedersenCommit(a, r));

  test('a < X (1000 ≤ 5000) ⇒ accepted', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'le', X: 5000n });
    return verifyRange(C, proof).ok === true;
  });

  test('a == X boundary (1000 ≤ 1000) ⇒ accepted', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'le', X: 1000n });
    return verifyRange(C, proof).ok === true;
  });

  test('a > X (cannot prove 1000 ≤ 500) ⇒ prover throws', () => {
    try {
      proveRange({ value: a, blinding: r }, { type: 'le', X: 500n });
      return false;
    } catch (e) { return /cannot prove/.test(e.message); }
  });

  test('tampered LE proof ⇒ rejected', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'le', X: 5000n });
    const bad = new Uint8Array(proof); bad[40] ^= 0x80;
    return verifyRange(C, bad).ok === false;
  });
}

// =========================================================================
// PRED_IN_RANGE: a ∈ [X, Y]
// =========================================================================
console.log('\nPRED_IN_RANGE — a ∈ [X, Y]');
{
  const a = 1000n, r = randomScalar();
  const C = pointToBytes(pedersenCommit(a, r));

  test('1000 ∈ [500, 2000] ⇒ accepted', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'in_range', X: 500n, Y: 2000n });
    return verifyRange(C, proof).ok === true;
  });

  test('a == X boundary (1000 ∈ [1000, 5000]) ⇒ accepted', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'in_range', X: 1000n, Y: 5000n });
    return verifyRange(C, proof).ok === true;
  });

  test('a == Y boundary (1000 ∈ [500, 1000]) ⇒ accepted', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'in_range', X: 500n, Y: 1000n });
    return verifyRange(C, proof).ok === true;
  });

  test('a < X ⇒ prover throws', () => {
    try {
      proveRange({ value: a, blinding: r }, { type: 'in_range', X: 1500n, Y: 2000n });
      return false;
    } catch (e) { return /not in/.test(e.message); }
  });

  test('a > Y ⇒ prover throws', () => {
    try {
      proveRange({ value: a, blinding: r }, { type: 'in_range', X: 100n, Y: 500n });
      return false;
    } catch (e) { return /not in/.test(e.message); }
  });

  test('X > Y at prove time ⇒ rejected', () => {
    try {
      proveRange({ value: a, blinding: r }, { type: 'in_range', X: 2000n, Y: 500n });
      return false;
    } catch (e) { return /X ≤ Y/.test(e.message); }
  });

  test('IN_RANGE returns X and Y for caller-side verification', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'in_range', X: 500n, Y: 2000n });
    const result = verifyRange(C, proof);
    return result.ok && result.predicate.X === 500n && result.predicate.Y === 2000n;
  });
}

// =========================================================================
// PRED_GT_HIDDEN: a > b
// =========================================================================
console.log('\nPRED_GT_HIDDEN — a > b (hidden vs hidden)');
{
  const a = 1000n, r_a = randomScalar();
  const b = 500n,  r_b = randomScalar();
  const C_a = pointToBytes(pedersenCommit(a, r_a));
  const C_b = pointToBytes(pedersenCommit(b, r_b));

  test('a > b (1000 > 500) ⇒ accepted', () => {
    const proof = proveRange(
      { value: a, blinding: r_a, otherValue: b, otherBlinding: r_b },
      { type: 'gt_hidden' },
    );
    return verifyRange(C_a, proof, { commitmentB: C_b }).ok === true;
  });

  test('a == b+1 boundary (501 > 500) ⇒ accepted', () => {
    const r_a2 = randomScalar();
    const C_a2 = pointToBytes(pedersenCommit(501n, r_a2));
    const proof = proveRange(
      { value: 501n, blinding: r_a2, otherValue: 500n, otherBlinding: r_b },
      { type: 'gt_hidden' },
    );
    return verifyRange(C_a2, proof, { commitmentB: C_b }).ok === true;
  });

  test('a == b ⇒ prover throws (need strict >)', () => {
    try {
      proveRange(
        { value: 500n, blinding: r_a, otherValue: 500n, otherBlinding: r_b },
        { type: 'gt_hidden' },
      );
      return false;
    } catch (e) { return /cannot prove a > b/.test(e.message); }
  });

  test('a < b ⇒ prover throws', () => {
    try {
      proveRange(
        { value: 100n, blinding: r_a, otherValue: 500n, otherBlinding: r_b },
        { type: 'gt_hidden' },
      );
      return false;
    } catch (e) { return /cannot prove a > b/.test(e.message); }
  });

  test('verifier without commitmentB ⇒ rejected', () => {
    const proof = proveRange(
      { value: a, blinding: r_a, otherValue: b, otherBlinding: r_b },
      { type: 'gt_hidden' },
    );
    return verifyRange(C_a, proof).ok === false;
  });

  test('verifier with mismatched commitmentB ⇒ rejected', () => {
    const proof = proveRange(
      { value: a, blinding: r_a, otherValue: b, otherBlinding: r_b },
      { type: 'gt_hidden' },
    );
    const wrongC_b = pointToBytes(pedersenCommit(750n, randomScalar()));
    const result = verifyRange(C_a, proof, { commitmentB: wrongC_b });
    return result.ok === false && /commitmentB/.test(result.reason);
  });
}

// =========================================================================
// PRED_EQ: a = X
// =========================================================================
console.log('\nPRED_EQ — a = X (equality via opening)');
{
  const a = 1000n, r = randomScalar();
  const C = pointToBytes(pedersenCommit(a, r));

  test('a == X ⇒ accepted', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'eq', X: 1000n });
    return verifyRange(C, proof).ok === true;
  });

  test('a != X ⇒ prover throws', () => {
    try {
      proveRange({ value: a, blinding: r }, { type: 'eq', X: 999n });
      return false;
    } catch (e) { return /cannot prove a = X/.test(e.message); }
  });

  test('tampered blinding ⇒ rejected', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'eq', X: 1000n });
    const bad = new Uint8Array(proof); bad[15] ^= 0xff;
    return verifyRange(C, bad).ok === false;
  });

  test('PRED_EQ wire size is exactly 1 + 8 + 32 = 41 bytes (no bulletproof)', () => {
    const proof = proveRange({ value: a, blinding: r }, { type: 'eq', X: 1000n });
    return proof.length === 41;
  });
}

// =========================================================================
// Multi-UTXO aggregate (Σ a_i ≥ X)
// =========================================================================
console.log('\nMulti-UTXO aggregate — Σ a_i ≥ X via sum-commitment');
{
  // Three UTXOs summing to 6000; prove sum ≥ 5000.
  const utxos = [
    { value: 1000n, blinding: randomScalar() },
    { value: 2000n, blinding: randomScalar() },
    { value: 3000n, blinding: randomScalar() },
  ];
  const Cs = utxos.map(u => pointToBytes(pedersenCommit(u.value, u.blinding)));
  const sumC = sumCommitmentBytes(Cs);

  test('aggregate (1000+2000+3000) ≥ 5000 ⇒ accepted', () => {
    const agg = aggregateCommitments(utxos);
    const proof = proveRange(agg, { type: 'ge', X: 5000n });
    return verifyRange(sumC, proof).ok === true;
  });

  test('aggregate ≥ 7000 ⇒ prover throws (insufficient sum)', () => {
    const agg = aggregateCommitments(utxos);
    try {
      proveRange(agg, { type: 'ge', X: 7000n });
      return false;
    } catch (e) { return /cannot prove/.test(e.message); }
  });

  test('aggregate ∈ [5000, 10000] ⇒ accepted', () => {
    const agg = aggregateCommitments(utxos);
    const proof = proveRange(agg, { type: 'in_range', X: 5000n, Y: 10000n });
    return verifyRange(sumC, proof).ok === true;
  });
}

// =========================================================================
// Edge cases and adversarial
// =========================================================================
console.log('\nEdge cases and adversarial');
{
  test('PRED_GE proof for value=5 with bound X=10 (false claim) ⇒ prover refuses', () => {
    try {
      proveRange({ value: 5n, blinding: randomScalar() }, { type: 'ge', X: 10n });
      return false;
    } catch (e) { return true; }
  });

  test('value at u64 max (2^64 - 1) ≥ 0 ⇒ accepted', () => {
    const a = (1n << 64n) - 1n;
    const r = randomScalar();
    const C = pointToBytes(pedersenCommit(a, r));
    const proof = proveRange({ value: a, blinding: r }, { type: 'ge', X: 0n });
    return verifyRange(C, proof).ok === true;
  });

  test('value at u64 max ≤ u64 max ⇒ accepted', () => {
    const a = (1n << 64n) - 1n;
    const r = randomScalar();
    const C = pointToBytes(pedersenCommit(a, r));
    const proof = proveRange({ value: a, blinding: r }, { type: 'le', X: a });
    return verifyRange(C, proof).ok === true;
  });

  test('value ≥ 2^64 at prove time ⇒ rejected', () => {
    try {
      proveRange({ value: 1n << 64n, blinding: randomScalar() }, { type: 'ge', X: 0n });
      return false;
    } catch (e) { return /must satisfy/.test(e.message); }
  });

  test('X ≥ 2^64 at prove time ⇒ rejected', () => {
    try {
      proveRange({ value: 100n, blinding: randomScalar() }, { type: 'ge', X: 1n << 64n });
      return false;
    } catch (e) { return /must satisfy/.test(e.message); }
  });

  test('truncated attestation bytes ⇒ rejected gracefully', () => {
    const proof = proveRange({ value: 100n, blinding: randomScalar() }, { type: 'ge', X: 50n });
    const truncated = proof.slice(0, 20);
    const C = pointToBytes(pedersenCommit(100n, randomScalar()));
    const result = verifyRange(C, truncated);
    return result.ok === false;
  });

  test('unknown predicate tag ⇒ rejected gracefully', () => {
    const C = pointToBytes(pedersenCommit(100n, randomScalar()));
    const bogus = new Uint8Array([0xff, 0x00, 0x00, 0x00]);
    const result = verifyRange(C, bogus);
    return result.ok === false && /unknown predicate/.test(result.reason);
  });

  test('PRED_GE attestation reused for a different bound at verify time', () => {
    // The attestation embeds X — verifier can't be tricked into checking
    // against a different bound. The verifier returns the X embedded in the
    // attestation; the caller is responsible for matching it.
    const r = randomScalar();
    const C = pointToBytes(pedersenCommit(1000n, r));
    const proof = proveRange({ value: 1000n, blinding: r }, { type: 'ge', X: 500n });
    const result = verifyRange(C, proof);
    // Result is OK but X is what the attestation claims (500), not anything
    // the caller might erroneously believe.
    return result.ok && result.predicate.X === 500n;
  });
}

console.log(`\n${pass}/${pass + fail} range-proof tests passed`);
if (fail > 0) process.exit(1);
