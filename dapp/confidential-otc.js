// Confidential OTC (OP_OTC) witness assembler for the EVM confidential pool.
//
// A direct 2-party swap of shielded notes: the MAKER gives `vA` of assetA and receives `vB` of
// assetB; the TAKER gives `vB` of assetB and receives `vA` of assetA. No pool, no price curve — a
// fixed agreed (vA, vB) cleared peer-to-peer. Each note is bound to its amount by an OPENING SIGMA
// (Schnorr PoK of the note blinding `r` for the stated amount) under a SHARED intent context, so the
// settle prover (the box / matcher) verifies the openings WITHOUT learning `r` and can neither spend
// an input elsewhere nor redirect/relabel an output: every output owner + both amounts are in the
// context. Atomic by construction — one OP_OTC is one op in one proof. This is the direct-trade
// counterpart to OP_SWAP and reuses the same primitives. A passing Node round-trip locks the witness
// the guest re-verifies (mirror of contracts/sp1/confidential/src/main.rs OP_OTC).
//
// keccak injected for Node+browser parity; `pool` is a makeConfidentialPool instance whose
// commitXY/leaf/nullifier/merkle + openingSigma/intentContext primitives the guest agrees on.

const U64_MAX = (1n << 64n) - 1n;
const ZERO32 = '0x' + '00'.repeat(32);
const OTC_TAG = 'tacit-otc-intent-v1';

