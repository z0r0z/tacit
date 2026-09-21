#!/usr/bin/env node
// Farm monitor: reads the FarmManager over public RPC and prints the program's health.
//
//   node tools/farm-monitor.mjs [--json]
//
// Exit code 0 ok, 1 warn, 2 critical (an unreadable chain is critical). Env: RPC (one endpoint, or several separated by
// commas), FARM_MANAGER_ADDR.
import { makeRpc, checkFarm, publicProgram, FARM_MANAGER_MAINNET, FARM_RPCS_MAINNET } from '../worker-relay/src/lib/farm-health.js';

const json = process.argv.includes('--json');
const rpcs = process.env.RPC ? process.env.RPC.split(',').map((s) => s.trim()).filter(Boolean) : FARM_RPCS_MAINNET;
const manager = process.env.FARM_MANAGER_ADDR || FARM_MANAGER_MAINNET;
const CODE = { ok: 0, warn: 1, critical: 2 };

let out;
try {
  const { program, health } = await checkFarm({ rpc: makeRpc(rpcs), manager });
  out = { ...health, program: program.codeMissing ? null : publicProgram(program) };
} catch (e) {
  out = { status: 'critical', checks: [{ name: 'rpc', status: 'critical', detail: `farm state unreadable: ${e?.message || e}` }], program: null };
}

if (json) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const w = Math.max(...out.checks.map((c) => c.name.length));
  console.log(`farm ${manager}  ${out.status.toUpperCase()}`);
  for (const c of out.checks) console.log(`  ${c.status.toUpperCase().padEnd(8)} ${c.name.padEnd(w)}  ${c.detail}`);
  const p = out.program;
  if (p) {
    console.log(`\n  epoch  ${p.epoch.ratePerDayTac} TAC/day, ${(p.epoch.remainingSeconds / 86400).toFixed(1)}d left, treasury ${p.epoch.treasuryTac}, outstanding ${p.epoch.outstandingTac}`);
    console.log('  pid  pair        share%   TAC/day        shares');
    for (const q of p.pools) console.log(`  ${String(q.pid).padEnd(4)} ${q.pair.padEnd(11)} ${q.sharePct.padStart(6)}  ${q.tacPerDayForPool.padStart(12)}  ${q.totalShares}${q.idle ? '  (idle)' : ''}`);
  }
}
process.exit(CODE[out.status]);
