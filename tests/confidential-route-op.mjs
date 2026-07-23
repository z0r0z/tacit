#!/usr/bin/env node
// OP_SWAP_ROUTE — Node round-trip that locks the witness the SP1 guest re-verifies. Builds confidential
// multihop routes (one input note → N constant-product hops → one output note) and runs verifyRoute,
// which mirrors EVERY guest assertion in contracts/sp1/confidential/src/main.rs OP_SWAP_ROUTE: input
// membership, the secp openings, per-hop getAmountOut + canonical orientation + constant-product
// non-decrease, the final min_out, and one SwapSettlement per hop. A batch that passes here is one the
// guest accepts; a tamper that fails here it rejects.
//
// Run: node tests/confidential-route-op.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialRoute } from '../dapp/confidential-route.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const _ct = makeConfidentialTransfer({ keccak256: keccak256 });
const route = makeConfidentialRoute({ keccak256, pool , kernelSign: _ct.kernelSign, rangeProve: _ct.rangeProve });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const A = '0x' + 'aa'.repeat(32);
const B = '0x' + 'bb'.repeat(32);
const C = '0x' + 'cc'.repeat(32); // A < B < C
const OWNER = '0x' + '00'.repeat(31) + '01';
const OUT_OWNER = '0x' + '00'.repeat(31) + '02';
const CHAIN_BINDING = '0x' + '11'.repeat(32);
const ZEROS = pool.zeros;
const FEE = 30; // 0.3%

// ───────────────── 1. getAmountOut matches the Rust vector (formula parity) ─────────────────
{
  assert.strictEqual(route.getAmountOut(1000, 1_000_000, 1_000_000, 0), 999n, 'no-fee slippage');
  assert.strictEqual(route.getAmountOut(1000, 1_000_000, 1_000_000, 30), 996n, '0.3% fee → strictly less');
  ok('getAmountOut matches the cxfer-core Rust vectors (999 no-fee, 996 @ 0.3%)');
}

// ───────────────── 2. a 2-hop route A→B→C settles both pools + mints the output note ─────────────────
{
  const amountIn = 10_000;
  // hop1 (A,B): A is the low asset → input is reserveA; hop2 (B,C): B is low → input is reserveA
  const hops = [
    { assetNext: B, feeBps: FEE, reserveAPre: 1_000_000, reserveBPre: 1_000_000 },
    { assetNext: C, feeBps: FEE, reserveAPre: 1_000_000, reserveBPre: 1_000_000 },
  ];
  const rIn = randomScalar(), rOut = randomScalar();
  const op = route.buildRoute({ asset0: A, chainBinding: CHAIN_BINDING, inNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, amountIn, rIn, hops, minOut: 9000, outOwner: OUT_OWNER, rOut });

  // independent expectation: chain getAmountOut by hand
  const h1 = route.getAmountOut(amountIn, 1_000_000, 1_000_000, FEE);
  const h2 = route.getAmountOut(h1, 1_000_000, 1_000_000, FEE);
  assert.strictEqual(op.amountOut, h2, 'amountOut = chained getAmountOut');
  assert.strictEqual(op.assetFinal, C, 'route ends at asset C');

  const tree = new pool.Tree();
  const ii = tree.insert(pool.leaf(A, op.in.cx, op.in.cy, op.in.owner));
  op.in.leafIndex = ii; op.in.path = tree.rootAndPath(ii).path;
  const spendRoot = tree.rootAndPath(0).root;

  const { swaps, nullifiers, leaves } = route.verifyRoute(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });
  assert.strictEqual(swaps.length, 2, 'one SwapSettlement per hop');
  assert.strictEqual(swaps[0].poolId, route.poolId(A, B, FEE), 'hop 1 = pool (A,B)');
  assert.strictEqual(swaps[1].poolId, route.poolId(B, C, FEE), 'hop 2 = pool (B,C)');
  assert.strictEqual(swaps[0].reserveAPost, 1_000_000n + BigInt(amountIn), 'hop1 reserveA += amountIn (A is low)');
  assert.strictEqual(swaps[0].reserveBPost, 1_000_000n - h1, 'hop1 reserveB -= out');
  assert.strictEqual(swaps[1].reserveAPost, 1_000_000n + h1, 'hop2 reserveA += intermediate (B is low)');
  assert.strictEqual(swaps[1].reserveBPost, 1_000_000n - h2, 'hop2 reserveB -= final out');
  assert.strictEqual(nullifiers.length, 1, 'the single input note is spent');
  assert.strictEqual(leaves.length, 1, 'one output note minted');
  assert.strictEqual(leaves[0], pool.leaf(C, op.out.cx, op.out.cy, OUT_OWNER), 'output leaf = asset C note to the recipient');
  ok(`2-hop A→B→C: ${amountIn} A → ${h1} B → ${h2} C, both pools settled, output note minted`);
}

