// Emit the ACTIVATION-GATE vector for the in-guest BN254 Groth16 verifier: a REAL proof produced under the
// FINALIZED AMM ceremony zkey, to be verified against the guest's BAKED `batch_vk()` (== fixtures/swap_batch_vk.json).
// Unlike gen-swapbatch-verify-vector.mjs (dev key), this validates the exact ceremony key burned into the guest.
//
// Provenance: the finalized swap_batch proving zkey is the head_cid of ceremony
//   2d9db81d741e59d65e1b52ac3d37c5da521ef8c3728e9cd715c9a8a45bd495f4 (GET api.tacit.finance/ceremony/<hash>),
//   whose snarkjs-exported VK equals fixtures/swap_batch_vk.json. Regenerate:
//     HASH=2d9db81d741e59d65e1b52ac3d37c5da521ef8c3728e9cd715c9a8a45bd495f4
//     CID=$(curl -s api.tacit.finance/ceremony/$HASH | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).state.head_cid))")
//     curl -s -o /tmp/swap_batch_final.zkey https://gateway.pinata.cloud/ipfs/$CID   # ~95 MB, magic "zkey"
//     node ../../../node_modules/.bin/snarkjs groth16 prove /tmp/swap_batch_final.zkey \
//          ../../../dapp/circuits/amm/dev-zkey/witness_swap_batch.wtns /tmp/cer_proof.json /tmp/cer_public.json
//     node fixtures/gen-swapbatch-ceremony-vector.mjs
//
// Layout (8128 bytes): PROOF[0..256] = a(64) b(128) c(64); PUBLICS[256..4192] = 123*32; TAMPERED[4192..8128] = 123*32.
// G2 limb order (x_c0, x_c1, y_c0, y_c1), matching groth16.rs g2()/g2at() and parseGroth16Proof256. No VK — the
// native test verifies against batch_vk() itself.
import fs from 'fs';

const proof = JSON.parse(fs.readFileSync('/tmp/cer_proof.json', 'utf8'));
const publics = JSON.parse(fs.readFileSync('/tmp/cer_public.json', 'utf8'));

const be32 = (dec) => { const h = BigInt(dec).toString(16); if (h.length > 64) throw new Error('field overflow'); return Buffer.from(h.padStart(64, '0'), 'hex'); };
const g1 = (p) => Buffer.concat([be32(p[0]), be32(p[1])]);
const g2 = (p) => Buffer.concat([be32(p[0][0]), be32(p[0][1]), be32(p[1][0]), be32(p[1][1])]);

const proofBytes = Buffer.concat([g1(proof.pi_a), g2(proof.pi_b), g1(proof.pi_c)]);
const pubBytes = Buffer.concat(publics.map(be32));
// Tamper the last public signal by +1 (still a valid field element) — must reject.
const tampered = publics.slice();
tampered[tampered.length - 1] = (BigInt(tampered[tampered.length - 1]) + 1n).toString();
const tamBytes = Buffer.concat(tampered.map(be32));

if (proofBytes.length !== 256) throw new Error(`proof ${proofBytes.length} != 256`);
if (pubBytes.length !== 123 * 32 || tamBytes.length !== 123 * 32) throw new Error('publics size');

const out = Buffer.concat([proofBytes, pubBytes, tamBytes]);
fs.writeFileSync('fixtures/swapbatch_ceremony_vector.bin', out);
console.log('wrote fixtures/swapbatch_ceremony_vector.bin — %d bytes (proof 256, publics 3936x2)', out.length);
