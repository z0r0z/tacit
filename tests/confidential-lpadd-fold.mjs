#!/usr/bin/env node
// lp_add / POOL_INIT (T_LP_ADD 0x2D) fold — JS mirror of cxfer-core fold_lp_add + fold_lp_share_mint. The LP's
// per-asset detected spends fund a pool (variant 1 = POOL_INIT, insert at isqrt(Δa·Δb); variant 0 = LP-add,
// grow by the proportional mint), each side proven by its kernel; the minted LP-share note is onboarded.
// Validates POOL_INIT accept + variant-0 grow + gates (already-registered / unknown-pool / bad-kernel /
// tampered-share) + determinism + a Rust↔JS pool_id-domain pin. Guest-digest parity: gen-reflection-lp-poolinit
// (POOL_INIT) + gen-reflection-lp-add (variant-0 add-to-existing).

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { lpAddKernelSig } from './_swapvar-kernel.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

const ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32), PROTO_FEE_ADDR = '0x' + '00'.repeat(33), ZERO_OWNER = '0x' + '00'.repeat(32);
const deltaA = 4000n, deltaB = 9000n, rA = 0xAA01n, rB = 0xBB01n, shareR = 0x5555n;
const poolId = pool.ammDerivePoolIdFull(ASSET_A, ASSET_B, 0, 0, PROTO_FEE_ADDR, 0);
const totalShares = pool.isqrt(deltaA * deltaB), lpShares = totalShares - pool.AMM_MINIMUM_LIQUIDITY; // 6000, 5000
const seedAHex = '0x' + '1a'.repeat(32), seedBHex = '0x' + '1b'.repeat(32);
const cAxy = pool.commitXY(deltaA, rA), cBxy = pool.commitXY(deltaB, rB);
const shareCsecp = pool.compressXY(...Object.values(pool.commitXY(lpShares, shareR)));
const kSig = (variant, poolIdHex, assetXHex, deltaX, shareAmount, shareCsecpHex, inHex, rX, refund) =>
  '0x' + Buffer.from(lpAddKernelSig({ variant, poolIdHex, assetXHex, deltaX, shareAmount, shareCsecpHex, inputs: [[inHex, 0]], ...(refund || {}) }, rX)).toString('hex');
// POOL_INIT's founder-refund binding: an unconditional P2TR destination per side (a front-run / expired /
// malformed seed returns the funding deltas here instead of stranding them) — the kernel binds it, so the
// fold's lpAddKernelVerify(expiryHeight, refundXonly, refundBlinding) call needs the SAME values.
const INIT_EXPIRY = 200;
const INIT_REFUND_A_XONLY = '0x' + '51'.repeat(32), INIT_REFUND_B_XONLY = '0x' + '52'.repeat(32);
const INIT_REFUND_A_BLIND = '0x' + '61'.repeat(32), INIT_REFUND_B_BLIND = '0x' + '62'.repeat(32);
const kernelA = kSig(1, poolId, ASSET_A, deltaA, lpShares, shareCsecp, seedAHex, rA, { expiryHeight: INIT_EXPIRY, refundXonlyHex: INIT_REFUND_A_XONLY, refundBlindingHex: INIT_REFUND_A_BLIND });
const kernelB = kSig(1, poolId, ASSET_B, deltaB, lpShares, shareCsecp, seedBHex, rB, { expiryHeight: INIT_EXPIRY, refundXonlyHex: INIT_REFUND_B_XONLY, refundBlindingHex: INIT_REFUND_B_BLIND });
const initRefundArgs = (txidHex) => [INIT_REFUND_A_XONLY, INIT_REFUND_B_XONLY, pool.outpointKey(txidHex, 2), pool.outpointKey(txidHex, 3)];

