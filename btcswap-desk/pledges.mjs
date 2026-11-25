// Pledges of tracked TAC that fund the desk's swaps, and standing sell offers (floors) from holders of stuck TAC.
//
// A pledge is tracked TAC locked in a Taproot output whose key path is the MuSig2 aggregate of the pledger's key and a key
// the desk derives per pledge, and whose script path refunds the pledger after `csvPledge` blocks. The desk spends it only
// by key path, and only with the pledger's half of the signature: a draw is a joint claim of the pledge lock into the desk's
// own wallet, co-signed by the pledger, who checks the amount, the discount and the swap before signing. The desk never
// holds a pledger's TAC under its own key alone. A pledge funds a swap only while the swap's discount is within the
// pledger's maxDiscountBps, and only while the pledge has more than a few blocks before its refund opens.
//
// The desk owes a pledger what it drew plus `pledgeReturnBps` of it, paid back from the desk's owned tracked TAC once the
// swap the draw funded has settled. If the desk holds too little owned TAC to repay, the repayment waits; the pledge is
// not drawn on again in the meantime. A pledger whose pledge has run out takes it back through the script path themselves;
// the desk never touches an expired pledge.
//
// A floor is a holder's standing offer to sell one stuck note at a discount of at most `maxDiscountBps`. The desk matches
// it when it quotes that note at a discount the floor covers, so the holder need not be online to accept the price.
//
// Pure except for the store and the chain reads the desk already makes.
// ctx = { seed, store, btc, inventory, tracking, signer, log, config }
//   config   { asset, csvPledge (144), minConfs (2), pledgeReturnBps (50), trackAhead (true) }
//   signer   ({ pledgeId, swapId, amount, discountBps, sighash, deskNonce, revealJson }) -> { pubnonce, psig } | null
//              the pledger's half of a draw's signature, or null when the pledger will not sign it

import { bytesToHex, hexToBytes, concatBytes } from '../dapp/vendor/tacit-deps.min.js';
import { bigintToBytes32 } from '../dapp/bulletproofs.js';
import * as S from '../dapp/btcswap.js';
import * as M from '../dapp/musig2.js';

const hx = bytesToHex;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const rand = (n) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; };
const DRAW_MARGIN = 6; // blocks a draw needs before the pledge's refund opens

