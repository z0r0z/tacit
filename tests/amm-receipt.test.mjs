// Receipt-blinding derivation tests.
//
// Asserts:
//   • Deterministic — same inputs ⇒ same blindings
//   • Domain separation — secp/BJJ seeds differ
//   • Anchor sensitivity — different outpoints give different blindings
//   • Asset-id discrimination — LP_REMOVE two-leg case (same anchor, different asset_id)
//   • Privkey separation — different recipients give different blindings
//   • Range — r_secp < n_secp, r_BJJ < n_BJJ

import {
  canonicalOutpoint, deriveReceiptBlinding,
  deriveSwapReceiptBlinding, deriveLpAddShareBlinding, deriveLpRemoveBlindings,
} from './amm-receipt.mjs';
import { SECP_N } from './bulletproofs.mjs';
import { N_BJJ } from './amm-bjj.mjs';

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

const SK = new Uint8Array(32).fill(0x42);
const POOL_ID = new Uint8Array(32).fill(0x77);
const ASSET_A = new Uint8Array(32).fill(0xaa);
const ASSET_B = new Uint8Array(32).fill(0xbb);
const TXID = 'deadbeefcafef00d0123456789abcdef0123456789abcdef0123456789abcdef';

console.log('Canonical outpoint encoding');
test('canonicalOutpoint is 36 bytes', () => canonicalOutpoint(TXID, 0).length === 36);
test('canonicalOutpoint(vout=0) ends with 4 zero bytes', () => {
  const op = canonicalOutpoint(TXID, 0);
  return op[32] === 0 && op[33] === 0 && op[34] === 0 && op[35] === 0;
});
test('canonicalOutpoint(vout=1) ends with 01 00 00 00', () => {
  const op = canonicalOutpoint(TXID, 1);
  return op[32] === 1 && op[33] === 0 && op[34] === 0 && op[35] === 0;
});
test('canonicalOutpoint reverses txid hex (LE-on-wire convention)', () => {
  const op = canonicalOutpoint(TXID, 0);
  // First byte of canonical outpoint is LAST byte of txid hex (=0xef).
  return op[0] === 0xef;
});

console.log('\nDeterministic derivation');
const out0 = canonicalOutpoint(TXID, 0);
const b0 = deriveReceiptBlinding({ recipientPrivkey: SK, poolId: POOL_ID, anchorOutpoint: out0, assetId: ASSET_A });
const b1 = deriveReceiptBlinding({ recipientPrivkey: SK, poolId: POOL_ID, anchorOutpoint: out0, assetId: ASSET_A });
test('same inputs ⇒ same r_secp', () => b0.r_secp === b1.r_secp);
test('same inputs ⇒ same r_BJJ',  () => b0.r_BJJ  === b1.r_BJJ);

console.log('\nDomain separation');
test('secp seed and BJJ seed are different', () => b0.r_secp !== b0.r_BJJ);

console.log('\nAnchor sensitivity');
const out1 = canonicalOutpoint(TXID, 1);
const b_anchor1 = deriveReceiptBlinding({ recipientPrivkey: SK, poolId: POOL_ID, anchorOutpoint: out1, assetId: ASSET_A });
test('different vout ⇒ different blindings', () => {
  return b0.r_secp !== b_anchor1.r_secp && b0.r_BJJ !== b_anchor1.r_BJJ;
});
const otherTxid = '1111111111111111111111111111111111111111111111111111111111111111';
const out_other = canonicalOutpoint(otherTxid, 0);
const b_anchor2 = deriveReceiptBlinding({ recipientPrivkey: SK, poolId: POOL_ID, anchorOutpoint: out_other, assetId: ASSET_A });
test('different txid ⇒ different blindings', () => {
  return b0.r_secp !== b_anchor2.r_secp && b0.r_BJJ !== b_anchor2.r_BJJ;
});

console.log('\nAsset-id discrimination (LP_REMOVE two-leg case)');
const b_assetB = deriveReceiptBlinding({ recipientPrivkey: SK, poolId: POOL_ID, anchorOutpoint: out0, assetId: ASSET_B });
test('same anchor, different asset_id ⇒ different blindings', () => {
  return b0.r_secp !== b_assetB.r_secp && b0.r_BJJ !== b_assetB.r_BJJ;
});

console.log('\nPrivkey separation');
const SK2 = new Uint8Array(32).fill(0x99);
const b_otherSk = deriveReceiptBlinding({ recipientPrivkey: SK2, poolId: POOL_ID, anchorOutpoint: out0, assetId: ASSET_A });
test('different privkey ⇒ different blindings', () => {
  return b0.r_secp !== b_otherSk.r_secp && b0.r_BJJ !== b_otherSk.r_BJJ;
});

console.log('\nRange enforcement');
test('r_secp < n_secp', () => b0.r_secp < SECP_N);
test('r_BJJ < n_BJJ', () => b0.r_BJJ < N_BJJ);
test('r_secp != 0 (statistically — collision probability 2^-256)', () => b0.r_secp !== 0n);
test('r_BJJ != 0', () => b0.r_BJJ !== 0n);

console.log('\nInput validation');
test('rejects wrong-length privkey', () => {
  try {
    deriveReceiptBlinding({ recipientPrivkey: new Uint8Array(31), poolId: POOL_ID, anchorOutpoint: out0, assetId: ASSET_A });
    return false;
  } catch (e) { return /32 bytes/.test(e.message); }
});
test('rejects wrong-length anchor outpoint', () => {
  try {
    deriveReceiptBlinding({ recipientPrivkey: SK, poolId: POOL_ID, anchorOutpoint: new Uint8Array(35), assetId: ASSET_A });
    return false;
  } catch (e) { return /36 bytes/.test(e.message); }
});

console.log('\nHelper wrappers');
test('deriveSwapReceiptBlinding routes correctly', () => {
  const s = deriveSwapReceiptBlinding({
    recipientPrivkey: SK,
    poolId: POOL_ID,
    traderInputOutpoint: out0,
    outputAssetId: ASSET_A,
  });
  return s.r_secp === b0.r_secp && s.r_BJJ === b0.r_BJJ;
});
test('deriveLpAddShareBlinding uses lp_asset_id', () => {
  const s = deriveLpAddShareBlinding({
    recipientPrivkey: SK,
    poolId: POOL_ID,
    lpInputAOutpoint: out0,
    lpAssetId: ASSET_A,
  });
  return s.r_secp === b0.r_secp && s.r_BJJ === b0.r_BJJ;
});
test('deriveLpRemoveBlindings produces TWO distinct legs', () => {
  const { legA, legB } = deriveLpRemoveBlindings({
    recipientPrivkey: SK,
    poolId: POOL_ID,
    lpShareInputOutpoint: out0,
    assetIdA: ASSET_A,
    assetIdB: ASSET_B,
  });
  return legA.r_secp !== legB.r_secp && legA.r_BJJ !== legB.r_BJJ;
});
test('deriveLpRemoveBlindings legs disambiguate ONLY by asset_id', () => {
  const { legA } = deriveLpRemoveBlindings({
    recipientPrivkey: SK,
    poolId: POOL_ID,
    lpShareInputOutpoint: out0,
    assetIdA: ASSET_A,
    assetIdB: ASSET_B,
  });
  // legA should match the direct derivation against asset A.
  const direct = deriveReceiptBlinding({ recipientPrivkey: SK, poolId: POOL_ID, anchorOutpoint: out0, assetId: ASSET_A });
  return legA.r_secp === direct.r_secp && legA.r_BJJ === direct.r_BJJ;
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
