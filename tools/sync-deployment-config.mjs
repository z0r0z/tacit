// Wire a DeployV1Suite manifest (contracts/deployments/<chainid>.json) into the dapp + worker config,
// closing the manual step in ops/CHECKLIST-sepolia-full-suite.md §4.
//
// Writes/patches two locations:
//   1. dapp/confidential-crossout-consumer.js  CONFIDENTIAL_POOL_DEPLOYMENTS[net] = { pool, deployBlock }
//      (regex patch — the worker imports this module, so one edit wires the indexer scan too)
//   2. dapp/confidential-deployments.generated.js  DEPLOY_OVERRIDES[net] = { pool, router,
//      collateralEngine, deployBlock, assetIds:{cEth,cTac,cBtc,cUsd}, tac } — the single source merged by
//      confidential-deployments.js into the whole confidential dapp (pool/DeFi/OTC/send/swap + cross-lane
//      holdings). Written wholesale (no fragile regex over the asset register).
//
// By default it does NOT flip any asset `live: true` flag — advertising a DeFi route is a separate,
// conscious gate (CHECKLIST stop-conditions, playbook §7). The opt-in `--live <tickers>` flag (default OFF)
// flips the named tickers for the target network (via the override + the merge loop in
// confidential-deployments.js), making §4's flip scriptable + reviewable instead of a hand-edit.
// Dry-run by default; pass --write to apply.
//
// --network defaults from the manifest chainId (11155111 → 'signet' testnet / Sepolia EVM; 1 → 'mainnet').
// --deploy-block defaults to manifest.deployBlock (the indexer scan-from height) so it's never silently stale.
//
// Usage:
//   node tools/sync-deployment-config.mjs <manifest.json> [--network signet|mainnet] [--deploy-block N] [--live cETH,cTAC] [--write]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const manifestPath = argv.find((a) => !a.startsWith('--'));
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};
const write = !!flag('write', false);
// Opt-in, default OFF: a comma-list of tickers whose `live` flag this run flips to true in
// confidential-deployments.js. Advertising a route is a conscious gate, so it stays explicit + reviewable.
const liveFlag = flag('live', false);
const liveTickers = typeof liveFlag === 'string'
  ? liveFlag.split(',').map((t) => t.trim()).filter(Boolean)
  : [];

if (!manifestPath) {
  console.error('usage: node tools/sync-deployment-config.mjs <manifest.json> [--network signet|mainnet] [--deploy-block N] [--live cETH,cTAC] [--write]');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// --network defaults from the manifest's chainId so the wrapper can hand us a bare Sepolia (11155111) json.
// Sepolia is the dapp's 'signet' testnet network (Bitcoin-side name; EVM side is Sepolia — see
// confidential-deployments.js currentNetworkName()).
let network = flag('network');
if (!network) {
  if (manifest.chainId === 11155111) network = 'signet';
  else if (manifest.chainId === 1) network = 'mainnet';
}
if (network !== 'signet' && network !== 'mainnet') {
  console.error(`bad/missing --network ${network ?? ''} (manifest chainId=${manifest.chainId}; expected 11155111→signet or 1→mainnet)`);
  process.exit(2);
}

// --deploy-block defaults to the manifest's deployBlock (the indexer scan-from height) so the worker/dapp
// never silently keep a stale config block when the flag is omitted.
const deployBlock = flag('deploy-block', manifest.deployBlock != null ? String(manifest.deployBlock) : undefined);

const pool = manifest.pool;
if (!/^0x[0-9a-fA-F]{40}$/.test(pool || '')) { console.error(`manifest has no valid pool address: ${pool}`); process.exit(1); }
console.error(`pool=${pool} network=${network}${deployBlock ? ` deployBlock=${deployBlock}` : ''}${liveTickers.length ? ` live=${liveTickers.join(',')}` : ''} ${write ? '(WRITE)' : '(dry-run)'}`);

let changed = 0;

// 1. CONFIDENTIAL_POOL_DEPLOYMENTS[net] = { pool, deployBlock }
patch(
  join(ROOT, 'dapp/confidential-crossout-consumer.js'),
  new RegExp(`(${network}:\\s*\\{\\s*pool:\\s*)(?:'0x[0-9a-fA-F]{40}'|null)(,\\s*deployBlock:\\s*)(\\d+)`),
  (m, p1, p2, oldBlock) => `${p1}'${pool}'${p2}${deployBlock ?? oldBlock}`,
  'CONFIDENTIAL_POOL_DEPLOYMENTS'
);

// 2. DEPLOY_OVERRIDES[net] in dapp/confidential-deployments.generated.js — written wholesale from the
//    manifest's addresses + keccak asset ids (economics like decimals/scale stay in the static defaults).
const genFile = join(ROOT, 'dapp/confidential-deployments.generated.js');
const cur = (() => {
  try {
    const src = readFileSync(genFile, 'utf8');
    const m = src.match(/export const DEPLOY_OVERRIDES = (\{[\s\S]*\});\s*$/);
    return m ? JSON.parse(m[1]) : {};
  } catch { return {}; }
})();
const opt = (v) => (/^0x[0-9a-fA-F]{40}$/.test(v || '') ? v : undefined);
const id32 = (v) => (/^0x[0-9a-fA-F]{64}$/.test(v || '') ? v : undefined);
cur[network] = {
  pool,
  router: opt(manifest.router),
  collateralEngine: opt(manifest.engine),
  deployBlock: deployBlock != null ? Number(deployBlock) : (cur[network] && cur[network].deployBlock) || undefined,
  tac: opt(manifest.tac),
  assetIds: {
    cEth: id32(manifest.cEth),
    cTac: id32(manifest.cTac),
    cBtc: id32(manifest.cBtc),
    cUsd: id32(manifest.cUsd),
  },
  // --live <tickers>: the merge loop in confidential-deployments.js flips these tickers' `live:true` for
  // this network. Absent (default) ⇒ key omitted ⇒ the static `live` (false) stands. Conscious gate.
  ...(liveTickers.length ? { live: liveTickers } : {}),
};
const genBody = `// GENERATED — do not edit by hand. Written by tools/sync-deployment-config.mjs from a DeployV1Suite\n`
  + `// manifest. Merged over the static defaults in confidential-deployments.js.\n`
  + `export const DEPLOY_OVERRIDES = ${JSON.stringify(cur, null, 2)};\n`;
if (readFileSync(genFile, 'utf8') !== genBody) {
  console.error(`  ${write ? '✎' : 'Δ'}  DEPLOY_OVERRIDES[${network}]: pool=${pool} router=${cur[network].router || '—'} engine=${cur[network].collateralEngine || '—'}${liveTickers.length ? ` live=${liveTickers.join(',')}` : ''}`);
  if (write) writeFileSync(genFile, genBody);
  changed++;
} else {
  console.error('  ok  DEPLOY_OVERRIDES: already current');
}

console.error(`\n${changed} edit(s) ${write ? 'applied' : 'pending (dry-run; rerun with --write)'}.`);
if (!write && changed === 0) process.exit(1);

function patch(file, re, replacer, label) {
  const src = readFileSync(file, 'utf8');
  const m = src.match(re);
  if (!m) { console.error(`FAIL  ${label}: pattern for ${network} not found in ${file}`); process.exit(1); }
  const next = src.replace(re, replacer);
  if (next === src) { console.error(`  ok  ${label}: already current`); return; }
  console.error(`  ${write ? '✎' : 'Δ'}  ${label}: ${m[0].replace(/\s+/g, ' ').slice(0, 80)} ...`);
  if (write) writeFileSync(file, next);
  changed++;
}
