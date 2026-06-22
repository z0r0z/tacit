// Confidential AMM batch (OP_SWAP) witness assembler for the EVM confidential pool.
//
// A swap intent spends a secp pool note and clears it, at one uniform batch price, into a fresh
// secp note in the other asset. The guest computes the clearing so it sees the amounts (it is the
// prover); it binds each amount to its note with an OPENING SIGMA — a Schnorr proof of knowledge of
// the note's blinding `r` for the stated amount — NOT the raw `r`. So the settle prover (the box)
// verifies the opening without learning `r`, and therefore cannot spend the input note elsewhere or
// redirect the output: the sigma's challenge binds the whole intent (both notes + owners +
// direction/amounts/min_out), the swap analog of how the kernel hides transfer blindings. A passing
// Node round-trip here locks the witness the guest re-verifies.
//
// Price is `priceNum/priceDen` = units of B per A (ONE uniform price for the whole batch):
//   A→B: amount_out_B = floor(amount_in_A · priceNum/priceDen)
//   B→A: amount_out_A = floor(amount_in_B · priceDen/priceNum)   (the same price, inverted)
// LPs are protected by the constant-product non-decrease (k_post ≥ k_pre); each trader by min_out.
//
// keccak injected for Node+browser parity; `pool` is a makeConfidentialPool instance whose
// commitXY/leaf/nullifier/merkle + openingSigma/intentContext primitives the guest agrees on.

const U64_MAX = (1n << 64n) - 1n;
const ZERO32 = '0x' + '00'.repeat(32);
const bmod = (a, m) => ((a % m) + m) % m;
const SWAP_TAG = 'tacit-swap-intent-v1';

export function clearingPriceBperA(sol) {
  return { priceNum: BigInt(sol.P_clear_den), priceDen: BigInt(sol.P_clear_num) };
}

// Deterministic uniform-price clearing solve (AMM.md §4) — the SAME algorithm the guest enforces
// (cxfer-core solve_clearing) and the canonical JS (tests/amm-clearing.mjs). Kept self-contained here
// so the shipped dapp can pre-derive the fee-correct price (and verifyBatch can reject under-charged
// batches before the box does). The node swap/clearing tests cross-check this against amm-clearing.mjs.
const _U64_MAX = (1n << 64n) - 1n;
const _FEE_BPS_MAX = 1000n;
const _asU64 = (x, n) => { const v = BigInt(x); if (v < 0n || v > _U64_MAX) throw new Error(`${n} must fit in u64`); return v; };
function _solveAToB(X, Y, R_A, R_B, gNum, gDen) {
  let lo = 1n, hi = X, best = 1n, iter = 0;
  while (iter < 64 && lo <= hi) {
    const mid = lo + (hi - lo) / 2n;
    const deltaB = (R_B * gNum * mid) / (R_A * gDen + gNum * mid);
    const denom = Y + deltaB;
    const deltaAImplied = denom === 0n ? X : X - (Y * X) / denom;
    if (deltaAImplied === mid) return { P_clear_num: X, P_clear_den: Y + deltaB };
    if (deltaAImplied < mid) hi = mid - 1n; else { best = mid; lo = mid + 1n; }
    iter++;
  }
  const fdb = (R_B * gNum * best) / (R_A * gDen + gNum * best);
  return { P_clear_num: X, P_clear_den: Y + fdb };
}
export function solveClearing(X, Y, R_A, R_B, fee_bps) {
  X = _asU64(X, 'X'); Y = _asU64(Y, 'Y'); R_A = _asU64(R_A, 'R_A'); R_B = _asU64(R_B, 'R_B');
  fee_bps = BigInt(fee_bps);
  if (fee_bps < 0n || fee_bps > _FEE_BPS_MAX) throw new Error('fee_bps out of range');
  if (X === 0n && Y === 0n) return { P_clear_num: R_A, P_clear_den: R_B === 0n ? 1n : R_B };
  if (R_A === 0n || R_B === 0n) throw new Error('pool reserves must be > 0 for a non-empty batch');
  const gDen = 10000n, gNum = gDen - fee_bps; // γ = (10000 − fee_bps) / 10000
  const lhs = X * R_B, rhs = Y * R_A;
  if (lhs > rhs) return _solveAToB(X, Y, R_A, R_B, gNum, gDen);
  if (lhs < rhs) { const r = _solveAToB(Y, X, R_B, R_A, gNum, gDen); return { P_clear_num: r.P_clear_den, P_clear_den: r.P_clear_num }; }
  return { P_clear_num: R_A, P_clear_den: R_B };
}

