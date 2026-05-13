// Adversarial witness tests for the three AMM circuits.
//
// Each test constructs an invalid witness corresponding to a specific attack
// vector and confirms the wasm witness calculator REJECTS it (Assert Failed
// or constraint-violation throw). Honest paths are covered by witness-test.mjs;
// this file focuses on the kinds of cheats a malicious settler / LP could try.
//
// Run from this directory: `node adversarial-test.mjs`
// (Requires build/ artifacts; run ./build.sh first.)

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const TESTS_DIR = resolve(__dirname, '../../../tests');

async function buildWitnessCalculator(name) {
  const wcFactory = require(resolve(__dirname, `build/${name}_js/witness_calculator.cjs`));
  const wasm = readFileSync(resolve(__dirname, `build/${name}_js/${name}.wasm`));
  return await wcFactory(wasm);
}

let pass = 0, fail = 0;
async function assertReject(label, input, name) {
  try {
    const wc = await buildWitnessCalculator(name);
    await wc.calculateWitness(input, true);
    console.log(`  FAIL  ${label}  (witness generated when it should have been rejected)`);
    fail++;
  } catch (e) {
    if (/Assert Failed|Error in template|Not enough input|Invalid value/.test(e.message)) {
      console.log(`  PASS  ${label}`);
      pass++;
    } else {
      console.log(`  THROW ${label}: ${e.message}`);
      fail++;
    }
  }
}

const bjj      = await import(resolve(TESTS_DIR, 'amm-bjj.mjs'));
const clearing = await import(resolve(TESTS_DIR, 'amm-clearing.mjs'));

function randomBJJBlinding() {
  while (true) {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    let n = 0n;
    for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(buf[i]);
    if (n > 0n && n < bjj.N_BJJ) return n;
  }
}

// =========================================================================
// LP_ADD adversarial tests
// =========================================================================

console.log('amm_lp_add adversarial cases');

await assertReject('variant > 1 ⇒ rejected', (() => {
  const shareAmount = 1_414_213n;
  const r_share = randomBJJBlinding();
  const C = bjj.pedersenBJJ(shareAmount, r_share);
  return {
    pool_id_fr: '1', variant: '2',                           // invalid variant
    share_amount: shareAmount.toString(),
    C_share_BJJ_u: C[0].toString(), C_share_BJJ_v: C[1].toString(),
    r_share_BJJ: r_share.toString(),
  };
})(), 'amm_lp_add');

await assertReject('share_amount exceeds 2^64 ⇒ rejected', (() => {
  // share_amount = 2^64 (one over the bound). PedersenBJJ Num2Bits(64) will fail.
  const shareAmount = (1n << 64n);
  const r_share = randomBJJBlinding();
  // We can't actually compute pedersenBJJ for a value > Fr; but circom range
  // check fires before that. Use a placeholder commitment.
  return {
    pool_id_fr: '1', variant: '0',
    share_amount: shareAmount.toString(),
    C_share_BJJ_u: '0', C_share_BJJ_v: '1',
    r_share_BJJ: '0',
  };
})(), 'amm_lp_add');

await assertReject('mismatched commitment u-coord ⇒ rejected', (() => {
  const shareAmount = 1000n;
  const r_share = randomBJJBlinding();
  const C = bjj.pedersenBJJ(shareAmount, r_share);
  return {
    pool_id_fr: '1', variant: '0',
    share_amount: shareAmount.toString(),
    C_share_BJJ_u: (C[0] + 1n).toString(),                   // off-by-one
    C_share_BJJ_v: C[1].toString(),
    r_share_BJJ: r_share.toString(),
  };
})(), 'amm_lp_add');

await assertReject('wrong r_share_BJJ ⇒ rejected', (() => {
  const shareAmount = 1000n;
  const r_share = randomBJJBlinding();
  const C = bjj.pedersenBJJ(shareAmount, r_share);
  const wrongR = randomBJJBlinding();
  return {
    pool_id_fr: '1', variant: '0',
    share_amount: shareAmount.toString(),
    C_share_BJJ_u: C[0].toString(), C_share_BJJ_v: C[1].toString(),
    r_share_BJJ: wrongR.toString(),                          // claims different r
  };
})(), 'amm_lp_add');

// =========================================================================
// LP_REMOVE adversarial tests
// =========================================================================

console.log('\namm_lp_remove adversarial cases');

