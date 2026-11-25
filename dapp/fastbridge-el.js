
import * as X from './adaptor-xswap.js';
import * as adaptor from './adaptor-signature.js';
import { deriveLock, claimSecret } from './adaptor-btc-lock.js';
import { secp, bytesToHex, hexToBytes, hmac, sha256 } from './vendor/tacit-deps.min.js';
import { pedersenCommit } from './bulletproofs.js';

const hx = bytesToHex;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const DUST_P2TR = 330;

export function lockDeadline({ blockTime, windowSecs, roundSecs = 600 }) {
  return Math.ceil((blockTime + windowSecs) / roundSecs) * roundSecs;
}

// A lock built ahead (an offer taken while the Bitcoin lock waits for its block, `early`): its deadline is counted from when the offer was taken, not from the
// block, so the lock can be built and proved during the wait. It is used only if, once the Bitcoin lock is confirmed and agreed, the same check a lock built then
// passes holds for it (checkEvmDeadline: time to claim, and the claim slack before the Bitcoin refund can open), and it leaves the counterparty at least
// `preMinLeftSecs` to claim and no more than `preMaxLeftSecs` (under the most a Bitcoin locker accepts, maxEvmWindowSecs: 6 h). Otherwise it is let go and the lock
// is built as it always was, from the block. Returns the reasons it cannot be used (empty = use it).
export const PRE_DEFAULTS = { preWindowExtraSecs: 1800, preMinLeftSecs: 7200, preMaxLeftSecs: 5.5 * 3600, preProveWaitSecs: 300 };
export function preDeadline({ takenAt, policy }) {
  return lockDeadline({ blockTime: takenAt, windowSecs: policy.preWindowSecs ?? (policy.evmWindowSecs + PRE_DEFAULTS.preWindowExtraSecs), roundSecs: policy.roundSecs });
}
export function checkPreDeadline({ deadline, nowSecs, btcRefundOpens, policy }) {
  const minLeft = Math.max(policy.minClaimSecs ?? 1800, policy.preMinLeftSecs ?? PRE_DEFAULTS.preMinLeftSecs);
  const bad = X.checkEvmDeadline({ deadline, nowSecs, btcRefundOpens, minClaimSecs: minLeft, claimSlackSecs: policy.claimSlackSecs });
  if (deadline - nowSecs > (policy.preMaxLeftSecs ?? PRE_DEFAULTS.preMaxLeftSecs)) bad.push('the deadline built ahead is further out than a counterparty accepts');
  return bad;
}

// A swap's record built again from its pool lock's memo (dapp/fastbridge-evm.js openLockMemo) and the key, for a key whose records are gone. It is at 'offered': the lock is
// in the pool, so the next step reads what became of it (the claim gives t and the Bitcoin lock is taken; past the deadline the lock is refunded). Null when the memo
// does not make the lock it was found on. `lockValue`: the Bitcoin lock output's sats as the chain shows them (a lock of sats holds the amount itself).
export function recordFromLockMemo({ memo, seed, refundXonly, claimerPub, btcAsset, evmAsset, lockNullifier, lockValue = null, now }) {
  const id = strip(memo.swapId), T = secp.ProjectivePoint.fromHex(strip(memo.T));
  const rEvmLock = X.evmLockBlinding({ seed, swapId: hexToBytes(id), T });
  const amount = BigInt(memo.evm.amount), locker = hx(refundXonly), sats = X.isSats(btcAsset);
  const evmOffer = X.makeEvmOffer({ asset: strip(evmAsset), amount, rEvmLock, T, deadline: memo.deadline, recipient: memo.evm.recipient, locker, rOut: BigInt('0x' + strip(memo.evm.rOut)) });
  if (strip(evmOffer.lockLeaf) !== strip(memo.lockLeaf)) return null;
  const L = pedersenCommit(amount, rEvmLock).toRawBytes(false), Tu = T.toRawBytes(false), w = (b) => '0x' + hx(b);
  const lockLeaf = '0x' + strip(memo.lockLeaf);
  return {
    v: 1, role: 'el', id, phase: 'offered', created: Math.max(0, memo.deadline - 8 * 3600), updated: now, quoteId: null, recovered: true,
    offer: {
      v: 1, swapId: id, T: strip(memo.T), claimerPub: hx(claimerPub),
      btc: { asset: strip(btcAsset), value: String(memo.btc.value), ...(sats ? {} : { rLock: memo.btc.rLock }), txid: memo.btc.txid, vout: memo.btc.vout, csvBlocks: memo.btc.csvBlocks, lockerXonly: memo.btc.lockerXonly },
      evm: { asset: strip(evmAsset), amount: String(amount), recipient: strip(memo.evm.recipient), rOut: strip(memo.evm.rOut) },
    },
    lockTxid: memo.btc.txid, lockVout: memo.btc.vout, lockValue: lockValue ?? Number(memo.btc.value), csvBlocks: memo.btc.csvBlocks, deadline: memo.deadline,
    // (the lock's terms as its refund reads them)
    lock: { lockLeaf, lockNu: lockNullifier(lockLeaf), op: { amount: String(amount), lCx: w(L.slice(1, 33)), lCy: w(L.slice(33, 65)), tx: w(Tu.slice(1, 33)), ty: w(Tu.slice(33, 65)), deadline: memo.deadline, recipient: '0x' + strip(memo.evm.recipient), refundPub: '0x' + locker } },
    evmOffer,
  };
}

