// How much of the Bitcoin and ETH provider, its board and the page's quote stays open to others when one client sends a lot: the providers a quote asks and
// how long it waits on each, the board's queues, and the provider's holds, quotes and offers.
//   node tests/fastbridge-capacity.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { makeCounter } from '../dapp/fastbridge-http.js';
import { pairWorld, SATS, UNITS } from './lib/pair-world.mjs';
import { memStore } from './lib/fastbridge-world.mjs';
import { sealRequest } from '../dapp/sealed-request.js';
import { signSchnorr } from '../dapp/bulletproofs.js';
import { gatewayOf, makeMailboxServer } from '../dapp/fastbridge-mailbox.js';
import { makeBoard, signAd, replyDigest, LIMITS } from '../dapp/fastbridge-board.js';
import { secp, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const T0 = 1_800_000_000;
const priv = (n) => new Uint8Array(32).fill(n);
const pubOf = (p) => bytesToHex(secp.getPublicKey(p, true));
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

// eight ads that ask no fee and never answer, with new keys on every read of the board
const fakesOf = (real, round) => Array.from({ length: 8 }, (_, i) => ({
  id: `fake-${round}-${i}`, name: 'Provider', ref: { kind: 'mailbox', fake: true }, assets: real.assets,
  terms: { ...real.terms, feeBps: 0, flatFee: 0n, minAmount: 1n, maxAmount: 10n ** 12n }, reverse: { feeBps: 0, flatFee: 0n, minAmount: 1n, maxAmount: 10n ** 12n, available: null },
}));
const never = (n = () => {}) => makeCounter(() => (n(), new Promise(() => {})));
// a transport to the world's provider that counts the quotes it is asked for
const toFwd = (w, n) => makeCounter(async (m, path, body) => { if (path === '/quote') n(); const r = await w.fwd.handle({ method: m, path, body }); return { status: r.status, body: r.body }; });
const toRev = (w, n) => async (m, path, body) => { if (path === '/reverse/quote') n(); const r = await w.rev.handle({ method: m, path, body }); return { status: r.status, body: r.body }; };

test('page: a provider /fast/lp.json names is asked for every quote, whatever other ads the board lists, and at most four of those are asked', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(10n * UNITS, 'inv0');
  const real = await w.discover();
  let houseAsked = 0, fakesAsked = 0, round = 0;
  const pair = w.makePair({
    discover: async () => [...real, ...fakesOf(real[0], round)],
    counterFor: (ref) => (ref.fake ? never(() => fakesAsked++) : toFwd(w, () => houseAsked++)),
    reverseCallFor: (ref) => (ref.fake ? () => (fakesAsked++, new Promise(() => {})) : toRev(w, () => houseAsked++)),
    policy: { askMs: 20 },
  });
  for (let i = 0; i < 5; i++) {
    for (const dir of ['b2e', 'e2b']) {
      round++; const before = fakesAsked;
      const q = await pair.quote({ dir, amount: dir === 'b2e' ? SATS : UNITS });
      assert.equal(q.provider.id, 'lp1', `${dir}: the named provider's quote`);
      assert.ok(fakesAsked - before <= 4, `${dir}: ${fakesAsked - before} of the other ads asked`);
    }
  }
  assert.equal(houseAsked, 10, 'asked for every quote');
});

test('page: a provider this key finished a swap with is asked although it is only an ad on the board', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(10n * UNITS, 'inv0');
  const [real] = await w.discover();
  const onBoard = { ...real, ref: { ...real.ref, kind: 'mailbox' } };
  let houseAsked = 0, round = 0;
  const pair = w.makePair({
    discover: async () => [onBoard, ...fakesOf(real, ++round)],
    counterFor: (ref) => (ref.fake ? never() : toFwd(w, () => houseAsked++)),
    policy: { askMs: 20 },
  });
  // an ad like any other: past the four that ask no fee, it is not asked
  await assert.rejects(pair.quote({ dir: 'b2e', amount: SATS }), /no provider could quote|did not answer/);
  assert.equal(houseAsked, 0);
  await w.mems.get('fwd').put({ id: 'f'.repeat(64), role: 'bl', phase: 'done', created: 1, amount: '1', evmAmount: '1', csvBlocks: 144, provider: onBoard.ref });
  const q = await pair.quote({ dir: 'b2e', amount: SATS });
  assert.equal(q.provider.id, 'lp1');
  assert.equal(houseAsked, 1);
});

