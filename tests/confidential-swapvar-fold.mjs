#!/usr/bin/env node
// swap_var (T_SWAP_VAR 0x32) fold — JS mirror of cxfer-core fold_swap_var. Validates the fold LOGIC + GATES
// (accept a valid swap against a c0-backed pool; reject reserve-mismatch / wrong-asset / not-c0-backed /
// zero-out / drain / bad-kernel / bad-receipt-opening) + the reserve advance + JS determinism. End-to-end
// guest-digest parity (the kernel/receipt byte encodings) is confirmed by gen-reflection-swapvar-synth.mjs
// under reflect-exec. Run: node tests/confidential-swapvar-fold.mjs
//
// Sentinel-change case: the taker's input == delta_in_total (no change). c_in opens to delta_in (blinding
// r_in); c_receipt opens to the PUBLIC delta_out (blinding r_receipt). The kernel signs with r_in.

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { swapVarKernelSig } from './_swapvar-kernel.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

const ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32), POOL_ID = '0x' + '99'.repeat(32);
const ZERO_OWNER = '0x' + '00'.repeat(32);
const SENTINEL = Buffer.alloc(33);
const seedTxidHex = '0x' + '77'.repeat(32), seedVout = 0;
const RECEIPT_TXID = '0x' + '55'.repeat(32);
const reserveA = 1000000n, reserveB = 2000000n, deltaIn = 1000n, deltaOut = 1990n;
const rIn = 0xAAA1n, rReceipt = 0xBBB2n;

// Build a fresh seeded state + the swap_var env for the given reserves/deltas. c_in (= delta_in, sentinel),
// c_receipt (= delta_out), and the kernel sig are all internally consistent, so only the field under test
// breaks a gate. The taker's input note is seeded live at seedTxid:seedVout (asset_a).
function build({ rA = reserveA, rB = reserveB, dIn = deltaIn, dOut = deltaOut, c0 = true } = {}) {
  const cInXY = pool.commitXY(dIn, rIn);
  const cIn = pool.compressXY(cInXY.cx, cInXY.cy);
  const cReceiptXY = pool.commitXY(dOut, rReceipt);
  const cReceipt = pool.compressXY(cReceiptXY.cx, cReceiptXY.cy);
  const kernelSig = swapVarKernelSig({ assetHex: ASSET_A, txidHex: seedTxidHex, vout: seedVout, cChangeBytes: SENTINEL, deltaInTotal: dIn, rIn });
  const st = pool.makeScanReflectionState();
  st.setHeight(100);
  st.pools.load([{ poolId: POOL_ID, assetA: ASSET_A, assetB: ASSET_B, reserveA: rA.toString(), reserveB: rB.toString(), totalShares: '1000', c0Backed: c0, protocolFeeBps: 0, kLast: (rA * rB).toString(), protocolFeeAccrued: '0' }]);
  const inOutpoint = pool.outpointKey(seedTxidHex, seedVout);
  st.foldOutput(pool.leaf(ASSET_A, cInXY.cx, cInXY.cy, ZERO_OWNER), inOutpoint, pool.commitmentHash(cInXY.cx, cInXY.cy), ASSET_A);
  const sv = {
    type: 'swap_var', poolId: POOL_ID, direction: 0,
    rAPre: rA.toString(), rBPre: rB.toString(),
    deltaIn: dIn.toString(), tipAmount: '0', deltaOut: dOut.toString(),
    cIn, cChangeOrSentinel: '0x' + '00'.repeat(33), cReceipt,
    rReceipt: '0x' + Buffer.from(be(rReceipt, 32)).toString('hex'),
    kernelSig: '0x' + Buffer.from(kernelSig).toString('hex'),
  };
  return { st, sv, receiptOutpoint: pool.outpointKey(RECEIPT_TXID, 1) };
}
const doFold = ({ st, sv, receiptOutpoint }) => st.foldSwapVar(sv, [seedTxidHex, seedVout], ASSET_A, receiptOutpoint);

// ── accept ──
{
  const ctx = build();
  const noteBefore = ctx.st.counts().note;
  const g0 = ctx.st.digest();
  const w = doFold(ctx);
  ok(w && w.notePath, 'valid swap folds (returns the receipt note-path witness)');
  eq(ctx.st.counts().note, noteBefore + 1, 'receipt note onboarded to the tree');
  const p = ctx.st.pools.get(POOL_ID);
  eq(BigInt(p.reserveA), reserveA + deltaIn, 'reserve_in advanced by delta_in');
  eq(BigInt(p.reserveB), reserveB - deltaOut, 'reserve_out reduced by delta_out');
  ok(ctx.st.digest() !== g0, 'digest advanced');
}

// ── determinism (JS self-consistency) ──
{
  const a = build(), b = build();
  doFold(a); doFold(b);
  eq(a.st.digest(), b.st.digest(), 'deterministic: same swap → same digest');
}

// ── gates reject (each on a fresh state; null = skip; assert NO mutation) ──
const rejects = (label, mutate) => {
  const ctx = build();
  if (mutate) mutate(ctx);
  const noteBefore = ctx.st.counts().note;
  const reservesBefore = JSON.stringify([ctx.st.pools.get(POOL_ID).reserveA + '', ctx.st.pools.get(POOL_ID).reserveB + '']);
  eq(doFold(ctx), null, label + ' → skip');
  eq(ctx.st.counts().note, noteBefore, label + ': no note onboarded');
  eq(JSON.stringify([ctx.st.pools.get(POOL_ID).reserveA + '', ctx.st.pools.get(POOL_ID).reserveB + '']), reservesBefore, label + ': reserves unchanged');
};
rejects('reserve mismatch (R_a_pre wrong)', (c) => { c.sv.rAPre = (reserveA + 1n).toString(); });
rejects('not c0-backed', (c) => { const p = c.st.pools.get(POOL_ID); p.c0Backed = false; c.st.pools.set(POOL_ID, p); });
rejects('zero delta_out', (c) => { c.sv.deltaOut = '0'; });
rejects('tampered kernel sig', (c) => { c.sv.kernelSig = '0x' + 'de'.repeat(64); });
rejects('tampered receipt blinding (opening fails)', (c) => { c.sv.rReceipt = '0x' + 'cd'.repeat(32); });

// wrong input asset: the detected spend's asset != the pool's in-side asset.
{
  const ctx = build();
  const noteBefore = ctx.st.counts().note;
  eq(ctx.st.foldSwapVar(ctx.sv, [seedTxidHex, seedVout], ASSET_B, ctx.receiptOutpoint), null, 'input asset != pool in-side asset → skip');
  eq(ctx.st.counts().note, noteBefore, 'wrong-asset: no note onboarded');
}

// drain: delta_out > the out-side reserve (valid kernel + opening, but the swap would over-pay the pool).
{
  const ctx = build({ rB: 100n, dOut: 1990n });   // c_receipt opens to 1990 > reserve_b (100)
  const noteBefore = ctx.st.counts().note;
  eq(doFold(ctx), null, 'delta_out > reserve_out → skip (no pool drain)');
  eq(ctx.st.counts().note, noteBefore, 'drain: no note onboarded');
}

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