// ── Rust↔JS pin: the pool_id domain (else POOL_INIT keys a different pool than the guest / swaps). ──
const rustPoolDomain = readFileSync(new URL('../contracts/sp1/confidential/cxfer-core/src/lib.rs', import.meta.url), 'utf8').match(/AMM_POOL_ID_DOMAIN: &\[u8\] = b"([^"]+)"/)[1];
const [low, high] = pool.ammCanonicalPair(ASSET_A, ASSET_B);
const expectPid = '0x' + Buffer.from(sha256(Buffer.concat([Buffer.from(rustPoolDomain), Buffer.from(low.slice(2), 'hex'), Buffer.from(high.slice(2), 'hex'), Buffer.from('000000', 'hex')]))).toString('hex'); // fee_bps(2)=0 ‖ cap(1)=0, no protocol-fee suffix
eq(poolId, expectPid, 'ammDerivePoolIdFull == sha256(Rust AMM_POOL_ID_DOMAIN ‖ low ‖ high ‖ fee_bps ‖ cap)');

function seedNotes(st, notes) { for (const [h, xy, asset] of notes) { const op = pool.outpointKey(h, 0); st.foldOutput(pool.leaf(asset, xy.cx, xy.cy, ZERO_OWNER), op, pool.commitmentHash(xy.cx, xy.cy), asset); } }
const seedInit = () => { const st = pool.makeScanReflectionState(); st.setHeight(100); seedNotes(st, [[seedAHex, cAxy, ASSET_A], [seedBHex, cBxy, ASSET_B]]); return st; };
const initEnv = () => ({ type: 'lp_add', variant: 1, assetA: ASSET_A, assetB: ASSET_B, deltaA: deltaA.toString(), deltaB: deltaB.toString(), shareAmount: lpShares.toString(), shareCsecp, shareR: beHex(shareR), kernelSigA: kernelA, kernelSigB: kernelB, feeBps: 0, capabilityFlags: 0, protocolFeeAddress: PROTO_FEE_ADDR, protocolFeeBps: 0, expiryHeight: INIT_EXPIRY, refundABlinding: INIT_REFUND_A_BLIND, refundBBlinding: INIT_REFUND_B_BLIND });
// POOL_INIT's fold call, with its unconditional refund binding (height, refund xonlys + outpoints).
const foldInit = (st, txidHex = '0x' + '5e'.repeat(32)) => st.foldLpAdd(initEnv(), spendsInit(), beHex(shareR), SHARE_OUT, SHARE_AUTH, 100, ...initRefundArgs(txidHex));
const spendsInit = () => [{ cx: cAxy.cx, cy: cAxy.cy, asset: ASSET_A, outpoint: [seedAHex, 0] }, { cx: cBxy.cx, cy: cBxy.cy, asset: ASSET_B, outpoint: [seedBHex, 0] }];
const SHARE_OUT = pool.outpointKey('0x' + '5e'.repeat(32), 1);
const SHARE_AUTH = '0x' + '11'.repeat(32); // x-only key of the vout-0 LP-share output (the fold reads it from the tx)
// Variant-0 refund destinations (x-only keys @vout 1/2) + blindings. Non-zero so the P2TR guard passes.
const REFUND_A_XONLY = '0x' + '31'.repeat(32), REFUND_B_XONLY = '0x' + '32'.repeat(32);
const REFUND_A_BLIND = '0x' + '41'.repeat(32), REFUND_B_BLIND = '0x' + '42'.repeat(32);
const v0RefundEnv = { expiryHeight: 200, refundABlinding: REFUND_A_BLIND, refundBBlinding: REFUND_B_BLIND };
const v0RefundArgs = (txidHex) => [REFUND_A_XONLY, REFUND_B_XONLY, pool.outpointKey(txidHex, 1), pool.outpointKey(txidHex, 2)];

// ── POOL_INIT accept ──
{
  const st = seedInit();
  const w = foldInit(st);
  ok(w && w.path0, 'POOL_INIT folds (returns the share note-path)');
  const p = st.pools.get(poolId);
  ok(p, 'pool created');
  eq(BigInt(p.reserveA), deltaA, 'reserve_a = delta_a');
  eq(BigInt(p.reserveB), deltaB, 'reserve_b = delta_b');
  eq(BigInt(p.totalShares), totalShares, 'total_shares = isqrt(da·db)');
  eq(st.counts().note, 3, '2 funding notes + 1 minted share note');
}

