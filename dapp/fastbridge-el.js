// The Ethereum locker of a fast bridge swap: the party that checks the Bitcoin lock, locks the matching note in the
// pool, and takes the Bitcoin lock once the claim on Ethereum has shown it t. In Bitcoin -> Ethereum this is the
// liquidity provider; in Ethereum -> Bitcoin it is the user.
//
// One record per swap, persisted before each step that sends something and advanced by step(). The Ethereum lock is a
// pure function of the seed and the chain: its blinding follows the swap id and T (evmLockBlinding), its deadline
// follows the block time at which the Bitcoin lock reached its confirmations (lockDeadline), so after a restart, or
// with the record gone, the same lock leaf comes out and the pool shows whether it is already there. Each swap has
// exactly one lock, and no two locks share an L: the claim kernel is over (L, O).
//
// What this side reads from the chain itself, and never takes from the offer: the lock transaction and the
// outpoints it spends (the swap id), the note the validator derives from the lock output, its confirmations, whether
// the spent notes are already consumed on Ethereum, whether the lock output is still unspent, and whether its own
// lock is in the pool.
//
// Phases:  accepted -> locking -> locked -> offered -> taking -> done          or  ... -> refunding -> refunded
//          rejected / aborted before anything is locked
//
// ctx = { seed, now(), policy, store, quotes, btc, evm, counter }
//   quotes   { get(id) -> { btcAsset, btcValue, evmAsset, evmAmount, validUntil } | null }
//   policy   { minCsv, minConfsFor(value) -> n, evmWindowSecs, minClaimSecs, claimSlackSecs, maxAmount, minAmount, roundSecs }
//   btc      { prims, wallet:{ pub, priv, xonly }, tx (makeAdaptorBtcTx), satsUtxos(), feeRate(), broadcast(pair),
//              fetchTx(txid), status(txid) -> { confirmations, height }, tip(), blockTime(height), outspend(txid, vout),
//              resolveNote(txid, vout) -> { assetIdHex, commitment } | null, crossLaneBlocked(esploraTx) -> reason | null }
//   evm      { now(), lockNullifier(lockLeaf) -> hex, lockOp({ rec, rEvmLock, T, deadline, recipient, refundXonly }) -> { op, lockLeaf } | null (note not ready),
//              refundOp({ rec, position }) -> op, submit(type, op) -> { jobId }, jobStatus(jobId) -> 'pending' | 'settled' | 'failed',
//              lockPosition(leaf) -> { lIndex, lPath, lockSetRoot } | null, lockSpent(lockNu) -> bool,
//              findClaim(lockNu) -> [z hex, ...] | null, refundKey(swapIdHex) -> { xonly } }
//   counter  { publishEvmOffer(swapIdHex, evmOffer) }

