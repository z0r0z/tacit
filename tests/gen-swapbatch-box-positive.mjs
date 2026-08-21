#!/usr/bin/env node
// REAL amm_swap_batch Groth16 proofs for the box POSITIVE batch vector (ops/REPROVE-amm-box-vectors.md #10):
// n=1, n=2 and a full n=16 batch, each proven under the FINALIZED AMM ceremony zkey so the artifacts verify
// against the guest's baked batch_vk() (contracts/sp1/confidential/fixtures/swap_batch_vk.json).
//
//   REFLECT_SWAPBATCH_ZKEY=/tmp/swap_batch_final.zkey node tests/gen-swapbatch-box-positive.mjs
//
// Provenance of the zkey is the ceremony head_cid — see the header of
// contracts/sp1/confidential/fixtures/gen-swapbatch-ceremony-vector.mjs for the fetch recipe.
//
// Fills come from the clearing solver (tests/amm-clearing.mjs — solveClearing + amountOutForTrader, the same
// pair tests/amm-batch-fuzz.test.mjs drives the N=16 witness with), so a fill-math drift breaks this run.
// The declared net deltas are the SOLVER's delta_a_net/delta_b_net, not the sum of the floored fills: the
// circuit re-derives P_clear from the declared deltas, and floor dust (which stays in the pool) makes those
// two disagree on mixed batches. dapp/confidential-swapblind.js buildSwapInput declares fill-summed deltas
// instead and therefore cannot produce a witness for a mixed n=16 batch — see the README.
// BJJ blindings come from a SHA256-CTR stream keyed per case, so every artifact here is byte-reproducible.
//
// Per case it writes ops/box-artifacts/swapbatch-positive/n<N>/{input,proof,public,meta}.json and asserts:
//   (1) the circuit emits 123 public signals,
//   (2) swapBatchPublicSignals() re-derives all 123 exactly (the settle/fold side agrees with the circuit),
//   (3) the proof verifies against the CEREMONY vk via swapBatchGroth16Verify (256-byte serialization),
//   (4) mutating the proof's A/B/C points is rejected.
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

// Deterministic BJJ blinding stream: SHA256-CTR, reseeded per case.
let rngState = new Uint8Array(32), rngBuf = new Uint8Array(0), rngOff = 0;
const reseed = (label) => { rngState = sha256(Buffer.from(`tacit-box-swapbatch-positive-v1/${label}`)); rngBuf = new Uint8Array(0); rngOff = 0; };
const rngByte = () => { if (rngOff >= rngBuf.length) { rngState = sha256(rngState); rngBuf = rngState; rngOff = 0; } return rngBuf[rngOff++]; };

import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { pedersenBJJ, packPoint, P_FR, mod, N_BJJ } from '../dapp/amm-bjj.js';
import { parseGroth16Proof256, swapBatchPublicSignals, swapBatchGroth16Verify } from '../dapp/confidential-swapbatch.js';
import { solveClearing, amountOutForTrader } from './amm-clearing.mjs';

const randBjj = () => { for (;;) { let n = 0n; for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(rngByte()); if (n > 0n && n < N_BJJ) return n; } };

const require = createRequire(import.meta.url);
const snarkjs = require('snarkjs');
const groth16 = snarkjs.groth16 || (snarkjs.default && snarkjs.default.groth16);
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

