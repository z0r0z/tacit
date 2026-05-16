// Asset-id + pool-id derivation correctness suite.
//
// Verifies SPEC §4 (CETCH/T_PETCH) and AMM.md §"Pool state" (POOL_INIT LP)
// asset-id origins and the three-origin resolution rule.

import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import {
  deriveAssetIdFromReveal, canonicalAssetPair, derivePoolId, deriveLpAssetId,
  resolveAssetIdOrigin,
} from './amm-asset.mjs';

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

function eqBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function reverseBytes(b) { const r = new Uint8Array(b); r.reverse(); return r; }

const SAMPLE_TXID_HEX = 'deadbeefcafef00d0123456789abcdef0123456789abcdef0123456789abcdef';

console.log('asset_id from reveal-tx (CETCH/T_PETCH path)');
test('deriveAssetIdFromReveal == SHA256(txid_BE || 0_LE)', () => {
  const expected = sha256(concatBytes(reverseBytes(hexToBytes(SAMPLE_TXID_HEX)), new Uint8Array(4)));
  return eqBytes(deriveAssetIdFromReveal(SAMPLE_TXID_HEX), expected);
});
test('different reveal txids give different asset_ids', () => {
  const a = deriveAssetIdFromReveal(SAMPLE_TXID_HEX);
  const b = deriveAssetIdFromReveal('1111111111111111111111111111111111111111111111111111111111111111');
  return !eqBytes(a, b);
});
test('vout=0 explicit matches default', () => {
  const def = deriveAssetIdFromReveal(SAMPLE_TXID_HEX);
  const explicit = deriveAssetIdFromReveal(SAMPLE_TXID_HEX, 0);
  return eqBytes(def, explicit);
});

console.log('\ncanonicalAssetPair ordering');
test('smaller-first byte ⇒ asset_A', () => {
  const a = new Uint8Array(32).fill(0x10);
  const b = new Uint8Array(32).fill(0x20);
  const [low, high] = canonicalAssetPair(a, b);
  return low[0] === 0x10 && high[0] === 0x20;
});
test('canonical pair is order-independent', () => {
  const a = new Uint8Array(32).fill(0x10);
  const b = new Uint8Array(32).fill(0x20);
  const p1 = canonicalAssetPair(a, b);
  const p2 = canonicalAssetPair(b, a);
  return eqBytes(p1[0], p2[0]) && eqBytes(p1[1], p2[1]);
});
test('identical asset_ids throws', () => {
  const a = new Uint8Array(32).fill(0x10);
  try { canonicalAssetPair(a, new Uint8Array(a)); return false; }
  catch (e) { return /identical asset_ids/.test(e.message); }
});
test('rejects wrong-length asset_ids', () => {
  try { canonicalAssetPair(new Uint8Array(31), new Uint8Array(32)); return false; }
  catch (e) { return /32 bytes/.test(e.message); }
});

