// dapp/relay-outcome.js, what the relay said about a request: the front page's tests for turned down, held and ran out, and the words for each.
//   node tests/relay-outcome.test.mjs
import assert from 'node:assert/strict';
import { relayCode, proveCapped, proved, relayRefused, waitRanOut, jobSaid, relayWords } from '../dapp/relay-outcome.js';
import { waitRanOut as tickRanOut } from '../dapp/bridge-tick.js';

const err = (message, extra = {}) => Object.assign(new Error(message), extra);
assert.equal(relayCode(err('x', { code: 'relay_held' })), 'relay_held'); assert.equal(relayCode(err('x', { code: 4 })), ''); assert.equal(relayCode(null), '');
// turned down or held
for (const e of [err('x', { code: 'relay_held' }), err('x', { code: 'free_budget' }), err('relay 429: slow down'), err('relay 503: down'), err('the relay can’t take this one right now'),
  err('free relayed settles for today are used up'), err('fee below the current floor'), err('FEE_MOVED'), err('temporarily unavailable')]) assert.equal(relayRefused(e), true, e.message);
for (const e of [err('relay 400: bad op'), err('relay 404: not found'), err('reverted'), err('x', { code: 'relay_paused' }), err('x', { code: 'prove_reserved' }), err('prove_budget', { code: 'prove_budget' }), err('network error')]) assert.equal(relayRefused(e), false, e.message);
// proved and held for a sender
const open = err('settle held: proved and waiting for a sender (job 1)', { code: 'open', open: { proof: '0x1', memos: [] } });
assert.equal(proved(open), true); assert.equal(relayRefused(open), true, 'held for a sender is a hold, not a failure'); assert.equal(proved(err('x', { code: 'open' })), false);
assert.equal(proveCapped(err('the relay has made as many proofs as it can for today')), true); assert.equal(proveCapped(err('prove_budget')), true);
// a wait that ran out is the same test bridge-tick.js makes
for (const m of ['settle timed out (box offline or backlogged)', 'status polling for job 7 failed 5 times in a row', 'relay 429', 'settle failed: x', '']) assert.equal(waitRanOut(err(m)), tickRanOut(err(m)), m);
assert.equal(waitRanOut(err('settle timed out')), true); assert.equal(jobSaid(err('settle failed: reverted')), true); assert.equal(jobSaid(err('relay lost the job (worker restart)')), true); assert.equal(jobSaid(err('relay 500')), false);

// the words
const w = (e) => relayWords(e);
assert.match(w(err('prove_budget', { code: 'prove_budget' })).text, /Today’s relay proofs are taken/); assert.equal(w(err('prove_budget', { code: 'prove_budget' })).front, false);
assert.match(w(open).text, /proved and waiting to be sent/); assert.equal(w(open).front, true);
assert.match(w(err('settle held: proved', { code: 'open' })).text, /proved and waiting for a relay to send it/, 'held with no proof to hand over');
assert.match(w(err('x', { code: 'relay_paused' })).text, /Nothing was spent\. Prove it yourself/); assert.match(w(err('x', { code: 'relay_paused', queued: true })).text, /keeps its place and goes through/);
assert.match(w(err('x', { code: 'relay_held' })).text, /can’t take this one right now/); assert.equal(w(err('x', { code: 'relay_held' })).front, true);
assert.match(w(err('x', { code: 'relay_held', queued: true })).text, /keeps its place in line/); assert.match(w(err('x', { code: 'relay_held', queued: true, slow: true })).text, /taking longer than usual/);
assert.match(w(err('x', { code: 'free_budget' })).text, /Today’s free sends are taken/);
assert.match(w(err('fee below the current floor')).text, /network fee rose/);
assert.match(w(err('settle timed out (box offline)')).text, /do not send it again/);
assert.match(w(err('prove timed out')).text, /stopped waiting/); assert.match(w(err('relay lost the job')).text, /needs a check/);
assert.match(w(err('relay 503: busy')).text, /can’t take this one right now/);
assert.equal(w(err('relay 400: bad op')), null, 'a request the relay found wrong is not a refusal: the page says what it was'); assert.equal(w(err('reverted')), null); assert.equal(w(null), null);
console.log('relay-outcome: all checks passed');
