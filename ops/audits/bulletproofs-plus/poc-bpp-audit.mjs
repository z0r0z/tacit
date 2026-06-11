// Standalone PoC harness for the Bulletproofs+ audit (read-only; not a prod file).
// Run: node ops/audits/bulletproofs-plus/poc-bpp-audit.mjs
//
// Covers the gaps the existing suite does not:
//   (G) Pippenger msm() cross-checked against naive Σ s_i·P_i  — the "wrong MSM
//       that passes honest roundtrip" nightmare case.
//   (1) out-of-range soundness at the TRUE boundary (2^64, 2^64+1) and for
//       negative values (n-1, n-2^63) in single + aggregated proofs.
//   (i/j) crafted-body malformations: zero / >=n scalars in r1,s1,d1; off-curve
//       and bad-prefix points injected into A/A1/B/L/R fields.
//   (binding) commitment reorder / wrong-count rejection in the verifier.

import * as bpp from '../../../dapp/bulletproofs-plus.js';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; fails.push(`${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n## ${t}`); }

const { G, ZERO, SECP_N, modN, safeMult, msm, randomScalar } = bpp;

// ---- deterministic-ish PRNG for reproducibility of point/scalar selection ----
let _s = 0x12345678n;
function rnd() { _s = (_s * 6364136223846793005n + 1442695040888963407n) & ((1n<<64n)-1n); return _s; }
function randScalarInRange() { // [1, n)
  let r = 0n; for (let i=0;i<4;i++) r = (r<<64n) | rnd();
  r = modN(r); return r === 0n ? 1n : r;
}
function randPoint() { return G.multiply(randScalarInRange()); }

function naiveMsm(scalars, points) {
  let acc = ZERO;
  for (let i = 0; i < scalars.length; i++) {
    const s = modN(scalars[i]);
    if (s === 0n) continue;
    if (points[i].equals(ZERO)) continue;
    acc = acc.add(points[i].multiply(s));
  }
  return acc;
}

// ============================================================================
section('(G) Pippenger msm() vs naive Σ s_i·P_i');
// ============================================================================
{
  // Cover every window-size regime: <32 (c=3), <128 (c=4), <1024 (c=5), and the
  // verifier's real sizes (146 for m=1, 1057 for m=8). Include scalar 0/1/n-1,
  // high-bit-set scalars, repeated points, identity points.
  const sizes = [1, 2, 4, 5, 8, 31, 32, 33, 64, 127, 128, 146, 200, 512, 1057];
  let allEqual = true, checked = 0;
  for (const n of sizes) {
    for (let trial = 0; trial < 6; trial++) {
      const pts = [], scs = [];
      const base = randPoint();
      for (let i = 0; i < n; i++) {
        // mix: fresh random points, some repeated, occasional identity
        let P;
        const roll = Number(rnd() % 10n);
        if (roll === 0) P = ZERO;            // identity point
        else if (roll < 3) P = base;          // repeated point (bucket stress)
        else P = randPoint();
        pts.push(P);
        // mix scalars: 0, 1, n-1, high-bit, random
        const sroll = Number(rnd() % 12n);
        let s;
        if (sroll === 0) s = 0n;
        else if (sroll === 1) s = 1n;
        else if (sroll === 2) s = SECP_N - 1n;       // largest reduced scalar (bit255 set)
        else if (sroll === 3) s = (1n << 255n) | 1n; // explicit high bit
        else s = randScalarInRange();
        scs.push(s);
      }
      const a = msm(scs, pts);
      const b = naiveMsm(scs, pts);
      const eq = a.equals(b);
      if (!eq) { allEqual = false; ok(`msm==naive n=${n} trial=${trial}`, false, 'POINT MISMATCH'); }
      checked++;
    }
  }
  ok(`msm == naive across ${checked} mixed trials (all sizes/edge scalars)`, allEqual);
  // explicit degenerate inputs
  ok('msm([],[]) == ZERO', msm([], []).equals(ZERO));
  ok('msm(all-zero scalars) == ZERO', msm([0n,0n,0n,0n,0n,0n], [randPoint(),randPoint(),randPoint(),randPoint(),randPoint(),randPoint()]).equals(ZERO));
  {
    const pts=[randPoint(),randPoint(),randPoint(),randPoint(),randPoint(),randPoint(),randPoint()];
    const scs=[1n,1n,1n,1n,1n,1n,1n];
    ok('msm(ones) == naive sum of points', msm(scs,pts).equals(naiveMsm(scs,pts)));
  }
}

// ============================================================================
section('(1) Out-of-range soundness — verifier MUST reject');
// ============================================================================
function proveAllowOOR(values, blindings) {
  return bpp.bppRangeProve(values, blindings, /*_allowOutOfRangeForTest=*/true);
}
{
  const TWO64 = 1n << 64n;
  const cases = [
    ['v = 2^64',        TWO64],
    ['v = 2^64 + 1',    TWO64 + 1n],
    ['v = 2^64 + 7',    TWO64 + 7n],
    ['v = n-1 (= -1)',  SECP_N - 1n],
    ['v = n-2^63 (neg)',SECP_N - (1n<<63n)],
    ['v = 2^65',        1n << 65n],
    ['v = 2^200',       1n << 200n],
  ];
  for (const [label, v] of cases) {
    let rejected = false;
    try {
      const r = proveAllowOOR([v], [randomScalar()]);
      rejected = bpp.bppRangeVerify(r.commitments, r.proof) === false;
    } catch (e) { rejected = true; } // a throw is also a rejection
    ok(`reject ${label}`, rejected);
  }
  // aggregated: one in-range, one out-of-range slot must reject the whole proof
  {
    let rejected = false;
    try {
      const r = proveAllowOOR([5n, TWO64], [randomScalar(), randomScalar()]);
      rejected = bpp.bppRangeVerify(r.commitments, r.proof) === false;
    } catch (e) { rejected = true; }
    ok('reject m=2 aggregate with one OOR slot', rejected);
  }
  // sanity: the honest max value (2^64-1) MUST verify (no false-reject)
  {
    const r = bpp.bppRangeProve([(1n<<64n)-1n], [randomScalar()]);
    ok('accept honest 2^64-1 (no false reject)', bpp.bppRangeVerify(r.commitments, r.proof) === true);
  }
}

