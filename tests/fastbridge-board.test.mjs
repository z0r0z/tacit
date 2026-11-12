// The board (dapp/fastbridge-board.js) and the mailbox over it (dapp/fastbridge-mailbox.js): ads that are checked, traffic that is
// kept bounded, requests and answers that only their two ends can read or make, a request carried to a provider and its answer
// back with the private route's sealing, a provider's mailbox that survives what is thrown at it, and a whole swap with nothing
// between the user and the provider but the board.
//   node tests/fastbridge-board.test.mjs        (Node 22)

import { register } from 'node:module';
// fast/want.js imports by site path ("/x.js?cb=..."), which this maps to dapp/
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));
import assert from 'node:assert/strict';
import { realFetch } from './lib/real-fetch.mjs';
import { secp, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { signSchnorr } from '../dapp/bulletproofs.js';
import { sealRequest } from '../dapp/sealed-request.js';
import { makeBoard, signAd, checkAd, signWant, checkWant, replyDigest, messageId, LIMITS } from '../dapp/fastbridge-board.js';
import { gatewayOf, makeMailboxCall, makeMailboxServer, makeAdPublisher, makeProvider, readProviders } from '../dapp/fastbridge-mailbox.js';
import { makeFastBridgeClient } from '../dapp/fastbridge-client.js';
import { makeBoardClient } from '../dapp/fastbridge-board-client.js';
import { makeBoardHandler, boardKindOf } from '../fastbridge-lp/lib/board-http.mjs';
import { makeHttpServer } from '../fastbridge-lp/lib/http.mjs';
import { fetched } from './lib/btc-sim.mjs';
import { ASSET } from './lib/chain-sim.mjs';
import { VALUE } from './lib/fastbridge-world.mjs';
import { closers, configFor, service, httpWorld, bothDone } from './lib/lp-harness.mjs';

void realFetch;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const T0 = 1_800_000_000;
const priv = (n) => new Uint8Array(32).fill(n);
const pubOf = (p) => bytesToHex(secp.getPublicKey(p, true));
const adOf = (n, t, over = {}) => {
  const p = priv(n), gw = gatewayOf(p);
  return signAd({ claimPub: pubOf(p), gateway: bytesToHex(gw.pub), btcAsset: 'ab'.repeat(32), evmAsset: 'cd'.repeat(32), minAmount: '1000', maxAmount: '100000', available: '5000', feeBps: 30, flatFee: '200', csvBlocks: 144, evmWindowSecs: 14400, name: 'p' + n, at: t, until: t + 180, ...over }, p);
};
const clock = (start = T0) => { const c = { t: start, now: () => c.t, advance: (s) => { c.t += s; } }; return c; };
const bytesOf = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };

// ── wants ──

test('a want: signed by its one-time key, kept a day at most, replaced only by a later one of that key, taken down by amount 0, bounded', () => {
  const c = clock(), board = makeBoard({ now: c.now, limits: { maxWants: 2 } });
  const w = (n, t, amount = '100000000000', over = {}) => signWant({ pub: pubOf(priv(n)), btcAsset: 'ab'.repeat(32), amount, at: t, until: t + 86400, ...over }, priv(n));
  const a = w(1, T0);
  assert.equal(checkWant(a, T0), a);
  for (const [k, v] of [['amount', '1'], ['btcAsset', 'cd'.repeat(32)], ['until', T0 + 10]]) assert.match(thrown(() => checkWant({ ...a, [k]: v }, T0)).message, /not signed by its key/, k);
  assert.match(thrown(() => checkWant({ ...a, pub: pubOf(priv(2)) }, T0)).message, /not signed by its key/, 'another key');
  assert.match(thrown(() => checkWant(w(1, T0, '1', { until: T0 + 86401 }), T0)).message, /time is not valid/, 'more than a day');
  assert.match(thrown(() => checkWant(a, T0 + 86400)).message, /run out/);
  assert.match(thrown(() => checkWant(w(1, T0 + 1000), T0)).message, /from the future/);
  assert.match(thrown(() => checkWant({ ...a, amount: '-1' }, T0)).message, /not an amount/);
  board.putWant(a);
  assert.deepEqual(board.wants(), [a]);
  assert.equal(board.putWant(w(1, T0, '5')).kept, true, 'not a later one: the first stands');
  board.putWant(w(1, T0 + 1, '7'));
  assert.equal(board.wants()[0].amount, '7', 'a later one of the key replaces it');
  board.putWant(w(2, T0));
  assert.equal(thrown(() => board.putWant(w(3, T0))).status, 503, 'the board keeps a bounded number');
  assert.equal(board.putWant(w(2, T0 + 2, '0')).dropped, true);
  assert.deepEqual(board.wants().map((x) => x.pub), [pubOf(priv(1))], 'amount 0 takes it down');
  assert.equal(board.stats().wants, 1);
  c.advance(86401);
  assert.deepEqual(board.wants(), [], 'gone after its day');
});

