#!/usr/bin/env node
// A wallet's own reads over the private route (private-route.js walletRpcFetch): they go to a gateway of their own, the relay's reads go to the relay's, and neither
// service sees the other's. A gateway that fails is left alone for that reader only. Run: node tests/route-wallet-rpc.test.mjs
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
import { makeRpcGateway, nodesOf } from '../worker-relay/src/evm-pool-rpc-gateway.js';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const sealedUrl = pathToFileURL(new URL('../dapp/sealed-request.js', import.meta.url).pathname).href;
const source = readFileSync(new URL('../dapp/private-route.js', import.meta.url), 'utf8').replace(/\/sealed-request\.js\?cb=[A-Za-z0-9_-]+/, sealedUrl);
const dir = mkdtempSync(join(tmpdir(), 'route-wallet-rpc-'));
writeFileSync(join(dir, 'private-route.mjs'), source);
const { ROUTE, rpcFetch, walletRpcFetch, bundlerFetch } = await import(pathToFileURL(join(dir, 'private-route.mjs')).href);

// two gateways, two keys: the relay's and the wallet-read one
const relayKey = newGatewayKey(), rpcKey = newGatewayKey();
const PUB_RELAY = Buffer.from(gatewayKeys(relayKey).pub).toString('hex'), PUB_RPC = Buffer.from(gatewayKeys(rpcKey).pub).toString('hex');
const KEEPER = 'https://keepers.test', RPCGW = 'https://rpc.test', BASE = `${KEEPER}/1/evm-pool/keeper`, NODE = 'https://node.test/v2/KEY';
Object.assign(ROUTE, { gateway: PUB_RELAY, forwarders: ['https://f1.test'], keeper: KEEPER, nostr: [], rpc: { url: RPCGW, id: 'r', gateway: PUB_RPC } });

const seen = { relayCalls: [], walletCalls: [], node: 0, envelopes: { k: 0, r: 0 } };
const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
const relayPass = makeRpcPassthrough({ request: async (m) => { seen.relayCalls.push(m); return '0x1000'; }, chainId: 1 });
const relayServe = async (req, res) => { const out = await relayPass.handle(JSON.parse(String(await readBody(req))), 'fwd'); res.writeHead(out.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.body)); };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const relayTake = makeServiceGateway({ secret: relayKey, serve: relayServe, json, forwarders: ['198.51.100.7'] });
const walletGw = makeRpcGateway({ secret: rpcKey, nodes: nodesOf('{"1":["https://upstream.test"]}'), forwarders: ['198.51.100.7'],
  fetchImpl: async (url, init) => { const b = JSON.parse(init.body); seen.walletCalls.push(b.method); if (seen.throttled) return new Response('{"error":"rate limited"}', { status: 429 }); return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: b.method === 'eth_getBalance' ? '0x10' : '0x1000' })); } });

let walletUp = true, relayUp = true;
const synth = (init, run) => {
  const bytes = Buffer.from(init.body);
  const req = Readable.from([bytes]); req.method = 'POST'; req.url = '/sealed'; req.headers = { 'content-length': String(bytes.length), 'x-forwarded-for': '198.51.100.7' }; req.socket = { remoteAddress: '198.51.100.7' };
  return new Promise((resolve) => {
    const chunks = []; let status = 200;
    run(req, { headersSent: false, setHeader() {}, writeHead(c) { status = c; }, write(d) { chunks.push(Buffer.from(d)); }, end(d) { if (d) chunks.push(Buffer.from(d)); resolve(new Response(Buffer.concat(chunks), { status })); } });
  });
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === 'https://f1.test/f/k') { if (!relayUp) throw new Error('connection refused'); seen.envelopes.k++; return synth(init, (rq, rs) => relayTake(rq, rs)); }
  if (u === 'https://f1.test/f/r') { if (!walletUp) throw new Error('connection refused'); seen.envelopes.r++; return synth(init, (rq, rs) => walletGw.handler(rq, rs)); }
  if (u.startsWith('https://node.test')) { seen.node++; const b = JSON.parse(init.body); const one = (c) => ({ jsonrpc: '2.0', id: c.id, result: '0xd1' }); return new Response(JSON.stringify(Array.isArray(b) ? b.map(one) : one(b))); }
  throw new Error(`unexpected fetch ${u}`);
};
let clock = 1e12;
const wallet = () => jsonRpc([NODE], walletRpcFetch(1, { now: () => clock }));
const relay = () => jsonRpc([NODE], rpcFetch(BASE, { now: () => clock }));
const reset = () => { for (const k of ['relayCalls', 'walletCalls']) seen[k].length = 0; seen.node = 0; seen.envelopes = { k: 0, r: 0 }; clock += 120_000; };

await check('a wallet read goes to the wallet-read gateway, and the relay never sees it', async () => {
  reset();
  assert.equal(await wallet()('eth_getBalance', ['0xdc5c6e6a8e218a79f16f2336a870729937baa8cf', 'latest']), '0x10');
  assert.deepEqual(seen.walletCalls, ['eth_getBalance']);
  assert.deepEqual(seen.relayCalls, [], 'the relay saw nothing');
  assert.equal(seen.envelopes.r, 1); assert.equal(seen.envelopes.k, 0); assert.equal(seen.node, 0, 'and no public node was asked');
});

