// The chain node's HTTP face against what one client address can do to it: spends and settles are limited per address (each is checked in full before it can be
// refused), a forwarded address the client wrote does not change who it is, and one address cannot hold every body reader so that others are turned away.
// (A body of 1 KiB or less is read by the HTTP library itself before the node sees the request; every spend and settle is larger, and it is those the readers hold.)
//   cargo build --release (contracts/sp1/confidential/tacit-block/node), then node tests/tacit-node-limits.test.mjs
import assert from 'node:assert';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = process.env.TACIT_NODE_BIN || join(HERE, '../contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node');
const PORT = 19600 + Math.floor(Math.random() * 300);
const BLOCKS = '0x00000000000000000000000000000000000b10c5';
const env = { ...process.env, TACIT_NODE_ASSET: '0x' + '00'.repeat(31) + '09', TACIT_NODE_TRUST_PROXY: '1', TACIT_NODE_SUBMITS_PER_HOUR: '5', TACIT_NODE_READERS_PER_CLIENT: '2' };
env.TACIT_NODE_ADMIN = 'an-admin-token-nobody-here-has';   // with none set, a caller on this machine is the admin, and the admin is not limited
const server = spawn(BIN, ['serve', '1', `${BLOCKS}@127.0.0.1:${PORT}`], { stdio: ['ignore', 'ignore', 'ignore'], env });
const base = `http://127.0.0.1:${PORT}`;
let n = 0; const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/state')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  const post = async (path, headers) => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })).status;

  const A = { 'true-client-ip': '203.0.113.5' }, B = { 'true-client-ip': '203.0.113.6' };
  const codes = []; for (let i = 0; i < 8; i++) codes.push(await post('/spend', A));
  ok(codes.slice(0, 5).every((c) => c !== 429) && codes.slice(5).every((c) => c === 429), `a client address is held to its spends an hour (${codes.join(',')})`);
  ok(await post('/spend', B) !== 429, 'another client address is not');
  ok(await post('/settle', A) === 429, 'a settle counts with a client\'s spends');
  ok((await fetch(base + '/state', { headers: A })).status === 200, 'reads are not held to it');

  // behind a proxy the first forwarded address is the client's own word: the last is the one the proxy added
  const viaXff = []; for (let i = 0; i < 8; i++) viaXff.push(await post('/spend', { 'x-forwarded-for': `10.9.8.${i}, 198.51.100.77` }));
  ok(viaXff.slice(0, 5).every((c) => c !== 429) && viaXff.slice(5).every((c) => c === 429), 'a forwarded list the client wrote at its front does not make it another client');
  ok(await post('/spend', { 'true-client-ip': '203.0.113.5', 'x-forwarded-for': '1.2.3.4' }) === 429, 'True-Client-IP, when the edge sets it, is the client over a forwarded list');
  const v6 = []; for (let i = 0; i < 7; i++) v6.push(await post('/spend', { 'true-client-ip': `2001:db8:1:2:${(i + 1).toString(16)}::${i + 1}` }));
  ok(v6.slice(5).every((c) => c === 429), 'an IPv6 client is its /64, so another address in it does not help');

  // bodies that never finish: one client address may have only so many being read
  const stall = (tci) => new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => { s.write(`POST /spend HTTP/1.1\r\nHost: x\r\nTrue-Client-IP: ${tci}\r\nContent-Type: application/json\r\nContent-Length: 50000\r\n\r\n{`); resolve(s); });
    s.on('error', () => {});
  });
  const held = [await stall('203.0.113.50'), await stall('203.0.113.50')];
  await new Promise((r) => setTimeout(r, 300));
  const third = await fetch(base + '/state', { method: 'POST', headers: { 'content-type': 'application/json', 'true-client-ip': '203.0.113.50' }, body: '{}' });
  ok(third.status === 429, 'a third body from the address that has two stalled is turned away');
  const other = await fetch(base + '/state', { method: 'POST', headers: { 'content-type': 'application/json', 'true-client-ip': '203.0.113.51' }, body: '{}' });
  ok(other.status !== 429 && other.status !== 503, 'another address is still read');
  held.forEach((s) => s.destroy());
  await new Promise((r) => setTimeout(r, 300));
  const after = await fetch(base + '/state', { method: 'POST', headers: { 'content-type': 'application/json', 'true-client-ip': '203.0.113.50' }, body: '{}' });
  ok(after.status !== 429, 'and the address is read again once its stalled bodies are gone');
  console.log(`${n} ok`);
} finally { server.kill(); }
process.exit(0);
