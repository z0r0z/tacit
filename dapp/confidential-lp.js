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

export function makeConfidentialLp({ keccak256, pool, kernelSign, rangeProve }) {
  const { leaf, nullifier, commitXY, openingSigma, verifyOpeningSigma, openingPokBlind, verifyOpeningPokBlind, deriveOpeningNonce, intentContext } = pool;
  const enc = new TextEncoder();
  const hexToBytes = (h) => { h = (h || '').replace(/^0x/, ''); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
  const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
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
  // EVERY contributing note on both legs is bound, not just the first, so a relay cannot drop one input.
  // n_a/n_b are bound after the scalars to make the leg partition explicit: without them (1,2) and (2,1)
  // over the same ordered note list hash identically.
  const addCtx = (op) => {
    const pid = poolIdWithProtocolFee(op.assetA, op.assetB, op.feeBps, op.protocolFeeRecipient ?? ZERO_RCPT, op.protocolFeeBps ?? 0);
    const lpAsset = lpShareId(pid);
    const aIn = op.a.inputs ?? [{ cx: op.a.cx, cy: op.a.cy, owner: op.a.owner }];
    const bIn = op.b.inputs ?? [{ cx: op.b.cx, cy: op.b.cy, owner: op.b.owner }];
    return intentContext('tacit-lp-add-v1', op.chainBinding, op.assetA, op.assetB,
      [...aIn.map((n) => [n.cx, n.cy, n.owner]), ...bIn.map((n) => [n.cx, n.cy, n.owner]),
       [op.share.cx, op.share.cy, op.share.owner], [lpAsset, pid, op.share.owner]],
      [op.dA, op.dB, op.dShares, op.deadline ?? 0n, op.fee ?? 0n, BigInt(aIn.length), BigInt(bIn.length)]);
  };
  const removeCtx = (op) => intentContext('tacit-lp-remove-v1', op.chainBinding, op.assetA, op.assetB,
    [[op.share.cx, op.share.cy, op.share.owner], [op.a.cx, op.a.cy, op.a.owner], [op.b.cx, op.b.cy, op.b.owner]],
    [op.dShares, op.dA, op.dB, op.deadline ?? 0n, op.fee ?? 0n]);

  // ── OP_LP_ADD ──  first mint: shares = isqrt(dA·dB) − MIN_LIQ; subsequent: min rule (off-ratio safe).
  // The blindings rA/rB/rShares stay CLIENT-SIDE; only the opening sigmas reach the witness. Each sigma
  // nonce is DERIVED per (note blinding, intent context) so a re-add of the same note never reuses one.
  // MULTI-NOTE LEGS: pass `aNotes` / `bNotes` (arrays of {cx,cy,owner,leafIndex,path,value,blinding}) to feed
  // several accumulated notes into one side instead of paying for a consolidation settle first. The single
  // `aNote`+`rA` form still works and is normalised to a one-element array. Each note carries its OWN blind
  // PoK; the leg's kernel conserves Σ inputs == contribution + Σ change.
  function buildAdd({ assetA, assetB, chainBinding, feeBps, protocolFeeBps = 0, protocolFeeRecipient = ZERO_RCPT, reserveAPre, reserveBPre, sharesPre, aNote, bNote, aNotes, bNotes, dA, dB, rA, rB, shareOwner, rShares, deadline, fee = 0n, aChange = [], bChange = [] }) {
    const legNotes = (arr, one, r) => (arr && arr.length
      ? arr.map((n) => ({ ...n, blinding: BigInt(n.blinding), value: BigInt(n.value) }))
      : [{ ...one, blinding: BigInt(r), value: null }]);
    const aIns = legNotes(aNotes, aNote, rA);
    const bIns = legNotes(bNotes, bNote, rB);
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
    // PARTIAL ADDS: the A/B notes commit their FULL value; the contribution (dA/dB) is what enters the pool
    // and the remainder returns as change. With no change these reduce to the old whole-note commitments.
    const aTotal = aChange.reduce((t, c) => t + BigInt(c.value), BigInt(dA));
    const bTotal = bChange.reduce((t, c) => t + BigInt(c.value), BigInt(dB));
    // Single-note legs derive the commitment from (total, r). Multi-note legs use each note's own
    // commitment and value as supplied — and their values must sum to the leg total.
    const legCommit = (ins, total, r) => {
      if (ins.length === 1 && ins[0].value == null) {
        const c = commitXY(total, r);
        ins[0] = { ...ins[0], cx: c.cx, cy: c.cy, value: total };
        return ins;
      }
      const sum = ins.reduce((t, n) => t + n.value, 0n);
      if (sum !== total) throw new Error('lp_add: leg inputs must sum to the contribution + change');
      return ins.map((n) => ({ ...n, ...(n.cx ? {} : commitXY(n.value, n.blinding)) }));
    };
    const aFin = legCommit(aIns, aTotal, rA);
    const bFin = legCommit(bIns, bTotal, rB);
    const aC = { cx: aFin[0].cx, cy: aFin[0].cy }, bC = { cx: bFin[0].cx, cy: bFin[0].cy };
    const sC = commitXY(dShares, rShares);
    const op = {
      assetA, assetB, chainBinding, feeBps: Number(feeBps),
      protocolFeeBps: Number(protocolFeeBps), protocolFeeRecipient,
      deadline: BigInt(deadline ?? 0), fee: feeBig,
      reserveAPre: BigInt(reserveAPre), reserveBPre: BigInt(reserveBPre), sharesPre: BigInt(sharesPre),
      a: { cx: aC.cx, cy: aC.cy, owner: aFin[0].owner, leafIndex: aFin[0].leafIndex, path: aFin[0].path,
           inputs: aFin.map((n) => ({ cx: n.cx, cy: n.cy, owner: n.owner, leafIndex: n.leafIndex, path: n.path })) }, dA: BigInt(dA),
      b: { cx: bC.cx, cy: bC.cy, owner: bFin[0].owner, leafIndex: bFin[0].leafIndex, path: bFin[0].path,
           inputs: bFin.map((n) => ({ cx: n.cx, cy: n.cy, owner: n.owner, leafIndex: n.leafIndex, path: n.path })) }, dB: BigInt(dB),
      dShares, share: { cx: sC.cx, cy: sC.cy, owner: shareOwner },
    };
    const ctx = addCtx(op);
    // A/B prove spend authority WITHOUT revealing the note value (the guest's verify_opening_pok_blind);
    // conservation `note == d_x + Σ change` is the kernel's job. The SHARE note still opens exactly to
    // dShares (derived in-guest), so it keeps a value-revealing sigma.
    // ONE PoK PER INPUT NOTE — every contributing spender signs the shared ctx, so a relay cannot drop or
    // substitute one note out of a multi-note leg. The guest verifies them positionally against its inputs.
    const legPoks = (ins, tag) => ins.map((n, i) => openingPokBlind(
      n.value, n.blinding, ctx,
      deriveOpeningNonce(n.blinding, ctx, `${tag}-${i}-v`),
      deriveOpeningNonce(n.blinding, ctx, `${tag}-${i}-r`),
    ));
    const aPoks = legPoks(aFin, 'lp-add-a');
    const bPoks = legPoks(bFin, 'lp-add-b');
    op.a.inputs = op.a.inputs.map((n, i) => ({ ...n, pokR: aPoks[i].R, pokZv: aPoks[i].zV, pokZr: aPoks[i].zR }));
    op.b.inputs = op.b.inputs.map((n, i) => ({ ...n, pokR: bPoks[i].R, pokZv: bPoks[i].zV, pokZr: bPoks[i].zR }));
    op.aPok = aPoks[0]; op.bPok = bPoks[0]; // single-note compatibility
    // The membership witness (leafIndex/path) is only knowable once the commitments exist and have been
    // placed in the tree, so callers patch it after the build. The guest reads membership PER INPUT, so
    // the legacy single-note fields alias inputs[0] rather than holding a detached copy — a write to
    // op.a.leafIndex/op.a.path lands on the witness the guest actually verifies.
    for (const leg of [op.a, op.b]) {
      const first = leg.inputs[0];
      for (const k of ['leafIndex', 'path']) {
        delete leg[k];
        Object.defineProperty(leg, k, {
          enumerable: true, configurable: true,
          get: () => first[k],
          set: (v) => { first[k] = v; },
        });
      }
    }
    op.sSig = openingSigma(op.dShares, rShares, ctx, deriveOpeningNonce(rShares, ctx, 'lp-add-share'));

    // Change notes, each under ITS OWN leg's asset (never a shared witnessed asset).
    const mk = (asset, arr) => arr.map((c) => {
      const cc = commitXY(BigInt(c.value), BigInt(c.blinding));
      return { cx: cc.cx, cy: cc.cy, owner: c.owner, value: BigInt(c.value), blinding: BigInt(c.blinding), asset };
    });
    op.aChange = mk(assetA, aChange);
    op.bChange = mk(assetB, bChange);
    const aLeaves = op.aChange.map((c) => leaf(assetA, c.cx, c.cy, c.owner));
    const bLeaves = op.bChange.map((c) => leaf(assetB, c.cx, c.cy, c.owner));
    // Conservation is PER ASSET: each leg's note == its public contribution + its own change.
    // Conservation spans ALL of the leg's inputs: Σ inputs == contribution + Σ change.
    const aK = kernelSign({ inputs: aFin.map((n) => ({ value: n.value, blinding: n.blinding })), outputs: op.aChange, fee: BigInt(dA), outLeaves: aLeaves });
    const bK = kernelSign({ inputs: bFin.map((n) => ({ value: n.value, blinding: n.blinding })), outputs: op.bChange, fee: BigInt(dB), outLeaves: bLeaves });
    op.aKernel = { R: aK.R, z: aK.z };
    op.bKernel = { R: bK.R, z: bK.z };
    // ONE BP+ range proof across both legs' change (range is asset-agnostic — matches the guest).
    if (op.aChange.length || op.bChange.length) {
      const allCh = [...op.aChange, ...op.bChange];
      op.changeRangeProof = rangeProve(allCh.map((c) => c.value), allCh.map((c) => c.blinding));
    }
    return op;
  }

  function verifyAdd(op, { merkleRootFrom, spendRoot }) {
    const fail = (m) => { throw new Error('lp_add: ' + m); };
    if (spendRoot === ZERO32 || !spendRoot) fail('membership requires a non-zero spend root');
    const pid = poolIdWithProtocolFee(op.assetA, op.assetB, op.feeBps, op.protocolFeeRecipient ?? ZERO_RCPT, op.protocolFeeBps ?? 0), lpAsset = lpShareId(pid);
    // Membership is checked PER INPUT, over the same inputs[] array the guest reads — checking only the
    // legacy flat leg fields would pass while a stale per-input witness rode into the witness stream.
    const legIns = (leg) => leg.inputs ?? [{ cx: leg.cx, cy: leg.cy, owner: leg.owner, leafIndex: leg.leafIndex, path: leg.path }];
    for (const [tag, leg, asset] of [['A', op.a, op.assetA], ['B', op.b, op.assetB]]) {
      for (const n of legIns(leg)) {
        if (merkleRootFrom(leaf(asset, n.cx, n.cy, n.owner), n.leafIndex, n.path) !== spendRoot) fail(tag + ' membership');
      }
    }
    const ctx = addCtx(op);
    // A/B carry a value-HIDING PoK (the note may exceed the contribution); conservation is the kernel's job.
    if (!verifyOpeningPokBlind(op.a.cx, op.a.cy, op.aPok.R, op.aPok.zV, op.aPok.zR, ctx)) fail('A opening PoK');
    if (!verifyOpeningPokBlind(op.b.cx, op.b.cy, op.bPok.R, op.bPok.zV, op.bPok.zR, ctx)) fail('B opening PoK');
    // Change must be asset-scoped to its own leg — mirrors the guest, and is the §A check that FARM-01 failed.
    for (const c of (op.aChange || [])) if (c.asset !== op.assetA) fail('A change asset != assetA');
    for (const c of (op.bChange || [])) if (c.asset !== op.assetB) fail('B change asset != assetB');
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
  function buildRemove({ assetA, assetB, chainBinding, feeBps, protocolFeeBps = 0, protocolFeeRecipient = ZERO_RCPT, reserveAPre, reserveBPre, sharesPre, shareNote, dShares, rShares, aOwner, rA, bOwner, rB, deadline, fee = 0n, shareChange = [] }) {
    const a = floorDiv(BigInt(reserveAPre) * BigInt(dShares), sharesPre);
    const b = floorDiv(BigInt(reserveBPre) * BigInt(dShares), sharesPre);
    // The relay fee is carved from the A withdrawal: the A note opens to (dA − fee) while the pool still
    // releases the full proportional dA; `fee` is paid to the settler. fee = 0 ⇒ self-settle.
    const feeBig = BigInt(fee);
    if (!(feeBig < a.q)) throw new Error('lp_remove: fee >= A withdrawal');
    const netA = a.q - feeBig;
    // PARTIAL WITHDRAWAL: the share note commits its FULL holding; `dShares` is the public amount burned and
    // the remainder returns as LP-share change. Empty change ⇒ the old whole-note remove.
    const sTotal = shareChange.reduce((t, c) => t + BigInt(c.value), BigInt(dShares));
    const sC = commitXY(sTotal, rShares), aC = commitXY(netA, rA), bC = commitXY(b.q, rB);
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
    // The share note proves authority with a value-HIDING PoK; the kernel conserves it against dShares.
    op.sPok = openingPokBlind(sTotal, rShares, ctx, deriveOpeningNonce(rShares, ctx, 'lp-rm-share-v'), deriveOpeningNonce(rShares, ctx, 'lp-rm-share-r'));
    {
      const pid2 = poolIdWithProtocolFee(assetA, assetB, Number(feeBps), protocolFeeRecipient ?? ZERO_RCPT, Number(protocolFeeBps) || 0);
      const lpAsset2 = lpShareId(pid2);
      op.shareChange = shareChange.map((c) => {
        const cc = commitXY(BigInt(c.value), BigInt(c.blinding));
        return { cx: cc.cx, cy: cc.cy, owner: c.owner, value: BigInt(c.value), blinding: BigInt(c.blinding), asset: lpAsset2 };
      });
      const sLeaves = op.shareChange.map((c) => leaf(lpAsset2, c.cx, c.cy, c.owner));
      const sK = kernelSign({ inputs: [{ value: sTotal, blinding: BigInt(rShares) }], outputs: op.shareChange, fee: BigInt(dShares), outLeaves: sLeaves });
      op.shareKernel = { R: sK.R, z: sK.z };
      if (op.shareChange.length) {
        op.changeRangeProof = rangeProve(op.shareChange.map((c) => c.value), op.shareChange.map((c) => c.blinding));
      }
    }
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
    // The SPENT share note now carries a value-hiding PoK (it may exceed dShares); the kernel conserves it.
    if (!verifyOpeningPokBlind(op.share.cx, op.share.cy, op.sPok.R, op.sPok.zV, op.sPok.zR, ctx)) fail('share opening PoK');
    for (const c of (op.shareChange || [])) if (c.asset !== lpAsset) fail('share change asset != lpAsset');
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

  // isqrt / MINIMUM_LIQUIDITY / lpAddShares are exported so the wrap-fusion path (OP_WRAP_LP) can derive
  // the same share amount the guest does, without duplicating the min-rule.
  return { poolId, poolIdWithProtocolFee, lpShareId, buildAdd, verifyAdd, buildRemove, verifyRemove, isqrt, MINIMUM_LIQUIDITY, lpAddShares };
}
