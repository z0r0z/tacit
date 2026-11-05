// The chain the header feeder reads from the explorers, asked for as seldom as it can be: the tip kept for its TTL, buried blocks kept for good, headers ten to a
// request and each rebuilt from its fields and checked against its id. node --test tests/explorer-chain.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeExplorerChain, headerFromBlock } from '../src/lib/explorer-chain.js';

const sha256d = (b) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
const le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const rev = (hex) => Buffer.from(hex, 'hex').reverse();

// A chain of real double-SHA256 ids from height 0: block h links to block h-1, as Esplora lists it.
function makeChain(n) {
  const blocks = [], headers = [];
  for (let h = 0; h < n; h++) {
    const prev = h ? blocks[h - 1].id : '00'.repeat(32);
    const b = { height: h, version: 0x20000000, previousblockhash: prev, merkle_root: createHash('sha256').update(`m${h}`).digest('hex'), timestamp: 1_700_000_000 + h * 600, bits: 386000300, nonce: h * 7 + 1 };
    const raw = Buffer.concat([le(b.version), rev(b.previousblockhash), rev(b.merkle_root), le(b.timestamp), le(b.bits), le(b.nonce)]);
    b.id = sha256d(raw).reverse().toString('hex');
    blocks.push(b); headers.push(raw.toString('hex'));
  }
  return { blocks, headers };
}

// An explorer over `chain`: `/blocks/tip/height`, `/block-height/<h>`, `/block/<hash>/header`, `/blocks/<h>` (ten at and under h). `page` can corrupt or refuse the page.
function explorer(chain, { page = (list) => list, pages = true } = {}) {
  const calls = [];
  const err = (path, m) => new Error(`esplora ${path}: ${m}`);
  return {
    calls,
    async get(path) {
      calls.push(path);
      let m;
      if (path === '/blocks/tip/height') return String(chain.blocks.length - 1);
      if ((m = path.match(/^\/block-height\/(\d+)$/))) return (chain.blocks[+m[1]] || (() => { throw err(path, '404'); })()).id;
      if ((m = path.match(/^\/block\/([0-9a-f]{64})\/header$/))) { const b = chain.blocks.find((x) => x.id === m[1]); if (!b) throw err(path, '404'); return chain.headers[b.height]; }
      if ((m = path.match(/^\/blocks\/(\d+)$/))) {
        if (!pages) throw err(path, '404');
        const top = +m[1];
        return JSON.stringify(page(chain.blocks.slice(Math.max(0, top - 9), top + 1).reverse()));
      }
      throw err(path, '404');
    },
  };
}
const pageCalls = (e) => e.calls.filter((p) => /^\/blocks\/\d+$/.test(p)).length;

test('a header is rebuilt from a block\'s fields: the genesis block, and nothing that does not hash to its id', () => {
  const genesis = { id: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', version: 1, previousblockhash: '00'.repeat(32), merkle_root: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b', timestamp: 1231006505, bits: 486604799, nonce: 2083236893 };
  assert.equal(headerFromBlock(genesis), '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c');
  assert.equal(headerFromBlock({ ...genesis, nonce: genesis.nonce + 1 }), null, 'a changed field no longer hashes to the id');
  assert.equal(headerFromBlock({ ...genesis, id: '1'.repeat(64) }), null, 'nor does a changed id');
  const { bits, ...noBits } = genesis;
  assert.equal(headerFromBlock(noBits), null, 'a missing field');
  assert.equal(headerFromBlock({ ...genesis, nonce: '2083236893' }), null, 'a field that is not a number');
  assert.equal(headerFromBlock(null), null);
});

test('the tip is read once per TTL, not once per cycle', async () => {
  const w = explorer(makeChain(50));
  let t = 0;
  const chain = makeExplorerChain(w, { now: () => t, tipTtlMs: 90_000 });
  assert.equal(await chain.tip(), 49);
  t = 30_000; await chain.tip(); t = 60_000; await chain.tip(); t = 89_999; await chain.tip();
  assert.equal(w.calls.length, 1, 'three more cycles inside the TTL asked nothing');
  t = 90_000; await chain.tip();
  assert.equal(w.calls.length, 2, 'and one after it');
});

test('a forty-header batch is four requests, ascending, and each header is the real one', async () => {
  const c = makeChain(200), w = explorer(c), chain = makeExplorerChain(w);
  await chain.tip();
  const got = await chain.headers(100, 139);
  assert.deepEqual(got, c.headers.slice(100, 140));
  assert.equal(pageCalls(w), 4);
  assert.equal(w.calls.filter((p) => /block-height|header$/.test(p)).length, 0, 'no per-block request');
});

