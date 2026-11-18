// The private route to a relay anyone has listed in the relay registry: the relay's gateway key signed for by its relayer key (GET /sealed/key), a forwarder that
// carries a sealed request to the registry's entry for a relayer and to nothing else (POST /r/<chain>/<relayer>), the registry read behind it, the guard that keeps
// it from reaching anything private, and the wallet's side (dapp/route-community.js).
//
// Run: node worker-relay/tests/relay-community-route.test.mjs

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { privateKeyToAccount } from 'viem/accounts';
import { makeServiceGateway } from '../src/lib/evm-pool-keeper-sealed.js';
import { makeForwarder } from '../src/lib/evm-pool-forwarder.js';
import { makeRegistryReader } from '../src/lib/relay-registry-reader.js';
import { isPublicAddress, publicName, relayOrigin, guardedLookup, safeRequest } from '../src/lib/safe-https.js';
import { makeSealedFetch, newGatewayKey, gatewayKeys } from '../../dapp/sealed-request.js';
import { makeCommunityRoute } from '../../dapp/route-community.js';
import { verifyDoc } from '../../dapp/relay-gateway-doc.js';
import { encodeList } from '../../tests/helpers/relay-registry-list.mjs';

let pass = 0, fail = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.stack?.split('\n').slice(0, 2).join(' | ') ?? e.message}`); fail++; }
};
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r));
const jsonTo = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); };

const account = privateKeyToAccount('0x' + '3a'.repeat(32));
const stranger = privateKeyToAccount('0x' + '4b'.repeat(32));
const RELAY_URL = 'https://relay.example/1/evm-pool/keeper';

// a relay: the multi-keeper service's route with its gateway key and the signed key document, in front of a handler that quotes
async function relay({ accounts = [account], secret = newGatewayKey() } = {}) {
  const seen = [];
  const serve = (req, res) => {
    seen.push({ url: req.url, ip: req.socket?.remoteAddress ?? null, headers: req.headers });
    if (req.url.split('?')[0] === '/1/evm-pool/keeper/quote') return jsonTo(res, 200, { chainId: 1, relayer: account.address, fee: '777' });
    return jsonTo(res, 404, { error: 'not found' });
  };
  const take = makeServiceGateway({ secret, serve, json: jsonTo, accounts, ratePerMin: 100_000 });
  const server = createServer((req, res) => (take(req, res) ? undefined : serve(req, res)));
  await listen(server);
  return { server, seen, secret, pub: Buffer.from(gatewayKeys(secret).pub).toString('hex'), base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
// a forwarder whose community route finds `entries` and sends to the relay at `base` as if it were https://relay.example
async function forwarder({ entries, base, ratePerMin = 100_000, request = null, enabled = true }) {
  const sent = [];
  const community = enabled ? {
    find: async (chain, relayer) => entries.find((e) => e.chainId === chain && e.relayer.toLowerCase() === relayer.toLowerCase()) ?? null,
    request: request ?? (async (url, o) => {
      sent.push({ url, ...o });
      const r = await fetch(url.replace('https://relay.example', base), { method: o.method, headers: o.headers, body: o.body });
      return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
    }),
  } : null;
  const server = createServer(makeForwarder({ gateways: {}, community, ratePerMin }));
  await listen(server);
  return { server, sent, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
const entry = { chainId: 1, url: RELAY_URL, relayer: account.address };

console.log('the relay\'s key document');
await check('GET /sealed/key shows the gateway key signed for by each keeper account, and a wallet that knows only the address accepts it', async () => {
  const r = await relay();
  try {
    const { docs } = await (await fetch(`${r.base}/sealed/key`)).json();
    assert.equal(docs.length, 1);
    assert.equal(verifyDoc(docs[0], account.address), r.pub);
    assert.equal(verifyDoc(docs[0], stranger.address), null, 'not another relayer\'s');
  } finally { r.close(); }
});
await check('several accounts each get a document; the key is the gateway\'s alone; an unknown path and a POST are not the document', async () => {
  const r = await relay({ accounts: [account, stranger] });
  try {
    const { docs } = await (await fetch(`${r.base}/sealed/key`)).json();
    assert.deepEqual(docs.map((d) => d.relayer).sort(), [account.address.toLowerCase(), stranger.address.toLowerCase()].sort());
    assert.ok(docs.every((d) => d.key === r.pub));
    assert.equal((await fetch(`${r.base}/sealed/keys`)).status, 404);
    assert.equal((await fetch(`${r.base}/sealed/key`, { method: 'POST' })).status, 404);
  } finally { r.close(); }
});
await check('a service with no accounts shows no documents (nothing to vouch with), and the key is never the secret', async () => {
  const r = await relay({ accounts: [] });
  try {
    const body = await (await fetch(`${r.base}/sealed/key`)).text();
    assert.deepEqual(JSON.parse(body), { docs: [] });
    assert.ok(!body.includes(r.secret));
  } finally { r.close(); }
});

console.log('the forwarder\'s relay routes');
await check('a sealed request to a relay in the registry is carried to its /sealed and the sealed answer comes back, through the wallet\'s route end to end', async () => {
  const r = await relay(), f = await forwarder({ entries: [entry], base: r.base });
  try {
    const route = makeCommunityRoute({ relays: [entry], makeSealedFetch, forwarders: [f.url] });
    const res = await route.fetch(`${RELAY_URL}/quote`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { chainId: 1, relayer: account.address, fee: '777' });
    const post = f.sent.find((s) => s.method === 'POST');
    assert.equal(post.url, 'https://relay.example/sealed', 'to the relay\'s own /sealed on its origin');
    assert.deepEqual(Object.keys(post.headers), ['content-type'], 'nothing of the caller\'s is passed on');
    assert.equal(f.sent.find((s) => s.method === 'GET').url, 'https://relay.example/sealed/key');
    assert.ok(r.seen.length >= 1 && r.seen.every((s) => !s.headers['x-forwarded-for'] && !s.headers.origin), 'the relay saw the forwarder, no header of the caller');
  } finally { r.close(); f.close(); }
});
await check('the relay is reached again with the key it already has: one key fetch for many requests, and a warm-up fetches it ahead', async () => {
  const r = await relay(), f = await forwarder({ entries: [entry], base: r.base });
  try {
    const route = makeCommunityRoute({ relays: [entry], makeSealedFetch, forwarders: [f.url] });
    await route.warm();
    const keysAfterWarm = f.sent.filter((s) => s.method === 'GET').length;
    await route.fetch(`${RELAY_URL}/quote`); await route.fetch(`${RELAY_URL}/quote`);
    assert.equal(keysAfterWarm, 1);
    assert.equal(f.sent.filter((s) => s.method === 'GET').length, 1, 'still one');
    assert.equal(f.sent.filter((s) => s.method === 'POST').length, 2);
  } finally { r.close(); f.close(); }
});
await check('a key document signed by anyone but the relayer is refused, and then nothing is sent to the relay at all', async () => {
  const r = await relay({ accounts: [stranger] }), f = await forwarder({ entries: [entry], base: r.base });
  try {
    const route = makeCommunityRoute({ relays: [entry], makeSealedFetch, forwarders: [f.url] });
    await assert.rejects(route.fetch(`${RELAY_URL}/quote`), /could not be shown and checked/);
    assert.equal(f.sent.filter((s) => s.method === 'POST').length, 0, 'no envelope was sealed to a key nobody vouched for');
  } finally { r.close(); f.close(); }
});
await check('a forwarder that swaps the key for its own (it cannot sign for the relayer) is refused; the next forwarder\'s honest answer is used', async () => {
  const r = await relay(), good = await forwarder({ entries: [entry], base: r.base });
  const evilKey = Buffer.from(gatewayKeys(newGatewayKey()).pub).toString('hex');
  const evil = await forwarder({ entries: [entry], base: r.base, request: async (url) => {
    const real = await (await fetch(url.replace('https://relay.example', r.base))).json();
    return { status: 200, body: Buffer.from(JSON.stringify({ docs: [{ ...real.docs[0], key: evilKey }] })) };
  } });
  try {
    const route = makeCommunityRoute({ relays: [entry], makeSealedFetch, forwarders: [evil.url, good.url] });
    for (let i = 0; i < 4; i++) { const res = await route.fetch(`${RELAY_URL}/quote`); assert.equal(res.status, 200); }
    const alone = makeCommunityRoute({ relays: [entry], makeSealedFetch, forwarders: [evil.url] });
    await assert.rejects(alone.fetch(`${RELAY_URL}/quote`), /could not be shown and checked/);
  } finally { r.close(); good.close(); evil.close(); }
});
await check('a url that is not a listed relay is never reached, and a relay the registry does not list answers 404 from the forwarder', async () => {
  const r = await relay(), f = await forwarder({ entries: [], base: r.base });
  try {
    const route = makeCommunityRoute({ relays: [entry], makeSealedFetch, forwarders: [f.url] });
    await assert.rejects(route.fetch('https://other.example/1/evm-pool/keeper/quote'), /does not reach this relay/);
    assert.equal(route.has('https://other.example/1/evm-pool/keeper/quote'), false);
    assert.equal((await fetch(`${f.url}/r/1/${account.address}/key`)).status, 404, 'not in the registry');
    assert.equal((await fetch(`${f.url}/r/1/${account.address}`, { method: 'POST', body: 'x' })).status, 404);
    await assert.rejects(route.fetch(`${RELAY_URL}/quote`), /could not be shown and checked/);
  } finally { r.close(); f.close(); }
});
await check('without a registry the /r/ routes are 404, a wrong method is 404, a bad address is 404, and the /f/ route is as it was', async () => {
  const r = await relay(), f = await forwarder({ entries: [entry], base: r.base, enabled: false });
  const g = await forwarder({ entries: [entry], base: r.base });
  try {
    assert.equal((await fetch(`${f.url}/r/1/${account.address}/key`)).status, 404, 'no registry');
    assert.equal((await fetch(`${g.url}/r/1/${account.address}`)).status, 404, 'GET on the sealed route');
    assert.equal((await fetch(`${g.url}/r/1/${account.address}/key`, { method: 'POST', body: 'x' })).status, 404, 'POST on the key route');
    assert.equal((await fetch(`${g.url}/r/1/0x123/key`)).status, 404, 'a short address');
    assert.equal((await fetch(`${g.url}/r/one/${account.address}/key`)).status, 404);
    assert.equal((await fetch(`${g.url}/f/k`, { method: 'POST', body: 'x' })).status, 404, '/f/ has no gateway k here');
    assert.equal((await fetch(`${g.url}/health`)).status, 200);
  } finally { r.close(); f.close(); g.close(); }
});
await check('a relay that is down is a 502, one that refuses is passed on as a 400 or 429/5xx, a key document that is not one is a 502, and an answer too large is refused', async () => {
  const mk = (request) => forwarder({ entries: [entry], base: 'http://127.0.0.1:1', request });
  const post = (f) => fetch(`${f.url}/r/1/${account.address}`, { method: 'POST', body: Buffer.alloc(100, 1) });
  const down = await mk(async () => { throw new Error('down'); });
  const refuses = await mk(async () => ({ status: 403, body: Buffer.from('no') }));
  const limited = await mk(async () => ({ status: 429, body: Buffer.from('slow') }));
  const broken = await mk(async () => ({ status: 500, body: Buffer.from('x') }));
  const junk = await mk(async () => ({ status: 200, body: Buffer.from('not json') }));
  const noDocs = await mk(async () => ({ status: 200, body: Buffer.from('{"nope":1}') }));
  try {
    assert.equal((await post(down)).status, 502);
    assert.equal((await post(refuses)).status, 400);
    assert.equal((await post(limited)).status, 429);
    assert.equal((await post(broken)).status, 500);
    assert.equal((await fetch(`${junk.url}/r/1/${account.address}/key`)).status, 502);
    assert.equal((await fetch(`${noDocs.url}/r/1/${account.address}/key`)).status, 502);
    assert.equal((await fetch(`${down.url}/r/1/${account.address}/key`)).status, 502);
  } finally { for (const x of [down, refuses, limited, broken, junk, noDocs]) x.close(); }
});
await check('a caller is limited as on the /f/ route, an oversize body is refused, and an entry with a url the forwarder will not call (http, a port, an address) is not carried', async () => {
  const slow = await forwarder({ entries: [entry], base: 'http://127.0.0.1:1', ratePerMin: 2, request: async () => ({ status: 200, body: Buffer.from('{"docs":[]}') }) });
  const bad = await forwarder({ entries: [
    { chainId: 1, relayer: account.address, url: 'http://relay.example/1/evm-pool/keeper' },
    { chainId: 2, relayer: account.address, url: 'https://relay.example:8443/1/evm-pool/keeper' },
    { chainId: 3, relayer: account.address, url: 'https://10.0.0.5/1/evm-pool/keeper' },
    { chainId: 4, relayer: account.address, url: 'https://localhost/1/evm-pool/keeper' },
    { chainId: 5, relayer: account.address, url: 'https://user:pw@relay.example/1/evm-pool/keeper' },
  ], base: 'http://127.0.0.1:1' });
  try {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await fetch(`${slow.url}/r/1/${account.address}/key`)).status);
    assert.ok(codes.includes(429) && codes[0] === 200, codes.join());
    assert.equal((await fetch(`${bad.url}/r/1/${account.address}`, { method: 'POST', body: Buffer.alloc(200_000) })).status, 404, 'a url it will not call is refused before the body is read');
    for (const chain of [1, 2, 3, 4, 5]) assert.equal((await fetch(`${bad.url}/r/${chain}/${account.address}/key`)).status, 404, `entry ${chain}`);
  } finally { slow.close(); bad.close(); }
});

console.log('the registry behind it');
const REG = (entries, next = entries.length) => encodeList(entries.map((e) => ({ relayer: e.relayer, stake: 1000n * 10n ** 18n, url: e.url })), next);
await check('the reader finds a relay by its address in any case, keeps the list a minute, and keeps it a while when the node fails', async () => {
  let t = 0, calls = 0, down = false;
  const fetchImpl = async () => { calls++; if (down) throw new Error('node down'); return { json: async () => ({ result: REG([entry]) }) }; };
  const reader = makeRegistryReader({ rpcUrl: 'https://node.test', fetchImpl, now: () => t });
  const hit = await reader.find(1, account.address.toUpperCase().replace('0X', '0x'));
  assert.equal(hit.url, RELAY_URL);
  const first = calls;
  await reader.find(1, account.address);
  assert.equal(calls, first, 'a second ask inside the minute is not a read');
  assert.equal(await reader.find(1, stranger.address), null);
  t = 61_000; down = true;
  assert.equal((await reader.find(1, account.address))?.url, RELAY_URL, 'the node failed: what was known stands');
  t = 61_000 + 601_000;
  assert.equal(await reader.find(1, account.address), null, 'after ten minutes of failure it is not');
});
await check('a node that answers with an error or with nothing is not a registry', async () => {
  const reader = makeRegistryReader({ rpcUrl: 'https://node.test', fetchImpl: async () => ({ json: async () => ({ error: { code: -32000 } }) }) });
  assert.equal(await reader.find(1, account.address), null);
  const reader2 = makeRegistryReader({ rpcUrl: 'https://node.test', fetchImpl: async () => ({ json: async () => ({ result: '0x' }) }) });
  assert.equal(await reader2.find(1, account.address), null);
});

console.log('what the forwarder will call');
await check('only public addresses: private, loopback, link-local, shared and reserved ranges, v6 equivalents and v4-mapped v6 are all refused', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2001:db8::1', 'nonsense', '', null]) assert.equal(isPublicAddress(ip), false, String(ip));
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip);
});
await check('a name is resolved once and refused unless every address is public; the connection goes to an address that was checked', async () => {
  const lookup = (answer) => guardedLookup((host, opts, cb) => cb(null, answer));
  const run = (l, opts = {}) => new Promise((resolve) => l('relay.example', opts, (e, a, f) => resolve({ e, a, f })));
  assert.equal((await run(lookup([{ address: '93.184.216.34', family: 4 }]))).a, '93.184.216.34');
  assert.equal((await run(lookup([{ address: '10.0.0.1', family: 4 }]))).e.code, 'EBLOCKED');
  assert.equal((await run(lookup([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]))).e.code, 'EBLOCKED', 'one private answer among public ones is enough to refuse');
  assert.equal((await run(lookup([]))).e.code, 'EBLOCKED');
  assert.ok((await run(guardedLookup((h, o, cb) => cb(new Error('nxdomain'))))).e);
  assert.equal((await run(lookup([{ address: '93.184.216.34', family: 4 }]), { all: true })).a.length, 1, 'all: true gets the list');
});
await check('only an https url on a public name with no port, no credentials: the origin a relay is called at', () => {
  assert.equal(relayOrigin('https://relay.example/1/evm-pool/keeper'), 'https://relay.example');
  assert.equal(relayOrigin('https://Relay.Example/x'), 'https://relay.example');
  for (const bad of ['http://relay.example/x', 'https://relay.example:8443/x', 'https://relay.example:443/x'.replace(':443', ':444'), 'https://u:p@relay.example/x', 'https://10.0.0.1/x', 'https://localhost/x', 'https://printer.local/x', 'https://nodot/x', 'https://1.2/x', 'ftp://relay.example/x', 'nonsense', '', null, undefined]) assert.equal(relayOrigin(bad), null, String(bad));
  assert.equal(publicName('a.b.example.com'), true);
  assert.equal(publicName('a.1'), false);
});
// a request as node would make it, answered by `reply`: { statusCode, headers, chunks } or an error
const fakeRequest = (reply) => (options, onResponse) => {
  const req = new EventEmitter();
  req.written = [];
  req.write = (b) => req.written.push(b);
  req.destroy = (e) => { req.destroyed = true; setImmediate(() => { if (e) req.emit('error', e); req.emit('close'); }); };
  req.end = () => setImmediate(() => {
    if (reply.error) return req.emit('error', reply.error);
    const res = new EventEmitter();
    res.statusCode = reply.statusCode ?? 200; res.headers = reply.headers ?? {}; res.resume = () => {};
    onResponse(res);
    for (const c of reply.chunks ?? []) res.emit('data', Buffer.from(c));
    res.emit('end');
  });
  req.options = options;
  return req;
};
await check('the request: https only, at the name and port 443 with the guarded lookup, a redirect is not followed, a large answer is cut off, a failure is an error', async () => {
  let seen = null;
  const make = (reply) => (o, cb) => { seen = o; return fakeRequest(reply)(o, cb); };
  const ok = await safeRequest('https://relay.example/sealed/key', { requestImpl: make({ chunks: ['{"docs"', ':[]}'] }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.toString(), '{"docs":[]}');
  assert.equal(seen.hostname, 'relay.example'); assert.equal(seen.port, 443); assert.equal(seen.protocol, 'https:'); assert.equal(typeof seen.lookup, 'function'); assert.equal(seen.agent, false);
  await assert.rejects(safeRequest('http://relay.example/x', { requestImpl: make({}) }), /public https/);
  await assert.rejects(safeRequest('https://10.0.0.1/x', { requestImpl: make({}) }), /public https/);
  await assert.rejects(safeRequest('https://relay.example/x', { requestImpl: make({ statusCode: 302, headers: { location: 'https://127.0.0.1/' } }) }), /redirect/);
  await assert.rejects(safeRequest('https://relay.example/x', { maxBytes: 10, requestImpl: make({ chunks: ['0123456789', 'abc'] }) }), /too large/);
  await assert.rejects(safeRequest('https://relay.example/x', { requestImpl: make({ error: new Error('ECONNRESET') }) }), /ECONNRESET/);
  const post = await safeRequest('https://relay.example/sealed', { method: 'POST', body: Buffer.from('abc'), headers: { 'content-type': 'application/octet-stream' }, requestImpl: make({ chunks: ['ok'] }) });
  assert.equal(post.status, 200);
  assert.equal(seen.method, 'POST'); assert.deepEqual(seen.headers, { 'content-type': 'application/octet-stream' });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
