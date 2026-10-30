// ─────────────────────────────────────────────────────────────────────────────
// Balance + lag monitor — the pager.
//
// Render service type: Cron Job (e.g. every 5-10 min). Runs once and exits.
//
// Alerts (log always; POST to ALERT_WEBHOOK_URL if set) when:
//   * the prover network credit is low: under PROVE_CREDIT_WARN (warning) or PROVE_CREDIT_CRITICAL (critical) PROVE
//   * a wallet can no longer do its job (critical): the settle wallet cannot pay for the next settle, so relayed jobs
//     wait in the queue, or the relay wallet cannot keep an attest back and still send headers, so the Bitcoin headers
//     and attests stop; a settle wallet with under N days of runway, or any wallet under the buffer (warnings)
//   * reflection lag (relay tip - attested Bitcoin height) > N blocks
//   * the API's Bitcoin block scan trailing the chain tip (BTC_SCAN_LAG_WARN_BLOCKS / _CRITICAL_BLOCKS) — lib/scan-lag.js
//   * reflection snapshot size > warn threshold — the one cumulative resource
//   * reflection stalled: no successful attest for REFLECTION_STALL_HOURS with blocks waiting, or the API's cursor
//     off the pool's digest on two consecutive runs (a lost ack) — lib/reflection-stall.js
//   * launch-farm health (treasury solvency, epoch runway, idle pools, governor handover) — lib/farm-health.js;
//     FARM_MANAGER_ADDR overrides the manager, or set it to "off" to skip the check
//   * TAC on Ethereum against its backing (mainnet): the ERC-20 over the 21M etched or wTAC under one TAC per wTAC
//     (critical); a second pool registration over a canonical token, or a retired TAC token changing supply
//     (warning) — lib/tac-supply.js; TAC_SUPPLY_CHECK=off skips it
//
// The lag alert is the "reflection is falling behind" signal that catches a stalled
// reflection worker before the backlog grows into a batch too large to prove.
//
// A CRITICAL also makes the process EXIT NON-ZERO. ALERT_WEBHOOK_URL is optional; a failing exit code is
// the one channel that always exists, since Render marks the cron run failed without any configuration.
// ─────────────────────────────────────────────────────────────────────────────

import { formatEther, formatUnits } from 'viem';
import { CFG, OP_GAS } from './lib/config.js';
import { burnGasPerDay, runwayDays } from './lib/runway.js';
import { queueVerdict } from './lib/queue-health.js';
import { makeRpc, checkFarm, FARM_MANAGER_MAINNET } from './lib/farm-health.js';
import { stallVerdict, driftVerdict, awaitingBundleVerdict } from './lib/reflection-stall.js';
import { manualRecoveryHint } from './lib/reflection-reconcile.js';
import { reflectionDriftSeen, crossOutGapSeen } from './lib/worker-client.js';
import { creditLevel } from './lib/prove-credit.js';
import { blockSecOf, feedLagSec, feedLagLevel } from './lib/feed-lag.js';
import { settleFundsNeed, treasuryFloors } from './lib/settle-fees.js';
import { poolBooks } from './lib/evm-pool-solvency.js';
import { readTacSupply } from './lib/tac-supply.js';
import { scanLagVerdict } from './lib/scan-lag.js';
import { publicClient, relayWallet, watchedWallets, ERC20_ABI, PROVE, readPool, readReflectionDigest, HEADER_RELAY, RELAY_ABI, POOL } from './lib/chain.js';
import { safeErr } from './lib/safe-err.js';

const log = (...a) => console.log(`[monitor ${new Date().toISOString()}]`, ...a);

let criticals = 0;

async function alert(level, msg, extra = {}) {
  log(`${level.toUpperCase()}: ${msg}`, extra);
  if (level === 'critical') criticals++;
  if (!CFG.alertWebhookUrl) return;
  try {
    await fetch(CFG.alertWebhookUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // Generic {text} works for Slack/Discord-compatible incoming webhooks.
      body: JSON.stringify({ text: `[tacit-relay ${level}] ${msg}`, level, ...extra }),
    });
  } catch (e) { log('webhook post failed:', e.message); }
}

