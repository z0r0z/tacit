// Wrapper metadata is read from an IPFS gateway to at most 32 KiB, within the time allowed for the whole read, and checked against its CID.
// The gateways are stand-ins that count what is read from them.
//   node tests/wrapper-ipfs-read.test.mjs
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { fetchIpfsJson } from '../worker/src/index.js';

const b32 = (u8) => { const A = 'abcdefghijklmnopqrstuvwxyz234567'; let bits = 0, v = 0, o = ''; for (const b of u8) { v = (v << 8) | b; bits += 8; while (bits >= 5) { o += A[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) o += A[(v << (5 - bits)) & 31]; return o; };
const rawCid = (bytes) => 'b' + b32(Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), createHash('sha256').update(bytes).digest()]));
const doc = Buffer.from(JSON.stringify({ name: 'wrapped', tacit_wrapper: { v: 1 } }));
const cid = rawCid(doc);
let n = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };
const HOSTS = ['gateway.pinata.cloud', 'ipfs.filebase.io', 'ipfs.orbitor.dev'];
const pulled = Object.fromEntries(HOSTS.map((h) => [h, 0]));
const hostOf = (u) => HOSTS.find((h) => String(u).includes(h));

// what each gateway does is set per test
let behave = {};
globalThis.fetch = async (url, { signal } = {}) => {
  const h = hostOf(url), how = behave[h] || 'refuse';
  if (how === 'refuse') return new Response('no', { status: 503 });
  if (how === 'valid') { pulled[h] += doc.length; return new Response(doc, { status: 200 }); }
  if (how === 'declared') return new Response('x', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } });
  if (how === 'endless') {
    const body = new ReadableStream({ pull(c) { pulled[h] += 16384; c.enqueue(new Uint8Array(16384)); } }, { highWaterMark: 0 });   // lazy: only what is read is made
    return new Response(body, { status: 200 });
  }
  if (how === 'stalls') {
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); signal?.addEventListener('abort', () => c.error(new Error('aborted'))); } });
    return new Response(body, { status: 200 });
  }
};
const reset = () => { for (const h of HOSTS) pulled[h] = 0; };

behave = { 'gateway.pinata.cloud': 'valid' };
const good = await fetchIpfsJson(cid);
ok(good && good.json.name === 'wrapped' && good.gateway.includes('pinata'), 'a small blob that is the CID\'s is read');
reset();
behave = { 'gateway.pinata.cloud': 'valid', 'ipfs.filebase.io': 'valid' };
ok((await fetchIpfsJson(rawCid(Buffer.from('some other bytes')))) === null, 'a blob that is not the CID\'s is refused');

reset();
behave = { 'gateway.pinata.cloud': 'declared', 'ipfs.filebase.io': 'valid' };
const skipped = await fetchIpfsJson(cid);
ok(skipped && skipped.gateway.includes('filebase') && pulled['gateway.pinata.cloud'] === 0, 'a body that declares more than the cap is not read, and the next gateway answers');

reset();
behave = Object.fromEntries(HOSTS.map((h) => [h, 'endless']));
const t0 = Date.now();
const endless = await fetchIpfsJson(cid, { timeoutMs: 4000 });
const total = HOSTS.reduce((t, h) => t + pulled[h], 0);
ok(endless === null && total <= 3 * (32 * 1024 + 16384), `a body with no end is cut off at the cap (${total} bytes pulled over three gateways, ${Date.now() - t0} ms)`);

reset();
behave = Object.fromEntries(HOSTS.map((h) => [h, 'stalls']));
const t1 = Date.now();
const stalled = await fetchIpfsJson(cid, { timeoutMs: 150 });
const took = Date.now() - t1;
ok(stalled === null && took < 2000, `a body that stops after its headers is given up on within the time allowed (${took} ms for three gateways)`);
console.log(`${n} ok`);
process.exit(0);