// ── determinism ──
{
  const a = seedInit(), b = seedInit();
  foldInit(a);
  foldInit(b);
  eq(a.digest(), b.digest(), 'deterministic: same POOL_INIT → same digest');
}

// ── variant-0 LP-add grows the existing pool ──
{
  const st = seedInit();
  foldInit(st); // create the pool
  const dA2 = 4000n, dB2 = 9000n, rA2 = 0xCC01n, rB2 = 0xDD01n, shareR2 = 0x6666n;
  const sA2 = '0x' + '2a'.repeat(32), sB2 = '0x' + '2b'.repeat(32);
  const cA2 = pool.commitXY(dA2, rA2), cB2 = pool.commitXY(dB2, rB2);
  const minted = pool.lpAddShares(totalShares, dA2, dB2, deltaA, deltaB); // proportional → 6000
  const shareCsecp2 = pool.compressXY(...Object.values(pool.commitXY(minted, shareR2)));
  seedNotes(st, [[sA2, cA2, ASSET_A], [sB2, cB2, ASSET_B]]);
  // ASSET_A < ASSET_B ⇒ canonical (a,b) with no swap: the ASSET_A kernel binds refund A, ASSET_B binds refund B.
  const kA0 = kSig(0, poolId, ASSET_A, dA2, minted, shareCsecp2, sA2, rA2, { expiryHeight: 200, refundXonlyHex: REFUND_A_XONLY, refundBlindingHex: REFUND_A_BLIND });
  const kB0 = kSig(0, poolId, ASSET_B, dB2, minted, shareCsecp2, sB2, rB2, { expiryHeight: 200, refundXonlyHex: REFUND_B_XONLY, refundBlindingHex: REFUND_B_BLIND });
  const env0 = { type: 'lp_add', variant: 0, assetA: ASSET_A, assetB: ASSET_B, deltaA: dA2.toString(), deltaB: dB2.toString(), shareAmount: minted.toString(), shareCsecp: shareCsecp2, shareR: beHex(shareR2), kernelSigA: kA0, kernelSigB: kB0, feeBps: 0, capabilityFlags: 0, protocolFeeAddress: PROTO_FEE_ADDR, protocolFeeBps: 0, ...v0RefundEnv };
  const spends0 = [{ cx: cA2.cx, cy: cA2.cy, asset: ASSET_A, outpoint: [sA2, 0] }, { cx: cB2.cx, cy: cB2.cy, asset: ASSET_B, outpoint: [sB2, 0] }];
  const w = st.foldLpAdd(env0, spends0, beHex(shareR2), pool.outpointKey("0x" + "6e".repeat(32), 0), SHARE_AUTH, 100, ...v0RefundArgs("0x" + "6e".repeat(32)));
  ok(w && w.path0 && w.path1, 'variant-0 LP-add grows the pool (two-path witness)');
  const p = st.pools.get(poolId);
  eq(BigInt(p.reserveA), deltaA + dA2, 'reserve_a grew by delta_a');
  eq(BigInt(p.reserveB), deltaB + dB2, 'reserve_b grew by delta_b');
  eq(BigInt(p.totalShares), totalShares + minted, 'total_shares grew by the proportional mint');
}

