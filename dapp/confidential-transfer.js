// Arbitrary-amount confidential transfer for the EVM confidential pool — the
// Bitcoin-CXFER construction, EVM-side. A transfer proves two things about
// hidden amounts:
//   1. non-negativity: every output value ∈ [0, 2^64), via an aggregated
//      secp256k1 Bulletproofs+ range proof (dapp/bulletproofs-plus.js, the same
//      construction and generators as the Bitcoin layer — so a note and its range
//      proof are byte-identical across chains).
//   2. conservation: Σ C_in − Σ C_out is a multiple of G (a Mimblewimble kernel
//      Schnorr under the blinding excess). Since H and G are independent, that
//      forces Σ value_in = Σ value_out; with the ranges, no value is created and
//      none is negative.
//
// This prover runs in Node/browser today. The SP1 guest's job is only to
// RE-VERIFY this exact proof, so a passing Node round-trip here locks the proof
// format the guest will check — the guest port is then a mechanical
// re-implementation of bppRangeVerify + this kernel in Rust.
//
// keccak256 injected for Node + browser parity.

import {
  bppGens, bppRangeProve, bppRangeVerify,
  G, ZERO, SECP_N, modN, randomScalar,
} from './bulletproofs-plus.js';

const KERNEL_DOMAIN = new TextEncoder().encode('tacit-evm-cxfer-kernel-v1');

export function makeConfidentialTransfer({ keccak256 }) {
  const H = bppGens().H;

  const bytesToHex = (b) => Buffer.from(b).toString('hex');
  const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };
  const ptBytes = (P) => P.toRawBytes(true); // 33-byte compressed
  const mul = (P, s) => (s === 0n || P.equals(ZERO)) ? ZERO : P.multiply(modN(s));
  const sum = (pts) => pts.reduce((a, p) => a.add(p), ZERO);
  const commit = (v, r) => H.multiply(v).add(mul(G, r));

  function kernelChallenge(inC, outC, R) {
    const parts = [KERNEL_DOMAIN];
    for (const P of inC) parts.push(ptBytes(P));
    for (const P of outC) parts.push(ptBytes(P));
    parts.push(ptBytes(R));
    return modN(BigInt('0x' + bytesToHex(keccak256(concat(parts)))));
  }

  // inputs/outputs: [{ value: bigint, blinding: bigint }], with Σ value equal.
  // Output count m must be in {1, 2, 4, 8} (BP+ aggregation).
  function buildTransfer({ inputs, outputs }) {
    const sumIn = inputs.reduce((s, i) => s + i.value, 0n);
    const sumOut = outputs.reduce((s, o) => s + o.value, 0n);
    if (sumIn !== sumOut) throw new Error('transfer not conserved: Σin ≠ Σout');

    const { proof: rangeProof, commitments: outC } =
      bppRangeProve(outputs.map((o) => o.value), outputs.map((o) => o.blinding));
    const inC = inputs.map((i) => commit(i.value, i.blinding));

    const excess = modN(
      inputs.reduce((s, i) => s + i.blinding, 0n) - outputs.reduce((s, o) => s + o.blinding, 0n)
    );
    const k = randomScalar();
    const R = mul(G, k);
    const e = kernelChallenge(inC, outC, R);
    const z = modN(k + e * excess);

    return { inC, outC, rangeProof, kernel: { R, z } };
  }

  // Verifies ranges + conservation. Returns true iff the transfer creates no
  // value and contains no negative output.
  function verifyTransfer({ inC, outC, rangeProof, kernel }) {
    if (!bppRangeVerify(outC, rangeProof)) return false;
    const X = sum(inC).add(sum(outC).negate());        // Σ C_in − Σ C_out
    const e = kernelChallenge(inC, outC, kernel.R);
    const lhs = mul(G, kernel.z);                        // z·G
    const rhs = kernel.R.add(mul(X, e));                 // R + e·X
    return lhs.equals(rhs);
  }

  return { H, commit, buildTransfer, verifyTransfer, _ptBytes: ptBytes };
}
