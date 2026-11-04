// The page's wiring (dapp/fast/wire.js) on the real tacit.js: the Bitcoin address it checks, the key's TAC notes it lists, the providers it
// finds, and a provider and a user, each opened from its own key, reaching each other through a board. The modules import by site
// path ("/x.js?cb=..."), which a loader hook maps to dapp/. The pool wallet, the explorers and the board are stood in for by one fetch.
//   node tests/fastbridge-wire.test.mjs        (Node 22)

import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

import assert from 'node:assert/strict';
import { tacit as T, fetched } from './lib/btc-sim.mjs';
import { secp, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
import { makeBoard } from '../dapp/fastbridge-board.js';
import { makeBoardHandler } from '../fastbridge-lp/lib/board-http.mjs';

const { openFast, openProvider, discoverProviders, counterFor, notesOf, untrackedFirst, TAC_ASSET, EXPLORERS } = await import('../dapp/fast/wire.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const TAC = 10n ** 8n;
const key = (n) => new Uint8Array(32).fill(n);
const openWallet = (priv) => { T.wallet.priv = priv; T.wallet.pub = secp.getPublicKey(priv, true); };
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const utxo = (n, confirmed = true, value = 546) => ({ txid: String(n).repeat(64), vout: 0, value, status: { confirmed } });
const holdings = (entries) => new Map(entries);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the key\'s TAC notes: confirmed ones, as the lock takes them, and none for an asset the wallet does not hold', async () => {
  T._testSetScanHoldingsOverride(() => holdings([[TAC_ASSET, { utxos: [
    { utxo: utxo(1), amount: 5000n, blinding: 7n, commitment: 'x' }, { utxo: utxo(2, false), amount: 900n, blinding: 8n }, { utxo: utxo(3), amount: 250n, blinding: '0x09' },
  ] }], ['ab'.repeat(32), { utxos: [{ utxo: utxo(4), amount: 1n, blinding: 1n }] }]]));
  const notes = await notesOf(T);
  assert.deepEqual(notes.map((n) => [n.txid[0], n.vout, n.value, n.amount, n.blinding]), [['1', 0, 546, 5000n, 7n], ['3', 0, 546, 250n, 9n]]);
  T._testSetScanHoldingsOverride(() => holdings([]));
  assert.deepEqual(await notesOf(T), []);
  T._testSetScanHoldingsOverride(() => null);
  assert.deepEqual(await notesOf(T), []);
  T._testSetScanHoldingsOverride(null);
});

test('openFast: the address, the notes and the balance of the key, and the quotes of every provider asked, the best first', async () => {
  const priv = key(5), pubHex = bytesToHex(secp.getPublicKey(priv, true));
  openWallet(priv);
  T._testSetScanHoldingsOverride(() => holdings([[TAC_ASSET, { utxos: [{ utxo: utxo(1), amount: 5000n, blinding: 7n }, { utxo: utxo(2), amount: 700n, blinding: 8n }] }]]));
  const claimA = '02' + 'aa'.repeat(32), claimB = '03' + 'bb'.repeat(32), claimC = '03' + 'cc'.repeat(32);
  const quote = (claimPub, evmAmount) => ({ id: claimPub.slice(2, 34), btcAsset: TAC_ASSET, btcValue: '1000', evmAsset: '0x' + TAC_ASSET, evmAmount: String(evmAmount), claimPub, csvBlocks: 144, evmWindowSecs: 14400, minConfs: 1, created: Math.floor(Date.now() / 1000), validUntil: Math.floor(Date.now() / 1000) + 600 });
  const counters = {
    [claimA]: { quote: async () => quote(claimA, 990) }, [claimB]: { quote: async () => quote(claimB, 997) },
    [claimC]: { quote: async () => { throw new Error('down'); } },
  };
  const s = await openFast({ T, withKey: (fn) => fn(T), ux: { cfg: { pool: POOL } }, priv, pubHex, hrp: 'tb', counterFor: (ref) => counters[ref.claimPub] });
  assert.equal(s.address, T.wallet.address());
  assert.equal(await s.balance(), 5700n);
  assert.deepEqual((await s.notes()).map((n) => n.amount), [5000n, 700n]);
  const ps = [{ name: 'A', ref: { kind: 'http', claimPub: claimA } }, { name: 'B', ref: { kind: 'http', claimPub: claimB } }, { name: 'C', ref: { kind: 'http', claimPub: claimC } }];
  const r = await s.quoteAll(ps, 1000n);
  assert.deepEqual(r.quotes.map((x) => [x.provider.name, x.quote.evmAmount]), [['B', 997n], ['A', 990n]]);
  assert.deepEqual(r.failed.map((x) => x.provider.name), ['C']);
  assert.deepEqual(await s.records(), [], 'nothing under way for this key');
  // a provider that quotes with another key than its entry pins is refused by the client
  const claimD = '02' + 'dd'.repeat(32);
  counters[claimD] = { quote: async () => quote(claimB, 990) };
  const bad = await s.quoteAll([{ name: 'D', ref: { kind: 'http', claimPub: claimD } }], 1000n);
  assert.match(bad.failed[0].error.message, /key is not the one this page expects/);
  T._testSetScanHoldingsOverride(null);
});

test('a swap spends the notes the bridge does not take directly (out of the shielded pool, untracked) when they alone cover it', () => {
  const n = (c, amount) => ({ txid: c.repeat(64), vout: 0, amount });
  const pool = n('a', 1000n), tracked = n('b', 5000n), fresh = n('c', 300n), all = [tracked, pool, fresh];
  const tracks = new Map([[`${tracked.txid}:0`, 'tracked'], [`${pool.txid}:0`, 'untracked'], [`${fresh.txid}:0`, 'new']]);
  const covers = (want) => (rest) => rest.reduce((s, x) => s + x.amount, 0n) >= want;
  assert.deepEqual(untrackedFirst(all, tracks, covers(1000n)), [pool, fresh], 'the untracked notes cover it: the tracked one is kept');
  assert.deepEqual(untrackedFirst(all, tracks, covers(2000n)), all, 'they do not: every note may be spent');
  assert.deepEqual(untrackedFirst(all, null, covers(10n)), all, 'tracking unknown: every note');
  assert.deepEqual(untrackedFirst([tracked], tracks, covers(10n)), [tracked], 'only tracked notes: those');
  assert.deepEqual(untrackedFirst([pool], tracks, () => false), [pool], 'only untracked notes: those, without asking');
});

test('a key whose Bitcoin address is not the wallet\'s is refused before anything is built', async () => {
  const priv = key(5);
  openWallet(key(6));
  await assert.rejects(() => openFast({ T, withKey: (fn) => fn(T), ux: { cfg: { pool: POOL } }, priv, pubHex: 'x', hrp: 'tb' }), /not the one the wallet reads/);
  openWallet(priv);
});

test('counters: a provider that serves HTTP, one reached through a board, and one that is not there', async () => {
  const seen = [];
  const http = counterFor({ kind: 'http', base: 'https://lp.example' }, { fetchImpl: async (url) => { seen.push(url); return json({ claimPub: '02' + 'ab'.repeat(32) }); } });
  assert.equal((await http.info()).claimPub, '02' + 'ab'.repeat(32));
  assert.deepEqual(seen, ['https://lp.example/info']);
  assert.equal(typeof counterFor({ kind: 'mailbox', boardBase: 'https://board.example', gateway: '02' + 'cd'.repeat(32) }).quote, 'function');
  await assert.rejects(() => counterFor(null).quote(5), /the provider is not reachable from here/);
});

// one fetch for the explorers and the board of the stand-in world
function world({ coinsFor }) {
  const board = makeBoard();
  const handle = makeBoardHandler(board);
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.host === 'board.example') {
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : null;
      if (method === 'PUT' && u.pathname === '/ad') posts.push(body);
      const r = await handle({ method, path: u.pathname, body });
      return json(r.body, r.status);
    }
    if (u.host === 'mempool.space') {
      if (u.pathname === '/api/fee-estimates') return json({ 3: 4, 6: 2 });
      const m = /^\/api\/address\/([0-9a-z]+)\/utxo$/.exec(u.pathname);
      if (m) return json(coinsFor(m[1]));
    }
    return json({ error: 'not found' }, 404);
  };
  return { board, fetchImpl, posts };
}

