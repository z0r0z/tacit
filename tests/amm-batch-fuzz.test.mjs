// N=16 mixed-direction batch fuzz.
//
// Two-layer test:
//   Layer 1 (fast): 200 seeds of pure-math invariants on solveClearing +
//                   per-trader amount_out distribution.
//   Layer 2 (slow): 10 seeds run through the amm_swap_batch wasm witness
//                   calculator — verifies the circuit accepts the same math
//                   the reference impl produces.
//
// Layer 2 is the real cross-check: it confirms reference impl and circuit
// agree on N=16 mixed-direction inputs. If solveClearing produces values the
// circuit rejects (or vice versa), this test catches it before chain.
//
// Skip Layer 2 if the wasm calculator isn't built (build/amm_swap_batch_js/).

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { solveClearing, amountOutForTrader, applyBatch } from './amm-clearing.mjs';
import { N_BJJ, pedersenBJJ } from './amm-bjj.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const N_MAX = 16;
const WASM_PATH = resolve(__dirname, '../dapp/circuits/amm/build/amm_swap_batch_js/amm_swap_batch.wasm');
const WC_PATH   = resolve(__dirname, '../dapp/circuits/amm/build/amm_swap_batch_js/witness_calculator.cjs');
const WASM_AVAILABLE = existsSync(WASM_PATH) && existsSync(WC_PATH);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randBig(rng, max) {
  return BigInt(Math.floor(rng() * Number(max)));
}
function randomBJJBlinding(rng) {
  while (true) {
    const buf = new Uint8Array(32);
    for (let i = 0; i < 32; i++) buf[i] = Math.floor(rng() * 256);
    let n = 0n;
    for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(buf[i]);
    if (n > 0n && n < N_BJJ) return n;
  }
}

// Build a single fuzz scenario: N=16 random traders, mixed direction.
function buildScenario(seed) {
  const rng = mulberry32(seed);
  const R_A = 1_000_000n + randBig(rng, 1n << 36n);
  const R_B = 1_000_000n + randBig(rng, 1n << 36n);
  const fee_bps = Math.floor(rng() * 1001);

  const traders = [];
  for (let i = 0; i < N_MAX; i++) {
    const direction = rng() < 0.5 ? 0 : 1;   // 0 = A→B, 1 = B→A
    const amount    = 1n + randBig(rng, 1n << 24n);
    const tip       = randBig(rng, 100n);
    traders.push({ direction, amount_in_swap: amount, tip_amount: tip, min_out: 0n });
  }
  return { rng, R_A, R_B, fee_bps, traders };
}

// Math-level invariants on a solved scenario.
function checkInvariants({ R_A, R_B, fee_bps, traders }) {
  const X = traders.filter(t => t.direction === 0).reduce((s, t) => s + t.amount_in_swap, 0n);
  const Y = traders.filter(t => t.direction === 1).reduce((s, t) => s + t.amount_in_swap, 0n);
  const r = solveClearing(X, Y, R_A, R_B, fee_bps);

  // I1: direction soundness
  const lhs = X * R_B, rhs = Y * R_A;
  if (X === 0n && Y === 0n) {
    assert.strictEqual(r.direction, 'empty');
    return r;
  }
  if (lhs === rhs) {
    assert.strictEqual(r.direction, 'spot');
    return r;
  }
  assert.strictEqual(r.direction, lhs > rhs ? 'A→B' : 'B→A');

  // I2: post-reserves non-negative
  const post = applyBatch(R_A, R_B, r);
  assert.ok(post.R_A >= 0n);
  assert.ok(post.R_B >= 0n);

  // I3: k-invariant
  assert.ok(post.R_A * post.R_B >= R_A * R_B);

  // I4: per-trader amount_outs are non-negative and within bounds
  let aggOutA = 0n, aggOutB = 0n;
  for (const t of traders) {
    const dir = t.direction === 0 ? 'A→B' : 'B→A';
    const out = amountOutForTrader(t.amount_in_swap, dir, r.P_clear_num, r.P_clear_den);
    assert.ok(out >= 0n);
    if (t.direction === 0) aggOutB += out;
    else                   aggOutA += out;
  }
  // I5: aggregate output bound  aggOutA + delta_a_net ≤ X (for A→B direction)
  // I.e., what B→A traders take in A, plus what pool keeps, ≤ what A→B traders contributed
  if (r.direction === 'A→B') {
    assert.ok(aggOutA <= X, `aggOutA ${aggOutA} > X ${X}`);
    assert.ok(aggOutB <= Y + r.delta_b_net, `aggOutB ${aggOutB} > Y+δb ${Y + r.delta_b_net}`);
  } else if (r.direction === 'B→A') {
    assert.ok(aggOutB <= Y, `aggOutB ${aggOutB} > Y ${Y}`);
    assert.ok(aggOutA <= X + r.delta_a_net, `aggOutA ${aggOutA} > X+δa ${X + r.delta_a_net}`);
  }

  return r;
}

