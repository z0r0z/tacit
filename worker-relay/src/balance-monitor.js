// ─────────────────────────────────────────────────────────────────────────────
// Balance + lag monitor — the pager (ops runbook P1).
//
// Render service type: Cron Job (e.g. every 5-10 min). Runs once and exits.
//
// Alerts (log always; POST to ALERT_WEBHOOK_URL if set) when:
//   * PROVE balance (relay wallet's undeposited PROVE) < floor
//   * settle runway (what the ETH balance still buys at the live gas price) < N settles
//   * reflection lag (relay tip - attested Bitcoin height) > N blocks
//   * reflection snapshot size > warn threshold — the one cumulative resource
//
// The lag alert is the "reflection is falling behind" signal that catches a stalled
// reflection worker before the 176-block trap can form.
//
// A CRITICAL also makes the process EXIT NON-ZERO. ALERT_WEBHOOK_URL is optional and has historically
// been unset, which quietly turned every critical into a log line inside a cron run nobody reads — a
// pager with no pager attached. A failing exit code is the one channel that always exists: Render marks
// the cron run failed and surfaces it without any configuration at all. The webhook stays the good path;
// this is the floor beneath it.
// ─────────────────────────────────────────────────────────────────────────────

import { formatEther, formatUnits } from 'viem';
import { CFG, OP_GAS } from './lib/config.js';
import { publicClient, relayWallet, ERC20_ABI, PROVE, readPool, HEADER_RELAY, RELAY_ABI } from './lib/chain.js';

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
  // That gap cannot be closed on-chain: the vApp is a rollup and holds the deposited balance off-chain.
  // Probed 2026-09-20 against 0x5Ad5Bc4B…951F — balances/balanceOf/deposits/accountBalance/proverBalance
  // all revert, and the contract's ABI here carries only deposit(uint256). So there is nothing to read,
  // and this check should not be mistaken for one. Closing it properly means the Succinct API, with a key,
  // which is a credential decision rather than a code one.
  //
  // Read it for what it is: a healthy figure here means replenish is working, and a zero means replenish
  // has stopped — but neither tells you the prover can pay. Treat a stalled prover as the symptom to watch.
  if (whole < CFG.proveBalanceFloor) {
    await alert('critical', `PROVE balance ${whole} < floor ${CFG.proveBalanceFloor} — replenish/deposit or proving stalls`, { prove: whole });
  }
}

async function checkEth() {
  const owner = relayWallet.account.address;
  const bal = await publicClient.getBalance({ address: owner });
  log(`ETH (relay) = ${formatEther(bal)}`);

  // Runway: what the balance still buys at the live gas price. `transfer` is the representative settle —
  // it is the op the relay actually runs in volume, and its 600k is measured rather than guessed.
  let runway = null;
  try {
    const gasPrice = await publicClient.getGasPrice();
    const perSettle = OP_GAS.transfer * gasPrice;
    if (perSettle > 0n) {
      runway = Number(bal / perSettle);
      log(`settle runway = ${runway} settles @ ${formatUnits(gasPrice, 9)} gwei (${formatEther(perSettle)} ETH each)`);
      if (runway < CFG.settleRunwayAlert) {
        await alert('critical',
          `settle runway ${runway} < ${CFG.settleRunwayAlert} at ${formatUnits(gasPrice, 9)} gwei — fund ${owner} or the relay stalls`,
          { runway, ethWei: bal.toString(), gasPriceWei: gasPrice.toString() });
      }
    }
  } catch (e) { log(`gas price read failed, runway unavailable: ${e?.message || e}`); }

  // Absolute floor. Two alerts for one condition is noise, so this only escalates when runway did not
  // already cover it: critical if the gas read failed (the floor is then the only signal there is), and
  // otherwise a warning — a low balance that a quiet market makes survivable is still worth saying, but
  // it is not a second page.
  if (bal < CFG.ethGasBufferWei) {
    const level = runway === null ? 'critical' : 'warning';
    await alert(level, `ETH gas ${formatEther(bal)} < buffer ${formatEther(CFG.ethGasBufferWei)} — fund ${owner}`, { ethWei: bal.toString(), runway });
  }
}

// The protocol's one cumulative constraint. Everything on the immutable surface is flat in history: the
// note tree is fixed-depth with O(depth) inserts, roots and nullifiers are mappings that are never
// iterated, and the guest verifies against accumulated state through witnessed membership proofs, so its
// cost tracks batch size. The reflection snapshot is the exception — `noteLeaves` and `spentLinks` are
// append-only, so it only ever grows, and the assembler that loads it is where that lands first.
//
// This is a slow curve, not an incident: the point of watching it is to schedule compaction deliberately
// rather than meet it during a catch-up.
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

async function main() {
  log(`monitor run — worker=${CFG.workerBase} relay=${relayWallet.account.address}`);
  const results = await Promise.allSettled([checkProve(), checkEth(), checkReflectionLag(), checkSnapshotCapacity()]);
  for (const r of results) if (r.status === 'rejected') log('check threw:', r.reason?.message || r.reason);
  log(`monitor done — ${criticals} critical${criticals === 1 ? '' : 's'}`);
  // Exit non-zero so the cron run is marked failed even with no webhook configured. A check that THREW is
  // not a critical — it is an unknown, and failing on it would page for every transient RPC blip.
  if (criticals > 0) process.exit(1);
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
