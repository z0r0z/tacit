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
  // trace({ getCxferByOutput, noteOutpoint, c0Outpoint }) -> cxfers[] (the provenance DAG, dedup'd by txid)
  // Throws if a branch dead-ends at an outpoint that is neither a known cxfer output nor C_0 (an
  // un-provable note — the holder cannot bridge it scan-free), or if the walk exceeds `maxDepth`.
  function trace({ getCxferByOutput, noteOutpoint, c0Outpoint, maxDepth = 4096 }) {
    if (noteOutpoint === c0Outpoint) {
      throw new Error('burn-deposit trace: the note is C_0 itself (bridge the etch supply via a cxfer first)');
    }
    const cxfers = [];
    const seenCxfer = new Set();
    const queue = [noteOutpoint];
    let steps = 0;
    while (queue.length) {
      if (++steps > maxDepth) throw new Error('burn-deposit trace: provenance exceeded maxDepth (' + maxDepth + ')');
      const op = queue.shift();
      if (op === c0Outpoint) continue; // C_0 is the etch supply note — a leaf, not produced by a cxfer
      const cx = getCxferByOutput(op);
      if (!cx) {
        throw new Error('burn-deposit trace: outpoint not produced by a known cxfer and != C_0: ' + op);
      }
      if (seenCxfer.has(cx.txid)) continue;
      seenCxfer.add(cx.txid);
      cxfers.push(cx);
      for (const inp of cx.inputs) {
        const inOp = outpointKey(inp.prevTxid, inp.prevVout);
        if (inOp !== c0Outpoint) queue.push(inOp); // recurse on every non-C_0 input (full DAG)
      }
    }
    return cxfers;
  }

  return { trace };
}