test('page: an ETH-for-Bitcoin quote is asked with the quote\'s own wait, and the rest of the swap with the transport\'s', async () => {
  const w = pairWorld();
  await w.ready();
  const waits = [];
  const pair = w.makePair({
    reverseCallFor: (ref, o = {}) => { const ms = o.timeoutMs || null; return async (m, path, body) => { waits.push([path, ms]); const r = await w.rev.handle({ method: m, path, body }); return { status: r.status, body: r.body }; }; },
    policy: { askMs: 777 },
  });
  await pair.quote({ dir: 'e2b', amount: UNITS });
  assert.deepEqual(waits.filter(([p]) => p === '/reverse/quote'), [['/reverse/quote', 777]]);
});

const board9 = (c) => {
  const board = makeBoard({ now: c.now });
  const p = priv(9), keys = gatewayOf(p), gateway = bytesToHex(keys.pub);
  const advertise = () => board.putAd(signAd({ claimPub: pubOf(p), gateway, btcAsset: '00'.repeat(32), evmAsset: 'cd'.repeat(32), minAmount: '1', maxAmount: '9', available: '9', feeBps: 20, flatFee: '0', csvBlocks: 144, evmWindowSecs: 14400, name: 'house', at: c.t, until: c.t + 360 }, p));
  advertise();
  return { board, p, keys, gateway, advertise };
};

test('board: one address that posts requests the provider cannot open turns away only itself, and the provider\'s other users are taken at once', async () => {
  const c = { t: T0, now: () => c.t };
  const { board, p, keys, gateway } = board9(c);
  let handled = 0;
  const mail = makeMailboxServer({ board, keys, handle: async () => { handled++; return { status: 200, body: {} }; }, signReply: (d) => signSchnorr(d, p), now: c.now });
  // the provider keeps up: it reads its inbox and sets aside what it cannot open after every 24 (the board's share for one address)
  let posted = 0, refused = null;
  for (let i = 0; i < 2000 && !refused; i++) {
    try { board.post(gateway, rand(LIMITS.minMsg), { claimPub: pubOf(p), client: 'ip:one' }); posted++; } catch (e) { refused = e; }
    if (posted % 24 === 0) await mail.pump();
  }
  await mail.pump();
  assert.equal(handled, 0, 'nothing of it reached the handler');
  assert.equal(board.stats().queued, 0, 'the provider kept up: its queue is empty');
  assert.equal(posted, LIMITS.maxPostedFrom, 'one address is turned away once it has its share of the requests still known');
  assert.match(String(refused && refused.message), /from this address/);
  assert.ok(board.post(gateway, rand(LIMITS.minMsg), { claimPub: pubOf(p), client: 'ip:user' }).id, 'another address is taken at once');
  assert.ok(board.post(gateway, rand(LIMITS.minMsg), { claimPub: pubOf(p) }).id, 'and a request with no address');
});

test('board: the bytes waiting in all the providers\' queues together are bounded, and the requests it keeps known are forgotten oldest first once answered', async () => {
  const c = { t: T0, now: () => c.t };
  const board = makeBoard({ now: c.now, limits: { maxQueuesBytes: 3 * LIMITS.minMsg + 10, maxKept: 4 } });
  const ads = [7, 8].map((n) => { const p = priv(n); const gw = bytesToHex(gatewayOf(p).pub); board.putAd(signAd({ claimPub: pubOf(p), gateway: gw, btcAsset: '00'.repeat(32), evmAsset: 'cd'.repeat(32), minAmount: '1', maxAmount: '9', available: '9', feeBps: 20, flatFee: '0', csvBlocks: 144, evmWindowSecs: 14400, name: 'p' + n, at: c.t, until: c.t + 360 }, p)); return { p, gw }; });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(board.post(ads[0].gw, rand(LIMITS.minMsg)).id);
  assert.throws(() => board.post(ads[1].gw, rand(LIMITS.minMsg)), (e) => e.status === 503 && /board has all/.test(e.message), 'the board\'s bytes are full, whichever provider a request is for');
  const answer = (id) => { const b = rand(1200); board.putReply(id, b, bytesToHex(signSchnorr(replyDigest(id, b), ads[0].p))); };
  for (const id of ids) answer(id);
  assert.equal(board.stats().queuedBytes, 0);
  board.post(ads[1].gw, rand(LIMITS.minMsg));
  board.post(ads[1].gw, rand(LIMITS.minMsg));
  assert.equal(board.stats().known, 4, 'four known: the oldest answered one was forgotten to take the fifth');
  assert.ok(board.reply(ids[0]), 'its answer is still there to be read');
});

