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
//   policy   { screen?(notes) -> { why, retry } | null, minCsv, minConfsFor(value) -> n, evmWindowSecs, minClaimSecs, claimSlackSecs, maxAmount, minAmount, roundSecs,
//              refundMarginSecs (600), maxOfferAgeSecs (3600), maxLockFailures (3), maxConfirmWaitSecs (43200) }
//   btc      { prims, wallet:{ pub, priv, xonly }, tx (makeAdaptorBtcTx), satsUtxos(), feeRate(), broadcast(pair),
//              fetchTx(txid), status(txid) -> { confirmations, height }, tip(), blockTime(height), outspend(txid, vout),
//              resolveNote(txid, vout) -> { assetIdHex, commitment } | null, crossLaneBlocked(esploraTx) -> reason | null }
//   evm      { now() (the latest block's timestamp), lockNullifier(lockLeaf) -> hex, prepare({ rec }) (optional: make the exact note ready),
//              lockOp({ rec, rEvmLock, T, deadline, recipient, refundXonly, prefer }) -> { op, lockLeaf, noteLeaf } | null (note not ready; `prefer` is the note
//              an earlier try was built from, which a new try uses again so the two cannot both land), release({ rec }) (optional),
//              refundOp({ rec, position }) -> op, submit(type, op) -> { jobId }, jobStatus(jobId, { type, bundle }) -> 'pending' | 'settled' | 'failed',
//              lockPosition(leaf) -> { lIndex, lPath, lockSetRoot } | null,
//              findClaim(lockNu, { sinceSecs }) -> null (unspent) | [] (spent by a refund) | [z hex, ...] (spent by claims), refundKey(swapIdHex) -> { xonly } }
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
  // `updated` moves with every save, a failed step's included; `phaseAt` moves only when the phase does
  const save = async (rec, patch) => {
    const entered = patch.phase && patch.phase !== rec.phase ? { phaseAt: ctx.now() } : {};
    Object.assign(rec, patch, entered, { updated: ctx.now() });
    await store.put(rec);
    // a swap that ends with no lock in the pool gives its note back to the pool wallet's free notes
    if (patch.phase === 'aborted' && evm.release) evm.release({ rec });
    return rec;
  };
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
    if (!/^[0-9a-f]{72}$/.test(id)) return Promise.resolve({ ok: false, retry: false, why: 'malformed offer: the swap id' });
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
    // what needs no chain read is checked before any: the outpoint's shape, and the amounts against the quote
    if (!/^[0-9a-f]{64}$/.test(String(offer.btc.txid)) || !Number.isInteger(offer.btc.vout) || offer.btc.vout < 0 || offer.btc.vout > 0xffff) return reject('malformed offer: the lock outpoint');
    if (value < BigInt(policy.minAmount) || value > BigInt(policy.maxAmount)) return reject('amount outside this side\'s limits');
    if (value !== BigInt(quote.btcValue) || amount !== BigInt(quote.evmAmount)) return reject('the amounts differ from the quote');
    const tx = await btc.fetchTx(offer.btc.txid);
    if (!tx) return reject('the lock transaction is not on the chain', true);
    const out = tx.vout[offer.btc.vout];
    if (!out || !Number.isInteger(out.value) || out.value < DUST_P2TR) return reject('the lock output carries no spendable amount');
    // a lock that is only in the mempool can be replaced, and is not answered: the user's page sends its offer once the lock has confirmed
    const st = await btc.status(offer.btc.txid);
    if (!(st.confirmations > 0)) return reject('the lock has no confirmation yet', true);
    const note = await btc.resolveNote(offer.btc.txid, offer.btc.vout);
    if (st.confirmations > 0 && ctx.now() - (await btc.blockTime(st.height)) > maxOfferAge) return reject('the offer arrived too late to be answered');
    // a provider that does not take TAC whose history the bridge's proof cannot follow (`policy.screen`) looks at the notes the lock spends
    // before it takes the lock: { why, retry } to refuse it, null to go on; a look that fails is asked again
    if (policy.screen) {
      let s;
      try { s = await policy.screen(tx.vin.slice(1).map((i) => ({ txid: i.txid, vout: i.vout }))); } catch { return reject('the history of the notes could not be read just now', true); }
      if (s) return reject(s.why, s.retry === true);
    }
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
    // the lock pays the fee of this side's take, to this side's own address
    const takeSats = Number(quote.takeSats ?? 0), own = hx(btc.prims.p2wpkhScript(btc.wallet.pub));
    if (takeSats > 0 && !tx.vout.some((o) => strip(o.scriptpubkey) === own && o.value >= takeSats)) return reject('the lock does not pay the fee of the take');
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
    const zs = await evm.findClaim(rec.lock.lockNu, { sinceSecs: rec.created });
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
        if (st.confirmations < need) {
          // a lock that does not reach its confirmations (replaced, or reorganised away) does not hold the payout for ever
          if (ctx.now() - rec.created > (policy.maxConfirmWaitSecs ?? 43200)) return save(rec, { phase: 'aborted', why: 'the lock did not reach its confirmations in time' });
          // once the lock has a confirmation and needs more, the note of the exact size is made ready, once
          if (st.confirmations >= 1 && evm.prepare && !rec.prepared) { await evm.prepare({ rec }); return save(rec, { prepared: true }); }
          return rec;
        }
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
          // making the lock reads the wallet's notes, which is slow: a try that finds none is not repeated on every tick
          if (rec.buildRetryAt && ctx.now() < rec.buildRetryAt) return rec;
          const nowSecs = await evm.now();
          if (rec.deadline - nowSecs < policy.minClaimSecs) return save(rec, { phase: 'aborted', why: 'too late to lock' });
          const args = { rec, rEvmLock, T, deadline: rec.deadline, recipient: rec.offer.evm.recipient, refundXonly: refund.xonly, prefer: rec.lockNote || null };
          const failures = rec.buildFailures || 0;
          const next = { buildRetryAt: ctx.now() + Math.min(policy.buildRetryMaxSecs ?? 600, (policy.buildRetrySecs ?? 30) * 2 ** Math.min(failures, 10)), buildFailures: failures + 1 };
          let built;
          try {
            built = await evm.lockOp(args);
            // No note of the exact size yet: one is made from a larger note, and the lock is tried again; not when an earlier try named its note,
            // which is waited for: another note would let both tries land. This is asked on each try and not once per swap: bridges of one size that
            // arrive together all find the first one's note when they are made ready and skip their own cut, and only one of them gets it (five
            // bridges of 996.9 TAC within two minutes left four waiting for a note that never came). The adapter cuts only when no note of the size
            // is free, and the tries are spaced by the backoff below.
            if (!built && !rec.lockNote && evm.prepare) { await evm.prepare({ rec }); await save(rec, { prepared: true }); built = await evm.lockOp(args); }
          } catch (e) { await save(rec, next); throw e; }
          if (!built) return save(rec, { ...next, why: 'waiting for a pool note of the exact size' });
          if (strip(built.lockLeaf) !== strip(expected)) return save(rec, { phase: 'aborted', why: 'the lock built is not the lock this swap names' });
          return save(rec, { lock: { lockLeaf: expected, lockNu, op: built.op }, lockNote: built.noteLeaf || rec.lockNote || null, why: null, buildRetryAt: null, buildFailures: 0 });
        }
        if (await evm.lockPosition(rec.lock.lockLeaf)) return save(rec, { phase: 'locked' });
        if (!rec.lock.jobId) {
          const nowSecs = await evm.now();
          // too late to answer, but the stored lock may already be on its way: it is watched and refunded, not forgotten
          if (rec.deadline - nowSecs < policy.minClaimSecs) return save(rec, { phase: 'offered', noOffer: true });
          const { jobId } = await evm.submit('adaptorlock', rec.lock.op);
          return save(rec, { lock: { ...rec.lock, jobId } });
        }
        const st = await evm.jobStatus(rec.lock.jobId, { type: 'adaptorlock', bundle: rec.lock.op });
        if (st === 'failed') {
          // a lock the relay reports failed will not land: the pool is asked again by leaf before another is built
          if ((rec.lockFailures || 0) + 1 >= (policy.maxLockFailures ?? 3)) return save(rec, { phase: 'aborted', why: 'the lock failed repeatedly' });
          return save(rec, { lock: null, lockFailures: (rec.lockFailures || 0) + 1 });
        }
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
          await save(rec, { take: { txid: pair.revealTxid, commitTxid: pair.commitTxid, commitHex: pair.commitHex, revealHex: pair.revealHex, at: ctx.now() } });
        }
        try { await btc.broadcast(rec.take, null); } catch (e) {
          // a pair whose funding coin was spent elsewhere never goes: once it has had time to spread and its commit is nowhere, it is built again from the coins there are
          if (rec.take.at != null && ctx.now() - rec.take.at > 600 && (rec.takeRebuilds || 0) < 5 && !(await btc.fetchTx(rec.take.commitTxid).catch(() => null))) await save(rec, { take: null, takeRebuilds: (rec.takeRebuilds || 0) + 1 });
          throw e;
        }
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
        const st = await evm.jobStatus(rec.refund.jobId, { type: 'adaptorrefund', bundle: rec.refund.op });
        if (st === 'settled') return save(rec, { phase: 'refunded' });
        if (st === 'failed') return save(rec, { refund: { ...rec.refund, jobId: null } });
        return rec;
      }
      default:
        return rec;
    }
  }

  // One step; a failing adapter call is recorded and the phase kept, so the next tick tries again. A swap that moves on has no error left to show: an
  // alert for a swap that waited long in `taking` quoted the lock's "insufficient ETH" from hours before, when the wait was only slow Bitcoin blocks.
  // One that ends without a lock keeps its last error: it says why.
  const KEEPS_ERROR = new Set(['aborted', 'rejected', 'lost']);
  function step(rec) {
    return serial(rec.id, async () => {
      const cur = (await store.get(rec.id)) || rec;
      try {
        const before = cur.phase, out = await advance(cur);
        return out && out.lastError && out.phase !== before && !KEEPS_ERROR.has(out.phase) ? await save(out, { lastError: null }) : out;
      } catch (e) { return save(cur, { lastError: String((e && e.message) || e).slice(0, 300) }); }
    });
  }

  return { receive, step };
}
