// How patient the header feeder and the attest are with gas: a bar that follows the last day's prices, a bound on the wait, a spike
// that still holds, and no reading meaning the fixed numbers. node --test tests/gas-pace.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, paceBars, headerPace, headerHoldText, attestPace, attestGate, nextBaseFee, MIN_HISTORY } from '../src/lib/gas-pace.js';

const flat = (g, n = 7200) => Array.from({ length: n }, () => g);
// the live header settings (render.yaml) with the new knobs at their defaults
const HEADER = { ceilGwei: 0.3, followPct: 30, cheapGwei: 0.15, cheapPct: 12, minBatch: 20, minCheap: 3, maxWaitMin: 480, staleBlocks: 144, spikeGwei: 1, spikeMult: 8 };
const ATTEST = { minBlocks: 6, waitMin: 60 };

test('a percentile is read from the sorted numbers, and nothing has none', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0), 1);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 100), 5);
  assert.equal(percentile([1, NaN, 3, undefined], 100), 3);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile(null, 50), null);
});

test('with no usable history only the fixed numbers apply', () => {
  for (const h of [null, [], flat(5, MIN_HISTORY - 1)]) {
    const b = paceBars(h, HEADER);
    assert.equal(b.known, false);
    assert.equal(b.ceil, 0.3);
    assert.equal(b.cheap, 0.15);
    assert.equal(b.spike, 1);
    assert.equal(b.basis, 'ceiling');
  }
});

test('in a usual market the bar is the ceiling; once gas has settled above it, the bar is the last day\'s 30th percentile', () => {
  const usual = paceBars(flat(0.06), HEADER);
  assert.equal(usual.ceil, 0.3);
  assert.equal(usual.cheap, 0.15);
  const moved = paceBars(flat(0.5), HEADER);
  assert.equal(moved.ceil, 0.5, 'the bar moved up with gas');
  assert.equal(moved.basis, 'the last day');
  assert.equal(moved.cheap, 0.5, 'and so did the cheap line (the 12th percentile of a flat 0.5)');
  assert.equal(moved.spike, 4, 'a spike is eight times the median');
  // a day with a recent dip: the bar is the 30th percentile of the day, not its latest hours
  const day = [...flat(0.2, 4000), ...flat(0.8, 3200)];
  assert.equal(paceBars(day, HEADER).ceil, 0.3, 'the 30th percentile (0.2) is under the ceiling, so the ceiling stands');
});

test('no ceiling set means no bar: the feeder never waits for gas, as before', () => {
  const b = paceBars(flat(0.5), { ...HEADER, ceilGwei: 0 });
  assert.equal(b.ceil, Infinity);
  const p = headerPace({ price: 50, pending: 3, history: flat(0.5), params: { ...HEADER, ceilGwei: 0 } });
  assert.equal(p.dear, false);
});

test('headers: cheap gas takes small batches, usual-dear holds, a spike holds past the bound, the bound sends, the last resort sends', () => {
  const h = flat(0.06);
  const cheap = headerPace({ price: 0.1, pending: 3, history: h, params: HEADER });
  assert.deepEqual([cheap.cheap, cheap.minBatch, cheap.dear, cheap.force], [true, 3, false, false]);
  const mid = headerPace({ price: 0.2, pending: 5, history: h, params: HEADER });
  assert.deepEqual([mid.cheap, mid.minBatch, mid.dear], [false, 20, false], 'between the cheap line and the ceiling: full batches, no hold');
  const dear = headerPace({ price: 0.55, pending: 10, history: h, params: HEADER });
  assert.deepEqual([dear.dear, dear.force], [true, false]);
  assert.equal(dear.waitBlocks, 48, '480 minutes of Bitcoin blocks');
  const aged = headerPace({ price: 0.55, pending: 48, history: h, params: HEADER });
  assert.deepEqual([aged.dear, aged.aged, aged.force], [true, true, true], 'eight hours: it goes at 0.55 gwei');
  const justUnder = headerPace({ price: 0.55, pending: 47, history: h, params: HEADER });
  assert.equal(justUnder.force, false);
  const spike = headerPace({ price: 3, pending: 60, history: h, params: HEADER });
  assert.deepEqual([spike.dear, spike.aged, spike.force], [true, false, false], 'a spike keeps holding past the bound');
  const last = headerPace({ price: 3, pending: 144, history: h, params: HEADER });
  assert.deepEqual([last.stale, last.force], [true, true], 'the last resort goes at any price');
});

test('headers: a market that has moved up for good does not freeze the feeder', () => {
  const h = flat(0.5);                                  // the last day sat at 0.5 gwei
  assert.equal(headerPace({ price: 0.45, pending: 20, history: h, params: HEADER }).dear, false, 'at the new norm it goes');
  assert.equal(headerPace({ price: 0.7, pending: 20, history: h, params: HEADER }).dear, true, 'above the new norm it still holds');
  assert.equal(headerPace({ price: 0.45, pending: 20, history: h, params: { ...HEADER, followPct: 0 } }).dear, true, 'with the follow off it is the fixed ceiling again');
});

test('headers: no bound set (HEADER_MAX_WAIT_MIN=0) is the staleness bound alone', () => {
  const p = { ...HEADER, maxWaitMin: 0 };
  assert.equal(headerPace({ price: 0.55, pending: 100, history: flat(0.06), params: p }).force, false);
  assert.equal(headerPace({ price: 0.55, pending: 144, history: flat(0.06), params: p }).force, true);
});

