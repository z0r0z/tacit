#!/usr/bin/env node
// OP_BID resting (multi-fill) order — Node round-trip for the dapp-only repeated-fills layer (no guest
// change). A resting bid is a chain of standard single-shot OP_BID lots: each `increment` lot spends the
// head funding note and emits the next (its refund), so `verifyBid` (the exact guest mirror) accepts each
// unchanged with maxFill = remaining, chosenF = increment. This locks: the funding-chain identity (refund
// of lot C == funding of lot C+inc), per-lot conservation, buyer received-note accrual, the dual-role
// nonce discipline (no blinding leak), and the cancel/race serialization on the funding nullifier.
//
// Run: node tests/confidential-bid-resting.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialBid } from '../dapp/confidential-bid.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const bidMod = makeConfidentialBid({ keccak256, pool });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const ASSET_A = '0x' + 'aa'.repeat(32);
const ASSET_B = '0x' + 'bb'.repeat(32);
const BUYER = '0x' + '00'.repeat(31) + '01';
const SELLER = '0x' + '00'.repeat(31) + '02';
const CB = '0x' + '11'.repeat(32);
const BID_SECRET = '0x' + 'cc'.repeat(32);

// ───────────────── 1. resting bid filled by sequential lots; funding chains ─────────────────
// Buy up to 100 A at 5 B/unit, lot = increment = 10. V_fund = 500 B. Sellers each fill one lot (10 A →
// 50 B); the funding note chains 500 → 450 → 400 → 350 …, each lot a standard OP_BID verifyBid accepts.
{
  const maxFill = 100n, price = 5n, increment = 10n;
  const fundR = randomScalar();
  const rest = bidMod.buildRestingBid({
    assetA: ASSET_A, assetB: ASSET_B, maxFill, price, increment, chainBinding: CB,
    buyerOwner: BUYER, fundRSecp: fundR, bidSecret: BID_SECRET,
  });
  assert.strictEqual(rest.states.length, 10, '10 lot states (maxFill / increment)');
  const f0 = pool.commitXY(maxFill * price, fundR);
  assert.strictEqual(rest.states[0].fund.cx, f0.cx, 'funding[0] is the buyer existing note (fundRSecp)');

  const tree = new pool.Tree();
  let headIdx = tree.insert(pool.leaf(ASSET_B, rest.states[0].fund.cx, rest.states[0].fund.cy, BUYER));
  const buyerRecvLeaves = [];
  const LOTS = 4;
  for (let i = 0; i < LOTS; i++) {
    const C = BigInt(i) * increment;
    const state = rest.states[i];
    // chain identity: the refund this lot emits IS the funding the next lot spends (same note).
    assert.strictEqual(state.refund.cx, rest.states[i + 1].fund.cx, `refund of lot ${i} == funding of lot ${i + 1} (cx)`);
    assert.strictEqual(state.refund.amount, rest.states[i + 1].fund.amount, `… and same value (cy/amount)`);

    const sInR = randomScalar();
    const sInC = pool.commitXY(increment, sInR);
    const sIdx = tree.insert(pool.leaf(ASSET_A, sInC.cx, sInC.cy, SELLER));
    const spendRoot = tree.rootAndPath(0).root;

    const filled = bidMod.fillRestingLot(rest, C, {
      spendRoot, fundLeafIndex: headIdx, fundPath: tree.rootAndPath(headIdx).path,
      sellerOwner: SELLER, sellerInAmount: increment, sellerInRSecp: sInR,
      sellerInLeafIndex: sIdx, sellerInPath: tree.rootAndPath(sIdx).path,
      sellerRecvRSecp: randomScalar(), sellerChangeRSecp: null,
    });
    const { nullifiers, leaves } = bidMod.verifyBid(filled, { merkleRootFrom: pool.merkleRootFrom });
    assert.strictEqual(filled.pay, 50n, 'pay = 10·5');
    assert.strictEqual(filled.refund, (maxFill - C - increment) * price, 'refund = remaining-after-lot · price');
    assert.strictEqual(nullifiers[0], pool.nullifier(state.fund.cx, state.fund.cy), 'lot nullifies the head funding note');
    assert.strictEqual(leaves.length, 3, 'three leaves: buyer A recv + seller B pay + next funding (refund)');
    // settle: append the new leaves; leaves[2] (the refund) is the next head.
    tree.insert(leaves[0]); buyerRecvLeaves.push(leaves[0]);
    tree.insert(leaves[1]);
    headIdx = tree.insert(leaves[2]);
  }
  ok(`resting bid: ${LOTS} sequential lots, funding chains 500→450→400→350→300, each verifyBid-accepted`);

  // buyer accrued LOTS received notes of 10 A each, recoverable from the cumulative state C.
  for (let i = 0; i < LOTS; i++) {
    assert.strictEqual(buyerRecvLeaves[i], pool.leaf(ASSET_A, rest.states[i].recv.cx, rest.states[i].recv.cy, BUYER),
      `received[${i}] (10 A) recoverable from cumulative state`);
  }
  ok(`buyer accrued ${LOTS} received notes (10 A each), each recoverable from the cumulative state`);
}

