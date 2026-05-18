// Seed-recovery pinning tests for cBTC.tac atomic envelopes.
//
// Proves the production invariant: a wallet holding only the depositor's
// priv key can re-derive all output blindings for T_CBTC_TAC_DEPOSIT_ATOMIC
// and T_CBTC_TAC_WITHDRAW_ATOMIC outputs from on-chain witnesses alone.
//
// Tested derivations (SPEC §5.48.9, §5.49.8):
//
//   atomic deposit vout[0] (LP-share):
//     r = HMAC(priv, "tacit-amm-receipt-secp-v1"
//                    || pool_id
//                    || cbtc_zk_input_outpoint
//                    || lp_asset_id) mod n_secp
//
//   atomic deposit vout[1] (cBTC.tac mint):
//     r = HMAC(priv, "tacit-cbtc-tac-atomic-mint-v1"
//                    || target_leaf_hash
//                    || cbtc_zk_input_outpoint) mod n_secp
//
//   atomic withdraw vout[1] / vout[2] (LP_REMOVE legs):
//     r = HMAC(priv, "tacit-amm-receipt-secp-v1"
//                    || pool_id
//                    || lp_share_input_outpoint
//                    || asset_id_canonical) mod n_secp
//
// No network access. No localStorage. Pure-math pinning + Pedersen open
// against synthesized commits.

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
if (!globalThis.crypto) try { globalThis.crypto = dom.window.crypto; } catch {}
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

// Dynamic imports — dapp/tacit.js touches document at top level, so the
// JSDOM globals above must be in place before the module evaluates.
const { hmac, sha256, hexToBytes, concatBytes, bytesToHex } = await import('../dapp/vendor/tacit-deps.min.js');
const ammAssetMod = await import('../dapp/amm-asset.js');
const ammReceiptMod = await import('../dapp/amm-receipt.js');
const { pedersenCommit, SECP_N, modN } = await import('../dapp/bulletproofs.js');
const { deriveCbtcTacAtomicMintBlinding } = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = typeof actual === 'bigint' ? actual.toString() : String(actual);
  const e = typeof expected === 'bigint' ? expected.toString() : String(expected);
  if (a === e) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n        expected: ${e}\n        actual:   ${a}`); }
}
function ok(cond, label) { if (cond) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}`); } }

const PRIV = hexToBytes('11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff');
const POOL_ID = hexToBytes('9b5b14feb235ce1aeb1c2684e5f3ba368d16743fdb9cdc1b2add7578cc955646');
const TARGET_LEAF = hexToBytes('2bf5365846217c398e0e729a5f411f41c3eedfdf5c04db8734dd3abb5523a866');
const CBTCZK_TX = '81d0ca3c21d1bbcc11ddee22ff334455667788990011223344556677889900ff';
const CBTCZK_VOUT = 1;
const LP_SHARE_AMOUNT = 9_000_000_000n;
const MINT_AMOUNT = 500_000n;

const cbtcZkInputOutpoint = ammReceiptMod.canonicalOutpoint(CBTCZK_TX, CBTCZK_VOUT);

console.log('cBTC.tac atomic envelope seed-recovery pinning\n');

// ============ Test 1: LP-share derivation ============
{
  const lpAssetId = ammAssetMod.deriveLpAssetId(POOL_ID);
  const { r_secp } = ammReceiptMod.deriveLpAddShareBlinding({
    recipientPrivkey: PRIV, poolId: POOL_ID,
    lpInputAOutpoint: cbtcZkInputOutpoint,
    lpAssetId,
  });
  ok(r_secp > 0n && r_secp < SECP_N, 'LP-share blinding in (0, n)');
  // Independent re-derivation (simulates the scanHoldings recovery path).
  const expected = hmac(sha256, PRIV, concatBytes(
    new TextEncoder().encode('tacit-amm-receipt-secp-v1'),
    POOL_ID, cbtcZkInputOutpoint, lpAssetId,
  ));
  const r_expected = modN(BigInt('0x' + bytesToHex(expected)));
  eq(r_secp, r_expected, 'LP-share blinding matches HMAC re-derivation');

  const commit = pedersenCommit(LP_SHARE_AMOUNT, r_secp).toRawBytes(true);
  const commitReplay = pedersenCommit(LP_SHARE_AMOUNT, r_expected).toRawBytes(true);
  ok(bytesToHex(commit) === bytesToHex(commitReplay), 'LP-share Pedersen commit opens against recovered blinding');
}

