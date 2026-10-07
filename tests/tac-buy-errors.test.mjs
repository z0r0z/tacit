// How /tac reads a failed purchase (dapp/tac/market.js buyFailure), against the messages tacit.js's takePreauthSale
// throws: sats a commit locked must never read as "nothing was sent".
//   node tests/tac-buy-errors.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buyFailure } from '../dapp/tac/market.js';

// The strings are read from tacit.js, so a reworded message there fails here rather than silently changing what a buyer is told.
const src = readFileSync(new URL('../dapp/tacit.js', import.meta.url), 'utf8');
const pre = /throw new Error\(`(insufficient sats for commit[^`]*)`\)/.exec(src)?.[1];
const post = /throw new Error\(`(insufficient sats for reveal[^`]*)`\)/.exec(src)?.[1];
const tail = /const tail = ` · (Commit tx broadcast[^`]*)`/.exec(src)?.[1];
assert.ok(pre && post && tail, 'takePreauthSale\'s three messages are in tacit.js');

const fill = (m) => m.replace(/\$\{[^}]*\}/g, '12345');
assert.equal(buyFailure(fill(pre)), 'short', 'too few sats before anything is sent');
assert.equal(buyFailure(fill(post)), 'locked', 'too few sats for the reveal, after the commit went out: sats are locked');
assert.equal(buyFailure(fill(tail)), 'locked', 'any failure after the commit carries the recovery pointer');
assert.equal(buyFailure('asset outpoint already spent — preauth sale is stale (refresh listings or pick another)'), 'other');
assert.equal(buyFailure('preauth sale has expired'), 'other');
assert.equal(buyFailure(undefined), 'other');
console.log('ok - tac buy errors: a failure after the commit never reads as nothing sent (6 cases)');
