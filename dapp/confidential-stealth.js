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
  const REFUND_DOMAIN = enc.encode('tacit-stealth-refund-auth-v1');
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
  // Blind refund-auth msg (mirror cxfer-core `stealth_refund_msg`): the LOCKER signs this under their refund
  // pubkey so a claimant who holds r_L can't hijack the refund. Returns the 32-byte message (Uint8Array).
  const stealthRefundMsg = (chainBinding, lockLeaf, oCx, oCy, fee) =>
    k(REFUND_DOMAIN, b32(chainBinding), b32(lockLeaf), b32(oCx), b32(oCy), be(fee, 8));

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

  // SEND (prover-blind): lock note N's FULL value under the recipient's one-time pubkey, value hidden. The
  // N→L kernel (value-equal, fee 0) binds the BLIND lock leaf — it both proves spend authority on N and
  // conserves the value WITHOUT a cleartext amount, so a gasless relay never learns it. The locker conveys
  // `lBlinding` (r_L) to the recipient in the memo so they can later claim by kernel.
  const buildStealthLock = ({ chainBinding, asset, locker, ownerPub, amount, deadline, spendRoot, nNote, lBlinding }) => {
    const { cx: lCx, cy: lCy } = pool.commitXY(amount, lBlinding);
    const lockLeaf = stealthLockLeafBlind(asset, lCx, lCy, ownerPub, deadline, locker);
    const kt = transfer.kernelSign({ inputs: [{ value: BigInt(amount), blinding: BigInt(nNote.blinding) }],
      outputs: [{ value: BigInt(amount), blinding: BigInt(lBlinding) }], fee: 0n, outLeaves: [lockLeaf] });
    return { chainBinding, spendRoot, asset, locker, ownerPub, deadline: Number(deadline),
      nCx: nNote.cx, nCy: nNote.cy, nIndex: nNote.leafIndex, nPath: nNote.path,
      lCx, lCy, kernelR: hx(kt.R.toRawBytes(true)), kernelZ: hx(be(kt.z, 32)) };
  };

  // RECEIVE (prover-blind): claim a blind lock to a fresh note M, net of an optional relay `fee`. The L→M+fee
  // kernel + a BP+ range on M conserve value (and bound the fee) without a cleartext amount; the BIP-340 sig
  // under ownerPub authorizes only the recipient. Needs `lBlinding` (r_L, from the memo). `blind: 1`.
  const buildStealthClaim = ({ chainBinding, asset, lCx, lCy, ownerPub, amount, deadline, locker, lBlinding, lockSetRoot, lIndex, lPath, oneTimePriv, mOwner, fee = 0n, mBlinding }) => {
    const net = BigInt(amount) - BigInt(fee);
    const kt = transfer.buildTransfer({ inputs: [{ value: BigInt(amount), blinding: BigInt(lBlinding) }],
      outputs: [{ value: net, blinding: BigInt(mBlinding), owner: mOwner }], fee: BigInt(fee), assetId: asset });
    const { cx: mCx, cy: mCy } = pool.commitXY(net, mBlinding);
    const lockLeaf = stealthLockLeafBlind(asset, lCx, lCy, ownerPub, deadline, locker);
    const claimMsg = stealthClaimMsgBlind(chainBinding, lockLeaf, mCx, mCy, mOwner, fee);
    const ownerSig = signClaim({ oneTimePriv, claimMsg });
    return { blind: 1, chainBinding, lockSetRoot, asset, lCx, lCy, ownerPub, deadline: Number(deadline),
      locker, lIndex, lPath, mCx, mCy, mOwner, fee: Number(fee),
      kernelR: hx(kt.kernel.R.toRawBytes(true)), kernelZ: hx(be(kt.kernel.z, 32)), mRange: kt.rangeProof, ownerSig };
  };

  // REFUND (prover-blind): the locker reclaims an unclaimed blind lock after the deadline. L→O+fee kernel +
  // a BP+ range on O (bounds the fee without a cleartext amount); only the locker knows r_L. Needs `amount`
  // to rebuild the kernel (the locker knows it) but never emits it.
  const buildStealthRefund = ({ chainBinding, asset, lCx, lCy, ownerPub, amount, deadline, locker, lockerPriv, lockSetRoot, lIndex, lPath, lBlinding, fee = 0n, oBlinding }) => {
    const net = BigInt(amount) - BigInt(fee);
    const kt = transfer.buildTransfer({ inputs: [{ value: BigInt(amount), blinding: BigInt(lBlinding) }],
      outputs: [{ value: net, blinding: BigInt(oBlinding), owner: locker }], fee: BigInt(fee), assetId: asset });
    const { cx: oCx, cy: oCy } = pool.commitXY(net, oBlinding);
    // Locker authorization: sign the exact O + fee under the locker refund key, so a claimant holding r_L
    // can't hijack the refund (fee-theft / unspendable-output grief). The guest verifies bip340 under `locker`.
    const lockLeaf = stealthLockLeafBlind(asset, lCx, lCy, ownerPub, deadline, locker);
    const lockerSig = hx(signSchnorr(stealthRefundMsg(chainBinding, lockLeaf, oCx, oCy, fee), b32(lockerPriv)));
    return { chainBinding, lockSetRoot, asset, lCx, lCy, ownerPub, deadline: Number(deadline),
      locker, lIndex, lPath, oCx, oCy, fee: Number(fee),
      kernelR: hx(kt.kernel.R.toRawBytes(true)), kernelZ: hx(be(kt.kernel.z, 32)), oRange: kt.rangeProof, lockerSig };
  };

  // BRIDGE PAY-TO-STEALTH (BTC→ETH, prover-blind): mint a Bitcoin-burned note's value into the shared lock-set
  // under the recipient's one-time pubkey. Mirrors the guest OP_BRIDGE_STEALTH_MINT: the burned note (member of
  // the Bitcoin poolRoot) is conserved into L by an UNBOUND kernel v_in == v_L + fee (the burn-set membership
  // pins the BLIND dest leaf, so no opening sigma / no cleartext amount). `amount` = the burned value v_in; the
  // burner declares L = commit(amount − fee) as its destCommitment, so the recipient claims `amount − fee`.
  const buildBridgeStealthMint = ({ chainBinding, asset, poolRoot, burned, ownerPub, amount, deadline, locker, lBlinding, bmNext, bmIndex, bmPath, fee = 0n }) => {
    const net = BigInt(amount) - BigInt(fee);
    const { cx: lCx, cy: lCy } = pool.commitXY(net, lBlinding);
    const kt = transfer.kernelSign({ inputs: [{ value: BigInt(amount), blinding: BigInt(burned.blinding) }],
      outputs: [{ value: net, blinding: BigInt(lBlinding) }], fee: BigInt(fee), outLeaves: [] });
    // Range-bound L (v_L < 2^64) so the relay fee = v_in − v_L can't exceed the burned value (the bound the
    // dropped opening sigma used to give). The guest reads + verifies this.
    const { proof: lRange } = transfer.rangeProve([net], [BigInt(lBlinding)]);
    return { chainBinding, poolRoot, asset, ownerPub, deadline: Number(deadline), locker,
      inCx: burned.cx, inCy: burned.cy, inOwner: burned.owner, inIndex: burned.leafIndex, inPath: burned.path,
      lCx, lCy, bmNext, bmIndex, bmPath, fee: Number(fee),
      kernelR: hx(kt.R.toRawBytes(true)), kernelZ: hx(be(kt.z, 32)), lRange };
  };

  return {
    stealthLockLeaf, stealthLockLeafBlind, stealthClaimMsg, stealthClaimMsgBlind, stealthRefundMsg, oneTimeAddress, recoverOneTimeKey, scanLock, signClaim,
    buildStealthLock, buildStealthClaim, buildStealthRefund, buildBridgeStealthMint,
  };
}
