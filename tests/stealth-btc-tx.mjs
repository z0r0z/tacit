// Minimal Bitcoin tx builder used by stealth signet harnesses.
// P2WPKH + P2TR key-path inputs/outputs; BIP-143 / BIP-341 sighash.
// Standalone — does not import from dapp/tacit.js so it doesn't
// collide with concurrent dapp work.

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export const hash160 = b => ripemd160(sha256(b));
export const p2wpkhScript = pubkey => concatBytes(new Uint8Array([0x00, 0x14]), hash160(pubkey));
export const p2trScript = xOnly32 => concatBytes(new Uint8Array([0x51, 0x20]), xOnly32);

export function txidLEBytes(hex) {
  const b = hexToBytes(hex);
  const r = new Uint8Array(32);
  for (let i = 0; i < 32; i++) r[i] = b[31 - i];
  return r;
}

export const u8 = n => new Uint8Array([n & 0xff]);
export const u16le = n => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; };
export const u32le = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
export function u64le(n) {
  const b = new Uint8Array(8);
  const big = BigInt(n);
  new DataView(b.buffer).setUint32(0, Number(big & 0xffffffffn), true);
  new DataView(b.buffer).setUint32(4, Number((big >> 32n) & 0xffffffffn), true);
  return b;
}
export function varint(n) {
  if (n < 0xfd) return u8(n);
  if (n <= 0xffff) return concatBytes(u8(0xfd), u16le(n));
  if (n <= 0xffffffff) return concatBytes(u8(0xfe), u32le(n));
  return concatBytes(u8(0xff), u64le(n));
}

// BIP-143 sighash for P2WPKH SIGHASH_ALL.
export function bip143SighashP2wpkh({ tx, inputIndex, prevoutScript, prevoutValue }) {
  const hashPrevouts = sha256(sha256(concatBytes(
    ...tx.inputs.flatMap(i => [txidLEBytes(i.txid), u32le(i.vout)]),
  )));
  const hashSequence = sha256(sha256(concatBytes(...tx.inputs.map(i => u32le(i.sequence)))));
  const hashOutputs = sha256(sha256(concatBytes(
    ...tx.outputs.flatMap(o => [u64le(o.value), varint(o.script.length), o.script]),
  )));
  const inp = tx.inputs[inputIndex];
  // scriptCode = OP_DUP OP_HASH160 <20-byte program> OP_EQUALVERIFY OP_CHECKSIG
  const program = prevoutScript.slice(2);
  const scriptCode = concatBytes(
    new Uint8Array([0x76, 0xa9, 0x14]), program, new Uint8Array([0x88, 0xac]),
  );
  const preimage = concatBytes(
    u32le(tx.version),
    hashPrevouts, hashSequence,
    txidLEBytes(inp.txid), u32le(inp.vout),
    varint(scriptCode.length), scriptCode,
    u64le(prevoutValue),
    u32le(inp.sequence),
    hashOutputs,
    u32le(tx.locktime),
    u32le(1),  // SIGHASH_ALL
  );
  return sha256(sha256(preimage));
}

// BIP-341 sighash for P2TR key-path SIGHASH_DEFAULT.
//   prevouts: array of { value, script } for ALL inputs (BIP-341 requires
//             sha_amounts + sha_scriptpubkeys over the full prevout set).
export function bip341SighashKeyPath({ tx, inputIndex, prevouts }) {
  const sha_prevouts = sha256(concatBytes(
    ...tx.inputs.flatMap(i => [txidLEBytes(i.txid), u32le(i.vout)]),
  ));
  const sha_amounts = sha256(concatBytes(...prevouts.map(p => u64le(p.value))));
  const sha_scriptpubkeys = sha256(concatBytes(
    ...prevouts.map(p => concatBytes(varint(p.script.length), p.script)),
  ));
  const sha_sequences = sha256(concatBytes(...tx.inputs.map(i => u32le(i.sequence))));
  const sha_outputs = sha256(concatBytes(
    ...tx.outputs.flatMap(o => [u64le(o.value), varint(o.script.length), o.script]),
  ));
  const preimage = concatBytes(
    new Uint8Array([0x00]),        // sighash epoch
    new Uint8Array([0x00]),        // SIGHASH_DEFAULT (= ALL)
    u32le(tx.version),
    u32le(tx.locktime),
    sha_prevouts, sha_amounts, sha_scriptpubkeys, sha_sequences, sha_outputs,
    new Uint8Array([0x00]),        // spend_type: key-path, no annex
    u32le(inputIndex),
  );
  return taggedHash('TapSighash', preimage);
}

function taggedHash(tag, ...msgs) {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(tagHash, tagHash, ...msgs));
}

// =============================================================================
//                         Signatures
// =============================================================================

// ECDSA-DER signature for P2WPKH SIGHASH_ALL.
export function ecdsaSignDER(msgHash32, priv32) {
  const sig = secp.sign(msgHash32, priv32, { lowS: true });
  return derEncodeSig(sig.r, sig.s);
}

function derEncodeSig(r, s) {
  const rBytes = bigintTo32Bytes(r);
  const sBytes = bigintTo32Bytes(s);
  const rTrim = trimLeadingZeros(rBytes);
  const sTrim = trimLeadingZeros(sBytes);
  const rPad = (rTrim[0] & 0x80) ? concatBytes(new Uint8Array([0x00]), rTrim) : rTrim;
  const sPad = (sTrim[0] & 0x80) ? concatBytes(new Uint8Array([0x00]), sTrim) : sTrim;
  const body = concatBytes(
    new Uint8Array([0x02, rPad.length]), rPad,
    new Uint8Array([0x02, sPad.length]), sPad,
  );
  return concatBytes(new Uint8Array([0x30, body.length]), body);
}
function bigintTo32Bytes(n) {
  let hex = n.toString(16);
  while (hex.length < 64) hex = '0' + hex;
  return hexToBytes(hex);
}
function trimLeadingZeros(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  return bytes.slice(i);
}

