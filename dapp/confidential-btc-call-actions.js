// Bitcoin-side broadcaster for Mode B value-free calls (SPEC-BITCOIN-HOOK-AMENDMENT §1.4). Imports the
// wallet/network from tacit.js; the pure 0x68 codec is in confidential-btc-call.js. Mirrors
// amm-farm-actions.js's commit+reveal envelope tx, value-free (no asset input, no value output).

import {
  wallet, ensurePrivkey, getUtxos, getFeeRate, feeFor,
  broadcast, broadcastWithRetry, DUST,
  encodeEnvelopeScript, tapLeafHash, tweakedOutputKey,
  controlBlock, p2trScript, p2wpkhScript, TAP_NUMS,
  signP2wpkhInput, signTaprootScriptPathInput,
  serializeTx, txid as computeTxid,
  estCommitVb, sortSatsForCommit, signSchnorr,
} from './tacit.js';
import { concatBytes, bytesToHex, sha256 } from './vendor/tacit-deps.min.js';
import { encodeBtcCallEnvelope } from './confidential-btc-call.js';

// Broadcast the value-free request: a commit+reveal pair that inscribes the 0x68 envelope in the reveal's
// Taproot witness (the reflection reads it there). No asset input, no value output — the caller pays only
// Bitcoin fees. Returns the txids + the identifiers the Ethereum executeBtcCall needs.
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
    target: typeof target === 'string' ? (target.startsWith('0x') ? target : '0x' + target) : '0x' + bytesToHex(target),
  };
}
