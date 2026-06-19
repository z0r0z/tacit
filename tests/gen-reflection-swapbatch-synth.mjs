#!/usr/bin/env node
// Build a full-scan reflection input around a SYNTHETIC, REAL-PROVEN T_SWAP_BATCH (0x2F): construct a valid
// amm_swap_batch witness (1-intent A→B), fullProve it with the ceremony HEAD zkey (whose vk == the guest's
// batch_vk.bin), serialize the 0x2F envelope (secp commits + a real xcurve sigma + a balancing aggregate r_net +
// the 256B proof), seed the pool + the trader's c_in, and run the assembler (swapBatchFold hook, groth16Ok from
// the real verify) → the reflect-exec input + newDigest. The guest then re-derives the publics, runs its in-zkVM
// BN254 Groth16 over the proof, re-checks the aggregate + xcurve, and must land on this newDigest (DIGEST_MATCH).
//   REFLECT_SWAPBATCH_ZKEY=/tmp/head-swapbatch.zkey node tests/gen-reflection-swapbatch-synth.mjs > /tmp/swapbatch-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { foldSwapBatch, swapBatchPublicSignals, swapBatchGroth16Verify } from '../dapp/confidential-swapbatch.js';
import { pedersenCommit, pointToBytes } from '../dapp/bulletproofs.js';
import { pedersenBJJ, packPoint, P_FR, mod as bmod } from '../dapp/amm-bjj.js';
import { proveXCurveDeterministic } from '../dapp/amm-sigma.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat } from './btc-mini.mjs';

const require = createRequire(import.meta.url);
const snarkjs = require('snarkjs');
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const N = secp.CURVE.n;
const mod = (a, m) => ((a % m) + m) % m;
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const hb = (h) => Buffer.from(String(h).replace(/^0x/, ''), 'hex');
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const be32buf = (n) => Buffer.from(BigInt(n).toString(16).padStart(64, '0'), 'hex');
const bytesToBig = (b) => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; };
const hb32 = (h) => Buffer.from(String(h).replace(/^0x/, '').padStart(64, '0'), 'hex');
const commitZero = (r) => hx(secp.ProjectivePoint.BASE.multiply(mod(BigInt(r), N)).toRawBytes(true)); // 0·H + r·G

const ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32), ZERO33 = '0x' + '00'.repeat(33), ZERO_OWNER = '0x' + '00'.repeat(32);
const BLOCK_HEIGHT = 318000;
const reserveA = 1000000n, reserveB = 2000000n, feeBps = 30;
const X = 1000n, Y = 1900n;                                    // amount_in (A), amount_out (B); δa=+X, δb=−Y
const rInSecp = 0x1001n, rOutSecp = 0x2002n, rInBjj = 0x12345n, rOutBjj = 0x67890n, rTipA = 0x4004n, rTipB = 0x5005n;
const seedTxid = Buffer.alloc(32, 0x2f), seedVout = 0;
const poolId = pool.ammDerivePoolIdFull(ASSET_A, ASSET_B, feeBps, 0, ZERO33, 0);

