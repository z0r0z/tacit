// Round-trip self-consistency test for the BP+ port.
//
// THE CRITICAL TEST: prove → verify must return true for every honest proof.
// If this fails, the prover and verifier disagree at the algebraic level,
// which means either (a) the prover is broken, (b) the verifier is broken,
// or (c) both have matching bugs that mask each other.
//
// Self-consistency tests are necessary but not sufficient for cryptographic
// confidence — they cannot detect soundness bugs where a MALICIOUS prover
// could forge proofs. That's what external audit closes. But if round-trip
// FAILS, we know the implementation is definitely broken.

import * as bpp from '../dapp/bulletproofs-plus.js';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

group('Honest prove → verify round-trip at each m');

for (const m of [1, 2, 4, 8]) {
  const values = [];
  const blindings = [];
  for (let j = 0; j < m; j++) {
    values.push(BigInt(1000 + j * 100));
    blindings.push(bpp.randomScalar());
  }
  let result;
  try {
    result = bpp.bppRangeProve(values, blindings);
  } catch (e) {
    ok(`m=${m}: prover threw`, false, e?.message || String(e));
    continue;
  }
  let verifyResult;
  try {
    verifyResult = bpp.bppRangeVerify(result.commitments, result.proof);
  } catch (e) {
    ok(`m=${m}: verifier threw`, false, e?.message || String(e));
    continue;
  }
  ok(`m=${m}: honest proof verifies`, verifyResult === true,
    `bppRangeVerify returned ${verifyResult}`);
}

group('Edge values');

{
  // Smallest value: 0
  const v = [0n];
  const g = [bpp.randomScalar()];
  const r = bpp.bppRangeProve(v, g);
  ok('value=0 verifies', bpp.bppRangeVerify(r.commitments, r.proof) === true);
}
{
  // Largest in-range value: 2^64 - 1
  const v = [(1n << 64n) - 1n];
  const g = [bpp.randomScalar()];
  const r = bpp.bppRangeProve(v, g);
  ok('value=2^64-1 verifies', bpp.bppRangeVerify(r.commitments, r.proof) === true);
}
{
  // Mixed in same proof
  const v = [0n, (1n << 64n) - 1n];
  const g = [bpp.randomScalar(), bpp.randomScalar()];
  const r = bpp.bppRangeProve(v, g);
  ok('m=2 mixed [0, 2^64-1] verifies', bpp.bppRangeVerify(r.commitments, r.proof) === true);
}

group('Negative tests: tampered proofs reject');

{
  const v = [12345n];
  const g = [bpp.randomScalar()];
  const r = bpp.bppRangeProve(v, g);
  ok('baseline verifies', bpp.bppRangeVerify(r.commitments, r.proof) === true);

  // Flip one bit in r1 (a final scalar)
  const tampered = new Uint8Array(r.proof);
  const r1Off = 33 * 3;  // after A, A1, B
  tampered[r1Off] ^= 0x01;
  ok('tampered r1 rejects', bpp.bppRangeVerify(r.commitments, tampered) === false);
}
{
  const v = [12345n];
  const g = [bpp.randomScalar()];
  const r = bpp.bppRangeProve(v, g);
  // Flip one bit in A (first group element)
  const tampered = new Uint8Array(r.proof);
  tampered[1] ^= 0x01;
  // Might fail to parse (off-curve) — either reject path is fine
  const result = bpp.bppRangeVerify(r.commitments, tampered);
  ok('tampered A rejects', result === false);
}
{
  const v = [12345n];
  const g = [bpp.randomScalar()];
  const r = bpp.bppRangeProve(v, g);
  // Wrong commitment (use a different V)
  const wrongCommit = [bpp.pedersenCommit(99999n, bpp.randomScalar())];
  ok('wrong commitment rejects', bpp.bppRangeVerify(wrongCommit, r.proof) === false);
}
{
  // Verifier rejects malformed proof lengths
  ok('empty proof rejects',
    bpp.bppRangeVerify([bpp.pedersenCommit(1n, 1n)], new Uint8Array(0)) === false);
  ok('wrong-length proof rejects',
    bpp.bppRangeVerify([bpp.pedersenCommit(1n, 1n)], new Uint8Array(100)) === false);
}

group('Cross-witness rejection');

{
  // Two independent proofs of same value. Mixing their commitments
  // with each other's proofs must reject.
  const v = [777n];
  const r1 = bpp.bppRangeProve(v, [bpp.randomScalar()]);
  const r2 = bpp.bppRangeProve(v, [bpp.randomScalar()]);
  ok('proof1 with commit2 rejects',
    bpp.bppRangeVerify(r2.commitments, r1.proof) === false);
  ok('proof2 with commit1 rejects',
    bpp.bppRangeVerify(r1.commitments, r2.proof) === false);
}

group('Stress: multiple random m=4 proofs');

for (let trial = 0; trial < 5; trial++) {
  const values = [];
  const blindings = [];
  for (let j = 0; j < 4; j++) {
    // Random 64-bit values
    const buf = new Uint8Array(8);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(buf);
    else for (let i = 0; i < 8; i++) buf[i] = Math.floor(Math.random() * 256);
    let v = 0n;
    for (let i = 0; i < 8; i++) v |= BigInt(buf[i]) << BigInt(i * 8);
    values.push(v);
    blindings.push(bpp.randomScalar());
  }
  const r = bpp.bppRangeProve(values, blindings);
  ok(`trial ${trial + 1}/5 random m=4 verifies`,
    bpp.bppRangeVerify(r.commitments, r.proof) === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
