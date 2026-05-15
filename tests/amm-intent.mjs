// Intent message construction + signing + cancel + envelope_hash + qualifying_set_hash.
//
// Per AMM.md §"Cross-asset authorization for swaps" — canonical intent_msg
// commits to all settler-substitutable fields so the trader's BIP-340 sig
// binds the intent to a single pool, direction, input set, commitment pair,
// and tip/min_out/expiry parameters.
//
// canonical intent_msg layout:
//   domain_tag         -- "tacit-amm-intent-v1" (UTF-8)
//   pool_id            -- 32 B
//   direction          -- 1 B (0 = A→B, 1 = B→A)
//   input_utxos[]      -- length-prefixed: count u8, then [txid_BE(32) || vout_LE(4)] each
//   C_in_secp          -- 33 B (compressed) — aggregate of input UTXO commitments
//   C_in_BJJ           -- 32 B (compressed BabyJubJub point) — aux Pedersen commit
//   xcurve_sigma_proof -- 169 B (sigma proof binding C_in_secp and C_in_BJJ)
//   receive_scriptPubKey -- length-prefixed: count u16_LE, then bytes
//   min_out            -- 8 B (u64 LE)
//   tip_amount         -- 8 B (u64 LE)
//   tip_asset          -- 1 B (0 = asset_A, 1 = asset_B)
//   expiry_height      -- 4 B (u32 LE)
//   trader_pubkey      -- 33 B (compressed)
//
// intent_id = sha256(intent_msg).

import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

import { signSchnorr, verifySchnorr } from './composition.mjs';
import { XCURVE_PROOF_LEN } from './amm-sigma-xcurve.mjs';

const DOMAIN_INTENT = new TextEncoder().encode('tacit-amm-intent-v1');
const DOMAIN_INTENT_CANCEL = new TextEncoder().encode('tacit-amm-intent-cancel-v1');
const DOMAIN_QSET = new TextEncoder().encode('tacit-amm-qset-v1');

function asBytes(x, len, name) {
  const b = x instanceof Uint8Array ? x : hexToBytes(x);
  if (b.length !== len) throw new Error(`${name} must be ${len} bytes (got ${b.length})`);
  return b;
}
function reverseBytes(b) { const r = new Uint8Array(b); r.reverse(); return r; }
function u32LE(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}
function u64LE(n) {
  const b = new Uint8Array(8);
  let x = BigInt(n);
  if (x < 0n || x >= 1n << 64n) throw new Error('u64 overflow');
  for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}
function u16LE(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return b;
}
function outpointBytes(op) {
  const txidBE = reverseBytes(hexToBytes(op.txid));
  return concatBytes(txidBE, u32LE(op.vout));
}

// Encode the canonical intent_msg.
//
// Required fields:
//   poolId(32), direction (0|1), inputUtxos [{txid,vout}], cInSecp(33), cInBjj(32),
//   xcurveSigma(169), receiveScriptPubKey(Uint8Array, ≤ 65535 bytes), minOut(bigint),
//   tipAmount(bigint), tipAsset(0|1), expiryHeight(u32), traderPubkey(33).
export function buildIntentMsg({
  poolId, direction, inputUtxos, cInSecp, cInBjj, xcurveSigma,
  receiveScriptPubKey, minOut, tipAmount, tipAsset, expiryHeight, traderPubkey,
}) {
  const pid = asBytes(poolId, 32, 'poolId');
  if (direction !== 0 && direction !== 1) throw new Error('direction must be 0 or 1');
  if (tipAsset !== 0 && tipAsset !== 1) throw new Error('tipAsset must be 0 or 1');
  // Audit LOW-3: AMM.md §"Tip mechanics" §3 normatively requires tip_asset
  // to equal direction (tip is paid on the input side). The validator
  // hardcodes this when reconstructing intent_msg for sig verification, so a
  // trader who signs with a divergent tip_asset cannot have their intent
  // verified. We make the constraint explicit here to surface a clear error
  // instead of an opaque sig-verify failure when a builder gets this wrong.
  if (tipAsset !== direction) {
    throw new Error(
      `tipAsset (${tipAsset}) must equal direction (${direction}) per AMM.md ` +
      `"Tip mechanics" §3 — tip is always on the input side.`,
    );
  }
  if (!Array.isArray(inputUtxos) || inputUtxos.length === 0 || inputUtxos.length > 255) {
    throw new Error('inputUtxos: 1..255 entries required');
  }
  const cs = asBytes(cInSecp, 33, 'cInSecp');
  const cb = asBytes(cInBjj, 32, 'cInBjj');
  const xs = asBytes(xcurveSigma, XCURVE_PROOF_LEN, 'xcurveSigma');
  const tpk = asBytes(traderPubkey, 33, 'traderPubkey');
  if (!(receiveScriptPubKey instanceof Uint8Array)) throw new Error('receiveScriptPubKey must be Uint8Array');
  if (receiveScriptPubKey.length > 0xffff) throw new Error('receiveScriptPubKey too large (> 65535 bytes)');

  const parts = [
    DOMAIN_INTENT,
    pid,
    new Uint8Array([direction]),
    new Uint8Array([inputUtxos.length]),
  ];
  for (const op of inputUtxos) parts.push(outpointBytes(op));
  parts.push(cs, cb, xs);
  parts.push(u16LE(receiveScriptPubKey.length));
  parts.push(receiveScriptPubKey);
  parts.push(u64LE(minOut));
  parts.push(u64LE(tipAmount));
  parts.push(new Uint8Array([tipAsset]));
  parts.push(u32LE(expiryHeight));
  parts.push(tpk);
  return concatBytes(...parts);
}