// BIP-340 Schnorr signature.
export function schnorrSign(msgHash32, priv32) {
  // noble v2: secp.schnorr.sign returns 64-byte sig.
  const aux = crypto.getRandomValues(new Uint8Array(32));
  return secp.schnorr.sign(msgHash32, priv32, aux);
}

// Sign a P2WPKH input — returns witness [sig+sighash, pubkey].
export function signP2wpkhInput({ tx, inputIndex, prevoutScript, prevoutValue, priv, pub }) {
  const sh = bip143SighashP2wpkh({ tx, inputIndex, prevoutScript, prevoutValue });
  const der = ecdsaSignDER(sh, priv);
  return [concatBytes(der, new Uint8Array([0x01])), pub];
}

// Sign a P2TR key-path input — returns witness [schnorr-sig].
//   priv: 32-byte SCALAR — caller must ensure it corresponds to the
//         even-Y form of the pubkey (BIP-340). For tweaked secrets,
//         caller negates if the tweaked pubkey has odd Y.
//   prevouts: array of { value, script } for ALL inputs in tx.
export function signP2trKeyPathInput({ tx, inputIndex, prevouts, priv }) {
  // Even-Y normalization: BIP-340 requires the signer's pubkey to have
  // even Y. If pubkey from priv*G has odd Y, negate priv.
  const Pt = secp.ProjectivePoint.BASE.multiply(BigInt('0x' + bytesToHex(priv)));
  const pubBytes = Pt.toRawBytes(true);
  let signingPriv = priv;
  if (pubBytes[0] === 0x03) {
    // Odd Y; negate the scalar.
    const d = BigInt('0x' + bytesToHex(priv));
    const negated = SECP_N - d;
    let hex = negated.toString(16); while (hex.length < 64) hex = '0' + hex;
    signingPriv = hexToBytes(hex);
  }
  const sh = bip341SighashKeyPath({ tx, inputIndex, prevouts });
  const sig = schnorrSign(sh, signingPriv);
  return [sig];  // BIP-341 key-path witness is just the 64-byte sig
}

// =============================================================================
//                         Tx serialization
// =============================================================================

export function serializeTx(tx) {
  const parts = [u32le(tx.version)];
  const hasWitness = tx.inputs.some(i => i.witness && i.witness.length > 0);
  if (hasWitness) parts.push(new Uint8Array([0x00, 0x01]));
  parts.push(varint(tx.inputs.length));
  for (const i of tx.inputs) {
    parts.push(txidLEBytes(i.txid));
    parts.push(u32le(i.vout));
    parts.push(varint(0));
    parts.push(u32le(i.sequence));
  }
  parts.push(varint(tx.outputs.length));
  for (const o of tx.outputs) {
    parts.push(u64le(o.value));
    parts.push(varint(o.script.length));
    parts.push(o.script);
  }
  if (hasWitness) {
    for (const i of tx.inputs) {
      const w = i.witness || [];
      parts.push(varint(w.length));
      for (const item of w) {
        parts.push(varint(item.length));
        parts.push(item);
      }
    }
  }
  parts.push(u32le(tx.locktime));
  return concatBytes(...parts);
}

export function txid(tx) {
  const parts = [u32le(tx.version), varint(tx.inputs.length)];
  for (const i of tx.inputs) {
    parts.push(txidLEBytes(i.txid));
    parts.push(u32le(i.vout));
    parts.push(varint(0));
    parts.push(u32le(i.sequence));
  }
  parts.push(varint(tx.outputs.length));
  for (const o of tx.outputs) {
    parts.push(u64le(o.value));
    parts.push(varint(o.script.length));
    parts.push(o.script);
  }
  parts.push(u32le(tx.locktime));
  const h = sha256(sha256(concatBytes(...parts)));
  const r = new Uint8Array(32);
  for (let i = 0; i < 32; i++) r[i] = h[31 - i];
  return bytesToHex(r);
}

// =============================================================================
//                         Mempool API helpers
// =============================================================================

export const DEFAULT_MEMPOOL = 'https://mempool.space/signet/api';

export async function getUtxos(address, mempool = DEFAULT_MEMPOOL) {
  const r = await fetch(`${mempool}/address/${address}/utxo`);
  if (!r.ok) throw new Error(`mempool utxo fetch ${r.status}: ${address}`);
  return await r.json();
}

export async function broadcast(hex, mempool = DEFAULT_MEMPOOL) {
  const r = await fetch(`${mempool}/tx`, {
    method: 'POST', body: hex,
    headers: { 'Content-Type': 'text/plain' },
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`broadcast ${r.status}: ${body}`);
  return body.trim();
}

export async function getTx(txid, mempool = DEFAULT_MEMPOOL) {
  const r = await fetch(`${mempool}/tx/${txid}`);
  if (!r.ok) return null;
  return await r.json();
}

export async function waitForConfirm(txid, timeoutMs = 1_200_000, mempool = DEFAULT_MEMPOOL) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await getTx(txid, mempool);
    if (t?.status?.confirmed) return t;
    await new Promise(r => setTimeout(r, 8000));
    process.stdout.write('.');
  }
  throw new Error(`timeout waiting for ${txid} to confirm`);
}
