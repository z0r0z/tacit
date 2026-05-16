// Sanity check for the price-chart's monotone cubic interpolation
// (dapp/tacit.js `_smoothPath` inside renderMarketPriceChartSVG).
//
// The earlier Catmull-Rom implementation (tension=0.5) overshoots: on
// any local maximum/minimum sequence the cubic Bézier control points
// push the curve above the highest (or below the lowest) actual trade.
// A price chart that displays a price never traded is genuinely
// misleading — a trader reading the visual peak sees a value that
// nobody bid or asked at.
//
// Fritsch-Carlson monotone cubic is the standard fix. This test pins
// the key property: every interpolated y value on the curve lies
// within [min(y_i, y_{i+1}), max(y_i, y_{i+1})] for that segment.
//
// Re-implements the same algorithm the dapp uses (not importing because
// dapp/tacit.js requires jsdom + heavy module-init we don't need here).
// Drift between this re-implementation and the dapp's would be caught
// by a visual regression in production, but the property itself —
// no overshoot — is what we're pinning. The point of the test is to
// make sure the property HOLDS under adversarial input, not to assert
// byte-identical paths.
//
// Run: `node tests/dapp-chart-monotone.test.mjs`

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(ok => {
      if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
      else { console.log(`  FAIL  ${label}${ok ? ` (${JSON.stringify(ok)})` : ''}`); fail++; }
    })
    .catch(e => { console.log(`  FAIL  ${label}: ${e?.message || e}`); fail++; });
}

// Fritsch-Carlson tangent computation — mirrors the dapp implementation.
function monotoneTangents(xs, ys) {
  const n = xs.length;
  if (n < 2) return new Array(n).fill(0);
  const dx = new Array(n - 1), dy = new Array(n - 1), m = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = xs[i + 1] - xs[i];
    dy[i] = ys[i + 1] - ys[i];
    m[i] = dx[i] !== 0 ? dy[i] / dx[i] : 0;
  }
  const t = new Array(n);
  t[0]     = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      t[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      t[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const h = a * a + b * b;
    if (h > 9) {
      const r = 3 / Math.sqrt(h);
      t[i]     = r * a * m[i];
      t[i + 1] = r * b * m[i];
    }
  }
  return t;
}

// Evaluate the Hermite cubic on segment [i, i+1] at parameter s ∈ [0, 1].
// Standard Hermite basis: h00 = 2s³ − 3s² + 1, h10 = s³ − 2s² + s,
//                          h01 = −2s³ + 3s²,    h11 = s³ − s².
function hermiteEval(y0, y1, t0, t1, dx, s) {
  const h00 = 2 * s ** 3 - 3 * s ** 2 + 1;
  const h10 = s ** 3 - 2 * s ** 2 + s;
  const h01 = -2 * s ** 3 + 3 * s ** 2;
  const h11 = s ** 3 - s ** 2;
  return h00 * y0 + h10 * dx * t0 + h01 * y1 + h11 * dx * t1;
}

// Sample many points along each segment and assert every sample lies
// within the segment's [min(y_i, y_{i+1}), max(y_i, y_{i+1})] envelope.
// This is the "no overshoot" property — the entire point of switching
// from Catmull-Rom to monotone cubic.
function maxOvershoot(xs, ys) {
  const t = monotoneTangents(xs, ys);
  const SAMPLES_PER_SEGMENT = 64;
  let worst = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const dx = xs[i + 1] - xs[i];
    const yLo = Math.min(ys[i], ys[i + 1]);
    const yHi = Math.max(ys[i], ys[i + 1]);
    for (let k = 0; k <= SAMPLES_PER_SEGMENT; k++) {
      const s = k / SAMPLES_PER_SEGMENT;
      const y = hermiteEval(ys[i], ys[i + 1], t[i], t[i + 1], dx, s);
      const over = Math.max(0, y - yHi, yLo - y);
      if (over > worst) worst = over;
    }
  }
  return worst;
}

// ============================================================================
// Adversarial sequences that Catmull-Rom (tension 0.5) overshoots
// ============================================================================
console.log('\n§ No-overshoot property under adversarial inputs:');

