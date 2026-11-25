// Forward intake follows the live reverse rebalancer's status file, while quotes and swaps already taken continue.
//   node tests/fastbridge-lp-rebalance-gate.test.mjs (Node 22)

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRebalanceIntakeGate, rebalanceStatusFreshSecs, validateRebalanceStatus } from '../fastbridge-lp/lib/rebalance-gate.mjs';
import { makeCounter } from '../dapp/fastbridge-http.js';
import { VALUE, world } from './lib/fastbridge-world.mjs';
import { bothDone, closers, configFor, httpWorld, serve, service, startSwap } from './lib/lp-harness.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const NOW = 1_800_000_000;
const base = (text) => {
  const [whole, fraction = ''] = String(text).split('.');
  return (BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'))).toString();
};
const valid = (over = {}) => ({
  version: 1, kind: 'status', id: 'status', ts: NOW, enabled: true, dryRun: false,
  intakeAllowed: true, intakeReason: null, stalled: false, stallReason: null,
  maxStuckTac: '2000', maxStuckBaseUnits: base('2000'), measuredStuckTac: '10.5', measuredStuckBaseUnits: base('10.5'),
  measurementScope: 'eligible_leased_main_candidates_plus_reverse_stock_and_pending', buyerDemandGuaranteed: false,
  ...over,
});
const paused = (over = {}) => valid({
  intakeAllowed: false, intakeReason: 'stuck_exposure_ceiling', stalled: true, stallReason: 'stuck_exposure_ceiling',
  measuredStuckTac: '2001', measuredStuckBaseUnits: base('2001'), ...over,
});
const verdict = (status, over = {}) => validateRebalanceStatus(status, { nowSecs: NOW, freshSecs: 60, ...over });
const post = (svc, path, body) => svc.handle({ method: 'POST', path, body });
const info = (svc) => svc.handle({ method: 'GET', path: '/info' });

test('freshness derives from the rebalance tick and a fresh, explicit status allows intake', () => {
  assert.equal(rebalanceStatusFreshSecs(1), 60);
  assert.equal(rebalanceStatusFreshSecs(20), 60);
  assert.equal(rebalanceStatusFreshSecs(30), 90);
  assert.equal(rebalanceStatusFreshSecs(60), 180);
  assert.deepEqual(verdict(valid()), { allowed: true, code: null, reason: null });
  assert.deepEqual(verdict(valid({ ts: NOW - 60 })), { allowed: true, code: null, reason: null }, 'the threshold itself is still fresh');
  assert.equal(verdict(paused()).allowed, false);
  assert.match(verdict(paused()).reason, /stuck_exposure_ceiling/);
});

test('missing, malformed, wrong-version, future, stale and untrusted status fails closed', () => {
  assert.equal(verdict(null).code, 'missing');
  for (const value of [[], 'status', 42, valid({ version: 0 }), valid({ version: 2 }), valid({ ts: String(NOW) }), valid({ intakeAllowed: 'true' }), valid({ stalled: null }), valid({ intakeReason: 'not_allowed_when_open' }), valid({ stalled: true }), valid({ maxStuckTac: '0' }), valid({ maxStuckTac: null }), valid({ measuredStuckTac: '-1' }), valid({ measuredStuckTac: 10 }), valid({ ts: NOW + 1 }), valid({ ts: NOW - 61 })]) {
    assert.equal(verdict(value).allowed, false, JSON.stringify(value));
  }
  for (const value of [true, null, undefined, 'false']) assert.equal(verdict(valid({ buyerDemandGuaranteed: value })).allowed, false, String(value));
  assert.equal(verdict(valid({ measuredStuckTac: '2000.00000001', measuredStuckBaseUnits: base('2000.00000001') })).code, 'stuck_ceiling', 'the measured total cannot exceed its ceiling while intake stays open');
  assert.equal(verdict(valid({ stalled: true, stallReason: 'no_recovery' })).code, 'stalled');
  assert.equal(verdict(valid({ intakeAllowed: false, intakeReason: null })).code, 'malformed');
});

test('only the live status record is trusted, with exact identity, flags and measurement scope', () => {
  for (const [status, code] of [
    [valid({ kind: 'journal' }), 'wrong_identity'], [valid({ id: 'other' }), 'wrong_identity'],
    [valid({ enabled: false }), 'non_live'], [valid({ dryRun: true }), 'non_live'],
    [valid({ enabled: undefined }), 'non_live'], [valid({ dryRun: undefined }), 'non_live'],
    [valid({ measurementScope: 'unexpected_scope' }), 'measurement_scope'], [valid({ measurementScope: null }), 'measurement_scope'],
  ]) assert.equal(verdict(status).code, code, JSON.stringify(status));
  const withoutScope = valid();
  delete withoutScope.measurementScope;
  assert.equal(verdict(withoutScope).code, 'measurement_scope', 'a missing scope is not trusted');
});

test('TAC text and base units must agree exactly in both amount fields', () => {
  for (const status of [
    valid({ maxStuckBaseUnits: base('2000.00000001') }),
    valid({ maxStuckTac: '2000.00000001' }),
    valid({ measuredStuckBaseUnits: base('10.50000001') }),
    valid({ measuredStuckTac: '10.50000001' }),
    valid({ maxStuckBaseUnits: 200000000000n }),
    valid({ measuredStuckBaseUnits: null }),
    valid({ maxStuckBaseUnits: '0200000000000' }),
  ]) {
    const result = verdict(status);
    assert.equal(result.allowed, false, String(status.maxStuckBaseUnits));
    assert.ok(['malformed', 'amount_mismatch'].includes(result.code), JSON.stringify(result));
  }
  assert.equal(verdict(valid({ maxStuckTac: '2000.0' })).allowed, true, 'equivalent decimal text still agrees with the same base units');
});

test('the injectable reader is consulted every time and a fresh status reopens intake', async () => {
  let current = valid(), reads = 0, now = NOW;
  const gate = makeRebalanceIntakeGate({ readStatus: async () => { reads++; return current; }, now: () => now, freshSecs: 60, expectedMaxStuckBaseUnits: base('2000') });
  assert.equal((await gate()).allowed, true);
  current = null;
  assert.equal((await gate()).code, 'missing');
  current = '{not json';
  assert.equal((await gate()).code, 'malformed');
  current = valid({ ts: NOW - 61 });
  assert.equal((await gate()).code, 'stale');
  current = valid();
  assert.equal((await gate()).allowed, true);
  now += 61;
  assert.equal((await gate()).code, 'stale');
  current = valid({ ts: now });
  assert.equal((await gate()).allowed, true);
  assert.equal(reads, 7);
  const unavailable = makeRebalanceIntakeGate({ readStatus: async () => { throw new Error('disk unavailable'); }, now: () => NOW, freshSecs: 60, expectedMaxStuckBaseUnits: base('2000') });
  assert.equal((await unavailable()).code, 'unreadable');
});

test('a different configured ceiling fails closed across restart until the matching valid status arrives', async () => {
  let current = valid();
  const reader = async () => current;
  const original = makeRebalanceIntakeGate({ readStatus: reader, now: () => NOW, freshSecs: 60, expectedMaxStuckBaseUnits: base('2000') });
  assert.equal((await original()).allowed, true);
  current = valid({ maxStuckTac: '2500', maxStuckBaseUnits: base('2500') });
  assert.equal((await original()).code, 'ceiling_mismatch');
  const restarted = makeRebalanceIntakeGate({ readStatus: reader, now: () => NOW, freshSecs: 60, expectedMaxStuckBaseUnits: 2500n * 100000000n });
  assert.equal((await restarted()).allowed, true, 'the restarted daemon accepts status for its new configured ceiling');
  current = valid();
  assert.equal((await restarted()).code, 'ceiling_mismatch', 'an old status cannot reopen intake after config drift');
  current = valid({ maxStuckTac: '2500', maxStuckBaseUnits: base('2500') });
  assert.equal((await restarted()).allowed, true, 'the matching fresh status reopens intake');
  assert.throws(() => makeRebalanceIntakeGate({ readStatus: reader, expectedMaxStuckBaseUnits: 'not-base-units' }), /expectedMaxStuckBaseUnits/);
});

test('the file reader fails closed for a missing or malformed status.json and recovers from a valid write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-rebalance-gate-'));
  try {
    const file = join(dir, 'status.json'), gate = makeRebalanceIntakeGate({ statusFile: file, now: () => NOW, freshSecs: 60, expectedMaxStuckBaseUnits: base('2000') });
    assert.equal((await gate()).code, 'missing');
    writeFileSync(file, '{not json');
    assert.equal((await gate()).code, 'malformed');
    writeFileSync(file, JSON.stringify(valid()));
    assert.equal((await gate()).allowed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the provider returns a retryable 503 and zero availability for every bad status, then quotes again on recovery', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(VALUE, 'inventory');
  let current = valid({ ts: w.clock.now() });
  const gate = makeRebalanceIntakeGate({ readStatus: async () => current, now: w.clock.now, freshSecs: 60, expectedMaxStuckBaseUnits: base('2000') });
  const s = await serve(w, { config: { ...configFor(w), intakeGate: gate } });
  const cases = [
    [null, /missing/],
    [{ nope: true }, /version|malformed/],
    [valid({ ts: w.clock.now() - 61 }), /stale/],
    [valid({ ts: w.clock.now(), buyerDemandGuaranteed: true }), /buyer demand/],
  ];
  for (const [status, reason] of cases) {
    current = status;
    const no = await post(s.svc, '/quote', { amount: String(VALUE) });
    assert.equal(no.status, 503);
    assert.equal(no.body.retry, true);
    assert.match(no.body.error, reason);
    assert.equal(await s.svc.availableAmount(), 0n);
    assert.equal((await info(s.svc)).body.available, '0');
  }
  assert.equal((await s.quoteStore.list()).length, 0, 'no quote was created while the gate was closed');
  current = valid({ ts: w.clock.now() });
  const yes = await post(s.svc, '/quote', { amount: String(VALUE) });
  assert.equal(yes.status, 200);
  assert.ok(yes.body.id);
  assert.equal((await info(s.svc)).body.available, String(VALUE));
});

