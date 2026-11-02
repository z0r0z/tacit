// A JSON-RPC proxy for anvil's fork URL. An upstream node that drops a request now and then fails an anvil run, and every
// run reads the same state at the same block, so the proxy asks again when the upstream fails and keeps what it learned
// for state at a fixed block (on disk, so the next run starts warm). Calls that name no fixed block are passed through.
// The wallet reads the pool's whole history with eth_getLogs over ranges it narrows as it is refused, which a public node
// answers with rate limits; the proxy reads each range in fixed pieces, a few at a time, and answers from them.
// Needs Node 22.

import { createServer } from 'node:http';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const FIXED = /^0x[0-9a-f]+$/i;
const TRANSIENT = /unavailable|temporar|timed? ?out|rate|capacity|try again|too many|reset|overload|busy|internal error/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the position of the block argument, for the methods whose answer is fixed once the block is
const BLOCK_ARG = { eth_getStorageAt: 2, eth_getCode: 1, eth_getBalance: 1, eth_getTransactionCount: 1, eth_call: 1, eth_getProof: 2, eth_getBlockByNumber: 0 };

function cacheKeyOf(req) {
  const { method, params = [] } = req;
  if (method === 'eth_chainId' || method === 'net_version' || method === 'eth_getBlockByHash' || method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') return method + JSON.stringify(params);
  if (method === 'eth_getLogs') {
    const f = params[0] || {};
    return FIXED.test(f.toBlock || '') && FIXED.test(f.fromBlock || '') ? method + JSON.stringify(params) : null;
  }
  const at = BLOCK_ARG[method];
  if (at == null) return null;
  const tag = params[at];
  return typeof tag === 'string' && FIXED.test(tag) ? method + JSON.stringify(params) : null;
}

// `fetchImpl` is the fetch that reaches the upstream: a test that routes the global one to the fork passes the real one.
export async function startForkProxy({ upstream, cacheFile = null, attempts = 8, maxAgeMs = 24 * 3600 * 1000, log = () => {}, fetchImpl = globalThis.fetch }) {
  let entries = {}, block = null, dirty = false, at = Date.now();
  if (cacheFile) { try { const j = JSON.parse(readFileSync(cacheFile, 'utf8')); if (j.upstream === upstream && Date.now() - j.at < maxAgeMs) { entries = j.entries || {}; block = j.block ?? null; at = j.at; } } catch { /* a cold start */ } }
  const stats = { hits: 0, misses: 0, retries: 0 };

  async function ask(body) {
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetchImpl(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
        const text = await r.text();
        if (!r.ok) throw new Error(`upstream ${r.status} ${text.slice(0, 120)}`);
        const j = JSON.parse(text);
        if (j.error && TRANSIENT.test(String(j.error.message))) throw new Error(`upstream error ${j.error.message}`);
        return j;
      } catch (e) { last = e; stats.retries++; log(`retry ${i + 1}: ${String(e.message).slice(0, 100)}`); await sleep(400 * (i + 1)); }
    }
    throw last;
  }

  // ── eth_getLogs in fixed pieces ──
  const PIECE = 20000;
  const inflight = new Map();
  let active = 0; const waiting = [];
  const slot = async () => { if (active >= 3) await new Promise((r) => waiting.push(r)); active++; };
  const free = () => { active--; waiting.shift()?.(); };
  const hexN = (n) => '0x' + n.toString(16);
  async function readPiece(base, a, b) {
    let why = 'no answer';
    await slot();
    try {
      const j = await ask({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ ...base, fromBlock: hexN(a), toBlock: hexN(b) }] });
      if (!j.error) return j.result;
      why = String(j.error.message);
    } catch (e) { why = String((e && e.message) || e); } finally { free(); }
    if (b <= a) throw new Error(why);
    const mid = Math.floor((a + b) / 2);
    log(`splitting ${a}-${b}: ${why.slice(0, 80)}`);
    return [...(await readPiece(base, a, mid)), ...(await readPiece(base, mid + 1, b))];
  }
  async function logsOf(req) {
    const f = req.params[0];
    const from = parseInt(f.fromBlock, 16), to = Math.min(parseInt(f.toBlock, 16), block);
    const base = { address: f.address, topics: f.topics }, fk = JSON.stringify(base), out = [];
    for (let start = Math.floor(from / PIECE) * PIECE; start <= to; start += PIECE) {
      const a = start, b = Math.min(start + PIECE - 1, block), key = `logs${fk}${a}:${b}`;
      let logs = entries[key];
      if (!logs) {
        if (!inflight.has(key)) inflight.set(key, readPiece(base, a, b).then((r) => { entries[key] = r; dirty = true; return r; }).finally(() => inflight.delete(key)));
        logs = await inflight.get(key);
      }
      for (const l of logs) { const n = parseInt(l.blockNumber, 16); if (n >= from && n <= to) out.push(l); }
    }
    return { jsonrpc: '2.0', id: req.id, result: out };
  }

  async function answer(req) {
    if (req.method === 'eth_getLogs' && block != null) {
      const f = (req.params || [])[0] || {};
      if (FIXED.test(f.fromBlock || '') && FIXED.test(f.toBlock || '') && !f.blockHash) { stats.misses++; return logsOf(req); }
    }
    const key = cacheKeyOf(req);
    if (key && Object.hasOwn(entries, key)) { stats.hits++; return { jsonrpc: '2.0', id: req.id, result: entries[key] }; }
    stats.misses++;
    const t0 = Date.now();
    const j = await ask({ jsonrpc: '2.0', id: req.id, method: req.method, params: req.params || [] });
    if (Date.now() - t0 > 15000) log(`slow: ${req.method} took ${Math.round((Date.now() - t0) / 1000)} s`);
    // an answer is kept only when it says something: an error or a null (not found yet) may be different later
    if (key && !j.error && j.result != null) { entries[key] = j.result; dirty = true; }
    return j;
  }

  let seq = 0;
  const server = createServer(async (req, res) => {
    const n = ++seq, t0 = Date.now();
    let what = '?';
    req.on('error', (e) => log(`request ${n} error: ${e.message}`)); res.on('error', (e) => log(`response ${n} error: ${e.message}`));
    res.on('close', () => { if (!res.writableFinished) log(`#${n} ${what}: the client closed the connection after ${Math.round((Date.now() - t0) / 1000)} s, before the answer`); });
    const chunks = []; for await (const c of req) chunks.push(c);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      what = Array.isArray(body) ? `batch of ${body.length}` : `${body.method} ${JSON.stringify(body.params || []).slice(0, 110)}`;
      if (process.env.DEBUG_PROXY) log(`#${n} ${what}`);
      const out = Array.isArray(body) ? await Promise.all(body.map(answer)) : await answer(body);
      if (process.env.DEBUG_PROXY) log(`#${n} answered in ${Date.now() - t0} ms`);
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(out));
    } catch (e) { log(`answered 502: ${String((e && e.message) || e).slice(0, 160)}`); res.writeHead(502, { 'content-type': 'text/plain', connection: 'close' }); res.end(String((e && e.message) || e)); }
  });
  server.keepAliveTimeout = 120_000;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  function save() {
    if (!cacheFile || !dirty) return;
    dirty = false;
    try { writeFileSync(cacheFile + '.tmp', JSON.stringify({ upstream, block, at, entries })); renameSync(cacheFile + '.tmp', cacheFile); } catch { /* a cache that cannot be written is only slower */ }
  }
  const timer = setInterval(save, 15000); timer.unref();

  return {
    url: `http://127.0.0.1:${server.address().port}`, stats,
    // the block to fork at: the one the cache was filled at, or two blocks behind the upstream's head
    async pickBlock() {
      if (block != null) return block;
      const j = await ask({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
      block = Number(BigInt(j.result) - 2n); dirty = true; save();
      return block;
    },
    save, close: () => { clearInterval(timer); save(); server.closeAllConnections?.(); server.close(); },
  };
}
