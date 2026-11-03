// The holder of a Bitcoin-to-Bitcoin swap (dapp/btcswap.js): locks its note for the desk, checks the desk's lock of TAC the
// bridge's proof follows, claims it by key path with the desk's adapted half of the signature, and is done; or takes its
// note back once its timelock has run.
//
// One record per swap, persisted before each step that sends something, advanced by step(); steps of one record run one
// at a time. t, T and the lock's blinding follow the seed and the swap id (adaptor-xswap deriveSwapSecrets), and the lock
// carries the same recovery hint the fast bridge's does, so the refund needs only the key and the chain.
//
// Rules the steps keep:
//   - the desk's lock is believed only from the chain: its output key (the joint key of the two parties' keys), its
//     opening, the validator's note, its confirmations, and that the proof follows it (checkDeskOffer)
//   - the claim is sent only while `claimLeftBlocks` remain before the desk's refund opens: a claim that confirms after
//     the desk has refunded would still have published t
//   - a secret nonce signs once: the partial signature is stored, and the nonce wiped, in the same save, before it is sent
//
// Phases:  built -> broadcast -> offered -> claiming -> claimed -> done
//          refund path, from any phase before the claim is sent: refund-wait -> refunded       desk-took (the desk opened the lock)
//
// ctx = { seed, now(), policy, store, btc, desk, tracking }
//   policy   { csvBlocks, minConfs (desk lock, 2), offerWaitSecs, claimLeftBlocks, trackAhead (true) }
//   btc      the fast bridge's Bitcoin seam (dapp/fastbridge-btc.js): prims, wallet, tx, satsUtxos, feeRate, broadcast(pair),
//            fetchTx, status, tip, outspend, resolveNote
//   desk     { offer({ quoteId, offer }) -> { ok, retry?, why? }, status(id) -> { phase, deskOffer?, why? },
//              nonce(id, body) -> { pubnonce }, sign(id, body) -> { psig } }
//   tracking(notes [{ txid, vout, height }]) -> Map 'txid:vout' -> 'tracked' | 'bound' | 'new' | 'untracked'

