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

// The handler ends at the next top-level function, whatever that is, so this stays correct
// regardless of which function happens to sit next to it in the file.
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

test('runway is measured in DAYS of the wallet\'s real burn, not in settles', () => {
  ok(/import \{ burnGasPerDay, runwayDays \} from '\.\/lib\/runway\.js'/.test(monitor), 'monitor does not use the shared runway arithmetic');
  ok(/runway < CFG\.runwayDaysCritical/.test(monitor) && /runway < CFG\.runwayDaysWarn/.test(monitor), 'no critical and warning day thresholds');
  ok(/getGasPrice\(\)/.test(monitor), 'runway must read the live gas price');
});

// The arithmetic itself, with real numbers: a merged relayer wallet holding 0.02014 ETH at 0.053 gwei
// has about 6 days of runway, not the misleading "635 settles" a per-op count would suggest.
const { runwayDays, burnGasPerDay } = await import(join(ROOT, 'worker-relay/src/lib/runway.js'));
const GAS = { maintenance: 264_000n, transfer: 600_000n };
const mk = (o) => runwayDays({ maintenanceRunsPerDay: 111, expectedOpsPerDay: 50, gas: GAS, ...o });
const wei = (eth) => BigInt(Math.round(eth * 1e18));
const gwei = (g) => BigInt(Math.round(g * 1e9));

test('a merged wallet is priced on BOTH its jobs: ~6 days, not "635 settles"', () => {
  const d = mk({ roles: ['relay', 'settle'], balanceWei: wei(0.02014), gasPriceWei: gwei(0.053) });
  ok(d > 6.0 && d < 6.8, `expected ~6.4 days, got ${d}`);
  const settlesOnly = Number(wei(0.02014)) / Number(600_000n * gwei(0.053));
  ok(settlesOnly > 600 && d < settlesOnly / 50, 'the days figure must be far below the misleading settles figure');
});

test('the runway shrinks with gas price, so a spike is visible', () => {
  const a = mk({ roles: ['relay', 'settle'], balanceWei: wei(0.02), gasPriceWei: gwei(0.05) });
  const b = mk({ roles: ['relay', 'settle'], balanceWei: wei(0.02), gasPriceWei: gwei(0.5) });
  ok(Math.abs(a / b - 10) < 0.01, `10x the gas must be 1/10th the runway, got ratio ${a / b}`);
  ok(b < 1, `at 0.5 gwei this wallet should have under a day, got ${b}`);
});

test('roles are priced separately when the wallets are split', () => {
  const relay = mk({ roles: ['relay'], balanceWei: wei(0.01), gasPriceWei: gwei(0.05) });
  const settle = mk({ roles: ['settle'], balanceWei: wei(0.01), gasPriceWei: gwei(0.05) });
  const both = mk({ roles: ['relay', 'settle'], balanceWei: wei(0.01), gasPriceWei: gwei(0.05) });
  ok(relay > both && settle > both, 'a wallet doing both jobs must have less runway than one doing either');
  ok(Math.abs(1 / both - (1 / relay + 1 / settle)) < 1e-9, 'burn rates must add');
});

test('no gas price, or no roles, gives no runway rather than a wrong one', () => {
  ok(mk({ roles: ['relay'], balanceWei: wei(1), gasPriceWei: 0n }) === null, 'a zero gas price must not divide by zero');
  ok(mk({ roles: [], balanceWei: wei(1), gasPriceWei: gwei(0.05) }) === null, 'a wallet with no roles burns nothing');
  ok(burnGasPerDay({ roles: [], maintenanceRunsPerDay: 111, expectedOpsPerDay: 50, gas: GAS }) === 0n, 'no roles -> zero burn');
});

test('a critical exits non-zero so the cron surfaces it without a webhook', () => {
  ok(/if \(level === 'critical'\) criticals\+\+/.test(monitor), 'criticals are not counted');
  ok(/if \(criticals > 0\) process\.exit\(1\)/.test(monitor), 'criticals do not fail the run');
  // A thrown check is an unknown, not a critical — failing on it would page on every transient RPC blip.
  ok(/r\.status === 'rejected'/.test(monitor), 'rejected checks must be logged, not counted as criticals');
});

test('both new thresholds are env-overridable', () => {
  for (const k of ['RUNWAY_DAYS_CRITICAL', 'RUNWAY_DAYS_WARN', 'SNAPSHOT_BYTES_WARN']) {
    ok(new RegExp(`'${k}'`).test(config), `${k} is not configurable`);
  }
});

test('the capacity report needs no credentials', () => {
  // It exists so anyone can reproduce the numbers. The moment it needs a box token that stops being true.
  ok(!/BOX_TOKEN|authorization/i.test(report), 'capacity report must use only public endpoints');
  for (const f of ALL) ok(report.includes(`'${f}'`), `report does not model ${f}`);
});

// The string checks above pin names, not behaviour, so also run the real handler against the record
// shape the live KV holds — nesting the counts one level too high (`s.noteLeaves` vs
// `s.snapshot.noteLeaves`) would still pass a names-only check while reporting zero for every count.
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
