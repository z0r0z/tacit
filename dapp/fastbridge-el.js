// The Ethereum locker of a fast bridge swap: the party that checks the Bitcoin lock, locks the matching note in the
// pool, and takes the Bitcoin lock once the claim on Ethereum has shown it t. In Bitcoin -> Ethereum this is the
// liquidity provider; in Ethereum -> Bitcoin it is the user.
//
// One record per swap, persisted before each step that sends something and advanced by step(); steps of one record
// run one at a time. Each swap has exactly one lock, and no two locks share an L: the claim kernel is over (L, O).
// The lock's blinding follows the seed, the swap id and the whole adaptor point (evmLockBlinding); its deadline is
// computed once, from the block time at which the Bitcoin lock reached its confirmations, and stored. A lock that
// is stored is sent from its stored bytes, and a lock that may already be in the pool is looked up by its leaf before
// anything is built. The record is the safety state of the swap and is kept durably.
//
// What this side reads from the chain itself, and never takes from the offer: the lock transaction and the
// outpoints it spends (the swap id), the sats value of the lock output, the note the validator derives from it, its
// confirmations, whether the spent notes are already consumed on Ethereum, whether the lock output is still
// unspent, and whether its own lock is in the pool.
//
// Once the deadline and a margin have passed, the lock is refunded unless a claim has spent it; a claim that landed
// is looked for again before every refund step.
//
// Phases:  accepted -> locking -> locked -> offered -> taking -> done          or  ... -> refunding -> refunded
//          rejected / aborted before anything is locked
//
// ctx = { seed, now(), policy, store, quotes, btc, evm, counter }
//   quotes   { get(id) -> { btcAsset, btcValue, evmAsset, evmAmount, validUntil } | null }
//   policy   { minCsv, minConfsFor(value) -> n, evmWindowSecs, minClaimSecs, claimSlackSecs, maxAmount, minAmount, roundSecs,
//              refundMarginSecs (600), maxOfferAgeSecs (3600) }
//   btc      { prims, wallet:{ pub, priv, xonly }, tx (makeAdaptorBtcTx), satsUtxos(), feeRate(), broadcast(pair),
//              fetchTx(txid), status(txid) -> { confirmations, height }, tip(), blockTime(height), outspend(txid, vout),
//              resolveNote(txid, vout) -> { assetIdHex, commitment } | null, crossLaneBlocked(esploraTx) -> reason | null }
//   evm      { now() (the latest block's timestamp), lockNullifier(lockLeaf) -> hex,
//              lockOp({ rec, rEvmLock, T, deadline, recipient, refundXonly }) -> { op, lockLeaf } | null (note not ready),
//              refundOp({ rec, position }) -> op, submit(type, op) -> { jobId }, jobStatus(jobId) -> 'pending' | 'settled' | 'failed',
//              lockPosition(leaf) -> { lIndex, lPath, lockSetRoot } | null,
//              findClaim(lockNu) -> null (unspent) | [] (spent by a refund) | [z hex, ...] (spent by claims), refundKey(swapIdHex) -> { xonly } }
//   counter  { publishEvmOffer(swapIdHex, evmOffer) }

