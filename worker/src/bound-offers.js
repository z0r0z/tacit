// Bound swap offers: a holder's signed offer to sell its WHOLE bridged note (v1) or a part of it (v2, pinned to one of the bid wallet's
// coins, signed SIGHASH_ALL: dapp/bound-swap.js sellerPinnedOffer) into a watchtower bid, completed by the watchtower
// (fulfiller/watchtower-core.mjs) as ONE generation-bound transfer (T_CXFER_BOUND 0x39, dapp/bound-swap.js). The reflection folds
// a plain transfer or sale (0x22/0x26) only for TAC, but folds 0x39 for any asset when the note's signature binds every output
// and the payload names this deployment; the offer's signature is ALL|ANYONECANPAY, made before the watchtower builds the commit,
// so the seller posts once and can go offline. Off unless BOUND_OFFERS_ENABLED=true (reads stay open).
//
//   POST   /assets/:asset/bound-offers              { offer, bid_id, owner_pubkey, expiry, sig }   (the seller's x-only key signs)
//   GET    /assets/:asset/bound-offers[?bid=<id>][&status=open|filled|all]   offers, newest first (open by default)
//   DELETE /assets/:asset/bound-offers/:id          { sig }   (the seller cancels)
//   POST   /assets/:asset/bound-offers/:id/filled   { reveal_txid, commit_txid, sig }   (the bid key: the watchtower reports the fill)
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

export const boundOffersEnabled = (env) => String(env?.BOUND_OFFERS_ENABLED ?? '') === 'true';
export const boundOfferKey = (network, asset, id) => `boundoffer:${network}:${asset}:${id}`;
const boundOfferPrefix = (network, asset) => `boundoffer:${network}:${asset}:`;
const te = new TextEncoder();
const hash160 = (b) => ripemd160(sha256(b));
const PRICE_MIN = 546, MAX_LIFE = 7 * 86400, U64 = 1n << 64n;
const H = (n) => new RegExp(`^[0-9a-f]{${n}}$`);

// What the seller signs (dapp/bound-swap.js boundOfferMsg is the same function): every field of the offer, the bid it answers, and
// how long it stands.
export function boundOfferMsg(network, o, bidIdHex, expiry) {
  return sha256(te.encode(['tacit-bound-offer-v1', network, o.assetId, bidIdHex, `${o.note.txid}:${o.note.vout}`, o.note.value, o.note.script, o.amount, o.priceSats,
    o.payoutScript, o.payload, (o.noteScripts || []).join(','), (o.witness || []).join(','), o.sellerPub, o.buyerXonly, o.chainBinding, expiry,
    ...(o.v === 2 ? ['v2', `${o.fund?.txid}:${o.fund?.vout}`, o.fund?.value, o.fund?.script, o.feeRate, o.commitTxid, o.revealTxid, o.buyerPub] : [])].join('|')));
}
export const boundOfferCancelMsg = (network, asset, id) => sha256(te.encode(`tacit-bound-offer-cancel-v1|${network}|${asset}|${id}`));
export const boundOfferFilledMsg = (network, asset, id, revealTxid) => sha256(te.encode(`tacit-bound-offer-filled-v1|${network}|${asset}|${id}|${revealTxid}`));

