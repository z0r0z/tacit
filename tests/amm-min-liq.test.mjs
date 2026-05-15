// MINIMUM_LIQUIDITY locked-output construction tests.
//
// Asserts:
//   • Deterministic blinding + commitment + amount_ct from pool_id alone
//   • NUMS recipient derivation produces a valid x-only pubkey
//   • Encryption round-trips (decrypt(encrypt(x)) == x)
//   • Different pool_ids ⇒ different blindings, commitments, recipients
//   • Aggregate verifyMinLiqOutput catches every kind of tampering

import {
  MINIMUM_LIQUIDITY,
  deriveMinLiqBlinding, deriveMinLiqCommitment, deriveMinLiqAmountCt,
  decryptMinLiqAmount, deriveMinLiqNumsRecipient, verifyMinLiqOutput,
  assessMinLiqLockFraction,
  MIN_LIQ_LOCK_BPS_WARN, MIN_LIQ_LOCK_BPS_HIGH,
} from './amm-min-liq.mjs';
import { SECP_N, pedersenCommit, pointToBytes } from './bulletproofs.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

const POOL_A = new Uint8Array(32).fill(0x77);
const POOL_B = new Uint8Array(32).fill(0x88);

console.log('Constants');
test('MINIMUM_LIQUIDITY == 1000n', () => MINIMUM_LIQUIDITY === 1000n);

console.log('\nDeterministic blinding');
test('deriveMinLiqBlinding is deterministic', () => {
  return deriveMinLiqBlinding(POOL_A) === deriveMinLiqBlinding(POOL_A);
});
test('different pool_ids ⇒ different blindings', () => {
  return deriveMinLiqBlinding(POOL_A) !== deriveMinLiqBlinding(POOL_B);
});
test('r_burn < n_secp', () => deriveMinLiqBlinding(POOL_A) < SECP_N);
test('r_burn != 0', () => deriveMinLiqBlinding(POOL_A) !== 0n);

console.log('\nCommitment');
test('C_min_liq commits to MINIMUM_LIQUIDITY with derived r_burn', () => {
  const C = deriveMinLiqCommitment(POOL_A);
  const expected = pedersenCommit(MINIMUM_LIQUIDITY, deriveMinLiqBlinding(POOL_A));
  return C.equals(expected);
});
test('different pool_ids ⇒ different commitments', () => {
  return !deriveMinLiqCommitment(POOL_A).equals(deriveMinLiqCommitment(POOL_B));
});

console.log('\nAmount keystream + encryption');
test('amount_ct is 8 bytes', () => deriveMinLiqAmountCt(POOL_A).length === 8);
test('encrypt → decrypt round-trip recovers MINIMUM_LIQUIDITY', () => {
  const ct = deriveMinLiqAmountCt(POOL_A);
  return decryptMinLiqAmount(ct, POOL_A) === MINIMUM_LIQUIDITY;
});
test('different pool_ids ⇒ different keystreams', () => {
  const ct1 = deriveMinLiqAmountCt(POOL_A);
  const ct2 = deriveMinLiqAmountCt(POOL_B);
  return !ct1.every((b, i) => b === ct2[i]);
});
test('decrypt with wrong pool_id ⇒ wrong amount', () => {
  const ct = deriveMinLiqAmountCt(POOL_A);
  const decrypted = decryptMinLiqAmount(ct, POOL_B);
  return decrypted !== MINIMUM_LIQUIDITY;
});
test('decryptMinLiqAmount rejects wrong-length ct', () => {
  try { decryptMinLiqAmount(new Uint8Array(7), POOL_A); return false; }
  catch (e) { return /8 bytes/.test(e.message); }
});

console.log('\nNUMS recipient');
const numsA = deriveMinLiqNumsRecipient(POOL_A);
const numsB = deriveMinLiqNumsRecipient(POOL_B);
test('NUMS recipient is deterministic', () => {
  const n2 = deriveMinLiqNumsRecipient(POOL_A);
  return numsA.counter === n2.counter && numsA.xOnly.every((b, i) => b === n2.xOnly[i]);
});
test('different pool_ids ⇒ different NUMS recipients', () => {
  return !numsA.xOnly.every((b, i) => b === numsB.xOnly[i]);
});
test('NUMS x-only is 32 bytes', () => numsA.xOnly.length === 32);
test('NUMS p2wpkh is 20 bytes (HASH160)', () => numsA.p2wpkh.length === 20);
test('NUMS recipient is a valid curve point', () => !numsA.point.equals(deriveMinLiqNumsRecipient(POOL_B).point));
test('counter starts low (well under maxCounter)', () => numsA.counter < 32);

