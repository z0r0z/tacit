
import * as X from './adaptor-xswap.js';
import * as adaptor from './adaptor-signature.js';
import { deriveLock, claimSecret } from './adaptor-btc-lock.js';
import { secp, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';
import { pedersenCommit } from './bulletproofs.js';

const hx = bytesToHex;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const DUST_P2TR = 330;

export function lockDeadline({ blockTime, windowSecs, roundSecs = 600 }) {
  return Math.ceil((blockTime + windowSecs) / roundSecs) * roundSecs;
}

export function makeEthereumLocker(ctx) {
  const { seed, store, policy, quotes, btc, evm, counter } = ctx;
  const margin = policy.refundMarginSecs ?? 600;
  const maxOfferAge = policy.maxOfferAgeSecs ?? 3600;
  const save = async (rec, patch) => {
    const entered = patch.phase && patch.phase !== rec.phase ? { phaseAt: ctx.now() } : {};
    Object.assign(rec, patch, entered, { updated: ctx.now() });
    await store.put(rec);
    if (patch.phase === 'aborted' && evm.release) evm.release({ rec });
    return rec;
  };
  const sidOf = (rec) => hexToBytes(rec.id);

  const queues = new Map();
  const serial = (id, fn) => {
    const run = (queues.get(id) || Promise.resolve()).catch(() => {}).then(fn);
    queues.set(id, run);
    run.catch(() => {}).finally(() => { if (queues.get(id) === run) queues.delete(id); });
    return run;
  };

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
    if (!/^[0-9a-f]{64}$/.test(String(offer.btc.txid)) || !Number.isInteger(offer.btc.vout) || offer.btc.vout < 0 || offer.btc.vout > 0xffff) return reject('malformed offer: the lock outpoint');
    if (value < BigInt(policy.minAmount) || value > BigInt(policy.maxAmount)) return reject('amount outside this side\'s limits');
    if (value !== BigInt(quote.btcValue) || amount !== BigInt(quote.evmAmount)) return reject('the amounts differ from the quote');
    const tx = await btc.fetchTx(offer.btc.txid);
    if (!tx) return reject('the lock transaction is not on the chain', true);
    const out = tx.vout[offer.btc.vout];
    if (!out || !Number.isInteger(out.value) || out.value < DUST_P2TR) return reject('the lock output carries no spendable amount');
    const st = await btc.status(offer.btc.txid);
    if (!(st.confirmations > 0)) return reject('the lock has no confirmation yet', true);
    const note = await btc.resolveNote(offer.btc.txid, offer.btc.vout);
    if (st.confirmations > 0 && ctx.now() - (await btc.blockTime(st.height)) > maxOfferAge) return reject('the offer arrived too late to be answered');
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
    if (rec.lock && (rec.phase === 'locking' || rec.phase === 'locked') && (await evm.now()) > rec.deadline) {
      return save(rec, { phase: 'offered', noOffer: !rec.evmOffer });
    }
    switch (rec.phase) {
      case 'accepted': {
        const st = await btc.status(rec.lockTxid);
        const need = policy.minConfsFor(BigInt(rec.offer.btc.value));
        if (st.confirmations < need) {
          if (ctx.now() - rec.created > (policy.maxConfirmWaitSecs ?? 43200)) return save(rec, { phase: 'aborted', why: 'the lock did not reach its confirmations in time' });
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
          const refund = await evm.refundKey(rec.id);
          const expected = '0x' + hx(X.adaptorLockLeaf({
            asset: rec.offer.evm.asset, L: pedersenCommit(BigInt(rec.offer.evm.amount), rEvmLock), T, deadline: rec.deadline,
            recipient: rec.offer.evm.recipient, locker: hx(refund.xonly),
          }));
          const lockNu = evm.lockNullifier(expected);
          if (await evm.lockPosition(expected)) return save(rec, { lock: { lockLeaf: expected, lockNu }, phase: 'locked' });
          if (rec.buildRetryAt && ctx.now() < rec.buildRetryAt) return rec;
          const nowSecs = await evm.now();
          if (rec.deadline - nowSecs < policy.minClaimSecs) return save(rec, { phase: 'aborted', why: 'too late to lock' });
          const args = { rec, rEvmLock, T, deadline: rec.deadline, recipient: rec.offer.evm.recipient, refundXonly: refund.xonly, prefer: rec.lockNote || null };
          const failures = rec.buildFailures || 0;
          const next = { buildRetryAt: ctx.now() + Math.min(policy.buildRetryMaxSecs ?? 600, (policy.buildRetrySecs ?? 30) * 2 ** Math.min(failures, 10)), buildFailures: failures + 1 };
          let built;
          try {
            built = await evm.lockOp(args);
            if (!built && !rec.lockNote && evm.prepare) { await evm.prepare({ rec }); await save(rec, { prepared: true }); built = await evm.lockOp(args); }
          } catch (e) { await save(rec, next); throw e; }
          if (!built) return save(rec, { ...next, why: 'waiting for a pool note of the exact size' });
          if (strip(built.lockLeaf) !== strip(expected)) return save(rec, { phase: 'aborted', why: 'the lock built is not the lock this swap names' });
          return save(rec, { lock: { lockLeaf: expected, lockNu, op: built.op }, lockNote: built.noteLeaf || rec.lockNote || null, why: null, buildRetryAt: null, buildFailures: 0 });
        }
        if (await evm.lockPosition(rec.lock.lockLeaf)) return save(rec, { phase: 'locked' });
        if (!rec.lock.jobId) {
          const nowSecs = await evm.now();
          if (rec.deadline - nowSecs < policy.minClaimSecs) return save(rec, { phase: 'offered', noOffer: true });
          const { jobId } = await evm.submit('adaptorlock', rec.lock.op);
          return save(rec, { lock: { ...rec.lock, jobId } });
        }
        const st = await evm.jobStatus(rec.lock.jobId, { type: 'adaptorlock', bundle: rec.lock.op });
        if (st === 'failed') {
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
          if (rec.take.at != null && ctx.now() - rec.take.at > 600 && (rec.takeRebuilds || 0) < 5 && !(await btc.fetchTx(rec.take.commitTxid).catch(() => null))) await save(rec, { take: null, takeRebuilds: (rec.takeRebuilds || 0) + 1 });
          throw e;
        }
        if ((await btc.status(rec.take.txid)).confirmations) return save(rec, { phase: 'done' });
        return rec;
      }
      case 'refunding': {
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
