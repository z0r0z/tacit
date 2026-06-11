#!/usr/bin/env node
// OP_OTC (confidential 2-party direct swap) — Node round-trip that locks the witness the SP1 guest
// re-verifies. Builds a maker leg (spends assetA, receives assetB) + a taker leg (spends assetB,
// receives assetA) and runs verifyOtc, which mirrors EVERY guest assertion in
// contracts/sp1/confidential/src/main.rs (OP_OTC): membership of both spent inputs, the four (+
// change) opening sigmas under the shared intent context, per-asset conservation, and the canonical
// change form. The opening sigma binds the amount + owner to the note, so a batch that passes here
// is one the guest accepts; a tamper that fails here is one it rejects.
//
// Run: node tests/confidential-otc-op.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialOtc } from '../dapp/confidential-otc.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const otcMod = makeConfidentialOtc({ keccak256, pool });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const ASSET_A = '0x' + 'aa'.repeat(32);
const ASSET_B = '0x' + 'bb'.repeat(32);
const MAKER = '0x' + '00'.repeat(31) + '01';
const TAKER = '0x' + '00'.repeat(31) + '02';
const CHAIN_BINDING = '0x' + '11'.repeat(32);

// Build an OTC from (vA, vB) + each party's spent-input amount. Places both input leaves in one
// pool tree, patches the membership paths, and returns { otc, nullifiers, leaves } via the
// guest-mirroring verify. Change is derived automatically (input > give ⇒ a change note).
function assemble({ vA, vB, makerIn, takerIn }) {
  const mInR = randomScalar(), tInR = randomScalar();
  const mInC = pool.commitXY(BigInt(makerIn), mInR);
  const tInC = pool.commitXY(BigInt(takerIn), tInR);
  const tree = new pool.Tree();
  const mIdx = tree.insert(pool.leaf(ASSET_A, mInC.cx, mInC.cy, MAKER));
  const tIdx = tree.insert(pool.leaf(ASSET_B, tInC.cx, tInC.cy, TAKER));
  const mPath = tree.rootAndPath(mIdx).path;
  const tPath = tree.rootAndPath(tIdx).path;
  const spendRoot = tree.rootAndPath(0).root;
  const otc = otcMod.buildOtc({
    assetA: ASSET_A, assetB: ASSET_B, vA, vB, chainBinding: CHAIN_BINDING, spendRoot,
    maker: { owner: MAKER, inAmount: makerIn, inR: mInR, inLeafIndex: mIdx, inPath: mPath,
             recvR: randomScalar(), changeR: BigInt(makerIn) > BigInt(vA) ? randomScalar() : null },
    taker: { owner: TAKER, inAmount: takerIn, inR: tInR, inLeafIndex: tIdx, inPath: tPath,
             recvR: randomScalar(), changeR: BigInt(takerIn) > BigInt(vB) ? randomScalar() : null },
    nonces: { maker: { in: randomScalar(), recv: randomScalar(), change: randomScalar() },
              taker: { in: randomScalar(), recv: randomScalar(), change: randomScalar() } },
  });
  return { otc, ...otcMod.verifyOtc(otc, { merkleRootFrom: pool.merkleRootFrom }) };
}

// ───────────────── 1. exact swap (no change): 2 ν + 2 leaves ─────────────────
// Maker gives 100 A for 50 B; both spend exact-value notes. Taker gets 100 A, maker gets 50 B.
{
  const { otc, nullifiers, leaves } = assemble({ vA: 100, vB: 50, makerIn: 100, takerIn: 50 });
  assert.strictEqual(nullifiers.length, 2, 'two input nullifiers (maker + taker)');
  assert.strictEqual(leaves.length, 2, 'two output leaves (no change)');
  // taker receives asset A (vA), maker receives asset B (vB)
  assert.strictEqual(leaves[0], pool.leaf(ASSET_A, otc.taker.recv.cx, otc.taker.recv.cy, TAKER), 'leaf0 = taker A note');
  assert.strictEqual(leaves[1], pool.leaf(ASSET_B, otc.maker.recv.cx, otc.maker.recv.cy, MAKER), 'leaf1 = maker B note');
  assert.notStrictEqual(nullifiers[0], nullifiers[1], 'distinct nullifiers');
  ok('exact swap: 100 A ↔ 50 B, 2 ν + 2 leaves, each party receives the counterparty asset');
}

