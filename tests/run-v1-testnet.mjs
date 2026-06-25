// V1 testnet (Sepolia + Signet) day-1 launch test ORCHESTRATOR.
//
// The greenlight-to-mainnet bottleneck is real-block latency: signet ~10-min blocks × the reflection
// confirmation depth + the box prove cycle dwarf everything else. So this runs the day-1 feature matrix as
// a dependency DAG over MANY wallets, so independent flows — and especially the Bitcoin-confirmation-heavy
// cross-chain ones — overlap instead of summing. It also proves COVERAGE: every desired day-1 feature maps
// to a job, so a green run is a complete run.
//
// Two modes:
//   plan (default) — validate the DAG (deps exist, no cycle, wallets declared), simulate the parallel
//     schedule (deps + per-wallet exclusivity + a concurrency cap), print the waves + estimated wall-clock
//     vs the serial sum + the critical path, and assert the feature coverage is complete. Runs locally.
//   live (MODE=live) — execute the jobs as child processes on that schedule, stream pass/fail, and emit a
//     single GREENLIGHT verdict. Needs the manifest + funded wallets + the box (per the playbook).
//
// Run (plan): node tests/run-v1-testnet.mjs
// Run (live): MODE=live MANIFEST=contracts/deployments/11155111.json node tests/run-v1-testnet.mjs

import { spawn } from 'node:child_process';

const MAX_PARALLEL = Number(process.env.MAX_PARALLEL || 8);

// Wallet roles — distinct so independent flows never contend on UTXOs/nonces. The five
// Bitcoin-confirmation-heavy cross-chain flows each get their OWN btc wallet so their confirmation windows
// overlap (the whole point: makespan ≈ one confirmation window, not five).
const WALLETS = [
  'ops', 'opsBtc',                       // deployer/treasury (eth) + signet funder
  'ethA', 'ethB',                        // 2-party confidential pool (otc/bid/transfer)
  'lp', 'trader', 'zapper', 'relayer', 'claimant',
  'maker', 'taker',                      // orderbook
  'btcCbtc', 'btcDeposit', 'btcCeth', 'btcRefl', 'bsmSender', 'bsmRecipient', // parallel cross-chain
];

