// ─────────────────────────────────────────────────────────────────────────────
// Settle relay — the confidential-op settle loop (network prove edition).
//
// Render service type: Background Worker (long-running). Mirrors
// ops/scripts/confidential-settle-loop.sh, GPU swapped for the Succinct network prover.
//
// Cycle:
//   1. GET /confidential/job → the next queued user op {jobId, type, op, memos, mode}.
//   2. feeGate(job): reject an unprofitable job (proof-bound fee < cost + margin) so
//      relaying stays profitable / spam-resistant while it's paying gas.
//   3. proveSettle({type, op}, timeout) → exec harness groth16 on Succinct, with a
//      per-job wall-clock ceiling so one poison witness can't wedge the FIFO.
//   4. settle(pv, proof, memos) with the SETTLE key — the proof-bound fee is paid to
//      msg.sender (the relay) inside the settle; the relayer cannot inflate/redirect it.
//   5. POST /confidential/ack {jobId, txHash} (or {jobId, error} on failure).
//
// settle is permissionless: the contract independently verifies the proof against
// PROGRAM_VKEY. The relay never holds user funds or sees spending keys — only opening
// sigmas in the witness. It can only earn the bound fee.
// ─────────────────────────────────────────────────────────────────────────────

import { CFG, OP_GAS, DEFAULT_OP_GAS, OP_PROVE } from './lib/config.js';
import { confidentialJob, confidentialAck, heartbeat } from './lib/worker-client.js';
import { proveSettle } from './lib/prover.js';
import { settleWallet, publicClient, POOL, POOL_ABI } from './lib/chain.js';
import { quoteRelayFee } from './replenish.js';

