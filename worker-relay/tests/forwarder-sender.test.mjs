#!/usr/bin/env node
// The forwarder's stand-in for a caller (senderToken): a keyed hash of the caller's network and the day, sent only to the gateways that ask for it, and nothing of the caller's
// otherwise. Run: node worker-relay/tests/forwarder-sender.test.mjs
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { makeForwarder, senderToken } from '../src/lib/evm-pool-forwarder.js';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const SECRET = 'a'.repeat(64);

await check('a token is 12 hex digits, stable for a network and a day, and not an address', () => {
  const t = senderToken(SECRET, '203.0.113.7', 20000);
  assert.match(t, /^[0-9a-f]{12}$/);
  assert.equal(senderToken(SECRET, '203.0.113.7', 20000), t, 'stable');
  assert.equal(senderToken(SECRET, '203.0.113.201', 20000), t, 'the same /24 is one sender');
  assert.notEqual(senderToken(SECRET, '203.0.114.7', 20000), t, 'another /24 is another');
  assert.notEqual(senderToken(SECRET, '203.0.113.7', 20001), t, 'tomorrow\'s does not match today\'s');
  assert.notEqual(senderToken('b'.repeat(64), '203.0.113.7', 20000), t, 'the key makes it');
  assert.equal(senderToken(SECRET, '::ffff:203.0.113.7', 20000), t, 'an IPv4 address written as IPv6 is the same sender');
  assert.equal(senderToken(SECRET, '2001:db8:1:2::/64', 20000), senderToken(SECRET, '2001:db8:1:2::/64', 20000));
  assert.ok(!t.includes('203'), 'not a piece of the address');
});

const seen = [];
const fetchImpl = async (url, init) => { seen.push({ url, headers: { ...init.headers } }); return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); };
const call = (fwd, id, from) => new Promise((resolve) => {
  const req = Readable.from([Buffer.from('sealed-bytes')]); req.method = 'POST'; req.url = `/f/${id}`; req.headers = { 'content-length': '12', 'x-forwarded-for': from, 'user-agent': 'a-browser', origin: 'https://tacit.finance' }; req.socket = { remoteAddress: from };
  fwd(req, { headersSent: false, setHeader() {}, writeHead(c) { this.c = c; }, end() { resolve(this.c); } });
});
const gateways = { k: 'https://keepers.test/sealed', r: 'https://rpc.test/sealed', a: 'https://api.test/sealed' };

await check('only the gateways that ask get a token, and no header of the caller\'s goes anywhere', async () => {
  seen.length = 0;
  const f = makeForwarder({ gateways, fetchImpl, senderSecret: SECRET, senderIds: ['a'] });
  for (const id of ['k', 'r', 'a']) assert.equal(await call(f, id, '203.0.113.7'), 200);
  const by = Object.fromEntries(seen.map((s) => [s.url, s.headers]));
  assert.match(by['https://api.test/sealed']['x-tacit-sender'], /^[0-9a-f]{12}$/);
  assert.equal(by['https://keepers.test/sealed']['x-tacit-sender'], undefined);
  assert.equal(by['https://rpc.test/sealed']['x-tacit-sender'], undefined);
  const all = JSON.stringify(seen);
  assert.ok(!all.includes('203.0.113') && !all.includes('a-browser') && !all.includes('tacit.finance'), 'nothing of the caller\'s is forwarded');
});

await check('two people on one network share a token, two networks do not, and with no secret there is none', async () => {
  seen.length = 0;
  const f = makeForwarder({ gateways, fetchImpl, senderSecret: SECRET, senderIds: ['a'] });
  await call(f, 'a', '203.0.113.7'); await call(f, 'a', '203.0.113.99'); await call(f, 'a', '198.51.100.4');
  const t = seen.map((s) => s.headers['x-tacit-sender']);
  assert.equal(t[0], t[1]); assert.notEqual(t[0], t[2]);
  seen.length = 0;
  await call(makeForwarder({ gateways, fetchImpl, senderIds: ['a'] }), 'a', '203.0.113.7');
  assert.equal(seen[0].headers['x-tacit-sender'], undefined);
});

console.log(`\n${n} checks passed`);
