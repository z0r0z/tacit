// The capacity signal survives the trip from worker to monitor.
//
// Three pieces have to agree for snapshot growth to actually be watched: the reflection snapshot holds
// the arrays, `/reflection/state` reports their sizes, and the monitor reads those field names. Nothing
// fails loudly if they drift — a renamed key just makes the check silently report nothing, which is the
// worst outcome for a check whose whole job is to notice a slow trend. So pin the contract.
//
// The last case is the one with teeth: it reads the LIVE snapshot and asserts the arrays the report
// models actually exist and are non-empty, so the growth model is anchored to real state rather than to
// field names that were true when this was written.
//
// Run: node tests/capacity-monitoring.test.mjs        (set OFFLINE=1 to skip the live case)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const worker = readFileSync(join(ROOT, 'worker/src/index.js'), 'utf8');
const monitor = readFileSync(join(ROOT, 'worker-relay/src/balance-monitor.js'), 'utf8');
const config = readFileSync(join(ROOT, 'worker-relay/src/lib/config.js'), 'utf8');
const report = readFileSync(join(ROOT, 'tools/capacity-report.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
const test = (label, fn) => {
  try { fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const asyncTest = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};

console.log('capacity monitoring:\n');

// The four fields the growth model is built on. Two are append-only and set the permanent floor; two
// track the live set and are freed on spend. The distinction is the model, so both halves must survive.
const APPEND_ONLY = ['noteLeaves', 'spentLinks'];
const TRANSIENT = ['liveTriples', 'coords'];
const ALL = [...APPEND_ONLY, ...TRANSIENT];

// The handler ends at the next top-level function, whatever that is. This used to end at a NAMED neighbour
// (handleReflectionDump), which broke the moment another handler was added between them and its own KV read
// was counted against this one.
const stateStart = worker.indexOf('async function handleReflectionState');
const nextFn = worker.slice(stateStart + 1).search(/\n(async )?function \w+/);
const stateHandler = worker.slice(stateStart, stateStart + 1 + nextFn);

test('/reflection/state reports a capacity block', () => {
  ok(stateHandler.length > 0, 'handleReflectionState not found');
  ok(/capacity:\s*\{/.test(stateHandler), 'no capacity block in the response');
  ok(/bytes:\s*raw\.length/.test(stateHandler), 'capacity.bytes must be the serialized snapshot length');
});

test('capacity reports every field the growth model needs', () => {
  for (const f of ALL) ok(new RegExp(`${f}:\\s*len\\('${f}'\\)`).test(stateHandler), `capacity omits ${f}`);
});

test('capacity is free — it reuses the parse the handler already does', () => {
  // The handler reads and parses the snapshot to answer at all. If someone adds a second KV read to
  // compute sizes, this endpoint stops being safe to poll on a cron.
  const gets = stateHandler.match(/REGISTRY_KV\.get\(/g) || [];
  ok(gets.length === 1, `expected exactly 1 KV read, found ${gets.length}`);
});

test('the monitor reads the same field names the worker writes', () => {
  const check = monitor.slice(monitor.indexOf('async function checkSnapshotCapacity'), monitor.indexOf('async function main'));
  ok(check.length > 0, 'checkSnapshotCapacity not found');
  ok(/\/reflection\/state/.test(check), 'does not call /reflection/state');
  for (const f of ['noteLeaves', 'spentLinks', 'liveTriples']) {
    ok(new RegExp(`cap\\.${f}`).test(check), `monitor never reads cap.${f}`);
  }
});

test('a missing capacity block degrades quietly instead of throwing', () => {
  // The monitor and the worker deploy independently (worker/src needs a manual tacit-api deploy), so the
  // monitor WILL at some point talk to a worker that predates the field. That must not fail the run.
  const check = monitor.slice(monitor.indexOf('async function checkSnapshotCapacity'), monitor.indexOf('async function main'));
  ok(/if \(!cap \|\| !Number\.isFinite\(cap\.bytes\)\)/.test(check), 'no guard for a worker without the capacity field');
  ok(/return;/.test(check), 'guard must return rather than alert');
});

test('runway uses the measured settle gas, not a magic number', () => {
  ok(/import \{ CFG, OP_GAS \}/.test(monitor), 'monitor does not import OP_GAS');
  // Priced per role now: a settle wallet on OP_GAS.transfer, a maintenance-only one on OP_GAS.maintenance.
  ok(/const perOp = settles \? OP_GAS\.transfer : OP_GAS\.maintenance/.test(monitor),
    'runway must price each wallet on the work it actually does');
  ok(/perOp \* gasPrice/.test(monitor), 'runway must price at the live gas price');
  ok(/getGasPrice\(\)/.test(monitor), 'runway must read the live gas price');
});

test('the absolute floor is only a backstop for a missing runway', () => {
  // With runway known it says everything the floor would; alerting on both is a second line for one fact
  // (and the floor sat above both wallets' balances, so it fired on every run).
  ok(/if \(runway === null && bal < CFG\.ethGasBufferWei\)/.test(monitor), 'the floor must only apply when runway is unavailable');
});

test('a critical exits non-zero so the cron surfaces it without a webhook', () => {
  ok(/if \(level === 'critical'\) criticals\+\+/.test(monitor), 'criticals are not counted');
  ok(/if \(criticals > 0\) process\.exit\(1\)/.test(monitor), 'criticals do not fail the run');
  // A thrown check is an unknown, not a critical — failing on it would page on every transient RPC blip.
  ok(/r\.status === 'rejected'/.test(monitor), 'rejected checks must be logged, not counted as criticals');
});

test('both new thresholds are env-overridable', () => {
  for (const k of ['SETTLE_RUNWAY_ALERT', 'SNAPSHOT_BYTES_WARN']) {
    ok(new RegExp(`'${k}'`).test(config), `${k} is not configurable`);
  }
});

test('the capacity report needs no credentials', () => {
  // It exists so anyone can reproduce the numbers. The moment it needs a box token that stops being true.
  ok(!/BOX_TOKEN|authorization/i.test(report), 'capacity report must use only public endpoints');
  for (const f of ALL) ok(report.includes(`'${f}'`), `report does not model ${f}`);
});

// The string checks above pin names, not behaviour — and that is how the first version shipped reading the
// arrays one level too high (`s.noteLeaves` instead of `s.snapshot.noteLeaves`), reporting zero for every
// count while `bytes` looked fine. So run the real handler, against the record shape the live KV holds.
await asyncTest('capacity counts are read from the nested snapshot, not the record root', async () => {
  const src = stateHandler.replace(/^async function handleReflectionState/, 'return async function handleReflectionState');
  const record = {
    attestedHeight: 967805, tipHeight: 967831,
    snapshot: { noteLeaves: ['a', 'b', 'c'], spentLinks: ['x', 'y'], liveTriples: ['t'], coords: ['c1', 'c2'] },
  };
  const raw = JSON.stringify(record);
  const handler = new Function('checkConfidentialAuth', 'jsonResponse', src)(
    () => true,
    (body) => body,
  );
  const out = await handler({}, { REGISTRY_KV: { get: async () => raw } }, new URL('https://x/reflection/state?network=mainnet'), {});
  ok(out.capacity, 'no capacity block');
  ok(out.capacity.noteLeaves === 3, `noteLeaves read ${out.capacity.noteLeaves}, expected 3`);
  ok(out.capacity.spentLinks === 2, `spentLinks read ${out.capacity.spentLinks}, expected 2`);
  ok(out.capacity.liveTriples === 1 && out.capacity.coords === 2, 'live-set counts wrong');
  ok(out.capacity.bytes === raw.length, 'bytes must be the serialized record length');
  // A flat record (no .snapshot wrapper) must still work — older/other writers.
  const flat = JSON.stringify({ noteLeaves: ['a'], spentLinks: [] });
  const out2 = await handler({}, { REGISTRY_KV: { get: async () => flat } }, new URL('https://x/reflection/state'), {});
  ok(out2.capacity.noteLeaves === 1, 'flat record shape no longer read');
});

await asyncTest('the live snapshot still has the arrays the model is built on', async () => {
  if (process.env.OFFLINE) { console.log('    (skipped — OFFLINE)'); return; }
  const res = await fetch('https://api.tacit.finance/reflection/dump?network=mainnet');
  ok(res.ok, `/reflection/dump -> ${res.status}`);
  const s = (await res.json()).snapshot;
  for (const f of ALL) {
    ok(Array.isArray(s[f]), `live snapshot has no ${f} array — the growth model is stale`);
    ok(s[f].length > 0, `live ${f} is empty — the model would divide by zero`);
  }
  // The permanent floor must stay the dominant term, or the model's framing is wrong.
  ok(s.noteLeaves.length >= s.liveTriples.length,
    'noteLeaves should never be below liveTriples — every live note was created once');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
