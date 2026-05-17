// worker-amm-parity.test.mjs — cross-impl parity for the worker's ported
// AMM functions against the reference implementation in tests/.
//
// Why it exists: the worker's AMM enforcement (crystallization, MIN_LIQ
// verification, bulletproof verification, launcher-gate extraction,
// pair index, protocol-fee claim) is a fresh port. Without parity tests,
// the worker can silently diverge from the reference validator and two
// indexers see different pool state from the same chain history. This
// file pins every new worker function to the reference impl byte-for-byte.
//
// Run: `node worker-amm-parity.test.mjs`

import * as workerSecp from '../worker/node_modules/@noble/secp256k1/index.js';
import * as ref from './bulletproofs.mjs';
import * as refJcs from './amm-jcs.mjs';
import {
  crystallizeProtocolFee as refCrystallize,
  computeProtocolShares as refComputeShares,
  buildProtocolFeeClaimMsgWith as refBuildClaimMsg,
} from './amm-protocol-fee.mjs';
import { encodeProtocolFeeClaim, decodeProtocolFeeClaim } from './amm-envelope.mjs';
import {
  deriveMinLiqCommitment as refDeriveMinLiqCommitment,
  deriveMinLiqNumsRecipient as refDeriveMinLiqNums,
} from './amm-min-liq.mjs';
import { sha256 } from '@noble/hashes/sha256';

import {
  // Functions under test (worker)
  ammComputeProtocolShares, ammCrystallizeProtocolFee,
  decodeTProtocolFeeClaimPayload, buildProtocolFeeClaimMsg,
  bpRangeAggVerify,
  ammJcsCanonicalize, ammExtractLauncherPubkey, ammFetchLauncherPubkeyForAsset,
  ammDeriveMinLiqCommitment, ammDeriveMinLiqNumsP2wpkh, ammVerifyMinLiqVoutStructural,
  ammPairKey, ammPairGet, ammPairAppend,
  ammDerivePoolId,
  AMM_INITIAL_LP_LOCK_BLOCKS, AMM_MIN_BATCH_SIZE, POOL_CAP_SOLO_INTENT_ALLOWED,
  AMM_PROTOCOL_FEE_BPS_MAX, T_PROTOCOL_FEE_CLAIM,
} from '../worker/src/index.js';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else             { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}
async function testAsync(label, fn) {
  try {
    const ok = await fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else             { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}
function bytesEq(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function bytesToHex(b) { return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join(''); }
function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i*2, i*2+2), 16);
  return out;
}

// =========================================================================
// 1. Constants pinned to spec
// =========================================================================
console.log('\nConstants pinned to spec');
test('AMM_INITIAL_LP_LOCK_BLOCKS = 6', () => AMM_INITIAL_LP_LOCK_BLOCKS === 6);
test('AMM_MIN_BATCH_SIZE = 2', () => AMM_MIN_BATCH_SIZE === 2);
test('POOL_CAP_SOLO_INTENT_ALLOWED = 0x02', () => POOL_CAP_SOLO_INTENT_ALLOWED === 0x02);
test('AMM_PROTOCOL_FEE_BPS_MAX = 1000', () => AMM_PROTOCOL_FEE_BPS_MAX === 1000);
test('T_PROTOCOL_FEE_CLAIM = 0x31', () => T_PROTOCOL_FEE_CLAIM === 0x31);

// =========================================================================
// 2. Protocol-fee crystallization parity
// =========================================================================
console.log('\nProtocol-fee crystallization parity');

const refPool = {
  lp_total_shares: 10_000_000n,
  reserve_A: 1_000_000n,
  reserve_B: 1_000_000n,
  protocol_fee_address: new Uint8Array(33).fill(0x02),
  protocol_fee_bps: 100,                   // 1% of LP-fee growth
  k_last: 900_000_000_000n,                // pre-growth baseline
  protocol_fee_accrued: 0n,
};
const workerPool = {
  lp_total_shares: '10000000',
  reserve_a: '1000000',
  reserve_b: '1000000',
  protocol_fee_address: '02' + '00'.repeat(32),
  protocol_fee_bps: 100,
  k_last: '900000000000',
  protocol_fee_accrued: '0',
};
const refOut = refCrystallize(refPool);
const workerOut = ammCrystallizeProtocolFee(workerPool);

