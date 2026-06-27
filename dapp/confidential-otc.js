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
  const { leaf, nullifier, commitXY, openingSigma, verifyOpeningSigma, deriveOpeningNonce, intentContext } = pool;

  // The shared intent context (mirror of the guest): every touched note (cx, cy, owner) in fixed
  // order + both amounts. `m`/`t` are the built maker/taker legs.
  function otcCtx(assetA, assetB, chainBinding, vA, vB, m, t, deadline, feeA = 0n, feeB = 0n) {
    const notes = [[m.in.cx, m.in.cy, m.owner]];
    if (m.change) notes.push([m.change.cx, m.change.cy, m.owner]);
    notes.push([m.recv.cx, m.recv.cy, m.owner]);
    notes.push([t.in.cx, t.in.cy, t.owner]);
    if (t.change) notes.push([t.change.cx, t.change.cy, t.owner]);
    notes.push([t.recv.cx, t.recv.cy, t.owner]);
    return intentContext(OTC_TAG, chainBinding, assetA, assetB, notes, [BigInt(vA), BigInt(vB), BigInt(deadline ?? 0), BigInt(feeA), BigInt(feeB)]);
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

  // Build the full OTC + generate every opening sigma once the shared context is known. Blindings stay
  // client-side (never enter the witness); only the commitments + sigmas (R, z) do. Each sigma nonce is
  // DERIVED per (note blinding, shared context) so a renegotiation (new vA/vB) of the same input note
  // never reuses a nonce (reuse would leak the blinding → bearer spend).
  function buildOtc({ assetA, assetB, vA, vB, chainBinding, spendRoot, maker, taker, deadline, feeA = 0n, feeB = 0n }) {
    vA = BigInt(vA); vB = BigInt(vB);
    feeA = BigInt(feeA); feeB = BigInt(feeB);
    // Each party may carve a relay fee from the asset it RECEIVES: the taker from vA (asset_a), the
    // maker from vB (asset_b). The received note is built to the NET; fee = 0 ⇒ self-settle.
    if (!(feeA < vA)) throw new Error('otc: feeA >= taker receipt');
    if (!(feeB < vB)) throw new Error('otc: feeB >= maker receipt');
    deadline = BigInt(deadline ?? 0);
    const m = buildLeg({ ...maker, give: vA, recvValue: vB - feeB });
    const t = buildLeg({ ...taker, give: vB, recvValue: vA - feeA });
    const ctx = otcCtx(assetA, assetB, chainBinding, vA, vB, m, t, deadline, feeA, feeB);

    m.in.sig = openingSigma(m.in.amount, m.in._r, ctx, deriveOpeningNonce(m.in._r, ctx, 'otc-maker-in'));
    m.recv.sig = openingSigma(m.recv.amount, m.recv._r, ctx, deriveOpeningNonce(m.recv._r, ctx, 'otc-maker-recv'));
    if (m.change) m.change.sig = openingSigma(m.change.amount, m.change._r, ctx, deriveOpeningNonce(m.change._r, ctx, 'otc-maker-change'));
    t.in.sig = openingSigma(t.in.amount, t.in._r, ctx, deriveOpeningNonce(t.in._r, ctx, 'otc-taker-in'));
    t.recv.sig = openingSigma(t.recv.amount, t.recv._r, ctx, deriveOpeningNonce(t.recv._r, ctx, 'otc-taker-recv'));
    if (t.change) t.change.sig = openingSigma(t.change.amount, t.change._r, ctx, deriveOpeningNonce(t.change._r, ctx, 'otc-taker-change'));

    return { assetA, assetB, vA, vB, chainBinding, spendRoot, maker: m, taker: t, deadline, feeA, feeB };
  }

  // JS mirror of EVERY OP_OTC guest assertion. Returns { nullifiers, leaves } or throws.
  function verifyOtc(otc, { merkleRootFrom }) {
    const fail = (msg) => { throw new Error('otc: ' + msg); };
    const { assetA, assetB, chainBinding, spendRoot, maker: m, taker: t } = otc;
    const vA = BigInt(otc.vA), vB = BigInt(otc.vB), deadline = BigInt(otc.deadline ?? 0);
    const feeA = BigInt(otc.feeA ?? 0n), feeB = BigInt(otc.feeB ?? 0n);
    if (!(vA > 0n && vB > 0n)) fail('zero amount');
    if (!(feeA < vA)) fail('feeA >= taker receipt');
    if (!(feeB < vB)) fail('feeB >= maker receipt');
    if (assetA === assetB) fail('same asset');
    if (spendRoot === ZERO32 || !spendRoot) fail('membership requires a non-zero spend root');

    // Membership of each spent input (maker spends assetA, taker spends assetB).
    const mInLf = leaf(assetA, m.in.cx, m.in.cy, m.owner);
    if (merkleRootFrom(mInLf, m.in.leafIndex, m.in.path) !== spendRoot) fail('maker membership');
    const tInLf = leaf(assetB, t.in.cx, t.in.cy, t.owner);
    if (merkleRootFrom(tInLf, t.in.leafIndex, t.in.path) !== spendRoot) fail('taker membership');

    // Opening sigmas against the shared context: inputs authorize the spend, outputs bind the
    // received amount to the owner (no redirect / no re-price).
    const ctx = otcCtx(assetA, assetB, chainBinding, vA, vB, m, t, deadline, feeA, feeB);
    if (!verifyOpeningSigma(m.in.cx, m.in.cy, m.in.amount, m.in.sig.R, m.in.sig.z, ctx)) fail('maker-in opening');
    if (!verifyOpeningSigma(t.in.cx, t.in.cy, t.in.amount, t.in.sig.R, t.in.sig.z, ctx)) fail('taker-in opening');
    if (!verifyOpeningSigma(m.recv.cx, m.recv.cy, vB - feeB, m.recv.sig.R, m.recv.sig.z, ctx)) fail('maker-recv opening (net of relay fee)');
    if (!verifyOpeningSigma(t.recv.cx, t.recv.cy, vA - feeA, t.recv.sig.R, t.recv.sig.z, ctx)) fail('taker-recv opening (net of relay fee)');

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
    const fees = [];
    if (feeA > 0n) fees.push({ assetId: assetA, value: feeA });
    if (feeB > 0n) fees.push({ assetId: assetB, value: feeB });
    return { nullifiers, leaves, fees };
  }

  // ── trustless 2-party composer ──
  // buildOtc is the single-assembler path (needs both blindings). For a real handshake neither party holds
  // the other's `r`, so each signs ONLY its own legs. The opening sigma depends solely on (the party's own
  // _r, the SHARED context), so a split-signed OTC is BYTE-IDENTICAL to a monolithic buildOtc — same guest
  // check. Flow: each party builds its leg commitments (buildLeg) and shares them (NO _r); once both legs are
  // known either side computes the shared context and signs its own legs; assembleOtc merges the signed legs.

  // The shared context from two already-built legs (commitments only needed).
  function composeCtx({ assetA, assetB, chainBinding, vA, vB, maker, taker, deadline = 0, feeA = 0n, feeB = 0n }) {
    return otcCtx(assetA, assetB, chainBinding, vA, vB, maker, taker, deadline, feeA, feeB);
  }
  // Sign this party's own legs against the shared context. role ∈ {'maker','taker'}.
  function signLegs(leg, ctx, role) {
    const tag = role === 'maker' ? 'otc-maker' : 'otc-taker';
    leg.in.sig = openingSigma(leg.in.amount, leg.in._r, ctx, deriveOpeningNonce(leg.in._r, ctx, `${tag}-in`));
    leg.recv.sig = openingSigma(leg.recv.amount, leg.recv._r, ctx, deriveOpeningNonce(leg.recv._r, ctx, `${tag}-recv`));
    if (leg.change) leg.change.sig = openingSigma(leg.change.amount, leg.change._r, ctx, deriveOpeningNonce(leg.change._r, ctx, `${tag}-change`));
    return leg;
  }
  // The value-conservation invariants the guest enforces, checked WITHOUT the merkle witness (which a
  // composer may not yet hold). Fails a mis-built split-signed OTC here rather than producing a proof
  // that only fails late. A strict subset of verifyOtc — no new acceptance, only earlier rejection.
  function assertOtcConservation(otc) {
    const fail = (m) => { throw new Error('otc: ' + m); };
    const vA = BigInt(otc.vA), vB = BigInt(otc.vB);
    const feeA = BigInt(otc.feeA ?? 0n), feeB = BigInt(otc.feeB ?? 0n);
    if (!(vA > 0n && vB > 0n)) fail('zero amount');
    if (!(feeA < vA)) fail('feeA >= taker receipt');
    if (!(feeB < vB)) fail('feeB >= maker receipt');
    if (otc.assetA === otc.assetB) fail('same asset');
    const m = otc.maker, t = otc.taker;
    const changeA = m.change ? BigInt(m.change.amount) : 0n;
    const changeB = t.change ? BigInt(t.change.amount) : 0n;
    if (m.change) { if (!(BigInt(m.in.amount) > vA)) fail('maker change requires input > give'); }
    else if (BigInt(m.in.amount) !== vA) fail('maker exact input required without change');
    if (t.change) { if (!(BigInt(t.in.amount) > vB)) fail('taker change requires input > give'); }
    else if (BigInt(t.in.amount) !== vB) fail('taker exact input required without change');
    if (BigInt(m.in.amount) !== vA + changeA) fail('asset_a conservation');
    if (BigInt(t.in.amount) !== vB + changeB) fail('asset_b conservation');
    if (vA + changeA > U64_MAX || vB + changeB > U64_MAX) fail('amount over u64');
  }

  // Merge two signed legs into the final OTC object (same shape as buildOtc's return).
  function assembleOtc({ assetA, assetB, vA, vB, chainBinding, spendRoot, maker, taker, deadline = 0, feeA = 0n, feeB = 0n }) {
    const out = { assetA, assetB, vA: BigInt(vA), vB: BigInt(vB), chainBinding, spendRoot, maker, taker, deadline: BigInt(deadline), feeA: BigInt(feeA), feeB: BigInt(feeB) };
    assertOtcConservation(out);
    return out;
  }

  return { buildLeg, buildOtc, verifyOtc, composeCtx, signLegs, assembleOtc, OTC_TAG };
}