test('a reserved swap finishes while new quotes are closed, with no gate reads on reserve, offer, ticks or claims', async () => {
  let svc;
  const w = world({ funds: 0, userCounter: () => makeCounter((method, path, body) => svc.handle({ method, path, body })) });
  w.lEvm.fund(VALUE, 'inventory');
  let current = valid({ ts: w.clock.now() }), reads = 0;
  const gate = makeRebalanceIntakeGate({ readStatus: async () => { reads++; return current; }, now: w.clock.now, freshSecs: 60, expectedMaxStuckBaseUnits: base('2000') });
  const s = await service(w, { config: { ...configFor(w), intakeGate: gate } });
  svc = s.svc;
  const q = (await post(s.svc, '/quote', { amount: String(VALUE) })).body;
  assert.ok(q.id);
  assert.equal((await post(s.svc, '/reserve', { quoteId: q.id })).body.ok, true);
  current = paused({ ts: w.clock.now() });
  const no = await post(s.svc, '/quote', { amount: String(VALUE) });
  assert.deepEqual([no.status, no.body.retry], [503, true]);
  assert.match(no.body.error, /stuck_exposure_ceiling/);
  assert.equal((await info(s.svc)).body.available, '0');
  assert.equal((await post(s.svc, '/reserve', { quoteId: q.id })).body.ok, true, 'the existing reservation remains usable');
  const readsBeforeSwap = reads;
  await startSwap(w, q);
  await w.run(bothDone(w));
  assert.equal((await w.lp()).phase, 'done');
  assert.equal(reads, readsBeforeSwap, 'the whole existing swap never consulted the intake gate');
  w.lEvm.fund(VALUE, 'recovered-inventory');
  current = valid({ ts: w.clock.now() });
  assert.equal((await post(s.svc, '/quote', { amount: String(VALUE) })).status, 200, 'fresh recovery status reopens new quotes');
});