const log = (...a) => console.log(`[settle ${new Date().toISOString()}]`, ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Reject a job whose proof-bound fee doesn't cover its all-in cost + margin.
// The fee is carved from the op input and enforced by the guest, so the worker
// already knows the USD value it will collect: the op carries feeUsd (preferred),
// or feeAsset/feeAmountUsd. If it's absent we can't price it — self-settle jobs
// (mode 'prove' or user-pays-gas) bypass the gate.
export async function feeGate(job, liveGasGwei, provePriceUsd) {
  if (job.mode === 'prove') return { ok: true, reason: 'prove-only (no on-chain submit)' };
  const feeUsd = Number(job.op?.feeUsd ?? job.feeUsd ?? NaN);
  if (!Number.isFinite(feeUsd)) {
    // Can't price the bound fee → do not block launch volume, but flag it.
    return { ok: true, reason: 'fee not priced (accepted; TODO wire op.feeUsd)' };
  }
  const q = quoteRelayFee({
    op: job.type,
    tradeSizeUsd: Number(job.op?.tradeSizeUsd ?? 0),
    liveGasGwei,
    provePriceUsd,
  });
  if (feeUsd + 1e-9 < q.costUsd) {
    return { ok: false, reason: `bound fee $${feeUsd.toFixed(4)} < cost $${q.costUsd.toFixed(4)}` };
  }
  return { ok: true, reason: `fee $${feeUsd.toFixed(4)} ≥ cost $${q.costUsd.toFixed(4)}`, quote: q };
}

async function liveGasGwei() {
  try {
    const gp = await publicClient.getGasPrice();
    return Number(gp) / 1e9;
  } catch { return 1; } // fall back to ~1 gwei (PRICING doc centers here)
}

async function cycle() {
  const job = await confidentialJob();
  const jobId = job?.jobId;
  if (!jobId) return false; // empty queue

  const type = job.type;
  const mode = job.mode || 'settle';
  const memos = Array.isArray(job.memos) ? job.memos : [];
  if (!OP_GAS[type] && type !== 'transfer') {
    // unknown-but-provable ops still allowed; gas defaults. Only truly-unknown type fails at prove.
  }

  const gasGwei = await liveGasGwei();
  const gate = await feeGate(job, gasGwei, CFG.provePriceUsd);
  if (!gate.ok) {
    log(`job ${jobId} type=${type} rejected by feeGate: ${gate.reason}`);
    await confidentialAck({ jobId, error: `feeGate: ${gate.reason}` });
    return true;
  }

  log(`job ${jobId} type=${type} mode=${mode} — proving (network groth16). ${gate.reason}`);
  await heartbeat('settle', `proving ${jobId} ${type}`);

  let proof;
  if (mode === 'preproven' && job.publicValues && job.proof) {
    // The proof was produced elsewhere (a cold-box failover, or the user's own local prover — the private,
    // fee-free path where the witness never reached the relay). Skip proving; just settle the supplied proof.
    proof = { publicValues: job.publicValues, proof: job.proof };
    log(`job ${jobId} type=${type} preproven — settling supplied proof (no relay prove)`);
  } else {
    try {
      proof = await proveSettle({ type, op: job.op, memos, timeoutMs: CFG.settleJobTimeoutSecs * 1000 });
    } catch (e) {
      log(`job ${jobId} prove failed/timeout: ${e.message}`);
      await confidentialAck({ jobId, error: `prove failed: ${e.message.slice(0, 200)}` });
      return true; // acked failed → FIFO advances, no wedge
    }
  }

  if (mode === 'prove') {
    // Prove-only: hand the proof back for a user-sent tx (no on-chain submit here).
    // The worker's /confidential/ack accepts {publicValues, proof} in prove mode.
    try {
      await fetch(`${CFG.workerBase}/confidential/ack`, {
        method: 'POST',
        headers: { authorization: `Bearer ${CFG.boxToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, publicValues: proof.publicValues, proof: proof.proof }),
      });
    } catch { /* worker reclaims on TTL */ }
    log(`proved-only: job=${jobId}`);
    return true;
  }

  let txHash;
  try {
    txHash = await settleWallet.writeContract({
      address: POOL, abi: POOL_ABI, functionName: 'settle',
      args: [proof.publicValues, proof.proof, memos],
    });
    const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (rcpt.status !== 'success') throw new Error(`settle reverted ${txHash}`);
  } catch (e) {
    // A revert is typically a lost-ack re-serve of an already-applied op (nullifier spent).
    log(`job ${jobId} settle failed: ${e.message}`);
    await confidentialAck({ jobId, error: `settle reverted: ${e.message.slice(0, 200)}` });
    return true;
  }

  log(`settled: job=${jobId} tx=${txHash}`);
  await confidentialAck({ jobId, txHash });
  await heartbeat('settle', `settled ${jobId}`);
  return true;
}

async function main() {
  log(`starting — worker=${CFG.workerBase} pool=${POOL} poll=${CFG.settlePollSecs}s timeout=${CFG.settleJobTimeoutSecs}s`);
  if (CFG.sp1Prover === 'network' && !CFG.networkPrivateKey) {
    throw new Error('SP1_PROVER=network but NETWORK_PRIVATE_KEY unset — cannot prove');
  }
  // Cron mode: drain the settle queue (up to cronMaxCycles jobs / cronBudgetSecs) then exit.
  // A 1–2 min cron gives users near-instant settle without an always-on worker.
  if (CFG.runMode === 'cron') {
    const t0 = Date.now();
    for (let i = 0; i < CFG.cronMaxCycles; i++) {
      if ((Date.now() - t0) / 1000 > CFG.cronBudgetSecs) { log('cron budget reached — exiting'); break; }
      let worked;
      try { worked = await cycle(); }
      catch (e) { log('cycle error — exiting cron run:', e.message); await heartbeat('settle', `error ${e.message}`); break; }
      if (!worked) { log('queue drained — cron run done'); break; }
    }
    return;
  }
  for (;;) {
    try {
      const worked = await cycle();
      if (!worked) await sleep(CFG.settlePollSecs);
    } catch (e) {
      log('cycle error (continuing):', e.message);
      await heartbeat('settle', `error ${e.message}`);
      await sleep(CFG.settlePollSecs);
    }
  }
}

// Only run the loop when invoked directly (settle-relay is also imported for feeGate reuse).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('fatal', e); process.exit(1); });
}
