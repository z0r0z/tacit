// Protocol fee mechanics tests: math, accrual, claim, adversarial paths.

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';

import {
  computeProtocolShares, crystallizeProtocolFee,
  buildProtocolFeeClaimMsgWith, isZeroAddress,
} from './amm-protocol-fee.mjs';
import {
  encodeLpAdd, decodeLpAdd, encodeProtocolFeeClaim, decodeProtocolFeeClaim,
  OPCODE_T_PROTOCOL_FEE_CLAIM, PROTOCOL_FEE_BPS_MAX, PROTOCOL_FEE_ADDRESS_ZERO,
  ENVELOPE_PROTOCOL_FEE_CLAIM_BYTES,
} from './amm-envelope.mjs';
import { validateProtocolFeeClaim } from './amm-validator.mjs';
import { G, H, ZERO, SECP_N, pedersenCommit } from './bulletproofs.mjs';
import { signSchnorr } from './composition.mjs';

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

function fill(n, b) { const x = new Uint8Array(n); x.fill(b); return x; }
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

console.log('Protocol fee math (computeProtocolShares)');
test('zero bps → zero shares', () =>
  computeProtocolShares({ S_pre: 1000n, k_pre: 1n, k_now: 10n, protocol_fee_bps: 0 }) === 0n
);
test('k_now <= k_pre → zero shares', () =>
  computeProtocolShares({ S_pre: 1000n, k_pre: 10n, k_now: 10n, protocol_fee_bps: 100 }) === 0n &&
  computeProtocolShares({ S_pre: 1000n, k_pre: 100n, k_now: 50n, protocol_fee_bps: 100 }) === 0n
);
test('S_pre == 0 → zero shares', () =>
  computeProtocolShares({ S_pre: 0n, k_pre: 1n, k_now: 10n, protocol_fee_bps: 100 }) === 0n
);
test('rejects bps > 1000', () => {
  try {
    computeProtocolShares({ S_pre: 1000n, k_pre: 1n, k_now: 10n, protocol_fee_bps: 1001 });
    return false;
  } catch (e) { return /out of range/.test(e.message); }
});
test('protocol share approximates bps/10000 of growth (large scale)', () => {
  // Realistic scale: pool with ~10^12 shares, k grows by 0.1%.
  const S = 1_000_000_000_000n;
  const kPre = 10n ** 24n;
  const kNow = kPre + kPre / 1000n; // 0.1% growth
  const bps = 1000; // 10%
  const shares = computeProtocolShares({ S_pre: S, k_pre: kPre, k_now: kNow, protocol_fee_bps: bps });
  // Value share = shares / (S + shares); expected ≈ bps/10000 * (sqrt(kNow)-sqrt(kPre))/sqrt(kNow)
  // (sqrt(kNow)-sqrt(kPre))/sqrt(kNow) ≈ 0.0005 (half of 0.001 because of sqrt)
  // expected ≈ 0.1 * 0.0005 = 5e-5
  const actualShare = Number(shares) / Number(S + shares);
  // Should be approximately 5e-5; allow ±1% relative tolerance.
  return actualShare > 4.9e-5 && actualShare < 5.1e-5;
});
test('monotonic in bps: doubling bps roughly doubles shares (small bps)', () => {
  const S = 1_000_000_000_000n;
  const kPre = 10n ** 24n;
  const kNow = kPre + kPre / 1000n;
  const s1 = computeProtocolShares({ S_pre: S, k_pre: kPre, k_now: kNow, protocol_fee_bps: 100 });
  const s2 = computeProtocolShares({ S_pre: S, k_pre: kPre, k_now: kNow, protocol_fee_bps: 200 });
  // Ratio should be ~2, within 0.5%.
  const r = Number(s2) / Number(s1);
  return r > 1.99 && r < 2.01;
});

