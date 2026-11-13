
import { buildCbtcLockEnvelope } from './cbtc-envelope.js';

export function makeCbtcLock(deps) {
  const {
    privkey,
    asset,
    commitXY,
    deriveCbtcNoteBlinding,
    anchorBytes,
    selectLockFunding,
    ownLockScriptPubKey,
    broadcastCbtcLockTx,
    postHint,
    lockVout = 1,
  } = deps;

  if (!(privkey instanceof Uint8Array) || privkey.length !== 32) throw new Error('cbtc-lock: privkey must be 32 bytes');
  if (typeof commitXY !== 'function') throw new Error('cbtc-lock: inject commitXY');
  if (typeof broadcastCbtcLockTx !== 'function') throw new Error('cbtc-lock: inject broadcastCbtcLockTx');

  // `onSigned(lock)` is awaited with the signed lock ({ lockTxid, lockVout, vBtc, anchor, commitTxid, commitHex, revealHex }) before
  // anything is sent; `feeRate` (sat/vB) is used for both transactions when given.
  async function buildAndBroadcastCbtcLock({ amountSats, feePadSats = 0n, waitOpts, feeRate = null, onSigned = null } = {}) {
    const vBtc = BigInt(amountSats);
    if (vBtc <= 546n) throw new Error('cbtc-lock: amount must be above the dust band');

    const sel = await selectLockFunding({ amountSats: vBtc + BigInt(feePadSats) });
    if (!sel || !sel.fundingPrevout) throw new Error('cbtc-lock: no funding available for the lock');
    const { fundingPrevout } = sel;

    const anchorOutpoint = anchorBytes(fundingPrevout.txid, fundingPrevout.vout);
    const blinding = deriveCbtcNoteBlinding({ privkey, anchorOutpoint, outputIndex: 0 });

    const { cx, cy } = commitXY(vBtc, blinding);
    const envelopeHex = buildCbtcLockEnvelope({ asset, lockVout, cx, cy });

    const lockSpk = ownLockScriptPubKey();
    const res = await broadcastCbtcLockTx({ fundingPrevout, vBtc, lockVout, lockSpk, envelopeHex, waitOpts, feeRate,
      onSigned: onSigned && ((s) => onSigned({ ...s, vBtc: String(vBtc), anchor: { txid: fundingPrevout.txid, vout: fundingPrevout.vout } })) });
    if (!res || !res.lockTxid) throw new Error('cbtc-lock: broadcast returned no lock txid');

    if (postHint) { try { await postHint(res.lockTxid, res.lockVout ?? lockVout); } catch { } }

    return {
      lockTxid: res.lockTxid,
      lockVout: res.lockVout ?? lockVout,
      vBtc: String(vBtc),
      blinding,
      anchor: fundingPrevout,
    };
  }

  // A commit already on Bitcoin ({ txid, value, script } of its first output, and `anchor`, its first input), read as this key's lock: the
  // note's blinding comes from that first input as it does when a lock is made, so the amount whose envelope reproduces the commit's
  // script is the lock's, and its reveal can be signed again. → { vBtc, lockVout, anchor, revealHex, lockTxid }, or null when it is no lock
  // of this key.
  async function lockOfCommit({ txid, value, script, anchor }) {
    if (typeof broadcastCbtcLockTx.revealForCommit !== 'function') throw new Error('cbtc-lock: the broadcast seam cannot read a commit back');
    const blinding = deriveCbtcNoteBlinding({ privkey, anchorOutpoint: anchorBytes(anchor.txid, anchor.vout), outputIndex: 0 });
    const amountOf = (vSats) => { const { cx, cy } = commitXY(BigInt(vSats), blinding); return buildCbtcLockEnvelope({ asset, lockVout, cx, cy }); };
    const r = await broadcastCbtcLockTx.revealForCommit({ commit: { txid, value, script }, lockVout, lockSpk: ownLockScriptPubKey(), amountOf });
    return r && { ...r, anchor: { txid: anchor.txid, vout: anchor.vout } };
  }

  return { buildAndBroadcastCbtcLock, lockOfCommit };
}
