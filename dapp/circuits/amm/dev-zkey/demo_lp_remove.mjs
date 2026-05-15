#!/usr/bin/env node
// End-to-end Groth16 demo for amm_lp_remove (companion to demo.mjs which
// covers amm_lp_add).
//
// Run from /Users/z/tacit:
//   node dapp/circuits/amm/dev-zkey/demo_lp_remove.mjs
//
// Prereqs (built by the surrounding ceremony script in the parent chat):
//   dev-zkey/pot14_final.ptau
//   dev-zkey/amm_lp_remove_final.zkey
//   dev-zkey/amm_lp_remove_vkey.json
//
// Steps:
//   1. Build a valid LP_REMOVE witness input via reference BJJ Pedersen.
//   2. Calculate witness via the circom-emitted wasm.
//   3. Generate a real Groth16 proof.
//   4. Verify against the dev verification key.
//   5. Negative control: tamper a public signal, must reject.

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

function randomBJJBlinding() {
  while (true) {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    let n = 0n;
    for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(buf[i]);
    if (n > 0n && n < N_BJJ) return n;
  }
}

// ---- 1. LP_REMOVE input ----
const shareAmount = 1000n;
const deltaA      = 500n;
const deltaB      = 1000n;
const r_recv_A    = randomBJJBlinding();
const r_recv_B    = randomBJJBlinding();
const C_recv_A    = pedersenBJJ(deltaA, r_recv_A);
const C_recv_B    = pedersenBJJ(deltaB, r_recv_B);

const input = {
  pool_id_fr   : '12345678901234567890',
  share_amount : shareAmount.toString(),
  delta_A      : deltaA.toString(),
  delta_B      : deltaB.toString(),
  recv_A_BJJ_u : C_recv_A[0].toString(),
  recv_A_BJJ_v : C_recv_A[1].toString(),
  recv_B_BJJ_u : C_recv_B[0].toString(),
  recv_B_BJJ_v : C_recv_B[1].toString(),
  r_recv_A_BJJ : r_recv_A.toString(),
  r_recv_B_BJJ : r_recv_B.toString(),
};
writeFileSync(`${DEV_ZKEY}/input_lp_remove.json`, JSON.stringify(input, null, 2));
console.log('[1/4] LP_REMOVE input written');
console.log(`      share_amount = ${shareAmount}`);
console.log(`      delta_A      = ${deltaA}, delta_B = ${deltaB}`);

function snarkjs(args) {
  return execSync(`${SNARKJS} ${args}`, { cwd: ROOT, stdio: 'pipe' }).toString();
}

// ---- 2. Witness ----
const wasm = `${CIRC_DIR}/build/amm_lp_remove_js/amm_lp_remove.wasm`;
snarkjs(`wtns calculate ${wasm} ${DEV_ZKEY}/input_lp_remove.json ${DEV_ZKEY}/witness_lp_remove.wtns`);
console.log('[2/4] witness_lp_remove.wtns generated');

// ---- 3. Prove ----
snarkjs(`groth16 prove ${DEV_ZKEY}/amm_lp_remove_final.zkey ${DEV_ZKEY}/witness_lp_remove.wtns ${DEV_ZKEY}/proof_lp_remove.json ${DEV_ZKEY}/public_lp_remove.json`);
const proof  = JSON.parse(readFileSync(`${DEV_ZKEY}/proof_lp_remove.json`,  'utf8'));
const pubSig = JSON.parse(readFileSync(`${DEV_ZKEY}/public_lp_remove.json`, 'utf8'));
console.log('[3/4] Groth16 proof generated');
console.log(`      curve     = ${proof.curve}`);
console.log(`      protocol  = ${proof.protocol}`);
console.log(`      pi_a[0]   = ${proof.pi_a[0].slice(0, 40)}…`);
console.log(`      public signals (${pubSig.length}):`);
const labels = ['pool_id_fr', 'share_amount', 'delta_A', 'delta_B',
                'recv_A_BJJ_u', 'recv_A_BJJ_v', 'recv_B_BJJ_u', 'recv_B_BJJ_v'];
for (let i = 0; i < pubSig.length; i++) {
  const lbl = labels[i] ?? `signal_${i}`;
  console.log(`        [${i}] ${lbl.padEnd(14)} = ${pubSig[i].slice(0, 50)}${pubSig[i].length > 50 ? '…' : ''}`);
}

// ---- 4. Verify ----
const verifyOut = snarkjs(`groth16 verify ${DEV_ZKEY}/amm_lp_remove_vkey.json ${DEV_ZKEY}/public_lp_remove.json ${DEV_ZKEY}/proof_lp_remove.json`);
const ok = /OK/.test(verifyOut);
console.log(`[4/4] verification: ${ok ? 'OK' : 'FAILED'}`);
if (!ok) { console.log(verifyOut); process.exit(1); }

// Negative control: tamper share_amount, verify must reject.
const badPub = [...pubSig];
badPub[1] = (BigInt(badPub[1]) + 1n).toString();
writeFileSync(`${DEV_ZKEY}/public_lp_remove_tampered.json`, JSON.stringify(badPub, null, 2));
let negFailed = false;
try {
  const out = snarkjs(`groth16 verify ${DEV_ZKEY}/amm_lp_remove_vkey.json ${DEV_ZKEY}/public_lp_remove_tampered.json ${DEV_ZKEY}/proof_lp_remove.json`);
  negFailed = !/OK/.test(out);
} catch { negFailed = true; }
console.log(`      negative control (tampered share_amount): ${negFailed ? 'rejected (good)' : 'ACCEPTED (BAD)'}`);
if (!negFailed) process.exit(2);

console.log('\nLP_REMOVE four-stage pipeline succeeded.');
