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
import { confidentialJob, confidentialBatch, confidentialAck, heartbeat } from './lib/worker-client.js';
import { proveSettle } from './lib/prover.js';
import { settleWallet, settleWallets, publicClient, ethUsdPrice, POOL, POOL_ABI } from './lib/chain.js';
import { quoteRelayFee, provePriceUsd } from './replenish.js';

const log = (...a) => console.log(`[settle ${new Date().toISOString()}]`, ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Reject a job whose proof-bound fee doesn't cover its all-in cost + margin.
// The fee is carved from the op input and enforced by the guest, so the worker
// already knows the USD value it will collect: the op carries feeUsd (preferred),
// or feeAsset/feeAmountUsd. If it's absent we can't price it — self-settle jobs
// (mode 'prove' or user-pays-gas) bypass the gate.
export async function feeGate(job, liveGasGwei, provePriceUsd, ethPriceUsd) {
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
    ethPriceUsd,
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

// Batch several queued transfers into one settle when they can share it. Gas is charged per settle, so the
// members split it; it also means a settle transaction stops mapping to a single user. Returns true when it
// handled work. Anything that isn't batchable falls through to the single-job path untouched.
// Build, price and submit a settle. Shared by the single and batched paths so both get identical fee
// pricing and the same endpoint fall-through. Returns the tx hash; throws if every endpoint refused.
async function submitSettle(proof, memos, label) {
  // Price + estimate on the PUBLIC client, never the private endpoint. Left to itself viem derives the fee
  // cap (and nonce/gas) through the settle transport, and a cap taken from a lagging view of the base fee
  // gets the tx rejected outright as unincludable. Base fee can also climb between pricing and inclusion, so
  // cap at 3x the current base fee (refunded — only base plus tip is actually paid).
  const [blk, nonce, gasEst] = await Promise.all([
    publicClient.getBlock({ blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: settleWallet.account.address, blockTag: 'pending' }),
    publicClient.estimateContractGas({
      address: POOL, abi: POOL_ABI, functionName: 'settle',
      args: [proof.publicValues, proof.proof, memos], account: settleWallet.account,
    }).catch(() => null),
  ]);
  const baseFee = blk.baseFeePerGas ?? 0n;
  // Tip proportional to the base fee: at sub-gwei base fees a flat tip was a large share of the effective
  // price for no inclusion benefit. Floored so it is never zero, capped so a spike can't run away.
  let maxPriorityFeePerGas = baseFee / 10n;
  if (maxPriorityFeePerGas < 10_000_000n) maxPriorityFeePerGas = 10_000_000n;
  if (maxPriorityFeePerGas > 2_000_000_000n) maxPriorityFeePerGas = 2_000_000_000n;
  const tx = {
    address: POOL, abi: POOL_ABI, functionName: 'settle',
    args: [proof.publicValues, proof.proof, memos],
    nonce, maxFeePerGas: baseFee * 3n + maxPriorityFeePerGas, maxPriorityFeePerGas,
    ...(gasEst ? { gas: (gasEst * 12n) / 10n } : {}),
  };
  // Try each private endpoint in turn: the proof is already paid for, so one endpoint refusing must not sink
  // the job. Identical tx and nonce — whichever lands first wins.
  const endpoints = settleWallets.length ? settleWallets : [{ url: 'default', wallet: settleWallet }];
  let lastErr, txHash;
  for (const { url, wallet } of endpoints) {
    try {
      txHash = await wallet.writeContract(tx);
      if (lastErr) log(`${label} submitted via ${url} after an earlier endpoint refused it`);
      if (/PUBLIC/.test(url)) log(`${label} WARNING: settled over the PUBLIC mempool — every private endpoint refused; the bound fee is exposed to a searcher`);
      break;
    } catch (e) {
      lastErr = e;
      log(`${label} submit via ${url} failed: ${String(e.message).slice(0, 160)}`);
    }
  }
  if (!txHash) throw lastErr || new Error('no settle endpoint accepted the transaction');
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (rcpt.status !== 'success') throw new Error(`settle reverted ${txHash}`);
  return txHash;
}

async function batchCycle() {
  if (CFG.settleBatchMax <= 1) return false;
  const jobs = await confidentialBatch(CFG.settleBatchMax);
  if (!jobs.length) return false;
  const ids = jobs.map((j) => j.jobId);
  // These jobs are already CLAIMED, so they must be carried to a terminal state here — releasing them by
  // acking an error would fail a user's op merely for arriving alone. A lone job is proved on the ordinary
  // single-op path, which keeps the common case off the batch binary entirely.
  if (jobs.length === 1) {
    const j = jobs[0];
    try {
      const proof = await proveSettle({ type: j.type, op: j.op, memos: j.memos || [], timeoutMs: CFG.settleJobTimeoutSecs * 1000 });
      const txHash = await submitSettle(proof, j.memos || [], `job ${j.jobId}`);
      await confidentialAck({ jobId: j.jobId, txHash });
      log(`settled: job=${j.jobId} tx=${txHash}`);
    } catch (e) {
      log(`job ${j.jobId} failed: ${e.message}`);
      await confidentialAck({ jobId: j.jobId, error: e.message.slice(0, 200) });
    }
    return true;
  }
  log(`batching ${jobs.length} transfers into one settle: ${ids.map((i) => i.slice(0, 10)).join(' ')}`);
  const op = {
    chainBinding: jobs[0].op.chainBinding,
    spendRoot: jobs[0].op.spendRoot,
    ops: jobs.map((j) => j.op),
  };
  const memos = jobs.flatMap((j) => (Array.isArray(j.memos) ? j.memos : []));
  let proof;
  try {
    proof = await proveSettle({ type: 'batchtransfer', op, memos, timeoutMs: CFG.settleJobTimeoutSecs * 1000 });
  } catch (e) {
    log(`batch prove failed: ${e.message}`);
    // Fail each member individually so the queue drains and one poison witness can't wedge the rest.
    for (const id of ids) await confidentialAck({ jobId: id, error: `batch prove failed: ${e.message.slice(0, 160)}` });
    return true;
  }
  try {
    const txHash = await submitSettle(proof, memos, `batch(${jobs.length})`);
    for (const id of ids) await confidentialAck({ jobId: id, txHash });
    log(`batch settled: n=${jobs.length} tx=${txHash}`);
  } catch (e) {
    log(`batch settle failed: ${e.message}`);
    for (const id of ids) await confidentialAck({ jobId: id, error: `batch settle: ${e.message.slice(0, 160)}` });
  }
  return true;
}

async function cycle() {
  if (await batchCycle()) return true;
  const job = await confidentialJob();
  const jobId = job?.jobId;
  if (!jobId) return false; // empty queue

  const type = job.type;
  const mode = job.mode || 'settle';
  const memos = Array.isArray(job.memos) ? job.memos : [];
  if (!OP_GAS[type] && type !== 'transfer') {
    // unknown-but-provable ops still allowed; gas defaults. Only truly-unknown type fails at prove.
  }

  const [gasGwei, ethPx] = await Promise.all([liveGasGwei(), ethUsdPrice()]);
  const provePx = await provePriceUsd(ethPx);
  const gate = await feeGate(job, gasGwei, provePx, ethPx);
  if (!gate.ok) {
    log(`job ${jobId} type=${type} rejected by feeGate: ${gate.reason}`);
    await confidentialAck({ jobId, error: `feeGate: ${gate.reason}` });
    return true;
  }

  log(`job ${jobId} type=${type} mode=${mode} — proving (network groth16). ${gate.reason} [gas ${gasGwei.toFixed(4)} gwei, ETH $${Number(ethPx).toFixed(2)}, PROVE $${Number(provePx).toFixed(4)}]`);
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
    txHash = await submitSettle(proof, memos, `job ${jobId}`);
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
