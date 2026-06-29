// JS mirror of the cxfer-core stealth-receive primitives (ops/DESIGN-confidential-stealth-receive.md):
// non-interactive send-to-address over the shared lock-set. Byte-identical to cxfer-core `stealth_lock_leaf` /
// `stealth_claim_msg`, and the one-time-key derivation is dapp-only (the guest never sees the ECDH — it only
// verifies a BIP-340 sig under the one-time pubkey, so `signSchnorr` here produces a signature the guest's
// `bip340_verify` accepts). Inject `keccak256` (Uint8Array→32B), `secp` (@noble/secp256k1), `signSchnorr`
// (dapp/bulletproofs.js), and `curveOrder` (SECP_N).
//
// Byte layouts (big-endian raw concat, matching cxfer-core `kn`; u64 = 8 bytes):
//   stealth lock leaf = keccak("tacit-stealth-lock-v1" ‖ asset ‖ Cx ‖ Cy ‖ ownerPub ‖ amount_be8 ‖ deadline_be8 ‖ locker)
//   stealth claim msg = keccak("tacit-stealth-claim-v1" ‖ chainBinding ‖ lockLeaf ‖ Mx ‖ My ‖ Mowner ‖ amount_be8 ‖ fee_be8)
//   one-time addr     = ownerPub = x-only(B + s·G), s = keccak("tacit-stealth-ecdh-v1" ‖ compress(e·B)) mod n,
//                       E = e·G published in the memo; the recipient recovers s = keccak(… ‖ compress(b·E)) and
//                       the one-time key b + s (the sender knows ownerPub + s but not b, so cannot spend).