test('wants over HTTP, and fast/want.js: kept in the browser, posted under a one-time key, taken down, and what providers online take', async () => {
  const c = clock(), board = makeBoard({ now: c.now }), handle = makeBoardHandler(board);
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const r = await handle({ method: opts.method || 'GET', path: u.pathname, body: opts.body ? JSON.parse(opts.body) : null });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  const mem = new Map(), storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const { makeWants } = await import('../dapp/fast/want.js');
  const asset = 'ab'.repeat(32), user = '03' + 'cd'.repeat(32);
  const w = makeWants({ boards: ['https://board.example'], storage, fetchImpl, now: c.now, asset });
  assert.equal(w.kept(user), null);
  const k = await w.start(user, 1000n);
  assert.equal(k.amount, 1000n);
  const posted = board.wants();
  assert.equal(posted.length, 1);
  assert.notEqual(posted[0].pub, user, 'signed by a key made for it, not the wallet\'s');
  assert.ok(!JSON.stringify(posted[0]).includes(user.slice(2)), 'nothing of the wallet in it');
  const waits = await w.waiting();
  assert.deepEqual([waits.count, waits.total, waits.items.map((i) => i.amount)], [1, 1000n, [1000n]], 'each want is listed with its size');
  assert.equal(w.kept(user).amount, 1000n, 'kept in this browser');
  assert.deepEqual(await w.takers(1000n), [], 'nobody online');
  board.putAd(adOf(7, T0, { btcAsset: asset, minAmount: '500', maxAmount: '5000', available: '800' }));
  assert.deepEqual(await w.takers(1000n), [], 'a provider that can take only 800 now does not take 1,000');
  assert.deepEqual((await w.takers(700n)).map((p) => p.name), ['p7']);
  board.putAd(adOf(8, T0 + 1, { btcAsset: 'ee'.repeat(32), minAmount: '1', maxAmount: '5000', available: null }));
  assert.deepEqual(await w.takers(1000n), [], 'a provider of another asset does not count');
  c.advance(1);
  await w.stop(user);
  assert.equal(w.kept(user), null);
  assert.deepEqual(board.wants(), [], 'taken down on the board too');
  assert.deepEqual(await w.waiting(), { count: 0, total: 0n, items: [] });
  await w.start(user, 5n);
  c.advance(86400);
  assert.equal(w.kept(user), null, 'a want past its day is forgotten');
  const down = makeWants({ boards: ['https://board.example'], storage, fetchImpl: async () => { throw new Error('offline'); }, now: c.now, asset });
  assert.equal((await down.start(user, 9n)).amount, 9n, 'a board that cannot be reached: the want is still kept here');
});

// ── ads ──

test('an ad: signed by its provider\'s key and checked for shape and time; any change to it, or another key, fails', () => {
  const ad = adOf(1, T0);
  assert.equal(checkAd(ad, T0), ad);
  for (const [k, v] of [['maxAmount', '999999'], ['feeBps', 1], ['available', '1'], ['name', 'other'], ['csvBlocks', 10], ['gateway', '02' + 'ee'.repeat(32)]]) {
    assert.match(thrown(() => checkAd({ ...ad, [k]: v }, T0)).message, /not signed by its key/, k);
  }
  const forged = signAd({ ...adOf(1, T0), sig: undefined }, priv(2));
  assert.match(thrown(() => checkAd(forged, T0)).message, /not signed by its key/, 'signed by another key than the ad names');
  const bad = [
    [{ v: 2 }, /not an ad/], [{ claimPub: 'zz' }, /claimPub is not a key/], [{ gateway: '03' }, /gateway is not a key/], [{ btcAsset: 'ab' }, /btcAsset is not an asset/],
    [{ minAmount: '-5' }, /minAmount is not an amount/], [{ available: 'lots' }, /available is not an amount/], [{ feeBps: 20000 }, /feeBps is out of range/], [{ csvBlocks: 1.5 }, /csvBlocks is out of range/],
    [{ name: 'x'.repeat(41) }, /name is too long/], [{ until: T0 + 100000 }, /time is not valid/], [{ until: T0 - 5, at: T0 - 100 }, /has run out/], [{ at: T0 + 500, until: T0 + 600 }, /from the future/],
  ];
  for (const [over, re] of bad) assert.match(thrown(() => checkAd(signAd({ ...adOf(1, T0), sig: undefined, ...over }, priv(1)), T0)).message, re, JSON.stringify(over));
  assert.match(thrown(() => checkAd({ ...ad, sig: 'ab' }, T0)).message, /not signed/);
  assert.match(thrown(() => checkAd(null, T0)).message, /not an ad/);
  assert.match(thrown(() => checkAd(adOf(1, T0, { available: null }), T0 + 200)).message, /has run out/);
  assert.equal(checkAd(adOf(1, T0, { available: null }), T0).available, null, 'a provider that does not say what it can take may leave it out');
});

