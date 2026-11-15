// dapp/btc-pool-client.js scanMine: what a read of the note feed found is kept for the next page load (no secret in it), and a later read gives the notes a read from the start gives,
// trying only the leaves that came after. Whatever the record is or is not (another feed, another view tier, torn, tampered, storage that fails), the notes are the ones a read
// with no memory finds.
//   node tests/btc-pool-scan-checkpoint.test.mjs
import assert from 'node:assert/strict';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { makeBtcShieldedPool } from '../dapp/btc-shielded-pool.js';
import { makePoolClient } from '../dapp/btc-pool-client.js';

const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256, ripemd160 });
const ASSET = '0x' + 'ab'.repeat(32);
const seedA = Uint8Array.from({ length: 32 }, (_, i) => 7 + i), seedB = Uint8Array.from({ length: 32 }, (_, i) => 99 + i);
const walletOf = (seed, network = 'signet') => pool.walletFromSeed(seed, network);
const alice = () => walletOf(seedA), bob = () => walletOf(seedB);
const json = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

// feed items as the replay gives them: notes to alice (outside), to alice's internal address (change), to bob, and to a stranger
const A0 = alice(), B0 = bob(), stranger = walletOf(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
let e = 1n;
const noteTo = (address, value, network = 'signet') => { const o = pool.createNote(address, ASSET, value, { network, e: e++ + 1000n }); return { leaf: o.leaf, asset: o.asset, pkEph: o.pkEph, ctNote: o.ctNote }; };
const kinds = ['a', 'x', 'b', 's', 'a', 's', 'i', 'b', 's', 's', 'a', 'i', 's', 'x'];       // a: alice, i: alice's internal address, b: bob, s: stranger, x: stranger again
const make = (k, i) => noteTo(k === 'a' ? A0.address : k === 'i' ? A0.internalAddress : k === 'b' ? B0.address : stranger.address, BigInt(1000 + i * 17));
const feedOf = (ks, from = 0) => ks.map((k, j) => ({ leafIndex: from + j, txid: 'cd'.repeat(32), height: 100 + from + j, ...make(k, from + j) }));
const feed = feedOf(kinds);
const more = feedOf(['s', 's', 'a', 's', 'i'], feed.length);
const grown = [...feed, ...more];

const mem = () => { const m = new Map(); return { m, get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); } }; };
const counted = () => { const c = { tried: 0, calls: 0, pool: null }; c.pool = { ...pool, scan: (w, b) => { c.tried += b.length; c.calls++; return pool.scan(w, b); } }; return c; };
const read = (store, wallet, f, c = counted()) => makePoolClient({ store }).scanMine(c.pool, wallet, f).then((notes) => ({ notes, c }));
const CK = 'tacit-btc-scan-ck-v1';

const bare = await read(null, alice(), grown);                       // what a read with no memory finds, the reference for the rest
const bareFeed = await read(null, alice(), feed);
const bareView = await read(null, pool.viewWallet(alice()), grown);

await test('the fixtures hold notes of both tiers and notes that are not alice\'s', () => {
  assert.deepEqual(bareFeed.notes.map((n) => n.leafIndex), [0, 4, 6, 10, 11].filter((i) => i < feed.length));
  assert.ok(bareFeed.notes.some((n) => n.internal) && bareFeed.notes.some((n) => !n.internal));
  assert.deepEqual(bare.notes.map((n) => n.leafIndex), [0, 4, 6, 10, 11, 16, 18]);
  assert.deepEqual(bareView.notes.map((n) => n.leafIndex), [0, 4, 10, 16], 'the incoming-only tier does not see change');
});

await test('a read with no store tries every leaf once per wallet object, and the next call on that object tries none', async () => {
  const c = counted(), client = makePoolClient({ store: null }), w = alice();
  const a = await client.scanMine(c.pool, w, grown);
  assert.equal(c.tried, grown.length);
  assert.equal(json(a), json(bare.notes));
  const before = c.tried;
  assert.equal(json(await client.scanMine(c.pool, w, grown)), json(bare.notes));
  assert.equal(c.tried, before);
});

await test('the first read keeps a record with no secret in it, and a load with a new wallet object opens only the kept notes', async () => {
  const store = mem(), first = await read(store, alice(), feed);
  assert.equal(first.c.tried, feed.length);
  const raw = store.m.get(CK), rec = JSON.parse(raw).e[0];
  assert.equal(rec.n, feed.length);
  assert.deepEqual(rec.mine, bareFeed.notes.map((n) => n.leafIndex));
  const w = alice();
  for (const secret of [w.v, w.n, w.a, w.vInt, ...first.notes.flatMap((n) => [n.nkNote, n.skNote, n.rho, n.npk])].filter(Boolean)) assert.ok(!raw.includes(String(secret).replace(/^0x/, '')), 'no key or note secret is written');
  const second = await read(store, w, feed);
  assert.equal(second.c.tried, rec.mine.length, 'no leaf is tried again: the only work is one open for each kept note');
  assert.equal(second.c.calls, rec.mine.length);
  assert.equal(json(second.notes), json(first.notes), 'the same notes, read anew under the wallet in hand');
});