// ───────────────── 3. a HIGH→LOW hop uses the flipped orientation (reserveB is the input leg) ─────────────────
{
  // route B→A through pool (A,B): cur=B is the HIGH asset, so input is reserveB, output reserveA.
  const amountIn = 10_000;
  const op = route.buildRoute({
    asset0: B, chainBinding: CHAIN_BINDING, inNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, amountIn, rIn: randomScalar(),
    hops: [{ assetNext: A, feeBps: FEE, reserveAPre: 1_000_000, reserveBPre: 1_000_000 }], minOut: 9000, outOwner: OUT_OWNER, rOut: randomScalar(),
  });
  const tree = new pool.Tree();
  const ii = tree.insert(pool.leaf(B, op.in.cx, op.in.cy, op.in.owner));
  op.in.leafIndex = ii; op.in.path = tree.rootAndPath(ii).path;
  const spendRoot = tree.rootAndPath(0).root;
  const { swaps, leaves } = route.verifyRoute(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });
  const expOut = route.getAmountOut(amountIn, 1_000_000, 1_000_000, FEE);
  assert.strictEqual(swaps[0].poolId, route.poolId(A, B, FEE), 'same pool id either direction');
  assert.strictEqual(swaps[0].reserveBPost, 1_000_000n + BigInt(amountIn), 'reserveB += amountIn (B is the high/input leg)');
  assert.strictEqual(swaps[0].reserveAPost, 1_000_000n - expOut, 'reserveA -= out (A is the low/output leg)');
  assert.strictEqual(leaves[0], pool.leaf(A, op.out.cx, op.out.cy, OUT_OWNER), 'output note is asset A');
  ok('high→low hop flips orientation (reserveB is the input leg, reserveA pays out)');
}

// ───────────────── 4. min_out shortfall is rejected ─────────────────
{
  const amountIn = 10_000;
  const hops = [
    { assetNext: B, feeBps: FEE, reserveAPre: 1_000_000, reserveBPre: 1_000_000 },
    { assetNext: C, feeBps: FEE, reserveAPre: 1_000_000, reserveBPre: 1_000_000 },
  ];
  // honest amountOut ≈ 9745; demand 9800 → must fail
  const op = route.buildRoute({ asset0: A, chainBinding: CHAIN_BINDING, inNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, amountIn, rIn: randomScalar(), hops, minOut: 9800, outOwner: OUT_OWNER, rOut: randomScalar() });
  const tree = new pool.Tree();
  const ii = tree.insert(pool.leaf(A, op.in.cx, op.in.cy, op.in.owner));
  op.in.leafIndex = ii; op.in.path = tree.rootAndPath(ii).path;
  const spendRoot = tree.rootAndPath(0).root;
  assert.throws(() => route.verifyRoute(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot }), /min_out/, 'shortfall rejected');
  assert.ok(op.amountOut < 9800n, 'the honest output is below the demanded min_out');
  ok(`min_out shortfall rejected (out ${op.amountOut} < 9800 demanded)`);
}

// ───────────────── 5. too many hops is rejected ─────────────────
{
  const hops = Array.from({ length: route.MAX_ROUTE_HOPS + 1 }, () => ({ assetNext: B, feeBps: FEE, reserveAPre: 1_000_000, reserveBPre: 1_000_000 }));
  assert.throws(() => route.buildRoute({ asset0: A, chainBinding: CHAIN_BINDING, inNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, amountIn: 1000, rIn: randomScalar(), hops, minOut: 0, outOwner: OUT_OWNER, rOut: randomScalar() }), /hop count out of range/, 'over-long route rejected');
  ok(`a route longer than MAX_ROUTE_HOPS (${route.MAX_ROUTE_HOPS}) is rejected`);
}

console.log(`\n${n} OP_SWAP_ROUTE checks passed.`);
