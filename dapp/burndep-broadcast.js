// Dapp-side BTC→ETH burn-deposit broadcast seam — the counterpart to crossout-broadcast.js's ETH→BTC path.
//
// A burn-deposit reveal's ~161-byte envelope and the note it burns are locked to the same Bitcoin input:
// the guest defines the burned outpoint as the tx's first spent input (reflect.rs), and the envelope is
// read from that same input's witness item 1 (extract_taproot_envelope) — so the two can't be split across
// inputs, and the envelope can't be pre-committed into the note's own home script either, since it names
// that note's own outpoint, which doesn't exist yet when the note is created. Either way the item carrying
// the envelope ends up well over Bitcoin Core's 80-byte standardness cap for witness arguments, so ordinary
// relay (mempool.space, blockstream.info) won't carry it. This is a structural property of the current,
// immutable guest, not a symptom of a badly-homed note — every burn-deposit that has actually landed went
// out via MARA Slipstream, which accepts non-standard-but-consensus-valid transactions from a miner-side
// queue instead of the p2p relay policy path. See docs/BUILD-A-TACIT-DAPP.md §5f for the fuller picture.
//
// This module is a thin, dependency-injected client for that path plus the worker's own /reflection/burndep
// registration, so integrators don't have to hand-roll either.

const SLIPSTREAM_BASE = 'https://slipstream.mara.com';

export function makeBurnDepositBroadcaster({ workerBase, fetchImpl, slipstreamBase = SLIPSTREAM_BASE } = {}) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!f) throw new Error('burndep-broadcast: no fetch implementation');

  // A resubmission of the same tx is acknowledged as success and keeps its queue position (MARA's own
  // docs), so this is safe to call again from a caller that lost track of whether an earlier call landed.
  async function submitToSlipstream(txHex) {
    if (!txHex || typeof txHex !== 'string') throw new Error('burndep-broadcast: txHex required');
    const res = await f(`${slipstreamBase}/api/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tx_hex: txHex }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`burndep-broadcast: slipstream submit failed (${res.status}): ${JSON.stringify(body)}`);
    return body;
  }

  // Poll until `checkConfirmed` (an injected real chain lookup, e.g. against a public esplora or the
  // worker's own /chain/tx endpoint) reports the tx landed. MARA's own status endpoint is polled alongside
  // it purely for progress reporting (onUpdate) — its queue entry can go stale once a tx clears, whether
  // mined or dropped, so it's not trustworthy as the actual exit condition on its own.
  async function waitForBurnDepositMined({ txid, checkConfirmed, intervalMs = 30000, timeoutMs = 6 * 60 * 60 * 1000, onUpdate, sleep } = {}) {
    if (!txid) throw new Error('burndep-broadcast: txid required');
    if (typeof checkConfirmed !== 'function') throw new Error('burndep-broadcast: inject checkConfirmed(txid) => Promise<boolean>');
    const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      const confirmed = await checkConfirmed(txid);
      if (confirmed) {
        if (onUpdate && last !== 'confirmed') onUpdate({ status: 'confirmed', txid });
        return { confirmed: true, txid };
      }
      let slipstream = null;
      try {
        const res = await f(`${slipstreamBase}/api/transactions/status?tx_id=${txid}`);
        slipstream = await res.json();
      } catch { /* best-effort progress only; checkConfirmed is the real signal */ }
      const label = slipstream && slipstream.position ? 'queued' : 'unseen';
      if (label !== last) { last = label; if (onUpdate) onUpdate({ status: label, txid, slipstream }); }
      if (Date.now() > deadline) {
        throw new Error(`burndep-broadcast: not confirmed after ${Math.round(timeoutMs / 60000)}min — check ${slipstreamBase}/api/transactions/status?tx_id=${txid} before resubmitting`);
      }
      await wait(intervalMs);
    }
  }

  // Permissionless (no box-token) — anyone can reconstruct their own burn's provenance from public Bitcoin
  // data and the guest re-verifies it in-zkVM regardless, so this is a liveness convenience (help the
  // batch-builder find the burn quickly), not a trust boundary.
  async function registerBurnDeposit({ burnTxidDisplay, bundle, network = 'mainnet' } = {}) {
    if (!workerBase) throw new Error('burndep-broadcast: registerBurnDeposit needs workerBase');
    if (!burnTxidDisplay || !bundle) throw new Error('burndep-broadcast: burnTxidDisplay and bundle required');
    const res = await f(`${workerBase}/reflection/burndep?network=${network}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ burnTxidDisplay, bundle }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(`burndep-broadcast: registration failed: ${JSON.stringify(body)}`);
    return body;
  }

  // Submit → wait for real confirmation → register, in that order. Matches the waitOpts/onUpdate
  // convention crossout-broadcast.js uses for the reverse direction.
  async function completeBurnDepositToEthereum({ txHex, txid, burnTxidDisplay, bundle, network = 'mainnet', checkConfirmed, waitOpts } = {}) {
    const submitResult = await submitToSlipstream(txHex);
    await waitForBurnDepositMined({ txid, checkConfirmed, ...waitOpts });
    const registered = await registerBurnDeposit({ burnTxidDisplay: burnTxidDisplay || txid, bundle, network });
    return { submitResult, registered };
  }

  return { submitToSlipstream, waitForBurnDepositMined, registerBurnDeposit, completeBurnDepositToEthereum };
}
