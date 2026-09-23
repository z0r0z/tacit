// ─────────────────────────────────────────────────────────────────────────────
// Balance + lag monitor — the pager.
//
// Render service type: Cron Job (e.g. every 5-10 min). Runs once and exits.
//
// Alerts (log always; POST to ALERT_WEBHOOK_URL if set) when:
//   * PROVE balance (relay wallet's undeposited PROVE) < floor
//   * gas runway (days of this wallet's actual burn at the live gas price) < N days
//   * reflection lag (relay tip - attested Bitcoin height) > N blocks
//   * reflection snapshot size > warn threshold — the one cumulative resource
//   * reflection stalled: no successful attest for REFLECTION_STALL_HOURS with blocks waiting, or the API's cursor
//     off the pool's digest on two consecutive runs (a lost ack) — lib/reflection-stall.js
//   * launch-farm health (treasury solvency, epoch runway, idle pools, governor handover) — lib/farm-health.js;
//     FARM_MANAGER_ADDR overrides the manager, or set it to "off" to skip the check
//
// The lag alert is the "reflection is falling behind" signal that catches a stalled
// reflection worker before the backlog grows into a batch too large to prove.
//
// A CRITICAL also makes the process EXIT NON-ZERO. ALERT_WEBHOOK_URL is optional; a failing exit code is
// the one channel that always exists, since Render marks the cron run failed without any configuration.
// ─────────────────────────────────────────────────────────────────────────────

import { formatEther, formatUnits } from 'viem';
import { CFG, OP_GAS, MAINTENANCE_RUNS_PER_DAY } from './lib/config.js';
import { burnGasPerDay, runwayDays } from './lib/runway.js';
import { queueVerdict } from './lib/queue-health.js';
import { makeRpc, checkFarm, FARM_MANAGER_MAINNET } from './lib/farm-health.js';
import { stallVerdict, driftVerdict } from './lib/reflection-stall.js';
import { manualRecoveryHint } from './lib/reflection-reconcile.js';
import { reflectionDriftSeen } from './lib/worker-client.js';
import { publicClient, relayWallet, watchedWallets, ERC20_ABI, PROVE, readPool, readReflectionDigest, HEADER_RELAY, RELAY_ABI } from './lib/chain.js';

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
  const owner = relayWallet.account.address;
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
  // A WARNING, never a critical. Replenish deposits everything it buys into the vApp straight away, so a
  // healthy relay reads ~0 here by design.
  if (whole < CFG.proveBalanceFloor) {
    await alert('warning', `PROVE (undeposited) ${whole} < ${CFG.proveBalanceFloor} — expected while replenish deposits eagerly; a stalled prover is the real signal`, { prove: whole });
  }
}

// Check EVERY wallet the relay spends from, not just RELAY_KEY.
//
// On a split-key deployment the settle wallet is msg.sender on every settle, so it burns gas per op and can
// run low while the relay wallet looks fine.
async function checkEth() {
  let gasPrice = null;
  try { gasPrice = await publicClient.getGasPrice(); }
  catch (e) { log(`gas price read failed, runway unavailable: ${e?.message || e}`); }

  for (const { address, roles } of watchedWallets) {
    const bal = await publicClient.getBalance({ address });
    const who = `${address} (${roles.join('+')})`;
    log(`ETH ${who} = ${formatEther(bal)}`);

    // Runway in DAYS of this wallet's actual burn at the live gas price. It must be days, not "settles": a
    // wallet carrying both roles pays for the maintenance lane AND the settles, and maintenance (header
    // attestation, reflection) costs about as much per day as the settles do at any realistic volume.
    //   burn = (maintenance runs/day x maintenance gas)   if it carries the relay role
    //        + (expected ops/day x settle gas)            if it carries the settle role
    let runway = null;
    const burn = { roles, maintenanceRunsPerDay: MAINTENANCE_RUNS_PER_DAY, expectedOpsPerDay: CFG.expectedOpsPerDay, gas: OP_GAS };
    const burnGas = burnGasPerDay(burn);
    if (gasPrice && burnGas * gasPrice > 0n) {
      runway = runwayDays({ balanceWei: bal, gasPriceWei: gasPrice, ...burn });
      const settlesLeft = Number(bal / (OP_GAS.transfer * gasPrice));
      log(`  runway = ${runway.toFixed(1)} days of burn (${(Number(burnGas * gasPrice) / 1e18).toFixed(5)} ETH/day; ~${settlesLeft} settles if it did nothing else) @ ${formatUnits(gasPrice, 9)} gwei`);
      const extra = { address, roles, runwayDays: runway, ethWei: bal.toString(), gasPriceWei: gasPrice.toString() };
      if (runway < CFG.runwayDaysCritical) {
        await alert('critical', `${who} has ~${runway.toFixed(1)} days of gas left at ${formatUnits(gasPrice, 9)} gwei (< ${CFG.runwayDaysCritical}) — fund it or attestation and settles stall`, extra);
      } else if (runway < CFG.runwayDaysWarn) {
        await alert('warning', `${who} has ~${runway.toFixed(1)} days of gas left at ${formatUnits(gasPrice, 9)} gwei (< ${CFG.runwayDaysWarn}) — top it up soon`, extra);
      }
    }

    // Absolute floor — a BACKSTOP for when the runway could not be computed (no gas price). Once runway is
    // known it says everything the floor would, in a unit you can act on (settles left), so alerting on both
    // is just a second line for the same fact.
    if (runway === null && bal < CFG.ethGasBufferWei) {
      await alert('critical', `${who} ETH ${formatEther(bal)} < buffer ${formatEther(CFG.ethGasBufferWei)} and runway unavailable — fund it`, { address, roles, ethWei: bal.toString() });
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
async function checkFarmHealth() {
  const manager = process.env.FARM_MANAGER_ADDR || FARM_MANAGER_MAINNET;
  if (/^(off|none|0|false)$/i.test(manager) || /^0x0{40}$/i.test(manager)) { log('farm check disabled (FARM_MANAGER_ADDR)'); return; }
  let res;
  try { res = await checkFarm({ rpc: makeRpc(CFG.rpcUrls), manager }); }
  catch (e) { await alert('warning', `farm state unreadable: ${e?.message || e}`, { manager }); return; }
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
  let health = {};
  try {
    const res = await fetch(`${CFG.workerBase}/prover-health`, { headers: { authorization: `Bearer ${CFG.boxToken}` } });
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
    await alert('critical', `/prover-health reports unhealthy: ${health.reason || 'no heartbeat'}`, health);
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
  const ageSec = (Date.now() - Date.parse(pending.publishedAt)) / 1000;
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

async function main() {
  log(`monitor run — worker=${CFG.workerBase} relay=${relayWallet.account.address}`);
  const results = await Promise.allSettled([checkProve(), checkEth(), checkReflectionLag(), checkSnapshotCapacity(), checkFarmHealth(), checkReflectionStall(), checkQueue(), checkEthStatePending()]);
  for (const r of results) if (r.status === 'rejected') log('check threw:', r.reason?.message || r.reason);
  log(`monitor done — ${criticals} critical${criticals === 1 ? '' : 's'}`);
  // Exit non-zero so the cron run is marked failed even with no webhook configured. A check that THREW is
  // not a critical — it is an unknown, and failing on it would page for every transient RPC blip.
  if (criticals > 0) process.exit(1);
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
