// The token bucket and client key the holding claim route counts callers by (src/lib/token-bucket.js).
//   node worker-relay/tests/token-bucket.test.mjs
import assert from 'node:assert/strict';
import { makeTokenBucket, ipKey, clientKey } from '../src/lib/token-bucket.js';

let t = 0;
const allow = makeTokenBucket({ perMin: 6, burst: 3, maxKeys: 2, now: () => t });
assert.deepEqual([allow('a'), allow('a'), allow('a'), allow('a')], [true, true, true, false], 'a burst of three, then none');
assert.equal(allow('b'), true, 'another key has its own');
assert.equal(allow('c'), false, 'a table of keys that are all in use takes no new key');
t += 10_000;
assert.equal(allow('a'), true, 'one token back after ten seconds at six a minute');
assert.equal(allow('a'), false);
t += 60_000;
assert.equal(allow('c'), true, 'and takes one once the others have refilled');

assert.equal(ipKey('203.0.113.9'), '203.0.113.9');
assert.equal(ipKey('::ffff:203.0.113.9'), '::ffff:203.0.113.9');
assert.equal(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipKey('2001:db8:1:2:1::9'), 'one IPv6 /64 is one caller');
assert.notEqual(ipKey('2001:db8:1:3::1'), ipKey('2001:db8:1:2::1'));
assert.equal(clientKey({ headers: { 'x-forwarded-for': '1.1.1.1, 198.51.100.7' }, socket: { remoteAddress: '10.0.0.1' } }), '198.51.100.7', 'the hop the proxy added, not one the caller wrote');
assert.equal(clientKey({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
console.log('ok - callers are held to a rate by the hop the proxy saw, an IPv6 subscriber as one');
