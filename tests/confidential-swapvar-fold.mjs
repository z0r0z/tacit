#!/usr/bin/env node
// swap_var (T_SWAP_VAR 0x32) fold — JS mirror of cxfer-core fold_swap_var (C-01 current-price + refund floor).
// Validates: a FRESH swap clears at the current price and onboards the guest-FORMED receipt; a STALE swap (the
// reserves moved past the declared snapshot) still clears at the MOVED price rather than skipping; an
// over-slipped swap (min_out above what the pool clears) REFUNDS the exact input at vout 3 without touching the
// reserves; an EXPIRED intent REFUNDS the same way; and the fail-closed gates still skip (not c0-backed / wrong
// asset / bad kernel / non-P2TR refund dest / empty side). End-to-end guest-digest parity (the byte encodings)
// is confirmed by gen-reflection-swapvar-synth.mjs under reflect-exec. Run: node tests/confidential-swapvar-fold.mjs
//
// Sentinel-change case: the taker's input == delta_in_total (no change). c_in opens to delta_in (blinding r_in);
// the receipt is FORMED by the fold as delta_out'·H + r_receipt·G from delta_out' = get_amount_out(delta_in,
// r_in, r_out, fee_bps) against the CURRENT reserves. The kernel signs with r_in.

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
// x-only Taproot keys of the receipt/change/refund destination outputs (the fold reads them from the tx; here
// we pass them directly). Distinct non-zero keys stand in for real P2TR outputs.
const RECEIPT_AUTH = '0x' + '11'.repeat(32), CHANGE_AUTH = '0x' + '22'.repeat(32), REFUND_AUTH = '0x' + '33'.repeat(32);
const HEIGHT = 100n;
const reserveA = 1000000n, reserveB = 2000000n, deltaIn = 1000n;
const rIn = 0xAAA1n, rReceipt = 0xBBB2n;
// get_amount_out(1000, 1000000, 2000000, fee=0) — what the fold clears a FRESH swap to.
const clearedOut = pool.getAmountOut(deltaIn, reserveA, reserveB, 0);

// Build a fresh seeded state + a swap_var env. c_in (= delta_in, sentinel) and the kernel sig are internally
// consistent; the declared deltaOut/cReceipt are deliberately NOT read by the fold (it FORMS the receipt).
function build({ rA = reserveA, rB = reserveB, dIn = deltaIn, minOut = 0n, expiry = 1000, c0 = true } = {}) {
  const cInXY = pool.commitXY(dIn, rIn);
  const cIn = pool.compressXY(cInXY.cx, cInXY.cy);
  const kernelSig = swapVarKernelSig({ assetHex: ASSET_A, txidHex: seedTxidHex, vout: seedVout, cChangeBytes: SENTINEL, deltaInTotal: dIn, rIn });
  const st = pool.makeScanReflectionState();
  st.setHeight(Number(HEIGHT));
  st.pools.load([{ poolId: POOL_ID, assetA: ASSET_A, assetB: ASSET_B, reserveA: rA.toString(), reserveB: rB.toString(), totalShares: '1000', c0Backed: c0, feeBps: 0, protocolFeeBps: 0, kLast: (rA * rB).toString(), protocolFeeAccrued: '0' }]);
  const inOutpoint = pool.outpointKey(seedTxidHex, seedVout);
  st.foldOutput(pool.leaf(ASSET_A, cInXY.cx, cInXY.cy, ZERO_OWNER), inOutpoint, pool.commitmentHash(cInXY.cx, cInXY.cy), ASSET_A);
  const sv = {
    type: 'swap_var', poolId: POOL_ID, direction: 0,
    rAPre: rA.toString(), rBPre: rB.toString(),
    deltaIn: dIn.toString(), tipAmount: '0', deltaOut: '0', minOut: minOut.toString(), expiryHeight: expiry,
    cIn, cChangeOrSentinel: '0x' + '00'.repeat(33), cReceipt: '0x' + '00'.repeat(33),
    rReceipt: '0x' + Buffer.from(be(rReceipt, 32)).toString('hex'),
    kernelSig: '0x' + Buffer.from(kernelSig).toString('hex'),
  };
  return {
    st, sv,
    receiptOutpoint: pool.outpointKey(RECEIPT_TXID, 1),
    changeOutpoint: pool.outpointKey(RECEIPT_TXID, 2),
    refundOutpoint: pool.outpointKey(RECEIPT_TXID, 3),
    cIn, cInXY,
  };
}
const doFold = (ctx, o = {}) => ctx.st.foldSwapVar(
  ctx.sv, [seedTxidHex, seedVout], o.asset || ASSET_A, ctx.receiptOutpoint, ctx.changeOutpoint, ctx.refundOutpoint,
  o.receiptAuth !== undefined ? o.receiptAuth : RECEIPT_AUTH,
  o.changeAuth !== undefined ? o.changeAuth : CHANGE_AUTH,
  o.refundAuth !== undefined ? o.refundAuth : REFUND_AUTH,
  o.height !== undefined ? o.height : HEIGHT);

