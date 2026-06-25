// Off-chain swap-batch intent COORDINATOR — buffers individual confidential swap intents per pool and, when a
// trigger fires (enough intents queued, or a max wait elapsed), solves ONE uniform clearing price for the whole
// batch, assembles a single OP_SWAP via the proven confidential-swap.js assembler (the same one the guest
// mirrors), self-checks it with verifyBatch, and submits it through the relay as ONE settle.
//
// WHY: a solo swap is a batch-of-1 — its public reserve delta == its exact amount (transparent). Batching N
// intents into one OP_SWAP makes the single reserve delta cover all of them, so individual trade sizes are
// hidden among the batch. The on-chain OP_SWAP ALREADY clears N intents at a uniform price (the guest loops
// over `intents`), so this is a PURELY off-chain capability — no contract redeploy, no guest re-prove.
//
// NOT wired into the live path yet (slow-start ships solo/transparent — confidential-swap-tab.js calls
// ux.route directly). Flip to this when intent volume makes batching worthwhile. Everything is injected so it
// is testable and side-effect-free until mounted.
//
// Deps:
//   swap          — makeConfidentialSwap({ keccak256, pool }) (buildIntent / buildBatch / verifyBatch / solve)
//   pool          — makeConfidentialPool(...) (merkleRootFrom for the verifyBatch membership self-check)
//   reservesFor   — async (poolId, { assetA, assetB, feeBps }) => { reserveA, reserveB, feeBps, spendRoot }
//                   in CANONICAL orientation (reserveA = the low asset's reserve).
//   submitBatch   — async ({ type:'swap', op, leaves, outputs, ephRand, poolId, count }) => relay result
//   chainBindingHex — () => the batch chain binding (keccak(chainId, pool))
//   ephRand       — () => a fresh CSPRNG scalar for the memo seal (REQUIRED; privacy-critical, no fallback)
//   now           — () => ms (injectable for tests)
//   minIntents    — flush once this many intents are queued for a pool (default 4)
//   maxWaitMs     — flush a pool this long after its first queued intent (default 6000)
import { clearingPriceBperA, solveClearing } from './confidential-swap.js';

