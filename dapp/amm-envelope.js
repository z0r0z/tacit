// AMM envelope encoder — dapp-side port of tests/amm-envelope.mjs (LP_ADD +
// LP_REMOVE only, swap encoders live in tacit.js's existing SWAP_VAR path).
// Byte-for-byte identical to the test reference so worker decoder accepts
// dapp-produced payloads.

import { concatBytes, hexToBytes, sha256 } from './vendor/tacit-deps.min.js';
import { XCURVE_PROOF_LEN } from './amm-sigma.js';

export const OPCODE_T_LP_ADD     = 0x2D;
export const OPCODE_T_LP_REMOVE  = 0x2E;
export const OPCODE_T_PROTOCOL_FEE_CLAIM = 0x31;
export const FEE_BPS_MAX           = 1000;
export const PROTOCOL_FEE_BPS_MAX  = 1000;
export const PROTOCOL_FEE_ADDRESS_ZERO = new Uint8Array(33);

const _PROTOCOL_FEE_CLAIM_DOMAIN = new TextEncoder().encode('tacit-amm-protocol-fee-claim-v1');

function asBytes(x, len, name) {
  const b = x instanceof Uint8Array ? x : hexToBytes(x);
  if (b.length !== len) throw new Error(`${name} must be ${len} bytes`);
  return b;
}
function u16LE(n) {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, n & 0xffff, true);
  return buf;
}
function u64LE(n) {
  const buf = new Uint8Array(8);
  let x = BigInt(n);
  if (x < 0n || x >= 1n << 64n) throw new Error('u64 overflow');
  for (let i = 0; i < 8; i++) { buf[i] = Number(x & 0xffn); x >>= 8n; }
  return buf;
}
function isZeroAddress(b) {
  if (b.length !== 33) return false;
  for (let i = 0; i < 33; i++) if (b[i] !== 0) return false;
  return true;
}

// Required (variant 0):
//   variant: 0
//   assetA, assetB        : 32-byte
//   deltaA, deltaB        : bigint > 0
//   shareAmount           : bigint > 0
//   shareCSecp            : 33 bytes
//   shareCBJJ             : 32 bytes
//   shareXcurveSigma      : 169 bytes
//   kernelSigA, kernelSigB: 64 bytes each
//   proof                 : Uint8Array (Groth16 proof bytes)
// Additional for variant 1 (POOL_INIT):
//   feeBps, vkCid, ceremonyCid, arbiterPubkeys, launcherSigs,
//   protocolFeeAddress, protocolFeeBps, poolMetaUri, poolCapabilityFlags
// T_PROTOCOL_FEE_CLAIM (0x31) — founder-pinned recipient mints accrued
// LP-fee skim as an lp_asset_id UTXO. Fixed 202-byte payload.
// Wire format:
//   opcode(1)=0x31 || pool_id(32) || claimer_pubkey_x_only(32)
//   || claim_amount_LE(8) || claim_C_secp(33) || claim_blinding(32)
//   || claim_sig(64)
//
// claim_sig is BIP-340 Schnorr over:
//   SHA256("tacit-amm-protocol-fee-claim-v1" || pool_id || amt_LE
//          || claim_C_secp || claim_blinding)
//
// Worker rejects if claimer_pubkey_x_only doesn't match the founder-pinned
// address recorded at POOL_INIT, or if claim_amount differs from the
// crystallized protocol_fee_accrued.
export function buildProtocolFeeClaimMsg({ poolIdBytes, claimAmount, claimCSecpBytes, claimBlindingBytes }) {
  const amtLE = new Uint8Array(8);
  let x = BigInt(claimAmount);
  for (let i = 0; i < 8; i++) { amtLE[i] = Number(x & 0xffn); x >>= 8n; }
  return sha256(concatBytes(
    _PROTOCOL_FEE_CLAIM_DOMAIN,
    poolIdBytes, amtLE, claimCSecpBytes, claimBlindingBytes,
  ));
}

export function encodeProtocolFeeClaim(args) {
  const poolId = asBytes(args.poolId, 32, 'poolId');
  const claimerXOnly = asBytes(args.claimerXOnly, 32, 'claimerXOnly');
  const claimCSecp = asBytes(args.claimCSecp, 33, 'claimCSecp');
  const claimBlinding = asBytes(args.claimBlinding, 32, 'claimBlinding');
  const claimSig = asBytes(args.claimSig, 64, 'claimSig');
  const amt = BigInt(args.claimAmount);
  if (amt <= 0n || amt >= 1n << 64n) throw new Error('claim_amount out of u64+ range');
  const amtLE = new Uint8Array(8);
  let x = amt;
  for (let i = 0; i < 8; i++) { amtLE[i] = Number(x & 0xffn); x >>= 8n; }
  return concatBytes(
    new Uint8Array([OPCODE_T_PROTOCOL_FEE_CLAIM]),
    poolId, claimerXOnly, amtLE, claimCSecp, claimBlinding, claimSig,
  );
}

