// Confidential LP (OP_LP_ADD / OP_LP_REMOVE) witness assembler for the EVM confidential AMM.
//
// An LP position is a shielded note of a pool-specific LP asset (lpShareId = keccak(poolId ‖ "lp")).
// Add: spend an A note + a B note, add them IN RATIO to the public reserves, mint an LP-share note
// for the proportional shares. Remove: spend the LP-share note, withdraw the proportional underlying
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
  const lpShareId = (pid) => bytesToHex(keccak256(concat([hexToBytes(pid), enc.encode('lp')])));
  const floorDiv = (num, den) => { num = BigInt(num); den = BigInt(den); const q = num / den; return { q, rem: num - q * den }; };

  const addCtx = (op) => intentContext('tacit-lp-add-v1', op.chainBinding, op.assetA, op.assetB,
    [[op.a.cx, op.a.cy, op.a.owner], [op.b.cx, op.b.cy, op.b.owner], [op.share.cx, op.share.cy, op.share.owner]],
    [op.dA, op.dB, op.dShares]);
  const removeCtx = (op) => intentContext('tacit-lp-remove-v1', op.chainBinding, op.assetA, op.assetB,
    [[op.share.cx, op.share.cy, op.share.owner], [op.a.cx, op.a.cy, op.a.owner], [op.b.cx, op.b.cy, op.b.owner]],
    [op.dShares, op.dA, op.dB]);

  // ── OP_LP_ADD ──  dB must be in-ratio (dA·R_B == dB·R_A); shares = floor(sharesPre·dA/R_A).
  // The blindings rA/rB/rShares stay CLIENT-SIDE; only the opening sigmas reach the witness. Each sigma
  // nonce is DERIVED per (note blinding, intent context) so a re-add of the same note never reuses one.
  function buildAdd({ assetA, assetB, chainBinding, feeBps, reserveAPre, reserveBPre, sharesPre, aNote, bNote, dA, dB, rA, rB, shareOwner, rShares }) {
    const { q: dShares, rem } = floorDiv(BigInt(sharesPre) * BigInt(dA), reserveAPre);
    const aC = commitXY(dA, rA), bC = commitXY(dB, rB), sC = commitXY(dShares, rShares);
    const op = {
      assetA, assetB, chainBinding, feeBps: Number(feeBps),
      reserveAPre: BigInt(reserveAPre), reserveBPre: BigInt(reserveBPre), sharesPre: BigInt(sharesPre),
      a: { cx: aC.cx, cy: aC.cy, owner: aNote.owner, leafIndex: aNote.leafIndex, path: aNote.path }, dA: BigInt(dA),
      b: { cx: bC.cx, cy: bC.cy, owner: bNote.owner, leafIndex: bNote.leafIndex, path: bNote.path }, dB: BigInt(dB),
      dShares, rem, share: { cx: sC.cx, cy: sC.cy, owner: shareOwner },
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
    const pid = poolId(op.assetA, op.assetB, op.feeBps), lpAsset = lpShareId(pid);
    if (merkleRootFrom(leaf(op.assetA, op.a.cx, op.a.cy, op.a.owner), op.a.leafIndex, op.a.path) !== spendRoot) fail('A membership');
    if (merkleRootFrom(leaf(op.assetB, op.b.cx, op.b.cy, op.b.owner), op.b.leafIndex, op.b.path) !== spendRoot) fail('B membership');
    const ctx = addCtx(op);
    if (!verifyOpeningSigma(op.a.cx, op.a.cy, op.dA, op.aSig.R, op.aSig.z, ctx)) fail('A opening');
    if (!verifyOpeningSigma(op.b.cx, op.b.cy, op.dB, op.bSig.R, op.bSig.z, ctx)) fail('B opening');
    if (!(op.reserveAPre > 0n && op.reserveBPre > 0n && op.sharesPre > 0n)) fail('pool must be initialized');
    if (op.dA * op.reserveBPre !== op.dB * op.reserveAPre) fail('not in pool ratio');
    const { q, rem } = floorDiv(op.sharesPre * op.dA, op.reserveAPre);
    if (q !== op.dShares || rem !== op.rem) fail('proportional shares');
    if (!verifyOpeningSigma(op.share.cx, op.share.cy, op.dShares, op.sSig.R, op.sSig.z, ctx)) fail('share opening');
    return {
      settlement: {
        poolId: pid, reserveAPre: op.reserveAPre, reserveBPre: op.reserveBPre, sharesPre: op.sharesPre,
        reserveAPost: op.reserveAPre + op.dA, reserveBPost: op.reserveBPre + op.dB, sharesPost: op.sharesPre + op.dShares,
      },
      nullifiers: [nullifier(op.a.cx, op.a.cy), nullifier(op.b.cx, op.b.cy)],
      leaves: [leaf(lpAsset, op.share.cx, op.share.cy, op.share.owner)],
    };
  }

  // ── OP_LP_REMOVE ──  dA = floor(R_A·dShares/sharesPre), dB = floor(R_B·dShares/sharesPre).
  function buildRemove({ assetA, assetB, chainBinding, feeBps, reserveAPre, reserveBPre, sharesPre, shareNote, dShares, rShares, aOwner, rA, bOwner, rB }) {
    const a = floorDiv(BigInt(reserveAPre) * BigInt(dShares), sharesPre);
    const b = floorDiv(BigInt(reserveBPre) * BigInt(dShares), sharesPre);
    const sC = commitXY(dShares, rShares), aC = commitXY(a.q, rA), bC = commitXY(b.q, rB);
    const op = {
      assetA, assetB, chainBinding, feeBps: Number(feeBps),
      reserveAPre: BigInt(reserveAPre), reserveBPre: BigInt(reserveBPre), sharesPre: BigInt(sharesPre),
      share: { cx: sC.cx, cy: sC.cy, owner: shareNote.owner, leafIndex: shareNote.leafIndex, path: shareNote.path }, dShares: BigInt(dShares),
      dA: a.q, remA: a.rem, dB: b.q, remB: b.rem,
      a: { cx: aC.cx, cy: aC.cy, owner: aOwner },
      b: { cx: bC.cx, cy: bC.cy, owner: bOwner },
    };
    const ctx = removeCtx(op);
    op.sSig = openingSigma(op.dShares, rShares, ctx, deriveOpeningNonce(rShares, ctx, 'lp-rm-share'));
    op.aSig = openingSigma(op.dA, rA, ctx, deriveOpeningNonce(rA, ctx, 'lp-rm-a'));
    op.bSig = openingSigma(op.dB, rB, ctx, deriveOpeningNonce(rB, ctx, 'lp-rm-b'));
    return op;
  }

  function verifyRemove(op, { merkleRootFrom, spendRoot }) {
    const fail = (m) => { throw new Error('lp_remove: ' + m); };
    if (spendRoot === ZERO32 || !spendRoot) fail('membership requires a non-zero spend root');
    const pid = poolId(op.assetA, op.assetB, op.feeBps), lpAsset = lpShareId(pid);
    if (merkleRootFrom(leaf(lpAsset, op.share.cx, op.share.cy, op.share.owner), op.share.leafIndex, op.share.path) !== spendRoot) fail('share membership');
    const ctx = removeCtx(op);
    if (!verifyOpeningSigma(op.share.cx, op.share.cy, op.dShares, op.sSig.R, op.sSig.z, ctx)) fail('share opening');
    if (!(op.sharesPre > 0n && op.dShares > 0n && op.dShares <= op.sharesPre)) fail('shares in range');
    const a = floorDiv(op.reserveAPre * op.dShares, op.sharesPre);
    const b = floorDiv(op.reserveBPre * op.dShares, op.sharesPre);
    if (a.q !== op.dA || a.rem !== op.remA) fail('dA proportional');
    if (b.q !== op.dB || b.rem !== op.remB) fail('dB proportional');
    if (!verifyOpeningSigma(op.a.cx, op.a.cy, op.dA, op.aSig.R, op.aSig.z, ctx)) fail('A opening');
    if (!verifyOpeningSigma(op.b.cx, op.b.cy, op.dB, op.bSig.R, op.bSig.z, ctx)) fail('B opening');
    return {
      settlement: {
        poolId: pid, reserveAPre: op.reserveAPre, reserveBPre: op.reserveBPre, sharesPre: op.sharesPre,
        reserveAPost: op.reserveAPre - op.dA, reserveBPost: op.reserveBPre - op.dB, sharesPost: op.sharesPre - op.dShares,
      },
      nullifiers: [nullifier(op.share.cx, op.share.cy)],
      leaves: [leaf(op.assetA, op.a.cx, op.a.cy, op.a.owner), leaf(op.assetB, op.b.cx, op.b.cy, op.b.owner)],
    };
  }

  // ── initPool seed (V2-style founder LP recovery) ──
  // The founder's claimable position is rLo − MINIMUM_LIQUIDITY; MINIMUM_LIQUIDITY (must match
  // ConfidentialPool.MINIMUM_LIQUIDITY) is the permanently-locked floor that keeps the (pair,fee) slot
  // live after the founder fully exits.
  const MINIMUM_LIQUIDITY = 1000n;

  // The pending-deposit id ConfidentialPool records for the founder LP-share note — identical to the
  // guest's OP_WRAP deposit_id: keccak(lpAsset ‖ be32(value) ‖ cx ‖ cy ‖ owner) (the contract's
  // keccak256(abi.encode(lpAsset, value, cx, cy, owner)), value ≤ u64). Lets the dapp match the
  // PoolSeeded event and locate the claimable deposit.
  function seedDepositId(lpAsset, value, cx, cy, owner) {
    return bytesToHex(keccak256(concat([hexToBytes(lpAsset), be32(value), hexToBytes(cx), hexToBytes(cy), hexToBytes(owner)])));
  }

  // Build the EVM initPool args + the founder's RECOVERABLE LP-share note. ConfidentialPool.initPool
  // locks MINIMUM_LIQUIDITY of the rLo share basis and records the remainder (rLo − MINIMUM_LIQUIDITY) as
  // a pending LP-share deposit; the founder mints the note with an OP_WRAP opening proof (the SAME claim
  // path as a wrap), then spends it via buildRemove like any LP-share note — so the founder keeps their
  // seed as a shielded position instead of donating it. Caller presents assetA < assetB (canonical, like
  // buildAdd/buildRemove), so reserveA == the rLo share basis. The blinding stays client-side until the
  // claim proof. Returns the initPool args, the share note (with its deposit id), and the pool ids.
  function buildSeed({ assetA, assetB, reserveA, reserveB, feeBps, shareOwner, rShares, minimumLiquidity = MINIMUM_LIQUIDITY }) {
    if (bigOf(assetA) >= bigOf(assetB)) throw new Error('seed: present assetA < assetB (canonical order)');
    const rLo = BigInt(reserveA), minLiq = BigInt(minimumLiquidity);
    if (rLo <= minLiq) throw new Error('seed: reserveA (the share basis) must exceed MINIMUM_LIQUIDITY');
    const founderShares = rLo - minLiq;
    const pid = poolId(assetA, assetB, feeBps), lpAsset = lpShareId(pid);
    const sC = commitXY(founderShares, rShares); // C = founderShares·H + rShares·G
    const depositId = seedDepositId(lpAsset, founderShares, sC.cx, sC.cy, shareOwner);
    return {
      poolId: pid, lpAsset, founderShares,
      // the 8 args for ConfidentialPool.initPool(assetA, assetB, reserveA, reserveB, feeBps, shareCx, shareCy, shareOwner)
      initPoolArgs: {
        assetA, assetB, reserveA: BigInt(reserveA), reserveB: BigInt(reserveB), feeBps: Number(feeBps),
        shareCx: sC.cx, shareCy: sC.cy, shareOwner,
      },
      seedShareNote: { asset: lpAsset, value: founderShares, cx: sC.cx, cy: sC.cy, owner: shareOwner, blinding: BigInt(rShares), depositId },
    };
  }

  // Round-trip: the seed share commitment opens to founderShares under its blinding (so the OP_WRAP claim
  // will verify) — a cheap client-side sanity check before broadcasting initPool.
  function verifySeed(seed) {
    const { value, cx, cy, blinding } = seed.seedShareNote;
    const c = commitXY(value, blinding);
    return c.cx === cx && c.cy === cy;
  }

  return { poolId, lpShareId, buildAdd, verifyAdd, buildRemove, verifyRemove, buildSeed, seedDepositId, verifySeed, MINIMUM_LIQUIDITY };
}
