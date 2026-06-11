#!/usr/bin/env node
// OP_SWAP (confidential AMM batch) — Node round-trip that locks the witness the SP1 guest
// re-verifies. Builds real swap intents (secp pool notes, with the amounts bound by direct secp
// Pedersen openings) and runs verifyBatch, which mirrors EVERY guest assertion in
// contracts/sp1/confidential/src/main.rs (OP_SWAP): membership, both secp openings, the floor
// clearing, min_out, conservation, reserve non-underflow, and the constant-product non-decrease.
// The opening is verify_pedersen_opening's exact check (C == amount·H + r·G), so a batch that
// passes here is one the guest accepts; a tamper that fails here is one it rejects.
//
// Run: node tests/confidential-swap-op.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialSwap, solveClearing, clearingPriceBperA } from '../dapp/confidential-swap.js';
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
const CHAIN_BINDING = '0x' + '11'.repeat(32);
const FEE_BPS = 30; // 0.3% fee tier (one pool per (canonical pair, fee))
const ZEROS = pool.zeros; // 32 sibling-zeros for a placeholder path

// Build a batch from intent specs at the DETERMINISTIC fee-clearing price (the guest now enforces it,
// so an arbitrary price no longer settles): sum the gross flows, solve the price for FEE_BPS, derive
// each input note, place every input leaf in one tree, patch the paths, and verify. An explicit
// `feeBps` override builds at a DIFFERENT tier's price (to exercise the fee-enforcement rejection).
function assemble({ reserveAPre, reserveBPre, specs, priceFeeBps }) {
  let X = 0n, Y = 0n;
  for (const s of specs) { if (s.direction === 'A->B') X += BigInt(s.amountIn); else Y += BigInt(s.amountIn); }
  const { priceNum, priceDen } = clearingPriceBperA(solveClearing(X, Y, reserveAPre, reserveBPre, priceFeeBps ?? FEE_BPS));
  const intents = specs.map((s) => swap.buildIntent({
    direction: s.direction, amountIn: s.amountIn, priceNum, priceDen, minOut: s.minOut ?? 0,
    rInSecp: s.rInSecp, rOutSecp: randomScalar(), nonceIn: randomScalar(), nonceOut: randomScalar(),
    inNote: { owner: OWNER, leafIndex: 0, path: ZEROS }, outOwner: OWNER_OUT,
  }));
  // one pool tree holds every input note; patch each intent's (leafIndex, path)
  const tree = new pool.Tree();
  const idxs = intents.map((it) => {
    const inAsset = it.direction === 'A->B' ? ASSET_A : ASSET_B;
    return tree.insert(pool.leaf(inAsset, it.in.cx, it.in.cy, it.in.owner));
  });
  intents.forEach((it, i) => { const { path } = tree.rootAndPath(idxs[i]); it.in.leafIndex = idxs[i]; it.in.path = path; });
  const spendRoot = tree.rootAndPath(0).root;
  const batch = swap.buildBatch({ assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS, reserveAPre, reserveBPre, priceNum, priceDen, intents, spendRoot });
  return { batch, priceNum, priceDen, ...swap.verifyBatch(batch, { merkleRootFrom: pool.merkleRootFrom }) };
}

// ───────────────── 1. single A→B swap moves the reserves ─────────────────
// Pool 1000/1000; swap 100 A in. Constant product gives 90 B out (1000−⌊1e6/1100⌋); price 90/100.
{
  const rInSecp = randomScalar();
  const { batch, settlement, nullifiers, leaves, priceNum, priceDen } = assemble({
    reserveAPre: 1000, reserveBPre: 1000,
    specs: [{ direction: 'A->B', amountIn: 100, minOut: 90, rInSecp }],
  });
  assert.strictEqual(priceNum, 90n, 'fee-clearing price 90/100 (B per A) for 100 A into 1000/1000 @ 30bps');
  assert.strictEqual(priceDen, 100n);
  assert.strictEqual(batch.intents[0].amountOut, 90n, 'floor(100·90/100) = 90');
  assert.strictEqual(settlement.reserveAPost, 1100n, 'A: 1000 → 1100');
  assert.strictEqual(settlement.reserveBPost, 910n, 'B: 1000 → 910');
  assert.strictEqual(settlement.poolId, swap.poolId(ASSET_A, ASSET_B, FEE_BPS), 'poolId = keccak(A‖B‖feeBps)');
  // k strictly increases (the floored unit stays in the pool)
  assert.ok(1100n * 910n >= 1000n * 1000n, 'k non-decrease');
  assert.strictEqual(nullifiers.length, 1, 'one input nullifier');
  assert.strictEqual(leaves.length, 1, 'one output leaf (asset B)');
  ok('single A→B: 100 A → 90 B, reserves 1000/1000 → 1100/910, k↑, ν + leaf emitted');
}