// ============================================================================
section('(2) Boundary completeness');
// ============================================================================
for (const v of [0n, 1n, (1n<<63n), (1n<<64n)-1n]) {
  const r = bpp.bppRangeProve([v], [randomScalar()]);
  ok(`accept v=${v}`, bpp.bppRangeVerify(r.commitments, r.proof) === true);
}

// ============================================================================
section('(i/j) Crafted-body malformations — verifier MUST reject');
// ============================================================================
{
  const r = bpp.bppRangeProve([424242n], [randomScalar()]);
  ok('baseline verifies', bpp.bppRangeVerify(r.commitments, r.proof) === true);

  const R1=99, S1=131, D1=163; // scalar offsets (after A,A1,B = 33*3)
  // zero scalars
  for (const [name, off] of [['r1',R1],['s1',S1],['d1',D1]]) {
    const t = new Uint8Array(r.proof);
    for (let i=0;i<32;i++) t[off+i]=0;
    ok(`reject ${name}=0`, bpp.bppRangeVerify(r.commitments, t) === false);
  }
  // non-canonical (>= n): write SECP_N big-endian (which is == n, not < n)
  const nBE = bpp.bigintToBytes32 ? null : null;
  function beOf(x){ const b=new Uint8Array(32); for(let i=31;i>=0;i--){ b[i]=Number(x & 0xffn); x>>=8n;} return b; }
  for (const [name, off, val] of [['r1',R1,SECP_N],['s1',S1,SECP_N],['d1',D1,SECP_N],['r1',R1,(1n<<256n)-1n]]) {
    const t = new Uint8Array(r.proof);
    t.set(beOf(val), off);
    ok(`reject ${name} >= n (val 2^...) canonical check`, bpp.bppRangeVerify(r.commitments, t) === false);
  }
  // bad points injected into named fields: prefix 0x02 + x=0xFF*32 (off-curve / >=p)
  for (const [name, off] of [['A',0],['A1',33],['B',66]]) {
    const t = new Uint8Array(r.proof);
    t[off]=0x02; for (let i=1;i<33;i++) t[off+i]=0xff;
    ok(`reject off-curve point in ${name}`, bpp.bppRangeVerify(r.commitments, t) === false);
  }
  // bad prefix (0x00) => not a valid compressed point => parse fails => reject
  {
    const t = new Uint8Array(r.proof);
    for (let i=0;i<33;i++) t[i]=0x00;
    ok('reject 0x00..00 (invalid prefix) in A', bpp.bppRangeVerify(r.commitments, t) === false);
  }
  // first L field off-curve (m=1 => L starts at 195)
  {
    const Loff = 99+96; // 195
    const t = new Uint8Array(r.proof);
    t[Loff]=0x02; for (let i=1;i<33;i++) t[Loff+i]=0xff;
    ok('reject off-curve point in L[0]', bpp.bppRangeVerify(r.commitments, t) === false);
  }
}

// ============================================================================
section('(binding) commitment reorder / wrong-count / swap');
// ============================================================================
{
  const r = bpp.bppRangeProve([111n, 222n], [randomScalar(), randomScalar()]);
  ok('m=2 baseline verifies', bpp.bppRangeVerify(r.commitments, r.proof) === true);
  ok('reject reordered commitments', bpp.bppRangeVerify([r.commitments[1], r.commitments[0]], r.proof) === false);
  ok('reject wrong count (1 of 2)', bpp.bppRangeVerify([r.commitments[0]], r.proof) === false);
  ok('reject wrong count (3 padded)', bpp.bppRangeVerify([...r.commitments, bpp.pedersenCommit(1n, randomScalar())], r.proof) === false);
  // identity commitment as a slot
  ok('reject identity commitment slot', bpp.bppRangeVerify([ZERO, r.commitments[1]], r.proof) === false);
}

// ============================================================================
section('(malleability probe) different proof, same commitment');
// ============================================================================
{
  // Two honest proofs of the SAME value+blinding (so SAME commitment) differ in
  // bytes (fresh alpha/dL/dR randomness) but BOTH verify against that commitment.
  // This is expected (proofs are randomized, not unique) — documents that proof
  // bytes are NOT a unique handle; binding/anti-replay must live in the
  // commitment/nullifier, not the proof. Informational, not a failure.
  const g = randomScalar();
  const a = bpp.bppRangeProve([900n], [g]);
  const b = bpp.bppRangeProve([900n], [g]);
  const sameCommit = a.commitments[0].equals(b.commitments[0]);
  const bothVerify = bpp.bppRangeVerify(a.commitments, a.proof) && bpp.bppRangeVerify(a.commitments, b.proof);
  const diffBytes = bpp.bytesToHex ? false : (Buffer.from(a.proof).toString('hex') !== Buffer.from(b.proof).toString('hex'));
  console.log(`   info: same commitment=${sameCommit}, both proofs verify vs that commitment=${bothVerify}, proof bytes differ=${diffBytes}`);
}

console.log(`\n=================== ${pass} passed, ${fail} failed ===================`);
if (fail) { console.log('FAILURES:'); for (const f of fails) console.log('  - ' + f); process.exit(1); }
