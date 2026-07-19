// ─────────────────────────────────────────────────────────────────────────────
// Reflection folder — the always-on incremental Bitcoin-state attester.
//
// Render service type: Background Worker (long-running). This is the piece that
// keeps reflection INCREMENTAL (1-2 blocks per cycle) so the 176-block liveness
// trap never recurs: every cycle folds only the small gap since the last attested
// height, proves it on the Succinct NETWORK prover, and attests it on-chain.
//
// Cycle (mirrors ops/scripts/reflection-relay-loop.sh, GPU swapped for network):
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
// retry — the same job re-serves and completes (idempotency proven).
// ─────────────────────────────────────────────────────────────────────────────

import { CFG } from './lib/config.js';
import { reflectionJob, reflectionAck, heartbeat } from './lib/worker-client.js';
import { proveReflection } from './lib/prover.js';
import { relayWallet, publicClient, readPool, readReflectionDigest, POOL, POOL_ABI } from './lib/chain.js';

const log = (...a) => console.log(`[reflection ${new Date().toISOString()}]`, ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

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

  log(`job attestedTo=${attestedTo} pending=${job.pending ?? '?'} — proving (network groth16)...`);
  await heartbeat('reflection', `proving ${newDigest}`);
  const { publicValues, proofBytes } = await proveReflection(job.input);

  log('proved — submitting attestBitcoinStateProven...');
  const txHash = await relayWallet.writeContract({
    address: POOL, abi: POOL_ABI, functionName: 'attestBitcoinStateProven',
    args: [publicValues, proofBytes],
  });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (rcpt.status !== 'success') {
    // A revert here is almost always "already attested" (digest-chain) — re-read and re-ack.
    const now = await readReflectionDigest();
    if (now && newDigest && now.toLowerCase() === String(newDigest).toLowerCase()) {
      log('attest reverted but digest matches on-chain — re-acking');
      await reflectionAck({ attestedTo, txHash, jobId: newDigest });
      return true;
    }
    log(`attest tx reverted (${txHash}) — will retry job next cycle`);
    return false;
  }

  log(`attested: tx=${txHash} attestedTo=${attestedTo}`);
  await reflectionAck({ attestedTo, txHash, jobId: newDigest });
  await heartbeat('reflection', `attested ${newDigest}`);
  return true;
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
      catch (e) { log('cycle error — exiting cron run:', e.message); await heartbeat('reflection', `error ${e.message}`); break; }
      if (!worked) { log('caught up — cron run done'); break; }
    }
    return;
  }
  for (;;) {
    try {
      const worked = await cycle();
      if (!worked) await sleep(CFG.reflectionPollSecs); // idle or retry backoff
    } catch (e) {
      log('cycle error (continuing):', e.message);
      await heartbeat('reflection', `error ${e.message}`);
      await sleep(CFG.reflectionPollSecs);
    }
  }
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
