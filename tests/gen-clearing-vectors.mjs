#!/usr/bin/env node
// Generate reference vectors for the §11.1 deterministic clearing-solve (AMM.md §4) from the
// normative JS implementation (tests/amm-clearing.mjs), so the Rust guest port
// (cxfer-core solve_clearing) can be asserted byte-for-byte identical. The guest ENFORCES the AMM
// fee by re-deriving P_clear and rejecting any batch whose declared price differs; if the port
// drifts from this JS, the fee is mis-enforced. Run: node tests/gen-clearing-vectors.mjs
//
// Writes contracts/sp1/confidential/fixtures/clearing_vectors.json.

import { solveClearing } from './amm-clearing.mjs';
import { writeFileSync } from 'node:fs';

// Battery: one-sided each direction, two-sided dominant each way, exact-cancel (spot), empty,
// zero + max fee, large reserves (exercise the ~2^142 intermediate product), asymmetric reserves,
// and a case with no exact binary-search fixed point (forces the 'best' fallback).
const CASES = [
  { x: 100, y: 0, rA: 1000, rB: 1000, fee: 30 },        // single A→B
  { x: 0, y: 100, rA: 1000, rB: 1000, fee: 30 },        // single B→A
  { x: 100, y: 90, rA: 1000, rB: 1000, fee: 30 },       // two-sided, A-dominant
  { x: 90, y: 100, rA: 1000, rB: 1000, fee: 30 },       // two-sided, B-dominant
  { x: 100, y: 100, rA: 1000, rB: 1000, fee: 30 },      // exact-cancel → spot
  { x: 100, y: 0, rA: 1000, rB: 1000, fee: 0 },         // zero fee
  { x: 100, y: 0, rA: 1000, rB: 1000, fee: 1000 },      // max fee 10%
  { x: 1_000_000, y: 500_000, rA: 1_000_000_000, rB: 2_000_000_000, fee: 30 }, // large
  { x: 7_000_000, y: 3_000_000, rA: 5_000_000_000, rB: 1_000_000_000, fee: 25 }, // asymmetric
  { x: 123_457, y: 65_537, rA: 999_983, rB: 1_000_003, fee: 30 }, // primes → no exact fixpoint
  { x: 1, y: 0, rA: 2, rB: 1_000_000, fee: 100 },       // tiny X, skewed pool
  { x: 18_000_000_000_000_000, y: 0, rA: 9_000_000_000_000_000_000n, rB: 9_000_000_000_000_000_000n, fee: 30 }, // near-u64 reserves
];

const vectors = CASES.map((c) => {
  const sol = solveClearing(BigInt(c.x), BigInt(c.y), BigInt(c.rA), BigInt(c.rB), c.fee);
  return {
    x: String(c.x), y: String(c.y), rA: String(c.rA), rB: String(c.rB), fee: c.fee,
    direction: sol.direction,
    pNum: sol.P_clear_num.toString(),
    pDen: sol.P_clear_den.toString(),
  };
});

const out = 'contracts/sp1/confidential/fixtures/clearing_vectors.json';
writeFileSync(out, JSON.stringify({ vectors }, null, 2) + '\n');
console.log(`wrote ${vectors.length} clearing vectors to ${out}`);
for (const v of vectors) console.log(`  ${v.direction.padEnd(5)} X=${v.x} Y=${v.y} R=${v.rA}/${v.rB} fee=${v.fee} → P_clear=${v.pNum}/${v.pDen}`);
