// Optimistic pending-swap overlay + reconcile-on-scan for the confidential pool dapp.
//
// A confidential swap is deterministic at submit (the client knows its expected output from the reserves it
// saw), but settlement takes ~minutes (box SP1 proof + on-chain). So we show the result immediately and let
// the indexer scan confirm or roll it back in the background. The whole thing survives a tab close because a
// pending record is persisted and resolved purely from ON-CHAIN state — never from a relay job that might be
// lost on a worker restart.
//
// State machine:
//   proving ──▶ settling ──▶ (scan sees input ν spent) SETTLED  [record dropped; real note is in the scan]
//        └─────────────────▶ (relay error / timeout)    FAILED   [overlay rolled back; kept until dismiss()]
//
// Source of truth = the indexer's `spent` set (input note's nullifier consumed ⇒ the swap landed). The relay
// job status is only a faster hint for the progress UI. Drops into:
//   - dapp/confidential-relay.js : submitOp() → jobId, waitForSettle(jobId,{onUpdate})
//   - dapp/confidential-indexer.js: index(events) → { leaves, spent:Set }, then memo.scan(...) → active notes
//
// Inject { storage } = a localStorage-like { getItem, setItem }; { relay } only for drive() (progress UI);
// { now } a clock (injectable for tests). All amounts are bigint-or-string; kept as-is, compared as strings.

export function makeConfidentialPendingSwaps({ storage, relay = null, now = () => Date.now() }) {
  const KEY = 'tacit:pending-swaps:v1';
  const SETTLE_TIMEOUT_MS = 6 * 60 * 1000; // past this with the input ν still unspent ⇒ treat as failed

  const load = () => { try { return JSON.parse(storage.getItem(KEY) || '{}'); } catch { return {}; } };
  const save = (m) => storage.setItem(KEY, JSON.stringify(m));
  const lc = (h) => String(h).toLowerCase();
  const _set = (id, patch) => { const m = load(); if (m[id]) { m[id] = { ...m[id], ...patch }; save(m); } };

  // Open a pending swap at submit time.
  //   swap = {
  //     jobId,                                       // relay.submitOp response id (progress polling)
  //     in:  { nullifier, asset, value },            // the spent pool note — reconcile key (ν ∈ spent ⇒ landed)
  //     out: { leaf, asset, value, minOut, ... },    // the EXPECTED output note + its opening (optimistic show)
  //   }
  function open(swap) {
    if (!swap || !swap.jobId || !swap.in?.nullifier || !swap.out) throw new Error('pending-swap: jobId + in.nullifier + out required');
    const m = load();
    m[swap.jobId] = { ...swap, status: 'proving', createdAt: now(), txHash: null, error: null };
    save(m);
    return swap.jobId;
  }

  // Drive the progress UI off the relay. Optional + purely cosmetic — reconcile() is authoritative, so a swap
  // still resolves correctly if this is never called (or the relay loses the job). onChange(record) per change.
  async function drive(id, { onChange, sleep } = {}) {
    if (!relay) throw new Error('pending-swap: drive() needs { relay } injected');
    const rec = load()[id]; if (!rec) return;
    const fire = () => onChange && onChange(load()[id]);
    try {
      await relay.waitForSettle(rec.jobId, {
        sleep,
        onUpdate: (st) => {                                   // st.status: pending|proving|settled|failed
          const ui = st.status === 'settled' ? 'settling' : st.status === 'pending' ? 'proving' : st.status;
          _set(id, { status: ui, txHash: st.txHash || null }); fire();
        },
      });
      _set(id, { status: 'settling' }); fire();              // worker acked the tx; wait for the scan to confirm
    } catch (e) {
      _set(id, { status: 'failed', error: String(e?.message || e) }); fire();
    }
  }

  // Authoritative resolver — call after EVERY holdings scan with the indexer's index(events) output.
  // Returns { settled:[id], failed:[id] } for toasts.
  function reconcile({ spent } = {}) {
    const set = spent instanceof Set ? spent : new Set([...(spent || [])].map(lc));
    const m = load(); const settled = [], failed = [];
    for (const [id, r] of Object.entries(m)) {
      if (r.status === 'failed') continue;                   // already rolled back; awaits dismiss()
      if (set.has(lc(r.in.nullifier))) { delete m[id]; settled.push(id); }      // input consumed ⇒ landed
      else if (now() - r.createdAt > SETTLE_TIMEOUT_MS) { m[id] = { ...r, status: 'failed', error: 'timed out — price may have moved' }; failed.push(id); }
    }
    save(m);
    return { settled, failed };
  }

  // The optimistic view over the real (settled) scanned holdings. `scanned` = memo.scan(...) active notes,
  // each with a `.nullifier`. Hides the note being spent, shows the expected output as pending.
  function overlay(scanned) {
    const m = load(); const inN = new Set(); const adds = [];
    for (const r of Object.values(m)) {
      if (r.status === 'failed') continue;
      inN.add(lc(r.in.nullifier));
      adds.push({ asset: r.out.asset, value: r.out.value, minOut: r.out.minOut, pending: true, status: r.status, jobId: r.jobId });
    }
    return [...scanned.filter((n) => !inN.has(lc(n.nullifier))), ...adds];
  }

  const list = () => Object.values(load());                  // activity feed (pending + failed-awaiting-dismiss)
  const get = (id) => load()[id] || null;
  const dismiss = (id) => { const m = load(); delete m[id]; save(m); };

  return { open, drive, reconcile, overlay, list, get, dismiss };
}