test('board: a provider\'s inbox tells one client address\'s requests from another\'s with a tag that names neither, and the tag changes after a while', async () => {
  const c = { t: T0, now: () => c.t };
  const { board, p, gateway, advertise } = board9(c);
  const a1 = board.post(gateway, rand(LIMITS.minMsg), { client: '203.0.113.7' }), a2 = board.post(gateway, rand(LIMITS.minMsg), { client: '203.0.113.7' });
  const b1 = board.post(gateway, rand(LIMITS.minMsg), { client: '198.51.100.9' }), n1 = board.post(gateway, rand(LIMITS.minMsg));
  const from = Object.fromEntries(board.inbox(gateway, 0).items.map((m) => [m.id, m.from]));
  assert.match(from[a1.id], /^[0-9a-f]{16}$/);
  assert.equal(from[a1.id], from[a2.id], 'one address, one tag');
  assert.notEqual(from[a1.id], from[b1.id], 'two addresses, two tags');
  assert.equal(from[n1.id], undefined, 'a request with no address has none');
  assert.ok(!JSON.stringify(board.inbox(gateway, 0)).includes('203.0.113.7'));
  c.t += LIMITS.fromSecs; advertise();
  const a3 = board.post(gateway, rand(LIMITS.minMsg), { client: '203.0.113.7' });
  const tagA3 = board.inbox(gateway, 0).items.find((m) => m.id === a3.id).from;
  assert.notEqual(tagA3, from[a1.id], 'a later tag for the same address is another');
  // the provider's mailbox hands the tag to its handler as the client, so a provider's holds are shared out per client and not among all of the board's
  const seen = [];
  const mail = makeMailboxServer({ board, keys: gatewayOf(p), handle: async (req) => { seen.push(req.client || null); return { status: 200, body: {} }; }, signReply: (d) => signSchnorr(d, p), now: c.now });
  const sealed = await sealRequest(gateway, { method: 'GET', path: '/info', body: null }, { now: c.now });
  board.post(gateway, sealed.bytes, { client: '203.0.113.7' });
  await mail.pump();
  assert.deepEqual(seen.filter(Boolean), [`board:${tagA3}`], 'the request it could open was handled for the tag of its address');
});

test('provider: a user whose free hold was let go for four newer ones through the board still has its lock taken: /extend with a transaction that pays the quote\'s lock stands for the hold', async () => {
  const run = async (evict) => {
    const w = pairWorld({ fwdQuote: { validSecs: 300, graceSecs: 900, lateSecs: 21600 } });
    await w.ready();
    w.lEvm.fund(w.fwd.quoter.price(SATS).evmAmount, 'inv0');      // a note of the payout's size, and room for four more holds
    w.lEvm.fund(10n * UNITS, 'inv1');
    const q = await w.pair.quote({ dir: 'b2e', amount: SATS });
    await w.pair.start(q);                                // the page's /reserve, with no client address (as a board request without a tag)
    if (evict) {
      for (let i = 0; i < 4; i++) {
        const aq = await w.fwd.handle({ method: 'POST', path: '/quote', body: { amount: '20000' } });
        assert.equal((await w.fwd.handle({ method: 'POST', path: '/reserve', body: { quoteId: aq.body.id } })).body.ok, true);
      }
      assert.equal(w.fwd.reservations.has(q.ref.r.id), false, 'the user\'s hold was let go');
    }
    // the lock waits 25 minutes for its block (a slow block, or a fee the next block did not take)
    for (let i = 0; i < 25; i++) { await w.step(); w.clock.advance(60); }
    w.btc.mine(1, { advance: false });
    for (let i = 0; i < 200; i++) {
      await w.step(); w.clock.advance(60);
      if (i % 10 === 9) w.btc.mine(1, { advance: false });
      const r = (await w.mems.get('fwd').list())[0];
      if (['done', 'refund-wait', 'counter-took', 'claimed'].includes(r.phase)) break;
    }
    return (await w.mems.get('fwd').list())[0];
  };
  for (const evict of [false, true]) {
    const r = await run(evict);
    assert.equal(r.extended, true, `${evict ? 'with' : 'without'} the four holds the /extend is taken (${r.extendWhy || ''})`);
    assert.ok(['done', 'claimed', 'counter-took'].includes(r.phase), `${evict ? 'with' : 'without'} the four holds the swap goes through (${r.phase} ${r.why || ''})`);
  }
});

