// ─────────────────────────────────────────────────────────────────────────────
// Settle relay — the confidential-op settle loop (network prove edition).
//
// Render service type: Background Worker (long-running). Proves on the Succinct network prover.
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

import { CFG, ADDR, OP_GAS, DEFAULT_OP_GAS, OP_PROVE } from './lib/config.js';
import { confidentialJob, confidentialWake, confidentialBatch, confidentialAck, confidentialRefresh, confidentialActivateAck, confidentialOpenList, confidentialOpenJob, marketOrders, marketClear, marketProofPost, gasOrders, gasClear, confidentialQueue, heartbeat, heartbeatIdle, setHeartbeatLedger, relayBooks, quoteAsset } from './lib/worker-client.js';
import { makeBatchWindow } from './lib/batch-window.js';
import { proveSettle, proveMixed, proveSealed, proveStdin, boardAlive } from './lib/prover.js';
import { makeMarketSolver, marketHasRoom } from './lib/market-solver.js';
import { quoteTacForEth, deepest } from './lib/tac-quote.js';
import { abi as MARKET_ABI, claimCall, fulfillCall } from './lib/market-calls.js';
import { makeGasSolver } from './lib/gas-solver.js';
import { abi as GAS_ABI, executeCall } from './lib/gas-calls.js';
import { notExecuted } from './lib/stdin-prover.js';
import { assertMemosMatchProof } from './lib/memo-root.js';
import { consumedInput, consumedAck, unlandedDeposits, spentInputsOf, noteNullifier } from './lib/spent-precheck.js';
import { findCarrier, isRevert } from './lib/landed-elsewhere.js';
import { cbtcMintBlocker } from './lib/cbtc-mint-precheck.js';
import { cdpBlocker } from './lib/cdp-precheck.js';
import { bridgeMintBlocker } from './lib/bridge-mint-precheck.js';
import { renewStaleMint } from './lib/bridge-mint-renew.js';
import { settleWallet, settleWallets, relayWallet, publicClient, ethUsdPrice, POOL, POOL_ABI, ROUTER } from './lib/chain.js';
import { ledger } from './lib/income-ledger.js';
import { makeBooksRestorer } from './lib/ledger-restore.js';
import { ROUTER_EXIT_ABI, recipeArgs, exitCheck, activationCover } from './lib/exit-activate.js';
import { makeAbandonedSettles } from './lib/abandoned-settles.js';
import { quoteRelayFee, provePriceUsd, replenishOnce, drainToSink, feeAssets, depositArrivedProve, lastProverCredit, readProverCredit, creditForEager } from './replenish.js';
import { proveFloorWei } from './lib/prove-floor.js';
import { openable, pickOpen, ethFeeWei, STALE_PROOF_SELECTORS, pvFees } from './lib/open-board.js';
import { boardProving, standingNote, creditShort, makeProvePause } from './lib/prove-pause.js';
import { replenishDue } from './lib/replenish-schedule.js';
import { tipFor, makeTipFloor, TIP_HISTORY_BLOCKS, TIP_PERCENTILE } from './lib/gas-tip.js';
import { feeCapFor } from './lib/fee-cap.js';
import { SETTLE_TIP_MIN_TOTAL_WEI, SETTLE_TIP_CAP_WEI, CAP_MULT_MAX, CAP_MULT_MIN, settleFundsNeed } from './lib/settle-fees.js';
import { safeErr } from './lib/safe-err.js';
import { revertSelector, opExpiry } from './lib/revert-data.js';
import { encodeFunctionData } from 'viem';

const log = (...a) => console.log(`[settle ${new Date().toISOString()}]`, ...a);

// The books (lib/income-ledger.js): a settled job's fee and its share of the settle's gas, read from the receipt. Run after the ack, never
// awaited by the loop, and it cannot throw into it: a settle is never held up for its own bookkeeping.
function bookSettled(jobs, txHash) {
  publicClient.getTransactionReceipt({ hash: txHash })
    .then((r) => BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice))
    .catch(() => 0n)
    .then((cost) => { const each = cost / BigInt(Math.max(1, jobs.length)); for (const j of jobs) ledger.settled(j, { txCostWei: each }); })
    .catch(() => {});
}
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
// Idle, the relay waits on the API's wake (a job accepted wakes it at once) rather than a fixed pause, for up to SETTLE_WAKE_SECS; an API
// without the route, or a call that fails, falls back to the SETTLE_POLL_SECS pause.
async function idleWait() {
  const t0 = Date.now();
  if (CFG.settleWakeSecs > 0) {
    const r = await confidentialWake(Math.max(CFG.settleWakeSecs, CFG.settlePollSecs)).catch(() => null);
    if (typeof r?.woke === 'boolean') return;
  }
  const left = CFG.settlePollSecs - (Date.now() - t0) / 1000;
  if (left > 0) await sleep(left);
}

// Settle submission: a private endpoint accepting a transaction is not the same as a builder including it,
// and an un-included settle costs a proof that was already paid for. These bound how hard the relay tries
// before giving up, and how cheap a tip it is willing to start from.
const TIP_FLOOR_WEI = CFG.settleTipFloorWei;   // only a fallback now: the rate used when the fee history cannot be read
// The smallest total priority payment worth a builder's attention. A floor on the total rather than on the rate, so a
// 350k-gas settle stays worth including without a 3.5M-gas batch paying the same rate for it.
const TIP_MIN_TOTAL_WEI = SETTLE_TIP_MIN_TOTAL_WEI;   // 0.00002 ETH, lib/settle-fees.js (the monitor prices a settle with the same figures)
// The floor a settle actually offers starts at that figure and tunes itself between it and SETTLE_TIP_MIN_TOTAL_LOW_WEI (0.000004 ETH):
// it falls 3% for each settle that lands in its first round and doubles for each that does not (lib/gas-tip.js makeTipFloor). With a
// settle sent to every private endpoint at once, 25 of 26 land in the first round at the full floor (2026-10-17), so most of the floor
// is paid for nothing; the funds the wallet must hold are still reckoned at the full figure.
const tipFloor = makeTipFloor({ startWei: TIP_MIN_TOTAL_WEI, minWei: BigInt(process.env.SETTLE_TIP_MIN_TOTAL_LOW_WEI || '4000000000000'), maxWei: TIP_MIN_TOTAL_WEI });
const TIP_CAP_WEI = SETTLE_TIP_CAP_WEI;               // 2 gwei
const SUBMIT_ROUNDS = Math.max(1, parseInt(process.env.SETTLE_SUBMIT_ROUNDS || '3', 10));
const RECEIPT_WAIT_MS = Math.max(30_000, parseInt(process.env.SETTLE_RECEIPT_WAIT_MS || '90000', 10));
const INCLUSION_POLL_MS = 4_000;
// How far before a settle's first broadcast to look for another landing of the same proof: covers a second relay
// that claimed the same job and proved it in parallel.
const LANDED_MARGIN_BLOCKS = 32n;
// How far back a job whose inputs are already gone looks for the settle that consumed them (about a day).
const CONSUMED_LOOKBACK_BLOCKS = BigInt(process.env.SETTLE_CONSUMED_LOOKBACK_BLOCKS || '7200');
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
  // witness fields the guest enforces); `job.op` is client JSON and is never trusted for the fee. The worker
  // strips `op.feeUsd` on submit, and this gate never reads it.
  const feeUsd = Number(job.feeUsd ?? NaN);
  if (!Number.isFinite(feeUsd)) {
    // An op that carries no priced fee is unpaid work. By default it is relayed as a logged subsidy;
    // RELAY_REQUIRE_PRICED_FEE=1 refuses it.
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
  // Hold the fee to the op's MARGINAL cost by default (see gateIncludesMaintenance in config): fixed overhead is
  // carried by the margin, not charged to each op.
  const need = CFG.gateIncludesMaintenance ? q.costUsd : q.marginalCostUsd;
  const label = CFG.gateIncludesMaintenance ? 'cost' : 'marginal cost';
  if (feeUsd + 1e-9 < need) {
    // `reason` is logged AND acked to the job, where the submitter can read it. It must not carry the dollar value
    // of their fee: for an asset priced from private config (cTAC) that value is units x the private reference
    // price, which stays private. Our own cost is not sensitive.
    return { ok: false, reason: `bound fee $${feeUsd.toFixed(4)} < ${label} $${need.toFixed(4)}`, publicReason: `bound fee is below the ${label} of $${need.toFixed(4)} at current gas and PROVE prices` };
  }
  return { ok: true, reason: `fee $${feeUsd.toFixed(4)} ≥ ${label} $${need.toFixed(4)}`, quote: q };
}

async function liveGasGwei() {
  try {
    const gp = await publicClient.getGasPrice();
    return Number(gp) / 1e9;
  } catch { return 1; } // fall back to ~1 gwei
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
  // Whoever lands this proof settles the op (see lib/landed-elsewhere.js), so a transaction carrying these public
  // values is this job's result even when another sender landed it first.
  const fromBlock = (await publicClient.getBlockNumber()) - LANDED_MARGIN_BLOCKS;
  const landed = () => findCarrier({ client: publicClient, pool: POOL, needles: [proof.publicValues], fromBlock });
  return submitCall({ address: POOL, abi: POOL_ABI, functionName: 'settle', args: [proof.publicValues, proof.proof, memos] }, label, { landed });
}

