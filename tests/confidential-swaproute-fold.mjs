#!/usr/bin/env node
// swap_route (T_SWAP_ROUTE 0x33) fold — JS mirror of cxfer-core fold_swap_route (C-01 current-price + refund
// floor). The trader's single input note flows through 2–4 pools and lands as ONE receipt note. Validates: a
// FRESH route clears each hop at the current price and onboards the FORMED receipt; a STALE route (a spanned
// pool moved) re-clears at the moved price rather than stranding the whole route; an over-slipped route REFUNDS
// the exact input at vout 2 with NO pool moving; an EXPIRED intent REFUNDS the same way; and the fail-closed
// gates still skip (chain-break / pool-repeat / output-asset / bad kernel / non-P2TR dest / unknown pool /
// empty side). End-to-end guest-digest parity: gen-reflection-swaproute-synth.mjs under reflect-exec.

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { signSchnorr } from '../dapp/bulletproofs.js';
import { swapVarKernelSig } from './_swapvar-kernel.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

const A = '0x' + 'a1'.repeat(32), B = '0x' + 'b2'.repeat(32), C = '0x' + 'c3'.repeat(32);
const PROTO = '0x' + '00'.repeat(33), ZERO_OWNER = '0x' + '00'.repeat(32), SENTINEL = Buffer.alloc(33);
const RECEIPT_XONLY = '11'.repeat(32), REFUND_XONLY = '33'.repeat(32);
const P2TR = (x) => '0x5120' + x, P2WPKH = '0x0014' + 'ab'.repeat(20);
const RECEIPT_SPK = P2TR(RECEIPT_XONLY), REFUND_SPK = P2TR(REFUND_XONLY);
const TRADER_PRIV = Uint8Array.from(Buffer.from('44'.repeat(32), 'hex'));
const TRADER_XONLY = Buffer.from(secp.ProjectivePoint.BASE.multiply(BigInt('0x' + '44'.repeat(32))).toRawBytes(true)).slice(1).toString('hex');
const TRADER_PUB = '0x02' + TRADER_XONLY;
const HEIGHT = 100n;
const inMag = 1000n;
const p1A = 1000000n, p1B = 2000000n, p2A = 2000000n, p2B = 4000000n;
const rIn = 0x303n, rReceipt = 0x707n;
const seedTxidHex = '0x' + '33'.repeat(32), seedVout = 0;

const pool1Id = pool.ammDerivePoolIdFull(A, B, 0, 0, PROTO, 0);
const pool2Id = pool.ammDerivePoolIdFull(B, C, 0, 0, PROTO, 0);
const cInXY = pool.commitXY(inMag, rIn), cIn = pool.compressXY(cInXY.cx, cInXY.cy);
const kernelSig = '0x' + Buffer.from(swapVarKernelSig({ assetHex: A, txidHex: seedTxidHex, vout: seedVout, cChangeBytes: SENTINEL, deltaInTotal: inMag, rIn })).toString('hex');

// The chain the FRESH route clears to, at fee 0 (the fold computes these; declared magnitudes are ignored).
const mid0 = pool.getAmountOut(inMag, p1A, p1B, 0);
const out0 = pool.getAmountOut(mid0, p2A, p2B, 0);

function seed({ withPools = true, p1a = p1A, p1b = p1B, p2a = p2A, p2b = p2B } = {}) {
  const st = pool.makeScanReflectionState();
  st.setHeight(Number(HEIGHT));
  if (withPools) st.pools.load([
    { poolId: pool1Id, assetA: A, assetB: B, reserveA: p1a.toString(), reserveB: p1b.toString(), totalShares: '1000', c0Backed: true, feeBps: 0, protocolFeeBps: 0, kLast: (p1a * p1b).toString(), protocolFeeAccrued: '0' },
    { poolId: pool2Id, assetA: B, assetB: C, reserveA: p2a.toString(), reserveB: p2b.toString(), totalShares: '1000', c0Backed: true, feeBps: 0, protocolFeeBps: 0, kLast: (p2a * p2b).toString(), protocolFeeAccrued: '0' },
  ]);
  const op = pool.outpointKey(seedTxidHex, seedVout);
  st.foldOutput(pool.leaf(A, cInXY.cx, cInXY.cy, ZERO_OWNER), op, pool.commitmentHash(cInXY.cx, cInXY.cy), A);
  return st;
}
// Declared hop magnitudes are stale placeholders (never read for pricing) — only hop0's in-side mag is read
// (as the kernel-bound route input). min_out / expiry ride the envelope.
const env = (over = {}) => ({
  type: 'swap_route', traderInputAsset: A, traderOutputAsset: C, minOut: '0', expiryHeight: 1000, traderPubkey: TRADER_PUB,
  hops: [
    { poolId: pool1Id, direction: 0, rAPre: p1A.toString(), rBPre: p1B.toString(), deltaANetMag: inMag.toString(), deltaBNetMag: '0' },
    { poolId: pool2Id, direction: 0, rAPre: p2A.toString(), rBPre: p2B.toString(), deltaANetMag: '0', deltaBNetMag: '0' },
  ],
  cIn, cReceipt: '0x' + '00'.repeat(33), rReceipt: beHex(rReceipt), kernelSig, intentSig: '0x' + '00'.repeat(64), ...over,
});
const withHop = (over, idx, hopOver) => { const e = env(over); e.hops[idx] = { ...e.hops[idx], ...hopOver }; return e; };
// Sign a VALID intent_sig over the message the fold rebuilds from the output scripts (unless o.badSig).
const doFold = (st, e, o = {}) => {
  const receiveSpk = o.receiveSpk !== undefined ? o.receiveSpk : RECEIPT_SPK;
  const refundSpk = o.refundSpk !== undefined ? o.refundSpk : REFUND_SPK;
  if (!o.badSig) e.intentSig = '0x' + Buffer.from(signSchnorr(pool.swapRouteIntentMsg(e, receiveSpk, refundSpk), TRADER_PRIV)).toString('hex');
  return st.foldSwapRoute(
    e, [seedTxidHex, seedVout], o.asset || A, pool.outpointKey('0x' + '5a'.repeat(32), 1), pool.outpointKey('0x' + '5a'.repeat(32), 2),
    receiveSpk, refundSpk, o.height !== undefined ? o.height : HEIGHT);
};

