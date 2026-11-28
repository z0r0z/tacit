// The Bitcoin locker of a fast bridge swap: the party that holds the swap secret t, locks its Bitcoin note first and
// claims the Ethereum lock. In Bitcoin -> Ethereum this is the user; in Ethereum -> Bitcoin it is the liquidity provider.
// The Bitcoin side is a Tacit note or, with asset X.SATS_ASSET, plain sats (the lock is one ordinary transaction).
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
// From the moment the timelock has run, a lock that is still unspent is refunded in any phase before this side has sent a claim, so no stuck step
// (an offer that cannot be read, a counterparty that went away) holds the note; steps of one record run one at a time.
//
// Once a claim has been sent (to the relay, or from an account of this side's own), the lock is refunded only when the Ethereum nodes agree the claim did
// not land: the pool lock spent by a refund, or still unspent at a block past its deadline, after which no claim can land. A claim the pool shows (final,
// `finalDepth` blocks deep) ends the swap as done, whatever its job said and whenever it is read. A read that cannot be made (too few nodes, nodes that differ,
// a spend not yet deep enough) is made again and refunds nothing, in either direction: a refund taken while the claim had landed would take back sats the
// counterparty paid for (in BTC for ETH the user's page would end with both legs; in ETH for BTC the provider's refund would race the user's take with t).
// Waiting costs time and not the sats: the relay proves a claim with a private input or not at all (worker-relay/src/lib/private-prove.js), so a claim that
// did not land has not given t to the counterparty, which cannot take the lock without it.
//
// Phases:  built -> broadcast -> offered -> claiming -> claimed(-> done)       refund path from any phase before claimed:
//          ... -> refund-wait -> refunded            counter-took  (the lock was spent by the counterparty with t)
//
// ctx = { seed, now(), policy, store, btc, evm, counter }
//   store    { get(id), put(rec), list() }
//   policy   { csvBlocks, minClaimSecs, offerWaitSecs, maxEvmWindowSecs, claimMarginSecs (600) }
//   btc      { prims, wallet:{ pub, priv, xonly }, tx (makeAdaptorBtcTx), satsUtxos(), feeRate(), broadcast(pair),
//              status(txid) -> { confirmations, height }, tip(), outspend(txid, vout) -> spending txid | null }
//   evm      { now(), lockPosition(leaf) -> { lIndex, lPath, lockSetRoot } | null,
//              recipient(swapIdHex) -> { xonly, priv }, claimOp({ rec, evmOffer, sec, position }) -> an op the adapter sends as it is,
//              submit(type, op) -> { jobId }, claimStatus(jobId, { type, bundle, sinceSecs? }) -> 'pending' | 'settled' | 'failed'
//              (a claim the relay calls failed is settled when the pool shows its lock spent by a claim, read from sinceSecs on),
//              lockNullifier(leaf), findClaim(lockNu, { sinceSecs, check?, final? }) -> null (unspent) | [] (refunded) | [z, ...] (claimed); throws while unreadable }
//   counter  { sendOffer({ quoteId, offer }) -> { ok, retry?, why? }, getEvmOffer(swapIdHex) -> evmOffer | null,
//              extend?({ quoteId, txid }) -> { ok, retry?, why? } }

