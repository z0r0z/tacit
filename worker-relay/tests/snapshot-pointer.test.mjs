// The header relay's step that points snapshot.tacit.wei at tacit-api's newest pool snapshot (src/lib/snapshot-pointer.js), with the API, the
// gateway, the pool's storage and the wallet stood in for: a record already current or less than a day behind is left; dear gas waits; a
// gateway's other bytes, a root the pool never had or a count past the pool's are refused; a manifest that checks out is named.
//   node --test tests/snapshot-pointer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { keccak256 as vk } from 'viem';
import { pointSnapshot, parseRecord, cidSha, POINTER } from '../src/lib/snapshot-pointer.js';

const keccak256 = (b) => Buffer.from(vk(b).slice(2), 'hex');
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function rawCid(bytes) {
  const b = Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), createHash('sha256').update(bytes).digest()]);
  let out = '', bits = 0, acc = 0;
  for (const x of b) { acc = (acc << 8) | x; bits += 8; while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return 'b' + out;
}
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const root = (n) => '0x' + word(n);
const TREES = { note: { count: 100, root: root(1) }, lock: { count: 3, root: root(2) }, cdp: { count: 0, root: root(3) } };

function world({ trees = TREES, record = '', gwei = 1, lie = false, known = [root(1), root(2)], counts = { 3: 120, 84: 3, 128: 0 }, to = 30_000 } = {}) {
  const manifest = Buffer.from(JSON.stringify({ v: 1, to, trees }));
  const cid = rawCid(manifest);
  const sent = [];
  const knownSlots = new Set();
  for (const [k, [, slot]] of Object.entries(POINTER.slots)) for (const r of known) knownSlots.add('0x' + keccak256(Buffer.from(word(BigInt(r)) + word(slot), 'hex')).toString('hex') + '|' + k);
  const deps = {
    apiBase: 'https://api.test',
    fetchImpl: async (url) => {
      if (url === 'https://api.test/pool/snapshot') return new Response(JSON.stringify({ v: 1, cid, to }));
      if (url.endsWith(cid)) return new Response(lie ? Buffer.from('not it') : manifest);
      return new Response('', { status: 404 });
    },
    readText: async () => record,
    getStorageAt: async (slot) => {
      const n = Number(BigInt(slot));
      if (n in counts) return '0x' + word(counts[n]);
      return [...knownSlots].some((s) => s.startsWith(slot + '|')) ? '0x' + word(1) : '0x0';
    },
    keccak256,
    gasGwei: async () => gwei,
    setText: async (v) => { sent.push(v); return '0xabc'; },
  };
  return { deps, sent, cid };
}

test('an empty record is pointed at a manifest that checks out', async () => {
  const w = world();
  const r = await pointSnapshot(w.deps);
  assert.equal(r.status, 'set');
  assert.deepEqual(parseRecord(w.sent[0]), { v: 1, cid: w.cid, to: 30_000 });
  assert.ok(cidSha(w.cid));
});

test('a record already naming it, or less than a day behind, is left alone', async () => {
  const w = world();
  assert.equal((await pointSnapshot({ ...w.deps, readText: async () => JSON.stringify({ v: 1, cid: w.cid, to: 30_000 }) })).status, 'current');
  const older = rawCid(Buffer.from('older'));
  assert.equal((await pointSnapshot({ ...w.deps, readText: async () => JSON.stringify({ v: 1, cid: older, to: 30_000 - 100 }) })).status, 'current');
  assert.equal((await pointSnapshot({ ...w.deps, readText: async () => JSON.stringify({ v: 1, cid: older, to: 30_000 - POINTER.everyBlocks }) })).status, 'set');
  assert.equal(w.sent.length, 1);
});

test('dear gas waits', async () => {
  const w = world({ gwei: 9 });
  assert.equal((await pointSnapshot(w.deps)).status, 'dear');
  assert.equal(w.sent.length, 0);
});

test('a gateway\'s other bytes, a root the pool never had, or a count past the pool\'s, are refused', async () => {
  for (const [w, why] of [
    [world({ lie: true }), /not the manifest/],
    [world({ known: [root(1)] }), /not the pool's/],
    [world({ counts: { 3: 50, 84: 3, 128: 0 } }), /not the pool's/],
  ]) {
    const r = await pointSnapshot(w.deps);
    assert.equal(r.status, 'refused');
    assert.match(r.why, why);
    assert.equal(w.sent.length, 0);
  }
});