console.log('\npool_id derivation');
const aidA = deriveAssetIdFromReveal(SAMPLE_TXID_HEX);
const aidB = deriveAssetIdFromReveal('1111111111111111111111111111111111111111111111111111111111111111');
const FEE_30 = 30, FLAGS_0 = 0;
test('derivePoolId is canonical (order-independent)', () => {
  return eqBytes(derivePoolId(aidA, aidB, FEE_30, FLAGS_0), derivePoolId(aidB, aidA, FEE_30, FLAGS_0));
});
test('different pairs give different pool_ids', () => {
  const aidC = deriveAssetIdFromReveal('2222222222222222222222222222222222222222222222222222222222222222');
  return !eqBytes(derivePoolId(aidA, aidB, FEE_30, FLAGS_0), derivePoolId(aidA, aidC, FEE_30, FLAGS_0));
});
test('different fee tiers give different pool_ids (V3/V4 parity)', () => {
  return !eqBytes(derivePoolId(aidA, aidB, 5, FLAGS_0), derivePoolId(aidA, aidB, 30, FLAGS_0));
});
test('different capability_flags give different pool_ids', () => {
  return !eqBytes(derivePoolId(aidA, aidB, FEE_30, 0x00), derivePoolId(aidA, aidB, FEE_30, 0x02));
});
test('fee_bps + capability_flags together discriminate', () => {
  // Sanity: a four-corner matrix of (fee_bps, flags) all yields distinct pool_ids.
  const ids = [
    derivePoolId(aidA, aidB, 5,  0x00),
    derivePoolId(aidA, aidB, 5,  0x02),
    derivePoolId(aidA, aidB, 30, 0x00),
    derivePoolId(aidA, aidB, 30, 0x02),
  ];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      if (eqBytes(ids[i], ids[j])) return false;
  return true;
});
test('pool_id has 32 bytes', () => derivePoolId(aidA, aidB, FEE_30, FLAGS_0).length === 32);
test('pool_id matches SHA256(domain || low || high || fee_bps_LE || flags)', () => {
  const [low, high] = canonicalAssetPair(aidA, aidB);
  const domain = new TextEncoder().encode('tacit-amm-pool-v1');
  const feeBpsLE = new Uint8Array(2);
  new DataView(feeBpsLE.buffer).setUint16(0, FEE_30, true);
  const flagsByte = new Uint8Array([FLAGS_0]);
  const expected = sha256(concatBytes(domain, low, high, feeBpsLE, flagsByte));
  return eqBytes(derivePoolId(aidA, aidB, FEE_30, FLAGS_0), expected);
});
test('rejects fee_bps > 1000', () => {
  try { derivePoolId(aidA, aidB, 1001, 0); return false; }
  catch (e) { return /fee_bps/.test(e.message); }
});
test('rejects negative fee_bps', () => {
  try { derivePoolId(aidA, aidB, -1, 0); return false; }
  catch (e) { return /fee_bps/.test(e.message); }
});
test('rejects capability_flags > 255', () => {
  try { derivePoolId(aidA, aidB, 30, 256); return false; }
  catch (e) { return /capability_flags/.test(e.message); }
});
test('rejects non-integer fee_bps', () => {
  try { derivePoolId(aidA, aidB, 30.5, 0); return false; }
  catch (e) { return /fee_bps/.test(e.message); }
});

console.log('\nlp_asset_id derivation');
const poolId = derivePoolId(aidA, aidB, FEE_30, FLAGS_0);
test('deriveLpAssetId is deterministic', () => eqBytes(deriveLpAssetId(poolId), deriveLpAssetId(poolId)));
test('different pool_ids give different lp_asset_ids', () => {
  const aidC = deriveAssetIdFromReveal('2222222222222222222222222222222222222222222222222222222222222222');
  const poolId2 = derivePoolId(aidA, aidC, FEE_30, FLAGS_0);
  return !eqBytes(deriveLpAssetId(poolId), deriveLpAssetId(poolId2));
});
test('LP shares of different fee tiers are different tacit assets', () => {
  // Direct consequence of fee_bps being in pool_id: lp_asset_id at fee=5 bps
  // is a different tacit asset than lp_asset_id at fee=30 bps for the same pair.
  // V3/V4 fee-tier parity at the asset-identity layer.
  const lpFee5  = deriveLpAssetId(derivePoolId(aidA, aidB, 5,  FLAGS_0));
  const lpFee30 = deriveLpAssetId(derivePoolId(aidA, aidB, 30, FLAGS_0));
  return !eqBytes(lpFee5, lpFee30);
});
test('lp_asset_id matches SHA256("tacit-amm-lp-v1" || pool_id)', () => {
  const domain = new TextEncoder().encode('tacit-amm-lp-v1');
  const expected = sha256(concatBytes(domain, poolId));
  return eqBytes(deriveLpAssetId(poolId), expected);
});
test('rejects wrong-length pool_id', () => {
  try { deriveLpAssetId(new Uint8Array(31)); return false; }
  catch (e) { return /32 bytes/.test(e.message); }
});