// ── variant-0 refund: a floor above the recomputed mint (sandwich) returns both assets, pool UNCHANGED ──
{
  const st = seedInit();
  foldInit(st); // create the pool (reserves 4000/9000)
  // Skew the reserves so the balanced deposit mints below the signed floor (simulating a front-run).
  const before = st.pools.get(poolId);
  st.pools.set(poolId, { ...before, reserveA: 40000n, reserveB: 9000n }); // total_shares unchanged
  const skewed = st.pools.get(poolId);
  const dA2 = 4000n, dB2 = 9000n, rA2 = 0xCC02n, rB2 = 0xDD02n, shareR2 = 0x6767n;
  const sA2 = '0x' + '3a'.repeat(32), sB2 = '0x' + '3b'.repeat(32);
  const cA2 = pool.commitXY(dA2, rA2), cB2 = pool.commitXY(dB2, rB2);
  const floor = pool.lpAddShares(totalShares, dA2, dB2, 4000n, 9000n); // the pre-skew (signed) expectation
  const mintedSkew = pool.lpAddShares(BigInt(skewed.totalShares), dA2, dB2, 40000n, 9000n);
  ok(mintedSkew < floor, 'skew makes the recomputed mint fall below the signed floor');
  const shareCsecp2 = pool.compressXY(...Object.values(pool.commitXY(floor, shareR2)));
  seedNotes(st, [[sA2, cA2, ASSET_A], [sB2, cB2, ASSET_B]]);
  const kA0 = kSig(0, poolId, ASSET_A, dA2, floor, shareCsecp2, sA2, rA2, { expiryHeight: 200, refundXonlyHex: REFUND_A_XONLY, refundBlindingHex: REFUND_A_BLIND });
  const kB0 = kSig(0, poolId, ASSET_B, dB2, floor, shareCsecp2, sB2, rB2, { expiryHeight: 200, refundXonlyHex: REFUND_B_XONLY, refundBlindingHex: REFUND_B_BLIND });
  const env0 = { type: 'lp_add', variant: 0, assetA: ASSET_A, assetB: ASSET_B, deltaA: dA2.toString(), deltaB: dB2.toString(), shareAmount: floor.toString(), shareCsecp: shareCsecp2, shareR: beHex(shareR2), kernelSigA: kA0, kernelSigB: kB0, feeBps: 0, capabilityFlags: 0, protocolFeeAddress: PROTO_FEE_ADDR, protocolFeeBps: 0, ...v0RefundEnv };
  const spends0 = [{ cx: cA2.cx, cy: cA2.cy, asset: ASSET_A, outpoint: [sA2, 0] }, { cx: cB2.cx, cy: cB2.cy, asset: ASSET_B, outpoint: [sB2, 0] }];
  const txid = "0x" + "7e".repeat(32);
  const noteBefore = st.counts().note; // after the funding-note seeding; the refund should add exactly two
  const w = st.foldLpAdd(env0, spends0, beHex(shareR2), pool.outpointKey(txid, 0), SHARE_AUTH, 100, ...v0RefundArgs(txid));
  ok(w && w.path0 && w.path1, 'sandwiched add takes the refund path (two notes)');
  const after = st.pools.get(poolId);
  eq(BigInt(after.reserveA), 40000n, 'refund: reserve_a UNCHANGED');
  eq(BigInt(after.reserveB), 9000n, 'refund: reserve_b UNCHANGED');
  eq(BigInt(after.totalShares), BigInt(skewed.totalShares), 'refund: total_shares UNCHANGED');
  eq(st.counts().note, noteBefore + 2, 'refund onboards two notes (both assets)');
}

