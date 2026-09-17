// Cross-validates the Mode B dapp codec (dapp/confidential-btc-call.js) against the byte formats the SP1
// guest (cxfer-core fold_btc_call / parse_btc_call_envelope) and the Solidity BtcCallExecutor expect.
// SPEC-BITCOIN-HOOK-AMENDMENT §1.4.
import assert from 'node:assert';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { concatBytes, hexToBytes, bytesToHex } from '../node_modules/@noble/hashes/utils.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { signSchnorr, verifySchnorr } from './composition.mjs';
import { encodeBtcCallEnvelope, encodeExecuteBtcCall } from '../dapp/confidential-btc-call.js';

let passed = 0;
function test(label, fn) { fn(); passed++; console.log('  ✓', label); }

const priv = hexToBytes('11'.repeat(32));
const callerPubkey = secp.getPublicKey(priv, true).slice(1); // 32-byte x-only (the x of P=priv·G)
const executor = hexToBytes('aa'.repeat(20));
const target = hexToBytes('bb'.repeat(20));
const calldata = hexToBytes('deadbeef');
const callNonce = hexToBytes('33'.repeat(32));
const DOMAIN = new TextEncoder().encode('tacit-btc-call-v2');
const chainBinding = hexToBytes('7c'.repeat(32)); // keccak(chainid ‖ pool) of the deployment the call is for
const calldataHash = keccak_256(calldata);

const built = encodeBtcCallEnvelope({
  chainBinding, executor, target, calldata, callNonce, callerPubkey,
  sign: (m) => signSchnorr(m, priv),
});

test('envelope is 201 bytes, op 0x68, fields at the guest parse offsets', () => {
  assert.equal(built.payload.length, 201);
  assert.equal(built.payload[0], 0x68);
  assert.deepEqual(built.payload.subarray(1, 21), executor);
  assert.deepEqual(built.payload.subarray(21, 41), target);
  assert.deepEqual(built.payload.subarray(41, 73), calldataHash);
  assert.deepEqual(built.payload.subarray(73, 105), callerPubkey);
  assert.deepEqual(built.payload.subarray(105, 137), callNonce);
  assert.equal(built.payload.subarray(137, 201).length, 64);
});

test('embedded sig is a valid BIP-340 sig over the call message (guest bip340_verify accepts)', () => {
  const msg = keccak_256(concatBytes(DOMAIN, chainBinding, executor, target, calldataHash, callerPubkey, callNonce));
  assert.ok(verifySchnorr(built.payload.subarray(137, 201), msg, callerPubkey));
});

test('callId + recordHash match the guest fold_btc_call derivation', () => {
  assert.equal(built.callId, '0x' + bytesToHex(keccak_256(concatBytes(callerPubkey, callNonce))));
  assert.equal(built.recordHash, '0x' + bytesToHex(keccak_256(concatBytes(executor, target, calldataHash, callerPubkey))));
});

test('recordHash == executor keccak(abi.encodePacked(address(this), target, calldataHash, callerPubkey))', () => {
  // address(this) = executor(20), target(20), calldataHash(32), callerPubkey(32) — abi.encodePacked layout
  assert.equal(built.recordHash, '0x' + bytesToHex(keccak_256(concatBytes(executor, target, calldataHash, callerPubkey))));
});

test('encodeExecuteBtcCall: selector + ABI(bytes32,address,bytes32,bytes) layout', () => {
  const { to, data } = encodeExecuteBtcCall({
    executor, callId: built.callId, target, callerPubkey: built.callerPubkey, calldata,
  });
  assert.equal(to, '0x' + bytesToHex(executor));
  const blob = hexToBytes(data.slice(2));
  const selector = keccak_256(new TextEncoder().encode('executeBtcCall(bytes32,address,bytes32,bytes)')).slice(0, 4);
  assert.deepEqual(blob.subarray(0, 4), selector, 'selector');
  assert.deepEqual(blob.subarray(4, 36), hexToBytes(built.callId.slice(2)), 'callId word');
  assert.deepEqual(blob.subarray(48, 68), target, 'target right-aligned in its word');
  assert.deepEqual(blob.subarray(68, 100), callerPubkey, 'callerPubkey word');
  assert.equal(blob[131], 0x80, 'bytes offset = 0x80');
  assert.equal(blob[163], calldata.length, 'bytes length');
  assert.deepEqual(blob.subarray(164, 164 + calldata.length), calldata, 'calldata tail');
});

test('a different executor yields a different recordHash (no cross-deployment replay)', () => {
  const other = encodeBtcCallEnvelope({
    chainBinding, executor: hexToBytes('cc'.repeat(20)), target, calldata, callNonce, callerPubkey,
    sign: (m) => signSchnorr(m, priv),
  });
  assert.notEqual(other.recordHash, built.recordHash);
  assert.equal(other.callId, built.callId, 'callId is executor-independent (caller+nonce only)');
});

test('the signature binds the deployment: the same call signed for another chain binding verifies under neither the other message nor this one', () => {
  const otherChain = hexToBytes('7d'.repeat(32));
  const forOther = encodeBtcCallEnvelope({ chainBinding: otherChain, executor, target, calldata, callNonce, callerPubkey, sign: (m) => signSchnorr(m, priv) });
  const msgHere = keccak_256(concatBytes(DOMAIN, chainBinding, executor, target, calldataHash, callerPubkey, callNonce));
  assert.equal(verifySchnorr(forOther.payload.subarray(137, 201), msgHere, callerPubkey), false, 'a signature for another deployment does not verify here');
  assert.equal(forOther.recordHash, built.recordHash, 'the record is identical, so the signature is what pins the deployment');
});

test('a chain binding is required', () => {
  assert.throws(() => encodeBtcCallEnvelope({ executor, target, calldata, callNonce, callerPubkey, sign: (m) => signSchnorr(m, priv) }), /expected bytes/);
});

console.log(`\nconfidential-btc-call: ${passed} passed`);
