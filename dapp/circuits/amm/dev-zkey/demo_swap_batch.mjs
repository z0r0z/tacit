#!/usr/bin/env node
// End-to-end Groth16 demo for amm_swap_batch (companion to demo.mjs and
// demo_lp_remove.mjs).
//
// Run from /Users/z/tacit:
//   node dapp/circuits/amm/dev-zkey/demo_swap_batch.mjs
//
// Prereqs (built by the surrounding ceremony / build-dev-zkey.sh script):
//   dev-zkey/pot18_final.ptau
//   dev-zkey/amm_swap_batch_final.zkey
//   dev-zkey/amm_swap_batch_vkey.json
//
// Steps:
//   1. Build a valid swap-batch witness input (single A→B trader on a 1:2
//      pool) via the reference clearing solver + BJJ Pedersen primitive.
//   2. Calculate witness via the circom-emitted wasm.
//   3. Generate a real Groth16 proof.
//   4. Verify against the dev verification key.
//   5. Negative control: tamper pool_id_fr (cross-pool replay defense),
//      verify must reject.

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '../../../..');
const CIRC_DIR  = resolve(ROOT, 'dapp/circuits/amm');
const DEV_ZKEY  = resolve(CIRC_DIR, 'dev-zkey');
const SNARKJS   = resolve(ROOT, 'dapp/circuits/node_modules/.bin/snarkjs');
const TESTS     = resolve(ROOT, 'tests');

const { pedersenBJJ, N_BJJ } = await import(resolve(TESTS, 'amm-bjj.mjs'));
const clearing               = await import(resolve(TESTS, 'amm-clearing.mjs'));

const N_MAX = 16;

function randomBJJBlinding() {
  while (true) {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    let n = 0n;
    for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(buf[i]);
    if (n > 0n && n < N_BJJ) return n;
  }
}

// Mirrors buildSwapInput in dapp/circuits/amm/witness-test.mjs. Re-implemented
// here so the demo file is self-contained for ceremony / CI bundling.
function buildSwapInput({ poolIdFr, R_A, R_B, fee_bps, traders }) {
  const X = traders.filter(t => t.direction === 0).reduce((s, t) => s + t.amount_in_swap, 0n);
  const Y = traders.filter(t => t.direction === 1).reduce((s, t) => s + t.amount_in_swap, 0n);
  const solve = clearing.solveClearing(X, Y, R_A, R_B, BigInt(fee_bps));

  const filled = traders.map(t => {
    const aOut = clearing.amountOutForTrader(
      t.amount_in_swap, t.direction, solve.P_clear_num, solve.P_clear_den
    );
    let mult, div;
    if (t.direction === 0) { mult = solve.P_clear_den; div = solve.P_clear_num; }
    else                   { mult = solve.P_clear_num; div = solve.P_clear_den; }
    const num = t.amount_in_swap * mult;
    const rem = num - aOut * div;
    return { ...t, amount_out: aOut, rem };
  });

  const tipA = filled.filter(t => t.direction === 0).reduce((s, t) => s + t.tip_amount, 0n);
  const tipB = filled.filter(t => t.direction === 1).reduce((s, t) => s + t.tip_amount, 0n);

  const direction          = new Array(N_MAX).fill('0');
  const min_out            = new Array(N_MAX).fill('0');
  const tip_amount         = new Array(N_MAX).fill('0');
  const amount_in_swap     = new Array(N_MAX).fill('0');
  const tip_amount_witness = new Array(N_MAX).fill('0');
  const r_in_BJJ           = new Array(N_MAX).fill('0');
  const amount_out         = new Array(N_MAX).fill('0');
  const rem                = new Array(N_MAX).fill('0');
  const r_out_BJJ          = new Array(N_MAX).fill('0');
  const C_in_BJJ_u         = new Array(N_MAX).fill('0');
  const C_in_BJJ_v         = new Array(N_MAX).fill('1');  // identity (0, 1)
  const C_out_BJJ_u        = new Array(N_MAX).fill('0');
  const C_out_BJJ_v        = new Array(N_MAX).fill('1');

  for (let i = 0; i < filled.length; i++) {
    const t = filled[i];
    const inTotal = t.amount_in_swap + t.tip_amount;
    const r_in = randomBJJBlinding();
    const r_out = randomBJJBlinding();
    const C_in = pedersenBJJ(inTotal, r_in);
    const C_out = pedersenBJJ(t.amount_out, r_out);

    direction[i]          = t.direction.toString();
    min_out[i]            = t.min_out.toString();
    tip_amount[i]         = t.tip_amount.toString();
    amount_in_swap[i]     = t.amount_in_swap.toString();
    tip_amount_witness[i] = t.tip_amount.toString();
    r_in_BJJ[i]           = r_in.toString();
    amount_out[i]         = t.amount_out.toString();
    rem[i]                = t.rem.toString();
    r_out_BJJ[i]          = r_out.toString();
    C_in_BJJ_u[i]         = C_in[0].toString();
    C_in_BJJ_v[i]         = C_in[1].toString();
    C_out_BJJ_u[i]        = C_out[0].toString();
    C_out_BJJ_v[i]        = C_out[1].toString();
  }

  let deltaA_sign = 0, deltaB_sign = 0;
  if (solve.direction === 'A→B')      { deltaA_sign = 0; deltaB_sign = 1; }
  else if (solve.direction === 'B→A') { deltaA_sign = 1; deltaB_sign = 0; }

  return {
    pool_id_fr           : poolIdFr,
    R_A_pre              : R_A.toString(),
    R_B_pre              : R_B.toString(),
    delta_A_net_sign     : deltaA_sign.toString(),
    delta_A_net_magnitude: solve.delta_a_net.toString(),
    delta_B_net_sign     : deltaB_sign.toString(),
    delta_B_net_magnitude: solve.delta_b_net.toString(),
    tip_A_amount         : tipA.toString(),
    tip_B_amount         : tipB.toString(),
    fee_bps              : fee_bps.toString(),
    n_intents            : filled.length.toString(),
    direction, C_in_BJJ_u, C_in_BJJ_v, min_out, tip_amount,
    C_out_BJJ_u, C_out_BJJ_v,
    amount_in_swap, tip_amount_witness, r_in_BJJ,
    amount_out, rem, r_out_BJJ,
  };
}

