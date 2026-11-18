// A gateway for a wallet's own chain reads on the private route (docs/EVM-POOL.md). The pool relay (the keepers) answers the reads of a wallet's private
// side; this answers the reads of its public side (the connected account's balance, the simulation of a deposit, the receipt of a transaction, a name the wallet
// looks up), and it is a different service with a different key, so the relay never sees the wallet's reads and this never sees a box's. A forwarder carries the
// sealed request to it as it does to the relay (id "r"); it answers from public nodes.
//
// RPC_GATEWAY_KEY    the gateway key: 32 bytes of hex (node worker-relay/src/sealed-keygen.js); the public half is what a page pins
// RPC_GATEWAY_NODES  JSON, { "<chainId>": ["<node url>", …] }: the public nodes it reads from, tried in order, the one that answered last first
// RPC_GATEWAY_FORWARDERS  addresses of the forwarders that carry many callers (they may send ten times as much)
// PORT               default 10000
//   POST /sealed             a sealed request: the calls inside are POST /<chainId>/evm-pool/keeper/rpc, a JSON-RPC call or batch (evm-pool-keeper-rpc.js)
//   GET  /sealed/key         the gateway key
//   GET  /health
import { createServer } from 'node:http';
import { makeServiceGateway } from './lib/evm-pool-keeper-sealed.js';
import { makeRpcPassthrough, MAX_BODY } from './lib/evm-pool-keeper-rpc.js';

// The public nodes this reads from have limits of their own, so a log read may span more here than on a relay's paid node: a day of a busy token is about 7,200 blocks.
const MAX_LOG_RANGE = 20_000;

// The ERC-4337 bundlers a wallet sends a fixed pool's gasless withdrawal to (dapp/fixed-pool-paymaster.js bundlersOf): sent from here, the bundler sees this service, not the person.
// The hosts are fixed (this is not a proxy to any url) and only the bundler's own methods are carried.
export const BUNDLERS = Object.freeze({
  pimlico: (chainId) => `https://public.pimlico.io/v2/${chainId}/rpc`,
  candide: (chainId) => `https://api.candide.dev/public/v3/${chainId}`,
});
export const BUNDLER_METHODS = new Set(['eth_sendUserOperation', 'eth_estimateUserOperationGas', 'eth_getUserOperationByHash', 'eth_getUserOperationReceipt', 'pimlico_getUserOperationGasPrice', 'eth_supportedEntryPoints', 'eth_chainId']);
const CARRIED = [['POST', /^\/(rpc|bundler-pimlico|bundler-candide)$/]];
const MAX_BUNDLER_REPLY = 256 * 1024;

const log = (...a) => console.log(`[evm-pool-rpc-gateway ${new Date().toISOString()}]`, ...a);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' };
const JSON_TYPE = { 'Content-Type': 'application/json', ...CORS };

export function nodesOf(raw) {
  let n;
  try { n = JSON.parse(raw); } catch { throw new Error('RPC_GATEWAY_NODES is not JSON'); }
  if (!n || typeof n !== 'object' || Array.isArray(n)) throw new Error('RPC_GATEWAY_NODES is an object of chain id → node urls');
  const out = new Map();
  for (const [id, urls] of Object.entries(n)) {
    if (!/^\d{1,10}$/.test(id) || !Array.isArray(urls) || !urls.length) throw new Error(`RPC_GATEWAY_NODES: "${id}" needs a list of urls`);
    for (const u of urls) if (new URL(u).protocol !== 'https:') throw new Error(`RPC_GATEWAY_NODES: ${id}: a node must be https`);
    out.set(Number(id), urls.slice());
  }
  return out;
}

// A JSON-RPC request over a list of nodes: each is tried in turn, starting at the one that answered last, and a node's own error (a revert, a bad parameter) is
// the answer, not a reason to ask the next (a log read is the exception: the nodes differ in the range they take). → request(method, params)
export function makeNodeRequest(urls, { fetchImpl = globalThis.fetch.bind(globalThis), timeoutMs = 8000 } = {}) {
  let first = 0, id = 0;
  return async (method, params = []) => {
    let last = new Error('no node answered');
    for (let k = 0; k < urls.length; k++) {
      const at = (first + k) % urls.length;
      try {
        const r = await fetchImpl(urls[at], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) { last = new Error(`HTTP ${r.status}`); continue; }
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(j.error.message || 'rpc error'), { code: j.error.code, data: j.error.data, rpc: method !== 'eth_getLogs' });   // a log range one node refuses is another's to answer
        first = at;
        return j.result === undefined ? null : j.result;
      } catch (e) {
        if (e.rpc) throw e;
        last = e;
      }
    }
    throw last;
  };
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const c = []; let size = 0;
    req.on('data', (d) => { size += d.length; if (size <= max) c.push(d); });
    req.on('end', () => (size > max ? reject(new Error('too large')) : resolve(Buffer.concat(c))));
    req.on('error', reject);
  });
}

