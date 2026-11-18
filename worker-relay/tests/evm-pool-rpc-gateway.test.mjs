#!/usr/bin/env node
// The wallet-read gateway (src/evm-pool-rpc-gateway.js): sealed to its own key, reads only, public nodes, and nothing of the relay's. Run: node worker-relay/tests/evm-pool-rpc-gateway.test.mjs
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { makeSealedFetch, newGatewayKey, gatewayKeys } from '../../dapp/sealed-request.js';
import { makeRpcGateway, makeNodeRequest, nodesOf } from '../src/evm-pool-rpc-gateway.js';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

await check('node lists are validated', () => {
  assert.deepEqual([...nodesOf('{"1":["https://a.test","https://b.test"],"8453":["https://c.test"]}').keys()], [1, 8453]);
  assert.throws(() => nodesOf('nope'), /not JSON/);
  assert.throws(() => nodesOf('{"1":["http://plain.test"]}'), /https/);
  assert.throws(() => nodesOf('{"x":["https://a.test"]}'), /list of urls/);
  assert.throws(() => nodesOf('{"1":[]}'), /list of urls/);
});

await check('a node that fails is skipped, the one that answered goes first next time, and a node\'s own error is final', async () => {
  const hits = [];
  const fetchImpl = async (url, init) => {
    hits.push(url); const b = JSON.parse(init.body);
    if (url === 'https://down.test') throw new Error('refused');
    if (url === 'https://busy.test') return new Response('{}', { status: 429 });
    if (b.method === 'eth_call') return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: b.method === 'eth_getTransactionReceipt' ? undefined : '0x10' }));
  };
  const req = makeNodeRequest(['https://down.test', 'https://busy.test', 'https://ok.test'], { fetchImpl });
  assert.equal(await req('eth_getBalance', ['0xaa', 'latest']), '0x10');
  assert.deepEqual(hits, ['https://down.test', 'https://busy.test', 'https://ok.test']);
  hits.length = 0; await req('eth_blockNumber');
  assert.deepEqual(hits, ['https://ok.test'], 'starts at the node that answered');
  hits.length = 0;
  await assert.rejects(req('eth_call', [{}, 'latest']), (e) => e.code === 3 && /revert/.test(e.message));
  assert.deepEqual(hits, ['https://ok.test'], 'a revert is not asked of another node');
  assert.equal(await req('eth_getTransactionReceipt', ['0x1']), null, 'no result is null');
  await assert.rejects(makeNodeRequest(['https://down.test'], { fetchImpl })('eth_blockNumber'), /refused/);
});

