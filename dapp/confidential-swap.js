// Confidential AMM batch (OP_SWAP) witness assembler for the EVM confidential pool.
//
// A swap intent spends a secp pool note and clears it, at one uniform batch price, into a fresh
// secp note in the other asset. The guest computes the clearing so it sees the amounts (it is the
// prover); it binds each amount to its note with a DIRECT secp Pedersen opening (C = amount·H +
// r·G — the same accelerated primitive wrap/unwrap use), not a cross-curve sigma. A passing Node
// round-trip here locks the witness the guest re-verifies: the guest is a mechanical
// re-implementation of verify_pedersen_opening + the clearing/invariant.
//
// (The secp↔BJJ sigma binding is only needed when the amounts must be hidden from the PROVER —
// the homomorphic batch-aggregation follow-up — so it is intentionally absent from the base op.)
//
// Price is `priceNum/priceDen` = units of B per A (ONE uniform price for the whole batch):
//   A→B: amount_out_B = floor(amount_in_A · priceNum/priceDen)
//   B→A: amount_out_A = floor(amount_in_B · priceDen/priceNum)   (the same price, inverted)
// LPs are protected by the constant-product non-decrease (k_post ≥ k_pre); each trader by min_out.
//
// keccak injected for Node+browser parity; `pool` is a makeConfidentialPool instance whose
// commitXY/leaf/nullifier/merkle primitives the contract + guest already agree on.

const U64_MAX = (1n << 64n) - 1n;
const ZERO32 = '0x' + '00'.repeat(32);
const bmod = (a, m) => ((a % m) + m) % m;

// Normalize an AMM clearing-solve result (solveClearing, AMM.md §4) to the guest's price
// orientation: priceNum/priceDen = units of B per A. solveClearing returns P_clear_num/P_clear_den
// = X / (Y + Δb_net) for every case (A→B-dominant, the swapped B→A wrapper, and spot) — i.e. total
// A-input over total B-output, which is A per B. So B per A is the reciprocal, uniformly. The
// per-intent floor clearing only ever rounds toward the pool, so feeding this price keeps the
// constant product non-decreasing (k_post ≥ k_pre).
export function clearingPriceBperA(sol) {
  return { priceNum: BigInt(sol.P_clear_den), priceDen: BigInt(sol.P_clear_num) };
}

export function makeConfidentialSwap({ keccak256, pool }) {
  const { leaf, nullifier, commitXY } = pool;
  const hexToBytes = (h) => { h = (h || '').replace(/^0x/, ''); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
  const bytesToHex = (b) => '0x' + Buffer.from(b).toString('hex');
  const be32 = (n) => '0x' + bmod(BigInt(n), 1n << 256n).toString(16).padStart(64, '0');
  const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };

  // poolId = keccak256(abi.encode(assetA, assetB)) — two bytes32 ⇒ their 64-byte concat.
  const poolId = (a, b) => bytesToHex(keccak256(concat([hexToBytes(a), hexToBytes(b)])));

  // floor clearing for one intent under the uniform price (B per A), with the remainder.
  function clearOut(direction, amountIn, priceNum, priceDen) {
    amountIn = BigInt(amountIn);
    const [mulN, divN] = direction === 'A->B' ? [BigInt(priceNum), BigInt(priceDen)] : [BigInt(priceDen), BigInt(priceNum)];
    const prod = amountIn * mulN;
    const amountOut = prod / divN;
    return { amountOut, rem: prod - amountOut * divN };
  }

  // Build one intent's full witness. inNote = { owner, leafIndex, path } (the spent pool note's
  // membership); outOwner = the fresh output note's owner. The note commitments are derived from
  // the amounts + the supplied secp blindings, so the opening the guest checks holds by construction.
  function buildIntent({ direction, amountIn, priceNum, priceDen, minOut, rInSecp, rOutSecp, inNote, outOwner }) {
    const { amountOut, rem } = clearOut(direction, amountIn, priceNum, priceDen);
    const inC = commitXY(amountIn, rInSecp);     // C_in = amount_in·H + r_in·G
    const outC = commitXY(amountOut, rOutSecp);  // C_out = amount_out·H + r_out·G
    return {
      direction, dirByte: direction === 'A->B' ? 0 : 1,
      in: { cx: inC.cx, cy: inC.cy, owner: inNote.owner, leafIndex: inNote.leafIndex, path: inNote.path },
      amountIn: BigInt(amountIn), amountOut, rem, rInSecp: be32(rInSecp),
      minOut: BigInt(minOut ?? 0),
      out: { cx: outC.cx, cy: outC.cy, owner: outOwner }, rOutSecp: be32(rOutSecp),
    };
  }

  // Net the intents into the pre→post reserve move (no settle-time state needed here).
  function buildBatch({ assetA, assetB, reserveAPre, reserveBPre, priceNum, priceDen, intents, spendRoot }) {
    let gAin = 0n, gAout = 0n, gBin = 0n, gBout = 0n;
    for (const it of intents) {
      if (it.direction === 'A->B') { gAin += it.amountIn; gBout += it.amountOut; }
      else { gBin += it.amountIn; gAout += it.amountOut; }
    }
    const aPre = BigInt(reserveAPre), bPre = BigInt(reserveBPre);
    return {
      assetA, assetB, poolId: poolId(assetA, assetB), spendRoot,
      priceNum: BigInt(priceNum), priceDen: BigInt(priceDen),
      reserveAPre: aPre, reserveBPre: bPre,
      reserveAPost: aPre + gAin - gAout, reserveBPost: bPre + gBin - gBout,
      intents,
    };
  }

  // JS mirror of EVERY OP_SWAP guest assertion. Returns { settlement, nullifiers, leaves } or
  // throws the same condition the guest would reject on. `merkleRootFrom` = pool.merkleRootFrom.
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

      // secp Pedersen opening: the note's commitment must equal amount·H + r·G.
      const inC = commitXY(it.amountIn, BigInt(it.rInSecp));
      if (inC.cx !== it.in.cx || inC.cy !== it.in.cy) fail('input opening');
      const outC = commitXY(it.amountOut, BigInt(it.rOutSecp));
      if (outC.cx !== it.out.cx || outC.cy !== it.out.cy) fail('output opening');

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