// ---- 1. Build swap-batch input ----
const POOL_ID_FR = '12345678901234567890';
const input = buildSwapInput({
  poolIdFr: POOL_ID_FR,
  R_A: 1_000_000n,
  R_B: 2_000_000n,
  fee_bps: 30,
  traders: [{
    direction      : 0,        // A→B
    amount_in_swap : 1000n,
    tip_amount     : 0n,
    min_out        : 0n,
  }],
});
writeFileSync(`${DEV_ZKEY}/input_swap_batch.json`, JSON.stringify(input, null, 2));
console.log('[1/4] swap-batch input written');
console.log(`      n_intents            = ${input.n_intents}`);
console.log(`      direction[0]         = ${input.direction[0]} (0=A→B, 1=B→A)`);
console.log(`      amount_in_swap[0]    = ${input.amount_in_swap[0]}`);
console.log(`      amount_out[0]        = ${input.amount_out[0]}`);
console.log(`      delta_A_net (sign,mag) = (${input.delta_A_net_sign}, ${input.delta_A_net_magnitude})`);
console.log(`      delta_B_net (sign,mag) = (${input.delta_B_net_sign}, ${input.delta_B_net_magnitude})`);

function snarkjs(args) {
  return execSync(`${SNARKJS} ${args}`, { cwd: ROOT, stdio: 'pipe' }).toString();
}

// ---- 2. Witness ----
const wasm = `${CIRC_DIR}/build/amm_swap_batch_js/amm_swap_batch.wasm`;
snarkjs(`wtns calculate ${wasm} ${DEV_ZKEY}/input_swap_batch.json ${DEV_ZKEY}/witness_swap_batch.wtns`);
console.log('[2/4] witness_swap_batch.wtns generated');

// ---- 3. Prove ----
snarkjs(`groth16 prove ${DEV_ZKEY}/amm_swap_batch_final.zkey ${DEV_ZKEY}/witness_swap_batch.wtns ${DEV_ZKEY}/proof_swap_batch.json ${DEV_ZKEY}/public_swap_batch.json`);
const proof  = JSON.parse(readFileSync(`${DEV_ZKEY}/proof_swap_batch.json`,  'utf8'));
const pubSig = JSON.parse(readFileSync(`${DEV_ZKEY}/public_swap_batch.json`, 'utf8'));
console.log('[3/4] Groth16 proof generated');
console.log(`      curve                = ${proof.curve}`);
console.log(`      protocol             = ${proof.protocol}`);
console.log(`      pi_a[0]              = ${proof.pi_a[0].slice(0, 40)}…`);
console.log(`      public signals length = ${pubSig.length} (expected 123)`);
const globalLabels = [
  'pool_id_fr', 'R_A_pre', 'R_B_pre',
  'delta_A_net_sign', 'delta_A_net_magnitude',
  'delta_B_net_sign', 'delta_B_net_magnitude',
  'tip_A_amount', 'tip_B_amount', 'fee_bps', 'n_intents',
];
for (let i = 0; i < globalLabels.length; i++) {
  console.log(`        [${i}] ${globalLabels[i].padEnd(22)} = ${pubSig[i]}`);
}

// ---- 4. Verify ----
const verifyOut = snarkjs(`groth16 verify ${DEV_ZKEY}/amm_swap_batch_vkey.json ${DEV_ZKEY}/public_swap_batch.json ${DEV_ZKEY}/proof_swap_batch.json`);
const ok = /OK/.test(verifyOut);
console.log(`[4/4] verification: ${ok ? 'OK' : 'FAILED'}`);
if (!ok) { console.log(verifyOut); process.exit(1); }

// Negative control: tamper pool_id_fr (cross-pool replay defense).
const badPub = [...pubSig];
badPub[0] = (BigInt(badPub[0]) + 1n).toString();
writeFileSync(`${DEV_ZKEY}/public_swap_batch_tampered.json`, JSON.stringify(badPub, null, 2));
let negFailed = false;
try {
  const out = snarkjs(`groth16 verify ${DEV_ZKEY}/amm_swap_batch_vkey.json ${DEV_ZKEY}/public_swap_batch_tampered.json ${DEV_ZKEY}/proof_swap_batch.json`);
  negFailed = !/OK/.test(out);
} catch { negFailed = true; }
console.log(`      negative control (tampered pool_id_fr): ${negFailed ? 'rejected (good)' : 'ACCEPTED (BAD)'}`);
if (!negFailed) process.exit(2);

console.log('\nswap_batch four-stage pipeline succeeded.');