const bytesToBig = (b) => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; };
const hb32 = (h) => Buffer.from(String(h).replace(/^0x/, '').padStart(64, '0'), 'hex');
const be32 = (dec) => { let v = BigInt(dec); const o = new Uint8Array(32); for (let i = 31; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
const hex = (b) => '0x' + Buffer.from(b).toString('hex');

const WASM = './dapp/circuits/amm/build/amm_swap_batch_js/amm_swap_batch.wasm';
const ZKEY = process.env.REFLECT_SWAPBATCH_ZKEY || '/tmp/swap_batch_final.zkey';
const VK = JSON.parse(readFileSync(process.env.SWAPBATCH_VK || 'contracts/sp1/confidential/fixtures/swap_batch_vk.json', 'utf8'));
const OUTDIR = 'ops/box-artifacts/swapbatch-positive';
const N_MAX = 16;

const ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32), ZERO33 = '0x' + '00'.repeat(33);
const FEE_BPS = 30, R_A = 10_000_000n, R_B = 20_000_000n;
const POOL_ID = pool.ammDerivePoolIdFull(ASSET_A, ASSET_B, FEE_BPS, 0, ZERO33, 0);
const POOL_ID_FR = mod(bytesToBig(sha256(hb32(POOL_ID))), P_FR);

// n=1 one-sided; n=2 crossing pair; n=16 mixed book with varied sizes (all A→B and B→A slots exercised).
const CASES = [
  { n: 1, traders: [{ direction: 0, amountIn: 1000n }] },
  { n: 2, traders: [{ direction: 0, amountIn: 5000n }, { direction: 1, amountIn: 7000n }] },
  { n: 16, traders: Array.from({ length: 16 }, (_, i) => ({ direction: i % 2, amountIn: BigInt(1000 + i * 137) * (i % 2 ? 2n : 1n) })) },
];

let failures = 0;
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

const wasm = new Uint8Array(readFileSync(WASM));
const zkeyBytes = new Uint8Array(readFileSync(ZKEY));
console.error(`zkey=${ZKEY} (${zkeyBytes.length} B), vk nPublic=${VK.nPublic}`);
mkdirSync(OUTDIR, { recursive: true });

for (const c of CASES) {
  const label = `n${c.n}`;
  reseed(label);

  const X = c.traders.filter((t) => t.direction === 0).reduce((s, t) => s + t.amountIn, 0n);
  const Y = c.traders.filter((t) => t.direction === 1).reduce((s, t) => s + t.amountIn, 0n);
  const solve = solveClearing(X, Y, R_A, R_B, BigInt(FEE_BPS));
  if (solve.direction !== 'A→B' && solve.direction !== 'B→A') throw new Error(`[${label}] unexpected clearing direction ${solve.direction}`);

  // The circuit's P_clear comes from the DECLARED net deltas (A-dom: (X_sum, Y_sum+|Δb|), B-dom:
  // (X_sum+|Δa|, Y_sum)), so the declared deltas must be the solver's — the floor dust stays in the pool.
  const deltas = solve.direction === 'A→B'
    ? { deltaANetSign: 0, deltaANetMag: solve.delta_a_net, deltaBNetSign: 1, deltaBNetMag: solve.delta_b_net }
    : { deltaANetSign: 1, deltaANetMag: solve.delta_a_net, deltaBNetSign: 0, deltaBNetMag: solve.delta_b_net };

  const slot = (v) => { const a = new Array(N_MAX).fill(v); return a; };
  const input = {
    pool_id_fr: POOL_ID_FR.toString(), R_A_pre: R_A.toString(), R_B_pre: R_B.toString(),
    delta_A_net_sign: String(deltas.deltaANetSign), delta_A_net_magnitude: deltas.deltaANetMag.toString(),
    delta_B_net_sign: String(deltas.deltaBNetSign), delta_B_net_magnitude: deltas.deltaBNetMag.toString(),
    tip_A_amount: '0', tip_B_amount: '0', fee_bps: String(FEE_BPS), n_intents: String(c.n),
    direction: slot('0'), min_out: slot('0'), tip_amount: slot('0'),
    amount_in_swap: slot('0'), tip_amount_witness: slot('0'), r_in_BJJ: slot('0'),
    amount_out: slot('0'), rem: slot('0'), r_out_BJJ: slot('0'),
    C_in_BJJ_u: slot('0'), C_in_BJJ_v: slot('1'), C_out_BJJ_u: slot('0'), C_out_BJJ_v: slot('1'),
  };

  const filled = [];
  for (let i = 0; i < c.traders.length; i++) {
    const t = c.traders[i];
    const amountOut = amountOutForTrader(t.amountIn, t.direction === 0 ? 'A→B' : 'B→A', solve.P_clear_num, solve.P_clear_den);
    const [mult, div] = t.direction === 0 ? [solve.P_clear_den, solve.P_clear_num] : [solve.P_clear_num, solve.P_clear_den];
    const rem = t.amountIn * mult - amountOut * div;
    // min_out at 90% of the actual fill, so the circuit's min_out ≤ amount_out check is load-bearing.
    const minOut = (amountOut * 9n) / 10n;
    const rIn = randBjj(), rOut = randBjj();
    const cIn = pedersenBJJ(t.amountIn, rIn), cOut = pedersenBJJ(amountOut, rOut);

    input.direction[i] = String(t.direction);
    input.min_out[i] = minOut.toString();
    input.amount_in_swap[i] = t.amountIn.toString();
    input.r_in_BJJ[i] = rIn.toString();
    input.amount_out[i] = amountOut.toString();
    input.rem[i] = rem.toString();
    input.r_out_BJJ[i] = rOut.toString();
    input.C_in_BJJ_u[i] = cIn[0].toString(); input.C_in_BJJ_v[i] = cIn[1].toString();
    input.C_out_BJJ_u[i] = cOut[0].toString(); input.C_out_BJJ_v[i] = cOut[1].toString();
    filled.push({ ...t, minOut, amountOut, rem, cInBjj: packPoint(cIn), cOutBjj: packPoint(cOut) });
  }

  console.error(`[${label}] proving ${c.n} intent(s) — full 16-slot circuit, ~1-2 min…`);
  const t0 = Date.now();
  const { proof, publicSignals } = await groth16.fullProve(input, wasm, zkeyBytes);
  console.error(`[${label}] proved in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  ok(publicSignals.length === 123, `[${label}] circuit emitted 123 public signals`);

  const env = {
    assetA: ASSET_A, assetB: ASSET_B, nIntents: c.n, feeBps: FEE_BPS,
    deltaANetSign: deltas.deltaANetSign, deltaANetMag: deltas.deltaANetMag.toString(),
    deltaBNetSign: deltas.deltaBNetSign, deltaBNetMag: deltas.deltaBNetMag.toString(),
    tipAAmount: '0', tipBAmount: '0',
    intents: filled.map((f) => ({ direction: f.direction, cInBjj: hex(f.cInBjj), minOut: BigInt(f.minOut).toString(), tipAmount: '0' })),
    receipts: filled.map((f) => ({ cOutBjj: hex(f.cOutBjj) })),
  };
  const mine = swapBatchPublicSignals(env, POOL_ID, R_A, R_B).map((x) => x.toString());
  const bad = mine.findIndex((v, i) => v !== publicSignals[i]);
  ok(bad === -1, `[${label}] swapBatchPublicSignals == the circuit's 123 publics${bad === -1 ? '' : ` — first mismatch @${bad}: ${mine[bad]} vs ${publicSignals[bad]}`}`);

  const proof256 = new Uint8Array([
    ...be32(proof.pi_a[0]), ...be32(proof.pi_a[1]),
    ...be32(proof.pi_b[0][0]), ...be32(proof.pi_b[0][1]), ...be32(proof.pi_b[1][0]), ...be32(proof.pi_b[1][1]),
    ...be32(proof.pi_c[0]), ...be32(proof.pi_c[1]),
  ]);
  ok(await swapBatchGroth16Verify(VK, publicSignals.map(BigInt), proof256), `[${label}] proof verifies against the CEREMONY vk`);
  const parsed = parseGroth16Proof256(proof256);
  ok(parsed?.pi_b?.[0]?.[0] === proof.pi_b[0][0] && parsed?.pi_b?.[1]?.[1] === proof.pi_b[1][1], `[${label}] G2 Fp2 limbs round-trip in native [c0,c1] order`);

  let rejected = true;
  for (const [pt, off] of [['A', 0], ['B', 64], ['C', 192]]) {
    const t = new Uint8Array(proof256); t[off] ^= 1;
    if (await swapBatchGroth16Verify(VK, publicSignals.map(BigInt), t)) { rejected = false; console.error(`FAIL [${label}] mutated proof point ${pt} verified`); }
  }
  ok(rejected, `[${label}] mutating proof points A/B/C is rejected`);

  const dir = `${OUTDIR}/${label}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/input.json`, JSON.stringify(input, null, 2));
  writeFileSync(`${dir}/proof.json`, JSON.stringify(proof, null, 2));
  writeFileSync(`${dir}/public.json`, JSON.stringify(publicSignals, null, 2));
  writeFileSync(`${dir}/meta.json`, JSON.stringify({
    vector: 'ops/REPROVE-amm-box-vectors.md #10 (POSITIVE batch)',
    n_intents: c.n,
    pool: { assetA: ASSET_A, assetB: ASSET_B, feeBps: FEE_BPS, poolId: POOL_ID, poolIdFr: POOL_ID_FR.toString(), reserveA: R_A.toString(), reserveB: R_B.toString() },
    clearing: { direction: solve.direction, P_clear_num: solve.P_clear_num.toString(), P_clear_den: solve.P_clear_den.toString() },
    deltas: { signA: deltas.deltaANetSign, magA: deltas.deltaANetMag.toString(), signB: deltas.deltaBNetSign, magB: deltas.deltaBNetMag.toString() },
    intents: filled.map((f) => ({ direction: f.direction, amountIn: BigInt(f.amountIn).toString(), minOut: BigInt(f.minOut).toString(), amountOut: f.amountOut.toString(), rem: f.rem.toString(), cInBjj: hex(f.cInBjj), cOutBjj: hex(f.cOutBjj) })),
    proof256: hex(proof256),
    zkey: { path: ZKEY, bytes: zkeyBytes.length },
    circuit: { wasm: WASM, nPublic: 123, nMax: 16 },
  }, null, 2));
  console.log(`wrote ${dir}/{input,proof,public,meta}.json`);
}

console.log(failures ? `\n${failures} FAIL` : `\nall ok — ${CASES.length} real ceremony-key batch proofs under ${OUTDIR}`);
process.exit(failures ? 1 : 0);
