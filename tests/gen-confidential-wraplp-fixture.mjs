#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/wraplp_op.json — a single OP_WRAP_LP (op 32) for the box's
// exec-wraplp harness (OP_FILE=…/wraplp_op.json).
//
// 1-click liquidity from an EXTERNAL wallet: two pending PUBLIC deposits become the A/B contributions and
// the shielded LP-share note is minted in one settle. No tree notes are spent, so there is no membership,
// no nullifier and no change — a deposit's value is EXACT and public (bound into its deposit_id, which the
// contract independently gates on `depositStatus == 1`). That exactness is precisely what removes the
// intermediate note: one transaction instead of wrap, wrap, add, and one fewer linkable note.
//
// The shared ctx binds BOTH deposits, the minted share note and the pool identity, so a relay can neither
// redirect the position nor settle it against a different pool/tier. `d_shares` is DERIVED in-guest (the min
// rule), never witnessed, so it cannot be over-claimed.
//
// Run: node tests/gen-confidential-wraplp-fixture.mjs   [FEE=<u64 on the coarse ladder>]

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialLp } from '../dapp/confidential-lp.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const _ct = makeConfidentialTransfer({ keccak256 });
const lp = makeConfidentialLp({ keccak256, pool, kernelSign: _ct.kernelSign, rangeProve: _ct.rangeProve });

let ASSET_A = '0x' + 'aa'.repeat(32);
let ASSET_B = '0x' + 'bb'.repeat(32);
if (BigInt(ASSET_A) > BigInt(ASSET_B)) { const t = ASSET_A; ASSET_A = ASSET_B; ASSET_B = t; } // canonical
const OWNER = '0x' + '00'.repeat(31) + '01';
const CHAIN_BINDING = '0x' + '11'.repeat(32);
const ZERO_RCPT = '0x' + '00'.repeat(33);
const FEE_BPS = 30;

const det = (tag) => BigInt('0x' + keccak256(new TextEncoder().encode('cwlp-fixture-' + tag))
  .reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''));

const RESERVE_A = 1000n, RESERVE_B = 2000n, SHARES_PRE = 1000n;
const D_A = 100n, D_B = 200n;                 // the two deposit values (public)
const FEE = BigInt(process.env.FEE || 0);     // carved from the A contribution
const DEADLINE = 0n;

const aBlind = det('depA'), bBlind = det('depB'), sBlind = det('share');
const a = pool.commitXY(D_A, aBlind);
const b = pool.commitXY(D_B, bBlind);

// d_shares mirrors the guest exactly (fee carved off A before the share math).
const addA = D_A - FEE;
const dShares = lp.lpAddShares(SHARES_PRE, addA, D_B, RESERVE_A, RESERVE_B);
if (dShares <= 0n) throw new Error('wrap-lp: contribution below one share');
const s = pool.commitXY(dShares, sBlind);

const pid = lp.poolIdWithProtocolFee(ASSET_A, ASSET_B, FEE_BPS, ZERO_RCPT, 0);
const lpAsset = lp.lpShareId(pid);

// Shared ctx: both deposits + the minted share note + the pool identity.
const ctx = pool.intentContext('tacit-wrap-lp-v1', CHAIN_BINDING, ASSET_A, ASSET_B,
  [[a.cx, a.cy, OWNER], [b.cx, b.cy, OWNER], [s.cx, s.cy, OWNER], [lpAsset, pid, OWNER]],
  [D_A, D_B, dShares, DEADLINE, FEE]);

const sig = (val, blind, tag) => pool.openingSigma(val, blind, ctx, pool.deriveOpeningNonce(blind, ctx, tag));
const aSig = sig(D_A, aBlind, 'wrap-lp-a');
const bSig = sig(D_B, bBlind, 'wrap-lp-b');
const sSig = sig(dShares, sBlind, 'wrap-lp-share');

const fixture = {
  chainBinding: CHAIN_BINDING,
  spendRoot: '0x' + '00'.repeat(32), // no tree notes are spent
  op: 32,
  assetA: ASSET_A, assetB: ASSET_B, feeBps: FEE_BPS,
  protocolFeeBps: 0, protocolFeeRecipient: ZERO_RCPT,
  reserveAPre: Number(RESERVE_A), reserveBPre: Number(RESERVE_B), sharesPre: Number(SHARES_PRE),
  a: { value: Number(D_A), cx: a.cx, cy: a.cy, owner: OWNER, sigR: aSig.R, sigZ: aSig.z },
  b: { value: Number(D_B), cx: b.cx, cy: b.cy, owner: OWNER, sigR: bSig.R, sigZ: bSig.z },
  share: { cx: s.cx, cy: s.cy, owner: OWNER, sigR: sSig.R, sigZ: sSig.z },
  opDeadline: Number(DEADLINE),
  fee: Number(FEE),
  expected: { dShares: Number(dShares), poolId: pid, lpAsset },
};

const out = 'contracts/sp1/confidential/fixtures/wraplp_op.json';
writeFileSync(out, JSON.stringify(fixture, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2) + '\n');
console.log('wrote', out, `— deposits ${D_A}A/${D_B}B (fee ${FEE}) → ${dShares} LP shares, no intermediate note`);
