#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/lp_remove_op.json — a single OP_LP_REMOVE for the box's
// exec-lpremove harness. Pool 1100 A / 2200 B / 1100 shares; burn 100 shares ⇒ withdraw 100 A + 200 B.
//
// PARTIAL WITHDRAWALS: the share note may hold MORE than the shares burned; the remainder returns as an
// LP-share change note in the same settle. Set SHARE_HELD > BURN to exercise that path (the default holds
// exactly the burn, reproducing the old whole-note remove). The change count must be a legal BP+
// aggregation size {0,1,2,4,8} — the guest asserts it.
//
// Run: node tests/gen-confidential-lpremove-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialLp } from '../dapp/confidential-lp.js';
const _ptHexK = (P) => (typeof P === 'string' ? P : '0x' + Buffer.from(P.toRawBytes(true)).toString('hex'));
const _scHexK = (v) => (typeof v === 'string' ? v : '0x' + BigInt(v).toString(16).padStart(64, '0'));

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const _ct = makeConfidentialTransfer({ keccak256 });
const lp = makeConfidentialLp({ keccak256, pool, kernelSign: _ct.kernelSign, rangeProve: _ct.rangeProve });

const ASSET_A = '0x' + 'aa'.repeat(32);
const ASSET_B = '0x' + 'bb'.repeat(32);
const OWNER = '0x' + '00'.repeat(31) + '01';
const CHAIN_BINDING = '0x' + '11'.repeat(32);
const FEE_BPS = 30;
const ZERO_RCPT = '0x' + '00'.repeat(33);

const det = (tag) => BigInt('0x' + keccak256(new TextEncoder().encode('clpr-fixture-' + tag))
  .reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''));

const RESERVE_A = 1100n, RESERVE_B = 2200n, SHARES_PRE = 1100n;
const BURN = BigInt(process.env.BURN || 100);
const SHARE_HELD = BigInt(process.env.SHARE_HELD || BURN); // > BURN exercises the partial path
const FEE = BigInt(process.env.FEE || 0);

const rShares = det('share');
const rA = det('outA'), rB = det('outB');
const rChange = det('change');
const shareChangeVal = SHARE_HELD - BURN;

const pid = lp.poolIdWithProtocolFee(ASSET_A, ASSET_B, FEE_BPS, ZERO_RCPT, 0);
const lpAsset = lp.lpShareId(pid);
// The share note commits its FULL holding (burn + change); membership is proven against that leaf.
const shareC = pool.commitXY(SHARE_HELD, rShares);
const tree = new pool.Tree();
const index = tree.insert(pool.leaf(lpAsset, shareC.cx, shareC.cy, OWNER));
const { root: spendRoot, path } = tree.rootAndPath(index);

const op = lp.buildRemove({
  assetA: ASSET_A, assetB: ASSET_B, chainBinding: CHAIN_BINDING, feeBps: FEE_BPS,
  reserveAPre: RESERVE_A, reserveBPre: RESERVE_B, sharesPre: SHARES_PRE,
  shareNote: { owner: OWNER, leafIndex: index, path },
  dShares: BURN, rShares,
  aOwner: OWNER, rA, bOwner: OWNER, rB,
  deadline: 0n, fee: FEE,
  shareChange: shareChangeVal > 0n ? [{ value: shareChangeVal, blinding: rChange, owner: OWNER }] : [],
});
op.spendRoot = spendRoot;

const fixture = {
  chainBinding: CHAIN_BINDING,
  spendRoot,
  op: 8, // OP_LP_REMOVE
  assetA: ASSET_A, assetB: ASSET_B, feeBps: FEE_BPS, protocolFeeBps: 0, protocolFeeRecipient: ZERO_RCPT,
  reserveAPre: Number(RESERVE_A), reserveBPre: Number(RESERVE_B), sharesPre: Number(SHARES_PRE),
  share: {
    cx: shareC.cx, cy: shareC.cy, owner: OWNER, leafIndex: index, path,
    dShares: Number(BURN),
    // Value-HIDING PoK: the note may exceed the shares burned.
    pokR: op.sPok.R, pokZv: op.sPok.zV, pokZr: op.sPok.zR,
  },
  dA: Number(op.dA), remA: Number(op.remA), dB: Number(op.dB), remB: Number(op.remB),
  a: { cx: op.a.cx, cy: op.a.cy, owner: OWNER, sigR: op.aSig.R, sigZ: op.aSig.z },
  b: { cx: op.b.cx, cy: op.b.cy, owner: OWNER, sigR: op.bSig.R, sigZ: op.bSig.z },
  deadline: 0, fee: Number(FEE),
  // LP-share change returned to the provider (built under the pool's own lp_asset, never witnessed).
  shareChange: (op.shareChange || []).map((c) => ({ cx: c.cx, cy: c.cy, owner: c.owner })),
  ...(op.changeRangeProof ? { changeRangeProof: op.changeRangeProof } : {}),
  shareKernelR: _ptHexK(op.shareKernel.R), shareKernelZ: _scHexK(op.shareKernel.z),
};

const out = 'contracts/sp1/confidential/fixtures/lp_remove_op.json';
writeFileSync(out, JSON.stringify(fixture, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2) + '\n');
console.log('wrote', out, `— burn ${BURN} of ${SHARE_HELD} shares, change ${shareChangeVal}`);
