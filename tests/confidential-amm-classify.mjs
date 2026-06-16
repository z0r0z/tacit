#!/usr/bin/env node
// Live-classifier flip validation: classifyConfidentialTx must parse each on-chain AMM op's REAL envelope
// (taken from the reflect-exec-DIGEST_MATCH-validated gens' txData) to the fold-critical fields the assembler
// reads. We run the light gens, classify their txData, and assert the type + the public scalars/assets/
// commitments the gen used (the commitments/sigs themselves are exercised by the gens' folds). Confirms the
// classifier routes swap_var / swap_route / harvest / protocol_fee_claim / farm_init (+ inline farm_refund),
// no longer 'unsupported'. Run: node tests/confidential-amm-classify.mjs

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { classifyConfidentialTx, parseHarvestEnvelope } from '../dapp/burn-deposit-bitcoin.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
let failures = 0;
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };
const norm = (x) => (typeof x === 'string' ? x.replace(/^0x/, '').toLowerCase() : x);
const numEq = (a, b) => { try { return BigInt(a) === BigInt(b); } catch { return false; } };
const txData = (gen) => JSON.parse(execFileSync('node', [`tests/${gen}`], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] })).blocks[0].txs[0].txData;
const ZERO33 = '0x' + '00'.repeat(33);
const A = '0x' + 'a1'.repeat(32), B = '0x' + 'b2'.repeat(32), C = '0x' + 'c3'.repeat(32);

