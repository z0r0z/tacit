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

export function makeConfidentialSwap({ keccak256, pool }) {
  const { leaf, nullifier, commitXY, openingSigma, verifyOpeningSigma, intentContext } = pool;
  const hexToBytes = (h) => { h = (h || '').replace(/^0x/, ''); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
  const bytesToHex = (b) => '0x' + Buffer.from(b).toString('hex');
  const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };

  const poolId = (a, b) => bytesToHex(keccak256(concat([hexToBytes(a), hexToBytes(b)])));

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
    [BigInt(it.dirByte), it.amountIn, it.amountOut, it.minOut],
  );

  // Build one intent. The secp blindings rInSecp/rOutSecp + the sigma nonces stay CLIENT-SIDE — they
  // never enter the witness; only the opening sigmas (R, z) do (generated in buildBatch once the
  // batch context is known). nonceIn/nonceOut must be fresh random scalars (reuse leaks the blinding).
  function buildIntent({ direction, amountIn, priceNum, priceDen, minOut, rInSecp, rOutSecp, nonceIn, nonceOut, inNote, outOwner }) {
    const { amountOut, rem } = clearOut(direction, amountIn, priceNum, priceDen);
    const inC = commitXY(amountIn, rInSecp);     // C_in = amount_in·H + r_in·G
    const outC = commitXY(amountOut, rOutSecp);  // C_out = amount_out·H + r_out·G
    return {
      direction, dirByte: direction === 'A->B' ? 0 : 1,
      in: { cx: inC.cx, cy: inC.cy, owner: inNote.owner, leafIndex: inNote.leafIndex, path: inNote.path },
      amountIn: BigInt(amountIn), amountOut, rem,
      minOut: BigInt(minOut ?? 0),
      out: { cx: outC.cx, cy: outC.cy, owner: outOwner },
      _r: { rIn: BigInt(rInSecp), rOut: BigInt(rOutSecp), nonceIn: BigInt(nonceIn), nonceOut: BigInt(nonceOut) },
    };
  }

  // Net the intents into the pre→post reserve move, and generate each intent's opening sigmas (the
  // blindings never leave this function). `chainBinding` is the batch's chain binding (keccak(chainid,pool)).
  function buildBatch({ assetA, assetB, chainBinding, reserveAPre, reserveBPre, priceNum, priceDen, intents, spendRoot }) {
    let gAin = 0n, gAout = 0n, gBin = 0n, gBout = 0n;
    for (const it of intents) {
      const ctx = intentCtx(assetA, assetB, chainBinding, it);
      it.inSig = openingSigma(it.amountIn, it._r.rIn, ctx, it._r.nonceIn);
      it.outSig = openingSigma(it.amountOut, it._r.rOut, ctx, it._r.nonceOut);
      if (it.direction === 'A->B') { gAin += it.amountIn; gBout += it.amountOut; }
      else { gBin += it.amountIn; gAout += it.amountOut; }
    }
    const aPre = BigInt(reserveAPre), bPre = BigInt(reserveBPre);
    return {
      assetA, assetB, chainBinding, poolId: poolId(assetA, assetB), spendRoot,
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
    const nullifiers = [], leaves = [];
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

      const { amountOut, rem } = clearOut(it.direction, it.amountIn, batch.priceNum, batch.priceDen);
      if (amountOut !== it.amountOut || rem !== it.rem) fail('clearing');
      if (it.amountOut < it.minOut) fail('min_out');

      if (it.direction === 'A->B') { gAin += it.amountIn; gBout += it.amountOut; }
      else { gBin += it.amountIn; gAout += it.amountOut; }

      nullifiers.push(nullifier(it.in.cx, it.in.cy));
      leaves.push(leaf(outAsset, it.out.cx, it.out.cy, it.out.owner));
    }

    const aPre = batch.reserveAPre, bPre = batch.reserveBPre;
    if (aPre + gAin < gAout) fail('reserve A underflow');
    if (bPre + gBin < gBout) fail('reserve B underflow');
    const aPost = aPre + gAin - gAout, bPost = bPre + gBin - gBout;
    if (aPost > U64_MAX || bPost > U64_MAX) fail('reserve overflow');
    if (aPost * bPost < aPre * bPre) fail('constant-product decreased');

    return {
      settlement: { poolId: batch.poolId, reserveAPre: aPre, reserveBPre: bPre, reserveAPost: aPost, reserveBPost: bPost },
      nullifiers, leaves,
    };
  }

  return { poolId, clearOut, clearingPriceBperA, buildIntent, buildBatch, verifyBatch };
}