// ── FRESH clear: onboard the guest-FORMED receipt, advance reserves by (delta_in, cleared_out) ──
{
  const ctx = build();
  const noteBefore = ctx.st.counts().note;
  const g0 = ctx.st.digest();
  const w = doFold(ctx);
  ok(w && w.notePath, 'fresh swap folds (returns the receipt note-path witness)');
  eq(ctx.st.counts().note, noteBefore + 1, 'receipt note onboarded to the tree');
  const p = ctx.st.pools.get(POOL_ID);
  eq(BigInt(p.reserveA), reserveA + deltaIn, 'reserve_in advanced by delta_in');
  eq(BigInt(p.reserveB), reserveB - clearedOut, 'reserve_out reduced by the cleared amount');
  // The onboarded leaf is the btc-note leaf of the FORMED receipt (delta_out'·H + r_receipt·G) at receiptAuth.
  const rc = pool.commitXY(clearedOut, rReceipt);
  const expLeaf = pool.btcNoteLeaf(ASSET_B, rc.cx, rc.cy, RECEIPT_AUTH);
  ok(ctx.st._acc.notes.leaves.some((l) => pool.hx(l).toLowerCase() === expLeaf.toLowerCase()), 'onboarded leaf == FORMED receipt at the vout-1 key');
  ok(ctx.st.digest() !== g0, 'digest advanced');
}

// ── determinism ──
{
  const a = build(), b = build();
  doFold(a); doFold(b);
  eq(a.st.digest(), b.st.digest(), 'deterministic: same swap → same digest');
}

// ── STALE (reserves moved past the declared snapshot, min_out still met) → clears at the MOVED price ──
{
  // Declared snapshot is the fresh reserves, but the pool has ADVANCED (a concurrent swap). The fold prices
  // against the current reserves and still onboards a receipt (closes C-01: no skip-and-strand).
  const movedA = reserveA + 500000n, movedB = reserveB - 900000n;
  const ctx = build({ rA: movedA, rB: movedB, minOut: 0n });
  const noteBefore = ctx.st.counts().note;
  const w = doFold(ctx);
  ok(w && w.notePath, 'stale swap still folds a receipt (current-price clearing)');
  eq(ctx.st.counts().note, noteBefore + 1, 'stale: receipt onboarded (not skipped)');
  const out = pool.getAmountOut(deltaIn, movedA, movedB, 0);
  const p = ctx.st.pools.get(POOL_ID);
  eq(BigInt(p.reserveB), movedB - out, 'stale: reserves advance from the CURRENT price');
}