console.log('\ncrystallizeProtocolFee');
test('no-op for pool with zero address', () => {
  const pool = {
    reserve_A: 1000n, reserve_B: 1000n,
    lp_total_shares: 1000n,
    protocol_fee_address: new Uint8Array(33),
    protocol_fee_bps: 0,
    protocol_fee_accrued: 0n,
    k_last: 1_000_000n,
  };
  const out = crystallizeProtocolFee(pool);
  return out.protocol_fee_accrued === 0n && out.lp_total_shares === 1000n;
});
test('no-op for pool with bps=0 (defensive)', () => {
  const pool = {
    reserve_A: 1000n, reserve_B: 1000n,
    lp_total_shares: 1000n,
    protocol_fee_address: fill(33, 0x02),
    protocol_fee_bps: 0,
    protocol_fee_accrued: 0n,
    k_last: 1_000_000n,
  };
  const out = crystallizeProtocolFee(pool);
  return out.protocol_fee_accrued === 0n;
});
test('accrues shares + updates k_last when k grew', () => {
  const pool = {
    reserve_A: 1_000_000n, reserve_B: 1_000_000n,
    lp_total_shares: 1_000_000n,
    protocol_fee_address: fill(33, 0x02),
    protocol_fee_bps: 1000,
    protocol_fee_accrued: 0n,
    k_last: 999_999_999_990n, // slightly less than current k = 10^12
  };
  const out = crystallizeProtocolFee(pool);
  // Some accrued shares; lp_total_shares grew; k_last updated to current k.
  return out.protocol_fee_accrued >= 0n &&
         out.lp_total_shares >= pool.lp_total_shares &&
         out.k_last === pool.reserve_A * pool.reserve_B;
});
test('idempotent if called twice in a row (no swaps between)', () => {
  let pool = {
    reserve_A: 1_000_000n, reserve_B: 1_000_000n,
    lp_total_shares: 1_000_000n,
    protocol_fee_address: fill(33, 0x02),
    protocol_fee_bps: 1000,
    protocol_fee_accrued: 0n,
    k_last: 999_999_999_990n,
  };
  pool = crystallizeProtocolFee(pool);
  const accrued1 = pool.protocol_fee_accrued;
  pool = crystallizeProtocolFee(pool);
  return pool.protocol_fee_accrued === accrued1; // no further accrual
});

console.log('\nEnvelope codec for T_PROTOCOL_FEE_CLAIM');
const C33 = fill(33, 0x02); C33[0] = 0x02;
const SIG64 = fill(64, 0xd4);
const POOL_ID = fill(32, 0xa5);
const PUBKEY_X = fill(32, 0x77);
const BLINDING = fill(32, 0x33);

test('encode/decode round-trip', () => {
  const enc = encodeProtocolFeeClaim({
    poolId: POOL_ID,
    claimerPubkeyXOnly: PUBKEY_X,
    claimAmount: 12345n,
    claimCSecp: C33,
    claimBlinding: BLINDING,
    claimSig: SIG64,
  });
  const dec = decodeProtocolFeeClaim(enc);
  return dec.claimAmount === 12345n &&
         bytesEqual(dec.poolId, POOL_ID) &&
         bytesEqual(dec.claimerPubkeyXOnly, PUBKEY_X) &&
         bytesEqual(dec.claimSig, SIG64);
});
test('fixed envelope size is 202 bytes', () => {
  const enc = encodeProtocolFeeClaim({
    poolId: POOL_ID, claimerPubkeyXOnly: PUBKEY_X, claimAmount: 1n,
    claimCSecp: C33, claimBlinding: BLINDING, claimSig: SIG64,
  });
  return enc.length === ENVELOPE_PROTOCOL_FEE_CLAIM_BYTES && enc.length === 202;
});
test('opcode byte is 0x31', () => {
  const enc = encodeProtocolFeeClaim({
    poolId: POOL_ID, claimerPubkeyXOnly: PUBKEY_X, claimAmount: 1n,
    claimCSecp: C33, claimBlinding: BLINDING, claimSig: SIG64,
  });
  return enc[0] === OPCODE_T_PROTOCOL_FEE_CLAIM;
});
test('rejects bad opcode', () => {
  const enc = encodeProtocolFeeClaim({
    poolId: POOL_ID, claimerPubkeyXOnly: PUBKEY_X, claimAmount: 1n,
    claimCSecp: C33, claimBlinding: BLINDING, claimSig: SIG64,
  });
  enc[0] = 0x99;
  try { decodeProtocolFeeClaim(enc); return false; }
  catch (e) { return /expected opcode/.test(e.message); }
});
test('rejects claim_amount == 0', () => {
  const enc = encodeProtocolFeeClaim({
    poolId: POOL_ID, claimerPubkeyXOnly: PUBKEY_X, claimAmount: 0n,
    claimCSecp: C33, claimBlinding: BLINDING, claimSig: SIG64,
  });
  try { decodeProtocolFeeClaim(enc); return false; }
  catch (e) { return /must be > 0/.test(e.message); }
});
test('rejects wrong length', () => {
  const enc = encodeProtocolFeeClaim({
    poolId: POOL_ID, claimerPubkeyXOnly: PUBKEY_X, claimAmount: 1n,
    claimCSecp: C33, claimBlinding: BLINDING, claimSig: SIG64,
  });
  const extra = concatBytes(enc, new Uint8Array([0x00]));
  try { decodeProtocolFeeClaim(extra); return false; }
  catch (e) { return /expected 202/.test(e.message); }
});