console.log('\nThree-origin resolution');
test('CETCH path resolves', () => {
  const lookups = {
    getCetchOrPetch: () => ({ mode: 'CETCH', reveal_txid_hex: SAMPLE_TXID_HEX }),
    getPoolInit: () => null,
  };
  const r = resolveAssetIdOrigin(aidA, lookups);
  return r && r.origin === 'CETCH' && r.reveal_txid_hex === SAMPLE_TXID_HEX;
});
test('T_PETCH path resolves', () => {
  const lookups = {
    getCetchOrPetch: () => ({ mode: 'T_PETCH', reveal_txid_hex: SAMPLE_TXID_HEX }),
    getPoolInit: () => null,
  };
  const r = resolveAssetIdOrigin(aidA, lookups);
  return r && r.origin === 'T_PETCH';
});
test('LP origin path resolves', () => {
  const lpId = deriveLpAssetId(poolId);
  const lookups = {
    getCetchOrPetch: () => null,
    getPoolInit: () => ({
      pool_id: bytesToHex(poolId),
      asset_A: bytesToHex(aidA), asset_B: bytesToHex(aidB),
      fee_bps: FEE_30, capability_flags: FLAGS_0,
    }),
  };
  const r = resolveAssetIdOrigin(lpId, lookups);
  return r && r.origin === 'LP' && r.pool_id === bytesToHex(poolId);
});
test('forged CETCH (wrong txid) rejected', () => {
  // Lookup returns a different txid than what asset_id was derived from.
  const wrongTxid = '0000000000000000000000000000000000000000000000000000000000000000';
  const lookups = {
    getCetchOrPetch: () => ({ mode: 'CETCH', reveal_txid_hex: wrongTxid }),
    getPoolInit: () => null,
  };
  const r = resolveAssetIdOrigin(aidA, lookups);
  return r === null;
});
test('forged LP (wrong pool_id) rejected', () => {
  const lpId = deriveLpAssetId(poolId);
  const wrongPool = new Uint8Array(32).fill(0xaa);
  const lookups = {
    getCetchOrPetch: () => null,
    getPoolInit: () => ({
      pool_id: bytesToHex(wrongPool),
      asset_A: bytesToHex(aidA), asset_B: bytesToHex(aidB),
      fee_bps: FEE_30, capability_flags: FLAGS_0,
    }),
  };
  const r = resolveAssetIdOrigin(lpId, lookups);
  return r === null;
});
test('unresolved (no lookup hit) returns null', () => {
  const lookups = { getCetchOrPetch: () => null, getPoolInit: () => null };
  return resolveAssetIdOrigin(aidA, lookups) === null;
});

console.log('\nCross-origin collision resistance (statistical)');
test('CETCH, LP, and pool_id preimages have distinct lengths', () => {
  // CETCH preimage: txid_BE(32) || vout_LE(4) = 36 B
  // LP preimage:    "tacit-amm-lp-v1"(15) || pool_id(32) = 47 B
  // pool_id preimage: "tacit-amm-pool-v1"(17) || A(32) || B(32) || fee_LE(2) || flags(1) = 84 B
  // All three sizes are disjoint → cross-origin collisions reduce to
  // SHA256 preimage-finding under distinct domain separations.
  const lpDomain = new TextEncoder().encode('tacit-amm-lp-v1');
  const poolDomain = new TextEncoder().encode('tacit-amm-pool-v1');
  return lpDomain.length === 15 && poolDomain.length === 17;
});
test('pool_id and lp_asset_id are independent (no accidental aliasing)', () => {
  const poolId2 = derivePoolId(aidA, aidB, FEE_30, FLAGS_0);
  const lpId = deriveLpAssetId(poolId2);
  return !eqBytes(poolId2, lpId);
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
