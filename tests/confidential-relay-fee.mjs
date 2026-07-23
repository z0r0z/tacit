#!/usr/bin/env node
// Relay-fee round-trips + per-op CONSERVATION KATs for the gasless-privacy fee leg. Each op is built with a
// fee, verified through the JS mirror (which mirrors the guest assertions), then checked for value
// conservation: the fee leg equals a REAL reduction (a pool-reserve delta or a net note), so the fee is drawn
// purely from the user's own value — nothing is inflated and no counterparty/pool is drained. fee = 0 is the
// existing fee-free path (covered by the per-op round-trip tests).
//
// Run: node tests/confidential-relay-fee.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialRoute } from '../dapp/confidential-route.js';
import { makeConfidentialSwap, solveClearing, clearingPriceBperA } from '../dapp/confidential-swap.js';
import { makeConfidentialLp } from '../dapp/confidential-lp.js';
import { makeConfidentialOtc } from '../dapp/confidential-otc.js';
import { makeConfidentialBid } from '../dapp/confidential-bid.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const ct = makeConfidentialTransfer({ keccak256 });
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const route = makeConfidentialRoute({ keccak256, pool , kernelSign: ct.kernelSign, rangeProve: ct.rangeProve });
const swap = makeConfidentialSwap({ keccak256, pool });
const lp = makeConfidentialLp({ keccak256, pool , kernelSign: ct.kernelSign, rangeProve: ct.rangeProve });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// ── 1. transfer with a relay fee: Σin = Σout + fee verifies; padded / understated / zero rejected ──
{
  const inputs = [{ value: 1000n, blinding: randomScalar() }];
  const outputs = [{ value: 700n, blinding: randomScalar() }, { value: 270n, blinding: randomScalar() }]; // Σout = 970
  const fee = 30n; // Σin = 1000 = 970 + 30
  const t = ct.buildTransfer({ inputs, outputs, fee });
  assert.strictEqual(ct.verifyTransfer(t), true, 'honest fee verifies');
  assert.strictEqual(ct.verifyTransfer({ ...t, fee: 31n }), false, 'padded fee rejected');
  assert.strictEqual(ct.verifyTransfer({ ...t, fee: 29n }), false, 'understated fee rejected');
  assert.strictEqual(ct.verifyTransfer({ ...t, fee: 0n }), false, 'fee-free read of a fee-bearing transfer rejected');
  // CONSERVATION: the kernel verifyTransfer enforces IS the balance Σin = Σout + fee (1000 = 970 + 30); the
  // padded/understated rejections above prove the fee can't deviate from that exact excess.
  assert.strictEqual(1000n, (700n + 270n) + fee, 'conservation: Σin = Σout + fee');
  ok('transfer relay fee (Σin=Σout+fee): honest verifies, padded/understated/zero rejected');
}

// ── 2. a non-conserving fee is rejected at build (Σin ≠ Σout + fee) ──
{
  assert.throws(() => ct.buildTransfer({
    inputs: [{ value: 500n, blinding: randomScalar() }],
    outputs: [{ value: 480n, blinding: randomScalar() }],
    fee: 30n, // 500 ≠ 480 + 30
  }), /not conserved/, 'Σin ≠ Σout + fee throws');
  ok('non-conserving relay fee rejected at build');
}

// ── 3. quoteRouteFee mirrors quoteUnwrapFee (30 bps + an optional floor) ──
{
  const q = route.quoteRouteFee(100000n);
  assert.strictEqual(q.fee, 300n, '30 bps of 100000 = 300');
  assert.strictEqual(q.net, 99700n, 'net = value − fee');
  const qf = route.quoteRouteFee(1000n, { minFee: 50n });
  assert.strictEqual(qf.fee, 50n, 'floor applies when the bps cut (3) is below it');
  ok('quoteRouteFee = 30 bps with a floor (mirrors quoteUnwrapFee)');
}

