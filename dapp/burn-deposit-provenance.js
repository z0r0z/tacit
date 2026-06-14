// Liveness mirror of cxfer-core/src/burn_deposit.rs — the worker/dapp port of the TAC burn-deposit realness
// (scan-free per-bridge provenance to the etch supply note C_0). The AUTHORITATIVE check is the reflection
// guest (the Rust); this mirror lets the worker/assembler decide which burn-deposits to fold WITHOUT trusting
// anything (a fold the JS admits but the guest rejects just doesn't prove). Verdicts must match the Rust —
// see verifyProvenanceDag's KATs (tests/burn-deposit-provenance.mjs) mirroring the 9 Rust cases, and the
// REFLECT-1 desync discipline (Rust == JS on the same vectors).
//
// Deps (injected, same crypto the pool uses so verdicts are byte-identical):
//   outpointKey(txidHex, vout) -> hex     (keccak(txid ‖ vout_le), pool.outpointKey)
//   sha256(Uint8Array) -> Uint8Array      (for the Bitcoin double-SHA merkle path)
//   verifyCxferConservation(asset, inputOutpoints, inputPoints, outputCompressed, rangeProof, kernelSig) -> bool
//   commitmentHashCompressed(compressedHex) -> hex   (pool.commitmentHash of the decoded point)
//   decompress(compressedHex) -> point | null
export function makeBurnDepositProvenance({
  outpointKey,
  sha256,
  verifyCxferConservation,
  commitmentHashCompressed,
  decompress,
} = {}) {
  const stripHex = (h) => (h.startsWith('0x') ? h.slice(2) : h);
  const hexToBytes = (h) => {
    h = stripHex(h);
    const a = new Uint8Array(h.length / 2);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return a;
  };
  const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

  // Bitcoin merkle inclusion PATH (mirror of bitcoin::verify_merkle_path): fold txid with its siblings
  // bottom-up, left/right by each level's index bit, double-SHA256 of left‖right (internal order). Returns
  // the resulting root (hex). The caller asserts it equals a relay-confirmed block merkle root.
  function verifyMerklePath(txidHex, siblingsHex, index) {
    let acc = hexToBytes(txidHex);
    let idx = index >>> 0;
    for (const sibHex of siblingsHex) {
      const sib = hexToBytes(sibHex);
      const combined = new Uint8Array(64);
      if ((idx & 1) === 0) {
        combined.set(acc, 0);
        combined.set(sib, 32);
      } else {
        combined.set(sib, 0);
        combined.set(acc, 32);
      }
      acc = sha256(sha256(combined));
      idx = idx >>> 1;
    }
    return bytesToHex(acc);
  }

  // Pure DAG-linkage check (mirror of burn_deposit::verify_provenance_dag). cxfers: [{ txid, inputs:
  // [[prevTxidHex, prevVout, spentCommitmentHash]], outputs: [[vout, commitmentHash]] }]. All keys/hashes
  // are hex strings; outpoints are derived via the injected outpointKey (same as the Rust outpoint_key).
  function verifyProvenanceDag(c0Outpoint, c0CommitmentHash, burnedOutpoint, burnedCommitmentHash, cxfers) {
    if (!cxfers.length) return false;
    // 1. index produced outputs (outpoint → commitment hash); reject a duplicate produced outpoint.
    const produced = new Map();
    for (const cx of cxfers) {
      if (!cx.outputs.length) return false;
      for (const [vout, ch] of cx.outputs) {
        const op = outpointKey(cx.txid, vout);
        if (produced.has(op)) return false;
        produced.set(op, ch);
      }
    }
    // 2. resolve every input to a produced output (value-matched) or the C_0 leaf; no outpoint twice.
    const consumed = new Set();
    for (const cx of cxfers) {
      if (!cx.inputs.length) return false;
      for (const [prevTxid, prevVout, inCh] of cx.inputs) {
        const op = outpointKey(prevTxid, prevVout);
        if (consumed.has(op)) return false;
        consumed.add(op);
        const linked = produced.has(op) && produced.get(op) === inCh;
        const isC0 = op === c0Outpoint && inCh === c0CommitmentHash;
        if (!linked && !isC0) return false;
      }
    }
    // 3. burned note produced by the DAG and NOT consumed inside it.
    const producedBurned = produced.get(burnedOutpoint) === burnedCommitmentHash;
    const consumedBurned = consumed.has(burnedOutpoint);
    return producedBurned && !consumedBurned;
  }

  // Full realness composition (mirror of burn_deposit::verify_provenance): per-CXFER inclusion +
  // conservation → linkage. cxfers: [{ txid, inputOutpoints:[[prevTxidHex,prevVout]], inputCommitments:[hex],
  // outputCommitments:[hex], outputVouts:[n], rangeProof, kernelSig, merkleSiblings:[hex], merkleIndex,
  // confirmedBlockRoot }]. Returns false (fold nothing) on the first failure.
  function verifyProvenance(asset, c0Outpoint, c0CommitmentHash, burnedOutpoint, burnedCommitmentHash, cxfers) {
    if (!cxfers.length) return false;
    const verified = [];
    for (const cx of cxfers) {
      if (cx.inputCommitments.length !== cx.inputOutpoints.length) return false;
      if (cx.outputCommitments.length !== cx.outputVouts.length) return false;
      // 1. inclusion
      if (verifyMerklePath(cx.txid, cx.merkleSiblings, cx.merkleIndex) !== cx.confirmedBlockRoot) return false;
      // 2. conservation (value + asset, bound to the one asset)
      const inputPoints = [];
      for (const c of cx.inputCommitments) {
        const p = decompress(c);
        if (!p) return false;
        inputPoints.push(p);
      }
      if (!verifyCxferConservation(asset, cx.inputOutpoints, inputPoints, cx.outputCommitments, cx.rangeProof, cx.kernelSig)) {
        return false;
      }
      // 3. linkage shape — commitment hashes from the SAME commitments conservation verified
      const inputs = cx.inputOutpoints.map(([prevTxid, prevVout], i) => [
        prevTxid,
        prevVout,
        commitmentHashCompressed(cx.inputCommitments[i]),
      ]);
      const outputs = cx.outputCommitments.map((c, i) => [cx.outputVouts[i], commitmentHashCompressed(c)]);
      verified.push({ txid: cx.txid, inputs, outputs });
    }
    return verifyProvenanceDag(c0Outpoint, c0CommitmentHash, burnedOutpoint, burnedCommitmentHash, verified);
  }

  return { verifyMerklePath, verifyProvenanceDag, verifyProvenance };
}