await test('a feed that has grown is read from where the record ends, the notes among the new leaves are found, and the record moves on', async () => {
  const store = mem();
  await read(store, alice(), feed);
  const r = await read(store, alice(), grown);
  assert.equal(r.c.tried, bareFeed.notes.length + more.length, 'the kept notes are opened again and only the new leaves are tried');
  assert.equal(json(r.notes), json(bare.notes));
  assert.equal(JSON.parse(store.m.get(CK)).e[0].n, grown.length);
  const again = await read(store, alice(), grown);
  assert.equal(again.c.tried, bare.notes.length, 'nothing but the kept notes is opened');
  assert.equal(json(again.notes), json(bare.notes));
});

await test('a feed that differs in what was read (a leaf, a key, a ciphertext, the asset) is read from the start', async () => {
  const mutate = [
    ['leaf', (f) => ({ ...f, leaf: '0x' + 'ee'.repeat(32) })],
    ['pkEph', (f) => ({ ...f, pkEph: '0x' + f.pkEph.replace(/^0x/, '').replace(/^../, (m) => (m === '02' ? '03' : '02')) })],
    ['ctNote', (f) => ({ ...f, ctNote: '0x' + f.ctNote.replace(/^0x/, '').replace(/.$/, (m) => (m === '0' ? '1' : '0')) })],
    ['asset', (f) => ({ ...f, asset: '0x' + 'ac'.repeat(32) })],
  ];
  for (const [what, fn] of mutate) {
    for (const at of [0, 5, feed.length - 1]) {
      const store = mem();
      await read(store, alice(), feed);
      const changed = feed.map((f, i) => (i === at ? fn(f) : f));
      const want = await read(null, alice(), changed);
      const r = await read(store, alice(), changed);
      assert.equal(r.c.tried, changed.length, `${what} at ${at}: the whole feed is tried`);
      assert.equal(json(r.notes), json(want.notes), `${what} at ${at}`);
    }
  }
});

await test('a shorter feed than the record, or one with a gap, is read from the start and a gapped feed is not kept', async () => {
  const store = mem();
  await read(store, alice(), grown);
  const short = await read(store, alice(), feed);
  assert.equal(short.c.tried, feed.length);
  assert.equal(json(short.notes), json(bareFeed.notes));
  const gapped = grown.filter((f) => f.leafIndex !== 3);
  const s2 = mem();
  const g = await read(s2, alice(), gapped);
  assert.equal(json(g.notes), json((await read(null, alice(), gapped)).notes));
  assert.equal(s2.m.get(CK), undefined, 'a feed with a gap is not kept');
  const g2 = await read(s2, alice(), gapped);
  assert.equal(g2.c.tried, gapped.length, 'read from the start again');
});

await test('each view tier, wallet and network has its own record: the incoming-only tier never reads from the full tier\'s', async () => {
  const store = mem();
  const full = await read(store, alice(), grown);
  const view = await read(store, pool.viewWallet(alice()), grown);
  assert.equal(view.c.tried, grown.length, 'another tier is read from the start');
  assert.equal(json(view.notes), json(bareView.notes));
  assert.ok(!view.notes.some((n) => n.internal), 'no change note shows to the incoming-only tier');
  const back = await read(store, alice(), grown);
  assert.equal(back.c.tried, full.notes.length, 'the full tier\'s record is still there: only its notes are opened');
  assert.equal(json(back.notes), json(full.notes));
  const other = await read(store, bob(), grown);
  assert.equal(other.c.tried, grown.length);
  assert.deepEqual(other.notes.map((n) => n.leafIndex), [2, 7]);
  const main = await read(store, walletOf(seedA, 'mainnet'), grown);
  assert.equal(main.c.tried, grown.length, 'the same seed on another network is another wallet');
  assert.equal(JSON.parse(store.m.get(CK)).e.length, 4);
});