// The terms of a swap this side checked (receiveOnce: the offer against its own quote and the Bitcoin lock on the chain), sealed with a MAC under the seed. With
// `ctx.requireChecked`, a lock is built and sent only for a record that carries it: a record that came from anywhere else (a file read back, storage written by
// something other than this machine) is never locked against. The page's user side sets it; a record that lacks it stops before anything of its own is locked.
const enc = new TextEncoder();
// The value a lock's confirmations are weighed by: the lock's own, or, when its transaction pays other Taproot outputs besides (the other locks of a split across providers,
// dapp/fastbridge-pair.js), the whole of what the transaction locks, whichever is more. A block that reorders away a large transaction takes every lock in it, so the
// confirmations asked for a lock are those asked for the total moved, and a leg of a split is never answered on fewer than a lone lock of that total would be (a lone
// lock's total is its own value, so nothing changes for it). `lockTotal` is read from the transaction when the offer is taken.
export const confValue = (rec) => { const v = BigInt(rec.offer.btc.value), t = BigInt(rec.lockTotal || 0); return t > v ? t : v; };
const P2TR_PREFIX = '5120';
export const lockTotalOf = (tx) => (tx.vout || []).reduce((t, o) => (String(o.scriptpubkey || '').toLowerCase().startsWith(P2TR_PREFIX) && String(o.scriptpubkey).length === 68 && Number.isSafeInteger(o.value) ? t + o.value : t), 0);

export function checkedTag(seed, rec) {
  const o = rec.offer || {}, b = o.btc || {}, e = o.evm || {};
  const terms = JSON.stringify(['tacit-el-checked-v1', strip(rec.id), rec.quoteId ?? null, strip(o.T || ''), strip(o.claimerPub || ''),
    strip(b.asset || ''), String(b.value), strip(b.txid || ''), Number(b.vout), Number(b.csvBlocks), strip(b.lockerXonly || ''),
    strip(e.asset || ''), String(e.amount), strip(e.recipient || ''), strip(e.rOut || ''), strip(rec.lockTxid || ''), Number(rec.lockVout), Number(rec.lockValue)]);
  return hx(hmac(sha256, seed, enc.encode(terms)));
}