test('the board keeps one ad for each provider, the newest, lets it run out, and takes only so many', () => {
  const c = clock(), board = makeBoard({ now: c.now, limits: { maxAds: 2 } });
  assert.deepEqual(board.putAd(adOf(1, T0)), { ok: true });
  c.advance(10);
  assert.deepEqual(board.putAd(adOf(1, T0 + 10, { available: '4000' })), { ok: true });
  assert.equal(board.putAd(adOf(1, T0 + 5)).kept, true, 'an older ad does not replace a newer one');
  assert.equal(board.ads().length, 1); assert.equal(board.ads()[0].available, '4000');
  board.putAd(adOf(2, T0 + 100));
  assert.deepEqual(board.ads().map((a) => a.name), ['p2', 'p1'], 'newest first');
  assert.equal(thrown(() => board.putAd(adOf(3, T0 + 10))).status, 503, 'the board is full');
  assert.match(thrown(() => board.putAd(adOf(9, T0 + 10, { gateway: adOf(1, T0).gateway }))).message, /belongs to another provider/);
  assert.equal(thrown(() => board.putAd(adOf(4, T0 - 1000))).status, 400);
  c.advance(185);
  assert.deepEqual(board.ads().map((a) => a.name), ['p2'], 'the first ad has run out, the second has not');
  c.advance(100);
  assert.deepEqual(board.ads(), []);
  assert.deepEqual(board.putAd(adOf(3, T0 + 295)), { ok: true }, 'room again');
});

// ── messages ──

test('a request: only for a provider with a live ad, of a sealed request\'s size, once, in a queue that is bounded and runs out', () => {
  const c = clock(), board = makeBoard({ now: c.now, limits: { maxQueue: 3 } });
  const ad = adOf(1, T0), gw = ad.gateway;
  assert.equal(thrown(() => board.post(gw, bytesOf(4100))).status, 404, 'nobody has that gateway key yet');
  board.putAd(ad);
  assert.equal(thrown(() => board.post('zz', bytesOf(4100))).status, 400);
  assert.equal(thrown(() => board.post(gw, bytesOf(100))).status, 413); assert.equal(thrown(() => board.post(gw, bytesOf(LIMITS.maxMsg + 1))).status, 413);
  assert.equal(thrown(() => board.post(gw, 'text')).status, 413);
  const a = board.post(gw, bytesOf(4100, 1));
  assert.equal(a.id, messageId(bytesOf(4100, 1)));
  assert.equal(board.post(gw, bytesOf(4100, 1)).kept, true, 'the same request twice is one request');
  board.post(gw, bytesOf(4100, 2)); board.post(gw, bytesOf(4100, 3));
  assert.equal(thrown(() => board.post(gw, bytesOf(4100, 4))).status, 503, 'the provider\'s queue is full');
  const first = board.inbox(gw, 0);
  assert.deepEqual(first.items.map((m) => m.seq), [1, 2, 3]); assert.equal(first.next, 3);
  assert.deepEqual(board.inbox(gw, 2).items.map((m) => m.seq), [3], 'from a cursor');
  assert.deepEqual({ ...board.inbox(gw, 3), boot: null }, { next: 3, items: [], boot: null });
  assert.deepEqual({ ...board.inbox('02' + 'ff'.repeat(32), 0), boot: null }, { next: 0, items: [], boot: null });
  c.advance(601);
  assert.deepEqual(board.inbox(gw, 0).items, [], 'requests run out');
});

test('an answer: only the provider the request was for can make it, once, and it runs out', () => {
  const c = clock(), board = makeBoard({ now: c.now });
  const ad = adOf(1, T0), p = priv(1);
  board.putAd(ad); board.putAd(adOf(2, T0));
  const { id } = board.post(ad.gateway, bytesOf(4100));
  const reply = bytesOf(1200, 9);
  const sig = (who, i = id, b = reply) => bytesToHex(signSchnorr(replyDigest(i, b), who));
  assert.equal(thrown(() => board.putReply(id, reply, sig(priv(2)))).status, 403, 'another provider\'s signature');
  assert.equal(thrown(() => board.putReply(id, reply, 'ab')).status, 403);
  assert.equal(thrown(() => board.putReply(id, reply, sig(p, id, bytesOf(1200, 3)))).status, 403, 'a signature over other bytes');
  assert.equal(thrown(() => board.putReply('0'.repeat(32), reply, sig(p, '0'.repeat(32)))).status, 404);
  assert.equal(thrown(() => board.putReply(id, bytesOf(10), sig(p, id, bytesOf(10)))).status, 413);
  assert.equal(board.reply(id), null);
  assert.deepEqual(board.putReply(id, reply, sig(p)), { ok: true });
  assert.deepEqual(board.reply(id), reply);
  assert.equal(board.putReply(id, bytesOf(1200, 5), sig(p, id, bytesOf(1200, 5))).kept, true, 'the first answer stands');
  assert.deepEqual(board.reply(id), reply);
  c.advance(601);
  assert.equal(board.reply(id), null);
});

