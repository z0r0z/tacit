// LP-supply invariant test.
//
// Asserts the protocol's accounting identity holds at every event in a
// pool's lifetime:
//
//   pool.lp_total_shares − pool.protocol_fee_accrued
//                     ==  Σ(minted lp_asset_id UTXO amounts)
//                         − Σ(burned lp_asset_id UTXO amounts)
//
// Where "mint" / "burn" events are:
//
//   POOL_INIT    mints founder_shares (vout[0]) + locked_shares (vout[1])
//   LP_ADD v=0   mints share_amount (vout[0])
//   LP_REMOVE    burns share_amount (LP's spent share UTXOs)
//   SWAP_*       does NOT touch lp_total_shares directly — only
//                crystallizeProtocolFee, fired on the NEXT LP event,
//                converts k-growth into protocol_fee_accrued shares
//   FEE_CLAIM    mints claim_amount (vout[0]) of the founder-pinned
//                recipient. The shares are already counted in
//                lp_total_shares (from earlier crystallization);
//                protocol_fee_accrued resets to 0 at claim.
//
// The test runs through a representative lifecycle:
//   1.  POOL_INIT  (founder seeds 1000:2000, no protocol fee)
//   2.  LP_ADD     (second LP joins at the ratio)
//   3.  SWAP       (grows k, accrues no protocol fee since pool has none)
//   4.  LP_REMOVE  (second LP burns shares for a proportional slice)
//   5.  Tear down
//
//   6.  POOL_INIT  (founder seeds a fee-bearing pool: 100 bps protocol fee)
//   7.  SWAP × 3   (grows k; protocol_fee_accrued increases at the NEXT
//                  LP event via crystallizeProtocolFee)
//   8.  LP_ADD     (triggers crystallization — invariant must hold)
//   9.  FEE_CLAIM  (founder mints accrued; lp_total_shares unchanged but
//                  the accrued counter resets and a fresh UTXO is minted)
//  10.  LP_REMOVE  (full burn-down)
//
// At every step the test recomputes the invariant; any divergence is a
// supply-accounting bug.
//
// Run: `node tests/amm-lp-supply-invariant.test.mjs`

import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, hexToBytes } from '@noble/hashes/utils';

import { lpAddShares, lpInitShares, lpRemoveOutputs, solveClearing, amountOutForTrader } from './amm-clearing.mjs';
import { crystallizeProtocolFee, computeProtocolShares } from './amm-protocol-fee.mjs';

