// The header feeder's cadence knobs are opt-in: with nothing set it submits as soon as any block exists and honours
// the gas ceiling exactly as it always did; with HEADER_RELAY_MIN_BATCH it waits to send one transaction for a
// batch; and HEADER_RELAY_MAX_STALE_BLOCKS bounds how far behind the relay can be left, whatever the gas price.
//
// Run: node tests/header-cadence.test.mjs

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { planHeaderAdvance as plan } from '../worker-relay/src/lib/header-plan.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const base = 1000;

// ── defaults are the original behaviour ─────────────────────────────────────────────────────────────────────
assert.deepStrictEqual(plan({ base, to: base, maxBatch: 40 }), { action: 'idle', pending: 0 });
assert.deepStrictEqual(plan({ base, to: base - 3, maxBatch: 40 }), { action: 'idle', pending: 0 });
ok('nothing pending is idle');
assert.deepStrictEqual(plan({ base, to: base + 1, maxBatch: 40 }), { action: 'advance', from: 1001, to: 1001, forced: false });
ok('defaults: one new block is submitted straight away');
assert.deepStrictEqual(plan({ base, to: base + 100, maxBatch: 40 }), { action: 'advance', from: 1001, to: 1040, forced: false });
ok('defaults: a backlog is clipped to the batch size');
assert.deepStrictEqual(plan({ base, to: base + 5, maxBatch: 40, gasDear: true }), { action: 'wait', reason: 'gas', pending: 5 });
ok('defaults: the gas ceiling still holds a submit');

// ── minimum batch ───────────────────────────────────────────────────────────────────────────────────────────
assert.deepStrictEqual(plan({ base, to: base + 23, minBatch: 24, maxBatch: 40 }), { action: 'wait', reason: 'batching', pending: 23 });
assert.deepStrictEqual(plan({ base, to: base + 24, minBatch: 24, maxBatch: 40 }), { action: 'advance', from: 1001, to: 1024, forced: false });
ok('a minimum batch waits, then sends the whole batch at once');
assert.deepStrictEqual(plan({ base, to: base + 30, minBatch: 24, maxBatch: 40, gasDear: true }), { action: 'wait', reason: 'gas', pending: 30 });
ok('a full batch still waits for the gas ceiling');
assert.deepStrictEqual(plan({ base, to: base + 2, minBatch: 24, maxBatch: 40, restore: true }), { action: 'advance', from: 1001, to: 1002, forced: false });
assert.deepStrictEqual(plan({ base, to: base + 2, minBatch: 24, maxBatch: 40, restore: true, gasDear: true }), { action: 'wait', reason: 'gas', pending: 2 });
ok('restoring the canonical chain skips the batching wait but not the gas ceiling');

// ── staleness bound ─────────────────────────────────────────────────────────────────────────────────────────
assert.deepStrictEqual(plan({ base, to: base + 47, minBatch: 24, maxStale: 48, maxBatch: 40, gasDear: true }), { action: 'wait', reason: 'gas', pending: 47 });
assert.deepStrictEqual(plan({ base, to: base + 48, minBatch: 24, maxStale: 48, maxBatch: 40, gasDear: true }), { action: 'advance', from: 1001, to: 1040, forced: true });
ok('at the staleness bound the gas ceiling stops holding the relay back');
assert.deepStrictEqual(plan({ base, to: base + 10, minBatch: 24, maxStale: 8, maxBatch: 40 }), { action: 'advance', from: 1001, to: 1010, forced: true });
ok('the staleness bound overrides a larger minimum batch');
assert.strictEqual(plan({ base, to: base + 500, maxStale: 0, maxBatch: 40, gasDear: true }).action, 'wait');
ok('a zero staleness bound is off');

// ── wiring: defaults in config, and the feeder actually uses the plan ───────────────────────────────────────────
const config = readFileSync(join(ROOT, 'worker-relay/src/lib/config.js'), 'utf8');
assert.match(config, /headerMinBatch: num\('HEADER_RELAY_MIN_BATCH', 1\)/);
assert.match(config, /headerMaxStaleBlocks: num\('HEADER_RELAY_MAX_STALE_BLOCKS', 0\)/);
ok('both knobs default to the original behaviour');
const feeder = readFileSync(join(ROOT, 'worker-relay/src/header-relay.js'), 'utf8');
assert.match(feeder, /planHeaderAdvance\(\{/);
assert.match(feeder, /submitAdvance\(plan\.from, plan\.to\)/);
ok('the feeder submits what the plan says');

console.log(`\n${n} checks passed`);