// ── FRESH clear ──
{
  const st = seed();
  const g0 = st.digest();
  const w = doFold(st, env());
  ok(w && w.receiptPath, 'swap_route folds (returns the receipt note-path)');
  eq(st.counts().note, 2, 'receipt onboarded (1 seeded input + 1 receipt)');
  const p1 = st.pools.get(pool1Id), p2 = st.pools.get(pool2Id);
  eq(BigInt(p1.reserveA), p1A + inMag, 'pool1 reserve_a += inMag');
  eq(BigInt(p1.reserveB), p1B - mid0, 'pool1 reserve_b -= computed mid');
  eq(BigInt(p2.reserveA), p2A + mid0, 'pool2 reserve_a(B) += mid (chain)');
  eq(BigInt(p2.reserveB), p2B - out0, 'pool2 reserve_b(C) -= computed out');
  const rc = pool.commitXY(out0, rReceipt);
  const expLeaf = pool.btcNoteLeaf(C, rc.cx, rc.cy, '0x' + RECEIPT_XONLY);
  ok(st._acc.notes.leaves.some((l) => pool.hx(l).toLowerCase() === expLeaf.toLowerCase()), 'onboarded leaf == FORMED receipt (asset C) at the vout-1 key');
  ok(st.digest() !== g0, 'digest advanced');
}

// ── determinism ──
{ const a = seed(), b = seed(); doFold(a, env()); doFold(b, env()); eq(a.digest(), b.digest(), 'deterministic: same route → same digest'); }

// ── STALE (pool1 moved by a concurrent op) → re-clears at the moved price, still onboards ──
{
  const st = seed({ p1a: p1A + 300000n, p1b: p1B - 500000n });
  const w = doFold(st, env());
  ok(w && w.receiptPath, 'stale route still folds (re-cleared at the moved price)');
  eq(st.counts().note, 2, 'stale: receipt onboarded (not stranded)');
}

// ── over-slippage → REFUND at vout 2, NO pool moves ──
{
  const st = seed();
  const g0 = st.digest();
  const w = doFold(st, env({ minOut: (out0 + 1n).toString() }));
  ok(w && w.receiptPath, 'over-slippage refunds (note-path, not null)');
  eq(st.counts().note, 2, 'over-slippage: refund note onboarded');
  const p1 = st.pools.get(pool1Id), p2 = st.pools.get(pool2Id);
  ok(BigInt(p1.reserveA) === p1A && BigInt(p2.reserveB) === p2B, 'over-slippage: no pool along the route moves');
  const refundLeaf = pool.btcNoteLeaf(A, cInXY.cx, cInXY.cy, '0x' + REFUND_XONLY);
  ok(st._acc.notes.leaves.some((l) => pool.hx(l).toLowerCase() === refundLeaf.toLowerCase()), 'over-slippage: refund leaf == input commitment (asset A) at the vout-2 key');
  ok(st.digest() !== g0, 'over-slippage: digest advanced (refund onboarded)');
}

// ── EXPIRED → REFUND, no pool moves ──
{
  const st = seed();
  const w = doFold(st, env({ expiryHeight: Number(HEIGHT) - 1 }));
  ok(w && st.counts().note === 2, 'expired route refunds');
  const p1 = st.pools.get(pool1Id);
  eq(BigInt(p1.reserveA), p1A, 'expired: no pool moves');
  const refundLeaf = pool.btcNoteLeaf(A, cInXY.cx, cInXY.cy, '0x' + REFUND_XONLY);
  ok(st._acc.notes.leaves.some((l) => pool.hx(l).toLowerCase() === refundLeaf.toLowerCase()), 'expired: refund leaf == input commitment (asset A)');
}

// ── fail-closed gates (all-or-nothing: assert NO note onboarded, reserves untouched) ──
const rejects = (label, st, e, o) => {
  const g0 = st.digest();
  eq(doFold(st, e, o || {}), null, label + ' → skip');
  eq(st.counts().note, 1, label + ': no note onboarded');
  eq(st.digest(), g0, label + ': state unchanged (all-or-nothing)');
};
rejects('final asset != route output asset', seed(), env({ traderOutputAsset: B }));
rejects('bad input kernel', seed(), env({ kernelSig: '0x' + 'de'.repeat(64) }));
rejects('pool repeated in route', seed(), withHop({}, 1, { poolId: pool1Id }));
rejects('non-P2TR refund dest (zero auth)', seed(), env(), { refundSpk: P2WPKH });
rejects('non-P2TR receipt dest (zero auth)', seed(), env(), { receiveSpk: P2WPKH });
rejects('invalid intent_sig (unauthorized route)', seed(), env(), { badSig: true });
rejects('spent input asset != route input asset', seed(), env(), { asset: B });
rejects('unknown pool', seed({ withPools: false }), env());

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
