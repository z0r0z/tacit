// ─────────────────────────────────────────────────────────────────────────────
// Eth-state sidecar — the Mode-B "fuel" producer. Runs eth_prove and POSTs the resulting eth_set
// candidate before every Mode-B Bitcoin batch.
//
// WHY THE TRIGGER IS "IS A PENDING CANDIDATE LIVE", NOT "HAS crossOutCount CHANGED":
// Once a pool's crossOutCount has advanced past 0, EVERY future Bitcoin-side reflection attest must be
// Mode-B forever (ReflectionLib.sol:148-153 — a forward mode_b=0 batch's committed crossOutCount is the
// permanent 0 sentinel, which can never again equal the pool's live crossOutCount). Worse: the eth-side
// digest chains too — reflect.rs:524-533/548 sets `state.eth_refl_digest = eth_pv.newDigest`
// UNCONDITIONALLY on every landed mode_b=1 cycle, and the NEXT cycle's eth proof must chain its own
// `priorDigest` from that exact value (`expected_prior`), even if nothing new happened on the Ethereum
// side. So a "confirmed" eth-state candidate is single-use:
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
// per Bitcoin-side attest — the protocol's own minimum, not a guessed interval — which keeps a routine
// crossout/consume from piling up into a multi-block backlog. attestedCrossOutCount()/attestedBitcoinConsumedCount()
// are read every cycle purely for logging/heartbeat context (did this candidate actually pick up
// anything new), never as the gate.
//
// eth_prove keeps its own cumulative resume state on disk (out_dir()/eth_set_state.json, committed; plus
// a not-yet-committed eth_set_state.pending.json — see prover.js's proveEthState/commitEthProveState
// header comments). This process tracks ONE additional local file (see LOCAL_INFLIGHT_PATH below) across
// restarts so a crash between "eth_prove produced a candidate" and "the worker confirmed it landed"
// resolves safely instead of either double-publishing or silently losing track.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, rm, mkdir, readdir, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import { keccak256 } from 'viem';
import { CFG } from './lib/config.js';
import { reflectionEthState, reflectionEthStatePublish, reflectionEthStateClear, heartbeat, heartbeatIdle } from './lib/worker-client.js';
import { proveEthState, commitEthProveState } from './lib/prover.js';
import { readPool, readPoolCounts } from './lib/chain.js';
import { safeErr } from './lib/safe-err.js';
import { resumeMismatch, rebuildFromConfirmed } from './lib/eth-state-resume.js';
import { finalizedHead, finalityNotAdvanced } from './lib/beacon-finality.js';
import { countsBehind, pvCounts } from './lib/attest-counts.js';
import { noteFoldedCounts } from './lib/attest-demand.js';
import { inflightRecord, inflightCounts, makeCoverWait } from './lib/eth-state-counts.js';

