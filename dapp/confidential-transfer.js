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
  const hexToBytes = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));
  const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };
  const ptBytes = (P) => P.toRawBytes(true); // 33-byte compressed
  const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
  const b32 = (h) => { const b = hexToBytes(h); if (b.length > 32) throw new Error('over 32 bytes'); const o = new Uint8Array(32); o.set(b, 32 - b.length); return o; };
  const u16be = (n) => Uint8Array.of((Number(n) >> 8) & 0xff, Number(n) & 0xff);
  const mul = (P, s) => (s === 0n || P.equals(ZERO)) ? ZERO : P.multiply(modN(s));
  const sum = (pts) => pts.reduce((a, p) => a.add(p), ZERO);
  const commit = (v, r) => H.multiply(v).add(mul(G, r));
  const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
  // Bitcoin-side destination leaf = keccak(asset ‖ cx ‖ cy ‖ owner) — same layout
  // as confidential-pool.leaf(), so the cross-minted note is byte-identical.
  const destLeaf = (assetId, cx, cy, owner) => '0x' + bytesToHex(keccak256(concat([b32(assetId), b32(cx), b32(cy), b32(owner)])));
  // claimId = keccak(abi.encodePacked(destChain:uint16, destCommitment:bytes32,
  // nullifier:bytes32, assetId:bytes32)) — mirrors ConfidentialPool.settle's re-derivation.
  const claimId = (destChain, destCommitment, nullifier, assetId) =>
    '0x' + bytesToHex(keccak256(concat([u16be(destChain), b32(destCommitment), b32(nullifier), b32(assetId)])));

  // `outLeaves` (ordered output leaf hashes) bind the output OWNER into the kernel for ops that emit
  // fresh prover-supplied-owner leaves (transfer / wrap-transfer / send-unwrap change), mirroring the
  // guest's verify_kernel_with_fee_bound (leaves hashed AFTER out points, BEFORE R). Empty ⇒ the original
  // transcript (bridge-burn / crossout, which force ZERO_OWNER or bind owner elsewhere, pass none).
  function kernelChallenge(inC, outC, R, outLeaves = []) {
    const parts = [KERNEL_DOMAIN];
    for (const P of inC) parts.push(ptBytes(P));
    for (const P of outC) parts.push(ptBytes(P));
    for (const lf of outLeaves) parts.push(b32(lf));
    parts.push(ptBytes(R));
    return modN(BigInt('0x' + bytesToHex(keccak256(concat(parts)))));
  }

  // Low-level conservation-kernel signer for ops that bind a NON-note out-leaf (e.g. the stealth blind LOCK
  // leaf) or no leaf at all (bridge-stealth, where burn-set membership pins it). Returns the kernel { R, z }
  // over Σin = Σout + fee with the given ordered `outLeaves` bound, mirroring verify_kernel_with_fee_bound.
  // No range proof (the caller adds one only where the guest reads it). The fee is public ⇒ excess = Σr_in − Σr_out.
  function kernelSign({ inputs, outputs, fee = 0n, outLeaves = [] }) {
    const f = BigInt(fee);
    if (inputs.reduce((s, i) => s + i.value, 0n) !== outputs.reduce((s, o) => s + o.value, 0n) + f) {
      throw new Error('kernelSign: Σin ≠ Σout + fee');
    }
    const inC = inputs.map((i) => commit(i.value, i.blinding));
    const outC = outputs.map((o) => commit(o.value, o.blinding));
    const excess = modN(inputs.reduce((s, i) => s + i.blinding, 0n) - outputs.reduce((s, o) => s + o.blinding, 0n));
    const k = randomScalar();
    const R = mul(G, k);
    const e = kernelChallenge(inC, outC, R, outLeaves);
    return { R, z: modN(k + e * excess), inC, outC };
  }

  // inputs: [{ value, blinding }]; outputs: [{ value, blinding, owner }] with Σ value equal (modulo fee).
  // `assetId` + each output `owner` bind the output LEAF into the kernel (so a delegated prover can't mutate
  // an output owner into an unspendable leaf). Output count m must be in {1, 2, 4, 8} (BP+ aggregation).
  function buildTransfer({ inputs, outputs, fee = 0n, assetId }) {
    const f = BigInt(fee);
    const sumIn = inputs.reduce((s, i) => s + i.value, 0n);
    const sumOut = outputs.reduce((s, o) => s + o.value, 0n);
    // Conservation with a public relay fee: Σin = Σout + fee. The fee leaves the shielded set as a
    // FeePayment (in the transfer asset); fee = 0 ⇒ the original Σin = Σout transfer.
    if (sumIn !== sumOut + f) throw new Error('transfer not conserved: Σin ≠ Σout + fee');

    const { proof: rangeProof, commitments: outC } =
      bppRangeProve(outputs.map((o) => o.value), outputs.map((o) => o.blinding));
    const inC = inputs.map((i) => commit(i.value, i.blinding));
    // Output leaves (owner-bound) — keccak(asset‖cx‖cy‖owner), byte-identical to the guest's leaf().
    const outLeaves = outC.map((P, j) => {
      const { cx, cy } = xy(P);
      return destLeaf(assetId, cx, cy, outputs[j].owner);
    });

    // The fee is public (no blinding), so the kernel excess is unchanged: Σr_in − Σr_out.
    const excess = modN(
      inputs.reduce((s, i) => s + i.blinding, 0n) - outputs.reduce((s, o) => s + o.blinding, 0n)
    );
    const k = randomScalar();
    const R = mul(G, k);
    const e = kernelChallenge(inC, outC, R, outLeaves);
    const z = modN(k + e * excess);

    return { inC, outC, rangeProof, kernel: { R, z }, fee: f, outLeaves };
  }

  // Kernel-only conservation check (no range proof) — for ops whose range is bounded elsewhere or absent
  // (stealth blind lock / bridge-stealth mint). Mirrors verify_kernel_with_fee_bound.
  function verifyKernel({ inC, outC, fee = 0n, kernel, outLeaves = [] }) {
    let X = sum(inC).add(sum(outC).negate());
    if (BigInt(fee) !== 0n) X = X.add(mul(H, BigInt(fee)).negate()); // multiply-by-0 throws in noble
    const e = kernelChallenge(inC, outC, kernel.R, outLeaves);
    return mul(G, kernel.z).equals(kernel.R.add(mul(X, e)));
  }

  // Verifies ranges + conservation. Returns true iff the transfer creates no
  // value and contains no negative output.
  function verifyTransfer({ inC, outC, rangeProof, kernel, fee = 0n, outLeaves = [] }) {
    if (!bppRangeVerify(outC, rangeProof)) return false;
    const f = BigInt(fee);
    // Σ C_in − Σ C_out − fee·H (the public fee leaves the shielded set); fee = 0 ⇒ the original check.
    const X = sum(inC).add(sum(outC).negate()).add(mul(H, f).negate());
    const e = kernelChallenge(inC, outC, kernel.R, outLeaves);
    const lhs = mul(G, kernel.z);                        // z·G
    const rhs = kernel.R.add(mul(X, e));                 // R + e·X
    return lhs.equals(rhs);
  }

  // A bridge-burn (Ethereum → Bitcoin): the same conservation + range proof as a
  // transfer, but the outputs are destination notes that will be MINTED ON BITCOIN
  // rather than appended as Ethereum leaves. Each output yields a `crossOut`
  // record {destChain, destCommitment, nullifier, assetId, claimId} that the
  // contract emits (CrossOutRecorded) for Bitcoin validators to honor once-and-
  // past-finality. Conservation across the chain boundary: Σ value_in (Ethereum,
  // burned) = Σ value_out (Bitcoin, minted).
  //
  // inputs: [{value, blinding}] (Ethereum notes being burned, nullified).
  // outputs: [{value, blinding, owner}] (Bitcoin destination notes; owner = the
  //   recipient's Bitcoin owner field). Count m ∈ {1, 2, 4, 8}.
  // bindNullifier: the burn's canonical nullifier (the first input's ν), binding
  //   every claimId of this burn to a specific consumed note (anti-replay).
  function buildBridgeBurn({ inputs, outputs, assetId, destChain, bindNullifier, fee = 0n }) {
    const f = BigInt(fee);
    const sumIn = inputs.reduce((s, i) => s + i.value, 0n);
    const sumOut = outputs.reduce((s, o) => s + o.value, 0n);
    // Conservation across the boundary, net of the relay fee: Σin (ETH burned) = Σout (BTC minted) + fee.
    if (sumIn !== sumOut + f) throw new Error('bridge-burn not conserved: Σin ≠ Σout + fee');

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

    const crossOuts = outC.map((C, j) => {
      const { cx, cy } = xy(C);
      const destCommitment = destLeaf(assetId, cx, cy, outputs[j].owner);
      return {
        destChain,
        destCommitment,
        nullifier: bindNullifier,
        assetId,
        claimId: claimId(destChain, destCommitment, bindNullifier, assetId),
        cx, cy, owner: outputs[j].owner,
      };
    });

    return { inC, outC, rangeProof, kernel: { R, z }, crossOuts, fee: f };
  }

  // Verifies a bridge-burn: ranges + conservation (as a transfer) + that every
  // crossOut's claimId binds its own (destChain, destCommitment, ν, assetId).
  function verifyBridgeBurn({ inC, outC, rangeProof, kernel, crossOuts, fee = 0n }) {
    if (!verifyTransfer({ inC, outC, rangeProof, kernel, fee })) return false;
    for (let j = 0; j < crossOuts.length; j++) {
      const c = crossOuts[j];
      const expectLeaf = destLeaf(c.assetId, c.cx, c.cy, c.owner);
      if (expectLeaf.toLowerCase() !== String(c.destCommitment).toLowerCase()) return false;
      const expectClaim = claimId(c.destChain, c.destCommitment, c.nullifier, c.assetId);
      if (expectClaim.toLowerCase() !== String(c.claimId).toLowerCase()) return false;
    }
    return true;
  }

  // Standalone aggregated BP+ range proof over `values` (with `blindings`) — for an output whose conservation
  // kernel is unbound (e.g. the bridge-stealth lock L, range-bounded so the relay fee can't exceed the burn).
  function rangeProve(values, blindings) { return bppRangeProve(values, blindings); }

  return { H, commit, kernelSign, verifyKernel, rangeProve, buildTransfer, verifyTransfer, buildBridgeBurn, verifyBridgeBurn, claimId, destLeaf, _ptBytes: ptBytes };
}
