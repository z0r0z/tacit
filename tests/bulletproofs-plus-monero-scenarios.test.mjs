// Monero-scenario adversarial coverage for the BP+ port.
//
// Mirrors the test patterns Monero's bulletproofs_plus.cc test corpus
// exercises. Byte-level fixtures aren't shareable (different curve + hash),
// but the scenario classes are: boundary values, identity / off-curve
// commitments, transcript replay, out-of-order commitments, repeated
// verification, empty commitments, large-m verification under varying
// witnesses.
//
// This file complements (does not replace) bulletproofs-plus-adversarial.
// Its job is to widen the net of malicious-prover-attempt classes the
// implementation has been exercised against. It does not close the
// soundness gap on its own — see the algorithmic peer-agent review in
// the spec amendment for the load-bearing argument.

import * as bpp from '../dapp/bulletproofs-plus.js';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

// ============== Boundary value coverage ==============
group('Boundary values (Monero test_invalid_amount class)');

{
  // Just inside the range: v = 2^64 - 1 should prove + verify
  const r = bpp.bppRangeProve([(1n << 64n) - 1n], [bpp.randomScalar()]);
  ok('v=2^64-1 proves + verifies', bpp.bppRangeVerify(r.commitments, r.proof) === true);
}
{
  // Exactly at the range boundary: v = 2^64 should be rejected at the prover
  let threw = false;
  try { bpp.bppRangeProve([(1n << 64n)], [bpp.randomScalar()]); }
  catch { threw = true; }
  ok('v=2^64 rejected by prover', threw);
}
{
  // Negative-encoded value: v = SECP_N - 1 (close to 2^256). Way out of range.
  let threw = false;
  try { bpp.bppRangeProve([bpp.SECP_N - 1n], [bpp.randomScalar()]); }
  catch { threw = true; }
  ok('v near group order rejected', threw);
}
{
  // High bit set in 64-bit range: v = 2^63 (valid)
  const r = bpp.bppRangeProve([(1n << 63n)], [bpp.randomScalar()]);
  ok('v=2^63 (high bit) proves + verifies',
    bpp.bppRangeVerify(r.commitments, r.proof) === true);
}
{
  // Mixed boundary aggregation: m=4 with all extremes
  const v = [0n, 1n, (1n << 63n), (1n << 64n) - 1n];
  const g = [bpp.randomScalar(), bpp.randomScalar(), bpp.randomScalar(), bpp.randomScalar()];
  const r = bpp.bppRangeProve(v, g);
  ok('m=4 mixed [0, 1, 2^63, 2^64-1] verifies',
    bpp.bppRangeVerify(r.commitments, r.proof) === true);
}

// ============== Commitment-shape attacks ==============
group('Commitment-shape attacks (Monero test_invalid_commitment class)');

{
  // Verifier given an empty commitments array
  const r = bpp.bppRangeProve([1n], [bpp.randomScalar()]);
  ok('empty commitment array rejects',
    bpp.bppRangeVerify([], r.proof) === false);
}
{
  // Verifier given identity (point at infinity) as a commitment
  const r = bpp.bppRangeProve([1n], [bpp.randomScalar()]);
  ok('identity-point commitment rejects',
    bpp.bppRangeVerify([bpp.ZERO], r.proof) === false);
}
{
  // Verifier given wrong-count commitments: m=4 proof with m=2 commitments
  const r = bpp.bppRangeProve([1n, 2n, 3n, 4n], [
    bpp.randomScalar(), bpp.randomScalar(), bpp.randomScalar(), bpp.randomScalar(),
  ]);
  ok('m=4 proof with 2 commitments rejects',
    bpp.bppRangeVerify([r.commitments[0], r.commitments[1]], r.proof) === false);
}
{
  // m=4 proof with m=2 padded to m=4 with identities
  const r = bpp.bppRangeProve([1n, 2n, 3n, 4n], [
    bpp.randomScalar(), bpp.randomScalar(), bpp.randomScalar(), bpp.randomScalar(),
  ]);
  const tampered = [r.commitments[0], r.commitments[1], bpp.ZERO, bpp.ZERO];
  ok('m=4 proof with identity-padded commitments rejects',
    bpp.bppRangeVerify(tampered, r.proof) === false);
}

// ============== Repeated verification (cache / state leak) ==============
group('Repeated verification (state-leak / cache-corruption class)');

{
  const r = bpp.bppRangeProve([42n], [bpp.randomScalar()]);
  // Verify the same proof 10 times. If module-level caches mutate state,
  // a later verify might disagree with the first.
  let allAgree = true;
  let first = bpp.bppRangeVerify(r.commitments, r.proof);
  for (let i = 0; i < 9; i++) {
    if (bpp.bppRangeVerify(r.commitments, r.proof) !== first) { allAgree = false; break; }
  }
  ok('verifier idempotent across 10 calls (no state corruption)',
    allAgree && first === true);
}