test('worker crystallize matches ref protocol_fee_accrued', () =>
  refOut.protocol_fee_accrued.toString() === workerOut.protocol_fee_accrued);
test('worker crystallize matches ref lp_total_shares', () =>
  refOut.lp_total_shares.toString() === workerOut.lp_total_shares);
test('worker crystallize matches ref k_last', () =>
  refOut.k_last.toString() === workerOut.k_last);

// Zero-address no-op parity
const refZeroAddr = refCrystallize({ ...refPool, protocol_fee_address: new Uint8Array(33) });
const workerZeroAddr = ammCrystallizeProtocolFee({ ...workerPool, protocol_fee_address: '00'.repeat(33) });
test('zero-address pool: ref no-op', () => refZeroAddr.protocol_fee_accrued === 0n);
test('zero-address pool: worker no-op', () => (workerZeroAddr.protocol_fee_accrued ?? '0') === '0');

// bps=0 no-op parity
const refZeroBps = refCrystallize({ ...refPool, protocol_fee_bps: 0 });
const workerZeroBps = ammCrystallizeProtocolFee({ ...workerPool, protocol_fee_bps: 0 });
test('zero-bps pool: ref no-op', () => refZeroBps.protocol_fee_accrued === 0n);
test('zero-bps pool: worker no-op', () => (workerZeroBps.protocol_fee_accrued ?? '0') === '0');

// k_now <= k_last: no growth → no accrual, but k_last set
const refNoGrowth = refCrystallize({ ...refPool, k_last: 2n * refPool.reserve_A * refPool.reserve_B });
const workerNoGrowth = ammCrystallizeProtocolFee({
  ...workerPool,
  k_last: (2n * BigInt(workerPool.reserve_a) * BigInt(workerPool.reserve_b)).toString(),
});
test('no growth: ref returns 0 accrued', () => (refNoGrowth.protocol_fee_accrued ?? 0n) === 0n);
test('no growth: worker returns 0 accrued', () => (workerNoGrowth.protocol_fee_accrued ?? '0') === '0');

// Various bps values, growth magnitudes, S sizes — fuzz parity
console.log('\nProtocol-fee fuzz parity (10 random cases)');
function rndBigInt(maxBits) {
  let n = 0n;
  for (let i = 0; i < maxBits; i++) {
    if (Math.random() > 0.5) n |= (1n << BigInt(i));
  }
  return n;
}
for (let i = 0; i < 10; i++) {
  const S = (rndBigInt(40) | 1n);
  const rA = (rndBigInt(40) | 1n);
  const rB = (rndBigInt(40) | 1n);
  const bps = 1 + Math.floor(Math.random() * 1000);
  const k_last = ((rA * rB) * BigInt(50 + Math.floor(Math.random() * 50))) / 100n; // ~50-100% of current
  const refIn = {
    lp_total_shares: S, reserve_A: rA, reserve_B: rB,
    protocol_fee_address: new Uint8Array(33).fill(0x03),
    protocol_fee_bps: bps, k_last, protocol_fee_accrued: 0n,
  };
  const workerIn = {
    lp_total_shares: S.toString(), reserve_a: rA.toString(), reserve_b: rB.toString(),
    protocol_fee_address: '03' + '00'.repeat(32),
    protocol_fee_bps: bps, k_last: k_last.toString(), protocol_fee_accrued: '0',
  };
  const r = refCrystallize(refIn);
  const w = ammCrystallizeProtocolFee(workerIn);
  test(`fuzz #${i}: accrued matches`, () =>
    (r.protocol_fee_accrued ?? 0n).toString() === (w.protocol_fee_accrued ?? '0'));
}

// =========================================================================
// 3. Protocol-fee claim envelope decode parity
// =========================================================================
console.log('\nT_PROTOCOL_FEE_CLAIM envelope parity');