// Decoder for T_PROTOCOL_FEE_CLAIM. Fixed 202-byte payload; bigint amount.
// Returns null on any structural mismatch (caller treats null as non-tacit).
export function decodeProtocolFeeClaim(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  if (payload.length !== 202) return null;
  if (payload[0] !== OPCODE_T_PROTOCOL_FEE_CLAIM) return null;
  const poolId = payload.slice(1, 33);
  const claimerXOnly = payload.slice(33, 65);
  let amt = 0n;
  for (let i = 0; i < 8; i++) amt |= BigInt(payload[65 + i]) << BigInt(i * 8);
  const claimCSecp = payload.slice(73, 106);
  const claimBlinding = payload.slice(106, 138);
  const claimSig = payload.slice(138, 202);
  return { poolId, claimerXOnly, claimAmount: amt, claimCSecp, claimBlinding, claimSig };
}

// T_LP_REMOVE (0x2E) — burn LP-share UTXO(s) for proportional withdrawal
// of pool reserves. Each receipt (A side + B side) carries a Pedersen
// commit on both curves + an XCurve sigma binding them to the same
// hidden amount. One kernel sig (LP side) proves the consumed LP-share
// UTXOs net to exactly share_amount · H_secp.
export function encodeLpRemove(args) {
  const parts = [
    new Uint8Array([OPCODE_T_LP_REMOVE]),
    asBytes(args.assetA, 32, 'assetA'),
    asBytes(args.assetB, 32, 'assetB'),
    u64LE(args.shareAmount),
    u64LE(args.deltaA),
    u64LE(args.deltaB),
    asBytes(args.recvACSecp, 33, 'recvACSecp'),
    asBytes(args.recvACBJJ, 32, 'recvACBJJ'),
    asBytes(args.recvAXcurveSigma, XCURVE_PROOF_LEN, 'recvAXcurveSigma'),
    asBytes(args.recvBCSecp, 33, 'recvBCSecp'),
    asBytes(args.recvBCBJJ, 32, 'recvBCBJJ'),
    asBytes(args.recvBXcurveSigma, XCURVE_PROOF_LEN, 'recvBXcurveSigma'),
    asBytes(args.kernelSigLP, 64, 'kernelSigLP'),
    // option-a opening blindings (reflection): recvACSecp opens to deltaA under rRecvA, recvBCSecp to deltaB
    // under rRecvB — so the relay can fold the withdrawal without an off-chain witness it cannot derive.
    asBytes(args.rRecvA, 32, 'rRecvA'),
    asBytes(args.rRecvB, 32, 'rRecvB'),
  ];
  const proof = args.proof;
  if (!(proof instanceof Uint8Array)) throw new Error('proof must be Uint8Array');
  if (proof.length > 0xffff) throw new Error('proof too large');
  parts.push(u16LE(proof.length), proof);
  return concatBytes(...parts);
}

