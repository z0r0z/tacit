// ─────────────────────────────────────────────────────────────────────────────
// Eth-state sidecar — the Mode-B "fuel" producer. Replaces the by-hand recipe
// (scratchpad/MODEB-RECIPE.md §1) of manually running eth_prove on the RunPod box, hand-copying
// eth_set.json, and hand-POSTing it before every Mode-B Bitcoin batch.
//
// WHY THE TRIGGER IS "IS A PENDING CANDIDATE LIVE", NOT "HAS crossOutCount CHANGED":
// Once a pool's crossOutCount has advanced past 0, EVERY future Bitcoin-side reflection attest must be
// Mode-B forever (ReflectionLib.sol:148-153 — a forward mode_b=0 batch's committed crossOutCount is the
// permanent 0 sentinel, which can never again equal the pool's live crossOutCount). Worse: the eth-side
// digest chains too — reflect.rs:524-533/548 sets `state.eth_refl_digest = eth_pv.newDigest`
// UNCONDITIONALLY on every landed mode_b=1 cycle, and the NEXT cycle's eth proof must chain its own
// `priorDigest` from that exact value (`expected_prior`), even if nothing new happened on the Ethereum
// side (scratchpad/MODEB-RECIPE.md's "an eth_prove proof is SINGLE-USE" section — confirmed against the
// guest source, not just the recipe's own telling). So a "confirmed" eth-state candidate is single-use:
// the moment the Bitcoin batch built from it lands, that exact candidate can never be reused, and the
// VERY NEXT Bitcoin attest (whether or not it folds a new crossout) needs a freshly-chained one or it
// reverts. The worker already encodes this correctly: `ethBundleSource` (worker/src/index.js) feeds the
// PENDING candidate into every job-assemble call, and `handleReflectionAck` promotes pending -> confirmed
// (freeing the pending slot) only once that job's batch actually lands.
//
// That makes "is a pending candidate currently live" the exact right, minimal trigger: as long as one is
// live, the next Bitcoin attest (whenever it happens) is fueled and this sidecar has nothing to do; the
// instant it gets consumed-and-promoted (or never existed), Bitcoin-side reflection is stalled until a
// fresh one appears, so produce one immediately. This self-paces to almost exactly one real eth_prove run
// per Bitcoin-side attest generation — the protocol's own minimum, not a guessed interval — which is what
// keeps a routine crossout/consume from ever again piling up into the multi-block, tens-of-billions-of-
// cycles backlog this sidecar exists to prevent. attestedCrossOutCount()/attestedBitcoinConsumedCount()
// are read every cycle purely for logging/heartbeat context (did this candidate actually pick up
// anything new), never as the gate.
//
// eth_prove keeps its own cumulative resume state on disk (out_dir()/eth_set_state.json, committed; plus
// a not-yet-committed eth_set_state.pending.json — see prover.js's proveEthState/commitEthProveState
// header comments). This process tracks ONE additional local file (see LOCAL_INFLIGHT_PATH below) across
// restarts so a crash between "eth_prove produced a candidate" and "the worker confirmed it landed"
// resolves safely instead of either double-publishing or silently losing track.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { keccak256 } from 'viem';
import { CFG } from './lib/config.js';
import { reflectionEthState, reflectionEthStatePublish, heartbeat } from './lib/worker-client.js';
import { proveEthState, commitEthProveState } from './lib/prover.js';
import { readPool } from './lib/chain.js';

