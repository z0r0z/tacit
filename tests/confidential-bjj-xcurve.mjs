#!/usr/bin/env node
// BabyJubJub + cross-curve sigma — the swap_batch reflection mirror's BJJ dependency. The guest's
// babyjubjub.rs (unpack / verify_xcurve) mirrors dapp/amm-bjj.js + amm-sigma.js BYTE-FOR-BYTE (its own native
// harness validates that), so the reflection reuses the dapp JS directly rather than re-porting. This pins the
// two operations the swap_batch fold needs:
//   - unpackPoint — the 123 Groth16 public signals recover each C_in_BJJ / C_out_BJJ's (u,v) via it; it must
//     round-trip packPoint, stay on-curve + in the prime-order subgroup, and reject a non-canonical v.
//   - verifyXCurve — binds a receipt's C_out_secp ↔ C_out_BJJ to a shared hidden amount (so the onboarded
//     secp note carries the Groth16-cleared value); must accept a real proveXCurve sigma + reject tampering.
// Run: node tests/confidential-bjj-xcurve.mjs

import { pedersenBJJ, packPoint, unpackPoint, onCurve, inSubgroup, eq as bjjEq, P_FR } from '../dapp/amm-bjj.js';
import { verifyXCurve, proveXCurveDeterministic } from '../dapp/amm-sigma.js';
import { pedersenCommit, pointToBytes } from '../dapp/bulletproofs.js';

let failures = 0;
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

// ── unpackPoint round-trip (the swap_batch publics recover C_in_BJJ / C_out_BJJ via this) ──
for (const [v, r] of [[123n, 456n], [0n, 1n], [1000000n, 0xdeadbeefn]]) {
  const P = pedersenBJJ(v, r);
  ok(onCurve(P), `pedersenBJJ(${v},${r}) on curve`);
  ok(inSubgroup(P), `  in prime-order subgroup`);
  const back = unpackPoint(packPoint(P));
  ok(back && bjjEq(back, P), `  packPoint→unpackPoint round-trips`);
}
ok(P_FR > 0n, 'P_FR exported');
{
  const tooBig = new Uint8Array(32).fill(0xff); tooBig[31] &= 0x7f; // sign bit clear; v ≈ 2^255−1 > P_FR
  ok(unpackPoint(tooBig) === null, 'non-canonical v (≥ P_FR) → null');
}

// ── verifyXCurve: a real receipt sigma binds C_out_secp ↔ C_out_BJJ to a shared amount ──
{
  const a = 1000n, rSecp = 0x1111n, rBjj = 0x2222n;
  const Cs = pedersenCommit(a, rSecp), Cb = pedersenBJJ(a, rBjj);   // points (the prover serializes them)
  const seedKey = new Uint8Array(32).fill(7);
  const { proof, C_secp_bytes: CsB, C_BJJ_bytes: CbB } = proveXCurveDeterministic({ a, r_secp: rSecp, r_BJJ: rBjj, seedKey, C_secp: Cs, C_BJJ: Cb });
  ok(proof instanceof Uint8Array && proof.length === 169, 'sigma is 169 bytes');
  ok(verifyXCurve(proof, CsB, CbB) === true, 'valid sigma verifies (secp ↔ BJJ shared amount)');
  const bad = new Uint8Array(proof); bad[0] ^= 1;
  ok(verifyXCurve(bad, CsB, CbB) === false, 'tampered sigma rejected');
  ok(verifyXCurve(proof, pointToBytes(pedersenCommit(a + 1n, rSecp)), CbB) === false, 'sigma against a different C_secp rejected');
  ok(verifyXCurve(proof, CsB, packPoint(pedersenBJJ(a + 1n, rBjj))) === false, 'sigma against a different C_BJJ rejected');
}

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