describe('amm_swap_batch N=16 mixed-direction fuzz (math layer)', () => {

  test('200 seeds: all math invariants hold for N=16 random batches', () => {
    let aHits = 0, bHits = 0, spotHits = 0;
    for (let seed = 0; seed < 200; seed++) {
      const scenario = buildScenario(seed * 9007 + 17);
      const r = checkInvariants(scenario);
      if (r.direction === 'A→B') aHits++;
      else if (r.direction === 'B→A') bHits++;
      else spotHits++;
    }
    // Sanity: should see both directions and not 100% spot.
    assert.ok(aHits > 50, `too few A→B batches: ${aHits}/200`);
    assert.ok(bHits > 50, `too few B→A batches: ${bHits}/200`);
  });

  test('boundary: all-A→B (Y=0) and all-B→A (X=0) batches solve cleanly', () => {
    for (let seed = 0; seed < 10; seed++) {
      const rng = mulberry32(seed * 211);
      const R_A = 1_000_000n + randBig(rng, 1n << 30n);
      const R_B = 1_000_000n + randBig(rng, 1n << 30n);

      // All N=16 traders in direction A→B
      const aTraders = Array.from({ length: 16 }, () => ({
        direction: 0, amount_in_swap: 1n + randBig(rng, 1n << 20n), tip_amount: 0n, min_out: 0n,
      }));
      const aR = checkInvariants({ R_A, R_B, fee_bps: 30, traders: aTraders });
      assert.strictEqual(aR.direction, 'A→B');

      // All N=16 traders in direction B→A
      const bTraders = Array.from({ length: 16 }, () => ({
        direction: 1, amount_in_swap: 1n + randBig(rng, 1n << 20n), tip_amount: 0n, min_out: 0n,
      }));
      const bR = checkInvariants({ R_A, R_B, fee_bps: 30, traders: bTraders });
      assert.strictEqual(bR.direction, 'B→A');
    }
  });

  test('boundary: extreme R_A:R_B ratio (1M:1) still resolves directions correctly', () => {
    const R_A = 1_000_000_000n;
    const R_B = 1_000n;
    // X small, Y large → likely B→A; but X·R_B might equal Y·R_A → spot.
    const traders = [
      { direction: 0, amount_in_swap: 100n, tip_amount: 0n, min_out: 0n },
      { direction: 1, amount_in_swap: 100n, tip_amount: 0n, min_out: 0n },
    ];
    const r = checkInvariants({ R_A, R_B, fee_bps: 30, traders });
    // X·R_B = 100·1000 = 100K; Y·R_A = 100·1B = 100B; lhs<rhs → B→A.
    assert.strictEqual(r.direction, 'B→A');
  });

});

// ---------------------------------------------------------------------------
// Layer 2: circuit-witness cross-check (slow)
// ---------------------------------------------------------------------------