// The offer's own shape (null, or what is wrong). Ownership of the note: its script is the seller key's untweaked P2TR (a cross-out
// mint's address) or its P2WPKH; the payload's notes are the buyer's P2TR and the seller's zero change at its P2TR.
export function boundOfferShape(o, asset) {
  if (!o || typeof o !== 'object' || (o.v !== 1 && o.v !== 2)) return 'offer.v must be 1 (a whole note) or 2 (a pinned part)';
  if (o.kind !== 'taproot' && o.kind !== 'p2wpkh') return 'offer.kind must be taproot or p2wpkh';
  if (o.assetId !== asset) return 'offer.assetId is not this asset';
  if (!H(64).test(o.chainBinding || '')) return 'offer.chainBinding must be 32-byte hex';
  if (!/^\d+$/.test(String(o.amount || '')) || BigInt(o.amount) <= 0n || BigInt(o.amount) >= U64) return 'offer.amount must be a positive u64 string';
  if (!Number.isInteger(o.priceSats) || o.priceSats < PRICE_MIN) return `offer.priceSats must be an integer >= ${PRICE_MIN}`;
  if (!/^0[23][0-9a-f]{64}$/.test(o.sellerPub || '') || o.sellerXonly !== o.sellerPub.slice(2)) return 'offer.sellerPub / sellerXonly must be the seller\'s 33-byte key and its x-only half';
  if (!H(64).test(o.buyerXonly || '')) return 'offer.buyerXonly must be 32-byte hex';
  const n = o.note || {};
  if (!H(64).test(n.txid || '') || !Number.isInteger(n.vout) || n.vout < 0 || !Number.isInteger(n.value) || n.value < 1) return 'offer.note must name an outpoint and its sats value';
  const tr = '5120' + o.sellerXonly, wpkh = '0014' + bytesToHex(hash160(hexToBytes(o.sellerPub)));
  if (o.kind === 'taproot' ? n.script !== tr : n.script !== wpkh) return 'offer.note.script is not the seller key\'s';
  if (!/^39[0-9a-f]+$/.test(o.payload || '') || o.payload.length % 2 || o.payload.length > 16384) return 'offer.payload must be a 0x39 payload';
  // a whole note's zero change sits at the seller's P2TR; a pinned part's change at its P2WPKH (a note its wallet reads and can sell again)
  if (!Array.isArray(o.noteScripts) || o.noteScripts.length !== 2 || o.noteScripts[0] !== '5120' + o.buyerXonly || o.noteScripts[1] !== (o.v === 2 ? wpkh : tr)) return 'offer.noteScripts must be the buyer\'s P2TR, then the seller\'s';
  if (!/^[0-9a-f]{4,160}$/.test(o.payoutScript || '') || o.payoutScript.length % 2) return 'offer.payoutScript must be a script';
  const w = o.witness;
  if (!Array.isArray(w) || !w.every((x) => /^[0-9a-f]+$/.test(x) && x.length % 2 === 0)) return 'offer.witness must be hex items';
  const ht = o.v === 2 ? '01' : '81';
  if (o.kind === 'taproot' ? !(w.length === 1 && w[0].length === 130 && w[0].endsWith(ht)) : !(w.length === 2 && w[0].endsWith(ht) && w[1] === o.sellerPub)) return o.v === 2 ? 'offer.witness must be the note key\'s SIGHASH_ALL signature' : 'offer.witness must be the note key\'s ALL|ANYONECANPAY signature';
  if (o.v === 2) {
    const f = o.fund || {}, bx = o.buyerXonly;
    if (!/^0[23][0-9a-f]{64}$/.test(o.buyerPub || '') || o.buyerPub.slice(2) !== bx) return 'offer.buyerPub must be the bid\'s 33-byte key';
    if (!H(64).test(f.txid || '') || !Number.isInteger(f.vout) || f.vout < 0 || !Number.isInteger(f.value) || f.value < 1) return 'offer.fund must name the bid wallet\'s coin and its value';
    if (f.script !== '0014' + bytesToHex(hash160(hexToBytes(o.buyerPub))) && f.script !== '5120' + bx) return 'offer.fund.script is not the bid key\'s';
    if (!(typeof o.feeRate === 'number' && o.feeRate > 0 && o.feeRate <= 500)) return 'offer.feeRate must be a positive number of sats a vbyte';
    if (!H(64).test(o.commitTxid || '') || !H(64).test(o.revealTxid || '')) return 'offer.commitTxid / revealTxid must be 32-byte hex';
  }
  return null;
}