export function makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder, pool, transfer }) {
  const Pt = secp.ProjectivePoint;
  const G = Pt.BASE;
  const N = BigInt(curveOrder);
  const enc = new TextEncoder();
  const LOCK_DOMAIN = enc.encode('tacit-stealth-lock-v1');
  const LOCK_BLIND_DOMAIN = enc.encode('tacit-stealth-lock-blind-v1');
  const CLAIM_DOMAIN = enc.encode('tacit-stealth-claim-v1');
  const ECDH_DOMAIN = enc.encode('tacit-stealth-ecdh-v1');

  const hx = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const concat = (arrs) => {
    const n = arrs.reduce((s, a) => s + a.length, 0);
    const o = new Uint8Array(n);
    let p = 0;
    for (const a of arrs) { o.set(a, p); p += a.length; }
    return o;
  };
  const bN = (h, n) => {
    const s = String(h).replace(/^0x/, '').padStart(n * 2, '0');
    if (s.length !== n * 2) throw new Error(`expected ${n}-byte value, got ${s.length / 2}`);
    const o = new Uint8Array(n);
    for (let i = 0; i < n; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return o;
  };
  const b32 = (h) => bN(h, 32);
  const be = (v, n) => {
    let x = BigInt(v);
    const o = new Uint8Array(n);
    for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; }
    return o;
  };
  const bToBig = (b) => { let x = 0n; for (const y of b) x = (x << 8n) | BigInt(y); return x; };
  const modN = (x) => ((x % N) + N) % N;
  const k = (...parts) => keccak256(concat(parts));
  const compress = (P) => P.toRawBytes(true); // 33-byte compressed
  const xOnly = (P) => P.toRawBytes(true).slice(1); // 32-byte x-only (even-y convention, matches verifySchnorr)
  const ptFrom = (hexCompressedOrXonly) => {
    const s = String(hexCompressedOrXonly).replace(/^0x/, '');
    return s.length === 64 ? Pt.fromHex('02' + s) : Pt.fromHex(s); // x-only → even-y lift; else a 33-byte point
  };

  // ── byte-parity primitives (mirror cxfer-core) ──
  const stealthLockLeaf = (asset, cx, cy, ownerPub, amount, deadline, locker) =>
    hx(k(LOCK_DOMAIN, b32(asset), b32(cx), b32(cy), b32(ownerPub), be(amount, 8), be(deadline, 8), b32(locker)));
  // Prover-blind lock leaf (mirror cxfer-core `stealth_lock_leaf_blind`): NO amount in the preimage — the
  // value is carried by the commitment (cx,cy). Domain-separated so it can never cross-claim an amount-bearing leaf.
  const stealthLockLeafBlind = (asset, cx, cy, ownerPub, deadline, locker) =>
    hx(k(LOCK_BLIND_DOMAIN, b32(asset), b32(cx), b32(cy), b32(ownerPub), be(deadline, 8), b32(locker)));
  // Returns the 32-byte message (Uint8Array) the recipient signs under their one-time key.
  const stealthClaimMsg = (chainBinding, lockLeaf, mCx, mCy, mOwner, amount, fee) =>
    k(CLAIM_DOMAIN, b32(chainBinding), b32(lockLeaf), b32(mCx), b32(mCy), b32(mOwner), be(amount, 8), be(fee, 8));
  // Blind claim msg (mirror cxfer-core `stealth_claim_msg_blind`): binds M + fee, NO amount (it's hidden).
  const stealthClaimMsgBlind = (chainBinding, lockLeaf, mCx, mCy, mOwner, fee) =>
    k(CLAIM_DOMAIN, b32(chainBinding), b32(lockLeaf), b32(mCx), b32(mCy), b32(mOwner), enc.encode('blind'), be(fee, 8));

  // ── one-time stealth address (the ECDH is entirely dapp-side; the guest never sees it) ──
  const _shared = (sharedPt) => modN(bToBig(keccak256(concat([ECDH_DOMAIN, compress(sharedPt)]))));

  // SENDER: derive the one-time pubkey to lock under, + the ephemeral pubkey to publish in the memo.
  const oneTimeAddress = ({ recipientSpendPub, ephemeralPriv }) => {
    const B = ptFrom(recipientSpendPub);
    const e = modN(BigInt(ephemeralPriv));
    const s = _shared(B.multiply(e));
    const O = B.add(G.multiply(s));
    return { ephemeralPub: hx(compress(G.multiply(e))), ownerPub: hx(xOnly(O)) };
  };

  // RECIPIENT: recover the one-time spending key (b + s) + its pubkey, from a lock's published ephemeral E.
  const recoverOneTimeKey = ({ recipientSpendPriv, ephemeralPub }) => {
    const b = modN(BigInt(recipientSpendPriv));
    const E = ptFrom(ephemeralPub);
    const s = _shared(E.multiply(b));
    const oneTimePriv = modN(b + s);
    return { oneTimePriv: hx(be(oneTimePriv, 32)), ownerPub: hx(xOnly(G.multiply(oneTimePriv))) };
  };

  // RECIPIENT scan: is this lock (its published `ephemeralPub` + leaf `ownerPub`) addressed to me?
  const scanLock = ({ recipientSpendPriv, ephemeralPub, ownerPub }) =>
    recoverOneTimeKey({ recipientSpendPriv, ephemeralPub }).ownerPub.toLowerCase() === String(ownerPub).toLowerCase();

  // RECIPIENT: the BIP-340 claim signature the guest's bip340_verify accepts (sign with the one-time key).
  const signClaim = ({ oneTimePriv, claimMsg }) => hx(signSchnorr(claimMsg, b32(oneTimePriv)));

  // ── op-assemblers (witness JSON for the box harnesses; require `pool`, refund also `transfer`) ──
  // The opening sigmas / kernel are built exactly as the guest re-checks them; the box harness feeds these to
  // the guest, the contract independently verifies the proof. The merkle witnesses (spendRoot/nPath,
  // lockSetRoot/lPath, leaf indices) are supplied by the caller from the live note + lock-set trees.

  // SEND: lock note N's value under the recipient's one-time pubkey. N and L both open to `amount` (no change).
  const buildStealthLock = ({ chainBinding, asset, locker, ownerPub, amount, deadline, spendRoot, nNote, lBlinding }) => {
    const { cx: lCx, cy: lCy } = pool.commitXY(amount, lBlinding);
    const ctx = pool.intentContext('tacit-stealth-lock-intent-v1', chainBinding, asset, asset,
      [[nNote.cx, nNote.cy, locker], [lCx, lCy, ownerPub]], [BigInt(amount), BigInt(deadline)]);
    const nSig = pool.openingSigma(BigInt(amount), nNote.blinding, ctx, pool.deriveOpeningNonce(nNote.blinding, ctx, 'stealth-lock-n'));
    const lSig = pool.openingSigma(BigInt(amount), lBlinding, ctx, pool.deriveOpeningNonce(lBlinding, ctx, 'stealth-lock-l'));
    return { chainBinding, spendRoot, asset, locker, ownerPub, amount: Number(amount), deadline: Number(deadline),
      nCx: nNote.cx, nCy: nNote.cy, nIndex: nNote.leafIndex, nPath: nNote.path, nSigR: nSig.R, nSigZ: nSig.z,
      lCx, lCy, lSigR: lSig.R, lSigZ: lSig.z };
  };

  // RECEIVE: claim a lock to a fresh note M the recipient owns, net of an optional gasless relay `fee`.
  const buildStealthClaim = ({ chainBinding, asset, lCx, lCy, ownerPub, amount, deadline, locker, lockSetRoot, lIndex, lPath, oneTimePriv, mOwner, fee = 0n, mBlinding }) => {
    const net = BigInt(amount) - BigInt(fee);
    const { cx: mCx, cy: mCy } = pool.commitXY(net, mBlinding);
    const mCtx = pool.intentContext('tacit-stealth-claim-out-v1', chainBinding, asset, asset,
      [[mCx, mCy, mOwner]], [BigInt(amount), BigInt(fee)]);
    const mSig = pool.openingSigma(net, mBlinding, mCtx, pool.deriveOpeningNonce(mBlinding, mCtx, 'stealth-claim-m'));
    const lockLeaf = stealthLockLeaf(asset, lCx, lCy, ownerPub, amount, deadline, locker);
    const claimMsg = stealthClaimMsg(chainBinding, lockLeaf, mCx, mCy, mOwner, amount, fee);
    const ownerSig = signClaim({ oneTimePriv, claimMsg });
    return { chainBinding, lockSetRoot, asset, lCx, lCy, ownerPub, amount: Number(amount), deadline: Number(deadline),
      locker, lIndex, lPath, mCx, mCy, mOwner, fee: Number(fee), mSigR: mSig.R, mSigZ: mSig.z, ownerSig };
  };

  // REFUND: the locker reclaims an unclaimed lock after the deadline (kernel-gated; only the locker knows r_L).
  const buildStealthRefund = ({ chainBinding, asset, lCx, lCy, ownerPub, amount, deadline, locker, lockSetRoot, lIndex, lPath, lBlinding, fee = 0n, oBlinding }) => {
    const net = BigInt(amount) - BigInt(fee);
    const { cx: oCx, cy: oCy } = pool.commitXY(net, oBlinding);
    const kt = transfer.buildTransfer({ inputs: [{ value: BigInt(amount), blinding: BigInt(lBlinding) }], outputs: [{ value: net, blinding: BigInt(oBlinding) }], fee: BigInt(fee) });
    return { chainBinding, lockSetRoot, asset, lCx, lCy, ownerPub, amount: Number(amount), deadline: Number(deadline),
      locker, lIndex, lPath, oCx, oCy, fee: Number(fee), kernelR: hx(kt.kernel.R.toRawBytes(true)), kernelZ: hx(be(kt.kernel.z, 32)) };
  };

  // BRIDGE PAY-TO-STEALTH (BTC→ETH): mint a Bitcoin-burned note's value into the shared lock-set under the
  // recipient's one-time pubkey, so the sender can't spend it — the recipient claims with buildStealthClaim,
  // the locker refunds with buildStealthRefund. Mirrors the guest OP_BRIDGE_STEALTH_MINT (main.rs): the burned
  // note (membership in the Bitcoin poolRoot) is conserved into L by a kernel (v_in == v_L), and an opening
  // sigma binds L to the cleartext `amount` (v_L == amount) ⇒ amount == v_in (no over-mint). `burned` is the
  // Bitcoin note being bridged { cx, cy, owner, blinding (r_in), leafIndex, path }; `bm*` is its membership in
  // the reflected bridge-burn set (ν → dest_leaf). N and L both open to `amount` (no change at the lock).
  const buildBridgeStealthMint = ({ chainBinding, asset, poolRoot, burned, ownerPub, amount, deadline, locker, lBlinding, bmNext, bmIndex, bmPath }) => {
    const { cx: lCx, cy: lCy } = pool.commitXY(amount, lBlinding);
    // L opening sigma — binds L = commit(amount, r_L) to the cleartext amount baked into the lock leaf.
    const ctx = pool.intentContext('tacit-bridge-stealth-mint-v1', chainBinding, asset, asset,
      [[lCx, lCy, ownerPub]], [BigInt(amount), BigInt(deadline)]);
    const lSig = pool.openingSigma(BigInt(amount), lBlinding, ctx, pool.deriveOpeningNonce(lBlinding, ctx, 'bridge-stealth-mint-l'));
    // Conservation kernel — v_in (burned note) == v_L. Built exactly as the guest's verify_kernel re-checks it
    // (input = the burned Bitcoin note, output = the lock note L), so only the burner (who knows r_in) can mint.
    const kt = transfer.buildTransfer({ inputs: [{ value: BigInt(amount), blinding: BigInt(burned.blinding) }], outputs: [{ value: BigInt(amount), blinding: BigInt(lBlinding) }] });
    return { chainBinding, poolRoot, asset, ownerPub, amount: Number(amount), deadline: Number(deadline), locker,
      inCx: burned.cx, inCy: burned.cy, inOwner: burned.owner, inIndex: burned.leafIndex, inPath: burned.path,
      lCx, lCy, lSigR: lSig.R, lSigZ: lSig.z, bmNext, bmIndex, bmPath,
      kernelR: hx(kt.kernel.R.toRawBytes(true)), kernelZ: hx(be(kt.kernel.z, 32)) };
  };

  return {
    stealthLockLeaf, stealthLockLeafBlind, stealthClaimMsg, stealthClaimMsgBlind, oneTimeAddress, recoverOneTimeKey, scanLock, signClaim,
    buildStealthLock, buildStealthClaim, buildStealthRefund, buildBridgeStealthMint,
  };
}