// Each job: id, the day-1 features it covers, the chain whose block-time dominates, the wallets it holds
// (exclusive while running), its deps, a rough wall-clock etaSec (for the schedule estimate), and the live
// command. cross = Bitcoin confirmations + a prove cycle (the slow ones).
const JOBS = [
  { id: 'fund-btc', features: ['signet-funding'], chain: 'btc', wallets: ['opsBtc'], deps: [], etaSec: 700,
    cmd: 'node tests/gen-amm-e2e-signet-wallets.mjs' },
  { id: 'deploy', features: ['deploy', 'wiring', 'engine', 'pools', 'farms-deployed'], chain: 'eth', wallets: ['ops'], deps: [], etaSec: 180,
    cmd: 'contracts/deploy-v1-suite-testnet.sh' },
  { id: 'sync', features: ['config-sync'], chain: 'eth', wallets: ['ops'], deps: ['deploy'], etaSec: 20,
    cmd: 'node tools/sync-deployment-config.mjs "$MANIFEST" --network signet --write' },
  { id: 'fund-eth', features: ['sepolia-funding'], chain: 'eth', wallets: ['ops'], deps: ['deploy'], etaSec: 60,
    cmd: 'node tests/v1-fund-wallets.mjs eth' },
  { id: 'bootstrap', features: ['lp-seed', 'farm-fund', 'cdp-seed', 'wrap'], chain: 'eth', wallets: ['ops'], deps: ['sync', 'fund-eth'], etaSec: 600,
    cmd: 'MODE=live node tests/v1-day1-bootstrap-signet.mjs "$MANIFEST"' },
  { id: 'airdrop', features: ['airdrop-claim', 'airdrop-clawback'], chain: 'eth', wallets: ['claimant'], deps: ['deploy'], etaSec: 150,
    cmd: 'node tests/airdrop-e2e-signet.mjs' },

  // Relay-tip advancer: DeployTestnetRelay only genesis()-es the relay; the pool's _anchorReflection bars
  // every attestBitcoinStateProven (the whole cross-chain lane) until the relay tip walked back
  // REFLECTION_CONFIRMATIONS reaches GENESIS_REFLECTION_ANCHOR. So advance the tip BEFORE any cross-chain flow
  // runs (the deploy script does the initial maturity; this keeps it live during the long confirmation
  // windows). Distinct from the attest loop (reflection-relay-loop.sh), which never advances headers.
  // Requires RELAY_ADDRESS (the freshly-deployed relay — not in the manifest) + RELAY_PK/SEPOLIA_PK in env.
  { id: 'relay-advance', features: ['relay-advance'], chain: 'cross', wallets: ['ops'], deps: ['deploy', 'bootstrap'], etaSec: 300,
    cmd: 'scripts/advance-relay.sh --count 20' },

  // Ethereum-fast confidential-pool flows (parallel, ~12s blocks).
  { id: 'amm', features: ['swap', 'route', 'lp-add', 'lp-remove', 'protocol-fee', 'fee-tiers'], chain: 'cross', wallets: ['lp', 'trader'], deps: ['bootstrap', 'fund-btc'], etaSec: 900,
    cmd: 'node tests/amm-full-e2e-signet.mjs' },
  { id: 'cxfer', features: ['transfer', 'unwrap', 'stealth-send'], chain: 'btc', wallets: ['ethA'], deps: ['fund-btc'], etaSec: 600,
    cmd: 'node tests/cxfer-bpp-onchain-e2e-signet.mjs' },
  { id: 'otc-bid', features: ['otc', 'bid'], chain: 'btc', wallets: ['ethB'], deps: ['fund-btc'], etaSec: 600,
    cmd: 'node tests/preauth-bid-var-onchain-e2e-signet.mjs' },
  { id: 'zap', features: ['router-zap'], chain: 'eth', wallets: ['zapper'], deps: ['bootstrap'], etaSec: 200,
    cmd: 'PHASE=4 MODE=live node tests/v1-day1-e2e-signet.mjs "$MANIFEST"' },
  { id: 'relayer', features: ['relayed-settle', 'self-settle'], chain: 'eth', wallets: ['relayer'], deps: ['bootstrap'], etaSec: 200,
    cmd: 'MODE=live node tests/relayer-fee-collection-signet.mjs "$MANIFEST"' },
  { id: 'cdp', features: ['cdp-mint', 'cdp-topup', 'cdp-close', 'cdp-liquidate', 'oracle'], chain: 'eth', wallets: ['ethB'], deps: ['bootstrap', 'otc-bid'], etaSec: 700,
    cmd: 'MODE=live node tests/cdp-lifecycle-signet.mjs "$MANIFEST"' },
  { id: 'orderbook', features: ['orderbook', 'rfq', 'adaptor-lock', 'adaptor-claim', 'adaptor-refund'], chain: 'cross', wallets: ['maker', 'taker'], deps: ['bootstrap'], etaSec: 900,
    cmd: 'PHASE=5 MODE=live node tests/v1-day1-e2e-signet.mjs "$MANIFEST"' },

  // Bitcoin-confirmation-heavy cross-chain flows — each on its OWN btc wallet so confirmation windows
  // overlap. All gated on relay-advance: until the relay tip matures the genesis anchor, every attest reverts.
  { id: 'cbtc', features: ['cbtc-lock', 'cbtc-mint', 'eth-escrow', 'slashing'], chain: 'cross', wallets: ['btcCbtc'], deps: ['bootstrap', 'fund-btc', 'relay-advance'], etaSec: 3900,
    cmd: 'MODE=live node tests/cbtc-backing-broadcast-signet.mjs "$MANIFEST"' },
  { id: 'deposit', features: ['bridge-mint'], chain: 'cross', wallets: ['btcDeposit'], deps: ['bootstrap', 'fund-btc', 'relay-advance'], etaSec: 3900,
    cmd: 'MODE=live node tests/bridge-sepolia-signet-e2e.mjs "$MANIFEST"' },
  { id: 'ceth', features: ['ceth-roundtrip', 'bridge-burn', 'crossout'], chain: 'cross', wallets: ['btcCeth'], deps: ['bootstrap', 'fund-btc', 'relay-advance'], etaSec: 3900,
    cmd: 'MODE=live node tests/crossout-mint-broadcast-cli.mjs "$MANIFEST"' },
  { id: 'reflection', features: ['reflection', 'fast-lane', 'consumed-nu'], chain: 'cross', wallets: ['btcRefl'], deps: ['bootstrap', 'fund-btc', 'relay-advance'], etaSec: 1800,
    cmd: 'MODE=live node tests/reflection-fastlane-broadcast-signet.mjs "$MANIFEST"' },
  { id: 'bridge-stealth', features: ['bridge-stealth-mint', 'stealth-claim'], chain: 'cross', wallets: ['bsmSender', 'bsmRecipient'], deps: ['bootstrap', 'fund-btc', 'relay-advance'], etaSec: 3900,
    cmd: 'MODE=live node tests/bridge-stealth-mint-signet-e2e.mjs' },
];