import * as X from './adaptor-xswap.js';
import { deriveLock } from './adaptor-btc-lock.js';
import { bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';

const hx = bytesToHex;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();

// The most all the bumps of a lock may pay: 1% of the amount, or more for a small amount (up to `lockBumpMaxSats` and `lockBumpShareBps` of it), never past what its change holds
export function lockBumpCap(amount, changeValue, policy = {}) {
  const a = Number(amount), pct = Math.floor((a * (policy.lockBumpMaxBps ?? 100)) / 10000);
  const small = Math.min(policy.lockBumpMaxSats ?? 1500, Math.floor((a * (policy.lockBumpShareBps ?? 600)) / 10000));
  return Math.min(Math.max(pct, small), Number(changeValue) - 547);
}

export function makeBitcoinLocker(ctx) {
  const { seed, store, policy, btc, evm, counter } = ctx;
  const secrets = (rec) => X.deriveSwapSecrets({ seed, swapId: hexToBytes(rec.id) });
  const lockOf = (rec) => deriveLock({ prims: btc.prims, claimerPub: rec.counterClaimPub, T: secrets(rec).T, lockerXonly: btc.wallet.xonly, csvBlocks: rec.csvBlocks });
  const save = async (rec, patch) => { Object.assign(rec, patch, { updated: ctx.now() }); await store.put(rec); return rec; };
  const margin = policy.claimMarginSecs ?? 600;
  const queues = new Map();
  const serial = (id, fn) => {
    const run = (queues.get(id) || Promise.resolve()).catch(() => {}).then(fn);
    queues.set(id, run);
    run.catch(() => {}).finally(() => { if (queues.get(id) === run) queues.delete(id); });
    return run;
  };

  // Builds the lock and stores it; sends nothing. `notes` are the wallet's own notes to lock from, `counterClaimPub` the
  // 33-byte Bitcoin key the counterparty committed to before this call, `takeSats` the fee of its take, which the lock pays
  // to that key's address so a counterparty needs no coins of its own on Bitcoin.
  async function build({ asset, amount, notes, counterClaimPub, evmAsset, evmAmount, quoteId = null, takeSats = 0, takeInLock = false, avoid = null, validUntil = null, csvBlocks: csvIn = null }) {
    if (X.isSats(asset)) return buildSats({ asset, amount, counterClaimPub, evmAsset, evmAmount, quoteId, avoid, validUntil, csvBlocks: csvIn });
    if (!notes.length) throw new Error('fastbridge: no note to lock');
    const swapId = X.swapIdOf(notes[0].txid, notes[0].vout), id = hx(swapId);
    const sec = X.deriveSwapSecrets({ seed, swapId });
    const csvBlocks = csvIn ?? policy.csvBlocks;
    const lock = deriveLock({ prims: btc.prims, claimerPub: counterClaimPub, T: sec.T, lockerXonly: btc.wallet.xonly, csvBlocks });
    const hint = X.lockHintScript({ seed, swapId, claimerPub: counterClaimPub, csvBlocks, value: amount });
    // The take is paid to the counterparty's own address, or (takeInLock) locked as a second output of the lock's own script: only the counterparty's key
    // with t opens it, and this side's refund opens it too, so a take is paid when the swap is done and comes back when it is not.
    const pay = takeSats > 0 ? { value: takeSats, script: takeInLock ? lock.spk : btc.prims.p2wpkhScript(counterClaimPub) } : null;
    // a coin the wallet knows to carry a note is never a fee coin, whatever sats it holds
    const coins = (await btc.satsUtxos()).filter((u) => !avoid || !avoid.has(`${u.txid}:${u.vout}`));
    const pair = btc.tx.lockTransfer({ asset, notes, lock, lockAmount: amount, rLock: sec.rLock, hint, pay, satsUtxos: coins, feeRate: await btc.feeRate() });
    const takeVout = takeSats > 0 && takeInLock ? pair.revealTx.outputs.findIndex((o, i) => i !== 0 && o.value === takeSats && hx(o.script) === hx(lock.spk)) : -1;
    if (takeSats > 0 && takeInLock && takeVout < 0) throw new Error('fastbridge: the take is not among the lock\'s outputs');
    const rec = {
      v: 1, role: 'bl', id, phase: 'built', created: ctx.now(), updated: ctx.now(), quoteId, validUntil,
      asset: hx(asset), amount: String(amount), evmAsset: strip(evmAsset), evmAmount: String(evmAmount),
      counterClaimPub: hx(counterClaimPub), csvBlocks, takeSats, ...(takeVout >= 0 ? { takeInLock: true, takeVout, takeValue: takeSats } : {}),
      lock: { txid: pair.revealTxid, vout: 0, value: pair.revealTx.outputs[0].value, commitTxid: pair.commitTxid, commitHex: pair.commitHex, revealHex: pair.revealHex },
      noteInputs: notes.map((n) => ({ txid: n.txid, vout: n.vout })),
      // the plain-sat coins that paid for the lock's commit: a bridge started right after this one (the parts of one split bridge) leaves them alone
      feeInputs: pair.commitTx.inputs.map((i) => ({ txid: i.txid, vout: i.vout })),
    };
    return { rec, pair };
  }
  // The same lock for plain sats (asset X.SATS_ASSET): the wallet's own coins, picked here, go into the lock output of one ordinary
  // transaction, and the first coin's outpoint is the swap id. No note, no commit, no coin kept for the fee of the counterparty's
  // take: a take or a refund pays its fee out of the lock output.
  // `first`: coins of this address to spend before its listed ones (a payment to it just sent, not yet in a block: the lock spends it at once)
  async function buildSats({ asset, amount, counterClaimPub, evmAsset, evmAmount, quoteId = null, avoid = null, validUntil = null, csvBlocks: csvIn = null, first = null }) {
    const feeRate = await btc.feeRate();
    const listed = await btc.satsUtxos(), at = (u) => `${u.txid}:${u.vout}`, early = (first || []).filter((c) => Number.isSafeInteger(c.value) && c.value > 0);
    const coins = [...early, ...listed.filter((u) => !early.some((c) => at(c) === at(u)))].filter((u) => !avoid || !avoid.has(at(u)));
    const picked = btc.tx.pickSats({ amount, satsUtxos: coins, feeRate });
    const swapId = X.swapIdOf(picked[0].txid, picked[0].vout), id = hx(swapId);
    const sec = X.deriveSwapSecrets({ seed, swapId });
    const csvBlocks = csvIn ?? policy.csvBlocks;
    const lock = deriveLock({ prims: btc.prims, claimerPub: counterClaimPub, T: sec.T, lockerXonly: btc.wallet.xonly, csvBlocks });
    // (the hint carries no fixed marker: nothing in the transaction says it is a Tacit lock)
    const hint = X.lockHintScript({ seed, swapId, claimerPub: counterClaimPub, csvBlocks, value: amount, bare: true });
    const pair = btc.tx.lockSats({ lock, amount, hint, coins: picked, feeRate });
    const rec = {
      v: 1, role: 'bl', id, phase: 'built', created: ctx.now(), updated: ctx.now(), quoteId, validUntil,
      asset: hx(asset), amount: String(amount), evmAsset: strip(evmAsset), evmAmount: String(evmAmount),
      counterClaimPub: hx(counterClaimPub), csvBlocks, takeSats: 0,
      lock: { txid: pair.revealTxid, vout: 0, value: pair.revealTx.outputs[0].value, commitTxid: null, commitHex: null, revealHex: pair.revealHex, ...lockFeeOf(pair) },
      noteInputs: [],
      // the coins that funded the lock: a swap started before it confirms must not pick them again
      feeInputs: picked.map((c) => ({ txid: c.txid, vout: c.vout })),
    };
    return { rec, pair };
  }
  // What a lock of sats paid and where its change went: what a bump from that change (bumpLock) needs
  // SEVERAL LOCKS IN ONE TRANSACTION: one lock output for each of `legs` ([{ counterClaimPub, amount, evmAsset, evmAmount, quoteId, csvBlocks }], one provider each), built
  // exactly as a lone lock is, each keyed to its provider's key and to a secret of its own (X.legSwapId: the swap id of output k is the first coin and k), one recovery hint for
  // all of them. Each record is a swap on its own, the lock output of its own (`lock.vout`), and shares only the transaction. Every record's quote expires with the first one:
  // a batch is sent whole or not at all (the 'built' step), never with some of its locks left out.
  async function buildSatsBatch({ legs, avoid = null, validUntil = null, first = null }) {
    const feeRate = await btc.feeRate();
    const listed = await btc.satsUtxos(), at = (u) => `${u.txid}:${u.vout}`, early = (first || []).filter((c) => Number.isSafeInteger(c.value) && c.value > 0);
    const coins = [...early, ...listed.filter((u) => !early.some((c) => at(c) === at(u)))].filter((u) => !avoid || !avoid.has(at(u)));
    const picked = btc.tx.pickSatsMany({ amounts: legs.map((l) => l.amount), satsUtxos: coins, feeRate });
    const ids = legs.map((_, k) => X.legSwapId(picked[0].txid, picked[0].vout, k));
    const made = legs.map((l, k) => {
      const sec = X.deriveSwapSecrets({ seed, swapId: ids[k] }), csvBlocks = l.csvBlocks ?? policy.csvBlocks;
      return { l, csvBlocks, lock: deriveLock({ prims: btc.prims, claimerPub: l.counterClaimPub, T: sec.T, lockerXonly: btc.wallet.xonly, csvBlocks }) };
    });
    const hint = X.lockBatchHintScript({ seed, swapId: ids[0], legs: made.map((m) => ({ claimerPub: m.l.counterClaimPub, csvBlocks: m.csvBlocks })) });
    const pair = btc.tx.lockSatsMany({ legs: made.map((m) => ({ lock: m.lock, amount: m.l.amount })), hint, coins: picked, feeRate });
    const until = [validUntil, ...legs.map((l) => l.validUntil)].filter((v) => v != null && Number(v) > 0).map(Number).sort((a, b) => a - b)[0] ?? null;
    const batch = { id: hx(ids[0]), n: legs.length, total: legs.reduce((t, l) => t + BigInt(l.amount), 0n).toString(), fee: pair.revealFee };
    const recs = made.map((m, k) => ({
      v: 1, role: 'bl', id: hx(ids[k]), phase: 'built', created: ctx.now(), updated: ctx.now(), quoteId: m.l.quoteId ?? null, validUntil: until,
      asset: hx(hexToBytes(X.SATS_ASSET)), amount: String(m.l.amount), evmAsset: strip(m.l.evmAsset), evmAmount: String(m.l.evmAmount),
      counterClaimPub: hx(m.l.counterClaimPub), csvBlocks: m.csvBlocks, takeSats: 0, batch: { ...batch, k }, ...(m.l.provider ? { provider: m.l.provider, providerName: m.l.providerName } : {}),
      // (only the first lock keeps the change, so that one leg alone bumps the transaction: lock.change is what bumpLock spends)
      lock: { txid: pair.revealTxid, vout: k, value: pair.revealTx.outputs[k].value, commitTxid: null, commitHex: null, revealHex: pair.revealHex, ...(k === 0 ? lockFeeOf(pair) : {}) },
      noteInputs: [], feeInputs: picked.map((c) => ({ txid: c.txid, vout: c.vout })),
    }));
    return { recs, pair };
  }
  async function startBatch(args) {
    const { recs } = await buildSatsBatch(args);
    for (const r of recs) if (await store.get(r.id)) throw new Error('fastbridge: this coin is already part of a swap');
    for (const r of recs) await store.put(r);
    return recs;
  }
  function lockFeeOf(pair) {
    if (!btc.tx.vsizeOf) return {};
    const own = hx(btc.prims.p2wpkhScript(btc.wallet.pub)), change = pair.revealTx.outputs.findIndex((o, i) => i > 0 && hx(o.script) === own);
    return { fee: pair.revealFee, vsize: btc.tx.vsizeOf(pair.revealTx), ...(change > 0 ? { change: { vout: change, value: pair.revealTx.outputs[change].value } } : {}) };
  }
  // A lock of sats that a block went by without is bumped (child pays for parent) from its change: a child whose fee lifts the two to the rate the explorers give
  // for the next block, never more than lockBumpCap between all its bumps (1% of the amount, or for a small amount up to `lockBumpMaxSats` (1,500) when that is not over 6% of it:
  // 1% of 26,000 sats cannot lift a lock out of a backlog, 2026-11-26), asked again after each block that still goes by without it, up
  // to `lockMaxBumps` times. The lock keeps its txid, which the counterparty holds. A bump that cannot be made changes nothing: the lock waits as it would have.
  async function bumpLock(rec) {
    if (!X.isSats(rec.asset) || policy.lockBump === false || !btc.tx.childSats || !rec.lock.change || rec.lock.fee == null || !rec.lock.vsize || !btc.tip) return;
    const tip = await btc.tip();
    if (rec.bumpTip == null) { await save(rec, { bumpTip: tip }); return; }
    if (tip < rec.bumpTip + (policy.lockBumpBlocks ?? 1)) return;
    const last = rec.cpfp || null;
    if ((last ? last.bumps : 0) >= (policy.lockMaxBumps ?? 4)) return;
    const rate = Math.ceil(await (btc.nextFeeRate ? btc.nextFeeRate() : btc.feeRate(0))), childVb = btc.tx.childVsize ? btc.tx.childVsize() : 110;
    const cap = lockBumpCap(rec.amount, rec.lock.change.value, policy);
    let fee = rate * (rec.lock.vsize + childVb) - rec.lock.fee;
    if (last) fee = Math.max(fee, last.fee + childVb + 1);                 // (a replacement pays more than the child it replaces, by the relay's increment)
    fee = Math.min(fee, cap);
    if (!(fee > (last ? last.fee : 0)) || fee <= 0) { await save(rec, { bumpTip: tip }); return; }
    const pair = btc.tx.childSats({ coin: { txid: rec.lock.txid, vout: rec.lock.change.vout, value: rec.lock.change.value }, fee });
    await save(rec, { bumpTip: tip, cpfp: { txid: pair.revealTxid, revealHex: pair.revealHex, commitHex: null, commitTxid: null, fee, rate, at: ctx.now(), bumps: (last ? last.bumps : 0) + 1 } });
    await btc.broadcast(rec.cpfp, null);
  }

  async function start(args) {
    if (X.isSats(args.asset)) {
      const { rec } = await buildSats(args);
      if (await store.get(rec.id)) throw new Error('fastbridge: this coin is already part of a swap');
      await store.put(rec);
      return rec;
    }
    if (!args.notes.length) throw new Error('fastbridge: no note to lock');
    if (await store.get(hx(X.swapIdOf(args.notes[0].txid, args.notes[0].vout)))) throw new Error('fastbridge: this note is already part of a swap');
    const { rec } = await build(args);
    await store.put(rec);
    return rec;
  }

  // A take that was locked with the lock goes back with it, by the same refund path and a transaction of its own (its fee comes out of the output). It is
  // tended apart from the note's refund, which it never holds up: what goes wrong here is kept in `takeWhy` and tried again.
  async function refundTake(rec) {
    if (rec.takeVout == null || rec.takeSettled) return;
    const out = { txid: rec.lock.txid, vout: rec.takeVout, value: Number(rec.takeValue) };
    try {
      if (await btc.outspend(out.txid, out.vout)) { await save(rec, { takeSettled: true }); return; }
      if (!rec.takeRefund) {
        let pair;
        try { pair = btc.tx.refundSats({ lockOut: out, lock: lockOf(rec), dLocker: btc.wallet.priv, feeRate: await btc.feeRate(), maxFee: Math.floor(out.value * (policy.takeRefundMaxFeeShare ?? 0.5)) }); } catch (e) {
          if (/does not cover the fee/.test(String((e && e.message) || e))) { await save(rec, { takeSettled: true, takeWhy: 'too small to return' }); return; }
          throw e;
        }
        await save(rec, { takeRefund: { txid: pair.revealTxid, commitHex: null, revealHex: pair.revealHex, commitTxid: null, at: ctx.now() } });
      }
      await btc.broadcast(rec.takeRefund, null);
    } catch (e) { await save(rec, { takeWhy: String((e && e.message) || e).slice(0, 200) }); }
  }

  // The Bitcoin refund, once the lock is old enough and still unspent.
  async function maybeRefund(rec) {
    const st = await btc.status(rec.lock.txid);
    if (!st.confirmations) return null;
    const spent = await btc.outspend(rec.lock.txid, rec.lock.vout);
    if (spent) return spent;
    const tip = await btc.tip();
    if (tip < st.height + rec.csvBlocks - 1) return null;
    if (!rec.refund) {
      const lock = lockOf(rec), sec = secrets(rec);
      const lockOut = { txid: rec.lock.txid, vout: rec.lock.vout, value: rec.lock.value ?? 546 };
      // A refund never pays more than a ceiling, whatever rate the explorers gave: a share of the lock for plain sats (the fee comes out of the lock),
      // a fixed amount for a note (it comes out of the fee coins). Over it, the refund waits for the next rate; the timelock does not run out.
      const pair = X.isSats(rec.asset)
        ? btc.tx.refundSats({ lockOut, lock, dLocker: btc.wallet.priv, feeRate: await btc.feeRate(), maxFee: Math.floor(Number(lockOut.value) * (policy.refundMaxFeeShare ?? 0.25)) })
        : btc.tx.refundTransfer({
          asset: hexToBytes(rec.asset), lockOut, lock, dLocker: btc.wallet.priv,
          amount: BigInt(rec.amount), rLock: sec.rLock, satsUtxos: await btc.satsUtxos(), feeRate: await btc.feeRate(),
        });
      if (!X.isSats(rec.asset) && pair.commitFee + pair.revealFee > (policy.refundMaxFeeSats ?? 200000)) throw new Error(`the refund would cost ${pair.commitFee + pair.revealFee} sats at the current rate, more than this side pays; asked again with the next rate`);
      await save(rec, { refund: { txid: pair.revealTxid, commitHex: pair.commitHex, revealHex: pair.revealHex, commitTxid: pair.commitTxid, at: ctx.now() } });
    }
    try { await btc.broadcast(rec.refund, null); } catch (e) {
      // as the take: a pair whose funding coin was spent elsewhere is built again once it has had time to spread
      // (a sats refund has no commit, so no funding coin that could have been spent elsewhere)
      if (rec.refund.commitTxid && rec.refund.at != null && ctx.now() - rec.refund.at > 600 && (rec.refundRebuilds || 0) < 5 && btc.fetchTx && !(await btc.fetchTx(rec.refund.commitTxid).catch(() => true))) await save(rec, { refund: null, refundRebuilds: (rec.refundRebuilds || 0) + 1 });
      throw e;
    }
    await refundTake(rec);
    return null;
  }

  // The clock a claim is handed out by: the chain's (evm.now, the time the nodes agree on) or this machine's, whichever is later. A claim gives t to the side that
  // holds the pre-signature, so a node that is behind (or lies) must not make a deadline look further away than it is; a machine whose clock runs ahead only claims
  // sooner. Whether a claim can still land is the chain's alone (claimVerdict, the deadline check while claiming): the pool takes one until its own clock passes.
  const claimClock = async () => Math.max(await evm.now(), Math.floor(Number(ctx.now())));
  // What the pool shows of this side's claim, once one was sent: 'landed' (the lock spent by a claim, final), 'missed' (the nodes agree it was refunded, or
  // that it is unspent at a block past the deadline, when no claim can land any more), or 'unread' (not settled yet). A read that cannot be made throws (nodes
  // that disagree with `quorum` set), and the step keeps its phase; a spend not yet final is waited for quietly.
  const claimSent = (rec) => !!(rec.claimSent || (rec.claim && rec.claim.jobId));
  async function claimVerdict(rec) {
    const nu = evm.lockNullifier(rec.evmOffer.lockLeaf);
    const ownS = rec.claim && rec.claim.op && rec.claim.op.op && rec.claim.op.op.kernelS, mine = ownS ? (z) => BigInt(z) === BigInt(ownS) : null;
    let zs;
    try { zs = await evm.findClaim(nu, { sinceSecs: rec.claimStartedAt || 0, final: policy.finalDepth ?? 64, ...(mine ? { check: mine } : {}) }); } catch (e) { if (/not deep enough/.test(String((e && e.message) || e)) && !(e && e.quorum)) return 'unread'; throw e; }
    if (zs && zs.length) return 'landed';               // (only this side's key opens the lock's claim: a claim the pool shows is this side's)
    if (zs) return 'missed';                            // refunded
    if ((await evm.now()) <= rec.evmOffer.deadline + margin) return 'unread';
    if (!evm.spentAgreed) return 'missed';
    return (await evm.spentAgreed(nu, { final: policy.unspentDepth ?? 12 })) ? 'unread' : 'missed';
  }

  // Whether the lock is spent already, or unspent with its timelock run, for the phases that wait on the counterparty.
  async function lockState(rec) {
    const st = await btc.status(rec.lock.txid);
    if (!st.confirmations) return null;
    if (await btc.outspend(rec.lock.txid, rec.lock.vout)) return 'spent';
    return (await btc.tip()) >= st.height + rec.csvBlocks - 1 ? 'due' : null;
  }

  async function advance(rec) {
    let state = null;
    if (rec.phase === 'broadcast' || rec.phase === 'offered' || rec.phase === 'claiming') {
      state = await lockState(rec);
      // while claiming, a spent lock is not yet a claim that landed (t can be out before the claim is in), so the claim is carried on below
      if (state === 'spent' && rec.phase !== 'claiming') return save(rec, { phase: 'counter-took', why: 'the lock was spent' });
      if (state === 'due') return save(rec, { phase: 'refund-wait', why: 'the timelock has run' });
    }
    switch (rec.phase) {
      case 'built': {
        // A lock already on the network moves on, whatever an earlier send was told. One that never went out is not sent once its quote has
        // run out (and a few minutes more), since the counterparty no longer holds the payout for it; its notes stay where they are.
        const seen = (await btc.status(rec.lock.txid)).confirmations > 0 || (btc.fetchTx ? !!(await btc.fetchTx(rec.lock.txid, { quick: true })) : false);
        if (!seen) {
          if (rec.validUntil && ctx.now() > Number(rec.validUntil) + 600) return save(rec, { phase: 'aborted', why: 'the lock was not sent before the quote ran out' });
          await btc.broadcast(rec.lock, null);
        }
        return save(rec, { phase: 'broadcast', broadcastAt: ctx.now(), bumpTip: btc.tip ? await Promise.resolve().then(() => btc.tip()).catch(() => null) : null });
      }
      case 'broadcast': {
        // the provider is asked to hold the payout through the confirmation; a provider that does not answer this is not waited on
        if (!rec.extended && counter.extend && rec.quoteId) {
          try {
            // (with the lock's terms, so the provider can see the transaction pays this lock and no other output; a lock of plain sats also carries its whole offer,
            // the one sent once the lock is confirmed, so a provider can build and prove its pool lock while the block is awaited: it locks nothing before the
            // confirmations, and a provider that does not build ahead reads only the terms)
            const s0 = secrets(rec);
            const early = X.isSats(rec.asset) && policy.early !== false ? X.makeBtcLockOffer({
              swapId: hexToBytes(rec.id), asset: rec.asset, value: BigInt(rec.amount), rLock: null, txid: rec.lock.txid, vout: rec.lock.vout, csvBlocks: rec.csvBlocks, lockerXonly: btc.wallet.xonly, T: s0.T,
              claimerPub: rec.counterClaimPub, evm: { asset: rec.evmAsset, amount: BigInt(rec.evmAmount), recipient: hx((await evm.recipient(rec.id)).xonly), rOut: s0.rOut },
            }) : null;
            const r = await counter.extend({ quoteId: rec.quoteId, txid: rec.lock.txid, lock: { T: hx(s0.T.toRawBytes(true)), lockerXonly: hx(btc.wallet.xonly) }, ...(early ? { offer: early } : {}) });
            if (!(r && r.ok === false && r.retry)) await save(rec, { extended: !(r && r.ok === false), extendWhy: r && r.ok === false ? String(r.why || '') : null });
          } catch { /* asked again on the next step */ }
        }
        const st = await btc.status(rec.lock.txid);
        if (!st.confirmations) { try { await bumpLock(rec); } catch (e) { await save(rec, { bumpWhy: String((e && e.message) || e).slice(0, 160) }); } return rec; }
        // confirmedAt is when this side saw it (the offer's wait counts from it); lockAt is the block's time, which the timelock counts from
        if (!rec.confirmedAt) await save(rec, { confirmedAt: ctx.now(), lockHeight: st.height, lockAt: btc.blockTime ? await btc.blockTime(st.height).catch(() => null) : null });
        const sec = secrets(rec), recipient = await evm.recipient(rec.id);
        const offer = X.makeBtcLockOffer({
          swapId: hexToBytes(rec.id), asset: rec.asset, value: BigInt(rec.amount), rLock: X.isSats(rec.asset) ? null : sec.rLock, txid: rec.lock.txid, vout: rec.lock.vout,
          csvBlocks: rec.csvBlocks, lockerXonly: btc.wallet.xonly, T: sec.T, claimerPub: rec.counterClaimPub,
          evm: { asset: rec.evmAsset, amount: BigInt(rec.evmAmount), recipient: hx(recipient.xonly), rOut: sec.rOut },
        });
        let answer;
        try { answer = await counter.sendOffer({ quoteId: rec.quoteId, offer }); } catch (e) {
          if (ctx.now() - rec.confirmedAt > policy.offerWaitSecs) return save(rec, { phase: 'refund-wait', why: 'the counterparty could not be reached' });
          throw e;
        }
        if (answer && answer.ok === false) {
          if (answer.retry && ctx.now() - rec.confirmedAt <= policy.offerWaitSecs) return save(rec, { offerWhy: String(answer.why || '').slice(0, 200) });
          return save(rec, { phase: 'refund-wait', why: 'the counterparty declined: ' + answer.why });
        }
        return save(rec, { phase: 'offered', offeredAt: ctx.now(), offerWhy: null });
      }
      case 'offered': {
        // A lock found again from the key: the provider is asked for its offer with a growing gap (a minute, doubling to a quarter hour), not at every pass, and with none
        // seen after twenty minutes it is not coming: the swap goes to the refund. Until an offer is seen, the page says nothing of the provider sending anything.
        const fromKey = !!rec.claimFromKey && !rec.offerSeen, looks = rec.offerLooks || 0;
        if (fromKey && rec.offerLookAt && ctx.now() - rec.offerLookAt < Math.min(60 * 2 ** Math.min(looks, 4), 900)) return rec;
        const evmOffer = await counter.getEvmOffer(rec.id);
        if (fromKey) {
          if (!evmOffer) {
            if (ctx.now() - rec.offeredAt > Math.min(policy.offerWaitSecs, 1200)) return save(rec, { phase: 'refund-wait', why: 'the provider sent no offer for it' });
            return save(rec, { offerLookAt: ctx.now(), offerLooks: looks + 1 });
          }
          rec = await save(rec, { offerSeen: true });
        }
        if (evmOffer && !/^[0-9a-f]{64}$/.test(strip(evmOffer.lockLeaf || ''))) return save(rec, { phase: 'refund-wait', why: 'offer: malformed lock leaf' });
        // An offer whose lock the pool does not show yet is waited for, not refused: the lock may still be landing.
        const position = evmOffer ? await evm.lockPosition(evmOffer.lockLeaf) : null;
        if (!position) {
          if (ctx.now() - rec.offeredAt > policy.offerWaitSecs) return save(rec, { phase: 'refund-wait', why: evmOffer ? 'the offered lock never showed in the pool' : 'no Ethereum lock arrived' });
          return rec;
        }
        const chainNow = await evm.now(), nowSecs = Math.max(chainNow, Math.floor(Number(ctx.now())));   // (claimClock: the later of the two decides)
        const sec = secrets(rec), recipient = await evm.recipient(rec.id);
        // A swap found again from the key knows the lock's sats but not the ETH quoted for it (that was only in the lost record, and in the provider's quote). The
        // provider's offer is then taken only at no less than the market floor (ctx.recoverFloor, a share under the market price); with no floor to judge by it waits
        // (the timelock still returns the BTC), and an offer under it ends in the refund. The amount it is taken at is kept.
        let wantEvm = BigInt(rec.evmAmount);
        if (rec.recovered && wantEvm === 0n) {
          const floor = ctx.recoverFloor ? await ctx.recoverFloor(rec) : null;
          if (floor == null) return rec;
          if (BigInt(evmOffer.amount) < BigInt(floor)) return save(rec, { phase: 'refund-wait', why: 'offer: less ETH than the market price allows for these sats' });
          wantEvm = BigInt(evmOffer.amount);
        }
        const v = X.verifyEvmOffer(evmOffer, {
          mine: { T: sec.T, recipient: hx(recipient.xonly), rOut: sec.rOut },
          expect: { evmAsset: rec.evmAsset, evmAmount: wantEvm }, inLockSet: true, nowSecs, minClaimSecs: policy.minClaimSecs,
        });
        if (!v.ok) return save(rec, { phase: 'refund-wait', why: 'offer: ' + v.reasons.join('; ') });
        if (evmOffer.deadline - nowSecs > policy.maxEvmWindowSecs) return save(rec, { phase: 'refund-wait', why: 'offer: the deadline is further out than this side accepts' });
        return save(rec, { phase: 'claiming', evmOffer, position, claimStartedAt: chainNow, evmAmount: String(wantEvm) });
      }
      case 'claiming': {
        // Held back near the deadline, a claim keeps t to this side. Once the lock is spent t is out already, so the claim is sent while any time is left.
        const tooLate = async () => { const left = rec.evmOffer.deadline - (await claimClock()); return state === 'spent' ? left <= 0 : left < policy.minClaimSecs; };
        if (!rec.claim) {
          if (await tooLate()) return save(rec, { phase: 'refund-wait', why: 'too little time left to claim safely' });
          const position = (await evm.lockPosition(rec.evmOffer.lockLeaf)) || rec.position;
          // the claim is built and stored before it is sent, and is sent from the stored bytes
          return save(rec, { claim: { op: await evm.claimOp({ rec, evmOffer: rec.evmOffer, sec: secrets(rec), position }) } });
        }
        if (!rec.claim.jobId) {
          // a claim stored earlier is never sent with less than the minimum time left: it would publish t and miss the deadline
          if (await tooLate()) return save(rec, { phase: 'refund-wait', why: 'too little time left to claim safely' });
          // (from here on the claim may land whatever its job says: the lock is refunded only on the pool's word that it did not, claimVerdict)
          await save(rec, { claimSent: true });
          const { jobId } = await evm.submit('adaptorclaim', rec.claim.op);
          return save(rec, { claim: { ...rec.claim, jobId, at: await evm.now() } });
        }
        const st = await evm.claimStatus(rec.claim.jobId, { type: 'adaptorclaim', bundle: rec.claim.op, sinceSecs: rec.claimStartedAt });
        if (st === 'settled') return save(rec, { phase: 'claimed', claimedAt: ctx.now() });
        if (st === 'failed') return save(rec, { claim: { op: rec.claim.op }, claimFailures: (rec.claimFailures || 0) + 1 });
        // A claim still unanswered after the deadline can no longer land; whether one did is the pool's to say, read until the nodes agree on it
        if ((await evm.now()) > rec.evmOffer.deadline + margin) {
          const v = await claimVerdict(rec);
          if (v === 'landed') return save(rec, { phase: 'claimed', claimedAt: ctx.now() });
          if (v === 'missed') return save(rec, { phase: 'refund-wait', claimMissed: true, why: 'the claim did not land before the deadline' });
        }
        return rec;
      }
      case 'claimed': {
        // The Ethereum leg is done and the Bitcoin lock is the counterparty's, to take by its key path at any time. The claim is read from the pool on every
        // step until it is final (`finalDepth` blocks deep, as the nodes agree), and the swap is then done. Only a pool that shows no claim of this side's after
        // the deadline (claimVerdict 'missed') sends the swap to the refund; a read that cannot be made yet is made again, and refunds nothing.
        const spent = await btc.outspend(rec.lock.txid, rec.lock.vout);
        if (spent) return save(rec, { phase: 'done', takenBy: spent });
        const v = await claimVerdict(rec);
        if (v === 'landed') return save(rec, { phase: 'done', why: 'paid on Ethereum; the Bitcoin lock is the counterparty\'s to take' });
        if (v === 'missed') return save(rec, { phase: 'refund-wait', claimMissed: true, why: 'the pool shows no claim of this side\'s' });
        return rec;
      }
      case 'refund-wait': {
        // once a claim was sent, the lock goes back only when the pool shows the claim did not land; a claim it shows ends the swap as claimed
        if (claimSent(rec) && !rec.claimMissed && !(await btc.outspend(rec.lock.txid, rec.lock.vout))) {
          const v = await claimVerdict(rec);
          if (v === 'landed') return save(rec, { phase: 'claimed', claimedAt: ctx.now(), why: null });
          if (v !== 'missed') return rec;
          await save(rec, { claimMissed: true });
        }
        const taken = await maybeRefund(rec);
        if (taken) {
          // a refund sent from another browser, or a lock found again from the key, is not the one kept here: a refund is the spend that waited out the timelock
          let home = taken === rec.refund?.txid;
          if (!home && btc.fetchTx) {
            const tx = await btc.fetchTx(taken);
            if (!tx) throw new Error('the spend of the lock could not be read just now');
            home = (tx.vin || []).some((i) => i.txid === rec.lock.txid && Number(i.vout) === Number(rec.lock.vout) && Number(i.sequence) === Number(rec.csvBlocks));
          }
          // a take locked with the lock is not the counterparty's if the lock came home: it is tended until it is back (or for three days), then the swap is over
          if (home && rec.takeVout != null && !rec.takeSettled) {
            await refundTake(rec);
            if (!rec.takeSettled && ctx.now() - (rec.refund?.at ?? ctx.now()) < 3 * 86400) return rec;
          }
          return save(rec, { phase: home ? 'refunded' : 'counter-took', takenBy: taken });
        }
        if (rec.refund && (await btc.status(rec.refund.txid)).confirmations) return save(rec, { phase: 'refunded' });
        return rec;
      }
      default:
        return rec;
    }
  }

  // One step; a failing adapter call is recorded and the phase kept, so the next tick tries again. `nodesSince`: since when the swap waits on Ethereum nodes
  // that do not agree (or too few answer).
  function step(rec) {
    return serial(rec.id, async () => {
      const cur = (await store.get(rec.id)) || rec;
      try {
        // the reason a swap ends without its trade is in `why`: an error from before a phase moved on is not kept
        const before = cur.phase, out = await advance(cur);
        if (out && out.nodesSince != null) await save(out, { nodesSince: null });
        return out && out.lastError && out.phase !== before ? await save(out, { lastError: null }) : out;
      } catch (e) { return save(cur, { lastError: String((e && e.message) || e).slice(0, 300), nodesSince: e && e.quorum ? (cur.nodesSince ?? ctx.now()) : null }); }
    });
  }

  return { start, build, step, startBatch, buildBatch: buildSatsBatch };
}
