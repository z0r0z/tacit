// The Bitcoin locker of a fast bridge swap: the party that holds the swap secret t, locks its Bitcoin note first and
// claims the Ethereum lock. In Bitcoin -> Ethereum this is the user; in Ethereum -> Bitcoin it is the liquidity provider.
//
// One record per swap, persisted before each step that sends something, advanced by step(). Everything the record
// does not hold is derived again from the seed and the chain (dapp/adaptor-xswap.js), so a lost record costs the
// swap's state and not its funds: the refund needs only the key and the chain.
//
// Rules the steps keep (each is a check on chain data the caller supplies, never on a counterparty's word):
//   - the counterparty's Bitcoin claim key is fixed before t exists; the lock is built to that key and no other
//   - the Ethereum offer is believed only when its lock leaf is found in the pool's lock set and its pre-signature
//     verifies against the output this side chose
//   - no claim is built with less than policy.minClaimSecs left on the Ethereum deadline, because a claim that
//     misses the deadline still publishes t
//   - the Bitcoin refund is taken once the timelock has run and the lock is still unspent
//
// Phases:  built -> broadcast -> offered -> claiming -> claimed(-> done)       refund path from any phase before claimed:
//          ... -> refund-wait -> refunded            counter-took  (the lock was spent by the counterparty with t)
//
// ctx = { seed, now(), policy, store, btc, evm, counter }
//   store    { get(id), put(rec), list() }
//   policy   { csvBlocks, minClaimSecs, offerWaitSecs, maxEvmWindowSecs }
//   btc      { prims, wallet:{ pub, priv, xonly }, tx (makeAdaptorBtcTx), satsUtxos(), feeRate(), broadcast(pair),
//              status(txid) -> { confirmations, height }, tip(), outspend(txid, vout) -> spending txid | null }
//   evm      { now(), lockPosition(leaf) -> { lIndex, lPath, lockSetRoot } | null,
//              recipient(swapIdHex) -> { xonly, priv }, claim({ rec, evmOffer, sec, position }) -> { jobId },
//              claimStatus(jobId) -> 'pending' | 'settled' | 'failed' }
//   counter  { sendOffer({ quoteId, offer }) -> { ok, retry?, why? }, getEvmOffer(swapIdHex) -> evmOffer | null }

