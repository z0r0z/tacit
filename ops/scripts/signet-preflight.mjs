#!/usr/bin/env node
// Signet V1 preflight — one-glance "is the dapp ready to test, and if not, whose gate is it?"
//
// Separates the three failure classes the dapp report flagged:
//   (A) box / re-prove gate   — pool vkey vs the pinned ELF, box liveness, op-27-30 allowlist
//   (B) config sync           — pool/router/engine/factory wired to the live (vanity) suite
//   (C) day-1 seeding         — assets registered, pools seeded with liquidity, farms deployed
//
// A red in (A)/(B) means "fix the pipeline"; a red only in (C) means "the dapp is ready, you just
// haven't seeded yet" — exactly the distinction that turns a confusing prove-fail into a to-do item.
//
// Run: node ops/scripts/signet-preflight.mjs   (add --net mainnet for the mainnet suite)
//   exit 0 = ready to test the wired surfaces; exit 1 = a pipeline gate (A/B) is red.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../../node_modules/@noble/hashes/sha3.js';
import * as secp from '../../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../../node_modules/@noble/hashes/sha2.js';
import { getConfidentialDeployment } from '../../dapp/confidential-deployments.js';
import { makeConfidentialPoolUx } from '../../dapp/confidential-pool-ux.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NET = (process.argv.includes('--net') ? process.argv[process.argv.indexOf('--net') + 1] : 'signet');
const EXPECTED_VKEY = '0x00f36e4cc98bafa005207e71c3832d751baf1bd9e85f085db802e5a88c09a3e1'; // re-proven ELF (ops 27-30)
const VANITY_PREFIX = '0x00000000'; // CreateX vanity suite leading bytes

// secp RFC-6979 sync HMAC (for any signing the ux touches; read paths don't need it but keep parity).
const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (k, ...m) => hmac(nobleSha256, k, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

const C = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m` };
let hardFail = false;
const PASS = (m) => console.log(`  ${C.g('✓')} ${m}`);
const FAIL = (m) => { console.log(`  ${C.r('✗')} ${m}`); hardFail = true; };
const WARN = (m) => console.log(`  ${C.y('⚠')} ${m}`);
const section = (t) => console.log(`\n${t}`);

const d = getConfidentialDeployment(NET);
if (!d) { console.error(`no deployment for net '${NET}'`); process.exit(2); }
console.log(`Tacit ${NET} V1 preflight — pool ${d.pool || '(unset)'}`);

// ── (A) box / re-prove gate ──────────────────────────────────────────────────
section('A. Box / re-prove gate');
try {
  const pin = JSON.parse(readFileSync(resolve(ROOT, 'contracts/sp1/confidential/elf-vkey-pin.json'), 'utf8'));
  if (pin.program_vkey === EXPECTED_VKEY) PASS(`pinned settle vkey == re-proven ELF (${EXPECTED_VKEY.slice(0, 10)}…, ops 27-30)`);
  else FAIL(`pinned settle vkey ${String(pin.program_vkey).slice(0, 10)}… != expected ${EXPECTED_VKEY.slice(0, 10)}… — box ELF drift / re-prove not landed`);
} catch (e) { FAIL(`could not read elf-vkey-pin.json: ${e.message}`); }

// op-27-30 acceptance in the worker allowlist + the box settle-loop harness map
const need = ['wraptransfer', 'lpbond'];
try {
  const allow = readFileSync(resolve(ROOT, 'worker/src/confidential-settle.js'), 'utf8');
  const miss = need.filter((t) => !allow.includes(`'${t}'`));
  miss.length ? FAIL(`worker submit allowlist missing: ${miss.join(', ')}`) : PASS('worker allowlist accepts wraptransfer + lpbond');
} catch (e) { WARN(`worker allowlist unreadable: ${e.message}`); }
try {
  const loop = readFileSync(resolve(ROOT, 'ops/scripts/confidential-settle-loop.sh'), 'utf8');
  const miss = need.filter((t) => !loop.includes(`${t})`));
  miss.length ? FAIL(`box settle-loop harness map missing: ${miss.join(', ')}`) : PASS('box settle-loop maps wraptransfer + lpbond to their harnesses');
} catch (e) { WARN(`box settle-loop unreadable: ${e.message}`); }

// box liveness (prover-health)
const base = d.relayBase;
if (base) {
  try {
    const res = await fetch(`${base}/prover-health`, { signal: AbortSignal.timeout(8000) });
    const h = await res.json().catch(() => ({}));
    if (h.healthy) PASS(`box healthy (last heartbeat ${h.last_heartbeat_ts ? new Date(h.last_heartbeat_ts).toISOString() : '?'})`);
    else WARN(`box not healthy: ${(h.reasons || ['unknown']).join('; ')} — settle jobs will queue but not prove`);
  } catch (e) { WARN(`prover-health unreachable (${e.name || e.message}) — can't confirm the box is up`); }
} else WARN('no relayBase configured — skipping box liveness');