test('a want that was taken down stays down: the original, which is public, cannot be put back', () => {
  const c = clock(), board = makeBoard({ now: c.now });
  const w = (t, amount, until) => signWant({ pub: pubOf(priv(1)), btcAsset: 'ab'.repeat(32), amount, at: t, until }, priv(1));
  const original = w(T0, '100000000000', T0 + 86400);
  board.putWant(original);
  board.putWant(w(T0 + 5, '0', T0 + 65));
  assert.deepEqual(board.wants(), []);
  assert.equal(board.putWant(original).kept, true, 'replayed: not taken');
  assert.deepEqual(board.wants(), []);
  assert.equal(board.putWant(w(T0 + 10, '7', T0 + 86410)).ok, true, 'a later want of the key is a new one');
  assert.equal(board.wants().length, 1);
  // takedowns of wants that were never there leave nothing behind to fill the board with
  const other = signWant({ pub: pubOf(priv(2)), btcAsset: 'ab'.repeat(32), amount: '0', at: T0, until: T0 + 60 }, priv(2));
  board.putWant(other);
  assert.equal(board.putWant(signWant({ pub: pubOf(priv(2)), btcAsset: 'ab'.repeat(32), amount: '5', at: T0 - 1, until: T0 + 60 }, priv(2))).ok, true, 'nothing was remembered for a want that was never taken');
});

test('an ad is bounded in size, and a member named __proto__ cannot be added to a signed ad without breaking its signature', () => {
  const a = adOf(1, T0);
  assert.equal(checkAd(a, T0), a);
  assert.match(thrown(() => checkAd({ ...a, extra: 'x'.repeat(3000) }, T0)).message, /too large/);
  const sneaky = JSON.parse(JSON.stringify(a).replace(/}$/, ',"__proto__":{"x":1}}'));
  assert.match(thrown(() => checkAd(sneaky, T0)).message, /not signed by its key/, 'the member is part of what is signed');
  assert.equal(makeBoard({ now: () => T0 }).putAd(a).ok, true);
});

test('a board that restarts does not leave a provider deaf: the provider reads again from the start when the board\'s run changes', async () => {
  const c = clock();
  let board = makeBoard({ now: c.now });
  const P = providerOf(1, async () => ({ status: 200, body: { ok: true } }), c);
  board.putAd(adOf(1, T0));
  const live = { inbox: (...a) => board.inbox(...a), putReply: (...a) => board.putReply(...a), post: (...a) => board.post(...a), reply: (...a) => board.reply(...a) };
  const server = makeMailboxServer({ board: live, keys: P.keys, handle: P.handle, signReply: P.signReply, now: c.now });
  const call = pumpedCall(live, server, P.gateway, c.now);
  for (let i = 0; i < 5; i++) assert.equal((await call('GET', '/info')).status, 200);
  assert.ok(board.inbox(P.gateway, 0).boot, 'the inbox names the board\'s run');
  const run1 = board.inbox(P.gateway, 0).boot;
  board = makeBoard({ now: c.now });                                  // restarted: its ads and messages gone, its numbering from the start
  board.putAd(adOf(1, T0));
  assert.notEqual(board.inbox(P.gateway, 0).boot, run1);
  assert.equal((await call('GET', '/info')).status, 200, 'the first request after the restart is answered');
  assert.equal((await call('GET', '/info')).status, 200);
});

// ── the mailbox ──

const pumpedCall = (board, server, gateway, now, over = {}) => makeMailboxCall({ board, gateway, now, pollMs: 1, sleep: async () => { await server.pump(); }, ...over });
function providerOf(n, handle, c) {
  const board = null;
  void board;
  const p = priv(n), keys = gatewayOf(p);
  return { p, keys, gateway: bytesToHex(keys.pub), claimPub: pubOf(p), signReply: (d) => signSchnorr(d, p), handle, now: c.now };
}

