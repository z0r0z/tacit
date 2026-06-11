// BPP-1: cross-check the windowed Pippenger msm() against a naive Σ s_i·P_i.
//
// msm() is used by BOTH the prover (A, L, R) and the verifier's terminal
// identity check, so a bucketing bug could pass the honest round-trip (same
// buggy msm on both sides) while corrupting the verification relation. The rest
// of the suite never checks the SUMMATION against an independent oracle — this
// test does, across every window-size regime and edge-scalar.
//
// Run: node tests/bulletproofs-plus-msm.test.mjs

import * as bpp from '../dapp/bulletproofs-plus.js';

const { G, ZERO, SECP_N, modN, safeMult, msm, randomScalar } = bpp;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(t) { console.log(`\n${t}:`); }

// Independent oracle: plain accumulate-and-add (handles 0 scalar and identity point).
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

// small deterministic PRNG so failures reproduce
let _s = 0xABCDEF1234567890n;
function rnd() { _s = (_s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return _s; }
function randScalar() { let r = 0n; for (let i = 0; i < 4; i++) r = (r << 64n) | rnd(); r = modN(r); return r === 0n ? 1n : r; }
function randPoint() { return G.multiply(randScalar()); }

group('msm() == naive Σ s_i·P_i across window-size regimes + edge scalars');
{
  // c=3 (<32), c=4 (<128), c=5 (<1024), plus the verifier's real sizes (146 @ m=1, 1057 @ m=8)
  const sizes = [1, 2, 4, 5, 8, 31, 32, 33, 64, 127, 128, 146, 200, 512, 1057];
  let allEqual = true, trials = 0;
  for (const n of sizes) {
    for (let t = 0; t < 6; t++) {
      const pts = [], scs = [];
      const repeat = randPoint();
      for (let i = 0; i < n; i++) {
        const pr = Number(rnd() % 10n);
        pts.push(pr === 0 ? ZERO : pr < 3 ? repeat : randPoint());  // identity / repeated / fresh
        const sr = Number(rnd() % 12n);
        scs.push(sr === 0 ? 0n : sr === 1 ? 1n : sr === 2 ? SECP_N - 1n : sr === 3 ? ((1n << 255n) | 1n) : randScalar());
      }
      if (!msm(scs, pts).equals(naiveMsm(scs, pts))) { allEqual = false; ok(`n=${n} t=${t}`, false, 'POINT MISMATCH'); }
      trials++;
    }
  }
  ok(`${trials} mixed trials (sizes ${sizes[0]}..${sizes[sizes.length - 1]}, edge scalars, repeated/identity points)`, allEqual);
}

group('degenerate inputs');
{
  ok('msm([],[]) == ZERO', msm([], []).equals(ZERO));
  const p = Array.from({ length: 6 }, () => randPoint());
  ok('all-zero scalars == ZERO', msm([0n, 0n, 0n, 0n, 0n, 0n], p).equals(ZERO));
  ok('ones == naive sum', msm(p.map(() => 1n), p).equals(naiveMsm(p.map(() => 1n), p)));
  const one = [randPoint()];
  ok('single term == s·P', msm([7n], one).equals(safeMult(one[0], 7n)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
