#!/usr/bin/env node
// OP_BID buyer-output recovery — proves a wiped buyer wallet recovers its FILLED-bid notes (received
// asset_a + the asset_b refund) FROM THE SEED ALONE. These are the one note family the universal memo
// scan (confidential-indexer.recover) cannot reach: the seller settles the fill but never learns the
// buyer's deriveNote blindings, so it can seal NO memo for them. The buyer instead re-derives the
// per-fill blindings from a SEED-BOUND bid secret (pool.deriveBidSecret) and matches the on-chain
// leaves (bid.recoverBidOutputs).
//
// Regression: before the seed-bound bidSecret + recoverBidOutputs, a wiped buyer had no path to these
// notes (no memo possible, bidSecret was a throwaway random) → permanent fund loss on wipe.
//
// Run: node tests/confidential-bid-recovery.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar, G } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialBid } from '../dapp/confidential-bid.js';
import { makeConfidentialIndexer } from '../dapp/confidential-indexer.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const deps = { secp, keccak256, sha256 };
const pool = makeConfidentialPool(deps);
const bidMod = makeConfidentialBid({ keccak256, pool });
const idx = makeConfidentialIndexer(deps);
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const ASSET_A = '0x' + 'aa'.repeat(32);
const ASSET_B = '0x' + 'bb'.repeat(32);
const SELLER = '0x' + '00'.repeat(31) + '02';
const CB = '0x' + '11'.repeat(32);

// The buyer's wallet seed (the ONLY thing it has after a wipe) + its owner field.
const SEED = '0x' + 'fe'.repeat(32);
const buyerPriv = randomScalar();
const BUYER = '0x' + Buffer.from(G.multiply(buyerPriv).toRawBytes(true)).toString('hex'); // owner = bearer pubkey

// ── Build a bid + a partial fill, with bidSecret DERIVED FROM THE SEED (the fix) ──
// Bid: buy up to 100 A at 5 B/unit, grid 10. Fund = 500 B. Seller fills 40 → buyer gets 40 A + 300 B.
const minFill = 10n, maxFill = 100n, price = 5n, increment = 10n, chosenF = 40n;
const fundR = randomScalar();
const vFund = maxFill * price;
const fundC = pool.commitXY(vFund, fundR);
// bidSecret is seed-bound to the funding commitment → recoverable from the seed after a wipe.
const bidSecret = pool.deriveBidSecret(SEED, fundC.cx, fundC.cy);

const sInR = randomScalar();
const sInC = pool.commitXY(40n, sInR);
const tree = new pool.Tree();
const fundIdx = tree.insert(pool.leaf(ASSET_B, fundC.cx, fundC.cy, BUYER));
const sIdx = tree.insert(pool.leaf(ASSET_A, sInC.cx, sInC.cy, SELLER));
const spendRoot = tree.rootAndPath(0).root;

const bid = bidMod.buildBid({
  assetA: ASSET_A, assetB: ASSET_B, minFill, maxFill, price, increment, chainBinding: CB, spendRoot,
  buyerOwner: BUYER, fundRSecp: fundR, fundLeafIndex: fundIdx, fundPath: tree.rootAndPath(fundIdx).path, bidSecret,
});
const filled = bidMod.fillBid(bid, {
  chosenF, sellerOwner: SELLER, sellerInAmount: 40n, sellerInRSecp: sInR,
  sellerInLeafIndex: sIdx, sellerInPath: tree.rootAndPath(sIdx).path,
  sellerRecvRSecp: randomScalar(), sellerChangeRSecp: null,
  nonces: { fund: randomScalar(), recvA: randomScalar(), refund: randomScalar(),
            sellerIn: randomScalar(), sellerRecv: randomScalar(), sellerChange: randomScalar() },
});
const { nullifiers, leaves } = bidMod.verifyBid(filled, { merkleRootFrom: pool.merkleRootFrom });
assert.strictEqual(leaves.length, 3, 'buyer A + seller B pay + buyer B refund');

