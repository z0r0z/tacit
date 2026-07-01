// Confidential multihop route (OP_SWAP_ROUTE) witness assembler for the EVM confidential AMM.
//
// Routes one input note through up to MAX_ROUTE_HOPS constant-product pools to one output note. The
// intermediate amounts flow as VALUES (only the route's start input + final output are notes), so the
// path stays private and atomic in one proof. Each hop is a constant-product exact-in swap
// (getAmountOut, fee-charged) and stages a SwapSettlement the settle swap-loop applies — so the route
// reuses the existing on-chain machinery (no new contract surface). The trader is protected by the
// final minOut, the LPs by each hop's constant-product non-decrease. Mirrors the guest's OP_SWAP_ROUTE
// in contracts/sp1/confidential/src/main.rs exactly; `pool` is a makeConfidentialPool instance.

const ZERO32 = '0x' + '00'.repeat(32);
const MAX_ROUTE_HOPS = 4;

export function makeConfidentialRoute({ keccak256, pool }) {
  const { leaf, nullifier, commitXY, openingSigma, verifyOpeningSigma, deriveOpeningNonce, intentContext } = pool;
  const enc = new TextEncoder();
  const hexToBytes = (h) => { h = (h || '').replace(/^0x/, ''); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
  const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };
  const be32 = (n) => { const o = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
  const bigOf = (h) => BigInt('0x' + h.replace(/^0x/, ''));
  // poolId binds the CANONICAL pair + fee tier (matches the guest pool_id + the contract).
  const poolId = (a, b, feeBps) => {
    const [lo, hi] = bigOf(a) <= bigOf(b) ? [a, b] : [b, a];
    return bytesToHex(keccak256(concat([hexToBytes(lo), hexToBytes(hi), be32(feeBps)])));
  };
  // Constant-product exact-in hop output: floor(R_out·in·(10000−fee) / (R_in·10000 + in·(10000−fee))).
  const getAmountOut = (amountIn, rIn, rOut, feeBps) => {
    const gamma = BigInt(10000 - Number(feeBps));
    const ainG = BigInt(amountIn) * gamma;
    return (BigInt(rOut) * ainG) / (BigInt(rIn) * 10000n + ainG);
  };

  const routeCtx = (op) => intentContext('tacit-route-intent-v1', op.chainBinding, op.asset0, op.assetFinal,
    [[op.in.cx, op.in.cy, op.in.owner], [op.out.cx, op.out.cy, op.out.owner]],
    [op.amountIn, op.amountOut, op.minOut, BigInt(op.hops.length), op.deadline ?? 0n, op.fee ?? 0n]);

  // Walk the hops: compute each pool's exact-in output, thread it into the next hop, and stage a
  // SwapSettlement per hop (canonical reserveA/B orientation). Returns {amountOut, assetFinal, swaps}.
  function walk(asset0, amountIn, hops) {
    let curAsset = asset0, curAmount = BigInt(amountIn);
    const swaps = [];
    for (const h of hops) {
      if (curAsset === h.assetNext) throw new Error('route: hop maps an asset to itself');
      const pid = poolId(curAsset, h.assetNext, h.feeBps);
      const curIsLo = bigOf(curAsset) <= bigOf(h.assetNext); // flow is low→high ⇒ in=reserveA, out=reserveB
      const rIn = curIsLo ? BigInt(h.reserveAPre) : BigInt(h.reserveBPre);
      const rOut = curIsLo ? BigInt(h.reserveBPre) : BigInt(h.reserveAPre);
      if (!(rIn > 0n && rOut > 0n)) throw new Error('route: hop pool not initialized');
      const out = getAmountOut(curAmount, rIn, rOut, h.feeBps);
      if (!(out > 0n)) throw new Error('route: hop output rounds to zero');
      const rInPost = rIn + curAmount, rOutPost = rOut - out;
      if (!(rInPost * rOutPost >= rIn * rOut)) throw new Error('route: constant-product decreased');
      const [aPost, bPost] = curIsLo ? [rInPost, rOutPost] : [rOutPost, rInPost];
      swaps.push({ poolId: pid, reserveAPre: BigInt(h.reserveAPre), reserveBPre: BigInt(h.reserveBPre), reserveAPost: aPost, reserveBPost: bPost });
      curAsset = h.assetNext; curAmount = out;
    }
    return { amountOut: curAmount, assetFinal: curAsset, swaps };
  }

  // hops: [{ assetNext, feeBps, reserveAPre, reserveBPre }] in route order. rIn/rOut are the input/output
  // note blindings (stay CLIENT-SIDE; only the opening sigmas reach the witness).
  function buildRoute({ asset0, chainBinding, inNote, amountIn, rIn, hops, minOut, outOwner, rOut, deadline, fee = 0n }) {
    if (!(hops.length >= 1 && hops.length <= MAX_ROUTE_HOPS)) throw new Error('route: hop count out of range');
    const feeBig = BigInt(fee);
    if (!(feeBig < BigInt(amountIn))) throw new Error('route: fee >= input (note too small for a gasless route — self-settle)');
    // Only amountIn − fee routes; the relay is paid `fee` in the input asset (asset0) as a public
    // FeePayment. The input note still commits to the gross amountIn (its opening binds that).
    const { amountOut, assetFinal } = walk(asset0, BigInt(amountIn) - feeBig, hops);
    const inC = commitXY(amountIn, rIn), outC = commitXY(amountOut, rOut);
    const op = {
      asset0, assetFinal, chainBinding, deadline: BigInt(deadline ?? 0), fee: feeBig,
      in: { cx: inC.cx, cy: inC.cy, owner: inNote.owner, leafIndex: inNote.leafIndex, path: inNote.path },
      amountIn: BigInt(amountIn), amountOut, minOut: BigInt(minOut),
      out: { cx: outC.cx, cy: outC.cy, owner: outOwner },
      hops: hops.map(h => ({ assetNext: h.assetNext, feeBps: Number(h.feeBps), reserveAPre: BigInt(h.reserveAPre), reserveBPre: BigInt(h.reserveBPre) })),
    };
    const ctx = routeCtx(op);
    op.inSig = openingSigma(op.amountIn, rIn, ctx, deriveOpeningNonce(rIn, ctx, 'route-in'));
    op.outSig = openingSigma(op.amountOut, rOut, ctx, deriveOpeningNonce(rOut, ctx, 'route-out'));
    return op;
  }

  function verifyRoute(op, { merkleRootFrom, spendRoot }) {
    const fail = (m) => { throw new Error('route: ' + m); };
    if (spendRoot === ZERO32 || !spendRoot) fail('membership requires a non-zero spend root');
    if (!(op.hops.length >= 1 && op.hops.length <= MAX_ROUTE_HOPS)) fail('hop count out of range');
    if (merkleRootFrom(leaf(op.asset0, op.in.cx, op.in.cy, op.in.owner), op.in.leafIndex, op.in.path) !== spendRoot) fail('membership');
    const fee = BigInt(op.fee ?? 0n);
    if (!(fee < op.amountIn)) fail('fee >= input');
    const { amountOut, assetFinal, swaps } = walk(op.asset0, op.amountIn - fee, op.hops);
    if (assetFinal !== op.assetFinal) fail('asset_final mismatch');
    if (amountOut !== op.amountOut) fail('amount_out mismatch');
    if (!(op.amountOut >= op.minOut)) fail('min_out');
    const ctx = routeCtx(op);
    if (!verifyOpeningSigma(op.in.cx, op.in.cy, op.amountIn, op.inSig.R, op.inSig.z, ctx)) fail('input opening');
    if (!verifyOpeningSigma(op.out.cx, op.out.cy, op.amountOut, op.outSig.R, op.outSig.z, ctx)) fail('output opening');
    return {
      swaps,
      nullifiers: [nullifier(op.in.cx, op.in.cy)],
      leaves: [leaf(assetFinal, op.out.cx, op.out.cy, op.out.owner)],
      fees: fee > 0n ? [{ assetId: op.asset0, value: fee }] : [],
    };
  }

  // Relay-fee quote for a gasless route — mirrors confidential-pool-ux.js quoteUnwrapFee (30 bps + an
  // optional per-asset floor covering the settle gas). The fee is carved from the INPUT asset; net =
  // amountIn − fee is what actually routes. net ≤ 0 ⇒ the note is too small to relay (self-settle, fee = 0).
  const ROUTE_FEE_BPS = 30n;
  function quoteRouteFee(amountIn, { feeBps = ROUTE_FEE_BPS, minFee = 0n } = {}) {
    const v = BigInt(amountIn);
    const floor = BigInt(minFee);
    const pct = (v * BigInt(feeBps) + 9999n) / 10000n; // ceil
    const fee = pct > floor ? pct : floor;
    return { fee, net: v - fee, value: v };
  }

  return { poolId, getAmountOut, buildRoute, verifyRoute, quoteRouteFee, MAX_ROUTE_HOPS };
}