export function makeRpcGateway({ secret, nodes, forwarders = [], fetchImpl, ratePerMin = 20 }) {
  const passes = new Map();
  const passFor = (chainId) => {
    if (!nodes.has(chainId)) return null;
    if (!passes.has(chainId)) passes.set(chainId, makeRpcPassthrough({ request: makeNodeRequest(nodes.get(chainId), { fetchImpl }), chainId, maxLogRange: MAX_LOG_RANGE }));
    return passes.get(chainId);
  };
  const json = (res, code, body) => { res.writeHead(code, JSON_TYPE); res.end(JSON.stringify(body)); };
  // what a request that came through the sealed route reaches: /<chainId>/evm-pool/keeper/rpc (the path shape the gateway carries), nothing else
  const serve = async (req, res) => {
    const url = (req.url || '').split('?')[0];
    const b = /^\/(\d{1,10})\/evm-pool\/keeper\/bundler-(pimlico|candide)$/.exec(url);
    if (b && req.method === 'POST') {
      if (!nodes.has(Number(b[1]))) return json(res, 404, { error: 'no such chain' });
      let call;
      try { call = JSON.parse(String(await readBody(req, MAX_BODY))); } catch { return json(res, 400, { error: 'not JSON' }); }
      if (!call || typeof call !== 'object' || Array.isArray(call) || !BUNDLER_METHODS.has(call.method)) return json(res, 403, { error: 'that call is not carried' });
      let up;
      try { up = await (fetchImpl || globalThis.fetch)(BUNDLERS[b[2]](Number(b[1])), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(call), signal: AbortSignal.timeout(20_000) }); } catch { return json(res, 502, { error: 'the bundler could not be reached' }); }
      const text = (await up.text()).slice(0, MAX_BUNDLER_REPLY);
      res.writeHead(up.status, JSON_TYPE); return res.end(text);
    }
    const m = /^\/(\d{1,10})\/evm-pool\/keeper\/rpc$/.exec(url);
    if (!m || req.method !== 'POST') return json(res, 404, { error: 'not found' });
    const pass = passFor(Number(m[1]));
    if (!pass) return json(res, 404, { error: 'no such chain' });
    let body;
    try { body = JSON.parse(String(await readBody(req, MAX_BODY))); } catch { return json(res, 400, { error: 'not JSON' }); }
    const out = await pass.handle(body, req.headers['x-forwarded-for'] || 'sender');
    return json(res, out.status, out.body);
  };
  const take = makeServiceGateway({ secret, serve, json, forwarders, ratePerMin, log, carried: CARRIED });
  return {
    key: take.key,
    handler: (req, res) => {
      const path = (req.url || '').split('?')[0];
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
      if (path === '/health') return json(res, 200, { ok: true });
      if (path === '/sealed/key' && req.method === 'GET') return json(res, 200, { kid: take.key.kid, key: take.key.key });
      if (take(req, res)) return;
      return json(res, 404, { error: 'not found' });
    },
  };
}

function main() {
  if (!process.env.RPC_GATEWAY_KEY) { log('RPC_GATEWAY_KEY is not set: no gateway to run'); return; }
  const nodes = nodesOf(process.env.RPC_GATEWAY_NODES || '{}');
  if (!nodes.size) throw new Error('RPC_GATEWAY_NODES names no chain');
  const forwarders = String(process.env.RPC_GATEWAY_FORWARDERS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const gw = makeRpcGateway({ secret: process.env.RPC_GATEWAY_KEY, nodes, forwarders });
  const port = Number(process.env.PORT || 10000);
  createServer((req, res) => { Promise.resolve(gw.handler(req, res)).catch((e) => { log('request failed:', String(e?.message || e).slice(0, 120)); try { if (!res.headersSent) { res.writeHead(500, JSON_TYPE); res.end('{"error":"internal error"}'); } } catch { /* gone */ } }); }).listen(port, () => log(`listening on ${port}: chains ${[...nodes.keys()].join(', ')}, key id ${gw.key.kid}`));
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { log('failed:', e.message); process.exit(1); }
}