const log = (...a) => console.log(`[eth-state ${new Date().toISOString()}]`, ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Records the candidate this process itself last produced and published, so a restart between "POSTed
// it" and "confirmed it landed" doesn't lose track (and doesn't double-produce while it's still live).
// Losing this file (ephemeral disk, or first run) is always safe — the worst case is one redundant
// eth_prove run that gets a 409 (see below), never a double-publish or a skipped commit.
const LOCAL_INFLIGHT_PATH = path.join(CFG.ethProveOutDir, 'sidecar-inflight.json');

// Every candidate's resume state, kept by content hash and block: eth_prove overwrites its pending file on the
// next run, so a candidate this process gave up on (stale, superseded, or a restart) that the Bitcoin side folds
// anyway can still be committed exactly. A few are kept; only the folded one is ever used.
const ARCHIVE_DIR = path.join(CFG.ethProveOutDir, 'candidates');
const ARCHIVE_KEEP = 16;
const archivePath = (contentHash, lastBlock) => path.join(ARCHIVE_DIR, `${String(contentHash).toLowerCase().replace(/^0x/, '')}-${Number(lastBlock)}.json`);
async function archiveCandidate(contentHash, lastBlock) {
  await mkdir(ARCHIVE_DIR, { recursive: true });
  await writeFile(archivePath(contentHash, lastBlock), await readFile(path.join(CFG.ethProveOutDir, 'eth_set_state.pending.json')));
  const files = await readdir(ARCHIVE_DIR);
  if (files.length <= ARCHIVE_KEEP) return;
  const aged = await Promise.all(files.map(async (f) => ({ f, t: (await stat(path.join(ARCHIVE_DIR, f))).mtimeMs })));
  aged.sort((a, b) => a.t - b.t);
  await Promise.all(aged.slice(0, aged.length - ARCHIVE_KEEP).map((x) => rm(path.join(ARCHIVE_DIR, x.f), { force: true })));
}
// The committed file the folded candidate stands for: its archived state, else one rebuilt from it when it adds
// nothing to the committed records (see rebuildFromConfirmed). Written only when it then passes resumeMismatch.
async function healResume(committed, confirmed) {
  let next = null, how = null;
  try { next = JSON.parse(await readFile(archivePath(confirmed.contentHash, confirmed.lastBlock), 'utf8')); how = 'its archived state'; }
  catch (e) { if (e.code !== 'ENOENT') log('archived candidate unreadable:', e.message); }
  if (!next || resumeMismatch({ committed: next, confirmed })) { next = rebuildFromConfirmed({ committed, confirmed }); how = 'the committed records, through its block'; }
  if (!next || resumeMismatch({ committed: next, confirmed })) return null;
  const file = path.join(CFG.ethProveOutDir, 'eth_set_state.json');
  await writeFile(`${file}.heal`, JSON.stringify(next));
  await rename(`${file}.heal`, file);
  await rm(LOCAL_INFLIGHT_PATH, { force: true });
  log(`resume state realigned to the folded candidate ${confirmed.contentHash} (block ${confirmed.lastBlock}) from ${how}`);
  return next;
}

// Stall watchdog: a fresh candidate is deterministic from (pool, prior_set_root/count, prior_consumed_root/
// count, prior_msg_root/count) — none of which include last_block — so an eth_prove run that keeps landing
// on an unchanged crossOutCount/consumedCount reproduces the EXACT SAME contentHash every time, even though
// last_block (and the surrounding scan window) keeps moving forward with real time. That is indistinguishable
// from routine idleness UNTIL it also means the pending candidate's priorDigest no longer chains against
// on-chain reality (e.g. a fold landed through some other, out-of-band path this sidecar's local resume state
// never learned about). Every affected cycle "succeeds" individually
// (job assembles fine; only the on-chain attest ever reverts, which this sidecar never sees), so nothing about
// a single cycle's own log line reveals the stall — only the SAME contentHash reappearing cycle after cycle
// does. Track that here and escalate once it crosses a threshold.
const STALL_WATCH_PATH = path.join(CFG.ethProveOutDir, 'sidecar-stall-watch.json');
const STALL_ALERT_THRESHOLD = 6; // ~consecutive publish cycles on the same contentHash before escalating
async function checkStall(contentHash) {
  let prev = null;
  try { prev = JSON.parse(await readFile(STALL_WATCH_PATH, 'utf8')); } catch { /* first run */ }
  const repeatCount = (prev && prev.contentHash === contentHash) ? prev.repeatCount + 1 : 1;
  await writeFile(STALL_WATCH_PATH, JSON.stringify({ contentHash, repeatCount }));
  if (repeatCount === STALL_ALERT_THRESHOLD || (repeatCount > STALL_ALERT_THRESHOLD && repeatCount % STALL_ALERT_THRESHOLD === 0)) {
    const msg = `STALL: contentHash ${contentHash} unchanged across ${repeatCount} consecutive publish cycles — `
      + 'resume state likely desynced from on-chain reality (see project_reflection_catchup_header_relay_pacing_2026_09_15)';
    log(msg);
    await heartbeat('eth-state', msg);
  }
}

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
const coverWait = makeCoverWait({ boundMs: CFG.ethStateFinalityCoverSecs * 1000 });

// One cycle: resolve any local in-flight candidate against the server's view of the world, then produce
// a fresh one iff nothing is live. Returns true if it did real work (an eth_prove run), false if idle.
async function cycle() {
  await mkdir(CFG.ethProveOutDir, { recursive: true });
  const state = await reflectionEthState(); // { confirmed, pending }
  // An API that cannot answer says nothing about the candidates: the in-flight one is kept and nothing is proved until it can.
  if (state.unavailable) {
    log(`the API could not say what is pending (HTTP ${state.unavailable}) — asking again next cycle`);
    return false;
  }
  // What the last landed batch carried to Bitcoin: the attest gate goes at once while the pool has moved past it.
  noteFoldedCounts(state.confirmed?.ethPv ? pvCounts(state.confirmed.ethPv) : null);
  let pendingLive = !!(state.pending && !isStale(state.pending.publishedAt));

  const local = await readLocalInflight();
  if (local) {
    if (state.confirmed && state.confirmed.contentHash === local.contentHash) {
      log(`local candidate ${local.contentHash} confirmed landed on-chain — committing resume state`);
      if (!CFG.ethStateDryRun) await commitEthProveState();
      await rm(LOCAL_INFLIGHT_PATH, { force: true });
    } else if (state.pending && state.pending.contentHash === local.contentHash && !isStale(state.pending.publishedAt)) {
      // A candidate the pool has moved past can never be folded, so it is replaced now rather than held to the staleness ceiling.
      const behind = countsBehind(inflightCounts(local), await readPoolCounts());
      if (!behind) {
        log(`local candidate ${local.contentHash} still pending confirmation — waiting`);
        return false;
      }
      if (CFG.ethStateDryRun) {
        log(`DRY_RUN=1 — local candidate ${local.contentHash} carries ${behind}; would clear it and produce a fresh one`);
        return false;
      }
      const cleared = await reflectionEthStateClear();
      if (!cleared.ok) {
        log(`local candidate ${local.contentHash} carries ${behind}, and the API would not clear it (HTTP ${cleared.status}) — waiting`);
        return false;
      }
      log(`local candidate ${local.contentHash} carries ${behind}: no batch built on it can land — cleared it, producing a fresh one`);
      await heartbeat('eth-state', `cleared a candidate behind the pool (${behind})`);
      await rm(LOCAL_INFLIGHT_PATH, { force: true });
      pendingLive = false;
    } else if (state.pending && state.pending.contentHash === local.contentHash) {
      // Our own candidate is still the server's official pending slot, but it's aged past
      // ETH_STATE_PENDING_STALE_SECS — whatever was supposed to confirm it (a Bitcoin-side attest) isn't
      // coming. Matching contentHash short-circuited past the pendingLive staleness check below on every
      // prior cycle, which is also why checkStall() (below) never got a chance to see or escalate this —
      // both exist specifically for this case but neither fires while this branch returns early. Discard
      // and fall through: the POST below is guaranteed not to 409 against this same stale entry.
      log(`local candidate ${local.contentHash} is the live server pending but stale (published `
        + `${new Date(state.pending.publishedAt).toISOString()}) — discarding and producing a fresh one`);
      await rm(LOCAL_INFLIGHT_PATH, { force: true });
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

  // Resume-state gate. eth_prove builds the next candidate's prior from its committed file
  // (out_dir()/eth_set_state.json), which advances only via commitEthProveState() once this process sees its own
  // candidate confirmed (LOCAL_INFLIGHT_PATH above). A restart in that window skips the commit, a replaced disk or a
  // reset loses the file, and either way every later candidate proves and publishes normally while each Bitcoin-side
  // batch built from it panics on reflect.rs's digest-chain assert, which the network reports only as an
  // unexecutable request. So compare the file with the candidate the Bitcoin side actually folded.
  let committed = null;
  try {
    committed = JSON.parse(await readFile(path.join(CFG.ethProveOutDir, 'eth_set_state.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // no committed file: eth_prove would start from zero
  }
  let mismatch = resumeMismatch({ committed, confirmed: state.confirmed });
  if (mismatch && !CFG.ethStateDryRun && await healResume(committed, state.confirmed)) mismatch = null;
  if (mismatch) {
    const msg = `STALE RESUME STATE: ${mismatch}. A candidate built from here would not continue the Bitcoin `
      + "guest's digest chain, so none is built until the committed file is rebuilt from the confirmed candidate "
      + '(ops/runbooks/eth-state-recovery.md).';
    log(msg);
    await heartbeat('eth-state', msg);
    throw new Error(msg);
  }

  if (CFG.ethStateDryRun) {
    log('DRY_RUN=1 — stopping here (would run eth_prove + POST /reflection/eth-state now)');
    return false;
  }
  if (!CFG.sourceConsensusRpc || !CFG.sourceExecutionRpc || !CFG.ethCallOutbox || !CFG.ethProveGenesisSlot) {
    throw new Error('SOURCE_CONSENSUS_RPC/SOURCE_EXECUTION_RPC/ETH_CALL_OUTBOX/GENESIS_SLOT must all be set '
      + '(pinned per deployment); refusing to guess them');
  }

  // The guest refuses a candidate whose finalized head has not moved past the last one's, and this stage starts the moment an
  // attest lands, often before finality has moved (every ~6.4 min). The network would refuse the request as unexecutable and the
  // retry would wait two minutes, so ask the beacon node and wait for the head. A reading that fails is not a reason to wait.
  let head = null;
  try { head = await finalizedHead(CFG.sourceConsensusRpc); } catch (e) { log(`finality check unavailable (${e.message}) — proceeding`); }
  const notAdvanced = head && finalityNotAdvanced({ committed, slot: head.slot });
  if (notAdvanced) {
    log(`${notAdvanced} — waiting for finality to move before asking the network to prove`);
    await heartbeat('eth-state', 'waiting for Ethereum finality to move');
    return false;
  }
  // A candidate proves the pool at the finalized head, so cross-outs and consumes recorded after it would leave the candidate behind
  // the pool on arrival: wait for finality to cover them, for at most ETH_STATE_FINALITY_COVER_SECS.
  if (head) {
    const atHead = await readPoolCounts(head.block ? { blockNumber: BigInt(head.block) } : { blockTag: 'finalized' });
    const uncovered = countsBehind(atHead, await readPoolCounts());
    if (coverWait(uncovered)) {
      log(`the finalized head (block ${head.block ?? '?'}) holds ${uncovered} — waiting for finality to cover them before asking the network to prove`);
      await heartbeat('eth-state', 'waiting for finality to cover the pool\'s latest cross-outs');
      return false;
    }
  }

  // Free local dry-run first: catches a bad witness or a
  // digest-chain mismatch via a low, early-panic cycle count before spending a real network prove on it.
  let pre = null;
  if (CFG.ethStatePreflight) try {
    await heartbeat('eth-state', 'execute preflight');
    pre = await proveEthState({ mode: 'execute', timeoutMs: CFG.ethProveTimeoutSecs * 1000 });
  } catch (e) {
    // SP1's local CPU execute() for this guest is unreliable on this host's container — its spawned child
    // process has been observed to die multiple distinct ways (a stdin pipe closing early with "Broken
    // pipe"; a native-executor crash with SIGBUS) that are all local-executor infra failures, not witness
    // panics: a genuine witness/logic panic is silently swallowed by SP1's local executor and surfaces as
    // a low pv_bytes on a SUCCESSFUL execute() call (checked below), never as a thrown error. So any error
    // thrown by execute() itself — regardless of its specific message — is categorically an infra failure
    // here, not evidence of a bad witness; skip the preflight rather than let it block every real network
    // prove behind a check that can never actually run to completion on this host.
    log(`execute preflight failed on this host's local executor (${e.message}) — skipping preflight, proceeding to network prove`);
    pre = null;
  }
  if (pre) {
    log(`execute preflight: cycles=${pre.cycles} pv_bytes=${pre.pvBytes}`);
    if (pre.pvBytes < 11 * 32) {
      throw new Error(`execute preflight produced pv_bytes=${pre.pvBytes} (< 352B fast-lane minimum) — `
        + 'guest likely panicked early (digest-chain mismatch or bad witness); refusing to spend a network proof');
    }
  }

  await heartbeat('eth-state', 'proving (network)');
  const result = await proveEthState({ mode: 'network', timeoutMs: CFG.ethProveTimeoutSecs * 1000 });
  const contentHash = ethStateContentHash(result.ethPv);
  log(`proved — ${result.crossouts.length} cumulative crossout(s), ${result.consumeds.length} cumulative `
    + `consumed, execBlock=${result.execBlock}, contentHash=${contentHash}, on the ${result.lane || 'network'}${result.worker ? ` (${result.worker})` : ''}`);
  await checkStall(contentHash);
  await archiveCandidate(contentHash, result.lastBlock).catch((e) => log('could not archive candidate state:', e.message));

  // Persist the in-flight marker BEFORE publishing: if the process dies between the POST landing and this
  // write, the worst case is one extra harmless GET-confirms-it-anyway cycle on restart (the content hash
  // is deterministic from ethPv, recoverable by re-deriving it from the just-written local pending state
  // file) — but persisting AFTER the POST risks publishing successfully and then losing all record of it.
  await writeFile(LOCAL_INFLIGHT_PATH, JSON.stringify(inflightRecord({ contentHash, ethPv: result.ethPv })));

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
  await writeFile(LOCAL_INFLIGHT_PATH, JSON.stringify(inflightRecord({ contentHash: pub.body.contentHash, publishedAt: pub.body.publishedAt, ethPv: result.ethPv })));
  log(`published contentHash=${pub.body.contentHash}`);
  await heartbeat('eth-state', `published ${pub.body.contentHash}`);
  return true;
}

// One-time reset for a move to a successor deployment: ETH_PROVE_STATE_PATH lives on this service's OWN
// persistent disk, keyed by nothing deployment-specific, so a pool migration leaves the predecessor's
// cumulative crossouts/consumeds committed here with no natural way to age out (unlike
// the pending/confirmed KV records, which have their own /reflection/eth-state/clear and .../confirmed/clear
// resets). eth_prove.rs already treats a missing/unparseable state file as EthSetState::default() (all
// zero) on its own (see its state_path() load), so deleting this file is the whole reset. Gated on an env
// var so this never fires by accident against a deployment with still-pending-confirmation local state.
async function resetLocalStateIfRequested() {
  if (process.env.RESET_ETH_PROVE_STATE !== '1') return;
  // Safe only on a pool that has never landed a Mode-B batch. Past that, the documented recovery pairs
  // this with clearing the worker's `confirmed` record — and with `confirmed` gone the resume guard reads
  // a cold start, opens, and the sidecar publishes candidates whose batches all panic. The runbook says
  // so in prose; the pool can say so in code, and it is the one source that cannot be misread.
  const landed = await readPool('attestedCrossOutCount').catch(() => null);
  if (landed != null && BigInt(landed) > 0n) {
    log(`RESET_ETH_PROVE_STATE=1 IGNORED: the pool has attested ${landed} cross-out(s), so Mode-B history exists. `
      + 'Resetting here is only safe before the first Mode-B batch lands; see ops/runbooks/eth-state-recovery.md.');
    return;
  }
  const committed = path.join(CFG.ethProveOutDir, 'eth_set_state.json');
  await Promise.all([
    rm(committed, { force: true }),
    rm(path.join(CFG.ethProveOutDir, 'eth_set_state.pending.json'), { force: true }),
    rm(LOCAL_INFLIGHT_PATH, { force: true }),
    rm(STALL_WATCH_PATH, { force: true }),
  ]);
  log(`RESET_ETH_PROVE_STATE=1 — deleted ${committed} and local sidecar bookkeeping; `
    + 'next cycle bootstraps eth_prove from zero (crossouts=[], consumeds=[], last_block=0)');
}

async function main() {
  await resetLocalStateIfRequested();
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
      catch (e) { log('cycle error — exiting cron run:', e.message); await heartbeat('eth-state', `error ${safeErr(e)}`); break; }
      if (!worked) { log('idle — cron run done'); await heartbeat('eth-state', 'idle'); break; }
    }
    return;
  }
  // Back off on CONSECUTIVE failures. A cycle spends a real network proof before it publishes, so a failure
  // mode where publishing keeps failing (control plane down, a persistent 4xx) but proving keeps succeeding
  // bills a fresh proof on every pass — at a 60s poll that is ~60 paid proofs per hour of outage, for
  // nothing. Backing off bounds the cost of a bad hour without slowing the healthy path at all: one success
  // resets it immediately, and the ceiling still retries often enough to recover unattended.
  const BACKOFF_CAP_SECS = 30 * 60;
  let consecutiveFailures = 0;
  for (;;) {
    let failed = false;
    try {
      const worked = await cycle();
      // cycle() returns false on every "nothing to do yet" branch (candidate still pending, dry-run stop,
      // etc). Those are the normal steady state here, not errors — but /prover-health only sees a live
      // heartbeat() call on real work, so idle stretches need their own throttled beat or the endpoint
      // goes stale after 10 quiet minutes on a perfectly healthy sidecar.
      if (!worked) await heartbeatIdle('eth-state', 'idle — no candidate to produce yet');
    } catch (e) {
      failed = true;
      log('cycle error (continuing):', e.message);
      await heartbeat('eth-state', `error ${safeErr(e)}`);
    }
    consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
    const delay = failed
      ? Math.min(BACKOFF_CAP_SECS, CFG.ethStatePollSecs * 2 ** Math.min(consecutiveFailures - 1, 20))
      : CFG.ethStatePollSecs;
    if (failed) log(`  ${consecutiveFailures} consecutive failure(s) — next attempt in ${delay}s`);
    await sleep(delay);
  }
}

// The Bitcoin lane worker (src/bitcoin-lane.js) runs this cycle beside the reflection folder and the header feeder, in turn; on its own
// this file is the sidecar service as before.
export { cycle as ethStateCycle, resetLocalStateIfRequested as ethStateReset };
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('fatal', e); process.exit(1); });
}
