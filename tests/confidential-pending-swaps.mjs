// Pending-swap state machine (dapp/confidential-pending-swaps.js): optimistic overlay + reconcile-on-scan.
// Pure logic — mock storage, a controllable clock, and a stub relay. Validates: optimistic display, settle
// via the scan's spent set (authoritative), the timeout→failed roll-back, and the relay-driven progress UI.
// Run: node tests/confidential-pending-swaps.mjs
import { makeConfidentialPendingSwaps } from '../dapp/confidential-pending-swaps.js';
import assert from 'node:assert';

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const mockStorage = () => { let s = '{}'; return { getItem: () => s, setItem: (_k, v) => { s = v; }, _raw: () => s }; };
let clock = 1_000_000;
const now = () => clock;

const IN_NU = '0xAAAA';   // the spent pool note's nullifier (reconcile key)
const OUT_LEAF = '0xBBBB';
const swap = {
  jobId: 'job-1',
  in:  { nullifier: IN_NU, asset: '0xETH', value: '100' },
  out: { leaf: OUT_LEAF, asset: '0xUSD', value: '250', minOut: '245', blinding: '0x1', owner: '0x0' },
};
// the scanned (real, settled) holdings the indexer would return — BEFORE settle, the input note is still active
const scannedBefore = [{ asset: '0xETH', value: '100', nullifier: IN_NU, leaf: '0xINLEAF' }];
// AFTER settle, the indexer drops the spent input note and recovers the real output note
const scannedAfter = [{ asset: '0xUSD', value: '250', nullifier: '0xCCCC', leaf: OUT_LEAF }];

// (1) open + overlay = optimistic: input note hidden, expected output shown pending
{
  const p = makeConfidentialPendingSwaps({ storage: mockStorage(), now });
  p.open(swap);
  const view = p.overlay(scannedBefore);
  assert.equal(view.find((x) => x.nullifier === IN_NU), undefined, 'input note hidden (optimistically spent)');
  const out = view.find((x) => x.pending);
  assert.equal(out.asset, '0xUSD', 'expected output shown');
  assert.equal(out.value, '250', 'shows expected value');
  assert.equal(out.minOut, '245', 'carries the slippage bound for "~X (min Y)"');
  assert.equal(out.status, 'proving', 'starts in proving');
  ok('open + overlay: input hidden, expected output shown as pending with min-bound');
}

// (2) reconcile while input ν NOT yet spent → still pending (no premature resolve)
{
  const st = mockStorage(); const p = makeConfidentialPendingSwaps({ storage: st, now });
  p.open(swap);
  const r = p.reconcile({ spent: new Set(['0xZZZZ']) }); // some other op's ν, not ours
  assert.deepEqual(r, { settled: [], failed: [] }, 'nothing resolves');
  assert.equal(p.list().length, 1, 'still pending');
  ok('reconcile: unrelated spends do not resolve a pending swap');
}

// (3) reconcile once input ν IS spent → SETTLED (record dropped), overlay returns the scanned truth seamlessly
{
  const st = mockStorage(); const p = makeConfidentialPendingSwaps({ storage: st, now });
  p.open(swap);
  const r = p.reconcile({ spent: new Set([IN_NU.toLowerCase()]) }); // the dapp's scan caught up
  assert.deepEqual(r.settled, ['job-1'], 'reports settled');
  assert.equal(p.list().length, 0, 'pending record dropped');
  const view = p.overlay(scannedAfter);
  assert.deepEqual(view, scannedAfter, 'overlay == real scanned holdings (no phantom note)');
  ok('reconcile: input ν in spent ⇒ settled, overlay collapses to scanned truth');
}

// (4) timeout while never landing → FAILED, overlay stops hiding the input note (roll back)
{
  clock = 1_000_000;
  const st = mockStorage(); const p = makeConfidentialPendingSwaps({ storage: st, now });
  p.open(swap);
  clock += 7 * 60 * 1000; // past SETTLE_TIMEOUT_MS with ν still unspent
  const r = p.reconcile({ spent: new Set() });
  assert.deepEqual(r.failed, ['job-1'], 'reports failed');
  assert.equal(p.get('job-1').status, 'failed', 'marked failed (kept until dismiss)');
  const view = p.overlay(scannedBefore);
  assert.ok(view.find((x) => x.nullifier === IN_NU), 'input note restored (roll back the optimistic spend)');
  assert.equal(view.find((x) => x.pending), undefined, 'no pending output shown for a failed swap');
  p.dismiss('job-1');
  assert.equal(p.list().length, 0, 'dismiss clears it');
  ok('timeout: failed swap rolls back the overlay + lingers until dismiss');
}

// (5) drive: progress UI transitions off a stub relay; failure path marks failed
{
  clock = 1_000_000;
  const seen = [];
  const relayOk = { waitForSettle: async (_id, { onUpdate }) => { onUpdate({ status: 'proving' }); onUpdate({ status: 'settled', txHash: '0xTX' }); } };
  const p = makeConfidentialPendingSwaps({ storage: mockStorage(), relay: relayOk, now });
  p.open(swap);
  await p.drive('job-1', { onChange: (r) => seen.push(r.status) });
  assert.deepEqual(seen, ['proving', 'settling', 'settling'], 'proving → settling (worker acked), txHash captured');
  assert.equal(p.get('job-1').txHash, '0xTX', 'settle tx hash recorded');

  const relayFail = { waitForSettle: async () => { throw new Error('box offline'); } };
  const p2 = makeConfidentialPendingSwaps({ storage: mockStorage(), relay: relayFail, now });
  p2.open(swap);
  await p2.drive('job-1', {});
  assert.equal(p2.get('job-1').status, 'failed', 'relay error ⇒ failed');
  assert.match(p2.get('job-1').error, /box offline/, 'error surfaced');
  ok('drive: relay status drives the progress UI; relay error marks the swap failed');
}

console.log(`confidential-pending-swaps: all ${n} checks passed`);
