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
import { termsOf } from '../dapp/fastbridge-client.js';
import { makeBoardHandler } from '../fastbridge-lp/lib/board-http.mjs';

const { openFast, openProvider, discoverProviders, counterFor, notesOf, untrackedFirst, followed, TAC_ASSET, EXPLORERS } = await import('../dapp/fast/wire.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const TAC = 10n ** 8n;
const key = (n) => new Uint8Array(32).fill(n);
const openWallet = (priv) => { T.wallet.priv = priv; T.wallet.pub = secp.getPublicKey(priv, true); };
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const utxo = (n, confirmed = true, value = 546) => ({ txid: String(n).repeat(64), vout: 0, value, status: { confirmed } });
const holdings = (entries) => new Map(entries);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// what the bridge's trace says of notes, by the first character of their txid (anything not listed could not be read)
const verdicts = (table) => async (ns) => new Map(ns.map((n) => [`${n.txid}:${n.vout}`, table[n.txid[0]] || { state: 'unread', error: 'down' }]));
const follows = verdicts({ 1: { state: 'tracked' }, 2: { state: 'tracked' }, 3: { state: 'tracked' } });

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

test('a form that picks a note bridges exactly that note: `only` names the notes a bridge may spend', async () => {
  const priv = key(6), pubHex = bytesToHex(secp.getPublicKey(priv, true));
  openWallet(priv);
  T._testSetScanHoldingsOverride(() => holdings([[TAC_ASSET, { utxos: [{ utxo: utxo(1), amount: 5000n, blinding: 7n }, { utxo: utxo(2), amount: 700n, blinding: 8n }, { utxo: utxo(3), amount: 900n, blinding: 9n }] }]]));
  const s = await openFast({ T, withKey: (fn) => fn(T), ux: { cfg: { pool: POOL } }, priv, pubHex, hrp: 'tb', counterFor: () => ({}), vet: follows });
  let got = null;
  s.market.start = async (o) => { got = o; return { rec: {} }; };
  const q = [{ provider: { ref: { kind: 'http', claimPub: '02' + 'aa'.repeat(32) } }, quote: { btcValue: 100n } }];
  await s.start({ quotes: q, only: [{ txid: utxo(2).txid, vout: 0 }] });
  assert.deepEqual(got.notes.map((n) => n.amount), [700n], 'the one picked and no other');
  await s.start({ quotes: q, only: [{ txid: utxo(3).txid, vout: 0 }, { txid: utxo(1).txid, vout: 0 }] });
  assert.deepEqual(got.notes.map((n) => n.amount), [5000n, 900n]);
  await s.start({ quotes: q, only: [{ txid: 'f'.repeat(64), vout: 0 }] });
  assert.deepEqual(got.notes, [], 'a note that is not the key\'s is not found, and nothing is spent');
  T._testSetScanHoldingsOverride(null);
});

test('the steps of a key\'s bridges are taken by one page at a time: the others show what is stored, and one takes over when the first closes', async () => {
  const priv = key(7), pubHex = bytesToHex(secp.getPublicKey(priv, true));
  openWallet(priv);
  const queue = [];
  let held = false;
  const locks = { request: (name, cb) => new Promise((resolve) => {
    const go = async () => { held = true; try { resolve(await cb({ name })); } finally { held = false; const next = queue.shift(); if (next) next(); } };
    if (held) queue.push(go); else go();
  }) };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true });
  try {
    const open = () => openFast({ T, withKey: (fn) => fn(T), ux: { cfg: { pool: POOL } }, priv, pubHex, hrp: 'tb', counterFor: () => ({}) });
    const [a, b] = [await open(), await open()], log = [], shown = [];
    for (const [n, x] of [['a', a], ['b', b]]) x.market.run = () => { log.push(`${n} tends`); return () => log.push(`${n} stops`); };
    const stopA = a.run({ everyMs: 5 }), stopB = b.run({ everyMs: 5, onChange: (l) => shown.push(l) });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(log, ['a tends'], 'only the first tends');
    assert.ok(shown.length > 0 && Array.isArray(shown[0]), 'the second shows what is stored');
    stopA();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(log, ['a tends', 'a stops', 'b tends'], 'the second takes over when the first closes');
    stopB();
    assert.deepEqual(log.slice(-1), ['b stops']);
  } finally { if (had) Object.defineProperty(globalThis, 'navigator', had); else delete globalThis.navigator; }
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

test('followed: a note the bridge\'s proof cannot follow is left out and the pick made again, so no lock is built on it', async () => {
  const n = (c, amount) => ({ txid: c.repeat(64), vout: 0, amount });
  const exit = n('a', 5000n), small = n('b', 800n), big = n('c', 3000n);
  // largest first until covered, as the lock picks
  const picker = (want) => async (set) => { let sum = 0n; const out = []; for (const x of [...set].sort((p, q) => (p.amount > q.amount ? -1 : 1))) { out.push(x); sum += x.amount; if (sum >= want) return out; } return null; };
  const table = { a: { state: 'unprovable', through: 'shielded', at: 'f'.repeat(64) }, b: { state: 'traced', hops: 3 }, c: { state: 'tracked' } };
  const asked = [];
  const vet = async (ns) => { asked.push(ns.map((x) => x.txid[0]).join('')); return verdicts(table)(ns); };

  // the exit would be picked first (the largest): it is refused, and the pick is made again from what is left
  const set = await followed([[exit, small, big]], picker(2000n), vet);
  assert.deepEqual(set.map((x) => x.txid[0]), ['b', 'c'], 'the notes the lock may spend, without the exit');
  assert.deepEqual(asked, ['a', 'c'], 'each pick was looked at, and only the notes picked');

  // what the preferred notes leave, once the exit is out, does not cover it: every other note is tried
  asked.length = 0;
  const tiers = [[exit, small], [exit, small, big]];
  assert.deepEqual((await followed(tiers, picker(2000n), vet)).map((x) => x.txid[0]), ['b', 'c'], 'falls back to the notes it kept back, without the exit');

  // all that is left cannot cover it: the error says what was left out, and what else the key holds
  const err = await followed([[exit, small]], picker(2000n), vet).catch((e) => e);
  assert.equal(err.code, 'lineage');
  assert.deepEqual(err.refused.map((r) => [r.txid[0], r.through, r.amount]), [['a', 'shielded', 5000n]]);
  assert.equal(err.left, 800n);

  // everything followed: the set comes back as it was, and a history too long for the proof is not refused
  const same = [small, big, n('d', 1n)];
  assert.deepEqual(await followed([same], picker(10n), verdicts({ b: { state: 'traced' }, c: { state: 'long', hops: 300, max: 255 }, d: { state: 'tracked' } })), same);
});

test('followed: a note whose history could not be read stops the lock; one that is refused is dealt with first', async () => {
  const n = (c, amount) => ({ txid: c.repeat(64), vout: 0, amount });
  const exit = n('a', 5000n), unread = n('e', 700n), ok = n('b', 800n);
  const all = (set) => async () => set;
  const err = await followed([[unread]], all([unread]), verdicts({})).catch((e) => e);
  assert.equal(err.code, 'lineage_unread');
  assert.deepEqual(err.unread, [`${unread.txid}:0`]);
  // the exit is refused and the pick made again, which no longer holds the note that could not be read
  const again = async (set) => (set.some((x) => x === exit) ? [exit, unread] : [ok]);
  const set = await followed([[exit, unread, ok]], again, verdicts({ a: { state: 'unprovable', through: 'other' }, b: { state: 'tracked' } }));
  assert.deepEqual(set, [unread, ok], 'the lock then picks the same notes');
});

test('a lock is not built on a note out of the shielded pool: the lock looks at the notes it would spend, and takes the others', async () => {
  const priv = key(7), pubHex = bytesToHex(secp.getPublicKey(priv, true));
  openWallet(priv);
  // utxo 1 is an exit from the pool, 2 and 3 are followed; the exit is the largest, and the lock picks the smallest that covers or else the largest first
  T._testSetScanHoldingsOverride(() => holdings([[TAC_ASSET, { utxos: [{ utxo: utxo(1), amount: 5000n, blinding: 7n }, { utxo: utxo(2), amount: 700n, blinding: 8n }, { utxo: utxo(3), amount: 900n, blinding: 9n }] }]]));
  const vet = verdicts({ 1: { state: 'unprovable', through: 'shielded' }, 2: { state: 'traced', hops: 4 }, 3: { state: 'tracked' } });
  // the reflection tracks utxo 3 only, so the lock prefers 1 and 2 (the bridge does not take them directly) while they cover it
  const tt = { ...T, bridgeUx: () => ({ noteTracking: async (ns) => new Map(ns.map((x) => [`${x.txid}:${x.vout}`, x.txid[0] === '3' ? 'tracked' : 'untracked'])) }) };
  const open = (v) => openFast({ T: tt, withKey: (fn) => fn(tt), ux: { cfg: { pool: POOL } }, priv, pubHex, hrp: 'tb', counterFor: () => ({}), vet: v });
  const s = await open(vet);
  let got = null;
  s.market.start = async (o) => { got = o; return { rec: {} }; };
  const provider = { ref: { kind: 'http', claimPub: '02' + 'aa'.repeat(32) } };
  const quotes = (v) => [{ provider, quote: { btcValue: v } }];
  await s.start({ quotes: quotes(1500n) });
  assert.deepEqual(got.notes.map((n) => n.amount), [700n, 900n], 'the exit is not among the notes the lock may spend, and the tracked note is then spent too');
  // only the exit, or more than the others hold: nothing is built, and it says why
  for (const [q, only] of [[100n, [{ txid: utxo(1).txid, vout: 0 }]], [3000n, undefined]]) {
    got = null;
    const e = await s.start({ quotes: quotes(q), ...(only ? { only } : {}) }).catch((x) => x);
    assert.equal(e.code, 'lineage', `${q}`);
    assert.equal(got, null, 'no lock was begun');
    assert.equal(e.refused[0].through, 'shielded');
  }
  // the cost of the lock is read from the same notes: the exit fails it the same way, before any lock is built
  const e = await s.cost({ quote: { btcValue: 100n }, provider, only: [{ txid: utxo(1).txid, vout: 0 }] }).catch((x) => x);
  assert.equal(e.code, 'lineage');
  // a history that could not be read stops the lock (it is not guessed at)
  const down = await open(verdicts({}));
  down.market.start = async () => { throw new Error('built a lock on a guess'); };
  assert.equal((await down.start({ quotes: quotes(100n) }).catch((x) => x)).code, 'lineage_unread');
  T._testSetScanHoldingsOverride(null);
});

test('the lock goes to the best provider that takes what it must spend: a provider that takes any TAC is given the notes the bridge\'s proof does not follow, and the others are not', async () => {
  const priv = key(8), pubHex = bytesToHex(secp.getPublicKey(priv, true));
  openWallet(priv);
  // utxo 1 is an exit from the shielded pool (the largest), 3 is followed; nothing is tracked by the reflection
  T._testSetScanHoldingsOverride(() => holdings([[TAC_ASSET, { utxos: [{ utxo: utxo(1), amount: 5000n, blinding: 7n }, { utxo: utxo(3), amount: 900n, blinding: 9n }] }]]));
  const asked = [];
  const vet = async (ns) => { asked.push(ns.map((n) => n.txid[0]).join('')); return verdicts({ 1: { state: 'unprovable', through: 'shielded' }, 3: { state: 'tracked' } })(ns); };
  const tt = { ...T, bridgeUx: () => ({ noteTracking: async () => new Map() }) };
  const s = await openFast({ T: tt, withKey: (fn) => fn(tt), ux: { cfg: { pool: POOL } }, priv, pubHex, hrp: 'tb', counterFor: () => ({}), vet });
  const started = [];
  s.market.start = async (o) => { started.push(o); return { rec: {}, provider: o.quotes[0].provider }; };
  const prov = (name, anyTac) => ({ name, ref: { kind: 'http', claimPub: '02' + name.charCodeAt(0).toString(16).repeat(32) }, terms: { anyTac } });
  const cheap = prov('Cheap', false), open = prov('Open', true), screen2 = prov('Other', false);
  const q = (provider, evm) => ({ provider, quote: { btcValue: 4000n, evmAmount: evm } });
  // 4,000 TAC can only be locked by spending the exit: the better quote is a provider that screens, so it is passed over for the one that takes any
  await s.start({ quotes: [q(cheap, 3990n), q(open, 3980n)] });
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].quotes.map((x) => x.provider.name), ['Open'], 'the lock is begun with the provider that takes it');
  assert.deepEqual(started[0].notes.map((n) => n.amount), [5000n, 900n], 'with the notes that cover the amount, the exit among them');
  // only providers that screen: nothing is built, and it says why
  const e = await s.start({ quotes: [q(cheap, 3990n), q(screen2, 3980n)] }).catch((x) => x);
  assert.equal(e.code, 'lineage'); assert.equal(started.length, 1, 'no lock was begun');
  // an amount the followed TAC covers needs no such provider: the best quote is used, with notes the bridge follows
  const small = (provider, evm) => ({ provider, quote: { btcValue: 800n, evmAmount: evm } });
  await s.start({ quotes: [small(cheap, 790n), small(open, 780n)] });
  assert.deepEqual(started[1].quotes.map((x) => x.provider.name), ['Cheap']);
  assert.deepEqual(s.market.clientFor(cheap.ref).pickNotes(started[1].notes, 800n).notes.map((n) => n.amount), [900n], 'the lock spends the followed note alone');
  // the cost is for the notes its own provider takes, and a provider that takes any TAC is not asked about the history at all
  asked.length = 0;
  await s.cost({ quote: { btcValue: 4000n }, provider: open }).catch(() => {});
  assert.deepEqual(asked, [], 'no look at the history');
  const refused = await s.cost({ quote: { btcValue: 4000n }, provider: cheap }).catch((x) => x);
  assert.equal(refused.code, 'lineage');
  T._testSetScanHoldingsOverride(null);
});

