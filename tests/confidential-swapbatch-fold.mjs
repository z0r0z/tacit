#!/usr/bin/env node
// foldSwapBatch — the swap_batch (0x2F) reflection fold assembly (mirror cxfer-core fold_swap_batch). Validates
// the full SYNC logic with a synthetic BALANCING 1-intent batch (A→B): a real per-asset aggregate Pedersen
// identity, a real cross-curve sigma binding the receipt's C_out_secp ↔ C_out_BJJ, the trader's c_in_secp a
// real seeded spend, and groth16Ok injected (the Groth16 verify is the caller's async pre-step, validated in
// confidential-swapbatch-groth16). Asserts: the receipt onboards as a real note of the output asset + reserves
// advance by the public net deltas; and every gate rejects (no groth16 / wrong R_net / tampered sigma /
// non-real spend / not-c0-backed) with no mutation. End-to-end (the guest's in-zkVM Groth16) is the head-zkey
// gen. Run: node tests/confidential-swapbatch-fold.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { foldSwapBatch } from '../dapp/confidential-swapbatch.js';
import { pedersenCommit, pointToBytes } from '../dapp/bulletproofs.js';
import { pedersenBJJ, packPoint } from '../dapp/amm-bjj.js';
import { proveXCurveDeterministic } from '../dapp/amm-sigma.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const N = secp.CURVE.n;
const mod = (a, m) => ((a % m) + m) % m;
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const beHex = (n) => '0x' + mod(BigInt(n), N).toString(16).padStart(64, '0');
const commitZero = (r) => hx(secp.ProjectivePoint.BASE.multiply(mod(BigInt(r), N)).toRawBytes(true)); // 0·H + r·G
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

const ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32), ZERO_ADDR33 = '0x' + '00'.repeat(33);
const reserveA = 1000000n, reserveB = 2000000n, feeBps = 0;
const vIn = 1000n, vOut = 1900n;                       // A→B: trader pays 1000 A, receives 1900 B
const rIn = 0x1001n, rOut = 0x2002n, rOutBjj = 0x3003n, rTipA = 0x4004n, rTipB = 0x5005n;
const poolId = pool.ammDerivePoolIdFull(ASSET_A, ASSET_B, feeBps, 0, ZERO_ADDR33, 0);
const txid = '0x' + '2f'.repeat(32), seedTxid = '0x' + 'cc'.repeat(32);

const cInSecp = hx(pointToBytes(pedersenCommit(vIn, rIn)));
const cInXY = pool.decompressCommitment(cInSecp);
const cOutSecp = hx(pointToBytes(pedersenCommit(vOut, rOut)));
const cOutBjj = hx(packPoint(pedersenBJJ(vOut, rOutBjj)));
const { proof: outXcurveSigma } = proveXCurveDeterministic({ a: vOut, r_secp: rOut, r_BJJ: rOutBjj, seedKey: new Uint8Array(32).fill(9), C_secp: pedersenCommit(vOut, rOut), C_BJJ: pedersenBJJ(vOut, rOutBjj) });

// Balancing identities (1-intent dir-0): asset A R_net = r_in − r_tipA; asset B R_net = −(r_out + r_tipB).
const env = {
  assetA: ASSET_A, assetB: ASSET_B, nIntents: 1, feeBps,
  deltaANetSign: 0, deltaANetMag: vIn.toString(),       // reserve_a grows by 1000
  deltaBNetSign: 1, deltaBNetMag: vOut.toString(),      // reserve_b shrinks by 1900
  rNetA: beHex(rIn - rTipA), rNetB: beHex(-(rOut + rTipB)),
  tipACSecp: commitZero(rTipA), tipBCSecp: commitZero(rTipB),
  intents: [{ direction: 0, cInSecp }],
  receipts: [{ cOutSecp, cOutBjj, outXcurveSigma: hx(outXcurveSigma) }],
};

function seed({ c0 = true } = {}) {
  const st = pool.makeScanReflectionState();
  st.setHeight(100);
  st.pools.load([{ poolId, assetA: ASSET_A, assetB: ASSET_B, reserveA: reserveA.toString(), reserveB: reserveB.toString(), totalShares: '1000', c0Backed: c0, protocolFeeBps: 0, kLast: (reserveA * reserveB).toString(), protocolFeeAccrued: '0' }]);
  st.foldOutput(pool.leaf(ASSET_A, cInXY.cx, cInXY.cy, '0x' + '00'.repeat(32)), pool.outpointKey(seedTxid, 0), pool.commitmentHash(cInXY.cx, cInXY.cy), ASSET_A);
  return st;
}
const spends = [{ cx: cInXY.cx, cy: cInXY.cy }];

// ── accept ──
{
  const st = seed();
  const g0 = st.digest();
  const w = foldSwapBatch(pool, st, env, txid, spends, { groth16Ok: true });
  ok(w && w.receiptPaths && w.receiptPaths.length === 1, 'batch folds (1 receipt note-path)');
  eq(st.counts().note, 2, 'receipt onboarded (1 seeded c_in + 1 receipt)');
  const p = st.pools.get(poolId);
  eq(BigInt(p.reserveA), reserveA + vIn, 'reserve_a grew by δ_a (+1000)');
  eq(BigInt(p.reserveB), reserveB - vOut, 'reserve_b shrank by δ_b (−1900)');
  ok(st.digest() !== g0, 'digest advanced');
}

// ── gates reject (no mutation) ──
const rejects = (label, st, run) => {
  const before = st.counts().note, rA = st.pools.get(poolId) ? st.pools.get(poolId).reserveA + '' : '-';
  ok(run() === null, label + ' → skip');
  eq(st.counts().note, before, label + ': no receipt onboarded');
  if (st.pools.get(poolId)) eq(st.pools.get(poolId).reserveA + '', rA, label + ': reserves unchanged');
};
rejects('groth16 not verified', seed(), () => foldSwapBatch(pool, seed(), env, txid, spends, { groth16Ok: false }));
rejects('wrong R_net_A (aggregate fails)', seed(), () => foldSwapBatch(pool, seed(), { ...env, rNetA: beHex(rIn - rTipA + 1n) }, txid, spends, { groth16Ok: true }));
rejects('tampered receipt xcurve sigma', seed(), () => { const bad = new Uint8Array(outXcurveSigma); bad[0] ^= 1; return foldSwapBatch(pool, seed(), { ...env, receipts: [{ cOutSecp, cOutBjj, outXcurveSigma: hx(bad) }] }, txid, spends, { groth16Ok: true }); });
rejects('intent c_in not a real spend', seed(), () => foldSwapBatch(pool, seed(), env, txid, [], { groth16Ok: true }));
rejects('pool not c0-backed', seed({ c0: false }), () => foldSwapBatch(pool, seed({ c0: false }), env, txid, spends, { groth16Ok: true }));

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