// intent_id = SHA256(intent_msg). 32-byte canonical identifier used for
// vin/vout ordering and (qualifying_set_hash, intent_sig) input.
export function deriveIntentId(intentMsg) {
  if (!(intentMsg instanceof Uint8Array)) throw new Error('intentMsg must be Uint8Array');
  return sha256(intentMsg);
}

// intent_sig is BIP-340 over the intent_msg under trader_pubkey's x-only form.
// Pass the trader's full 32-byte privkey; the function handles parity adjustment.
export function signIntent(intentMsg, traderPrivkey32, taggedHashOverride = null) {
  const sig = signSchnorr(sha256(intentMsg), traderPrivkey32);
  return sig;
}
export function verifyIntent(intentMsg, intentSig64, traderPubkey33) {
  const pk = asBytes(traderPubkey33, 33, 'traderPubkey');
  // BIP-340 verify under x-only key. Compressed form's parity is captured by the
  // first byte (0x02 = even-y / 0x03 = odd-y). For BIP-340 verification we use
  // x-only; verifySchnorr accepts 32-byte x-only.
  return verifySchnorr(intentSig64, sha256(intentMsg), pk.subarray(1));
}

// Intent cancellation message (BIP-340 over this hash by trader_pubkey).
//   cancel_msg_hash = SHA256("tacit-amm-intent-cancel-v1" || pool_id || intent_id)
export function buildIntentCancelMsg({ poolId, intentId }) {
  const pid = asBytes(poolId, 32, 'poolId');
  const iid = asBytes(intentId, 32, 'intentId');
  return sha256(concatBytes(DOMAIN_INTENT_CANCEL, pid, iid));
}
export function signIntentCancel({ poolId, intentId }, traderPrivkey32) {
  return signSchnorr(buildIntentCancelMsg({ poolId, intentId }), traderPrivkey32);
}
export function verifyIntentCancel({ poolId, intentId, sig64, traderPubkey33 }) {
  const pk = asBytes(traderPubkey33, 33, 'traderPubkey');
  return verifySchnorr(sig64, buildIntentCancelMsg({ poolId, intentId }), pk.subarray(1));
}

// envelope_hash = SHA256(envelope_payload).
// Used as the `vout[0]` OP_RETURN data in T_SWAP_BATCH, binding the trader's
// SIGHASH_ALL signature to the envelope content.
export function computeEnvelopeHash(envelopePayload) {
  if (!(envelopePayload instanceof Uint8Array)) throw new Error('envelopePayload must be Uint8Array');
  return sha256(envelopePayload);
}

// qualifying_set_hash for arbiter-pinned pools:
//   sha256("tacit-amm-qset-v1" || pool_id || height_LE(4) || canonical_list_bytes)
// where canonical_list_bytes is the sorted-by-intent_id, length-prefixed
// concatenation of qualifying intent_ids.
export function buildCanonicalListBytes(intentIds) {
  // Each intent_id is 32 bytes. Sort ascending by byte order, then prefix with
  // a u16 count, then concatenate.
  const sorted = intentIds.map(id => asBytes(id, 32, 'intentId'))
                          .sort((a, b) => {
                            for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
                            return 0;
                          });
  if (sorted.length > 0xff) throw new Error('canonical list too large (> 255 intents)');
  // u8 count prefix per AMM.md §"On-chain commitment to the canonical list"
  // — matches the validator's computeQualifyingSetHash. N_MAX=16 fits in u8.
  const parts = [new Uint8Array([sorted.length])];
  for (const id of sorted) parts.push(id);
  return concatBytes(...parts);
}

export function computeQualifyingSetHash({ poolId, height, intentIds }) {
  const pid = asBytes(poolId, 32, 'poolId');
  const h = u32LE(height);
  const list = buildCanonicalListBytes(intentIds);
  return sha256(concatBytes(DOMAIN_QSET, pid, h, list));
}

// Arbiter sig over the qualifying_set_hash (BIP-340 under one of the pool's
// pinned arbiter pubkeys).
export function signQualifyingSet({ poolId, height, intentIds }, arbiterPrivkey32) {
  return signSchnorr(computeQualifyingSetHash({ poolId, height, intentIds }), arbiterPrivkey32);
}
export function verifyQualifyingSet({ poolId, height, intentIds, sig64, arbiterPubkey33 }) {
  const pk = asBytes(arbiterPubkey33, 33, 'arbiterPubkey');
  return verifySchnorr(sig64, computeQualifyingSetHash({ poolId, height, intentIds }), pk.subarray(1));
}