// Every day-1 feature the launch must demonstrate on real blocks. A green run must cover ALL of these.
const DESIRED = [
  'deploy', 'wiring', 'config-sync', 'relay-advance', 'lp-seed', 'farm-fund', 'wrap', 'transfer', 'unwrap',
  'swap', 'route', 'lp-add', 'lp-remove', 'protocol-fee', 'fee-tiers', 'otc', 'bid',
  'cdp-mint', 'cdp-topup', 'cdp-close', 'cdp-liquidate', 'oracle',
  'cbtc-lock', 'cbtc-mint', 'eth-escrow', 'slashing',
  'bridge-mint', 'bridge-burn', 'crossout', 'ceth-roundtrip', 'reflection', 'fast-lane', 'consumed-nu',
  'router-zap', 'orderbook', 'rfq', 'adaptor-lock', 'adaptor-claim', 'adaptor-refund',
  'relayed-settle', 'self-settle', 'bridge-stealth-mint', 'stealth-claim',
  'airdrop-claim', 'airdrop-clawback',
];

// ── validation ───────────────────────────────────────────────────────────────
function validate() {
  const ids = new Set(JOBS.map((j) => j.id));
  const wset = new Set(WALLETS);
  const errs = [];
  for (const j of JOBS) {
    for (const d of j.deps) if (!ids.has(d)) errs.push(`${j.id}: unknown dep ${d}`);
    for (const w of j.wallets) if (!wset.has(w)) errs.push(`${j.id}: undeclared wallet ${w}`);
  }
  // cycle detection (DFS)
  const color = {};
  const visit = (id, stack) => {
    color[id] = 1;
    for (const d of JOBS.find((j) => j.id === id).deps) {
      if (color[d] === 1) errs.push(`cycle: ${[...stack, id, d].join(' → ')}`);
      else if (!color[d]) visit(d, [...stack, id]);
    }
    color[id] = 2;
  };
  for (const j of JOBS) if (!color[j.id]) visit(j.id, []);
  // coverage
  const covered = new Set(JOBS.flatMap((j) => j.features));
  const missing = DESIRED.filter((f) => !covered.has(f));
  return { errs, missing };
}

// Critical path = longest dependency chain by etaSec (the wall-clock lower bound, infinite parallelism).
function criticalPath() {
  const memo = {};
  const len = (id) => {
    if (memo[id] != null) return memo[id];
    const j = JOBS.find((x) => x.id === id);
    const base = Math.max(0, ...j.deps.map(len));
    return (memo[id] = base + j.etaSec);
  };
  return Math.max(...JOBS.map((j) => len(j.id)));
}

// Simulate the greedy scheduler: deps + per-wallet exclusivity + a concurrency cap → makespan + waves.
function schedule() {
  const done = new Set();
  const launchedSet = new Set();
  const busyWallet = new Map(); // wallet → freeAt
  let running = []; // {id, end, wallets}
  let t = 0;
  const order = [];
  const remaining = new Set(JOBS.map((j) => j.id));

  const canStart = (j) =>
    !launchedSet.has(j.id) && j.deps.every((d) => done.has(d)) &&
    j.wallets.every((w) => (busyWallet.get(w) || 0) <= t);

  let guard = 0;
  while (remaining.size && guard++ < 10000) {
    // launch everything startable now, up to the cap
    let launched = true;
    while (launched) {
      launched = false;
      if (running.length >= MAX_PARALLEL) break;
      for (const j of JOBS) {
        if (running.length >= MAX_PARALLEL) break;
        if (canStart(j)) {
          launchedSet.add(j.id);
          const end = t + j.etaSec;
          running.push({ id: j.id, end, wallets: j.wallets });
          for (const w of j.wallets) busyWallet.set(w, end);
          order.push({ id: j.id, start: t, end, wallets: j.wallets });
          launched = true;
        }
      }
    }
    if (!running.length) break; // stuck (shouldn't happen if validated)
    // advance to the next finish
    const next = Math.min(...running.map((r) => r.end));
    t = next;
    for (const r of running.filter((r) => r.end <= t)) { done.add(r.id); remaining.delete(r.id); }
    running = running.filter((r) => r.end > t);
  }
  return { makespan: t, order };
}