test('provider: /extend without a hold is taken only for a transaction that pays this quote\'s own lock, while the quote and its grace stand', async () => {
  const w = pairWorld({ fwdQuote: { validSecs: 300, graceSecs: 900, lateSecs: 21600 } });
  await w.ready();
  w.lEvm.fund(10n * UNITS, 'inv0');
  const q = (await w.fwd.handle({ method: 'POST', path: '/quote', body: { amount: String(SATS) } })).body;
  const ext = (body) => w.fwd.handle({ method: 'POST', path: '/extend', body: { quoteId: q.id, ...body } });
  const lock = { T: bytesToHex(secp.getPublicKey(priv(3), true)), lockerXonly: bytesToHex(secp.getPublicKey(priv(4), true)).slice(2) };
  assert.match((await ext({ txid: 'ab'.repeat(32) })).body.why, /no reservation/, 'no lock named: refused as before');
  let reads = 0;
  const fetchTx = w.lBtc.fetchTx;
  w.lBtc.fetchTx = async (txid) => { reads++; return fetchTx(txid); };
  assert.match((await ext({ txid: 'ab'.repeat(32), lock })).body.why, /not visible yet/);
  for (let i = 0; i < 8; i++) await ext({ txid: (i + 10).toString(16).padStart(64, '0'), lock });
  assert.ok(reads <= 4, `a quote with no hold looks at a few transactions (${reads})`);
  w.clock.advance(300 + 900 + 1);
  assert.match((await ext({ txid: 'cd'.repeat(32), lock })).body.why, /no reservation/, 'past its grace: refused');
});

test('provider: a quote costs no store until it is held: a client that asks for one a second fills nothing, and a held quote is kept and read back', async () => {
  const MAX = 60;
  const store = Object.assign(memStore(), { del: async function (id) { this.m.delete(id); } });
  const w = pairWorld({ fwdPolicy: { maxQuotes: MAX }, fwdQuote: { validSecs: 300, graceSecs: 900, lateSecs: 21600 }, fwdQuoteStore: store });
  await w.ready();
  w.lEvm.fund(10n * UNITS, 'inv0');
  let lists = 0;
  const list = w.stores.lp.list;
  w.stores.lp.list = async () => { lists++; return list(); };
  const quote = () => w.fwd.handle({ method: 'POST', path: '/quote', body: { amount: String(SATS) } });
  await w.fwd.tick();
  lists = 0;
  const ids = [];
  for (let i = 0; i < 4 * MAX; i++) { const r = await quote(); assert.equal(r.status, 200); ids.push(r.body.id); w.clock.advance(1); }
  assert.equal(store.m.size, 0, 'nothing stored for a quote');
  assert.ok(lists <= 20, `the open swaps were read ${lists} times for ${4 * MAX} quotes`);
  // a quote is read back from its id, and one whose id was changed is no quote
  const q = await w.fwd.quoter.get(ids[0]);
  assert.equal(q.btcValue, String(SATS));
  const bent = ids[0].slice(0, 20) + (ids[0][20] === '0' ? '1' : '0') + ids[0].slice(21);
  assert.equal(await w.fwd.quoter.get(bent), null);
  assert.match((await w.fwd.handle({ method: 'POST', path: '/reserve', body: { quoteId: bent } })).body.why, /unknown quote/);
  // a hold stores it, and letting go of the hold lets go of it
  const last = ids.at(-1);
  assert.equal((await w.fwd.handle({ method: 'POST', path: '/reserve', body: { quoteId: last } })).body.ok, true);
  assert.equal(store.m.size, 1);
  assert.equal((await store.get(last)).reservedUntil > 0, true);
  w.clock.advance(301);
  await w.fwd.tick(); w.clock.advance(3601); await w.providerFeed.refresh(); await w.fwd.tick();
  assert.equal(store.m.size, 0, 'a hold that ran out leaves nothing stored');
});

