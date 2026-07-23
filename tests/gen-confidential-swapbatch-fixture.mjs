#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/swapbatch_op.json — ONE confidential OP_SWAP proof that clears
// N hidden-amount swap intents against a SINGLE pool pre-state into N net reserve moves (the N-intents →
// 1-aggregate-delta path). exec-swap.rs ALREADY reads an `intents` array and the guest OP_SWAP arm
// (main.rs:731-1005) loops `for _ in 0..n_intents`, so NO new harness is needed — this fixture just
// populates that loop with more than one intent. Each input note is a REAL member of a shared spendRoot
// tree (the guest verifies membership), and each intent binds amount_in/amount_out to its notes with an
// OPENING SIGMA over the per-intent context `[direction, amount_in, amount_out, min_out, deadline, fee]`
// under tag `tacit-swap-intent-v1` (the box never sees the raw blinding r). The declared uniform price is
// the deterministic fee-clearing price of the AGGREGATE input flow (solveClearing) so the guest's
// per-intent clearing + the k-non-decrease + the fee-tier price-match all pass. Everything is DETERMINISTIC
// (no wall-clock / RNG) so the fixture reproduces across re-proves. Field names + order match exec-swap.rs.
//
// Run: node tests/gen-confidential-swapbatch-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialSwap, solveClearing } from '../dapp/confidential-swap.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const _ptHexK = (P) => (typeof P === 'string' ? P : '0x' + Buffer.from(P.toRawBytes(true)).toString('hex'));
const _scHexK = (v) => (typeof v === 'string' ? v : '0x' + BigInt(v).toString(16).padStart(64, '0'));
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const _ct = makeConfidentialTransfer({ keccak256 });
const swap = makeConfidentialSwap({ keccak256, pool, kernelSign: _ct.kernelSign, rangeProve: _ct.rangeProve });

// Canonical pair (assetA < assetB so reserveA/reserveB line up with the pool's low→high storage).
const ASSET_A = '0x' + 'aa'.repeat(32);
const ASSET_B = '0x' + 'bb'.repeat(32);
const OWNER_IN = '0x' + Buffer.from('swapbatch-trader'.padEnd(32, '\0')).toString('hex');
const OWNER_OUT = '0x' + Buffer.from('swapbatch-output'.padEnd(32, '\0')).toString('hex');
const CHAIN_BINDING = '0x' + '11'.repeat(32);
const FEE_BPS = 30;        // 0.30% pool fee tier — binds the pool id
const PROTO_FEE_BPS = 0;   // no-skim pool (no treasury notes) — keeps the aggregate-delta path clean
const DEADLINE = 2_000_000_000n; // fixed, reproducible; bound in each intent's opening sigma
const RESERVE_A_PRE = 1_000_000n;
const RESERVE_B_PRE = 1_000_000n;

// Two A->B intents and one B->A intent in ONE batch (the guest supports mixed directions: it nets gross
// A-in/A-out and B-in/B-out separately, then moves reserves by the aggregate). Each has its own relay fee
// (0 = self-settle here, kept 0 so amount_in == swapIn and the clearing math stays transparent).
const INTENTS = [
  { direction: 'A->B', amountIn: 4000n },
  { direction: 'A->B', amountIn: 6000n },
  { direction: 'B->A', amountIn: 5000n },
];

// Deterministic blinding scalar from a tag (reproducible across re-proves).
const det = (tag) => (BigInt('0x' + Buffer.from(keccak256(new TextEncoder().encode('cswapbatch-' + tag))).toString('hex')) % secp.CURVE.n) || 1n;

// 1) Solve the deterministic uniform fee-clearing price for the AGGREGATE input flow. The price depends
//    only on the gross INPUT amounts (per asset) + reserves + feeBps — not on the outputs — so we can
//    solve it up front, then derive each intent's amount_out from it.
let gAin = 0n, gBin = 0n;
for (const it of INTENTS) { if (it.direction === 'A->B') gAin += it.amountIn; else gBin += it.amountIn; }
const sol = solveClearing(gAin, gBin, RESERVE_A_PRE, RESERVE_B_PRE, FEE_BPS);
const { priceNum, priceDen } = swap.clearingPriceBperA(sol);

// 2) Build the shared input-note tree: leaf(inAsset, cx, cy, owner) for each intent, then read paths.
const tree = new pool.Tree();
const built = [];
for (let i = 0; i < INTENTS.length; i++) {
  const it = INTENTS[i];
  const inAsset = it.direction === 'A->B' ? ASSET_A : ASSET_B;
  const rIn = det('rin-' + i);
  const rOut = det('rout-' + i);
  const { amountOut } = swap.clearOut(it.direction, it.amountIn, priceNum, priceDen); // fee=0 ⇒ swapIn==amountIn
  const { cx, cy } = pool.commitXY(it.amountIn, rIn);
  const inLeaf = pool.leaf(inAsset, cx, cy, OWNER_IN);
  const leafIndex = tree.insert(inLeaf);
  built.push({ ...it, i, inAsset, rIn, rOut, amountOut, inCx: cx, inCy: cy, leafIndex });
}
const spendRoot = tree.root();