export function encodeLpAdd(args) {
  const variant = args.variant;
  if (variant !== 0 && variant !== 1) throw new Error('variant must be 0 or 1');

  const parts = [
    new Uint8Array([OPCODE_T_LP_ADD, variant]),
    asBytes(args.assetA, 32, 'assetA'),
    asBytes(args.assetB, 32, 'assetB'),
    u64LE(args.deltaA),
    u64LE(args.deltaB),
    u64LE(args.shareAmount),
    asBytes(args.shareCSecp, 33, 'shareCSecp'),
    asBytes(args.shareCBJJ, 32, 'shareCBJJ'),
    asBytes(args.shareXcurveSigma, XCURVE_PROOF_LEN, 'shareXcurveSigma'),
    asBytes(args.kernelSigA, 64, 'kernelSigA'),
    asBytes(args.kernelSigB, 64, 'kernelSigB'),
    // option-a opening blinding (reflection): shareCSecp opens to the minted LP-share amount under shareR —
    // lets the relay fold the share-note mint without an off-chain witness. Sits before the variant-1 tail.
    asBytes(args.shareR, 32, 'shareR'),
  ];

  if (variant === 1) {
    if (typeof args.feeBps !== 'number' || args.feeBps < 0 || args.feeBps > FEE_BPS_MAX) {
      throw new Error(`feeBps must be 0..${FEE_BPS_MAX}`);
    }
    parts.push(u16LE(args.feeBps));
    const vkBytes = new TextEncoder().encode(args.vkCid);
    if (vkBytes.length < 1 || vkBytes.length > 64) throw new Error('vkCid length 1..64 bytes');
    parts.push(new Uint8Array([vkBytes.length]), vkBytes);
    const cerBytes = new TextEncoder().encode(args.ceremonyCid);
    if (cerBytes.length < 1 || cerBytes.length > 64) throw new Error('ceremonyCid length 1..64 bytes');
    parts.push(new Uint8Array([cerBytes.length]), cerBytes);
    const arb = args.arbiterPubkeys || [];
    if (arb.length > 16) throw new Error('arbiterPubkeys count 0..16');
    const arbM = args.arbiterThresholdM ?? (arb.length > 0 ? 1 : 0);
    if (arb.length === 0 && arbM !== 0) {
      throw new Error('arbiterThresholdM must be 0 when no arbiter pubkeys pinned');
    }
    if (arb.length > 0 && (arbM < 1 || arbM > arb.length)) {
      throw new Error(`arbiterThresholdM must be 1..${arb.length}`);
    }
    parts.push(new Uint8Array([arb.length, arbM]));
    for (const pk of arb) parts.push(asBytes(pk, 33, 'arbiterPubkey'));
    const lsigs = args.launcherSigs || [];
    if (lsigs.length > 2) throw new Error('launcherSigs count 0..2');
    parts.push(new Uint8Array([lsigs.length]));
    for (const sig of lsigs) parts.push(asBytes(sig, 64, 'launcherSig'));
    const protoAddr = args.protocolFeeAddress || PROTOCOL_FEE_ADDRESS_ZERO;
    parts.push(asBytes(protoAddr, 33, 'protocolFeeAddress'));
    const protoBps = args.protocolFeeBps || 0;
    if (typeof protoBps !== 'number' || protoBps < 0 || protoBps > PROTOCOL_FEE_BPS_MAX) {
      throw new Error(`protocolFeeBps must be 0..${PROTOCOL_FEE_BPS_MAX}`);
    }
    if (protoBps > 0 && isZeroAddress(protoAddr)) {
      throw new Error('protocolFeeBps > 0 requires non-zero protocolFeeAddress');
    }
    if (!isZeroAddress(protoAddr) && protoBps === 0) {
      throw new Error('non-zero protocolFeeAddress requires protocolFeeBps > 0');
    }
    parts.push(u16LE(protoBps));
    const metaUri = args.poolMetaUri ?? '';
    const metaBytes = new TextEncoder().encode(metaUri);
    if (metaBytes.length > 255) throw new Error('poolMetaUri length must be 0..255 bytes');
    parts.push(new Uint8Array([metaBytes.length]), metaBytes);
    const capFlags = args.poolCapabilityFlags ?? 0;
    if (capFlags < 0 || capFlags > 0xff) throw new Error('poolCapabilityFlags must be u8');
    // V1 pools fix capability_flags to 0x00. The byte is reserved in
    // the pool_id preimage so future opcodes (e.g. range-LP) can extend
    // the pool taxonomy without colliding with V1 pool_ids — see AMM.md
    // §"Forward compatibility". Any non-zero value would derive a pool_id
    // no V1 validator can interpret, so we reject at the encoder.
    if (capFlags !== 0) {
      throw new Error(`poolCapabilityFlags must be 0x00 for V1 pools (the byte is reserved in pool_id derivation for forward extensions)`);
    }
    parts.push(new Uint8Array([capFlags]));
  }

  const proof = args.proof;
  if (!(proof instanceof Uint8Array)) throw new Error('proof must be Uint8Array');
  if (proof.length > 0xffff) throw new Error('proof too large (> 65535 bytes)');
  parts.push(u16LE(proof.length), proof);

  return concatBytes(...parts);
}

