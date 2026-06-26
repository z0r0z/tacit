#!/usr/bin/env node
// lp_remove (T_LP_REMOVE 0x2E) fold — JS mirror of cxfer-core fold_lp_remove + the canonical-pair pool search.
// The LP burns its detected LP-share spends (netting to share_amount under the share-burn kernel) and withdraws
// the proportional (delta_a, delta_b); both withdrawn notes are onboarded (each bound to its PUBLIC delta_X by a
// witnessed blinding) and reserves/shares are drawn down. Validates accept + gates (unknown pool / not-c0-backed
// / non-proportional / bad kernel / tampered recv opening) + determinism + the reversed-pair canonicalization
// invariant. End-to-end guest-digest parity: gen-reflection-lpremove-synth.mjs under reflect-exec.

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { lpRemoveKernelSig } from './_swapvar-kernel.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

const ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32), POOL_ID = '0x' + '2e'.repeat(32); // a1 < b2 canonical
const ZERO_OWNER = '0x' + '00'.repeat(32);
const seedTxidHex = '0x' + '2e'.repeat(32), seedVout = 0, RECV_TXID = '0x' + '5a'.repeat(32);
const reserveA = 1000000n, reserveB = 2000000n, totalShares = 1000000n, shareAmount = 100000n;
const deltaA = (reserveA * shareAmount) / totalShares, deltaB = (reserveB * shareAmount) / totalShares;
const rShare = 0x5151n, rRecvA = 0xA1A1n, rRecvB = 0xB2B2n;

const lpAsset = pool.ammDeriveLpAssetId(POOL_ID);
const shareXY = pool.commitXY(shareAmount, rShare);
const recvAXY = pool.commitXY(deltaA, rRecvA), recvBXY = pool.commitXY(deltaB, rRecvB);
const recvA = pool.compressXY(recvAXY.cx, recvAXY.cy), recvB = pool.compressXY(recvBXY.cx, recvBXY.cy);
const kernelSigHex = '0x' + Buffer.from(lpRemoveKernelSig({ poolIdHex: POOL_ID, shareAmount, deltaA, deltaB, recvAHex: recvA, recvBHex: recvB, lpOutpoints: [[seedTxidHex, seedVout]] }, rShare)).toString('hex');

// A C0-backed pool + the LP's burned LP-share note (a live UTXO of the pool's LP-share asset).
function seed({ c0 = true, rA = reserveA, withPool = true } = {}) {
  const st = pool.makeScanReflectionState();
  st.setHeight(100);
  if (withPool) st.pools.load([{ poolId: POOL_ID, assetA: ASSET_A, assetB: ASSET_B, reserveA: rA.toString(), reserveB: reserveB.toString(), totalShares: totalShares.toString(), c0Backed: c0, protocolFeeBps: 0, kLast: (rA * reserveB).toString(), protocolFeeAccrued: '0' }]);
  const op = pool.outpointKey(seedTxidHex, seedVout);
  st.foldOutput(pool.leaf(lpAsset, shareXY.cx, shareXY.cy, ZERO_OWNER), op, pool.commitmentHash(shareXY.cx, shareXY.cy), lpAsset);
  return st;
}
const canonEnv = () => ({ type: 'lp_remove', assetA: ASSET_A, assetB: ASSET_B, shareAmount: shareAmount.toString(), deltaA: deltaA.toString(), deltaB: deltaB.toString(), recvASecp: recvA, recvBSecp: recvB, rRecvA: beHex(rRecvA), rRecvB: beHex(rRecvB), kernelSig: kernelSigHex });
const doFold = (st, env) => st.foldLpRemove(env, [[seedTxidHex, seedVout]], [{ cx: shareXY.cx, cy: shareXY.cy }], pool.outpointKey(RECV_TXID, 1), pool.outpointKey(RECV_TXID, 2));

// ── accept ──
{
  const st = seed();
  const g0 = st.digest();
  const w = doFold(st, canonEnv());
  ok(w && w.recvAPath && w.recvBPath, 'valid lp_remove folds (two recv note-paths)');
  eq(st.counts().note, 3, 'both withdrawn notes onboarded (1 seeded share + 2 recv)');
  const p = st.pools.get(POOL_ID);
  eq(BigInt(p.reserveA), reserveA - deltaA, 'reserve_a drawn down by delta_a');
  eq(BigInt(p.reserveB), reserveB - deltaB, 'reserve_b drawn down by delta_b');
  eq(BigInt(p.totalShares), totalShares - shareAmount, 'total_shares drawn down by share_amount');
  ok(st.digest() !== g0, 'digest advanced');
}

// ── determinism ──
{
  const a = seed(), b = seed();
  doFold(a, canonEnv()); doFold(b, canonEnv());
  eq(a.digest(), b.digest(), 'deterministic: same lp_remove → same digest');
}

// ── reversed-pair canonicalization: submitting (asset_b, asset_a) folds to the SAME result ──
{
  const stC = seed(); doFold(stC, canonEnv());
  const stS = seed();
  const swapped = { type: 'lp_remove', assetA: ASSET_B, assetB: ASSET_A, shareAmount: shareAmount.toString(), deltaA: deltaB.toString(), deltaB: deltaA.toString(), recvASecp: recvB, recvBSecp: recvA, rRecvA: beHex(rRecvB), rRecvB: beHex(rRecvA), kernelSig: kernelSigHex };
  ok(doFold(stS, swapped), 'swapped (reversed-pair) submission also folds');
  eq(stS.digest(), stC.digest(), 'swapped submission → same fold result (canonicalization)');
}

// ── gates reject (null = skip; assert NO note onboarded beyond the seeded share) ──
const rejects = (label, st, env) => {
  const before = st.counts().note;
  eq(doFold(st, env), null, label + ' → skip');
  eq(st.counts().note, before, label + ': no recv note onboarded');
};
rejects('unknown pool for the pair', seed({ withPool: false }), canonEnv());
rejects('pool not c0-backed', seed({ c0: false }), canonEnv());
rejects('non-proportional withdrawal (wrong reserves)', seed({ rA: 2000000n }), canonEnv());
rejects('bad share-burn kernel', seed(), { ...canonEnv(), kernelSig: '0x' + 'de'.repeat(64) });
rejects('tampered recv_a blinding (opening fails)', seed(), { ...canonEnv(), rRecvA: beHex(0xDEADn) });

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
