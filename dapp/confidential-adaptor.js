// Op assemblers for the Ethereum leg of a cross-chain adaptor swap: the OP_ADAPTOR_LOCK / _CLAIM / _REFUND
// witnesses the relay's exec-adaptor{lock,claim,refund} harnesses read, byte-aligned to the guest (main.rs) and
// built the way the box-proven fixtures are (scripts/build-adaptor-exec-fixture.mjs,
// scripts/build-remaining-exec-fixtures.mjs). The swap terms, the pre-signature and the completed claim kernel
// come from dapp/adaptor-xswap.js. Inject `keccak256` (Uint8Array → 32B), `secp` (@noble/secp256k1, the one `pool`
// was built with), `signSchnorr` (dapp/bulletproofs.js), `curveOrder` (SECP_N) and `pool` (makeConfidentialPool).
//
// Byte layouts (big-endian raw concat, matching cxfer-core `kn`; u64 = 8 bytes):
//   lock leaf  = keccak("tacit-adaptor-lock-v1" ‖ asset ‖ Lx ‖ Ly ‖ Tx ‖ Ty ‖ deadline_be8 ‖ recipient ‖ locker)
//   claim msg  = keccak("tacit-adaptor-claim-auth-v1" ‖ chainBinding ‖ lockLeaf ‖ lockNu ‖ outLeaf ‖ amount_be8 ‖ kernelR(33) ‖ kernelS)
//   refund msg = keccak("tacit-adaptor-refund-auth-v1" ‖ chainBinding ‖ lockLeaf ‖ Ox ‖ Oy ‖ fee_be8 ‖ refundOwner)
// `locker` in the leaf is the refund key (x-only, signs the refund); the spent note's owner is its H(nk).
// The merkle witnesses (spendRoot/nPath, lockSetRoot/lPath, indices) come from the caller's view of the live
// trees, and the caller seals the memos (the relay hashes them into the proof).

