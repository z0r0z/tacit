// BP+ audit PoC — empirical soundness edges on the JS verifier.
// Read-only: imports the production module, constructs proofs, asserts verdicts.
import {
  bppRangeProve, bppRangeVerify, pedersenCommit, SECP_N, N_BITS,
  bigintToBytes32, bytesToPoint, pointToBytes, G, ZERO,
} from '../../../dapp/bulletproofs-plus.js';

let pass = 0, fail = 0;
const ok  = (name, cond) => { (cond ? (pass++, console.log('  PASS', name)) : (fail++, console.log('  FAIL', name))); };

// 1) Honest in-range proof verifies (completeness baseline).
{
  const vals = [42n], gam = [123456789n];
  const { proof, commitments } = bppRangeProve(vals, gam);
  ok('honest m=1 verifies', bppRangeVerify(commitments, proof) === true);
}

// 2) Edge values 0 and 2^64-1 verify (boundary completeness).
{
  const vals = [0n, (1n<<64n)-1n, 1n, 2n], gam = [1n,2n,3n,4n];
  const { proof, commitments } = bppRangeProve(vals, gam);
  ok('edge {0, 2^64-1, 1, 2} m=4 verifies', bppRangeVerify(commitments, proof) === true);
}

// 3) SOUNDNESS: out-of-range value (2^64 exactly, and a "negative" = N-1) must be REJECTED.
//    Use the test-only escape hatch to force the prover to build a proof for an
//    out-of-range commitment, exactly as a malicious prover would try.
{
  const v = 1n << 64n;                  // 2^64 — just past the range
  const { proof, commitments } = bppRangeProve([v], [7n], /*allowOOR*/ true);
  ok('out-of-range 2^64 REJECTED', bppRangeVerify(commitments, proof) === false);
}
{
  const v = SECP_N - 1n;               // "negative" (huge) value
  const { proof, commitments } = bppRangeProve([v], [7n], true);
  ok('out-of-range (N-1) REJECTED', bppRangeVerify(commitments, proof) === false);
}

// 4) SOUNDNESS: commitment swap — a proof valid for V must not verify for a different V.
{
  const a = bppRangeProve([10n],[11n]);
  const b = bppRangeProve([20n],[22n]);
  ok('proof-A vs commitment-B REJECTED', bppRangeVerify(b.commitments, a.proof) === false);
}

// 5) MALLEABILITY: non-canonical r1 (r1 + N, re-encoded) — verifier must reject.
//    r1 lives at offset 99 (after A,A1,B = 99 bytes), 32 bytes big-endian.
{
  const { proof, commitments } = bppRangeProve([5n],[6n]);
  ok('clean proof verifies (control)', bppRangeVerify(commitments, proof) === true);
  const tampered = proof.slice();
  // Set r1 to a value >= N by writing 0xff..ff into its 32-byte slot.
  for (let i = 99; i < 99 + 32; i++) tampered[i] = 0xff;
  ok('non-canonical r1 (0xff..ff >= N) REJECTED', bppRangeVerify(commitments, tampered) === false);
}

// 6) Length tamper — truncated / over-long proof rejected (not thrown).
{
  const { proof, commitments } = bppRangeProve([5n],[6n]);
  ok('truncated proof REJECTED', bppRangeVerify(commitments, proof.slice(0, proof.length - 1)) === false);
  const longer = new Uint8Array(proof.length + 1); longer.set(proof);
  ok('over-long proof REJECTED', bppRangeVerify(commitments, longer) === false);
}

// 7) Single-bit flip survey across the whole proof — every flip must reject.
{
  const { proof, commitments } = bppRangeProve([777n],[888n]);
  let allReject = true, tested = 0;
  // Sample byte positions (full sweep is slow; step through structure).
  for (let byte = 0; byte < proof.length; byte += 7) {
    const t = proof.slice(); t[byte] ^= 0x01; tested++;
    let v; try { v = bppRangeVerify(commitments, t); } catch { v = 'threw'; }
    if (v === true) { allReject = false; console.log('    accepted flip at byte', byte); break; }
  }
  ok(`bit-flip survey (${tested} flips) all REJECT`, allReject);
}

// 8) Identity-commitment edge (the parity finding): JS must return false cleanly, not throw.
{
  const { proof } = bppRangeProve([5n],[6n]);
  let verdict; try { verdict = bppRangeVerify([ZERO], proof); } catch (e) { verdict = 'THREW: ' + e.message; }
  ok('identity commitment → clean false (no throw)', verdict === false);
}

console.log(`\nBP+ audit PoC: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
