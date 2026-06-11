// BPP-2: crafted-body malformation tests the rest of the suite only hit
// incidentally (via random bit-flips). Here we DELIBERATELY construct a proof
// with (a) a canonical-but-zero scalar, (b) a scalar >= n, and (c) an off-curve
// / bad-prefix point in a NAMED field (A/A1/B/L), and assert bppRangeVerify
// rejects. Also: identity commitment slot, reorder, wrong count.
//
// The verifier has no EXPLICIT nonzero check on r1/s1 — these tests confirm the
// algebraic MSM identity is the backstop, and that it is (zero scalars reject).
//
// Run: node tests/bulletproofs-plus-malformed-body.test.mjs

import * as bpp from '../dapp/bulletproofs-plus.js';

const { SECP_N, ZERO, randomScalar } = bpp;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(t) { console.log(`\n${t}:`); }

function beOf(x) { const b = new Uint8Array(32); for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; }

// proof layout (m=1): A@0 A1@33 B@66 r1@99 s1@131 d1@163 L[0]@195
const R1 = 99, S1 = 131, D1 = 163, L0 = 195;

const base = bpp.bppRangeProve([424242n], [randomScalar()]);
group('baseline');
ok('honest m=1 verifies', bpp.bppRangeVerify(base.commitments, base.proof) === true);

group('zero scalars in r1/s1/d1 (no explicit check — MSM must reject)');
for (const [name, off] of [['r1', R1], ['s1', S1], ['d1', D1]]) {
  const t = new Uint8Array(base.proof); for (let i = 0; i < 32; i++) t[off + i] = 0;
  ok(`r1/s1/d1=0 → reject (${name})`, bpp.bppRangeVerify(base.commitments, t) === false);
}

group('non-canonical scalars (>= n) → reject at the canonical gate');
for (const [name, off, val] of [['r1', R1, SECP_N], ['s1', S1, SECP_N], ['d1', D1, SECP_N], ['r1', R1, (1n << 256n) - 1n]]) {
  const t = new Uint8Array(base.proof); t.set(beOf(val), off);
  ok(`${name} = ${val === SECP_N ? 'n' : '2^256-1'} → reject`, bpp.bppRangeVerify(base.commitments, t) === false);
}

group('off-curve / bad-prefix points in named fields → reject');
for (const [name, off] of [['A', 0], ['A1', 33], ['B', 66], ['L[0]', L0]]) {
  const t = new Uint8Array(base.proof); t[off] = 0x02; for (let i = 1; i < 33; i++) t[off + i] = 0xff; // x = 0xFF*32 (>= p / off-curve)
  ok(`off-curve in ${name} → reject`, bpp.bppRangeVerify(base.commitments, t) === false);
}
{
  const t = new Uint8Array(base.proof); for (let i = 0; i < 33; i++) t[i] = 0x00; // invalid prefix
  ok('0x00..00 (invalid prefix) in A → reject', bpp.bppRangeVerify(base.commitments, t) === false);
}

group('commitment-side malformations');
{
  const r = bpp.bppRangeProve([111n, 222n], [randomScalar(), randomScalar()]);
  ok('m=2 baseline verifies', bpp.bppRangeVerify(r.commitments, r.proof) === true);
  ok('reorder → reject', bpp.bppRangeVerify([r.commitments[1], r.commitments[0]], r.proof) === false);
  ok('wrong count (1 of 2) → reject', bpp.bppRangeVerify([r.commitments[0]], r.proof) === false);
  ok('identity commitment slot → reject', bpp.bppRangeVerify([ZERO, r.commitments[1]], r.proof) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