test('provider: a quote stored when it was given (before quotes were sealed) is still held and answered', async () => {
  const store = Object.assign(memStore(), { del: async function (id) { this.m.delete(id); } });
  const w = pairWorld({ fwdQuoteStore: store });
  await w.ready();
  w.lEvm.fund(10n * UNITS, 'inv0');
  const fresh = (await w.fwd.handle({ method: 'POST', path: '/quote', body: { amount: String(SATS) } })).body;
  const old = { ...(await w.fwd.quoter.get(fresh.id)), id: 'ab'.repeat(16) };
  await store.put(old);
  const r = await w.fwd.handle({ method: 'POST', path: '/reserve', body: { quoteId: old.id } });
  assert.equal(r.body.ok, true);
  assert.equal((await w.fwd.quoter.get(old.id)).btcValue, String(SATS));
  assert.equal((await store.get(old.id)).reservedUntil, r.body.until);
});

test('provider: the reverse side lets go of the quotes no swap uses once they have run out, and keeps the one that started a swap', async () => {
  const w = pairWorld();
  await w.ready();
  w.stores.rv.quotes.del = async function (id) { this.m.delete(id); };
  const claimPub = pubOf(priv(5));
  const ids = [];
  for (let i = 0; i < 200; i++) { const r = await w.rev.handle({ method: 'POST', path: '/reverse/quote', body: { amount: String(UNITS), claimPub } }); assert.equal(r.status, 200); ids.push(r.body.id); }
  const started = await w.rev.handle({ method: 'POST', path: '/reverse/start', body: { quoteId: ids[0] } });
  assert.equal(started.body.ok, true);
  for (let d = 0; d < 3 * 24; d++) { w.clock.advance(3600); await w.rev.tick(); }
  assert.deepEqual([...w.stores.rv.quotes.m.keys()], [ids[0]], 'only the quote that started a swap is kept');
});

test('provider: offers for locks that no /extend named share a budget of explorer reads, and a transaction found missing is not looked for again at once', async () => {
  const w = pairWorld();
  await w.ready();
  w.lEvm.fund(10n * UNITS, 'inv0');
  let reads = 0;
  const fetchTx = w.lBtc.fetchTx;
  w.lBtc.fetchTx = async (txid) => { reads++; return fetchTx(txid); };
  const q = (await w.fwd.handle({ method: 'POST', path: '/quote', body: { amount: String(SATS) } })).body;
  const offer = (txid, sid) => w.fwd.handle({ method: 'POST', path: '/offer', body: { quoteId: q.id, offer: { swapId: sid, btc: { txid, vout: 0, value: String(SATS), csvBlocks: 144 }, evm: { amount: q.evmAmount } } } });
  const hexOf = (n, len) => n.toString(16).padStart(len, '0');
  // the same transaction again and again: looked for once
  for (let i = 0; i < 10; i++) assert.equal((await offer('ab'.repeat(32), hexOf(1, 72))).body.ok, false);
  assert.equal(reads, 1, 'one read for one missing transaction');
  // a new transaction every time: the budget, then no more reads
  reads = 0;
  for (let i = 0; i < 100; i++) await offer(hexOf(i + 100, 64), hexOf(i + 100, 72));
  assert.ok(reads <= 30, `${reads} reads for 100 offers of transactions no /extend named`);
  const last = (await offer(hexOf(999, 64), hexOf(999, 72))).body;
  assert.equal(last.retry, true);
  // it fills again with time
  w.clock.advance(60);
  reads = 0;
  await offer(hexOf(1000, 64), hexOf(1000, 72));
  assert.equal(reads, 1);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
