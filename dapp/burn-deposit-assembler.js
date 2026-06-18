// Assembles the TAC burn-deposit witness (the reflect.rs `burnDeposit` field) from the provenance data the
// worker traces off Bitcoin: the asset's CETCH (committing C_0), the conserving cxfer DAG from the note back
// to C_0, the pre-anchor header chain, the burned note, and the bridge-out (ν → dest). Reuses the pool's IMT
// (foldSpent/foldBurn) for the insert witnesses + a Bitcoin merkle-path builder for inclusion.
//
// Division of labour: the reflection guest's dispatch VALIDATES this witness (verify_provenance over the
// canonical chain); the liveness mirror (burn-deposit-provenance.js) decides WHICH burn-deposits to assemble;
// the LIVE provenance tracing (walking the cxfer graph back to C_0 via the reflection indexer + fetching the
// pre-anchor headers) is the worker's job. This module builds the witness GIVEN that data — the same shape
// gen-reflection-burn-deposit.mjs produces synthetically, so the generator's native-exec exercises it.
//
// GUEST FORMAT CHANGE (pending, gates burn-deposit re-enablement). The guest's burn_deposit.rs now binds each
// provenance/etch/cmint step to the ACTUAL confirmed tx: it derives the txid (computed, not free), the
// CXFER/CETCH/CMINT envelope, and the input outpoints FROM the tx bytes, and authenticates the witness via the
// BIP141 commitment (wtxid merkle path + the same-block coinbase). So each provenance tx now needs, instead of
// a free txid + separately-witnessed inputs/outputs/kernel/range: the full `tx` bytes, the spent-note
// `inputCommitments` (points only; Bitcoin records just the outpoint), the produced `outputVouts`, and the
// witness-commitment proof — `wtxidSiblings` (over the block's wtxids, coinbase wtxid := 0), `coinbase` (the
// tx carrying the 6a24aa21a9ed commitment + reserved-value witness), and `coinbaseTxidSiblings` (the coinbase
// at txid index 0). The worker's tracer must therefore fetch each provenance block's coinbase + wtxids. This
// module, the SP1-stdin serializer + foldBurnDepositTx mirror in confidential-pool.js, and the generator are
// updated together and re-verified by the native-exec gate (gen-reflection-burn-deposit.mjs) before
// burn-deposit onboarding is re-enabled. Until then the serialization below is the pre-change shape.
//
// Deps (injected so the worker + the test generator each supply their own Bitcoin helpers):
//   dsha256(Uint8Array) -> Uint8Array     (double-SHA256, internal order)
//   cat([Uint8Array]) -> Uint8Array
//   bytesToHex(Uint8Array) -> "0x…"       (0x-prefixed, as the guest/harness reads via hexv)
export function makeBurnDepositAssembler({ dsha256, cat, bytesToHex }) {
  // Bitcoin merkle inclusion path (siblings, 0x-hex) for the tx at `index` among `txids` (internal-order
  // bytes). Empty for a single-tx block. Mirrors compute_merkle_root's odd-leaf duplication.
  function merkleSiblings(txids, index) {
    const sibs = [];
    let layer = txids.map((t) => Uint8Array.from(t));
    let idx = index >>> 0;
    while (layer.length > 1) {
      const sibIdx = (idx ^ 1) < layer.length ? (idx ^ 1) : idx;
      sibs.push(bytesToHex(layer[sibIdx]));
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        const l = layer[i];
        const r = i + 1 < layer.length ? layer[i + 1] : layer[i];
        next.push(dsha256(cat([l, r])));
      }
      layer = next;
      idx = idx >>> 1;
    }
    return sibs;
  }
  function merkleRoot(txids) {
    let layer = txids.map((t) => Uint8Array.from(t));
    while (layer.length > 1) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        const l = layer[i];
        const r = i + 1 < layer.length ? layer[i + 1] : layer[i];
        next.push(dsha256(cat([l, r])));
      }
      layer = next;
    }
    return bytesToHex(layer[0]);
  }

  // Build the burnDeposit witness.
  //   etch:       { tx:"0x…", blockTxids:[bytes], index }
  //   provHeaders:["0x…"] (the pre-anchor chain whose tip == the batch anchor's prev_hash)
  //   cxfers:     [{ txid:"0x…", inputs:[{prevTxid,prevVout,commitment}], outputs:[{commitment,vout}],
  //                  rangeProof:"0x…", kernelSig:"0x…", blockTxids:[bytes], index }]
  //   burned:     { cx:"0x…", cy:"0x…" }
  //   burnedNoteLeaf: "0x…" — leaf(asset, cx, cy, ZERO_OWNER); the proven-real note appended to the pool
  //                   tree so OP_BRIDGE_MINT binds v_mint == v_burn (caller computes via pool.leaf)
  //   nu, dest:   "0x…" (the burned note's nullifier + the bridge-out destination commitment)
  //   scanState:  pool.makeScanReflectionState() positioned at the batch's prior (advances on fold*)
  // The STATE-INDEPENDENT part of the witness: the etch + cxfers + cmints with their Bitcoin merkle paths
  // resolved. The live worker builds this from the holder-traced provenance; the canonical scan
  // (foldBurnDepositTx) then appends the state-dependent IMT inserts at the fold point.
  function buildBurnDepositStatic({ etch, provHeaders, cxfers, cmints = [] }) {
    return {
      etchTx: etch.tx,
      etchIndex: etch.index,
      etchSiblings: merkleSiblings(etch.blockTxids, etch.index),
      provHeaders,
      cxfers: cxfers.map((c) => ({
        txid: c.txid,
        inputs: c.inputs,
        outputs: c.outputs,
        burnedAmount: c.burnedAmount || 0, // 0 for a transfer; > 0 for a CBURN step (Σ C_in = burned·H + Σ C_out)
        rangeProof: c.rangeProof,
        kernelSig: c.kernelSig,
        merkleSiblings: merkleSiblings(c.blockTxids, c.index),
        merkleIndex: c.index,
        confirmedBlockRoot: merkleRoot(c.blockTxids),
      })),
      // mintable: issuer-authorized cmints in the lineage (revealTx + commitTx + reveal merkle inclusion).
      // Empty for fixed-supply. cm: { revealTx, commitTx, blockTxids, index }.
      cmints: cmints.map((cm) => ({
        revealTx: cm.revealTx,
        commitTx: cm.commitTx,
        merkleSiblings: merkleSiblings(cm.blockTxids, cm.index),
        merkleIndex: cm.index,
      })),
    };
  }

  function assembleBurnDeposit({ etch, provHeaders, cxfers, cmints = [], burned, burnedNoteLeaf, nu, dest, scanState }) {
    return {
      ...buildBurnDepositStatic({ etch, provHeaders, cxfers, cmints }),
      burnedCx: burned.cx,
      burnedCy: burned.cy,
      // Fold order mirrors the guest dispatch: fold_spent → fold_note_append → fold_burn (independent
      // accumulators, but kept in lockstep). foldNoteAppend onboards the burned note as a pool member.
      spentInsert: scanState.foldSpent(nu),
      notePath: scanState.foldNoteAppend(burnedNoteLeaf).notePath,
      burnInsert: scanState.foldBurn(nu, dest),
    };
  }

  return { assembleBurnDeposit, buildBurnDepositStatic, merkleSiblings, merkleRoot };
}