// Build a valid claim envelope via ref encoder; decode via worker.
const claimerPriv = new Uint8Array(32);
crypto.getRandomValues(claimerPriv);
const claimerPub = workerSecp.ProjectivePoint.BASE.multiply(BigInt('0x' + bytesToHex(claimerPriv)) % workerSecp.CURVE.n);
const claimerXOnly = claimerPub.toRawBytes(true).slice(1);
const poolIdBytes = sha256(new TextEncoder().encode('parity-test-pool-id'));
const claimAmount = 12345n;
// Compute the Pedersen commit on the worker's secp.
const claimBlinding = new Uint8Array(32);
crypto.getRandomValues(claimBlinding);
const refClaimC = refDeriveMinLiqCommitment(poolIdBytes);  // just any 33-byte commit
const claimCSecpBytes = refClaimC.toRawBytes(true);

const refClaimMsg = refBuildClaimMsg(sha256, {
  poolId: poolIdBytes,
  claimAmount,
  claimCSecp: claimCSecpBytes,
  claimBlinding,
});
const workerClaimMsg = buildProtocolFeeClaimMsg({
  poolIdBytes,
  claimAmount,
  claimCSecpBytes,
  claimBlindingBytes: claimBlinding,
});
test('claim_msg byte parity (ref ↔ worker)', () => bytesEq(refClaimMsg, workerClaimMsg));

// Round-trip: encode via ref encoder, decode via worker decoder.
const dummySig = new Uint8Array(64);  // not verifying sig in this test
const encoded = encodeProtocolFeeClaim({
  poolId: poolIdBytes,
  claimerPubkeyXOnly: claimerXOnly,
  claimAmount,
  claimCSecp: claimCSecpBytes,
  claimBlinding,
  claimSig: dummySig,
});
test('encoded claim envelope is 202 bytes', () => encoded.length === 202);

const decoded = decodeTProtocolFeeClaimPayload(encoded);
test('worker decode: not null', () => decoded !== null);
test('worker decode: pool_id matches', () => bytesEq(hexToBytes(decoded.pool_id), poolIdBytes));
test('worker decode: claim_amount matches', () => decoded.claim_amount_bigint === claimAmount);
test('worker decode: claimer_x_only matches', () => bytesEq(decoded.claimer_x_only_bytes, claimerXOnly));
test('worker decode: claim_C_secp matches', () => bytesEq(decoded.claim_c_secp_bytes, claimCSecpBytes));
test('worker decode: claim_blinding matches', () => bytesEq(decoded.claim_blinding_bytes, claimBlinding));
test('worker decode: claim_sig matches', () => bytesEq(decoded.claim_sig_bytes, dummySig));

// Adversarial: wrong opcode, wrong length
test('worker decode rejects wrong opcode', () => {
  const bad = new Uint8Array(encoded);
  bad[0] = 0x30;
  return decodeTProtocolFeeClaimPayload(bad) === null;
});
test('worker decode rejects truncated envelope', () => {
  const truncated = encoded.subarray(0, 200);
  return decodeTProtocolFeeClaimPayload(truncated) === null;
});

// =========================================================================
// 4. Bulletproof verifier parity
// =========================================================================
console.log('\nBulletproof verifier parity (m=2 — T_SWAP_VAR shape)');

const values = [4321n, 87654321n];
const blindings = [ref.randomScalar(), ref.randomScalar()];
const { proof: bpProof, commitments } = ref.bpRangeAggProve(values, blindings);
test('ref verifies its own proof', () => ref.bpRangeAggVerify(commitments, bpProof));

// Round-trip commitments through compressed bytes into worker-native points.
const commitBytes = commitments.map(c => c.toRawBytes(true));
const workerPts = commitBytes.map(b => workerSecp.ProjectivePoint.fromHex(bytesToHex(b)));
test('worker verifies ref-produced proof (production wire path)', () =>
  bpRangeAggVerify(workerPts, bpProof));

// Single-byte tampering at every byte index must reject.
let tamperAccept = 0, tamperReject = 0;
for (let off = 0; off < bpProof.length; off += 17) {
  const bad = new Uint8Array(bpProof);
  bad[off] ^= 0x80;
  try {
    if (bpRangeAggVerify(workerPts, bad)) tamperAccept++;
    else tamperReject++;
  } catch { tamperReject++; }
}
test('worker rejects every tampered byte (sample of bpProof)', () => tamperAccept === 0 && tamperReject > 0);