// deps: { jsonResponse, verifySchnorr(sig64, msg32, xonly32), watchtowerBidKey(network, ownerH160, bidId), now? }
export function makeBoundOffers(deps) {
  const { jsonResponse, verifySchnorr, watchtowerBidKey } = deps;
  const now = () => (deps.now ? deps.now() : Math.floor(Date.now() / 1000));
  const bidOf = async (env, network, ownerPub, bidId) => env.REGISTRY_KV.get(watchtowerBidKey(network, bytesToHex(hash160(hexToBytes(ownerPub))), bidId), 'json');

  async function post(asset, req, env, network, cors) {
    if (!boundOffersEnabled(env)) return jsonResponse({ error: 'bound offers are not currently accepted' }, 410, cors);
    let body;
    try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
    const o = body.offer, bidId = String(body.bid_id ?? '').toLowerCase(), ownerPub = String(body.owner_pubkey ?? '').toLowerCase(), expiry = Number(body.expiry), sig = String(body.sig ?? '').toLowerCase();
    const bad = boundOfferShape(o, asset);
    if (bad) return jsonResponse({ error: bad }, 400, cors);
    if (!H(32).test(bidId)) return jsonResponse({ error: 'bid_id must be 32 hex chars' }, 400, cors);
    if (!/^0[23][0-9a-f]{64}$/.test(ownerPub)) return jsonResponse({ error: 'owner_pubkey must be 33-byte compressed' }, 400, cors);
    const t = now();
    if (!Number.isInteger(expiry) || expiry <= t || expiry > t + MAX_LIFE) return jsonResponse({ error: 'expiry must be within the next 7 days' }, 400, cors);
    if (!H(128).test(sig)) return jsonResponse({ error: 'sig must be 128 hex chars' }, 400, cors);
    const msg = boundOfferMsg(network, o, bidId, expiry);
    if (!verifySchnorr(hexToBytes(sig), msg, hexToBytes(o.sellerXonly))) return jsonResponse({ error: 'invalid offer signature' }, 403, cors);
    const wt = await bidOf(env, network, ownerPub, bidId);
    if (!wt || wt.status !== 'active' || Number(wt.expiry || 0) <= t) return jsonResponse({ error: 'no active watchtower bid with that id' }, 404, cors);
    if (wt.kind !== 'bound') return jsonResponse({ error: 'that bid is not a bound (bridged token) bid' }, 409, cors);
    if (wt.asset_id !== asset) return jsonResponse({ error: 'that bid is for another asset' }, 409, cors);
    if (String(wt.bid_pubkey || '').slice(2) !== o.buyerXonly) return jsonResponse({ error: 'offer.buyerXonly is not that bid\'s key' }, 409, cors);
    if (o.v === 2 && String(wt.bid_pubkey || '') !== o.buyerPub) return jsonResponse({ error: 'offer.buyerPub is not that bid\'s key' }, 409, cors);
    const amount = BigInt(o.amount), remaining = BigInt(wt.bid_amount_base || '0') - BigInt(wt.filled_base || '0');
    if (amount > remaining) return jsonResponse({ error: `the bid takes at most ${remaining} more` }, 409, cors);
    // the seller asks no more per unit than the buyer bid: priceSats / amount <= bid_price_sats / bid_amount_base
    if (BigInt(o.priceSats) * BigInt(wt.bid_amount_base) > BigInt(wt.bid_price_sats) * amount) return jsonResponse({ error: 'the offer asks more per unit than the bid pays' }, 409, cors);
    const id = bytesToHex(msg);
    const rec = { id, ...o, bid_id: bidId, owner_pubkey: ownerPub, expiry, sig, status: 'open', created_at: t };
    await env.REGISTRY_KV.put(boundOfferKey(network, asset, id), JSON.stringify(rec), { expirationTtl: Math.max(60, expiry - t + 86400) });
    return jsonResponse({ ok: true, id, offer: rec }, 200, cors);
  }

  async function list(asset, url, env, network, cors) {
    const bid = String(url.searchParams.get('bid') ?? '').toLowerCase(), t = now(), prefix = boundOfferPrefix(network, asset), out = [];
    // ?status=filled lists a bid's fills (the owner finds the notes it bought); the default is the open book
    const want = ['filled', 'all'].includes(String(url.searchParams.get('status') ?? '')) ? String(url.searchParams.get('status')) : 'open';
    let cursor;
    for (let i = 0; i < 20; i++) {
      const page = await env.REGISTRY_KV.list({ prefix, cursor });
      for (const k of page.keys || []) {
        const v = await env.REGISTRY_KV.get(k.name, 'json');
        if (!v || (bid && v.bid_id !== bid)) continue;
        if (want === 'open' ? (v.status !== 'open' || Number(v.expiry || 0) <= t) : want === 'filled' ? v.status !== 'filled' : false) continue;
        out.push(v);
      }
      if (page.list_complete !== false || !page.cursor) break;
      cursor = page.cursor;
    }
    out.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return jsonResponse({ asset_id: asset, count: out.length, offers: out }, 200, cors);
  }

  async function cancel(asset, id, req, env, network, cors) {
    let body;
    try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
    const rec = await env.REGISTRY_KV.get(boundOfferKey(network, asset, id), 'json');
    if (!rec) return jsonResponse({ error: 'no such offer' }, 404, cors);
    const sig = String(body.sig ?? '').toLowerCase();
    if (!H(128).test(sig) || !verifySchnorr(hexToBytes(sig), boundOfferCancelMsg(network, asset, id), hexToBytes(rec.sellerXonly))) return jsonResponse({ error: 'invalid cancel signature' }, 403, cors);
    if (rec.status !== 'open') return jsonResponse({ error: `the offer is ${rec.status}` }, 409, cors);
    await env.REGISTRY_KV.put(boundOfferKey(network, asset, id), JSON.stringify({ ...rec, status: 'cancelled', cancelled_at: now() }), { expirationTtl: 86400 });
    return jsonResponse({ ok: true }, 200, cors);
  }

  async function filled(asset, id, req, env, network, cors) {
    let body;
    try { body = await req.json(); } catch { return jsonResponse({ error: 'invalid JSON body' }, 400, cors); }
    const rec = await env.REGISTRY_KV.get(boundOfferKey(network, asset, id), 'json');
    if (!rec) return jsonResponse({ error: 'no such offer' }, 404, cors);
    const reveal = String(body.reveal_txid ?? '').toLowerCase(), commit = String(body.commit_txid ?? '').toLowerCase(), sig = String(body.sig ?? '').toLowerCase();
    if (!H(64).test(reveal) || !H(64).test(commit)) return jsonResponse({ error: 'reveal_txid and commit_txid must be 32-byte hex' }, 400, cors);
    if (!H(128).test(sig) || !verifySchnorr(hexToBytes(sig), boundOfferFilledMsg(network, asset, id, reveal), hexToBytes(rec.buyerXonly))) return jsonResponse({ error: 'invalid fill signature (the bid key signs it)' }, 403, cors);
    if (rec.status === 'filled') return jsonResponse({ ok: true, offer: rec }, 200, cors);
    if (rec.status !== 'open') return jsonResponse({ error: `the offer is ${rec.status}` }, 409, cors);
    const next = { ...rec, status: 'filled', reveal_txid: reveal, commit_txid: commit, filled_at: now() };
    await env.REGISTRY_KV.put(boundOfferKey(network, asset, id), JSON.stringify(next), { expirationTtl: 30 * 86400 });
    // a self-take bid has no watchtower to count its fills: the fill counts here, and a bid filled in full is closed
    const wt = await bidOf(env, network, rec.owner_pubkey, rec.bid_id).catch(() => null);
    if (wt && wt.self_take && wt.status === 'active') {
      const filledBase = BigInt(wt.filled_base || '0') + BigInt(rec.amount);
      const done = filledBase >= BigInt(wt.bid_amount_base || '0');
      const k = watchtowerBidKey(network, bytesToHex(hash160(hexToBytes(rec.owner_pubkey))), rec.bid_id);
      await env.REGISTRY_KV.put(k, JSON.stringify({ ...wt, filled_base: filledBase.toString(), ...(done ? { status: 'filled' } : {}) }), { expirationTtl: Math.max(60, Number(wt.expiry || 0) - now() + 86400) });
    }
    return jsonResponse({ ok: true, offer: next }, 200, cors);
  }

  return { post, list, cancel, filled };
}
