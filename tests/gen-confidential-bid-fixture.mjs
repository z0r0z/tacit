#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/bid_op.json — a single OP_BID the box's exec-bid harness
// feeds to the guest (execute → prove). Bid: buy up to 100 A at 5 B/unit, grid 10, V_fund=500 B.
// Seller fills 40 from a 50 A note ⇒ partial fill (300 B refund to buyer) AND seller change (10 A) —
// one fixture exercises BOTH the refund and the seller-change branches. Fields are emitted in the
// guest's io::read order; `expected` carries the ν + leaves the guest must commit.
//
// Run: node tests/gen-confidential-bid-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialBid } from '../dapp/confidential-bid.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const bidMod = makeConfidentialBid({ keccak256, pool });

const ASSET_A = '0x' + 'aa'.repeat(32);
const ASSET_B = '0x' + 'bb'.repeat(32);
const BUYER = '0x' + '00'.repeat(31) + '01';
const SELLER = '0x' + '00'.repeat(31) + '02';
const CB = '0x' + '11'.repeat(32);
const BID_SECRET = '0x' + 'cc'.repeat(32);
const det = (tag) => BigInt('0x' + keccak256(new TextEncoder().encode('cbid-fixture-' + tag)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''));

const minFill = 10, maxFill = 100, price = 5, increment = 10, chosenF = 40, sellerIn = 50;
const fundR = det('fund'), sInR = det('s-in');
const vFund = BigInt(maxFill) * BigInt(price);
const fundC = pool.commitXY(vFund, fundR);
const sInC = pool.commitXY(BigInt(sellerIn), sInR);
const tree = new pool.Tree();
const fundIdx = tree.insert(pool.leaf(ASSET_B, fundC.cx, fundC.cy, BUYER));
const sIdx = tree.insert(pool.leaf(ASSET_A, sInC.cx, sInC.cy, SELLER));
const spendRoot = tree.rootAndPath(0).root;

const bid = bidMod.buildBid({
  assetA: ASSET_A, assetB: ASSET_B, minFill, maxFill, price, increment, chainBinding: CB, spendRoot,
  buyerOwner: BUYER, fundRSecp: fundR, fundLeafIndex: fundIdx, fundPath: tree.rootAndPath(fundIdx).path, bidSecret: BID_SECRET,
});
const filled = bidMod.fillBid(bid, {
  chosenF, sellerOwner: SELLER, sellerInAmount: sellerIn, sellerInRSecp: sInR,
  sellerInLeafIndex: sIdx, sellerInPath: tree.rootAndPath(sIdx).path,
  sellerRecvRSecp: det('s-recv'), sellerChangeRSecp: det('s-change'),
  nonces: { fund: det('n-fund'), recvA: det('n-recvA'), refund: det('n-refund'),
            sellerIn: det('n-sin'), sellerRecv: det('n-srecv'), sellerChange: det('n-schange') },
});
const { nullifiers, leaves } = bidMod.verifyBid(filled, { merkleRootFrom: pool.merkleRootFrom });

const fixture = {
  chainBinding: CB, spendRoot, assetA: ASSET_A, assetB: ASSET_B,
  minFill, maxFill, price, increment, buyerOwner: BUYER, sellerOwner: SELLER, chosenF,
  fund: { cx: bid.fund.cx, cy: bid.fund.cy, leafIndex: fundIdx, path: tree.rootAndPath(fundIdx).path, sigR: bid.fund.sig.R, sigZ: bid.fund.sig.z },
  buyerRecvA: { cx: filled.buyerRecvA.cx, cy: filled.buyerRecvA.cy, sigR: filled.buyerRecvA.sig.R, sigZ: filled.buyerRecvA.sig.z },
  refund: filled.refundNote ? { cx: filled.refundNote.cx, cy: filled.refundNote.cy, sigR: filled.refundNote.sig.R, sigZ: filled.refundNote.sig.z } : null,
  sellerIn: { cx: filled.sellerIn.cx, cy: filled.sellerIn.cy, leafIndex: sIdx, path: tree.rootAndPath(sIdx).path, amount: Number(filled.sellerIn.amount), sigR: filled.sellerIn.sig.R, sigZ: filled.sellerIn.sig.z },
  sellerHasChange: filled.sellerChange ? 1 : 0,
  sellerChange: filled.sellerChange ? { cx: filled.sellerChange.cx, cy: filled.sellerChange.cy, sigR: filled.sellerChange.sig.R, sigZ: filled.sellerChange.sig.z } : null,
  sellerRecvB: { cx: filled.sellerRecvB.cx, cy: filled.sellerRecvB.cy, sigR: filled.sellerRecvB.sig.R, sigZ: filled.sellerRecvB.sig.z },
  deadline: Number(bid.deadline ?? 0), // buyer's bid expiry; bound in the offline presig (buildBid), read last (guest 917)
  expected: { nullifiers, leaves },
};

const out = 'contracts/sp1/confidential/fixtures/bid_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, `— fill ${chosenF}/${maxFill} @ ${price}; refund ${Number(filled.refund)} B, seller change ${Number(filled.sellerChange.amount)} A; ${nullifiers.length} ν, ${leaves.length} leaves`);
