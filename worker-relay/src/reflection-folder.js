// ─────────────────────────────────────────────────────────────────────────────
// Reflection folder — the incremental Bitcoin-state attester.
//
// Render service type: Cron Job (RUN_MODE=cron drains pending batches, then exits) or
// Background Worker. It keeps reflection INCREMENTAL (1-2 blocks per cycle) so a batch
// never grows too large to prove: every cycle folds only the small gap since the last
// attested height, proves it on the Succinct NETWORK prover, and attests it on-chain.
//
// Cycle:
//   1. GET /reflection/job?network=  → the assembled next batch (worker streaming
//      assembler, bounded memory). jobId = the batch's newDigest.
//   2. Idempotency: read knownReflectionDigest(); if newDigest already landed
//      (a lost ack), just re-ack — a re-submit would revert, never double-attest.
//   3. proveReflection(input) → bitcoin_prove groth16 on Succinct.
//   4. attestBitcoinStateProven(pv, proof) with the RELAY key.
//   5. POST /reflection/ack {attestedTo, txHash, jobId} → worker advances the
//      un-rewindable attested cursor (persists newSnapshot keyed by jobId).
//
// The persisted snapshot advances only on ack, so a failed prove/submit is a safe
// retry — the same job re-serves and completes. A submitted attest is waited on by polling
// the pool's digest rather than trusting one receipt wait, and is recorded with the API so a later run waits on
// it instead of proving the same batch again; a pool that got ahead of the cursor is reconciled, not re-proved.
// ─────────────────────────────────────────────────────────────────────────────

import { CFG } from './lib/config.js';
import { isMatured } from './lib/maturity.js';
import { reflectionJob, reflectionAck, reflectionPending, reflectionAttestState, reflectionSubmitted, heartbeat, heartbeatIdle } from './lib/worker-client.js';
import { awaitAttestLanding, digestDeepEnough } from './lib/attest-wait.js';
import { recoverLostAck } from './lib/reflection-reconcile.js';
import { proveReflection } from './lib/prover.js';
import { relayWallet, publicClient, verifyClient, readPool, readReflectionDigest, POOL, POOL_ABI, gasAboveCap, HEADER_RELAY, RELAY_ABI } from './lib/chain.js';
import { safeErr } from './lib/safe-err.js';
import { withNonceRetry } from './lib/nonce-retry.js';