// ───────────────── 2. swap with change on both sides: 2 ν + 4 leaves ─────────────────
// Maker spends a 150 A note (gives 100, 50 change); taker spends an 80 B note (gives 50, 30 change).
{
  const { otc, nullifiers, leaves } = assemble({ vA: 100, vB: 50, makerIn: 150, takerIn: 80 });
  assert.strictEqual(nullifiers.length, 2, 'two input nullifiers');
  assert.strictEqual(leaves.length, 4, 'four leaves: 2 received + 2 change');
  assert.strictEqual(otc.maker.change.amount, 50n, 'maker change = 150 − 100');
  assert.strictEqual(otc.taker.change.amount, 30n, 'taker change = 80 − 50');
  // change leaves: maker change (A) then taker change (B), after the two received notes
  assert.strictEqual(leaves[2], pool.leaf(ASSET_A, otc.maker.change.cx, otc.maker.change.cy, MAKER), 'leaf2 = maker A change');
  assert.strictEqual(leaves[3], pool.leaf(ASSET_B, otc.taker.change.cx, otc.taker.change.cy, TAKER), 'leaf3 = taker B change');
  ok('swap with change: 150 A → 100 give + 50 change; 80 B → 50 give + 30 change; 4 leaves');
}

// ───────────────── 3. forged membership (tampered input owner) rejected ─────────────────
{
  const { otc } = assemble({ vA: 100, vB: 50, makerIn: 100, takerIn: 50 });
  const bad = { ...otc, maker: { ...otc.maker, owner: '0x' + '00'.repeat(31) + 'ff' } };
  assert.throws(() => otcMod.verifyOtc(bad, { merkleRootFrom: pool.merkleRootFrom }), /membership/, 'forged maker note rejected');
  ok('a spent input not in the pool tree (tampered owner) fails membership');
}

// ───────────────── 4. box swaps in its own output note → opening rejected ─────────────────
// The settle prover tries to replace the taker's received-A note with a commitment IT controls
// (a fresh r) while keeping the signed sigma. The sigma is bound to the original commitment, so it
// no longer verifies — the box cannot redirect the output to a note it can spend.
{
  const { otc } = assemble({ vA: 100, vB: 50, makerIn: 100, takerIn: 50 });
  const evil = pool.commitXY(100n, randomScalar()); // 100 A, but a blinding the box knows
  const bad = { ...otc, taker: { ...otc.taker, recv: { ...otc.taker.recv, cx: evil.cx, cy: evil.cy } } };
  assert.throws(() => otcMod.verifyOtc(bad, { merkleRootFrom: pool.merkleRootFrom }), /opening/, 'redirected output rejected');
  ok('box-substituted output note (its own blinding) breaks the opening sigma — no redirect');
}

// ───────────────── 5. re-pricing (tampered vA) breaks the sigma + conservation ─────────────────
{
  const { otc } = assemble({ vA: 100, vB: 50, makerIn: 100, takerIn: 50 });
  const bad = { ...otc, vA: 101n }; // claim the taker gets 101 A for the same 50 B
  assert.throws(() => otcMod.verifyOtc(bad, { merkleRootFrom: pool.merkleRootFrom }), /opening|conservation/, 're-price rejected');
  ok('inflating vA (101 vs signed 100) breaks the opening-sigma context bind + conservation');
}

// ───────────────── 6. zero-amount and same-asset guards ─────────────────
// (A 0-value note isn't constructible — noble rejects the 0 scalar — so the guards are exercised by
// tampering a valid OTC; the guest's `v_a>0 && v_b>0` + `asset_a!=asset_b` asserts mirror these.)
{
  const { otc } = assemble({ vA: 100, vB: 50, makerIn: 100, takerIn: 50 });
  const zero = { ...otc, vA: 0n };
  assert.throws(() => otcMod.verifyOtc(zero, { merkleRootFrom: pool.merkleRootFrom }), /zero amount/, 'zero vA rejected');
  const same = { ...otc, assetB: ASSET_A };
  assert.throws(() => otcMod.verifyOtc(same, { merkleRootFrom: pool.merkleRootFrom }), /same asset/, 'same-asset rejected');
  ok('zero-amount and same-asset OTCs are rejected');
}

console.log(`\n${n} OP_OTC checks passed.`);
