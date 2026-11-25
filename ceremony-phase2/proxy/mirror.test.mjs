// node --test ceremony-phase2/proxy/mirror.test.mjs: the mirror copies only files of the pinned, signed chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trustedFiles } from './mirror.mjs';

const t = JSON.parse(readFileSync(new URL('../../dapp/praxis/transcript.json', import.meta.url)));

test('the published transcript is trusted end to end', async () => {
  const { files, why } = await trustedFiles(t);
  assert.equal(why, null);
  assert.equal(files.length, 1 + t.receipts.length);
});

test('a receipt with a changed field, a broken link or another key stops the copy there', async () => {
  const forged = structuredClone(t);
  forged.receipts[0].name = 'Mallory';
  assert.match((await trustedFiles(forged)).why, /not signed/);
  assert.equal((await trustedFiles(forged)).files.length, 1);

  const unlinked = structuredClone(t);
  unlinked.receipts[0].prev_file_sha256 = '00'.repeat(32);
  assert.match((await trustedFiles(unlinked)).why, /does not link/);

  const other = structuredClone(t);
  other.coordinator_pubkey = '11'.repeat(32);
  assert.deepEqual((await trustedFiles(other)).files, []);
});