const MINIMUM_LIQUIDITY = 1000n;

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}  (returned ${typeof ok === 'object' ? JSON.stringify(ok) : ok})`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

// In-memory ledger: tracks every event that mints / burns lp_asset_id
// UTXO amounts. The invariant compares this ledger to pool state at
// each step.
class LedgerInvariant {
  constructor() {
    this.minted = 0n;   // Σ of UTXO amounts emitted as lp_asset_id outputs
    this.burned = 0n;   // Σ of UTXO amounts consumed as lp_asset_id inputs
    this.events = [];
  }
  mint(amount, label) {
    this.minted += BigInt(amount);
    this.events.push({ kind: 'mint', amount: BigInt(amount), label });
  }
  burn(amount, label) {
    this.burned += BigInt(amount);
    this.events.push({ kind: 'burn', amount: BigInt(amount), label });
  }
  circulating() { return this.minted - this.burned; }
  check(pool, contextLabel) {
    // Invariant: lp_total_shares − protocol_fee_accrued == minted − burned
    const lhs = BigInt(pool.lp_total_shares) - BigInt(pool.protocol_fee_accrued || 0n);
    const rhs = this.circulating();
    if (lhs !== rhs) {
      throw new Error(
        `LP-supply invariant violated at ${contextLabel}: ` +
        `lp_total_shares ${pool.lp_total_shares} − accrued ${pool.protocol_fee_accrued || 0n} = ${lhs}, ` +
        `but Σ(mint) ${this.minted} − Σ(burn) ${this.burned} = ${rhs}`,
      );
    }
    return true;
  }
}

// Helper: simulate a swap on the pool's reserves under the deterministic
// clearing-solve algorithm. Returns updated pool state. Doesn't touch
// lp_total_shares (swaps never do, per the invariant).
function applySwap(pool, direction, deltaIn) {
  const X = direction === 0 ? deltaIn : 0n;
  const Y = direction === 1 ? deltaIn : 0n;
  if (direction !== 0 && direction !== 1) throw new Error('direction must be 0|1');
  const solve = solveClearing(X, Y, pool.reserve_A, pool.reserve_B, BigInt(pool.fee_bps));
  const aOut = amountOutForTrader(deltaIn, direction, solve.P_clear_num, solve.P_clear_den);
  let newReserveA, newReserveB;
  if (direction === 0) {
    // Trader pays A into pool, receives B out
    newReserveA = pool.reserve_A + deltaIn;
    newReserveB = pool.reserve_B - aOut;
  } else {
    newReserveA = pool.reserve_A - aOut;
    newReserveB = pool.reserve_B + deltaIn;
  }
  return {
    ...pool,
    reserve_A: newReserveA,
    reserve_B: newReserveB,
  };
}

// =========================================================================
// Scenario A — no protocol fee
// =========================================================================
console.log('Scenario A: pool without protocol fee');
{
  const ledger = new LedgerInvariant();
  const init = lpInitShares(1_000n, 2_000n, MINIMUM_LIQUIDITY);
  let pool = {
    pool_id: new Uint8Array(32),
    reserve_A: 1_000n,
    reserve_B: 2_000n,
    fee_bps: 30,
    lp_total_shares: init.total_shares,
    protocol_fee_accrued: 0n,
    protocol_fee_bps: 0,
    protocol_fee_address: new Uint8Array(33),  // zero address
    k_last: 1_000n * 2_000n,
  };
  ledger.mint(init.founder_shares, 'POOL_INIT founder');
  ledger.mint(init.locked_shares,  'POOL_INIT MINIMUM_LIQUIDITY');
  test('A1: POOL_INIT supply invariant holds', () => ledger.check(pool, 'A1 POOL_INIT'));

  // LP_ADD: second LP joins at the ratio, doubling each side.
  const lpAddDeltaA = 500n;
  const lpAddDeltaB = 1_000n;
  const lpAddShares0 = lpAddShares(lpAddDeltaA, lpAddDeltaB, pool.reserve_A, pool.reserve_B, pool.lp_total_shares);
  // Crystallize first (no-op since protocol fee is disabled).
  pool = crystallizeProtocolFee(pool);
  // Apply LP_ADD.
  pool = {
    ...pool,
    reserve_A: pool.reserve_A + lpAddDeltaA,
    reserve_B: pool.reserve_B + lpAddDeltaB,
    lp_total_shares: pool.lp_total_shares + lpAddShares0,
    k_last: (pool.reserve_A + lpAddDeltaA) * (pool.reserve_B + lpAddDeltaB),
  };
  ledger.mint(lpAddShares0, 'LP_ADD #1');
  test('A2: LP_ADD supply invariant holds', () => ledger.check(pool, 'A2 LP_ADD'));

  // SWAP: trader pays in A side. Reserves shift but lp_total_shares unchanged.
  const lpSharesBeforeSwap = pool.lp_total_shares;
  pool = applySwap(pool, 0, 100n);
  test('A3: SWAP leaves lp_total_shares unchanged', () => pool.lp_total_shares === lpSharesBeforeSwap);
  test('A3: SWAP supply invariant holds', () => ledger.check(pool, 'A3 SWAP'));

  // LP_REMOVE: founder burns shareAmount worth of LP shares (must be ≤
  // their position — founder_shares is the only spendable bag of shares,
  // since locked_shares is at the NUMS recipient).
  const burnAmount = init.founder_shares / 4n;
  // Crystallize first (no-op).
  pool = crystallizeProtocolFee(pool);
  // Apply LP_REMOVE.
  const out = lpRemoveOutputs(burnAmount, pool.reserve_A, pool.reserve_B, pool.lp_total_shares);
  pool = {
    ...pool,
    reserve_A: pool.reserve_A - out.delta_a,
    reserve_B: pool.reserve_B - out.delta_b,
    lp_total_shares: pool.lp_total_shares - burnAmount,
    k_last: (pool.reserve_A - out.delta_a) * (pool.reserve_B - out.delta_b),
  };
  ledger.burn(burnAmount, 'LP_REMOVE founder partial');
  test('A4: LP_REMOVE supply invariant holds', () => ledger.check(pool, 'A4 LP_REMOVE'));
}

// =========================================================================
// Scenario B — pool WITH a protocol fee (lazy crystallization)
// =========================================================================
console.log('\nScenario B: pool with 100bps protocol fee (lazy crystallization)');
{
  const ledger = new LedgerInvariant();
  // Reserves chosen large enough that the protocol-fee crystallization
  // doesn't round to zero on a small handful of swaps. S = isqrt(R_A·R_B)
  // must be large relative to (fee_bps × root_k_growth / denominator) for
  // newShares > 0; 100M:200M is comfortably in range.
  const init = lpInitShares(100_000_000n, 200_000_000n, MINIMUM_LIQUIDITY);
  // Use a fake founder address for the protocol-fee recipient (non-zero).
  const fakeFounderAddr = new Uint8Array(33); fakeFounderAddr[0] = 0x02;
  for (let i = 1; i < 33; i++) fakeFounderAddr[i] = i;
  let pool = {
    pool_id: new Uint8Array(32),
    reserve_A: 100_000_000n,
    reserve_B: 200_000_000n,
    fee_bps: 30,
    lp_total_shares: init.total_shares,
    protocol_fee_accrued: 0n,
    protocol_fee_bps: 100,                  // 1% of LP-fee growth
    protocol_fee_address: fakeFounderAddr,
    k_last: 100_000_000n * 200_000_000n,
  };
  ledger.mint(init.founder_shares, 'POOL_INIT founder (fee pool)');
  ledger.mint(init.locked_shares,  'POOL_INIT MINIMUM_LIQUIDITY (fee pool)');
  test('B1: POOL_INIT supply invariant holds', () => ledger.check(pool, 'B1 POOL_INIT'));

  // SWAP × 5 with 1M-scale Δ — k grows. protocol_fee_accrued stays 0
  // until next LP event.
  for (let i = 0; i < 5; i++) {
    const before = pool.protocol_fee_accrued;
    pool = applySwap(pool, i % 2, 1_000_000n);
    if (pool.protocol_fee_accrued !== before) {
      throw new Error(`B2: SWAP must NOT touch protocol_fee_accrued (i=${i})`);
    }
  }
  test('B2: SWAPs grow k without touching accrued/total', () => ledger.check(pool, 'B2 SWAP series'));
  test('B2: k grew above k_last', () => pool.reserve_A * pool.reserve_B > pool.k_last);

  // LP_ADD — triggers crystallization. accrued += newShares, total += newShares.
  const beforeAccrued = pool.protocol_fee_accrued;
  const expectedCrystallize = computeProtocolShares({
    S_pre: pool.lp_total_shares,
    k_pre: pool.k_last,
    k_now: pool.reserve_A * pool.reserve_B,
    protocol_fee_bps: pool.protocol_fee_bps,
  });
  if (expectedCrystallize <= 0n) {
    throw new Error('B3: expected protocol-fee crystallization shares > 0');
  }
  pool = crystallizeProtocolFee(pool);
  if (pool.protocol_fee_accrued !== beforeAccrued + expectedCrystallize) {
    throw new Error(`B3: accrued post-crystallize wrong (expected ${beforeAccrued + expectedCrystallize}, got ${pool.protocol_fee_accrued})`);
  }
  // The crystallized shares ARE in lp_total_shares but NOT yet in the
  // ledger (no UTXO emitted yet). They show up as "accrued — virtual".
  // Invariant must therefore include accrued subtraction.
  test('B3: crystallization preserves lp_total_shares − accrued invariant', () => ledger.check(pool, 'B3 crystallize'));

  // Apply the actual LP_ADD on top of the crystallized state.
  const lpAddDeltaA = 1_000_000n;
  const lpAddDeltaB = (lpAddDeltaA * pool.reserve_B) / pool.reserve_A;  // at-ratio
  const lpAddShares0 = lpAddShares(lpAddDeltaA, lpAddDeltaB, pool.reserve_A, pool.reserve_B, pool.lp_total_shares);
  pool = {
    ...pool,
    reserve_A: pool.reserve_A + lpAddDeltaA,
    reserve_B: pool.reserve_B + lpAddDeltaB,
    lp_total_shares: pool.lp_total_shares + lpAddShares0,
    k_last: (pool.reserve_A + lpAddDeltaA) * (pool.reserve_B + lpAddDeltaB),
  };
  ledger.mint(lpAddShares0, 'LP_ADD post-crystallize');
  test('B4: LP_ADD supply invariant holds', () => ledger.check(pool, 'B4 LP_ADD'));

  // FEE_CLAIM — founder mints claim_amount of lp_asset_id. The shares
  // were already in lp_total_shares from crystallization; this just
  // emits the UTXO and resets accrued. lp_total_shares is unchanged.
  const claimAmount = pool.protocol_fee_accrued;
  const lpTotalBeforeClaim = pool.lp_total_shares;
  pool = {
    ...pool,
    protocol_fee_accrued: 0n,
    // reserves, k_last, lp_total_shares unchanged
  };
  ledger.mint(claimAmount, 'FEE_CLAIM');
  test('B5: FEE_CLAIM emits UTXO without changing lp_total_shares',
    () => pool.lp_total_shares === lpTotalBeforeClaim);
  test('B5: FEE_CLAIM supply invariant holds (accrued resets to 0)',
    () => ledger.check(pool, 'B5 FEE_CLAIM'));

  // LP_REMOVE — full burn of the LP_ADD position from step B4.
  const burnAmount = lpAddShares0;
  pool = crystallizeProtocolFee(pool);              // crystallize first
  const out = lpRemoveOutputs(burnAmount, pool.reserve_A, pool.reserve_B, pool.lp_total_shares);
  pool = {
    ...pool,
    reserve_A: pool.reserve_A - out.delta_a,
    reserve_B: pool.reserve_B - out.delta_b,
    lp_total_shares: pool.lp_total_shares - burnAmount,
    k_last: (pool.reserve_A - out.delta_a) * (pool.reserve_B - out.delta_b),
  };
  ledger.burn(burnAmount, 'LP_REMOVE full');
  test('B6: LP_REMOVE supply invariant holds', () => ledger.check(pool, 'B6 LP_REMOVE'));
}

// =========================================================================
// Scenario C — adversarial / boundary cases the invariant catches
// =========================================================================
console.log('\nScenario C: boundary cases the invariant catches');
{
  // (a) Direct mutation of lp_total_shares without a ledger event MUST
  //     break the invariant (forged supply). This is the inflation
  //     attack the invariant exists to detect.
  const ledger = new LedgerInvariant();
  const init = lpInitShares(1_000n, 2_000n, MINIMUM_LIQUIDITY);
  let pool = {
    pool_id: new Uint8Array(32),
    reserve_A: 1_000n, reserve_B: 2_000n, fee_bps: 30,
    lp_total_shares: init.total_shares,
    protocol_fee_accrued: 0n, protocol_fee_bps: 0,
    protocol_fee_address: new Uint8Array(33),
    k_last: 1_000n * 2_000n,
  };
  ledger.mint(init.founder_shares, 'POOL_INIT founder');
  ledger.mint(init.locked_shares,  'POOL_INIT locked');
  test('Ca: clean POOL_INIT invariant holds', () => ledger.check(pool, 'Ca clean'));

  // Tamper: forge an extra 100 shares onto lp_total_shares without a
  // ledger event (this is what an inflation attack would look like).
  pool.lp_total_shares = pool.lp_total_shares + 100n;
  test('Ca: inflation by direct mutation IS detected', () => {
    try { ledger.check(pool, 'Ca tampered'); return false; }   // should throw
    catch (e) { return /invariant violated/.test(e.message); }
  });

  // (b) Burning more than the ledger has minted MUST also break the
  //     invariant (it'd mean the trader spent UTXOs that don't exist).
  pool.lp_total_shares = pool.lp_total_shares - 100n;          // restore
  test('Ca: invariant restored after un-tampering', () => ledger.check(pool, 'Ca restored'));

  ledger.burn(pool.lp_total_shares + 1n, 'over-burn');
  test('Cb: over-burn IS detected', () => {
    try { ledger.check(pool, 'Cb over-burn'); return false; }   // should throw
    catch (e) { return /invariant violated/.test(e.message); }
  });
}

console.log(`\n${pass}/${pass + fail} LP-supply invariant checks passed`);
if (fail > 0) process.exit(1);