// Length-class rejection: proof one byte short.
test('worker rejects truncated proof', () => !bpRangeAggVerify(workerPts, bpProof.subarray(0, bpProof.length - 1)));

// Length-class rejection: wrong commitment count.
test('worker rejects m=1 (single commit) when proof expects m=2', () =>
  !bpRangeAggVerify([workerPts[0]], bpProof));

// =========================================================================
// 5. JCS canonicalization + launcher-pubkey extraction parity
// =========================================================================
console.log('\nJCS + launcher-pubkey parity');

const obj = { foo: 'bar', tacit_amm_launcher: '02' + 'aa'.repeat(32), zz: 42 };
test('worker JCS matches ref JCS', () =>
  bytesEq(ammJcsCanonicalize(obj), refJcs.canonicalize(obj)));

// Different shapes
test('JCS empty object parity', () => bytesEq(ammJcsCanonicalize({}), refJcs.canonicalize({})));
test('JCS nested object parity', () => bytesEq(
  ammJcsCanonicalize({ a: { b: [1, 2, 3], c: 'x' } }),
  refJcs.canonicalize({ a: { b: [1, 2, 3], c: 'x' } })
));
test('JCS string escaping parity', () => bytesEq(
  ammJcsCanonicalize({ k: 'a"b\\c\nd' }),
  refJcs.canonicalize({ k: 'a"b\\c\nd' })
));

// extractLauncherPubkey
const canonical = refJcs.canonicalize({ tacit_amm_launcher: '02' + 'bb'.repeat(32) });
test('worker extracts pubkey from canonical blob (ref parity)', () => {
  const refKey = refJcs.extractLauncherPubkey(canonical);
  const workerKey = ammExtractLauncherPubkey(canonical);
  return refKey !== null && workerKey !== null && bytesEq(refKey, workerKey);
});

// Non-canonical (whitespace) → both null
test('worker rejects whitespace blob (parity)', () => {
  const ws = new TextEncoder().encode('{ "tacit_amm_launcher": "02' + 'cc'.repeat(32) + '" }');
  return refJcs.extractLauncherPubkey(ws) === null && ammExtractLauncherPubkey(ws) === null;
});

// Non-canonical key order → both null
test('worker rejects wrong-key-order blob (parity)', () => {
  const wrongOrder = new TextEncoder().encode('{"tacit_amm_launcher":"02' + 'dd'.repeat(32) + '","foo":"bar"}');
  return refJcs.extractLauncherPubkey(wrongOrder) === null && ammExtractLauncherPubkey(wrongOrder) === null;
});

// Missing field → both null
test('worker rejects missing field (parity)', () => {
  const noField = refJcs.canonicalize({ foo: 'bar' });
  return refJcs.extractLauncherPubkey(noField) === null && ammExtractLauncherPubkey(noField) === null;
});

// Malformed value (number, not hex string) → both null
test('worker rejects malformed value (parity)', () => {
  const bad = refJcs.canonicalize({ tacit_amm_launcher: 123 });
  return refJcs.extractLauncherPubkey(bad) === null && ammExtractLauncherPubkey(bad) === null;
});

// Wrong-length hex → both null
test('worker rejects wrong-length pubkey hex (parity)', () => {
  const short = refJcs.canonicalize({ tacit_amm_launcher: '02' + 'aa'.repeat(30) });
  return refJcs.extractLauncherPubkey(short) === null && ammExtractLauncherPubkey(short) === null;
});

// =========================================================================
// 6. MIN_LIQ NUMS construction parity
// =========================================================================
console.log('\nMIN_LIQ NUMS recipient parity');

const poolIdForMinLiq = sha256(new TextEncoder().encode('min-liq-pool-id'));
const refMinLiqNums = refDeriveMinLiqNums(poolIdForMinLiq);
const workerMinLiqP2wpkh = ammDeriveMinLiqNumsP2wpkh(poolIdForMinLiq);
test('worker MIN_LIQ P2WPKH matches ref P2WPKH', () => bytesEq(workerMinLiqP2wpkh, refMinLiqNums.p2wpkh));

