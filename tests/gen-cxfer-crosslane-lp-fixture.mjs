#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/crosslane_lp_op.json — the acceptance witness for a
// ONE-SETTLE cross-chain LP-ADD (OP_LP_ADD) in CROSS-LANE mode: a Bitcoin holder adds liquidity in one
// settle, both contribution notes (A + B) Bitcoin-homed (a batch proves membership against a SINGLE
// spendRoot, so a btcHomed LP-add funds both reserves from Bitcoin notes). It is the OP_LP_ADD witness
// (gen-confidential-lp-fixture.mjs) with the cross-lane additions, mirroring the swap/OTC fixtures:
//   • bitcoinSpentRoot != 0  → the guest runs check_btc_nonmembership per spent input
//   • per leg (A, B): a `nonMember` indexed-Merkle witness (ν absent from the reflected Bitcoin spent set)
//   • `expected.consumed` = BOTH input ν the contract records in bitcoinConsumed (spendRoot-bound).
// The LP guest reads BOTH nonMembers at the END (after op_deadline), A then B — it defers its membership
// + cross-lane checks until after deriving d_shares (main.rs:621 A / :626 B). No guest change is needed;
// this validates that path against the box re-prove. See ops/PLAN-fast-lane-trading.md.
//
// Run: node tests/gen-cxfer-crosslane-lp-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialLp } from '../dapp/confidential-lp.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const lp = makeConfidentialLp({ keccak256, pool });

const ASSET_A = '0x' + 'aa'.repeat(32);
const ASSET_B = '0x' + 'bb'.repeat(32);
const OWNER = '0x' + '00'.repeat(31) + '01';
const SHARE_OWNER = '0x' + '00'.repeat(31) + '02';
const CHAIN_BINDING = '0x' + '11'.repeat(32);
const FEE_BPS = 30;

const det = (tag) => BigInt('0x' + keccak256(new TextEncoder().encode('cxfer-crosslane-lp-' + tag)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''));

const op = lp.buildAdd({
  assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS, reserveAPre: 1000, reserveBPre: 2000, sharesPre: 1000,
  aNote: { owner: OWNER, leafIndex: 0, path: pool.zeros }, dA: 100, rA: det('a-secp'),
  bNote: { owner: OWNER, leafIndex: 0, path: pool.zeros }, dB: 200, rB: det('b-secp'),
  shareOwner: SHARE_OWNER, rShares: det('share-secp'),
  nonceA: det('a-nonce'), nonceB: det('b-nonce'), nonceShares: det('share-nonce'),
});

// Both spent contribution notes live in ONE tree — a reflected BITCOIN pool root (both legs btcHomed).
const tree = new pool.Tree();
const ai = tree.insert(pool.leaf(ASSET_A, op.a.cx, op.a.cy, op.a.owner));
const bi = tree.insert(pool.leaf(ASSET_B, op.b.cx, op.b.cy, op.b.owner));
op.a.leafIndex = ai; op.a.path = tree.rootAndPath(ai).path;
op.b.leafIndex = bi; op.b.path = tree.rootAndPath(bi).path;
const spendRoot = tree.rootAndPath(0).root;

const { settlement, nullifiers, leaves } = lp.verifyAdd(op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });

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
  note: 'one-settle cross-chain LP-ADD (OP_LP_ADD) — BOTH contribution notes btcHomed + per-leg cross-lane non-membership + consumed-ν',
  chainBinding: CHAIN_BINDING,
  spendRoot,            // a reflected Bitcoin pool root (both inputs btcHomed)
  bitcoinSpentRoot,     // != 0 → guest runs check_btc_nonmembership per input
  assetA: ASSET_A, assetB: ASSET_B, feeBps: FEE_BPS,
  reserveAPre: 1000, reserveBPre: 2000, sharesPre: 1000,
  a: { cx: op.a.cx, cy: op.a.cy, owner: op.a.owner, leafIndex: op.a.leafIndex, path: op.a.path, d: Number(op.dA), sigR: op.aSig.R, sigZ: op.aSig.z, nonMember },
  b: { cx: op.b.cx, cy: op.b.cy, owner: op.b.owner, leafIndex: op.b.leafIndex, path: op.b.path, d: Number(op.dB), sigR: op.bSig.R, sigZ: op.bSig.z, nonMember },
  share: { cx: op.share.cx, cy: op.share.cy, owner: op.share.owner, sigR: op.sSig.R, sigZ: op.sSig.z },
  deadline: Number(op.deadline ?? 0),
  expected: {
    poolId: settlement.poolId,
    reserveAPost: Number(settlement.reserveAPost), reserveBPost: Number(settlement.reserveBPost), sharesPost: Number(settlement.sharesPost),
    nullifiers, leaves,
    consumed, // contract records BOTH in bitcoinConsumed + advances bitcoinConsumedCount by consumed.length
  },
};

const out = 'contracts/sp1/confidential/fixtures/crosslane_lp_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, '— cross-lane add 100A/200B, reserves 1000/2000 →', fixture.expected.reserveAPost + '/' + fixture.expected.reserveBPost, '· consumed ν:', consumed.length, '· bitcoinSpentRoot set');
