// The prove failures a relay reports on its heartbeat (the monitor pages on them) are the prover's: a pool that refuses an op as it stands (code 'op_refused', the proof
// itself fine) is a verdict on the job and is not counted. Pinned in the source, as the relay is a script that cannot be loaded.
// Offline: node --test worker-relay/tests/prove-failure-count.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/settle-relay.js', import.meta.url), 'utf8');

test('the single path counts a prove failure unless the pool refused the op as it stands', () => {
  assert.match(src, /prove failed\/timeout: \$\{e\.message\}`\);\s*\n[^\n]*\n\s*if \(e\.code !== 'op_refused'\) noteProveFailure\(\);/);
  assert.equal((src.match(/noteProveFailure\(\);/g) || []).length, 2, 'one for the sealed path, one for the single path');
});

test('the board prover marks such a refusal with that code', () => {
  assert.match(readFileSync(new URL('../src/lib/board-prover.js', import.meta.url), 'utf8'), /code: 'op_refused'/);
});

test('an op the input builder cannot read is a verdict on the op as well: not counted, and its reason reaches the holder', () => {
  const prover = readFileSync(new URL('../src/lib/prover.js', import.meta.url), 'utf8');
  assert.match(prover, /not an op the prover can read[^\n]*\), \{ code: 'op_refused' \}\)/);
  const m = /function proveFailureForJob\(e\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, 'proveFailureForJob is in the relay');
  assert.match(m[0], /not an op the prover can read/, 'the reason is passed on, not replaced by "try again in a few minutes"');
});
