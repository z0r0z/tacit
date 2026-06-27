// Per-bid fill engine for the walk-away watchtower — shared by the single-bid
// CLI daemon (buyer-watchtower.mjs) and the hosted multi-bid orchestrator
// (hosted-watchtower.mjs), so the security-critical verify-before-take and
// settle-time policy re-check live in exactly ONE place.
//
// A bid is a limit buy: fill from any matching ask. A seller filling the bid
// (fulfilBidIntent) publishes a PUBLIC §5.7.6 atomic-intent at the bid's price;
// direct asks are the same shape. The take delivers the asset to THIS bid
// wallet and verifyAxferOffer + the policy re-check bind delivery and price ≤
// ceiling — so settling any matching public ask IS the limit buy.
//
// All state is passed in and owned by the caller (a local JSON file for the
// daemon, a KV record for the orchestrator); the engine mutates it and signals
// the caller to persist via the `persist` callback. The dapp module is passed
// in `ctx.dapp` — no crypto or tx-building is reimplemented here.
//
//   ctx = {
//     dapp,                              // imported dapp/tacit.js module
//     workerBase, network, assetId, decimals,
//     priv: Uint8Array, pub: Uint8Array, pubHex, h160, address,
//     maxUnitPriceSats: number, maxTotalFillBase: bigint,
//     claimFulfilTimeoutSec, minBidWalletSats,
//     dryRun: boolean,
//     log(level, msg, extra),
//   }
//   state = { filledBase: bigint, processed: { [intentId]: {...} } }

import { evalBidPolicy } from './bid-policy.mjs';

// The dapp keeps a single global wallet; set it to THIS bid's key before any
// operation. Callers that drive many bids must run them serially (the
// orchestrator does), so there is no race on the shared global.
function bindWallet(ctx) {
  ctx.dapp.wallet.priv = ctx.priv;
  ctx.dapp.wallet.pub = ctx.pub;
}

export function bidPolicy(ctx, state, rec) {
  return evalBidPolicy(rec, {
    maxUnitPriceSats: ctx.maxUnitPriceSats,
    decimals: ctx.decimals,
    maxTotalFillBase: ctx.maxTotalFillBase,
    filledBase: state.filledBase,
  });
}

export async function bidWalletSats(ctx) {
  try {
    const utxos = await ctx.dapp.getUtxos(ctx.address);
    return utxos.reduce((s, u) => s + (u.value || 0), 0);
  } catch (e) { ctx.log('warn', 'getUtxos failed', { err: e.message }); return null; }
}

// Atomic-intent asks on the asset this bid wallet may settle. Skip only intents
// reserved for a different buyer; untargeted public asks are candidates.
export async function fetchCandidateIntents(ctx) {
  const url = `${ctx.workerBase}/assets/${ctx.assetId}/atomic-intents?network=${encodeURIComponent(ctx.network)}`;
  let j;
  try { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); j = await r.json(); }
  catch (e) { ctx.log('warn', 'atomic-intents list failed', { err: e.message }); return []; }
  const intents = Array.isArray(j.intents) ? j.intents : (Array.isArray(j) ? j : []);
  const now = Math.floor(Date.now() / 1000);
  return intents.filter((it) => {
    if (!it || !it.intent_id) return false;
    if (it.expired || Number(it.expiry || 0) <= now) return false;
    const tgt = String(it.intended_buyer_h160 || '').toLowerCase();
    const rcp = String(it.recipient_pubkey || '').toLowerCase();
    if (tgt && tgt !== ctx.h160) return false;
    if (rcp && rcp !== ctx.pubHex) return false;
    return true;
  });
}

