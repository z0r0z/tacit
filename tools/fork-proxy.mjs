#!/usr/bin/env node
// A JSON-RPC proxy for anvil forks of mainnet that no one public node can serve alone. Free nodes each refuse part of what a fork of the
// pool needs: one has no old state, another caps a log read at 10,000 blocks (or 10, or 50), another throttles a long scan, and the gateway
// that does everything sometimes refuses a machine for hours. This proxy sends each call where it can be answered:
//   - eth_getLogs over a fixed range is cut into chunks of LOG_SPAN blocks, each asked of LOG_UPSTREAMS in turn, the answers merged in order;
//   - every other call goes to STATE_UPSTREAMS in turn (archive state: old storage, proofs, code);
//   - a call that failed for want of capacity (rate limits, 5xx, timeouts, a node's own "too many" words) is tried again with backoff;
//   - an answer about fixed blocks is kept on disk (CACHE_DIR), so a rerun of a test at the same fork block asks nothing it asked before.
// Calls about `latest`, `pending`, gas prices and the head are never cached.
//
//   node tools/fork-proxy.mjs                 then fork from http://127.0.0.1:8590 (anvil --fork-url, a test's FORK=)
//   PORT=8590 CACHE_DIR=.fork-cache LOG_SPAN=10000 STATE_UPSTREAMS=https://a,https://b LOG_UPSTREAMS=https://c node tools/fork-proxy.mjs
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 8590);
const CACHE = process.env.CACHE_DIR || join(process.env.TMPDIR || '/tmp', 'tacit-fork-cache');
const LOG_SPAN = BigInt(process.env.LOG_SPAN || 10000);
const list = (v, d) => String(v || d).split(',').map((s) => s.trim()).filter(Boolean);
const STATE = list(process.env.STATE_UPSTREAMS, 'https://rpc.mevblocker.io,https://eth-mainnet.public.blastapi.io');
// dRPC's free tier counts a range of 10,000 blocks as over its limit: it is asked for one block fewer
const LOGS = list(process.env.LOG_UPSTREAMS, 'https://rpc.mevblocker.io,https://eth.drpc.org');
const LOG_SPAN_AT = { 'https://eth.drpc.org': 9999n };
const INFLIGHT = Number(process.env.INFLIGHT || 4);
mkdirSync(CACHE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a refusal for want of capacity, or a connection that failed: worth asking again, here or at the next node
const busy = /rate|limit|too many|capacity|busy|overload|unavailable|temporar|timeout|timed out|try again|upstream|gateway|50[0-9]|internal error|fetch failed|econn|socket|network|aborted/i;
let running = 0;
const queue = [];
const slot = () => (running < INFLIGHT ? (running++, Promise.resolve()) : new Promise((r) => queue.push(r)));
const free = () => { const n = queue.shift(); if (n) n(); else running--; };

// One call to one upstream. → { result } or { error, retry } (retry: worth asking again or elsewhere).
async function ask(url, method, params) {
  await slot();
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { return { error: { code: -32000, message: `${new URL(url).host} answered ${r.status}: ${text.slice(0, 120)}` }, retry: true }; }
    if (j.error) return { error: j.error, retry: !r.ok || busy.test(String(j.error.message || '')) };
    if (!r.ok) return { error: { code: -32000, message: `${new URL(url).host} answered ${r.status}` }, retry: true };
    return { result: j.result };
  } catch (e) { return { error: { code: -32000, message: `${new URL(url).host}: ${e.message}` }, retry: true }; } finally { free(); }
}
// A call asked of each upstream in turn, the round repeated with backoff while the failures were for want of capacity.
async function anyOf(urls, method, params, span = null) {
  let last = null;
  for (let round = 0; round < 8; round++) {
    for (const url of urls) {
      if (span && LOG_SPAN_AT[url] && LOG_SPAN_AT[url] < span) continue;      // this node does not take a range this long
      const a = await ask(url, method, params);
      if (!a.error) return a;
      last = a.error;
      if (!a.retry) break;                                                      // a refusal of the call itself: no other node will differ
    }
    if (last && !busy.test(String(last.message || ''))) break;
    await sleep(Math.min(30_000, 1000 * 2 ** round));
  }
  return { error: last || { code: -32000, message: 'no upstream answered' } };
}

const fixed = (b) => typeof b === 'string' && /^0x[0-9a-f]+$/i.test(b);
const volatile = new Set(['eth_blockNumber', 'eth_gasPrice', 'eth_feeHistory', 'eth_maxPriorityFeePerGas', 'eth_chainId', 'net_version', 'eth_syncing']);
// Whether an answer can be kept: no call about the head, and none naming latest or pending anywhere in its parameters.
const cacheable = (method, params) => !volatile.has(method) && !/"(latest|pending|safe|finalized)"/.test(JSON.stringify(params || []));
const keyOf = (method, params) => createHash('sha256').update(JSON.stringify([method, params || []])).digest('hex');
function cached(method, params, compute) {
  if (!cacheable(method, params)) return compute();
  const f = join(CACHE, keyOf(method, params) + '.json');
  if (existsSync(f)) { try { return Promise.resolve(JSON.parse(readFileSync(f, 'utf8'))); } catch { /* asked again */ } }
  return compute().then((a) => { if (!a.error) try { writeFileSync(f, JSON.stringify(a)); } catch { } return a; });
}

// eth_getLogs over a fixed range in chunks; a range naming latest goes whole to the log upstreams (a fork asks those only past its block).
async function getLogs(params) {
  const q = params && params[0] ? params[0] : {};
  if (!fixed(q.fromBlock) || !fixed(q.toBlock) || q.blockHash) return cached('eth_getLogs', params, () => anyOf(LOGS, 'eth_getLogs', params));
  const from = BigInt(q.fromBlock), to = BigInt(q.toBlock), out = [];
  const span = Object.values(LOG_SPAN_AT).reduce((a, b) => (b < a ? b : a), LOG_SPAN);
  for (let a = from; a <= to; a += span) {
    const b = a + span - 1n < to ? a + span - 1n : to;
    const part = [{ ...q, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }];
    const r = await cached('eth_getLogs', part, () => anyOf(LOGS, 'eth_getLogs', part, b - a + 1n));
    if (r.error) return r;
    out.push(...(r.result || []));
  }
  return { result: out };
}

async function one(req) {
  const { method, params, id } = req || {};
  const a = method === 'eth_getLogs' ? await getLogs(params) : await cached(method, params, () => anyOf(STATE, method, params));
  return a.error ? { jsonrpc: '2.0', id, error: a.error } : { jsonrpc: '2.0', id, result: a.result };
}

createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  let body = '';
  for await (const c of req) body += c;
  let j;
  try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
  const reply = Array.isArray(j) ? await Promise.all(j.map(one)) : await one(j);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(reply));
}).listen(PORT, '127.0.0.1', () => console.log(`fork proxy on http://127.0.0.1:${PORT}: state ${STATE.map((u) => new URL(u).host).join(', ')}; logs ${LOGS.map((u) => new URL(u).host).join(', ')} in ${LOG_SPAN}-block chunks; cache ${CACHE}`));
