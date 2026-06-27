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
const kSig = (variant, poolIdHex, assetXHex, deltaX, shareAmount, shareCsecpHex, inHex, rX) =>
  '0x' + Buffer.from(lpAddKernelSig({ variant, poolIdHex, assetXHex, deltaX, shareAmount, shareCsecpHex, inputs: [[inHex, 0]] }, rX)).toString('hex');
const kernelA = kSig(1, poolId, ASSET_A, deltaA, lpShares, shareCsecp, seedAHex, rA);
const kernelB = kSig(1, poolId, ASSET_B, deltaB, lpShares, shareCsecp, seedBHex, rB);

// ── Rust↔JS pin: the pool_id domain (else POOL_INIT keys a different pool than the guest / swaps). ──
const rustPoolDomain = readFileSync(new URL('../contracts/sp1/confidential/cxfer-core/src/lib.rs', import.meta.url), 'utf8').match(/AMM_POOL_ID_DOMAIN: &\[u8\] = b"([^"]+)"/)[1];
const [low, high] = pool.ammCanonicalPair(ASSET_A, ASSET_B);
const expectPid = '0x' + Buffer.from(sha256(Buffer.concat([Buffer.from(rustPoolDomain), Buffer.from(low.slice(2), 'hex'), Buffer.from(high.slice(2), 'hex'), Buffer.from('000000', 'hex')]))).toString('hex'); // fee_bps(2)=0 ‖ cap(1)=0, no protocol-fee suffix
eq(poolId, expectPid, 'ammDerivePoolIdFull == sha256(Rust AMM_POOL_ID_DOMAIN ‖ low ‖ high ‖ fee_bps ‖ cap)');

function seedNotes(st, notes) { for (const [h, xy, asset] of notes) { const op = pool.outpointKey(h, 0); st.foldOutput(pool.leaf(asset, xy.cx, xy.cy, ZERO_OWNER), op, pool.commitmentHash(xy.cx, xy.cy), asset); } }
const seedInit = () => { const st = pool.makeScanReflectionState(); st.setHeight(100); seedNotes(st, [[seedAHex, cAxy, ASSET_A], [seedBHex, cBxy, ASSET_B]]); return st; };
const initEnv = () => ({ type: 'lp_add', variant: 1, assetA: ASSET_A, assetB: ASSET_B, deltaA: deltaA.toString(), deltaB: deltaB.toString(), shareAmount: lpShares.toString(), shareCsecp, shareR: beHex(shareR), kernelSigA: kernelA, kernelSigB: kernelB, feeBps: 0, capabilityFlags: 0, protocolFeeAddress: PROTO_FEE_ADDR, protocolFeeBps: 0 });
const spendsInit = () => [{ cx: cAxy.cx, cy: cAxy.cy, asset: ASSET_A, outpoint: [seedAHex, 0] }, { cx: cBxy.cx, cy: cBxy.cy, asset: ASSET_B, outpoint: [seedBHex, 0] }];
const SHARE_OUT = pool.outpointKey('0x' + '5e'.repeat(32), 1);

// ── POOL_INIT accept ──
{
  const st = seedInit();
  const w = st.foldLpAdd(initEnv(), spendsInit(), beHex(shareR), SHARE_OUT);
  ok(w && w.sharePath, 'POOL_INIT folds (returns the share note-path)');
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
  a.foldLpAdd(initEnv(), spendsInit(), beHex(shareR), SHARE_OUT);
  b.foldLpAdd(initEnv(), spendsInit(), beHex(shareR), SHARE_OUT);
  eq(a.digest(), b.digest(), 'deterministic: same POOL_INIT → same digest');
}

// ── variant-0 LP-add grows the existing pool ──
{
  const st = seedInit();
  st.foldLpAdd(initEnv(), spendsInit(), beHex(shareR), SHARE_OUT); // create the pool
  const dA2 = 4000n, dB2 = 9000n, rA2 = 0xCC01n, rB2 = 0xDD01n, shareR2 = 0x6666n;
  const sA2 = '0x' + '2a'.repeat(32), sB2 = '0x' + '2b'.repeat(32);
  const cA2 = pool.commitXY(dA2, rA2), cB2 = pool.commitXY(dB2, rB2);
  const minted = pool.lpAddShares(totalShares, dA2, dB2, deltaA, deltaB); // proportional → 6000
  const shareCsecp2 = pool.compressXY(...Object.values(pool.commitXY(minted, shareR2)));
  seedNotes(st, [[sA2, cA2, ASSET_A], [sB2, cB2, ASSET_B]]);
  const env0 = { type: 'lp_add', variant: 0, assetA: ASSET_A, assetB: ASSET_B, deltaA: dA2.toString(), deltaB: dB2.toString(), shareAmount: minted.toString(), shareCsecp: shareCsecp2, shareR: beHex(shareR2), kernelSigA: kSig(0, poolId, ASSET_A, dA2, minted, shareCsecp2, sA2, rA2), kernelSigB: kSig(0, poolId, ASSET_B, dB2, minted, shareCsecp2, sB2, rB2), feeBps: 0, capabilityFlags: 0, protocolFeeAddress: PROTO_FEE_ADDR, protocolFeeBps: 0 };
  const spends0 = [{ cx: cA2.cx, cy: cA2.cy, asset: ASSET_A, outpoint: [sA2, 0] }, { cx: cB2.cx, cy: cB2.cy, asset: ASSET_B, outpoint: [sB2, 0] }];
  const w = st.foldLpAdd(env0, spends0, beHex(shareR2), pool.outpointKey('0x' + '6e'.repeat(32), 1));
  ok(w, 'variant-0 LP-add grows the pool');
  const p = st.pools.get(poolId);
  eq(BigInt(p.reserveA), deltaA + dA2, 'reserve_a grew by delta_a');
  eq(BigInt(p.reserveB), deltaB + dB2, 'reserve_b grew by delta_b');
  eq(BigInt(p.totalShares), totalShares + minted, 'total_shares grew by the proportional mint');
}

// ── gates ──
{ const st = seedInit(); st.foldLpAdd(initEnv(), spendsInit(), beHex(shareR), SHARE_OUT); eq(st.foldLpAdd(initEnv(), spendsInit(), beHex(shareR), SHARE_OUT), null, 'POOL_INIT for an already-registered pool → skip'); }
eq(seedInit().foldLpAdd({ ...initEnv(), variant: 0 }, spendsInit(), beHex(shareR), SHARE_OUT), null, 'variant-0 LP-add to an unknown pool → skip');
eq(seedInit().foldLpAdd({ ...initEnv(), kernelSigA: '0x' + 'de'.repeat(64) }, spendsInit(), beHex(shareR), SHARE_OUT), null, 'bad asset_a kernel → skip');
{
  const st = seedInit();
  eq(st.foldLpAdd(initEnv(), spendsInit(), beHex(0xDEADn), SHARE_OUT), null, 'tampered share blinding (mint opening fails) → skip');
  eq(st.counts().note, 2, 'tampered share: no share note onboarded (pool mutated, share not minted — guest-faithful)');
}

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