// Minimal decoder for T_LP_ADD — returns the fields scanHoldings needs to
// recognize + recover the founder/recipient LP-share UTXO at vout[0].
// Returns null on any structural mismatch (caller treats null as non-tacit).
//
// For variant 1 (POOL_INIT) we also extract feeBps + poolCapabilityFlags so
// the recovery path can re-derive pool_id without consulting the registry.
// For variant 0 the dapp recovery path looks up pool_id by (assetA, assetB)
// from its cached pool list.
function _readU16LE(b, off) {
  return new DataView(b.buffer, b.byteOffset).getUint16(off, true);
}
function _readU64LE(b, off) {
  const dv = new DataView(b.buffer, b.byteOffset);
  return (BigInt(dv.getUint32(off + 4, true)) << 32n) | BigInt(dv.getUint32(off, true));
}
export function decodeLpAdd(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  if (payload.length < 2 + 32 + 32 + 8 + 8 + 8 + 33 + 32 + 169 + 64 + 64 + 32 + 2) return null;
  if (payload[0] !== OPCODE_T_LP_ADD) return null;
  const variant = payload[1];
  if (variant !== 0 && variant !== 1) return null;
  let off = 2;
  try {
    const assetA = payload.slice(off, off + 32); off += 32;
    const assetB = payload.slice(off, off + 32); off += 32;
    const deltaA = _readU64LE(payload, off); off += 8;
    const deltaB = _readU64LE(payload, off); off += 8;
    const shareAmount = _readU64LE(payload, off); off += 8;
    const shareCSecp = payload.slice(off, off + 33); off += 33;
    const shareCBJJ = payload.slice(off, off + 32); off += 32;
    // Capture the share xcurve sigma (binds shareCSecp ↔ shareCBJJ to the same
    // hidden value). The two 64-byte kernel sigs that follow are worker-side
    // (Σ C_in conservation); the dapp's value-binding uses the sigma + Groth16.
    const shareXcurveSigma = payload.slice(off, off + XCURVE_PROOF_LEN);
    off += XCURVE_PROOF_LEN + 64 + 64;
    const shareR = payload.slice(off, off + 32); off += 32; // option-a opening blinding (between header and the variant-1 tail)
    const result = { variant, assetA, assetB, deltaA, deltaB, shareAmount, shareCSecp, shareCBJJ, shareXcurveSigma, shareR };
    if (variant === 1) {
      if (off + 2 > payload.length) return null;
      result.feeBps = _readU16LE(payload, off); off += 2;
      if (result.feeBps > FEE_BPS_MAX) return null;
      const vkLen = payload[off++];
      if (vkLen < 1 || vkLen > 64) return null;
      off += vkLen;
      const cerLen = payload[off++];
      if (cerLen < 1 || cerLen > 64) return null;
      off += cerLen;
      const arbCount = payload[off++];
      if (arbCount > 16) return null;
      off += 1 + arbCount * 33;  // threshold + arbiter pubkeys
      const lsigCount = payload[off++];
      if (lsigCount > 2) return null;
      off += lsigCount * 64;
      off += 33;  // protocol_fee_address
      if (off + 2 > payload.length) return null;
      off += 2;  // protocol_fee_bps
      if (off + 1 > payload.length) return null;
      const metaLen = payload[off++];
      off += metaLen;
      if (off + 1 > payload.length) return null;
      result.poolCapabilityFlags = payload[off++];
    }
    // Tail: u16(proofLen) || proof. Skip if truncated (older callers don't
    // need proof; verifier callers check for presence).
    if (off + 2 <= payload.length) {
      const proofLen = _readU16LE(payload, off); off += 2;
      if (off + proofLen <= payload.length) {
        result.proof = payload.slice(off, off + proofLen);
      }
    }
    return result;
  } catch { return null; }
}

// Minimal decoder for T_LP_REMOVE — returns fields scanHoldings needs to
// recognize + recover the recipient's receive-A (vout[0]) and receive-B
// (vout[1]) UTXOs. pool_id is NOT carried in the envelope; recovery looks
// it up via canonical (assetA, assetB) from the dapp's pool registry.
export function decodeLpRemove(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  const minLen = 1 + 32 + 32 + 8 + 8 + 8 + 33 + 32 + 169 + 33 + 32 + 169 + 64 + 32 + 32 + 2;
  if (payload.length < minLen) return null;
  if (payload[0] !== OPCODE_T_LP_REMOVE) return null;
  let off = 1;
  try {
    const assetA = payload.slice(off, off + 32); off += 32;
    const assetB = payload.slice(off, off + 32); off += 32;
    const shareAmount = _readU64LE(payload, off); off += 8;
    const deltaA = _readU64LE(payload, off); off += 8;
    const deltaB = _readU64LE(payload, off); off += 8;
    const recvACSecp = payload.slice(off, off + 33); off += 33;
    const recvACBJJ = payload.slice(off, off + 32); off += 32;
    off += XCURVE_PROOF_LEN;
    const recvBCSecp = payload.slice(off, off + 33); off += 33;
    const recvBCBJJ = payload.slice(off, off + 32); off += 32;
    off += XCURVE_PROOF_LEN + 64;  // recvBXcurveSigma + kernelSigLP
    const rRecvA = payload.slice(off, off + 32); off += 32; // option-a opening blindings (between kernel sig and proof)
    const rRecvB = payload.slice(off, off + 32); off += 32;
    const result = { assetA, assetB, shareAmount, deltaA, deltaB, recvACSecp, recvACBJJ, recvBCSecp, recvBCBJJ, rRecvA, rRecvB };
    if (off + 2 <= payload.length) {
      const proofLen = _readU16LE(payload, off); off += 2;
      if (off + proofLen <= payload.length) {
        result.proof = payload.slice(off, off + proofLen);
      }
    }
    return result;
  } catch { return null; }
}