test('a request goes to a provider and its answer comes back, sealed both ways: the board sees neither', async () => {
  const c = clock(), board = makeBoard({ now: c.now });
  const seenBy = [];
  const P = providerOf(1, async (req) => { seenBy.push(req); return req.path === '/missing' ? { status: 404, body: { error: 'nothing here' } } : { status: 200, body: { echo: req.path, got: req.body, secret: 'quote-4242' } }; }, c);
  board.putAd(adOf(1, T0));
  const server = makeMailboxServer({ board, keys: P.keys, handle: P.handle, signReply: P.signReply, now: c.now });
  const call = pumpedCall(board, server, P.gateway, c.now);
  const r = await call('POST', '/quote', { amount: '5000', note: 'payer-7777' });
  assert.deepEqual(r, { status: 200, body: { echo: '/quote', got: { amount: '5000', note: 'payer-7777' }, secret: 'quote-4242' } });
  assert.deepEqual(seenBy, [{ method: 'POST', path: '/quote', body: { amount: '5000', note: 'payer-7777' } }]);
  assert.deepEqual(await call('GET', '/missing'), { status: 404, body: { error: 'nothing here' } });
  assert.deepEqual((await call('GET', '/info')).body.got, null);
  // what the board holds is ciphertext
  const kept = Buffer.from(board.inbox(P.gateway, 0).items[0].bytes).toString('latin1');
  for (const word of ['5000', 'payer-7777', '/quote', 'amount']) assert.ok(!kept.includes(word), `the request does not hold "${word}"`);
  const answer = Buffer.from(board.reply(board.inbox(P.gateway, 0).items[0].id)).toString('latin1');
  for (const word of ['quote-4242', 'echo', '200']) assert.ok(!answer.includes(word), `the answer does not hold "${word}"`);
});

test('what the board or a stranger can do to a call: nothing readable, nothing that passes, and a provider that is not there is a timeout', async () => {
  const c = clock(), board = makeBoard({ now: c.now });
  const P = providerOf(1, async () => ({ status: 200, body: { ok: true } }), c);
  board.putAd(adOf(1, T0));
  const server = makeMailboxServer({ board, keys: P.keys, handle: P.handle, signReply: P.signReply, now: c.now });
  // a board that changes an answer on its way: the user's side refuses it
  const flipping = { ...board, reply: (id) => { const b = board.reply(id); if (!b) return b; const x = Uint8Array.from(b); x[x.length - 1] ^= 1; return x; }, post: (g, b) => board.post(g, b) };
  await assert.rejects(() => pumpedCall(flipping, server, P.gateway, c.now)('GET', '/info'), /did not pass its tag/);
  // a request sealed to one provider and left with another is not answered by it
  board.putAd(adOf(2, T0));
  const Q = providerOf(2, async () => ({ status: 200, body: { ok: 'q' } }), c);
  const serverQ = makeMailboxServer({ board, keys: Q.keys, handle: Q.handle, signReply: Q.signReply, now: c.now, log: () => {} });
  const sealed = await sealRequest(P.gateway, { method: 'GET', path: '/info', body: null }, { now: c.now });
  const { id } = board.post(Q.gateway, sealed.bytes);
  await serverQ.pump();
  assert.equal(board.reply(id), null, 'the other provider cannot open it');
  // garbage in the inbox does not stop what follows it
  board.post(P.gateway, bytesOf(4200, 77));
  assert.equal((await pumpedCall(board, server, P.gateway, c.now)('GET', '/info')).status, 200);
  // a provider whose mailbox nobody reads: the call gives up
  board.putAd(adOf(3, T0));
  let t = 0;
  const lonely = makeMailboxCall({ board, gateway: adOf(3, T0).gateway, now: c.now, pollMs: 1, timeoutMs: 20, sleep: async () => {}, clock: () => (t += 10) });
  await assert.rejects(() => lonely('GET', '/info'), /did not answer/);
  // an old request is not answered: the provider's clock is not the request's
  const stale = await sealRequest(P.gateway, { method: 'GET', path: '/info', body: null }, { now: () => c.now() - 4000 });
  const sid = board.post(P.gateway, stale.bytes).id;
  await server.pump();
  assert.equal(board.reply(sid), null);
  // and a handler that fails is a request not answered, not a mailbox stopped
  const broken = makeMailboxServer({ board, keys: P.keys, handle: async () => { throw new Error('boom'); }, signReply: P.signReply, now: c.now, log: () => {} });
  const bsealed = await sealRequest(P.gateway, { method: 'GET', path: '/x', body: null }, { now: c.now });
  const bid = board.post(P.gateway, bsealed.bytes).id;
  assert.ok((await broken.pump()) >= 0);
  assert.equal(board.reply(bid), null);
});

