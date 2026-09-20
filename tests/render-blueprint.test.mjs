// The Render blueprints must PARSE, and must say what production actually runs.
//
// A syntax error in worker-relay/render.yaml is silent until a blueprint sync fails — and it is the file that
// keeps the relay services in line. It happened: an unquoted `: ` inside a dockerCommand made the whole file
// invalid, and nothing noticed because nothing parsed it. So parse it, and pin the few invariants whose
// violation would hurt: one signing key, no second replenisher, and the guards that must stay declared.
//
// Parsing shells out to Python's YAML (no JS YAML parser is a dependency of this repo). Where that is
// unavailable the test says so and skips rather than pretending to have checked.
//
// Run: node tests/render-blueprint.test.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
const test = (label, fn) => { try { fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; } };

function parse(file) {
  const r = spawnSync('python3', ['-c', 'import sys,json,yaml;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', join(ROOT, file)], { encoding: 'utf8' });
  if (r.error || /No module named yaml/.test(r.stderr || '')) return { skipped: true };
  if (r.status !== 0) throw new Error(`does not parse: ${(r.stderr || '').trim().split('\n').slice(-1)[0]}`);
  return JSON.parse(r.stdout);
}

console.log('render blueprints:\n');
let relay;
try { relay = parse('worker-relay/render.yaml'); } catch (e) { relay = { error: e.message }; }
if (relay.skipped) { console.log('  SKIP  python3 + PyYAML unavailable — blueprints NOT checked'); process.exit(0); }

test('worker-relay/render.yaml parses', () => { ok(!relay.error, relay.error); ok(Array.isArray(relay.services) && relay.services.length > 0, 'no services'); });
if (relay.error) { console.log(`\n${pass} passed, ${fail} failed.`); process.exit(1); }

const svc = (n) => relay.services.find((s) => s.name === n);
const envKeys = (s) => (s.envVars || []).map((e) => e.key).filter(Boolean);

test('every service the relay depends on is declared', () => {
  for (const n of ['tacit-settle', 'tacit-header', 'tacit-reflection', 'tacit-eth-state', 'tacit-monitor']) ok(svc(n), `${n} is missing`);
});

test('one signing key: SETTLE_KEY is not declared anywhere', () => {
  // A second key splits fee income from the account that funds proving (the network prover account).
  for (const s of relay.services) ok(!envKeys(s).includes('SETTLE_KEY'), `${s.name} declares SETTLE_KEY`);
  ok(!envKeys(svc('tacit-monitor')).includes('SETTLE_ADDRESS'), 'the monitor still watches a second, retired wallet');
});

test('replenish runs inside tacit-settle, and the old cron is inert', () => {
  const settle = envKeys(svc('tacit-settle'));
  for (const k of ['REPLENISH_IN_SETTLE', 'REPLENISH_INTERVAL_MIN', 'FEE_ASSETS']) ok(settle.includes(k), `tacit-settle does not declare ${k}`);
  // A resumed cron running replenish.js would be a SECOND replenisher racing settle for the same wallet's nonces.
  const cron = svc('tacit-replenish');
  if (cron) ok(!/replenish\.js/.test(cron.dockerCommand || ''), 'tacit-replenish would run replenish.js again');
});

test('settlement keeps its private-submission safety', () => {
  const s = svc('tacit-settle');
  ok(envKeys(s).includes('SETTLE_RPC_URLS'), 'private submission endpoints are not declared');
  const urls = (s.envVars.find((e) => e.key === 'SETTLE_RPC_URLS') || {}).value || '';
  ok(/flashbots/.test(urls) || /mevblocker/.test(urls), 'SETTLE_RPC_URLS must name a private endpoint');
});

test('no secret VALUE is committed: keys that hold secrets are sync:false or absent', () => {
  for (const s of relay.services) for (const e of s.envVars || []) {
    if (/(_KEY|TOKEN|SECRET|PASSWORD)$/.test(e.key || '') && !/(_ADDR|_ADDRESS|_LEAD)/.test(e.key)) {
      ok(e.sync === false || e.value === undefined, `${s.name}.${e.key} has a committed value`);
    }
  }
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
