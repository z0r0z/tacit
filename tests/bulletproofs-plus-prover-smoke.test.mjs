// Smoke test: bppRangeProve runs end-to-end without throwing and produces
// the expected proof length at each aggregation level. Does NOT verify
// correctness — verifier is a follow-up. This catches type errors,
// off-by-one indexing, transcript-challenge-zero retry exhaustion,
// generator-derivation regressions, etc.

import * as bpp from '../dapp/bulletproofs-plus.js';
import { bytesToHex } from '@noble/hashes/utils';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

group('Generator derivation');
{
  const { Gvec, Hvec, H } = bpp.bppGens();
  ok('Gvec has BPP_MAX_NM=512 generators', Gvec.length === 512);
  ok('Hvec has BPP_MAX_NM=512 generators', Hvec.length === 512);
  ok('H is a non-zero point', !H.equals(bpp.ZERO));
  // Gvec[0] / Hvec[0] should match the pinned values in SPEC.md §3.1 since
  // the domain tags + derivation procedure are identical to standard BP.
  // SPEC.md §3.1 pins:
  //   G_vec[0] = 025cfa02a4913b0b122c4f275ae566e6ba52627d80036e25a43a3fd5d2062f28d4
  //   H_vec[0] = 02b78ed462f5c137b05d1e99daeb2619eb890ec4781acf098018628ca0ec0d20e2
  //   H        = 02bd7bf40fb5db2f7e0a1e8660ca13df55bb0d9f904e36e6297361f00376865e56
  const G0hex = bytesToHex(bpp.pointToBytes(Gvec[0]));
  const H0hex = bytesToHex(bpp.pointToBytes(Hvec[0]));
  const Hhex  = bytesToHex(bpp.pointToBytes(H));
  ok('Gvec[0] matches SPEC §3.1 pinned hex',
    G0hex === '025cfa02a4913b0b122c4f275ae566e6ba52627d80036e25a43a3fd5d2062f28d4',
    `got ${G0hex}`);
  ok('Hvec[0] matches SPEC §3.1 pinned hex',
    H0hex === '02b78ed462f5c137b05d1e99daeb2619eb890ec4781acf098018628ca0ec0d20e2',
    `got ${H0hex}`);
  ok('H matches SPEC §3.1 pinned hex',
    Hhex === '02bd7bf40fb5db2f7e0a1e8660ca13df55bb0d9f904e36e6297361f00376865e56',
    `got ${Hhex}`);
}

group('bppRangeProve at each m ∈ {1, 2, 4, 8}');
for (const m of [1, 2, 4, 8]) {
  const values = [];
  const blindings = [];
  for (let j = 0; j < m; j++) {
    values.push(BigInt(1000 + j * 100));  // arbitrary valid amounts
    blindings.push(bpp.randomScalar());
  }
  let result;
  try {
    result = bpp.bppRangeProve(values, blindings);
  } catch (e) {
    ok(`m=${m}: prover ran without throwing`, false, e?.message || String(e));
    continue;
  }
  ok(`m=${m}: prover ran without throwing`, true);
  ok(`m=${m}: returned proof bytes`,
    result?.proof instanceof Uint8Array && result.proof.length > 0);
  ok(`m=${m}: returned ${m} commitments`,
    Array.isArray(result?.commitments) && result.commitments.length === m);

  // Expected proof length = 99 + 96 + logMN*66
  const logMN = Math.log2(m) + 6;
  const expectedLen = 99 + 96 + logMN * 66;
  ok(`m=${m}: proof length matches BP+ spec (${expectedLen} B)`,
    result?.proof?.length === expectedLen,
    `expected ${expectedLen}, got ${result?.proof?.length}`);
}

group('Out-of-range value rejected by prover');
{
  let threw = false;
  try {
    const overflow = (1n << 64n) + 1n;
    bpp.bppRangeProve([overflow], [bpp.randomScalar()]);
  } catch { threw = true; }
  ok('value >= 2^64 throws', threw);
}

group('Invalid aggregation factor rejected');
{
  let threw = false;
  try {
    bpp.bppRangeProve([100n, 200n, 300n], [1n, 2n, 3n]);  // m=3 not allowed
  } catch { threw = true; }
  ok('m=3 throws', threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