import * as X from './adaptor-xswap.js';
import * as adaptor from './adaptor-signature.js';
import { deriveLock, claimSecret } from './adaptor-btc-lock.js';
import { secp, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';
import { pedersenCommit } from './bulletproofs.js';

const hx = bytesToHex;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const DUST_P2TR = 330;

// The Ethereum deadline of a swap: the time of the block that gave the Bitcoin lock its confirmations, plus the
// window, rounded up to `roundSecs`.
export function lockDeadline({ blockTime, windowSecs, roundSecs = 600 }) {
  return Math.ceil((blockTime + windowSecs) / roundSecs) * roundSecs;
}

export function makeEthereumLocker(ctx) {
  const { seed, store, policy, quotes, btc, evm, counter } = ctx;
  const margin = policy.refundMarginSecs ?? 600;
  const maxOfferAge = policy.maxOfferAgeSecs ?? 3600;
  const save = async (rec, patch) => { Object.assign(rec, patch, { updated: ctx.now() }); await store.put(rec); return rec; };
  const sidOf = (rec) => hexToBytes(rec.id);

  // Work on one swap runs one step at a time, so two overlapping ticks never build the same thing twice.
  const queues = new Map();
  const serial = (id, fn) => {
    const run = (queues.get(id) || Promise.resolve()).catch(() => {}).then(fn);
    queues.set(id, run);
    run.catch(() => {}).finally(() => { if (queues.get(id) === run) queues.delete(id); });
    return run;
  };

  // The Bitcoin locker's offer, checked against the quote this side issued and the chain. Answers { ok: true, rec } once
  // the swap is stored, or { ok: false, retry, why } and stores nothing: a refusal is recomputed from the chain each
  // time, so a lock this side has not seen yet is not refused for good. A swap already stored answers with its record.
  function receive({ quoteId, offer }) {
    const id = strip((offer && offer.swapId) || '');
    return serial(id, () => receiveOnce({ quoteId, offer, id }));
  }

  async function receiveOnce({ quoteId, offer, id }) {
    const known = await store.get(id);
    if (known) return { ok: true, rec: known };
    const reject = (why, retry = false) => ({ ok: false, retry, why });
    const quote = await quotes.get(quoteId);
    if (!quote) return reject('unknown quote');
    if (ctx.now() > quote.validUntil) return reject('quote expired');
    let value, amount;
    try { value = BigInt(offer.btc.value); amount = BigInt(offer.evm.amount); } catch { return reject('malformed offer'); }
    if (value < BigInt(policy.minAmount) || value > BigInt(policy.maxAmount)) return reject('amount outside this side\'s limits');
    const tx = await btc.fetchTx(offer.btc.txid);
    if (!tx) return reject('the lock transaction is not on the chain', true);
    const out = tx.vout[offer.btc.vout];
    if (!out || !Number.isInteger(out.value) || out.value < DUST_P2TR) return reject('the lock output carries no spendable amount');
    const note = await btc.resolveNote(offer.btc.txid, offer.btc.vout);
    const st = await btc.status(offer.btc.txid);
    if (st.confirmations > 0 && ctx.now() - (await btc.blockTime(st.height)) > maxOfferAge) return reject('the offer arrived too late to be answered');
    const chain = {
      spk: out.scriptpubkey, commitment: note ? hx(note.commitment) : '', validNote: !!note && strip(note.assetIdHex) === strip(offer.btc.asset),
      confirmations: st.confirmations, noteInputs: tx.vin.slice(1).map((i) => ({ txid: i.txid, vout: i.vout })),
    };
    const v = X.verifyBtcLockOffer(offer, {
      prims: btc.prims, myClaimerPub: btc.wallet.pub,
      expect: { btcAsset: quote.btcAsset, btcValue: BigInt(quote.btcValue), evmAsset: quote.evmAsset, evmAmount: BigInt(quote.evmAmount) },
      chain, minConfs: 0, minCsv: policy.minCsv,
    });
    if (!v.ok) return reject(v.reasons.join('; '));
    if (value !== BigInt(quote.btcValue) || amount !== BigInt(quote.evmAmount)) return reject('the amounts differ from the quote');
    const consumed = await btc.crossLaneBlocked(tx);
    if (consumed) return reject('a spent note is already consumed on Ethereum: ' + consumed);
    const rec = {
      v: 1, role: 'el', id, phase: 'accepted', created: ctx.now(), updated: ctx.now(), quoteId, offer,
      lockTxid: offer.btc.txid, lockVout: offer.btc.vout, lockValue: out.value, csvBlocks: offer.btc.csvBlocks,
    };
    await store.put(rec);
    return { ok: true, rec };
  }

  const secretsOf = (rec) => {
    const T = secp.ProjectivePoint.fromHex(strip(rec.offer.T));
    return { T, rEvmLock: X.evmLockBlinding({ seed, swapId: sidOf(rec), T }) };
  };

  // What the pool says about the lock: nothing yet (null), a refund spent it ({ refunded }), a claim whose s opens T
  // ({ t }), or a claim that does not reveal t ({ lost }).
  async function readLock(rec) {
    const zs = await evm.findClaim(rec.lock.lockNu);
    if (!zs) return null;
    if (!zs.length) return { refunded: true };
    if (!rec.evmOffer) return { lost: true };
    const sTilde = BigInt('0x' + strip(rec.evmOffer.presign.sTilde));
    const T = secretsOf(rec).T;
    for (const z of zs) {
      const t = adaptor.evmKernelExtract(sTilde, BigInt(z));
      if (t !== 0n && adaptor.adaptorPoint(t).equals(T)) return { t: '0x' + t.toString(16).padStart(64, '0') };
    }
    return { lost: true };
  }
  const afterRead = (rec, r) => {
    if (r.t) return save(rec, { phase: 'taking', t: r.t });
    if (r.refunded) return save(rec, { phase: rec.refund ? 'refunded' : 'done', why: 'the lock was spent by a refund' });
    return save(rec, { phase: 'lost', why: 'the lock was claimed with a kernel that does not reveal t' });
  };

  async function advance(rec) {
    // From the deadline on, a lock that is stored or may be in the pool is watched and refunded whatever the phase.
    if (rec.lock && (rec.phase === 'locking' || rec.phase === 'locked') && (await evm.now()) > rec.deadline) {
      return save(rec, { phase: 'offered', noOffer: !rec.evmOffer });
    }
    switch (rec.phase) {
      case 'accepted': {
        const st = await btc.status(rec.lockTxid);
        const need = policy.minConfsFor(BigInt(rec.offer.btc.value));
        if (st.confirmations < need) return rec;
        if (await btc.outspend(rec.lockTxid, rec.lockVout)) return save(rec, { phase: 'aborted', why: 'the lock output was spent before it could be answered' });
        const consumed = await btc.crossLaneBlocked(await btc.fetchTx(rec.lockTxid));
        if (consumed) return save(rec, { phase: 'aborted', why: 'a spent note is already consumed on Ethereum: ' + consumed });
        const confirmedAt = await btc.blockTime(st.height + need - 1);
        const deadline = lockDeadline({ blockTime: confirmedAt, windowSecs: policy.evmWindowSecs, roundSecs: policy.roundSecs });
        const nowSecs = await evm.now();
        const tip = await btc.tip();
        const opens = X.btcRefundOpensAt({ lockHeight: st.height, csvBlocks: rec.csvBlocks, tipHeight: tip, nowSecs });
        const bad = X.checkEvmDeadline({ deadline, nowSecs, btcRefundOpens: opens, minClaimSecs: policy.minClaimSecs, claimSlackSecs: policy.claimSlackSecs });
        if (bad.length) return save(rec, { phase: 'aborted', why: bad.join('; ') });
        return save(rec, { phase: 'locking', deadline, lockHeight: st.height });
      }
      case 'locking': {
        const { T, rEvmLock } = secretsOf(rec);
        if (!rec.lock) {
          // Nothing is built twice: the leaf is a function of the swap, so the pool says whether an earlier attempt
          // landed, without a note to spend.
          const refund = await evm.refundKey(rec.id);
          const expected = '0x' + hx(X.adaptorLockLeaf({
            asset: rec.offer.evm.asset, L: pedersenCommit(BigInt(rec.offer.evm.amount), rEvmLock), T, deadline: rec.deadline,
            recipient: rec.offer.evm.recipient, locker: hx(refund.xonly),
          }));
          const lockNu = evm.lockNullifier(expected);
          if (await evm.lockPosition(expected)) return save(rec, { lock: { lockLeaf: expected, lockNu }, phase: 'locked' });
          const nowSecs = await evm.now();
          if (rec.deadline - nowSecs < policy.minClaimSecs) return save(rec, { phase: 'aborted', why: 'too late to lock' });
          const built = await evm.lockOp({ rec, rEvmLock, T, deadline: rec.deadline, recipient: rec.offer.evm.recipient, refundXonly: refund.xonly });
          if (!built) return rec;
          if (strip(built.lockLeaf) !== strip(expected)) return save(rec, { phase: 'aborted', why: 'the lock built is not the lock this swap names' });
          return save(rec, { lock: { lockLeaf: expected, lockNu, op: built.op } });
        }
        if (await evm.lockPosition(rec.lock.lockLeaf)) return save(rec, { phase: 'locked' });
        if (!rec.lock.jobId) {
          const nowSecs = await evm.now();
          // too late to answer, but the stored lock may already be on its way: it is watched and refunded, not forgotten
          if (rec.deadline - nowSecs < policy.minClaimSecs) return save(rec, { phase: 'offered', noOffer: true });
          const { jobId } = await evm.submit('adaptorlock', rec.lock.op);
          return save(rec, { lock: { ...rec.lock, jobId } });
        }
        const st = await evm.jobStatus(rec.lock.jobId);
        if (st === 'failed') return save(rec, { lock: { ...rec.lock, jobId: null }, lockFailures: (rec.lockFailures || 0) + 1 });
        return rec;
      }
      case 'locked': {
        const { T, rEvmLock } = secretsOf(rec);
        const refund = await evm.refundKey(rec.id);
        const evmOffer = X.makeEvmOffer({
          asset: rec.offer.evm.asset, amount: BigInt(rec.offer.evm.amount), rEvmLock, T, deadline: rec.deadline,
          recipient: rec.offer.evm.recipient, locker: hx(refund.xonly), rOut: BigInt('0x' + strip(rec.offer.evm.rOut)),
        });
        if (strip(evmOffer.lockLeaf) !== strip(rec.lock.lockLeaf)) return save(rec, { phase: 'aborted', why: 'the offer and the lock disagree' });
        await counter.publishEvmOffer(rec.id, evmOffer);
        return save(rec, { phase: 'offered', evmOffer });
      }
      case 'offered': {
        const r = await readLock(rec);
        if (r) return afterRead(rec, r);
        if ((await evm.now()) > rec.deadline + margin) return save(rec, { phase: 'refunding' });
        return rec;
      }
      case 'taking': {
        if (!rec.take) {
          const lock = deriveLock({ prims: btc.prims, claimerPub: btc.wallet.pub, T: secretsOf(rec).T, lockerXonly: hexToBytes(strip(rec.offer.btc.lockerXonly)), csvBlocks: rec.csvBlocks });
          const sk = claimSecret({ dClaimer: btc.wallet.priv, t: BigInt(rec.t), lock });
          const pair = btc.tx.claimTransfer({
            asset: hexToBytes(strip(rec.offer.btc.asset)), lockOut: { txid: rec.lockTxid, vout: rec.lockVout, value: rec.lockValue }, lock, sk,
            amount: BigInt(rec.offer.btc.value), rLock: BigInt('0x' + strip(rec.offer.btc.rLock)), satsUtxos: await btc.satsUtxos(), feeRate: await btc.feeRate(),
          });
          await save(rec, { take: { txid: pair.revealTxid, commitTxid: pair.commitTxid, commitHex: pair.commitHex, revealHex: pair.revealHex } });
        }
        await btc.broadcast(rec.take, null);
        if ((await btc.status(rec.take.txid)).confirmations) return save(rec, { phase: 'done' });
        return rec;
      }
      case 'refunding': {
        // a claim that landed after the refund was decided on still opens the Bitcoin lock
        const r = await readLock(rec);
        if (r && (r.t || r.lost)) return afterRead(rec, r);
        if (r && r.refunded) return save(rec, { phase: 'refunded' });
        if (!rec.refund) {
          const position = await evm.lockPosition(rec.lock.lockLeaf);
          if (!position) {
            if ((await evm.now()) > rec.deadline + margin + 3600) return save(rec, { phase: 'aborted', why: 'the lock never reached the pool' });
            return rec;
          }
          return save(rec, { refund: { op: await evm.refundOp({ rec, position }) } });
        }
        if (!rec.refund.jobId) {
          const { jobId } = await evm.submit('adaptorrefund', rec.refund.op);
          return save(rec, { refund: { ...rec.refund, jobId } });
        }
        const st = await evm.jobStatus(rec.refund.jobId);
        if (st === 'settled') return save(rec, { phase: 'refunded' });
        if (st === 'failed') return save(rec, { refund: { ...rec.refund, jobId: null } });
        return rec;
      }
      default:
        return rec;
    }
  }

  // One step; a failing adapter call is recorded and the phase kept, so the next tick tries again.
  function step(rec) {
    return serial(rec.id, async () => {
      const cur = (await store.get(rec.id)) || rec;
      try { return await advance(cur); } catch (e) { return save(cur, { lastError: String((e && e.message) || e).slice(0, 300) }); }
    });
  }

  return { receive, step };
}