import * as X from './adaptor-xswap.js';
import * as S from './btcswap.js';
import * as M from './musig2.js';
import { bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';

const hx = bytesToHex;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
// what a desk lock still lacks while it settles, as against what is wrong with it
const WAITING = /confirmation|does not follow/;

export function makeBtcSwapHolder(ctx) {
  const { seed, store, policy, btc, desk } = ctx;
  const P = { ...S.DEFAULTS, minConfs: 2, offerWaitSecs: 12 * 3600, trackAhead: true, ...policy };
  const secrets = (rec) => X.deriveSwapSecrets({ seed, swapId: hexToBytes(rec.id) });
  const lockOf = (rec) => S.holderLock({ prims: btc.prims, deskPub: rec.deskPub, T: secrets(rec).T, holderXonly: btc.wallet.xonly, csvBlocks: rec.csvBlocks });
  const jointOf = (rec) => S.jointLock({ prims: btc.prims, holderPub: btc.wallet.pub, deskPub: rec.deskOffer.lock.musigPub, deskXonly: rec.deskOffer.lock.deskXonly, csvBlocks: rec.deskOffer.lock.csvBlocks });
  const save = async (rec, patch) => { Object.assign(rec, patch, { updated: ctx.now() }); await store.put(rec); return rec; };
  const auth = (rec, path, body) => ({ ...body, auth: S.signRequest(btc.wallet.priv, rec.id, path, body) });
  const queues = new Map();
  const serial = (id, fn) => {
    const run = (queues.get(id) || Promise.resolve()).catch(() => {}).then(fn);
    queues.set(id, run);
    run.catch(() => {}).finally(() => { if (queues.get(id) === run) queues.delete(id); });
    return run;
  };

  // Builds the lock and stores it; sends nothing. `quote` is the desk's: { id, deskPub, out }.
  async function start({ asset, amount, notes, quote }) {
    if (!notes.length) throw new Error('btcswap: no note to lock');
    const swapId = X.swapIdOf(notes[0].txid, notes[0].vout), id = hx(swapId);
    if (await store.get(id)) throw new Error('btcswap: this note is already part of a swap');
    const sec = X.deriveSwapSecrets({ seed, swapId });
    const csvBlocks = P.csvBlocks ?? P.csvHolder;
    const lock = S.holderLock({ prims: btc.prims, deskPub: quote.deskPub, T: sec.T, holderXonly: btc.wallet.xonly, csvBlocks });
    const hint = X.lockHintScript({ seed, swapId, claimerPub: hexToBytes(strip(quote.deskPub)), csvBlocks, value: amount });
    const pair = btc.tx.lockTransfer({ asset, notes, lock, lockAmount: amount, rLock: sec.rLock, hint, satsUtxos: await btc.satsUtxos(), feeRate: await btc.feeRate() });
    const rec = {
      v: 1, role: 'holder', id, phase: 'built', created: ctx.now(), updated: ctx.now(), quoteId: quote.id,
      asset: hx(asset), amount: String(amount), out: String(quote.out), deskPub: strip(quote.deskPub), csvBlocks,
      lock: { txid: pair.revealTxid, vout: 0, value: pair.revealTx.outputs[0].value, commitTxid: pair.commitTxid, commitHex: pair.commitHex, revealHex: pair.revealHex },
      noteInputs: notes.map((n) => ({ txid: n.txid, vout: n.vout })),
    };
    await store.put(rec);
    return rec;
  }

  async function lockState(rec) {
    const st = await btc.status(rec.lock.txid);
    if (!st.confirmations) return null;
    if (await btc.outspend(rec.lock.txid, rec.lock.vout)) return 'spent';
    return (await btc.tip()) >= st.height + rec.csvBlocks - 1 ? 'due' : null;
  }

  async function maybeRefund(rec) {
    const st = await btc.status(rec.lock.txid);
    if (!st.confirmations || (await btc.tip()) < st.height + rec.csvBlocks - 1) return null;
    const spent = await btc.outspend(rec.lock.txid, rec.lock.vout);
    if (spent) return spent;
    if (!rec.refund) {
      const pair = btc.tx.refundTransfer({
        asset: hexToBytes(rec.asset), lockOut: { txid: rec.lock.txid, vout: rec.lock.vout, value: rec.lock.value }, lock: lockOf(rec), dLocker: btc.wallet.priv,
        amount: BigInt(rec.amount), rLock: secrets(rec).rLock, satsUtxos: await btc.satsUtxos(), feeRate: await btc.feeRate(),
      });
      await save(rec, { refund: { txid: pair.revealTxid, commitTxid: pair.commitTxid, commitHex: pair.commitHex, revealHex: pair.revealHex } });
    }
    await btc.broadcast({ ...rec.refund, revealTxid: rec.refund.txid });
    return null;
  }

  // Whether the proof follows the desk's lock: it does already, or it will (P.trackAhead) because the lock transaction is a
  // valid transfer whose every note input is tracked and signed so as to bind every output.
  async function followed(lockTx, txid, vout, height) {
    const own = await ctx.tracking([{ txid, vout, height }]);
    const t = own.get(`${txid}:${vout}`);
    if (t === 'tracked') return true;
    if (t !== 'new' || !P.trackAhead) return false;
    const ins = lockTx.vin.slice(1);
    if (!ins.length || !ins.every((i) => S.bindsAllOutputs(i.witness))) return false;
    const notes = [];
    for (const i of ins) {
      const p = await btc.fetchTx(i.txid);
      if (!p || !p.status || !p.status.confirmed) return false;
      notes.push({ txid: i.txid, vout: i.vout, height: p.status.block_height });
    }
    const m = await ctx.tracking(notes);
    return notes.every((n) => m.get(`${n.txid}:${n.vout}`) === 'tracked');
  }

  async function readDeskLock(rec, offer) {
    const l = offer.lock;
    const tx = await btc.fetchTx(l.txid);
    const out = tx && tx.vout[l.vout];
    if (!out) return null;
    const st = await btc.status(l.txid);
    const note = await btc.resolveNote(l.txid, l.vout);
    return {
      spk: out.scriptpubkey, commitment: note ? hx(note.commitment) : '', validNote: !!note && strip(note.assetIdHex) === rec.asset,
      confirmations: st.confirmations, height: st.height, tip: await btc.tip(), value: out.value,
      tracked: st.confirmations > 0 && (await followed(tx, l.txid, l.vout, st.height)),
    };
  }

  async function advance(rec) {
    if (['broadcast', 'offered', 'claiming'].includes(rec.phase) && !(rec.claim && rec.claim.sent)) {
      const state = await lockState(rec);
      if (state === 'spent') return save(rec, { phase: 'desk-took', why: 'the lock was spent before a claim was sent' });
      if (state === 'due') return save(rec, { phase: 'refund-wait', why: 'the timelock has run' });
    }
    switch (rec.phase) {
      case 'built': {
        await btc.broadcast({ ...rec.lock, revealTxid: rec.lock.txid });
        return save(rec, { phase: 'broadcast', broadcastAt: ctx.now() });
      }
      case 'broadcast': {
        const st = await btc.status(rec.lock.txid);
        if (!st.confirmations) return rec;
        if (!rec.confirmedAt) await save(rec, { confirmedAt: ctx.now(), lockHeight: st.height });
        const sec = secrets(rec);
        const offer = S.makeHolderOffer({
          swapId: hexToBytes(rec.id), asset: rec.asset, value: BigInt(rec.amount), rLock: sec.rLock, txid: rec.lock.txid, vout: rec.lock.vout,
          csvBlocks: rec.csvBlocks, holderPub: btc.wallet.pub, T: sec.T, deskPub: rec.deskPub, out: BigInt(rec.out),
        });
        let answer;
        try { answer = await desk.offer({ quoteId: rec.quoteId, offer }); } catch (e) {
          if (ctx.now() - rec.confirmedAt > P.offerWaitSecs) return save(rec, { phase: 'refund-wait', why: 'the desk could not be reached' });
          throw e;
        }
        if (answer && answer.ok === false) {
          if (answer.retry && ctx.now() - rec.confirmedAt <= P.offerWaitSecs) return rec;
          return save(rec, { phase: 'refund-wait', why: 'the desk declined: ' + answer.why });
        }
        return save(rec, { phase: 'offered', offeredAt: ctx.now() });
      }
      case 'offered': {
        const s = await desk.status(rec.id);
        const late = ctx.now() - rec.offeredAt > P.offerWaitSecs;
        if (s && (s.phase === 'aborted' || s.phase === 'rejected')) return save(rec, { phase: 'refund-wait', why: 'the desk gave up: ' + (s.why || s.phase) });
        if (!s || !s.deskOffer) return late ? save(rec, { phase: 'refund-wait', why: 'the desk never locked' }) : rec;
        const chain = await readDeskLock(rec, s.deskOffer);
        if (!chain) return late ? save(rec, { phase: 'refund-wait', why: 'the desk\'s lock never showed' }) : rec;
        const v = S.checkDeskOffer(s.deskOffer, { prims: btc.prims, holderPub: btc.wallet.pub, expect: { swapId: rec.id, asset: rec.asset, amount: rec.out }, chain, minConfs: P.minConfs, policy: P });
        if (v.ok) return save(rec, { phase: 'claiming', deskOffer: s.deskOffer, deskLock: { value: chain.value, height: chain.height } });
        if (v.reasons.every((r) => WAITING.test(r)) && !late) return save(rec, { waiting: v.reasons.join('; ') });
        return save(rec, { phase: 'refund-wait', why: 'the desk\'s lock: ' + v.reasons.join('; ') });
      }
      case 'claiming': {
        const l = rec.deskOffer.lock, joint = jointOf(rec);
        const tooLate = async () => (await btc.tip()) + P.claimLeftBlocks > rec.deskLock.height + l.csvBlocks - 1;
        if (!rec.claim) {
          if (await tooLate()) return save(rec, { phase: 'refund-wait', why: 'too little time left before the desk\'s refund' });
          const pair = btc.tx.jointClaimTransfer({
            asset: hexToBytes(rec.asset), lockOut: { txid: l.txid, vout: l.vout, value: rec.deskLock.value }, lock: joint,
            amount: BigInt(l.amount), rLock: BigInt('0x' + l.rLock), satsUtxos: await btc.satsUtxos(), feeRate: await btc.feeRate(),
          });
          return save(rec, { claim: { txid: pair.revealTxid, commitTxid: pair.commitTxid, commitHex: pair.commitHex, revealJson: pair.revealJson, sighash: hx(pair.sighash) } });
        }
        if (!rec.nonce) {
          const n = M.nonceGen({ sk: btc.wallet.priv, pk: btc.wallet.pub, aggXonly: joint.keys.xonly, msg: hexToBytes(rec.claim.sighash) });
          return save(rec, { nonce: { sec: hx(n.secnonce), pub: hx(n.pubnonce) } });
        }
        if (!rec.deskNonce) {
          const r = await desk.nonce(rec.id, auth(rec, 'nonce', { msg: rec.claim.sighash, pubnonce: rec.nonce.pub }));
          if (!r || !/^[0-9a-f]{132}$/.test(strip(r.pubnonce || ''))) throw new Error('the desk gave no nonce' + (r && r.why ? ': ' + r.why : ''));
          return save(rec, { deskNonce: strip(r.pubnonce) });
        }
        const sess = M.session({ keys: joint.keys, pubnonces: [hexToBytes(rec.nonce.pub), hexToBytes(rec.deskNonce)], msg: hexToBytes(rec.claim.sighash), T: secrets(rec).T });
        if (!rec.psig) {
          if (await tooLate()) return save(rec, { phase: 'refund-wait', why: 'too little time left before the desk\'s refund' });
          const psig = M.partialSign({ secnonce: hexToBytes(rec.nonce.sec), sk: btc.wallet.priv, sess });
          return save(rec, { psig: hx(psig), nonce: { pub: rec.nonce.pub, sec: null } });
        }
        if (!rec.claim.revealHex) {
          const r = await desk.sign(rec.id, auth(rec, 'sign', { pubnonce: rec.nonce.pub, psig: rec.psig }));
          const theirs = r && strip(r.psig || '');
          if (!theirs || !M.partialVerify({ psig: hexToBytes(theirs), pubnonce: hexToBytes(rec.deskNonce), pk: hexToBytes(l.musigPub), sess })) throw new Error('the desk\'s half of the signature does not verify' + (r && r.why ? ': ' + r.why : ''));
          const sPre = M.partialAgg({ psigs: [hexToBytes(rec.psig), hexToBytes(theirs)], sess });
          if (!M.preVerify({ sPre, sess })) throw new Error('the joint pre-signature does not verify');
          const sig = M.adapt({ sPre, t: secrets(rec).t, sess });
          const done = btc.tx.withKeyPathSig({ revealJson: rec.claim.revealJson, sighash: hexToBytes(rec.claim.sighash), sig, outputXonly: joint.outputXonly });
          return save(rec, { claim: { ...rec.claim, revealJson: done.revealJson, revealHex: done.revealHex } });
        }
        if (!rec.claim.sent) {
          if (await btc.outspend(l.txid, l.vout)) return save(rec, { phase: 'refund-wait', why: 'the desk\'s lock was spent before the claim' });
          if (await tooLate()) return save(rec, { phase: 'refund-wait', why: 'too little time left before the desk\'s refund' });
          // marked sent before it is: once it may be out, t may be public, and the holder's own refund is no longer safe to want
          await save(rec, { claim: { ...rec.claim, sent: ctx.now() } });
        }
        await btc.broadcast({ ...rec.claim, revealTxid: rec.claim.txid });
        return save(rec, { phase: 'claimed', claimedAt: ctx.now() });
      }
      case 'claimed': {
        const st = await btc.status(rec.claim.txid);
        if (st.confirmations) return save(rec, { phase: 'done', doneAt: ctx.now(), note: { txid: rec.claim.txid, vout: 0, amount: rec.deskOffer.lock.amount } });
        const by = await btc.outspend(rec.deskOffer.lock.txid, rec.deskOffer.lock.vout);
        if (by && by !== rec.claim.txid) return save(rec, { phase: 'refund-wait', why: 'the desk refunded its lock before the claim confirmed' });
        await btc.broadcast({ ...rec.claim, revealTxid: rec.claim.txid });
        return rec;
      }
      case 'refund-wait': {
        const taken = await maybeRefund(rec);
        if (taken) return save(rec, { phase: taken === rec.refund?.txid ? 'refunded' : 'desk-took', takenBy: taken });
        if (rec.refund && (await btc.status(rec.refund.txid)).confirmations) return save(rec, { phase: 'refunded' });
        return rec;
      }
      default:
        return rec;
    }
  }

  function step(rec) {
    return serial(rec.id, async () => {
      const cur = (await store.get(rec.id)) || rec;
      try { return await advance(cur); } catch (e) { return save(cur, { lastError: String((e && e.message) || e).slice(0, 300) }); }
    });
  }

  return { start, step };
}

export const holderDone = (rec) => ['done', 'refunded', 'desk-took'].includes(rec.phase);