await test('Catmull-Rom comparison sanity: dapp\'s pre-fix CR formula DOES overshoot', () => {
  // Sanity baseline: verify the test harness can DETECT overshoot — without
  // this, the "monotone passes" assertions below could be vacuously passing.
  // We re-implement the EXACT Catmull-Rom-to-Bézier formula the dapp used
  // before the monotone-cubic switch (c1 = p1 + (p2 - p0)/6 · tension, etc.,
  // tension = 0.5) and run it on a sequence known to push the actual curve
  // outside the segment envelope: y = [0, 100, 100, 200]. The middle
  // segment [1,2] is a plateau (both endpoints y=100) but the centered
  // tangent at i=1 is +100, and at i=2 is +100 — so the curve dips ~2.4
  // BELOW 100 mid-segment then arcs back. With the old chart, that means
  // a flat-price interval visually shows a dip the data didn't contain.
  function catmullDappBezier(xs, ys, tension = 0.5) {
    const n = xs.length;
    let maxOver = 0;
    for (let i = 0; i < n - 1; i++) {
      const p0i = i - 1 < 0 ? 0 : i - 1;
      const p3i = i + 2 > n - 1 ? n - 1 : i + 2;
      const p0x = xs[p0i], p0y = ys[p0i];
      const p1x = xs[i], p1y = ys[i];
      const p2x = xs[i + 1], p2y = ys[i + 1];
      const p3x = xs[p3i], p3y = ys[p3i];
      const c1x = p1x + (p2x - p0x) / 6 * tension;
      const c1y = p1y + (p2y - p0y) / 6 * tension;
      const c2x = p2x - (p3x - p1x) / 6 * tension;
      const c2y = p2y - (p3y - p1y) / 6 * tension;
      const yLo = Math.min(p1y, p2y);
      const yHi = Math.max(p1y, p2y);
      for (let k = 0; k <= 64; k++) {
        const s = k / 64;
        const omS = 1 - s;
        const y = omS ** 3 * p1y + 3 * omS ** 2 * s * c1y + 3 * omS * s ** 2 * c2y + s ** 3 * p2y;
        const over = Math.max(0, y - yHi, yLo - y);
        if (over > maxOver) maxOver = over;
      }
    }
    return maxOver;
  }
  const over = catmullDappBezier([0, 1, 2, 3], [0, 100, 100, 200]);
  // Curve overshoots ~2.4 above 100 and ~2.4 below — well clear of any
  // floating-point noise. Monotone cubic on the same input must be < 1e-9.
  return over > 2;
});

await test('monotone DOESN\'T overshoot the same input that breaks CR', () => {
  return maxOvershoot([0, 1, 2, 3], [0, 100, 100, 200]) < 1e-9;
});

await test('monotone never overshoots a single spike (Catmull-Rom would)', () => {
  // Same spike as above; monotone cubic must keep the curve ≤ 100.
  return maxOvershoot([0, 1, 2, 3], [10, 10, 100, 10]) < 1e-9;
});

await test('monotone never overshoots a zigzag sequence', () => {
  // Classic zigzag — each interior point is an extremum, so every
  // interior tangent should be zeroed by the sign-flip rule and the
  // curve should bow but not cross either neighbor's y.
  return maxOvershoot([0, 1, 2, 3, 4, 5, 6], [50, 100, 50, 100, 50, 100, 50]) < 1e-9;
});

await test('monotone never overshoots a flat-then-jump sequence', () => {
  // Flat segment then a step up; standard Catmull-Rom would dip below
  // the floor before the step. Monotone cubic must stay ≥ 100 on the
  // flat side and ≤ 200 on the rising side.
  return maxOvershoot([0, 1, 2, 3, 4, 5], [100, 100, 100, 100, 200, 200]) < 1e-9;
});

await test('monotone never overshoots a dust-print outlier', () => {
  // Realistic tacit pattern: in-band trades around 200 sats/whole,
  // a single dust print at 5 sats. The chart still plots the outlier
  // (clamped), but the LINE between in-band neighbors must not dip
  // toward the outlier — and the outlier's own neighbors mustn't
  // overshoot above it back to in-band.
  return maxOvershoot([0, 1, 2, 3, 4, 5], [200, 210, 5, 215, 220, 218]) < 1e-9;
});

await test('monotone never overshoots a strictly monotonic ramp', () => {
  // Monotone input should produce a monotone curve (no S-shape that
  // dips below the prior point). Spot-check: every sample must be
  // between the bracketing endpoint y values.
  return maxOvershoot([0, 1, 2, 3, 4, 5, 6, 7], [10, 20, 35, 60, 90, 120, 160, 200]) < 1e-9;
});

await test('monotone never overshoots irregular timestamps (sparse + dense)', () => {
  // Trades clustered in a burst then quiet: x deltas vary 100×.
  // Catmull-Rom on uneven X produces bulges; monotone cubic keeps
  // the envelope tight regardless of x spacing.
  return maxOvershoot([0, 1, 2, 3, 200, 400, 600], [50, 80, 60, 90, 75, 85, 70]) < 1e-9;
});

await test('monotone never overshoots a real-shape sequence (50 random walk steps)', () => {
  // Deterministic pseudo-random walk: same seed every run. Verify
  // the no-overshoot property holds across a longer realistic ring.
  const xs = []; const ys = [];
  let y = 100;
  let seed = 0xC0FFEE;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 50; i++) {
    xs.push(i);
    y += (rng() - 0.5) * 30;
    ys.push(Math.max(1, y));
  }
  return maxOvershoot(xs, ys) < 1e-9;
});

await test('two-point line: trivially no overshoot', () => {
  return maxOvershoot([0, 1], [10, 20]) < 1e-9;
});

await test('three points with one repeated value', () => {
  // Edge case: m[i] == 0 on one side. The dapp's pre-loop pass already
  // sets t to 0 in this case; the final overshoot pass leaves them.
  return maxOvershoot([0, 1, 2], [50, 100, 100]) < 1e-9;
});

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