function fmt(sec) { const m = Math.round(sec / 60); return `${sec}s (~${m}m)`; }

function plan() {
  const { errs, missing } = validate();
  console.log('V1 testnet run — PLAN\n');
  console.log(`jobs: ${JOBS.length}   wallets: ${WALLETS.length}   max-parallel: ${MAX_PARALLEL}\n`);

  const { makespan, order } = schedule();
  // group the order into waves by start time for display
  const waves = {};
  for (const o of order) (waves[o.start] ||= []).push(o.id);
  console.log('schedule (start → jobs):');
  for (const t of Object.keys(waves).map(Number).sort((a, b) => a - b)) {
    console.log(`  t+${String(t).padStart(5)}s  ${waves[t].join(', ')}`);
  }
  const serial = JOBS.reduce((s, j) => s + j.etaSec, 0);
  console.log(`\nserial (one at a time): ${fmt(serial)}`);
  console.log(`critical path (lower bound): ${fmt(criticalPath())}`);
  console.log(`scheduled wall-clock (≤${MAX_PARALLEL} parallel, wallet-exclusive): ${fmt(makespan)}`);
  console.log(`speedup vs serial: ${(serial / makespan).toFixed(1)}×`);

  console.log(`\ncoverage: ${DESIRED.length - missing.length}/${DESIRED.length} day-1 features mapped to a job`);
  let ok = true;
  if (errs.length) { ok = false; console.log('\nDAG ERRORS:'); errs.forEach((e) => console.log(`  ✗ ${e}`)); }
  if (missing.length) { ok = false; console.log(`\nUNCOVERED FEATURES: ${missing.join(', ')}`); }
  console.log(`\n${ok ? 'PLAN OK — DAG valid, coverage complete' : 'PLAN INVALID'}`);
  process.exit(ok ? 0 : 1);
}

// ── live executor ──────────────────────────────────────────────────────────────
async function live() {
  const { errs, missing } = validate();
  if (errs.length || missing.length) { console.error('refusing to run an invalid/incomplete plan; run plan mode'); process.exit(1); }
  if (!process.env.MANIFEST) { console.error('set MANIFEST=contracts/deployments/<chainid>.json'); process.exit(2); }
  const done = new Set(), failed = new Set(), started = new Set();
  const busyWallet = new Set();
  const results = {};
  let running = 0;

  const runnable = () => JOBS.filter((j) =>
    !started.has(j.id) && j.deps.every((d) => done.has(d)) && j.wallets.every((w) => !busyWallet.has(w)) &&
    !j.deps.some((d) => failed.has(d)));
  const blocked = () => JOBS.filter((j) => !started.has(j.id) && j.deps.some((d) => failed.has(d)));

  await new Promise((resolve) => {
    const pump = () => {
      for (const b of blocked()) { started.add(b.id); failed.add(b.id); results[b.id] = 'SKIPPED (dep failed)'; console.log(`  ⊘ ${b.id} skipped`); }
      while (running < MAX_PARALLEL) {
        const j = runnable()[0];
        if (!j) break;
        started.add(j.id); running++; j.wallets.forEach((w) => busyWallet.add(w));
        console.log(`  ▶ ${j.id}  [${j.wallets.join(',')}]`);
        const child = spawn('bash', ['-lc', j.cmd], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, MODE: 'live' } });
        child.on('exit', (code) => {
          running--; j.wallets.forEach((w) => busyWallet.delete(w));
          if (code === 0) { done.add(j.id); results[j.id] = 'PASS'; console.log(`  ✓ ${j.id}`); }
          else { failed.add(j.id); results[j.id] = `FAIL (exit ${code})`; console.log(`  ✗ ${j.id}`); }
          if (started.size === JOBS.length && running === 0) resolve();
          else pump();
        });
      }
      if (started.size === JOBS.length && running === 0) resolve();
    };
    pump();
  });

  console.log('\n──────── GREENLIGHT REPORT ────────');
  for (const j of JOBS) console.log(`  ${(results[j.id] || '—').padEnd(22)} ${j.id}  (${j.features.join(', ')})`);
  const greenlit = JOBS.every((j) => results[j.id] === 'PASS');
  console.log(`\n${greenlit ? 'GREENLIGHT — every day-1 feature passed on real blocks' : 'NOT GREENLIT — failures above'}`);
  process.exit(greenlit ? 0 : 1);
}

if (process.env.MODE === 'live') await live();
else plan();
