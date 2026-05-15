#!/usr/bin/env node
// One-shot end-to-end Groth16 demo for the amm_lp_add circuit.
//
// Run from /Users/z/tacit:
//   node dapp/circuits/amm/dev-zkey/demo.mjs
//
// Prerequisites (produced by the surrounding shell sequence in the parent
// chat, not by this script):
//   dev-zkey/pot13_final.ptau
//   dev-zkey/amm_lp_add_final.zkey
//   dev-zkey/amm_lp_add_vkey.json
//
// Steps performed here:
//   1. Build a valid LP_ADD witness input via the reference BJJ Pedersen
//      primitive (tests/amm-bjj.mjs).
//   2. Calculate witness via the circom-emitted wasm calculator.
//   3. Generate a real Groth16 proof against the dev zkey.
//   4. Verify the proof against the dev verification key.
//   5. Print proof shape + public signals + verification result.

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '../../../..');           // /Users/z/tacit
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

// ---- 1. Build a valid LP_ADD witness input ----
const shareAmount = 1_414_213n;             // u64 public — LP shares minted
const r_share_BJJ = randomBJJBlinding();    // private — BJJ scalar
const C_share     = pedersenBJJ(shareAmount, r_share_BJJ);
const pool_id_fr  = '12345678901234567890'; // SHA256(pool_id) mod p_Fr placeholder
const variant     = '0';                    // 0 = standard add

const input = {
  pool_id_fr,
  variant,
  share_amount  : shareAmount.toString(),
  C_share_BJJ_u : C_share[0].toString(),
  C_share_BJJ_v : C_share[1].toString(),
  r_share_BJJ   : r_share_BJJ.toString(),
};

writeFileSync(`${DEV_ZKEY}/input.json`, JSON.stringify(input, null, 2));
console.log('[1/4] generated LP_ADD input.json');
console.log(`      share_amount  = ${shareAmount}`);
console.log(`      C_share.u     = ${C_share[0].toString().slice(0, 40)}…`);
console.log(`      C_share.v     = ${C_share[1].toString().slice(0, 40)}…`);

function snarkjs(args) {
  return execSync(`${SNARKJS} ${args}`, { cwd: ROOT, stdio: 'pipe' }).toString();
}

// ---- 2. Witness calculation ----
const wasm = `${CIRC_DIR}/build/amm_lp_add_js/amm_lp_add.wasm`;
snarkjs(`wtns calculate ${wasm} ${DEV_ZKEY}/input.json ${DEV_ZKEY}/witness.wtns`);
console.log('[2/4] witness.wtns generated');

// ---- 3. Groth16 prove ----
snarkjs(`groth16 prove ${DEV_ZKEY}/amm_lp_add_final.zkey ${DEV_ZKEY}/witness.wtns ${DEV_ZKEY}/proof.json ${DEV_ZKEY}/public.json`);
const proof  = JSON.parse(readFileSync(`${DEV_ZKEY}/proof.json`,  'utf8'));
const pubSig = JSON.parse(readFileSync(`${DEV_ZKEY}/public.json`, 'utf8'));
console.log('[3/4] Groth16 proof generated');
console.log(`      curve     = ${proof.curve}`);
console.log(`      protocol  = ${proof.protocol}`);
console.log(`      pi_a[0]   = ${proof.pi_a[0].slice(0, 40)}…`);
console.log(`      pi_b[0][0]= ${proof.pi_b[0][0].slice(0, 40)}…`);
console.log(`      pi_c[0]   = ${proof.pi_c[0].slice(0, 40)}…`);
console.log(`      public signals (${pubSig.length}):`);
for (let i = 0; i < pubSig.length; i++) {
  const label = ['pool_id_fr', 'variant', 'share_amount', 'C_share_BJJ_u', 'C_share_BJJ_v'][i] ?? `signal_${i}`;
  console.log(`        [${i}] ${label.padEnd(14)} = ${pubSig[i].slice(0, 50)}${pubSig[i].length > 50 ? '…' : ''}`);
}

// ---- 4. Groth16 verify ----
const verifyOut = snarkjs(`groth16 verify ${DEV_ZKEY}/amm_lp_add_vkey.json ${DEV_ZKEY}/public.json ${DEV_ZKEY}/proof.json`);
const ok = /OK/.test(verifyOut);
console.log(`[4/4] verification: ${ok ? 'OK' : 'FAILED'}`);
if (!ok) {
  console.log(verifyOut);
  process.exit(1);
}

// Negative control: tamper a public signal, verify must fail.
const badPub = [...pubSig];
badPub[2] = (BigInt(badPub[2]) + 1n).toString();   // bump share_amount
writeFileSync(`${DEV_ZKEY}/public_tampered.json`, JSON.stringify(badPub, null, 2));
let negFailed = false;
try {
  const negOut = snarkjs(`groth16 verify ${DEV_ZKEY}/amm_lp_add_vkey.json ${DEV_ZKEY}/public_tampered.json ${DEV_ZKEY}/proof.json`);
  negFailed = !/OK/.test(negOut);
} catch { negFailed = true; }
console.log(`      negative control (tampered share_amount): ${negFailed ? 'rejected (good)' : 'ACCEPTED (BAD)'}`);
if (!negFailed) process.exit(2);

console.log('\nAll four pipeline stages succeeded.');
console.log('  - witness calculation (circom wasm)');
console.log('  - Groth16 proof generation (snarkjs, BN254)');
console.log('  - proof verification against committed vkey');
console.log('  - tampered-public-signal rejection');