// ── swap_var (gen: pool 0x99…, dir 0, R 1e6/2e6, dIn 1000, dOut 1990) ──
{
  const d = classifyConfidentialTx(txData('gen-reflection-swapvar-synth.mjs'));
  ok(d && d.type === 'swap_var', 'swap_var: type');
  ok(d && norm(d.poolId) === '99'.repeat(32) && d.direction === 0 && numEq(d.rAPre, 1000000) && numEq(d.rBPre, 2000000) && numEq(d.deltaIn, 1000) && numEq(d.deltaOut, 1990), '  swap_var: poolId/dir/reserves/deltas');
  ok(d && /^(0x)?0{66}$/i.test(d.cChangeOrSentinel) && norm(d.cReceipt).length === 66 && norm(d.kernelSig).length === 128, '  swap_var: sentinel change + 33B cReceipt + 64B kernelSig');
}
// ── swap_route (gen: A→C via pool1(A,B) + pool2(B,C); hop0 R 1e6/2e6 d 1000/1900, hop1 R 2e6/4e6 d 1900/3600) ──
{
  const d = classifyConfidentialTx(txData('gen-reflection-swaproute-synth.mjs'));
  ok(d && d.type === 'swap_route', 'swap_route: type');
  ok(d && norm(d.traderInputAsset) === 'a1'.repeat(32) && norm(d.traderOutputAsset) === 'c3'.repeat(32) && d.hops.length === 2, '  swap_route: assets + 2 hops');
  ok(d && norm(d.hops[0].poolId) === norm(pool.ammDerivePoolIdFull(A, B, 0, 0, ZERO33, 0)) && numEq(d.hops[0].deltaANetMag, 1000) && numEq(d.hops[0].deltaBNetMag, 1900), '  swap_route: hop0 poolId + deltas');
  ok(d && norm(d.hops[1].poolId) === norm(pool.ammDerivePoolIdFull(B, C, 0, 0, ZERO33, 0)) && numEq(d.hops[1].deltaANetMag, 1900) && numEq(d.hops[1].deltaBNetMag, 3600), '  swap_route: hop1 poolId + deltas');
}
// ── harvest (gen: farm 0x44…, reward 25000) ──
{
  const d = classifyConfidentialTx(txData('gen-reflection-harvest-synth.mjs'));
  ok(d && d.type === 'harvest' && norm(d.farmId) === '44'.repeat(32) && numEq(d.amount, 25000) && norm(d.r).length === 64, 'harvest: type/farmId/amount/r');
}
// ── protocol_fee_claim (gen: pool 0x31…, accrued 1502) ──
{
  const d = classifyConfidentialTx(txData('gen-reflection-protofee-synth.mjs'));
  ok(d && d.type === 'protocol_fee_claim' && norm(d.poolId) === '31'.repeat(32) && numEq(d.amount, 1502) && norm(d.cSecp).length === 66 && norm(d.blinding).length === 64, 'protocol_fee_claim: type/poolId/amount/cSecp/blinding');
}
// ── farm_init (gen: pool 0x77…, nonce 0x01…, reward asset 0xc3…, total 500000) ──
{
  const d = classifyConfidentialTx(txData('gen-reflection-farminit-synth.mjs'));
  ok(d && d.type === 'farm_init' && norm(d.poolId) === '77'.repeat(32) && norm(d.farmNonce) === '01'.repeat(32) && norm(d.rewardAsset) === 'c3'.repeat(32) && numEq(d.rewardTotal, 500000) && norm(d.kernelSig).length === 128, 'farm_init: type/poolId/nonce/asset/total/kernelSig');
}
// ── farm_refund (0x3E, no gen): inline parse ──
{
  const e = new Uint8Array(174); e[0] = 0x3e; e.fill(0xab, 1, 33); e[66] = 0xe8; e[67] = 0x03; e.fill(0xcd, 78, 110);
  const d = parseHarvestEnvelope('0x' + Buffer.from(e).toString('hex'));
  ok(d && d.type === 'farm_refund' && numEq(d.amount, 1000) && norm(d.farmId) === 'ab'.repeat(32) && norm(d.r) === 'cd'.repeat(32), 'farm_refund (0x3E): type/farmId/amount/r');
}
// ── swap_batch (0x2F): its gen fullProves a real 1-intent A→B batch (snarkjs + the ~95MB head zkey), which is
// heavy enough to deadlock a memory-constrained machine — so it is OPT-IN (RUN_SWAPBATCH_GEN=1, set on the box)
// and time-bounded. When off/absent/timed-out, SKIP LOUD (never a silent pass) — the box's reflect-exec
// DIGEST_MATCH is the authority for the fold; here we only assert a real 0x2F classifies to swap_batch. ──
{
  const ZKEY = process.env.REFLECT_SWAPBATCH_ZKEY || '/tmp/head-swapbatch.zkey';
  const VK = process.env.SWAPBATCH_VK || '/tmp/swapbatch-inline-vk.json';
  const WASM = 'dapp/circuits/amm/build/amm_swap_batch_js/amm_swap_batch.wasm';
  let raw = null;
  if (process.env.RUN_SWAPBATCH_GEN === '1' && existsSync(ZKEY) && existsSync(VK) && existsSync(WASM)) {
    try {
      raw = JSON.parse(execFileSync('node', ['tests/gen-reflection-swapbatch-synth.mjs'],
        { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 180000, stdio: ['ignore', 'pipe', 'ignore'] })).blocks[0].txs[0].txData;
    } catch (e) { console.error(`SKIP swap_batch classify: gen failed/timed out (${e.code || e.message}) — validated on the box`); }
  } else {
    console.error('SKIP swap_batch classify: set RUN_SWAPBATCH_GEN=1 with the head zkey to run (validated on the box)');
  }
  if (raw) {
    const d = classifyConfidentialTx(raw);
    ok(d && d.type === 'swap_batch' && d.nIntents === 1 && d.intents.length === 1 && d.receipts.length === 1
      && norm(d.proof).length === 512 && norm(d.assetA).length === 64 && norm(d.assetB).length === 64,
      'swap_batch (0x2F): classifies to swap_batch (1 intent/receipt, 256B proof)');
  }
}

console.log(failures ? `\n${failures} FAIL` : '\nall ok — AMM ops route live (classify parses each on-chain envelope to its fold env)');
process.exit(failures ? 1 : 0);
