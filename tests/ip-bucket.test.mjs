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

// a queued job's sender keeps the /24 grouping but not the network
{
  const { queueSender, senderKey } = await import('../worker/src/index.js');
  const k = (ip) => senderKey(env, queueSender(ip));
  assert.strictEqual(k('203.0.113.17'), k('203.0.113.201'), 'one /24 is still one sender');
  assert.notStrictEqual(k('203.0.113.17'), k('203.0.114.17'), 'another /24 is another');
  assert.ok(!k('203.0.113.17').includes('203.0.113') && /^n:[0-9a-f]{24}$/.test(k('203.0.113.17')), 'the network is not in the key');
  assert.strictEqual(senderKey(env, 'armed:0123456789abcdef'), 'armed:0123456789abcdef', 'a mint keeps its own key');
  assert.strictEqual(senderKey(env, null), null, 'no address, no sender');
  console.log('  ok - a job keeps a hashed sender, same grouping');
}
// the proof pool's client key is keyed too, not a bare hash of the address
{
  const { clientOf } = await import('../worker/src/proof-pool.js');
  const { sha256 } = await import('@noble/hashes/sha256');
  const { bytesToHex } = await import('@noble/hashes/utils');
  const bare = bytesToHex(sha256(new TextEncoder().encode('tacit-proof-pool-client|203.0.113.7'))).slice(0, 16);
  assert.notStrictEqual(clientOf('203.0.113.7', env), bare, 'not the bare hash an enumeration of IPv4 could undo');
  assert.strictEqual(clientOf('203.0.113.7', env), clientOf('203.0.113.7', env), 'stable');
  assert.notStrictEqual(clientOf('203.0.113.7', env), clientOf('203.0.113.7', { IP_HASH_SALT: 'c'.repeat(64) }), 'salted');
  console.log('  ok - the proof pool keys its clients with the salt');
}
// no store key in the worker is built from a raw address
for (const f of ['../worker/src/index.js', '../worker/src/governance.js']) {
  const bad = readFileSync(new URL(f, import.meta.url), 'utf8').split('\n')
    .map((l, i) => [i + 1, l]).filter(([, l]) => /`[^`]*:\$\{(ip|clientIp)\}`/.test(l));
  assert.deepStrictEqual(bad, [], `${f} builds a key from a raw address:\n${bad.map(([n, l]) => n + ': ' + l.trim()).join('\n')}`);
}
console.log('  ok - no key in index.js or governance.js ends in a raw address\n2 passed');