// ── 1. fullProve the circuit (head zkey == ceremony vk == guest batch_vk.bin) ──
const ZKEY = process.env.REFLECT_SWAPBATCH_ZKEY || '/tmp/head-swapbatch.zkey';
const WASM = './dapp/circuits/amm/build/amm_swap_batch_js/amm_swap_batch.wasm';
const N_MAX = 16, pad = (vals, p) => { const a = vals.slice(); while (a.length < N_MAX) a.push(p); return a.map((x) => x.toString()); };
const cInBjjP = pedersenBJJ(X, rInBjj), cOutBjjP = pedersenBJJ(Y, rOutBjj);
const circuitInput = {
  pool_id_fr: bmod(bytesToBig(sha256(hb32(poolId))), P_FR).toString(),
  R_A_pre: reserveA.toString(), R_B_pre: reserveB.toString(),
  delta_A_net_sign: '0', delta_A_net_magnitude: X.toString(), delta_B_net_sign: '1', delta_B_net_magnitude: Y.toString(),
  tip_A_amount: '0', tip_B_amount: '0', fee_bps: feeBps.toString(), n_intents: '1',
  direction: pad([0n], 0n), C_in_BJJ_u: pad([cInBjjP[0]], 0n), C_in_BJJ_v: pad([cInBjjP[1]], 1n),
  min_out: pad([0n], 0n), tip_amount: pad([0n], 0n), C_out_BJJ_u: pad([cOutBjjP[0]], 0n), C_out_BJJ_v: pad([cOutBjjP[1]], 1n),
  amount_in_swap: pad([X], 0n), tip_amount_witness: pad([0n], 0n), r_in_BJJ: pad([rInBjj], 0n),
  amount_out: pad([Y], 0n), rem: pad([0n], 0n), r_out_BJJ: pad([rOutBjj], 0n),
};
const groth16 = snarkjs.groth16 || (snarkjs.default && snarkjs.default.groth16);
console.error(`fullProve with ${ZKEY} (~95MB zkey + circuit; ~1-2 min)…`);
const { proof, publicSignals } = await groth16.fullProve(circuitInput, new Uint8Array(readFileSync(WASM)), new Uint8Array(readFileSync(ZKEY)));
const proofBytes = Buffer.concat([be32buf(proof.pi_a[0]), be32buf(proof.pi_a[1]), be32buf(proof.pi_b[0][0]), be32buf(proof.pi_b[0][1]), be32buf(proof.pi_b[1][0]), be32buf(proof.pi_b[1][1]), be32buf(proof.pi_c[0]), be32buf(proof.pi_c[1])]);

// ── 2. secp commits, BJJ commits, the receipt xcurve sigma, the balancing aggregate residues ──
const cInSecp = hx(pointToBytes(pedersenCommit(X, rInSecp)));
const cOutSecp = hx(pointToBytes(pedersenCommit(Y, rOutSecp)));
const cInBjj = hx(packPoint(cInBjjP)), cOutBjj = hx(packPoint(cOutBjjP));
const { proof: outXcurveSigma } = proveXCurveDeterministic({ a: Y, r_secp: rOutSecp, r_BJJ: rOutBjj, seedKey: new Uint8Array(32).fill(9), C_secp: pedersenCommit(Y, rOutSecp), C_BJJ: cOutBjjP });
const rNetA = '0x' + mod(rInSecp - rTipA, N).toString(16).padStart(64, '0');
const rNetB = '0x' + mod(-(rOutSecp + rTipB), N).toString(16).padStart(64, '0');

const env = {
  assetA: ASSET_A, assetB: ASSET_B, nIntents: 1, feeBps,
  deltaANetSign: 0, deltaANetMag: X.toString(), deltaBNetSign: 1, deltaBNetMag: Y.toString(),
  rNetA, rNetB, tipAAmount: '0', tipBAmount: '0', tipACSecp: commitZero(rTipA), tipBCSecp: commitZero(rTipB),
  intents: [{ direction: 0, cInSecp, cInBjj, minOut: '0', tipAmount: '0' }],
  receipts: [{ cOutSecp, cOutBjj, outXcurveSigma: hx(outXcurveSigma) }],
  proof: hx(proofBytes),
};

// ── 3. serialize the 0x2F envelope (worker decodeTSwapBatchPayload inverse; worker-only fields zeroed) ──
const signedU64 = (sign, mag) => Buffer.concat([Buffer.from([sign]), u64le(mag)]);
const intentBytes = cat([[0x00], Buffer.alloc(33), hb(cInSecp), hb(cInBjj), Buffer.alloc(169), u64le(0), u64le(0), Buffer.alloc(4), Buffer.alloc(64)]); // 352
const receiptBytes = cat([hb(cOutSecp), hb(cOutBjj), Buffer.from(outXcurveSigma)]); // 234
const envelope = cat([
  [0x2f], hb(ASSET_A), hb(ASSET_B), [0x01],
  signedU64(0, X), signedU64(1, Y), hb(rNetA), hb(rNetB), u16le(feeBps), u64le(0), u64le(0), hb(env.tipACSecp), hb(env.tipBCSecp),
  be32buf(rTipA), be32buf(rTipB), intentBytes, receiptBytes, u16le(proofBytes.length), proofBytes, [0x00],
]);

// ── 4. the swap_batch tx: spend the trader's c_in + the 0x2F envelope in the witness ──
const pushData = (b) => b.length < 0x4c
  ? cat([[b.length], b])
  : b.length <= 0xff
    ? cat([[0x4c, b.length], b])
    : cat([[0x4d, b.length & 0xff, (b.length >> 8) & 0xff], b]);