// ============== Out-of-order commitments ==============
group('Commitment ordering (z^(2j+1) factor binds index)');

{
  // m=4 proof. Permuting commitments must reject.
  const v = [111n, 222n, 333n, 444n];
  const g = [bpp.randomScalar(), bpp.randomScalar(), bpp.randomScalar(), bpp.randomScalar()];
  const r = bpp.bppRangeProve(v, g);
  ok('canonical order verifies', bpp.bppRangeVerify(r.commitments, r.proof) === true);
  const reversed = [r.commitments[3], r.commitments[2], r.commitments[1], r.commitments[0]];
  ok('reversed-order commitments reject',
    bpp.bppRangeVerify(reversed, r.proof) === false);
  const rotated = [r.commitments[1], r.commitments[2], r.commitments[3], r.commitments[0]];
  ok('rotated-order commitments reject',
    bpp.bppRangeVerify(rotated, r.proof) === false);
}

// ============== Transcript replay across distinct (commit, proof) pairs ==============
group('Transcript replay (Monero test_proof_substitution class)');

{
  // Two proofs of the same value with different blindings. Their transcripts
  // differ at the first 'V' append, so all subsequent challenges differ.
  // Substituting either side of the (V, proof) pair must reject.
  const v = 12345n;
  const p1 = bpp.bppRangeProve([v], [bpp.randomScalar()]);
  const p2 = bpp.bppRangeProve([v], [bpp.randomScalar()]);
  ok('p1 with p1.commit verifies',  bpp.bppRangeVerify(p1.commitments, p1.proof) === true);
  ok('p2 with p2.commit verifies',  bpp.bppRangeVerify(p2.commitments, p2.proof) === true);
  ok('p1.proof with p2.commit rejects', bpp.bppRangeVerify(p2.commitments, p1.proof) === false);
  ok('p2.proof with p1.commit rejects', bpp.bppRangeVerify(p1.commitments, p2.proof) === false);
}

// ============== Aggregation-factor confusion ==============
group('Aggregation-factor proof substitution');

{
  // m=2 proof verified with m=2 commitments — passes.
  // Now generate an m=4 proof and try to verify with m=4 truncated to m=2 + that m=2 proof.
  const p2 = bpp.bppRangeProve([10n, 20n], [bpp.randomScalar(), bpp.randomScalar()]);
  const p4 = bpp.bppRangeProve([10n, 20n, 30n, 40n], [
    bpp.randomScalar(), bpp.randomScalar(), bpp.randomScalar(), bpp.randomScalar(),
  ]);
  ok('m=2 proof rejects against m=4 commitments',
    bpp.bppRangeVerify(p4.commitments, p2.proof) === false);
  ok('m=4 proof rejects against m=2 truncated commitments',
    bpp.bppRangeVerify(p4.commitments.slice(0, 2), p4.proof) === false);
}

// ============== Stress across many independent proofs (Monero test_correctness x N) ==============
group('Stress: 20 independent proofs at random m');

{
  let allOk = true;
  let firstFail = null;
  for (let trial = 0; trial < 20; trial++) {
    const m = [1, 2, 4, 8][Math.floor(Math.random() * 4)];
    const values = [], blindings = [];
    for (let j = 0; j < m; j++) {
      const buf = new Uint8Array(8);
      if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(buf);
      else for (let i = 0; i < 8; i++) buf[i] = Math.floor(Math.random() * 256);
      let v = 0n;
      for (let i = 0; i < 8; i++) v |= BigInt(buf[i]) << BigInt(i * 8);
      values.push(v);
      blindings.push(bpp.randomScalar());
    }
    const r = bpp.bppRangeProve(values, blindings);
    if (bpp.bppRangeVerify(r.commitments, r.proof) !== true) {
      allOk = false;
      firstFail = `trial ${trial} m=${m}`;
      break;
    }
  }
  ok('20/20 random proofs verify', allOk, firstFail);
}

// ============== Cross-m proof bytes don't accidentally validate ==============
group('Cross-m wire substitution');

{
  // An m=1 proof has the wrong byte length for an m=2 verifier call.
  // Verifier should reject deterministically on length-mismatch, not crash.
  const p1 = bpp.bppRangeProve([100n], [bpp.randomScalar()]);
  const p2 = bpp.bppRangeProve([100n, 200n], [bpp.randomScalar(), bpp.randomScalar()]);

  ok('p1 proof bytes against 2 commitments rejects (length mismatch)',
    bpp.bppRangeVerify(p2.commitments, p1.proof) === false);
  ok('p2 proof bytes against 1 commitment rejects (length mismatch)',
    bpp.bppRangeVerify([p1.commitments[0]], p2.proof) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