test('a provider and a user, each from its own key, find and reach each other through a board; what the provider can take is in its ad', async () => {
  const pPriv = key(7), pPub = bytesToHex(secp.getPublicKey(pPriv, true)), uPriv = key(8), uPub = bytesToHex(secp.getPublicKey(uPriv, true));
  let providerAddress = null;
  const { fetchImpl, posts } = world({ coinsFor: (addr) => (addr === providerAddress ? [{ txid: 'c'.repeat(64), vout: 0, value: 200000, status: { confirmed: true, block_height: 1 } }] : []) });
  // the provider's pool wallet holds 5,000 TAC as one note
  const uxP = {
    cfg: { pool: POOL }, chainBindingHex: () => '0x' + '11'.repeat(32), rpc: async () => '0x0',
    balance: async () => ({ byAsset: { ['0x' + TAC_ASSET]: { notes: [{ value: 5000n * TAC, leaf: '0x' + 'ab'.repeat(32) }] } } }),
  };
  openWallet(pPriv);
  const provider = await openProvider({ T, ux: uxP, priv: pPriv, pubHex: pPub, boards: ['https://board.example'], fetchImpl, hrp: 'tb', pollMs: 15, tickSecs: 1 });
  providerAddress = provider.address;
  const inv = await provider.inventory();
  assert.deepEqual([inv.pool, inv.address === provider.address], [5000n * TAC, true]);
  assert.deepEqual(await provider.status(), { running: false, accepting: false, open: 0, done: 0, earned: 0n, lastError: null, lastTake: null, held: null });
  await provider.start({ settings: { feeBps: 30, flatFee: TAC, minAmount: 10n * TAC, maxAmount: 1000n * TAC }, accept: true });
  try {
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(posts.length >= 1, 'the ad is posted when the provider starts');
    const ad = posts.at(-1);
    assert.deepEqual([ad.claimPub, ad.feeBps, ad.flatFee, ad.minAmount, ad.maxAmount, ad.available, ad.name], [provider.claimPub, 30, String(TAC), String(10n * TAC), String(1000n * TAC), String(1000n * TAC), `Provider ${provider.claimPub.slice(2, 8)}`]);
    assert.equal((await provider.status()).running, true);

    // the user finds it among the ads, and asks it for a quote through the board
    const found = await discoverProviders({ providers: [], boards: ['https://board.example'], fetchImpl });
    assert.equal(found.length, 1);
    assert.deepEqual([found[0].id, found[0].ref.kind, found[0].terms.feeBps, found[0].terms.flatFee, found[0].terms.available], [provider.claimPub, 'mailbox', 30, TAC, 1000n * TAC]);
    openWallet(uPriv);
    T._testSetScanHoldingsOverride(() => holdings([[TAC_ASSET, { utxos: [{ utxo: utxo(1), amount: 500n * TAC, blinding: 7n }] }]]));
    const s = await openFast({ T, withKey: (fn) => fn(T), ux: { cfg: { pool: POOL } }, priv: uPriv, pubHex: uPub, hrp: 'tb', fetchImpl, call: { pollMs: 5 } });
    const r = await s.quoteAll(found, 100n * TAC);
    assert.deepEqual(r.failed, []);
    assert.deepEqual([r.quotes[0].quote.btcValue, r.quotes[0].quote.evmAmount, r.quotes[0].quote.fee], [100n * TAC, 9_870_000_000n, 130_000_000n]);
    assert.equal(r.quotes[0].quote.claimPub, provider.claimPub);
    T._testSetScanHoldingsOverride(null);
  } finally { provider.stop(); }
  assert.equal((await provider.status()).running, false);
  // a provider that only finishes what is open takes no requests and posts no ad
  const before = posts.length;
  openWallet(pPriv);
  await provider.start({ accept: false });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(posts.length, before);
  assert.deepEqual([(await provider.status()).running, (await provider.status()).accepting], [true, false]);
  provider.stop();
});