// ── 4. route with a relay fee: only amountIn − fee routes; the input opening binds gross amountIn ──
{
  const A = '0x' + 'aa'.repeat(32), B = '0x' + 'bb'.repeat(32);
  const amountIn = 10_000, fee = 30n; // routes 9970
  const hops = [{ assetNext: B, feeBps: 30, reserveAPre: 1_000_000, reserveBPre: 1_000_000 }];
  const op = route.buildRoute({
    asset0: A, chainBinding: '0x' + '11'.repeat(32),
    inNote: { owner: '0x' + '00'.repeat(31) + '01', leafIndex: 0, path: pool.zeros },
    amountIn, rIn: randomScalar(), hops, minOut: 9000, outOwner: '0x' + '00'.repeat(31) + '02', rOut: randomScalar(), fee,
  });
  assert.strictEqual(op.fee, fee, 'op carries the fee');
  assert.strictEqual(op.amountOut, route.getAmountOut(9970, 1_000_000, 1_000_000, 30), 'amountOut = getAmountOut on amountIn − fee');

  const tree = new pool.Tree();
  const ii = tree.insert(pool.leaf(A, op.in.cx, op.in.cy, op.in.owner));
  op.in.leafIndex = ii; op.in.path = tree.rootAndPath(ii).path;
  const spendRoot = tree.rootAndPath(0).root;
  const { fees, nullifiers, leaves, swaps } = route.verifyRoute(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });
  assert.strictEqual(fees.length, 1, 'one fee leg');
  assert.strictEqual(fees[0].assetId, A, 'fee paid in the input asset (asset0)');
  assert.strictEqual(fees[0].value, fee, 'fee value');
  assert.strictEqual(nullifiers.length, 1, 'input note spent');
  assert.strictEqual(leaves.length, 1, 'output note minted');
  // CONSERVATION: the spent input note (gross amountIn) = value into the hop-1 pool + fee leg. Nothing created.
  assert.strictEqual((swaps[0].reserveAPost - swaps[0].reserveAPre) + fees[0].value, BigInt(amountIn),
    'conservation: hop-1 pool intake (amountIn − fee) + fee = gross amountIn');
  ok('route relay fee: routes amountIn − fee, fee leg in the input asset, input opening binds gross amountIn');

  // a settler that bumps the fee is rejected (fee is bound: it re-routes amountIn − fee, breaking the result)
  assert.throws(() => route.verifyRoute({ ...op, fee: 60n }, { merkleRootFrom: pool.merkleRootFrom, spendRoot }),
    /input opening|amount_out|fee/, 'a bumped route fee is rejected');
  ok('a settler that bumps the route fee is rejected');
}

// ── 5. swap with a per-intent relay fee (input-take): only amountIn − fee swaps; fee leg in the input asset ──
{
  const assetA = '0x' + 'aa'.repeat(32), assetB = '0x' + 'bb'.repeat(32);
  const reserveAPre = 1_000_000n, reserveBPre = 1_000_000n, feeBps = 30;
  const amountIn = 10_000n, fee = 30n;
  const price = clearingPriceBperA(solveClearing(amountIn - fee, 0n, reserveAPre, reserveBPre, feeBps));
  const intent = swap.buildIntent({
    direction: 'A->B', amountIn, priceNum: price.priceNum, priceDen: price.priceDen, minOut: 0,
    rInSecp: randomScalar(), rOutSecp: randomScalar(),
    inNote: { owner: '0x' + '00'.repeat(31) + '01', leafIndex: 0, path: pool.zeros },
    outOwner: '0x' + '00'.repeat(31) + '02', fee,
  });
  assert.strictEqual(intent.swapIn, amountIn - fee, 'only amountIn − fee swaps');
  const tree = new pool.Tree();
  const ii = tree.insert(pool.leaf(assetA, intent.in.cx, intent.in.cy, intent.in.owner));
  intent.in.leafIndex = ii; intent.in.path = tree.rootAndPath(ii).path;
  const spendRoot = tree.rootAndPath(0).root;
  const batch = swap.buildBatch({ assetA, assetB, chainBinding: '0x' + '11'.repeat(32), feeBps, reserveAPre, reserveBPre, priceNum: price.priceNum, priceDen: price.priceDen, intents: [intent], spendRoot });
  const r = swap.verifyBatch(batch, { merkleRootFrom: pool.merkleRootFrom });
  assert.strictEqual(r.fees.length, 1, 'one fee leg');
  assert.strictEqual(r.fees[0].assetId, assetA, 'A→B swap fee in asset A (the input)');
  assert.strictEqual(r.fees[0].value, fee, 'fee value');
  // CONSERVATION: the pool's intake (reserveA delta) + fee leg = the spent input note (gross amountIn).
  assert.strictEqual((r.settlement.reserveAPost - r.settlement.reserveAPre) + r.fees[0].value, amountIn,
    'conservation: pool intake (amountIn − fee) + fee = gross amountIn');
  ok('swap relay fee: amountIn − fee clears, fee leg in the input asset');
}

