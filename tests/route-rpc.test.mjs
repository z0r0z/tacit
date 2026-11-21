#!/usr/bin/env node
// The wallet's chain reads over the private route: the page's JSON-RPC reader (dapp/json-rpc.js) with private-route.js's rpcFetch, a real gateway and the keeper's
// passthrough. A read goes to the keeper through a forwarder; only a read the route cannot carry goes to the node the reader named.
//   node tests/route-rpc.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { newGatewayKey, gatewayKeys } from '../dapp/sealed-request.js';
import { jsonRpc } from '../dapp/json-rpc.js';
import { makeServiceGateway } from '../worker-relay/src/lib/evm-pool-keeper-sealed.js';
import { makeRpcPassthrough } from '../worker-relay/src/lib/evm-pool-keeper-rpc.js';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

// private-route.js as a page loads it, its one absolute import pointed at the file
const sealedUrl = pathToFileURL(new URL('../dapp/sealed-request.js', import.meta.url).pathname).href;
const source = readFileSync(new URL('../dapp/private-route.js', import.meta.url), 'utf8').replace(/\/sealed-request\.js\?cb=[A-Za-z0-9_-]+/, sealedUrl)
  .replace(/(from\s*)'\.\/([\w./-]+\.js)'/g, (m, f, p) => `${f}'${pathToFileURL(new URL(`../dapp/${p}`, import.meta.url).pathname).href}'`);      // (its relative imports, ./evm-pool-relays.js and any later one, are dapp/'s)
const dir = mkdtempSync(join(tmpdir(), 'route-rpc-'));
writeFileSync(join(dir, 'private-route.mjs'), source);
const { ROUTE, rpcFetch } = await import(pathToFileURL(join(dir, 'private-route.mjs')).href);

const secret = newGatewayKey(), keys = gatewayKeys(secret), PUB = Buffer.from(keys.pub).toString('hex');
const KEEPER = 'https://keepers.test', BASE = `${KEEPER}/1/evm-pool/keeper`, NODE = 'https://node.test/v2/KEY';
Object.assign(ROUTE, { gateway: PUB, forwarders: ['https://f1.test'], keeper: KEEPER, nostr: [] });

const seen = { keeper: [], node: 0, envelopes: 0 };
const pass = makeRpcPassthrough({
  request: async (method, params) => {
    seen.keeper.push(method);
    if (method === 'eth_call' && params[0]?.data === '0xdead') throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x08c379a0' });
    return method === 'eth_getBalance' ? '0x10' : '0x1000';
  }, chainId: 1,
});
const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
const serve = async (req, res) => {
  if (req.url === '/1/evm-pool/keeper/rpc') {
    const out = await pass.handle(JSON.parse(String(await readBody(req))), 'fwd');
    res.writeHead(out.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify(out.body));
  }
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
};
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const take = makeServiceGateway({ secret, serve, json, forwarders: ['198.51.100.7'] });

let forwarderUp = true;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://f1.test/f/k')) {
    if (!forwarderUp) throw new Error('connection refused');
    seen.envelopes++;
    const bytes = Buffer.from(init.body);
    const req = Readable.from([bytes]); req.method = 'POST'; req.url = '/sealed'; req.headers = { 'content-length': String(bytes.length) }; req.socket = { remoteAddress: '198.51.100.7' };
    return new Promise((resolve) => {
      const chunks = []; let status = 200;
      const res = { headersSent: false, setHeader() {}, writeHead(c) { status = c; }, write(d) { chunks.push(Buffer.from(d)); }, end(d) { if (d) chunks.push(Buffer.from(d)); resolve(new Response(Buffer.concat(chunks), { status })); } };
      take(req, res);
    });
  }
  if (u.startsWith('https://node.test') || u.startsWith('http://127.0.0.1')) {
    seen.node++;
    const b = JSON.parse(init.body); const one = (c) => ({ jsonrpc: '2.0', id: c.id, result: '0xd1' });
    return new Response(JSON.stringify(Array.isArray(b) ? b.map(one) : one(b)), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`unexpected fetch ${u}`);
};

let clock = 1e12;
const reader = (urls = [NODE]) => jsonRpc(urls, rpcFetch(BASE, { now: () => clock }));
const reset = () => { seen.keeper.length = 0; seen.node = 0; seen.envelopes = 0; clock += 120_000; };

await check('a read goes to the keeper through a forwarder, and the node the reader named is not asked', async () => {
  reset();
  assert.equal(await reader()('eth_getBalance', ['0x' + 'aa'.repeat(20), 'latest']), '0x10');
  assert.deepEqual(seen.keeper, ['eth_getBalance']);
  assert.equal(seen.node, 0, 'the public node saw nothing');
  assert.equal(seen.envelopes, 1);
});

await check('a burst of reads shares envelopes', async () => {
  reset(); const r = reader();
  const out = await Promise.all(Array.from({ length: 14 }, (_, i) => r('eth_getBalance', ['0x' + String(i).padStart(40, '0'), 'latest'])));
  assert.ok(out.every((x) => x === '0x10'));
  assert.ok(seen.envelopes <= 3, `${seen.envelopes} envelopes for 14 reads`);
  assert.equal(seen.node, 0);
});

await check('a read the keeper does not carry goes to the node, and the next one still goes by the route', async () => {
  reset(); const r = reader();
  assert.equal(await r('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0xfffff' }]), '0xd1', 'too wide: asked of the node');
  assert.equal(seen.node, 1);
  assert.equal(await r('eth_getBalance', ['0xaa', 'latest']), '0x10');
  assert.equal(seen.node, 1, 'the route was not given up on');
});

await check('a revert from the keeper is the answer, not a reason to ask the node', async () => {
  reset();
  await assert.rejects(reader()('eth_call', [{ to: '0xaa', data: '0xdead' }, 'latest']), /revert/i);
  assert.equal(seen.node, 0);
});

await check('when the route is down the read goes to the node, and the route is left alone for a minute', async () => {
  reset(); forwarderUp = false; const r = reader();
  assert.equal(await r('eth_getBalance', ['0xaa', 'latest']), '0xd1', 'the node answered');
  const tried = seen.envelopes;
  for (let i = 0; i < 5; i++) await r('eth_getBalance', ['0xaa', 'latest']);
  assert.equal(seen.envelopes, tried, 'no further attempts on the route');
  assert.equal(seen.node, 6);
  forwarderUp = true; clock += 61_000;
  assert.equal(await r('eth_getBalance', ['0xaa', 'latest']), '0x10', 'and after the minute it is tried again');
});

await check('a node of the reader\'s own (this machine) is asked directly, not through the route', async () => {
  reset();
  assert.equal(await reader(['http://127.0.0.1:8545'])('eth_getBalance', ['0xaa', 'latest']), '0xd1');
  assert.equal(seen.envelopes, 0); assert.equal(seen.keeper.length, 0);
});

await check('with no keeper to ask, or the route off, the reader is as it was', async () => {
  reset();
  assert.equal(await jsonRpc([NODE], rpcFetch(null, { now: () => clock }))('eth_getBalance', ['0xaa', 'latest']), '0xd1');
  assert.equal(seen.envelopes, 0);
});

globalThis.fetch = realFetch;
console.log(`\n${n} checks passed`);
