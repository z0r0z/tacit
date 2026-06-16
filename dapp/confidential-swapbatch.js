// T_SWAP_BATCH (0x2F) reflection fold — the BabyJubJub + Groth16 half. (The secp aggregate Pedersen identity
// lives in confidential-pool.js as swapBatchAggregateIdentity; the envelope parser in burn-deposit-bitcoin.js
// as parseSwapBatchEnvelope.) Mirrors cxfer-core swap_batch.rs. Kept OUT of confidential-pool.js so the other
// folds don't pull in the BabyJubJub / snarkjs deps; reuses the dapp's amm-bjj.js (BabyJubJub) — the guest's
// babyjubjub.rs mirrors it byte-for-byte — and (for the Groth16 step, wired next) snarkjs + the inline ceremony vk.

import { unpackPoint, P_FR, mod } from './amm-bjj.js';
import { sha256 } from './vendor/tacit-deps.min.js';

const N_MAX = 16;
const bytesToBig = (b) => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; };
const hb32 = (h) => { const s = String(h).replace(/^0x/, '').padStart(64, '0'); const o = new Uint8Array(32); for (let i = 0; i < 32; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; };

// Re-derive the swap_batch circuit's 123 public signals from the on-chain envelope + the pool's tracked
// reserves, in the EXACT order the circom `main` declares: 11 globals then seven N_MAX=16 arrays
// [direction, C_in_BJJ_u, C_in_BJJ_v, min_out, tip_amount, C_out_BJJ_u, C_out_BJJ_v]. Mirrors
// swap_batch_public_signals: a prover can't forge these — R_*_pre come from the registry, pool_id_fr =
// SHA256(pool_id) mod r, and each BJJ (u,v) is recovered by the validated unpackPoint (unused slots padded with
// the BJJ identity (0,1), like the circuit). Returns BigInt[123] field values (the guest's [u8;32] BE encode the
// same), or null on a bad point / out-of-range count. Feed to snarkjs.groth16.verify as decimal strings.
export function swapBatchPublicSignals(env, poolIdHex, reserveA, reserveB) {
  const ni = env.nIntents;
  if (ni < 1 || ni > N_MAX || env.intents.length !== ni || env.receipts.length !== ni) return null;
  const s = [
    mod(bytesToBig(sha256(hb32(poolIdHex))), P_FR), // pool_id_fr = SHA256(pool_id) mod r
    BigInt(reserveA), BigInt(reserveB),
    BigInt(env.deltaANetSign), BigInt(env.deltaANetMag),
    BigInt(env.deltaBNetSign), BigInt(env.deltaBNetMag),
    BigInt(env.tipAAmount), BigInt(env.tipBAmount),
    BigInt(env.feeBps), BigInt(ni),
  ];
  const direction = Array(N_MAX).fill(0n);
  const cInU = Array(N_MAX).fill(0n), cInV = Array(N_MAX).fill(1n);   // pad: BJJ identity (0,1)
  const minOut = Array(N_MAX).fill(0n), tip = Array(N_MAX).fill(0n);
  const cOutU = Array(N_MAX).fill(0n), cOutV = Array(N_MAX).fill(1n);
  for (let i = 0; i < ni; i++) {
    const it = env.intents[i];
    direction[i] = BigInt(it.direction);
    const cin = unpackPoint(hb32(it.cInBjj)); if (!cin) return null;
    cInU[i] = cin[0]; cInV[i] = cin[1];
    minOut[i] = BigInt(it.minOut); tip[i] = BigInt(it.tipAmount);
    const cout = unpackPoint(hb32(env.receipts[i].cOutBjj)); if (!cout) return null;
    cOutU[i] = cout[0]; cOutV[i] = cout[1];
  }
  for (const arr of [direction, cInU, cInV, minOut, tip, cOutU, cOutV]) for (const x of arr) s.push(x);
  return s.length === 123 ? s : null;
}

// Parse a 256-byte Groth16 proof (the guest's G16Proof layout: A(G1 64) ‖ B(G2 128: x_c0 x_c1 y_c0 y_c1) ‖
// C(G1 64), big-endian field bytes) → a snarkjs proof object. Byte-identical to the dapp's _parseGroth16Proof
// (and parse_g16_proof in the guest); pi_b limbs in snarkjs [c0, c1] order. Accepts a Uint8Array or 0x-hex.
const be32dec = (b, o) => { let v = 0n; for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(b[o + i]); return v.toString(); };
export function parseGroth16Proof256(proofBytes) {
  const b = proofBytes instanceof Uint8Array ? proofBytes : hb32Var(proofBytes);
  if (!(b instanceof Uint8Array) || b.length !== 256) return null;
  return {
    pi_a: [be32dec(b, 0), be32dec(b, 32), '1'],
    pi_b: [[be32dec(b, 64), be32dec(b, 96)], [be32dec(b, 128), be32dec(b, 160)], ['1', '0']],
    pi_c: [be32dec(b, 192), be32dec(b, 224), '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };
}
const hb32Var = (h) => { const s = String(h).replace(/^0x/, ''); const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; };

// Verify the swap_batch BN254 Groth16 (per-receipt clearing split) against the CID-verified ceremony vk
// (_CANONICAL_AMM_VK_INLINE.swap_batch in the dapp = batch_vk.bin in the guest), supplied by the caller so this
// module stays vk-agnostic (no drift). `publicsBigInt` = swapBatchPublicSignals(...) (123 field values). The
// proof is the envelope's 256 bytes. Returns a Promise<bool>; fail-closed on a malformed proof.
export async function swapBatchGroth16Verify(vk, publicsBigInt, proofBytes) {
  const proof = parseGroth16Proof256(proofBytes);
  if (!proof || !Array.isArray(publicsBigInt)) return false;
  const publics = publicsBigInt.map((x) => BigInt(x).toString());
  const sjs = await import('snarkjs');
  const groth16 = sjs.groth16 || (sjs.default && sjs.default.groth16);
  if (!groth16 || typeof groth16.verify !== 'function') throw new Error('snarkjs.groth16.verify unavailable');
  return groth16.verify(vk, publics, proof);
}
