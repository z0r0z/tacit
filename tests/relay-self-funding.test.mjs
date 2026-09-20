// The relay funds the wallets that actually spend, and charges for the work it actually does.
//
// Four independent things were broken at once on 2026-09-20, and each was individually invisible:
//   1. the replenish cron was suspended, so the flywheel had never run;
//   2. SETTLE_KEY is split from RELAY_KEY, and both the monitor and replenish looked only at RELAY_KEY —
//      so the wallet that earns the fees and burns the settle gas was neither watched nor funded;
//   3. the fee gate accepted any op without `op.feeUsd` for free, which was every op;
//   4. the maintenance lane (Bitcoin header attestation) was absent from the cost model, so every op was
//      priced below its true cost.
//
// (1) is an operator action. The other three are pinned here, because all three failed silently and the
// only symptom was a wallet quietly reaching zero.
//
// Run: node tests/relay-self-funding.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const chain = read('worker-relay/src/lib/chain.js');
const config = read('worker-relay/src/lib/config.js');
const monitor = read('worker-relay/src/balance-monitor.js');
const replenish = read('worker-relay/src/replenish.js');
const settle = read('worker-relay/src/settle-relay.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
const test = (label, fn) => {
  try { fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};

console.log('relay self-funding:\n');

test('fundedWallets names both spending roles and dedupes them', () => {
  ok(/export const fundedWallets/.test(chain), 'fundedWallets not exported');
  ok(/\['relay', relayWallet\]/.test(chain) && /\['settle', settleWallet\]/.test(chain),
    'fundedWallets must cover both the relay and settle roles');
  // SETTLE_KEY defaults to RELAY_KEY. A single-key deployment must collapse to ONE entry carrying both
  // roles, or the monitor double-reports and replenish sweeps the same wallet twice.
  ok(/seen\.get\(addr\)/.test(chain) && /prior\.roles\.push\(role\)/.test(chain),
    'a shared key must collapse to one entry with both roles, not two entries');
});

test('the monitor checks every funded wallet, not just RELAY_KEY', () => {
  const block = monitor.slice(monitor.indexOf('async function checkEth'), monitor.indexOf('async function checkSnapshotCapacity'));
  ok(/for \(const \{ address, roles \} of fundedWallets\)/.test(block), 'checkEth does not iterate fundedWallets');
  ok(!/relayWallet\.account\.address/.test(block), 'checkEth still pins the relay wallet');
  // A settle wallet and a maintenance-only wallet do not cost the same per run, so they must not be
  // priced with the same figure.
  ok(/roles\.includes\('settle'\)/.test(block), 'runway must distinguish a settle wallet from a maintenance one');
  ok(/OP_GAS\.maintenance/.test(block), 'a maintenance-only wallet must be priced on maintenance gas');
});

test('replenish sweeps and funds every wallet from its own income', () => {
  ok(/for \(const \{ address: owner, wallet, roles \} of fundedWallets\)/.test(replenish),
    'the sweep loop does not iterate fundedWallets');
  // Every write must go through the per-wallet handle. A stray `relayWallet.` inside the loop would send
  // one wallet's swap from another's key, which is exactly the bug being fixed.
  const loop = replenish.slice(replenish.indexOf('for (const { address: owner, wallet, roles }'), replenish.indexOf("log('replenish done')"));
  ok(!/relayWallet\./.test(loop), 'the sweep loop still references relayWallet directly');
  for (const call of ['maxPreApprove(assets, wallet)', 'fireSwap(q, wallet)', 'depositProveToVApp(wallet)']) {
    ok(loop.includes(call), `sweep loop does not pass the wallet through: ${call}`);
  }
});

test('gas is bought before PROVE', () => {
  // A wallet that cannot pay for a transaction cannot buy PROVE either, so the exact-out gas leg has to
  // clear first. If these ever swap order a drained wallet can never recover on its own.
  const loop = replenish.slice(replenish.indexOf('for (const { address: owner, wallet, roles }'), replenish.indexOf("log('replenish done')"));
  const gasLeg = loop.indexOf('gas top-up');
  const proveLeg = loop.indexOf('-> ~${q.amountOut} PROVE', gasLeg);
  ok(gasLeg > -1 && proveLeg > gasLeg, 'the ETH gas top-up must precede the PROVE conversion');
});

test('the cost model carries the maintenance lane', () => {
  ok(/maintenance: 264_000n/.test(config), 'measured maintenance gas missing');
  ok(/MAINTENANCE_RUNS_PER_DAY/.test(config), 'maintenance cadence not configurable');
  ok(/maintenanceCostUsd/.test(replenish), 'quoteRelayFee does not price maintenance');
  ok(/costUsd = gasCostUsd \+ proveCostUsd \+ maintenanceCostUsd/.test(replenish),
    'maintenance must be part of costUsd, not just reported alongside it');
});

test('maintenance overhead is amortised, and cannot divide by zero', () => {
  ok(/Math\.max\(1, CFG\.expectedOpsPerDay\)/.test(replenish), 'EXPECTED_OPS_PER_DAY=0 would divide by zero');
});

test('an unpriced op is visible, and refusable', () => {
  ok(/unpricedJobs\+\+/.test(settle), 'unpaid jobs are not counted');
  ok(/UNPAID:/.test(settle), 'unpaid jobs are not logged');
  ok(/CFG\.requirePricedFee/.test(settle), 'no way to refuse unpriced ops');
  ok(/RELAY_REQUIRE_PRICED_FEE/.test(config), 'the switch is not env-configurable');
});

test('refusing unpriced ops stays OFF by default', () => {
  // Nothing populates op.feeUsd yet, so a default-on switch would refuse every job in production.
  ok(/opt\('RELAY_REQUIRE_PRICED_FEE', '0'\) === '1'/.test(config),
    'RELAY_REQUIRE_PRICED_FEE must default to off until the producer is wired');
});

test('the fee model still moves with live gas and live PROVE', () => {
  // The whole point is being dynamic. A quote that stops reading live inputs silently reverts to the
  // static fallbacks and misprices everything.
  ok(/liveGasGwei/.test(replenish), 'fee quote no longer takes live gas');
  ok(/export async function provePriceUsd/.test(replenish), 'live PROVE pricing removed');
  ok(/ethUsdPrice/.test(chain), 'live ETH price feed removed');
});

// ── the fee is derived, not declared ────────────────────────────────────────
const settler = read('worker/src/confidential-settle.js');
const worker = read('worker/src/index.js');

test('a client-supplied feeUsd is stripped BEFORE the job id is derived', () => {
  ok(/'feeUsd' in op\) delete op\.feeUsd/.test(settler), 'submitJob must drop a caller-supplied op.feeUsd');
  // Position is the security property, not just the deletion: jobIdOf hashes the op, so stripping after
  // the id was taken would let a caller vary a field the guest never reads to mint a fresh id for the
  // same op and slip past dedup.
  const strip = settler.indexOf('delete op.feeUsd');
  const idAt = settler.indexOf('const id = jobIdOf(');
  ok(strip > -1 && idAt > -1 && strip < idAt, 'op.feeUsd must be stripped before jobIdOf hashes the op');
});

test('the relay reads only the worker-derived fee', () => {
  // The bypass: op is client JSON. Reading op.feeUsd would let an integrator declare its own fee.
  ok(/const feeUsd = Number\(job\.feeUsd \?\? NaN\)/.test(settle), 'feeGate must read job.feeUsd only');
  ok(!/job\.op\?\.feeUsd/.test(settle), 'feeGate still reads the client-controlled op.feeUsd');
});

test('the pricer derives from the op witness, not from any declared field', () => {
  ok(/function buildFeePricer/.test(worker), 'buildFeePricer missing');
  ok(/totalFee\(type, op\)/.test(worker), 'pricer must read the op\'s own fee legs');
  ok(/feeUsd: null/.test(worker), 'an unpriceable asset must yield null, not a guess');
});

test('the derived fee actually reaches the relay', () => {
  // Storing feeUsd on the job is only half of it: nextJob/nextBatch project a SUBSET of the job, and both
  // originally dropped it — which would have left the gate seeing undefined and calling every job unpaid,
  // with all the wiring in place and inert.
  const projections = settler.match(/jobId: id, type: j\.type, op: j\.op[^\n]*/g) || [];
  ok(projections.length >= 2, `expected nextJob and nextBatch projections, found ${projections.length}`);
  for (const p of projections) ok(/feeUsd: j\.feeUsd/.test(p), `a job projection drops feeUsd: ${p.slice(0, 60)}…`);
});

test('pricing failure never fails a submit', () => {
  ok(/catch \{ priced = null; \}/.test(settler), 'a blinking oracle must not reject a user op');
});

test('metering is no longer something the fee floor can switch off', () => {
  // The old coupling: RELAY_FEE_FLOOR=1 skipped metering entirely, but the gate only prices cETH — so it
  // re-opened zero-fee floods for every other asset. That is why the floor could never be turned on.
  ok(!/submitMode === 'prove' \|\| env\.RELAY_FEE_FLOOR !== '1'/.test(worker),
    'metering is still gated on RELAY_FEE_FLOOR');
  ok(/const paying = submitMode !== 'prove' && feeFloorOn/.test(worker), 'no separate paid bucket');
  ok(/'paid', Number\(env\.PAID_RL_BURST/.test(worker), 'paid submits must use their own bucket');
});

test('rate-limit buckets cannot collide', () => {
  // Same IP, two buckets, one KV namespace — the bucket name has to be in the key.
  ok(/cps:rl:\$\{bucket\}:\$\{ip\}/.test(worker), 'bucket name missing from the rate-limit key');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