// ===== LP-bond yield farms (SPEC-AMM-FARM-AMENDMENT.md) =====
//
// T_FARM_INIT (0x34) / T_LP_BOND (0x35) / T_LP_UNBOND (0x36). Mirrors
// the byte layouts of tests/amm-farm.mjs encodeFarmInit / encodeLpBond /
// encodeLpUnbond exactly so worker decoders accept dapp envelopes.

export const OPCODE_T_FARM_INIT  = 0x34;
export const OPCODE_T_LP_BOND    = 0x35;
export const OPCODE_T_LP_UNBOND  = 0x36;
export const OPCODE_T_LP_HARVEST = 0x3B;  // claim reward without unbonding (SPEC §5.43)
export const OPCODE_T_FARM_REFUND = 0x3E; // launcher reclaims unspent treasury (SPEC §5.44)
// Farm-state attestation reuses T_INTENT_ATTEST (0x30) per SPEC §5.45
// (scope_id = farm_id, intent_pool_hash = buildFarmStateHash output).
export const FARM_NO_CHANGE_SENTINEL = new Uint8Array(33);

const _FARM_INIT_DOMAIN    = new TextEncoder().encode('tacit-amm-farm-init-v1');
const _FARM_BOND_DOMAIN    = new TextEncoder().encode('tacit-amm-farm-bond-v1');
const _FARM_UNBOND_DOMAIN  = new TextEncoder().encode('tacit-amm-farm-unbond-v1');
const _FARM_HARVEST_DOMAIN = new TextEncoder().encode('tacit-amm-farm-harvest-v1');
const _FARM_REFUND_DOMAIN  = new TextEncoder().encode('tacit-amm-farm-refund-v1');
const _FARM_STATE_DOMAIN   = new TextEncoder().encode('tacit-farm-state-v1');
const _LP_ASSET_DOMAIN     = new TextEncoder().encode('tacit-amm-lp-v1');

function u32LE(n) {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n >>> 0, true);
  return buf;
}
function u128LE(n) {
  const buf = new Uint8Array(16);
  let x = BigInt(n);
  if (x < 0n || x >= 1n << 128n) throw new Error('u128 overflow');
  for (let i = 0; i < 16; i++) { buf[i] = Number(x & 0xffn); x >>= 8n; }
  return buf;
}
function _readU128LE(b, off) {
  let n = 0n;
  for (let i = 0; i < 16; i++) n |= BigInt(b[off + i]) << BigInt(i * 8);
  return n;
}
function _readU32LE(b, off) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, true) >>> 0;
}

// farm_id = SHA256("tacit-amm-farm-init-v1" || pool_id || launcher_pubkey ||
//                   reward_asset_id || farm_nonce)
export function deriveFarmId({ poolId, launcherPubkey, rewardAssetId, farmNonce }) {
  return sha256(concatBytes(
    _FARM_INIT_DOMAIN,
    asBytes(poolId, 32, 'poolId'),
    asBytes(launcherPubkey, 33, 'launcherPubkey'),
    asBytes(rewardAssetId, 32, 'rewardAssetId'),
    asBytes(farmNonce, 32, 'farmNonce'),
  ));
}

export function deriveLpAssetIdFromPoolId(poolId) {
  return sha256(concatBytes(_LP_ASSET_DOMAIN, asBytes(poolId, 32, 'poolId')));
}