test('a service without intakeGate keeps the original quote and info behaviour', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(VALUE, 'inventory');
  const s = await serve(w, { config: configFor(w) });
  const q = await post(s.svc, '/quote', { amount: String(VALUE) });
  assert.equal(q.status, 200);
  assert.equal(q.body.retry, undefined);
  assert.equal((await info(s.svc)).body.available, String(VALUE));
  assert.equal((await info(s.svc)).body.intake, undefined);
  assert.equal((await post(s.svc, '/reserve', { quoteId: q.body.id })).body.ok, true);
});

test('the daemon wires only live non-pair rebalance to the forward service and logs activation', () => {
  const src = readFileSync(new URL('../fastbridge-lp/server.mjs', import.meta.url), 'utf8');
  const activation = src.indexOf('if (C.reverse?.enabled === true && C.reverse.rebalance?.enabled === true && !DRY && !PAIR)');
  const service = src.indexOf('const service = makeLpService(');
  assert.ok(activation > 0 && activation < service);
  assert.match(src, /config\.intakeGate = makeRebalanceIntakeGate\(\{ statusFile, freshSecs, expectedMaxStuckBaseUnits: ropts\.rebalance\.maxStuck \}\)/);
  assert.match(src, /resolve\(data, 'rebalance\/status\.json'\)/);
  assert.match(src, /rebalanceStatusFreshSecs\(ropts\.rebalance\.tickSecs\)/);
  assert.match(src, /msg: 'forward intake gate is on: new quotes need fresh reverse rebalance status'/);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
  while (closers.length) { try { await closers.pop()(); } catch { /* already closed */ } }
}
console.log(`\n${passed}/${tests.length} forward intake gate checks passed`);
process.exit(process.exitCode || 0);