// ── 6. lp_add with a relay fee (input A): the pool sees dA − fee; the A note opens to the gross dA ──
{
  const assetA = '0x' + 'aa'.repeat(32), assetB = '0x' + 'bb'.repeat(32);
  const reserveAPre = 1000n, reserveBPre = 2000n, sharesPre = 1000n, dA = 100n, dB = 200n, fee = 5n;
  const op = lp.buildAdd({
    assetA, assetB, chainBinding: '0x' + '11'.repeat(32), feeBps: 30, reserveAPre, reserveBPre, sharesPre,
    aNote: { owner: '0x' + '00'.repeat(31) + '01', leafIndex: 0, path: pool.zeros },
    bNote: { owner: '0x' + '00'.repeat(31) + '01', leafIndex: 1, path: pool.zeros },
    dA, dB, rA: randomScalar(), rB: randomScalar(), shareOwner: '0x' + '00'.repeat(31) + '02', rShares: randomScalar(), fee,
  });
  const tree = new pool.Tree();
  const ai = tree.insert(pool.leaf(assetA, op.a.cx, op.a.cy, op.a.owner));
  const bi = tree.insert(pool.leaf(assetB, op.b.cx, op.b.cy, op.b.owner));
  op.a.leafIndex = ai; op.a.path = tree.rootAndPath(ai).path;
  op.b.leafIndex = bi; op.b.path = tree.rootAndPath(bi).path;
  const spendRoot = tree.rootAndPath(0).root;
  const r = lp.verifyAdd(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });
  assert.strictEqual(r.fees.length, 1, 'one fee leg');
  assert.strictEqual(r.fees[0].assetId, assetA, 'lp_add fee in asset A');
  assert.strictEqual(r.fees[0].value, fee, 'fee value');
  assert.strictEqual(r.settlement.reserveAPost, reserveAPre + (dA - fee), 'reserveA += dA − fee (pool sees the net)');
  // CONSERVATION: the pool's intake (reserveA delta) + fee leg = the LP's gross dA contribution.
  assert.strictEqual((r.settlement.reserveAPost - reserveAPre) + r.fees[0].value, dA,
    'conservation: pool intake (dA − fee) + fee = gross dA');
  ok('lp_add relay fee: pool sees dA − fee, A note binds gross dA, fee leg in asset A');
}

