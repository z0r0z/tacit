#!/usr/bin/env node
// What the keeper counts a request against behind a forwarder (makeServiceGateway `isolate`): an envelope from a listed forwarder under an address of its own, so the
// people behind one forwarder do not share one allowance; any other sender under its own address. Run: node worker-relay/tests/keeper-isolate.test.mjs
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { makeSealedFetch, newGatewayKey, gatewayKeys } from '../../dapp/sealed-request.js';
import { makeServiceGateway } from '../src/lib/evm-pool-keeper-sealed.js';
import { clientKey } from '../src/lib/token-bucket.js';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const secret = newGatewayKey(), PUB = Buffer.from(gatewayKeys(secret).pub).toString('hex');
const GW = 'https://k.test';

function rig({ isolate, listed }) {
  const keys = [];
  const serve = (req, res) => { keys.push(clientKey(req)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); };
  const json = (res, c, b) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  const take = makeServiceGateway({ secret, serve, json, forwarders: listed, isolate });
  const via = (from) => async (url, init) => {
    const bytes = Buffer.from(init.body);
    const req = Readable.from([bytes]); req.method = 'POST'; req.url = '/sealed'; req.headers = { 'content-length': String(bytes.length), 'x-forwarded-for': from }; req.socket = { remoteAddress: from };
    return new Promise((resolve) => { const chunks = []; take(req, { headersSent: false, setHeader() {}, writeHead() {}, write(d) { chunks.push(Buffer.from(d)); }, end(d) { if (d) chunks.push(Buffer.from(d)); resolve(new Response(Buffer.concat(chunks), { status: 200 })); } }); });
  };
  const ask = async (from, k = 3) => { const f = await makeSealedFetch({ keeper: GW, chainId: 'k', gateway: PUB, forwarders: ['https://f.test'], fetchImpl: via(from), batchMs: 0 }); for (let i = 0; i < k; i++) await f(`${GW}/1/evm-pool/keeper/head?n=${i}`); };
  return { keys, ask };
}

await check('behind a listed forwarder each envelope is counted under an address of its own', async () => {
  const r = rig({ isolate: true, listed: ['198.51.100.7'] });
  await r.ask('198.51.100.7', 5);
  assert.equal(r.keys.length, 5);
  assert.equal(new Set(r.keys).size, 5, 'five envelopes, five different keys');
  assert.ok(r.keys.every((k) => k !== '198.51.100.7'), 'none is the forwarder\'s own address');
});

await check('a sender that is not a listed forwarder keeps its own address', async () => {
  const r = rig({ isolate: true, listed: ['198.51.100.7'] });
  await r.ask('203.0.113.9', 3);
  assert.deepEqual([...new Set(r.keys)], ['203.0.113.9']);
});

await check('with isolate off nothing changes: the forwarder\'s address is what is counted', async () => {
  const r = rig({ isolate: false, listed: ['198.51.100.7'] });
  await r.ask('198.51.100.7', 3);
  assert.deepEqual([...new Set(r.keys)], ['198.51.100.7']);
});

console.log(`\n${n} checks passed`);
