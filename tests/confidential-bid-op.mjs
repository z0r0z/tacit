#!/usr/bin/env node
// OP_BID (confidential partial-fill bid) — Node round-trip that locks the witness the SP1 guest
// re-verifies. Builds a buyer-offline bid + a seller fill and runs verifyBid, which mirrors EVERY
// guest assertion in contracts/sp1/confidential/src/main.rs (OP_BID): grid/range, funding +
// per-fill buyer openings (pre-signed, no seller notes in their context), seller openings, the
// refund + change forms, and per-asset conservation. A fill that passes here is one the guest
// accepts; a tamper that fails here is one it rejects.
//
// Run: node tests/confidential-bid-op.mjs

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

// Build a bid (buyer funds V_fund=maxFill*price of asset B) + a seller fill at chosenF. Places the
// funding + seller-input leaves in one tree, patches paths, returns { filled, nullifiers, leaves }.
function assemble({ minFill, maxFill, price, increment, chosenF, sellerIn }) {
  const fundR = randomScalar();
  const vFund = BigInt(maxFill) * BigInt(price);
  const fundC = pool.commitXY(vFund, fundR);
  const sInR = randomScalar();
  const sInC = pool.commitXY(BigInt(sellerIn), sInR);
  const tree = new pool.Tree();
  const fundIdx = tree.insert(pool.leaf(ASSET_B, fundC.cx, fundC.cy, BUYER));
  const sIdx = tree.insert(pool.leaf(ASSET_A, sInC.cx, sInC.cy, SELLER));
  const spendRoot = tree.rootAndPath(0).root;
  const bid = bidMod.buildBid({
    assetA: ASSET_A, assetB: ASSET_B, minFill, maxFill, price, increment, chainBinding: CB, spendRoot,
    buyerOwner: BUYER, fundRSecp: fundR, fundLeafIndex: fundIdx, fundPath: tree.rootAndPath(fundIdx).path, bidSecret: BID_SECRET,
  });
  const needChange = BigInt(sellerIn) > BigInt(chosenF);
  const filled = bidMod.fillBid(bid, {
    chosenF, sellerOwner: SELLER, sellerInAmount: sellerIn, sellerInRSecp: sInR,
    sellerInLeafIndex: sIdx, sellerInPath: tree.rootAndPath(sIdx).path,
    sellerRecvRSecp: randomScalar(), sellerChangeRSecp: needChange ? randomScalar() : null,
    nonces: { fund: randomScalar(), recvA: randomScalar(), refund: randomScalar(),
              sellerIn: randomScalar(), sellerRecv: randomScalar(), sellerChange: randomScalar() },
  });
  return { filled, ...bidMod.verifyBid(filled, { merkleRootFrom: pool.merkleRootFrom }) };
}

// ───────────────── 1. partial fill with refund ─────────────────
// Bid: buy up to 100 A at 5 B/unit, grid 10. Fund = 500 B. Seller fills 40 (exact note): seller
// gets 200 B, buyer gets 40 A + 300 B refund.
{
  const { filled, nullifiers, leaves } = assemble({ minFill: 10, maxFill: 100, price: 5, increment: 10, chosenF: 40, sellerIn: 40 });
  assert.strictEqual(filled.pay, 200n, 'pay = 40·5');
  assert.strictEqual(filled.refund, 300n, 'refund = (100−40)·5');
  assert.strictEqual(nullifiers.length, 2, 'two nullifiers (funding + seller input)');
  assert.strictEqual(leaves.length, 3, 'three leaves: buyer A + seller B pay + buyer B refund');
  assert.strictEqual(leaves[0], pool.leaf(ASSET_A, filled.buyerRecvA.cx, filled.buyerRecvA.cy, BUYER), 'leaf0 = buyer A note');
  assert.strictEqual(leaves[2], pool.leaf(ASSET_B, filled.refundNote.cx, filled.refundNote.cy, BUYER), 'leaf2 = buyer refund');
  ok('partial fill: 40/100 @ 5 → seller 200 B, buyer 40 A + 300 B refund; 2 ν, 3 leaves');
}

// ───────────────── 2. full fill (no refund) + seller change ─────────────────
// Seller fills the whole 100 from a 150 A note: 50 A change, NO refund leaf.
{
  const { filled, nullifiers, leaves } = assemble({ minFill: 10, maxFill: 100, price: 5, increment: 10, chosenF: 100, sellerIn: 150 });
  assert.strictEqual(filled.pay, 500n, 'pay = 100·5 = full V_fund');
  assert.strictEqual(filled.refund, 0n, 'no refund on a full fill');
  assert.strictEqual(filled.refundNote, null, 'no refund note');
  assert.strictEqual(filled.sellerChange.amount, 50n, 'seller change = 150 − 100');
  assert.strictEqual(leaves.length, 3, 'three leaves: buyer A + seller B + seller A change (no refund)');
  ok('full fill: 100/100, seller 500 B + 50 A change, buyer 100 A, no refund');
}

// ───────────────── 3. off-grid and out-of-range fills rejected ─────────────────
{
  let g = null; try { assemble({ minFill: 10, maxFill: 100, price: 5, increment: 10, chosenF: 45, sellerIn: 45 }); } catch (e) { g = e; }
  assert.ok(g && /off grid/.test(g.message), 'off-grid fill (45) rejected');
  let r = null; try { assemble({ minFill: 10, maxFill: 100, price: 5, increment: 10, chosenF: 110, sellerIn: 110 }); } catch (e) { r = e; }
  assert.ok(r && /out of range/.test(r.message), 'over-max fill (110) rejected');
  ok('off-grid (45) and out-of-range (110) fills are rejected');
}

// ───────────────── 4. box shorts the buyer's refund → refund opening fails ─────────────────
// The buyer is owed (100−40)·5 = 300 B refund. The box/seller tries to substitute a smaller refund
// note to pocket the difference; the refund is opening-bound to 300, so it fails (the analog of
// Bitcoin's consensus-enforced refund vout).
{
  const { filled } = assemble({ minFill: 10, maxFill: 100, price: 5, increment: 10, chosenF: 40, sellerIn: 40 });
  const evil = pool.commitXY(100n, randomScalar()); // 100 B instead of the owed 300
  const bad = { ...filled, refundNote: { ...filled.refundNote, cx: evil.cx, cy: evil.cy } };
  assert.throws(() => bidMod.verifyBid(bad, { merkleRootFrom: pool.merkleRootFrom }), /opening/, 'shorted refund rejected');
  ok('shorting the buyer refund (100 vs owed 300) breaks the refund opening — refund is enforced');
}

// ───────────────── 5. box-substituted seller pay note → seller opening fails ─────────────────
{
  const { filled } = assemble({ minFill: 10, maxFill: 100, price: 5, increment: 10, chosenF: 40, sellerIn: 40 });
  const evil = pool.commitXY(200n, randomScalar()); // 200 B, but a blinding the box controls
  const bad = { ...filled, sellerRecvB: { ...filled.sellerRecvB, cx: evil.cx, cy: evil.cy } };
  assert.throws(() => bidMod.verifyBid(bad, { merkleRootFrom: pool.merkleRootFrom }), /opening/, 'substituted pay note rejected');
  ok('box-substituted seller pay note (its own blinding) breaks the opening sigma');
}

console.log(`\n${n} OP_BID checks passed.`);