const log = (...a) => console.log(`[eth-state ${new Date().toISOString()}]`, ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Records the candidate this process itself last produced and published, so a restart between "POSTed
// it" and "confirmed it landed" doesn't lose track (and doesn't double-produce while it's still live).
// Losing this file (ephemeral disk, or first run) is always safe — the worst case is one redundant
// eth_prove run that gets a 409 (see below), never a double-publish or a skipped commit.
const LOCAL_INFLIGHT_PATH = path.join(CFG.ethProveOutDir, 'sidecar-inflight.json');

function ethStateContentHash(ethPv) {
  return keccak256(ethPv.startsWith('0x') ? ethPv : `0x${ethPv}`);
}
function isStale(publishedAt) {
  if (!Number.isFinite(publishedAt)) return true;
  return (Date.now() - publishedAt) > (CFG.ethStatePendingStaleSecs * 1000);
}
async function readLocalInflight() {
  try { return JSON.parse(await readFile(LOCAL_INFLIGHT_PATH, 'utf8')); } catch { return null; }
}

// One cycle: resolve any local in-flight candidate against the server's view of the world, then produce
// a fresh one iff nothing is live. Returns true if it did real work (an eth_prove run), false if idle.
async function cycle() {
  await mkdir(CFG.ethProveOutDir, { recursive: true });
  const state = await reflectionEthState(); // { confirmed, pending }
  const pendingLive = !!(state.pending && !isStale(state.pending.publishedAt));

  const local = await readLocalInflight();
  if (local) {
    if (state.confirmed && state.confirmed.contentHash === local.contentHash) {
      log(`local candidate ${local.contentHash} confirmed landed on-chain — committing resume state`);
      if (!CFG.ethStateDryRun) await commitEthProveState();
      await rm(LOCAL_INFLIGHT_PATH, { force: true });
    } else if (state.pending && state.pending.contentHash === local.contentHash) {
      log(`local candidate ${local.contentHash} still pending confirmation — waiting`);
      return false;
    } else {
      // Not confirmed, not the live pending: either it aged out server-side, or a fresher candidate (e.g.
      // this same sidecar's PREVIOUS incarnation, or manual /reflection/eth-state/clear) replaced it. Never
      // commit an abandoned candidate — the next fresh eth_prove run re-derives correctly from whatever
      // state_path() (committed) already holds, which this abandoned run never touched.
      log(`local candidate ${local.contentHash} is no longer live server-side (expired/superseded) — discarding`);
      await rm(LOCAL_INFLIGHT_PATH, { force: true });
    }
  }

  if (pendingLive) {
    log('a pending eth-state candidate is already live server-side — nothing to do');
    return false;
  }

  // Diagnostic context only (see header comment for why this isn't the trigger).
  let crossOutCount = null, consumedCount = null;
  try {
    [crossOutCount, consumedCount] = await Promise.all([
      readPool('attestedCrossOutCount'), readPool('attestedBitcoinConsumedCount'),
    ]);
  } catch (e) { log('view-call read failed (non-fatal, diagnostic only):', e.message); }
  const confirmedCounts = state.confirmed
    ? `confirmed had ${state.confirmed.crossouts?.length ?? '?'} crossout(s)/${state.confirmed.consumeds?.length ?? '?'} consumed`
    : 'no confirmed candidate yet (cold start)';
  log(`no live pending — producing a fresh candidate. on-chain crossOutCount=${crossOutCount} consumedCount=${consumedCount}; ${confirmedCounts}`);

  if (CFG.ethStateDryRun) {
    log('DRY_RUN=1 — stopping here (would run eth_prove + POST /reflection/eth-state now)');
    return false;
  }
  if (!CFG.sourceConsensusRpc || !CFG.sourceExecutionRpc || !CFG.ethCallOutbox || !CFG.ethProveGenesisSlot) {
    throw new Error('SOURCE_CONSENSUS_RPC/SOURCE_EXECUTION_RPC/ETH_CALL_OUTBOX/GENESIS_SLOT must all be set '
      + '(per-generation pinned constants — see scratchpad/MODEB-RECIPE.md §1); refusing to guess them');
  }

  // Free local dry-run first (scratchpad/MODEB-RECIPE.md's own operating rule): catches a bad witness or a
  // digest-chain mismatch via a low, early-panic cycle count before spending a real network prove on it.
  await heartbeat('eth-state', 'execute preflight');
  const pre = await proveEthState({ mode: 'execute' });
  log(`execute preflight: cycles=${pre.cycles} pv_bytes=${pre.pvBytes}`);
  if (pre.pvBytes < 11 * 32) {
    throw new Error(`execute preflight produced pv_bytes=${pre.pvBytes} (< 352B fast-lane minimum) — `
      + 'guest likely panicked early (digest-chain mismatch or bad witness); refusing to spend a network proof');
  }

  await heartbeat('eth-state', 'proving (network)');
  const result = await proveEthState({ mode: 'network' });
  const contentHash = ethStateContentHash(result.ethPv);
  log(`proved — ${result.crossouts.length} cumulative crossout(s), ${result.consumeds.length} cumulative `
    + `consumed, execBlock=${result.execBlock}, contentHash=${contentHash}`);

  // Persist the in-flight marker BEFORE publishing: if the process dies between the POST landing and this
  // write, the worst case is one extra harmless GET-confirms-it-anyway cycle on restart (the content hash
  // is deterministic from ethPv, recoverable by re-deriving it from the just-written local pending state
  // file) — but persisting AFTER the POST risks publishing successfully and then losing all record of it.
  await writeFile(LOCAL_INFLIGHT_PATH, JSON.stringify({ contentHash, publishedAt: null }));

  const pub = await reflectionEthStatePublish({
    ethPv: result.ethPv, crossouts: result.crossouts, consumeds: result.consumeds,
    ethCompressedProof: result.ethCompressedProofB64,
    lastBlock: result.lastBlock, execBlock: result.execBlock,
  });
  if (pub.status === 409) {
    // Lost a publish race (another producer's candidate is already live and not stale). Fine — that
    // candidate fuels the next attest just as well; discard ours unpublished (never commit its state).
    log(`lost the publish race (409: ${pub.body?.error || 'pending already live'}) — discarding this candidate`);
    await rm(LOCAL_INFLIGHT_PATH, { force: true });
    return true;
  }
  if (!pub.ok) {
    await rm(LOCAL_INFLIGHT_PATH, { force: true });
    throw new Error(`POST /reflection/eth-state failed (${pub.status}): ${pub.body?.error || 'unknown'}`);
  }
  await writeFile(LOCAL_INFLIGHT_PATH, JSON.stringify({ contentHash: pub.body.contentHash, publishedAt: pub.body.publishedAt }));
  log(`published contentHash=${pub.body.contentHash}`);
  await heartbeat('eth-state', `published ${pub.body.contentHash}`);
  return true;
}

async function main() {
  log(`starting — worker=${CFG.workerBase} network=${CFG.network} outDir=${CFG.ethProveOutDir} `
    + `poll=${CFG.ethStatePollSecs}s dryRun=${CFG.ethStateDryRun}`);
  if (!CFG.ethStateDryRun && CFG.sp1Prover === 'network' && !CFG.networkPrivateKey) {
    throw new Error('SP1_PROVER=network but NETWORK_PRIVATE_KEY unset — cannot prove');
  }
  if (CFG.runMode === 'cron') {
    const t0 = Date.now();
    for (let i = 0; i < CFG.cronMaxCycles; i++) {
      if ((Date.now() - t0) / 1000 > CFG.cronBudgetSecs) { log('cron budget reached — exiting'); break; }
      let worked;
      try { worked = await cycle(); }
      catch (e) { log('cycle error — exiting cron run:', e.message); await heartbeat('eth-state', `error ${e.message}`); break; }
      if (!worked) { log('idle — cron run done'); break; }
    }
    return;
  }
  for (;;) {
    try {
      await cycle();
    } catch (e) {
      log('cycle error (continuing):', e.message);
      await heartbeat('eth-state', `error ${e.message}`);
    }
    await sleep(CFG.ethStatePollSecs);
  }
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
