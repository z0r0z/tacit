// A block another leader landed with its data in blobs is read back from a blob source and checked against the block's own public values.
//   node tests/tacit-leader-blobs.test.mjs
// The stream and blob layout (tests/lib/leader-blob-fixture.mjs) is written out again from tacit-block-common blob.rs (`stream`, `blob`), so a round trip checks the leader's reader against it.
import assert from 'node:assert';
import { sha256, concatBytes } from '../dapp/vendor/tacit-deps.min.js';
import { hexOf } from '../tacit-leader/abi.mjs';
import { BLOB_BYTES, MEMO_LEN, blobLists, listsAgree, makeBlobReader, makeRetries, openingHashes, parseStream, unblob, versionedHash } from '../tacit-leader/blobs.mjs';
import { block, u32 } from './lib/leader-blob-fixture.mjs';

// (AbortSignal.timeout's timer does not keep a bare script alive; the leader always has live timers)
const alive = setInterval(() => {}, 1000);
// ── the layout: a stream survives blobs, in one blob and in several
for (const [no, nn, nc] of [[0, 0, 0], [3, 4, 2], [110, 20, 3]]) {
  const b = block(no, nn, nc);
  assert.equal(b.blobs.length, no === 110 ? 2 : 1, `blobs for ${no} outputs`);
  const back = unblob(b.blobs);
  assert.deepEqual([...back.subarray(0, b.stream.length)], [...b.stream], 'unblob gives the stream back');
  assert.ok(back.subarray(b.stream.length).every((x) => x === 0), 'what follows is padding');
  const l = parseStream(back);
  assert.ok(l, 'parses');
  assert.equal(l.leaves.length, 32 * no);
  assert.equal(l.memos.length, MEMO_LEN * no);
  assert.deepEqual(l.nullifiers, b.nullifiers.map(hexOf));
  assert.equal(l.claims.length, 64 * nc);
  if (no) assert.deepEqual([...l.memos.subarray(0, MEMO_LEN)], [...b.outputs[0][1]]);
  assert.ok(listsAgree(b.pv, l), 'its lists are the ones the public values commit');
}

// ── what is not a block's stream is refused
{
  const b = block(3, 4, 2);
  const bad = Uint8Array.from(b.blobs[0]); bad[0] = 1;
  assert.equal(unblob([bad]), null, 'an element with a first byte set is not the program\'s layout');
  assert.equal(unblob([b.blobs[0].subarray(0, BLOB_BYTES - 32)]), null, 'a short blob');
  const tail = Uint8Array.from(unblob(b.blobs)); tail[tail.length - 1] = 1;
  assert.equal(parseStream(tail), null, 'something after the lists that is not zero');
  assert.equal(parseStream(b.stream.subarray(0, b.stream.length - 70)), null, 'a stream cut short');
  assert.equal(parseStream(concatBytes(u32(0xffffffff), new Uint8Array(100))), null, 'a count past the end');
  assert.equal(parseStream(new Uint8Array(2)), null);
  const l = parseStream(unblob(b.blobs));
  const memos = Uint8Array.from(l.memos); memos[5] ^= 1;
  assert.ok(!listsAgree(b.pv, { ...l, memos }), 'a changed memo no longer matches the outputs word');
  assert.ok(!listsAgree(b.pv, { ...l, nullifiers: l.nullifiers.slice(1) }), 'a missing nullifier no longer matches');
  assert.ok(!listsAgree(block(3, 4, 2, 99).pv, l), 'another block\'s words');
}

// ── the hashes to look for come from the call's openings
{
  const b = block(110, 1, 0);
  const hs = openingHashes(b.openings);
  assert.equal(hs.length, 2);
  assert.equal(hs[0], versionedHash(b.openings.subarray(0, 48)));
  assert.equal(hs[0], hexOf(Uint8Array.from([1, ...sha256(b.openings.subarray(0, 48)).slice(1)])), '0x01 ‖ sha256(commitment)[1:]');
  assert.equal(openingHashes(b.openings.subarray(0, 100)), null, 'openings that are not whole');
  assert.equal(openingHashes(new Uint8Array(0)), null);
}

// ── sources: a url source that is down, one that answers as a blob archive does (a body naming where the bytes are kept), a beacon node
const fake = (routes) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const hit = routes.find(([m]) => (typeof m === 'string' ? url.startsWith(m) : m.test(url)));
    if (!hit) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const v = typeof hit[1] === 'function' ? hit[1](url) : hit[1];
    if (v instanceof Error) throw v;
    if (typeof v === 'number') return { ok: false, status: v, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = v instanceof Uint8Array ? v : new TextEncoder().encode(JSON.stringify(v));
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  };
  return { fetchImpl, calls };
};

