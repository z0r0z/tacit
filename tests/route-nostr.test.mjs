#!/usr/bin/env node
// The private route over Nostr (dapp/route-nostr.js, worker-relay/src/lib/evm-pool-keeper-nostr.js): a sealed request carried by a relay, answered by the
// real gateway, opened by the caller; and what the road refuses. A fake relay speaks the part of NIP-01 it uses.
//   node tests/route-nostr.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeSealedFetch, newGatewayKey, gatewayKeys, sealRequest } from '../dapp/sealed-request.js';
import { makeRequestEvent, readRequest, makeReplyEvent, readReply, makeNostrCarrier, REQ_KIND, REP_KIND, kidOfEnvelope, MAX_ENVELOPE } from '../dapp/route-nostr.js';
import { makeServiceGateway } from '../worker-relay/src/lib/evm-pool-keeper-sealed.js';
import { makeNostrRoad } from '../worker-relay/src/lib/evm-pool-keeper-nostr.js';

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { WebSocketServer, WebSocket } = require('ws');
let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A relay: REQ keeps a subscription, EVENT answers OK and goes to the subscriptions it matches. Nothing is kept for a later REQ (ephemeral kinds).
async function fakeRelay() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  const subs = new Set(), log = { events: [] };
  const match = (f, ev) => (!f.kinds || f.kinds.includes(ev.kind)) && Object.entries(f).every(([k, v]) => !k.startsWith('#') || ev.tags.some((t) => t[0] === k.slice(1) && v.includes(t[1])));
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m[0] === 'REQ') subs.add({ ws, id: m[1], f: m[2] });
      if (m[0] === 'EVENT') {
        log.events.push(m[1]);
        ws.send(JSON.stringify(['OK', m[1].id, true, '']));
        for (const s of subs) if (s.ws.readyState === 1 && match(s.f, m[1])) s.ws.send(JSON.stringify(['EVENT', s.id, m[1]]));
      }
    });
    ws.on('close', () => { for (const s of subs) if (s.ws === ws) subs.delete(s); });
  });
  return { url: `ws://127.0.0.1:${wss.address().port}`, log, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}

// The real gateway over a stand-in keeper.
const secret = newGatewayKey(), keys = gatewayKeys(secret), PUB = Buffer.from(keys.pub).toString('hex');
const served = [];
const serve = (req, res) => { served.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ via: 'keeper', path: req.url })); };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const take = makeServiceGateway({ secret, serve, json, ratePerMin: 20 });
const KEEPER = 'https://keepers.test';
const relay = await fakeRelay();
const road = makeNostrRoad({ take, kidHex: take.key.kid, relays: [relay.url], WS: WebSocket, minBits: 8 }).start();
for (let i = 0; i < 50 && road.stats().relays.length < 1; i++) await sleep(50);
assert.equal(road.stats().relays.length, 1, 'the keeper is listening on the relay');
const carrier = () => makeNostrCarrier({ relays: [relay.url], WS: WebSocket, bits: 8, timeoutMs: 4000 });

await check('events: a request is read back, and what is wrong with one is refused', async () => {
  const sealed = await sealRequest(PUB, { method: 'GET', path: '/1/evm-pool/keeper/head' });
  const ev = makeRequestEvent(sealed.bytes, { bits: 8 });
  assert.equal(ev.kind, REQ_KIND);
  assert.deepEqual(readRequest(ev, { kidHex: take.key.kid, minBits: 8 }), new Uint8Array(sealed.bytes), 'the envelope comes back whole');
  assert.equal(readRequest(ev, { kidHex: 'deadbeef', minBits: 8 }), null, 'another key id');
  assert.equal(readRequest(ev, { kidHex: take.key.kid, minBits: 20 }), null, 'too little work');
  assert.equal(readRequest({ ...ev, content: ev.content.slice(0, -4) + 'AAAA' }, { kidHex: take.key.kid, minBits: 8 }), null, 'a changed envelope');
  assert.equal(readRequest(ev, { kidHex: take.key.kid, minBits: 8, nowSec: ev.created_at + 400 }), null, 'a stale one');
  assert.equal(kidOfEnvelope(sealed.bytes), take.key.kid);
  assert.throws(() => makeRequestEvent(new Uint8Array(MAX_ENVELOPE + 1), { bits: 0 }), /too large/);
  const rep = makeReplyEvent(new Uint8Array([1, 2, 3]), ev.id);
  assert.deepEqual(readReply(rep, ev.id), new Uint8Array([1, 2, 3]));
  assert.equal(readReply(rep, 'f'.repeat(64)), null, 'a reply to another request');
  assert.equal(rep.kind, REP_KIND);
});

