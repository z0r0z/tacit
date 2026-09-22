// Dapp-side T_CROSSOUT_MINT broadcast seam (task #5). After a
// confidential-pool bridge_burn (ETH→BTC) the wallet knows the destination note (cx, cy, owner) and the
// claimId, and broadcasts the Bitcoin T_CROSSOUT_MINT (0x65) envelope so the reflection prover folds it
// (and the worker's /hint dispatch indexes it). Dependency-injected on the existing Taproot commit/reveal
// broadcast machinery (the same encodeEnvelopeScript → commit/reveal → broadcast path the bridge deposit
// uses) + postHint, so it is testable and tacit.js keeps the wallet/broadcast specifics. Gated on the
// burn flow, which supplies {assetId, claimId, cx, cy, owner}.
//
//   buildAndBroadcastEnvelope(payloadBytes) => Promise<{ txid, vout? }>  — Taproot commit/reveal of the envelope
//   postHint(txid, vout) => Promise<any>                                  — fast-track the worker /hint (0x65)

import { encodeCrossoutMint } from './confidential-crossout-consumer.js';

export function makeCrossoutBroadcaster({ buildAndBroadcastEnvelope, postHint }) {
  if (typeof buildAndBroadcastEnvelope !== 'function') throw new Error('crossout-broadcast: inject buildAndBroadcastEnvelope');
  return async function broadcastCrossoutMint({ assetId, claimId, cx, cy, owner }) {
    const payload = encodeCrossoutMint({ assetId, claimId, cx, cy, owner }); // 161 bytes, opcode 0x65
    const res = (await buildAndBroadcastEnvelope(payload)) || {};
    const txid = res.txid;
    const vout = res.vout ?? 0;
    if (!txid) throw new Error('crossout-broadcast: no txid from broadcast');
    // The Bitcoin broadcast above already happened and can't be undone — a postHint failure (e.g. a
    // transient fetch error to the worker) must not make this function throw away that txid, or a caller
    // that treats the rejection as "nothing happened" would retry and double-broadcast. The worker's own
    // scan picks the envelope up regardless, so postHint is a fast-track only, not required for correctness.
    let hinted = true;
    if (postHint) { try { await postHint(txid, vout); } catch { hinted = false; } }
    return { txid, vout, claimId, payloadLen: payload.length, status: 'broadcast', hinted };
  };
}