// ── (B) config sync ──────────────────────────────────────────────────────────
section('B. Config sync (dapp → live suite)');
const set = (k) => d[k] && !/^0x0+$/.test(String(d[k]));
set('pool') ? PASS(`pool ${d.pool}`) : FAIL('pool not set');
if (d.pool && !d.pool.toLowerCase().startsWith(VANITY_PREFIX)) WARN(`pool is not a ${VANITY_PREFIX}… vanity address — confirm it's the re-proven suite`);
set('router') ? PASS(`router ${d.router}`) : WARN('router not set — wrap-and-send + 1-tx flows disabled');
set('assetFactory') ? PASS(`assetFactory ${d.assetFactory} (Create→Asset live)`) : WARN('assetFactory not set — Create→Asset disabled');
set('collateralEngine') ? PASS(`collateralEngine ${d.collateralEngine}`) : WARN('collateralEngine not set — CDP/cUSD disabled');

// Cross-lane link coherence: the dapp resolver merges tETH(BTC)↔cETH(ETH) (and any bitcoinLink asset) from
// the config-declared bitcoinLink, NOT an on-chain read of localAssetOf — so the config value MUST equal the
// deployed TETH_BITCOIN_ID. TETH_BITCOIN_LINK is internal (unreadable), but localAssetOf IS public: assert
// localAssetOf(bitcoinLink) == the asset's id. A mismatch silently splits the unified row / breaks bridged
// unwrap resolution. (MAINNET-V1-DEPLOY-CONFIG.md "Dapp reconcile".)
if (set('pool')) {
  const sel = '0x' + Array.from(keccak_256(new TextEncoder().encode('localAssetOf(bytes32)'))).slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
  const pad = (h) => String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0');
  for (const a of d.assets.filter((x) => x.bitcoinLink && x.assetId)) {
    try {
      const r = await fetch(d.rpcs[0], { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: d.pool, data: sel + pad(a.bitcoinLink) }, 'latest'] }) }).then((x) => x.json());
      const onchain = '0x' + pad(r.result || '0x0');
      const want = '0x' + pad(a.assetId);
      if (/^0x0+$/.test(onchain)) WARN(`${a.ticker} bitcoinLink not linked on-chain yet (localAssetOf=0) — set at pool construction; verify TETH_BITCOIN_ID was passed`);
      else if (onchain === want) PASS(`${a.ticker} bitcoinLink == on-chain localAssetOf (cross-lane merge sound)`);
      else FAIL(`${a.ticker} bitcoinLink MISMATCH: config→${want.slice(0, 12)}… but localAssetOf(${a.bitcoinLink.slice(0, 10)}…)=${onchain.slice(0, 12)}… — unified row will split`);
    } catch (e) { WARN(`${a.ticker} bitcoinLink on-chain check skipped: ${e.name || e.message}`); }
  }
}

// ── (C) day-1 seeding ────────────────────────────────────────────────────────
section('C. Day-1 seeding (assets → pools → farms → liquidity)');
const live = d.assets.filter((a) => a.assetId);
if (!live.length) WARN('no assets registered yet (assetIds empty) — Send/Swap/Earn show empty until you register + re-sync');
else PASS(`${live.length} asset(s) registered: ${live.map((a) => a.ticker).join(', ')}`);

const farms = d.farmControllers || {};
const nFarms = Object.keys(farms).length;
nFarms ? PASS(`${nFarms} farm controller(s) wired — Earn bonding enabled`) : WARN('no farm controllers yet — Earn 1-click bond disabled until farms deploy + re-sync');

// Pool reserves for the day-1 TAC pairs (only checkable once assets are registered).
const ids = (d.assetIds) || {};
const tac = ids.cTac;
const pairs = tac ? [['cETH/TAC', ids.cEth, tac], ['cBTC/TAC', ids.cBtc, tac], ['cUSD/TAC', ids.cUsd, tac]].filter((p) => p[1] && p[2]) : [];
if (!pairs.length) WARN('day-1 TAC pools not checkable yet (need cTAC + a paired asset registered)');
else {
  const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256 });
  for (const [label, a, b] of pairs) {
    try {
      const r = await ux.poolReserves(ux.routePoolId(a, b, 0)) || await ux.poolReserves(ux.routePoolId(a, b, 30));
      if (r && (r.reserveA > 0n || r.reserveB > 0n)) PASS(`${label} seeded (reserves ${r.reserveA}/${r.reserveB})`);
      else WARN(`${label} not seeded (no reserves) — Swap/Earn inert for this pair`);
    } catch (e) { WARN(`${label} reserve read failed: ${e.message}`); }
  }
}

// ── verdict ──────────────────────────────────────────────────────────────────
section('Verdict');
if (hardFail) {
  console.log(C.r('  ✗ A pipeline gate (box/re-prove or config) is RED — fix before testing the new ops.'));
  process.exit(1);
}
console.log(C.g('  ✓ Pipeline is GREEN. Wired surfaces are testable.'));
console.log(C.dim('    Any ⚠ above under (C) is seeding work, not a dapp/box fault — the dapp degrades cleanly to it.'));
process.exit(0);
