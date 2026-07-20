// ─────────────────────────────────────────────────────────────────────────────
// Header feeder — keeps the on-chain BitcoinLightRelay current so reflection can attest.
//
// Render service type: Cron Job. Ports ops/box-artifacts/auto-relay.sh (which died with the
// box) to run box-free. NO proving — just: read the relay tip + BTC tip, fetch the raw 80-byte
// headers for the gap, and submit advanceTip(bytes) on-chain (RELAY_KEY pays gas, ~cheap).
//
// PACING (the one subtlety): reflection's attest tip must land in the pool's maturity window
// [relayTip-12, relayTip-6] (CONFIRMATIONS 6 + FINALITY_WINDOW 6). So the relay must NOT get more
// than CONF+FINALITY+MAX_BATCH (=18) ahead of reflection's attested height, or reflection's 6-block
// fold falls below the window and its attest reverts. We target relay tip = min(btcTip-2,
// reflectionAttested + headerLead), so the relay only advances as reflection advances — the two
// loops self-catch-up in lockstep, then hold at the tip.
// ─────────────────────────────────────────────────────────────────────────────

import { CFG } from './lib/config.js';
import { publicClient, relayWallet, HEADER_RELAY, RELAY_ABI } from './lib/chain.js';

const log = (...a) => console.log(`[header ${new Date().toISOString()}]`, ...a);
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const ESPLORAS = CFG.btcEsplora.split(',').map((s) => s.trim()).filter(Boolean);

async function esplora(path) {
  let err;
  for (let a = 0; a < ESPLORAS.length * 3; a++) {
    const base = ESPLORAS[a % ESPLORAS.length];
    try { const r = await fetch(base + path); if (!r.ok) throw new Error(`${r.status}`); return (await r.text()).trim(); }
    catch (e) { err = e; await sleep(0.5 * (a + 1)); }
  }
  throw new Error(`esplora ${path}: ${err?.message}`);
}
const btcTip = async () => parseInt(await esplora('/blocks/tip/height'), 10);
async function headerHex(h) {
  const hash = await esplora(`/block-height/${h}`);
  const hdr = await esplora(`/block/${hash}/header`);
  if (!/^[0-9a-fA-F]{160}$/.test(hdr)) throw new Error(`bad header @${h} (${hdr.slice(0, 16)}…)`);
  return hdr;
}
const relayTip = async () => Number(await publicClient.readContract({ address: HEADER_RELAY, abi: RELAY_ABI, functionName: 'tipHeight' }));

// Reflection's attested height from the control plane (lightweight KV read, no assembly). Null if the
// endpoint isn't available — then we advance only a small safe step so we can't overshoot reflection.
async function reflectionAttested() {
  try {
    const r = await fetch(`${CFG.workerBase}/reflection/state?network=${CFG.network}`, { headers: { authorization: `Bearer ${CFG.boxToken}` } });
    if (!r.ok) return null;
    const j = await r.json();
    return Number.isFinite(Number(j.attestedHeight)) ? Number(j.attestedHeight) | 0 : null;
  } catch { return null; }
}

async function cycle() {
  const [rtip, btip, refl] = await Promise.all([relayTip(), btcTip(), reflectionAttested()]);
  // Target: keep the relay within headerLead of reflection so its fold stays in the maturity window.
  // If reflection's height is unknown, creep forward only a small step (never overshoot).
  const paceCap = refl != null ? refl + CFG.headerLead : rtip + 6;
  let to = Math.min(btip - 2, paceCap);
  if (to <= rtip) { log(`relay current (tip=${rtip} btc=${btip} refl=${refl ?? '?'})`); return false; }
  const from = rtip + 1;
  if (to - from + 1 > CFG.headerMaxBatch) to = from + CFG.headerMaxBatch - 1;

  log(`advancing relay ${from}..${to} (btc=${btip} refl=${refl ?? '?'} lead-cap=${paceCap})`);
  let hex = '';
  for (let h = from; h <= to; h++) hex += await headerHex(h);
  const txHash = await relayWallet.writeContract({ address: HEADER_RELAY, abi: RELAY_ABI, functionName: 'advanceTip', args: [`0x${hex}`] });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (rcpt.status !== 'success') throw new Error(`advanceTip reverted ${txHash}`);
  log(`relay advanced to ${to} tx=${txHash}`);
  return true;
}

async function main() {
  log(`starting — relay=${HEADER_RELAY} lead=${CFG.headerLead} maxBatch=${CFG.headerMaxBatch} esploras=${ESPLORAS.length}`);
  if (CFG.runMode === 'cron') {
    const t0 = Date.now();
    for (let i = 0; i < CFG.cronMaxCycles; i++) {
      if ((Date.now() - t0) / 1000 > CFG.cronBudgetSecs) { log('cron budget reached — exiting'); break; }
      let worked;
      try { worked = await cycle(); }
      catch (e) { log('cycle error — exiting cron run:', e.message); break; }
      if (!worked) { log('relay caught up to pace — cron run done'); break; }
    }
    return;
  }
  for (;;) {
    try { await cycle(); } catch (e) { log('cycle error (continuing):', e.message); }
    await sleep(CFG.reflectionPollSecs);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('fatal', e); process.exit(1); });
}
