// worker-relay/src/lib/prover.js: an op the board's input builder cannot read fails at once and says which field, instead of falling through to the binary
// (minutes of start-up to say the same). Real ops are not affected: the builder reads every fixture below.
//   node --test tests/prover-bad-op.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const tmp = path.join(os.tmpdir(), `prover-bad-op-${process.pid}`);
Object.assign(process.env, { RPC_URL: process.env.RPC_URL || 'http://127.0.0.1:1', PROVER_BOARD: '1', FIXTURE_DIR: path.join(tmp, 'fixtures'), PROVER_OUT: path.join(tmp, 'out') });
const { proveSettle } = await import('../worker-relay/src/lib/prover.js');
const { stdinFor } = await import('../worker-relay/src/lib/spn/sp1-stdin.js');
const fixture = (f) => JSON.parse(readFileSync(new URL(`../contracts/sp1/confidential/fixtures/${f}.json`, import.meta.url), 'utf8'));

test('an op with a field missing fails at once, naming the field', async () => {
  const t0 = Date.now();
  await assert.rejects(proveSettle({ type: 'farmunbond', op: {}, memos: [], timeoutMs: 5000 }),
    (e) => /^exec:farmunbond — not an op the prover can read \(chainBinding is missing\)$/.test(e.message));
  assert.ok(Date.now() - t0 < 3000, 'it did not wait for a binary');
});

test('a field that is malformed is named as well', async () => {
  const op = fixture('farm_unbond_op');
  await assert.rejects(proveSettle({ type: 'farmunbond', op: { ...op, oldPath: 'nope' }, memos: [], timeoutMs: 5000 }),
    (e) => /not an op the prover can read \(oldPath must be an array\)/.test(e.message));
});

test('real ops are read by the builder, so none of them is turned away by this', () => {
  const pairs = [['farmunbond', 'farm_unbond_op'], ['farmbond', 'farm_bond_op'], ['farmharvest', 'farm_harvest_op'], ['wrap', 'wrap_op'], ['transfer', 'transfer_op'],
    ['unwrap', 'unwrap_op'], ['cdpclose', 'cdp_close_op']];
  for (const [type, f] of pairs) assert.doesNotThrow(() => stdinFor(type, { ...fixture(f), memoHashes: [] }), `${type}: ${f}`);
});