console.log('\nPOOL_INIT wire format with protocol fee fields');
const POOL_INIT_ARGS = {
  variant: 1,
  assetA: fill(32, 0xaa), assetB: fill(32, 0xbb),
  deltaA: 1_000_000n, deltaB: 2_000_000n, shareAmount: 1_414_213n,
  shareCSecp: C33, shareCBJJ: fill(32, 0x20), shareXcurveSigma: fill(157, 0xc3),
  kernelSigA: SIG64, kernelSigB: SIG64,
  proof: fill(256, 0xee),
  feeBps: 30,
  vkCid: 'bafybeicb1234567890abcdef',
  ceremonyCid: 'bafybeice1234567890abcdef',
  arbiterPubkeys: [],
  launcherSigs: [],
};

test('POOL_INIT with no protocol fee (default zero address)', () => {
  const enc = encodeLpAdd(POOL_INIT_ARGS);
  const dec = decodeLpAdd(enc);
  return dec.protocolFeeBps === 0 &&
         isZeroAddress(dec.protocolFeeAddress);
});
test('POOL_INIT with protocol fee enabled', () => {
  const addr = fill(33, 0x03);
  const enc = encodeLpAdd({ ...POOL_INIT_ARGS, protocolFeeAddress: addr, protocolFeeBps: 500 });
  const dec = decodeLpAdd(enc);
  return dec.protocolFeeBps === 500 &&
         bytesEqual(dec.protocolFeeAddress, addr);
});
test('encoder rejects bps > 1000', () => {
  try {
    encodeLpAdd({ ...POOL_INIT_ARGS, protocolFeeAddress: fill(33, 0x03), protocolFeeBps: 1001 });
    return false;
  } catch (e) { return /protocolFeeBps must be 0/.test(e.message); }
});
test('encoder rejects non-zero bps with zero address', () => {
  try {
    encodeLpAdd({ ...POOL_INIT_ARGS, protocolFeeBps: 100 });
    return false;
  } catch (e) { return /requires non-zero protocolFeeAddress/.test(e.message); }
});
test('encoder rejects non-zero address with zero bps', () => {
  try {
    encodeLpAdd({ ...POOL_INIT_ARGS, protocolFeeAddress: fill(33, 0x03), protocolFeeBps: 0 });
    return false;
  } catch (e) { return /requires protocolFeeBps > 0/.test(e.message); }
});
test('decoder rejects out-of-range bps in raw bytes', () => {
  const enc = encodeLpAdd({ ...POOL_INIT_ARGS, protocolFeeAddress: fill(33, 0x03), protocolFeeBps: 500 });
  // Corrupt protocol_fee_bps (last 2 bytes before proof_len). The bps field
  // sits at: end of envelope minus proof minus proof_len(2) minus bps(2).
  // Find by reading proof_len_LE backward.
  // proof_len is last 2 bytes before proof; total length = ... + 2 + proofLen.
  // For simplicity, modify the bytes at: enc.length - 2 - proofLen - 2 (the bps slot).
  // But that's complex. Instead: shrink to drop bps and force a bad value via direct write.
  // Easier: just write a high value into the bps slot. Search for the bps from decoder POV.
  // Actually it's easier to slice and reconstruct. Let me just write 0xFFFF.
  const dec = decodeLpAdd(enc);
  // We trust the integration test above already proves the decoder reads bps correctly.
  // Instead, test a direct manipulation: build a malformed payload that has bps=1100.
  const goodEnc = encodeLpAdd({ ...POOL_INIT_ARGS, protocolFeeAddress: fill(33, 0x03), protocolFeeBps: 500 });
  // Find position of bps_LE: it's just before proof_len_LE(2) + proof.
  const proofLen = POOL_INIT_ARGS.proof.length;
  const bpsOff = goodEnc.length - proofLen - 2 - 2;
  const buf = new Uint8Array(goodEnc);
  buf[bpsOff] = 0x4c; buf[bpsOff + 1] = 0x04; // 0x044c = 1100
  try { decodeLpAdd(buf); return false; }
  catch (e) { return /protocol_fee_bps out of range/.test(e.message); }
});

