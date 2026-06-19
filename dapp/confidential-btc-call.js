// Dapp builder for Mode B — value-free Bitcoin-authorized Ethereum calls (SPEC-BITCOIN-HOOK-AMENDMENT §1.4).
//
// Two sides:
//   1. REQUEST (Bitcoin): the caller signs a Bitcoin tx carrying a `T_BTC_CALL` (0x68) Taproot envelope that
//      authorizes one Ethereum call — no asset, no value. The reflection proves it and records the
//      commitment in ConfidentialPool.pendingBtcCall. Mirrors amm-farm-actions.js's commit+reveal envelope tx
//      (value-free: no asset input, no extra outputs).
//   2. FIRE (Ethereum): anyone calls BtcCallExecutor.executeBtcCall(callId, target, callerPubkey, data); this
//      module builds that calldata. The executor verifies the call against the pool's commitment and fires
//      target.onBitcoinReflect(data, 0, callerPubkey).
//
// The 0x68 envelope is 201 bytes:
//   executor(20) ‖ target(20) ‖ calldataHash(32) ‖ callerPubkey(32, x-only) ‖ callNonce(32) ‖ sig(64)
// The BIP-340 `sig` (by callerPubkey) is over keccak("tacit-btc-call-v1" ‖ executor ‖ target ‖ calldataHash ‖
// callerPubkey ‖ callNonce) — binding the call to ONE executor (deployment), so it can never replay onto a
// different pool/chain. callId = keccak(callerPubkey ‖ callNonce); recordHash = keccak(executor ‖ target ‖
// calldataHash ‖ callerPubkey) — byte-identical to the executor's keccak(abi.encodePacked(address(this),
// target, calldataHash, callerPubkey)) check.

import {
  wallet, ensurePrivkey, getUtxos, getFeeRate, feeFor,
  broadcast, broadcastWithRetry, DUST,
  encodeEnvelopeScript, tapLeafHash, tweakedOutputKey,
  controlBlock, p2trScript, p2wpkhScript, TAP_NUMS,
  signP2wpkhInput, signTaprootScriptPathInput,
  serializeTx, txid as computeTxid,
  estCommitVb, sortSatsForCommit, signSchnorr,
} from './tacit.js';

import { keccak_256, concatBytes, hexToBytes, bytesToHex, sha256 } from './vendor/tacit-deps.min.js';

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
// Pure (no wallet/network) so it's unit-testable; broadcastBtcCall supplies callerPubkey + sign from `wallet`.
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

// Broadcast the value-free request: a commit+reveal pair that inscribes the 0x68 envelope in the reveal's
// Taproot witness (the reflection reads it there). No asset input, no value output — the caller pays only
// Bitcoin fees. Returns the txids + the call identifiers the Ethereum side needs.
export async function broadcastBtcCall({ executor, target, calldata, callNonce }) {
  await ensurePrivkey();
  const built = encodeBtcCallEnvelope({
    executor, target, calldata, callNonce,
    callerPubkey: wallet.xonly(),
    sign: (m) => signSchnorr(m, wallet.priv),
  });
  const { payload } = built;

  const envelopeScript = encodeEnvelopeScript(wallet.xonly(), payload);
  const tapLeaf = tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, tapLeaf);
  const commitSpk = p2trScript(Q_xonly);
  const cb = controlBlock(TAP_NUMS, parity);

  const feeRate = await getFeeRate();
  const envelopeHash = sha256(payload);
  const opReturnSpk = concatBytes(new Uint8Array([0x6a, 0x20]), envelopeHash);

  // Reveal: 1 taproot input (the commit) + 1 OP_RETURN. No asset vin, no dust outs.
  const revealVbBase = 11 + 41 + 34;
  const revealVb = revealVbBase + Math.ceil((1 + 1 + 65 + 3 + 45 + payload.length + 34 + 109) / 4);
  const revealFee = feeFor(revealVb, feeRate);
  const commitValue = Math.max(DUST, revealFee);

  const allUtxos = await getUtxos(wallet.address());
  const sats = sortSatsForCommit(allUtxos.filter(u => u.value > DUST));
  const picked = []; let total = 0; let commitFee = 500;
  for (const u of sats) {
    picked.push(u); total += u.value;
    commitFee = feeFor(estCommitVb(picked.length), feeRate);
    if (total >= commitValue + commitFee + DUST) break;
  }
  if (total < commitValue + commitFee) {
    throw new Error(`insufficient sats for btc-call: need ${commitValue + commitFee}, have ${total} (across ${picked.length} confirmed UTXOs)`);
  }
  const changeSats = total - commitValue - commitFee;
  const changeSpk = p2wpkhScript(wallet.pub);

  const commitOutputs = [{ value: commitValue, script: commitSpk }];
  if (changeSats >= DUST) commitOutputs.push({ value: changeSats, script: changeSpk });
  const commitTx = {
    version: 2, locktime: 0,
    inputs: picked.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: commitOutputs,
  };
  for (let i = 0; i < commitTx.inputs.length; i++) {
    commitTx.inputs[i].witness = signP2wpkhInput(commitTx, i, picked[i].value);
  }
  const commitHex = bytesToHex(serializeTx(commitTx));
  const commitTxidHex = computeTxid(commitTx);

  const revealTx = {
    version: 2, locktime: 0,
    inputs: [{ txid: commitTxidHex, vout: 0, sequence: 0xfffffffd, witness: [] }],
    outputs: [{ value: 0, script: opReturnSpk }],
  };
  revealTx.inputs[0].witness = signTaprootScriptPathInput(
    revealTx, [{ value: commitValue, script: commitSpk }], envelopeScript, cb,
  );
  const revealHex = bytesToHex(serializeTx(revealTx));
  const revealTxidHex = computeTxid(revealTx);

  await broadcast(commitHex);
  await broadcastWithRetry(revealHex);
  return {
    commitTxid: commitTxidHex,
    revealTxid: revealTxidHex,
    callId: built.callId,
    recordHash: built.recordHash,
    callerPubkey: built.callerPubkey,
    target: '0x' + bytesToHex(toBytes(target, 20)),
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

// Build the calldata for a permissionless executeBtcCall on the named executor. `callId` and `callerPubkey`
// come from broadcastBtcCall / encodeBtcCallEnvelope; `target` + `calldata` are the (public) Ethereum call.
// Returns { to, data } — `to` is the executor; submit it as a normal Ethereum tx (no value).
export function encodeExecuteBtcCall({ executor, callId, target, callerPubkey, calldata }) {
  const id = toBytes(callId, 32);
  const tgt = word32(toBytes(target, 20));
  const caller = toBytes(callerPubkey, 32);
  const data = toBytes(calldata);

  // head: callId(32) ‖ target(32) ‖ callerPubkey(32) ‖ offset(32 = 0x80) ; tail: len(32) ‖ data(padded)
  const offset = word32(new Uint8Array([0x80]));
  const len = word32(new Uint8Array([
    (data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff,
  ]));
  const padded = new Uint8Array(Math.ceil(data.length / 32) * 32);
  padded.set(data);

  const blob = concatBytes(EXECUTE_SELECTOR, id, tgt, caller, offset, len, padded);
  return { to: '0x' + bytesToHex(toBytes(executor, 20)), data: '0x' + bytesToHex(blob) };
}
