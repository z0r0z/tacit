#!/usr/bin/env node
/**
 * Audit T3-03 — pin two invariants in CI:
 *
 *  (A) Every NEW deposit-record creation site in the dapp + tests generates
 *      `nullifierPreimage` from a fresh CSPRNG call (crypto.getRandomValues
 *      or randomBytes(32)) or a documented deterministic-unique derivation
 *      (_derive*NullifierPreimage). Reusing a preimage across notes would
 *      collide their nullifier_hash (= poseidon(preimage), no denom binding
 *      pre-ceremony-2) → second note becomes permanently unspendable (user
 *      self-lock; not a drain).
 *
 *  (B) The SP1 guest uses a SINGLE GLOBAL null_set across all denoms — not
 *      per-denom. If anyone ever refactors to per-denom sets, the same
 *      preimage used across two denoms would NOT conflict per-denom → could
 *      be burned twice → double-withdraw → real drain. The global set is
 *      THE backstop until the circuit is upgraded to bind denom into the
 *      nullifier (deferred — needs new ceremony).
 *
 * Fails CI loudly if either invariant slips.
 */

import fs from 'fs';

const REPO = new URL('..', import.meta.url).pathname;

// ─── (A) preimage freshness ────────────────────────────────────────
const DAPP_SOURCES = [
  'dapp/tacit.js',
  'tests/bridge-3a.mjs',
  'tests/bridge-3b.mjs',
];

const FRESH_PATTERNS = [
  /\bcrypto\.getRandomValues\b/,           // browser/Node webcrypto
  /\brandomBytes\s*\(\s*32\s*\)/,          // Node's crypto.randomBytes
  /\b_derive[A-Za-z]*NullifierPreimage\b/, // documented deterministic-unique
];

const RECOVERY_PATTERNS = [
  /\bhexToBytes\b/,                        // recovered from stored record
  /out\.nullifierPreimage\b/,              // caller-supplied (lint elsewhere)
  /noteRecord\.nullifierPreimage/,
  /depositRecord\.nullifierPreimage/,
  /slotRecord\.nullifierPreimage/,
];

let failed = 0;
for (const rel of DAPP_SOURCES) {
  const path = `${REPO}${rel}`;
  if (!fs.existsSync(path)) { console.warn(`  ${rel}: not present, skipping`); continue; }
  const src = fs.readFileSync(path, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match `const|let nullifierPreimage = ...` (declaration patterns only;
    // pure assignment `noteRecord.nullifierPreimage = ...` is mutation of an
    // existing record and out of scope for this freshness check)
    const m = line.match(/(?:const|let)\s+(nullifierPreimage|preimagePool|preimageEth|nullPreimage|preimage)\b\s*=/);
    if (!m) continue;
    const varName = m[1];
    // Look at this line + next 3 lines (multi-line RHS expressions) for either
    // fresh-random or recovery patterns.
    const ctx = lines.slice(i, Math.min(lines.length, i + 4)).join('\n');
    const isFresh = FRESH_PATTERNS.some(p => p.test(ctx));
    const isRecovery = RECOVERY_PATTERNS.some(p => p.test(ctx));
    // A bare `preimage` variable named in a tx-construction context (BIP-143
    // sighash preimage assembly) is not a nullifier preimage. Identify by the
    // sighash-assembly patterns and skip — those are NOT inputs to poseidon
    // nullifier_hash and so are out of scope for this freshness invariant.
    if (varName === 'preimage' && /\b(Buffer\.concat|concatBytes)\b/.test(ctx) &&
        /\b(nVersion|nSequence|nLocktime|hashOutputs|hashPrevouts|scriptCode|sighash)\b/i.test(ctx)) continue;
    if (!isFresh && !isRecovery) {
      console.error(`${rel}:${i + 1}: ${varName} assignment may not be fresh-random or recovery`);
      console.error(`  > ${line.trim()}`);
      failed++;
    }
  }
}
if (failed === 0) {
  console.log(`(A) preimage-freshness: OK across ${DAPP_SOURCES.length} files`);
} else {
  console.error(`(A) preimage-freshness: FAIL — ${failed} suspect sites`);
}

// ─── (B) single-global nullifier set in guest ──────────────────────
const GUEST_MAIN = `${REPO}contracts/sp1/program/src/main.rs`;
const guestSrc = fs.readFileSync(GUEST_MAIN, 'utf8');
// The guest should declare exactly ONE null_set binding (mut or otherwise).
// Count production code only — strip the #[cfg(test)] module, whose unit
// tests legitimately construct their own NullifierSet instances.
const prodSrc = guestSrc.split(/\n\s*#\[cfg\(test\)\]/)[0];
const nullSetDecls = (prodSrc.match(/\blet\s+(?:mut\s+)?null_set\s*[:=]/g) || []).length;
// And should NEVER declare a per-denom nullifier set (e.g., Vec<NullifierSet>)
const perDenomShape = /Vec\s*<\s*(?:merkle\s*::\s*)?NullifierSet\s*>|\[\s*(?:merkle\s*::\s*)?NullifierSet\s*;\s*[A-Z0-9_]+\s*\]/.test(prodSrc);

let bFailed = false;
if (nullSetDecls !== 1) {
  console.error(`(B) global-null-set: FAIL — found ${nullSetDecls} null_set declarations (expected exactly 1)`);
  bFailed = true;
}
if (perDenomShape) {
  console.error(`(B) global-null-set: FAIL — guest appears to declare a per-denom nullifier set shape`);
  console.error(`    A per-denom set without coordinated denom-binding circuit upgrade enables a double-withdraw → drain.`);
  console.error(`    See audit T3-03 + ops/AUDIT-teth-bridge-mainnet-readiness-2026-05-29.md.`);
  bFailed = true;
}
if (!bFailed) {
  console.log('(B) global-null-set: OK — guest uses a single global NullifierSet');
}

if (failed > 0 || bFailed) {
  console.error('\nT3-03 invariants violated; refusing to merge.');
  process.exit(1);
}
console.log('\nT3-03 invariants PIN: both halves OK');
