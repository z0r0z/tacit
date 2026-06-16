#!/usr/bin/env node
// swap_route (T_SWAP_ROUTE 0x33) fold — JS mirror of cxfer-core fold_swap_route. The trader's single input
// note flows through 2–4 pools and lands as ONE receipt note. Validates accept (2-hop A→B→C: receipt onboarded
// + both pools advanced) + gates (chain-break / reserve-mismatch / pool-repeat / output-asset / drain / bad
// kernel / tampered receipt / unknown pool) + determinism + the all-or-nothing property (any gate ⇒ NO state
// change). End-to-end guest-digest parity: gen-reflection-swaproute-synth.mjs under reflect-exec.

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { swapVarKernelSig } from './_swapvar-kernel.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const beHex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

const A = '0x' + 'a1'.repeat(32), B = '0x' + 'b2'.repeat(32), C = '0x' + 'c3'.repeat(32);
const PROTO = '0x' + '00'.repeat(33), ZERO_OWNER = '0x' + '00'.repeat(32), SENTINEL = Buffer.alloc(33);
const inMag = 1000n, midMag = 1900n, outMag = 3600n;
const p1A = 1000000n, p1B = 2000000n, p2A = 2000000n, p2B = 4000000n;
const rIn = 0x303n, rReceipt = 0x707n;
const seedTxidHex = '0x' + '33'.repeat(32), seedVout = 0;

const pool1Id = pool.ammDerivePoolIdFull(A, B, 0, 0, PROTO, 0);
const pool2Id = pool.ammDerivePoolIdFull(B, C, 0, 0, PROTO, 0);
const cInXY = pool.commitXY(inMag, rIn), cIn = pool.compressXY(cInXY.cx, cInXY.cy);
const cReceipt = pool.compressXY(...Object.values(pool.commitXY(outMag, rReceipt)));
const kernelSig = '0x' + Buffer.from(swapVarKernelSig({ assetHex: A, txidHex: seedTxidHex, vout: seedVout, cChangeBytes: SENTINEL, deltaInTotal: inMag, rIn })).toString('hex');

function seed({ withPools = true } = {}) {
  const st = pool.makeScanReflectionState();
  st.setHeight(100);
  if (withPools) st.pools.load([
    { poolId: pool1Id, assetA: A, assetB: B, reserveA: p1A.toString(), reserveB: p1B.toString(), totalShares: '1000', c0Backed: true, protocolFeeBps: 0, kLast: (p1A * p1B).toString(), protocolFeeAccrued: '0' },
    { poolId: pool2Id, assetA: B, assetB: C, reserveA: p2A.toString(), reserveB: p2B.toString(), totalShares: '1000', c0Backed: true, protocolFeeBps: 0, kLast: (p2A * p2B).toString(), protocolFeeAccrued: '0' },
  ]);
  const op = pool.outpointKey(seedTxidHex, seedVout);
  st.foldOutput(pool.leaf(A, cInXY.cx, cInXY.cy, ZERO_OWNER), op, pool.commitmentHash(cInXY.cx, cInXY.cy), A);
  return st;
}
const env = (over = {}) => ({
  type: 'swap_route', traderInputAsset: A, traderOutputAsset: C,
  hops: [
    { poolId: pool1Id, direction: 0, rAPre: p1A.toString(), rBPre: p1B.toString(), deltaANetMag: inMag.toString(), deltaBNetMag: midMag.toString() },
    { poolId: pool2Id, direction: 0, rAPre: p2A.toString(), rBPre: p2B.toString(), deltaANetMag: midMag.toString(), deltaBNetMag: outMag.toString() },
  ],
  cIn, cReceipt, rReceipt: beHex(rReceipt), kernelSig, ...over,
});
const withHop = (over, idx, hopOver) => { const e = env(over); e.hops[idx] = { ...e.hops[idx], ...hopOver }; return e; };
const doFold = (st, e) => st.foldSwapRoute(e, [seedTxidHex, seedVout], A, pool.outpointKey('0x' + '5a'.repeat(32), 1));

// ── accept ──
{
  const st = seed();
  const g0 = st.digest();
  const w = doFold(st, env());
  ok(w && w.receiptPath, 'swap_route folds (returns the receipt note-path)');
  eq(st.counts().note, 2, 'receipt onboarded (1 seeded input + 1 receipt)');
  const p1 = st.pools.get(pool1Id), p2 = st.pools.get(pool2Id);
  eq(BigInt(p1.reserveA), p1A + inMag, 'pool1 reserve_a += inMag');
  eq(BigInt(p1.reserveB), p1B - midMag, 'pool1 reserve_b -= midMag');
  eq(BigInt(p2.reserveA), p2A + midMag, 'pool2 reserve_a(B) += midMag (chain)');
  eq(BigInt(p2.reserveB), p2B - outMag, 'pool2 reserve_b(C) -= outMag');
  ok(st.digest() !== g0, 'digest advanced');
}

// ── determinism ──
{ const a = seed(), b = seed(); doFold(a, env()); doFold(b, env()); eq(a.digest(), b.digest(), 'deterministic: same route → same digest'); }

// ── gates reject (all-or-nothing: assert NO note onboarded, reserves untouched) ──
const rejects = (label, st, e) => {
  const g0 = st.digest();
  eq(doFold(st, e), null, label + ' → skip');
  eq(st.counts().note, 1, label + ': no receipt onboarded');
  eq(st.digest(), g0, label + ': state unchanged (all-or-nothing)');
};
rejects('chain break (hop1 input != hop0 output)', seed(), withHop({}, 1, { deltaANetMag: (midMag + 1n).toString() }));
rejects('reserve mismatch (hop0 R_a_pre wrong)', seed(), withHop({}, 0, { rAPre: (p1A + 1n).toString() }));
rejects('pool repeated in route', seed(), withHop({}, 1, { poolId: pool1Id }));
rejects('final asset != route output asset', seed(), env({ traderOutputAsset: B }));
rejects('hop output exceeds reserve (drain)', seed(), withHop({}, 1, { deltaBNetMag: (p2B + 1n).toString() }));
rejects('bad input kernel', seed(), env({ kernelSig: '0x' + 'de'.repeat(64) }));
rejects('tampered receipt blinding (opening fails)', seed(), env({ rReceipt: beHex(0xDEADn) }));
rejects('unknown pool', seed({ withPools: false }), env());

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