// ============ Test 2: cBTC.tac mint derivation ============
{
  const r = deriveCbtcTacAtomicMintBlinding({
    privkey: PRIV,
    targetLeafHash: TARGET_LEAF,
    anchorOutpoint: cbtcZkInputOutpoint,
  });
  ok(r > 0n && r < SECP_N, 'mint blinding in (0, n)');
  const expected = hmac(sha256, PRIV, concatBytes(
    new TextEncoder().encode('tacit-cbtc-tac-atomic-mint-v1'),
    TARGET_LEAF, cbtcZkInputOutpoint,
  ));
  const r_expected = modN(BigInt('0x' + bytesToHex(expected)));
  eq(r, r_expected, 'mint blinding matches HMAC re-derivation');
  const commit = pedersenCommit(MINT_AMOUNT, r).toRawBytes(true);
  const commitReplay = pedersenCommit(MINT_AMOUNT, r_expected).toRawBytes(true);
  ok(bytesToHex(commit) === bytesToHex(commitReplay), 'mint Pedersen commit opens against recovered blinding');
}

// ============ Test 3: mint blinding domain separation from LP-share ============
{
  const lpAssetId = ammAssetMod.deriveLpAssetId(POOL_ID);
  const { r_secp: rLp } = ammReceiptMod.deriveLpAddShareBlinding({
    recipientPrivkey: PRIV, poolId: POOL_ID,
    lpInputAOutpoint: cbtcZkInputOutpoint, lpAssetId,
  });
  const rMint = deriveCbtcTacAtomicMintBlinding({
    privkey: PRIV, targetLeafHash: TARGET_LEAF, anchorOutpoint: cbtcZkInputOutpoint,
  });
  ok(rLp !== rMint, 'LP-share blinding distinct from mint blinding (domain-tag separation)');
}

// ============ Test 4: anchor uniqueness — different cbtcZk outpoint yields distinct blinding ============
{
  const otherOutpoint = ammReceiptMod.canonicalOutpoint(
    'ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00', 0,
  );
  const r1 = deriveCbtcTacAtomicMintBlinding({
    privkey: PRIV, targetLeafHash: TARGET_LEAF, anchorOutpoint: cbtcZkInputOutpoint,
  });
  const r2 = deriveCbtcTacAtomicMintBlinding({
    privkey: PRIV, targetLeafHash: TARGET_LEAF, anchorOutpoint: otherOutpoint,
  });
  ok(r1 !== r2, 'different anchor outpoint → different mint blinding');
}

// ============ Test 5: priv-key sensitivity ============
{
  const otherPriv = hexToBytes('aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900');
  const r1 = deriveCbtcTacAtomicMintBlinding({
    privkey: PRIV, targetLeafHash: TARGET_LEAF, anchorOutpoint: cbtcZkInputOutpoint,
  });
  const r2 = deriveCbtcTacAtomicMintBlinding({
    privkey: otherPriv, targetLeafHash: TARGET_LEAF, anchorOutpoint: cbtcZkInputOutpoint,
  });
  ok(r1 !== r2, 'different priv key → different mint blinding');
}

// ============ Test 6: WITHDRAW_ATOMIC LP_REMOVE legs ============
{
  const LP_SHARE_IN_TX = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
  const lpShareInputOutpoint = ammReceiptMod.canonicalOutpoint(LP_SHARE_IN_TX, 0);
  const CBTC_ZK_SIDE = hexToBytes('bc832dbb8d34bcfdae893c5de962dd39e01cdded47ee42734d22a54b2407fa30');
  const TAC_SIDE     = hexToBytes('37fc8e091a1d7aa79ddcb6ac6c7d4a71633a316b779cede04d15b736cf38e1b3');
  const [canonA, canonB] = ammAssetMod.canonicalAssetPair(bytesToHex(CBTC_ZK_SIDE), bytesToHex(TAC_SIDE));

  const { legA, legB } = ammReceiptMod.deriveLpRemoveBlindings({
    recipientPrivkey: PRIV, poolId: POOL_ID,
    lpShareInputOutpoint,
    assetIdA: canonA, assetIdB: canonB,
  });
  ok(legA.r_secp > 0n && legA.r_secp < SECP_N, 'legA blinding in (0, n)');
  ok(legB.r_secp > 0n && legB.r_secp < SECP_N, 'legB blinding in (0, n)');
  ok(legA.r_secp !== legB.r_secp, 'legA blinding distinct from legB blinding (different canonical asset_id)');

  // scanHoldings recovery path: takes assetIdHex from the scan loop, looks
  // up pool from position record, derives via deriveReceiptBlinding.
  const expectedA = ammReceiptMod.deriveReceiptBlinding({
    recipientPrivkey: PRIV, poolId: POOL_ID,
    anchorOutpoint: lpShareInputOutpoint, assetId: canonA,
  });
  eq(legA.r_secp, expectedA.r_secp, 'legA matches scanHoldings re-derivation');
}

console.log(`\n${pass + fail}/${pass + fail} ran, ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