const refMinLiqCommit = refDeriveMinLiqCommitment(poolIdForMinLiq);
const workerMinLiqCommit = ammDeriveMinLiqCommitment(poolIdForMinLiq);
test('worker MIN_LIQ commit matches ref commit (compressed bytes)', () =>
  bytesEq(workerMinLiqCommit.toRawBytes(true), refMinLiqCommit.toRawBytes(true)));

// ammVerifyMinLiqVoutStructural — happy path
const honestVout1Script = '0014' + bytesToHex(workerMinLiqP2wpkh);
test('worker accepts honest vout[1] P2WPKH', () => {
  const tx = { vout: [{}, { scriptpubkey: honestVout1Script }] };
  return ammVerifyMinLiqVoutStructural(tx, poolIdForMinLiq) === true;
});

// Wrong P2WPKH → reject
test('worker rejects wrong P2WPKH at vout[1]', () => {
  const badScript = '0014' + 'aa'.repeat(20);
  const tx = { vout: [{}, { scriptpubkey: badScript }] };
  return ammVerifyMinLiqVoutStructural(tx, poolIdForMinLiq) === false;
});

// Non-P2WPKH (P2TR script) → reject
test('worker rejects non-P2WPKH at vout[1] (P2TR shape)', () => {
  const tx = { vout: [{}, { scriptpubkey: '5120' + 'aa'.repeat(32) }] };
  return ammVerifyMinLiqVoutStructural(tx, poolIdForMinLiq) === false;
});

// Missing vout[1] → reject
test('worker rejects missing vout[1]', () => {
  const tx = { vout: [{ scriptpubkey: '0014' + '00'.repeat(20) }] };
  return ammVerifyMinLiqVoutStructural(tx, poolIdForMinLiq) === false;
});

// Different pool_id ⇒ different P2WPKH ⇒ original verifier rejects
test('worker rejects cross-pool-id vout[1]', () => {
  const otherPoolId = sha256(new TextEncoder().encode('different-pool-id'));
  const tx = { vout: [{}, { scriptpubkey: honestVout1Script }] };
  return ammVerifyMinLiqVoutStructural(tx, otherPoolId) === false;
});

// =========================================================================
// 7. Pool pair index (variant-0 LP_ADD / LP_REMOVE pool discovery)
// =========================================================================
console.log('\nPool pair index — variant-0 disambiguation');

// Mock KV.
function makeMockKV() {
  const m = new Map();
  return {
    REGISTRY_KV: {
      async get(key, type) {
        const v = m.get(key);
        if (v === undefined) return null;
        return type === 'json' ? JSON.parse(v) : v;
      },
      async put(key, val) { m.set(key, val); },
      async delete(key) { m.delete(key); },
    },
    _map: m,
  };
}

const aHex = '11'.repeat(32);
const bHex = '22'.repeat(32);
test('pair key (signet): pair-prefixed', () => {
  const k = ammPairKey('signet', aHex, bHex);
  return k === `ammpoolpair:${aHex}:${bHex}`;
});
test('pair key (mainnet): network-prefixed', () => {
  const k = ammPairKey('mainnet', aHex, bHex);
  return k === `ammpoolpair:mainnet:${aHex}:${bHex}`;
});

const env = makeMockKV();
await testAsync('pair index initially empty', async () => {
  const list = await ammPairGet(env, 'signet', aHex, bHex);
  return Array.isArray(list) && list.length === 0;
});
await testAsync('append + get returns single entry', async () => {
  await ammPairAppend(env, 'signet', aHex, bHex, 'cafebabe');
  const list = await ammPairGet(env, 'signet', aHex, bHex);
  return list.length === 1 && list[0] === 'cafebabe';
});
await testAsync('append is idempotent (no duplicate)', async () => {
  await ammPairAppend(env, 'signet', aHex, bHex, 'cafebabe');
  const list = await ammPairGet(env, 'signet', aHex, bHex);
  return list.length === 1;
});
await testAsync('append accumulates distinct pool_ids', async () => {
  await ammPairAppend(env, 'signet', aHex, bHex, 'deadbeef');
  await ammPairAppend(env, 'signet', aHex, bHex, 'feedface');
  const list = await ammPairGet(env, 'signet', aHex, bHex);
  return list.length === 3 && list.includes('deadbeef') && list.includes('feedface');
});