// Build the full circuit input from a scenario (mirrors witness-test.mjs).
function buildCircuitInput(seed, scenario) {
  const rng = scenario.rng;
  const X = scenario.traders.filter(t => t.direction === 0).reduce((s, t) => s + t.amount_in_swap, 0n);
  const Y = scenario.traders.filter(t => t.direction === 1).reduce((s, t) => s + t.amount_in_swap, 0n);
  const solve = solveClearing(X, Y, scenario.R_A, scenario.R_B, BigInt(scenario.fee_bps));

  // Skip spot/empty — circuit witness gen for these has tight constraints
  // that aren't part of this fuzz's scope.
  if (solve.direction === 'spot' || solve.direction === 'empty') return null;

  const filled = scenario.traders.map(t => {
    const dir = t.direction === 0 ? 'A→B' : 'B→A';
    const aOut = amountOutForTrader(t.amount_in_swap, dir, solve.P_clear_num, solve.P_clear_den);
    let mult, div;
    if (t.direction === 0) { mult = solve.P_clear_den; div = solve.P_clear_num; }
    else                   { mult = solve.P_clear_num; div = solve.P_clear_den; }
    const num = t.amount_in_swap * mult;
    const rem = num - aOut * div;
    return { ...t, amount_out: aOut, rem };
  });

  const tipA = filled.filter(t => t.direction === 0).reduce((s, t) => s + t.tip_amount, 0n);
  const tipB = filled.filter(t => t.direction === 1).reduce((s, t) => s + t.tip_amount, 0n);

  const direction = new Array(N_MAX).fill('0');
  const min_out = new Array(N_MAX).fill('0');
  const tip_amount = new Array(N_MAX).fill('0');
  const amount_in_swap = new Array(N_MAX).fill('0');
  const tip_amount_witness = new Array(N_MAX).fill('0');
  const r_in_BJJ = new Array(N_MAX).fill('0');
  const amount_out = new Array(N_MAX).fill('0');
  const rem = new Array(N_MAX).fill('0');
  const r_out_BJJ = new Array(N_MAX).fill('0');
  const C_in_BJJ_u = new Array(N_MAX).fill('0');
  const C_in_BJJ_v = new Array(N_MAX).fill('1');
  const C_out_BJJ_u = new Array(N_MAX).fill('0');
  const C_out_BJJ_v = new Array(N_MAX).fill('1');

  for (let i = 0; i < filled.length; i++) {
    const t = filled[i];
    const inTotal = t.amount_in_swap + t.tip_amount;
    const r_in = randomBJJBlinding(rng);
    const r_out = randomBJJBlinding(rng);
    const C_in = pedersenBJJ(inTotal, r_in);
    const C_out = pedersenBJJ(t.amount_out, r_out);

    direction[i] = t.direction.toString();
    min_out[i] = t.min_out.toString();
    tip_amount[i] = t.tip_amount.toString();
    amount_in_swap[i] = t.amount_in_swap.toString();
    tip_amount_witness[i] = t.tip_amount.toString();
    r_in_BJJ[i] = r_in.toString();
    amount_out[i] = t.amount_out.toString();
    rem[i] = t.rem.toString();
    r_out_BJJ[i] = r_out.toString();
    C_in_BJJ_u[i] = C_in[0].toString();
    C_in_BJJ_v[i] = C_in[1].toString();
    C_out_BJJ_u[i] = C_out[0].toString();
    C_out_BJJ_v[i] = C_out[1].toString();
  }

  let deltaA_sign = 0, deltaB_sign = 0;
  if (solve.direction === 'A→B') { deltaA_sign = 0; deltaB_sign = 1; }
  else if (solve.direction === 'B→A') { deltaA_sign = 1; deltaB_sign = 0; }

  return {
    pool_id_fr: '12345678901234567890',
    R_A_pre: scenario.R_A.toString(),
    R_B_pre: scenario.R_B.toString(),
    delta_A_net_sign: deltaA_sign.toString(),
    delta_A_net_magnitude: solve.delta_a_net.toString(),
    delta_B_net_sign: deltaB_sign.toString(),
    delta_B_net_magnitude: solve.delta_b_net.toString(),
    tip_A_amount: tipA.toString(),
    tip_B_amount: tipB.toString(),
    fee_bps: scenario.fee_bps.toString(),
    n_intents: filled.length.toString(),
    direction, C_in_BJJ_u, C_in_BJJ_v, min_out, tip_amount,
    C_out_BJJ_u, C_out_BJJ_v,
    amount_in_swap, tip_amount_witness, r_in_BJJ,
    amount_out, rem, r_out_BJJ,
  };
}

describe('amm_swap_batch N=16 fuzz (circuit witness layer)', { skip: !WASM_AVAILABLE }, () => {

  let wc;
  test('build witness calculator', async () => {
    const wcFactory = require(WC_PATH);
    const wasm = readFileSync(WASM_PATH);
    wc = await wcFactory(wasm);
    assert.ok(wc, 'witness calculator built');
  });

  test('10 random N=16 mixed-direction batches all produce valid witnesses', async () => {
    let accepted = 0;
    for (let seed = 1000; seed < 1010; seed++) {
      const scenario = buildScenario(seed * 17 + 3);
      const input = buildCircuitInput(seed, scenario);
      if (input === null) continue;  // spot/empty
      let ok = true;
      try { await wc.calculateWitness(input, true); }
      catch (e) {
        ok = false;
        assert.fail(`seed ${seed} witness gen failed: ${e.message}`);
      }
      if (ok) accepted++;
    }
    assert.ok(accepted > 0, 'no batches accepted (all spot/empty?)');
  });

});