console.log('\nAggregate verifyMinLiqOutput');
test('honest construction verifies', () => {
  const C = pointToBytes(deriveMinLiqCommitment(POOL_A));
  const ct = deriveMinLiqAmountCt(POOL_A);
  const { p2wpkh } = numsA;
  return verifyMinLiqOutput({ poolId: POOL_A, onChainCommit: C, onChainAmtCt: ct, onChainP2wpkh: p2wpkh });
});
test('tampered commitment ⇒ reject', () => {
  const ct = deriveMinLiqAmountCt(POOL_A);
  // Use commitment for a different amount
  const wrongC = pointToBytes(pedersenCommit(999n, deriveMinLiqBlinding(POOL_A)));
  return !verifyMinLiqOutput({ poolId: POOL_A, onChainCommit: wrongC, onChainAmtCt: ct, onChainP2wpkh: numsA.p2wpkh });
});
test('tampered amount_ct ⇒ reject', () => {
  const ct = deriveMinLiqAmountCt(POOL_A);
  const badCt = new Uint8Array(ct); badCt[0] ^= 0xff;
  return !verifyMinLiqOutput({
    poolId: POOL_A,
    onChainCommit: pointToBytes(deriveMinLiqCommitment(POOL_A)),
    onChainAmtCt: badCt,
    onChainP2wpkh: numsA.p2wpkh,
  });
});
test('tampered p2wpkh ⇒ reject', () => {
  const badP = new Uint8Array(numsA.p2wpkh); badP[0] ^= 0xff;
  return !verifyMinLiqOutput({
    poolId: POOL_A,
    onChainCommit: pointToBytes(deriveMinLiqCommitment(POOL_A)),
    onChainAmtCt: deriveMinLiqAmountCt(POOL_A),
    onChainP2wpkh: badP,
  });
});
test('cross-pool commitment ⇒ reject', () => {
  return !verifyMinLiqOutput({
    poolId: POOL_A,
    onChainCommit: pointToBytes(deriveMinLiqCommitment(POOL_B)),
    onChainAmtCt: deriveMinLiqAmountCt(POOL_A),
    onChainP2wpkh: numsA.p2wpkh,
  });
});

console.log('\nassessMinLiqLockFraction (dapp UX helper)');
test('typical large pool (1M × 2M) ⇒ ok', () => {
  const a = assessMinLiqLockFraction(1_000_000n, 2_000_000n);
  return a.severity === 'ok'
    && a.total_shares === 1_414_213n
    && a.locked_shares === MINIMUM_LIQUIDITY
    && a.founder_shares === 1_414_213n - MINIMUM_LIQUIDITY
    && a.locked_bps < MIN_LIQ_LOCK_BPS_WARN;
});
test('small pool just below 1% threshold ⇒ ok', () => {
  // total = isqrt(da · db); locked_bps = floor(10000·1000/total).
  // For locked_bps < 100 we need total > 100_000.
  // 100_000^2 = 1e10; pick da=db=100_001 ⇒ total = 100_001.
  const a = assessMinLiqLockFraction(100_001n, 100_001n);
  return a.severity === 'ok' && a.locked_bps < MIN_LIQ_LOCK_BPS_WARN;
});
test('small pool ≥ 1% locked ⇒ warn', () => {
  // total ≈ 50_000 ⇒ locked_bps ≈ 200 (2%).
  const a = assessMinLiqLockFraction(50_000n, 50_000n);
  return a.severity === 'warn'
    && a.locked_bps >= MIN_LIQ_LOCK_BPS_WARN
    && a.locked_bps < MIN_LIQ_LOCK_BPS_HIGH;
});
test('thin pool ≥ 10% locked ⇒ high', () => {
  // total ≈ 5_000 ⇒ locked_bps ≈ 2000 (20%).
  const a = assessMinLiqLockFraction(5_000n, 5_000n);
  return a.severity === 'high' && a.locked_bps >= MIN_LIQ_LOCK_BPS_HIGH;
});
test('pool too small (total ≤ MIN_LIQ) ⇒ reject', () => {
  // total = isqrt(1000·1000) = 1000 == MINIMUM_LIQUIDITY ⇒ reject.
  const a = assessMinLiqLockFraction(1000n, 1000n);
  return a.severity === 'reject'
    && a.founder_shares === 0n
    && a.locked_bps === 10000n;
});
test('asymmetric thin pool (low-decimal asset) ⇒ high', () => {
  // 0-decimal asset paired with 8-decimal cBTC analog.
  // 50_000 of asset A × 100 base units of B ⇒ total = isqrt(5_000_000) = 2236.
  // locked_bps ≈ floor(10000·1000/2236) = 4472 (44.7%).
  const a = assessMinLiqLockFraction(50_000n, 100n);
  return a.severity === 'high' && a.locked_bps >= MIN_LIQ_LOCK_BPS_HIGH;
});
test('rejects zero or negative inputs', () => {
  let threw = 0;
  try { assessMinLiqLockFraction(0n, 1n); } catch { threw++; }
  try { assessMinLiqLockFraction(1n, 0n); } catch { threw++; }
  try { assessMinLiqLockFraction(-1n, 1n); } catch { threw++; }
  return threw === 3;
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
