// Adversarial test battery for the BP+ port.
//
// These tests try to construct INVALID proofs that might slip through a
// buggy verifier. They narrow (but don't close) the soundness gap that
// external cryptographic review must finish.
//
// What this CAN catch:
//   - Verifier silently accepting tampered fields
//   - Missing binding between commitments and proof
//   - Transcript replay vulnerabilities
//   - Mismatched m between proof and verifier call
//
// What this CANNOT catch:
//   - Soundness bugs where the WIPA collapse equation has the wrong shape
//   - Hidden algebraic relationships that let a malicious prover forge
//   - Side-channel leakage in the prover
//
// For those, an external auditor must read the WIPA construction line by
// line against the BP+ paper. Self-honesty: this file is a confidence
// floor, not a ceiling.

import * as bpp from '../dapp/bulletproofs-plus.js';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

// Helper: produce a valid proof for value v at m=1.
function freshProof(v, g = null) {
  const blinding = g ?? bpp.randomScalar();
  return bpp.bppRangeProve([v], [blinding]);
}

group('Bit-flip survey: every byte of the proof binds something');

{
  const p = freshProof(12345n);
  ok('baseline verifies', bpp.bppRangeVerify(p.commitments, p.proof) === true);

  let acceptances = 0;
  let total = 0;
  const sampleStride = 7;  // sample every 7th byte to keep test runtime reasonable
  for (let i = 0; i < p.proof.length; i += sampleStride) {
    const tampered = new Uint8Array(p.proof);
    tampered[i] ^= 0x01;
    let result;
    try { result = bpp.bppRangeVerify(p.commitments, tampered); }
    catch { result = false; }  // off-curve parses count as rejections
    if (result === true) acceptances++;
    total++;
  }
  ok(`bit-flips: ${total - acceptances}/${total} rejected (0 acceptances expected)`,
    acceptances === 0,
    acceptances > 0 ? `${acceptances} bit-flips were silently accepted!` : null);
}

group('Per-byte tampering on each structural field');

{
  const p = freshProof(98765n);
  const m = 1, logMN = 6;
  const sections = [
    { name: 'A',  start: 0,           end: 33 },
    { name: 'A1', start: 33,          end: 66 },
    { name: 'B',  start: 66,          end: 99 },
    { name: 'r1', start: 99,          end: 131 },
    { name: 's1', start: 131,         end: 163 },
    { name: 'd1', start: 163,         end: 195 },
  ];
  for (let k = 0; k < logMN; k++) {
    sections.push({ name: `L[${k}]`, start: 195 + k * 66, end: 228 + k * 66 });
    sections.push({ name: `R[${k}]`, start: 228 + k * 66, end: 261 + k * 66 });
  }
  // Sanity check sections cover the whole proof
  ok(`proof has expected length for m=1 (591 B)`, p.proof.length === 591);
  ok(`sections sum to 591`, sections[sections.length - 1].end === 591);

  // Flip the LAST byte of each section. This catches "didn't bind the
  // high bytes" bugs better than flipping the first byte.
  for (const s of sections) {
    const tampered = new Uint8Array(p.proof);
    tampered[s.end - 1] ^= 0x80;
    let result;
    try { result = bpp.bppRangeVerify(p.commitments, tampered); }
    catch { result = false; }
    ok(`flipping last byte of ${s.name} rejects`, result === false);
  }
}

group('Aggregation factor mismatch');

{
  // Generate an m=2 proof, try to verify as m=1 or m=4
  const v = [100n, 200n];
  const g = [bpp.randomScalar(), bpp.randomScalar()];
  const p = bpp.bppRangeProve(v, g);
  ok('m=2 proof verifies with m=2 commitments',
    bpp.bppRangeVerify(p.commitments, p.proof) === true);
  // Verifying with truncated commitments (m=1)
  ok('m=2 proof rejects with only 1 commitment',
    bpp.bppRangeVerify([p.commitments[0]], p.proof) === false);
  // Verifying with padded commitments (m=4)
  const padded = [...p.commitments, bpp.pedersenCommit(0n, 1n), bpp.pedersenCommit(0n, 2n)];
  ok('m=2 proof rejects with 4 commitments (padded)',
    bpp.bppRangeVerify(padded, p.proof) === false);
}

group('Commitment swap within an aggregated proof');

{
  // Generate an m=2 proof, swap the two commitments at verify time
  const v = [111n, 222n];
  const g = [bpp.randomScalar(), bpp.randomScalar()];
  const p = bpp.bppRangeProve(v, g);
  ok('original order verifies',
    bpp.bppRangeVerify(p.commitments, p.proof) === true);
  ok('swapped commitments reject (z^(2j+1) factor binds order)',
    bpp.bppRangeVerify([p.commitments[1], p.commitments[0]], p.proof) === false);
}

group('Cross-proof substitution');

{
  // Two independently-generated proofs of the same value with different
  // blindings. Their proof bytes look superficially similar but must be
  // distinguished.
  const v = 42n;
  const p1 = freshProof(v, bpp.randomScalar());
  const p2 = freshProof(v, bpp.randomScalar());
  ok('p1 verifies with p1.commit',
    bpp.bppRangeVerify(p1.commitments, p1.proof) === true);
  ok('p2 verifies with p2.commit',
    bpp.bppRangeVerify(p2.commitments, p2.proof) === true);
  ok('p1.proof rejects with p2.commit',
    bpp.bppRangeVerify(p2.commitments, p1.proof) === false);
  ok('p2.proof rejects with p1.commit',
    bpp.bppRangeVerify(p1.commitments, p2.proof) === false);
}

group('Length truncation/extension');

{
  const p = freshProof(7777n);
  ok('one byte truncated rejects',
    bpp.bppRangeVerify(p.commitments, p.proof.slice(0, -1)) === false);
  const extended = new Uint8Array(p.proof.length + 1);
  extended.set(p.proof);
  ok('one byte appended rejects',
    bpp.bppRangeVerify(p.commitments, extended) === false);
  ok('half-truncated rejects',
    bpp.bppRangeVerify(p.commitments, p.proof.slice(0, p.proof.length / 2)) === false);
}

group('Zero / identity commitment edge cases');

{
  // A commitment to 0 with zero blinding is the identity point. Accepted?
  const p = freshProof(0n, 0n);
  // The verifier should reject if it treats identity as a valid commitment
  // input. Actually scratch that — pedersen of (0,0) IS the identity, and
  // the prover successfully built a proof. Whether it should be accepted is
  // a separate policy question. Self-consistency-wise:
  let res;
  try { res = bpp.bppRangeVerify(p.commitments, p.proof); }
  catch { res = 'threw'; }
  ok('pedersen(0,0) commit + matching proof: self-consistent (true OR threw)',
    res === true || res === 'threw',
    `verifier returned ${res}`);
}

group('Verifier always returns boolean (no info leak on malformed inputs)');

{
  const p = freshProof(1n);
  const cases = [
    { name: 'empty bytes', proof: new Uint8Array(0) },
    { name: 'one byte',    proof: new Uint8Array(1) },
    { name: '32 bytes',    proof: new Uint8Array(32) },
    { name: 'random 591',  proof: (() => { const b = new Uint8Array(591); for (let i = 0; i < 591; i++) b[i] = i & 0xff; return b; })() },
  ];
  for (const c of cases) {
    let res;
    try { res = bpp.bppRangeVerify(p.commitments, c.proof); }
    catch (e) { res = `threw: ${e?.message}`; }
    ok(`malformed input "${c.name}" returns false (not exception)`,
      res === false, typeof res === 'string' ? res : null);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
