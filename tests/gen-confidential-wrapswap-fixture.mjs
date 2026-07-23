#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/wrapswap_op.json — a single OP_WRAP_SWAP (op 33) for the box's
// exec-wrapswap harness (OP_FILE=…/wrapswap_op.json).
//
// 1-click swap from an EXTERNAL wallet: one pending PUBLIC deposit is the swap input, and the hidden output
// note is minted in one settle. Same deposit-exactness argument as OP_WRAP_LP — the value is public and
// bound into deposit_id, so there is nothing hidden to conserve and no membership/nullifier/change/kernel.
//
// FEE-SWITCH POOLS ARE OUT OF SCOPE: the guest fails closed on a non-zero protocolFeeBps. OP_SWAP realizes
// the protocol fee per swap by subtracting the recipient's cut from the post reserves; accepting a skim pool
// here WITHOUT skimming would silently divert that cut to the LPs — the same pool behaving differently
// depending on which op the caller used. Those pools route through OP_SWAP.
//
// Run: node tests/gen-confidential-wrapswap-fixture.mjs   [FEE=<u64 on the coarse ladder>]

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialLp } from '../dapp/confidential-lp.js';
import { makeConfidentialRoute } from '../dapp/confidential-route.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const lp = makeConfidentialLp({ keccak256, pool });
const route = makeConfidentialRoute({ keccak256, pool });

let ASSET_A = '0x' + 'aa'.repeat(32);
let ASSET_B = '0x' + 'bb'.repeat(32);
if (BigInt(ASSET_A) > BigInt(ASSET_B)) { const t = ASSET_A; ASSET_A = ASSET_B; ASSET_B = t; } // canonical
const OWNER = '0x' + '00'.repeat(31) + '01';
const CHAIN_BINDING = '0x' + '11'.repeat(32);
const ZERO_RCPT = '0x' + '00'.repeat(33);
const FEE_BPS = 30;

const det = (tag) => BigInt('0x' + keccak256(new TextEncoder().encode('cwsw-fixture-' + tag))
  .reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''));

const RESERVE_A = 1000n, RESERVE_B = 1000n;
const DIRECTION = 0;                        // 0 = A→B (SWAP_DIR_A_TO_B)
const AMOUNT_IN = 100n;                     // == the deposit's public value
const FEE = BigInt(process.env.FEE || 0);   // carved from the input, coarse ladder
const DEADLINE = 0n;

const dBlind = det('deposit'), oBlind = det('out');
const dep = pool.commitXY(AMOUNT_IN, dBlind);

// Curve clearing mirrors the guest: only amountIn − fee swaps.
const swapIn = AMOUNT_IN - FEE;
const [rIn, rOut] = DIRECTION === 0 ? [RESERVE_A, RESERVE_B] : [RESERVE_B, RESERVE_A];
const amountOut = route.getAmountOut(swapIn, rIn, rOut, FEE_BPS);
const MIN_OUT = amountOut; // exact quote
const out = pool.commitXY(amountOut, oBlind);

const pid = lp.poolIdWithProtocolFee(ASSET_A, ASSET_B, FEE_BPS, ZERO_RCPT, 0);
const depId = pool.depositId(DIRECTION === 0 ? ASSET_A : ASSET_B, AMOUNT_IN, dep.cx, dep.cy, OWNER);

const ctx = pool.intentContext('tacit-wrap-swap-v1', CHAIN_BINDING, ASSET_A, ASSET_B,
  [[dep.cx, dep.cy, OWNER], [out.cx, out.cy, OWNER], [depId, pid, OWNER]],
  [BigInt(DIRECTION), AMOUNT_IN, amountOut, MIN_OUT, DEADLINE, FEE]);

const sig = (val, blind, tag) => pool.openingSigma(val, blind, ctx, pool.deriveOpeningNonce(blind, ctx, tag));
const dSig = sig(AMOUNT_IN, dBlind, 'wrap-swap-in');
const oSig = sig(amountOut, oBlind, 'wrap-swap-out');

const fixture = {
  chainBinding: CHAIN_BINDING,
  spendRoot: '0x' + '00'.repeat(32), // no tree notes are spent
  op: 33,
  assetA: ASSET_A, assetB: ASSET_B, feeBps: FEE_BPS,
  protocolFeeBps: 0, protocolFeeRecipient: ZERO_RCPT, // MUST be 0 — the guest fails closed otherwise
  reserveAPre: Number(RESERVE_A), reserveBPre: Number(RESERVE_B),
  direction: DIRECTION,
  amountIn: Number(AMOUNT_IN),
  fee: Number(FEE),
  deposit: { cx: dep.cx, cy: dep.cy, owner: OWNER, sigR: dSig.R, sigZ: dSig.z },
  minOut: Number(MIN_OUT),
  out: { cx: out.cx, cy: out.cy, owner: OWNER, sigR: oSig.R, sigZ: oSig.z },
  opDeadline: Number(DEADLINE),
  expected: { amountOut: Number(amountOut), poolId: pid },
};

const path = 'contracts/sp1/confidential/fixtures/wrapswap_op.json';
writeFileSync(path, JSON.stringify(fixture, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2) + '\n');
console.log('wrote', path, `— deposit ${AMOUNT_IN} (fee ${FEE}) → ${amountOut} out, no intermediate note`);
