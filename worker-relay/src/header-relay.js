// ─────────────────────────────────────────────────────────────────────────────
// Header feeder — keeps the on-chain BitcoinLightRelay current so reflection can attest.
//
// Render service type: Cron Job. Ports ops/box-artifacts/auto-relay.sh (which died with the
// box) to run box-free. NO proving — just: read the relay tip + BTC tip, fetch the raw 80-byte
// headers for the gap, and submit advanceTip(bytes) on-chain (RELAY_KEY pays gas, ~cheap).
//
// PACING (the one subtlety): reflection's attest tip must sit at or below relayTip-CONFIRMATIONS, and
// the pool tolerates it sitting up to REFLECTION_MAX_LAG further below, so a relay that has run ahead
// never locks reflection out — it just makes reflection's next batches lag, and the pool's anchor
// walk costs one parent read per block of that lag. So the lead is a COST cap, not a correctness one:
// we target relay tip = min(btcTip-2, reflectionAttested + headerLead) to keep the two loops roughly in
// step and each attest's walk short, then hold at the tip.
// ─────────────────────────────────────────────────────────────────────────────

import { CFG } from './lib/config.js';
import { publicClient, relayWallet, HEADER_RELAY, RELAY_ABI, gasAboveCap } from './lib/chain.js';

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
const relayTipHash = async () => publicClient.readContract({ address: HEADER_RELAY, abi: RELAY_ABI, functionName: 'tip' });
const relayParent = async (h) => publicClient.readContract({ address: HEADER_RELAY, abi: RELAY_ABI, functionName: 'blockParent', args: [h] });
// Explorer hashes are displayed byte-reversed; the relay keys blocks by the header's internal byte order.
const relayKey = (explorerHash) => `0x${explorerHash.replace(/^0x/, '').toLowerCase().match(/../g).reverse().join('')}`;
const relayKnows = async (explorerHash) => (await publicClient.readContract({ address: HEADER_RELAY, abi: RELAY_ABI, functionName: 'blockWork', args: [relayKey(explorerHash)] })) > 0n;

// The relay keys blocks by the hash as it appears in the header (internal byte order); explorers display
// the byte-reversed form. Accept either so the comparison never hinges on one convention.
const sameBlock = (relayHash, explorerHash) => {
  const a = relayHash.replace(/^0x/, '').toLowerCase();
  const b = explorerHash.replace(/^0x/, '').toLowerCase();
  return a === b || a === b.match(/../g).reverse().join('');
};

// The height the next submission continues from. Normally the relay's tip is on the canonical chain and that
// is simply its tip height. If the relay's tip sits on a branch the network has since abandoned (a reorg, a
// header taken from a lagging explorer, or a branch someone else submitted), every submission from tipHeight+1
// would build on that branch or fail with UnknownParent. The relay accepts a branch from ANY block it knows
// (heaviest-chain fork choice, every header PoW-checked), so walk its tip back through blockParent to the last
// block the explorer still agrees on, at any depth, and resubmit the explorer chain from there: submitting the
// honest chain is always safe. A fork deeper than `alertDepth` is not normal network behaviour, so it is also
// raised through `onDeepFork` — but the feeder keeps restoring the canonical tip rather than stopping.
// A restore can take several batches while the abandoned branch still carries more work, so the explorer blocks
// the relay already stores past the common ancestor (`isKnown`, up to `maxHeight`) are skipped: each cycle then
// continues the honest branch instead of resubmitting its first batch. Pure over its readers so it is testable.
export async function findResumeHeight({ tipHeight, tipHash, parentOf, explorerHashAt, isKnown, maxHeight, alertDepth, onDeepFork }) {
  let hash = tipHash;
  for (let h = tipHeight; h >= 0; h--) {
    if (sameBlock(hash, await explorerHashAt(h))) {
      const depth = tipHeight - h;
      if (depth > alertDepth && onDeepFork) await onDeepFork({ depth, height: h, tipHeight });
      let height = h;
      if (depth > 0 && isKnown) {
        while (height + 1 <= maxHeight && await isKnown(await explorerHashAt(height + 1))) height++;
      }
      return { height, depth, ancestor: h };
    }
    hash = await parentOf(hash);
    if (!hash || /^(0x)?0*$/.test(String(hash))) break; // walked past the relay's first known block
  }
  throw new Error(`relay tip shares no block with the explorer chain in the relay's known history (tip ${tipHeight})`);
}

