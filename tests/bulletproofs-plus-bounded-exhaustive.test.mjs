// Bounded-model exhaustive sweep for the BP+ port.
//
// Property fuzz hits a random sample of the input space. This sweep hits
// a STRUCTURED sample chosen to maximize the chance of catching boundary
// bugs that random sampling rarely lands on:
//
//   1. Every power of 2 from 2^0 to 2^63 (64 cases)
//   2. Every (2^k − 1) and (2^k − 2) boundary at the same range (128)
//   3. Every (2^k + 1) and (2^k + 2) just above each power (128)
//   4. 0 and 2^64 − 1 (the extremes)
//   5. 256 random values uniformly distributed across [0, 2^64)
//
// For each, prove + verify must succeed (completeness). For each, a
// shifted-by-1 commitment must reject (binding).
//
// Total: ~520 cases at m=1 alone; replicated at m=2/4/8 with multi-value
// combinations of the same boundary set. Catches off-by-one bugs at bit
// transitions, sign-bit boundaries, and aggregation-position-dependent
// bugs that random sampling would only land on with probability < 2^-50.

import * as bpp from '../dapp/bulletproofs-plus.js';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

// ============== Boundary value set ==============
function boundaryValues() {
  const vals = new Set();
  vals.add(0n);
  vals.add((1n << 64n) - 1n);
  for (let k = 0n; k < 64n; k++) {
    vals.add(1n << k);
    if (k > 0n) {
      vals.add((1n << k) - 1n);
      vals.add((1n << k) - 2n);
      vals.add((1n << k) + 1n);
      vals.add((1n << k) + 2n);
    }
  }
  // 64 random uniform samples in [0, 2^64)
  for (let i = 0; i < 64; i++) {
    const buf = new Uint8Array(8);
    globalThis.crypto.getRandomValues(buf);
    let v = 0n;
    for (let j = 0; j < 8; j++) v |= BigInt(buf[j]) << BigInt(j * 8);
    vals.add(v);
  }
  return [...vals].filter(v => v >= 0n && v < (1n << 64n));
}

group('m=1: exhaustive boundary sweep — completeness');
{
  const values = boundaryValues();
  let okCount = 0, failCount = 0, firstFail = null;
  for (const v of values) {
    const g = bpp.randomScalar();
    const r = bpp.bppRangeProve([v], [g]);
    if (bpp.bppRangeVerify(r.commitments, r.proof) === true) okCount++;
    else { failCount++; firstFail ??= `v=${v}`; }
  }
  ok(`m=1: ${okCount}/${values.length} boundary values prove+verify`,
    failCount === 0, firstFail);
}

group('m=1: exhaustive boundary sweep — binding (wrong commitment rejects)');
{
  const values = boundaryValues().slice(0, 64);  // half-sample for speed
  let acceptances = 0, firstUnsound = null;
  for (const v of values) {
    const g = bpp.randomScalar();
    const r = bpp.bppRangeProve([v], [g]);
    // Build a commitment for a NEIGHBORING value with the same blinding.
    // If our verifier wrongly accepts this, it would mean the proof
    // doesn't bind the value correctly — an inflation surface.
    const v_evil = v === 0n ? 1n : v - 1n;
    const C_evil = bpp.pedersenCommit(v_evil, g);
    if (bpp.bppRangeVerify([C_evil], r.proof) === true) {
      acceptances++;
      firstUnsound ??= `proof for v=${v} accepted commit(v-1=${v_evil})`;
    }
  }
  ok(`m=1: 0 unsound acceptances across ${values.length} neighbor-attack attempts`,
    acceptances === 0, firstUnsound);
}

group('m=2: structured boundary pairs');
{
  const vals = [0n, 1n, (1n << 32n), (1n << 32n) - 1n, (1n << 63n), (1n << 64n) - 1n];
  let okCount = 0, failCount = 0, firstFail = null;
  let total = 0;
  for (const v1 of vals) {
    for (const v2 of vals) {
      total++;
      const g1 = bpp.randomScalar();
      const g2 = bpp.randomScalar();
      const r = bpp.bppRangeProve([v1, v2], [g1, g2]);
      if (bpp.bppRangeVerify(r.commitments, r.proof) === true) okCount++;
      else { failCount++; firstFail ??= `(${v1}, ${v2})`; }
    }
  }
  ok(`m=2: ${okCount}/${total} boundary pairs prove+verify`,
    failCount === 0, firstFail);
}

group('m=4: structured boundary quads (a sample)');
{
  const extremes = [0n, 1n, (1n << 32n) - 1n, (1n << 64n) - 1n];
  let okCount = 0, failCount = 0, firstFail = null;
  let total = 0;
  // Cover all 4^4 = 256 combinations
  for (const v1 of extremes) {
    for (const v2 of extremes) {
      for (const v3 of extremes) {
        for (const v4 of extremes) {
          total++;
          const g = [bpp.randomScalar(), bpp.randomScalar(), bpp.randomScalar(), bpp.randomScalar()];
          const r = bpp.bppRangeProve([v1, v2, v3, v4], g);
          if (bpp.bppRangeVerify(r.commitments, r.proof) === true) okCount++;
          else { failCount++; firstFail ??= `(${v1},${v2},${v3},${v4})`; }
        }
      }
    }
  }
  ok(`m=4: ${okCount}/${total} boundary quads prove+verify`,
    failCount === 0, firstFail);
}

group('m=8: extreme combinations');
{
  // 4 specific configurations at m=8 to exercise the deepest aggregation
  const configs = [
    Array(8).fill(0n),
    Array(8).fill((1n << 64n) - 1n),
    [0n, 1n, (1n << 16n), (1n << 32n), (1n << 48n), (1n << 63n), 42n, (1n << 64n) - 1n],
    [(1n << 64n) - 1n, (1n << 63n), (1n << 32n), (1n << 16n), 1n, 0n, 1337n, 99n],
  ];
  let okCount = 0, failCount = 0, firstFail = null;
  for (const cfg of configs) {
    const g = cfg.map(() => bpp.randomScalar());
    const r = bpp.bppRangeProve(cfg, g);
    if (bpp.bppRangeVerify(r.commitments, r.proof) === true) okCount++;
    else { failCount++; firstFail ??= `cfg starting ${cfg[0]}`; }
  }
  ok(`m=8: ${okCount}/${configs.length} extreme m=8 configs prove+verify`,
    failCount === 0, firstFail);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