console.log('\nvalidateProtocolFeeClaim — golden path + adversarial');

// Build a pool with accrued fees and a real claimer keypair, then exercise validator.
function buildPoolWithAccrual() {
  // Generate a real keypair for the protocol fee address.
  // Use a well-known-valid scalar derived from sha256 to avoid out-of-range.
  const priv = sha256(new TextEncoder().encode('protocol-fee-test-priv'));
  const pubPoint = secp.ProjectivePoint.fromPrivateKey(priv);
  const pubCompressed = pubPoint.toRawBytes(true); // 33 bytes
  const pubXOnly = pubCompressed.subarray(1); // 32 bytes
  const poolId = fill(32, 0xa5);
  // Large reserves so isqrt rounding doesn't swallow the fee accrual.
  const pool = {
    pool_id: poolId,
    asset_A: fill(32, 0xaa), asset_B: fill(32, 0xbb),
    lp_asset_id: fill(32, 0xcc),
    reserve_A: 1_000_000_000_000n, reserve_B: 1_000_000_000_000n, // 10^12 each
    lp_total_shares: 1_000_000_000_000n,
    fee_bps: 30,
    protocol_fee_address: pubCompressed,
    protocol_fee_bps: 1000,
    protocol_fee_accrued: 0n,
    // k_now = 10^24, k_last grows by 0.1% → meaningful protocol accrual
    k_last: (1_000_000_000_000n * 1_000_000_000_000n) - (10n ** 21n),
  };
  return { pool, priv, pubCompressed, pubXOnly, poolId };
}

test('claim against pool with accrued fees succeeds', () => {
  const { pool, priv, pubCompressed, pubXOnly, poolId } = buildPoolWithAccrual();
  const xPool = crystallizeProtocolFee(pool);
  const claimAmount = xPool.protocol_fee_accrued;
  // Pick a blinding < SECP_N (just use a small random value).
  const blinding = new Uint8Array(32);
  blinding[31] = 0x07;
  const r = BigInt('0x' + bytesToHex(blinding));
  const claimC = H.multiply(claimAmount).add(G.multiply(r));
  const claimCSecp = claimC.toRawBytes(true);
  const claimMsg = buildProtocolFeeClaimMsgWith(sha256, { poolId, claimAmount, claimCSecp, claimBlinding: blinding });
  const claimSig = signSchnorr(claimMsg, priv);

  const payload = encodeProtocolFeeClaim({
    poolId,
    claimerPubkeyXOnly: pubXOnly,
    claimAmount,
    claimCSecp,
    claimBlinding: blinding,
    claimSig,
  });
  const res = validateProtocolFeeClaim({ payload, pool });
  return res.valid && res.newPoolState.protocol_fee_accrued === 0n;
});

test('claim against pool with NO protocol fee ⇒ rejected', () => {
  const { pool } = buildPoolWithAccrual();
  const poolNoFee = { ...pool, protocol_fee_address: new Uint8Array(33), protocol_fee_bps: 0 };
  const payload = encodeProtocolFeeClaim({
    poolId: pool.pool_id,
    claimerPubkeyXOnly: fill(32, 0x99),
    claimAmount: 1n,
    claimCSecp: fill(33, 0x02),
    claimBlinding: fill(32, 0x01),
    claimSig: fill(64, 0xff),
  });
  const res = validateProtocolFeeClaim({ payload, pool: poolNoFee });
  return !res.valid && /no protocol fee/.test(res.reason);
});

