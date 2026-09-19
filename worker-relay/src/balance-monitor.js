// ─────────────────────────────────────────────────────────────────────────────
// Balance + lag monitor — the pager (ops runbook P1).
//
// Render service type: Cron Job (e.g. every 5-10 min). Runs once and exits.
//
// Alerts (log always; POST to ALERT_WEBHOOK_URL if set) when:
//   * PROVE balance (relay wallet + on-chain proxy for the vApp prover balance) < floor
//   * ETH gas balance < buffer
//   * reflection lag (relay tip - attested Bitcoin height) > N blocks
//
// The lag alert is the "reflection is falling behind" signal that catches a stalled
// reflection worker before the 176-block trap can form.
// ─────────────────────────────────────────────────────────────────────────────

import { formatEther, formatUnits } from 'viem';
import { CFG } from './lib/config.js';
import { publicClient, relayWallet, ERC20_ABI, PROVE, readPool, HEADER_RELAY, RELAY_ABI } from './lib/chain.js';

const log = (...a) => console.log(`[monitor ${new Date().toISOString()}]`, ...a);

async function alert(level, msg, extra = {}) {
  log(`${level.toUpperCase()}: ${msg}`, extra);
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
  log(`PROVE (relay wallet) = ${whole}`);
  // Note: this is the relay's UNDEPOSITED PROVE, not the vApp prover balance. If Succinct
  // exposes a prover-balance read, add it here. TODO: query the vApp/Succinct API for the
  // deposited prover balance too — that's the one proving actually spends.
  if (whole < CFG.proveBalanceFloor) {
    await alert('critical', `PROVE balance ${whole} < floor ${CFG.proveBalanceFloor} — replenish/deposit or proving stalls`, { prove: whole });
  }
}

async function checkEth() {
  const owner = relayWallet.account.address;
  const bal = await publicClient.getBalance({ address: owner });
  log(`ETH (relay) = ${formatEther(bal)}`);
  if (bal < CFG.ethGasBufferWei) {
    await alert('critical', `ETH gas ${formatEther(bal)} < buffer ${formatEther(CFG.ethGasBufferWei)} — attest/settle will stall`, { ethWei: bal.toString() });
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
  await Promise.allSettled([checkProve(), checkEth(), checkReflectionLag()]);
  log('monitor done');
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
