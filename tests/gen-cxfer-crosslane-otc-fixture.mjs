#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/crosslane_otc_op.json — the acceptance witness for a
// ONE-SETTLE cross-chain ORDERBOOK FILL (OP_OTC) in CROSS-LANE mode. It is the OP_OTC witness
// (gen-confidential-otc-fixture.mjs) with the cross-lane additions, mirroring the swap fixture:
//   • both legs are Bitcoin-homed — a batch proves membership against a SINGLE spendRoot, so a
//     btcHomed OTC necessarily has BOTH the maker's and taker's notes in the same reflected Bitcoin
//     pool root (two Bitcoin holders matching directly on Ethereum). A MIXED-lane fill (one Bitcoin
//     party, one Ethereum party) cannot be one batch — it is the two-settle on-ramp instead.
//   • bitcoinSpentRoot != 0  → the guest runs check_btc_nonmembership per spent input
//   • per leg: a `nonMember` indexed-Merkle witness (ν absent from the reflected Bitcoin spent set)
//   • `expected.consumed` = BOTH input ν the contract records in bitcoinConsumed (spendRoot-bound),
//     so the reverse reflection folds each into the Bitcoin spent set (Ethereum-senior void).
// The OTC math + opening sigmas are IDENTICAL to the value-conserving OTC fixture; only the cross-lane
// bits are added. The OTC guest already reads each leg's nonMember right after that leg's membership +
// nullifier and before its amount (main.rs:750 maker / :774 taker, op-agnostic), so no guest change is
// needed; this validates that path against the box re-prove. See ops/PLAN-fast-lane-trading.md (Flow A).
//
// Run: node tests/gen-cxfer-crosslane-otc-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialOtc } from '../dapp/confidential-otc.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const otcMod = makeConfidentialOtc({ keccak256, pool });

const ASSET_A = '0x' + 'aa'.repeat(32);
const ASSET_B = '0x' + 'bb'.repeat(32);
const MAKER = '0x' + '00'.repeat(31) + '01';
const TAKER = '0x' + '00'.repeat(31) + '02';
const CHAIN_BINDING = '0x' + '11'.repeat(32);

const det = (tag) => BigInt('0x' + keccak256(new TextEncoder().encode('cxfer-crosslane-otc-' + tag)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''));

// ── the OTC, identical in shape to the value-conserving OTC fixture (maker has change, taker exact) ──
const vA = 100, vB = 50, makerIn = 150, takerIn = 50;
const mInR = det('m-in'), tInR = det('t-in');
const mInC = pool.commitXY(BigInt(makerIn), mInR);
const tInC = pool.commitXY(BigInt(takerIn), tInR);
// Both inputs live in ONE tree — a reflected BITCOIN pool root (both legs btcHomed). The membership
// construction is identical to the Ethereum-homed case; only the home lane of the root differs.
const tree = new pool.Tree();
const mIdx = tree.insert(pool.leaf(ASSET_A, mInC.cx, mInC.cy, MAKER));
const tIdx = tree.insert(pool.leaf(ASSET_B, tInC.cx, tInC.cy, TAKER));
const spendRoot = tree.rootAndPath(0).root;

const otc = otcMod.buildOtc({
  assetA: ASSET_A, assetB: ASSET_B, vA, vB, chainBinding: CHAIN_BINDING, spendRoot,
  maker: { owner: MAKER, inAmount: makerIn, inR: mInR, inLeafIndex: mIdx, inPath: tree.rootAndPath(mIdx).path,
           recvR: det('m-recv'), changeR: det('m-change') },
  taker: { owner: TAKER, inAmount: takerIn, inR: tInR, inLeafIndex: tIdx, inPath: tree.rootAndPath(tIdx).path,
           recvR: det('t-recv'), changeR: null },
});
const { nullifiers, leaves } = otcMod.verifyOtc(otc, { merkleRootFrom: pool.merkleRootFrom });

// ── cross-lane: an empty reflected Bitcoin spent set (one sentinel leaf {0 → MAX}); every ν is a
//    non-member through it. A populated set is the same primitive (cxfer-core imt_non_membership). ──
const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
const bytesOf = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const ZERO = beHex(0n), MAX = '0x' + 'ff'.repeat(32);
const imtLeaf = (v, n) => '0x' + Buffer.from(keccak_256(cat([bytesOf(v), bytesOf(n)]))).toString('hex');

const spentTree = new pool.Tree();
spentTree.insert(imtLeaf(ZERO, MAX));
const bitcoinSpentRoot = spentTree.root();
// both legs share the single sentinel non-membership witness (both ν fall strictly inside 0 < ν < MAX)
const nonMember = { lowValue: ZERO, lowNext: MAX, lowIndex: 0, path: spentTree.rootAndPath(0).path };
const big = (h) => BigInt(h.startsWith('0x') ? h : '0x' + h);
for (const nu of nullifiers) {
  if (!(big(nu) > 0n && big(nu) < big(MAX))) throw new Error('nullifier outside the sentinel non-membership gap: ' + nu);
}

const leg = (l) => ({
  inCx: l.in.cx, inCy: l.in.cy, inLeafIndex: l.in.leafIndex, inPath: l.in.path,
  nonMember, // cross-lane: read after this leg's membership + nullifier, before inAmount (main.rs:750/774)
  inAmount: Number(l.in.amount), inSigR: l.in.sig.R, inSigZ: l.in.sig.z,
  hasChange: l.change ? 1 : 0,
  ...(l.change ? { changeCx: l.change.cx, changeCy: l.change.cy, changeSigR: l.change.sig.R, changeSigZ: l.change.sig.z } : {}),
  recvCx: l.recv.cx, recvCy: l.recv.cy, recvSigR: l.recv.sig.R, recvSigZ: l.recv.sig.z,
});

// the ν the contract records in bitcoinConsumed[ν] = spendRoot (the reverse reflection folds each)
const consumed = nullifiers.map((nu) => ({ nullifier: nu, spendRoot }));

const fixture = {
  note: 'one-settle cross-chain ORDERBOOK FILL (OP_OTC) — BOTH legs btcHomed + per-leg cross-lane non-membership + consumed-ν',
  chainBinding: CHAIN_BINDING,
  spendRoot,            // a reflected Bitcoin pool root (both inputs btcHomed)
  bitcoinSpentRoot,     // != 0 → guest runs check_btc_nonmembership per input
  assetA: ASSET_A, assetB: ASSET_B, vA, vB,
  makerOwner: MAKER, takerOwner: TAKER,
  maker: leg(otc.maker), taker: leg(otc.taker),
  deadline: Number(otc.deadline ?? 0),
  expected: {
    nullifiers, leaves,
    consumed, // contract records BOTH in bitcoinConsumed + advances bitcoinConsumedCount by consumed.length
  },
};

const out = 'contracts/sp1/confidential/fixtures/crosslane_otc_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, `— cross-lane ${vA} A ↔ ${vB} B (maker change=${makerIn - vA}, taker exact); ${nullifiers.length} ν, ${leaves.length} leaves · consumed ν: ${consumed.length} · bitcoinSpentRoot set`);