await assertReject('swapped recv_A and recv_B commitments ⇒ rejected', (() => {
  const deltaA = 500n, deltaB = 1000n;
  const r_A = randomBJJBlinding();
  const r_B = randomBJJBlinding();
  const C_A = bjj.pedersenBJJ(deltaA, r_A);
  const C_B = bjj.pedersenBJJ(deltaB, r_B);
  // Provide the wrong (amount, commitment) pairing: A-side gets B's commitment.
  return {
    pool_id_fr: '1',
    share_amount: '1000', delta_A: deltaA.toString(), delta_B: deltaB.toString(),
    recv_A_BJJ_u: C_B[0].toString(), recv_A_BJJ_v: C_B[1].toString(),
    recv_B_BJJ_u: C_A[0].toString(), recv_B_BJJ_v: C_A[1].toString(),
    r_recv_A_BJJ: r_A.toString(), r_recv_B_BJJ: r_B.toString(),
  };
})(), 'amm_lp_remove');

await assertReject('share_amount exceeds 2^64 ⇒ rejected', (() => {
  return {
    pool_id_fr: '1',
    share_amount: ((1n << 64n)).toString(),                  // out of range
    delta_A: '0', delta_B: '0',
    recv_A_BJJ_u: '0', recv_A_BJJ_v: '1',
    recv_B_BJJ_u: '0', recv_B_BJJ_v: '1',
    r_recv_A_BJJ: '0', r_recv_B_BJJ: '0',
  };
})(), 'amm_lp_remove');

await assertReject('delta_A exceeds 2^64 (PedersenBJJ range check) ⇒ rejected', (() => {
  return {
    pool_id_fr: '1',
    share_amount: '1000',
    delta_A: ((1n << 64n)).toString(),                       // out of range
    delta_B: '1000',
    recv_A_BJJ_u: '0', recv_A_BJJ_v: '1',
    recv_B_BJJ_u: '0', recv_B_BJJ_v: '1',
    r_recv_A_BJJ: '0', r_recv_B_BJJ: '0',
  };
})(), 'amm_lp_remove');

// =========================================================================
// SWAP_BATCH adversarial tests
// =========================================================================

const N_MAX = 16;

// Build a "honest" SWAP_BATCH input that we then mutate per test.
function buildSwapInput(traders, opts = {}) {
  const R_A = opts.R_A || 1_000_000n;
  const R_B = opts.R_B || 2_000_000n;
  const fee_bps = opts.fee_bps || 30;
  const X = traders.filter(t => t.direction === 0).reduce((s, t) => s + t.amount_in_swap, 0n);
  const Y = traders.filter(t => t.direction === 1).reduce((s, t) => s + t.amount_in_swap, 0n);
  const solve = (X === 0n && Y === 0n)
    ? { direction: 'empty', delta_a_net: 0n, delta_b_net: 0n, P_clear_num: R_A, P_clear_den: R_B }
    : clearing.solveClearing(X, Y, R_A, R_B, BigInt(fee_bps));

  const filled = traders.map(t => {
    let aOut, mult, div;
    if (t.direction === 0) {
      aOut = (t.amount_in_swap * solve.P_clear_den) / solve.P_clear_num;
      mult = solve.P_clear_den; div = solve.P_clear_num;
    } else {
      aOut = (t.amount_in_swap * solve.P_clear_num) / solve.P_clear_den;
      mult = solve.P_clear_num; div = solve.P_clear_den;
    }
    const num = t.amount_in_swap * mult;
    const rem = num - aOut * div;
    return { ...t, amount_out: aOut, rem };
  });

  const tipA = filled.filter(t => t.direction === 0).reduce((s, t) => s + t.tip_amount, 0n);
  const tipB = filled.filter(t => t.direction === 1).reduce((s, t) => s + t.tip_amount, 0n);

  const direction = Array(N_MAX).fill('0');
  const min_out = Array(N_MAX).fill('0');
  const tip_amount = Array(N_MAX).fill('0');
  const amount_in_swap = Array(N_MAX).fill('0');
  const tip_amount_witness = Array(N_MAX).fill('0');
  const r_in_BJJ = Array(N_MAX).fill('0');
  const amount_out = Array(N_MAX).fill('0');
  const rem = Array(N_MAX).fill('0');
  const r_out_BJJ = Array(N_MAX).fill('0');
  const C_in_BJJ_u = Array(N_MAX).fill('0');
  const C_in_BJJ_v = Array(N_MAX).fill('1');
  const C_out_BJJ_u = Array(N_MAX).fill('0');
  const C_out_BJJ_v = Array(N_MAX).fill('1');

  for (let i = 0; i < filled.length; i++) {
    const t = filled[i];
    const inTotal = t.amount_in_swap + t.tip_amount;
    const r_in = randomBJJBlinding();
    const r_out = randomBJJBlinding();
    const C_in = bjj.pedersenBJJ(inTotal, r_in);
    const C_out = bjj.pedersenBJJ(t.amount_out, r_out);
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

  let deltaA_sign = '0', deltaB_sign = '0';
  if (solve.direction === 'A→B') { deltaA_sign = '0'; deltaB_sign = '1'; }
  else if (solve.direction === 'B→A') { deltaA_sign = '1'; deltaB_sign = '0'; }

  return {
    pool_id_fr: '12345',
    R_A_pre: R_A.toString(), R_B_pre: R_B.toString(),
    delta_A_net_sign: deltaA_sign, delta_A_net_magnitude: solve.delta_a_net.toString(),
    delta_B_net_sign: deltaB_sign, delta_B_net_magnitude: solve.delta_b_net.toString(),
    tip_A_amount: tipA.toString(), tip_B_amount: tipB.toString(),
    fee_bps: fee_bps.toString(), n_intents: filled.length.toString(),
    direction, C_in_BJJ_u, C_in_BJJ_v, min_out, tip_amount,
    C_out_BJJ_u, C_out_BJJ_v,
    amount_in_swap, tip_amount_witness, r_in_BJJ,
    amount_out, rem, r_out_BJJ,
  };
}

const baseTraders = [{ direction: 0, amount_in_swap: 1000n, tip_amount: 50n, min_out: 0n }];

console.log('\namm_swap_batch adversarial cases — direction & range');

await assertReject('direction = 2 (out of {0,1}) ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  inp.direction[0] = '2';
  return inp;
})(), 'amm_swap_batch');