// ── over-slippage → REFUND the exact input at vout 3, reserves untouched ──
{
  const ctx = build({ minOut: clearedOut + 1n });   // ask for more than the pool clears
  const noteBefore = ctx.st.counts().note;
  const reservesBefore = JSON.stringify([ctx.st.pools.get(POOL_ID).reserveA + '', ctx.st.pools.get(POOL_ID).reserveB + '']);
  const w = doFold(ctx);
  ok(w && w.notePath, 'over-slippage refunds (returns a note-path, not null)');
  eq(ctx.st.counts().note, noteBefore + 1, 'over-slippage: refund note onboarded');
  eq(JSON.stringify([ctx.st.pools.get(POOL_ID).reserveA + '', ctx.st.pools.get(POOL_ID).reserveB + '']), reservesBefore, 'over-slippage: reserves untouched');
  // The refund note commits the input's EXACT (Cx,Cy) on the INPUT asset at the vout-3 key.
  const refundLeaf = pool.btcNoteLeaf(ASSET_A, ctx.cInXY.cx, ctx.cInXY.cy, REFUND_AUTH);
  ok(ctx.st._acc.notes.leaves.some((l) => pool.hx(l).toLowerCase() === refundLeaf.toLowerCase()), 'over-slippage: refund leaf == input commitment at the vout-3 key');
}

// ── EXPIRED (expiry < height) → REFUND, reserves untouched ──
{
  const ctx = build({ expiry: Number(HEIGHT) - 1 });
  const noteBefore = ctx.st.counts().note;
  const reservesBefore = JSON.stringify([ctx.st.pools.get(POOL_ID).reserveA + '', ctx.st.pools.get(POOL_ID).reserveB + '']);
  const w = doFold(ctx);
  ok(w && w.notePath, 'expired intent refunds');
  eq(ctx.st.counts().note, noteBefore + 1, 'expired: refund note onboarded');
  eq(JSON.stringify([ctx.st.pools.get(POOL_ID).reserveA + '', ctx.st.pools.get(POOL_ID).reserveB + '']), reservesBefore, 'expired: reserves untouched');
  const refundLeaf = pool.btcNoteLeaf(ASSET_A, ctx.cInXY.cx, ctx.cInXY.cy, REFUND_AUTH);
  ok(ctx.st._acc.notes.leaves.some((l) => pool.hx(l).toLowerCase() === refundLeaf.toLowerCase()), 'expired: refund leaf == input commitment at the vout-3 key');
}
// expiry == 0 also refunds (never read as "unlimited").
{
  const ctx = build({ expiry: 0 });
  const noteBefore = ctx.st.counts().note;
  const w = doFold(ctx);
  ok(w && ctx.st.counts().note === noteBefore + 1, 'zero-expiry intent refunds (not unlimited)');
}

// ── fail-closed gates (each on a fresh state; null = skip; assert NO mutation) ──
const rejects = (label, mutate, foldOpts) => {
  const ctx = build();
  if (mutate) mutate(ctx);
  const noteBefore = ctx.st.counts().note;
  const reservesBefore = JSON.stringify([ctx.st.pools.get(POOL_ID).reserveA + '', ctx.st.pools.get(POOL_ID).reserveB + '']);
  eq(doFold(ctx, foldOpts || {}), null, label + ' → skip');
  eq(ctx.st.counts().note, noteBefore, label + ': no note onboarded');
  eq(JSON.stringify([ctx.st.pools.get(POOL_ID).reserveA + '', ctx.st.pools.get(POOL_ID).reserveB + '']), reservesBefore, label + ': reserves unchanged');
};
rejects('not c0-backed', (c) => { const p = c.st.pools.get(POOL_ID); p.c0Backed = false; c.st.pools.set(POOL_ID, p); });
rejects('tampered kernel sig', (c) => { c.sv.kernelSig = '0x' + 'de'.repeat(64); });
rejects('non-P2TR refund dest (zero auth)', null, { refundAuth: null });
rejects('non-P2TR receipt dest (zero auth)', null, { receiptAuth: null });
rejects('input asset != pool in-side asset', null, { asset: ASSET_B });
// empty side (reserve_in == 0) has no price → skip rather than degenerate.
rejects('empty in-side reserve', (c) => { c.sv.rAPre = '0'; const p = c.st.pools.get(POOL_ID); p.reserveA = '0'; c.st.pools.set(POOL_ID, p); });

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