// Domain msg builders. Sigs bind structural fields only; OP_RETURN
// (SHA256(payload)) provides replay protection. Same convention as
// T_SWAP_VAR intent_msg.
export function buildFarmInitMsg({ farmId, launcherPubkey, rewardTotal, rewardPerBlock, startHeight, endHeight }) {
  return sha256(concatBytes(
    _FARM_INIT_DOMAIN,
    asBytes(farmId, 32, 'farmId'),
    asBytes(launcherPubkey, 33, 'launcherPubkey'),
    u64LE(rewardTotal), u64LE(rewardPerBlock),
    u32LE(startHeight), u32LE(endHeight),
  ));
}
export function buildLpBondMsg({ farmId, bonderPubkey, bondAmount, entryAccPerShare, bondViewHeight }) {
  return sha256(concatBytes(
    _FARM_BOND_DOMAIN,
    asBytes(farmId, 32, 'farmId'),
    asBytes(bonderPubkey, 33, 'bonderPubkey'),
    u64LE(bondAmount),
    u128LE(entryAccPerShare),
    u32LE(bondViewHeight),
  ));
}
export function buildLpUnbondMsg({ farmId, bondId, unbonderPubkey, exitAccPerShare, exitViewHeight, rewardAmount, lpReturnR, rewardR }) {
  return sha256(concatBytes(
    _FARM_UNBOND_DOMAIN,
    asBytes(farmId, 32, 'farmId'),
    asBytes(bondId, 36, 'bondId'),
    asBytes(unbonderPubkey, 33, 'unbonderPubkey'),
    u128LE(exitAccPerShare),
    u32LE(exitViewHeight),
    u64LE(rewardAmount),
    asBytes(lpReturnR, 32, 'lpReturnR'),
    asBytes(rewardR, 32, 'rewardR'),
  ));
}
export function buildLpHarvestMsg({ farmId, bondId, harvesterPubkey, exitAccPerShare, exitViewHeight, rewardAmount, rewardR }) {
  return sha256(concatBytes(
    _FARM_HARVEST_DOMAIN,
    asBytes(farmId, 32, 'farmId'),
    asBytes(bondId, 36, 'bondId'),
    asBytes(harvesterPubkey, 33, 'harvesterPubkey'),
    u128LE(exitAccPerShare),
    u32LE(exitViewHeight),
    u64LE(rewardAmount),
    asBytes(rewardR, 32, 'rewardR'),
  ));
}
export function buildFarmRefundMsg({ farmId, launcherPubkey, refundAmount, refundViewHeight, refundR }) {
  return sha256(concatBytes(
    _FARM_REFUND_DOMAIN,
    asBytes(farmId, 32, 'farmId'),
    asBytes(launcherPubkey, 33, 'launcherPubkey'),
    u64LE(refundAmount),
    u32LE(refundViewHeight),
    asBytes(refundR, 32, 'refundR'),
  ));
}

// Canonical farm-state hash for T_INTENT_ATTEST attestations (SPEC §5.45).
// Attesters publish this 32B value as the `intent_pool_hash` of a
// T_INTENT_ATTEST envelope with scope_id = farm_id.
export function buildFarmStateHash({ treasuryRemaining, totalBonded, accRewardPerShare }) {
  return sha256(concatBytes(
    _FARM_STATE_DOMAIN,
    u64LE(treasuryRemaining),
    u64LE(totalBonded),
    u128LE(accRewardPerShare),
  ));
}

export function encodeFarmInit(args) {
  const parts = [
    new Uint8Array([OPCODE_T_FARM_INIT]),
    asBytes(args.poolId, 32, 'poolId'),
    asBytes(args.farmNonce, 32, 'farmNonce'),
    asBytes(args.launcherPubkey, 33, 'launcherPubkey'),
    asBytes(args.rewardAssetId, 32, 'rewardAssetId'),
    u64LE(args.rewardTotal),
    u64LE(args.rewardPerBlock),
    u32LE(args.startHeight),
    u32LE(args.endHeight),
    asBytes(args.cChangeOrSentinel, 33, 'cChangeOrSentinel'),
  ];
  const proof = args.rangeProof;
  if (!(proof instanceof Uint8Array)) throw new Error('rangeProof must be Uint8Array');
  if (proof.length > 0xffff) throw new Error('rangeProof too large');
  parts.push(u16LE(proof.length), proof);
  parts.push(asBytes(args.kernelSig, 64, 'kernelSig'));
  parts.push(asBytes(args.launcherSig, 64, 'launcherSig'));
  return concatBytes(...parts);
}

export function encodeLpBond(args) {
  const parts = [
    new Uint8Array([OPCODE_T_LP_BOND]),
    asBytes(args.farmId, 32, 'farmId'),
    asBytes(args.bonderPubkey, 33, 'bonderPubkey'),
    u64LE(args.bondAmount),
    u128LE(args.entryAccPerShare),
    u32LE(args.bondViewHeight),
    asBytes(args.ownerCommit, 32, 'ownerCommit'), // blinded receipt owner (pubkey+b·G), PUBLIC so any prover
    asBytes(args.nonce, 32, 'nonce'),             // folds the bond trustlessly; fresh b per bond ⇒ unlinkable
    asBytes(args.cChangeOrSentinel, 33, 'cChangeOrSentinel'),
  ];
  const proof = args.rangeProof;
  if (!(proof instanceof Uint8Array)) throw new Error('rangeProof must be Uint8Array');
  if (proof.length > 0xffff) throw new Error('rangeProof too large');
  parts.push(u16LE(proof.length), proof);
  parts.push(asBytes(args.kernelSig, 64, 'kernelSig'));
  parts.push(asBytes(args.bonderSig, 64, 'bonderSig'));
  return concatBytes(...parts);
}

