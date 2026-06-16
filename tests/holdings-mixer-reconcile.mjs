#!/usr/bin/env node
// Holdings reconciliation — proves scanHoldingsComplete's core (reconcileMixerHoldings)
// folds un-withdrawn pool notes back into a wallet's "what do I own" total, so a deposit
// (whose UTXO leaves scanHoldings) is no longer silently uncounted, WITHOUT double-counting
// a deposit that's already been withdrawn (whose fresh UTXO scanHoldings does count).
//
// The function lives in the browser script dapp/tacit.js (no ES exports), so we extract its
// real source and run it in a sandbox — the test tracks the shipped code, no drift.
//
// Run: node tests/holdings-mixer-reconcile.mjs

import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const SRC = readFileSync(new URL('../dapp/tacit.js', import.meta.url), 'utf8').split('\n');
function extract(name) {
  const re = new RegExp('^(?:async )?function ' + name + '\\b');
  const start = SRC.findIndex((l) => re.test(l));
  if (start < 0) throw new Error('function not found in tacit.js: ' + name);
  let end = start;
  while (end < SRC.length && SRC[end] !== '}') end++;
  if (end >= SRC.length) throw new Error('no closing brace for: ' + name);
  return SRC.slice(start, end + 1).join('\n');
}
const { reconcileMixerHoldings } = new Function(
  extract('reconcileMixerHoldings') + '\nreturn { reconcileMixerHoldings };')();

let n = 0;
const ok = (s) => { console.log('  ok -', s); n++; };
const AAA = 'aa'.repeat(32);
const BBB = 'bb'.repeat(32);
const dep = (assetIdHex, denomination, nullifierHashHex, extra = {}) =>
  ({ assetIdHex, denomination: String(denomination), nullifierHashHex, ...extra });
const never = () => false;
// Mirror of scanHoldingsComplete's isSpent: terminal local status OR canonical nullifier set.
const terminal = (r) => r.status === 'withdrawn' || r.status === 'burned' ||
  r.status === 'exported' || r.status === 'rotated' || r.withdrawTxid || r.exportTxid;
const isSpentWith = (set) => (r) => terminal(r) || set.has(r.nullifierHashHex);

// ── 1. spendable-only: no deposits → total == spendable ──
let r = reconcileMixerHoldings(new Map([[AAA, { balance: 100n }]]), [], never);
assert.strictEqual(r.get(AAA).spendable, 100n);
assert.strictEqual(r.get(AAA).inMixer, 0n);
assert.strictEqual(r.get(AAA).total, 100n);
ok('spendable balance passes through with no pool notes');

// ── 2. an un-withdrawn deposit is added to inMixer + total, never to spendable ──
r = reconcileMixerHoldings(new Map([[AAA, { balance: 100n }]]), [dep(AAA, 40, 'n1')], never);
assert.strictEqual(r.get(AAA).spendable, 100n, 'spendable untouched');
assert.strictEqual(r.get(AAA).inMixer, 40n, 'pool note counted as inMixer');
assert.strictEqual(r.get(AAA).total, 140n, 'total = spendable + inMixer');
assert.strictEqual(r.get(AAA).mixerCount, 1);
ok('un-withdrawn deposit lifts the total (the gap #1 fix) without inflating spendable');

// ── 3. a withdrawn deposit is excluded (its fresh UTXO is already in scanHoldings) ──
r = reconcileMixerHoldings(new Map([[AAA, { balance: 100n }]]),
  [dep(AAA, 40, 'n1', { status: 'withdrawn' })], isSpentWith(new Set()));
assert.strictEqual(r.get(AAA).inMixer, 0n, 'local terminal status → not counted');
assert.strictEqual(r.get(AAA).total, 100n, 'no double-count of a withdrawn deposit');
ok('withdrawn deposit (local status) excluded — no double-count');

// ── 4. canonical nullifier-set spent signal also excludes (cross-device withdraw) ──
r = reconcileMixerHoldings(new Map([[AAA, { balance: 0n }]]),
  [dep(AAA, 40, 'n2'), dep(AAA, 25, 'n3')], isSpentWith(new Set(['n2'])));
assert.strictEqual(r.get(AAA).inMixer, 25n, 'only the un-spent note (n3) counts');
assert.strictEqual(r.get(AAA).mixerCount, 1);
ok('canonical isSpent predicate excludes a withdrawn note');

// ── 5. an asset held ONLY in the pool surfaces (spendable 0, inMixer > 0) ──
r = reconcileMixerHoldings(new Map(), [dep(BBB, 70, 'n4')], never);
assert.strictEqual(r.get(BBB).spendable, 0n);
assert.strictEqual(r.get(BBB).total, 70n);
ok('an asset with only pool notes appears in the reconciled view');

// ── 6. duplicate records (same nullifier) counted once ──
r = reconcileMixerHoldings(new Map(), [dep(AAA, 40, 'n5'), dep(AAA, 40, 'n5')], never);
assert.strictEqual(r.get(AAA).inMixer, 40n, 'dedupe by nullifier');
assert.strictEqual(r.get(AAA).mixerCount, 1);
ok('duplicate deposit records deduped by nullifier');

// ── 7. malformed records skipped, not thrown on ──
r = reconcileMixerHoldings(new Map([[AAA, { balance: 5n }]]),
  [null, {}, dep(AAA, '0', 'n6'), dep(AAA, 'xyz', 'n7'), dep(AAA, 12, 'n8')], never);
assert.strictEqual(r.get(AAA).inMixer, 12n, 'zero/NaN/empty denom skipped, valid one kept');
assert.strictEqual(r.get(AAA).total, 17n);
ok('malformed / zero-denom records skipped without throwing');

console.log(`\n${n} checks passed`);
