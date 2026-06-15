// Liveness mirror of cxfer-core/src/burn_deposit.rs — the worker/dapp port of the TAC burn-deposit realness
// (scan-free per-bridge provenance to the etch supply note C_0). The AUTHORITATIVE check is the reflection
// guest (the Rust); this mirror lets the worker/assembler decide which burn-deposits to fold WITHOUT trusting
// anything (a fold the JS admits but the guest rejects just doesn't prove). Verdicts must match the Rust —
// see verifyProvenanceDag's KATs (tests/burn-deposit-provenance.mjs) mirroring the 9 Rust cases, and the
// REFLECT-1 desync discipline (Rust == JS on the same vectors).
//
// Deps (injected, same crypto the pool uses so verdicts are byte-identical):
//   outpointKey(txidHex, vout) -> hex     (keccak(txid ‖ vout_le), pool.outpointKey)
//   sha256(Uint8Array) -> Uint8Array      (for the Bitcoin double-SHA merkle path; also the single-SHA cmint msg)
//   verifyCxferConservation(asset, inputOutpoints, inputPoints, outputCompressed, rangeProof, kernelSig, burned) -> bool
//     (burned: public supply a CBURN step destroys, 0 for a pure transfer; verify key P = ΣC_in − ΣC_out − burned·H)
//   commitmentHashCompressed(compressedHex) -> hex   (pool.commitmentHash of the decoded point)
//   decompress(compressedHex) -> point | null
// Mintable (cmint-deposit, §6.1) additionally needs the Bitcoin envelope/tx helpers the worker already has:
//   extractTaprootEnvelope(txHex) -> envHex | null   (the reveal's Taproot witness envelope, env[0]=opcode)
//   parseCmint(envHex) -> { asset, etchTxid, commitment, encryptedAmount, rangeProof, issuerSig } (all hex) | null
//   computeTxid(txHex) -> txidHex                     (internal byte order, == the guest compute_txid)
//   extractInputs(txHex) -> [{ prevTxid, prevVout }] | null
//   bip340Verify(sigHex, msgBytes, pubkeyXHex) -> bool
//   verifyRange(points, rangeProofHex) -> bool        (BP+ range over the minted commitment)
export function makeBurnDepositProvenance({
  outpointKey,
  sha256,
  verifyCxferConservation,
  commitmentHashCompressed,
  decompress,
  extractTaprootEnvelope,
  parseCmint,
  computeTxid,
  extractInputs,
  bip340Verify,
  verifyRange,
} = {}) {
  const stripHex = (h) => (h.startsWith('0x') ? h.slice(2) : h);
  const hexToBytes = (h) => {
    h = stripHex(h);
    const a = new Uint8Array(h.length / 2);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return a;
  };
  const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const concatBytes = (...arrs) => {
    const total = arrs.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  };
  const u32le = (n) => {
    const a = new Uint8Array(4);
    a[0] = n & 0xff; a[1] = (n >>> 8) & 0xff; a[2] = (n >>> 16) & 0xff; a[3] = (n >>> 24) & 0xff;
    return a;
  };
  // Domain for the issuer-authorized-mint signature (mirror of burn_deposit::CMINT_DOMAIN == the dapp's
  // computeMintMsg domain). The message a mint the live dapp accepts is signed under.
  const CMINT_DOMAIN = new TextEncoder().encode('tacit-mint-v1');

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

  // Generalized DAG-linkage check (mirror of burn_deposit::verify_provenance_dag_leaves). Admits MULTIPLE
  // valid supply leaves — for a MINTABLE asset, C_0 PLUS each issuer-authorized cmint output. validLeaves:
  // [[leafOutpointHex, leafCommitmentHashHex]]. cxfers: [{ txid, inputs: [[prevTxidHex, prevVout,
  // spentCommitmentHash]], outputs: [[vout, commitmentHash]] }]. All keys/hashes hex; outpoints via the
  // injected outpointKey (same as the Rust outpoint_key).
  function verifyProvenanceDagLeaves(validLeaves, burnedOutpoint, burnedCommitmentHash, cxfers) {
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
    // 2. resolve every input to a produced output (value-matched) or a valid supply leaf; no outpoint twice.
    const consumed = new Set();
    for (const cx of cxfers) {
      if (!cx.inputs.length) return false;
      for (const [prevTxid, prevVout, inCh] of cx.inputs) {
        const op = outpointKey(prevTxid, prevVout);
        if (consumed.has(op)) return false;
        consumed.add(op);
        const linked = produced.has(op) && produced.get(op) === inCh;
        const isLeaf = validLeaves.some(([lo, lch]) => op === lo && inCh === lch);
        if (!linked && !isLeaf) return false;
      }
    }
    // 3. burned note produced by the DAG and NOT consumed inside it.
    const producedBurned = produced.get(burnedOutpoint) === burnedCommitmentHash;
    const consumedBurned = consumed.has(burnedOutpoint);
    return producedBurned && !consumedBurned;
  }

  // Fixed-supply single-leaf wrapper (mirror of burn_deposit::verify_provenance_dag): leaves = [C_0].
  function verifyProvenanceDag(c0Outpoint, c0CommitmentHash, burnedOutpoint, burnedCommitmentHash, cxfers) {
    return verifyProvenanceDagLeaves(
      [[c0Outpoint, c0CommitmentHash]], burnedOutpoint, burnedCommitmentHash, cxfers,
    );
  }

  // Full realness composition (mirror of burn_deposit::verify_provenance): per-CXFER inclusion +
  // conservation → linkage. cxfers: [{ txid, inputOutpoints:[[prevTxidHex,prevVout]], inputCommitments:[hex],
  // outputCommitments:[hex], outputVouts:[n], rangeProof, kernelSig, merkleSiblings:[hex], merkleIndex,
  // confirmedBlockRoot }]. Returns false (fold nothing) on the first failure.
  function verifyProvenance(asset, c0Outpoint, c0CommitmentHash, burnedOutpoint, burnedCommitmentHash, cxfers) {
    return verifyProvenanceLeaves(
      asset, [[c0Outpoint, c0CommitmentHash]], burnedOutpoint, burnedCommitmentHash, cxfers,
    );
  }

  // MINTABLE form (mirror of burn_deposit::verify_provenance_leaves): the burned note may descend from ANY of
  // validLeaves — C_0 PLUS each issuer-authorized cmint output. Per-CXFER crypto is identical to the
  // fixed-supply form; only the leaf set differs. Each leaf is verified by the caller (C_0 via the etch anchor;
  // each cmint via verifyCmintAuthorized). Returns false (fold nothing) on the first failure.
  function verifyProvenanceLeaves(asset, validLeaves, burnedOutpoint, burnedCommitmentHash, cxfers) {
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
      if (!verifyCxferConservation(asset, cx.inputOutpoints, inputPoints, cx.outputCommitments, cx.rangeProof, cx.kernelSig, cx.burnedAmount || 0)) {
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
    return verifyProvenanceDagLeaves(validLeaves, burnedOutpoint, burnedCommitmentHash, verified);
  }

  // Verify a T_MINT (0x24) reveal is an AUTHORIZED supply leaf for a MINTABLE asset → [leafOutpoint,
  // leafCommitmentHash] (a validLeaves entry), or null (admit nothing). Mirror of
  // burn_deposit::verify_cmint_authorized — see ops/DESIGN-trustless-asset-onboarding.md §6.1. Checks:
  //   - mintable: mintAuthority != 0 (a fixed-supply asset has none);
  //   - asset-bound: the reveal's cmint envelope declares THIS asset;
  //   - commit/reveal pair: the reveal's first input spends the commit tx;
  //   - authorized + non-re-wrappable: BIP-340 verify of issuerSig under mintAuthority over
  //     sha256(CMINT_DOMAIN ‖ asset ‖ commitment ‖ commit_anchor), commit_anchor = the COMMIT tx's first
  //     input outpoint — so one signature can't be re-wrapped into another commit/reveal pair;
  //   - range: the minted commitment is BP+ range-bounded.
  // The leaf note is the reveal's vout-0 commitment. The CALLER confirms the reveal + commit txs are real
  // on-chain (header+merkle), as for the provenance cxfers.
  function verifyCmintAuthorized(asset, mintAuthority, revealTxHex, commitTxHex) {
    if (hexToBytes(mintAuthority).every((b) => b === 0)) return null; // not mintable — no authorized mints
    const env = extractTaprootEnvelope(revealTxHex);
    if (!env) return null;
    const parsed = parseCmint(env);
    if (!parsed) return null;
    const { asset: mintAsset, commitment, encryptedAmount, rangeProof, issuerSig } = parsed;
    if (stripHex(mintAsset) !== stripHex(asset)) return null;
    // commit/reveal pair: the reveal's first input spends the commit tx.
    const commitTxid = computeTxid(commitTxHex);
    const revInputs = extractInputs(revealTxHex);
    if (!revInputs || !revInputs.length) return null;
    if (stripHex(revInputs[0].prevTxid) !== stripHex(commitTxid)) return null;
    // commit_anchor = the commit tx's first input outpoint (binds the sig to THIS pair → no re-wrap).
    // The message is the dapp's canonical computeMintMsg: DOMAIN ‖ asset ‖ anchor_txid ‖ anchor_vout_LE ‖
    // commitment ‖ amount_ct.
    const comInputs = extractInputs(commitTxHex);
    if (!comInputs || !comInputs.length) return null;
    const mintMsg = sha256(concatBytes(
      CMINT_DOMAIN,
      hexToBytes(asset),
      hexToBytes(comInputs[0].prevTxid),
      u32le(comInputs[0].prevVout >>> 0),
      hexToBytes(commitment),
      hexToBytes(encryptedAmount),
    ));
    if (!bip340Verify(issuerSig, mintMsg, mintAuthority)) return null;
    const c = decompress(commitment);
    if (!c) return null;
    if (!verifyRange([c], rangeProof)) return null;
    // the supply leaf: the minted note at the reveal's vout 0.
    return [outpointKey(computeTxid(revealTxHex), 0), commitmentHashCompressed(commitment)];
  }

  return {
    verifyMerklePath,
    verifyProvenanceDag,
    verifyProvenanceDagLeaves,
    verifyProvenance,
    verifyProvenanceLeaves,
    verifyCmintAuthorized,
  };
}