await check('a request sealed to the gateway goes through a relay and the answer comes back to the caller', async () => {
  served.length = 0;
  const f = await makeSealedFetch({ keeper: KEEPER, chainId: 'k', gateway: PUB, nostr: carrier(), forwarders: ['http://127.0.0.1:1'] });
  const r = await f(`${KEEPER}/1/evm-pool/keeper/head`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { via: 'keeper', path: '/1/evm-pool/keeper/head' });
  assert.deepEqual(served, ['/1/evm-pool/keeper/head'], 'the keeper handled it once');
  assert.equal(road.stats().answered >= 1, true);
});

await check('what the relay saw is a blob: no path and no answer in the clear', async () => {
  const text = JSON.stringify(relay.log.events);
  assert.ok(!text.includes('evm-pool'), 'the path is not in any event');
  assert.ok(!text.includes('"via"'), 'the answer is not in any event');
  assert.ok(relay.log.events.every((e) => e.pubkey && e.kind >= 21501 && e.kind <= 21502));
  const pubs = new Set(relay.log.events.map((e) => e.pubkey));
  assert.equal(pubs.size, relay.log.events.length, 'every event has a key of its own');
});

await check('a burst of reads shares envelopes on this road too, and each caller has its own answer', async () => {
  const f = await makeSealedFetch({ keeper: KEEPER, chainId: 'k', gateway: PUB, nostr: carrier(), forwarders: ['http://127.0.0.1:1'] });
  const paths = Array.from({ length: 6 }, (_, i) => `/1/evm-pool/keeper/quote?n=${i}`);
  const answers = await Promise.all(paths.map(async (p) => (await f(`${KEEPER}${p}`)).json()));
  assert.deepEqual(answers.map((a) => a.path), paths);
});

await check('a replayed request event is answered once', async () => {
  const sealed = await sealRequest(PUB, { method: 'GET', path: '/1/evm-pool/keeper/head' });
  const ev = makeRequestEvent(sealed.bytes, { bits: 8 });
  const before = road.stats().answered;
  const ws = new WebSocket(relay.url); await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify(['EVENT', ev])); ws.send(JSON.stringify(['EVENT', ev]));
  await sleep(600); ws.close();
  assert.equal(road.stats().answered - before, 1);
});

await check('when no relay carries it the request fails, and is never sent in the open', async () => {
  const dead = makeNostrCarrier({ relays: ['ws://127.0.0.1:1'], WS: WebSocket, bits: 8, timeoutMs: 1500 });
  let direct = 0;
  const f = await makeSealedFetch({ keeper: KEEPER, chainId: 'k', gateway: PUB, nostr: dead, forwarders: ['http://127.0.0.1:1'], fetchImpl: async (u) => { if (String(u).startsWith(KEEPER)) direct++; throw new Error('connection refused'); } });
  await assert.rejects(f(`${KEEPER}/1/evm-pool/keeper/head`));
  assert.equal(direct, 0, 'nothing went to the keeper itself');
});

await check('a request for another gateway key is not heard', async () => {
  const other = gatewayKeys(newGatewayKey());
  const f = await makeSealedFetch({ keeper: KEEPER, chainId: 'k', gateway: Buffer.from(other.pub).toString('hex'), nostr: makeNostrCarrier({ relays: [relay.url], WS: WebSocket, bits: 8, timeoutMs: 1200 }), forwarders: ['http://127.0.0.1:1'] });
  const before = road.stats().heard;
  await assert.rejects(f(`${KEEPER}/1/evm-pool/keeper/head`));
  assert.equal(road.stats().heard, before, 'not even counted');
});

road.stop(); await relay.close();
console.log(`\n${n} checks passed`);
process.exit(0);