// Verify multi-tier pool_id distinction (V3/V4 parity):
//   same pair, different fee_bps → different pool_id → different entries.
const aBytes = hexToBytes(aHex);
const bBytes = hexToBytes(bHex);
const poolId30 = ammDerivePoolId(aBytes, bBytes, 30, 0);
const poolId5 = ammDerivePoolId(aBytes, bBytes, 5, 0);
const poolId30Cap = ammDerivePoolId(aBytes, bBytes, 30, 0x02);
test('different fee_bps ⇒ different pool_id', () => !bytesEq(poolId30, poolId5));
test('different capability_flags ⇒ different pool_id', () => !bytesEq(poolId30, poolId30Cap));
test('same (assets, fee_bps, flags) ⇒ same pool_id', () =>
  bytesEq(ammDerivePoolId(aBytes, bBytes, 30, 0), ammDerivePoolId(aBytes, bBytes, 30, 0)));

// =========================================================================
// 8. Launcher-gate resolver tri-state semantics
// =========================================================================
console.log('\nLauncher-gate resolver tri-state');

function makeMockEnvWithAsset(assetIdHex, image_uri) {
  const e = makeMockKV();
  if (image_uri !== undefined) {
    e._map.set(
      `asset:${assetIdHex}`,
      JSON.stringify({ asset_id: assetIdHex, image_uri }),
    );
  }
  return e;
}

const assetIdA = '11'.repeat(32);
await testAsync('no asset registered ⇒ no-gate (cached)', async () => {
  const e = makeMockEnvWithAsset(assetIdA, undefined);
  const out = await ammFetchLauncherPubkeyForAsset(e, 'signet', assetIdA);
  if (out.status !== 'no-gate' || out.pubkey !== null) return false;
  // Cached.
  return e._map.has(`amm:launcher:${assetIdA}`);
});

await testAsync('asset with no image_uri ⇒ no-gate (cached)', async () => {
  const e = makeMockEnvWithAsset(assetIdA, undefined);
  e._map.set(`asset:${assetIdA}`, JSON.stringify({ asset_id: assetIdA }));
  const out = await ammFetchLauncherPubkeyForAsset(e, 'signet', assetIdA);
  return out.status === 'no-gate' && e._map.has(`amm:launcher:${assetIdA}`);
});

await testAsync('asset with HTTPS image_uri (non-IPFS) ⇒ no-gate (cached)', async () => {
  const e = makeMockEnvWithAsset(assetIdA, 'https://example.com/x.png');
  const out = await ammFetchLauncherPubkeyForAsset(e, 'signet', assetIdA);
  return out.status === 'no-gate';
});

await testAsync('cached gated entry round-trip', async () => {
  const e = makeMockKV();
  const pkHex = '02' + 'ab'.repeat(32);
  e._map.set(
    `amm:launcher:${assetIdA}`,
    JSON.stringify({ status: 'gated', pubkey_hex: pkHex }),
  );
  const out = await ammFetchLauncherPubkeyForAsset(e, 'signet', assetIdA);
  return out.status === 'gated' && bytesToHex(out.pubkey) === pkHex;
});

await testAsync('cached no-gate entry round-trip', async () => {
  const e = makeMockKV();
  e._map.set(
    `amm:launcher:${assetIdA}`,
    JSON.stringify({ status: 'no-gate' }),
  );
  const out = await ammFetchLauncherPubkeyForAsset(e, 'signet', assetIdA);
  return out.status === 'no-gate' && out.pubkey === null;
});

await testAsync('mainnet uses network-prefixed cache key', async () => {
  const e = makeMockKV();
  e._map.set(`asset:mainnet:${assetIdA}`, JSON.stringify({ asset_id: assetIdA }));
  const out = await ammFetchLauncherPubkeyForAsset(e, 'mainnet', assetIdA);
  // Cache write goes to mainnet-prefixed key.
  return out.status === 'no-gate' && e._map.has(`amm:launcher:mainnet:${assetIdA}`);
});

// =========================================================================
console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