export function makeConfidentialOtc({ keccak256, pool }) {
  const { leaf, nullifier, commitXY, openingSigma, verifyOpeningSigma, intentContext } = pool;

  // The shared intent context (mirror of the guest): every touched note (cx, cy, owner) in fixed
  // order + both amounts. `m`/`t` are the built maker/taker legs.
  function otcCtx(assetA, assetB, chainBinding, vA, vB, m, t) {
    const notes = [[m.in.cx, m.in.cy, m.owner]];
    if (m.change) notes.push([m.change.cx, m.change.cy, m.owner]);
    notes.push([m.recv.cx, m.recv.cy, m.owner]);
    notes.push([t.in.cx, t.in.cy, t.owner]);
    if (t.change) notes.push([t.change.cx, t.change.cy, t.owner]);
    notes.push([t.recv.cx, t.recv.cy, t.owner]);
    return intentContext(OTC_TAG, chainBinding, assetA, assetB, notes, [BigInt(vA), BigInt(vB)]);
  }

  // Build one party's leg commitments. `give` = what this party hands the counterparty (vA for the
  // maker's asset_a, vB for the taker's asset_b); `recvValue` = what it gets back. The input
  // blinding `inR` is the party's existing note secret (they know it); change/recv blindings are
  // fresh (the party picks them so only it can later spend the outputs). Change is omitted when the
  // input exactly equals the give amount (no dust 0-change).
  function buildLeg({ owner, inAmount, inR, inLeafIndex, inPath, give, recvValue, recvR, changeR }) {
    inAmount = BigInt(inAmount); give = BigInt(give); recvValue = BigInt(recvValue);
    if (inAmount < give) throw new Error('otc: input below give amount');
    const inC = commitXY(inAmount, inR);
    const recvC = commitXY(recvValue, recvR);
    const changeAmount = inAmount - give;
    let change = null;
    if (changeAmount > 0n) {
      if (changeR == null) throw new Error('otc: changeR required when input exceeds give');
      const c = commitXY(changeAmount, changeR);
      change = { cx: c.cx, cy: c.cy, amount: changeAmount, _r: BigInt(changeR) };
    } else if (changeR != null) {
      throw new Error('otc: changeR given but input equals give (use no change)');
    }
    return {
      owner,
      in: { cx: inC.cx, cy: inC.cy, amount: inAmount, leafIndex: inLeafIndex, path: inPath, _r: BigInt(inR) },
      recv: { cx: recvC.cx, cy: recvC.cy, amount: recvValue, _r: BigInt(recvR) },
      change,
    };
  }

  // Build the full OTC + generate every opening sigma once the shared context is known. Blindings +
  // nonces stay client-side (never enter the witness); only the commitments + sigmas (R, z) do.
  // `nonces` per party: { in, recv, change } — fresh random scalars (reuse leaks the blinding).
  function buildOtc({ assetA, assetB, vA, vB, chainBinding, spendRoot, maker, taker, nonces }) {
    vA = BigInt(vA); vB = BigInt(vB);
    const m = buildLeg({ ...maker, give: vA, recvValue: vB });
    const t = buildLeg({ ...taker, give: vB, recvValue: vA });
    const ctx = otcCtx(assetA, assetB, chainBinding, vA, vB, m, t);

    m.in.sig = openingSigma(m.in.amount, m.in._r, ctx, nonces.maker.in);
    m.recv.sig = openingSigma(m.recv.amount, m.recv._r, ctx, nonces.maker.recv);
    if (m.change) m.change.sig = openingSigma(m.change.amount, m.change._r, ctx, nonces.maker.change);
    t.in.sig = openingSigma(t.in.amount, t.in._r, ctx, nonces.taker.in);
    t.recv.sig = openingSigma(t.recv.amount, t.recv._r, ctx, nonces.taker.recv);
    if (t.change) t.change.sig = openingSigma(t.change.amount, t.change._r, ctx, nonces.taker.change);

    return { assetA, assetB, vA, vB, chainBinding, spendRoot, maker: m, taker: t };
  }

  // JS mirror of EVERY OP_OTC guest assertion. Returns { nullifiers, leaves } or throws.
  function verifyOtc(otc, { merkleRootFrom }) {
    const fail = (msg) => { throw new Error('otc: ' + msg); };
    const { assetA, assetB, chainBinding, spendRoot, maker: m, taker: t } = otc;
    const vA = BigInt(otc.vA), vB = BigInt(otc.vB);
    if (!(vA > 0n && vB > 0n)) fail('zero amount');
    if (assetA === assetB) fail('same asset');
    if (spendRoot === ZERO32 || !spendRoot) fail('membership requires a non-zero spend root');

    // Membership of each spent input (maker spends assetA, taker spends assetB).
    const mInLf = leaf(assetA, m.in.cx, m.in.cy, m.owner);
    if (merkleRootFrom(mInLf, m.in.leafIndex, m.in.path) !== spendRoot) fail('maker membership');
    const tInLf = leaf(assetB, t.in.cx, t.in.cy, t.owner);
    if (merkleRootFrom(tInLf, t.in.leafIndex, t.in.path) !== spendRoot) fail('taker membership');

    // Opening sigmas against the shared context: inputs authorize the spend, outputs bind the
    // received amount to the owner (no redirect / no re-price).
    const ctx = otcCtx(assetA, assetB, chainBinding, vA, vB, m, t);
    if (!verifyOpeningSigma(m.in.cx, m.in.cy, m.in.amount, m.in.sig.R, m.in.sig.z, ctx)) fail('maker-in opening');
    if (!verifyOpeningSigma(t.in.cx, t.in.cy, t.in.amount, t.in.sig.R, t.in.sig.z, ctx)) fail('taker-in opening');
    if (!verifyOpeningSigma(m.recv.cx, m.recv.cy, vB, m.recv.sig.R, m.recv.sig.z, ctx)) fail('maker-recv opening');
    if (!verifyOpeningSigma(t.recv.cx, t.recv.cy, vA, t.recv.sig.R, t.recv.sig.z, ctx)) fail('taker-recv opening');

    // Per-asset conservation + canonical change form.
    const changeA = m.change ? m.change.amount : 0n;
    const changeB = t.change ? t.change.amount : 0n;
    if (m.change) {
      if (!(m.in.amount > vA)) fail('maker change requires input > give');
      if (!verifyOpeningSigma(m.change.cx, m.change.cy, changeA, m.change.sig.R, m.change.sig.z, ctx)) fail('maker-change opening');
    } else if (m.in.amount !== vA) fail('maker exact input required without change');
    if (t.change) {
      if (!(t.in.amount > vB)) fail('taker change requires input > give');
      if (!verifyOpeningSigma(t.change.cx, t.change.cy, changeB, t.change.sig.R, t.change.sig.z, ctx)) fail('taker-change opening');
    } else if (t.in.amount !== vB) fail('taker exact input required without change');
    if (m.in.amount !== vA + changeA) fail('asset_a conservation');
    if (t.in.amount !== vB + changeB) fail('asset_b conservation');
    if (vA + changeA > U64_MAX || vB + changeB > U64_MAX) fail('amount over u64');

    // Emit ν + leaves in the guest's fixed order (client + memos mirror it).
    const nullifiers = [nullifier(m.in.cx, m.in.cy), nullifier(t.in.cx, t.in.cy)];
    const leaves = [
      leaf(assetA, t.recv.cx, t.recv.cy, t.owner), // taker receives assetA (vA)
      leaf(assetB, m.recv.cx, m.recv.cy, m.owner), // maker receives assetB (vB)
    ];
    if (m.change) leaves.push(leaf(assetA, m.change.cx, m.change.cy, m.owner));
    if (t.change) leaves.push(leaf(assetB, t.change.cx, t.change.cy, t.owner));
    return { nullifiers, leaves };
  }

  return { buildLeg, buildOtc, verifyOtc, OTC_TAG };
}