import * as X from './adaptor-xswap.js';
import { deriveLock } from './adaptor-btc-lock.js';
import { bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';

const hx = bytesToHex;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();

export function makeBitcoinLocker(ctx) {
  const { seed, store, policy, btc, evm, counter } = ctx;
  const secrets = (rec) => X.deriveSwapSecrets({ seed, swapId: hexToBytes(rec.id) });
  const lockOf = (rec) => deriveLock({ prims: btc.prims, claimerPub: rec.counterClaimPub, T: secrets(rec).T, lockerXonly: btc.wallet.xonly, csvBlocks: rec.csvBlocks });
  const save = async (rec, patch) => { Object.assign(rec, patch, { updated: ctx.now() }); await store.put(rec); return rec; };

  // Builds the lock and stores it; sends nothing. `notes` are the wallet's own notes to lock from, `counterClaimPub` the
  // 33-byte Bitcoin key the counterparty committed to before this call.
  async function start({ asset, amount, notes, counterClaimPub, evmAsset, evmAmount, quoteId = null }) {
    if (!notes.length) throw new Error('fastbridge: no note to lock');
    const swapId = X.swapIdOf(notes[0].txid, notes[0].vout), id = hx(swapId);
    if (await store.get(id)) throw new Error('fastbridge: this note is already part of a swap');
    const sec = X.deriveSwapSecrets({ seed, swapId });
    const csvBlocks = policy.csvBlocks;
    const lock = deriveLock({ prims: btc.prims, claimerPub: counterClaimPub, T: sec.T, lockerXonly: btc.wallet.xonly, csvBlocks });
    const hint = X.lockHintScript({ seed, swapId, claimerPub: counterClaimPub, csvBlocks, value: amount });
    const pair = btc.tx.lockTransfer({ asset, notes, lock, lockAmount: amount, rLock: sec.rLock, hint, satsUtxos: await btc.satsUtxos(), feeRate: await btc.feeRate() });
    const rec = {
      v: 1, role: 'bl', id, phase: 'built', created: ctx.now(), updated: ctx.now(), quoteId,
      asset: hx(asset), amount: String(amount), evmAsset: strip(evmAsset), evmAmount: String(evmAmount),
      counterClaimPub: hx(counterClaimPub), csvBlocks,
      lock: { txid: pair.revealTxid, vout: 0, commitTxid: pair.commitTxid, commitHex: pair.commitHex, revealHex: pair.revealHex },
      noteInputs: notes.map((n) => ({ txid: n.txid, vout: n.vout })),
    };
    await store.put(rec);
    return rec;
  }

  // The Bitcoin refund, once the lock is old enough and still unspent.
  async function maybeRefund(rec) {
    const st = await btc.status(rec.lock.txid);
    if (!st.confirmations) return null;
    const tip = await btc.tip();
    if (tip < st.height + rec.csvBlocks - 1) return null;
    const spent = await btc.outspend(rec.lock.txid, rec.lock.vout);
    if (spent) return spent;
    if (!rec.refund) {
      const lock = lockOf(rec), sec = secrets(rec);
      const pair = btc.tx.refundTransfer({
        asset: hexToBytes(rec.asset), lockOut: { txid: rec.lock.txid, vout: rec.lock.vout, value: 546 }, lock, dLocker: btc.wallet.priv,
        amount: BigInt(rec.amount), rLock: sec.rLock, satsUtxos: await btc.satsUtxos(), feeRate: await btc.feeRate(),
      });
      await save(rec, { refund: { txid: pair.revealTxid, commitHex: pair.commitHex, revealHex: pair.revealHex, commitTxid: pair.commitTxid } });
    }
    await btc.broadcast(rec.refund, null);
    return null;
  }

  async function advance(rec) {
    switch (rec.phase) {
      case 'built': {
        await btc.broadcast(rec.lock, null);
        return save(rec, { phase: 'broadcast', broadcastAt: ctx.now() });
      }
      case 'broadcast': {
        const st = await btc.status(rec.lock.txid);
        if (!st.confirmations) return rec;
        if (!rec.confirmedAt) await save(rec, { confirmedAt: ctx.now(), lockHeight: st.height });
        const sec = secrets(rec), recipient = await evm.recipient(rec.id);
        const offer = X.makeBtcLockOffer({
          swapId: hexToBytes(rec.id), asset: rec.asset, value: BigInt(rec.amount), rLock: sec.rLock, txid: rec.lock.txid, vout: rec.lock.vout,
          csvBlocks: rec.csvBlocks, lockerXonly: btc.wallet.xonly, T: sec.T, claimerPub: rec.counterClaimPub,
          evm: { asset: rec.evmAsset, amount: BigInt(rec.evmAmount), recipient: hx(recipient.xonly), rOut: sec.rOut },
        });
        let answer;
        try { answer = await counter.sendOffer({ quoteId: rec.quoteId, offer }); } catch (e) {
          if (ctx.now() - rec.confirmedAt > policy.offerWaitSecs) return save(rec, { phase: 'refund-wait', why: 'the counterparty could not be reached' });
          throw e;
        }
        if (answer && answer.ok === false) {
          if (answer.retry && ctx.now() - rec.confirmedAt <= policy.offerWaitSecs) return rec;
          return save(rec, { phase: 'refund-wait', why: 'the counterparty declined: ' + answer.why });
        }
        return save(rec, { phase: 'offered', offeredAt: ctx.now() });
      }
      case 'offered': {
        const evmOffer = await counter.getEvmOffer(rec.id);
        // An offer whose lock the pool does not show yet is waited for, not refused: the lock may still be landing.
        const position = evmOffer ? await evm.lockPosition(evmOffer.lockLeaf) : null;
        if (!position) {
          if (ctx.now() - rec.offeredAt > policy.offerWaitSecs) return save(rec, { phase: 'refund-wait', why: evmOffer ? 'the offered lock never showed in the pool' : 'no Ethereum lock arrived' });
          return rec;
        }
        const nowSecs = await evm.now();
        const sec = secrets(rec), recipient = await evm.recipient(rec.id);
        const v = X.verifyEvmOffer(evmOffer, {
          mine: { T: sec.T, recipient: hx(recipient.xonly), rOut: sec.rOut },
          expect: { evmAsset: rec.evmAsset, evmAmount: BigInt(rec.evmAmount) }, inLockSet: true, nowSecs, minClaimSecs: policy.minClaimSecs,
        });
        if (!v.ok) return save(rec, { phase: 'refund-wait', why: 'offer: ' + v.reasons.join('; ') });
        if (evmOffer.deadline - nowSecs > policy.maxEvmWindowSecs) return save(rec, { phase: 'refund-wait', why: 'offer: the deadline is further out than this side accepts' });
        return save(rec, { phase: 'claiming', evmOffer, position, claimStartedAt: nowSecs });
      }
      case 'claiming': {
        if (!rec.claim) {
          const nowSecs = await evm.now();
          if (rec.evmOffer.deadline - nowSecs < policy.minClaimSecs) return save(rec, { phase: 'refund-wait', why: 'too little time left to claim safely' });
          const position = (await evm.lockPosition(rec.evmOffer.lockLeaf)) || rec.position;
          const { jobId } = await evm.claim({ rec, evmOffer: rec.evmOffer, sec: secrets(rec), position });
          return save(rec, { claim: { jobId, at: nowSecs } });
        }
        const st = await evm.claimStatus(rec.claim.jobId);
        if (st === 'settled') return save(rec, { phase: 'claimed', claimedAt: ctx.now() });
        if (st === 'failed') return save(rec, { claim: null, claimFailures: (rec.claimFailures || 0) + 1 });
        return rec;
      }
      case 'claimed': {
        // The Ethereum leg is done. The Bitcoin lock is the counterparty's to take; if it never does, the timelock
        // returns the note here.
        const spent = await btc.outspend(rec.lock.txid, rec.lock.vout);
        if (spent) return save(rec, { phase: 'done', takenBy: spent });
        const r = await maybeRefund(rec);
        if (r) return save(rec, { phase: 'done', takenBy: r });
        return rec;
      }
      case 'refund-wait': {
        const taken = await maybeRefund(rec);
        if (taken) return save(rec, { phase: taken === rec.refund?.txid ? 'refunded' : 'counter-took', takenBy: taken });
        if (rec.refund && (await btc.status(rec.refund.txid)).confirmations) return save(rec, { phase: 'refunded' });
        return rec;
      }
      default:
        return rec;
    }
  }

  // One step; a failing adapter call is recorded and the phase kept, so the next tick tries again.
  async function step(rec) {
    try { return await advance(rec); } catch (e) { return save(rec, { lastError: String((e && e.message) || e).slice(0, 300) }); }
  }

  return { start, step };
}
