// Which tacit-provers /prove/ tells to run the setup line again: read from the shape of GET /mine, since a prover reports no version and never updates itself.
// The shapes are the ones each release really answers (checked against the release tags' salt.rs: `background` arrives in v0.6.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { proverUpdate, updateText } from '../dapp/prove/view.js';

const base = { miner: null, on: false, job: null, proved: 0 };

test('a prover from before salt mining, or before gentle mining, is told to update; a current one and an unanswered one are not', () => {
  assert.equal(proverUpdate({ ...base }), 'salt');                                                                 // before salt mining: no `salt`
  assert.equal(proverUpdate({ ...base, salt: { on: true, rate: 1, minBits: 26, today: null } }), 'gentle');        // v0.6.0 to v0.6.2: no `background`
  assert.equal(proverUpdate({ ...base, salt: { on: true, rate: 1, minBits: 26, today: null, threads: 2, background: true, pausedFor: null } }), null); // v0.6.3 on
  assert.equal(proverUpdate({ ...base, salt: { on: false, background: false } }), null, 'background off is still a current prover');
  assert.equal(proverUpdate(null), null);
  assert.equal(proverUpdate(undefined), null);
  assert.equal(proverUpdate('nope'), null);
  assert.equal(proverUpdate({ ...base, salt: null }), null, 'a malformed salt is not guessed at');
});

test('the line says to run the setup line again and what the update brings, and is empty for a current prover', () => {
  assert.match(updateText('salt'), /^Run the setup line again to update tacit-prover: it then mines salts between proofs\.$/);
  assert.match(updateText('gentle'), /^Run the setup line again to update tacit-prover: it then mines salts more gently, on a quarter of your cores at the lowest priority and not on battery\.$/);
  assert.equal(updateText(null), '');
});