test('a range that does not fill a page, or is one block, asks for the page it needs', async () => {
  const c = makeChain(200), w = explorer(c), chain = makeExplorerChain(w);
  assert.deepEqual(await chain.headers(150, 152), c.headers.slice(150, 153));
  assert.equal(pageCalls(w), 1);
  assert.deepEqual(await chain.headers(77, 77), [c.headers[77]]);
  assert.equal(pageCalls(w), 2);
});

test('a block in a page that does not hash to its id is not used: that block, and the ones under it, are asked one by one, and the others come from the page', async () => {
  const c = makeChain(200);
  // the page at 139 lists 139..130; its block 134 has a nonce that does not match its id
  const w = explorer(c, { page: (list) => list.map((b) => (b.height === 134 ? { ...b, nonce: b.nonce + 1 } : b)) });
  const chain = makeExplorerChain(w);
  await chain.tip();
  const got = await chain.headers(130, 139);
  assert.deepEqual(got, c.headers.slice(130, 140), 'the real header at 134, not the one the page described');
  assert.ok(w.calls.includes('/block-height/134'), 'the bad block was asked directly');
  assert.ok(!w.calls.includes('/block-height/139') && !w.calls.includes('/block-height/135'), 'the good ones above it were not');
});

test('a page whose block does not link to the header above it is refused', async () => {
  const c = makeChain(200);
  // block 135 is replaced by a different block that has a valid id but is not the parent block 136 names
  const fork = makeChain(200);
  const other = { ...fork.blocks[135], merkle_root: createHash('sha256').update('other').digest('hex') };
  const raw = Buffer.concat([le(other.version), rev(other.previousblockhash), rev(other.merkle_root), le(other.timestamp), le(other.bits), le(other.nonce)]);
  other.id = sha256d(raw).reverse().toString('hex');
  const w = explorer(c, { page: (list) => list.map((b) => (b.height === 135 ? other : b)) });
  const chain = makeExplorerChain(w);
  await chain.tip();
  const got = await chain.headers(130, 139);
  assert.deepEqual(got, c.headers.slice(130, 140));
  assert.ok(w.calls.includes('/block-height/135'), 'the block that did not link was asked directly');
});

test('an explorer that does not serve the page costs the old way, and the headers are the same', async () => {
  const c = makeChain(60), w = explorer(c, { pages: false }), chain = makeExplorerChain(w);
  await chain.tip();
  assert.deepEqual(await chain.headers(40, 44), c.headers.slice(40, 45));
  assert.equal(w.calls.filter((p) => /^\/block-height\//.test(p)).length, 5);
  assert.equal(w.calls.filter((p) => /\/header$/.test(p)).length, 5);
});

test('a page that is not JSON, or an empty one, falls back to one block at a time', async () => {
  const c = makeChain(60);
  const junk = explorer(c); const get = junk.get; junk.get = async (p) => (/^\/blocks\/\d+$/.test(p) ? '<html>busy</html>' : get(p));
  assert.deepEqual(await makeExplorerChain(junk).headers(20, 22), c.headers.slice(20, 23));
  const empty = explorer(c, { page: () => [] });
  assert.deepEqual(await makeExplorerChain(empty).headers(20, 22), c.headers.slice(20, 23));
});

test('a block buried under the tip is kept for good, a recent one is asked again', async () => {
  const w = explorer(makeChain(100)), chain = makeExplorerChain(w, { depth: 12 });
  await chain.tip();                       // 99
  await chain.hashAt(50); await chain.hashAt(50);
  assert.equal(w.calls.filter((p) => p === '/block-height/50').length, 1, 'height 50 is 49 under the tip');
  await chain.hashAt(95); await chain.hashAt(95);
  assert.equal(w.calls.filter((p) => p === '/block-height/95').length, 2, 'height 95 is 4 under the tip: a reorg could replace it');
});

test('a header already fetched by hash is not fetched again', async () => {
  const c = makeChain(60), w = explorer(c, { pages: false }), chain = makeExplorerChain(w);
  await chain.tip();
  await chain.headers(10, 12); await chain.headers(10, 12);
  assert.equal(w.calls.filter((p) => /\/header$/.test(p)).length, 3, 'three headers, once each; the block-height lookups of the recent ones are asked again only if shallow');
});

test('the header cache is bounded', async () => {
  const c = makeChain(120), w = explorer(c), chain = makeExplorerChain(w, { keep: 8 });
  await chain.tip();
  await chain.headers(0, 99);
  assert.equal((await chain.headers(95, 99)).length, 5);
});