await check('a relay read goes to the relay, and the wallet-read gateway never sees it', async () => {
  reset();
  assert.equal(await relay()('eth_blockNumber'), '0x1000');
  assert.deepEqual(seen.relayCalls, ['eth_blockNumber']); assert.deepEqual(seen.walletCalls, []);
  assert.equal(seen.envelopes.k, 1); assert.equal(seen.envelopes.r, 0);
});

await check('a burst of wallet reads shares envelopes', async () => {
  reset(); const r = wallet();
  const out = await Promise.all(Array.from({ length: 12 }, (_, i) => r('eth_getBalance', ['0x' + String(i).padStart(40, '0'), 'latest'])));
  assert.ok(out.every((x) => x === '0x10'));
  assert.ok(seen.envelopes.r <= 3, `${seen.envelopes.r} envelopes for 12 reads`);
});

await check('what the wallet-read gateway does not carry goes to the named node, one call only', async () => {
  reset(); const r = wallet();
  assert.equal(await r('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0xfffff' }]), '0xd1');
  assert.equal(seen.node, 1);
  assert.equal(await r('eth_getBalance', ['0xaa', 'latest']), '0x10'); assert.equal(seen.node, 1, 'the road was not given up on');
});

await check('a failing wallet-read gateway is left alone for a minute, and the relay\'s reads are not held up by it', async () => {
  reset(); walletUp = false; const w = wallet(), k = relay();
  assert.equal(await w('eth_getBalance', ['0xaa', 'latest']), '0xd1', 'the node answered');
  const tried = seen.envelopes.r;
  for (let i = 0; i < 4; i++) await w('eth_getBalance', ['0xaa', 'latest']);
  assert.equal(seen.envelopes.r, tried, 'not tried again within the minute');
  assert.equal(await k('eth_blockNumber'), '0x1000', 'the relay road still works');
  assert.equal(seen.envelopes.k, 1);
  walletUp = true; clock += 61_000;
  assert.equal(await w('eth_getBalance', ['0xaa', 'latest']), '0x10', 'and it is tried again after the minute');
});

await check('with no wallet-read gateway named, the reader is as it was', async () => {
  reset(); const saved = ROUTE.rpc; ROUTE.rpc = null;
  assert.equal(await jsonRpc([NODE], walletRpcFetch(1, { now: () => clock }))('eth_getBalance', ['0xaa', 'latest']), '0xd1');
  assert.equal(seen.envelopes.r, 0); ROUTE.rpc = saved;
});

await check('a fixed pool\'s bundler call goes to the wallet-read gateway, and straight to the bundler only when the road fails', async () => {
  reset(); const direct = [];
  const bf = bundlerFetch({ now: () => clock, fetchImpl: async (u) => { direct.push(String(u)); return new Response('{"jsonrpc":"2.0","id":1,"result":"0xdirect"}'); } });
  const PIM = 'https://public.pimlico.io/v2/1/rpc', body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendUserOperation', params: [{}, '0x' + '22'.repeat(20)] });
  const r = await bf(PIM, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(r.status, 200);
  assert.deepEqual(seen.walletCalls, ['eth_sendUserOperation']); assert.equal(seen.envelopes.r, 1); assert.deepEqual(direct, [], 'nothing went to the bundler directly');
  assert.deepEqual(seen.relayCalls, [], 'and the relay saw nothing');
  await bf('https://example.test/v2/1/rpc', { method: 'POST', body });
  assert.deepEqual(direct, ['https://example.test/v2/1/rpc'], 'a url that is not a known bundler is not carried');
  walletUp = false; direct.length = 0;
  assert.equal((await (await bf('https://api.candide.dev/public/v3/1', { method: 'POST', body })).json()).result, '0xdirect');
  assert.deepEqual(direct, ['https://api.candide.dev/public/v3/1'], 'a road that fails sends it straight, as before');
  const before = seen.envelopes.r;
  await bf(PIM, { method: 'POST', body });
  assert.equal(seen.envelopes.r, before, 'the road is left alone for a minute'); walletUp = true;
});

await check('a bundler that throttles the gateway (429) is a road that failed: the call goes straight to the bundler, and the road is left alone for a minute', async () => {
  reset(); const direct = []; seen.throttled = true;
  const bf = bundlerFetch({ now: () => clock, fetchImpl: async (u) => { direct.push(String(u)); return new Response('{"jsonrpc":"2.0","id":1,"result":"0xdirect"}'); } });
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_estimateUserOperationGas', params: [{}, '0x' + '22'.repeat(20)] });
  const r = await bf('https://public.pimlico.io/v2/1/rpc', { method: 'POST', body });
  assert.equal((await r.json()).result, '0xdirect'); assert.deepEqual(direct, ['https://public.pimlico.io/v2/1/rpc']);
  const before = seen.envelopes.r;
  await bf('https://public.pimlico.io/v2/1/rpc', { method: 'POST', body });
  assert.equal(seen.envelopes.r, before, 'not tried again for a minute'); seen.throttled = false;
});

globalThis.fetch = realFetch;
console.log(`\n${n} checks passed`);