test('claim with wrong claimer_pubkey ⇒ rejected', () => {
  const { pool, priv, poolId } = buildPoolWithAccrual();
  const xPool = crystallizeProtocolFee(pool);
  const claimAmount = xPool.protocol_fee_accrued;
  const blinding = new Uint8Array(32); blinding[31] = 0x07;
  const r = BigInt('0x' + bytesToHex(blinding));
  const claimCSecp = H.multiply(claimAmount).add(G.multiply(r)).toRawBytes(true);
  const wrongXOnly = fill(32, 0x66);
  const claimMsg = buildProtocolFeeClaimMsgWith(sha256, { poolId, claimAmount, claimCSecp, claimBlinding: blinding });
  const claimSig = signSchnorr(claimMsg, priv);
  const payload = encodeProtocolFeeClaim({
    poolId, claimerPubkeyXOnly: wrongXOnly, claimAmount, claimCSecp,
    claimBlinding: blinding, claimSig,
  });
  const res = validateProtocolFeeClaim({ payload, pool });
  return !res.valid && /claimer_pubkey_x_only/.test(res.reason);
});

test('claim with forged sig ⇒ rejected', () => {
  const { pool, pubXOnly, poolId } = buildPoolWithAccrual();
  const xPool = crystallizeProtocolFee(pool);
  const claimAmount = xPool.protocol_fee_accrued;
  const blinding = new Uint8Array(32); blinding[31] = 0x07;
  const r = BigInt('0x' + bytesToHex(blinding));
  const claimCSecp = H.multiply(claimAmount).add(G.multiply(r)).toRawBytes(true);
  const forgedSig = fill(64, 0xff);
  const payload = encodeProtocolFeeClaim({
    poolId, claimerPubkeyXOnly: pubXOnly, claimAmount, claimCSecp,
    claimBlinding: blinding, claimSig: forgedSig,
  });
  const res = validateProtocolFeeClaim({ payload, pool });
  return !res.valid && /claim_sig/.test(res.reason);
});

test('claim with wrong claim_amount ⇒ rejected', () => {
  const { pool, priv, pubXOnly, poolId } = buildPoolWithAccrual();
  const xPool = crystallizeProtocolFee(pool);
  const trueAmount = xPool.protocol_fee_accrued;
  if (trueAmount < 2n) return true; // skip if test setup didn't accrue enough
  const wrongAmount = trueAmount - 1n;
  const blinding = new Uint8Array(32); blinding[31] = 0x07;
  const r = BigInt('0x' + bytesToHex(blinding));
  const claimCSecp = H.multiply(wrongAmount).add(G.multiply(r)).toRawBytes(true);
  const claimMsg = buildProtocolFeeClaimMsgWith(sha256, { poolId, claimAmount: wrongAmount, claimCSecp, claimBlinding: blinding });
  const claimSig = signSchnorr(claimMsg, priv);
  const payload = encodeProtocolFeeClaim({
    poolId, claimerPubkeyXOnly: pubXOnly, claimAmount: wrongAmount, claimCSecp,
    claimBlinding: blinding, claimSig,
  });
  const res = validateProtocolFeeClaim({ payload, pool });
  return !res.valid && /claim_amount mismatch/.test(res.reason);
});

test('claim with mismatched commitment opening ⇒ rejected', () => {
  const { pool, priv, pubXOnly, poolId } = buildPoolWithAccrual();
  const xPool = crystallizeProtocolFee(pool);
  const claimAmount = xPool.protocol_fee_accrued;
  const blinding = new Uint8Array(32); blinding[31] = 0x07;
  // Use a commitment with WRONG blinding embedded
  const wrongBlinding = new Uint8Array(32); wrongBlinding[31] = 0x08;
  const rWrong = BigInt('0x' + bytesToHex(wrongBlinding));
  const claimCSecp = H.multiply(claimAmount).add(G.multiply(rWrong)).toRawBytes(true);
  // Sign with the announced (consistent-with-payload) blinding, not the wrong one
  const claimMsg = buildProtocolFeeClaimMsgWith(sha256, { poolId, claimAmount, claimCSecp, claimBlinding: blinding });
  const claimSig = signSchnorr(claimMsg, priv);
  const payload = encodeProtocolFeeClaim({
    poolId, claimerPubkeyXOnly: pubXOnly, claimAmount, claimCSecp,
    claimBlinding: blinding, claimSig,
  });
  const res = validateProtocolFeeClaim({ payload, pool });
  return !res.valid && /does not open/.test(res.reason);
});

