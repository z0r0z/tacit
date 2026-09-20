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

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
