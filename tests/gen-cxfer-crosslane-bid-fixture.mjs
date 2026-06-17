#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/crosslane_bid_op.json — the acceptance witness for a
// ONE-SETTLE cross-chain RESTING-BID FILL (OP_BID) in CROSS-LANE mode, where BOTH the buyer's funding
// note AND the seller's note are Bitcoin-homed (a batch proves membership against a SINGLE spendRoot, so
// a btcHomed BID has both legs on Bitcoin — two Bitcoin holders matching a confidential limit order on
// Ethereum). It is the OP_BID witness (gen-confidential-bid-fixture.mjs) with the cross-lane additions:
//   • bitcoinSpentRoot != 0  → the guest runs check_btc_nonmembership per spent input
//   • per leg (funding, seller): a `nonMember` indexed-Merkle witness (ν absent from the Bitcoin spent set)
//   • `expected.consumed` = BOTH input ν the contract records in bitcoinConsumed (spendRoot-bound).
// The BID guest reads each nonMember INTERLEAVED — funding right after its membership path and before its
// sigma (main.rs:874), seller right after its membership path and before its amount (main.rs:914). No
// guest change is needed; this validates that path against the box re-prove. See ops/PLAN-fast-lane-trading.md (Flow A).
//
// Run: node tests/gen-cxfer-crosslane-bid-fixture.mjs

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
const det = (tag) => BigInt('0x' + keccak256(new TextEncoder().encode('cxfer-crosslane-bid-' + tag)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''));

const minFill = 10, maxFill = 100, price = 5, increment = 10, chosenF = 40, sellerIn = 50;
const fundR = det('fund'), sInR = det('s-in');
const vFund = BigInt(maxFill) * BigInt(price);
const fundC = pool.commitXY(vFund, fundR);
const sInC = pool.commitXY(BigInt(sellerIn), sInR);
// Both spent notes live in ONE tree — a reflected BITCOIN pool root (both legs btcHomed).
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

// ── cross-lane: empty reflected Bitcoin spent set (sentinel {0 → MAX}); both ν are non-members ──
const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
const bytesOf = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const ZERO = beHex(0n), MAX = '0x' + 'ff'.repeat(32);
const imtLeaf = (v, n) => '0x' + Buffer.from(keccak_256(cat([bytesOf(v), bytesOf(n)]))).toString('hex');
const spentTree = new pool.Tree();
spentTree.insert(imtLeaf(ZERO, MAX));
const bitcoinSpentRoot = spentTree.root();
const nonMember = { lowValue: ZERO, lowNext: MAX, lowIndex: 0, path: spentTree.rootAndPath(0).path };
const big = (h) => BigInt(h.startsWith('0x') ? h : '0x' + h);
for (const nu of nullifiers) {
  if (!(big(nu) > 0n && big(nu) < big(MAX))) throw new Error('nullifier outside the sentinel non-membership gap: ' + nu);
}

const consumed = nullifiers.map((nu) => ({ nullifier: nu, spendRoot }));

const fixture = {
  note: 'one-settle cross-chain BID fill (OP_BID) — BOTH funding + seller notes btcHomed + per-leg cross-lane non-membership + consumed-ν',
  chainBinding: CB, spendRoot, bitcoinSpentRoot, assetA: ASSET_A, assetB: ASSET_B,
  minFill, maxFill, price, increment, buyerOwner: BUYER, sellerOwner: SELLER, chosenF,
  fund: { cx: bid.fund.cx, cy: bid.fund.cy, leafIndex: fundIdx, path: tree.rootAndPath(fundIdx).path, nonMember, sigR: bid.fund.sig.R, sigZ: bid.fund.sig.z },
  buyerRecvA: { cx: filled.buyerRecvA.cx, cy: filled.buyerRecvA.cy, sigR: filled.buyerRecvA.sig.R, sigZ: filled.buyerRecvA.sig.z },
  refund: filled.refundNote ? { cx: filled.refundNote.cx, cy: filled.refundNote.cy, sigR: filled.refundNote.sig.R, sigZ: filled.refundNote.sig.z } : null,
  sellerIn: { cx: filled.sellerIn.cx, cy: filled.sellerIn.cy, leafIndex: sIdx, path: tree.rootAndPath(sIdx).path, nonMember, amount: Number(filled.sellerIn.amount), sigR: filled.sellerIn.sig.R, sigZ: filled.sellerIn.sig.z },
  sellerHasChange: filled.sellerChange ? 1 : 0,
  sellerChange: filled.sellerChange ? { cx: filled.sellerChange.cx, cy: filled.sellerChange.cy, sigR: filled.sellerChange.sig.R, sigZ: filled.sellerChange.sig.z } : null,
  sellerRecvB: { cx: filled.sellerRecvB.cx, cy: filled.sellerRecvB.cy, sigR: filled.sellerRecvB.sig.R, sigZ: filled.sellerRecvB.sig.z },
  deadline: Number(bid.deadline ?? 0),
  expected: {
    nullifiers, leaves,
    consumed, // contract records BOTH in bitcoinConsumed + advances bitcoinConsumedCount by consumed.length
  },
};

const out = 'contracts/sp1/confidential/fixtures/crosslane_bid_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, `— cross-lane fill ${chosenF}/${maxFill} @ ${price}; refund ${Number(filled.refund)} B, seller change ${Number(filled.sellerChange.amount)} A; ${nullifiers.length} ν, ${leaves.length} leaves · consumed ν: ${consumed.length} · bitcoinSpentRoot set`);
