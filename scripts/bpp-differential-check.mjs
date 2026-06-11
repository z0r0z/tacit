#!/usr/bin/env node
// BPP-3: regenerate-then-diff JS↔Rust differential for the Bulletproofs+ range
// proof. Catches drift between the JS prover (dapp/bulletproofs-plus.js) and the
// Rust consensus verifier (cxfer-core::verify_range): a JS change that the
// pinned fixtures don't happen to cover would otherwise pass behind a green
// suite. Also fuzzes lightly — the prover draws fresh randomness each run, so
// every invocation feeds the Rust verifier a NEW proof.
//
// Flow: back up the committed fixtures → regenerate them from current JS →
// run the Rust differential tests → restore the fixtures (tree stays clean).
// Non-zero exit on any drift. Suitable for a CI step.
//
// Run: node scripts/bpp-differential-check.mjs

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { copyFileSync, existsSync, unlinkSync } from 'node:fs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIX = join(ROOT, 'contracts/sp1/confidential/fixtures');
const CRATE = join(ROOT, 'contracts/sp1/confidential/cxfer-core');

// (gen script, fixture file) pairs. Each gen writes JSON to stdout.
const GENS = [
  ['tests/gen-cxfer-fixture.mjs', join(FIX, 'cxfer.json')],
  ['tests/gen-bpp-out-of-range-fixture.mjs', join(FIX, 'bpp_out_of_range.json')],
];
// Rust tests that consume those fixtures (libtest treats multiple filters as OR).
const RUST_TESTS = [
  'range_accepts_js_proof_and_rejects_tamper',
  'range_rejects_out_of_range_commitment',
];

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'pipe', encoding: 'utf8', cwd: ROOT, ...opts });

const backups = [];
let failed = false;
try {
  // 1. back up + 2. regenerate from current JS
  for (const [gen, fixture] of GENS) {
    if (existsSync(fixture)) { const bak = fixture + '.diffbak'; copyFileSync(fixture, bak); backups.push([bak, fixture]); }
    console.log(`regenerating ${fixture.replace(ROOT + '/', '')} from ${gen}`);
    run(`node ${gen} > "${fixture}"`, { shell: '/bin/bash' });
  }
  // 3. run the Rust differential against the freshly regenerated fixtures
  console.log(`running Rust differential (${RUST_TESTS.join(', ')}) ...`);
  const out = run(`cargo test --release -- ${RUST_TESTS.join(' ')} 2>&1`, { cwd: CRATE });
  process.stdout.write(out);
  const m = out.match(/test result:\s+ok\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/);
  if (!m || Number(m[2]) !== 0 || Number(m[1]) < RUST_TESTS.length) {
    failed = true;
    console.error(`\nDRIFT: expected >= ${RUST_TESTS.length} passing, 0 failing.`);
  } else {
    console.log(`\nOK: JS proofs (freshly regenerated) verify under the Rust consensus verifier — no drift.`);
  }
} catch (e) {
  failed = true;
  console.error('\nDIFFERENTIAL FAILED:\n' + (e.stdout || '') + (e.stderr || e.message || ''));
} finally {
  // 4. restore committed fixtures so the working tree is unchanged
  for (const [bak, fixture] of backups) { try { copyFileSync(bak, fixture); unlinkSync(bak); } catch {} }
}

process.exit(failed ? 1 : 0);
