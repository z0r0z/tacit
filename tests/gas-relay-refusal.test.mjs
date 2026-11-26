// What the Swap card says when the relay's order board refuses an order (GR.orderRefusal): the rate-limit wait is no longer lost.
//
// Run: node tests/gas-relay-refusal.test.mjs
import assert from 'node:assert/strict';
import { orderRefusal } from '../dapp/gas-relay.js';

const calm = (x) => (/below the current floor/.test(x) ? 'The relay’s fee moved.' : x);
assert.equal(orderRefusal({ ok: false, error: 'fee below the current floor' }, calm), 'The relay’s fee moved. Nothing was spent.', 'the relay’s plain words, when calmText rewrites them');
assert.equal(orderRefusal({ ok: false, error: 'too many orders, retry in ~30s', retryAfter: 30 }, calm), 'The relay is busy: try again in about 30 seconds. Nothing was spent.', 'a rate limit says how long');
assert.equal(orderRefusal({ ok: false, error: 'too many orders, retry in ~300s', retryAfter: 300 }, calm), 'The relay is busy: try again in about 5 minutes. Nothing was spent.', 'a long wait in minutes');
assert.equal(orderRefusal({ ok: false, error: 'bad json' }, calm), 'The relay did not take the order. Nothing was spent.', 'anything else is the generic line');
assert.equal(orderRefusal({ ok: false }, calm), 'The relay did not take the order. Nothing was spent.');
assert.equal(orderRefusal(null), 'The relay did not take the order. Nothing was spent.');
console.log('ok   orderRefusal: plain words, the rate-limit wait, the generic line, always "Nothing was spent"');
