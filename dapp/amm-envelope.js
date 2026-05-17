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
    // Pre-launch guard. The 0x01 (RANGE_ATTEST-gated LP_ADD) and 0x02
    // (POOL_CAP_SOLO_INTENT_ALLOWED) bits are drafted in AMM.md but the
    // worker validator does NOT yet enforce them — setting a bit creates
    // a pool labelled with the flag but offering no actual semantic gate.
    // Reject here so callers can't accidentally rely on a non-functional
    // capability. Remove this guard when the corresponding validator
    // branches ship in a follow-up amendment.
    if (capFlags !== 0) {
      throw new Error(`poolCapabilityFlags=${capFlags} is drafted but not enforced by the worker pre-launch; only 0x00 is valid for now`);
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
  if (payload.length < 2 + 32 + 32 + 8 + 8 + 8 + 33 + 32 + 169 + 64 + 64 + 2) return null;
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
    off += 32 + XCURVE_PROOF_LEN + 64 + 64;
    const result = { variant, assetA, assetB, deltaA, deltaB, shareAmount, shareCSecp };
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
    return result;
  } catch { return null; }
}

// Minimal decoder for T_LP_REMOVE — returns fields scanHoldings needs to
// recognize + recover the recipient's receive-A (vout[0]) and receive-B
// (vout[1]) UTXOs. pool_id is NOT carried in the envelope; recovery looks
// it up via canonical (assetA, assetB) from the dapp's pool registry.
export function decodeLpRemove(payload) {
  if (!(payload instanceof Uint8Array)) return null;
  const minLen = 1 + 32 + 32 + 8 + 8 + 8 + 33 + 32 + 169 + 33 + 32 + 169 + 64 + 2;
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
    off += 32 + XCURVE_PROOF_LEN;
    const recvBCSecp = payload.slice(off, off + 33); off += 33;
    return { assetA, assetB, shareAmount, deltaA, deltaB, recvACSecp, recvBCSecp };
  } catch { return null; }
}
