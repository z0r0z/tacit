// Worker-side reflection attestation (Phase 4.4 wiring). Maintains the canonical confidential-pool
// reflection state from the worker's confirmed-CXFER scan, and runs attestation cycles: assemble a
// prover batch → prove on the GPU box → submit ConfidentialPool.attestBitcoinStateProven.
//
// Dependency-injected so it is testable + deployment-agnostic. The deployment provides:
//   deps      : { secp, keccak256, sha256 } (the @noble crypto)
//   storage   : { load(): Promise<{ effectLog, attestedCount }>, save(state): Promise<void> } (KV/Postgres)
//   prove     : (input) => Promise<{ vkey, publicValues, proofBytes }>  — the GPU box (tETH-style loop:
//               the worker enqueues `input`, the box proves exec-reflect-prove.rs, returns the proof)
//   submit    : (publicValues, proofBytes) => Promise<txHash>  — attestBitcoinStateProven via RPC + relay key
//   getHeaders: (blockHeights) => Promise<hex[]>  — the 80-byte headers for the batch's blocks
//
// The confirmed effect log is the source of truth: state is rebuilt by replaying it (the canonical
// Bitcoin pool effects, ordered by block + tx index), so a restart/redeploy is always consistent.

import { makeReflectionIndexer } from '../../dapp/confidential-reflection-indexer.js';

export function makeReflectionAttester({ deps, storage, prove, submit, getHeaders }) {
  // Replay the persisted effect log into a fresh indexer → the current canonical state.
  async function rebuild() {
    const { effectLog = [], attestedCount = 0 } = (await storage.load()) || {};
    const idx = makeReflectionIndexer(deps);
    // deposits first (notes entering), then the ordered transfers/burns that spend them.
    const resolved = [];
    for (const eff of effectLog) {
      if (eff.kind === 'deposit') {
        idx.applyDeposits([idx.recordDeposit(eff.deposit)], eff.height);
      } else if (eff.kind === 'transfer') {
        resolved.push({ raw: eff, spec: idx.resolveTransfer(eff.raw) });
      } else if (eff.kind === 'burn') {
        resolved.push({ raw: eff, spec: idx.resolveBurn(eff.raw) });
      }
    }
    return { idx, effectLog, attestedCount, resolved };
  }

  // The scan calls this when a confirmed pool effect lands (ordered by block + tx index).
  async function ingest(eff) {
    const { effectLog = [], attestedCount = 0 } = (await storage.load()) || {};
    effectLog.push(eff);
    await storage.save({ effectLog, attestedCount });
  }

  // The cron calls this. Assemble the un-attested batch → prove → submit → advance the attested
  // cursor. No-op if nothing is pending. Returns the attestation tx hash (or null).
  async function runCycle() {
    const { idx, effectLog, attestedCount, resolved } = await rebuild();
    const pending = resolved.slice(attestedCount); // transfers/burns not yet attested
    if (pending.length === 0) return null;

    // advance the canonical state past the already-attested effects (so `prior` is the attested anchor)
    const attested = resolved.slice(0, attestedCount);
    if (attested.length) idx.assembleBatch(attested.map((r) => r.spec), { headers: [], anchorHeight: 0 });

    const blocks = [...new Set(pending.map((r) => r.spec.blockIndex))];
    const headers = await getHeaders(blocks);
    const anchorHeight = Math.min(...pending.map((r) => r.raw.height));
    // re-key block indices to the batch's header array
    const specs = pending.map((r) => ({ ...r.spec, blockIndex: blocks.indexOf(r.spec.blockIndex) }));

    const input = idx.assembleBatch(specs, { headers, anchorHeight });
    const { vkey, publicValues, proofBytes } = await prove(input);
    const txHash = await submit(publicValues, proofBytes);

    await storage.save({ effectLog, attestedCount: resolved.length });
    return { txHash, vkey, newDigest: input.newDigest, attested: pending.length };
  }

  return { ingest, runCycle, rebuild };
}