// ───────────────── 2. full drain: last lot has no refund (order exhausted) ─────────────────
{
  const maxFill = 30n, price = 7n, increment = 10n;
  const rest = bidMod.buildRestingBid({ assetA: ASSET_A, assetB: ASSET_B, maxFill, price, increment,
    chainBinding: CB, buyerOwner: BUYER, fundRSecp: randomScalar(), bidSecret: BID_SECRET });
  assert.strictEqual(rest.states.length, 3, '3 lots');
  assert.ok(rest.states[0].refund && rest.states[1].refund, 'lots 0,1 emit a refund (order continues)');
  assert.strictEqual(rest.states[2].refund, null, 'final lot has no refund (order exhausted)');
  ok('final lot emits no refund — the resting order is fully drained at cumulative = maxFill');
}

// ───────────────── 3. dual-role funding sigmas use distinct nonces (no blinding leak) ─────────────────
// funding[C+inc] is signed as lot C's REFUND and as lot C+inc's FUNDING. A shared nonce across the two
// challenges would leak r (= (z1−z2)/(e1−e2)) → bearer spend. Distinct nonce ⇒ distinct sigma R point.
{
  const rest = bidMod.buildRestingBid({ assetA: ASSET_A, assetB: ASSET_B, maxFill: 100n, price: 5n,
    increment: 10n, chainBinding: CB, buyerOwner: BUYER, fundRSecp: randomScalar(), bidSecret: BID_SECRET });
  for (let i = 0; i < rest.states.length - 1; i++) {
    assert.notStrictEqual(rest.states[i].refund.sig.R, rest.states[i + 1].fund.sig.R,
      `funding[${i + 1}] as-refund vs as-funding sigmas use distinct nonces (distinct R)`);
  }
  ok('dual-role funding sigmas (as-refund vs as-funding) use distinct nonces — no blinding leak');
}

// ───────────────── 4. cancellation + race serialize on the funding nullifier ─────────────────
// The buyer cancels the head by spending the current funding note (it knows the blinding); a seller
// racing a fill at the same head spends the SAME note → identical nullifier → the loser reverts.
{
  const maxFill = 50n, price = 3n, increment = 10n;
  const fundR = randomScalar();
  const rest = bidMod.buildRestingBid({ assetA: ASSET_A, assetB: ASSET_B, maxFill, price, increment,
    chainBinding: CB, buyerOwner: BUYER, fundRSecp: fundR, bidSecret: BID_SECRET });
  const fn = bidMod.restingFundingNote(rest, 0);
  assert.strictEqual(fn._r, fundR, 'buyer knows the head funding blinding (can cancel)');
  const cancelNu = pool.nullifier(fn.cx, fn.cy);
  const fillNu = pool.nullifier(rest.states[0].fund.cx, rest.states[0].fund.cy);
  assert.strictEqual(cancelNu, fillNu, 'cancel + fill at the same head share the funding nullifier');
  ok('cancellation spends the head funding note; a racing fill double-spends the same nullifier (serialized)');
}

// ───────────────── 5. a tampered next-funding (refund) breaks the pre-signed opening ─────────────────
// The buyer's next-funding note is opening-bound in its pre-signed context. A seller that substitutes a
// fatter next-funding (to skim the chain) shifts the buyer context, so the pre-signed openings fail.
{
  const maxFill = 100n, price = 5n, increment = 10n;
  const rest = bidMod.buildRestingBid({ assetA: ASSET_A, assetB: ASSET_B, maxFill, price, increment,
    chainBinding: CB, buyerOwner: BUYER, fundRSecp: randomScalar(), bidSecret: BID_SECRET });
  const tree = new pool.Tree();
  const headIdx = tree.insert(pool.leaf(ASSET_B, rest.states[0].fund.cx, rest.states[0].fund.cy, BUYER));
  const sInR = randomScalar();
  const sInC = pool.commitXY(increment, sInR);
  const sIdx = tree.insert(pool.leaf(ASSET_A, sInC.cx, sInC.cy, SELLER));
  const spendRoot = tree.rootAndPath(0).root;
  const filled = bidMod.fillRestingLot(rest, 0, {
    spendRoot, fundLeafIndex: headIdx, fundPath: tree.rootAndPath(headIdx).path,
    sellerOwner: SELLER, sellerInAmount: increment, sellerInRSecp: sInR,
    sellerInLeafIndex: sIdx, sellerInPath: tree.rootAndPath(sIdx).path,
    sellerRecvRSecp: randomScalar(), sellerChangeRSecp: null,
  });
  const evil = pool.commitXY(900n, randomScalar()); // fatter next-funding than the owed 450
  const bad = { ...filled, refundNote: { ...filled.refundNote, cx: evil.cx, cy: evil.cy } };
  assert.throws(() => bidMod.verifyBid(bad, { merkleRootFrom: pool.merkleRootFrom }), /opening/,
    'tampered next-funding rejected');
  ok('substituting a fatter next-funding breaks the buyer opening — the chain value is enforced');
}

console.log(`\n${n} OP_BID resting checks passed.`);
