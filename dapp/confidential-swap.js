// Confidential AMM batch (OP_SWAP) witness assembler for the EVM confidential pool.
//
// A swap intent spends a secp pool note whose hidden amount is sigma-bound (secp↔BJJ) to a
// BabyJubJub commitment; one uniform batch price clears it to amount_out — a fresh secp note
// inserted as a leaf. The guest (contracts/sp1/confidential, OP_SWAP) re-verifies exactly these
// objects, so a passing Node round-trip here locks the witness the guest will accept: the guest
// port is a mechanical re-implementation of pedersenBJJ + verifyXCurve + the clearing/invariant.
//
// Price is `priceNum/priceDen` = units of B per A (ONE uniform price for the whole batch):
//   A→B: amount_out_B = floor(amount_in_A · priceNum/priceDen)
//   B→A: amount_out_A = floor(amount_in_B · priceDen/priceNum)   (the same price, inverted)
// LPs are protected by the constant-product non-decrease (k_post ≥ k_pre); each trader by min_out.
//
// secp/keccak injected for Node+browser parity; `pool` is a makeConfidentialPool instance whose
// note/leaf/nullifier/merkle primitives the contract + guest already agree on.

import { pedersenBJJ, packPoint, N_BJJ } from './amm-bjj.js';
import { proveXCurveDeterministic, verifyXCurve } from './amm-sigma.js';

const U64_MAX = (1n << 64n) - 1n;
const ZERO32 = '0x' + '00'.repeat(32);
const bmod = (a, m) => ((a % m) + m) % m;

export function makeConfidentialSwap({ secp, keccak256, pool }) {
  const { leaf, nullifier, compressXY } = pool;
  const enc = new TextEncoder();
  const hexToBytes = (h) => { h = (h || '').replace(/^0x/, ''); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
  const bytesToHex = (b) => '0x' + Buffer.from(b).toString('hex');
  const be32 = (n) => '0x' + bmod(BigInt(n), 1n << 256n).toString(16).padStart(64, '0');
  const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };

  // poolId = keccak256(abi.encode(assetA, assetB)) — two bytes32 ⇒ their 64-byte concat.
  const poolId = (a, b) => bytesToHex(keccak256(concat([hexToBytes(a), hexToBytes(b)])));

  // affine (cx,cy) 0x-hex from a 33-byte compressed secp commitment (the sigma-bound note).
  function affineFromCompressed(c33) {
    const a = secp.ProjectivePoint.fromHex(bytesToHex(c33).slice(2)).toAffine();
    return { cx: be32(a.x), cy: be32(a.y) };
  }

  // floor clearing for one intent under the uniform price (B per A), with the remainder.
  function clearOut(direction, amountIn, priceNum, priceDen) {
    amountIn = BigInt(amountIn);
    const [mulN, divN] = direction === 'A->B' ? [BigInt(priceNum), BigInt(priceDen)] : [BigInt(priceDen), BigInt(priceNum)];
    const prod = amountIn * mulN;
    const amountOut = prod / divN;
    return { amountOut, rem: prod - amountOut * divN };
  }

  // Build one intent's full witness. inNote = { owner, leafIndex, path } (the spent pool note's
  // membership); outOwner = the fresh output note's owner. Blindings are caller-supplied so the
  // input note matches the one already in the tree; a deterministic seedKey makes the sigma proofs
  // (and so the fixture) reproducible.
  function buildIntent({ direction, amountIn, priceNum, priceDen, minOut, rInSecp, rInBjj, rOutSecp, rOutBjj, inNote, outOwner, seedKey }) {
    const { amountOut, rem } = clearOut(direction, amountIn, priceNum, priceDen);
    const seed = (tag) => keccak256(concat([enc.encode('tacit-cswap-' + tag), hexToBytes(seedKey || ZERO32)]));
    const sin = proveXCurveDeterministic({ a: BigInt(amountIn), r_secp: BigInt(rInSecp), r_BJJ: BigInt(rInBjj), seedKey: seed('in') });
    const sout = proveXCurveDeterministic({ a: amountOut, r_secp: BigInt(rOutSecp), r_BJJ: BigInt(rOutBjj), seedKey: seed('out') });
    return {
      direction, dirByte: direction === 'A->B' ? 0 : 1,
      in: { ...affineFromCompressed(sin.C_secp_bytes), owner: inNote.owner, leafIndex: inNote.leafIndex, path: inNote.path },
      amountIn: BigInt(amountIn), amountOut, rem,
      cInBjj: bytesToHex(sin.C_BJJ_bytes), rInBjj: be32(bmod(BigInt(rInBjj), N_BJJ)),
      cOutBjj: bytesToHex(sout.C_BJJ_bytes), rOutBjj: be32(bmod(BigInt(rOutBjj), N_BJJ)),
      minOut: BigInt(minOut ?? 0),
      sigmaIn: bytesToHex(sin.proof), sigmaOut: bytesToHex(sout.proof),
      out: { ...affineFromCompressed(sout.C_secp_bytes), owner: outOwner },
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

      const cInSecp = hexToBytes(compressXY(it.in.cx, it.in.cy));
      const cOutSecp = hexToBytes(compressXY(it.out.cx, it.out.cy));
      if (!verifyXCurve(hexToBytes(it.sigmaIn), cInSecp, hexToBytes(it.cInBjj))) fail('input sigma');
      if (!verifyXCurve(hexToBytes(it.sigmaOut), cOutSecp, hexToBytes(it.cOutBjj))) fail('output sigma');

      if (bytesToHex(packPoint(pedersenBJJ(it.amountIn, BigInt(it.rInBjj)))) !== it.cInBjj) fail('input opening');
      if (bytesToHex(packPoint(pedersenBJJ(it.amountOut, BigInt(it.rOutBjj)))) !== it.cOutBjj) fail('output opening');

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

  return { poolId, clearOut, buildIntent, buildBatch, verifyBatch };
}
