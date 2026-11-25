// How much of the Bitcoin and ETH provider, its board and the page's quote stays open to others when one client sends a lot: the providers a quote asks and
// how long it waits on each, the board's queues, and the provider's holds, quotes and offers.
//   node tests/fastbridge-capacity.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { makeCounter } from '../dapp/fastbridge-http.js';
import { pairWorld, SATS, UNITS } from './lib/pair-world.mjs';
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

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
