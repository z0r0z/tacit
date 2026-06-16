#!/usr/bin/env node
// END-TO-END swap_batch Groth16 validation: construct a valid amm_swap_batch circuit witness (a self-consistent
// 1-intent A→B batch), fullProve it with a REAL zkey + the circuit wasm, then assert (1) my swapBatchPublicSignals
// re-derivation EQUALS the circuit's own publicSignals (closes the "exact circom-signal order" gap), and (2) the
// real proof verifies via swapBatchGroth16Verify against that zkey's vk. Uses the LOCAL dev zkey by default (no
// network) to validate the witness + derivation + verify machinery; pass REFLECT_SWAPBATCH_ZKEY=<head zkey> +
// SWAPBATCH_VK=<inline vk json> to validate against the ceremony vk (the head-zkey step).
//   node tests/gen-swapbatch-prove.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { pedersenBJJ, packPoint, P_FR, mod } from '../dapp/amm-bjj.js';
import { swapBatchPublicSignals, swapBatchGroth16Verify } from '../dapp/confidential-swapbatch.js';

const require = createRequire(import.meta.url);
const snarkjs = require('snarkjs');
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const bytesToBig = (b) => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; };
const hb32 = (h) => Buffer.from(String(h).replace(/^0x/, '').padStart(64, '0'), 'hex');
const N_MAX = 16;
let failures = 0;
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

// ── a self-consistent 1-intent A→B batch (clearing: amount_out = floor(X·|δB|/|δA|); δA=+X, δB=−Y ⇒ amount_out=Y, rem=0) ──
const ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32), ZERO33 = '0x' + '00'.repeat(33);
const reserveA = 1000000n, reserveB = 2000000n, feeBps = 30;
const X = 1000n, Y = 1900n, rInBjj = 0x12345n, rOutBjj = 0x67890n;
const poolId = pool.ammDerivePoolIdFull(ASSET_A, ASSET_B, feeBps, 0, ZERO33, 0);
const cInBjjP = pedersenBJJ(X, rInBjj), cOutBjjP = pedersenBJJ(Y, rOutBjj);
const pad = (vals, padVal) => { const a = vals.slice(); while (a.length < N_MAX) a.push(padVal); return a.map((x) => x.toString()); };

const input = {
  pool_id_fr: mod(bytesToBig(sha256(hb32(poolId))), P_FR).toString(),
  R_A_pre: reserveA.toString(), R_B_pre: reserveB.toString(),
  delta_A_net_sign: '0', delta_A_net_magnitude: X.toString(),
  delta_B_net_sign: '1', delta_B_net_magnitude: Y.toString(),
  tip_A_amount: '0', tip_B_amount: '0', fee_bps: feeBps.toString(), n_intents: '1',
  direction: pad([0n], 0n),
  C_in_BJJ_u: pad([cInBjjP[0]], 0n), C_in_BJJ_v: pad([cInBjjP[1]], 1n),
  min_out: pad([0n], 0n), tip_amount: pad([0n], 0n),
  C_out_BJJ_u: pad([cOutBjjP[0]], 0n), C_out_BJJ_v: pad([cOutBjjP[1]], 1n),
  amount_in_swap: pad([X], 0n), tip_amount_witness: pad([0n], 0n), r_in_BJJ: pad([rInBjj], 0n),
  amount_out: pad([Y], 0n), rem: pad([0n], 0n), r_out_BJJ: pad([rOutBjj], 0n),
};

const WASM = './dapp/circuits/amm/build/amm_swap_batch_js/amm_swap_batch.wasm';
const ZKEY = process.env.REFLECT_SWAPBATCH_ZKEY || './dapp/circuits/amm/dev-zkey/amm_swap_batch_final.zkey';

const run = async () => {
  console.error(`proving with zkey=${ZKEY} (this loads a ~95MB zkey + runs the circuit — ~1-2 min)…`);
  const wasm = new Uint8Array(readFileSync(WASM));
  const zkey = new Uint8Array(readFileSync(ZKEY));
  const groth16 = snarkjs.groth16 || (snarkjs.default && snarkjs.default.groth16);
  const { proof, publicSignals } = await groth16.fullProve(input, wasm, zkey);
  ok(Array.isArray(publicSignals) && publicSignals.length === 123, `circuit emitted 123 public signals (got ${publicSignals.length})`);

  // (1) my swapBatchPublicSignals re-derivation == the circuit's publicSignals (EXACT circom-signal order).
  const env = {
    assetA: ASSET_A, assetB: ASSET_B, nIntents: 1, feeBps,
    deltaANetSign: 0, deltaANetMag: X.toString(), deltaBNetSign: 1, deltaBNetMag: Y.toString(),
    tipAAmount: '0', tipBAmount: '0',
    intents: [{ direction: 0, cInBjj: '0x' + Buffer.from(packPoint(cInBjjP)).toString('hex'), minOut: '0', tipAmount: '0' }],
    receipts: [{ cOutBjj: '0x' + Buffer.from(packPoint(cOutBjjP)).toString('hex') }],
  };
  const mine = swapBatchPublicSignals(env, poolId, reserveA, reserveB).map((x) => x.toString());
  const firstMismatch = mine.findIndex((v, i) => v !== publicSignals[i]);
  ok(firstMismatch === -1, `swapBatchPublicSignals == the circuit's publicSignals (all 123)${firstMismatch === -1 ? '' : ` — first mismatch @${firstMismatch}: mine ${mine[firstMismatch]} vs circuit ${publicSignals[firstMismatch]}`}`);

  // (2) the REAL proof verifies via my swapBatchGroth16Verify against this zkey's vk.
  const vk = process.env.SWAPBATCH_VK ? JSON.parse(readFileSync(process.env.SWAPBATCH_VK)) : await snarkjs.zKey.exportVerificationKey(new Uint8Array(readFileSync(ZKEY)));
  const be32 = (dec) => { let v = BigInt(dec); const o = new Uint8Array(32); for (let i = 31; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
  const proofBytes = new Uint8Array([...be32(proof.pi_a[0]), ...be32(proof.pi_a[1]), ...be32(proof.pi_b[0][0]), ...be32(proof.pi_b[0][1]), ...be32(proof.pi_b[1][0]), ...be32(proof.pi_b[1][1]), ...be32(proof.pi_c[0]), ...be32(proof.pi_c[1])]);
  ok(await swapBatchGroth16Verify(vk, mine.map(BigInt), proofBytes), 'real proof verifies via swapBatchGroth16Verify (256B-parse + my publics + the vk)');

  console.log(failures ? `\n${failures} FAIL` : '\nall ok — swap_batch Groth16 validated end-to-end against the real circuit');
  process.exit(failures ? 1 : 0);
};
run().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
