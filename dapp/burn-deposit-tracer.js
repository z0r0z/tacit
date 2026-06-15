// Live provenance tracer for the TAC burn-deposit. Given a holder's note to bridge, walks the confidential
// cxfer graph BACKWARD — each note's producing cxfer, then that cxfer's inputs, recursively — until every
// branch reaches the asset's etch supply note C_0. The result is the conserving cxfer DAG that
// burn-deposit-assembler.js turns into the reflect.rs `burnDeposit` witness, which the reflection guest
// verifies (verify_provenance) against the canonical chain.
//
// The cxfer GRAPH itself comes from the worker's reflection indexer via the injected `getCxferByOutput`
// (outpoint → the cxfer that produced it). This module is the pure walk + invariants — no Bitcoin I/O — so
// it is testable in isolation; the worker wires `getCxferByOutput` + fetches the etch/headers/block-txids the
// assembler needs.
export function makeBurnDepositTracer({ outpointKey }) {
  // getCxferByOutput(outpointKeyHex) -> {
  //   txid, inputs:[{prevTxid, prevVout, commitment}], outputs:[{commitment, vout}],
  //   rangeProof, kernelSig, blockTxids:[bytes], index
  // } | null   (null = the outpoint was not produced by a known cxfer)
  //
  // trace({ getCxferByOutput, noteOutpoint, c0Outpoint, leafOutpoints }) -> cxfers[] (the provenance DAG,
  // dedup'd by txid). The walk stops at any SUPPLY LEAF: for a fixed-supply asset that is just C_0; for a
  // MINTABLE asset (§6.1) it is C_0 PLUS each issuer-authorized cmint output (pass `leafOutpoints`). A leaf is
  // not produced by a cxfer — it is the etch supply note or an authorized mint, verified separately by the
  // reflection guest (verify_etch_anchor / verify_cmint_authorized). Throws if a branch dead-ends at an
  // outpoint that is neither a known cxfer output nor a leaf (an un-provable note — the holder cannot bridge
  // it scan-free), or if the walk exceeds `maxDepth`.
  //
  // `leafOutpoints` (array, optional) generalizes `c0Outpoint`; either or both may be given — their union is
  // the leaf set. The mintable caller passes leafOutpoints = [c0, ...cmintOutpoints].
  function trace({ getCxferByOutput, noteOutpoint, c0Outpoint, leafOutpoints, maxDepth = 4096 }) {
    const leaves = new Set(leafOutpoints || []);
    if (c0Outpoint != null) leaves.add(c0Outpoint);
    if (leaves.has(noteOutpoint)) {
      throw new Error('burn-deposit trace: the note is a supply leaf itself (bridge it via a cxfer first)');
    }
    const cxfers = [];
    const seenCxfer = new Set();
    const queue = [noteOutpoint];
    let steps = 0;
    while (queue.length) {
      if (++steps > maxDepth) throw new Error('burn-deposit trace: provenance exceeded maxDepth (' + maxDepth + ')');
      const op = queue.shift();
      if (leaves.has(op)) continue; // a supply leaf — not produced by a cxfer
      const cx = getCxferByOutput(op);
      if (!cx) {
        throw new Error('burn-deposit trace: outpoint not produced by a known cxfer and not a supply leaf: ' + op);
      }
      if (seenCxfer.has(cx.txid)) continue;
      seenCxfer.add(cx.txid);
      cxfers.push(cx);
      for (const inp of cx.inputs) {
        const inOp = outpointKey(inp.prevTxid, inp.prevVout);
        if (!leaves.has(inOp)) queue.push(inOp); // recurse on every non-leaf input (full DAG)
      }
    }
    return cxfers;
  }

  return { trace };
}