test('the ads: a provider posts its terms and what it can take now; a user reads only the ones that check out', async () => {
  const c = clock(), board = makeBoard({ now: c.now });
  let info = { btcAsset: 'ab'.repeat(32), evmAsset: '0x' + 'cd'.repeat(32), minAmount: '1000', maxAmount: '50000', available: '7000', feeBps: 25, flatFee: '100', csvBlocks: 144, evmWindowSecs: 14400 };
  const P = providerOf(1, async (req) => (req.path === '/info' ? { status: 200, body: info } : { status: 404, body: {} }), c);
  const ads = makeAdPublisher({ board, handle: P.handle, claimPriv: P.p, claimPub: P.claimPub, keys: P.keys, name: 'Fast one', now: c.now, everySecs: 60 });
  const first = await ads.publish();
  assert.deepEqual([first.name, first.available, first.feeBps, first.evmAsset, first.until - first.at], ['Fast one', '7000', 25, 'cd'.repeat(32), 360], 'an ad stands for six minutes, several posts long, so a late post leaves no gap');
  c.advance(60); info = { ...info, available: '2000' };
  await ads.publish();
  assert.equal(board.ads()[0].available, '2000', 'the newer ad replaces the older');
  const found = await readProviders({ board, now: c.now });
  assert.deepEqual(found.map((p) => [p.name, p.kind, p.id === P.claimPub]), [['Fast one', 'mailbox', true]]);
  // a board that makes an ad up, or changes one, offers a user nothing
  const lying = { ads: async () => [{ ...board.ads()[0], maxAmount: '1' }, adOf(5, T0 + 60, { gateway: P.gateway }), { v: 1 }] };
  const some = await readProviders({ board: lying, now: c.now });
  assert.deepEqual(some.map((p) => p.name), ['p5'], 'only the ad that is signed by its own key stands (it names a gateway key that is not its own, which only costs its user a call that is not answered)');
  info = null;
  assert.equal(await makeAdPublisher({ board, handle: async () => ({ status: 503, body: null }), claimPriv: P.p, claimPub: P.claimPub, keys: P.keys, now: c.now }).publish(), null);
  void ads;
});

// ── the board over HTTP ──