await assertReject('direction = 5 ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  inp.direction[0] = '5';
  return inp;
})(), 'amm_swap_batch');

await assertReject('delta_A_net_sign = 2 (non-bit) ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  inp.delta_A_net_sign = '2';
  return inp;
})(), 'amm_swap_batch');

await assertReject('delta_B_net_sign = 7 (non-bit) ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  inp.delta_B_net_sign = '7';
  return inp;
})(), 'amm_swap_batch');

await assertReject('fee_bps > 1023 (10-bit cap) ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  inp.fee_bps = '1024';
  return inp;
})(), 'amm_swap_batch');

console.log('\namm_swap_batch adversarial — tip binding');

await assertReject('tip_amount_witness ≠ public tip_amount ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  inp.tip_amount_witness[0] = '999';                         // diverges from inp.tip_amount[0] = '50'
  return inp;
})(), 'amm_swap_batch');

await assertReject('public tip_A_amount ≠ Σ tip_amount over direction=0 ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  inp.tip_A_amount = '999';                                  // claims wrong aggregate
  return inp;
})(), 'amm_swap_batch');

await assertReject('tip on wrong direction side ⇒ aggregate mismatch ⇒ rejected', (() => {
  // Trader is direction=0 (A→B), tip should go to tip_A. Claim tip_B has it.
  const inp = buildSwapInput(baseTraders);
  inp.tip_A_amount = '0';
  inp.tip_B_amount = '50';                                   // wrong direction
  return inp;
})(), 'amm_swap_batch');

console.log('\namm_swap_batch adversarial — amount_out / rem manipulation');

await assertReject('amount_out > floor(amount_in · ratio) ⇒ rejected (rem ≥ divisor)', (() => {
  const inp = buildSwapInput(baseTraders);
  const aOut = BigInt(inp.amount_out[0]);
  inp.amount_out[0] = (aOut + 1n).toString();
  // To keep div_lhs === div_rhs + rem balance, rem becomes negative → field
  // wrap → fails rem < divisor LessThan check. Also the Pedersen opening
  // would fail because C_out_BJJ was computed for the original amount_out.
  return inp;
})(), 'amm_swap_batch');

await assertReject('rem ≥ divisor (forge a high quotient) ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  // Cleanly: set rem = divisor (= P_clear_num for A→B with the trivial setup).
  // The equation amount_in · multiplier === amount_out · divisor + rem still
  // needs to hold; satisfying both is impossible, so witness gen fails.
  inp.rem[0] = inp.delta_A_net_magnitude;                    // some large value
  return inp;
})(), 'amm_swap_batch');

console.log('\namm_swap_batch adversarial — Pedersen commitment swaps');

