#!/usr/bin/env node
// Confidential OP_SWAP driven by the CANONICAL AMM clearing solve (tests/amm-clearing.mjs, which
// mirrors AMM.md §4 byte-for-byte). Instead of hand-picking a price, this derives the uniform
// batch price from the pool reserves + the intents exactly as the Bitcoin AMM does, normalizes it
// to the guest's B-per-A orientation, and confirms the resulting confidential batch satisfies
// every OP_SWAP guest assertion — crucially the constant-product non-decrease, which is what
// validates the price orientation (a flipped price would drain the pool and fail k_post ≥ k_pre).
//
// Run: node tests/confidential-swap-clearing.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialSwap, clearingPriceBperA } from '../dapp/confidential-swap.js';
import { solveClearing } from './amm-clearing.mjs';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const swap = makeConfidentialSwap({ keccak256, pool });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const ASSET_A = '0x' + 'aa'.repeat(32);
const ASSET_B = '0x' + 'bb'.repeat(32);
const OWNER = '0x' + '00'.repeat(31) + '01';
const OWNER_OUT = '0x' + '00'.repeat(31) + '02';
const CHAIN_BINDING = '0x' + '11'.repeat(32); // keccak(chainid,pool) — binds the opening-sigma intent context
const ZEROS = pool.zeros;

// Derive the uniform price from the pool + intents via solveClearing, then build + verify the
// confidential batch at that price. reserveA/B are the pool's public reserves; feeBps the fee.
function clearAndVerify({ reserveA, reserveB, feeBps, specs }) {
  let X = 0n, Y = 0n; // gross A-side input, gross B-side input
  for (const s of specs) { if (s.direction === 'A->B') X += BigInt(s.amountIn); else Y += BigInt(s.amountIn); }
  const sol = solveClearing(X, Y, reserveA, reserveB, feeBps);
  const { priceNum, priceDen } = clearingPriceBperA(sol);

  const intents = specs.map((s) => swap.buildIntent({
    direction: s.direction, amountIn: s.amountIn, priceNum, priceDen, minOut: 0,
    rInSecp: randomScalar(), rOutSecp: randomScalar(),
    nonceIn: randomScalar(), nonceOut: randomScalar(), // opening-sigma nonces (fresh per intent; reuse leaks the blinding)
    inNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, outOwner: OWNER_OUT,
  }));
  const tree = new pool.Tree();
  const idxs = intents.map((it) => {
    const inAsset = it.direction === 'A->B' ? ASSET_A : ASSET_B;
    return tree.insert(pool.leaf(inAsset, it.in.cx, it.in.cy, it.in.owner));
  });
  intents.forEach((it, i) => { const { path } = tree.rootAndPath(idxs[i]); it.in.leafIndex = idxs[i]; it.in.path = path; });
  const spendRoot = tree.rootAndPath(0).root;
  const batch = swap.buildBatch({ assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps, reserveAPre: reserveA, reserveBPre: reserveB, priceNum, priceDen, intents, spendRoot });
  const res = swap.verifyBatch(batch, { merkleRootFrom: pool.merkleRootFrom });
  return { sol, priceNum, priceDen, batch, ...res };
}

// ───────────────── 1. one-sided A→B batch at the curve-clearing price ─────────────────
{
  const { sol, priceNum, priceDen, batch, settlement } = clearAndVerify({
    reserveA: 1_000_000, reserveB: 1_000_000, feeBps: 30,
    specs: [{ direction: 'A->B', amountIn: 10_000 }, { direction: 'A->B', amountIn: 5_000 }],
  });
  assert.strictEqual(sol.direction, 'A→B', 'solve: A-dominant');
  // k must not decrease at the solved price (the orientation is correct)
  assert.ok(settlement.reserveAPost * settlement.reserveBPost >= 1_000_000n * 1_000_000n, 'k non-decrease');
  assert.ok(settlement.reserveAPost > 1_000_000n && settlement.reserveBPost < 1_000_000n, 'A in, B out');
  ok(`A→B batch cleared at ${priceNum}/${priceDen} (B per A); reserves ${settlement.reserveAPre}/${settlement.reserveBPre} → ${settlement.reserveAPost}/${settlement.reserveBPost}, k↑`);
}

// ───────────────── 2. B→A-dominant batch: the price orientation must flip ─────────────────
{
  const { sol, settlement } = clearAndVerify({
    reserveA: 1_000_000, reserveB: 1_000_000, feeBps: 30,
    specs: [{ direction: 'B->A', amountIn: 20_000 }],
  });
  assert.strictEqual(sol.direction, 'B→A', 'solve: B-dominant');
  assert.ok(settlement.reserveBPost * settlement.reserveAPost >= 1_000_000n * 1_000_000n, 'k non-decrease (flipped price)');
  assert.ok(settlement.reserveBPost > 1_000_000n && settlement.reserveAPost < 1_000_000n, 'B in, A out');
  ok('B→A batch: solveClearing returns A-per-B, clearingPriceBperA flips it; k holds (orientation correct)');
}

// ───────────────── 3. mixed two-sided batch nets through one uniform price ─────────────────
{
  const { settlement } = clearAndVerify({
    reserveA: 2_000_000, reserveB: 1_000_000, feeBps: 30,
    specs: [
      { direction: 'A->B', amountIn: 30_000 },
      { direction: 'A->B', amountIn: 10_000 },
      { direction: 'B->A', amountIn: 8_000 },
    ],
  });
  assert.ok(settlement.reserveAPost * settlement.reserveBPost >= 2_000_000n * 1_000_000n, 'k non-decrease (mixed)');
  ok('mixed A→B + B→A batch clears at one uniform price; k holds, reserves move net of the cross');
}

console.log(`\n${n} clearing-driven OP_SWAP checks passed.`);
