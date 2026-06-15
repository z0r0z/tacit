#!/usr/bin/env node
// Generate reference vectors for the constant-product exact-in HOP primitive (get_amount_out) that
// OP_SWAP_ROUTE chains, so the Rust guest port (cxfer-core get_amount_out) can be asserted byte-for-byte
// identical AND the Bitcoin route validator's floor (swap-route.mjs cfmmFloorOk) is pinned to the same
// value. Closes the dual-implementation drift gap: previously only the BATCH clearing solve had a
// JS↔Rust KAT (clearing_vectors.json) — the per-hop curve was asserted-equal by comment only.
//
// get_amount_out(a_in, R_in, R_out, fee) = ⌊R_out·γ·a_in / (R_in·10000 + γ·a_in)⌋,  γ = 10000 − fee_bps.
// This is exactly the MAX delta_out cfmmFloorOk accepts, so for each vector:
//   cfmmFloorOk(delta_out = amountOut)     == true   (the floor admits the exact curve output)
//   cfmmFloorOk(delta_out = amountOut + 1) == false  (one more would push k below the curve)
//
// Run: node tests/gen-amount-out-vectors.mjs  → writes contracts/sp1/confidential/fixtures/get_amount_out_vectors.json
import { writeFileSync } from 'node:fs';
import { cfmmFloorOk } from './swap-route.mjs';

// The normative per-hop curve (mirrors cxfer-core get_amount_out + worker ammCurveDeltaOut).
export function getAmountOut(amountIn, reserveIn, reserveOut, feeBps) {
  const gamma = 10000n - BigInt(feeBps);
  const ainG = BigInt(amountIn) * gamma;
  const num = BigInt(reserveOut) * ainG;
  const den = BigInt(reserveIn) * 10000n + ainG;
  return num / den; // floor toward the pool
}

// Battery: no-fee, 0.3%, max 10% fee; tiny-in skewed pool; large + asymmetric reserves; primes (no clean
// division); near-u64 reserves (exercise the ~2^142 intermediate product); slippage-heavy small out reserve.
export const CASES = [
  { amountIn: 1000n, reserveIn: 1_000_000n, reserveOut: 1_000_000n, feeBps: 0 },
  { amountIn: 1000n, reserveIn: 1_000_000n, reserveOut: 1_000_000n, feeBps: 30 },
  { amountIn: 1000n, reserveIn: 1_000_000n, reserveOut: 1_000_000n, feeBps: 1000 },
  { amountIn: 1n, reserveIn: 2n, reserveOut: 1_000_000n, feeBps: 100 },
  { amountIn: 5_000_000n, reserveIn: 1_000_000_000n, reserveOut: 2_000_000_000n, feeBps: 30 },
  { amountIn: 7_000_000n, reserveIn: 5_000_000_000n, reserveOut: 1_000_000_000n, feeBps: 25 },
  { amountIn: 123_457n, reserveIn: 999_983n, reserveOut: 1_000_003n, feeBps: 30 },
  { amountIn: 1000n, reserveIn: 1_000_000n, reserveOut: 5000n, feeBps: 30 },
  { amountIn: 18_000_000_000_000_000n, reserveIn: 9_000_000_000_000_000_000n, reserveOut: 9_000_000_000_000_000_000n, feeBps: 30 },
];

export function computeVectors() {
  return CASES.map((c) => {
    const amountOut = getAmountOut(c.amountIn, c.reserveIn, c.reserveOut, c.feeBps);
    // Pin the Bitcoin route-floor to the same value: the exact output is admitted, one more is rejected.
    const f = (d) => cfmmFloorOk({ delta_in: c.amountIn, delta_out: d, R_in: c.reserveIn, R_out: c.reserveOut, fee_bps: c.feeBps });
    if (!f(amountOut)) throw new Error(`cfmmFloorOk rejected the exact curve output for ${JSON.stringify(c)}`);
    if (f(amountOut + 1n)) throw new Error(`cfmmFloorOk admitted amountOut+1 (floor not exact) for ${JSON.stringify(c)}`);
    return {
      amountIn: c.amountIn.toString(), reserveIn: c.reserveIn.toString(),
      reserveOut: c.reserveOut.toString(), feeBps: c.feeBps, amountOut: amountOut.toString(),
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = { _comment: 'get_amount_out (per-hop CFMM exact-in) KAT: JS reference == Rust cxfer-core get_amount_out == max delta_out admitted by swap-route cfmmFloorOk. Regenerate: node tests/gen-amount-out-vectors.mjs', vectors: computeVectors() };
  const path = new URL('../contracts/sp1/confidential/fixtures/get_amount_out_vectors.json', import.meta.url);
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${out.vectors.length} get_amount_out vectors`);
}