test('a provider that says nothing of it screens: only an ad or info that says `anyTac: true` is read as taking any TAC', () => {
  const base = { claimPub: '02' + 'ab'.repeat(32), minAmount: '1', maxAmount: '2', feeBps: 1, flatFee: '0' };
  assert.equal(termsOf(base).anyTac, false);
  assert.equal(termsOf({ ...base, anyTac: 'yes' }).anyTac, false, 'only the value true');
  assert.equal(termsOf({ ...base, anyTac: true }).anyTac, true);
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
    assert.equal(ad.anyTac, true, 'the provider says in its signed ad that it takes TAC whatever its history'); assert.equal(found[0].terms.anyTac, true, 'and the user\'s side reads it');
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

test('a provider away from its page takes on nothing new: no ad is posted and a quote is declined, until it is back', async () => {
  const pPriv = key(9), pPub = bytesToHex(secp.getPublicKey(pPriv, true)), uPriv = key(10), uPub = bytesToHex(secp.getPublicKey(uPriv, true));
  const { fetchImpl, posts } = world({ coinsFor: () => [] });
  const uxP = {
    cfg: { pool: POOL }, chainBindingHex: () => '0x' + '11'.repeat(32), rpc: async () => '0x0',
    balance: async () => ({ byAsset: { ['0x' + TAC_ASSET]: { notes: [{ value: 5000n * TAC, leaf: '0x' + 'ab'.repeat(32) }] } } }),
  };
  let here = true;
  openWallet(pPriv);
  const provider = await openProvider({ T, ux: uxP, priv: pPriv, pubHex: pPub, boards: ['https://board.example'], fetchImpl, hrp: 'tb', pollMs: 15, tickSecs: 1, present: () => here });
  await provider.start({ settings: { feeBps: 30, flatFee: TAC, minAmount: 10n * TAC, maxAmount: 1000n * TAC }, accept: true });
  try {
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(posts.length >= 1, 'present: the ad is posted');
    const found = await discoverProviders({ providers: [], boards: ['https://board.example'], fetchImpl });
    openWallet(uPriv);
    T._testSetScanHoldingsOverride(() => holdings([[TAC_ASSET, { utxos: [{ utxo: utxo(1), amount: 500n * TAC, blinding: 7n }] }]]));
    const s = await openFast({ T, withKey: (fn) => fn(T), ux: { cfg: { pool: POOL } }, priv: uPriv, pubHex: uPub, hrp: 'tb', fetchImpl, call: { pollMs: 5 } });
    here = false;
    const away = await s.quoteAll(found, 100n * TAC);
    assert.equal(away.quotes.length, 0);
    assert.match(String(away.failed[0].error.message), /away from its page/, 'the user is told why');
    const posted = posts.length;
    await new Promise((r) => setTimeout(r, 1200));
    // the publisher posts every minute; what matters is that nothing it posts while away is an ad
    assert.equal(posts.length, posted, 'no ad while away');
    here = true;
    const back = await s.quoteAll(found, 100n * TAC);
    assert.equal(back.quotes.length, 1, 'back at the page, it quotes');
    T._testSetScanHoldingsOverride(null);
  } finally { provider.stop(); }
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