async function alert(msg, extra = {}) {
  log(`CRITICAL: ${msg}`, extra);
  if (!CFG.alertWebhookUrl) return;
  try {
    await fetch(CFG.alertWebhookUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `[tacit-relay critical] ${msg}`, level: 'critical', ...extra }),
    });
  } catch (e) { log('webhook post failed:', e.message); }
}

async function resumeHeight(rtip, btip) {
  const r = await findResumeHeight({
    tipHeight: rtip,
    tipHash: await relayTipHash(),
    parentOf: relayParent,
    explorerHashAt: (h) => esplora(`/block-height/${h}`),
    isKnown: relayKnows,
    maxHeight: btip - 2,
    alertDepth: CFG.headerReorgDepth,
    onDeepFork: ({ depth: d, height: h }) => alert(`header relay tip was on a ${d}-block branch the explorer chain abandoned; resubmitting the canonical chain from ${h}`, { depth: d, height: h, relayTip: rtip }),
  });
  if (r.depth > 0) log(`relay tip is on an abandoned branch (${r.depth} blocks past ${r.ancestor}) — continuing the canonical chain from ${r.height}`);
  return r;
}

async function submitAdvance(from, to) {
  let hex = '';
  for (let h = from; h <= to; h++) hex += await headerHex(h);
  const txHash = await relayWallet.writeContract({ address: HEADER_RELAY, abi: RELAY_ABI, functionName: 'advanceTip', args: [`0x${hex}`] });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (rcpt.status !== 'success') throw new Error(`advanceTip reverted ${txHash}`);
  return txHash;
}

// Reflection's attested height from the control plane (lightweight KV read, no assembly). Null if the
// endpoint isn't available — the cycle then follows the explorer tip instead of pacing.
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
  // Pace against reflection: keep the relay within headerLead of reflection's attested height, so each attest
  // pays a short ancestor walk rather than one proportional to an unbounded lead. The pace is only a cost cap.
  // What protects reflected effects is the relay following the real chain: while it idles, a privately mined
  // branch needs only REFLECTION_CONFIRMATIONS headers past the last reflected block to become the relay's tip.
  // So when reflection's height is UNKNOWN (/reflection/state not reachable) the feeder keeps following the
  // explorer tip rather than stopping; a longer attest walk is the price, and a lane that falls past the
  // pool's lag bound recovers through advanceReflectionAncestry.
  if (refl == null) log(`reflection height unavailable (/reflection/state) — following the explorer tip. relay tip=${rtip}`);
  const paceCap = refl == null ? btip - 2 : refl + CFG.headerLead;
  let to = Math.min(btip - 2, paceCap);
  const { height: base, depth } = await resumeHeight(rtip, btip);
  // Off the canonical chain, restoring it outranks pacing: carry the honest branch past the abandoned tip.
  if (depth > 0) to = Math.max(to, Math.min(btip - 2, rtip + 1));
  if (to <= base) { log(`relay current (tip=${rtip} btc=${btip} refl=${refl ?? '?'})`); return false; }

  // advanceTip derives each header's difficulty target from its OWN branch (blockTarget[prev] +
  // epochStartTs[prev]), not a single global per-epoch value set by a separate call — so it crosses a
  // difficulty-epoch boundary transparently within one submission. No special-casing needed here.
  const from = base + 1;
  if (to - from + 1 > CFG.headerMaxBatch) to = from + CFG.headerMaxBatch - 1;
  const dear = await gasAboveCap();
  if (dear) { log(`gas ${dear.toFixed(3)} gwei is above MAX_GAS_GWEI=${CFG.maxGasGwei} — waiting`); return false; }
  log(`advancing relay ${from}..${to} (btc=${btip} refl=${refl ?? '?'} lead-cap=${paceCap})`);
  const tx = await submitAdvance(from, to);
  log(`relay advanced to ${to} tx=${tx}`);
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
