// AMM envelope encoder — dapp-side port of tests/amm-envelope.mjs (LP_ADD +
// LP_REMOVE only, swap encoders live in tacit.js's existing SWAP_VAR path).
// Byte-for-byte identical to the test reference so worker decoder accepts
// dapp-produced payloads.

import { concatBytes, hexToBytes } from './vendor/tacit-deps.min.js';
import { XCURVE_PROOF_LEN } from './amm-sigma.js';

export const OPCODE_T_LP_ADD     = 0x2D;
export const OPCODE_T_LP_REMOVE  = 0x2E;
export const FEE_BPS_MAX           = 1000;
export const PROTOCOL_FEE_BPS_MAX  = 1000;
export const PROTOCOL_FEE_ADDRESS_ZERO = new Uint8Array(33);

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
    parts.push(new Uint8Array([capFlags]));
  }

  const proof = args.proof;
  if (!(proof instanceof Uint8Array)) throw new Error('proof must be Uint8Array');
  if (proof.length > 0xffff) throw new Error('proof too large (> 65535 bytes)');
  parts.push(u16LE(proof.length), proof);

  return concatBytes(...parts);
}