export function encodeLpUnbond(args) {
  // Trustless complete exit: the bond's RECEIPT (owner_commit, nonce, shares, rps_entry) + the lp-return note's
  // PUBLIC blinding ride the envelope, so any prover nullifies the receipt, drops shares, and mints the
  // shares-worth lp_asset note back. No reward (harvest first). Matches guest parse_lp_unbond_fields (217B).
  return concatBytes(
    new Uint8Array([OPCODE_T_LP_UNBOND]),
    asBytes(args.farmId, 32, 'farmId'),
    asBytes(args.ownerCommit, 32, 'ownerCommit'),
    asBytes(args.nonce, 32, 'nonce'),
    u64LE(args.shares),
    u128LE(args.rpsEntry),
    asBytes(args.lpReturnR, 32, 'lpReturnR'),
    asBytes(args.unbonderSig, 64, 'unbonderSig'),
  );
}

export function encodeLpHarvest(args) {
  return concatBytes(
    new Uint8Array([OPCODE_T_LP_HARVEST]),
    asBytes(args.farmId, 32, 'farmId'),
    asBytes(args.bondId, 36, 'bondId'),
    asBytes(args.harvesterPubkey, 33, 'harvesterPubkey'),
    u128LE(args.exitAccPerShare),
    u32LE(args.exitViewHeight),
    u64LE(args.rewardAmount),
    asBytes(args.rewardR, 32, 'rewardR'),
    asBytes(args.ownerCommit, 32, 'ownerCommit'), // OLD receipt's (owner, nonces, shares, rps_entry) ride the
    asBytes(args.oldNonce, 32, 'oldNonce'),       // PUBLIC envelope so any prover reconstructs + nullifies the
    asBytes(args.newNonce, 32, 'newNonce'),       // receipt + appends the advanced one — trustless harvest.
    u64LE(args.shares),
    u128LE(args.rpsEntry),
    asBytes(args.harvesterSig, 64, 'harvesterSig'),
  );
}

export function encodeFarmRefund(args) {
  return concatBytes(
    new Uint8Array([OPCODE_T_FARM_REFUND]),
    asBytes(args.farmId, 32, 'farmId'),
    asBytes(args.launcherPubkey, 33, 'launcherPubkey'),
    u64LE(args.refundAmount),
    u32LE(args.refundViewHeight),
    asBytes(args.refundR, 32, 'refundR'),
    asBytes(args.launcherSig, 64, 'launcherSig'),
  );
}

export function decodeFarmInit(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  if (payload.length < 315 + 2) return null;
  let p = 0;
  if (payload[p++] !== OPCODE_T_FARM_INIT) return null;
  try {
    const poolId          = payload.slice(p, p + 32); p += 32;
    const farmNonce       = payload.slice(p, p + 32); p += 32;
    const launcherPubkey  = payload.slice(p, p + 33); p += 33;
    if (launcherPubkey[0] !== 0x02 && launcherPubkey[0] !== 0x03) return null;
    const rewardAssetId   = payload.slice(p, p + 32); p += 32;
    const rewardTotal     = _readU64LE(payload, p); p += 8;
    const rewardPerBlock  = _readU64LE(payload, p); p += 8;
    const startHeight     = _readU32LE(payload, p); p += 4;
    const endHeight       = _readU32LE(payload, p); p += 4;
    const cChangeOrSentinel = payload.slice(p, p + 33); p += 33;
    const rpLen = _readU16LE(payload, p); p += 2;
    if (p + rpLen + 64 + 64 > payload.length) return null;
    const rangeProof   = payload.slice(p, p + rpLen); p += rpLen;
    const kernelSig    = payload.slice(p, p + 64); p += 64;
    const launcherSig  = payload.slice(p, p + 64); p += 64;
    if (p !== payload.length) return null;
    return {
      poolId, farmNonce, launcherPubkey, rewardAssetId,
      rewardTotal, rewardPerBlock, startHeight, endHeight,
      cChangeOrSentinel, rangeProof, kernelSig, launcherSig,
    };
  } catch { return null; }
}

export function decodeLpBond(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  if (payload.length < 255 + 2) return null;
  let p = 0;
  if (payload[p++] !== OPCODE_T_LP_BOND) return null;
  try {
    const farmId          = payload.slice(p, p + 32); p += 32;
    const bonderPubkey    = payload.slice(p, p + 33); p += 33;
    if (bonderPubkey[0] !== 0x02 && bonderPubkey[0] !== 0x03) return null;
    const bondAmount      = _readU64LE(payload, p); p += 8;
    const entryAccPerShare = _readU128LE(payload, p); p += 16;
    const bondViewHeight  = _readU32LE(payload, p); p += 4;
    const cChangeOrSentinel = payload.slice(p, p + 33); p += 33;
    const rpLen = _readU16LE(payload, p); p += 2;
    if (p + rpLen + 64 + 64 > payload.length) return null;
    const rangeProof = payload.slice(p, p + rpLen); p += rpLen;
    const kernelSig  = payload.slice(p, p + 64); p += 64;
    const bonderSig  = payload.slice(p, p + 64); p += 64;
    if (p !== payload.length) return null;
    return {
      farmId, bonderPubkey, bondAmount, entryAccPerShare, bondViewHeight,
      cChangeOrSentinel, rangeProof, kernelSig, bonderSig,
    };
  } catch { return null; }
}

