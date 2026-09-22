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
//   6. A relayed L2 exit that carried its recipe: activateExit(recipe) once the settle funded the escrow, when
//      the bound fee covers both transactions, then POST /confidential/ack {jobId, activateTx|activateError}.
//
// settle is permissionless: the contract independently verifies the proof against
// PROGRAM_VKEY. The relay never holds user funds or sees spending keys — only opening
// sigmas in the witness. It can only earn the bound fee.
// ─────────────────────────────────────────────────────────────────────────────

import { CFG, OP_GAS, DEFAULT_OP_GAS, OP_PROVE } from './lib/config.js';
import { confidentialJob, confidentialBatch, confidentialAck, confidentialActivateAck, heartbeat } from './lib/worker-client.js';
import { proveSettle } from './lib/prover.js';
import { assertMemosMatchProof } from './lib/memo-root.js';
import { settleWallet, settleWallets, publicClient, ethUsdPrice, POOL, POOL_ABI, ROUTER } from './lib/chain.js';
import { ROUTER_EXIT_ABI, recipeArgs, exitCheck, activationCover } from './lib/exit-activate.js';
import { quoteRelayFee, provePriceUsd, replenishOnce, drainToSink } from './replenish.js';

const log = (...a) => console.log(`[settle ${new Date().toISOString()}]`, ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Settle submission: a private endpoint accepting a transaction is not the same as a builder including it,
// and an un-included settle costs a proof that was already paid for. These bound how hard the relay tries
// before giving up, and how cheap a tip it is willing to start from.
const TIP_FLOOR_WEI = BigInt(process.env.SETTLE_TIP_FLOOR_WEI || '50000000'); // 0.05 gwei
const TIP_CAP_WEI = BigInt(process.env.SETTLE_TIP_CAP_WEI || '2000000000'); // 2 gwei
const SUBMIT_ROUNDS = Math.max(1, parseInt(process.env.SETTLE_SUBMIT_ROUNDS || '3', 10));
const RECEIPT_WAIT_MS = Math.max(30_000, parseInt(process.env.SETTLE_RECEIPT_WAIT_MS || '90000', 10));
const INCLUSION_POLL_MS = 4_000;
// A node's answer when this key's nonce is already used — by another sender on the key (the header relay can
// share it) or by an earlier broadcast of ours that landed. Clients word it differently.
export const NONCE_TAKEN = /nonce ?too ?low|lower than the current nonce|nonce has already been used|NONCE_EXPIRED/i;
const NONCE_REFRESHES = 3;

// Count of jobs relayed for free this process — surfaced in the log so an unpaid relay is observable
// rather than something you infer later from an empty wallet.
let unpricedJobs = 0;

// Reject a job whose proof-bound fee doesn't cover its all-in cost + margin.
// The fee is carved from the op input and enforced by the guest, so the worker
// already knows the USD value it will collect: the op carries feeUsd (preferred),
// or feeAsset/feeAmountUsd. If it's absent we can't price it — self-settle jobs
// (mode 'prove' or user-pays-gas) bypass the gate.
export async function feeGate(job, liveGasGwei, provePriceUsd, ethPriceUsd) {
  if (job.mode === 'prove') return { ok: true, reason: 'prove-only (no on-chain submit)' };
  // DERIVED value only. `job.feeUsd` is computed by the worker from the op's own fee legs (the same
  // witness fields the guest enforces); `job.op` is client JSON, so anything on it is attacker-controlled.
  // Reading `op.feeUsd` first — as this did — would have let a hostile integrator declare any fee it liked
  // the moment the producer was wired. The worker strips that field on submit; not reading it here is the
  // other half of the same fix.
  const feeUsd = Number(job.feeUsd ?? NaN);
  if (!Number.isFinite(feeUsd)) {
    // An op that carries no priced fee is unpaid work. Every relayed op has taken this path so far — the
    // producer never set `op.feeUsd` — which is why the relay's fee balances have been flat zero while it
    // paid for every settle out of its own gas. The flywheel downstream (sweep -> ETH/PROVE -> vApp) is
    // complete and correct; it has simply never had anything to sweep.
    //
    // Defaulting to closed here would stop production dead, since nothing populates the field yet, so the
    // default preserves today's behaviour and makes the subsidy VISIBLE instead of silent. Wire
    // `op.feeUsd` at the producer, then set RELAY_REQUIRE_PRICED_FEE=1 to actually collect.
    if (CFG.requirePricedFee) {
      return { ok: false, reason: 'op carries no priced fee and RELAY_REQUIRE_PRICED_FEE=1' };
    }
    unpricedJobs++;
    log(`UNPAID: job type=${job.type} carries no op.feeUsd — relaying at our own expense (${unpricedJobs} so far this process)`);
    return { ok: true, reason: 'fee not priced (accepted as subsidy — set RELAY_REQUIRE_PRICED_FEE=1 to refuse)' };
  }
  const q = quoteRelayFee({
    op: job.type,
    tradeSizeUsd: Number(job.op?.tradeSizeUsd ?? 0),
    liveGasGwei,
    provePriceUsd,
    ethPriceUsd,
  });
  // Hold the fee to the op's MARGINAL cost by default (see gateIncludesMaintenance in config): refusing an op
  // for failing to cover a share of fixed overhead rejected ordinary dapp fees whenever gas was above ~0.06 gwei.
  const need = CFG.gateIncludesMaintenance ? q.costUsd : q.marginalCostUsd;
  const label = CFG.gateIncludesMaintenance ? 'cost' : 'marginal cost';
  if (feeUsd + 1e-9 < need) {
    // `reason` is logged AND acked to the job, where the submitter can read it. It must not carry the dollar value
    // of their fee: for an asset priced from private config (cTAC) that value is units x the private reference
    // price, so echoing it back would let anyone read the price off a rejection. Our own cost is not sensitive.
    return { ok: false, reason: `bound fee $${feeUsd.toFixed(4)} < ${label} $${need.toFixed(4)}`, publicReason: `bound fee is below the ${label} of $${need.toFixed(4)} at current gas and PROVE prices` };
  }
  return { ok: true, reason: `fee $${feeUsd.toFixed(4)} ≥ ${label} $${need.toFixed(4)}`, quote: q };
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
  // The memos shipped with the settle must be the ones the proof commits to; the pool rejects any other set, so
  // a divergence is caught here before a settle is paid for.
  assertMemosMatchProof(proof.publicValues, memos);
  return submitCall({ address: POOL, abi: POOL_ABI, functionName: 'settle', args: [proof.publicValues, proof.proof, memos] }, label);
}

// Wait for a broadcast to land — or for it to become impossible to land.
//
// Waiting on a receipt alone cannot tell "slow" from "dead". A transaction is DEAD the moment another sender on
// this key mines a transaction with the same nonce: nothing we sent under that nonce can ever be included, yet a
// receipt wait sits out its full timeout, and every escalation round re-broadcasts at the SAME nonce and is dead
// too. Seen in production 2026-09-20: a relayed wrap was signed at nonce 2715, another sender's transaction took
// 2715 before it landed, and the relay spent two full 3-minute rounds on a transaction that could never be
// included before noticing on the third — 6.5 minutes for a settle that then landed in 13 seconds.
//
// So each poll checks both things: has any of OUR broadcasts landed, and has this nonce been consumed. The
// receipts are always checked first, and once more after a short pause before declaring the nonce taken — the
// block that consumed it may be ours, with its receipt not yet visible. Dependencies are injected so the
// timing and the chain can be faked in a test.
//   -> { state: 'landed' | 'reverted', hash } | { state: 'taken' } | { state: 'timeout' }
export async function awaitInclusion({
  hashes, nonce, waitMs, pollMs = INCLUSION_POLL_MS, getReceipt, getConfirmedNonce,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, recheckMs = 3_000,
}) {
  const verdict = async () => {
    for (const h of hashes) {
      const r = await getReceipt(h).catch(() => null);
      if (r) return { state: r.status === 'success' ? 'landed' : 'reverted', hash: h };
    }
    return null;
  };
  const deadline = now() + waitMs;
  for (;;) {
    const v = await verdict();
    if (v) return v;
    const confirmed = await getConfirmedNonce().catch(() => null);
    if (confirmed !== null && confirmed !== undefined && BigInt(confirmed) > BigInt(nonce)) {
      await sleep(recheckMs);
      return (await verdict()) || { state: 'taken' };
    }
    if (now() >= deadline) return { state: 'timeout' };
    await sleep(pollMs);
  }
}

// Submit one relay transaction — a settle (gas estimated here), or an exit activation whose `gasLimit` the caller
// already fixed and simulated at.
async function submitCall(base, label, gasLimit = null) {
  // Price + estimate on the PUBLIC client, never the private endpoint. Left to itself viem derives the fee
  // cap (and nonce/gas) through the settle transport, and a cap taken from a lagging view of the base fee
  // gets the tx rejected outright as unincludable. Base fee can also climb between pricing and inclusion, so
  // cap at 3x the current base fee (refunded — only base plus tip is actually paid).
  let [blk, nonce, gasEst] = await Promise.all([
    publicClient.getBlock({ blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: settleWallet.account.address, blockTag: 'pending' }),
    gasLimit ? null : publicClient.estimateContractGas({ ...base, account: settleWallet.account }).catch(() => null),
  ]);
  const baseFee = blk.baseFeePerGas ?? 0n;
  // Tip proportional to the base fee, floored so it is never dust and capped so a spike can't run away.
  // The floor matters more than it looks: at sub-gwei base fees the proportional term is worth a fraction of
  // a cent on a ~600k-gas settle, which a builder has no reason to include. A private endpoint ACCEPTS such a
  // transaction and simply never lands it.
  let tip = baseFee / 10n;
  if (tip < TIP_FLOOR_WEI) tip = TIP_FLOOR_WEI;
  if (tip > TIP_CAP_WEI) tip = TIP_CAP_WEI;

  const call = { ...base, ...(gasLimit ? { gas: gasLimit } : gasEst ? { gas: (gasEst * 12n) / 10n } : {}) };
  const endpoints = settleWallets.length ? settleWallets : [{ url: 'default', wallet: settleWallet }];
  // Every broadcast under this nonce. A later round REPLACES an earlier one, but the earlier hash can still
  // be the one that lands, so all of them are checked before the job is called failed.
  const seen = [];
  let lastErr;

  // Rounds escalate two things at once: the tip, and how far down the endpoint list we start — so a job that
  // private builders keep ignoring ends up on the public mempool rather than expiring. Submission acceptance
  // is NOT inclusion: without a bounded wait the job sits on viem's default timeout and then throws away a
  // proof the relay has already paid for. The proof stays in memory across rounds, so escalating is free;
  // re-proving is not.
  let refreshes = 0;
  for (let round = 0; round < SUBMIT_ROUNDS; round++) {
    const tx = { ...call, nonce, maxFeePerGas: baseFee * 3n + tip, maxPriorityFeePerGas: tip };
    let txHash, taken = false;
    for (let i = 0; i < endpoints.length; i++) {
      const { url, wallet } = endpoints[(i + round) % endpoints.length];
      try {
        txHash = await wallet.writeContract(tx);
        seen.push(txHash);
        log(`${label} submitted via ${url} (round ${round + 1}, tip ${tip} wei) ${txHash}`);
        if (/PUBLIC/.test(url)) log(`${label} WARNING: settling over the PUBLIC mempool — the bound fee is exposed to a searcher`);
        break;
      } catch (e) {
        lastErr = e;
        log(`${label} submit via ${url} failed: ${String(e.message).slice(0, 160)}`);
        if (NONCE_TAKEN.test(String(e && e.message))) { taken = true; break; } // every endpoint would say the same
      }
    }

    // Wait for inclusion — but stop early if this nonce is consumed by someone else, since nothing broadcast under
    // it can land any more (see awaitInclusion). A submit error that already said "nonce taken" skips the wait.
    if (txHash && !taken) {
      const res = await awaitInclusion({
        hashes: seen, nonce, waitMs: RECEIPT_WAIT_MS,
        getReceipt: (h) => publicClient.getTransactionReceipt({ hash: h }),
        getConfirmedNonce: () => publicClient.getTransactionCount({ address: settleWallet.account.address, blockTag: 'latest' }),
      });
      if (res.state === 'landed') return res.hash;
      // A revert is the chain's verdict and is terminal.
      if (res.state === 'reverted') throw new Error(`${base.functionName} reverted ${res.hash}`);
      if (res.state === 'taken') { log(`${label} nonce ${nonce} was consumed by another sender before ours landed`); taken = true; }
      else log(`${label} not included within ${RECEIPT_WAIT_MS}ms at tip ${tip} wei — escalating`);
    }

    // The nonce is spent. If one of our own broadcasts spent it, that transaction is the answer; otherwise another
    // sender took it, none of ours can land any more, and the proof is still good — send again at a fresh nonce.
    if (taken) {
      for (const h of seen) {
        const r = await publicClient.getTransactionReceipt({ hash: h }).catch(() => null);
        if (!r) continue;
        if (r.status !== 'success') throw new Error(`${base.functionName} reverted ${h}`);
        log(`${label} landed as an earlier broadcast ${h}`);
        return h;
      }
      if (refreshes < NONCE_REFRESHES) {
        refreshes += 1;
        nonce = await publicClient.getTransactionCount({ address: settleWallet.account.address, blockTag: 'pending' });
        log(`${label} nonce taken by another sender — sending again at nonce ${nonce}`);
        round -= 1; // a fresh nonce is not an escalation
        continue;
      }
      break;
    }

    // A replaced transaction can still be the included one; check before spending another round.
    for (const h of seen) {
      const r = await publicClient.getTransactionReceipt({ hash: h }).catch(() => null);
      if (!r) continue;
      if (r.status !== 'success') throw new Error(`${base.functionName} reverted ${h}`);
      log(`${label} landed as an earlier broadcast ${h}`);
      return h;
    }

    if (tip >= TIP_CAP_WEI) break; // nothing left to escalate; further rounds would be identical
    tip = tip * 3n > TIP_CAP_WEI ? TIP_CAP_WEI : tip * 3n; // a replacement must clear the node's bump rule
  }

  throw lastErr || new Error(`${base.functionName} accepted but never included after ${SUBMIT_ROUNDS} rounds (last tip ${tip} wei)`);
}

// A relayed exit that carried its recipe: activate it now that the settle has funded the escrow, so the bridge
// call runs without the user sending anything from a wallet that would link to the exit. Every refusal is
// reported, and the user's own activate path (activateExit is permissionless) still works until the deadline.
async function activateRelayedExit(job, settleTx) {
  if (!job.exit || !CFG.activateExits) return;
  const label = `job ${job.jobId} activate`;
  const refuse = async (reason) => {
    log(`${label} not sent: ${reason}`);
    await confidentialActivateAck({ jobId: job.jobId, error: reason });
  };
  try {
    const recipe = recipeArgs(job.exit);
    const escrow = await publicClient.readContract({ address: ROUTER, abi: ROUTER_EXIT_ABI, functionName: 'escrowAddressFor', args: [recipe] });
    const check = exitCheck({ job, escrow, nowSecs: Math.floor(Date.now() / 1000), ethAssetId: CFG.ethAssetId });
    if (!check.ok) return refuse(check.reason);
    const call = { address: ROUTER, abi: ROUTER_EXIT_ABI, functionName: 'activateExit', args: [recipe] };
    // The settle receipt came from one endpoint; another may not have the funded escrow yet (EscrowEmpty).
    const estimate = async () => {
      for (let i = 0; ; i++) {
        try { return await publicClient.estimateContractGas({ ...call, account: settleWallet.account }); }
        catch (e) { if (i >= 2) throw e; await sleep(6); }
      }
    };
    const [rcpt, gasPriceWei, gasEstimate] = await Promise.all([
      publicClient.getTransactionReceipt({ hash: settleTx }),
      publicClient.getGasPrice(),
      estimate(),
    ]);
    const cover = activationCover({
      job, settleCostWei: rcpt.gasUsed * rcpt.effectiveGasPrice, gasEstimate, gasPriceWei,
      weiPerUnit: CFG.ethUnitScale, gasCap: CFG.activateGasCap, marginBps: CFG.activateMarginBps,
    });
    if (!cover.ok) return refuse(cover.reason);
    // Dry-run at the exact gas limit the transaction carries: an uncapped call succeeds where the capped one
    // runs out of gas inside the bridge call.
    await publicClient.simulateContract({ ...call, account: settleWallet.account, gas: cover.gas });
    const txHash = await submitCall(call, label, cover.gas);
    log(`${label}: ${txHash} (fee ${cover.feeWei} wei covers ${cover.cost} wei)`);
    await confidentialActivateAck({ jobId: job.jobId, txHash });
  } catch (e) {
    await refuse(`activation failed: ${String(e.shortMessage || e.message).slice(0, 180)}`);
  }
}

// Split claimed jobs into those the fee gate admits and those it refuses. Exported so the split can be tested
// without a chain; the gate itself is injected.
export async function admitJobs(jobs, gate) {
  const admitted = [], refused = [];
  for (const job of jobs) {
    const verdict = await gate(job);
    (verdict.ok ? admitted : refused).push({ job, verdict });
  }
  return { admitted: admitted.map((a) => a.job), refused };
}

// Prove and settle one claimed job on the ordinary single-op path, carrying it to a terminal ack either way.
async function settleOne(j) {
  try {
    const proof = await proveSettle({ type: j.type, op: j.op, memos: j.memos || [], timeoutMs: CFG.settleJobTimeoutSecs * 1000 });
    const txHash = await submitSettle(proof, j.memos || [], `job ${j.jobId}`);
    await confidentialAck({ jobId: j.jobId, txHash });
    log(`settled: job=${j.jobId} tx=${txHash}`);
    await activateRelayedExit(j, txHash);
  } catch (e) {
    log(`job ${j.jobId} failed: ${e.message}`);
    await confidentialAck({ jobId: j.jobId, error: e.message.slice(0, 200) });
  }
}

async function batchCycle() {
  if (CFG.settleBatchMax <= 1) return false;
  let jobs = await confidentialBatch(CFG.settleBatchMax);
  if (!jobs.length) return false;

  // Gate every member exactly as the single-job path does. Batched transfers used to be claimed and proved without
  // ever passing through feeGate, so a batch could relay a job the single path would have refused. Refused members
  // are acked individually — one underpaying member must not sink the others — and the rest carry on. The gate
  // holds each to its own marginal cost; a batch splits the gas, so this is conservative, never permissive.
  const [gasGwei, ethPx] = await Promise.all([liveGasGwei(), ethUsdPrice()]);
  const provePx = await provePriceUsd(ethPx);
  const { admitted, refused } = await admitJobs(jobs, (j) => feeGate(j, gasGwei, provePx, ethPx));
  for (const { job, verdict } of refused) {
    log(`job ${job.jobId} type=${job.type} rejected by feeGate (batch): ${verdict.reason}`);
    await confidentialAck({ jobId: job.jobId, error: `feeGate: ${verdict.publicReason || verdict.reason}` });
  }
  if (!admitted.length) return true; // we did work (refusing), so the loop should poll again immediately
  jobs = admitted;
  const ids = jobs.map((j) => j.jobId);
  // These jobs are already CLAIMED, so they must be carried to a terminal state here — releasing them by
  // acking an error would fail a user's op merely for arriving alone. A lone job is proved on the ordinary
  // single-op path, which keeps the common case off the batch binary entirely.
  if (jobs.length === 1) {
    await settleOne(jobs[0]);
    return true;
  }
  // The batch is proved as `batchtransfer`, which is a TRANSFER-specific guest op — it folds transfer
  // witnesses and nothing else. `nextBatch` defaults to types:['transfer'], so today the two agree, but
  // the agreement is implicit: it lives in a default argument on one side of an HTTP boundary and a
  // hardcoded string on the other. Widening the claim types without a heterogeneous guest batch type
  // would quietly feed non-transfers into batchtransfer.
  //
  // So check it here, where the op is actually built. These jobs are already claimed, so a mismatch is
  // released back rather than failed — the ordinary single-op path settles them correctly.
  const wrongType = jobs.filter((j) => j.type !== 'transfer');
  if (wrongType.length) {
    log(`REFUSING to batch: ${wrongType.length} non-transfer job(s) claimed (${[...new Set(wrongType.map((j) => j.type))].join(', ')}) — batchtransfer folds transfers only`);
    for (const id of ids) await confidentialAck({ jobId: id, error: 'released: non-transfer job claimed into a transfer batch' });
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
    // A batch proof covers every member, so one member that cannot prove fails it; settle each member alone
    // instead, so only that member fails.
    log(`batch prove failed, settling members one by one: ${e.message}`);
    for (const j of jobs) await settleOne(j);
    return true;
  }
  try {
    const txHash = await submitSettle(proof, memos, `batch(${jobs.length})`);
    for (const id of ids) await confidentialAck({ jobId: id, txHash });
    log(`batch settled: n=${jobs.length} tx=${txHash}`);
  } catch (e) {
    log(`batch settle failed, settling members one by one: ${e.message}`);
    for (const j of jobs) await settleOne(j);
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
    await confidentialAck({ jobId, error: `feeGate: ${gate.publicReason || gate.reason}` });
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
  await activateRelayedExit(job, txHash);
  await heartbeat('settle', `settled ${jobId}`);
  return true;
}

// Fee income -> gas, run from the settle loop's idle time. Serialised with settles (same wallet, same
// nonce) by construction: it is only ever awaited where the loop would otherwise sleep. Off unless
// REPLENISH_IN_SETTLE=1, and it can never take the loop down — a failure is logged and retried next interval.
let lastReplenishAt = 0;
let drained = false;
async function maybeReplenish() {
  // Key consolidation runs once, ahead of everything else, and only where asked. It is idle-time work like the
  // rest, so it can never race a settle on the same nonce.
  if (CFG.replenishDrainToSink && !drained) {
    drained = true;
    try { await drainToSink({ roles: ['settle'] }); }
    catch (e) { log(`drain failed (settling continues): ${e?.message || e}`); }
  }
  if (!CFG.replenishInSettle) return;
  if (Date.now() - lastReplenishAt < CFG.replenishIntervalMin * 60_000) return;
  lastReplenishAt = Date.now();
  try { await replenishOnce({ roles: ['settle'], convertToProve: CFG.replenishDepositProve }); }
  catch (e) { log(`replenish failed (settling continues): ${e?.message || e}`); }
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
      if (!worked) { await maybeReplenish(); await sleep(CFG.settlePollSecs); }
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
