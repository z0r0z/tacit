// Approves a claim for a reviewed task step on the live points service, after reading it here first.
//
//   node worker-relay/scripts/tasks-approve.mjs --job coingecko-listing --step 01-filer --tx 0x…           what the claim is and what approving it does (changes nothing)
//   node worker-relay/scripts/tasks-approve.mjs --job coingecko-listing --step 01-filer --tx 0x… --apply   also approve it (POST /tasks/approve), then show where it stands
//
// The reading is the service's own: a successful transaction from an account to itself, twelve blocks deep, whose 32 bytes are what the step asks for
// (a Bitcoin transaction id, or an id of the shape `evidence` names). What the script cannot read is the work itself (a CoinGecko request, a bridge
// round trip): that is read by hand, and approving is saying it was. Nothing is sent without --apply, and nothing when the reading fails.
//
// The key is POINTS_TASKS_ADMIN_SECRET on tacit-points: give it as TASKS_ADMIN_SECRET, or keep it in the macOS keychain item `tacit-tasks-admin-secret`
// (read inline, never printed). TASKS_API names another service (default https://tacit-points.onrender.com) and TASKS_ETH_RPC a node (a comma list).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkJob, evidenceText, stepChain } from '../src/lib/points-tasks.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const has = (f) => process.argv.includes(`--${f}`);
const root = fileURLToPath(new URL('../../', import.meta.url));
const API = process.env.TASKS_API || 'https://tacit-points.onrender.com';
const RPCS = (process.env.TASKS_ETH_RPC || 'https://ethereum-rpc.publicnode.com,https://rpc.mevblocker.io,https://eth.drpc.org').split(',');
const lc = (s) => String(s || '').toLowerCase();
const stop = (msg) => { console.error(msg); process.exit(1); };

const [jobId, stepId, tx] = [arg('job'), arg('step'), lc(arg('tx'))];
if (!jobId || !stepId || !/^0x[0-9a-f]{64}$/.test(tx)) stop('usage: tasks-approve.mjs --job <id> --step <id> --tx <hash> [--apply]');
const jobs = JSON.parse(readFileSync(`${root}worker-relay/src/lib/points-tasks-jobs.json`, 'utf8')).jobs.map(checkJob);
const job = jobs.find((j) => j.id === jobId), step = job?.steps.find((s) => s.id === stepId);
if (!step || step.kind !== 'review') stop(`${jobId}/${stepId} is not a reviewed step of a listed job`);
const chain = stepChain(job, step);
if (chain !== 1) stop('this script reads Ethereum only');

async function rpc(method, params) {
  for (const u of RPCS) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20e3) });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
    } catch { /* the next node */ }
  }
  return null;
}

const [t, rc, head] = await Promise.all([rpc('eth_getTransactionByHash', [tx]), rpc('eth_getTransactionReceipt', [tx]), rpc('eth_blockNumber', [])]);
const checks = [];
const check = (ok, what) => { checks.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
if (!t || !rc) stop('FAIL the transaction is not on Ethereum (or no node answered)');
const depth = parseInt(head, 16) - parseInt(rc.blockNumber, 16) + 1;
console.log(`claim ${tx}\n  from ${t.from}\n  to   ${t.to}`);
check(rc.status === '0x1', 'it succeeded');
check(lc(t.from) === lc(t.to), 'it is a transaction from the account to itself');
check(/^0x[0-9a-f]{64}$/i.test(t.input || ''), `it carries exactly 32 bytes (${((t.input || '').length - 2) / 2})`);
check(depth >= 12, `it is ${depth} blocks deep (twelve needed)`);
const named = /^0x[0-9a-f]{64}$/i.test(t.input || '') ? evidenceText(t.input) : '';
if (step.evidence) {
  console.log(`  names "${named}"`);
  check(new RegExp(step.evidence.pattern).test(named), `what it names looks like what the step asks for (${step.evidence.pattern})`);
} else console.log(`  names ${t.input} (a transaction id: read it on its own chain)`);
console.log(`  pays ${Number(BigInt(step.minWei) / 10n ** 16n) / 100} TAC to ${t.from}, once`);

let state = null;
try {
  const view = await (await fetch(`${API}/tasks`, { signal: AbortSignal.timeout(20e3) })).json();
  const mine = view.claims?.find((c) => c.job === jobId && c.step === stepId);
  state = mine ? `already claimed by ${mine.address} (${mine.state}, tx ${mine.txHash})` : 'not claimed yet';
  if (view.budget) console.log(`  budget left ${Number(BigInt(view.budget.remainingWei) / 10n ** 16n) / 100} TAC`);
} catch { state = 'the service did not answer'; }
console.log(`  step state: ${state}`);
check(!/already claimed/.test(state), 'the step is still open');

const good = checks.every(Boolean);
if (!has('apply')) { console.log(good ? '\nreads as a valid claim. Add --apply to approve it.' : '\nthis claim does not read as valid; nothing to approve.'); process.exit(good ? 0 : 1); }
if (!good) stop('\nnot approving: the claim does not read as valid.');

let key = process.env.TASKS_ADMIN_SECRET;
if (!key) { try { key = execFileSync('security', ['find-generic-password', '-s', 'tacit-tasks-admin-secret', '-w'], { encoding: 'utf8' }).trim(); } catch { /* none */ } }
if (!key) stop('\nno key: set TASKS_ADMIN_SECRET or the keychain item tacit-tasks-admin-secret');
const res = await fetch(`${API}/tasks/approve`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ job: jobId, step: stepId, txHash: tx }), signal: AbortSignal.timeout(60e3) });
const out = await res.json().catch(() => ({}));
console.log(`\nPOST /tasks/approve -> ${res.status}\n${JSON.stringify(out, null, 2)}`);
process.exit(res.ok ? 0 : 1);
