// Confidential LP (OP_LP_ADD / OP_LP_REMOVE) witness assembler for the EVM confidential AMM.
//
// An LP position is a shielded note of a pool-specific LP asset (lpShareId = keccak(poolId ‖ "lp")).
// Add: spend an A note + a B note, add them to the public reserves, mint an LP-share note for the
// shares (first mint = isqrt(dA·dB)−MIN_LIQ; later = the min rule, off-ratio safe). Remove: spend
// the LP-share note, withdraw the proportional underlying
// as fresh A/B notes (floored toward the pool). Each note's amount is bound by an OPENING SIGMA — a
// Schnorr proof of knowledge of the note's blinding for the stated amount, NOT the raw blinding — so
// the settle prover (the box) verifies the openings without learning any `r`: it cannot spend the
// spent notes elsewhere nor redirect the minted ones. The sigma challenge binds the whole intent
// (all three notes + owners + the deltas). The guest re-verifies exactly these objects.
//
// keccak injected for Node+browser parity; `pool` is a makeConfidentialPool instance whose
// commitXY/leaf/nullifier + openingSigma/intentContext primitives the guest agrees on.

const ZERO32 = '0x' + '00'.repeat(32);

export function makeConfidentialLp({ keccak256, pool }) {
  const { leaf, nullifier, commitXY, openingSigma, verifyOpeningSigma, deriveOpeningNonce, intentContext } = pool;
  const enc = new TextEncoder();
  const hexToBytes = (h) => { h = (h || '').replace(/^0x/, ''); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
  const bytesToHex = (b) => '0x' + Buffer.from(b).toString('hex');
  const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };

  const be32 = (n) => { const o = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
  const bigOf = (h) => BigInt('0x' + h.replace(/^0x/, ''));
  // poolId binds the CANONICAL pair + fee tier (one pool per (pair, fee)); lpShareId therefore varies by
  // fee tier too. Callers present assetA/assetB in canonical order (assetA < assetB).
  const poolId = (a, b, feeBps) => {
    const [lo, hi] = bigOf(a) <= bigOf(b) ? [a, b] : [b, a];
    return bytesToHex(keccak256(concat([hexToBytes(lo), hexToBytes(hi), be32(feeBps)])));
  };
  // Optional Uniswap fee-switch pool id — mirrors cxfer-core `pool_id_with_protocol_fee` + the contract's
  // 6-arg id byte-for-byte: pfBps == 0 ≡ the canonical 3-arg `poolId`; else keccak(lo ‖ hi ‖ feeBps_be32 ‖
  // recipient33 ‖ pfBps_be32). Lets the confidential LP fund the SAME slot OP_SWAP skims against.
  const ZERO_RCPT = '0x' + '00'.repeat(33);
  const poolIdWithProtocolFee = (a, b, feeBps, recipient33 = ZERO_RCPT, pfBps = 0) => {
    if (BigInt(pfBps) === 0n) return poolId(a, b, feeBps);
    const [lo, hi] = bigOf(a) <= bigOf(b) ? [a, b] : [b, a];
    return bytesToHex(keccak256(concat([hexToBytes(lo), hexToBytes(hi), be32(feeBps), hexToBytes(recipient33), be32(pfBps)])));
  };
  const lpShareId = (pid) => bytesToHex(keccak256(concat([hexToBytes(pid), enc.encode('lp')])));
  const floorDiv = (num, den) => { num = BigInt(num); den = BigInt(den); const q = num / den; return { q, rem: num - q * den }; };
  // Constant-product first-mint basis: total = isqrt(dA·dB), MINIMUM_LIQUIDITY locked (noteless floor).
  const MINIMUM_LIQUIDITY = 1000n;
  const isqrt = (n) => { n = BigInt(n); if (n < 2n) return n; let x = n, y = (x + 1n) >> 1n; while (y < x) { x = y; y = (x + n / x) >> 1n; } return x; };
  // min rule for a SUBSEQUENT add: min(floor(S·dA/R_A), floor(S·dB/R_B)). The limiting leg sets the
  // shares (off-ratio earns the smaller leg, excess accrues to the pool — never over-claim); no exact-ratio
  // gate. Mirrors cxfer-core lp_add_shares + tests/amm-clearing.mjs lpAddShares.
  const lpAddShares = (S, dA, dB, rA, rB) => {
    const a = (BigInt(S) * BigInt(dA)) / BigInt(rA);
    const b = (BigInt(S) * BigInt(dB)) / BigInt(rB);
    return a < b ? a : b;
  };

  // The (lpAsset, pid, shareOwner) tuple binds the POOL IDENTITY (mirror main.rs OP_LP_ADD): without it a
  // first-add (dShares independent of any pool) could be redirected by the box into a different same-pair fee
  // tier / protocol-fee config. pid binds feeBps + protocolFeeRecipient + protocolFeeBps; lpAsset is the share asset.
  const addCtx = (op) => {
    const pid = poolIdWithProtocolFee(op.assetA, op.assetB, op.feeBps, op.protocolFeeRecipient ?? ZERO_RCPT, op.protocolFeeBps ?? 0);
    const lpAsset = lpShareId(pid);
    return intentContext('tacit-lp-add-v1', op.chainBinding, op.assetA, op.assetB,
      [[op.a.cx, op.a.cy, op.a.owner], [op.b.cx, op.b.cy, op.b.owner], [op.share.cx, op.share.cy, op.share.owner], [lpAsset, pid, op.share.owner]],
      [op.dA, op.dB, op.dShares, op.deadline ?? 0n, op.fee ?? 0n]);
  };
  const removeCtx = (op) => intentContext('tacit-lp-remove-v1', op.chainBinding, op.assetA, op.assetB,
    [[op.share.cx, op.share.cy, op.share.owner], [op.a.cx, op.a.cy, op.a.owner], [op.b.cx, op.b.cy, op.b.owner]],
    [op.dShares, op.dA, op.dB, op.deadline ?? 0n, op.fee ?? 0n]);

  // ── OP_LP_ADD ──  first mint: shares = isqrt(dA·dB) − MIN_LIQ; subsequent: min rule (off-ratio safe).
  // The blindings rA/rB/rShares stay CLIENT-SIDE; only the opening sigmas reach the witness. Each sigma
  // nonce is DERIVED per (note blinding, intent context) so a re-add of the same note never reuses one.
  function buildAdd({ assetA, assetB, chainBinding, feeBps, protocolFeeBps = 0, protocolFeeRecipient = ZERO_RCPT, reserveAPre, reserveBPre, sharesPre, aNote, bNote, dA, dB, rA, rB, shareOwner, rShares, deadline, fee = 0n }) {
    // The relay fee is carved from the A contribution (asset A): the pool/share math sees dA − fee, while
    // the A note still opens to its full value dA; `fee` is paid to the settler. fee = 0 ⇒ self-settle.
    const feeBig = BigInt(fee);
    if (!(feeBig < BigInt(dA))) throw new Error('lp_add: fee >= A contribution');
    const addA = BigInt(dA) - feeBig;
    // First mint (empty pool): ZAMM total = isqrt(addA·dB), founder note = total − MINIMUM_LIQUIDITY (locked,
    // noteless). Subsequent: the min rule min(floor(S·addA/R_A), floor(S·dB/R_B)) — off-ratio safe.
    let dShares;
    if (BigInt(sharesPre) === 0n) {
      const total = isqrt(addA * BigInt(dB));
      if (total <= MINIMUM_LIQUIDITY) throw new Error('lp_add: initial liquidity below MINIMUM_LIQUIDITY');
      dShares = total - MINIMUM_LIQUIDITY;
    } else {
      dShares = lpAddShares(sharesPre, addA, dB, reserveAPre, reserveBPre);
      if (dShares <= 0n) throw new Error('lp_add: contribution below one share');
    }
    const aC = commitXY(dA, rA), bC = commitXY(dB, rB), sC = commitXY(dShares, rShares);
    const op = {
      assetA, assetB, chainBinding, feeBps: Number(feeBps),
      protocolFeeBps: Number(protocolFeeBps), protocolFeeRecipient,
      deadline: BigInt(deadline ?? 0), fee: feeBig,
      reserveAPre: BigInt(reserveAPre), reserveBPre: BigInt(reserveBPre), sharesPre: BigInt(sharesPre),
      a: { cx: aC.cx, cy: aC.cy, owner: aNote.owner, leafIndex: aNote.leafIndex, path: aNote.path }, dA: BigInt(dA),
      b: { cx: bC.cx, cy: bC.cy, owner: bNote.owner, leafIndex: bNote.leafIndex, path: bNote.path }, dB: BigInt(dB),
      dShares, share: { cx: sC.cx, cy: sC.cy, owner: shareOwner },
    };
    const ctx = addCtx(op);
    op.aSig = openingSigma(op.dA, rA, ctx, deriveOpeningNonce(rA, ctx, 'lp-add-a'));
    op.bSig = openingSigma(op.dB, rB, ctx, deriveOpeningNonce(rB, ctx, 'lp-add-b'));
    op.sSig = openingSigma(op.dShares, rShares, ctx, deriveOpeningNonce(rShares, ctx, 'lp-add-share'));
    return op;
  }

  function verifyAdd(op, { merkleRootFrom, spendRoot }) {
    const fail = (m) => { throw new Error('lp_add: ' + m); };
    if (spendRoot === ZERO32 || !spendRoot) fail('membership requires a non-zero spend root');
    const pid = poolIdWithProtocolFee(op.assetA, op.assetB, op.feeBps, op.protocolFeeRecipient ?? ZERO_RCPT, op.protocolFeeBps ?? 0), lpAsset = lpShareId(pid);
    if (merkleRootFrom(leaf(op.assetA, op.a.cx, op.a.cy, op.a.owner), op.a.leafIndex, op.a.path) !== spendRoot) fail('A membership');
    if (merkleRootFrom(leaf(op.assetB, op.b.cx, op.b.cy, op.b.owner), op.b.leafIndex, op.b.path) !== spendRoot) fail('B membership');
    const ctx = addCtx(op);
    if (!verifyOpeningSigma(op.a.cx, op.a.cy, op.dA, op.aSig.R, op.aSig.z, ctx)) fail('A opening');
    if (!verifyOpeningSigma(op.b.cx, op.b.cy, op.dB, op.bSig.R, op.bSig.z, ctx)) fail('B opening');
    const fee = BigInt(op.fee ?? 0n);
    if (!(fee < op.dA)) fail('fee >= A contribution');
    const addA = op.dA - fee; // the relay fee is carved from A; the pool/share math sees dA − fee
    let reserveAPost, reserveBPost, sharesPost;
    if (op.sharesPre === 0n) {
      // ZAMM first mint: total = isqrt(addA·dB), founder note = total − MIN_LIQUIDITY (locked, noteless). The
      // founder sets the price (no in-ratio); reserves are SET, not added.
      if (!(addA > 0n && op.dB > 0n)) fail('first mint needs both sides');
      const total = isqrt(addA * op.dB);
      if (total <= MINIMUM_LIQUIDITY) fail('initial liquidity below MINIMUM_LIQUIDITY');
      if (op.dShares !== total - MINIMUM_LIQUIDITY) fail('first-mint shares = isqrt(addA·dB) - MIN_LIQUIDITY');
      reserveAPost = addA; reserveBPost = op.dB; sharesPost = total;
    } else {
      if (!(op.reserveAPre > 0n && op.reserveBPre > 0n)) fail('pool must be initialized');
      // min rule (no exact-ratio gate): off-ratio add earns the limiting leg, the excess accrues to
      // the pool. The share note must open to exactly the derived min, so the LP can never over-claim.
      const dShares = lpAddShares(op.sharesPre, addA, op.dB, op.reserveAPre, op.reserveBPre);
      if (!(dShares > 0n)) fail('zero shares minted (dust add would donate)'); // ZAMM require(liquidity != 0)
      if (op.dShares !== dShares) fail('proportional shares');
      reserveAPost = op.reserveAPre + addA; reserveBPost = op.reserveBPre + op.dB; sharesPost = op.sharesPre + op.dShares;
    }
    if (!verifyOpeningSigma(op.share.cx, op.share.cy, op.dShares, op.sSig.R, op.sSig.z, ctx)) fail('share opening');
    return {
      settlement: {
        poolId: pid, reserveAPre: op.reserveAPre, reserveBPre: op.reserveBPre, sharesPre: op.sharesPre,
        reserveAPost, reserveBPost, sharesPost,
      },
      fees: fee > 0n ? [{ assetId: op.assetA, value: fee }] : [],
      nullifiers: [nullifier(op.a.cx, op.a.cy), nullifier(op.b.cx, op.b.cy)],
      leaves: [leaf(lpAsset, op.share.cx, op.share.cy, op.share.owner)],
    };
  }

  // ── OP_LP_REMOVE ──  dA = floor(R_A·dShares/sharesPre), dB = floor(R_B·dShares/sharesPre).
  function buildRemove({ assetA, assetB, chainBinding, feeBps, protocolFeeBps = 0, protocolFeeRecipient = ZERO_RCPT, reserveAPre, reserveBPre, sharesPre, shareNote, dShares, rShares, aOwner, rA, bOwner, rB, deadline, fee = 0n }) {
    const a = floorDiv(BigInt(reserveAPre) * BigInt(dShares), sharesPre);
    const b = floorDiv(BigInt(reserveBPre) * BigInt(dShares), sharesPre);
    // The relay fee is carved from the A withdrawal: the A note opens to (dA − fee) while the pool still
    // releases the full proportional dA; `fee` is paid to the settler. fee = 0 ⇒ self-settle.
    const feeBig = BigInt(fee);
    if (!(feeBig < a.q)) throw new Error('lp_remove: fee >= A withdrawal');
    const netA = a.q - feeBig;
    const sC = commitXY(dShares, rShares), aC = commitXY(netA, rA), bC = commitXY(b.q, rB);
    const op = {
      assetA, assetB, chainBinding, feeBps: Number(feeBps),
      protocolFeeBps: Number(protocolFeeBps), protocolFeeRecipient,
      deadline: BigInt(deadline ?? 0), fee: feeBig,
      reserveAPre: BigInt(reserveAPre), reserveBPre: BigInt(reserveBPre), sharesPre: BigInt(sharesPre),
      share: { cx: sC.cx, cy: sC.cy, owner: shareNote.owner, leafIndex: shareNote.leafIndex, path: shareNote.path }, dShares: BigInt(dShares),
      dA: a.q, remA: a.rem, dB: b.q, remB: b.rem,
      a: { cx: aC.cx, cy: aC.cy, owner: aOwner },
      b: { cx: bC.cx, cy: bC.cy, owner: bOwner },
    };
    const ctx = removeCtx(op);
    op.sSig = openingSigma(op.dShares, rShares, ctx, deriveOpeningNonce(rShares, ctx, 'lp-rm-share'));
    op.aSig = openingSigma(netA, rA, ctx, deriveOpeningNonce(rA, ctx, 'lp-rm-a'));
    op.bSig = openingSigma(op.dB, rB, ctx, deriveOpeningNonce(rB, ctx, 'lp-rm-b'));
    return op;
  }

  function verifyRemove(op, { merkleRootFrom, spendRoot }) {
    const fail = (m) => { throw new Error('lp_remove: ' + m); };
    if (spendRoot === ZERO32 || !spendRoot) fail('membership requires a non-zero spend root');
    const pid = poolIdWithProtocolFee(op.assetA, op.assetB, op.feeBps, op.protocolFeeRecipient ?? ZERO_RCPT, op.protocolFeeBps ?? 0), lpAsset = lpShareId(pid);
    if (merkleRootFrom(leaf(lpAsset, op.share.cx, op.share.cy, op.share.owner), op.share.leafIndex, op.share.path) !== spendRoot) fail('share membership');
    const ctx = removeCtx(op);
    if (!verifyOpeningSigma(op.share.cx, op.share.cy, op.dShares, op.sSig.R, op.sSig.z, ctx)) fail('share opening');
    if (!(op.sharesPre > 0n && op.dShares > 0n && op.dShares <= op.sharesPre)) fail('shares in range');
    // The locked MINIMUM_LIQUIDITY can never be removed — totalShares stays ≥ it (guest + contract
    // enforce the same gate). A remove that would breach it is rejected.
    if (op.sharesPre - op.dShares < MINIMUM_LIQUIDITY) fail('would breach MINIMUM_LIQUIDITY floor');
    const a = floorDiv(op.reserveAPre * op.dShares, op.sharesPre);
    const b = floorDiv(op.reserveBPre * op.dShares, op.sharesPre);
    if (a.q !== op.dA || a.rem !== op.remA) fail('dA proportional');
    if (b.q !== op.dB || b.rem !== op.remB) fail('dB proportional');
    const fee = BigInt(op.fee ?? 0n);
    if (!(fee < op.dA)) fail('fee >= A withdrawal');
    const netA = op.dA - fee; // the A note opens to dA − fee; the pool still releases the full dA
    if (!verifyOpeningSigma(op.a.cx, op.a.cy, netA, op.aSig.R, op.aSig.z, ctx)) fail('A opening (net of relay fee)');
    if (!verifyOpeningSigma(op.b.cx, op.b.cy, op.dB, op.bSig.R, op.bSig.z, ctx)) fail('B opening');
    return {
      settlement: {
        poolId: pid, reserveAPre: op.reserveAPre, reserveBPre: op.reserveBPre, sharesPre: op.sharesPre,
        reserveAPost: op.reserveAPre - op.dA, reserveBPost: op.reserveBPre - op.dB, sharesPost: op.sharesPre - op.dShares,
      },
      fees: fee > 0n ? [{ assetId: op.assetA, value: fee }] : [],
      nullifiers: [nullifier(op.share.cx, op.share.cy)],
      leaves: [leaf(op.assetA, op.a.cx, op.a.cy, op.a.owner), leaf(op.assetB, op.b.cx, op.b.cy, op.b.owner)],
    };
  }

  return { poolId, poolIdWithProtocolFee, lpShareId, buildAdd, verifyAdd, buildRemove, verifyRemove };
}