// One full fill: claim -> wait for the seller's fulfilment -> settle-time policy
// re-check -> verify+take (SIGHASH_ALL). Returns
// { ok, txid, settledAmt } | { ok:false, refused, reason } | { ok:false, dry }.
export async function attemptFill(ctx, state, it) {
  const m = ctx.dapp;
  const intentIdHex = String(it.intent_id).toLowerCase();
  const priceSats = Number(it.price_sats);
  ctx.log('info', 'claiming candidate ask', { intent_id: intentIdHex, price_sats: priceSats, amount: it.amount });
  if (ctx.dryRun) { ctx.log('info', 'DRY RUN — would claim + take', { intent_id: intentIdHex }); return { ok: false, dry: true }; }

  try { await m.claimAxferIntent({ assetIdHex: ctx.assetId, intentIdHex, priceSats }); }
  catch (e) { return { ok: false, reason: `claim failed: ${e.message}` }; }

  const deadline = Date.now() + ctx.claimFulfilTimeoutSec * 1000;
  let fulfilment = null;
  while (Date.now() < deadline) {
    try {
      const f = await m.fetchAxferFulfilment({ assetIdHex: ctx.assetId, intentIdHex });
      const rec = f?.fulfilment || f;
      if (rec && rec.partial_reveal) { fulfilment = rec; break; }
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!fulfilment) return { ok: false, reason: 'seller did not fulfil within timeout' };

  // Re-fetch the canonical record we are about to settle.
  let intentRec = it;
  let refetched = false;
  try {
    const r = await fetch(`${ctx.workerBase}/assets/${ctx.assetId}/atomic-intents/${intentIdHex}?network=${encodeURIComponent(ctx.network)}`);
    if (r.ok) { const jj = await r.json(); intentRec = jj.intent || jj || it; refetched = true; }
  } catch { /* fall back to list record */ }
  // Falling back to the (possibly stale) list record is still SAFE — takeAxferIntent's
  // verifyAxferOffer binds intentRec.price_sats/amount to the on-chain partial_reveal, so a mismatch
  // fails closed rather than overpaying — but surface it so a flapping worker is visible.
  if (!refetched) ctx.log('warn', 'canonical re-fetch failed; settling against list record (on-chain bind still enforced)', { intent_id: intentIdHex });

  // Settle-time policy re-check against the record actually being settled.
  // takeAxferIntent -> verifyAxferOffer binds intentRec.price_sats/amount to the
  // on-chain partial_reveal, so this ties the buyer's ceiling + cap to what
  // settles. Without it a worker serving a worse record than it listed would
  // slip past the list-record gate and overpay from the bid wallet.
  const settleGate = bidPolicy(ctx, state, intentRec);
  if (!settleGate.ok) {
    ctx.log('warn', 'settlement record fails policy — refusing + cancelling claim', { intent_id: intentIdHex, reason: settleGate.reason });
    try { await m.cancelAxferClaim({ assetIdHex: ctx.assetId, intentIdHex }); }
    catch (e) { ctx.log('warn', 'claim cancel failed (will lapse at TTL)', { intent_id: intentIdHex, err: e.message }); }
    return { ok: false, refused: true, reason: `settlement record fails policy: ${settleGate.reason}` };
  }

  try {
    const res = await m.takeAxferIntent({ intent: intentRec, fulfilment });
    return { ok: true, txid: res?.revealTxid || res?.txid || null, settledAmt: settleGate.amt };
  } catch (e) {
    return { ok: false, reason: `take failed: ${e.message}` };
  }
}

// One poll cycle for one bid. Mutates `state` and calls `persist(state)` after
// each settled/refused intent. Returns { fills, capped, idle, scanned }.
export async function runTick(ctx, state, { persist = () => {} } = {}) {
  bindWallet(ctx);
  if (ctx.maxTotalFillBase > 0n && state.filledBase >= ctx.maxTotalFillBase) {
    ctx.log('info', 'max fill reached — nothing to do', { filled_base: state.filledBase.toString() });
    return { fills: 0, capped: true };
  }
  const sats = await bidWalletSats(ctx);
  if (sats != null && sats < ctx.minBidWalletSats) {
    ctx.log('info', 'bid wallet below min — idling', { sats, min: ctx.minBidWalletSats });
    return { fills: 0, idle: true };
  }
  const intents = await fetchCandidateIntents(ctx);
  let fills = 0;
  for (const it of intents) {
    const id = String(it.intent_id).toLowerCase();
    if (state.processed[id]) continue;
    const gate = bidPolicy(ctx, state, it);
    if (!gate.ok) { ctx.log('info', 'intent skipped by policy', { intent_id: id, reason: gate.reason }); continue; }
    const r = await attemptFill(ctx, state, it);
    if (r.ok) {
      const settled = r.settledAmt != null ? r.settledAmt : gate.amt;
      state.processed[id] = { txid: r.txid, at: Math.floor(Date.now() / 1000), amount: settled.toString() };
      state.filledBase += settled;
      await persist(state);
      fills++;
      ctx.log('info', 'fill completed', { intent_id: id, txid: r.txid, filled_base: state.filledBase.toString() });
      try { ctx.dapp.invalidateHoldingsCache(); } catch {}
      if (ctx.maxTotalFillBase > 0n && state.filledBase >= ctx.maxTotalFillBase) break;
    } else if (r.refused) {
      state.processed[id] = { refused: true, reason: r.reason, at: Math.floor(Date.now() / 1000) };
      await persist(state);
      ctx.log('info', 'intent refused at settlement-time policy re-check', { intent_id: id, reason: r.reason });
    } else if (!r.dry) {
      ctx.log('warn', 'fill attempt failed', { intent_id: id, reason: r.reason });
    }
  }
  return { fills, scanned: intents.length };
}
