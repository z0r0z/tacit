#!/usr/bin/env node
// Edge-case reflection scenarios where the assembler once disagreed with the guest (or threw). Each one runs a
// generator scenario and checks two things: the generator's own post-fold assertions pass, and the digest equals
// the committed fixture's newDigest, which verify-reflection-fixtures.sh replays through the guest.
//   node tests/confidential-reflection-fold-edge-scenarios.mjs

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const FXD = `${ROOT}contracts/sp1/confidential/fixtures`;

// [generator, env, fixture]
const CASES = [
  ['swapvar', { SWAPVAR_SCENARIO: 'unknown-pool' }, 'reflection_swapvar_unknown_pool'],
  ['swapvar', { SWAPVAR_SCENARIO: 'classic-change' }, 'reflection_swapvar_classic_change'],
  ['swapvar', { SWAPVAR_SCENARIO: 'tip-nonp2tr' }, 'reflection_swapvar_tip_nonp2tr'],
  ['swapvar', { SWAPVAR_SCENARIO: 'extra-input' }, 'reflection_swapvar_extra_input'],
  ['farminit', { FARMINIT_SCENARIO: 'extra-input' }, 'reflection_farminit_extra_input'],
  ['harvest', { HARVEST_SCENARIO: 'zero-reward' }, 'reflection_harvest_zero_reward'],
  ['farm-lifecycle', { LIFECYCLE_SCENARIO: 'unbond-nonp2tr' }, 'reflection_farm_lifecycle_unbond_nonp2tr'],
  ['lpbond', { LPBOND_SCENARIO: 'debt-overflow' }, 'reflection_lpbond_debt_overflow'],
  ['lpremove', { LPREMOVE_SCENARIO: 'refund-nonp2tr' }, 'reflection_lpremove_refund_nonp2tr'],
];

let failures = 0;
const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); failures++; } else console.log(`ok   ${m}`); };

for (const [gen, env, fixture] of CASES) {
  const label = `${gen} ${Object.values(env).join(',')}`;
  const r = spawnSync(process.execPath, [`${ROOT}tests/gen-reflection-${gen}-synth.mjs`], {
    env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) { ok(false, `${label}: generator failed\n${(r.stderr || '').split('\n').filter((l) => /FATAL|Error/.test(l)).join('\n')}`); continue; }
  let digest = null;
  try { digest = JSON.parse(r.stdout).newDigest; } catch { /* reported below */ }
  ok(/^0x[0-9a-f]{64}$/.test(digest || ''), `${label}: emits a reflection input`);
  const committed = JSON.parse(readFileSync(`${FXD}/${fixture}.json`, 'utf8')).newDigest;
  ok(digest === committed, `${label}: digest == committed ${fixture} (${committed})`);
}

console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exit(failures ? 1 : 0);