export function decodeLpUnbond(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  if (payload.length !== 258) return null;
  let p = 0;
  if (payload[p++] !== OPCODE_T_LP_UNBOND) return null;
  try {
    const farmId          = payload.slice(p, p + 32); p += 32;
    const bondId          = payload.slice(p, p + 36); p += 36;
    const unbonderPubkey  = payload.slice(p, p + 33); p += 33;
    if (unbonderPubkey[0] !== 0x02 && unbonderPubkey[0] !== 0x03) return null;
    const exitAccPerShare = _readU128LE(payload, p); p += 16;
    const exitViewHeight  = _readU32LE(payload, p); p += 4;
    const rewardAmount    = _readU64LE(payload, p); p += 8;
    const lpReturnR       = payload.slice(p, p + 32); p += 32;
    const rewardR         = payload.slice(p, p + 32); p += 32;
    const unbonderSig     = payload.slice(p, p + 64); p += 64;
    if (p !== payload.length) return null;
    return {
      farmId, bondId, unbonderPubkey,
      exitAccPerShare, exitViewHeight, rewardAmount,
      lpReturnR, rewardR, unbonderSig,
    };
  } catch { return null; }
}

export function decodeLpHarvest(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  if (payload.length !== 226) return null;
  let p = 0;
  if (payload[p++] !== OPCODE_T_LP_HARVEST) return null;
  try {
    const farmId          = payload.slice(p, p + 32); p += 32;
    const bondId          = payload.slice(p, p + 36); p += 36;
    const harvesterPubkey = payload.slice(p, p + 33); p += 33;
    if (harvesterPubkey[0] !== 0x02 && harvesterPubkey[0] !== 0x03) return null;
    const exitAccPerShare = _readU128LE(payload, p); p += 16;
    const exitViewHeight  = _readU32LE(payload, p); p += 4;
    const rewardAmount    = _readU64LE(payload, p); p += 8;
    const rewardR         = payload.slice(p, p + 32); p += 32;
    const harvesterSig    = payload.slice(p, p + 64); p += 64;
    if (p !== payload.length) return null;
    return {
      farmId, bondId, harvesterPubkey,
      exitAccPerShare, exitViewHeight, rewardAmount,
      rewardR, harvesterSig,
    };
  } catch { return null; }
}

export function decodeFarmRefund(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  if (payload.length !== 174) return null;  // 1+32+33+8+4+32+64
  let p = 0;
  if (payload[p++] !== OPCODE_T_FARM_REFUND) return null;
  try {
    const farmId         = payload.slice(p, p + 32); p += 32;
    const launcherPubkey = payload.slice(p, p + 33); p += 33;
    if (launcherPubkey[0] !== 0x02 && launcherPubkey[0] !== 0x03) return null;
    const refundAmount   = _readU64LE(payload, p); p += 8;
    const refundViewHeight = _readU32LE(payload, p); p += 4;
    const refundR        = payload.slice(p, p + 32); p += 32;
    const launcherSig    = payload.slice(p, p + 64); p += 64;
    if (p !== payload.length) return null;
    return {
      farmId, launcherPubkey, refundAmount, refundViewHeight,
      refundR, launcherSig,
    };
  } catch { return null; }
}

// Q.96 lazy crystallization (mirrors tests/amm-farm.mjs crystallizeFarm).
// Used by the dapp to compute live pending rewards before /farm fetch.
// Mutates the farm object in place; idempotent at same height.
export const FARM_ACC_FIXED_POINT_SHIFT = 96n;
export function crystallizeFarm(farm, currentHeight) {
  const h = currentHeight > farm.end_height ? farm.end_height : currentHeight;
  if (h <= farm.last_update_height) return;
  if (h < farm.start_height) {
    farm.last_update_height = h;
    return;
  }
  const baseline = farm.last_update_height < farm.start_height
    ? farm.start_height
    : farm.last_update_height;
  const elapsed = BigInt(h - baseline);
  const totalBonded = BigInt(farm.total_bonded);
  if (totalBonded > 0n && elapsed > 0n) {
    const rewardUnits = elapsed * BigInt(farm.reward_per_block);
    const accDelta = (rewardUnits << FARM_ACC_FIXED_POINT_SHIFT) / totalBonded;
    farm.acc_reward_per_share = (BigInt(farm.acc_reward_per_share) + accDelta).toString();
  }
  farm.last_update_height = h;
}
