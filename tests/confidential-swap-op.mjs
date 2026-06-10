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
import { makeConfidentialSwap } from '../dapp/confidential-swap.js';
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
const ZEROS = pool.zeros; // 32 sibling-zeros for a placeholder path

// Build a batch from intent specs: derive each input note, place every input leaf in one tree,
// patch the membership paths, and return { batch, settlement } via the guest-mirroring verify.
function assemble({ reserveAPre, reserveBPre, priceNum, priceDen, specs }) {
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
  const batch = swap.buildBatch({ assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, reserveAPre, reserveBPre, priceNum, priceDen, intents, spendRoot });
  return { batch, ...swap.verifyBatch(batch, { merkleRootFrom: pool.merkleRootFrom }) };
}

// ───────────────── 1. single A→B swap moves the reserves ─────────────────
// Pool 1000/1000; swap 100 A in. Constant product gives 90 B out (1000−⌊1e6/1100⌋); price 90/100.
{
  const rInSecp = randomScalar();
  const { batch, settlement, nullifiers, leaves } = assemble({
    reserveAPre: 1000, reserveBPre: 1000, priceNum: 90, priceDen: 100,
    specs: [{ direction: 'A->B', amountIn: 100, minOut: 90, rInSecp }],
  });
  assert.strictEqual(batch.intents[0].amountOut, 90n, 'floor(100·90/100) = 90');
  assert.strictEqual(settlement.reserveAPost, 1100n, 'A: 1000 → 1100');
  assert.strictEqual(settlement.reserveBPost, 910n, 'B: 1000 → 910');
  assert.strictEqual(settlement.poolId, swap.poolId(ASSET_A, ASSET_B), 'poolId = keccak(A‖B)');
  // k strictly increases (the floored unit stays in the pool)
  assert.ok(1100n * 910n >= 1000n * 1000n, 'k non-decrease');
  assert.strictEqual(nullifiers.length, 1, 'one input nullifier');
  assert.strictEqual(leaves.length, 1, 'one output leaf (asset B)');
  ok('single A→B: 100 A → 90 B, reserves 1000/1000 → 1100/910, k↑, ν + leaf emitted');
}

// ───────────────── 2. two-sided batch that perfectly crosses (net-zero) ─────────────────
// A→B 100→90 and B→A 90→100 at the same price 90/100 net to zero: reserves unchanged, k constant.
{
  const { batch, settlement } = assemble({
    reserveAPre: 1000, reserveBPre: 1000, priceNum: 90, priceDen: 100,
    specs: [
      { direction: 'A->B', amountIn: 100, minOut: 90, rInSecp: randomScalar() },
      { direction: 'B->A', amountIn: 90, minOut: 100, rInSecp: randomScalar() },
    ],
  });
  assert.strictEqual(batch.intents[1].amountOut, 100n, 'B→A: floor(90·100/90) = 100');
  assert.strictEqual(settlement.reserveAPost, 1000n, 'A nets to 0 move');
  assert.strictEqual(settlement.reserveBPost, 1000n, 'B nets to 0 move');
  ok('two-sided cross: A→B + B→A net to zero, reserves unchanged, both directions priced uniformly');
}

// ───────────────── 3. a price that overpays liquidity is rejected (k decreases) ─────────────────
// Two A→B intents totaling 150 A at the flat marginal price 90/100 pay out 135 B, but the curve
// only allows ~130 for 150 A in — so k would fall. The guest's invariant must bite.
{
  let threw = null;
  try {
    assemble({
      reserveAPre: 1000, reserveBPre: 1000, priceNum: 90, priceDen: 100,
      specs: [
        { direction: 'A->B', amountIn: 100, rInSecp: randomScalar() },
        { direction: 'A->B', amountIn: 50, rInSecp: randomScalar() },
      ],
    });
  } catch (e) { threw = e; }
  assert.ok(threw && /constant-product decreased/.test(threw.message), 'k-decrease rejected');
  ok('over-priced batch (135 B out for 150 A in) rejected: constant-product would decrease');
}

// ───────────────── 4. min_out shortfall is rejected ─────────────────
{
  let threw = null;
  try {
    assemble({
      reserveAPre: 1000, reserveBPre: 1000, priceNum: 90, priceDen: 100,
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
    reserveAPre: 1000, reserveBPre: 1000, priceNum: 90, priceDen: 100,
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
    reserveAPre: 1000, reserveBPre: 1000, priceNum: 90, priceDen: 100,
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
