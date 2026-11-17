#!/usr/bin/env node
// A rate-limit key is a keyed hash of the client address, never the address. Run: node tests/ip-bucket.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { ipBucket } from '../worker/src/ip-bucket.js';

const env = { IP_HASH_SALT: 'a'.repeat(64) };
const a = ipBucket(env, '203.0.113.7');
assert.ok(/^[0-9a-f]{24}$/.test(a), 'a 24-digit hex key, not the dotted address');
assert.strictEqual(ipBucket(env, '203.0.113.7'), a, 'stable for one address');
assert.notStrictEqual(ipBucket(env, '203.0.113.8'), a, 'one source apart from another');
assert.notStrictEqual(ipBucket({ IP_HASH_SALT: 'b'.repeat(64) }, '203.0.113.7'), a, 'the salt changes the key');
assert.strictEqual(ipBucket({}, '203.0.113.7'), ipBucket({}, '203.0.113.7'), 'with no salt set, stable within the process');
for (const s of ['anon', '*', 'all']) assert.strictEqual(ipBucket(env, s), s, 'sentinels pass through');
console.log('  ok - keyed, stable, per-source, sentinels pass through');

// no store key in the worker is built from a raw address
for (const f of ['../worker/src/index.js', '../worker/src/governance.js']) {
  const bad = readFileSync(new URL(f, import.meta.url), 'utf8').split('\n')
    .map((l, i) => [i + 1, l]).filter(([, l]) => /`[^`]*:\$\{(ip|clientIp)\}`/.test(l));
  assert.deepStrictEqual(bad, [], `${f} builds a key from a raw address:\n${bad.map(([n, l]) => n + ': ' + l.trim()).join('\n')}`);
}
console.log('  ok - no key in index.js or governance.js ends in a raw address\n2 passed');