{
  const b = block(110, 20, 3);
  const [h0, h1] = openingHashes(b.openings);
  const byHash = new Map([[h0, b.blobs[0]], [h1, b.blobs[1]]]);
  const archive = (url) => { const h = url.split('/').pop(); return { versionedHash: h, dataStorageReferences: [{ storage: 'x', url: `https://store.example/${h}.bin` }] }; };
  const f = fake([
    ['https://down.example/', 503],
    ['https://archive.example/blobs/', archive],
    ['https://store.example/', (url) => byHash.get(url.split('/').pop().replace('.bin', ''))],
  ]);
  const reader = makeBlobReader({ urls: ['https://down.example/b/{hash}', 'https://archive.example/blobs/{hash}'], fetchImpl: f.fetchImpl });
  const got = await blobLists({ openings: b.openings, publicValues: b.pv, reader, slotOf: async () => 0 });
  assert.equal(got.via, 'archive.example', 'the first source is down, the second answers');
  assert.equal(got.blobs, 2);
  assert.equal(got.leaves.length, 32 * 110);
  assert.deepEqual(got.nullifiers, b.nullifiers.map(hexOf));
  assert.ok(f.calls[0].startsWith('https://down.example/'), 'sources are tried in order');

  // a source that answers with another block's data is passed over, the next one is used
  const other = block(110, 20, 3, 99);
  const wrong = fake([['https://wrong.example/', (url) => [other.blobs[0], other.blobs[1]][[h0, h1].indexOf(url.split('/').pop())]], ['https://right.example/', (url) => byHash.get(url.split('/').pop())]]);
  const r2 = makeBlobReader({ urls: ['https://wrong.example/{hash}', 'https://right.example/{hash}'], fetchImpl: wrong.fetchImpl });
  const got2 = await blobLists({ openings: b.openings, publicValues: b.pv, reader: r2, slotOf: async () => 0 });
  assert.equal(got2.via, 'right.example', 'data that does not match the block is not used');

  // a body that holds the blob as hex, and one that names another blob, which is refused
  const hex = fake([['https://hex.example/', (url) => ({ data: hexOf(byHash.get(url.split('/').pop())) })]]);
  const gotHex = await blobLists({ openings: b.openings, publicValues: b.pv, reader: makeBlobReader({ urls: ['https://hex.example/{hash}'], fetchImpl: hex.fetchImpl }), slotOf: async () => 0 });
  assert.equal(gotHex.via, 'hex.example');
  const named = fake([['https://named.example/', (url) => ({ versionedHash: '0x' + '02'.repeat(32), data: hexOf(byHash.get(url.split('/').pop())) })]]);
  await assert.rejects(blobLists({ openings: b.openings, publicValues: b.pv, reader: makeBlobReader({ urls: ['https://named.example/{hash}'], fetchImpl: named.fetchImpl }), slotOf: async () => 0 }), /no blob source held/);

  // a beacon node: the slot comes from the landing block's time, the sidecars are matched to the call by versioned hash
  const GENESIS = 1_606_824_023, time = GENESIS + 12 * 12_345;
  const sidecars = [h1, h0].map((h) => ({ index: '0', blob: hexOf(byHash.get(h)), kzg_commitment: hexOf(b.openings.subarray(160 * [h0, h1].indexOf(h), 160 * [h0, h1].indexOf(h) + 48)) }));
  const bc = fake([[/\/eth\/v1\/beacon\/blob_sidecars\/12345$/, { data: sidecars }]]);
  const gotBc = await blobLists({ openings: b.openings, publicValues: b.pv, reader: makeBlobReader({ urls: [], beaconUrl: 'https://beacon.example', fetchImpl: bc.fetchImpl }), slotOf: async () => time });
  assert.equal(gotBc.via, 'beacon.example');
  assert.equal(bc.calls.length, 1);
  assert.deepEqual([...gotBc.leaves], [...got.leaves]);

  // everything down: an error naming each source's reason, nothing read
  const none = fake([]);
  const r3 = makeBlobReader({ urls: ['https://a.example/{hash}'], beaconUrl: 'https://beacon.example', fetchImpl: none.fetchImpl });
  const err = await blobLists({ openings: b.openings, publicValues: b.pv, reader: r3, slotOf: async () => time }).then(() => null, (e) => e);
  assert.ok(err && err.attempts.length === 2 && err.attempts.every((a) => a.error), 'each source says why');
  assert.deepEqual(err.attempts.map((a) => a.source), ['a.example', 'beacon.example']);
  const nothing = await blobLists({ openings: b.openings, publicValues: b.pv, reader: makeBlobReader({ fetchImpl: none.fetchImpl }), slotOf: async () => 0 }).then(() => null, (e) => e);
  assert.match(nothing.message, /no blob source is set/);
  // a request that hangs is given up on (the per-source timeout), not waited for
  const hang = makeBlobReader({ urls: ['https://slow.example/{hash}'], fetchImpl: (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))), timeoutMs: 30 });
  const slow = await blobLists({ openings: b.openings, publicValues: b.pv, reader: hang, slotOf: async () => 0 }).then(() => null, (e) => e);
  assert.ok(slow?.attempts?.[0]?.error, 'a hung source is passed over');
}

// ── the wait between tries: doubles to a ceiling, per block, and holds every step while any block waits
{
  let t = 1_000;
  const r = makeRetries({ firstMs: 15_000, maxMs: 60_000, now: () => t });
  assert.equal(r.pending(), 0);
  assert.equal(r.failed(5), 15_000);
  assert.equal(r.pending(), 15_000);
  t += 15_000;
  assert.equal(r.pending(), 0, 'after the wait the next try may go');
  assert.equal(r.failed(5), 30_000);
  assert.equal(r.failed(5), 60_000);
  assert.equal(r.failed(5), 60_000, 'ceiling');
  r.clear(5);
  assert.equal(r.pending(), 0);
}

clearInterval(alive);
console.log('tacit-leader blobs: ok');
