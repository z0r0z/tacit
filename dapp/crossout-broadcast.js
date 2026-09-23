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
  //
  // The default interval matches the endpoint's own refill rate (its bucket is a 60-token burst that
  // refills one token per minute), so a long wait can't outrun its own budget. A faster interval spends
  // the burst in the first half hour and then 429s for the rest of the wait — and since a throttled
  // response carries no `covered` field, polling through one looks exactly like "not covered yet". That
  // misreads a self-inflicted rate limit as a protocol state, which on this particular endpoint is the
  // difference between waiting and broadcasting a claim that can never be folded. Handle 429 explicitly:
  // honour the server's Retry-After, never count it as an answer, and name it in the timeout.
  async function waitForCrossOutCoverage({ network = 'mainnet', block, intervalMs = 60000, timeoutMs = 3 * 60 * 60 * 1000, onUpdate, sleep } = {}) {
    if (!workerBase) throw new Error('crossout-broadcast: waitForCrossOutCoverage needs workerBase');
    if (!f) throw new Error('crossout-broadcast: no fetch implementation');
    if (!Number.isFinite(block) || block <= 0) throw new Error('crossout-broadcast: block (the crossOut settle\'s own block number) is required');
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let throttled = 0;
    for (;;) {
      const res = await f(`${workerBase}/reflection/eth-state/covers?network=${network}&block=${block}`);
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      // A throttled or errored poll is not an answer about coverage. Back off and ask again rather than
      // letting a missing `covered` field read as "still waiting". The `covered` field itself is the
      // test for a real answer — a response that carries one is authoritative whatever else it says.
      if (!body || typeof body.covered !== 'boolean') {
        throttled += 1;
        const retryAfter = Number(body && body.retryAfter) || Number(res.headers && res.headers.get && res.headers.get('Retry-After')) || 0;
        if (Date.now() > deadline) break;
        await wait(Math.max(intervalMs, retryAfter * 1000));
        continue;
      }
      const status = body.covered ? 'covered' : 'waiting';
      if (status !== last) { last = status; if (onUpdate) onUpdate(body); }
      if (body.covered) return body;
      if (Date.now() > deadline) break;
      await wait(intervalMs);
    }
    const why = throttled
      ? ` — ${throttled} poll(s) were rate-limited or unreadable, so this may be a polling problem rather than a protocol state; slow intervalMs down`
      : '';
    throw new Error(`crossOut coverage wait timed out after ${Math.round(timeoutMs / 60000)}min${why} — check /reflection/eth-state before retrying rather than assuming it's safe to broadcast`);
  }

  // Convenience: wait for coverage, then broadcast. Pass the whole crossOut() result — `block` is its
  // `ethBlock` and `claimIdVerified` is its corroboration flag — so both gates are checked from one object:
  //
  //   completeCrossOutOnBitcoin({ ...r, ...r.crossOuts[0] })
  //
  // Coverage is only half of "safe to broadcast". The other half is that the claimId being broadcast is the
  // one the pool actually recorded: fold_crossout hashes claim_id into its membership check, so a reveal
  // built from a predicted-but-wrong claimId can never fold, and there is no on-chain error anywhere to say
  // so. crossOut() corroborates its prediction against the real CrossOutRecorded event and reports the
  // outcome; refuse to broadcast when it could not. `claimIdVerified: true` can be passed explicitly by a
  // caller that corroborated the claimId some other way.
  async function completeCrossOutOnBitcoin({ block, assetId, claimId, cx, cy, owner, network = 'mainnet', waitOpts, claimIdVerified, claimIdNote } = {}) {
    if (claimIdVerified !== true) {
      throw new Error('refusing to broadcast a crossOut mint whose claimId was not corroborated against the '
        + `CrossOutRecorded event (${claimIdNote || 'claimIdVerified was not set'}). A reveal built from a wrong `
        + 'claimId can never fold and fails silently — re-read the settle receipt and retry, or pass '
        + 'claimIdVerified: true if you have corroborated it yourself.');
    }
    await waitForCrossOutCoverage({ network, block, ...waitOpts });
    return broadcastCrossoutMint({ assetId, claimId, cx, cy, owner });
  }

  // The return value is still the callable broadcastCrossoutMint function itself (existing callers are
  // unaffected) — the new capabilities hang off it as properties rather than changing the return shape.
  broadcastCrossoutMint.waitForCrossOutCoverage = waitForCrossOutCoverage;
  broadcastCrossoutMint.completeCrossOutOnBitcoin = completeCrossOutOnBitcoin;
  return broadcastCrossoutMint;
}
