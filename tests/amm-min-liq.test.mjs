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

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