// a gateway of its own, and a sealed fetch to it through a forwarder stand-in
const secret = newGatewayKey(), keys = gatewayKeys(secret), PUB = Buffer.from(keys.pub).toString('hex');
const nodeHits = [];
const gw = makeRpcGateway({
  secret, nodes: nodesOf('{"1":["https://eth.test"],"8453":["https://base.test"]}'), forwarders: ['198.51.100.7'],
  fetchImpl: async (url, init) => { const b = JSON.parse(init.body); nodeHits.push([url, b.method, JSON.stringify(b.params)]); return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: url.includes('base') ? '0xba5e' : '0x10' })); },
});
const viaForwarder = async (url, init) => {
  const bytes = Buffer.from(init.body);
  const req = Readable.from([bytes]); req.method = 'POST'; req.url = '/sealed'; req.headers = { 'content-length': String(bytes.length), 'x-forwarded-for': '198.51.100.7' }; req.socket = { remoteAddress: '198.51.100.7' };
  return new Promise((resolve) => {
    const chunks = []; let status = 200;
    const res = { headersSent: false, setHeader() {}, writeHead(c) { status = c; }, write(d) { chunks.push(Buffer.from(d)); }, end(d) { if (d) chunks.push(Buffer.from(d)); resolve(new Response(Buffer.concat(chunks), { status })); } };
    gw.handler(req, res);
  });
};
const GW = 'https://rpc.test';
const sealed = (gateway = PUB) => makeSealedFetch({ keeper: GW, chainId: 'r', gateway, forwarders: ['https://f1.test'], fetchImpl: (u, i) => viaForwarder(u, i) });
const rpcCall = async (f, chain, body) => { const r = await f(`${GW}/${chain}/evm-pool/keeper/rpc`, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

await check('a wallet read goes through the sealed route to the public node of its chain', async () => {
  const f = await sealed();
  const r = await rpcCall(f, 1, { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: ['0x' + 'aa'.repeat(20), 'latest'] });
  assert.deepEqual(r, { status: 200, body: { jsonrpc: '2.0', id: 1, result: '0x10' } });
  assert.equal((await rpcCall(f, 8453, { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] })).body.result, '0xba5e', 'the other chain reads its own node');
  assert.deepEqual(nodeHits.map((h) => h[0]), ['https://eth.test', 'https://base.test']);
});

await check('a day of logs is carried here (the nodes are public), and a node that refuses a range does not end the read', async () => {
  const seenUrls = [];
  const g = makeRpcGateway({ secret, nodes: nodesOf('{"1":["https://narrow.test","https://wide.test"]}'), forwarders: ['198.51.100.7'],
    fetchImpl: async (url, init) => { seenUrls.push(url); const b = JSON.parse(init.body); if (b.method === 'eth_blockNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: '0x100000' })); return url.includes('narrow') ? new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, error: { code: -32005, message: 'range too large' } })) : new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: [] })); } });
  const via = async (url, init) => { const bytes = Buffer.from(init.body); const req = Readable.from([bytes]); req.method = 'POST'; req.url = '/sealed'; req.headers = { 'content-length': String(bytes.length) }; req.socket = { remoteAddress: '198.51.100.7' };
    return new Promise((resolve) => { const chunks = []; g.handler(req, { headersSent: false, setHeader() {}, writeHead() {}, write(d) { chunks.push(Buffer.from(d)); }, end(d) { if (d) chunks.push(Buffer.from(d)); resolve(new Response(Buffer.concat(chunks), { status: 200 })); } }); }); };
  const f = await makeSealedFetch({ keeper: GW, chainId: 'r', gateway: Buffer.from(gatewayKeys(secret).pub).toString('hex'), forwarders: ['https://f1.test'], fetchImpl: via });
  const head = 0x100000, hex = (x) => '0x' + x.toString(16);
  const day = await f(`${GW}/1/evm-pool/keeper/rpc`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: '0x' + 'aa'.repeat(20), topics: [], fromBlock: hex(head - 7200), toBlock: 'latest' }] }) });
  assert.equal(day.status, 200); assert.deepEqual((await day.json()).result, [], 'the second node answered');
  assert.ok(seenUrls.includes('https://narrow.test') && seenUrls.includes('https://wide.test'));
  const wide = await f(`${GW}/1/evm-pool/keeper/rpc`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_getLogs', params: [{ fromBlock: hex(1), toBlock: 'latest' }] }) });
  assert.equal(wide.status, 403, 'but not the whole chain');
});

await check('only reads are carried, and only for a chain it has', async () => {
  const f = await sealed(); nodeHits.length = 0;
  assert.equal((await rpcCall(f, 1, { jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x00'] })).status, 403);
  assert.equal((await rpcCall(f, 999, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })).status, 404, 'a chain it has no node for');
  assert.deepEqual(nodeHits, [], 'nothing reached a node');
});

await check('a bundler call goes to the fixed bundler of its chain, only its own methods, and no other host', async () => {
  const f = await sealed(); nodeHits.length = 0;
  const send = (name, chain, body) => f(`${GW}/${chain}/evm-pool/keeper/bundler-${name}`, { method: 'POST', body: JSON.stringify(body) });
  const r = await send('pimlico', 1, { jsonrpc: '2.0', id: 1, method: 'eth_sendUserOperation', params: [{ sender: '0x' + '11'.repeat(20) }, '0x' + '22'.repeat(20)] });
  assert.equal(r.status, 200);
  const c = await send('candide', 1, { jsonrpc: '2.0', id: 2, method: 'eth_getUserOperationReceipt', params: ['0x01'] });
  assert.equal(c.status, 200);
  assert.deepEqual(nodeHits.map((h) => h[0]), ['https://public.pimlico.io/v2/1/rpc', 'https://api.candide.dev/public/v3/1']);
  assert.equal((await send('pimlico', 1, { jsonrpc: '2.0', id: 3, method: 'eth_sendRawTransaction', params: ['0x00'] })).status, 403, 'not a bundler method');
  assert.equal((await send('pimlico', 999, { jsonrpc: '2.0', id: 4, method: 'eth_chainId', params: [] })).status, 404, 'a chain it has no node for');
  assert.equal((await f(`${GW}/1/evm-pool/keeper/bundler-evil`, { method: 'POST', body: '{}' })).status, 403, 'no other bundler name is carried');
  assert.equal(nodeHits.length, 2, 'only the two good calls went out');
});

await check('many callers behind one forwarder do not share one allowance: 25 envelopes of 32 calls (800 calls, over one caller\'s burst) all get through', async () => {
  const f = await sealed(); nodeHits.length = 0;
  const batch = Array.from({ length: 32 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_getBalance', params: ['0x' + 'aa'.repeat(20), 'latest'] }));
  const statuses = [];
  for (let k = 0; k < 25; k++) statuses.push((await rpcCall(f, 1, batch)).status);
  assert.deepEqual([...new Set(statuses)], [200], `statuses: ${statuses.join(',')}`);
});

await check('a request sealed to the relay\'s key, or any other, is not opened here, and the gateway key is public', async () => {
  const other = gatewayKeys(newGatewayKey());
  const f = await sealed(Buffer.from(other.pub).toString('hex'));
  await assert.rejects(rpcCall(f, 1, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }));
  const keyRes = await new Promise((resolve) => { const req = Readable.from([]); req.method = 'GET'; req.url = '/sealed/key'; req.headers = {}; req.socket = { remoteAddress: '203.0.113.5' }; const chunks = []; gw.handler(req, { headersSent: false, setHeader() {}, writeHead() {}, write(d) { chunks.push(d); }, end(d) { if (d) chunks.push(d); resolve(JSON.parse(Buffer.concat(chunks.map(Buffer.from)))); } }); });
  assert.equal(keyRes.key, PUB);
});

await check('the image\'s files start the gateway', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const out = mkdtempSync(join(tmpdir(), 'rpc-gw-image-'));
  const files = ['dapp/package.json', 'dapp/sealed-request.js', 'dapp/relay-gateway-doc.js', 'dapp/vendor/tacit-deps.min.js', 'worker-relay/package.json', 'worker-relay/src/evm-pool-rpc-gateway.js',
    'worker-relay/src/lib/evm-pool-keeper-sealed.js', 'worker-relay/src/lib/evm-pool-keeper-rpc.js', 'worker-relay/src/lib/token-bucket.js', 'worker-relay/src/lib/safe-err.js'];
  const docker = (await import('node:fs')).readFileSync(join(root, 'worker-relay/Dockerfile.evm-pool-rpc-gateway'), 'utf8');
  for (const f of files) { mkdirSync(dirname(join(out, f)), { recursive: true }); copyFileSync(join(root, f), join(out, f)); assert.ok(docker.includes(f.split('/').pop()), `the Dockerfile copies ${f}`); }
  const m = await import(pathToFileURL(join(out, 'worker-relay/src/evm-pool-rpc-gateway.js')).href);
  assert.equal(typeof m.makeRpcGateway, 'function');
});

console.log(`\n${n} checks passed`);
