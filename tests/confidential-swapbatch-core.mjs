#!/usr/bin/env node
// swap_batch (T_SWAP_BATCH 0x2F) — the locally-validatable core of the reflection mirror: the aggregate
// Pedersen identity (the per-asset NO-INFLATION bound) + the envelope parser. The assembled fold also needs a
// BN254 Groth16 verify + per-receipt BabyJubJub sigma + the 123-signal derivation; those + the end-to-end
// reflect-exec DIGEST_MATCH need a real ceremony-zkey proof vector (the head zkey; the VK is inline in the dapp
// as _CANONICAL_AMM_VK_INLINE) — that's the box step. Here we pin the two pieces that ARE validatable now:
//   1. swapBatchAggregateIdentity — against cxfer-core's swap_batch_aggregate_identity_binds_receipts_to_inputs KAT.
//   2. parseSwapBatchEnvelope — round-trip a hand-built 0x2F envelope.
// Run: node tests/confidential-swapbatch-core.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { parseSwapBatchEnvelope } from '../dapp/burn-deposit-bitcoin.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const N = secp.CURVE.n;
const mod = (a, m) => ((a % m) + m) % m;
const beHex = (n) => '0x' + mod(BigInt(n), N).toString(16).padStart(64, '0');
const cat = (a) => Buffer.concat(a.map((x) => (Buffer.isBuffer(x) ? x : Buffer.from(x))));
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hb = (h) => Buffer.from(String(h).replace(/^0x/, ''), 'hex');
const compressPt = (P) => '0x' + Buffer.from(P.toRawBytes(true)).toString('hex');
const commitZero = (r) => compressPt(secp.ProjectivePoint.BASE.multiply(mod(BigInt(r), N))); // 0·H + r·G (a value-0 tip)
let failures = 0;
const eq = (a, b, m) => { if (a !== b) { console.error(`FAIL ${m}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${m}`); };
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

// ── 1. aggregate identity — the cxfer-core KAT vector (1-intent dir-0 batch, asset-A identity) ──
{
  const vIn = 1000n, deltaA = 1000n;
  const rIn = mod(BigInt('0x' + '31'.repeat(32)), N), rTip = mod(BigInt('0x' + '32'.repeat(32)), N);
  const cInXY = pool.commitXY(vIn, rIn), cIn = pool.compressXY(cInXY.cx, cInXY.cy);
  const tipA = commitZero(rTip); // 0·H + r_tip·G
  const rNetA = beHex(rIn - rTip);
  const intents = [{ direction: 0, cInSecp: cIn }];
  const receipts = [cIn]; // dir-0 intent is INPUT-side for asset A ⇒ its receipt isn't summed

  ok(pool.swapBatchAggregateIdentity(intents, receipts, true, 0, deltaA, tipA, rNetA), 'valid asset-A identity holds (C_in − tip − δ·H == R_net·G)');
  ok(!pool.swapBatchAggregateIdentity(intents, receipts, true, 0, deltaA, tipA, beHex(rIn - rTip + 1n)), 'wrong R_net rejected');
  ok(!pool.swapBatchAggregateIdentity(intents, receipts, true, 0, deltaA + 1n, tipA, rNetA), 'wrong delta magnitude rejected');
  ok(!pool.swapBatchAggregateIdentity(intents, receipts, true, 1, deltaA, tipA, rNetA), 'wrong delta sign rejected');

  // 2-intent: one A→B (asset-A input) + one B→A (asset-A output). Asset-A identity: C_in0 − C_out1 − tip − δ·H == R·G.
  const rIn0 = 500n, rOut1 = 700n, vIn0 = 800n, vOut1 = 300n, dA = vIn0 - vOut1; // δ_A = +(in−out) = 500
  const c0 = pool.compressXY(...Object.values(pool.commitXY(vIn0, rIn0)));
  const c1out = pool.compressXY(...Object.values(pool.commitXY(vOut1, rOut1)));
  const rTip0 = 3n, tip0 = commitZero(rTip0);
  const intents2 = [{ direction: 0, cInSecp: c0 }, { direction: 1, cInSecp: '0x' + '00'.repeat(33) }];
  const receipts2 = ['0x' + '00'.repeat(33), c1out]; // intent0 is input (receipt unused), intent1 is output
  ok(pool.swapBatchAggregateIdentity(intents2, receipts2, true, 0, dA, tip0, beHex(rIn0 - rOut1 - rTip0)), '2-intent asset-A identity holds (in − out − tip − δ·H == R·G)');
  ok(!pool.swapBatchAggregateIdentity(intents2, receipts2, true, 0, dA, tip0, beHex(rIn0 - rOut1 - rTip0 + 5n)), '2-intent wrong R_net rejected');
}

// ── 2. parser round-trip: a hand-built 1-intent 0x2F envelope decodes to the surfaced fields ──
{
  const assetA = '0x' + 'a1'.repeat(32), assetB = '0x' + 'b2'.repeat(32);
  const rNetA = '0x' + 'c1'.repeat(32), rNetB = '0x' + 'd2'.repeat(32);
  const tipAC = '0x02' + '11'.repeat(32), tipBC = '0x03' + '22'.repeat(32);
  const cInSecp = '0x02' + '33'.repeat(32), cInBjj = '0x' + '44'.repeat(32);
  const cOutSecp = '0x03' + '55'.repeat(32), cOutBjj = '0x' + '66'.repeat(32);
  const proof = Buffer.alloc(256, 0xab);
  const intent = cat([[0], Buffer.alloc(33), hb(cInSecp), hb(cInBjj), Buffer.alloc(169), u64le(700), u64le(9), Buffer.alloc(4), Buffer.alloc(64)]);
  const receipt = cat([hb(cOutSecp), hb(cOutBjj), Buffer.alloc(169)]);
  const env = cat([
    [0x2f], hb(assetA), hb(assetB), [1],
    [0], u64le(1500), [1], u64le(2500),         // δa = +1500, δb = −2500
    hb(rNetA), hb(rNetB), u16le(30), u64le(11), u64le(22), hb(tipAC), hb(tipBC),
    Buffer.alloc(32), Buffer.alloc(32),          // r_tip_a, r_tip_b
    intent, receipt, u16le(proof.length), proof, [0],
  ]);
  const d = parseSwapBatchEnvelope('0x' + env.toString('hex'));
  ok(d, 'envelope parses');
  eq(d.assetA, assetA, '  asset_a'); eq(d.assetB, assetB, '  asset_b'); eq(d.nIntents, 1, '  n_intents');
  eq(d.deltaANetSign, 0, '  δa sign'); eq(d.deltaANetMag, '1500', '  δa mag');
  eq(d.deltaBNetSign, 1, '  δb sign'); eq(d.deltaBNetMag, '2500', '  δb mag');
  eq(d.rNetA, rNetA, '  R_net_a'); eq(d.rNetB, rNetB, '  R_net_b');
  eq(d.feeBps, 30, '  fee_bps'); eq(d.tipAAmount, '11', '  tip_a'); eq(d.tipBAmount, '22', '  tip_b');
  eq(d.tipACSecp, tipAC, '  tip_a_c'); eq(d.tipBCSecp, tipBC, '  tip_b_c');
  eq(d.intents[0].direction, 0, '  intent dir'); eq(d.intents[0].cInSecp, cInSecp, '  intent c_in_secp');
  eq(d.intents[0].cInBjj, cInBjj, '  intent c_in_bjj'); eq(d.intents[0].minOut, '700', '  intent min_out'); eq(d.intents[0].tipAmount, '9', '  intent tip');
  eq(d.receipts[0].cOutSecp, cOutSecp, '  receipt c_out_secp'); eq(d.receipts[0].cOutBjj, cOutBjj, '  receipt c_out_bjj');
  eq(d.proof, '0x' + proof.toString('hex'), '  proof bytes');
  // reject: trailing garbage / bad opcode / bad n_intents
  eq(parseSwapBatchEnvelope('0x' + env.toString('hex') + 'ff'), null, 'trailing byte → null');
  eq(parseSwapBatchEnvelope('0x22' + env.toString('hex').slice(2)), null, 'wrong opcode → null');
}

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