export function makeConfidentialSwap({ keccak256, pool }) {
  const { leaf, nullifier, commitXY, openingSigma, verifyOpeningSigma, deriveOpeningNonce, intentContext } = pool;
  const hexToBytes = (h) => { h = (h || '').replace(/^0x/, ''); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
  const bytesToHex = (b) => '0x' + Buffer.from(b).toString('hex');
  const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };

  const be32 = (n) => { const o = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
  const bigOf = (h) => BigInt('0x' + h.replace(/^0x/, ''));
  // poolId binds the CANONICAL pair (assets sorted) + the fee tier — one pool per (pair, fee), matching
  // the guest's pool_id + ConfidentialPool.initPool. Callers present assetA/assetB in canonical order
  // (assetA < assetB) so the reserves line up with the pool's canonical low→high storage.
  const poolId = (a, b, feeBps) => {
    const [lo, hi] = bigOf(a) <= bigOf(b) ? [a, b] : [b, a];
    return bytesToHex(keccak256(concat([hexToBytes(lo), hexToBytes(hi), be32(feeBps)])));
  };

  // floor clearing for one intent under the uniform price (B per A), with the remainder.
  function clearOut(direction, amountIn, priceNum, priceDen) {
    amountIn = BigInt(amountIn);
    const [mulN, divN] = direction === 'A->B' ? [BigInt(priceNum), BigInt(priceDen)] : [BigInt(priceDen), BigInt(priceNum)];
    const prod = amountIn * mulN;
    const amountOut = prod / divN;
    return { amountOut, rem: prod - amountOut * divN };
  }

  // The per-intent sigma context (mirror of the guest): binds both notes + owners + the trade terms.
  const intentCtx = (assetA, assetB, chainBinding, it) => intentContext(
    SWAP_TAG, chainBinding, assetA, assetB,
    [[it.in.cx, it.in.cy, it.in.owner], [it.out.cx, it.out.cy, it.out.owner]],
    [BigInt(it.dirByte), it.amountIn, it.amountOut, it.minOut, BigInt(it.deadline ?? 0), BigInt(it.fee ?? 0)],
  );

  // Build one intent. The secp blindings rInSecp/rOutSecp stay CLIENT-SIDE — they never enter the
  // witness; only the opening sigmas (R, z) do (generated in buildBatch once the batch context is
  // known). The sigma nonces are DERIVED per (note blinding, intent context) at sign time, so a
  // re-quote of the same note under a new price/min_out automatically uses a fresh nonce (no reuse).
  function buildIntent({ direction, amountIn, priceNum, priceDen, minOut, rInSecp, rOutSecp, inNote, outOwner, deadline, fee = 0n, assetA, assetB }) {
    const feeBig = BigInt(fee);
    if (!(feeBig < BigInt(amountIn))) throw new Error('swap: fee >= input');
    const swapIn = BigInt(amountIn) - feeBig;    // only amountIn − fee swaps; `fee` is the relay fee in the input asset
    const { amountOut, rem } = clearOut(direction, swapIn, priceNum, priceDen);
    const inC = commitXY(amountIn, rInSecp);     // C_in commits to the GROSS amountIn (its opening binds that)
    const outC = commitXY(amountOut, rOutSecp);  // C_out = amount_out·H + r_out·G
    // Optimistic-flow keys (for the pending-swap overlay/reconcile): `inNullifier` is the spent note's ν
    // (note-bound, needs no asset) and shows up in the indexer's `spent` set at settle; `outLeaf` is the
    // expected output note's leaf and shows up in `LeavesInserted`. outLeaf needs the OUTPUT asset, which
    // depends on direction — computed here when the pair is supplied, else filled in by verifyBatch (which
    // always has the pair). Both equal exactly what the guest emits, so reconcile keys line up.
    const inNullifier = nullifier(inC.cx, inC.cy);
    const outAsset = (assetA && assetB) ? (direction === 'A->B' ? assetB : assetA) : null;
    const outLeaf = outAsset ? leaf(outAsset, outC.cx, outC.cy, outOwner) : null;
    return {
      direction, dirByte: direction === 'A->B' ? 0 : 1,
      in: { cx: inC.cx, cy: inC.cy, owner: inNote.owner, leafIndex: inNote.leafIndex, path: inNote.path },
      amountIn: BigInt(amountIn), fee: feeBig, swapIn, amountOut, rem,
      minOut: BigInt(minOut ?? 0), deadline: BigInt(deadline ?? 0),
      out: { cx: outC.cx, cy: outC.cy, owner: outOwner },
      inNullifier, outLeaf,
      _r: { rIn: BigInt(rInSecp), rOut: BigInt(rOutSecp) },
    };
  }

  // Net the intents into the pre→post reserve move, and generate each intent's opening sigmas (the
  // blindings never leave this function). `chainBinding` is the batch's chain binding (keccak(chainid,pool)).
  function buildBatch({ assetA, assetB, chainBinding, feeBps, reserveAPre, reserveBPre, priceNum, priceDen, intents, spendRoot }) {
    let gAin = 0n, gAout = 0n, gBin = 0n, gBout = 0n;
    for (const it of intents) {
      const ctx = intentCtx(assetA, assetB, chainBinding, it);
      it.inSig = openingSigma(it.amountIn, it._r.rIn, ctx, deriveOpeningNonce(it._r.rIn, ctx, 'swap-in'));
      it.outSig = openingSigma(it.amountOut, it._r.rOut, ctx, deriveOpeningNonce(it._r.rOut, ctx, 'swap-out'));
      if (it.direction === 'A->B') { gAin += it.swapIn; gBout += it.amountOut; }
      else { gBin += it.swapIn; gAout += it.amountOut; }
    }
    const aPre = BigInt(reserveAPre), bPre = BigInt(reserveBPre);
    return {
      assetA, assetB, chainBinding, feeBps: Number(feeBps), poolId: poolId(assetA, assetB, feeBps), spendRoot,
      priceNum: BigInt(priceNum), priceDen: BigInt(priceDen),
      reserveAPre: aPre, reserveBPre: bPre,
      reserveAPost: aPre + gAin - gAout, reserveBPost: bPre + gBin - gBout,
      intents,
    };
  }

  // JS mirror of EVERY OP_SWAP guest assertion. Returns { settlement, nullifiers, leaves } or throws.
  function verifyBatch(batch, { merkleRootFrom }) {
    const fail = (m) => { throw new Error('swap: ' + m); };
    if (!(batch.priceNum > 0n && batch.priceDen > 0n)) fail('zero price');
    if (batch.spendRoot === ZERO32 || !batch.spendRoot) fail('membership requires a non-zero spend root');

    let gAin = 0n, gAout = 0n, gBin = 0n, gBout = 0n;
    const nullifiers = [], leaves = [], fees = [];
    for (const it of batch.intents) {
      const inAsset = it.direction === 'A->B' ? batch.assetA : batch.assetB;
      const outAsset = it.direction === 'A->B' ? batch.assetB : batch.assetA;

      const lf = leaf(inAsset, it.in.cx, it.in.cy, it.in.owner);
      if (merkleRootFrom(lf, it.in.leafIndex, it.in.path) !== batch.spendRoot) fail('membership');

      // opening sigma: prove knowledge of the blinding for the stated amount, bound to the intent —
      // verified without the raw blinding (so the box can't spend the input or redirect the output).
      const ctx = intentCtx(batch.assetA, batch.assetB, batch.chainBinding, it);
      if (!verifyOpeningSigma(it.in.cx, it.in.cy, it.amountIn, it.inSig.R, it.inSig.z, ctx)) fail('input opening');
      if (!verifyOpeningSigma(it.out.cx, it.out.cy, it.amountOut, it.outSig.R, it.outSig.z, ctx)) fail('output opening');

      const fee = BigInt(it.fee ?? 0n);
      if (!(fee < it.amountIn)) fail('fee >= input');
      const swapIn = it.amountIn - fee;
      const { amountOut, rem } = clearOut(it.direction, swapIn, batch.priceNum, batch.priceDen);
      if (amountOut !== it.amountOut || rem !== it.rem) fail('clearing');
      if (it.amountOut < it.minOut) fail('min_out');

      if (it.direction === 'A->B') { gAin += swapIn; gBout += it.amountOut; }
      else { gBin += swapIn; gAout += it.amountOut; }
      if (fee > 0n) fees.push({ assetId: inAsset, value: fee });

      const inNu = nullifier(it.in.cx, it.in.cy);
      const outLf = leaf(outAsset, it.out.cx, it.out.cy, it.out.owner);
      nullifiers.push(inNu);
      leaves.push(outLf);
      it.inNullifier = inNu; // attach the optimistic-flow keys (guaranteed once the batch pair is known)
      it.outLeaf = outLf;
    }

    const aPre = batch.reserveAPre, bPre = batch.reserveBPre;
    if (aPre + gAin < gAout) fail('reserve A underflow');
    if (bPre + gBin < gBout) fail('reserve B underflow');
    const aPost = aPre + gAin - gAout, bPost = bPre + gBin - gBout;
    if (aPost > U64_MAX || bPost > U64_MAX) fail('reserve overflow');
    if (aPost * bPost < aPre * bPre) fail('constant-product decreased');

    // Mirror the guest's FEE enforcement: the declared uniform price must be EXACTLY the deterministic
    // fee-clearing price for the gross flows + reserves + feeBps (k-non-decrease alone is the zero-fee
    // floor). Without this the pool's fee tier wouldn't actually be charged.
    const cp = clearingPriceBperA(solveClearing(gAin, gBin, aPre, bPre, batch.feeBps));
    if (batch.priceNum !== cp.priceNum || batch.priceDen !== cp.priceDen) fail('declared price is not the fee-clearing price');

    return {
      settlement: { poolId: batch.poolId, reserveAPre: aPre, reserveBPre: bPre, reserveAPost: aPost, reserveBPost: bPost },
      nullifiers, leaves, fees,
    };
  }

  return { poolId, clearOut, clearingPriceBperA, buildIntent, buildBatch, verifyBatch };
}
