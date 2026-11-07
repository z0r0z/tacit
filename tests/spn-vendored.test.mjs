// The relay's copies of the program-input builder, the network client and the self-prover (worker-relay/src/lib/spn/) are
// the dapp's files, as code: the relay image is built from worker-relay/ alone, so it carries copies. The dapp's files are served with their comments
// stripped (build/strip-comments.mjs, which proves the program is unchanged) and the relay's copies keep them, so it is the code that must be the same.
//
// Run: node --test tests/spn-vendored.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from '../build/strip-comments.mjs';

for (const f of ['sp1-stdin.js', 'succinct-net.js', 'self-prover.js']) {
  test(`worker-relay/src/lib/spn/${f} equals dapp/${f}`, () => {
    const a = readFileSync(new URL(`../dapp/${f}`, import.meta.url), 'utf8');
    const b = readFileSync(new URL(`../worker-relay/src/lib/spn/${f}`, import.meta.url), 'utf8');
    assert.equal(stripComments(b), stripComments(a), `cp dapp/${f} worker-relay/src/lib/spn/${f}`);
  });
}
