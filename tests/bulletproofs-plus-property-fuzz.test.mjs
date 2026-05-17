// Property-based fuzz for the BP+ port.
//
// Two complementary properties exercised over many random inputs:
//
//   P1 (completeness): for every (values, blindings) in the honest input
//        space, bppRangeProve produces a proof that bppRangeVerify
//        accepts. Iterated over 1000+ random samples.
//
//   P2 (soundness sanity): for every honest proof, a single random
//        byte-flip in the proof bytes produces a proof that is rejected.
//        Iterated against the same sample set.
//
// P2 is a sanity check; bit-flip is necessary but not sufficient for
// soundness. Combined with the malicious-prover suite (shaped attacks)
// and the algorithmic peer-agent review, it bounds the space of
// implementation bugs detectable by negative testing.
//
// Run time: ~30s for 200 samples * (1 prove + 1 verify + 1 tamper-verify).

import * as bpp from '../dapp/bulletproofs-plus.js';
import { bytesToHex } from '@noble/hashes/utils';

let pass = 0, fail = 0;
const samplesPerM = parseInt(process.env.BPP_FUZZ_SAMPLES || '50', 10);

function ok(name, cond, detail) {
  if (cond) pass++; else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

function randomBigint64() {
  const buf = new Uint8Array(8);
  globalThis.crypto.getRandomValues(buf);
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(buf[i]) << BigInt(i * 8);
  return v;
}

group(`P1 (completeness): ${samplesPerM} samples × m ∈ {1,2,4,8} = ${samplesPerM * 4} honest proofs verify`);
{
  let allOk = true, firstFail = null;
  let proveCount = 0;
  for (const m of [1, 2, 4, 8]) {
    for (let trial = 0; trial < samplesPerM; trial++) {
      const values = [];
      const blindings = [];
      for (let j = 0; j < m; j++) {
        values.push(randomBigint64() & ((1n << 64n) - 1n));
        blindings.push(bpp.randomScalar());
      }
      const r = bpp.bppRangeProve(values, blindings);
      proveCount++;
      if (bpp.bppRangeVerify(r.commitments, r.proof) !== true) {
        allOk = false;
        firstFail = `m=${m} trial=${trial} values=[${values.slice(0,3).join(',')}…]`;
        break;
      }
    }
    if (!allOk) break;
  }
  ok(`P1: all ${proveCount} honest proofs verified`, allOk, firstFail);
}

group(`P2 (soundness sanity): random single-byte tamper rejects at ${samplesPerM} × 4 m-levels`);
{
  let totalTamper = 0, acceptances = 0;
  let firstUnsoundDetail = null;
  for (const m of [1, 2, 4, 8]) {
    for (let trial = 0; trial < samplesPerM; trial++) {
      const values = [];
      const blindings = [];
      for (let j = 0; j < m; j++) {
        values.push(randomBigint64() & ((1n << 64n) - 1n));
        blindings.push(bpp.randomScalar());
      }
      const r = bpp.bppRangeProve(values, blindings);
      // Random byte index + random bit
      const idxBuf = new Uint8Array(2);
      globalThis.crypto.getRandomValues(idxBuf);
      const idx = ((idxBuf[0] << 8) | idxBuf[1]) % r.proof.length;
      const bitBuf = new Uint8Array(1);
      globalThis.crypto.getRandomValues(bitBuf);
      const bit = 1 << (bitBuf[0] & 0x7);

      const tampered = new Uint8Array(r.proof);
      tampered[idx] ^= bit;
      let verifyResult;
      try { verifyResult = bpp.bppRangeVerify(r.commitments, tampered); }
      catch { verifyResult = false; }   // off-curve parse failures count as rejection
      totalTamper++;
      if (verifyResult === true) {
        acceptances++;
        if (!firstUnsoundDetail) {
          firstUnsoundDetail = `m=${m} trial=${trial} flipped byte[${idx}] bit ${Math.log2(bit)} of proof len ${r.proof.length}`;
        }
      }
    }
  }
  ok(`P2: ${totalTamper - acceptances}/${totalTamper} byte-flips rejected (0 acceptances expected)`,
    acceptances === 0,
    firstUnsoundDetail);
}

group(`P3 (binding): random V swap rejects at ${samplesPerM} samples for m=2`);
{
  let totalSwaps = 0, acceptances = 0;
  for (let trial = 0; trial < samplesPerM; trial++) {
    const values = [randomBigint64() & ((1n << 64n) - 1n), randomBigint64() & ((1n << 64n) - 1n)];
    if (values[0] === values[1]) values[1] = (values[1] + 1n) & ((1n << 64n) - 1n);  // ensure distinct
    const blindings = [bpp.randomScalar(), bpp.randomScalar()];
    const r = bpp.bppRangeProve(values, blindings);
    let result;
    try { result = bpp.bppRangeVerify([r.commitments[1], r.commitments[0]], r.proof); }
    catch { result = false; }
    totalSwaps++;
    if (result === true) acceptances++;
  }
  ok(`P3: ${totalSwaps - acceptances}/${totalSwaps} commitment-swap attempts rejected`,
    acceptances === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