// ── The on-chain settle: the fill's output leaves land, memos are sealed only for notes whose openings
//    the SETTLER knows — i.e. the SELLER's pay note. The buyer's two outputs get NO memo (the seller
//    can't seal what it can't open). Simulate that: a memo for the seller pay note, empty for the rest.
const sealerlessMemo = '0x'; // no memo available for buyer outputs
const events = [
  { type: 'LeavesInserted', firstLeafIndex: 0, leaves: [pool.leaf(ASSET_B, fundC.cx, fundC.cy, BUYER), pool.leaf(ASSET_A, sInC.cx, sInC.cy, SELLER)], memos: [sealerlessMemo, sealerlessMemo] },
  { type: 'LeavesInserted', firstLeafIndex: 2, leaves, memos: [sealerlessMemo, sealerlessMemo, sealerlessMemo] },
  { type: 'NullifiersSpent', nullifiers },
];

// ── 1. The universal memo recovery CANNOT reach the buyer's bid outputs (no memo to open) ──
const viaMemo = idx.recover(events, buyerPriv);
assert.strictEqual(viaMemo.length, 0, 'memo scan recovers zero (no memo seals the buyer bid outputs)');
ok('the universal memo recovery cannot reach a buyer\'s filled-bid notes (no memo possible)');

// ── 2. Seed-only bid recovery DOES recover them (received A + refund B), with spend paths ──
const indexed = idx.index(events);
const fullTree = idx.buildTree(indexed.leaves);
const leafSet = new Map();
indexed.leaves.forEach((l, i) => { if (l) leafSet.set(String(l.leaf).toLowerCase(), { leafIndex: i }); });

const recovered = bidMod.recoverBidOutputs({
  seed: SEED,
  bid: { assetA: ASSET_A, assetB: ASSET_B, minFill, maxFill, price, increment, buyerOwner: BUYER, fund: { cx: fundC.cx, cy: fundC.cy } },
  leafSet,
});
assert.strictEqual(recovered.length, 2, 'recovered both buyer outputs (received A + refund B)');
const recvA = recovered.find((r) => r.asset === ASSET_A);
const refund = recovered.find((r) => r.asset === ASSET_B);
assert.ok(recvA && recvA.value === 40n, 'recovered received-A note (40)');
assert.ok(refund && refund.value === 300n, 'recovered refund-B note (300)');
ok('seed-only bid recovery returns the received-A (40) + refund-B (300) notes');

// ── 3. The recovered notes carry valid spend material (leaf folds to the on-chain root, ν matches) ──
const root = fullTree.root();
for (const r of recovered) {
  const path = fullTree.rootAndPath(r.leafIndex).path;
  assert.ok(pool.verifyPath(r.leaf, r.leafIndex, path, root), `recovered ${r.asset === ASSET_A ? 'A' : 'B'} leaf folds to root`);
  // the recovered blinding actually opens the on-chain commitment (spendable)
  const c = pool.commitXY(r.value, r.blinding);
  assert.strictEqual(pool.leaf(r.asset, c.cx, c.cy, r.owner).toLowerCase(), String(r.leaf).toLowerCase(), 'opening recommits to the leaf');
}
ok('recovered bid notes are spendable: paths fold to the root + blindings reopen the commitments');

// ── 4. A WRONG seed recovers nothing (the bid secret is seed-bound) ──
const wrong = bidMod.recoverBidOutputs({
  seed: '0x' + '01'.repeat(32),
  bid: { assetA: ASSET_A, assetB: ASSET_B, minFill, maxFill, price, increment, buyerOwner: BUYER, fund: { cx: fundC.cx, cy: fundC.cy } },
  leafSet,
});
assert.strictEqual(wrong.length, 0, 'a wrong seed derives a wrong bid secret → no match');
ok('a wrong seed recovers nothing (bid secret is seed-bound)');

console.log(`\n${n} OP_BID recovery checks passed.`);