export function makeConfidentialSwapCoordinator({
  swap, pool, reservesFor, submitBatch, chainBindingHex,
  ephRand, now, minIntents = 4, maxWaitMs = 6000, setTimer, clearTimer,
} = {}) {
  if (!swap || !pool || !reservesFor || !submitBatch || !chainBindingHex || !ephRand) {
    throw new Error('swap-coordinator: swap, pool, reservesFor, submitBatch, chainBindingHex, ephRand are required');
  }
  const _now = now || (() => Date.now());
  const _setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms));
  const _clearTimer = clearTimer || ((h) => clearTimeout(h));
  const randScalar = ephRand; // CSPRNG scalar source for the memo seal — caller-supplied (privacy-critical)

  const lo = (h) => String(h || '').toLowerCase();
  // Canonical pair + the trade direction for a (fromAsset → toAsset) leg.
  function canonical(fromAsset, toAsset, feeBps) {
    const a = BigInt(fromAsset) <= BigInt(toAsset) ? fromAsset : toAsset;
    const b = a === fromAsset ? toAsset : fromAsset;
    return { assetA: a, assetB: b, direction: lo(fromAsset) === lo(a) ? 'A->B' : 'B->A', poolId: swap.poolId(a, b, feeBps) };
  }

  // poolKey → { assetA, assetB, feeBps, poolId, items:[{ intent, resolve, reject }], firstAt, timer }
  const buffers = new Map();

  // Queue one trader intent. Resolves with that trader's slice of the batch result once it settles, or rejects
  // if the batch fails / the trader's min_out can't be met. The intent's input blinding stays client-side until
  // assembly (buildBatch turns it into an opening sigma — the raw blinding never enters the witness).
  //   intent: { fromAsset, toAsset, feeBps, amountIn, minOut, fee=0, inNote{cx,cy,owner,leafIndex,path,blinding},
  //             outOwner, rOutSecp, secret, ownerPub }
  function addIntent(intent) {
    const { assetA, assetB, direction, poolId } = canonical(intent.fromAsset, intent.toAsset, intent.feeBps);
    const key = poolId;
    let buf = buffers.get(key);
    if (!buf) { buf = { assetA, assetB, feeBps: intent.feeBps, poolId, items: [], firstAt: _now(), timer: null }; buffers.set(key, buf); }
    return new Promise((resolve, reject) => {
      buf.items.push({ intent: { ...intent, direction }, resolve, reject });
      if (buf.items.length >= minIntents) { void flush(key); return; }
      if (!buf.timer) buf.timer = _setTimer(() => { void flush(key); }, maxWaitMs);
    });
  }

  // Assemble + submit the buffered batch for one pool. Safe to call early (it no-ops on an empty buffer).
  async function flush(poolKey) {
    const buf = buffers.get(poolKey);
    if (!buf || buf.items.length === 0) return null;
    buffers.delete(poolKey);
    if (buf.timer) _clearTimer(buf.timer);
    const { assetA, assetB, feeBps, poolId, items } = buf;
    try {
      const r = await reservesFor(poolId, { assetA, assetB, feeBps });
      if (!r) throw new Error('swap-coordinator: no reserves for pool');
      const reserveA = BigInt(r.reserveA), reserveB = BigInt(r.reserveB), spendRoot = r.spendRoot;

      // Gross flows that actually swap (each leg net of its relay fee) drive the single clearing price.
      let gAin = 0n, gBin = 0n;
      for (const { intent } of items) {
        const swapIn = BigInt(intent.amountIn) - BigInt(intent.fee || 0n);
        if (swapIn <= 0n) throw new Error('swap-coordinator: fee >= input');
        if (intent.direction === 'A->B') gAin += swapIn; else gBin += swapIn;
      }
      const { priceNum, priceDen } = clearingPriceBperA(solveClearing(gAin, gBin, reserveA, reserveB, feeBps));

      const chainBinding = chainBindingHex();
      const built = items.map(({ intent }) => swap.buildIntent({
        direction: intent.direction, amountIn: BigInt(intent.amountIn), priceNum, priceDen, minOut: BigInt(intent.minOut ?? 0),
        rInSecp: BigInt(intent.inNote.blinding), rOutSecp: BigInt(intent.rOutSecp), inNote: intent.inNote,
        outOwner: intent.outOwner, deadline: intent.deadline ?? 0, fee: BigInt(intent.fee || 0n), assetA, assetB,
      }));
      // min_out guard BEFORE we commit the batch — reject the under-filled intents (and abort if any) so the
      // batch never settles a trade below a trader's slippage bound.
      built.forEach((it, i) => { if (it.amountOut < it.minOut) throw new Error(`swap-coordinator: intent ${i} min_out ${it.minOut} > out ${it.amountOut}`); });

      const batch = swap.buildBatch({ assetA, assetB, chainBinding, feeBps, reserveAPre: reserveA, reserveBPre: reserveB, priceNum, priceDen, intents: built, spendRoot });
      // Mirror EVERY guest assertion off-chain before paying for a proof.
      swap.verifyBatch(batch, { merkleRootFrom: pool.merkleRootFrom });

      const op = toOpFixture(batch);
      const outAssetOf = (it) => (it.direction === 'A->B' ? assetB : assetA);
      const leaves = built.map((it) => pool.leaf(outAssetOf(it), it.out.cx, it.out.cy, it.out.owner));
      const outputs = built.map((it, i) => ({
        value: it.amountOut.toString(), blinding: items[i].intent.rOutSecp, secret: items[i].intent.secret,
        asset: outAssetOf(it), owner: it.out.owner, cx: it.out.cx, cy: it.out.cy, ownerPub: items[i].intent.ownerPub,
      }));

      const res = await submitBatch({ type: 'swap', op, leaves, outputs, ephRand: randScalar, poolId, count: built.length });
      built.forEach((it, i) => items[i].resolve({ ...res, amountOut: it.amountOut, outLeaf: leaves[i], poolId, batchSize: built.length }));
      return res;
    } catch (e) {
      for (const it of items) it.reject(e);
      throw e;
    }
  }

  // Map a buildBatch result to the OP_SWAP fixture the box harness consumes (mirror of swap_op.json).
  function toOpFixture(batch) {
    return {
      chainBinding: batch.chainBinding, spendRoot: batch.spendRoot,
      assetA: batch.assetA, assetB: batch.assetB, feeBps: Number(batch.feeBps),
      reserveAPre: Number(batch.reserveAPre), reserveBPre: Number(batch.reserveBPre),
      priceNum: Number(batch.priceNum), priceDen: Number(batch.priceDen),
      intents: batch.intents.map((it) => ({
        direction: it.dirByte,
        inCx: it.in.cx, inCy: it.in.cy, inOwner: it.in.owner, inLeafIndex: Number(it.in.leafIndex), inPath: it.in.path,
        amountIn: Number(it.amountIn), amountOut: Number(it.amountOut), rem: Number(it.rem),
        inSigR: it.inSig.R, inSigZ: it.inSig.z,
        minOut: Number(it.minOut), deadline: Number(it.deadline),
        outCx: it.out.cx, outCy: it.out.cy, outOwner: it.out.owner,
        outSigR: it.outSig.R, outSigZ: it.outSig.z,
      })),
    };
  }

  // Introspection: how many intents are queued per pool (for a coordinator status panel / tests).
  function pending() {
    const o = {};
    for (const [k, b] of buffers) o[k] = b.items.length;
    return o;
  }

  return { addIntent, flush, pending, _canonical: canonical, _toOpFixture: toOpFixture };
}