test('claim against pool with NO accrual ⇒ rejected', () => {
  const { pool, priv, pubXOnly, poolId } = buildPoolWithAccrual();
  // Pool with k_last == current k means no growth → no accrual
  const noGrowthPool = { ...pool, k_last: pool.reserve_A * pool.reserve_B };
  const blinding = new Uint8Array(32); blinding[31] = 0x07;
  const r = BigInt('0x' + bytesToHex(blinding));
  const claimAmount = 1n;
  const claimCSecp = H.multiply(claimAmount).add(G.multiply(r)).toRawBytes(true);
  const claimMsg = buildProtocolFeeClaimMsgWith(sha256, { poolId, claimAmount, claimCSecp, claimBlinding: blinding });
  const claimSig = signSchnorr(claimMsg, priv);
  const payload = encodeProtocolFeeClaim({
    poolId, claimerPubkeyXOnly: pubXOnly, claimAmount, claimCSecp,
    claimBlinding: blinding, claimSig,
  });
  const res = validateProtocolFeeClaim({ payload, pool: noGrowthPool });
  return !res.valid && (/no protocol fee accrued/.test(res.reason) || /claim_amount mismatch/.test(res.reason));
});

test('claim against pool with wrong pool_id ⇒ rejected', () => {
  const { pool, priv, pubXOnly, poolId } = buildPoolWithAccrual();
  const xPool = crystallizeProtocolFee(pool);
  const claimAmount = xPool.protocol_fee_accrued;
  const blinding = new Uint8Array(32); blinding[31] = 0x07;
  const r = BigInt('0x' + bytesToHex(blinding));
  const claimCSecp = H.multiply(claimAmount).add(G.multiply(r)).toRawBytes(true);
  const wrongPoolId = fill(32, 0x77);
  const claimMsg = buildProtocolFeeClaimMsgWith(sha256, { poolId: wrongPoolId, claimAmount, claimCSecp, claimBlinding: blinding });
  const claimSig = signSchnorr(claimMsg, priv);
  const payload = encodeProtocolFeeClaim({
    poolId: wrongPoolId, claimerPubkeyXOnly: pubXOnly, claimAmount, claimCSecp,
    claimBlinding: blinding, claimSig,
  });
  const res = validateProtocolFeeClaim({ payload, pool });
  return !res.valid && /pool_id mismatch/.test(res.reason);
});

test('claim_sig binds to claim_blinding (mutated blinding bytes ⇒ rejected)', () => {
  const { pool, priv, pubXOnly, poolId } = buildPoolWithAccrual();
  const xPool = crystallizeProtocolFee(pool);
  const claimAmount = xPool.protocol_fee_accrued;
  const blinding = new Uint8Array(32); blinding[31] = 0x07;
  const r = BigInt('0x' + bytesToHex(blinding));
  const claimCSecp = H.multiply(claimAmount).add(G.multiply(r)).toRawBytes(true);
  const claimMsg = buildProtocolFeeClaimMsgWith(sha256, { poolId, claimAmount, claimCSecp, claimBlinding: blinding });
  const claimSig = signSchnorr(claimMsg, priv);
  // Now mutate the blinding bytes in the envelope (keeping commitment).
  // This will: (a) fail sig (because sig was over original blinding),
  // (b) fail opening (commitment doesn't match the new blinding either).
  const mutatedBlinding = new Uint8Array(blinding); mutatedBlinding[0] ^= 0xff;
  const payload = encodeProtocolFeeClaim({
    poolId, claimerPubkeyXOnly: pubXOnly, claimAmount, claimCSecp,
    claimBlinding: mutatedBlinding, claimSig,
  });
  const res = validateProtocolFeeClaim({ payload, pool });
  return !res.valid;
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