test('the hold line says what it waits for and the latest it goes', () => {
  const h = flat(0.06);
  const t = headerHoldText({ price: 0.55, pending: 12, pace: headerPace({ price: 0.55, pending: 12, history: h, params: HEADER }), params: HEADER });
  assert.match(t, /0\.550 gwei is over the 0\.300 gwei bar \(HEADER_MAX_GAS_GWEI\)/);
  assert.match(t, /holding 12 headers/);
  assert.match(t, /within 6 h at the latest \(the 8 h bound\)/);
  const m = headerHoldText({ price: 0.7, pending: 12, pace: headerPace({ price: 0.7, pending: 12, history: flat(0.5), params: HEADER }), params: HEADER });
  assert.match(m, /30th percentile of the last day/);
  const s = headerHoldText({ price: 3, pending: 60, pace: headerPace({ price: 3, pending: 60, history: h, params: HEADER }), params: HEADER });
  assert.match(s, /spike line/);
  assert.match(s, /at 144 headers/);
});

test('attest: a few blocks wait for company at any gas, for a bounded time, unless someone waits on them', () => {
  const few = attestPace({ matured: 3, ageMin: 10, params: ATTEST });
  assert.equal(few.go, false, 'three blocks wait, whatever gas costs: the proof base fee is the same at any price');
  assert.match(few.reason, /3 of 6 blocks matured/);
  assert.match(few.reason, /in 50 min at the latest/);
  assert.equal(attestPace({ matured: 6, ageMin: 0, params: ATTEST }).go, true, 'six blocks go');
  assert.equal(attestPace({ matured: 2, ageMin: 60, params: ATTEST }).go, true, 'an hour is the bound');
  assert.equal(attestPace({ matured: 2, ageMin: 59.9, params: ATTEST }).go, false);
  const urgent = attestPace({ matured: 1, ageMin: 0, urgent: '1 bonded cBTC lock(s) wait on these blocks', params: ATTEST });
  assert.deepEqual([urgent.go, urgent.reason], [true, '1 bonded cBTC lock(s) wait on these blocks'], 'a user waiting: one block goes');
  assert.equal(attestPace({ matured: 0, ageMin: 0, urgent: 'x', params: ATTEST }).go, false, 'nothing matured is nothing to attest');
  assert.equal(attestPace({ matured: 1, ageMin: 0, params: { ...ATTEST, minBlocks: 1 } }).go, true, 'batching off');
  assert.equal(attestPace({ matured: 1, ageMin: 0, params: { ...ATTEST, waitMin: 0 } }).go, true, 'a zero wait is off');
});

test('the attest gate: nothing matured builds no job (but probes now and then), matured blocks follow the pace, and no reading proceeds', () => {
  const base = { confirmations: 24, now: 10_000_000, params: ATTEST };
  const relay = attestGate({ ...base, relayTip: 973810, attested: 973786, probedAt: base.now - 60_000 });
  assert.equal(relay.go, false);
  assert.equal(relay.key, 'relay');
  assert.match(relay.text, /next batch needs 973811/);
  assert.equal(relay.since, null);
  const probe = attestGate({ ...base, relayTip: 973810, attested: 973786, probedAt: base.now - 11 * 60_000 });
  assert.deepEqual([probe.go, probe.probe, probe.probedAt], [true, true, base.now], 'a job is asked for every ten minutes, so the drift and lost-ack checks still run');
  const few = attestGate({ ...base, relayTip: 973813, attested: 973786, probedAt: base.now });
  assert.deepEqual([few.go, few.key, few.matured, few.since], [false, 'company', 3, base.now], '3 blocks matured: the wait starts now');
  const wanted = attestGate({ ...base, relayTip: 973813, attested: 973786, probedAt: base.now, urgent: 'Ethereum has moved past the last batch' });
  assert.deepEqual([wanted.go, wanted.why], [true, 'Ethereum has moved past the last batch'], 'someone waiting: it goes now');
  const later = attestGate({ ...base, relayTip: 973813, attested: 973786, since: base.now - 61 * 60_000, probedAt: base.now });
  assert.equal(later.go, true, 'an hour on, it goes');
  const full = attestGate({ ...base, relayTip: 973820, attested: 973786, probedAt: base.now });
  assert.deepEqual([full.go, full.matured], [true, 10]);
  assert.equal(attestGate({ ...base, relayTip: 973813, attested: null }), null, 'the cursor cannot be read: proceed as before');
  assert.equal(attestGate({ ...base, relayTip: 0, attested: 973786 }), null);
});

test('the next block\'s base fee follows the fullness of this one', () => {
  const blk = (used, limit = 36_000_000n, base = 1_000_000_000n) => ({ baseFeePerGas: base, gasUsed: used, gasLimit: limit });
  assert.equal(nextBaseFee(blk(18_000_000n)), 1_000_000_000n, 'half full: unchanged');
  assert.equal(nextBaseFee(blk(36_000_000n)), 1_125_000_000n, 'full: up an eighth');
  assert.equal(nextBaseFee(blk(0n)), 875_000_000n, 'empty: down an eighth');
  assert.equal(nextBaseFee(blk(18_000_001n, 36_000_000n, 7n)), 8n, 'it always moves up by at least one wei when over target');
  assert.equal(nextBaseFee({ baseFeePerGas: 1n }), null);
  assert.equal(nextBaseFee(null), null);
});