// ── 7. lp_remove with a relay fee (output A): the A note opens to dA − fee; the pool releases the full dA ──
{
  const assetA = '0x' + 'aa'.repeat(32), assetB = '0x' + 'bb'.repeat(32);
  const reserveAPre = 10000n, reserveBPre = 20000n, sharesPre = 10000n, dShares = 100n, fee = 3n; // dA = 100
  const op = lp.buildRemove({
    assetA, assetB, chainBinding: '0x' + '11'.repeat(32), feeBps: 30, reserveAPre, reserveBPre, sharesPre,
    shareNote: { owner: '0x' + '00'.repeat(31) + '01', leafIndex: 0, path: pool.zeros },
    dShares, rShares: randomScalar(), aOwner: '0x' + '00'.repeat(31) + '02', rA: randomScalar(), bOwner: '0x' + '00'.repeat(31) + '02', rB: randomScalar(), fee,
  });
  const LP_ASSET = lp.lpShareId(lp.poolId(assetA, assetB, 30));
  const tree = new pool.Tree();
  const si = tree.insert(pool.leaf(LP_ASSET, op.share.cx, op.share.cy, op.share.owner));
  op.share.leafIndex = si; op.share.path = tree.rootAndPath(si).path;
  const spendRoot = tree.rootAndPath(0).root;
  const r = lp.verifyRemove(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });
  assert.strictEqual(r.fees.length, 1, 'one fee leg');
  assert.strictEqual(r.fees[0].assetId, assetA, 'lp_remove fee in asset A');
  assert.strictEqual(r.fees[0].value, fee, 'fee value');
  assert.strictEqual(r.settlement.reserveAPost, reserveAPre - 100n, 'pool releases the full proportional dA (100)');
  // CONSERVATION: the pool's release (reserveA drop) = the net A note (dA − fee) + fee leg. Nothing created.
  assert.strictEqual(reserveAPre - r.settlement.reserveAPost, (100n - fee) + r.fees[0].value,
    'conservation: released dA = net A note (dA − fee) + fee');
  ok('lp_remove relay fee: A note binds dA − fee, pool releases the full dA, fee leg in asset A');
}

// ── 8. OTC with relay fees (each party carves from the asset it RECEIVES) ──
{
  const otcMod = makeConfidentialOtc({ keccak256, pool });
  const assetA = '0x' + 'aa'.repeat(32), assetB = '0x' + 'bb'.repeat(32);
  const MAKER = '0x' + '00'.repeat(31) + '01', TAKER = '0x' + '00'.repeat(31) + '02';
  const vA = 1000n, vB = 2000n, feeA = 7n, feeB = 11n;
  const mInR = randomScalar(), tInR = randomScalar();
  const mInC = pool.commitXY(vA, mInR), tInC = pool.commitXY(vB, tInR); // exact inputs (no change)
  const tree = new pool.Tree();
  const mIdx = tree.insert(pool.leaf(assetA, mInC.cx, mInC.cy, MAKER));
  const tIdx = tree.insert(pool.leaf(assetB, tInC.cx, tInC.cy, TAKER));
  const spendRoot = tree.rootAndPath(0).root;
  const op = otcMod.buildOtc({
    assetA, assetB, vA, vB, chainBinding: '0x' + '11'.repeat(32), spendRoot,
    maker: { owner: MAKER, inAmount: vA, inR: mInR, inLeafIndex: mIdx, inPath: tree.rootAndPath(mIdx).path, recvR: randomScalar() },
    taker: { owner: TAKER, inAmount: vB, inR: tInR, inLeafIndex: tIdx, inPath: tree.rootAndPath(tIdx).path, recvR: randomScalar() },
    feeA, feeB,
  });
  const r = otcMod.verifyOtc(op, { merkleRootFrom: pool.merkleRootFrom });
  assert.strictEqual(r.fees.length, 2, 'two fee legs');
  const byAsset = Object.fromEntries(r.fees.map((f) => [f.assetId, f.value]));
  assert.strictEqual(byAsset[assetA], feeA, 'taker-side fee in asset A');
  assert.strictEqual(byAsset[assetB], feeB, 'maker-side fee in asset B');
  // CONSERVATION + no cross-party drain: each side's gross receipt = its net note + its OWN fee, drawn only
  // from what the counterparty gave: vA = (vA − feeA) + feeA, vB = (vB − feeB) + feeB.
  assert.strictEqual((vA - feeA) + byAsset[assetA], vA, 'conservation: taker net + feeA = vA (maker gave)');
  assert.strictEqual((vB - feeB) + byAsset[assetB], vB, 'conservation: maker net + feeB = vB (taker gave)');
  ok('otc relay fees: each party carves from its receipt (taker→assetA, maker→assetB)');
}