await assertReject('swap C_in_BJJ across two intent slots ⇒ rejected', (() => {
  const inp = buildSwapInput([
    { direction: 0, amount_in_swap: 600n, tip_amount: 10n, min_out: 0n },
    { direction: 1, amount_in_swap: 900n, tip_amount: 20n, min_out: 0n },
  ]);
  // Swap the two intents' input commitments.
  [inp.C_in_BJJ_u[0], inp.C_in_BJJ_u[1]] = [inp.C_in_BJJ_u[1], inp.C_in_BJJ_u[0]];
  [inp.C_in_BJJ_v[0], inp.C_in_BJJ_v[1]] = [inp.C_in_BJJ_v[1], inp.C_in_BJJ_v[0]];
  return inp;
})(), 'amm_swap_batch');

await assertReject('amount_in_swap doesn’t match C_in_BJJ ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  inp.amount_in_swap[0] = (BigInt(inp.amount_in_swap[0]) + 1n).toString();
  return inp;
})(), 'amm_swap_batch');

console.log('\namm_swap_batch adversarial — spot vs non-spot discrimination');

await assertReject('non-spot batch declared with both signs = 0 ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  // Default A-dom should have signs (0, 1). Force both to 0.
  inp.delta_B_net_sign = '0';
  return inp;
})(), 'amm_swap_batch');

await assertReject('non-spot batch declared with both signs = 1 ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  inp.delta_A_net_sign = '1';
  inp.delta_B_net_sign = '1';
  return inp;
})(), 'amm_swap_batch');

console.log('\namm_swap_batch adversarial — min_out');

await assertReject('amount_out < min_out ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  // min_out higher than the computed amount_out.
  inp.min_out[0] = (BigInt(inp.amount_out[0]) + 1n).toString();
  return inp;
})(), 'amm_swap_batch');

console.log('\namm_swap_batch adversarial — padding slot manipulation');

await assertReject('padded slot with non-identity C_in_BJJ ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  // Slot 1 onwards is padded. Inject a non-identity commitment but leave the
  // amount/r witness as zero. PedersenBJJ(0, 0) = (0, 1); if we claim a
  // different (u, v) the opening constraint fails.
  inp.C_in_BJJ_u[1] = '12345';
  inp.C_in_BJJ_v[1] = '67890';
  return inp;
})(), 'amm_swap_batch');

await assertReject('padded slot with non-zero amount_in_swap but zero r ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  // Inject amount_in_swap > 0 into padded slot 5. The C_in_BJJ at slot 5 is
  // still (0, 1) — PedersenBJJ(amount, 0) = amount·H_BJJ ≠ (0, 1) for amount ≠ 0,
  // so the opening fails.
  inp.amount_in_swap[5] = '500';
  return inp;
})(), 'amm_swap_batch');

console.log('\namm_swap_batch adversarial — single-side empty batches');

await assertReject('B→A trader claimed as A-dominant batch ⇒ rejected', (() => {
  // Real B→A flow but settler claims sign=0 (A-dominant). Aggregate Pedersen
  // wouldn't match — but the circuit's P_clear derivation also drops to wrong
  // branch.
  const inp = buildSwapInput([{ direction: 1, amount_in_swap: 1000n, tip_amount: 0n, min_out: 0n }]);
  inp.delta_A_net_sign = '0';                                // claim A flows in
  inp.delta_B_net_sign = '1';                                // claim B flows out
  return inp;
})(), 'amm_swap_batch');

console.log('\namm_swap_batch adversarial — hardening additions (pre-ceremony fixes)');

await assertReject('spot batch with non-canonical signs (1, 0) ⇒ rejected', (() => {
  // Spot batch: both magnitudes 0, but signs set to (1, 0) instead of (0, 0).
  // New constraint `is_spot · (sign_A + sign_B) === 0` should reject.
  const inp = buildSwapInput([
    { direction: 0, amount_in_swap: 500n,  tip_amount: 0n, min_out: 0n },
    { direction: 1, amount_in_swap: 1000n, tip_amount: 0n, min_out: 0n },
  ]);
  // Confirm we're in spot
  if (inp.delta_A_net_magnitude !== '0' || inp.delta_B_net_magnitude !== '0') {
    throw new Error('expected spot batch for this test');
  }
  inp.delta_A_net_sign = '1';
  inp.delta_B_net_sign = '0';
  return inp;
})(), 'amm_swap_batch');

await assertReject('fee_bps = 1001 (over spec cap) ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  inp.fee_bps = '1001';
  return inp;
})(), 'amm_swap_batch');

await assertReject('fee_bps = 1023 (max 10-bit but over spec cap) ⇒ rejected', (() => {
  const inp = buildSwapInput(baseTraders);
  inp.fee_bps = '1023';
  return inp;
})(), 'amm_swap_batch');

console.log(`\n${pass}/${pass + fail} adversarial cases properly rejected`);
if (fail > 0) process.exit(1);