async function boardServer({ limits } = {}) {
  const board = makeBoard();
  const server = makeHttpServer({ handle: makeBoardHandler(board), origins: ['*'], maxBody: 131072, kindOf: boardKindOf, limits: limits || { default: [1000, 1], write: [1000, 1] } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  closers.push(close);
  return { board, base: `http://127.0.0.1:${server.address().port}`, close };
}

test('the client is the address the proxy\'s edge saw: True-Client-IP when it sets one, else the last forwarded address; the rest of a list is the client\'s own', async () => {
  const seen = [];
  const server = makeHttpServer({ handle: async ({ client }) => { seen.push(client); return { status: 200, body: { client } }; }, trustProxy: true, kindOf: () => 'default', limits: { default: [3, 3600] } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (headers) => (await realFetch(base + '/x', { headers })).status;
  const A = { 'true-client-ip': '203.0.113.5', 'x-forwarded-for': '9.9.9.9, 104.23.0.1' }, B = { 'true-client-ip': '203.0.113.6', 'x-forwarded-for': '9.9.9.9, 104.23.0.1' };
  assert.deepEqual([await get(A), await get(A), await get(A), await get(A)], [200, 200, 200, 429], 'one client\'s fourth request in its window is refused');
  assert.equal(await get(B), 200, 'another client behind the same edge is not held to it');
  assert.equal(await get({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }), 200);
  assert.equal(seen.at(-1), '2.2.2.2', 'with no True-Client-IP the last forwarded address is the client, as before');
  await get({ 'true-client-ip': 'not an ip!', 'x-forwarded-for': '1.1.1.1, 2.2.2.3' });
  assert.equal(seen.at(-1), '2.2.2.3', 'a True-Client-IP that is not an address is ignored');
  await get({ 'true-client-ip': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' });
  const v6a = seen.at(-1);
  await get({ 'true-client-ip': '2001:0db8:0001:0002:1111::4444' });
  assert.equal(seen.at(-1), v6a); assert.equal(v6a, '2001:db8:1:2::/64', 'an IPv6 client is one client by its /64');
  const plain = makeHttpServer({ handle: async ({ client }) => ({ status: 200, body: { client } }), trustProxy: false, kindOf: () => 'default' });
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { plain.closeAllConnections?.(); plain.close(r); }));
  const r = await (await realFetch(`http://127.0.0.1:${plain.address().port}/x`, { headers: { 'true-client-ip': '203.0.113.5' } })).json();
  assert.notEqual(r.client, '203.0.113.5', 'with no trusted proxy the header is not believed');
});

test('one client address may have only a few provider keys on the board at once, and gets them back as the ads run out', async () => {
  const c = clock(), board = makeBoard({ now: c.now }), handle = makeBoardHandler(board, { adKeysPerClient: 3, now: c.now });
  const put = (n, client) => handle({ method: 'PUT', path: '/ad', body: adOf(n, c.now()), client });
  assert.deepEqual([(await put(1, 'x')).status, (await put(2, 'x')).status, (await put(3, 'x')).status, (await put(4, 'x')).status], [200, 200, 200, 429], 'a fourth key from one address is refused');
  assert.equal((await put(1, 'x')).status, 200, 'an ad it already has is refreshed');
  assert.equal((await put(4, 'y')).status, 200, 'another address is not held to it');
  assert.equal((await handle({ method: 'PUT', path: '/ad', body: { claimPub: 'zz' }, client: 'z' })).status, 400, 'an ad that is not one is refused as before');
  assert.deepEqual([(await put(7, 'z')).status, (await put(8, 'z')).status, (await put(9, 'z')).status], [200, 200, 200], 'and it took none of that address\'s places');
  assert.equal((await put(5, null)).status, 200, 'a caller with no address (a test, a local run) is not held to it');
  c.advance(LIMITS.adSecs + 5);
  assert.equal((await put(6, 'x')).status, 200, 'once its ads have run out it may have others');
});

test('a want, which costs nothing to make up, has its own small allowance per address; other writes are not held to it', async () => {
  assert.deepEqual([boardKindOf('PUT', '/want'), boardKindOf('PUT', '/ad'), boardKindOf('POST', '/m/' + 'a'.repeat(66)), boardKindOf('GET', '/wants')], ['want', 'write', 'write', 'default']);
  const { base } = await boardServer({ limits: { default: [1000, 1], write: [1000, 1], want: [2, 3600] } });
  const put = async (path) => (await realFetch(base + path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status;
  const got = [await put('/want'), await put('/want'), await put('/want')];
  assert.notEqual(got[0], 429); assert.notEqual(got[1], 429); assert.equal(got[2], 429, 'the third want in the hour is refused');
  assert.notEqual(await put('/ad'), 429, 'an ad from the same address still goes in');
});
const rawCall = async (base, method, path, body) => {
  const r = await realFetch(base + path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch { /* none */ }
  return { status: r.status, body: json, headers: r.headers };
};

test('the board over HTTP: a provider and a user on sockets of their own, the same calls as the board in memory', async () => {
  const { base } = await boardServer();
  const now = () => Math.floor(Date.now() / 1000);
  const providerBoard = makeBoardClient({ base, fetchImpl: realFetch }), userBoard = makeBoardClient({ base, fetchImpl: realFetch });
  const c = { now, t: 0 };
  const P = providerOf(1, async (req) => ({ status: 200, body: { echo: req.path, got: req.body } }), c);
  const ad = adOf(1, now());
  assert.deepEqual(await providerBoard.putAd(ad), { ok: true });
  assert.equal((await userBoard.ads())[0].claimPub, ad.claimPub);
  const server = makeMailboxServer({ board: providerBoard, keys: P.keys, handle: P.handle, signReply: P.signReply, now });
  const [found] = await readProviders({ board: userBoard, now, call: { pollMs: 1, sleep: async () => { await server.pump(); } } });
  assert.equal(found.name, 'p1');
  const r = await found.counter.quote(5000);
  assert.deepEqual(r.got, { amount: '5000' });
  assert.equal(await userBoard.reply('0'.repeat(32)), null, 'no answer yet is null, not an error');
  assert.equal((await rawCall(base, 'GET', '/health')).body.ads, 1);
});

test('the board over HTTP refuses what it should: another provider\'s gateway, a message that is not base64 or sealed, a body over the limit, answers not signed', async () => {
  const { base } = await boardServer();
  const now = () => Math.floor(Date.now() / 1000);
  const ad = adOf(1, now());
  await rawCall(base, 'PUT', '/ad', ad);
  assert.equal((await rawCall(base, 'PUT', '/ad', { ...ad, maxAmount: '1' })).status, 400, 'an ad that is changed');
  assert.equal((await rawCall(base, 'PUT', '/ad', 'x')).status, 400);
  assert.equal((await rawCall(base, 'POST', `/m/${ad.gateway}`, { b: '***' })).status, 400, 'not base64');
  assert.equal((await rawCall(base, 'POST', `/m/${ad.gateway}`, { b: Buffer.from('short').toString('base64') })).status, 413, 'not a sealed request\'s size');
  assert.equal((await rawCall(base, 'POST', `/m/02${'ee'.repeat(32)}`, { b: Buffer.from(bytesOf(4100)).toString('base64') })).status, 404, 'no provider has that key');
  assert.equal((await rawCall(base, 'POST', '/m/nope', { b: '' })).status, 404);
  assert.equal((await rawCall(base, 'POST', `/m/${ad.gateway}`, { b: 'A'.repeat(200000) })).status, 413, 'over the body limit');
  const posted = await rawCall(base, 'POST', `/m/${ad.gateway}`, { b: Buffer.from(bytesOf(4100)).toString('base64') });
  assert.equal(posted.status, 200);
  const inbox = await rawCall(base, 'GET', `/m/${ad.gateway}/0`);
  assert.deepEqual([inbox.body.items.length, inbox.body.items[0].id], [1, posted.body.id]);
  assert.equal((await rawCall(base, 'PUT', `/r/${posted.body.id}`, { b: Buffer.from(bytesOf(1200)).toString('base64'), sig: 'ab'.repeat(64) })).status, 403, 'an answer nobody signed');
  assert.equal((await rawCall(base, 'GET', '/nothing')).status, 404);
  const pre = await realFetch(base + '/ad', { method: 'OPTIONS', headers: { origin: 'https://tacit.finance', 'access-control-request-method': 'PUT' } });
  assert.equal(pre.status, 204); assert.match(pre.headers.get('access-control-allow-methods'), /PUT/);
});

test('the board over HTTP limits the traffic of one client: writes have a bucket of their own', async () => {
  const { base } = await boardServer({ limits: { default: [3, 3600], write: [2, 3600] } });
  const reads = []; for (let i = 0; i < 4; i++) reads.push((await rawCall(base, 'GET', '/ads')).status);
  assert.deepEqual(reads, [200, 200, 200, 429]);
  const writes = []; for (let i = 0; i < 3; i++) writes.push((await rawCall(base, 'PUT', '/ad', {})).status);
  assert.deepEqual(writes, [400, 400, 429], 'a write is counted apart from a read');
});

// ── a swap with nothing between the user and the provider but the board ──

test('a whole swap over the board: quote, reservation, offer, the pool lock\'s offer and the claim, all sealed; the board holds only ciphertext', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(VALUE, 'inv');
  w.lBtc.satsUtxos = async () => Array.from({ length: 3 }, (_, i) => ({ txid: String(i).repeat(64), vout: 0, value: 200_000 }));
  const { svc, config } = await service(w, { config: configFor(w) });
  const inner = makeBoard({ now: w.clock.now }), traffic = [];
  const board = { ...inner, post: (g, b) => { traffic.push(b); return inner.post(g, b); }, putReply: (id, b, sig) => { traffic.push(b); return inner.putReply(id, b, sig); } };
  const claimPriv = w.lW.prims.wallet.priv, keys = gatewayOf(claimPriv);
  const provider = makeProvider({ service: svc, board, claimPriv, claimPub: config.claimPub, keys, name: 'Tab provider', now: w.clock.now });
  w.lpTick = async () => { await svc.tick(); await provider.ads.publish(); await provider.mail.pump(); };    // a minute of the provider's life: its tick, its ad, its mailbox
  await provider.ads.publish();
  const [p] = await readProviders({ board, now: w.clock.now, call: { pollMs: 1, sleep: async () => { await provider.mail.pump(); } } });
  assert.equal(p.name, 'Tab provider');
  const fb = makeFastBridgeClient({ lp: p.counter, btc: w.uBtc, evm: w.uEvmCtx, store: w.userStore, seed: w.uKeys.seed, now: w.clock.now, pins: { claimPub: p.ad.claimPub, btcAsset: p.ad.btcAsset, evmAsset: ASSET } });
  w.userTick = () => fb.tick();
  assert.equal((await fb.terms()).available, VALUE);
  const q = await fb.quote(VALUE);
  const rec = await fb.start({ quote: q, notes: [w.note] });
  await w.run(bothDone(w));
  assert.equal((await fb.records())[0].title, 'Done');
  assert.equal(w.evm.locks.leaves.length, 1);
  // every request the provider received was ciphertext: none of the swap's own words are on the board
  assert.ok(traffic.length >= 10, `${traffic.length} requests and answers carried`);
  for (const bytes of traffic) {
    const raw = Buffer.from(bytes).toString('latin1');
    for (const word of [rec.id, q.id, 'sTilde', 'presign', 'quoteId', 'claimPub']) assert.ok(!raw.includes(word), `the board never carried "${word}"`);
  }
});

let passed = 0, ran = 0;
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
for (const [name, fn] of tests) {
  if (ONLY && !ONLY.test(name)) continue;
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
  while (closers.length) { try { await closers.pop()(); } catch { /* closed */ } }
}
void hexToBytes;
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${ran} fastbridge board checks passed`);
process.exit(process.exitCode || 0);