// Wait for a broadcast to land — or for it to become impossible to land.
//
// Waiting on a receipt alone cannot tell "slow" from "dead". A transaction is DEAD the moment another sender on
// this key mines a transaction with the same nonce: nothing we sent under that nonce can ever be included, yet a
// receipt wait sits out its full timeout, and every escalation round re-broadcasts at the SAME nonce and is dead
// too.
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
// already fixed and simulated at. `landed` (optional) names a transaction by another sender that already did this
// call's work; it is asked whenever the call turns out to have nothing left to do, and its answer is returned as
// the result.
async function submitCall(base, label, { gasLimit = null, landed = null } = {}) {
  // Price + estimate on the PUBLIC client, never the private endpoint. Left to itself viem derives the fee
  // cap (and nonce/gas) through the settle transport, and a cap taken from a lagging view of the base fee
  // gets the tx rejected outright as unincludable. Base fee can also climb between pricing and inclusion, so
  // cap at 3x the current base fee (refunded — only base plus tip is actually paid).
  let [blk, nonce, gasEst, feeHist, balance] = await Promise.all([
    publicClient.getBlock({ blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: settleWallet.account.address, blockTag: 'pending' }),
    gasLimit ? null : publicClient.estimateContractGas({ ...base, account: settleWallet.account }).catch(() => null),
    publicClient.getFeeHistory({ blockCount: TIP_HISTORY_BLOCKS, rewardPercentiles: [TIP_PERCENTILE] }).catch(() => null),
    publicClient.getBalance({ address: settleWallet.account.address }).catch(() => null),
  ]);
  const data = encodeFunctionData({ abi: base.abi, functionName: base.functionName, args: base.args });
  let baseFee = blk.baseFeePerGas ?? 0n;
  // What recent blocks actually paid, floored on what this settle offers in TOTAL rather than per gas (lib/gas-tip.js).
  // The total is what matters: the proportional term alone is worth a fraction of a cent on a ~600k-gas settle, which a
  // private endpoint accepts and then never lands, while a rate fixed high enough to fix that overpays by multiples
  // once gas is cheap. A history we cannot read falls back to that fixed rate.
  const gasForTip = gasLimit || (gasEst ? (gasEst * 12n) / 10n : 0n);
  let tip = tipFor({ rewards: feeHist && feeHist.reward, gas: gasForTip, minTotalWei: tipFloor.value(), capWei: TIP_CAP_WEI, fallbackWei: TIP_FLOOR_WEI });

  const call = { ...base, ...(gasLimit ? { gas: gasLimit } : gasEst ? { gas: (gasEst * 12n) / 10n } : {}) };
  // The fee cap each round sends with: the full multiple of the base fee when the wallet covers it, a lower one when it does
  // not (lib/fee-cap.js). A node refuses a send whose gas limit times cap the wallet cannot cover, and only base plus tip is
  // paid, so a wallet short of the full cap settles at the cap it can stand behind instead of holding the queue.
  let capNoted = false;
  const capNow = () => {
    if (balance == null) return baseFee * 3n + tip;          // the balance could not be read: the full cap, as before
    const c = feeCapFor({ balance, gas: call.gas ?? SETTLE_FUNDS_GAS, base: baseFee, tip, maxMult: CAP_MULT_MAX, minMult: CAP_MULT_MIN });
    if (c.mult < Number(CAP_MULT_MAX) / 1000 && !capNoted) { capNoted = true; log(`${label} wallet holds ${(Number(balance) / 1e18).toFixed(4)} ETH: fee cap ${c.mult} base fees instead of ${Number(CAP_MULT_MAX) / 1000}`); }
    return c.maxFee;
  };
  const endpoints = settleWallets.length ? settleWallets : [{ url: 'default', wallet: settleWallet }];
  // Rotation covers the PRIVATE endpoints only; a public one is appended after them on every round. Rounds
  // advance on non-inclusion, not on refusal, so rotating a public endpoint into the lead would put a
  // healthy-but-slow settle into the open mempool — where the bound fee is copied and ours lands as a
  // revert. Public stays what its comment claims: reached only once every private endpoint has been tried.
  const isPublicUrl = (u) => /PUBLIC/.test(u);
  const privateEps = endpoints.filter((e) => !isPublicUrl(e.url));
  const publicEps = endpoints.filter((e) => isPublicUrl(e.url));
  const endpointsFor = (r) => (privateEps.length
    ? [...privateEps.map((_, i) => privateEps[(i + r) % privateEps.length]), ...publicEps]
    : publicEps);
  // Every private endpoint gets the round's transaction at once (the same nonce, fee and bytes, so the same transaction offered to more
  // builders): a settle is no longer left a whole receipt wait on one endpoint whose builders did not win the next blocks. The price
  // rises every round.
  const epsPerTip = 1;
  // Every broadcast under this nonce. A later round REPLACES an earlier one, but the earlier hash can still
  // be the one that lands, so all of them are checked before the job is called failed.
  const seen = [];
  let lastErr;

  // A call that would revert now is never broadcast. The public node is asked, not a private endpoint, and an
  // unreachable node is not a verdict. Returns the revert, or null.
  // The revert carries its selector when any node will name it (lib/revert-data.js), for the ack's words.
  const wouldRevert = async () => {
    try { await publicClient.call({ account: settleWallet.account, to: base.address, data, ...(base.value ? { value: base.value } : {}) }); return null; }
    catch (e) {
      if (!isRevert(e)) return null;
      e.revertSelector = await revertSelector(e, { from: settleWallet.account.address, to: base.address, data }, { chainId: CFG.chainId }).catch(() => null);
      return e;
    }
  };
  // One of our own broadcasts that landed: its hash, or a thrown revert. Null while none has a receipt.
  const ownReceipt = async () => {
    for (const h of seen) {
      const r = await publicClient.getTransactionReceipt({ hash: h }).catch(() => null);
      if (!r) continue;
      if (r.status !== 'success') return finishReverted(h);
      return h;
    }
    return null;
  };
  const elsewhere = async () => {
    if (!landed) return null;
    const h = await landed().catch((e) => { log(`${label} could not look for another landing: ${String(e && e.message).slice(0, 120)}`); return null; });
    if (h) log(`${label} landed by another sender as ${h}: the op is done, and the bound fee went to that sender`);
    return h;
  };
  // Our transaction reverted: the op is done if another landing of it explains the revert.
  const finishReverted = async (h) => {
    const other = await elsewhere();
    if (other) return other;
    throw new Error(`${base.functionName} reverted ${h}`);
  };
  // Nothing we could send would succeed any more: our own landing, another sender's, or the revert itself.
  const settledOrDead = async (revert) => {
    const mine = await ownReceipt();
    if (mine) return mine;
    const other = await elsewhere();
    if (other) return other;
    throw revert;
  };

  // Rounds escalate two things at once: the tip, and which private endpoint goes first. Submission acceptance
  // is NOT inclusion: without a bounded wait the job sits on viem's default timeout and then throws away a
  // proof the relay has already paid for. The proof stays in memory across rounds, so escalating is free;
  // re-proving is not. Every round starts with a simulation, so a settle whose inputs went (to our own earlier
  // broadcast, or to a copy) is resolved instead of sent again.
  let refreshes = 0;
  for (let round = 0; round < SUBMIT_ROUNDS; round++) {
    // Reprice against the LIVE base fee each round, not the snapshot taken before the first submit. The 3x
    // multiplier is what absorbs a climb between pricing and inclusion, but applied to a stale snapshot it
    // absorbs nothing: if base fee more than triples across the ~4.5 minutes these rounds span, all three
    // carry the same unincludable cap, escalating the tip changes nothing, and an already-paid Groth16 proof
    // is discarded. A gas spike is exactly when a settle is slow enough to reach a later round, so the stale
    // case and the case the multiplier exists for are the same case.
    if (round > 0) {
      const fresh = await publicClient.getBlock({ blockTag: 'latest' }).catch(() => null);
      if (fresh && (fresh.baseFeePerGas ?? 0n) > baseFee) {
        baseFee = fresh.baseFeePerGas;
        log(`${label} base fee moved to ${baseFee} wei — repricing this round's cap against it`);
      }
    }
    const dead = await wouldRevert();
    if (dead) return settledOrDead(dead);
    const tx = { ...call, nonce, maxFeePerGas: capNow(), maxPriorityFeePerGas: tip };
    // Marked only now: a call refused by the simulation above was never put on the wire, so it must not hold the
    // prover top-up behind a nonce that nothing will ever consume.
    lastBroadcastNonce = Math.max(lastBroadcastNonce, nonce);
    let txHash, taken = false;
    // The private endpoints all at once; the public one only when none of them took it.
    const sendVia = async ({ url, wallet }) => {
      try {
        const h = await wallet.writeContract(tx);
        if (!seen.includes(h)) seen.push(h);
        txHash ||= h;
        log(`${label} submitted via ${url} (round ${round + 1}, tip ${tip} wei) ${h}`);
        if (/PUBLIC/.test(url)) log(`${label} WARNING: settling over the PUBLIC mempool — the bound fee is exposed to a searcher`);
        return 'ok';
      } catch (e) {
        if (/already known|known transaction|already imported/i.test(String(e && e.message))) return 'ok';   // the same transaction, already there
        lastErr = e;
        log(`${label} submit via ${url} failed: ${String(e.message).slice(0, 160)}`);
        if (NONCE_TAKEN.test(String(e && e.message))) return 'taken';
        if (isRevert(e)) return 'revert';
        return 'err';
      }
    };
    const order = endpointsFor(round);
    const priv = order.filter((x) => !/PUBLIC/.test(x.url)), pub = order.filter((x) => /PUBLIC/.test(x.url));
    const outs = await Promise.all(priv.map(sendVia));
    if (outs.includes('taken')) taken = true;
    // An endpoint's revert is only a verdict once the public node agrees; one lagging a block says nothing.
    if (!txHash && outs.includes('revert')) { const dead = await wouldRevert(); if (dead) return settledOrDead(dead); }
    if (!txHash && !taken) {
      for (const ep of pub) {
        const o = await sendVia(ep);
        if (o === 'ok') break;
        if (o === 'taken') { taken = true; break; }
        if (o === 'revert') { const dead = await wouldRevert(); if (dead) return settledOrDead(dead); }
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
      if (res.state === 'landed') { const f = tipFloor.record(round === 0); log(`${label} landed in round ${round + 1}; the tip floor is now ${f} wei in total`); return res.hash; }
      // A revert is the chain's verdict and is terminal — unless another landing of the same work caused it.
      if (res.state === 'reverted') return finishReverted(res.hash);
      if (res.state === 'taken') { log(`${label} nonce ${nonce} was consumed by another sender before ours landed`); taken = true; }
      else log(`${label} not included within ${RECEIPT_WAIT_MS}ms at tip ${tip} wei — escalating`);
    }

    // The nonce is spent. If one of our own broadcasts spent it, that transaction is the answer; otherwise another
    // sender took it, none of ours can land any more, and the proof is still good — send again at a fresh nonce.
    if (taken) {
      const mine = await ownReceipt();
      if (mine) { log(`${label} landed as ${mine}`); return mine; }
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
    const mine = await ownReceipt();
    if (mine) { log(`${label} landed as ${mine}`); return mine; }

    // An endpoint not yet tried at this price goes first, before the price rises. Non-inclusion says nothing about
    // which of the two it was: a private endpoint reaches only the builders it has, and one that builds few blocks
    // leaves a perfectly well-priced settle sitting. Re-broadcasting the identical transaction costs nothing (same
    // nonce, same fee, same bytes — the same transaction, just offered more widely), while raising the tip for it
    // pays a premium for a problem the tip never had.
    if ((round + 1) % epsPerTip) continue;
    if (tip >= TIP_CAP_WEI) break; // nothing left to escalate; further rounds would be identical
    tip = tip * 3n > TIP_CAP_WEI ? TIP_CAP_WEI : tip * 3n; // a replacement must clear the node's bump rule
  }

  // Last look before giving up. A private endpoint keeps re-submitting an accepted bundle for far longer
  // than the rounds above wait, so "we stopped waiting" and "it did not land" are different facts — and the
  // job is about to be acked FAILED, which is terminal and never retried. Getting this wrong tells a user
  // their op failed while it is settling, with no way to reach the tx hash.
  const late = await ownReceipt();
  if (late) { log(`${label} landed as ${late} after the wait window closed`); return late; }
  const other = await elsewhere();
  if (other) return other;
  const e = lastErr || new Error(`${base.functionName} accepted but never included after ${SUBMIT_ROUNDS} rounds (last tip ${tip} wei)`);
  // Carry the broadcast hashes so the caller can name them rather than reporting a bare failure: a
  // still-pending bundle may yet land, and these are the only handles on it.
  e.broadcastHashes = seen.slice();
  throw e;
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
    const txHash = await submitCall(call, label, { gasLimit: cover.gas });
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

// A job whose inputs are already consumed on chain can only revert, so it is never proved. A relayed job served
// again after its settle landed (an ack lost on the way back) is reported settled with that settle, found by the
// memos this job sealed, which ride in its calldata. Anything else is failed, naming the transaction that spent
// the input: a rebuilt request seals fresh memos, so it is never mistaken for the one that landed.
// A job whose own deadline has passed, or passes before a proof and its settle could land, can only revert with the
// pool's Expired(): it waited in the queue too long (a settle wallet short of gas holds jobs back). Failed without
// proving, so no PROVE is spent on it, in words the pages show as they are. Nothing of the holder's was touched, and
// sending it again builds a fresh deadline.
const EXPIRY_MARGIN_SECS = 180;
async function skipExpired(job) {
  const exp = opExpiry(job);
  if (!exp || exp > Math.floor(Date.now() / 1000) + EXPIRY_MARGIN_SECS) return false;
  log(`job ${job.jobId} type=${job.type} not proved: its deadline ${new Date(exp * 1000).toISOString()} has passed or is too close`);
  await confidentialAck({ jobId: job.jobId, error: 'expired: it waited in the queue past its deadline, so it was not sent and nothing was spent; send it again' });
  return true;
}

async function skipConsumed(job) {
  const gone = await consumedInput(job, { client: publicClient, pool: POOL });
  if (!gone) return false;
  const fromBlock = (await publicClient.getBlockNumber()) - CONSUMED_LOOKBACK_BLOCKS;
  const find = (needles) => findCarrier({ client: publicClient, pool: POOL, needles, fromBlock }).catch(() => null);
  const memos = (Array.isArray(job.memos) ? job.memos : []).filter((m) => String(m || '').replace(/^0x/i, '').length >= 64);
  const own = (job.mode || 'settle') === 'settle' && memos.length ? await find(memos) : null;
  const by = own ? null : await find([gone.id]);
  const ack = consumedAck(gone, { own, by, type: job.type });
  log(`job ${job.jobId} type=${job.type} ${ack.txHash ? `already settled in ${ack.txHash}` : `not proved: ${gone.reason}${by ? ` in ${by}` : ''}`}`);
  await confidentialAck({ jobId: job.jobId, ...ack });
  return true;
}

// A relayed wrap whose deposit the pool has not recorded can only revert. The dapp sends the job once the deposit
// has a receipt, so a node a block behind is the usual cause: look again for a few blocks before failing it, and
// fail it without proving.
async function skipUnlanded(job) {
  for (let i = 0; ; i++) {
    const missing = await unlandedDeposits(job, { client: publicClient, pool: POOL });
    if (!missing.length) return false;
    if (i >= 3) {
      log(`job ${job.jobId} type=${job.type} not proved: deposit ${missing[0]} is not on chain`);
      await confidentialAck({ jobId: job.jobId, error: 'the deposit for this wrap is not on chain, so nothing was taken; send it again once the deposit transaction confirms' });
      return true;
    }
    await sleep(8);
  }
}

// A cBTC mint the pool's lock gate would refuse, or a cUSD loan or top-up the engine would, or a bridge mint built on a burn root
// the pool has moved past, can only revert, so it is acked failed without paying for a proof, with the reason.
const GATED = {
  cbtcmint: ['cBTC mint', cbtcMintBlocker], cdpmint: ['cUSD loan', cdpBlocker], cdptopup: ['collateral top-up', cdpBlocker],
  bridgemint: ['bridge mint', bridgeMintBlocker], bridgestealthmint: ['bridge mint', bridgeMintBlocker],
};
async function skipBlockedMint(job) {
  // A bridge mint on a burn root the pool has moved past is made current by the API first (the holder's half is kept), so it is proved on
  // the root the pool holds; the check below then turns back only one that could not be.
  if (job.type === 'bridgemint') await renewStaleMint(job, { blocker: (j) => bridgeMintBlocker(j, { client: publicClient, pool: POOL }), refresh: confidentialRefresh, sleep, log });
  const gate = GATED[job.type];
  const why = gate && await gate[1](job, { client: publicClient, pool: POOL });
  if (!why) return false;
  log(`job ${job.jobId} type=${job.type} not proved: ${why}`);
  await confidentialAck({ jobId: job.jobId, error: `${gate[0]} not proved: ${why}` });
  return true;
}

// Prove and settle one claimed job on the ordinary single-op path, carrying it to a terminal ack either way. A job already
// claimed when proving paused (a batch member) is failed without being proved, in the words the pages read as "send it
// another way".
async function settleOne(j) {
  if (pause.paused()) {
    await confidentialAck({ jobId: j.jobId, error: 'prove failed: the relay isn’t proving right now; nothing was spent. Prove it with your own prover account, or send it again later' });
    return;
  }
  if (await skipConsumed(j)) return;
  try {
    const proof = await beating(`proving ${j.jobId} ${j.type}`, () => proveSettle({ type: j.type, op: j.op, memos: j.memos || [], timeoutMs: CFG.settleJobTimeoutSecs * 1000 }))
      .catch(async (e) => { await pauseOn(e); throw e; });
    const txHash = await submitSettle(proof, j.memos || [], `job ${j.jobId}`);
    await confidentialAck({ jobId: j.jobId, txHash, lane: proof.lane });
    log(`settled: job=${j.jobId} tx=${txHash}`);
    bookSettled([j], txHash);
    await activateRelayedExit(j, txHash);
  } catch (e) {
    log(`job ${j.jobId} failed: ${e.message}`);
    // As in the batch path: a broadcast that has not landed may still land, and acking failed is terminal. Name its hashes
    // so the status points at something checkable, and keep watching them so a late landing corrects the record.
    const pending = Array.isArray(e.broadcastHashes) && e.broadcastHashes.length
      ? ` — broadcast and possibly still pending: ${e.broadcastHashes.join(', ')}`
      : '';
    await confidentialAck({ jobId: j.jobId, error: pending ? `${safeErr(e, 200 - pending.length)}${pending}` : safeErr(e), broadcastHashes: e.broadcastHashes });
    abandoned.remember(j, e.broadcastHashes);
  }
}

// Ops of different types share a settle when SETTLE_BATCH_MIXED=1 (lib/prover.js proveMixed). A batch the network could
// not execute means the joined input was wrong for the guest, and asking the same way again would cost a request per
// cycle, so mixed batching rests for a while after one and says so.
const MIXED_REST_MS = 30 * 60_000;
let mixedRestUntil = 0;
const mixedOn = () => CFG.settleBatchMixed && !!CFG.networkPrivateKey && Date.now() >= mixedRestUntil;

// A lone op waits a little for company when the arrival rate says company is coming (lib/batch-window.js): the ops then
// share one proof and one settle. The wait is the time until the oldest queued op has waited the expected gap, at most
// SETTLE_BATCH_WAIT_MAX_SECS; prove-only jobs are never held (they are not batched).
const batchWindow = makeBatchWindow({ maxWaitMs: CFG.settleBatchWaitMaxSecs * 1000 });
let gatherNotedAt = 0;
async function gatherWait() {
  if (CFG.settleBatchMax <= 1 || CFG.settleBatchWaitMaxSecs <= 0) return 0;
  const q = await confidentialQueue().catch(() => null);
  if (!q) return 0;
  // Only relayed settles can join one another: a queue of prove-only jobs holds nobody, and an older API that does not say how many
  // of the pending are settles gets the old reading.
  const settles = Number.isFinite(q.pendingSettle) ? q.pendingSettle : q.pending;
  const oldest = Number.isFinite(q.oldestPendingSettleSec) ? q.oldestPendingSettleSec : q.oldestPendingSec;
  const ms = batchWindow.wait({ pending: settles, oldestPendingSec: oldest, batchMax: CFG.settleBatchMax });
  if (ms > 0 && Date.now() - gatherNotedAt > 30_000) {
    gatherNotedAt = Date.now();
    log(`holding ${settles} queued op${settles === 1 ? '' : 's'} up to ${Math.round(ms / 1000)} s for company (${batchWindow.ratePerHour().toFixed(0)} settles/h)`);
  }
  return ms;
}

async function batchCycle() {
  if (CFG.settleBatchMax <= 1) return false;
  let jobs = await confidentialBatch(CFG.settleBatchMax, { mixed: mixedOn() });
  if (!jobs.length) return false;
  for (const j of jobs) batchWindow.seen(j.jobId);

  // Gate every member exactly as the single-job path does. Refused members are acked individually — one underpaying member must not sink the others — and the rest carry on. The gate
  // holds each to its own marginal cost; a batch splits the gas, so this is conservative, never permissive.
  const [gasGwei, ethPx] = await Promise.all([liveGasGwei(), ethUsdPrice()]);
  const provePx = await provePriceUsd(ethPx);
  const { admitted, refused } = await admitJobs(jobs, (j) => feeGate(j, gasGwei, provePx, ethPx));
  for (const { job, verdict } of refused) {
    log(`job ${job.jobId} type=${job.type} rejected by feeGate (batch): ${verdict.reason}`);
    await confidentialAck({ jobId: job.jobId, error: `feeGate: ${verdict.publicReason || verdict.reason}` });
  }
  if (!admitted.length) return true; // we did work (refusing), so the loop should poll again immediately
  // The single path's checks that fail a job without a proof: a member they would fail would only fail the batch's settle.
  // (Transfers are checked for a consumed input, as before; the other types a mixed batch takes have their own.)
  jobs = [];
  for (const j of admitted) {
    if (await skipExpired(j) || await skipConsumed(j)) continue;
    if (j.type !== 'transfer' && (await skipUnlanded(j) || await skipBlockedMint(j))) continue;
    jobs.push(j);
  }
  // Two members spending the same note can never prove together (the second is a double spend); in practice it is a
  // user retrying a send that looked stuck. The first stays in the batch, and the rest settle on their own once the
  // batch is done, where they resolve against what the first one did.
  const spent = new Set(), later = [];
  jobs = jobs.filter((j) => {
    const nus = spentInputsOf(j.op || {}).map((n) => String(noteNullifier(n)).toLowerCase());
    if (nus.some((n) => spent.has(n))) { later.push(j); return false; }
    for (const n of nus) spent.add(n);
    return true;
  });
  try {
    if (!jobs.length) return true;
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
    // With the mixed path on, every batch goes through it, transfers alone included: it is the path the prover board and
    // the direct network request serve, where the transfer batch binary is a public network request only.
    const wrongType = jobs.filter((j) => j.type !== 'transfer');
    if (mixedOn()) return await settleMixed(jobs);
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
      proof = await beating(`proving a batch of ${jobs.length}`, () => proveSettle({ type: 'batchtransfer', op, memos, timeoutMs: CFG.settleJobTimeoutSecs * 1000 }));
    } catch (e) {
      // A batch proof covers every member, so one member that cannot prove fails it; settle each member alone
      // instead, so only that member fails. A batch the prover account could not pay for pauses proving, and its members
      // are then failed without being proved (settleOne).
      await pauseOn(e);
      log(`batch prove failed, settling members one by one: ${e.message}`);
      for (const j of jobs) await settleOne(j);
      return true;
    }
    try {
      const txHash = await submitSettle(proof, memos, `batch(${jobs.length})`);
      for (const id of ids) await confidentialAck({ jobId: id, txHash, lane: proof.lane });
      log(`batch settled: n=${jobs.length} tx=${txHash}`);
      bookSettled(jobs, txHash);
    } catch (e) {
      log(`batch settle failed, settling members one by one: ${e.message}`);
      for (const j of jobs) await settleOne(j);
    }
    return true;
  } finally {
    for (const j of later) await settleOne(j);
  }
}

// Several claimed ops of different types in one proof and one settle. Their memos go with the settle in op order, as the
// proof commits to them. A proof that fails leaves each member to settle on its own (settleOne, with its own credit check:
// a request over several ops needs more credit on hand than one over a single op, so a batch the account could not cover
// is not a reason to pause); a settle that fails does the same.
async function settleMixed(jobs) {
  const ids = jobs.map((j) => j.jobId);
  const memos = jobs.flatMap((j) => (Array.isArray(j.memos) ? j.memos : []));
  log(`batching ${jobs.length} ops (${jobs.map((j) => j.type).join(', ')}) into one settle: ${ids.map((i) => i.slice(0, 10)).join(' ')}`);
  let proof;
  try {
    proof = await beating(`proving a batch of ${jobs.length}`, () => proveMixed({ items: jobs.map((j) => ({ type: j.type, op: j.op, memos: j.memos || [] })), timeoutMs: CFG.settleJobTimeoutSecs * 1000 }));
  } catch (e) {
    if (notExecuted(e)) {
      mixedRestUntil = Date.now() + MIXED_REST_MS;
      log(`MIXED BATCH NOT EXECUTED by the network (${e.message}); ops of different types settle on their own for the next ${MIXED_REST_MS / 60_000} minutes`);
    } else {
      log(`mixed batch prove failed, settling members one by one: ${e.message}`);
    }
    for (const j of jobs) await settleOne(j);
    return true;
  }
  try {
    const txHash = await submitSettle(proof, memos, `batch(${jobs.length})`);
    for (const id of ids) await confidentialAck({ jobId: id, txHash, lane: proof.lane });
    log(`mixed batch settled: n=${jobs.length} tx=${txHash}${proof.private === false ? ' (public input)' : ''}`);
    bookSettled(jobs, txHash);
  } catch (e) {
    log(`mixed batch settle failed, settling members one by one: ${e.message}`);
    for (const j of jobs) await settleOne(j);
  }
  return true;
}

// The ops whose witness carries no relay fee by design (value-locking, on-ramps, a committed destination): the same list as
// worker/src/relay-quote.js feeLegsOf, kept equal by a test. Sealed, they are the relay's gift as in the clear, metered by the API on
// its free-settle budgets by type at submit; every other sealed op must bind a fee the proof shows.
export const SEALED_FEELESS = ['wrap', 'cbtcmint', 'farmbond', 'adaptorlock', 'adaptorclaim', 'cdptopup', 'stealthlock', 'bridgestealthmint'];
// What a sealed proof pays the relay, read from its public values: each fee leg against the API's published floor for its asset
// (worker-client.js quoteAsset; the same floor the pages quote). → { ok, feeUsd, feeToken, legs, reason }.
async function sealedFee(publicValues, ethPx) {
  let legs;
  try { legs = pvFees(publicValues); } catch (e) { return { ok: false, feeUsd: null, feeToken: null, legs: [], reason: `fee legs unreadable: ${e.message}` }; }
  if (!legs.length) return { ok: false, feeUsd: null, feeToken: null, legs, reason: 'no fee leg' };
  let ok = false, feeUsd = null, feeToken = null;
  const said = [];
  for (const leg of legs) {
    const q = await quoteAsset(leg.assetId);
    if (!q) { said.push(`${leg.assetId.slice(0, 10)}…: not priced`); continue; }
    said.push(`${leg.value} ${q.ticker} (floor ${q.floorUnits})`);
    if (leg.value >= q.floorUnits) { ok = true; feeToken ||= q.ticker; }
    if (q.ticker === 'cETH' && ethPx) feeUsd = (feeUsd || 0) + (Number(leg.value * BigInt(CFG.ethUnitScale)) / 1e18) * Number(ethPx);
  }
  return { ok, feeUsd, feeToken, legs, reason: said.join(', ') };
}
// A job sealed to one board worker (its witness never readable here): proved there or failed with the reason; the fee it
// binds is read from the proof's own legs and held to the API's floor for each asset; then sent as any settle.
async function settleSealed(job, memos) {
  const { jobId, type } = job;
  log(`job ${jobId} type=${type} sealed to ${job.sealed.worker} — proving on the board`);
  await beat(`proving ${jobId} ${type} (sealed)`);
  let proof;
  try {
    proof = await beating(`proving ${jobId} ${type} (sealed)`, () => proveSealed({ type, sealed: job.sealed, memos, timeoutMs: CFG.settleJobTimeoutSecs * 1000 }));
  } catch (e) {
    log(`job ${jobId} sealed prove failed: ${e.message}`);
    noteProveFailure();
    await confidentialAck({ jobId, error: e.code === 'sealed_unavailable' || e.code === 'sealed_unsupported' ? e.message : `prove failed: ${safeErr(e)}` });
    return true;
  }
  const ethPx = await ethUsdPrice().catch(() => null);
  // A sealed op's fee can only be read from its proof: each leg is held to the API's floor for its asset (gas-aware where the asset
  // is priced, static for cTAC), the same floor the page quoted it. An op with no fee by design is the relay's gift, as in the clear,
  // metered by the API at submit; any other sealed op without a leg at the floor is refused rather than subsidised blind.
  const fee = await sealedFee(proof.publicValues, ethPx);
  if (!fee.ok && !SEALED_FEELESS.includes(type)) {
    log(`job ${jobId} type=${type} (sealed) carries no relay fee at the floor: ${fee.reason}`);
    await confidentialAck({ jobId, error: `a sealed action must bind a relay fee at the floor in an asset the relay prices (${fee.reason}); nothing was sent — send it with such a fee, or unsealed` });
    return true;
  }
  if (!fee.ok) log(`UNPAID: job type=${type} (sealed) carries no fee leg — relaying at our own expense`);
  else log(`job ${jobId} type=${type} (sealed) fee ${fee.reason}`);
  if (fee.feeUsd != null) job = { ...job, feeUsd: fee.feeUsd, feeToken: fee.feeToken };
  else if (fee.feeToken) job = { ...job, feeToken: fee.feeToken };
  let txHash;
  try {
    txHash = await submitSettle(proof, memos, `job ${jobId}`);
  } catch (e) {
    log(`job ${jobId} (sealed) settle failed: ${e.message}`);
    const pending = Array.isArray(e.broadcastHashes) && e.broadcastHashes.length ? ` — broadcast and possibly still pending: ${e.broadcastHashes.join(', ')}` : '';
    const sel = e.revertSelector ? ` (${e.revertSelector})` : '';
    await confidentialAck({ jobId, error: `settle reverted: ${safeErr(e, 200 - pending.length - sel.length)}${sel}${pending}`, broadcastHashes: e.broadcastHashes });
    abandoned.remember(job, e.broadcastHashes);
    return true;
  }
  log(`settled: job=${jobId} tx=${txHash} (board, sealed)`);
  await confidentialAck({ jobId, txHash, lane: 'board' });
  bookSettled([job], txHash);
  await beat(`settled ${jobId}`);
  return true;
}

// A settle is paid from the settle wallet after its proof is bought, and a node refuses a send whose worst-case fee
// the wallet cannot cover, so while the wallet is short every job it settles would be proved and then failed. Those
// jobs wait as queued until it is funded again, and nothing is spent on a proof that cannot land. A job that asks
// only for its proof (the page sends the settle from its own account) needs nothing from the wallet, so those are
// still proved. The budget is an ordinary op's padded gas at the fee cap submitCall uses. An unreadable chain is not
// a reason to stop.
const SETTLE_FUNDS_GAS = CFG.settleFundsGas;
let shortSince = 0, shortNotedAt = 0;
async function fundsShort() {
  let have, need;
  try {
    const [bal, blk] = await Promise.all([
      publicClient.getBalance({ address: settleWallet.account.address }),
      publicClient.getBlock({ blockTag: 'latest' }),
    ]);
    have = bal; ({ need } = await settleFundsNeed(publicClient, { block: blk }));
  } catch { return false; }
  const eth = (wei) => (Number(wei) / 1e18).toFixed(4);
  if (have >= need) {
    if (shortSince) log(`settle wallet holds ${eth(have)} ETH again — taking jobs`);
    shortSince = 0;
    return false;
  }
  if (!shortSince) shortSince = Date.now();
  if (Date.now() - shortNotedAt >= 60_000) {
    shortNotedAt = Date.now();
    log(`settle wallet holds ${eth(have)} ETH, under the ${eth(need)} ETH a settle can cost at today's gas — proving only jobs a page settles itself${boardOn() ? ', and relayed jobs any sender can take from the open board' : '; the rest wait'}`);
  }
  return true;
}

// While the wallet is short, relayed jobs any account could send are proved for the open board only with the board on and the
// last credit reading at or over its floor (lib/prove-pause.js boardProving), and the heartbeat says so only then.
const boardOn = () => boardProving({ enabled: CFG.proveWhileShort, credit: lastProverCredit(), minWei: CFG.proveWhileShortMinCreditWei });

// Proving pauses when a proof request is refused for want of credit (lib/prove-pause.js): no job is claimed, so each keeps
// its place, and the credit is read again at most every SETTLE_PROVE_PAUSE_RECHECK_SECS until it covers a request. Sending
// proofs from the open board costs gas, not PROVE, and carries on.
const pause = makeProvePause({
  readCredit: readProverCredit, minWei: CFG.settleProveMinCreditWei, everyMs: CFG.settleProvePauseRecheckSecs * 1000, log,
});
// A proof request the prover account could not pay for starts the pause, and the paused note goes out at once, before the
// job's failure is acked, so a page that reads the failure finds the relay paused.
async function pauseOn(e) {
  if (!creditShort(e) || !pause.enter(String(e && e.message || e).split('\n')[0].slice(0, 160))) return;
  await standWith(standingNote({ paused: true }));
}

// What the heartbeat says. While the relay is short or paused it beats that standing note (lib/prove-pause.js), public and
// without balances: when it changes, and every minute while it holds. A job's own beat carries it too, so a job proved or
// sent meanwhile never makes the relay look as if it were taking everything. The API reads the notes (relayState).
let standing = null, standingAt = 0;
async function standWith(note) {
  const was = standing;
  standing = note;
  if (!note) { if (was) await heartbeat('settle', 'taking jobs again'); return; }
  if (note === was && Date.now() - standingAt < 60_000) return;
  standingAt = Date.now();
  await heartbeat('settle', note);
}
// Proofs that failed in the last hour (the board and the network both refusing, say) ride on every heartbeat note, so the monitor
// (balance-monitor.js checkProverKinds) can say so: a relay that is up and failing every job otherwise reads as healthy.
const proveFailAt = [];
function noteProveFailure() { proveFailAt.push(Date.now()); }
function recentProveFailures(now = Date.now()) { while (proveFailAt.length && now - proveFailAt[0] > 3_600_000) proveFailAt.shift(); return proveFailAt.length; }
const withFailures = (detail) => { const n = recentProveFailures(); return n ? `${detail || ''} · ${n} prove failure${n === 1 ? '' : 's'} in the last hour` : detail; };
const beat = (detail) => heartbeat('settle', withFailures(standing || detail));
// What a failed proof tells the job (and so the holder's page): a reason in the op is kept in the relay's words (it is theirs to act
// on); a reason on the relay's side (its prover did not run, the board was away, a timeout) is said plainly, with nothing of the
// relay's insides in it. The full error is in the log either way.
function proveFailureForJob(e) {
  const m = String(e && e.message || e);
  if (/unexecutable|execution failed|failed to execute|exceeded cycle limit|VKEY|stale|refused|did not pass/i.test(m)) return e;
  const out = new Error('the relay’s prover could not make this proof just now; nothing was spent — try again in a few minutes, or prove it yourself');
  out.creditShort = e && e.creditShort === true;
  return out;
}
// A prove can run past the API's ten quiet minutes (a private request waits up to six before its public retry), and a relay
// that has gone quiet reads as down to the pages, so the beat goes out again every few minutes until the proof is back.
async function beating(detail, fn) {
  const t = setInterval(() => { beat(detail); }, 4 * 60_000);
  try { return await fn(); } finally { clearInterval(t); }
}

// The open board (lib/open-board.js), from the sending side. Once the settle wallet can pay, the jobs it proved while it
// could not are sent before new work is proved, then any posted proof whose tETH fee covers its settle. The public board
// is read at most every OPEN_BOARD_POLL_SECS (straight away again after a send, there may be more), and the claim makes
// sure two relays never send the same job.
let openReadAt = 0;
// The proof market (lib/market-solver.js): an open order is claimed and proved at the same time, then fulfilled; the TAC price is pulled
// from the holder's permit in the fulfil, to this settle wallet. The relay is first in line for what it takes; a holder who wants
// another prover to win raises what they sign, and a prover that claims first has the order.
let marketReadAt = 0;
let lastWorkedAt = 0;
// A claim and a fulfil cost this much gas (measured on mainnet: 128k and 676k). The least price in TAC wei the relay takes an order at is that gas at
// the current price, plus its proving share, plus a margin, valued in TAC at what ETH buys now (read from the chain at most every minute).
const MARKET_GAS = 128_000n + 700_000n;
let tacRate = { at: 0, out: 0n };
let marketLowAt = 0;
async function marketMinPrice() {
  const gasPrice = await publicClient.getGasPrice();
  if (Date.now() - tacRate.at > 60_000) {
    const q = deepest(await quoteTacForEth(publicClient, 10n ** 16n));
    if (!q) throw new Error('no TAC quote');
    tacRate = { at: Date.now(), out: q.amountOut };
  }
  const costWei = (MARKET_GAS * gasPrice * 13n) / 10n + CFG.marketProveCostWei;           // gas at the price plus 30% for the base fee moving, plus proving
  // No order is taken (and no proof spent on one) unless the wallet holds what the relay's own settles need at today's gas (its floor: below it relayed jobs are held, which the
  // market must never cause) AND the gas to claim and fulfil on top of that.
  const [held, blk] = await Promise.all([publicClient.getBalance({ address: settleWallet.account.address }), publicClient.getBlock({ blockTag: 'latest' })]);
  const { need } = await settleFundsNeed(publicClient, { block: blk });
  if (!marketHasRoom({ held, need, orderGas: MARKET_GAS, gasPrice })) {
    if (Date.now() - marketLowAt > 10 * 60_000) { marketLowAt = Date.now(); log(`market: the settle wallet holds ${(Number(held) / 1e18).toFixed(5)} ETH; the relay's own settles need ${(Number(need) / 1e18).toFixed(5)} at ${(Number(gasPrice) / 1e9).toFixed(2)} gwei and an order about ${(Number((MARKET_GAS * gasPrice * 15n) / 10n) / 1e18).toFixed(5)} more: market orders are left until it is topped up`); }
    return 2n ** 255n;
  }
  const tac = (costWei * tacRate.out) / 10n ** 16n;
  const withMargin = (tac * (10_000n + CFG.marketMarginBps)) / 10_000n;
  return withMargin > CFG.marketMinTacWei ? withMargin : CFG.marketMinTacWei;
}
const marketSolver = makeMarketSolver({
  me: settleWallet.account.address, minPrice: marketMinPrice,
  // The relay's own queue (users' ops, the pool's settles) comes first: no new market proof is begun within 15 s of a job it worked on, so a market order never queues the board ahead of one.
  canStart: () => Date.now() - lastWorkedAt > 15_000,
  listOrders: () => marketOrders(),
  depositStatus: async (id) => BigInt((await publicClient.call({ to: POOL, data: `0x7da9874f${id.slice(2)}` })).data || 0),
  done: (id) => publicClient.readContract({ address: CFG.marketAddr, abi: MARKET_ABI, functionName: 'done', args: [id] }),
  claimOf: async (id) => { const [solver, until] = await publicClient.readContract({ address: CFG.marketAddr, abi: MARKET_ABI, functionName: 'claims', args: [id] }); return solver === '0x0000000000000000000000000000000000000000' ? null : { solver, until: Number(until) }; },
  claim: async (o) => submitCall({ address: CFG.marketAddr, abi: MARKET_ABI, ...claimCall(o), value: await publicClient.readContract({ address: CFG.marketAddr, abi: MARKET_ABI, functionName: 'claimBond' }) }, `market claim ${o.intent.opId.slice(0, 10)}`, { gasLimit: 170_000n }),
  prove: (o) => proveStdin({ stdin: Uint8Array.from(Buffer.from(o.stdin.slice(2), 'hex')), type: 'wrap', memos: o.memos || [], timeoutMs: 150_000, expectPublicValues: o.publicValues }),
  fulfil: (o, p) => submitCall({ address: CFG.marketAddr, abi: MARKET_ABI, ...fulfillCall(o, p.proof) }, `market fulfil ${o.intent.opId.slice(0, 10)}`, { gasLimit: 800_000n }),
  deliver: (o, p) => marketProofPost(o.intent.opId, p.publicValues, p.proof),
  clear: (id) => marketClear(id),
  log,
});
async function marketCycle() {
  if (!CFG.marketSolve || Date.now() - marketReadAt < CFG.marketPollSecs * 1000) return false;
  marketReadAt = Date.now();
  const worked = await marketSolver.pass();
  if (worked) { marketReadAt = 0; await beat('market order'); }
  return worked;
}

// TacitGasRelay (lib/gas-solver.js): an order is simulated, and sent only when its fee (TAC or the token spent, valued by a KyberSwap quote into
// ETH) covers the gas with the margin; the contract pays the fee only if the whole swap lands.
let gasReadAt = 0;
const ETH_KYBER = '0xEeeeeEeeeEeEeeEeEeeEeEEEeeeeEeeeeeeeEEeE';
async function gasFeeWei(x) {
  const o = x.order;
  if (BigInt(o.fee) === 0n) return 0n;
  const r = await fetch(`https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?${new URLSearchParams({ tokenIn: o.feeToken, tokenOut: ETH_KYBER, amountIn: String(o.fee) })}`, { signal: AbortSignal.timeout(8000) }).then((q) => (q.ok ? q.json() : null)).catch(() => null);
  const out = r?.data?.routeSummary?.amountOut;
  return /^\d+$/.test(String(out ?? '')) ? BigInt(out) : null;
}
const gasSolver = makeGasSolver({
  marginBps: CFG.gasRelayMarginBps,
  listOrders: () => gasOrders(),
  used: (payer, nonce) => publicClient.readContract({ address: CFG.gasRelayAddr, abi: GAS_ABI, functionName: 'used', args: [payer, BigInt(nonce)] }),
  simulate: async (x) => {
    const base = { address: CFG.gasRelayAddr, abi: GAS_ABI, ...executeCall(x), account: settleWallet.account };
    await publicClient.simulateContract(base);                                  // throws when the contract would refuse it
    return (await publicClient.estimateContractGas(base)) * 12n / 10n;
  },
  feeWei: gasFeeWei,
  gasPrice: () => publicClient.getGasPrice(),
  send: (x, gas) => submitCall({ address: CFG.gasRelayAddr, abi: GAS_ABI, ...executeCall(x) }, `gas relay ${x.id.slice(0, 10)}`, { gasLimit: gas }),
  clear: (x) => gasClear(x),
  log,
});
async function gasCycle() {
  if (!CFG.gasRelaySolve || Date.now() - gasReadAt < CFG.gasRelayPollSecs * 1000) return false;
  gasReadAt = Date.now();
  const worked = await gasSolver.pass();
  if (worked) gasReadAt = 0;
  return worked;
}

async function openCycle() {
  if (!CFG.openBoard || Date.now() - openReadAt < CFG.openBoardPollSecs * 1000) return false;
  openReadAt = Date.now();
  const jobs = await confidentialOpenList().catch(() => []);
  if (!jobs.length) return false;
  const gasPrice = await publicClient.getGasPrice().catch(() => null);
  const pick = pickOpen(jobs, {
    settleCostWei: gasPrice == null ? null : DEFAULT_OP_GAS * gasPrice, ethAssetId: CFG.ethAssetId, ethUnitScale: CFG.ethUnitScale,
  });
  if (!pick) return false;
  const job = await confidentialOpenJob(pick.jobId);
  if (!job?.jobId) return false;
  openReadAt = 0;
  const { jobId, type } = job;
  log(`job ${jobId} type=${type} — sending its proof from the open board${job.posted ? ' (posted by its holder)' : ''}`);
  await beat(`sending ${jobId} ${type}`);
  let txHash;
  try {
    txHash = await submitSettle({ publicValues: job.publicValues, proof: job.proof }, job.memos || [], `job ${jobId}`);
  } catch (e) {
    log(`job ${jobId} open settle failed: ${e.message}`);
    // A proof pinned to a root that moved is proved again from the witness the API holds; one that cannot be sent at all
    // fails. Nothing that was broadcast and might still land is dropped: its hashes stay on the record.
    const requeue = !job.posted && !!job.op && STALE_PROOF_SELECTORS.includes(e.revertSelector || '');
    const sel = e.revertSelector ? ` (${e.revertSelector})` : '';
    await confidentialAck({ jobId, error: `settle reverted: ${safeErr(e, 180 - sel.length)}${sel}`, broadcastHashes: e.broadcastHashes, requeue });
    abandoned.remember(job, e.broadcastHashes);
    return true;
  }
  log(`settled from the open board: job=${jobId} tx=${txHash}`);
  await confidentialAck({ jobId, txHash });
  // A posted proof carries no fee the API priced; its tETH legs are what this settle earned, at today's ETH price.
  if (job.posted && job.feeUsd == null) {
    const wei = ethFeeWei(job.publicValues, { ethAssetId: CFG.ethAssetId, ethUnitScale: CFG.ethUnitScale });
    const ethUsd = wei > 0n ? await ethUsdPrice().catch(() => null) : null;
    if (wei > 0n && ethUsd) Object.assign(job, { feeUsd: (Number(wei) / 1e18) * Number(ethUsd), feeAsset: '0x0000000000000000000000000000000000000000' });
  }
  bookSettled([job], txHash);
  await beat(`settled ${jobId}`);
  return true;
}

// What a free prove-only job is told when the credit is kept back. Public (the job's status carries it), so it says what to do and
// nothing about balances.
export const FREE_PROVE_HELD = 'the relay is keeping its proving credit for the bridge right now: send it through the relay instead (it carries a fee), or try again later';
// The last credit reading if it is recent, else a fresh one, at most every two minutes; an unreadable credit holds nothing back.
let freeProveReadAt = 0;
async function freeProveAllowed(type) {
  // Offered to a prover-board worker that is proving now, the job costs no credit, so the reserve has nothing to keep (the API lets
  // such a job through on the same reading; a board that misses sends it to the network, one proof past the floor at worst).
  if (await boardAlive().catch(() => false)) return true;
  let c = lastProverCredit();
  if (!c || Date.now() - c.at > 10 * 60_000) {
    if (Date.now() - freeProveReadAt >= 120_000) {
      freeProveReadAt = Date.now();
      try { await readProverCredit(); } catch {}
      c = lastProverCredit();
    }
  }
  return !c || c.wei == null || BigInt(c.wei) >= proveFloorWei(type, { reserveWei: CFG.freeProveMinCreditWei, exitWei: CFG.freeProveExitMinCreditWei });
}

async function cycle() {
  const short = await fundsShort();
  const paused = await pause.check();
  const board = short && boardOn();
  await standWith(standingNote({ paused, short, board }));
  // Sending a proof from the open board costs gas, not PROVE, so it carries on while proving is paused.
  if (!short && await openCycle()) return true;
  // Paused: nothing is claimed, so every job keeps its place in the queue until the credit covers a request.
  if (paused) return false;
  // Gathering: the queued settle jobs are left a moment for company; only prove-only jobs are taken meanwhile.
  const gather = short ? 0 : await gatherWait();
  if (!short && !gather && await batchCycle()) return true;
  let job = await confidentialJob(short || gather ? { mode: 'prove' } : {});
  if (gather && !job?.jobId) { await sleep(Math.min(gather / 1000, CFG.settlePollSecs)); return true; }
  // While the wallet cannot pay for a settle, a relayed job any account could send is still proved and put on the open
  // board: its holder's page offers to send it at once, any relayer may send it for its fee, and this relay sends it
  // itself once it can pay. A job only this relay could finish (an exit to activate, a router-embedded proof) waits, and so
  // does everything while the credit has nothing to spare: a board proof is bought before anyone sends it.
  const holding = short && !job?.jobId && board;
  if (holding) job = await confidentialJob({ mode: 'settle', openable: true });
  const jobId = job?.jobId;
  if (!jobId) return false; // empty queue

  const type = job.type;
  const mode = job.mode || 'settle';
  // An arrival that could have shared a settle: the rate that decides whether a lone op waits for company counts these only (prove-only
  // jobs were 90% of the count, so the relay expected company that never came and held settles a minute for it).
  if (mode === 'settle' && !job.exit) batchWindow.seen(jobId);
  // A worker that predates the mode filter can hand a settle job over while the wallet is short: it is left
  // claimed and unacked, so it comes back to the queue when the claim lapses, and nothing is spent on it now.
  if (short && mode !== 'prove' && !(holding && openable(job))) return false;
  const memos = Array.isArray(job.memos) ? job.memos : [];
  // A sealed job carries no op the checks below could read: it is proved on the board (or not at all), then checked and priced
  // from the proof itself.
  if (job.sealed && mode === 'settle') return settleSealed(job, memos);
  if (!OP_GAS[type] && type !== 'transfer') {
    // unknown-but-provable ops still allowed; gas defaults. Only truly-unknown type fails at prove.
  }

  // A free prove-only job (the holder sends the settle, the relay pays only the proof) is proved only while the credit holds what the
  // bridge's attests and paid work need (FREE_PROVE_MIN_CREDIT_WEI). The API turns such jobs away at submit on the same figure; this is
  // the backstop for one already queued. A wrap whose deposit tipped the relay is paid work and is proved whatever the credit.
  if (mode === 'prove' && !job.paid && !(await freeProveAllowed(type))) {
    log(`job ${jobId} type=${type} prove-only held: the credit is under ${(Number(proveFloorWei(type, { reserveWei: CFG.freeProveMinCreditWei, exitWei: CFG.freeProveExitMinCreditWei })) / 1e18).toFixed(0)} PROVE, kept for the bridge and paid work`);
    await confidentialAck({ jobId, error: FREE_PROVE_HELD });
    return true;
  }

  const [gasGwei, ethPx] = await Promise.all([liveGasGwei(), ethUsdPrice()]);
  const provePx = await provePriceUsd(ethPx);
  const gate = await feeGate(job, gasGwei, provePx, ethPx);
  if (!gate.ok) {
    log(`job ${jobId} type=${type} rejected by feeGate: ${gate.reason}`);
    await confidentialAck({ jobId, error: `feeGate: ${gate.publicReason || gate.reason}` });
    return true;
  }

  if (await skipExpired(job)) return true;
  if (mode !== 'preproven' && (await skipConsumed(job) || (mode === 'settle' && await skipUnlanded(job)) || await skipBlockedMint(job))) return true;

  log(`job ${jobId} type=${type} mode=${mode} — proving (network groth16). ${gate.reason} [gas ${gasGwei.toFixed(4)} gwei, ETH $${Number(ethPx).toFixed(2)}, PROVE $${Number(provePx).toFixed(4)}]`);
  await beat(`proving ${jobId} ${type}`);

  let proof;
  if (mode === 'preproven' && job.publicValues && job.proof) {
    // The proof was produced elsewhere (a standby prover, or the user's own local prover — the private,
    // fee-free path where the witness never reached the relay). Skip proving; just settle the supplied proof.
    proof = { publicValues: job.publicValues, proof: job.proof };
    log(`job ${jobId} type=${type} preproven — settling supplied proof (no relay prove)`);
  } else {
    try {
      proof = await beating(`proving ${jobId} ${type}`, () => proveSettle({ type, op: job.op, memos, timeoutMs: CFG.settleJobTimeoutSecs * 1000 }));
    } catch (e) {
      log(`job ${jobId} prove failed/timeout: ${e.message}`);
      noteProveFailure();
      e = proveFailureForJob(e);
      // A request the prover account could not pay for pauses proving first; the job is failed as any other, so the page
      // waiting on it offers to prove it another way.
      await pauseOn(e);
      await confidentialAck({ jobId, error: `prove failed: ${safeErr(e)}` });
      return true; // acked failed → FIFO advances, no wedge
    }
  }

  if (mode === 'prove' || holding) {
    // Prove-only: hand the proof back for a user-sent tx (no on-chain submit here). A relayed job proved while the wallet
    // is short goes back with `open`, onto the board.
    const r = await confidentialAck({ jobId, publicValues: proof.publicValues, proof: proof.proof, open: holding });
    if (holding) log(`proved and put on the open board: job=${jobId}${r.ok ? '' : ' (the API did not take it; it is proved again when its claim lapses)'}`);
    else log(`proved-only: job=${jobId}`);
    ledger.provedOnly();                                              // a proof paid for with no settle of the relay's own (yet)
    return true;
  }

  let txHash;
  try {
    txHash = await submitSettle(proof, memos, `job ${jobId}`);
  } catch (e) {
    // A revert is typically a lost-ack re-serve of an already-applied op (nullifier spent).
    log(`job ${jobId} settle failed: ${e.message}`);
    // Acking an error is TERMINAL for the job — the worker marks it failed and drops it from the queue, and
    // nothing retries. So distinguish "the chain rejected this" from "we stopped waiting": a private
    // endpoint keeps re-submitting an accepted bundle well past our inclusion window, so a broadcast that
    // has not landed yet may still land. Name those hashes in the error the user is shown, so `failed` on
    // /confidential/status at least points at something checkable instead of dead-ending.
    const pending = Array.isArray(e.broadcastHashes) && e.broadcastHashes.length
      ? ` — broadcast and possibly still pending: ${e.broadcastHashes.join(', ')}`
      : '';
    // The revert's selector, in the "(0x…)" form the pages turn into words (see lib/revert-data.js).
    const sel = e.revertSelector ? ` (${e.revertSelector})` : '';
    await confidentialAck({ jobId, error: `settle reverted: ${safeErr(e, 200 - pending.length - sel.length)}${sel}${pending}`, broadcastHashes: e.broadcastHashes });
    abandoned.remember(job, e.broadcastHashes);
    return true;
  }

  log(`settled: job=${jobId} tx=${txHash}${proof.lane ? ` (${proof.lane})` : ''}`);
  await confidentialAck({ jobId, txHash, lane: proof.lane });
  bookSettled([job], txHash);
  await activateRelayedExit(job, txHash);
  await beat(`settled ${jobId}`);
  return true;
}

// Settles acked failed whose broadcast may still land (lib/abandoned-settles.js): checked from the loop's idle time, and a
// relayed exit that lands late is activated as one that settled in time.
const abandoned = makeAbandonedSettles({
  getReceipt: (hash) => publicClient.getTransactionReceipt({ hash }),
  ack: confidentialAck,
  activate: activateRelayedExit,
  log,
});

// Fee income -> gas, run from the settle loop's idle time. Serialised with settles (same wallet, same
// nonce) by construction: it is only ever awaited where the loop would otherwise sleep. Off unless
// REPLENISH_IN_SETTLE=1, and it can never take the loop down — a failure is logged and retried next interval.
let lastReplenishAt = 0;
let drained = false;
// The highest nonce this process has put on the wire. A settle sent to a private endpoint is invisible to
// the public node, so "idle" does not mean "nothing of ours is pending".
let lastBroadcastNonce = -1;
// The credit as last read for the urgent check (the network's plus PROVE waiting in the sink), read every PROVE_EAGER_PROBE_SECS: one small
// helper process a few times an hour, so that a credit that falls under its line brings the next pass forward instead of waiting out the
// interval (lib/replenish-schedule.js). null = not read.
let eagerCredit = null, lastProbeAt = 0;
async function probeCredit() {
  if (!CFG.replenishInSettle || !CFG.replenishDepositProve || !(CFG.proveEagerProbeSecs > 0)) { eagerCredit = null; return; }
  if (Date.now() - lastProbeAt < CFG.proveEagerProbeSecs * 1000) return;
  lastProbeAt = Date.now();
  try { eagerCredit = await creditForEager(); } catch { eagerCredit = null; }
}
async function maybeReplenish() {
  // Cheap to call every cycle: nothing below (the nonce check included) runs unless the top-up, or the one-off key
  // consolidation, is actually due.
  await probeCredit();
  if (!replenishDue({ enabled: CFG.replenishInSettle, now: Date.now(), lastAt: lastReplenishAt, intervalMin: CFG.replenishIntervalMin, pendingDrain: !!CFG.replenishDrainToSink && !drained,
    credit: eagerCredit, urgentBelow: CFG.proveUrgentBelowWei, urgentEveryMin: CFG.proveEagerEveryMin })) return;
  // Serialisation with settles holds only while a settle is being awaited. Once its rounds are exhausted the
  // job is acked failed and the loop goes idle — but the transaction is still live at the private endpoint
  // and can still be included. A swap signed here would reuse that nonce, get mined first because it is
  // public, and kill a user's settle that was about to land. So idle work waits for the chain to move past
  // anything this process broadcast.
  if (lastBroadcastNonce >= 0) {
    const confirmed = await publicClient
      .getTransactionCount({ address: settleWallet.account.address, blockTag: 'latest' })
      .catch(() => null);
    if (confirmed == null) return;                       // cannot tell: assume something is pending
    if (confirmed <= lastBroadcastNonce) {
      log(`replenish held: nonce ${lastBroadcastNonce} may still be in flight (confirmed ${confirmed})`);
      return;
    }
    lastBroadcastNonce = -1;
  }
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

// PROVE that reaches the prover account between passes (a top-up, or a visitor paying for proofs from /relay/#prove) is
// deposited within PROVE_WATCH_SECS (replenish.js depositArrivedProve), so proving does not wait out a pass for credit
// already sent. The prover account is the relay wallet; where it is also the settle wallet the same nonce rule as a pass
// applies. A read is one balanceOf a minute; a deposit happens only when PROVE has actually arrived.
let lastProveWatchAt = 0;
async function maybeDepositArrived() {
  if (!CFG.replenishInSettle || !CFG.replenishDepositProve || !(CFG.proveWatchSecs > 0)) return;
  if (Date.now() - lastProveWatchAt < CFG.proveWatchSecs * 1000) return;
  lastProveWatchAt = Date.now();
  if (lastBroadcastNonce >= 0 && relayWallet.account.address === settleWallet.account.address) return;
  try { await depositArrivedProve({ minWei: CFG.proveWatchMinWei }); }
  catch (e) { log(`deposit of arrived PROVE failed (settling continues): ${e?.message || e}`); }
}

async function main() {
  log(`starting — worker=${CFG.workerBase} pool=${POOL} poll=${CFG.settlePollSecs}s timeout=${CFG.settleJobTimeoutSecs}s`);
  // The books: which fee assets count as converted income, what the standing commitments are set to, and the snapshot every heartbeat carries.
  try {
    ledger.configure({ converted: feeAssets(), tac: ADDR.tacToken });
    ledger.setConfig({
      buybackBps: CFG.buybackIncomeBps, buybackKeepEth: Number(CFG.buybackKeepWei) / 1e18, buybackMinSendEth: Number(CFG.buybackMinSendWei) / 1e18,
      buybackSurplusBps: CFG.buybackShareBps, splitter: CFG.splitterAddr || null, buyback: CFG.buybackAddr || null, replenishMin: CFG.replenishIntervalMin,
    });
    // The books a restart would lose are taken back from the API first; until it has answered, no heartbeat carries the ledger.
    const books = makeBooksRestorer({ ledger, fetchBooks: relayBooks, log });
    setHeartbeatLedger(() => (books.ready() ? ledger.snapshot() : null));
    await books.start();
  } catch (e) { log(`ledger setup failed (settling continues): ${e?.message || e}`); }
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
      catch (e) { log('cycle error — exiting cron run:', e.message); await heartbeat('settle', `error ${safeErr(e)}`); break; }
      if (!worked) { log('queue drained — cron run done'); await beat('queue drained'); break; }
    }
    return;
  }
  // A deploy or restart sends SIGTERM. A job in hand has had its proof paid for and is claimed, so it would sit
  // stranded until the claim times out: finish it, take no new one, then exit. (The service's shutdown delay has to
  // outlast a prove and settle for this to help.)
  let stopping = false;
  process.on('SIGTERM', () => { if (!stopping) log('SIGTERM — finishing the job in hand, taking no new ones'); stopping = true; });
  for (;;) {
    if (stopping) { log('stopped cleanly'); process.exit(0); }
    try {
      // a market order is paid in TAC by a holder who asked to jump the queue, so it is taken before the free queue (one job each pass)
      let worked = await marketCycle();
      if (!worked) { worked = await cycle(); if (worked) lastWorkedAt = Date.now(); }
      if (!worked) worked = await gasCycle();
      // An empty queue is the common case, not an error — but it must still beat, or /prover-health
      // goes stale (and "down") after 10 quiet minutes on a perfectly healthy relay. heartbeat() itself
      // only fires on real activity (proving/settled/error), so idle time needs its own signal. While the relay is short or
      // paused, its standing note is the signal (standWith), and an idle beat would hide it.
      if (!worked) { if (!standing) await heartbeatIdle('settle', 'idle — queue empty'); await abandoned.sweep(); }
      // Between jobs as well as when idle: a steady stream of jobs is when the prover credit drains fastest, and the top-up
      // has to be able to run then (it is awaited here, so it still never overlaps a settle on the same nonce).
      await maybeReplenish();
      await maybeDepositArrived();
      if (!worked) { if (CFG.marketSolve && marketSolver.hasOpen()) await sleep(2); else await idleWait(); }
    } catch (e) {
      log('cycle error (continuing):', e.message);
      await heartbeat('settle', `error ${safeErr(e)}`);
      await sleep(CFG.settlePollSecs);
    }
  }
}

// Only run the loop when invoked directly (settle-relay is also imported for feeGate reuse).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('fatal', e); process.exit(1); });
}
