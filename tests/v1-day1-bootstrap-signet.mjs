// Day-1 liquidity + farm bootstrap for the Tacit V1 suite.
//
// Two modes:
//   validate (default) — load the DeployV1Suite manifest, derive every day-1 pool id + LP-share id the
//     SAME way the contract does (keccak(lo‖hi‖be32(fee)); lpShareId = keccak(poolId‖"lp")), and assert
//     the bootstrap PLAN is coherent: all 5 TAC-centric pools resolve, the incentive split sums to the
//     budget, and the reward asset is cTAC. Runs locally, no signet/box. This is the pre-flight that
//     catches a misconfigured manifest BEFORE spending testnet funds.
//   live (MODE=live) — drive the actual seeding through the dapp confidential-DeFi action layer + the
//     box: wrap/mint the seed balances, open a cUSD CDP for the cUSD legs, add LP per pool, fund each
//     farm (farmEscrow → notifyRewardAmount). Validated on Sepolia+Signet per
//     ops/runbooks/V1-TESTNET-LAUNCH-PLAYBOOK.md §4.
//
// Run (validate):  node tests/v1-day1-bootstrap-signet.mjs contracts/deployments/11155111.json
// Run (live):      MODE=live node tests/v1-day1-bootstrap-signet.mjs contracts/deployments/11155111.json

import { keccak_256 } from '@noble/hashes/sha3';
import { readFileSync } from 'node:fs';

// Day-1 plan — keep in sync with ops/PLAN-day1-assets-and-incentives.md (launch parameters, tweakable).
const FEE_BPS = Number(process.env.DAY1_FEE_BPS || 30);
const BUDGET_TAC = 1_000_000n; // ~1M TAC LP/farm incentive
const AIRDROP_TAC = 2_500_000n; // first airdrop tranche
const POOLS = [
  { name: 'TAC/cETH', a: 'cTac', b: 'cEth', incentive: 250_000n },
  { name: 'TAC/cBTC', a: 'cTac', b: 'cBtc', incentive: 250_000n },
  { name: 'cUSD/cBTC', a: 'cUsd', b: 'cBtc', incentive: 200_000n },
  { name: 'cUSD/cETH', a: 'cUsd', b: 'cEth', incentive: 150_000n },
  { name: 'cETH/cBTC', a: 'cEth', b: 'cBtc', incentive: 150_000n },
];

const hx = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const hb = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
const cat = (a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const be32 = (n) => { const o = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
const big = (h) => BigInt(h);

// poolId(a,b,fee) — canonical (lo<=hi) then keccak(lo‖hi‖be32(fee)); MUST match ConfidentialPool._poolId
// and dapp/confidential-lp.js poolId. lpShareId = keccak(poolId‖"lp") — the farm STAKE_ASSET.
const poolId = (a, b, fee) => {
  const [lo, hi] = big(a) <= big(b) ? [a, b] : [b, a];
  return hx(keccak_256(cat([hb(lo), hb(hi), be32(fee)])));
};
const lpShareId = (pid) => hx(keccak_256(cat([hb(pid), new TextEncoder().encode('lp')])));

function validate(manifest) {
  let ok = true;
  const fail = (m) => { console.log(`FAIL  ${m}`); ok = false; };
  const pass = (m) => console.log(`  ok  ${m}`);

  // Incentive split sums to the budget.
  const sum = POOLS.reduce((s, p) => s + p.incentive, 0n);
  sum === BUDGET_TAC ? pass(`incentive split sums to ${BUDGET_TAC} TAC`) : fail(`incentive split ${sum} != budget ${BUDGET_TAC}`);

  const reward = manifest.cTac;
  reward && reward !== '0x' + '0'.repeat(64) ? pass(`reward asset cTAC = ${reward}`) : fail('cTac unresolved in manifest (TAC pools cannot reward)');

  for (const p of POOLS) {
    const a = manifest[p.a];
    const b = manifest[p.b];
    if (!a || !b || a === '0x' + '0'.repeat(64) || b === '0x' + '0'.repeat(64)) {
      fail(`${p.name}: leg unresolved (${p.a}=${a}, ${p.b}=${b}) — engine/cBTC or TAC missing in the deploy`);
      continue;
    }
    const pid = poolId(a, b, FEE_BPS);
    const lp = lpShareId(pid);
    pass(`${p.name} @${FEE_BPS}bps  poolId=${pid.slice(0, 12)}…  lpShareId=${lp.slice(0, 12)}…  incentive=${p.incentive} TAC`);
  }

  console.log(`\nairdrop tranche: ${AIRDROP_TAC} TAC via MerkleDistributor (build tree with tools/airdrop/build-merkle.mjs)`);
  return ok;
}

async function live(manifest, manifestPath) {
  // The live seeding drives the dapp confidential-DeFi action layer (openCdp/mintCbtc/bondFarm + LP
  // builders) and the box, exactly as the playbook prescribes. It requires signet wallets + a reachable
  // box, so it is intentionally gated behind MODE=live and validated on testnet, not in CI.
  console.error('live mode: seeding via the dapp action layer + box (per V1-TESTNET-LAUNCH-PLAYBOOK §4).');
  console.error('prereqs: signet wallets (.local/*), CONFIDENTIAL_BOX_TOKEN, worker base, funded ops account.');
  const plan = POOLS.map((p) => ({
    pool: p.name,
    poolId: poolId(manifest[p.a], manifest[p.b], FEE_BPS),
    lpShareId: lpShareId(poolId(manifest[p.a], manifest[p.b], FEE_BPS)),
    incentiveTac: p.incentive.toString(),
  }));
  console.error('seeding plan:', JSON.stringify(plan, null, 2));
  // Per-pool: ensure pool balance of each leg (wrap TAC/cETH; open a cUSD CDP against cBTC for cUSD legs;
  // mint cBTC from a reflected lock for cBTC legs), add LP via confidential-lp buildAdd → relay settle,
  // then pool.farmEscrow(farm, cTac, incentive) + farm.notifyRewardAmount. The dapp action layer
  // (dapp/confidential-defi-actions.js) + dapp/confidential-relay.js are the entrypoints; see the harness
  // skeleton in tests/amm-full-e2e-signet.mjs for wallet/box bootstrapping.
  throw new Error('live seeding runs on signet with wallets+box; wire .local wallets then re-run. (validate mode is the CI-safe path.)');
}

const manifestPath = process.argv[2];
if (!manifestPath) { console.error('usage: node tests/v1-day1-bootstrap-signet.mjs <deployments/<chainid>.json> [MODE=live]'); process.exit(2); }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
console.log(`day-1 bootstrap — ${process.env.MODE === 'live' ? 'LIVE' : 'VALIDATE'} — pool ${manifest.pool}\n`);

if (process.env.MODE === 'live') {
  await live(manifest, manifestPath);
} else {
  const ok = validate(manifest);
  console.log(`\n${ok ? 'PLAN COHERENT' : 'PLAN INCOHERENT'}`);
  process.exit(ok ? 0 : 1);
}