async function checkProve() {
  const owner = relayWallet ? relayWallet.account.address : CFG.relayAddress;
  if (!owner) { log('no relay wallet to watch: set RELAY_ADDRESS (or RELAY_KEY)'); return; }
  const bal = await publicClient.readContract({ address: PROVE, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
  const dec = await publicClient.readContract({ address: PROVE, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18);
  const whole = Number(formatUnits(bal, dec));
  log(`PROVE (relay wallet, undeposited) = ${whole}`);
  // This is the relay's UNDEPOSITED PROVE — what `replenish` has bought but not yet deposited. It is NOT
  // the vApp prover balance, which is what proving actually spends.
  //
  // That gap cannot be closed on-chain: the vApp is a rollup and holds the deposited balance off-chain,
  // and its contract exposes no balance read. Reading it needs the Succinct API with a key.
  //
  // Read it for what it is: a healthy figure here means replenish is working, and a zero means replenish
  // has stopped — but neither tells you the prover can pay. Treat a stalled prover as the symptom to watch.
  // Logged, never alerted: replenish deposits everything it buys into the vApp straight away, so a healthy relay reads
  // ~0 here by design. The credit itself is judged in checkProverKinds.
}

// Check EVERY wallet the relay spends from, not just RELAY_KEY.
//
// It pages (critical) only when a wallet can no longer do its job, judged the way the service that spends from it does:
//   settle role: the next settle at today's gas (the settle relay's own test before it takes a job), so a critical
//     means relayed jobs are sitting in the queue;
//   relay role: one attest kept back plus two headers (the header relay's smallest advance, one of margin), at today's
//     gas capped at the ceiling it advances under while a user waits (DEMAND_MAX_GAS_GWEI). Above that ceiling it
//     waits by design, and a balance that covers a short advance is not an outage: the header relay sizes each batch to
//     what the wallet holds. Below it, headers and attests stop, and nothing else pages on that, since the lag and
//     stall checks measure against the relay's own tip, which stops with them.
// A settle wallet's runway, in days at EXPECTED_OPS_PER_DAY and the live gas price, and the ETH_GAS_BUFFER_WEI floor
// are warnings: they say when to top up.
async function checkEth() {
  let gasPrice = null, base = null, tip = null;
  try { gasPrice = await publicClient.getGasPrice(); }
  catch (e) { log(`gas price read failed, runway unavailable: ${e?.message || e}`); }
  try {
    [base, tip] = await Promise.all([
      publicClient.getBlock({ blockTag: 'latest' }).then((b) => b.baseFeePerGas ?? 0n),
      publicClient.estimateMaxPriorityFeePerGas().catch(() => 10n ** 9n),
    ]);
  } catch (e) { log(`base fee read failed, next-transaction costs unavailable: ${e?.message || e}`); }

  // The floors the treasury pass keeps each wallet at (lib/settle-fees.js treasuryFloors): under one is the warning, since it means the
  // pass could not keep up, not a constant from before the pass existed.
  let floors = null;
  try { floors = await treasuryFloors(publicClient); } catch (e) { log(`treasury floors unavailable: ${e?.message || e}`); }
  for (const { address, roles } of watchedWallets) {
    const bal = await publicClient.getBalance({ address });
    const who = `${address} (${roles.join('+')})`;
    log(`ETH ${who} = ${formatEther(bal)}`);
    const extra = { address, roles, ethWei: bal.toString() };

    if (base !== null && roles.includes('settle')) {
      const { need } = await settleFundsNeed(publicClient);   // the figure the settle relay holds jobs back below (lib/settle-fees.js)
      if (bal < need) await alert('critical', `${who} holds ${formatEther(bal)} ETH, under the ${formatEther(need)} ETH the next settle can cost at today's gas: relayed jobs wait in the queue until it is topped up`, extra);
    }
    if (base !== null && roles.includes('relay')) {
      const cap = BigInt(Math.round(CFG.demandMaxGasGwei * 1e9)), fee = 2n * (base < cap ? base : cap) + tip;
      const need = (CFG.attestGasBudget + 2n * OP_GAS.maintenance) * fee;
      if (bal < need) await alert('critical', `${who} holds ${formatEther(bal)} ETH, under the ${formatEther(need)} ETH it needs to keep an attest back and still send headers: Bitcoin headers and attests stop until it is topped up`, extra);
    }

    // Runway in DAYS of the wallet's burn at the live gas price, from the roles it carries, as the treasury pass reckons it:
    //   burn = (RELAY_BURN_GAS_PER_DAY, the measured headers and attests)   if it carries the relay role
    //        + (expected ops/day x settle gas)                                if it carries the settle role
    let runway = null;
    const burn = { roles, relayBurnGasPerDay: CFG.relayBurnGasPerDay, expectedOpsPerDay: CFG.expectedOpsPerDay, gas: OP_GAS };
    const burnGas = burnGasPerDay(burn);
    if (gasPrice && burnGas * gasPrice > 0n) {
      runway = runwayDays({ balanceWei: bal, gasPriceWei: gasPrice, ...burn });
      log(`  runway = ${runway.toFixed(1)} days of burn (${(Number(burnGas * gasPrice) / 1e18).toFixed(5)} ETH/day) @ ${formatUnits(gasPrice, 9)} gwei`);
    }
    const floor = floors ? (roles.includes('settle') ? floors.settleFloor : 0n) + (roles.includes('relay') ? floors.relayFloor : 0n) : null;
    const short = runway !== null && runway < CFG.runwayDaysWarn, low = floor !== null && bal < floor;
    if (short || low) {
      await alert('warning', `${who} holds ${formatEther(bal)} ETH${short ? `, about ${runway.toFixed(1)} days of its burn at ${formatUnits(gasPrice, 9)} gwei` : ''}${low ? `, under the ${formatEther(floor)} ETH floor the treasury pass keeps` : ''}: the pass has not kept up; check the settle wallet's income and the relay's books`, { ...extra, runwayDays: runway });
    }
  }
}

// The protocol's one cumulative constraint. Everything on the immutable surface is flat in history: the
// note tree is fixed-depth with O(depth) inserts, roots and nullifiers are mappings that are never
// iterated, and the guest verifies against accumulated state through witnessed membership proofs, so its
// cost tracks batch size. The reflection snapshot is the exception — `noteLeaves` and `spentLinks` are
// append-only, so it only ever grows, and the assembler that loads it is where that lands first.
//
// This is a slow curve: the point of watching it is to schedule compaction deliberately
// rather than meet it during a catch-up.
// Is anyone waiting on a relay that is not answering? The queue's oldest pending job says so directly. Reads counts
// and ages only, from the worker's box-token route.
async function checkQueue() {
  let stats;
  try {
    const res = await fetch(`${CFG.workerBase}/confidential/queue`, { headers: { authorization: `Bearer ${CFG.boxToken}` } });
    if (!res.ok) { log(`queue stats unavailable: /confidential/queue ${res.status}${res.status === 404 ? ' (worker predates the route)' : ''}`); return; }
    stats = await res.json();
  } catch (e) { log(`queue stats read failed: ${e?.message || e}`); return; }
  const v = queueVerdict(stats, {
    pendingWarnSec: CFG.queuePendingWarnSec, pendingCriticalSec: CFG.queuePendingCriticalSec,
    provingStuckSec: CFG.settleJobTimeoutSecs + 300,
  });
  log(`queue: ${v.reason}`);
  if (v.level === 'critical' || v.level === 'warning') await alert(v.level, `settle queue: ${v.reason}`, stats);
}

async function checkSnapshotCapacity() {
  let cap;
  try {
    const res = await fetch(`${CFG.workerBase}/reflection/state?network=mainnet`, {
      headers: { authorization: `Bearer ${CFG.boxToken}` },
    });
    if (!res.ok) { log(`snapshot capacity unavailable: /reflection/state ${res.status}`); return; }
    cap = (await res.json()).capacity;
  } catch (e) { log(`snapshot capacity read failed: ${e?.message || e}`); return; }
  if (!cap || !Number.isFinite(cap.bytes)) { log('snapshot capacity not reported — worker predates the capacity field'); return; }

  const mb = (cap.bytes / (1024 * 1024)).toFixed(1);
  const permanent = cap.noteLeaves + cap.spentLinks;
  log(`snapshot = ${mb} MiB (append-only: ${cap.noteLeaves} noteLeaves + ${cap.spentLinks} spentLinks = ${permanent}; live: ${cap.liveTriples})`);
  if (cap.bytes > CFG.snapshotBytesWarn) {
    await alert('warning',
      `reflection snapshot ${mb} MiB over ${(CFG.snapshotBytesWarn / (1024 * 1024)).toFixed(0)} MiB — schedule frontier compaction before the assembler's headroom closes`,
      { bytes: cap.bytes, ...cap });
  }
}

// The launch farms stream one treasury across several pools; the failures worth a page are an under-funded treasury, an
// epoch about to run dry, and weight streaming into pools nobody has staked in. The checks are shared with GET /farm/health and
// tools/farm-monitor.mjs. An unreadable chain is a warning, not a critical: it says nothing about the farm itself.
// The points service reports whether the PointsDistributor holds enough TAC for the days still to publish (GET /rewards
// -> funding, lib/points-funding.js). Short means the next publish is held back and claims for new days are blocked;
// under three covered days is the time to send more.
async function checkPointsFunding() {
  let funding;
  try {
    const res = await fetch(`${CFG.pointsApiBase}/rewards`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    funding = (await res.json()).funding;
  } catch (e) { await alert('warning', `points funding unreadable: ${safeErr(e)}`); return; }
  if (!funding) { log('points funding: not reported (distributor unconfigured, or its balance could not be read)'); return; }
  log(`points funding = ${funding.verdict}: ${funding.daysCovered} day(s) covered, headroom ${formatEther(BigInt(funding.headroomWei))} TAC`);
  const extra = { distributor: funding.distributor, daysCovered: funding.daysCovered, headroomWei: funding.headroomWei };
  if (funding.verdict === 'critical') {
    await alert('critical', `PointsDistributor is ${formatEther(BigInt(funding.shortfallWei))} TAC short of what is allocated: the next publish is held back and new days cannot be claimed — send TAC to ${funding.distributor}`, extra);
  } else if (funding.verdict === 'warning') {
    await alert('warning', `PointsDistributor covers ${funding.daysCovered} more day(s): send TAC to ${funding.distributor} before ${new Date(funding.topUpBeforeSec * 1000).toISOString()}`, extra);
  }
}

async function checkFarmHealth() {
  const manager = process.env.FARM_MANAGER_ADDR || FARM_MANAGER_MAINNET;
  if (/^(off|none|0|false)$/i.test(manager) || /^0x0{40}$/i.test(manager)) { log('farm check disabled (FARM_MANAGER_ADDR)'); return; }
  let res;
  try { res = await checkFarm({ rpc: makeRpc(CFG.rpcUrls), manager }); }
  catch (e) { await alert('warning', `farm state unreadable: ${safeErr(e)}`, { manager }); return; }
  const { health } = res;
  log(`farm ${manager} = ${health.status}`);
  for (const c of health.checks) {
    if (c.status === 'ok') continue;
    await alert(c.status === 'critical' ? 'critical' : 'warning', `farm ${c.name}: ${c.detail}`, { manager, check: c.name });
  }
}

async function checkReflectionLag() {
  // Relay tip = the worker's confirmed Bitcoin tip; we approximate via /prover-health,
  // which already reports lag fields. Prefer that over re-scanning Bitcoin here.
  // ?kind=reflection: /prover-health used to blend settle/reflection/eth-state heartbeats into one
  // record, so this read whichever of the three last posted — not necessarily reflection. Heartbeats are
  // now kept per kind (see worker's handleProverHeartbeat), so ask for the one this check is named for.
  let health = {};
  try {
    const res = await fetch(`${CFG.workerBase}/prover-health?kind=reflection`, { headers: { authorization: `Bearer ${CFG.boxToken}` } });
    if (res.ok) health = await res.json();
  } catch { /* fall through to on-chain read */ }

  // Prefer the worker's own lag if present; else derive from on-chain attested height + health tip.
  let lag = Number(health.reflectionLag ?? health.lag ?? NaN);
  let attested = Number(health.attestedHeight ?? NaN);
  let tip = Number(health.tipHeight ?? health.bitcoinTip ?? NaN);

  // On-chain fallback when /prover-health is unreachable or omits the lag fields, which is when the lag
  // reading matters most. The pool exposes the attested tip HASH rather than a height, so resolve the height
  // through the light relay's `blockHeight`, the same lookup ReflectionLib's anchor check uses.
  if (!Number.isFinite(lag)) {
    try {
      const attestedTip = await readPool('attestedReflectionTip');
      const h = Number(await publicClient.readContract({
        address: HEADER_RELAY, abi: RELAY_ABI, functionName: 'blockHeight', args: [attestedTip],
      }));
      // blockHeight returns 0 for a hash the relay has never seen — not a real height, so do not treat a
      // miss as "attested at height 0", which would report an absurd lag and mask the real failure.
      if (Number.isFinite(h) && h > 0) attested = h;
    } catch (e) { log(`on-chain attested-height read failed: ${e?.message || e}`); }
    // Fall back to the relay's own tip height when health gave us no Bitcoin tip.
    if (!Number.isFinite(tip)) {
      try { tip = Number(await publicClient.readContract({ address: HEADER_RELAY, abi: RELAY_ABI, functionName: 'tipHeight' })); }
      catch (e) { log(`relay tipHeight read failed: ${e?.message || e}`); }
    }
    if (Number.isFinite(tip) && Number.isFinite(attested)) lag = tip - attested;
  }

  if (Number.isFinite(lag)) {
    log(`reflection lag = ${lag} blocks (attested=${attested} tip=${tip})`);
    if (lag > CFG.reflectionLagAlertBlocks) {
      await alert('warning', `reflection lag ${lag} > ${CFG.reflectionLagAlertBlocks} blocks — reflection worker may be stalled`, { lag, attested, tip });
    }
  } else {
    log('reflection lag unavailable (no health/on-chain height) — check /prover-health');
  }

  if (health.healthy === false) {
    // health.reasons is an array (see readProverKindHealth) — there has never been a singular .reason field,
    // so this fell back to the literal string below on every single unhealthy reading until now.
    await alert('critical', `/prover-health (reflection) unhealthy: ${(health.reasons || []).join('; ') || 'no heartbeat'}`, health);
  }
}

// Bridge burns the reflection holds pending with no proof bundle registered. A burn's own page registers one once the burn is
// mined; one that never does (a tab closed too soon, an old page, another browser) leaves the burn's TAC unmintable. The public
// status counts them and gives the height of the oldest, and a long wait is raised here.
async function checkBurnsAwaitingBundle() {
  let b = null;
  try {
    const res = await fetch(`${CFG.workerBase}/reflection/status?network=${encodeURIComponent(CFG.network)}`);
    if (res.ok) b = await res.json();
  } catch { /* unknown below */ }
  const v = awaitingBundleVerdict({ count: Number(b && b.burnsAwaitingBundle), oldestHeight: Number(b && b.oldestAwaitingHeight), attestedHeight: Number(b && b.attestedHeight), warnBlocks: CFG.burnBundleWarnBlocks });
  log(`burns awaiting a bundle: ${v.reason}`);
  if (v.level !== 'warning') return;
  await alert('warning', `${v.reason}. Register one for each: POST /reflection/burndep/trace, then /reflection/burndep/check, then /reflection/burndep (the burn's page does this itself when it is open), or POST /reflection/burndep/sweep with the box token.`, { count: b.burnsAwaitingBundle, oldestHeight: b.oldestAwaitingHeight, waited: v.waited });
}

// Every service's liveness, not just reflection's. The lag check above reads ?kind=reflection because it wants
// that record's lag fields; that left `settle` and `eth-state` with no health check at all, which matters most
// for eth-state: once the pool's crossOutCount has passed 0, EVERY Bitcoin-side attest must be Mode-B forever
// (ReflectionLib's freshness gate — a forward batch commits foldedCrossOutCount, which only equals crossOutCount
// once every recorded cross-out has folded), so the eth-state sidecar is a hard dependency for the entire
// Bitcoin->Ethereum lane. A dead sidecar with no candidate outstanding used to read as healthy everywhere: the
// pending-candidate check reports "none outstanding", the folder logs "caught up", and only the 3-hour stall
// clock eventually fires — labelled as a REFLECTION stall, pointing triage at the wrong service.
//
// The `note` read matters as much as `healthy`. The sidecar's own desync watchdog (its checkStall) escalates
// by writing a STALL note and nothing else — heartbeat() never clears prover_alive — so that escalation had no
// reader. Alert on a note that announces an error or a stall, whatever `healthy` says.
const HEALTH_KINDS = ['settle', 'reflection', 'eth-state'];
async function checkProverKinds() {
  for (const kind of HEALTH_KINDS) {
    let h = null;
    try {
      const res = await fetch(`${CFG.workerBase}/prover-health?kind=${encodeURIComponent(kind)}`, { headers: { authorization: `Bearer ${CFG.boxToken}` } });
      if (!res.ok) { log(`prover-health ${kind}: HTTP ${res.status}`); continue; }
      h = await res.json();
    } catch (e) { log(`prover-health ${kind} unreadable: ${e?.message || e}`); continue; }
    const note = String(h?.note || '');
    log(`prover-health ${kind}: healthy=${h?.healthy} age=${h?.age_seconds}s note=${note}${h?.prover_credit ? ` credit=${h.prover_credit} PROVE` : ''}`);
    // The prover network credit (reported by the settle service's replenish run): proving stops when it is spent.
    const low = h?.prover_credit ? creditLevel(h.prover_credit, { warn: CFG.proveCreditWarn, critical: CFG.proveCreditCritical }) : null;
    if (low) await alert(low, `prover credit is ${h.prover_credit} PROVE, under ${low === 'critical' ? CFG.proveCreditCritical : CFG.proveCreditWarn}: network proofs stop when it reaches zero. Fund the settle wallet (replenish converts ETH above its gas float to PROVE) or deposit PROVE`, { kind, prover_credit: h.prover_credit });
    // The settle relay counts the proofs that failed in the last hour on its note (settle-relay.js withFailures): a relay that is up
    // and failing its jobs (the board gone and the network refusing, a binary that cannot read its input) is otherwise healthy here.
    const fails = /(\d+) prove failures? in the last hour/.exec(note);
    if (fails && Number(fails[1]) >= CFG.proveFailuresCritical) await alert('critical', `${kind} relay: ${fails[1]} proofs failed in the last hour — the prover board and the network fallback are both failing its jobs; read the tacit-settle log`, { kind, note });
    else if (fails && Number(fails[1]) >= CFG.proveFailuresWarn) await alert('warning', `${kind} relay: ${fails[1]} proofs failed in the last hour; read the tacit-settle log`, { kind, note });
    if (h?.healthy === false) {
      await alert('critical', `${kind} prover unhealthy: ${(h.reasons || []).join('; ') || 'no heartbeat'}`, { kind, ...h });
    } else if (/^error\b|\bSTALL\b/i.test(note)) {
      // A service still beating but reporting its own failure. For eth-state a STALL note specifically means
      // its resume state has desynced from on-chain reality: every cycle "succeeds" and only the on-chain
      // attest reverts, which the sidecar never observes, so this note is the only signal that exists.
      await alert('warning', `${kind} prover is beating but reports: ${note}`, { kind, note });
    }
  }
}

// The lane can stall with the lag alert still quiet and every service reporting healthy: an attest that lands without
// its ack leaves the API's cursor behind the pool, and each later batch is built on a prior the pool no longer holds.
// Two readings catch it. Time since the last ack, while there are blocks to attest, says the lane is not moving. The
// cursor's digest against the pool's, on two runs in a row, says why.
async function checkReflectionStall() {
  const get = async (path) => {
    try {
      const res = await fetch(`${CFG.workerBase}${path}`, { headers: { authorization: `Bearer ${CFG.boxToken}` } });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  };
  const net = encodeURIComponent(CFG.network);
  const [state, att] = await Promise.all([get(`/reflection/state?network=${net}`), get(`/reflection/attest-state?network=${net}`)]);
  if (!state || !att || !att.lastAck) { log('reflection stall check unavailable (state / attest-state unreadable — worker predates the route?)'); return; }

  const stall = stallVerdict({
    attestedHeight: Number(state.attestedHeight), tipHeight: Number(state.tipHeight),
    lastAckAt: Number(att.lastAck.at), now: Number(att.now) || Date.now(), stallHours: CFG.reflectionStallHours,
  });
  log(`reflection stall: ${stall.reason}`);
  if (stall.level === 'critical') await alert('critical', `reflection stalled: ${stall.reason}`, { attestedHeight: state.attestedHeight, tipHeight: state.tipHeight, lastAck: att.lastAck });

  // The cursor's digest is what the last ack recorded, trusted only while the cursor still sits at that ack's height
  // (a reseed moves it without one). Anything else would mean assembling the next job to read its prior digest, which
  // the API's memory does not tolerate for a monitor probe, so that run has no drift verdict.
  let cursorDigest = null;
  if (!att.lastAck.seeded && Number(att.lastAck.attestedTo) === Number(state.attestedHeight)) cursorDigest = att.lastAck.jobId;
  let onchain = null;
  try { onchain = await readReflectionDigest(); } catch (e) { log(`pool digest read failed: ${e?.message || e}`); }
  const probe = driftVerdict({ cursorDigest, onchainDigest: onchain, streak: 0 });
  if (probe.level === 'unknown') { log(`reflection drift: ${probe.reason}`); return; }
  const streak = await reflectionDriftSeen(probe.drifting);
  const drift = driftVerdict({ cursorDigest, onchainDigest: onchain, streak: streak ?? 0 });
  log(`reflection drift: ${drift.reason}`);
  if (drift.level === 'critical') await alert('critical', `reflection cursor drift: ${drift.reason}. Recovery: ${manualRecoveryHint(onchain)}`, { cursorDigest, onchain, streak });
}

// A pending eth-state candidate bridges an ETH-side crossOut to its Bitcoin-side fold. The sidecar normally
// discards and republishes its own candidate once it passes ETH_STATE_PENDING_STALE_SECS on its own; this check
// covers the case where that hasn't happened yet, well ahead of the reflection lane's own block-maturity window.
// No pending candidate at all is healthy (nothing outstanding to fold); only an old, unconfirmed one is the signal.
async function checkEthStatePending() {
  let body;
  try {
    const res = await fetch(`${CFG.workerBase}/reflection/eth-state?network=${encodeURIComponent(CFG.network)}`, {
      headers: { authorization: `Bearer ${CFG.boxToken}` },
    });
    if (!res.ok) { log(`eth-state pending check unavailable: /reflection/eth-state ${res.status}`); return; }
    body = await res.json();
  } catch (e) { log(`eth-state pending check failed: ${e?.message || e}`); return; }
  const pending = body?.pending;
  if (!pending || !pending.publishedAt) { log('eth-state pending: none outstanding'); return; }
  // The sidecar stamps publishedAt in epoch milliseconds; an ISO string reads too.
  const publishedMs = Number.isFinite(Number(pending.publishedAt)) ? Number(pending.publishedAt) : Date.parse(pending.publishedAt);
  if (!Number.isFinite(publishedMs)) { log(`eth-state pending: ${pending.contentHash} with an unreadable publishedAt (${pending.publishedAt})`); return; }
  const ageSec = (Date.now() - publishedMs) / 1000;
  log(`eth-state pending: ${pending.contentHash} published ${(ageSec / 60).toFixed(1)}min ago (execBlock=${pending.execBlock})`);
  const extra = { contentHash: pending.contentHash, publishedAt: pending.publishedAt, ageSec, execBlock: pending.execBlock };
  if (ageSec > CFG.ethStatePendingCriticalSec) {
    await alert('critical',
      `eth-state candidate unconfirmed for ${(ageSec / 3600).toFixed(1)}h (> ${(CFG.ethStatePendingCriticalSec / 3600).toFixed(1)}h, past the self-heal window) — clear it (POST /reflection/eth-state/clear) once nothing is still relying on this exact candidate`,
      extra);
  } else if (ageSec > CFG.ethStatePendingWarnSec) {
    await alert('warning',
      `eth-state candidate unconfirmed for ${(ageSec / 60).toFixed(0)}min (> ${(CFG.ethStatePendingWarnSec / 60).toFixed(0)}min, past the self-heal window) — confirm the sidecar is running and check for a fresh candidate shortly`,
      extra);
  }
}

// An ETH->BTC cross-out that never folds is the one way this protocol loses user value with no error
// anywhere on either chain, and until now nothing watched for it.
//
// The mechanism: the pool records a cross-out (crossOutCount++) when the Ethereum side settles; the Bitcoin
// side is a separate T_CROSSOUT_MINT reveal the user broadcasts themselves. Reflection checks that reveal
// ONCE, at scan time, against the cross-out set its current eth-state bundle carries — membership or nothing.
// There is no pending list and no retry (unlike a bridge burn, whose uniqueness comes from spending a real
// Bitcoin UTXO, so it can safely wait for a later batch). A reveal broadcast before a bundle covering that
// cross-out exists is therefore a PERMANENT miss: the guest's anchor_height == prior + 1 invariant means its
// block is never rescanned. That is not hypothetical — it has already stranded one cross-out on mainnet.
//
// A gap is NOT itself a fault: it is the normal state between settling on Ethereum and broadcasting on
// Bitcoin, and how long that takes is entirely the user's business. Only a gap that never closes is a signal,
// so this alerts on DURATION, not on the gap existing.
//
// What this check can and cannot prove: it cannot tell a stranded cross-out from one whose owner simply has
// not broadcast yet — that needs the reveal's own Bitcoin block height, which is not knowable from here. So
// it pages a human with the one question that settles it, rather than guessing. That question is the whole
// point: the last time this happened, the gap was read as "reflection is just pacing" for over a day before
// anyone compared the reveal's block height against attestedHeight and found the wait had been structurally
// pointless from the first minute.
async function checkCrossOutFold() {
  let onchain = null;
  try { onchain = Number(await readPool('attestedCrossOutCount')); }
  catch (e) { log(`crossOut fold check: pool crossOutCount unreadable: ${e?.message || e}`); return; }
  let folded = null, attestedHeight = null;
  try {
    const res = await fetch(`${CFG.workerBase}/reflection/status?network=${encodeURIComponent(CFG.network)}`);
    if (res.ok) { const b = await res.json(); folded = Number(b.foldedCrossoutCount); attestedHeight = Number(b.attestedHeight); }
  } catch { /* fall through */ }
  if (!Number.isFinite(onchain) || !Number.isFinite(folded)) { log('crossOut fold check: counts unavailable'); return; }

  // Measure against the baseline, not against zero: a cross-out already written off as unfoldable leaves a
  // permanent gap, and paging about it every run would bury the alert this check exists to raise.
  const baseline = CFG.crossOutFoldGapBaseline;
  const gap = onchain - folded - baseline;
  const since = await crossOutGapSeen(gap > 0);
  log(`crossOut fold: onchain=${onchain} folded=${folded} baseline=${baseline} unexplained=${gap}`);
  if (gap <= 0 || !since) return;

  const hours = (Date.now() - since) / 3600000;
  if (hours < CFG.crossOutFoldGapWarnHours) return;
  await alert('warning',
    `${gap} ETH->BTC cross-out(s) beyond the known-unfoldable baseline have not folded on the Bitcoin side for `
    + `${hours.toFixed(0)}h (crossOutCount=${onchain}, foldedCrossoutCount=${folded}, baseline=${baseline}). `
    + `This is normal if nobody has broadcast their `
    + `T_CROSSOUT_MINT reveal yet. If a reveal HAS been broadcast, check its Bitcoin block height against `
    + `reflection's attestedHeight (${attestedHeight ?? 'unknown'}) FIRST: if attestedHeight was already past that `
    + `block before the eth-state bundle covering the cross-out existed, the fold is one-shot and the mint can `
    + `never land, no matter how long you wait — recover by settling a fresh cross-out, not by waiting.`,
    { onchain, folded, baseline, gap, attestedHeight, gapSinceHours: Number(hours.toFixed(1)) });
}

// The API's Bitcoin block scan, read as wallets read it (the scanned_height an answer from it carries), against the
// chain tip from public explorers.
async function checkBitcoinScan() {
  let scanned = null, tip = null;
  try {
    const r = await fetch(`${CFG.workerBase}/amm/swap-accepted?network=${encodeURIComponent(CFG.network)}&txid=${'0'.repeat(64)}`, { signal: AbortSignal.timeout(15_000) });
    if (r.ok) scanned = (await r.json()).scanned_height;
  } catch { /* unknown below */ }
  const explorers = CFG.network === 'mainnet' ? ['https://mempool.space/api', 'https://blockstream.info/api'] : ['https://mempool.space/signet/api', 'https://blockstream.info/signet/api'];
  for (const base of explorers) {
    try {
      const r = await fetch(`${base}/blocks/tip/height`, { signal: AbortSignal.timeout(10_000) });
      if (r.ok) { tip = Number(await r.text()); break; }
    } catch { /* next explorer */ }
  }
  const v = scanLagVerdict(Number.isInteger(scanned) ? scanned : null, Number.isInteger(tip) ? tip : null, { warn: CFG.btcScanLagWarnBlocks, critical: CFG.btcScanLagCriticalBlocks });
  if (v.level === 'ok' || v.level === 'unknown') { log(`bitcoin scan: ${v.why}`); return; }
  await alert(v.level, `${v.why}: wallets keep the outputs whose credit rests on it pending until it moves`, { scanned, tip, lag: v.lag });
}

// Mainnet only: the pool-minted tokens beside TAC (tacBTC, tacUSD), the wTAC wrapper, and a retired TAC token with the
// supply it ended at.
const TAC_SUPPLY_WATCH = {
  wtac: '0x2018139a8FDd3666855BE3315C7683b4D6aB7AEf',
  canonicalTokens: ['0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696', '0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564'],
  legacy: [{ token: '0xD7D7976367D171d105722F1Ce1aFa61602D97A4d', expected: 100000200000000000000n }],
};
async function checkTacSupply() {
  if (CFG.network !== 'mainnet' || process.env.TAC_SUPPLY_CHECK === 'off') return;
  const r = await readTacSupply({ client: publicClient, chainId: 1, pool: POOL, ...TAC_SUPPLY_WATCH });
  if (r.level === 'ok') { log(`tac supply: ${r.why.join('; ')}`); return; }
  // A critical is read once more before it stands, so one odd node answer cannot page.
  const again = r.level === 'critical' ? await readTacSupply({ client: publicClient, chainId: 1, pool: POOL, ...TAC_SUPPLY_WATCH }) : r;
  if (again.level === 'ok') { log(`tac supply: ${again.why.join('; ')} (a first read said: ${r.why.join('; ')})`); return; }
  await alert(again.level, `TAC on Ethereum: ${again.why.join('; ')}`, { tacToken: again.tacToken });
}

// The EVM pool keepers (evm-pool-keeper.js), one per chain: each relays users' sends and withdrawals and sweeps their
// deposit addresses, fronting the gas and taking it back, with a margin, from the fee paid to it in the same
// transaction. So its balance is working capital, and what matters is whether it can front the next send. It pages
// (critical) when a keeper does not answer, or cannot front an ordinary relay at this block's base fee (the keeper
// then refuses quotes and every user falls back to sending from their own wallet). It warns when it could not after
// a fourfold base-fee rise, or cannot front its largest transaction (the gas cap, e.g. a bridge move) with the full
// headroom it sends with. EVM_POOL_KEEPERS=off skips the check; a JSON list replaces the defaults.
const EVM_POOL_KEEPERS_DEFAULT = [
  { chainId: 1, name: 'Ethereum', keeper: 'https://tacit-evm-pool-keepers.onrender.com/1/evm-pool/keeper', address: '0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0', rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://mainnet.gateway.tenderly.co'], minTipWei: '50000000' },
  { chainId: 8453, name: 'Base', keeper: 'https://tacit-evm-pool-keepers.onrender.com/8453/evm-pool/keeper', address: '0xfA2afbaB631C7Eda7CeA6AE1440605C504E322Ec', rpc: ['https://mainnet.base.org', 'https://base.drpc.org', 'https://base.rpc.blxrbdn.com'] },
  { chainId: 4663, name: 'Robinhood Chain', keeper: 'https://tacit-evm-pool-keepers.onrender.com/4663/evm-pool/keeper', address: '0xc1F8DAc6BC910A5A794b4795b5F9997e0E8A5Fad', rpc: ['https://rpc.mainnet.chain.robinhood.com'] },
  // the TAC vaults' token pools on Ethereum: they send from the Ethereum keeper's address (its balance is judged once, above), paid in each
  // pool's token, their gas fronted in ETH
  ...[['TAC', 'tac', '0x0000007F401114398b8fa67b4Bf1e1CFEcd28ffe', '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279'], ['TACD', 'tacd', '0x0000007bDb91d1aa0b5D3106Fd1c44C784b33DBA', '0xA0f6B02561C8ef08335B69aD25e022C0B342147C'],
    ['TACE', 'tace', '0x00000091974fB81e7eBA4cF2Cb24869c00a9A1a1', '0x9DE27883C5Dc9Db47BE12E595D59b8f1aBEC8570']].map(([sym, id, pool, token]) => ({
    chainId: 1, name: `Ethereum (${sym} pool)`, keeper: `https://tacit-evm-pool-keepers.onrender.com/1-${id}/evm-pool/keeper`, address: '0x7c9f8aE4e48Cbb2727F95b6477a1cf92bCFc43D0',
    rpc: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://mainnet.gateway.tenderly.co'], minTipWei: '50000000', pool, token, sym })),
];
// The keeper's own gas figures (evm-pool-keeper-config.js defaults, unless the entry gives `relayGas` and `gasCap`): an
// ordinary relay's budget, sent with 30% on the estimate, and the cap on any one transaction.
const KEEPER_RELAY_GAS = 450_000n, KEEPER_GAS_CAP = 1_500_000n;
const EVM_POOL_ADDR = '0x000000c2A20657CE25f2Ba99737933D031AFBEE9';   // the same address on every chain
async function keeperRpc(urls, method, params = []) {
  let last;
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { last = e; }
  }
  throw last || new Error('no rpc');
}
async function checkEvmPoolKeepers() {
  const raw = process.env.EVM_POOL_KEEPERS;
  if (raw === 'off') return;
  const keepers = raw ? JSON.parse(raw) : EVM_POOL_KEEPERS_DEFAULT;
  // keepers that share an address (the token pools' one key) page once about it: its balance is one, and so is the reason it cannot quote
  const firstOf = new Map();
  for (const k of keepers) { const a = `${k.chainId}:${String(k.address).toLowerCase()}`; if (!firstOf.has(a)) firstOf.set(a, k); }
  const lead = (k) => firstOf.get(`${k.chainId}:${String(k.address).toLowerCase()}`) === k;
  await Promise.all(keepers.map(async (k) => {
    const who = `EVM pool keeper on ${k.name}`;
    let info = null;
    try {
      const r = await fetch(`${k.keeper}/info`, { signal: AbortSignal.timeout(20_000) });
      if (r.ok) info = await r.json();
    } catch {}
    if (!info) {
      await alert('critical', `${who} (${k.keeper}) does not answer: relayed private sends, withdrawals and deposit-address sweeps on ${k.name} stop; users can still send from their own wallets`, { chainId: k.chainId });
      return;
    }
    // A keeper can answer /info and still be unable to quote (its reads of the chain fail): users then see "the relay is not
    // answering". Asked twice, so one slow answer does not page.
    let quote = null, quoteWhy = '';
    for (let i = 0; i < 2 && !quote; i++) {
      try {
        const r = await fetch(`${k.keeper}/quote?gas=${k.relayGas ?? KEEPER_RELAY_GAS}`, { signal: AbortSignal.timeout(20_000) });
        const j = await r.json().catch(() => ({}));
        // a fee of nothing is no quote: a keeper with no price for its pool's token answers so
        if (r.ok && /^\d+$/.test(String(j.fee ?? '')) && BigInt(j.fee) > 0n) quote = j; else quoteWhy = j.error || (r.ok ? `a fee of ${j.fee}` : `HTTP ${r.status}`);
      } catch (e) { quoteWhy = safeErr(e); }
    }
    if (!quote && (lead(k) || !/busy with other sends/.test(quoteWhy))) await alert('critical', `${who} (${k.keeper}) answers /info but cannot quote (${quoteWhy}): relayed sends and withdrawals on ${k.name} show "the relay is not answering" and users send from their own wallets. ${k.token ? 'Check its price feed (EVM_POOL_KEEPER_RATE_FEED) and its RPC' : 'Its reads of the chain are likely failing: check its RPC'}`, { chainId: k.chainId });
    let address = k.address;
    if (info.keeper && info.keeper.toLowerCase() !== String(address).toLowerCase()) {
      await alert('warning', `${who} now signs as ${info.keeper}, not ${address}; checking the new account (update EVM_POOL_KEEPERS)`, { chainId: k.chainId });
      address = info.keeper;
    }
    const [balHex, block, tipHex] = await Promise.all([
      keeperRpc(k.rpc, 'eth_getBalance', [address, 'latest']), keeperRpc(k.rpc, 'eth_getBlockByNumber', ['latest', false]),
      keeperRpc(k.rpc, 'eth_maxPriorityFeePerGas').catch(() => '0x0'),
    ]);
    const bal = BigInt(balHex), base = BigInt(block.baseFeePerGas ?? '0x0'), minTip = BigInt(k.minTipWei ?? 0), tip0 = BigInt(tipHex);
    const tip = tip0 > minTip ? tip0 : minTip;
    const relayGas = BigInt(k.relayGas ?? KEEPER_RELAY_GAS) * 13n / 10n, gasCap = BigInt(k.gasCap ?? KEEPER_GAS_CAP);
    const now = relayGas * (base + tip), spike = relayGas * (8n * base + tip), largest = gasCap * (2n * base + tip);
    const extra = { chainId: k.chainId, address, ethWei: bal.toString(), baseFeeWei: base.toString() };
    log(`${who} ${address} quote ${quote ? `fee ${formatEther(BigInt(quote.fee))} ${k.sym ?? 'ETH'}` : 'FAILED'}, holds ${formatEther(bal)} ETH (a relay now needs ${formatEther(now)}; after a 4x base-fee rise ${formatEther(spike)}; the largest send ${formatEther(largest)})`);
    if (!lead(k)) { /* the same address as a keeper above: its balance was judged there */ }
    else if (bal < now) await alert('critical', `${who} ${address} holds ${formatEther(bal)} ETH, under the ${formatEther(now)} ETH it must front for one relay at today's gas: it refuses relays until topped up, and users fall back to their own wallets`, extra);
    else if (bal < spike) await alert('warning', `${who} ${address} holds ${formatEther(bal)} ETH: enough now, but a 4x base-fee rise would stop its relays (needs ${formatEther(spike)} ETH). Top it up`, extra);
    else if (bal < largest) await alert('warning', `${who} ${address} holds ${formatEther(bal)} ETH, under the ${formatEther(largest)} ETH to front its largest transaction (up to ${gasCap} gas, e.g. a bridge move) with full headroom`, extra);
    // The history feed a new device reads first. Far behind, and every new device reads the gap from public nodes, which on a busy
    // chain rate-limit it or cap the range: a first sync then fails. Warns at an hour behind, pages at six.
    try {
      const fr = await fetch(`${k.keeper}/events?from=999999999999`, { signal: AbortSignal.timeout(20_000) });
      if (fr.ok) {
        const through = Number((await fr.json()).through), head = Number(BigInt(await keeperRpc(k.rpc, 'eth_blockNumber')));
        const ts = async (n) => Number(BigInt((await keeperRpc(k.rpc, 'eth_getBlockByNumber', ['0x' + n.toString(16), false])).timestamp));
        const span = Math.min(1000, head - 1), blockSec = blockSecOf(await ts(head), await ts(head - span), span);
        const lag = feedLagSec({ through, head, blockSec }), level = feedLagLevel(lag);
        log(`${who} history feed through block ${through}, ${lag == null ? 'lag unknown' : `${Math.round(lag / 60)} min behind the chain`}`);
        if (level === 'warning' || level === 'critical') {
          await alert(level, `${who} history feed (${k.keeper}/events) is ${(lag / 3600).toFixed(1)} h behind the chain (through block ${through}, head ${head}): a new device reads that gap from public nodes, which can rate-limit a busy chain, so a first sync can fail. Check the keeper's 'history sync' log and its read nodes (EVM_POOL_RPC_URLS_FALLBACK)`, { chainId: k.chainId, through, head, lagHours: +(lag / 3600).toFixed(1) });
        }
      }
    } catch (e) { log(`${who} history feed check failed: ${safeErr(e)}`); }
    // The pool's own books: what its Transact events say went in and out (the keeper's /totals), held against the ETH it holds at the
    // same block. A balance under the net, or outflows above inflows, is what a flaw in the proof system would look like, so it pages;
    // a keeper that has no totals yet, or a node without the block's state, is only logged.
    try {
      const books = await poolBooks({ keeper: k.keeper, pool: k.pool ?? EVM_POOL_ADDR, token: k.token ?? null, unit: k.sym ?? 'ETH', rpc: (m, p) => keeperRpc(k.rpc, m, p) });
      log(`${who} pool books: ${books.level} — ${books.why}`);
      if (books.level === 'critical' || books.level === 'warning') {
        await alert(books.level, `The ${k.sym ?? 'ETH'} pool on ${k.name}: its events and its balance disagree: ${books.why}. ${k.token ? `Check it from the chain: the pool's Transact events (deposits, withdrawals, fees) against its ${k.sym} balance` : `Run tools/evm-pool-solvency.mjs --chain ${k.chainId} to check it from the chain's own logs`}`, { chainId: k.chainId, through: books.totals?.through, deposits: books.totals?.deposits, withdrawals: books.totals?.withdrawals, fees: books.totals?.fees, balance: books.chain?.balance });
      }
    } catch (e) { log(`${who} pool books check failed: ${safeErr(e)}`); }
  }));
}

// The prover board (worker/src/prover-board.js): Tacit's own GPU worker polls it every few seconds; while none has for a
// while, every settle proof goes to the prover network with a public input, which the relay does on its own but which
// costs the base fee and the witness's privacy, so it is worth knowing at once.
async function checkProverBoard() {
  if (!CFG.proverBoardExpectWorkers) return;
  let s;
  try {
    const res = await fetch(`${CFG.workerBase}/prover/board`);
    s = res.ok ? await res.json() : null;
  } catch (e) { s = null; }
  if (!s || !Array.isArray(s.workers)) { await alert('warning', `prover board unreadable: settle proofs may be going to the prover network`); return; }
  const live = s.workers.filter((w) => Number(w.lastSeenSeconds) <= CFG.proverBoardQuietSecs);
  if (!live.length) {
    const seen = s.workers.map((w) => `${w.name} ${Math.round(Number(w.lastSeenSeconds) / 60)} min ago`).join(', ') || 'none ever';
    await alert('critical', `no prover-board worker has polled in ${Math.round(CFG.proverBoardQuietSecs / 60)} min (last: ${seen}): settle proofs go to the prover network with public inputs until the GPU box is back (stopped pod, out of credit, or the worker loop down)`, { workers: s.workers });
    return;
  }
  const bad = s.workers.filter((w) => Number(w.bad) > 0);
  if (bad.length) await alert('warning', `prover board: ${bad.map((w) => `${w.name} ${w.bad} refused proof(s)`).join(', ')} — a proof the pool would not settle; check that box's guest and server versions`, { workers: s.workers });
  // A worker failing a good share of what it takes (a GPU server that keeps dying, inputs it cannot read): the jobs
  // still land, after a wait, on the prover network, but the box is not earning its keep.
  const failing = s.workers.filter((w) => Number(w.failed) >= 3 && Number(w.failed) * 2 >= Number(w.proved));
  if (failing.length) await alert('warning', `prover board: ${failing.map((w) => `${w.name} failed ${w.failed} of ${Number(w.failed) + Number(w.proved)} jobs`).join(', ')} — jobs then wait out the board before the prover network takes them; check the worker's log`, { workers: s.workers });
  // What a user's proof waits for the GPU: the wait for a claim over the last hour's finished jobs. A worker busy with the proof pool's stock or an
  // Ethereum-state proof leaves a user's job queued behind it (on 2026-10-30: 1 s at the median, 24 s at the 90th percentile, 70 jobs in 12 hours), and
  // a second worker, or less stock, is what lowers it.
  const r = s.recent;
  if (r && r.n >= 10 && Number(r.waitP90) > CFG.proverBoardWaitWarnSecs) {
    await alert('warning', `prover board: a user's proof waited ${r.waitP90} s for a free GPU at the 90th percentile (${r.waitP50} s at the median, ${r.n} jobs in the last hour, ${r.proveP50} s to prove): the worker is busy with other work; a second worker would cut the wait`, { recent: r });
  }
  log(`prover board: ${live.map((w) => `${w.name} seen ${w.lastSeenSeconds}s ago, proved ${w.proved}`).join('; ')}; queued ${s.queued}, claimed ${s.claimed}${r && r.n ? `; last hour: ${r.n} jobs, waited ${r.waitP50}/${r.waitP90} s (median/90th), proved in ${r.proveP50}/${r.proveP90} s` : ''}`);
}

// The GPU box's rent: RunPod stops the pod at a zero balance, and the board then goes quiet with no word. Hours left = balance over
// the running pods' hourly cost; a warning under two days, critical under half a day.
async function checkRunPod() {
  if (!CFG.runpodApiKey) return;
  let m;
  try {
    const res = await fetch('https://api.runpod.io/graphql', { method: 'POST', headers: { authorization: `Bearer ${CFG.runpodApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ myself { clientBalance pods { name desiredStatus costPerHr } } }' }) });
    m = res.ok ? (await res.json())?.data?.myself : null;
  } catch { m = null; }
  if (!m) { log('runpod: balance unreadable'); return; }
  const running = (m.pods || []).filter((p) => p.desiredStatus === 'RUNNING');
  const perHour = running.reduce((a, p) => a + Number(p.costPerHr || 0), 0);
  const balance = Number(m.clientBalance || 0);
  if (!running.length) { await alert('warning', `runpod: no pod is running (balance $${balance.toFixed(2)}); the prover board has no worker from here`); return; }
  if (perHour <= 0) { log(`runpod: balance $${balance.toFixed(2)}, cost unknown`); return; }
  const hours = balance / perHour;
  const what = `runpod balance $${balance.toFixed(2)} lasts about ${hours.toFixed(0)} h for ${running.map((p) => p.name).join(', ')} at $${perHour.toFixed(2)}/h`;
  if (hours < CFG.runpodHoursCritical) await alert('critical', `${what} — top it up or the GPU box stops and settle proofs go to the prover network with public inputs`);
  else if (hours < CFG.runpodHoursWarn) await alert('warning', `${what} — top it up soon`);
  else log(what);
}

async function main() {
  log(`monitor run — worker=${CFG.workerBase} relay=${relayWallet ? relayWallet.account.address : '(no key on this service — watching by address)'}`);
  const results = await Promise.allSettled([checkProve(), checkEth(), checkReflectionLag(), checkProverKinds(), checkRunPod(), checkSnapshotCapacity(), checkFarmHealth(), checkPointsFunding(), checkReflectionStall(), checkBurnsAwaitingBundle(), checkQueue(), checkEthStatePending(), checkCrossOutFold(), checkEvmPoolKeepers(), checkTacSupply(), checkBitcoinScan(), checkProverBoard()]);
  for (const r of results) if (r.status === 'rejected') log('check threw:', r.reason?.message || r.reason);
  log(`monitor done — ${criticals} critical${criticals === 1 ? '' : 's'}`);
  // Exit non-zero so the cron run is marked failed even with no webhook configured. A check that THREW is
  // not a critical — it is an unknown, and failing on it would page for every transient RPC blip.
  if (criticals > 0) process.exit(1);
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
