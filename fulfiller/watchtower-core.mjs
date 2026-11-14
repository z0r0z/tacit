// Per-bid fill engine for the walk-away watchtower — shared by the single-bid
// CLI daemon (buyer-watchtower.mjs) and the hosted multi-bid orchestrator
// (hosted-watchtower.mjs), so the security-critical verify-before-take and
// settle-time policy re-check live in exactly ONE place.
//
// A bid is a limit buy: fill from any matching ask. A seller filling the bid
// (fulfilBidIntent) publishes a PUBLIC atomic-intent at the bid's price;
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

// A registration is kept for a week past its bid's expiry, as the registry stores it, so the owner's list shows a finished
// bid for as long as its bid wallet may still hold funds.
export const RECORD_GRACE_SEC = 7 * 24 * 3600;
export const recordExpiration = (expiry) => Number(expiry) + RECORD_GRACE_SEC;

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

// ---- a bridged token's bid: bound offers instead of atomic intents ----
//
// A bridged token other than TAC is not sold by an atomic sale (the reflection would not fold it). A seller answers a 'bound' bid
// with a signed bound offer (worker/src/bound-offers.js): its whole note, ALL|ANYONECANPAY, for at most the bid's unit price. The
// take (dapp/tacit.js takeBoundOffer) checks the note live and unbound in the reflection's set, checks the offer, funds the commit
// from this bid wallet, verifies the pair (the seller's signature over THIS reveal, every output bound, the chain binding, the
// buyer note's opening) and broadcasts, then reports the fill. Nothing is claimed first: the offer is already signed.
export async function fetchCandidateBoundOffers(ctx) {
  const url = `${ctx.workerBase}/assets/${ctx.assetId}/bound-offers?network=${encodeURIComponent(ctx.network)}&bid=${encodeURIComponent(ctx.bidId || '')}`;
  let j;
  try { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); j = await r.json(); }
  catch (e) { ctx.log('warn', 'bound-offers list failed', { err: e.message }); return []; }
  const now = Math.floor(Date.now() / 1000);
  return (Array.isArray(j.offers) ? j.offers : []).filter((o) => o && o.id && o.status === 'open' && Number(o.expiry || 0) > now
    && String(o.bid_id || '') === String(ctx.bidId || '') && String(o.buyerXonly || '') === String(ctx.pubHex || '').slice(2));
}

// The policy speaks of a record's `amount` and `price_sats`, as an intent carries them.
export const boundOfferAsRecord = (o) => ({ amount: String(o.amount), price_sats: Number(o.priceSats) });

export async function attemptBoundFill(ctx, state, offer) {
  const gate = bidPolicy(ctx, state, boundOfferAsRecord(offer));
  if (!gate.ok) return { ok: false, refused: true, reason: `offer fails policy: ${gate.reason}` };
  if (ctx.dryRun) { ctx.log('info', 'DRY RUN — would take the bound offer', { offer: offer.id }); return { ok: false, dry: true }; }
  try {
    const t = await ctx.dapp.takeBoundOffer({ offer, bidPriv: ctx.priv });
    return { ok: true, txid: t?.revealTxid || null, settledAmt: gate.amt, note: t?.buyerNote ? { txid: t.buyerNote.txid, vout: 0, amount: String(t.buyerNote.amount) } : null };
  } catch (e) {
    // an offer whose checks fail is refused for good; a broadcast that did not go through is tried again next cycle
    if (/does not check|does not verify|bound note|another asset|not in the reflection|commitment is not/.test(e.message)) return { ok: false, refused: true, reason: e.message };
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
  const bound = ctx.kind === 'bound';
  const intents = bound ? await fetchCandidateBoundOffers(ctx) : await fetchCandidateIntents(ctx);
  let fills = 0;
  for (const it of intents) {
    const id = String(bound ? it.id : it.intent_id).toLowerCase();
    if (state.processed[id]) continue;
    const gate = bidPolicy(ctx, state, bound ? boundOfferAsRecord(it) : it);
    if (!gate.ok) { ctx.log('info', 'intent skipped by policy', { intent_id: id, reason: gate.reason }); continue; }
    const r = bound ? await attemptBoundFill(ctx, state, it) : await attemptFill(ctx, state, it);
    if (r.ok) {
      const settled = r.settledAmt != null ? r.settledAmt : gate.amt;
      state.processed[id] = { txid: r.txid, at: Math.floor(Date.now() / 1000), amount: settled.toString(), ...(r.note ? { note: r.note } : {}) };
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

// ---- giving a finished bid's wallet back to its owner ----
//
// Once a bid is filled, or an hour past its expiry, whatever its wallet holds (bought tokens, unspent sats) goes to the
// owner's key from the registration. That key is bound to the bid key by the registration's ciphertext, so the bid is
// not serviced if it was changed. A wallet with an unconfirmed output waits; one that is not emptied is tried again
// after a growing pause, up to a limit.
export const RETURN_RETRY_SEC = 600;
export const RETURN_RETRY_MAX_SEC = 6 * 3600;
export const RETURN_MAX_ATTEMPTS = 30;

export function returnDue(rec, dapp, now) {
  if (!rec || rec.returned_at || (rec.return_attempts || 0) >= RETURN_MAX_ATTEMPTS) return false;
  return dapp.watchtowerBidFinished(rec, now) && now >= (rec.return_next || 0);
}

export async function returnToOwner(ctx) {
  bindWallet(ctx);
  const dapp = ctx.dapp;
  const before = await dapp.getUtxos(ctx.address);
  if (!before.length) return { done: true, swept: 0, assets: [] };
  if (before.some((u) => u.status && u.status.confirmed === false)) return { done: false, pending: true, swept: 0, assets: [] };
  // a bound bid's note sits at the bid key's Taproot address, which the owner's key derives (dapp moveBoundNoteHome): only sats go back here
  const r = await dapp.sweepWatchtowerBidWallet(ctx.priv, ctx.kind === 'bound' ? [] : [ctx.assetId], { to: ctx.ownerPub });
  const after = await dapp.getUtxos(ctx.address);
  return { done: after.length === 0, swept: r.swept || 0, assets: r.assets || [], txid: r.txid || r.asset_txid || null };
}

// One return for a registration: build its context, give the wallet back, record the outcome, and store the record.
export async function giveBack(rec, now, { ctxFor, put }) {
  const ctx = ctxFor(rec);
  let r = { done: false };
  if (ctx) {
    try {
      r = await returnToOwner(ctx);
      if (r.done) ctx.log('info', 'bid wallet returned to owner', { swept_sats: r.swept, assets: r.assets.length, txid: r.txid });
      else if (r.pending) ctx.log('info', 'bid wallet has an unconfirmed output — return waits');
    } catch (e) { ctx.log('warn', 'return to owner failed', { err: e.message }); }
  }
  noteReturn(rec, r, now);
  await put(rec);
  return r;
}

export function noteReturn(rec, r, now) {
  if (r && r.done) {
    rec.status = 'returned';
    rec.returned_at = now;
    delete rec.return_next;
  } else if (r && r.pending) {
    rec.return_next = now + RETURN_RETRY_SEC;
  } else {
    rec.return_attempts = (rec.return_attempts || 0) + 1;
    rec.return_next = now + Math.min(RETURN_RETRY_MAX_SEC, RETURN_RETRY_SEC * 2 ** (rec.return_attempts - 1));
  }
  return rec;
}