// ── variant-0 refund: an expired add (expiry < height) refunds even when the floor is satisfiable ──
{
  const st = seedInit();
  foldInit(st);
  const dA2 = 4000n, dB2 = 9000n, rA2 = 0xCC03n, rB2 = 0xDD03n, shareR2 = 0x6868n;
  const sA2 = '0x' + '4a'.repeat(32), sB2 = '0x' + '4b'.repeat(32);
  const cA2 = pool.commitXY(dA2, rA2), cB2 = pool.commitXY(dB2, rB2);
  const minted = pool.lpAddShares(totalShares, dA2, dB2, deltaA, deltaB);
  const shareCsecp2 = pool.compressXY(...Object.values(pool.commitXY(minted, shareR2)));
  seedNotes(st, [[sA2, cA2, ASSET_A], [sB2, cB2, ASSET_B]]);
  const expEnv = { expiryHeight: 40, refundABlinding: REFUND_A_BLIND, refundBBlinding: REFUND_B_BLIND };
  const kA0 = kSig(0, poolId, ASSET_A, dA2, minted, shareCsecp2, sA2, rA2, { expiryHeight: 40, refundXonlyHex: REFUND_A_XONLY, refundBlindingHex: REFUND_A_BLIND });
  const kB0 = kSig(0, poolId, ASSET_B, dB2, minted, shareCsecp2, sB2, rB2, { expiryHeight: 40, refundXonlyHex: REFUND_B_XONLY, refundBlindingHex: REFUND_B_BLIND });
  const env0 = { type: 'lp_add', variant: 0, assetA: ASSET_A, assetB: ASSET_B, deltaA: dA2.toString(), deltaB: dB2.toString(), shareAmount: minted.toString(), shareCsecp: shareCsecp2, shareR: beHex(shareR2), kernelSigA: kA0, kernelSigB: kB0, feeBps: 0, capabilityFlags: 0, protocolFeeAddress: PROTO_FEE_ADDR, protocolFeeBps: 0, ...expEnv };
  const spends0 = [{ cx: cA2.cx, cy: cA2.cy, asset: ASSET_A, outpoint: [sA2, 0] }, { cx: cB2.cx, cy: cB2.cy, asset: ASSET_B, outpoint: [sB2, 0] }];
  const txid = "0x" + "8e".repeat(32);
  const before = st.pools.get(poolId);
  const noteBefore = st.counts().note; // after the funding-note seeding
  const w = st.foldLpAdd(env0, spends0, beHex(shareR2), pool.outpointKey(txid, 0), SHARE_AUTH, 100, ...v0RefundArgs(txid)); // height 100 > expiry 40
  ok(w && w.path0 && w.path1, 'expired add takes the refund path');
  const after = st.pools.get(poolId);
  eq(BigInt(after.reserveA), BigInt(before.reserveA), 'expired refund: reserves UNCHANGED');
  eq(st.counts().note, noteBefore + 2, 'expired refund onboards two notes');
}

// ── gates ──
{
  const st = seedInit();
  foldInit(st);
  const noteBefore = st.counts().note;
  const w2 = foldInit(st, '0x' + '5f'.repeat(32)); // same pool_id, a second funding pair (front-run shape)
  ok(w2 && w2.path0 && w2.path1, 'POOL_INIT for an already-registered pool → REFUND (not skip)');
  eq(st.counts().note, noteBefore + 2, 'already-registered: both seeded deltas refunded as notes');
  eq(BigInt(st.pools.get(poolId).totalShares), totalShares, 'already-registered: total_shares UNCHANGED (no re-init)');
}
eq(seedInit().foldLpAdd({ ...initEnv(), variant: 0 }, spendsInit(), beHex(shareR), SHARE_OUT, SHARE_AUTH, 100, ...initRefundArgs('0x' + '5e'.repeat(32))), null, 'variant-0 LP-add to an unknown pool → skip');
eq(seedInit().foldLpAdd({ ...initEnv(), kernelSigA: '0x' + 'de'.repeat(64) }, spendsInit(), beHex(shareR), SHARE_OUT, SHARE_AUTH, 100, ...initRefundArgs('0x' + '5e'.repeat(32))), null, 'bad asset_a kernel → skip');
// The share note is FORMED from the reflection-computed lp_shares under the envelope's PUBLIC share_r (C-01):
// there is no declared-share-opening gate to fail. A different share_r simply forms a different (still-valid)
// note committing the SAME lp_shares — the pool always mints, never strands the LP for a lost race.
{
  const st = seedInit();
  const w = st.foldLpAdd(initEnv(), spendsInit(), beHex(0x1234n), SHARE_OUT, SHARE_AUTH, 100, ...initRefundArgs('0x' + '5e'.repeat(32)));
  ok(w && w.path0, 'any signed share_r forms the note (no declared-opening gate)');
  const formed = pool.commitXY(lpShares, 0x1234n);
  const expLeaf = pool.btcNoteLeaf(pool.ammDeriveLpAssetId(poolId), formed.cx, formed.cy, SHARE_AUTH);
  ok(st._acc.notes.leaves.some((l) => pool.hx(l).toLowerCase() === expLeaf.toLowerCase()), 'onboarded leaf == FORMED share (lp_shares under the given share_r)');
}

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
