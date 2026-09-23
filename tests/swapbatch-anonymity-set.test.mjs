#!/usr/bin/env node
// A one-intent Bitcoin swap batch is not confidential (dapp/confidential-swapbatch.js).
//
// The T_SWAP_BATCH envelope carries the batch's NET reserve deltas and net blinding excesses in cleartext —
// that is how the fold checks conservation without opening anything. Across several intents those nets hide
// each trade; with exactly one, the net IS the trade, readable off the Bitcoin transaction by anyone. The
// fold must keep accepting n_intents == 1 (it is consensus and nothing is stealable), so the refusal belongs
// to the builder. This pins the guard and that the fold is untouched by it.
//
// Run: node tests/swapbatch-anonymity-set.test.mjs

import assert from 'node:assert';
import { assertBatchAnonymitySet } from '../dapp/confidential-swapbatch.js';

let n = 0; const ok = (s) => { n++; console.log('  ok -', s); };

// ── 1. a single-intent batch is refused, and says why ──
{
  assert.throws(
    () => assertBatchAnonymitySet({ nIntents: 1 }),
    /not confidential/,
    'refuses a batch of one',
  );
  assert.throws(
    () => assertBatchAnonymitySet({ nIntents: 1 }),
    /amount in and amount out/,
    'names what leaks, not just that something does',
  );
  ok('a single-intent batch is refused with the leak spelled out');
}

// ── 2. an explicit acknowledgement is the way to trade transparently on purpose ──
{
  assert.strictEqual(assertBatchAnonymitySet({ nIntents: 1, acknowledgeSingleIntent: true }), 1, 'acknowledged, allowed');
  assert.strictEqual(assertBatchAnonymitySet({ nIntents: 2 }), 2, 'two intents need no acknowledgement');
  assert.strictEqual(assertBatchAnonymitySet({ nIntents: 16 }), 16, 'the full batch is fine');
  ok('an acknowledged single intent passes, and any real batch passes unconditionally');
}

// ── 3. the count itself is validated ──
{
  for (const bad of [0, -1, 17, 1.5, 'two', undefined]) {
    assert.throws(() => assertBatchAnonymitySet({ nIntents: bad }), /n_intents must be 1\.\.16/, `rejects ${String(bad)}`);
  }
  ok('an out-of-range or non-integer intent count is rejected before the privacy check');
}

// ── 4. the fold is not gated by this — a confirmed one-intent batch still folds ──
{
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../dapp/confidential-swapbatch.js', import.meta.url), 'utf8'));
  const fold = src.slice(src.indexOf('export async function foldSwapBatch'));
  assert.ok(!fold.includes('assertBatchAnonymitySet'), 'foldSwapBatch does not call the builder guard');
  assert.ok(fold.includes('const ni = '), 'foldSwapBatch still derives its own intent count');
  ok('foldSwapBatch is untouched: the chain’s view of a one-intent batch is unchanged');
}

console.log(`\n${n}/4 swap-batch anonymity-set checks passed`);
