// Codec for Mode B — value-free Bitcoin-authorized Ethereum calls (SPEC-BITCOIN-HOOK-AMENDMENT §1.4).
// PURE (vendor-only imports, no tacit.js) so it is node-importable + unit-testable; the Bitcoin tx
// commit+reveal broadcaster lives in confidential-btc-call-actions.js (which imports the wallet/network).
//
// Two sides:
//   1. REQUEST (Bitcoin): the caller signs a Bitcoin tx carrying a `T_BTC_CALL` (0x68) Taproot envelope that
//      authorizes one Ethereum call — no asset, no value. The reflection proves it and records the
//      commitment in ConfidentialPool.pendingBtcCall.
//   2. FIRE (Ethereum): anyone calls BtcCallExecutor.executeBtcCall(callId, target, callerPubkey, data).
//
// The 0x68 envelope is 201 bytes:
//   executor(20) ‖ target(20) ‖ calldataHash(32) ‖ callerPubkey(32, x-only) ‖ callNonce(32) ‖ sig(64)
// The BIP-340 `sig` (by callerPubkey) is over keccak("tacit-btc-call-v1" ‖ executor ‖ target ‖ calldataHash ‖
// callerPubkey ‖ callNonce) — binding the call to ONE executor (deployment), so it can never replay onto a
// different pool/chain. callId = keccak(callerPubkey ‖ callNonce); recordHash = keccak(executor ‖ target ‖
// calldataHash ‖ callerPubkey) — byte-identical to the executor's keccak(abi.encodePacked(address(this),
// target, calldataHash, callerPubkey)) check.

import { keccak_256, concatBytes, hexToBytes, bytesToHex } from './vendor/tacit-deps.min.js';

const CALL_DOMAIN = new TextEncoder().encode('tacit-btc-call-v1');

// Normalize an address / hash / calldata arg to bytes. Accepts a Uint8Array or a hex string (0x-prefixed
// or not). `len` (when given) asserts the byte length — addresses are 20, hashes/keys/nonces are 32.
function toBytes(v, len) {
  let b;
  if (v instanceof Uint8Array) b = v;
  else if (typeof v === 'string') b = hexToBytes(v.startsWith('0x') ? v.slice(2) : v);
  else throw new Error('btc-call: expected bytes or hex string');
  if (len != null && b.length !== len) throw new Error(`btc-call: expected ${len} bytes, got ${b.length}`);
  return b;
}

function randomNonce() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return b;
}

// Build the 0x68 envelope payload + the derived (callId, recordHash). `executor`/`target` are 20-byte
// Ethereum addresses, `calldata` the Ethereum call bytes, `callNonce` an optional 32-byte caller nonce.
// `callerPubkey` is the 32-byte x-only (even-y) Bitcoin signer; `sign` is `(msg32) => sig64` (BIP-340).
export function encodeBtcCallEnvelope({ executor, target, calldata, callNonce, callerPubkey, sign }) {
  const exec = toBytes(executor, 20);
  const tgt = toBytes(target, 20);
  const data = toBytes(calldata);
  const nonce = callNonce ? toBytes(callNonce, 32) : randomNonce();
  const caller = toBytes(callerPubkey, 32);
  const calldataHash = keccak_256(data);

  const msg = keccak_256(concatBytes(CALL_DOMAIN, exec, tgt, calldataHash, caller, nonce));
  const sig = sign(msg); // BIP-340, verified in-guest by bip340_verify
  if (!(sig instanceof Uint8Array) || sig.length !== 64) throw new Error('btc-call: sign must return a 64-byte sig');

  const payload = concatBytes(new Uint8Array([0x68]), exec, tgt, calldataHash, caller, nonce, sig);
  if (payload.length !== 201) throw new Error(`btc-call: bad payload length ${payload.length}`);

  const callId = keccak_256(concatBytes(caller, nonce));
  const recordHash = keccak_256(concatBytes(exec, tgt, calldataHash, caller));
  return {
    payload,
    callId: '0x' + bytesToHex(callId),
    recordHash: '0x' + bytesToHex(recordHash),
    calldataHash: '0x' + bytesToHex(calldataHash),
    callerPubkey: '0x' + bytesToHex(caller),
    callNonce: '0x' + bytesToHex(nonce),
  };
}

// ── Ethereum side: encode BtcCallExecutor.executeBtcCall(bytes32,address,bytes32,bytes) ──
const EXECUTE_SELECTOR = keccak_256(
  new TextEncoder().encode('executeBtcCall(bytes32,address,bytes32,bytes)'),
).slice(0, 4);

function word32(b) {
  const out = new Uint8Array(32);
  out.set(b.subarray(0, 32), 32 - Math.min(b.length, 32));
  return out;
}

function u256word(n) {
  const out = new Uint8Array(32);
  let x = BigInt(n);
  for (let i = 31; i >= 0 && x > 0n; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

// Build the calldata for a permissionless executeBtcCall on the named executor. `callId` and `callerPubkey`
// come from encodeBtcCallEnvelope; `target` + `calldata` are the (public) Ethereum call. Returns
// { to, data } — `to` is the executor; submit it as a normal Ethereum tx (no value).
export function encodeExecuteBtcCall({ executor, callId, target, callerPubkey, calldata }) {
  const id = toBytes(callId, 32);
  const tgt = word32(toBytes(target, 20));
  const caller = toBytes(callerPubkey, 32);
  const data = toBytes(calldata);

  // head: callId(32) ‖ target(32) ‖ callerPubkey(32) ‖ offset(32 = 0x80) ; tail: len(32) ‖ data(padded)
  const offset = u256word(0x80);
  const len = u256word(data.length);
  const padded = new Uint8Array(Math.ceil(data.length / 32) * 32);
  padded.set(data);

  const blob = concatBytes(EXECUTE_SELECTOR, id, tgt, caller, offset, len, padded);
  return { to: '0x' + bytesToHex(toBytes(executor, 20)), data: '0x' + bytesToHex(blob) };
}