// 3) Assemble each intent through the dapp's own buildIntent/buildBatch (the exact sigma + clearing the
//    guest re-checks), then SELF-VERIFY every membership path + both opening sigmas before writing.
const intents = built.map((b) => {
  const inNote = {
    owner: OWNER_IN,
    leafIndex: b.leafIndex,
    path: tree.rootAndPath(b.leafIndex).path,
  };
  return swap.buildIntent({
    direction: b.direction, amountIn: b.amountIn, priceNum, priceDen,
    minOut: b.amountOut, rInSecp: b.rIn, rOutSecp: b.rOut, inNote,
    outOwner: OWNER_OUT, deadline: DEADLINE, fee: 0n, assetA: ASSET_A, assetB: ASSET_B,
  });
});

const batch = swap.buildBatch({
  assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS,
  reserveAPre: RESERVE_A_PRE, reserveBPre: RESERVE_B_PRE, priceNum, priceDen, intents, spendRoot,
});

// Run the dapp's full JS mirror of every guest assertion (membership, both openings, per-intent clearing,
// min_out, reserve non-underflow/overflow, k-non-decrease, AND the fee-tier price-match). Throws on any
// mismatch — this is the local gate that stands in for the (unavailable) zkVM execute.
const result = swap.verifyBatch(batch, { merkleRootFrom: (lf, idx, path) => pool.merkleRootFrom(lf, idx, path) });

// Belt-and-braces explicit self-checks (independent of verifyBatch) over membership + sigmas.
for (let i = 0; i < built.length; i++) {
  const b = built[i], it = intents[i];
  const path = tree.rootAndPath(b.leafIndex).path;
  const inLeaf = pool.leaf(b.inAsset, b.inCx, b.inCy, OWNER_IN);
  if (!pool.verifyPath(inLeaf, b.leafIndex, path, spendRoot)) throw new Error('membership self-check failed @' + i);
  const ctx = pool.intentContext('tacit-swap-intent-v1', CHAIN_BINDING, ASSET_A, ASSET_B,
    [[it.in.cx, it.in.cy, OWNER_IN], [it.out.cx, it.out.cy, OWNER_OUT]],
    [BigInt(it.dirByte), it.amountIn, it.amountOut, it.minOut, DEADLINE, 0n]);
  if (!pool.verifyOpeningPokBlind(it.in.cx, it.in.cy, it.inPok.R, it.inPok.zV, it.inPok.zR, ctx)) throw new Error('input opening self-check failed @' + i);
  if (!pool.verifyOpeningSigma(it.out.cx, it.out.cy, it.amountOut, it.outSig.R, it.outSig.z, ctx)) throw new Error('output opening self-check failed @' + i);
}

// 4) Emit the fixture in exec-swap.rs's read order / field names. The harness writes ONE OP_SWAP block
//    (numOps=1) whose `intents` array drives the guest's per-intent loop.
const fixture = {
  note: 'OP_SWAP confidential batch: ' + intents.length + ' hidden-amount intents (mixed A<->B) → one aggregate reserve delta, vs one pool pre-state. Fields in exec-swap.rs read order.',
  chainBinding: CHAIN_BINDING,
  spendRoot,
  assetA: ASSET_A,
  assetB: ASSET_B,
  feeBps: FEE_BPS,
  protocolFeeBps: PROTO_FEE_BPS,
  reserveAPre: Number(RESERVE_A_PRE),
  reserveBPre: Number(RESERVE_B_PRE),
  priceNum: Number(priceNum),
  priceDen: Number(priceDen),
  intents: intents.map((it) => ({
    direction: it.dirByte,
    inCx: it.in.cx, inCy: it.in.cy, inOwner: OWNER_IN,
    inLeafIndex: it.in.leafIndex, inPath: it.in.path,
    amountIn: Number(it.amountIn),
    fee: Number(it.fee),
    amountOut: Number(it.amountOut),
    rem: Number(it.rem),
    inPokR: it.inPok.R, inPokZv: it.inPok.zV, inPokZr: it.inPok.zR,
    minOut: Number(it.minOut),
    deadline: Number(DEADLINE),
    outCx: it.out.cx, outCy: it.out.cy, outOwner: OWNER_OUT,
    outSigR: it.outSig.R, outSigZ: it.outSig.z,
    changeKernelR: _ptHexK(it.changeKernel.R), changeKernelZ: _scHexK(it.changeKernel.z),
  })),
  expected: {
    poolId: result.settlement.poolId,
    reserveAPost: Number(result.settlement.reserveAPost),
    reserveBPost: Number(result.settlement.reserveBPost),
    nullifiers: result.nullifiers,
    leaves: result.leaves,
  },
};

const out = 'contracts/sp1/confidential/fixtures/swapbatch_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out);
console.log(' ', intents.length, 'intents, price', priceNum + '/' + priceDen, '(B per A)');
console.log('  reserves', RESERVE_A_PRE + '/' + RESERVE_B_PRE, '→', result.settlement.reserveAPost + '/' + result.settlement.reserveBPost);
console.log('  poolId', result.settlement.poolId);
console.log('  all membership paths + opening sigmas + k-non-decrease + fee-clearing price self-verified');
