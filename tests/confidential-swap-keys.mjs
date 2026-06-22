// confidential-swap.js buildIntent/verifyBatch surface the optimistic-flow keys (inNullifier, outLeaf) that
// the pending-swap overlay reconciles against. This pins those keys to EXACTLY what the guest/indexer emit:
// the input note's nullifier (lands in the indexer's `spent` set) and the output note's leaf (lands in
// `LeavesInserted`). If these drift, the optimistic UI would never resolve. Run: node tests/confidential-swap-keys.mjs
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

const assetA = '0x' + 'a1'.repeat(32);
const assetB = '0x' + 'b2'.repeat(32);
const inNote = { owner: '0x' + '00'.repeat(31) + '07', leafIndex: 3, path: pool.zeros };
const outOwner = '0x' + '00'.repeat(31) + '09';
const rIn = randomScalar(), rOut = randomScalar();

// (1) A->B intent with the pair: inNullifier + outLeaf == what the indexer/guest compute
{
  const it = swap.buildIntent({
    direction: 'A->B', amountIn: 1000n, priceNum: 1n, priceDen: 1n, minOut: 0n,
    rInSecp: rIn, rOutSecp: rOut, inNote, outOwner, assetA, assetB,
  });
  // the indexer's `spent` set carries nullifier(in.cx,in.cy); the overlay reconciles on it
  assert.equal(it.inNullifier, pool.nullifier(it.in.cx, it.in.cy), 'inNullifier == pool.nullifier(input commitment)');
  // A->B ⇒ output asset is B; LeavesInserted carries leaf(assetB, out.cx, out.cy, outOwner)
  assert.equal(it.outLeaf, pool.leaf(assetB, it.out.cx, it.out.cy, outOwner), 'outLeaf == pool.leaf(outAsset, output commitment, owner)');
  ok('buildIntent (A->B): inNullifier + outLeaf equal the indexer/guest values exactly');
}

// (2) B->A intent: output asset flips to A
{
  const it = swap.buildIntent({
    direction: 'B->A', amountIn: 500n, priceNum: 1n, priceDen: 1n, minOut: 0n,
    rInSecp: rIn, rOutSecp: rOut, inNote, outOwner, assetA, assetB,
  });
  assert.equal(it.outLeaf, pool.leaf(assetA, it.out.cx, it.out.cy, outOwner), 'B->A ⇒ outLeaf uses assetA');
  assert.equal(it.inNullifier, pool.nullifier(it.in.cx, it.in.cy), 'inNullifier note-bound (direction-agnostic)');
  ok('buildIntent (B->A): output asset flips to A; inNullifier still note-bound');
}

// (3) without the pair: inNullifier still set (note-bound), outLeaf deferred to verifyBatch
{
  const it = swap.buildIntent({
    direction: 'A->B', amountIn: 1000n, priceNum: 1n, priceDen: 1n, minOut: 0n,
    rInSecp: rIn, rOutSecp: rOut, inNote, outOwner, // no assetA/assetB
  });
  assert.ok(it.inNullifier, 'inNullifier computed without the pair');
  assert.equal(it.outLeaf, null, 'outLeaf is null until the pair is known (verifyBatch fills it)');
  ok('buildIntent without pair: inNullifier set, outLeaf deferred');
}

console.log(`confidential-swap-keys: all ${n} checks passed`);