import * as X from './adaptor-xswap.js';
import * as adaptor from './adaptor-signature.js';
import { deriveLock, claimSecret } from './adaptor-btc-lock.js';
import { secp, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';
import { pedersenCommit } from './bulletproofs.js';

const hx = bytesToHex;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();

// The Ethereum deadline of a swap: the time of the block that gave the Bitcoin lock its confirmations, plus the
// window, rounded up to `roundSecs`. Both sides can compute it from the chain; the Ethereum locker needs it to find
// its own lock again.
export function lockDeadline({ blockTime, windowSecs, roundSecs = 600 }) {
  return Math.ceil((blockTime + windowSecs) / roundSecs) * roundSecs;
}

export function makeEthereumLocker(ctx) {
  const { seed, store, policy, quotes, btc, evm, counter } = ctx;
  const save = async (rec, patch) => { Object.assign(rec, patch, { updated: ctx.now() }); await store.put(rec); return rec; };
  const sidOf = (rec) => hexToBytes(rec.id);

  // The Bitcoin locker's offer, checked against the quote this side issued and the chain. Answers { ok: true, rec } once
  // the swap is stored, or { ok: false, retry, why } and stores nothing: a refusal is recomputed from the chain each
  // time, so a lock this side has not seen yet is not refused for good. A swap already stored answers with its record.
  async function receive({ quoteId, offer }) {
    const id = strip(offer.swapId);
    const known = await store.get(id);
    if (known) return { ok: true, rec: known };
    const reject = (why, retry = false) => ({ ok: false, retry, why });
    const quote = await quotes.get(quoteId);
    if (!quote) return reject('unknown quote');
    if (ctx.now() > quote.validUntil) return reject('quote expired');
    const value = BigInt(offer.btc.value), amount = BigInt(offer.evm.amount);
    if (value < BigInt(policy.minAmount) || value > BigInt(policy.maxAmount)) return reject('amount outside this side\'s limits');
    const tx = await btc.fetchTx(offer.btc.txid);
    if (!tx) return reject('the lock transaction is not on the chain', true);
    const out = tx.vout[offer.btc.vout];
    const note = out ? await btc.resolveNote(offer.btc.txid, offer.btc.vout) : null;
    const st = await btc.status(offer.btc.txid);
    const chain = {
      spk: out ? out.scriptpubkey : '', commitment: note ? hx(note.commitment) : '', validNote: !!note && strip(note.assetIdHex) === strip(offer.btc.asset),
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
    const rec = { v: 1, role: 'el', id, phase: 'accepted', created: ctx.now(), updated: ctx.now(), quoteId, offer, lockTxid: offer.btc.txid, lockVout: offer.btc.vout, csvBlocks: offer.btc.csvBlocks };
    await store.put(rec);
    return { ok: true, rec };
  }

  const secretsOf = (rec) => {
    const T = secp.ProjectivePoint.fromHex(strip(rec.offer.T));
    return { T, rEvmLock: X.evmLockBlinding({ seed, swapId: sidOf(rec), T }) };
  };

  async function advance(rec) {
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
          // landed, with or without a record of it and without a note to spend.
          const refund = await evm.refundKey(rec.id);
          const expected = '0x' + bytesToHex(X.adaptorLockLeaf({
            asset: rec.offer.evm.asset, L: pedersenCommit(BigInt(rec.offer.evm.amount), rEvmLock), T, deadline: rec.deadline,
            recipient: rec.offer.evm.recipient, locker: bytesToHex(refund.xonly),
          }));
          const lockNu = evm.lockNullifier(expected);
          if (await evm.lockPosition(expected)) return save(rec, { lock: { lockLeaf: expected, lockNu }, phase: 'locked' });
          const built = await evm.lockOp({ rec, rEvmLock, T, deadline: rec.deadline, recipient: rec.offer.evm.recipient, refundXonly: refund.xonly });
          if (!built) return rec;
          if (strip(built.lockLeaf) !== strip(expected)) return save(rec, { phase: 'aborted', why: 'the lock built is not the lock this swap names' });
          return save(rec, { lock: { lockLeaf: expected, lockNu, op: built.op } });
        }
        if (await evm.lockPosition(rec.lock.lockLeaf)) return save(rec, { phase: 'locked' });
        if (!rec.lock.jobId) {
          const nowSecs = await evm.now();
          if (rec.deadline - nowSecs < policy.minClaimSecs) return save(rec, { phase: 'aborted', why: 'too late to lock' });
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
        const zs = await evm.findClaim(rec.lock.lockNu);
        if (zs && zs.length === 0) return save(rec, { phase: 'done', why: 'the lock was spent by a refund' });
        if (zs) {
          const sTilde = BigInt('0x' + strip(rec.evmOffer.presign.sTilde));
          const T = secretsOf(rec).T;
          for (const z of zs) {
            const t = adaptor.evmKernelExtract(sTilde, BigInt(z));
            if (t !== 0n && adaptor.adaptorPoint(t).equals(T)) return save(rec, { phase: 'taking', t: '0x' + t.toString(16).padStart(64, '0') });
          }
          return save(rec, { phase: 'lost', why: 'the lock was claimed with a kernel that does not reveal t' });
        }
        const nowSecs = await evm.now();
        if (nowSecs > rec.deadline && !(await evm.lockSpent(rec.lock.lockNu))) return save(rec, { phase: 'refunding' });
        return rec;
      }
      case 'taking': {
        if (!rec.take) {
          const lock = deriveLock({ prims: btc.prims, claimerPub: btc.wallet.pub, T: secretsOf(rec).T, lockerXonly: hexToBytes(strip(rec.offer.btc.lockerXonly)), csvBlocks: rec.csvBlocks });
          const sk = claimSecret({ dClaimer: btc.wallet.priv, t: BigInt(rec.t), lock });
          const pair = btc.tx.claimTransfer({
            asset: hexToBytes(strip(rec.offer.btc.asset)), lockOut: { txid: rec.lockTxid, vout: rec.lockVout, value: 546 }, lock, sk,
            amount: BigInt(rec.offer.btc.value), rLock: BigInt('0x' + strip(rec.offer.btc.rLock)), satsUtxos: await btc.satsUtxos(), feeRate: await btc.feeRate(),
          });
          await save(rec, { take: { txid: pair.revealTxid, commitTxid: pair.commitTxid, commitHex: pair.commitHex, revealHex: pair.revealHex } });
        }
        await btc.broadcast(rec.take, null);
        if ((await btc.status(rec.take.txid)).confirmations) return save(rec, { phase: 'done' });
        return rec;
      }
      case 'refunding': {
        if (!rec.refund) {
          const position = await evm.lockPosition(rec.lock.lockLeaf);
          if (!position) return rec;
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

  async function step(rec) {
    try { return await advance(rec); } catch (e) { return save(rec, { lastError: String((e && e.message) || e).slice(0, 300) }); }
  }

  return { receive, step };
}