await test('a record that is torn or tampered with is not trusted: the notes are the ones a read from the start finds', async () => {
  const good = mem();
  await read(good, alice(), grown);
  const rec = JSON.parse(good.m.get(CK));
  const tamper = (fn) => { const s = mem(); const r = JSON.parse(JSON.stringify(rec)); fn(r.e[0]); s.m.set(CK, JSON.stringify(r)); return s; };
  const cases = {
    'an index that is not alice\'s': tamper((x) => { x.mine = [...x.mine, 2]; }),
    'an index past the end': tamper((x) => { x.mine = [...x.mine, 9999]; }),
    'an index that is not a whole number': tamper((x) => { x.mine = [...x.mine, 1.5, 'x', null]; }),
    'a count past the feed': tamper((x) => { x.n = grown.length + 3; }),
    'a count of zero': tamper((x) => { x.n = 0; }),
    'a digest that is not the feed\'s': tamper((x) => { x.d = '00'.repeat(32); }),
    'no digest': tamper((x) => { delete x.d; }),
    'no kept list': tamper((x) => { delete x.mine; }),
  };
  const torn = mem(); torn.m.set(CK, '{"v":1,"e":[{"k":'); cases['a record cut short'] = torn;
  const wrongVersion = mem(); wrongVersion.m.set(CK, JSON.stringify({ v: 2, e: rec.e })); cases['another version'] = wrongVersion;
  const junk = mem(); junk.m.set(CK, 'not json'); cases['not json'] = junk;
  for (const [name, store] of Object.entries(cases)) {
    const r = await read(store, alice(), grown);
    assert.ok(r.c.tried >= grown.length, `${name}: every leaf is tried (${r.c.tried}; a record that fails after some of its notes opened has opened them first)`);
    assert.equal(json(r.notes), json(bare.notes), name);
  }
});

await test('a note taken out of the record by hand is not seen by a read that uses it (the limit of keeping anything: whoever can write the page\'s storage can also do worse)', async () => {
  const store = mem();
  await read(store, alice(), grown);
  const r = JSON.parse(store.m.get(CK)); r.e[0].mine = r.e[0].mine.filter((i) => i !== 4); store.m.set(CK, JSON.stringify(r));
  const got = await read(store, alice(), grown);
  assert.deepEqual(got.notes.map((n) => n.leafIndex), bare.notes.map((n) => n.leafIndex).filter((i) => i !== 4));
});

await test('storage that fails to read or write does not change what is found', async () => {
  const bad = { get: () => { throw new Error('blocked'); }, set: () => { throw new Error('full'); } };
  const r = await read(bad, alice(), grown);
  assert.equal(json(r.notes), json(bare.notes));
  assert.equal(r.c.tried, grown.length);
  const noRead = { get: () => null, set: () => { throw new Error('full'); } };
  assert.equal(json((await read(noRead, alice(), grown)).notes), json(bare.notes));
});

await test('only the six wallets read last are kept', async () => {
  const store = mem();
  for (let i = 0; i < 8; i++) await read(store, walletOf(Uint8Array.from({ length: 32 }, (_, j) => (i * 31 + j + 1) & 255)), feed.slice(0, 3));
  const e2 = JSON.parse(store.m.get(CK)).e;
  assert.equal(e2.length, 6);
  assert.equal(new Set(e2.map((x) => x.k)).size, 6);
  const once = await read(store, alice(), feed.slice(0, 3));       // alice is not among the six: read from the start, kept, and the oldest goes
  assert.equal(once.c.tried, 3);
  assert.equal(JSON.parse(store.m.get(CK)).e.length, 6, 'still six');
  const twice = await read(store, alice(), feed.slice(0, 3));
  assert.equal(twice.c.tried, 1, 'her record is there now: only her one note (leaf 0) is opened');
});

await test('two reads of one wallet made together open the kept notes once and read nothing else', async () => {
  const store = mem();
  await read(store, alice(), grown);
  const c = counted(), client = makePoolClient({ store }), w = alice();
  const [a, b] = await Promise.all([client.scanMine(c.pool, w, grown), client.scanMine(c.pool, w, grown)]);
  assert.equal(c.tried, bare.notes.length, 'one open for each kept note, nothing tried twice, no leaf read');
  assert.equal(json(a), json(bare.notes));
  assert.equal(json(b), json(bare.notes));
});

await test('opening the kept notes hands the thread back between them', async () => {
  const store = mem();
  await read(store, alice(), grown);
  const c = counted();
  const slow = { ...c.pool, scan: (w, b) => { const t0 = Date.now(); while (Date.now() - t0 < 15); return c.pool.scan(w, b); } };      // each open takes longer than a slice
  let yields = 0; const Real = globalThis.MessageChannel;                  // the thread is handed back by a message to oneself
  globalThis.MessageChannel = class extends Real { constructor() { super(); yields++; } };
  let notes;
  try { notes = await makePoolClient({ store }).scanMine(slow, alice(), grown); } finally { globalThis.MessageChannel = Real; }
  assert.equal(json(notes), json(bare.notes));
  assert.ok(yields >= bare.notes.length - 1, `the thread was handed back between the ${bare.notes.length} opens (${yields} times)`);
});

await test('an empty feed reads nothing and keeps nothing', async () => {
  const store = mem();
  const r = await read(store, alice(), []);
  assert.deepEqual(r.notes, []);
  assert.equal(store.m.get(CK), undefined);
});

console.log(`\n${passed} passed`);