// ───────────────── 2. two-sided batch clears at one uniform fee-correct price ─────────────────
// A→B 100 + B→A 50 against 1000/1000 @ 30bps: the A side dominates, so the batch clears at the
// solve's single price; the partial cross nets and k still holds (flooring favours the pool).
{
  const { batch, settlement, priceNum, priceDen } = assemble({
    reserveAPre: 1000, reserveBPre: 1000,
    specs: [
      { direction: 'A->B', amountIn: 100, minOut: 0, rInSecp: randomScalar() },
      { direction: 'B->A', amountIn: 50, minOut: 0, rInSecp: randomScalar() },
    ],
  });
  const cp = clearingPriceBperA(solveClearing(100n, 50n, 1000n, 1000n, FEE_BPS));
  assert.strictEqual(priceNum, cp.priceNum, 'batch price = the deterministic fee-clearing price');
  assert.strictEqual(priceDen, cp.priceDen);
  assert.ok(settlement.reserveAPost * settlement.reserveBPost >= 1000n * 1000n, 'k non-decrease');
  ok('two-sided batch clears at one uniform fee-correct price (A-dominant cross), k holds');
}

// ───────────────── 3. clearing a fee pool at the ZERO-fee price is rejected ─────────────────
// The fee-enforcement attack: in a 30bps pool, clear the batch at the (more generous) ZERO-fee price.
// Per-intent clearing is self-consistent and k still holds (zero-fee is the floor), so the OLD guest
// would accept it and starve LPs of the fee. The new guest re-derives the 30bps price and rejects.
// Large reserves so the fee actually moves the floored price (at 1000/1000 the dust swallows it).
{
  const RA = 1_000_000n, RB = 1_000_000n, IN = 100_000n;
  // build at the zero-fee tier's price inside a FEE_BPS(=30) pool
  let threw = null;
  try {
    assemble({
      reserveAPre: RA, reserveBPre: RB, priceFeeBps: 0,
      specs: [{ direction: 'A->B', amountIn: IN, minOut: 0, rInSecp: randomScalar() }],
    });
  } catch (e) { threw = e; }
  // sanity: the two tiers really do price differently here (else the test proves nothing)
  const p0 = clearingPriceBperA(solveClearing(IN, 0n, RA, RB, 0));
  const p30 = clearingPriceBperA(solveClearing(IN, 0n, RA, RB, FEE_BPS));
  assert.ok(p0.priceNum !== p30.priceNum || p0.priceDen !== p30.priceDen, 'zero-fee vs 30bps prices differ at this scale');
  assert.ok(threw && /fee-clearing price/.test(threw.message), 'zero-fee clearing in a fee pool rejected');
  ok('fee enforced: clearing a 30bps pool at the zero-fee price is rejected (LPs get their fee)');
}

// ───────────────── 4. min_out shortfall is rejected ─────────────────
{
  let threw = null;
  try {
    assemble({
      reserveAPre: 1000, reserveBPre: 1000,
      specs: [{ direction: 'A->B', amountIn: 100, minOut: 91, rInSecp: randomScalar() }],
    });
  } catch (e) { threw = e; }
  assert.ok(threw && /min_out/.test(threw.message), 'min_out shortfall rejected');
  ok('trader slippage guard: amount_out 90 < min_out 91 rejected');
}

// ───────────────── 5. a forged membership path is rejected ─────────────────
{
  const rInSecp = randomScalar();
  const { batch } = assemble({
    reserveAPre: 1000, reserveBPre: 1000,
    specs: [{ direction: 'A->B', amountIn: 100, minOut: 90, rInSecp }],
  });
  // tamper the input note's owner so its leaf is not the one in the tree
  const bad = { ...batch, intents: [{ ...batch.intents[0], in: { ...batch.intents[0].in, owner: '0x' + '00'.repeat(31) + 'ff' } }] };
  assert.throws(() => swap.verifyBatch(bad, { merkleRootFrom: pool.merkleRootFrom }), /membership/, 'forged note rejected');
  ok('a note not in the pool tree (tampered owner) fails membership');
}

// ───────────────── 6. a tampered output amount breaks the secp opening ─────────────────
{
  const rInSecp = randomScalar();
  const { batch } = assemble({
    reserveAPre: 1000, reserveBPre: 1000,
    specs: [{ direction: 'A->B', amountIn: 100, minOut: 90, rInSecp }],
  });
  // claim more output than the price clears, keeping the (now stale) output note commitment. The
  // intent context binds amount_out, so the inflated amount also breaks the opening sigmas (the box
  // can't re-price), beyond the clearing check.
  const bad = { ...batch, intents: [{ ...batch.intents[0], amountOut: 95n, rem: 0n }] };
  assert.throws(() => swap.verifyBatch(bad, { merkleRootFrom: pool.merkleRootFrom }), /opening|clearing/, 'inflated output rejected');
  ok('inflating amount_out (95 vs cleared 90) breaks the opening-sigma context bind + clearing');
}

console.log(`\n${n} OP_SWAP checks passed.`);