const payloadPushes = [];
for (let i = 0; i < envelope.length; i += 520) payloadPushes.push(pushData(envelope.subarray(i, Math.min(i + 520, envelope.length))));
const tapscript = cat([
  [0x20], Buffer.alloc(32), [0xac], [0x00, 0x63],
  [0x05], Buffer.from('TACIT'), [0x01, 0x01],
  ...payloadPushes,
  [0x68],
]);
const inputsBuf = cat([seedTxid, u32le(seedVout), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
const txid = computeTxid(tx), txidHex = '0x' + Buffer.from(txid).toString('hex');
// Authenticate the witness-carried envelope with a valid BIP141 coinbase commitment. Without this,
// the reflection guest deliberately ignores every Taproot envelope in the block.
const dsha = (b) => sha256(sha256(b));
const reserved = Buffer.alloc(32, 7);
const witnessRoot = dsha(cat([Buffer.alloc(32), dsha(tx)])); // coinbase wtxid is defined as zero
const wcommit = dsha(cat([witnessRoot, reserved]));
const coinbase = cat([
  [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
  [0x01], Buffer.alloc(32), [0xff, 0xff, 0xff, 0xff], [0x00], [0xff, 0xff, 0xff, 0xff],
  [0x01], Buffer.alloc(8), [0x26], [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed], wcommit,
  [0x01], [0x20], reserved,
  Buffer.alloc(4),
]);
const cbTxid = computeTxid(coinbase);
const coinbaseSpec = { txData: hx(coinbase), txid: hx(cbTxid), vins: [], env: null };
const header = mineHeader(computeMerkleRoot([cbTxid, txid]));

// ── 5. seed the pool + the trader's c_in (a live A note) ──
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.pools.load([{ poolId, assetA: ASSET_A, assetB: ASSET_B, reserveA: reserveA.toString(), reserveB: reserveB.toString(), totalShares: '1000', c0Backed: true, protocolFeeBps: 0, kLast: (reserveA * reserveB).toString(), protocolFeeAccrued: '0' }]);
const cInXY = pool.decompressCommitment(cInSecp);
const coords = new Map();
const inOutpoint = pool.outpointKey('0x' + seedTxid.toString('hex'), seedVout);
state.foldOutput(pool.leaf(ASSET_A, cInXY.cx, cInXY.cy, ZERO_OWNER), inOutpoint, pool.commitmentHash(cInXY.cx, cInXY.cy), ASSET_A);
coords.set(inOutpoint.toLowerCase(), { cx: cInXY.cx, cy: cInXY.cy });

// ── 6. fixture sanity check: my publics == the circuit's, and the proof verifies against the inline ceremony
// vk (the SAME vk + reserves the fold uses internally — foldSwapBatch now does the Groth16 verify itself). ──
const inlineVk = JSON.parse(readFileSync(process.env.SWAPBATCH_VK || '/tmp/swapbatch-inline-vk.json'));
const mine = swapBatchPublicSignals(env, poolId, reserveA, reserveB).map((x) => x.toString());
const pubMatch = mine.every((v, i) => v === publicSignals[i]);
const groth16Ok = await swapBatchGroth16Verify(inlineVk, mine.map(BigInt), proofBytes);
console.error(`publics match circuit=${pubMatch} groth16(inline vk)=${groth16Ok}`);

const txSpec = { txData: '0x' + tx.toString('hex'), txid: txidHex, vins: [{ prevTxid: '0x' + seedTxid.toString('hex'), vout: seedVout }], env: { type: 'swap_batch', ...env } };
const swapBatchFold = (e, tid, spends) => foldSwapBatch(pool, state, e, tid, spends, { vk: inlineVk });
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [coinbaseSpec, txSpec] }], swapBatchFold,
}, coords);

const sb = input.blocks[0].txs[1].swapBatch;
const p = state.pools.get(poolId);
console.error(`swap_batch: ${X}A→${Y}B folded=${!!sb} receipts=${sb ? sb.receiptPaths.length : 0} reservesPost=A:${p.reserveA} B:${p.reserveB} newDigest=${input.newDigest}`);
if (!pubMatch || !groth16Ok || !sb) { console.error('FATAL: publics/groth16/fold failed — fixture would not validate'); process.exit(1); }
console.log(JSON.stringify(input));