export function makeEthereumLocker(ctx) {
  const { seed, store, policy, quotes, btc, evm, counter } = ctx;
  const checked = (rec) => !ctx.requireChecked || (typeof rec.checked === 'string' && rec.checked === checkedTag(seed, rec));
  const unchecked = (rec) => save(rec, { phase: 'aborted', why: 'this swap was not checked on this page, so nothing was locked' });
  const margin = policy.refundMarginSecs ?? 600;
  const maxOfferAge = policy.maxOfferAgeSecs ?? 3600;
  const save = async (rec, patch) => {
    const entered = patch.phase && patch.phase !== rec.phase ? { phaseAt: ctx.now() } : {};
    Object.assign(rec, patch, entered, { updated: ctx.now() });
    await store.put(rec);
    if (patch.phase === 'aborted' && evm.release) { evm.release({ rec }); if (rec.pre && rec.pre.lockNote) evm.release({ rec: { lockNote: rec.pre.lockNote } }); }
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

  // `early`: an offer whose Bitcoin lock is not confirmed yet (a lock of plain sats only), taken so the lock can be built and proved while the block is awaited.
  // It is checked as any offer is, against the transaction as the explorers show it in their mempool; the record waits in 'accepted' for the confirmations as
  // every record does, and nothing is locked before them.
  function receive({ quoteId, offer, early = false }) {
    const id = strip((offer && offer.swapId) || '');
    if (!/^[0-9a-f]{72}$/.test(id)) return Promise.resolve({ ok: false, retry: false, why: 'malformed offer: the swap id' });
    return serial(id, () => receiveOnce({ quoteId, offer, id, early: early === true && policy.early !== false }));
  }

  async function receiveOnce({ quoteId, offer, id, early = false }) {
    const known = await store.get(id);
    // (an early record that ran out its wait for the block before anything was built on it is no answer: the offer is judged again)
    // (an early record the offer now comes for is held to its quote as of now, as the step after the block holds it: see 'accepted')
    if (known && known.early && known.phase === 'accepted' && !known.lock) {
      const q = await quotes.get(known.quoteId, { offer: known.offer });
      if (!q || ctx.now() > q.validUntil) { await dropPre(known); await save(known, { phase: 'aborted', why: 'quote expired', expired: true }); return { ok: false, retry: false, why: 'quote expired' }; }
    }
    if (known && !(known.early && known.phase === 'aborted' && !known.lock && known.expired)) return { ok: true, rec: known };
    const reject = (why, retry = false) => ({ ok: false, retry, why });
    // `admit({ id, offer })`: a reason this side will not answer the offer, from what it keeps beyond this store (a Bitcoin lock that another swap of the
    // same key already answers), or null
    if (ctx.admit) { const why = await ctx.admit({ id, offer }); if (why) return reject(why); }
    // (the offer goes with the ask: a quote past its time may still stand for a lock that was made in time)
    const quote = await quotes.get(quoteId, { offer });
    if (!quote) return reject('unknown quote');
    if (ctx.now() > quote.validUntil) return reject('quote expired');
    // a quote is the price of one swap: a second lock against it is not answered at that price
    if ((await store.list()).some((r) => r.quoteId === quoteId && r.id !== id)) return reject('this quote was used for another swap');
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
    // plain sats (X.SATS_ASSET) have no note to resolve, screen or find consumed on Ethereum: the lock is judged by its script and its value,
    // and the swap is named by the first coin the lock spends. Which of the two it is is this side's own quote, not the offer's word
    // (an offer that names the other is refused below, as the Bitcoin side differing from the quote)
    const sats = X.isSats(quote.btcAsset);
    // (a note's history is walked on confirmed transactions only, so an offer taken early is one of plain sats)
    if (!(st.confirmations > 0) && !(early && sats)) return reject('the lock has no confirmation yet', true);
    // what is settled by the transaction and the block alone comes first: the walk of a note's history (resolveNote) is the longest read there is
    if (st.confirmations > 0 && ctx.now() - (await btc.blockTime(st.height)) > maxOfferAge) return reject('the offer arrived too late to be answered');
    // the fee of the take is paid to this address, or locked with the lock: a second output of the lock's own script (only this key with t opens it, and the
    // user's refund opens it too). The lock's script itself is checked below against the terms; here only that the output is the same script and is not the lock.
    const takeSats = Number(quote.takeSats ?? 0), own = hx(btc.prims.p2wpkhScript(btc.wallet.pub)), lockSpk = strip(out.scriptpubkey);
    const paidDirect = tx.vout.some((o) => strip(o.scriptpubkey) === own && o.value >= takeSats);
    const lockedAt = tx.vout.findIndex((o, i) => i !== offer.btc.vout && strip(o.scriptpubkey) === lockSpk && o.value >= takeSats);
    if (takeSats > 0 && !paidDirect && lockedAt < 0) return reject('the lock does not pay the fee of the take');
    const note = sats ? null : await btc.resolveNote(offer.btc.txid, offer.btc.vout);
    if (policy.screen && !sats) {
      let s;
      try { s = await policy.screen(tx.vin.slice(1).map((i) => ({ txid: i.txid, vout: i.vout }))); } catch { return reject('the history of the notes could not be read just now', true); }
      if (s) return reject(s.why, s.retry === true);
    }
    const chain = {
      spk: out.scriptpubkey, commitment: note ? hx(note.commitment) : '', validNote: !!note && strip(note.assetIdHex) === strip(offer.btc.asset), value: out.value,
      confirmations: st.confirmations, noteInputs: tx.vin.slice(sats ? 0 : 1).map((i) => ({ txid: i.txid, vout: i.vout })),
    };
    const v = X.verifyBtcLockOffer(offer, {
      prims: btc.prims, myClaimerPub: btc.wallet.pub,
      expect: { btcAsset: quote.btcAsset, btcValue: BigInt(quote.btcValue), evmAsset: quote.evmAsset, evmAmount: BigInt(quote.evmAmount) },
      chain, minConfs: 0, minCsv: policy.minCsv,
    });
    if (!v.ok) return reject(v.reasons.join('; '));
    const consumed = sats ? null : await btc.crossLaneBlocked(tx);
    if (consumed) return reject('a spent note is already consumed on Ethereum: ' + consumed);
    const rec = {
      v: 1, role: 'el', id, phase: 'accepted', created: ctx.now(), updated: ctx.now(), quoteId, offer,
      lockTxid: offer.btc.txid, lockVout: offer.btc.vout, lockValue: out.value, lockSpk: strip(out.scriptpubkey), csvBlocks: offer.btc.csvBlocks,
      ...(sats && lockTotalOf(tx) > out.value ? { lockTotal: lockTotalOf(tx) } : {}),
      ...(takeSats > 0 && !paidDirect ? { takeVout: lockedAt, takeValue: tx.vout[lockedAt].value } : {}),
      ...(st.confirmations > 0 ? {} : { early: true }),
    };
    rec.checked = checkedTag(seed, rec);
    await store.put(rec);
    return { ok: true, rec };
  }

  const secretsOf = (rec) => {
    const T = secp.ProjectivePoint.fromHex(strip(rec.offer.T));
    return { T, rEvmLock: X.evmLockBlinding({ seed, swapId: sidOf(rec), T }) };
  };

  async function readLock(rec) {
    const sTilde = rec.evmOffer ? BigInt('0x' + strip(rec.evmOffer.presign.sTilde)) : null;
    const T = secretsOf(rec).T;
    const tOf = (z) => { const t = adaptor.evmKernelExtract(sTilde, BigInt(z)); return t !== 0n && adaptor.adaptorPoint(t).equals(T) ? t : null; };
    // `check`: a kernel read from anything but the pool's own record of the settle is taken only if it opens this swap
    // (the spend is read once it is a few blocks deep; a kernel that gives t stands on its own, anything else on what the nodes agree on)
    const zs = await evm.findClaim(rec.lock.lockNu, { sinceSecs: rec.created, final: policy.claimDepth ?? 12, ...(sTilde != null ? { check: (z) => tOf(z) != null, proves: true } : {}) });
    if (!zs) return null;
    if (!zs.length) return { refunded: true };
    if (sTilde == null) return { lost: true };
    for (const z of zs) {
      const t = tOf(z);
      if (t != null) return { t: '0x' + t.toString(16).padStart(64, '0') };
    }
    return { lost: true };
  }
  const afterRead = async (rec, r) => {
    if (r.t) return save(rec, { phase: 'taking', t: r.t, unread: null, lookAt: null });
    // (a lock is refunded only by its locker: a record found again from the key, which kept no refund of its own, was refunded by this key)
    if (r.refunded) return save(rec, { phase: rec.refund || rec.recovered ? 'refunded' : 'done', why: 'the lock was spent by a refund' });
    // A claim read so far without t is read again (each look reads more of the window's traces), less often each time but at least every two minutes (the BTC waits on it), for as long as the Bitcoin lock can still be
    // taken: only once its refund is a few blocks away is the swap given up.
    const height = rec.lockHeight ?? ((await btc.status(rec.lockTxid).catch(() => null)) || {}).height;
    const left = height == null ? null : height + rec.csvBlocks - 1 - (await btc.tip());
    if (left == null || left > (policy.unreadGiveUpBlocks ?? 6)) {
      const n = (rec.unread || 0) + 1;
      return save(rec, { unread: n, lookAt: ctx.now() + Math.min(policy.unreadMaxWaitSecs ?? 120, 30 * 2 ** Math.min(n - 1, 10)), why: 'the lock was spent: its claim is read again for t' });
    }
    return save(rec, { phase: 'lost', why: 'the lock was claimed with a kernel that does not reveal t' });
  };
  const waiting = (rec) => rec.lookAt != null && ctx.now() < rec.lookAt;

  // ── the lock built ahead, while the Bitcoin lock waits for its block (an early record) ──
  // The note a lock built ahead held is given back when that lock is let go
  async function dropPre(rec) {
    if (!rec.pre) return;
    if (evm.release && rec.pre.lockNote) evm.release({ rec: { lockNote: rec.pre.lockNote } });
    await save(rec, { pre: null });
  }
  // The confirmations the lock has while it waits, kept for the page's words (nothing is decided on them)
  async function watchTip(rec, st) {
    if (Number(rec.lockConfs || 0) !== Number(st.confirmations || 0)) await save(rec, { lockConfs: st.confirmations });
  }
  // The lock this swap would make with deadline `deadline`, built (and its note held) but not sent: { lock: { lockLeaf, lockNu, op }, lockNote } or null while no
  // note of the exact size is there
  async function buildLock(rec, deadline, prefer = null) {
    const { T, rEvmLock } = secretsOf(rec);
    const refund = await evm.refundKey(rec.id);
    const expected = '0x' + hx(X.adaptorLockLeaf({ asset: rec.offer.evm.asset, L: pedersenCommit(BigInt(rec.offer.evm.amount), rEvmLock), T, deadline, recipient: rec.offer.evm.recipient, locker: hx(refund.xonly) }));
    const built = await evm.lockOp({ rec, rEvmLock, T, deadline, recipient: rec.offer.evm.recipient, refundXonly: refund.xonly, prefer });
    if (!built) return null;
    if (strip(built.lockLeaf) !== strip(expected)) throw new Error('the lock built is not the lock this swap names');
    return { lock: { lockLeaf: expected, lockNu: evm.lockNullifier(expected), op: built.op }, lockNote: built.noteLeaf || null };
  }
  // One step of the lock built ahead: built with its deadline counted from when the offer was taken, then given to the relay to prove (prove only: nothing is
  // sent, so nothing of this side's is locked before the Bitcoin lock is confirmed). A step that cannot build or prove it leaves the swap as it would be without
  // it; the lock is then built and proved after the block, as always.
  async function preStep(rec) {
    if (!evm.lockOp || rec.preOff) return rec;
    if (rec.preRetryAt && ctx.now() < rec.preRetryAt) return rec;
    if (!rec.pre) {
      const deadline = preDeadline({ takenAt: rec.created, policy });
      // (a deadline that could not pass at the earliest the block can come is not built at all)
      if (deadline - (await evm.now()) < Math.max(policy.minClaimSecs ?? 1800, policy.preMinLeftSecs ?? PRE_DEFAULTS.preMinLeftSecs)) return save(rec, { preOff: true, preWhy: 'too late to build ahead' });
      let made = null;
      try { made = await buildLock(rec, deadline); } catch (e) { return save(rec, { preOff: true, preWhy: String((e && e.message) || e).slice(0, 160) }); }
      if (!made) return save(rec, { preRetryAt: ctx.now() + (policy.buildRetrySecs ?? 30) });
      return save(rec, { pre: { deadline, ...made, at: ctx.now() }, preRetryAt: null });
    }
    if (!rec.pre.proveJob && !rec.pre.proveOff && evm.proveAhead) {
      try {
        const r = await evm.proveAhead('adaptorlock', rec.pre.lock.op);
        if (r && r.jobId) return save(rec, { pre: { ...rec.pre, proveJob: r.jobId, proveAt: ctx.now() } });
        return save(rec, { pre: { ...rec.pre, proveOff: 'the relay gave no job' } });
      } catch (e) { return save(rec, { pre: { ...rec.pre, proveOff: String((e && e.message) || e).slice(0, 160) } }); }
    }
    return rec;
  }

  async function advance(rec) {
    if (rec.lock && (rec.phase === 'locking' || rec.phase === 'locked') && (await evm.now()) > rec.deadline) {
      return save(rec, { phase: 'offered', noOffer: !rec.evmOffer });
    }
    switch (rec.phase) {
      case 'accepted': {
        if (!checked(rec)) return unchecked(rec);
        const st = await btc.status(rec.lockTxid);
        const need = policy.minConfsFor(confValue(rec));
        if (st.confirmations < need) {
          // (an early record waits `earlyConfirmWaitSecs` when the side sets it: a provider does not hold its payout for a lock that never confirms longer than it
          // holds a reservation for one)
          const waitMax = rec.early && policy.earlyConfirmWaitSecs != null ? policy.earlyConfirmWaitSecs : (policy.maxConfirmWaitSecs ?? 43200);
          if (ctx.now() - rec.created > waitMax) { await dropPre(rec); return save(rec, { phase: 'aborted', why: 'the lock did not reach its confirmations in time', ...(rec.early ? { expired: true } : {}) }); }
          await watchTip(rec, st);
          if (st.confirmations >= 1 && evm.prepare && !rec.prepared && !rec.pre) { await evm.prepare({ rec }); return save(rec, { prepared: true }); }
          if (rec.early) return preStep(rec);
          return rec;
        }
        if (await btc.outspend(rec.lockTxid, rec.lockVout)) return save(rec, { phase: 'aborted', why: 'the lock output was spent before it could be answered' });
        // Before anything is locked against it, the lock is read again from every explorer: two that answer must show the same transaction in the same block,
        // its output unspent. One that answers alone (the explorers of a busy host often refuse most requests) is waited on until a second does: one explorer's
        // word is not enough to lock ETH against. One that says the lock is not there, or two that differ, keep the swap waiting. The height they
        // agree on is the one the windows count from. This is asked at most every `agreeEverySecs`, so a wait does not add to the refusals it is waiting out.
        let height = st.height;
        if (btc.lockAgreed) {
          if (rec.agreeAt && ctx.now() - rec.agreeAt < (policy.agreeEverySecs ?? 45)) return rec;
          await save(rec, { agreeAt: ctx.now() });
          let a;
          try { a = await btc.lockAgreed(rec.lockTxid, rec.lockVout); } catch (err) { if (rec.thinSince != null) await save(rec, { thinSince: null }); throw err; }   // (a contradiction starts the wait again)
          if (a.spent) return save(rec, { phase: 'aborted', why: 'the lock output was spent before it could be answered' });
          if (a.value !== rec.lockValue || (rec.lockSpk && strip(a.scriptpubkey) !== strip(rec.lockSpk))) return save(rec, { phase: 'aborted', why: 'the explorers do not show the lock this offer named' });
          // (explorers that have not all seen the new block yet are a few seconds behind: asked again in `agreeLagSecs`, not after the whole wait)
          if (a.confirmations < need) return save(rec, { agreeAt: ctx.now() - Math.max(0, (policy.agreeEverySecs ?? 45) - (policy.agreeLagSecs ?? 15)) });
          // ETH is locked only against a lock two explorers show alike: one that answers alone is waited on until a second does (or the swap's wait for
          // its confirmations runs out, before anything is locked), never taken on its word.
          if (a.thin) {
            if (rec.thinSince == null) await save(rec, { thinSince: ctx.now() });
            if (ctx.now() - rec.created > (policy.maxConfirmWaitSecs ?? 43200)) return save(rec, { phase: 'aborted', why: 'no second explorer showed the lock in time' });
            return rec;
          }
          height = a.height;
        }
        // An offer taken early is held to its quote as it would have been had it come now, with the lock confirmed: a quote priced from the market is not
        // answered at its old price once the market has moved past what this side allows (the provider's quotes.get). One that no longer stands ends here,
        // nothing locked, and the offer sent after the block is judged again, and refused, as before.
        if (rec.early) {
          const quote = await quotes.get(rec.quoteId, { offer: rec.offer });
          if (!quote || ctx.now() > quote.validUntil) { await dropPre(rec); return save(rec, { phase: 'aborted', why: 'quote expired', expired: true }); }
        }
        const consumed = X.isSats(rec.offer.btc.asset) ? null : await btc.crossLaneBlocked(await btc.fetchTx(rec.lockTxid));
        if (consumed) { await dropPre(rec); return save(rec, { phase: 'aborted', why: 'a spent note is already consumed on Ethereum: ' + consumed }); }
        const nowSecs = await evm.now();
        const tip = await btc.tip();
        const opens = X.btcRefundOpensAt({ lockHeight: height, csvBlocks: rec.csvBlocks, tipHeight: tip, nowSecs });
        // The lock built ahead goes in now, as it is, if its deadline passes the same checks a lock built now would (checkPreDeadline); else it is let go
        // and the lock is built from the block below, as it always was.
        if (rec.pre) {
          const why = checkPreDeadline({ deadline: rec.pre.deadline, nowSecs, btcRefundOpens: opens, policy });
          if (!why.length) {
            const out = await save(rec, { phase: 'locking', deadline: rec.pre.deadline, lockHeight: height, lock: { ...rec.pre.lock, ...(rec.pre.proveJob ? { proveJob: rec.pre.proveJob, proveAt: rec.pre.proveAt } : {}) }, lockNote: rec.pre.lockNote || null, pre: null, preUsed: true });
            return advance(out);                           // (sent in this same step: the block is in, and every second counts)
          }
          await dropPre(rec);
          await save(rec, { preWhy: why.join('; ') });
        }
        const confirmedAt = await btc.blockTime(height + need - 1);
        const deadline = lockDeadline({ blockTime: confirmedAt, windowSecs: policy.evmWindowSecs, roundSecs: policy.roundSecs });
        const bad = X.checkEvmDeadline({ deadline, nowSecs, btcRefundOpens: opens, minClaimSecs: policy.minClaimSecs, claimSlackSecs: policy.claimSlackSecs });
        if (bad.length) {
          // With time left to claim, the refund margin is the only thing that can be short, and it is short for the moment: it is measured from now and from the blocks the refund is
          // still away, so it grows as time passes. A lock of 72 blocks is short of its two hours by a few minutes at the first look and has them soon after (the page's reverse swap
          // of 11-23 was ended by that first look). Wait for it; once the deadline itself is too near, or the lock is spent, the swap ends as before.
          if (deadline - nowSecs >= (policy.minClaimSecs ?? 1800)) return rec;
          return save(rec, { phase: 'aborted', why: bad.join('; ') });
        }
        return save(rec, { phase: 'locking', deadline, lockHeight: height });
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
          if (!checked(rec)) return unchecked(rec);
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
          if (!checked(rec)) return unchecked(rec);
          const nowSecs = await evm.now();
          if (rec.deadline - nowSecs < policy.minClaimSecs) return save(rec, { phase: 'offered', noOffer: true });
          // A lock proved ahead is posted as it is (the relay only sends it). A proof still being made is waited for a few minutes, since it is nearer done than a
          // new one; one that failed, or that the relay will not take as posted, is let go and the lock is sent to be proved as it always was.
          if (rec.lock.proveJob && evm.provenStatus && evm.postProven) {
            let st = null;
            try { st = await evm.provenStatus(rec.lock.proveJob); } catch { st = null; }
            if (st && st.status === 'proven' && st.publicValues && st.proof) {
              try {
                const posted = await evm.postProven('adaptorlock', st, rec.lock.op);
                if (posted && posted.jobId) return save(rec, { lock: { ...rec.lock, jobId: posted.jobId, posted: true, proveJob: null } });
              } catch (e) { await save(rec, { lock: { ...rec.lock, proveJob: null }, preWhy: 'the proof made ahead was not taken: ' + String((e && e.message) || e).slice(0, 160) }); }
            } else if ((!st || st.status === 'pending' || st.status === 'proving' || st.status === 'claimed') && ctx.now() - (rec.lock.proveAt || 0) < (policy.preProveWaitSecs ?? PRE_DEFAULTS.preProveWaitSecs)) {
              return rec;
            } else await save(rec, { lock: { ...rec.lock, proveJob: null } });
          }
          const { jobId } = await evm.submit('adaptorlock', rec.lock.op);
          return save(rec, { lock: { ...rec.lock, jobId } });
        }
        const st = await evm.jobStatus(rec.lock.jobId, { type: 'adaptorlock', bundle: rec.lock.op });
        if (st === 'failed') {
          // a job the relay calls failed can still land: the last one is watched to the deadline (no offer is made for it) and refunded if it did
          if ((rec.lockFailures || 0) + 1 >= (policy.maxLockFailures ?? 3)) return save(rec, { phase: 'offered', noOffer: true, why: 'the lock failed repeatedly' });
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
        if (waiting(rec)) return rec;
        // (nodes that do not agree hold no swap past its deadline: the refund that follows is what the pool decides on)
        let r = null, held = null;
        try { r = await readLock(rec); } catch (e) { if (!(e && e.quorum)) throw e; held = e; }
        if (r) return afterRead(rec, r);
        if ((await evm.now()) > rec.deadline + margin) return save(rec, { phase: 'refunding' });
        if (held) throw held;
        return rec;
      }
      case 'taking': {
        // A lock of plain sats: the take is one transaction that pays its own fee out of the lock output, so no coin of this side's is needed.
        // It is also the one thing that must beat the user's refund once the timelock has run, and the fee can be raised at will (the input
        // signals replacement), so a take that has not confirmed is replaced by one that pays more, up to a share of the lock (takeMaxFeeShare),
        // and starts above the explorers' estimate (takeFeeFactor). takeBumpSecs is how long a take waits before it is replaced.
        const satsTake = X.isSats(rec.offer.btc.asset);
        const buildSatsTake = async (feeRate) => {
          const lock = deriveLock({ prims: btc.prims, claimerPub: btc.wallet.pub, T: secretsOf(rec).T, lockerXonly: hexToBytes(strip(rec.offer.btc.lockerXonly)), csvBlocks: rec.csvBlocks });
          const sk = claimSecret({ dClaimer: btc.wallet.priv, t: BigInt(rec.t), lock });
          return btc.tx.claimSats({ lockOut: { txid: rec.lockTxid, vout: rec.lockVout, value: rec.lockValue }, lock, sk, feeRate, maxFee: Math.floor(rec.lockValue * (policy.takeMaxFeeShare ?? 0.5)) });
        };
        // (`tip`: the newest block when the take was sent, so a take that a block goes by without is replaced then, not only after takeBumpSecs)
        const tipNow = async () => (btc.tip ? await Promise.resolve().then(() => btc.tip()).catch(() => null) : null);
        const takeRecord = (pair, feeRate, bumps, tip = null) => ({ txid: pair.revealTxid, commitTxid: null, commitHex: null, revealHex: pair.revealHex, at: ctx.now(), feeRate, fee: pair.revealFee, vsize: btc.tx.vsizeOf(pair.revealTx), bumps, tip });
        // (a take a block went by without is replaced only when the next block's rate has caught up with it: one that is still above it missed by chance)
        const missedBlock = async (t) => t.tip != null && ctx.now() - t.at >= (policy.takeMissMinSecs ?? 120) && (await tipNow()) >= t.tip + (policy.takeMissBlocks ?? 1) && Math.ceil(await btc.feeRate()) >= Number(t.feeRate || 0);
        if (satsTake && !rec.take) {
          const feeRate = Math.ceil((await btc.feeRate()) * (policy.takeFeeFactor ?? 1.5));
          const pair = await buildSatsTake(feeRate);
          await save(rec, { take: takeRecord(pair, feeRate, 0, await tipNow()), takes: [pair.revealTxid] });
        }
        if (satsTake) {
          // the lock spent by a transaction that is none of ours, and confirmed: the user's refund won the race. Said as it is, not as a take that landed.
          const spent = await btc.outspend(rec.lockTxid, rec.lockVout).catch(() => null);
          if (spent && !(rec.takes || []).includes(spent) && ((await btc.status(spent).catch(() => null)) || {}).confirmations) {
            // A spend that is not the refund (the script path, with the timelock as its sequence) is a take by this key (only t opens the key path): one sent from
            // another page or an earlier visit, which this record never saw. The swap is done.
            const tx = btc.fetchTx ? await btc.fetchTx(spent).catch(() => null) : null;
            const input = tx && (tx.vin || []).find((i) => i.txid === rec.lockTxid && Number(i.vout) === Number(rec.lockVout));
            if (input && input.sequence != null && Number(input.sequence) !== Number(rec.csvBlocks)) return save(rec, { phase: 'done', takenBy: spent });
            return save(rec, { phase: 'lost', why: 'the lock was spent by another transaction (its refund, once the timelock had run) before a take confirmed' });
          }
        }
        // A take that was locked with the lock is swept to this address first, by the key path now that t is known (a transaction that pays its fee out of
        // the output): the coin it leaves funds the commit of the take of the note, so this side needs no coin of its own. A sweep that waits is replaced like
        // a take of sats. If the output is gone (the user's refund opened it) or too small, the take of the note is funded as it always was.
        if (!satsTake && rec.takeVout != null && !rec.take && !rec.sweepSkipped) {
          const lock = deriveLock({ prims: btc.prims, claimerPub: btc.wallet.pub, T: secretsOf(rec).T, lockerXonly: hexToBytes(strip(rec.offer.btc.lockerXonly)), csvBlocks: rec.csvBlocks });
          const sk = claimSecret({ dClaimer: btc.wallet.priv, t: BigInt(rec.t), lock });
          const sweepAt = (feeRate) => btc.tx.claimSats({ lockOut: { txid: rec.lockTxid, vout: rec.takeVout, value: rec.takeValue }, lock, sk, feeRate, maxFee: Math.floor(rec.takeValue * (policy.sweepMaxFeeShare ?? 0.5)) });
          if (!rec.sweep) {
            const feeRate = Math.ceil((await btc.feeRate()) * (policy.takeFeeFactor ?? 1.5));
            let pair = null;
            try { pair = sweepAt(feeRate); } catch (err) { if (!/does not cover the fee|no spendable amount/.test(String((err && err.message) || err))) throw err; }
            if (!pair) return save(rec, { sweepSkipped: true });
            await save(rec, { sweep: takeRecord(pair, feeRate, 0), sweeps: [pair.revealTxid] });
          }
          let landed = null;
          for (const id of rec.sweeps || [rec.sweep.txid]) if (((await btc.status(id).catch(() => null)) || {}).confirmations) landed = id;
          if (!landed) {
            const gone = await btc.outspend(rec.lockTxid, rec.takeVout).catch(() => null);
            if (gone && !(rec.sweeps || []).includes(gone)) return save(rec, { sweepSkipped: true });
            try { await btc.broadcast(rec.sweep, null); } catch (err) { if (!(await btc.outspend(rec.lockTxid, rec.takeVout).catch(() => null))) throw err; }
            if ((rec.sweep.bumps || 0) < (policy.takeMaxBumps ?? 8) && ctx.now() - rec.sweep.at > (policy.takeBumpSecs ?? 1200)) {
              const prev = rec.sweep.feeRate, vsize = rec.sweep.vsize || 100;
              const feeRate = Math.max(Math.ceil(prev * 1.5), prev + 2, Math.ceil(await btc.feeRate()), Math.ceil((rec.sweep.fee + vsize + 1) / vsize));
              const pair = sweepAt(feeRate);
              if (pair.revealFee > rec.sweep.fee) { await save(rec, { sweep: takeRecord(pair, feeRate, (rec.sweep.bumps || 0) + 1), sweeps: [...(rec.sweeps || []), pair.revealTxid] }); await btc.broadcast(rec.sweep, null); }
              else await save(rec, { sweep: { ...rec.sweep, bumps: policy.takeMaxBumps ?? 8 } });
            }
            return rec;
          }
          if (landed !== rec.sweep.txid) await save(rec, { sweep: { ...rec.sweep, txid: landed } });
        }
        // A take of a note is a commit (funded from this address's coins) and a reveal that spends the lock. Its record keeps the coins the commit spent,
        // its rate and fee, so a take that waits can be replaced by a pair spending the same coins at a higher rate (below).
        const claim = (coins, feeRate) => {
          const lock = deriveLock({ prims: btc.prims, claimerPub: btc.wallet.pub, T: secretsOf(rec).T, lockerXonly: hexToBytes(strip(rec.offer.btc.lockerXonly)), csvBlocks: rec.csvBlocks });
          const sk = claimSecret({ dClaimer: btc.wallet.priv, t: BigInt(rec.t), lock });
          return btc.tx.claimTransfer({
            asset: hexToBytes(strip(rec.offer.btc.asset)), lockOut: { txid: rec.lockTxid, vout: rec.lockVout, value: rec.lockValue }, lock, sk,
            amount: BigInt(rec.offer.btc.value), rLock: BigInt('0x' + strip(rec.offer.btc.rLock)), satsUtxos: coins, feeRate,
          });
        };
        const noteTake = (pair, coins, feeRate, bumps) => ({
          txid: pair.revealTxid, commitTxid: pair.commitTxid, commitHex: pair.commitHex, revealHex: pair.revealHex, at: ctx.now(),
          feeRate, fee: pair.commitFee + pair.revealFee, commitVsize: btc.tx.vsizeOf(pair.commitTx), bumps,
          coins: pair.commitTx.inputs.map((i) => coins.find((c) => c.txid === i.txid && c.vout === i.vout)).filter(Boolean),
        });
        if (!rec.take) {
          const feeRate = await btc.feeRate();
          // The lock paid the fee of this take to this address: that coin is read from the lock's own transaction and tried first, so the take does not wait
          // on the address's whole coin list (which explorers refuse for a busy address and rate limit hardest). The list is asked for only when it is not enough.
          const own = typeof btc.coinsIn === 'function' ? await btc.coinsIn(rec.sweep && !rec.sweepSkipped ? rec.sweep.txid : rec.lockTxid).catch(() => []) : [];
          let pair = null, used = own;
          if (own.length) {
            try { pair = claim(own, feeRate); } catch (e) { if (!/not enough sats to fund the commit/.test(String((e && e.message) || e))) throw e; }
          }
          if (!pair) {
            const listed = await btc.satsUtxos();
            used = [...own, ...listed.filter((c) => !own.some((o) => o.txid === c.txid && o.vout === c.vout))];
            pair = claim(used, feeRate);
          }
          await save(rec, { take: noteTake(pair, used, feeRate, 0), takes: [...(rec.takes || []), pair.revealTxid] });
        }
        // A take that has confirmed is done, and is not sent again: its commit's output is spent by its reveal, so a node refuses the commit as having no inputs
        // (bad-txns-inputs-missingorspent), which is no failure. Asked after the send as well, for a take that confirmed between the two reads. A status that cannot
        // be read is not a take that is not there: it goes on to the send, as it always did.
        // (a sats take that was replaced by a higher fee may have confirmed as an earlier one: any of this swap's takes landing ends it)
        const confirmed = async () => {
          for (const id of new Set([...(rec.takes || []), rec.take.txid])) if (((await btc.status(id).catch(() => null)) || {}).confirmations) return true;
          return false;
        };
        if (await confirmed()) return save(rec, { phase: 'done' });
        try { await btc.broadcast(rec.take, null); } catch (e) {
          if (await confirmed()) return save(rec, { phase: 'done' });
          if (rec.take.commitTxid && rec.take.at != null && ctx.now() - rec.take.at > 600 && (rec.takeRebuilds || 0) < 5 && !(await btc.fetchTx(rec.take.commitTxid).catch(() => true))) await save(rec, { take: null, takeRebuilds: (rec.takeRebuilds || 0) + 1 });
          throw e;
        }
        if (await confirmed()) return save(rec, { phase: 'done' });
        if (satsTake && (rec.take.bumps || 0) < (policy.takeMaxBumps ?? 8) && (ctx.now() - rec.take.at > (policy.takeBumpSecs ?? 1200) || (await missedBlock(rec.take)))) {
          // A replacement must pay at least a relay increment (1 sat/vB of its size) more than the take it replaces, and the wallet's fee has a floor, so
          // a higher rate alone can leave the fee where it was: the rate is also raised until the fee is higher. The market may have moved since too.
          const prev = rec.take.feeRate, vsize = rec.take.vsize || 100;
          const feeRate = Math.max(Math.ceil(prev * 1.5), prev + 2, Math.ceil(await btc.feeRate()), Math.ceil((rec.take.fee + vsize + 1) / vsize));
          const pair = await buildSatsTake(feeRate);
          if (pair.revealFee > rec.take.fee) {
            await save(rec, { take: takeRecord(pair, feeRate, (rec.take.bumps || 0) + 1, await tipNow()), takes: [...(rec.takes || []), pair.revealTxid] });
            await btc.broadcast(rec.take, null);
          } else await save(rec, { take: { ...rec.take, bumps: policy.takeMaxBumps ?? 8 } });     // the cap holds the fee where it was: a replacement would pay no more
        }
        // A take of a note that waits is replaced too, while its commit has not confirmed: a new pair spends the same coins (so its commit replaces the
        // old one, and the old reveal with it) at a rate whose commit alone pays more than the whole pair it replaces, as a replacement must. It is the
        // take that must land before the user's refund opens. A replacement costs several times the pair, so it is made only once the refund is near
        // (takeBumpBlocks); until then a slow take is left to confirm. A take whose commit has confirmed keeps its reveal; the alert for a long take says so.
        const refundNear = async () => rec.lockHeight == null || rec.lockHeight + rec.csvBlocks - 1 - (await btc.tip()) <= (policy.takeBumpBlocks ?? 36);
        if (!satsTake && rec.take.fee != null && Array.isArray(rec.take.coins) && rec.take.coins.length && (rec.take.bumps || 0) < (policy.takeMaxBumps ?? 8)
          && ctx.now() - rec.take.at > (policy.takeBumpSecs ?? 1200) && (await refundNear()) && !((await btc.status(rec.take.commitTxid).catch(() => null)) || {}).confirmations) {
          const prev = rec.take.feeRate || 1, cv = rec.take.commitVsize || 150;
          const feeRate = Math.max(Math.ceil(prev * 1.5), prev + 2, Math.ceil(await btc.feeRate()), Math.ceil((rec.take.fee + cv + 1) / cv));
          const extra = (await btc.satsUtxos().catch(() => [])).filter((c) => !rec.take.coins.some((o) => o.txid === c.txid && o.vout === c.vout));
          const coins = [...rec.take.coins, ...extra];
          let pair;
          try { pair = claim(coins, feeRate); } catch (e) {
            await save(rec, { take: { ...rec.take, at: ctx.now() }, why: 'the take waits and its fee cannot be raised: ' + String((e && e.message) || e).slice(0, 160) });
            return rec;
          }
          if (pair.commitFee + pair.revealFee > (policy.takeMaxFeeSats ?? 200000)) {
            await save(rec, { take: { ...rec.take, bumps: policy.takeMaxBumps ?? 8 }, why: 'the take waits and its fee is at the most it may pay' });
            return rec;
          }
          await save(rec, { take: noteTake(pair, coins, feeRate, (rec.take.bumps || 0) + 1), takes: [...(rec.takes || []), pair.revealTxid] });
          await btc.broadcast(rec.take, null);
        }
        return rec;
      }
      case 'refunding': {
        if (waiting(rec)) return rec;
        // While the nodes do not agree on what became of the lock, the refund goes on: the pool takes it only for a lock that is still unspent. The wait is the
        // step's error, so it is seen.
        let r = null, held = null;
        try { r = await readLock(rec); } catch (e) { if (!(e && e.quorum)) throw e; held = e; }
        if (r && (r.t || r.lost)) return afterRead(rec, r);
        if (r && r.refunded) return save(rec, { phase: 'refunded' });
        const out = await refundStep(rec);
        if (held && out.phase === 'refunding') throw held;
        return out;
      }
      default:
        return rec;
    }
  }

  async function refundStep(rec) {
    if (!rec.refund) {
      const position = await evm.lockPosition(rec.lock.lockLeaf);
      if (!position) {
        // (given up only once the nodes agree the pool holds no such lock)
        if ((await evm.now()) > rec.deadline + margin + 3600 && (!evm.lockAbsent || (await evm.lockAbsent(rec.lock.lockLeaf)))) return save(rec, { phase: 'aborted', why: 'the lock never reached the pool' });
        return rec;
      }
      return save(rec, { refund: { op: await evm.refundOp({ rec, position }) } });
    }
    if (!rec.refund.jobId) {
      const { jobId } = await evm.submit('adaptorrefund', rec.refund.op);
      return save(rec, { refund: { ...rec.refund, jobId } });
    }
    const st = await evm.jobStatus(rec.refund.jobId, { type: 'adaptorrefund', bundle: rec.refund.op });
    // the relay's word, and the pool's: the lock spent, as the nodes agree a few blocks down
    if (st === 'settled') return !evm.spentAgreed || (await evm.spentAgreed(rec.lock.lockNu, { final: policy.claimDepth ?? 12 })) ? save(rec, { phase: 'refunded' }) : rec;
    if (st === 'failed') return save(rec, { refund: { ...rec.refund, jobId: null } });
    return rec;
  }

  // A swap that has not moved for longer than it should is looked at afresh: every wait this machine keeps (a read put off, a build put off, the explorers'
  // agreement asked at most every so often) is let go and the swap is stepped now. Nothing that decides anything is skipped: the step makes every check it
  // always makes, only sooner.
  function poke(rec) {
    return serial(rec.id, async () => {
      const cur = (await store.get(rec.id)) || rec;
      if (['done', 'refunded', 'aborted', 'lost'].includes(cur.phase)) return cur;
      return save(cur, { lookAt: null, agreeAt: null, buildRetryAt: null, preRetryAt: null, pokedAt: ctx.now() });
    }).then((r) => step(r));
  }

  const KEEPS_ERROR = new Set(['aborted', 'rejected', 'lost']);
  // `nodesSince`: since when the swap waits on Ethereum nodes that do not agree (or too few answer); the page and the provider say so once it is long
  function step(rec) {
    return serial(rec.id, async () => {
      const cur = (await store.get(rec.id)) || rec;
      try {
        const before = cur.phase, out = await advance(cur);
        if (out && out.nodesSince != null) await save(out, { nodesSince: null });
        return out && out.lastError && out.phase !== before && !KEEPS_ERROR.has(out.phase) ? await save(out, { lastError: null }) : out;
      } catch (e) { return save(cur, { lastError: String((e && e.message) || e).slice(0, 300), nodesSince: e && e.quorum ? (cur.nodesSince ?? ctx.now()) : null }); }
    });
  }

  return { receive, step, poke };
}
