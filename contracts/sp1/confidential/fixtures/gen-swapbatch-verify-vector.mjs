// Emit a native-test vector for the in-guest BN254 Groth16 verifier (groth16_bn254_verify) of T_SWAP_BATCH.
// Source: the committed dev-zkey artifacts (a REAL bn128 swap_batch proof) — exported dev VK + proof +
// public signals + a tamper of the publics. Serialized to the guest's exact field-byte layout (big-endian
// 32-byte limbs; G2 in (x_c0, x_c1, y_c0, y_c1) order, matching groth16.rs g2()/batch_vk() and
// parseGroth16Proof256). The native Rust test (groth16.rs) include_bytes! this flat blob and confirms the
// verifier ACCEPTS the real proof and REJECTS a public-input tamper and a G2-limb swap — the auditor's M-01
// verifier checks, with NO in-zkVM run and no extra crate deps.
//
// Layout (16512 bytes): VK[0..8384] = alpha1(64) beta2(128) gamma2(128) delta2(128) ic(124*64);
//   PROOF[8384..8640] = a(64) b(128) c(64); PUBLICS[8640..12576] = 123*32; TAMPERED[12576..16512] = 123*32.
//
// Regenerate (dev VK lives in the committed zkey):
//   node ../../../../node_modules/.bin/snarkjs zkey export verificationkey \
//        ../../../../dapp/circuits/amm/dev-zkey/amm_swap_batch_final.zkey /tmp/swap_batch_dev_vk.json
//   node fixtures/gen-swapbatch-verify-vector.mjs
import fs from 'fs';

const DEV = '/Users/z/tacit/dapp/circuits/amm/dev-zkey';
const vk = JSON.parse(fs.readFileSync('/tmp/swap_batch_dev_vk.json', 'utf8'));
const proof = JSON.parse(fs.readFileSync(`${DEV}/proof_swap_batch.json`, 'utf8'));
const publics = JSON.parse(fs.readFileSync(`${DEV}/public_swap_batch.json`, 'utf8'));
const publicsTampered = JSON.parse(fs.readFileSync(`${DEV}/public_swap_batch_tampered.json`, 'utf8'));

const be32 = (dec) => { // decimal field string -> 32-byte big-endian Buffer
  let hex = BigInt(dec).toString(16);
  if (hex.length > 64) throw new Error('field overflow');
  return Buffer.from(hex.padStart(64, '0'), 'hex');
};
const g1 = (p) => Buffer.concat([be32(p[0]), be32(p[1])]);                          // (x, y) = 64
const g2 = (p) => Buffer.concat([be32(p[0][0]), be32(p[0][1]), be32(p[1][0]), be32(p[1][1])]); // 128

const vkBytes = Buffer.concat([
  g1(vk.vk_alpha_1), g2(vk.vk_beta_2), g2(vk.vk_gamma_2), g2(vk.vk_delta_2),
  ...vk.IC.map(g1),
]);
const proofBytes = Buffer.concat([g1(proof.pi_a), g2(proof.pi_b), g1(proof.pi_c)]);
const pubBytes = Buffer.concat(publics.map(be32));
const pubTamperBytes = Buffer.concat(publicsTampered.map(be32));

if (vkBytes.length !== 8384) throw new Error(`vk ${vkBytes.length} != 8384`);
if (proofBytes.length !== 256) throw new Error(`proof ${proofBytes.length} != 256`);
if (pubBytes.length !== 3936 || pubTamperBytes.length !== 3936) throw new Error('publics size');

const out = Buffer.concat([vkBytes, proofBytes, pubBytes, pubTamperBytes]);
fs.writeFileSync('fixtures/swapbatch_verify_vector.bin', out);
console.log('wrote fixtures/swapbatch_verify_vector.bin — %d bytes (vk 8384, proof 256, publics 3936x2)', out.length);
