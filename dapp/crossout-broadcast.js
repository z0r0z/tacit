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
//
// A crossOut's Bitcoin-side claim is checked once, at scan time, against whatever the reflection worker's
// current eth-state view covers — unlike a bridge burn, there is no persisted retry if you're early (see
// BUILD-A-TACIT-DAPP.md §5f for why: a burn's uniqueness comes from spending a real Bitcoin UTXO, a
// crossOut's claim has no such guarantee). waitForCrossOutCoverage/completeCrossOutOnBitcoin below exist so
// a caller doesn't have to get that timing right by hand.

import { encodeCrossoutMint } from './confidential-crossout-consumer.js';

export function makeCrossoutBroadcaster({ buildAndBroadcastEnvelope, postHint, workerBase, fetchImpl } = {}) {
  if (typeof buildAndBroadcastEnvelope !== 'function') throw new Error('crossout-broadcast: inject buildAndBroadcastEnvelope');
  const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

  async function broadcastCrossoutMint({ assetId, claimId, cx, cy, owner }) {
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
  }

  // Poll GET /reflection/eth-state/covers until the crossOut's own Ethereum block is covered by the
  // reflection worker's current eth-state view. onUpdate(body) fires on each status change, matching the
  // waitForSettle/waitForProof convention elsewhere in this SDK. Resolves with the covers response once
  // covered=true; throws on timeout rather than silently returning uncovered, so a caller can't mistake a
  // timeout for a green light.
  async function waitForCrossOutCoverage({ network = 'mainnet', block, intervalMs = 30000, timeoutMs = 3 * 60 * 60 * 1000, onUpdate, sleep } = {}) {
    if (!workerBase) throw new Error('crossout-broadcast: waitForCrossOutCoverage needs workerBase');
    if (!f) throw new Error('crossout-broadcast: no fetch implementation');
    if (!Number.isFinite(block) || block <= 0) throw new Error('crossout-broadcast: block (the crossOut settle\'s own block number) is required');
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      const res = await f(`${workerBase}/reflection/eth-state/covers?network=${network}&block=${block}`);
      const body = await res.json();
      const status = body.covered ? 'covered' : 'waiting';
      if (status !== last) { last = status; if (onUpdate) onUpdate(body); }
      if (body.covered) return body;
      if (Date.now() > deadline) throw new Error(`crossOut coverage wait timed out after ${Math.round(timeoutMs / 60000)}min — check /reflection/eth-state before retrying rather than assuming it's safe to broadcast`);
      await wait(intervalMs);
    }
  }

  // Convenience: wait for coverage, then broadcast. `block` is the crossOut()'s own returned `ethBlock`.
  async function completeCrossOutOnBitcoin({ block, assetId, claimId, cx, cy, owner, network = 'mainnet', waitOpts } = {}) {
    await waitForCrossOutCoverage({ network, block, ...waitOpts });
    return broadcastCrossoutMint({ assetId, claimId, cx, cy, owner });
  }

  // The return value is still the callable broadcastCrossoutMint function itself (existing callers are
  // unaffected) — the new capabilities hang off it as properties rather than changing the return shape.
  broadcastCrossoutMint.waitForCrossOutCoverage = waitForCrossOutCoverage;
  broadcastCrossoutMint.completeCrossOutOnBitcoin = completeCrossOutOnBitcoin;
  return broadcastCrossoutMint;
}