export function makeConfidentialAdaptor({ keccak256, secp, signSchnorr, curveOrder, pool }) {
  const enc = new TextEncoder();
  const N = BigInt(curveOrder);
  const ZERO = '0x' + '00'.repeat(32);
  const LOCK_DOMAIN = enc.encode('tacit-adaptor-lock-v1');
  const CLAIM_DOMAIN = enc.encode('tacit-adaptor-claim-auth-v1');
  const REFUND_DOMAIN = enc.encode('tacit-adaptor-refund-auth-v1');
  const KERNEL_DOMAIN = enc.encode('tacit-evm-cxfer-kernel-v1');
  const REFUND_NONCE_DOMAIN = enc.encode('tacit-adaptor-refund-kernel-nonce-v1');

  const hx = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const concat = (arrs) => {
    const o = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
    let p = 0;
    for (const a of arrs) { o.set(a, p); p += a.length; }
    return o;
  };
  const bN = (h, n) => {
    const s = String(h).replace(/^0x/, '').padStart(n * 2, '0');
    if (s.length !== n * 2) throw new Error(`adaptor: expected a ${n}-byte value, got ${s.length / 2}`);
    return Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16)));
  };
  const b32 = (h) => bN(h, 32);
  const be = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
  const bToBig = (b) => b.reduce((a, y) => (a << 8n) | BigInt(y), 0n);
  const modN = (x) => ((x % N) + N) % N;
  const k = (...parts) => keccak256(concat(parts));
  const compressXY = (cx, cy) => concat([Uint8Array.of(bN(cy, 32)[31] & 1 ? 3 : 2), b32(cx)]);

  // ── byte-parity primitives (mirror cxfer-core) ──
  const adaptorLockLeaf = (asset, lCx, lCy, tx, ty, deadline, recipient, locker) =>
    hx(k(LOCK_DOMAIN, b32(asset), b32(lCx), b32(lCy), b32(tx), b32(ty), be(deadline, 8), b32(recipient), b32(locker)));
  const adaptorClaimMsg = (chainBinding, lockLeaf, lockNu, outLeaf, amount, kernelR, kernelS) =>
    k(CLAIM_DOMAIN, b32(chainBinding), b32(lockLeaf), b32(lockNu), b32(outLeaf), be(amount, 8), bN(kernelR, 33), b32(kernelS));
  const adaptorRefundMsg = (chainBinding, lockLeaf, oCx, oCy, fee, refundOwner) =>
    k(REFUND_DOMAIN, b32(chainBinding), b32(lockLeaf), b32(oCx), b32(oCy), be(fee, 8), b32(refundOwner));

  // LOCK: spend note N's FULL value into the lock-set as L (same amount, no change: split first to lock less).
  // `nNote` = { cx, cy, owner (H(nk)), blinding, leafIndex, path, secret (nk) }; `T` = { tx, ty } affine hex.
  // Both openings are bound to the whole lock (N, L→recipient, T, refundPub, amount, deadline), so a relay can
  // neither re-target nor re-price it.
  const buildAdaptorLock = ({ chainBinding, spendRoot, asset, nNote, amount, lBlinding, T, deadline, recipient, refundPub }) => {
    if (!nNote || nNote.secret == null) throw new Error('adaptor-lock: nNote.secret (the note\'s nk) is required — the guest reads it right after nPath');
    if (!(BigInt(amount) > 0n) || !(BigInt(deadline) > 0n)) throw new Error('adaptor-lock: amount and deadline must be positive');
    const L = pool.commitXY(amount, lBlinding);
    const ctx = pool.intentContext('tacit-adaptor-lock-intent-v1', chainBinding, asset, asset,
      [[nNote.cx, nNote.cy, nNote.owner], [L.cx, L.cy, recipient], [T.tx, T.ty, ZERO], [refundPub, ZERO, ZERO]],
      [BigInt(amount), BigInt(deadline)]);
    const nSig = pool.openingSigma(BigInt(amount), nNote.blinding, ctx, pool.deriveOpeningNonce(nNote.blinding, ctx, 'adaptor-lock-n'));
    const lSig = pool.openingSigma(BigInt(amount), lBlinding, ctx, pool.deriveOpeningNonce(lBlinding, ctx, 'adaptor-lock-l'));
    return {
      chainBinding, spendRoot, asset, locker: nNote.owner, recipient, refundPub, amount: Number(amount), tx: T.tx, ty: T.ty,
      deadline: Number(deadline), nCx: nNote.cx, nCy: nNote.cy, nIndex: nNote.leafIndex, nPath: nNote.path, nk: nNote.secret,
      nSigR: nSig.R, nSigZ: nSig.z, lCx: L.cx, lCy: L.cy, lSigR: lSig.R, lSigZ: lSig.z,
      lockLeaf: adaptorLockLeaf(asset, L.cx, L.cy, T.tx, T.ty, deadline, recipient, refundPub),
    };
  };

  // CLAIM: the recipient takes L into its own note O = commit(amount, oBlinding) owned by `outOwner` (H(nk)),
  // carrying the ADAPTOR-COMPLETED kernel { R, z } from adaptor-xswap completeEvmClaim — the guest commits z, which
  // is what publishes t. Fee-less by necessity (the kernel must stay zero-value); pay the relay from O afterwards.
  const buildAdaptorClaim = ({ chainBinding, lockSetRoot, asset, lCx, lCy, T, deadline, recipient, locker, lIndex, lPath, amount, oBlinding, kernel, outOwner, recipientPriv }) => {
    const O = pool.commitXY(amount, oBlinding);
    const oCtx = pool.intentContext('tacit-adaptor-claim-out-v1', chainBinding, asset, asset,
      [[O.cx, O.cy, recipient], [lCx, lCy, locker]], [BigInt(amount), BigInt(deadline)]);
    const oSig = pool.openingSigma(BigInt(amount), oBlinding, oCtx, pool.deriveOpeningNonce(oBlinding, oCtx, 'adaptor-claim-out'));
    const lockLeaf = adaptorLockLeaf(asset, lCx, lCy, T.tx, T.ty, deadline, recipient, locker);
    const lockNullifier = pool.nullifier(lockLeaf);
    const outLeaf = pool.leaf(asset, O.cx, O.cy, outOwner);
    const kernelR = '0x' + String(kernel.R).replace(/^0x/, '');
    const kernelS = '0x' + String(kernel.z).replace(/^0x/, '').padStart(64, '0');
    const msg = adaptorClaimMsg(chainBinding, lockLeaf, lockNullifier, outLeaf, amount, kernelR, kernelS);
    return {
      chainBinding, spendRoot: ZERO, lockSetRoot, asset, lCx, lCy, tx: T.tx, ty: T.ty, deadline: Number(deadline), recipient, locker,
      lIndex, lPath, amount: Number(amount), oCx: O.cx, oCy: O.cy, oSigR: oSig.R, oSigZ: oSig.z, kernelR, kernelS, outOwner,
      recipientSig: hx(signSchnorr(msg, b32(recipientPriv))),
      lockLeaf, lockNullifier, outLeaf,
    };
  };

  // REFUND: after the deadline the locker takes L back into O = commit(amount − fee, oBlinding) owned by
  // `refundOwner`, net of an optional relay `fee` (L = O + fee). Reveals nothing about t.
  const buildAdaptorRefund = ({ chainBinding, lockSetRoot, asset, lCx, lCy, T, deadline, recipient, locker, lockerPriv, lIndex, lPath, amount, lBlinding, oBlinding, fee = 0n, refundOwner }) => {
    const amountB = BigInt(amount), feeB = BigInt(fee);
    if (feeB >= amountB) throw new Error('adaptor-refund: fee must be below the locked amount');
    const O = pool.commitXY(amountB - feeB, oBlinding);
    const lockLeaf = adaptorLockLeaf(asset, lCx, lCy, T.tx, T.ty, deadline, recipient, locker);
    const refundCtx = pool.intentContext('tacit-adaptor-refund-v1', chainBinding, asset, asset,
      [[lCx, lCy, locker], [O.cx, O.cy, locker]], [amountB, BigInt(deadline)]);
    const lSig = pool.openingSigma(amountB, lBlinding, refundCtx, pool.deriveOpeningNonce(lBlinding, refundCtx, 'adaptor-refund-l'));
    // Fee kernel over L − O − fee·H = (r_L − r_O)·G: Schnorr, e = keccak(KERNEL_DOMAIN ‖ L ‖ O ‖ R).
    const x = modN(bToBig(b32(lBlinding)) - bToBig(b32(oBlinding)));
    const cL = compressXY(lCx, lCy), cO = compressXY(O.cx, O.cy);
    const kn = modN(bToBig(k(REFUND_NONCE_DOMAIN, be(x, 32), cL, cO))) || 1n;
    const R = secp.ProjectivePoint.BASE.multiply(kn);
    const e = modN(bToBig(k(KERNEL_DOMAIN, cL, cO, R.toRawBytes(true))));
    const z = modN(kn + e * x);
    const lockerSig = hx(signSchnorr(adaptorRefundMsg(chainBinding, lockLeaf, O.cx, O.cy, feeB, refundOwner), b32(lockerPriv)));
    return {
      chainBinding, spendRoot: ZERO, lockSetRoot, asset, lCx, lCy, tx: T.tx, ty: T.ty, deadline: Number(deadline), recipient, locker,
      lIndex, lPath, oCx: O.cx, oCy: O.cy, amount: Number(amountB), lSigR: lSig.R, lSigZ: lSig.z, fee: Number(feeB),
      kernelR: hx(R.toRawBytes(true)), kernelZ: hx(be(z, 32)), lockerSig, refundOwner,
      lockLeaf, lockNullifier: pool.nullifier(lockLeaf),
    };
  };

  return { adaptorLockLeaf, adaptorClaimMsg, adaptorRefundMsg, buildAdaptorLock, buildAdaptorClaim, buildAdaptorRefund };
}