const log = (...a) => console.log(`[reflection ${new Date().toISOString()}]`, ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Confirmation depth required before the ack advances the persisted cursor. The ack is one-way — the
// worker has no path back from being ahead of the chain — so this trades a little latency for not
// having to hand-rewind after every shallow reorg. Overridable, but do not set it to 1.
const ATTEST_CONFIRMATIONS = Math.max(1, parseInt(process.env.ATTEST_CONFIRMATIONS || '3', 10));

async function cycle() {
  const job = await reflectionJob();
  if (!job || !job.input) return false; // caught up
  const attestedTo = Number(job.attestedTo) | 0;
  const newDigest = job.jobId || job.input.newDigest;

  // Idempotency: batch already on-chain (lost ack) → re-ack and skip.
  const onchain = await readReflectionDigest();
  if (onchain && newDigest && onchain.toLowerCase() === String(newDigest).toLowerCase()) {
    log(`newDigest already attested on-chain — re-acking attestedTo=${attestedTo}`);
    await reflectionAck({ attestedTo, txHash: '', jobId: newDigest });
    return true;
  }

  // DRIFT GUARD. The batch chains off `priorDigest`; if the pool is not sitting on exactly that, the attest
  // CANNOT land (StaleReflectionDigest) and proving it just buys an unusable proof. That is the expensive
  // failure mode: the worker's cursor can end up AHEAD of the chain — a tx that landed, got acked, then was
  // dropped by a reorg — and there is no idempotent recovery for ahead-ness the way there is for behind-ness
  // (the re-ack path above). Proving on a stale prior would only spend the prover balance, so fail loud and
  // cheap instead; recovery is a cursor rewind (re-seed /reflection/seed at the chain's height).
  if (job.priorDigest && onchain && String(job.priorDigest).toLowerCase() !== String(onchain).toLowerCase()) {
    // Ahead-ness caused by a lost ack is recoverable: the API still holds the batch that landed. Adopt it and let
    // the loop rebuild the job from the advanced cursor. Anything else stays a refusal.
    const rec = await recoverLostAck({
      onchain,
      findPending: async (d) => reflectionPending(d),
      ack: (a) => reflectionAck({ attestedTo: a.attestedTo, txHash: '', jobId: a.jobId }),
      deepEnough: async () => (await confirmDigestOn(verifyClient, onchain)) && (await landedDeep(onchain)),
    });
    if (rec.waiting) {
      log(`landed batch not yet deep enough, waiting — pool digest ${onchain} has fewer than ${ATTEST_CONFIRMATIONS} confirmations or is not confirmed by the independent endpoint`);
      await heartbeat('reflection', `landed batch ${onchain} not yet deep enough`);
      return false;
    }
    if (rec.recovered) {
      log(`RECOVERED lost ack: pool digest ${onchain} was a landed batch the API still held — cursor advanced to attestedTo=${rec.attestedTo}`);
      await heartbeat('reflection', `recovered lost ack at ${rec.attestedTo}`);
      return true;
    }
    log(`DRIFT: job builds on prior=${job.priorDigest} but pool is at ${onchain} — refusing to prove `
      + `(worker cursor is out of sync with chain; re-seed it, do not let this loop burn PROVE). ${rec.reason}. Manual recovery: ${rec.hint}`);
    await heartbeat('reflection', `drift prior=${job.priorDigest} onchain=${onchain}`);
    return false;
  }

  // A previous run's attest for this same batch may still be in flight (its receipt wait ran out, not the tx).
  // Proving it again would buy a second proof for a tx that is about to land, so wait on the first one.
  try {
    const sub = (await reflectionAttestState()).submitted;
    if (sub && sub.txHash && newDigest && String(sub.newDigest).toLowerCase() === String(newDigest).toLowerCase()) {
      const st = await txStatus(sub.txHash);
      if (st.state === 'pending') {
        log(`attest ${sub.txHash} for this batch was submitted earlier and is still pending — waiting on it instead of re-proving`);
        return await settleSubmitted({ txHash: sub.txHash, newDigest, attestedTo });
      }
      log(`earlier attest ${sub.txHash} is ${st.state} and the digest has not moved — proving again`);
    }
  } catch (e) { log(`submitted-attest lookup unavailable (${e.message}) — proceeding`); }

  // MATURITY GUARD. The pool only accepts a batch whose tip is at or below the header relay's tip walked back
  // REFLECTION_CONFIRMATIONS. A batch above that reverts UnanchoredReflection deterministically, and the proof
  // is bought before the submit, so within `confirmations` blocks of the tip every cycle would burn a proof on
  // a revert. Wait for the relay to mature the batch instead — this is decided before any spend.
  try {
    const relayTip = Number(await publicClient.readContract({ address: HEADER_RELAY, abi: RELAY_ABI, functionName: 'tipHeight' }));
    if (relayTip > 0 && !isMatured(attestedTo, relayTip, CFG.reflectionConfirmations)) {
      log(`batch tip ${attestedTo} is not yet matured (relay tip ${relayTip}, needs ${attestedTo + CFG.reflectionConfirmations}) — waiting`);
      await heartbeat('reflection', `waiting for relay tip ${attestedTo + CFG.reflectionConfirmations} (now ${relayTip})`);
      return false;
    }
  } catch (e) { log(`maturity check unavailable (${e.message}) — proceeding`); }

  // Spend guard (opt-in): decided BEFORE a proof is bought, so waiting for cheaper gas wastes nothing.
  const dear = await gasAboveCap();
  if (dear) {
    log(`gas ${dear.toFixed(3)} gwei is above MAX_GAS_GWEI=${CFG.maxGasGwei} — waiting`);
    await heartbeat('reflection', `waiting for gas <= ${CFG.maxGasGwei} gwei (now ${dear.toFixed(3)})`);
    return false;
  }
  log(`job attestedTo=${attestedTo} pending=${job.pending ?? '?'} — proving (network groth16)...`);
  await heartbeat('reflection', `proving ${newDigest}`);
  const { publicValues, proofBytes } = await proveReflection(job.input);

  log('proved — submitting attestBitcoinStateProven...');
  // A bare estimate leaves no headroom if state moves between estimating and inclusion, and a revert here costs the
  // whole proof. Unused gas is refunded, so the pad only insures.
  const attestCall = { address: POOL, abi: POOL_ABI, functionName: 'attestBitcoinStateProven', args: [publicValues, proofBytes] };
  const attestGas = await publicClient.estimateContractGas({ ...attestCall, account: relayWallet.account });
  // The proof above is already paid for. SETTLE_KEY is unset in production, so the settle service, the
  // header cron and this one all sign from RELAY_KEY — and settles go out privately, so a public RPC's
  // pending nonce does not see one in flight and a collision here is routine. A bare write throws the whole
  // proof away and re-proves next cycle; retrying the submission costs a few seconds.
  const txHash = await withNonceRetry('attest', () => relayWallet.writeContract({ ...attestCall, gas: (attestGas * 125n) / 100n }), { log });
  await reflectionSubmitted({ newDigest, txHash, attestedTo });
  return await settleSubmitted({ txHash, newDigest, attestedTo });
}

// Where a submitted attest tx stands, from the chain alone.
async function txStatus(hash) {
  try {
    const r = await publicClient.getTransactionReceipt({ hash });
    if (r.status !== 'success') return { state: 'reverted' };
    return { state: 'mined', confirmations: Number((await publicClient.getBlockNumber()) - r.blockNumber) + 1 };
  } catch { /* no receipt yet */ }
  try { await publicClient.getTransaction({ hash }); return { state: 'pending' }; }
  catch { return { state: 'missing' }; }
}

// Wait for a submitted attest to land, then ack it. Confirmations, not just inclusion: the ack advances the worker's
// canonical cursor and there is no recovery from the cursor being ahead of the chain (see the drift guard above), so
// acking on a one-block receipt strands it permanently the first time that block is reorged.
//
// The wait polls the pool's digest instead of blocking on one receipt call, because a receipt wait that times out
// tells us nothing about the tx: it can still land minutes later. Running out of time here is therefore not an error —
// the tx is left alone and the next run finds it through the recorded submission.
async function settleSubmitted({ txHash, newDigest, attestedTo }) {
  const res = await awaitAttestLanding({
    newDigest, txHash, readDigest: () => readReflectionDigest(), txStatus, deepEnough: () => landedDeep(newDigest),
    windowSecs: CFG.reflectionAttestWaitSecs, pollSecs: CFG.reflectionAttestPollSecs, confirmations: ATTEST_CONFIRMATIONS,
  });
  if (res.outcome === 'timeout') {
    log(`attest ${txHash} is still not landed after ${CFG.reflectionAttestWaitSecs}s — leaving it; the next run waits on it rather than re-proving`);
    await heartbeat('reflection', `attest ${txHash} pending past ${CFG.reflectionAttestWaitSecs}s`);
    return false;
  }
  if (res.outcome === 'reverted') {
    // A revert here is almost always "already attested" (digest-chain), which the poll would have seen as landed.
    log(`attest tx reverted (${txHash}) — will retry job next cycle`);
    return false;
  }
  if (res.outcome === 'dropped') {
    log(`attest ${txHash} was dropped from the mempool without landing — will retry job next cycle`);
    return false;
  }

  // A confirmed receipt from publicClient is not yet grounds to ack. publicClient sticks with the FIRST
  // endpoint that answers (viem's fallback() has no reason to move on if RPC_URL keeps returning success),
  // so RPC_URL both submitted this tx and, alone, decided it landed. Ack is unrewindable, so before trusting it, ask an endpoint that had no part in the
  // submission whether the STATE actually changed — not just whether a receipt exists.
  if (!(await confirmDigestOn(verifyClient, newDigest))) {
    log(`WARNING: ${txHash} has ${ATTEST_CONFIRMATIONS} confirmations on the primary RPC, but an independent `
      + `endpoint does not see digest ${newDigest} on-chain — NOT acking (refusing to trust a single endpoint's `
      + `receipt for an unrewindable cursor advance). Will retry next cycle.`);
    await heartbeat('reflection', `unverified attest ${txHash} — primary RPC disagrees with independent read`);
    return false;
  }

  log(`attested: tx=${txHash} attestedTo=${attestedTo}`);
  await reflectionAck({ attestedTo, txHash, jobId: newDigest });
  await heartbeat('reflection', `attested ${newDigest}`);
  return true;
}

// The digest still holds ATTEST_CONFIRMATIONS blocks behind the head, on the primary endpoint.
const landedDeep = (expected) => digestDeepEnough({
  readDigestAt: (blockNumber) => readReflectionDigest(publicClient, blockNumber),
  getBlockNumber: () => publicClient.getBlockNumber(), confirmations: ATTEST_CONFIRMATIONS, expected,
});

// Poll a SEPARATE client for the digest actually landing, tolerating ordinary propagation lag (a real tx
// can legitimately reach one node before another) rather than distinguishing that from a false receipt on
// the first try. Five tries over ~40s is generous next to the ATTEST_CONFIRMATIONS wait already paid above.
async function confirmDigestOn(client, expected, tries = 5, delayMs = 8000) {
  for (let i = 0; i < tries; i++) {
    try {
      const d = await readReflectionDigest(client);
      if (d && String(d).toLowerCase() === String(expected).toLowerCase()) return true;
    } catch { /* endpoint hiccup — retry */ }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function main() {
  log(`starting — worker=${CFG.workerBase} network=${CFG.network} pool=${POOL} poll=${CFG.reflectionPollSecs}s`);
  // Fail loud if the network prover isn't configured (no silent local-GPU fallback).
  if (CFG.sp1Prover === 'network' && !CFG.networkPrivateKey) {
    throw new Error('SP1_PROVER=network but NETWORK_PRIVATE_KEY unset — cannot prove');
  }
  // Cron mode: drain any pending batches (usually 0–1, since a 5-min cron keeps pace with
  // Bitcoin's ~10-min blocks) then exit. Bounded by cronMaxCycles + cronBudgetSecs.
  if (CFG.runMode === 'cron') {
    const t0 = Date.now();
    for (let i = 0; i < CFG.cronMaxCycles; i++) {
      if ((Date.now() - t0) / 1000 > CFG.cronBudgetSecs) { log('cron budget reached — exiting'); break; }
      let worked;
      try { worked = await cycle(); }
      catch (e) { log('cycle error — exiting cron run:', e.message); await heartbeat('reflection', `error ${safeErr(e)}`); break; }
      if (!worked) { log('caught up — cron run done'); await heartbeat('reflection', 'caught up'); break; }
    }
    return;
  }
  for (;;) {
    try {
      const worked = await cycle();
      // "Caught up" is the steady state between Bitcoin blocks, not a fault — but a caught-up loop never
      // calls heartbeat() itself, so without this /prover-health goes stale (and "down") every time the
      // chain is quiet for 10+ minutes on an otherwise-healthy reflector.
      if (!worked) { await heartbeatIdle('reflection', 'caught up'); await sleep(CFG.reflectionPollSecs); } // idle or retry backoff
    } catch (e) {
      log('cycle error (continuing):', e.message);
      await heartbeat('reflection', `error ${safeErr(e)}`);
      await sleep(CFG.reflectionPollSecs);
    }
  }
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