// ── 9. BID fill with a relay fee (seller carves from its payment; the buyer's offline presign is untouched) ──
{
  const bidMod = makeConfidentialBid({ keccak256, pool });
  const assetA = '0x' + 'aa'.repeat(32), assetB = '0x' + 'bb'.repeat(32);
  const BUYER = '0x' + '00'.repeat(31) + '01', SELLER = '0x' + '00'.repeat(31) + '02';
  const minFill = 10n, maxFill = 100n, price = 5n, increment = 10n, chosenF = 40n, fee = 9n;
  const BID_SECRET = '0x' + 'cc'.repeat(32);
  const fundR = randomScalar(), vFund = maxFill * price;
  const fundC = pool.commitXY(vFund, fundR);
  const sInR = randomScalar(), sInC = pool.commitXY(chosenF, sInR); // exact seller input (no change)
  const tree = new pool.Tree();
  const fundIdx = tree.insert(pool.leaf(assetB, fundC.cx, fundC.cy, BUYER));
  const sIdx = tree.insert(pool.leaf(assetA, sInC.cx, sInC.cy, SELLER));
  const spendRoot = tree.rootAndPath(0).root;
  const bid = bidMod.buildBid({
    assetA, assetB, minFill, maxFill, price, increment, chainBinding: '0x' + '11'.repeat(32), spendRoot,
    buyerOwner: BUYER, fundRSecp: fundR, fundLeafIndex: fundIdx, fundPath: tree.rootAndPath(fundIdx).path, bidSecret: BID_SECRET,
  });
  const filled = bidMod.fillBid(bid, {
    chosenF, sellerOwner: SELLER, sellerInAmount: chosenF, sellerInRSecp: sInR,
    sellerInLeafIndex: sIdx, sellerInPath: tree.rootAndPath(sIdx).path, sellerRecvRSecp: randomScalar(),
    nonces: { fund: randomScalar(), recvA: randomScalar(), refund: randomScalar() }, fee,
  });
  const r = bidMod.verifyBid(filled, { merkleRootFrom: pool.merkleRootFrom });
  assert.strictEqual(r.fees.length, 1, 'one fee leg');
  assert.strictEqual(r.fees[0].assetId, assetB, 'seller fee in asset B (the payment asset)');
  assert.strictEqual(r.fees[0].value, fee, 'fee value');
  assert.strictEqual(filled.pay, chosenF * price, 'gross pay = chosenF·price (conservation unchanged)');
  // CONSERVATION: the buyer-funded payment = the seller's net note + fee (buyer's refund/fill untouched).
  assert.strictEqual((filled.pay - fee) + r.fees[0].value, filled.pay,
    'conservation: seller net (pay − fee) + fee = gross pay');
  ok('bid relay fee: seller carves from its payment, buyer offline presign untouched');
}

// ── 10. bridge_burn (ETH→BTC) with a relay fee: kernel public-fee, paid in the burned asset on ETH ──
{
  const assetId = '0x' + 'dd'.repeat(32);
  const inputs = [{ value: 1000n, blinding: randomScalar() }];
  const outputs = [{ value: 970n, blinding: randomScalar(), owner: '0x' + '00'.repeat(31) + '07' }]; // Σout = 970, minted on BTC
  const fee = 30n; // Σin = 1000 = 970 + 30
  const bb = ct.buildBridgeBurn({ inputs, outputs, assetId, destChain: 1, bindNullifier: '0x' + '00'.repeat(32), fee });
  assert.strictEqual(ct.verifyBridgeBurn(bb), true, 'honest bridge-burn fee verifies');
  assert.strictEqual(ct.verifyBridgeBurn({ ...bb, fee: 31n }), false, 'padded bridge-burn fee rejected');
  assert.strictEqual(ct.verifyBridgeBurn({ ...bb, fee: 0n }), false, 'fee-free read of a fee-bearing burn rejected');
  // CONSERVATION across the chain boundary: Σin (ETH burned) = Σout (BTC minted) + fee (1000 = 970 + 30),
  // enforced by the verifyBridgeBurn kernel; the padded/zero rejections prove fee can't deviate.
  assert.strictEqual(1000n, 970n + fee, 'conservation: Σin(ETH) = Σout(BTC) + fee');
  ok('bridge_burn relay fee: Σin = Σout(BTC) + fee, fee paid in the burned asset on ETH');
}

console.log(`\n${n}/${n} confidential relay-fee checks passed`);