export function makePledges(ctx) {
  const { seed, store, btc, inventory, tracking, signer } = ctx;
  const cfg = { asset: ctx.asset, csvPledge: 144, minConfs: 2, pledgeReturnBps: 50, trackAhead: true, ...ctx.config };
  const prims = btc.prims;
  const log = ctx.log || (() => {});
  const assetHex = strip(cfg.asset);
  const committedOf = (p) => (p.draws || []).filter((d) => ['allocated', 'requested', 'broadcast'].includes(d.phase)).reduce((s, d) => s + BigInt(d.amount), 0n);
  const remainingOf = (p) => BigInt(p.amount) - BigInt(p.drawn) - committedOf(p);

  const jointOf = (p) => S.jointLock({ prims, holderPub: p.pledgerPub, deskPub: p.joint.deskPub, deskXonly: p.joint.refundXonly, csvBlocks: p.csvBlocks, refundXonly: p.joint.refundXonly });
  const publicPledge = (p) => ({ id: p.id, phase: p.phase, amount: p.amount, maxDiscountBps: p.maxDiscountBps, csvBlocks: p.csvBlocks, fundedAt: p.fundedAt, expiryHeight: p.expiryHeight, drawn: p.drawn, owed: p.owed, repaid: p.repaid, committed: String(committedOf(p)), signerUrl: p.signerUrl, lock: p.lock || null });

  // Whether the proof follows a lock output: it does already, or it will because the lock transaction is a valid transfer
  // whose every note input is tracked and signed so as to bind every output (the holder's readDeskLock, same rule).
  async function followed(lockTx, txid, vout, height) {
    const own = await tracking([{ txid, vout, height }]);
    const t = own.get(`${txid}:${vout}`);
    if (t === 'tracked') return true;
    if (t !== 'new' || !cfg.trackAhead) return false;
    const ins = lockTx.vin.slice(1);
    if (!ins.length || !ins.every((i) => S.bindsAllOutputs(i.witness))) return false;
    const notes = [];
    for (const i of ins) {
      const p = await btc.fetchTx(i.txid);
      if (!p || !p.status || !p.status.confirmed) return false;
      notes.push({ txid: i.txid, vout: i.vout, height: p.status.block_height });
    }
    const m = await tracking(notes);
    return notes.every((n) => m.get(`${n.txid}:${n.vout}`) === 'tracked');
  }

  // ── pledges ──
  async function offer({ pledgerPub, pledgerXonly, amount, maxDiscountBps, signerUrl }) {
    if (!HEX(66).test(strip(pledgerPub || '')) || !HEX(64).test(strip(pledgerXonly || ''))) throw new Error('pledges: the pledger key is malformed');
    if (!/^\d{1,30}$/.test(String(amount)) || BigInt(amount) <= 0n) throw new Error('pledges: the amount must be a whole number');
    if (!Number.isInteger(maxDiscountBps) || maxDiscountBps < 0 || maxDiscountBps > 10000) throw new Error('pledges: maxDiscountBps is 0 to 10000');
    if (signerUrl != null && typeof signerUrl !== 'string') throw new Error('pledges: signerUrl must be a URL');
    const id = 'pl-' + hx(rand(8));
    const sec = S.pledgeSecrets({ seed, pledgeId: hexToBytes(id.slice(3)) });
    const joint = S.jointLock({ prims, holderPub: pledgerPub, deskPub: sec.pub, deskXonly: pledgerXonly, csvBlocks: cfg.csvPledge, refundXonly: pledgerXonly });
    const rec = { v: 1, id, phase: 'offered', pledgerPub: strip(pledgerPub), pledgerXonly: strip(pledgerXonly), signerUrl: signerUrl || null,
      amount: String(amount), maxDiscountBps, csvBlocks: cfg.csvPledge, lock: null, fundedAt: null, expiryHeight: null,
      drawn: '0', owed: '0', repaid: '0', draws: [],
      joint: { spk: hx(joint.spk), outputXonly: hx(joint.outputXonly), controlBlock: hx(joint.controlBlock), leafHash: hx(joint.leafHash), deskPub: hx(sec.pub), refundXonly: strip(pledgerXonly) } };
    await store.put(rec);
    return { pledgeId: id, amount: String(amount), rLock: hx(bigintToBytes32(sec.rLock)), csvBlocks: cfg.csvPledge, spk: hx(joint.spk), outputXonly: hx(joint.outputXonly), deskPub: hx(sec.pub) };
  }

  async function fund({ id, lock }) {
    const rec = await store.get(id);
    if (!rec || !String(rec.id).startsWith('pl-')) return { ok: false, why: 'no such pledge' };
    if (rec.phase !== 'offered') return { ok: false, why: 'this pledge is already funded' };
    if (!HEX(64).test(strip(lock.txid || '')) || !Number.isInteger(lock.vout) || lock.vout < 0) return { ok: false, why: 'malformed lock' };
    const sec = S.pledgeSecrets({ seed, pledgeId: hexToBytes(id.slice(3)) });
    const tx = await btc.fetchTx(strip(lock.txid));
    const out = tx && tx.vout[lock.vout];
    if (!out) return { ok: false, why: 'the lock transaction is not on the chain' };
    const st = await btc.status(strip(lock.txid));
    const note = await btc.resolveNote(strip(lock.txid), lock.vout);
    const chain = { spk: out.scriptpubkey, commitment: note ? hx(note.commitment) : '', validNote: !!note && strip(note.assetIdHex) === assetHex,
      confirmations: st.confirmations, height: st.height, tip: await btc.tip(), value: out.value,
      tracked: st.confirmations > 0 && (await followed(tx, strip(lock.txid), lock.vout, st.height)) };
    const offerRec = { v: 1, swapId: id, lock: { asset: assetHex, amount: rec.amount, rLock: hx(bigintToBytes32(sec.rLock)), txid: strip(lock.txid), vout: lock.vout, csvBlocks: rec.csvBlocks, deskXonly: rec.pledgerXonly, musigPub: rec.joint.deskPub } };
    const v = S.checkDeskOffer(offerRec, { prims, holderPub: rec.pledgerPub, expect: { swapId: id, asset: assetHex, amount: rec.amount }, chain, minConfs: cfg.minConfs, minCsv: 1, policy: { lockDelayBlocks: 0, csvDesk: 0, takeMarginBlocks: 0 } });
    if (!v.ok) return { ok: false, why: v.reasons.join('; ') };
    rec.phase = 'funded';
    rec.lock = { txid: strip(lock.txid), vout: lock.vout, value: out.value, height: st.height, amount: rec.amount, blinding: hx(bigintToBytes32(sec.rLock)) };
    rec.fundedAt = st.height;
    rec.expiryHeight = st.height + rec.csvBlocks;
    await store.put(rec);
    log({ level: 'info', msg: 'pledge funded', id, amount: rec.amount });
    return { ok: true, pledge: publicPledge(rec) };
  }

  const get = async (id) => store.get(id);
  async function list() { return (await store.list()).filter((r) => String(r.id).startsWith('pl-')); }

  async function info() {
    const tip = await btc.tip();
    const ps = await list();
    const funded = ps.filter((p) => p.phase === 'funded' || p.phase === 'spent');
    return { pledged: String(funded.reduce((s, p) => s + BigInt(p.amount), 0n)),
      borrowed: String(ps.reduce((s, p) => s + BigInt(p.drawn) - BigInt(p.repaid), 0n)),
      owed: String(ps.reduce((s, p) => s + BigInt(p.owed), 0n)),
      available: String(await available(tip)), floors: (await floors()).length };
  }

  async function available(tip = null) {
    const t = tip ?? await btc.tip();
    let sum = 0n;
    for (const p of await list()) {
      if (p.phase !== 'funded' && p.phase !== 'spent') continue;
      if (BigInt(p.expiryHeight) <= BigInt(t) + BigInt(DRAW_MARGIN)) continue;
      sum += remainingOf(p);
    }
    return sum;
  }

  // The pledges that can fund a swap at this discount, earliest expiry first. The takes are written to the pledges before
  // the desk builds anything, so two swaps cannot draw the same TAC. A shortfall writes nothing.
  async function allocate({ swapId, want, discountBps, tip, exclude = [] }) {
    const t = tip ?? await btc.tip();
    const excluded = new Set(exclude);
    const ps = (await list())
      .filter((p) => !excluded.has(p.id) && (p.phase === 'funded' || p.phase === 'spent') && p.maxDiscountBps >= discountBps && BigInt(p.expiryHeight) > BigInt(t) + BigInt(DRAW_MARGIN) && remainingOf(p) > 0n)
      .sort((a, b) => (BigInt(a.expiryHeight) < BigInt(b.expiryHeight) ? -1 : 1));
    let left = BigInt(want);
    const takes = [];
    for (const p of ps) {
      if (left <= 0n) break;
      const take = remainingOf(p) < left ? remainingOf(p) : left;
      takes.push({ p, take });
      left -= take;
    }
    if (left > 0n) return null;
    const out = [];
    for (const { p, take } of takes) {
      const index = p.draws.length;
      p.draws.push({ swapId, amount: String(take), phase: 'allocated', index, txid: null });
      await store.put(p);
      out.push({ pledge: p, take, index });
    }
    return out;
  }

  // Give back a swap's allocation on one pledge, before the draw was built. A draw already broadcast is not released.
  async function release(swapId, pledgeId) {
    const p = await store.get(pledgeId);
    if (!p) return;
    const before = p.draws.length;
    p.draws = p.draws.filter((d) => !(d.swapId === swapId && d.phase === 'allocated'));
    if (p.draws.length !== before) await store.put(p);
  }

  // The draw itself: the whole lock note is spent, the drawn amount goes to the desk's own wallet and the rest returns
  // to the joint lock as change, so the pledge can be drawn on again. The sighash and the desk's nonce are for the
  // pledger to sign against. Nothing is spent yet; the pair is stored by the caller and signed once. A second draw on
  // the same pledge waits until the first confirms and the lock moves to its change note.
  async function buildDraw({ pledge, swapId, amount, index }) {
    if (!pledge.lock) throw new Error('pledges: this pledge holds nothing to draw');
    const inFlight = pledge.draws.find((d) => (d.phase === 'allocated' || d.phase === 'broadcast') && !(d.swapId === swapId && d.index === index));
    if (inFlight) throw new Error('pledges: this pledge has a draw in flight');
    const sec = S.pledgeSecrets({ seed, pledgeId: hexToBytes(pledge.id.slice(3)) });
    const joint = jointOf(pledge);
    const change = BigInt(pledge.lock.amount) - BigInt(amount);
    if (change < 0n) throw new Error('pledges: this draw is more than the pledge holds');
    const changeRLock = S.changeSecrets({ seed, pledgeId: hexToBytes(pledge.id.slice(3)), index }).rLock;
    const pair = btc.tx.jointClaimSplit({ asset: hexToBytes(assetHex),
      lockOut: { txid: pledge.lock.txid, vout: pledge.lock.vout, value: pledge.lock.value, amount: BigInt(pledge.lock.amount), blinding: BigInt('0x' + pledge.lock.blinding) },
      lock: { spk: hexToBytes(pledge.joint.spk), outputXonly: hexToBytes(pledge.joint.outputXonly) },
      amount: BigInt(amount), changeAmount: change, changeRLock,
      satsUtxos: await btc.satsUtxos(), feeRate: await btc.feeRate() });
    const nonce = M.nonceGen({ sk: bigintToBytes32(sec.d), pk: sec.pub, aggXonly: joint.keys.xonly, msg: pair.sighash });
    return { pair, sighash: hx(pair.sighash), deskNonce: hx(nonce.pubnonce), secnonce: hx(nonce.secnonce), rLock: pair.drawnBlinding, changeRLock: hx(bigintToBytes32(changeRLock)), changeAmount: String(change), index, value: pair.revealTx.outputs[0].value };
  }

  // The pledger's half, checked, and the desk's half, aggregated into the draw's signature. A null return is a refusal:
  // the pledger would not sign this draw, and the desk must not spend the pledge.
  async function signDraw({ pledge, swapId, amount, discountBps, built }) {
    if (!signer) return null;
    const joint = jointOf(pledge);
    const ans = await signer({ pledgeId: pledge.id, signerUrl: pledge.signerUrl, swapId, amount: String(amount), discountBps, sighash: built.sighash, deskNonce: built.deskNonce, revealJson: built.pair.revealJson });
    if (!ans || !HEX(132).test(strip(ans.pubnonce || '')) || !HEX(64).test(strip(ans.psig || ''))) return null;
    const sess = M.session({ keys: joint.keys, pubnonces: [hexToBytes(built.deskNonce), hexToBytes(ans.pubnonce)], msg: hexToBytes(built.sighash), T: null });
    if (!M.partialVerify({ psig: hexToBytes(ans.psig), pubnonce: hexToBytes(ans.pubnonce), pk: hexToBytes(pledge.pledgerPub), sess })) return null;
    const sec = S.pledgeSecrets({ seed, pledgeId: hexToBytes(pledge.id.slice(3)) });
    const mineP = M.partialSign({ secnonce: hexToBytes(built.secnonce), sk: sec.d, sess });
    const s = M.partialAgg({ psigs: [hexToBytes(ans.psig), mineP], sess });
    const sig = concatBytes(sess.Rf.toRawBytes(true).slice(1), bigintToBytes32(s));
    return btc.tx.withKeyPathSig({ revealJson: built.pair.revealJson, sighash: hexToBytes(built.sighash), sig, outputXonly: hexToBytes(pledge.joint.outputXonly) });
  }

  // A broadcast draw, confirmed: the drawn note joins the desk's inventory, and the pledge owes the drawn amount plus its
  // return. The lock moves to the change note the draw left behind, so the next draw spends that. The note is tracked
  // (its only input is the tracked pledge lock), so the desk can lock it at once.
  async function confirmDraw({ pledge, draw, height }) {
    const note = { txid: draw.txid, vout: 0, value: draw.value ?? 546, amount: BigInt(draw.amount), blinding: BigInt('0x' + draw.rLock), height };
    if (inventory.add) await inventory.add(note);
    else if (inventory.forget) inventory.forget();
    const ret = (BigInt(draw.amount) * BigInt(cfg.pledgeReturnBps)) / 10000n;
    pledge.drawn = String(BigInt(pledge.drawn) + BigInt(draw.amount));
    pledge.owed = String(BigInt(pledge.owed) + BigInt(draw.amount) + ret);
    const stub = pledge.draws.find((d) => d.swapId === draw.swapId && d.index === draw.index);
    if (stub) { stub.phase = 'confirmed'; stub.txid = draw.txid; }
    if (BigInt(draw.changeAmount ?? '0') > 0n) pledge.lock = { txid: draw.txid, vout: 1, value: 546, height, amount: draw.changeAmount, blinding: draw.changeRLock };
    else pledge.lock = null;
    if (BigInt(pledge.drawn) >= BigInt(pledge.amount)) pledge.phase = 'spent';
    await store.put(pledge);
    log({ level: 'info', msg: 'pledge drawn', id: pledge.id, swapId: draw.swapId, amount: draw.amount });
    return note;
  }

  // Repay a pledge from the desk's owned notes, once a swap it funded has settled. The payment is a plain transfer to the
  // pledger's address, on the ECDH channel, so the pledger finds and opens the note from the desk's public key alone.
  async function repay({ pledge, notes, amount }) {
    if (BigInt(amount) <= 0n || BigInt(amount) > BigInt(pledge.owed)) return { ok: false, why: 'nothing owed, or more than is owed' };
    const sum = notes.reduce((s, n) => s + BigInt(n.amount), 0n);
    if (sum < BigInt(amount)) return { ok: false, why: 'the desk holds too little owned TAC to repay' };
    const pair = btc.tx.payTransfer({ asset: hexToBytes(assetHex), notes, amount: BigInt(amount), recipientPub: hexToBytes(pledge.pledgerPub),
      satsUtxos: await btc.satsUtxos(), feeRate: await btc.feeRate() });
    await btc.broadcast({ ...pair, revealTxid: pair.revealTxid });
    pledge.repaid = String(BigInt(pledge.repaid) + BigInt(amount));
    pledge.owed = String(BigInt(pledge.owed) - BigInt(amount));
    if (BigInt(pledge.owed) === 0n && BigInt(pledge.drawn) > 0n) pledge.phase = 'repaid';
    await store.put(pledge);
    log({ level: 'info', msg: 'pledge repaid', id: pledge.id, amount: String(amount), txid: pair.revealTxid });
    return { ok: true, txid: pair.revealTxid };
  }

  // Pledges whose refund has opened: their allocations are given back, and the phase says so. The pledger takes the TAC
  // back through the script path themselves; the desk never spends an expired pledge.
  async function expire(tip = null) {
    const t = tip ?? await btc.tip();
    const out = [];
    for (const p of await list()) {
      if ((p.phase === 'funded' || p.phase === 'spent') && BigInt(p.expiryHeight) <= BigInt(t)) {
        p.phase = 'expired';
        p.draws = p.draws.filter((d) => d.phase === 'confirmed');
        await store.put(p);
        out.push(p.id);
      }
    }
    return out;
  }

  // ── floors ──
  async function floor({ holderPub, amount, maxDiscountBps, note }) {
    if (!HEX(66).test(strip(holderPub || ''))) throw new Error('pledges: the holder key is malformed');
    if (!/^\d{1,30}$/.test(String(amount)) || BigInt(amount) <= 0n) throw new Error('pledges: the amount must be a whole number');
    if (!Number.isInteger(maxDiscountBps) || maxDiscountBps < 0 || maxDiscountBps > 10000) throw new Error('pledges: maxDiscountBps is 0 to 10000');
    if (!note || !HEX(64).test(strip(note.txid || '')) || !Number.isInteger(note.vout) || note.vout < 0) throw new Error('pledges: the note is malformed');
    const rec = { v: 1, id: 'fl-' + hx(rand(8)), kind: 'floor', holderPub: strip(holderPub), amount: String(amount), maxDiscountBps,
      note: { txid: strip(note.txid), vout: note.vout }, created: Math.floor(Date.now() / 1000) };
    await store.put(rec);
    return { floorId: rec.id, amount: rec.amount, maxDiscountBps: rec.maxDiscountBps, note: rec.note };
  }

  async function floors() { return (await store.list()).filter((r) => String(r.id).startsWith('fl-')); }

  // The floor for this note that covers this discount, if one stands: the holder has already said they will sell at it.
  async function matchFloor(note, discountBps) {
    const key = `${strip(note.txid)}:${note.vout}`;
    const hit = (await floors()).find((f) => `${f.note.txid}:${f.note.vout}` === key && f.maxDiscountBps >= discountBps);
    return hit ? { floorId: hit.id, maxDiscountBps: hit.maxDiscountBps } : null;
  }

  return { offer, fund, get, list, floors, floor, matchFloor, info, available, allocate, release, buildDraw, signDraw, confirmDraw, repay, expire, publicPledge };
}
