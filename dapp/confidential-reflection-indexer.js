// The Bitcoin reflection indexer (Phase 4.4). Maintains the canonical confidential-pool state
// (makeReflectionState) + the outpoint→note-coords map, resolves confirmed CXFER/burn effects the
// worker decodes from its existing scan, and assembles the reflection prover's input for an
// attestation batch. Pipeline: worker CXFER scan → resolveTransfer/resolveBurn → assembleBatch →
// GPU box (exec-reflect-prove.rs) → ConfidentialPool.attestBitcoinStateProven.
//
// The worker provides pre-parsed effects (it already decodes T_CXFER/T_CXFER_BPP/T_BRIDGE_BURN +
// the tx vins/inclusion). The indexer owns the stateful resolution (a spent outpoint → the real
// note's commitment coords, from prior outputs) + the canonical fold.

import { makeConfidentialPool } from './confidential-pool.js';

const ZERO_OWNER = '0x' + '00'.repeat(32);

export function makeReflectionIndexer({ secp, keccak256, sha256, ownerTag } = {}) {
  const pool = makeConfidentialPool({ secp, keccak256, sha256 });
  const OWNER = ownerTag || ZERO_OWNER;
  const state = pool.makeReflectionState();
  const coords = new Map(); // outpointKey (lowercased hex) → { cx, cy }

  const norm = (o) => o.toLowerCase();
  const record = (outpoint, cx, cy) => coords.set(norm(outpoint), { cx, cy });
  function resolve(prevTxid, vout) {
    const op = pool.outpointKey(prevTxid, vout);
    const c = coords.get(norm(op));
    if (!c) throw new Error('spent outpoint not a known pool output: ' + op);
    return { cx: c.cx, cy: c.cy, outpoint: op };
  }

  // Resolve a confirmed CXFER transfer (worker-decoded) into the effect spec assembleReflectionInput
  // folds. rawEff: { txid, assetId, height, blockIndex, txData, txIndex, txids,
  // spentVins: [{prevTxid, vout}], outputCommitments: [compressed-33 hex] }. Records the new
  // outputs' coords (for future spends) and drops the spent ones.
  function resolveTransfer(rawEff) {
    const spends = rawEff.spentVins.map(({ prevTxid, vout }) => resolve(prevTxid, vout));
    const outputs = rawEff.outputCommitments.map((comm, j) => {
      const { cx, cy } = pool.decompressCommitment(comm);
      const outpoint = pool.outpointKey(rawEff.txid, j); // CXFER vout = output index
      record(outpoint, cx, cy);
      return {
        noteLeaf: pool.leaf(rawEff.assetId, cx, cy, OWNER),
        outpoint,
        commitmentHash: pool.commitmentHash(cx, cy),
        vout: j,
      };
    });
    spends.forEach((s) => coords.delete(norm(s.outpoint)));
    return { type: 'transfer', blockIndex: rawEff.blockIndex, txData: rawEff.txData, txIndex: rawEff.txIndex, txids: rawEff.txids, spends, outputs, height: rawEff.height };
  }

  // Resolve a confirmed bridge-out (the destCommitment comes from the envelope, so the prover binds
  // it — the indexer only needs the spend). rawEff adds { spentVin: {prevTxid, vout} }.
  function resolveBurn(rawEff) {
    const { cx, cy } = resolve(rawEff.spentVin.prevTxid, rawEff.spentVin.vout);
    const outpoint = pool.outpointKey(rawEff.spentVin.prevTxid, rawEff.spentVin.vout);
    coords.delete(norm(outpoint));
    return { type: 'bridge_out', blockIndex: rawEff.blockIndex, txData: rawEff.txData, txIndex: rawEff.txIndex, txids: rawEff.txids, burn: { cx, cy, outpoint, destCommitment: rawEff.destCommitment }, height: rawEff.height };
  }

  // A note entering the pool (a deposit, or genesis seeding): record its coords and return the
  // output spec. The caller folds these via applyDeposits before the transfers that spend them.
  function recordDeposit({ assetId, txid, vout, cx, cy }) {
    const outpoint = pool.outpointKey(txid, vout);
    record(outpoint, cx, cy);
    return { noteLeaf: pool.leaf(assetId, cx, cy, OWNER), outpoint, commitmentHash: pool.commitmentHash(cx, cy), vout };
  }

  // Fold deposit outputs into the canonical state (no spends) at `height`.
  function applyDeposits(deposits, height) {
    state.applyTransfer([], deposits.map((d) => ({ noteLeaf: d.noteLeaf, outpoint: d.outpoint, commitmentHash: d.commitmentHash })), height);
  }

  // Assemble the prover input for a batch of resolved effects, advancing the canonical state.
  // headers = the batch's block headers (80-byte hex), anchorHeight = headers[0]'s confirmed height.
  function assembleBatch(effects, { headers, anchorHeight }) {
    return pool.assembleReflectionInput(state, { anchorHeight, headers, effects });
  }

  return {
    pool, state, resolveTransfer, resolveBurn, recordDeposit, applyDeposits, assembleBatch,
    digest: () => state.digest(),
    roots: () => state.commit(),
    knownOutpoints: () => coords.size,
  };
}