test('discovering providers: the ones that serve HTTP are checked against their pinned key, one entry for each key, an unreachable one left out', async () => {
  const claimA = '02' + 'aa'.repeat(32), claimB = '03' + 'bb'.repeat(32);
  const info = (claimPub) => ({ claimPub, btcAsset: TAC_ASSET, evmAsset: TAC_ASSET, minAmount: '1000000000', maxAmount: '5000000000', available: null, feeBps: 20, flatFee: '0', csvBlocks: 144, evmWindowSecs: 14400 });
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u === 'https://a.example/info') return json(info(claimA));
    if (u === 'https://b.example/info') return json(info(claimB));
    if (u === 'https://liar.example/info') return json(info(claimB));
    return json({ error: 'down' }, 503);
  };
  const found = await discoverProviders({
    providers: [{ name: 'A', base: 'https://a.example', claimPub: claimA }, { name: 'Liar', base: 'https://liar.example', claimPub: claimA }, { name: 'Gone', base: 'https://gone.example' }, { name: 'B', base: 'https://b.example' }],
    boards: ['https://nowhere.example'], fetchImpl,
  });
  assert.deepEqual(found.map((p) => [p.name, p.ref.kind, p.terms.feeBps, p.terms.available]).sort(), [['A', 'http', 20, null], ['B', 'http', 20, null]]);
  assert.deepEqual(found.map((p) => p.id).sort(), [claimA, claimB].sort());
});

test('the explorers the page reads are the two it lists for the bridge page', () => {
  assert.deepEqual(EXPLORERS, ['https://mempool.space/api', 'https://blockstream.info/api']);
  assert.equal(TAC_ASSET, 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b');
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${ran} fast wiring checks passed`);
process.exit(process.exitCode || 0);
