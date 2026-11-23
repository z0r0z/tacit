// The read-only front door of our own Ethereum and Bitcoin nodes (own-nodes/README.md).
//
//   POST /eth             JSON-RPC to the Ethereum node: an allowlist of read methods, no sends (but see INTERNAL_SENDS), no admin/debug/txpool/trace
//   GET  /btc/api/<path>  Esplora REST to the Bitcoin indexer: an allowlist of read paths (POST /btc/api/tx only when ALLOW_BROADCAST=1)
//   GET  /health          head and tip freshness plus aggregate counters (no addresses, no client data)
//   /btc/api/… can instead be served from a PRUNED bitcoind's RPC (BTC_RPC_URL + BTC_RPC_AUTH, no BTC_ESPLORA_UPSTREAM): only what a pruned
//                         node can answer truthfully (tip, block by height, headers, fee estimates, a transaction that is in the mempool, and
//                         POST /tx), 501 for the rest, and 503 while the node is still syncing. Never a list for old transactions or address history.
//   /k/<secret>/eth, /k/<secret>/btc/api/…   the same, for our own services: an INTERNAL_KEYS secret lifts the per-client budget
//                         (for a caller that can set a URL and not a header; `x-tacit-key: <secret>` does the same)
//
// What it is for: the nodes are the only thing that must never face the internet raw (their RPC has no auth and an open
// eth_call can pin a CPU), and the browser needs CORS, text/plain bodies (no preflight, see dapp/rpc-body.js), a cap per
// visitor, and answers that a wide eth_getLogs would otherwise ask the node to compute.
//
// Privacy, because this is the part that says what we can see: NO access log. Nothing about a request (address, method,
// params, URL, IP) is written anywhere. The per-client budget keeps only sha256(ip + a key made at start) in memory, dropped
// after ten idle minutes; the key is not stored, so a restart makes the table unreadable. /health carries counts only.
import http from 'node:http';
import crypto from 'node:crypto';

const READ_METHODS = {
  // method: cost in budget units
  eth_chainId: 1, net_version: 1, eth_blockNumber: 1, eth_syncing: 1,
  eth_gasPrice: 1, eth_maxPriorityFeePerGas: 1, eth_feeHistory: 3,
  eth_getBalance: 1, eth_getCode: 2, eth_getStorageAt: 1, eth_getTransactionCount: 1,
  eth_call: 5, eth_estimateGas: 5, eth_createAccessList: 5,
  eth_getBlockByNumber: 2, eth_getBlockByHash: 2, eth_getBlockReceipts: 5,
  eth_getTransactionByHash: 1, eth_getTransactionReceipt: 1,
  eth_getBlockTransactionCountByNumber: 1, eth_getBlockTransactionCountByHash: 1,
  eth_getLogs: 10, eth_getProof: 10,
};
const FULL_TX_COST = 5; // eth_getBlockBy*(…, true) returns every transaction

const UTXO = '[0-9a-f]{64}';
const TXS = '(txs(\\/(chain|mempool)(\\/' + UTXO + ')?)?|utxo)';
export const ESPLORA_GET = [
  /^\/blocks\/tip\/(height|hash)$/,
  /^\/block-height\/\d{1,9}$/,
  new RegExp('^\\/block\\/' + UTXO + '(\\/(header|raw|status|txids|txs(\\/\\d{1,6})?|txid\\/\\d{1,6}))?$'),
  /^\/blocks(\/\d{1,9})?$/,
  new RegExp('^\\/tx\\/' + UTXO + '(\\/(hex|raw|status|outspends|merkle-proof|merkleblock-proof|outspend\\/\\d{1,6}))?$'),
  new RegExp('^\\/address\\/[A-Za-z0-9]{14,100}(\\/' + TXS + ')?$'),
  new RegExp('^\\/scripthash\\/' + UTXO + '(\\/' + TXS + ')?$'),
  /^\/fee-estimates$/,
  /^\/mempool(\/(txids|recent))?$/,
];

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const num = (t) => (typeof t === 'string' && /^0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : null);

export function makeGateway(o = {}) {
  const cfg = {
    ethUpstream: o.ethUpstream, btcUpstream: o.btcUpstream, btcRpcUrl: o.btcRpcUrl || '', btcRpcAuth: o.btcRpcAuth || '',
    origins: new Set(o.origins || []), anyOrigin: (o.origins || []).includes('*'),
    internalKeys: (o.internalKeys || []).map((k) => crypto.createHash('sha256').update(k).digest()),
    trustProxy: !!o.trustProxy, whoami: !!o.whoami, clientIpHeader: String(o.clientIpHeader || '').toLowerCase(), allowBroadcast: !!o.allowBroadcast, internalSends: !!o.internalSends,
    budget: o.budgetPerMin ?? 600, internalBudget: o.internalBudgetPerMin ?? 60_000,
    maxBatch: o.maxBatch ?? 20, maxBody: o.maxBody ?? 256 * 1024, maxTxBody: o.maxTxBody ?? 1024 * 1024,
    logsMaxSpan: o.logsMaxSpan ?? 50_000, headMs: o.headMs ?? 1500, tipMs: o.tipMs ?? 5000,
    timeoutMs: o.timeoutMs ?? 30_000, fetchImpl: o.fetchImpl || fetch,
  };
  const idKey = crypto.randomBytes(32);
  const buckets = new Map();   // hash -> { tokens, at }
  const counters = { requests: 0, limited: 0, refused: 0, upstreamErrors: 0 };
  const cache = new Map();     // key -> { at, value }
  const inflight = new Map();  // key -> Promise (identical reads in flight share one upstream call)

  const sweep = setInterval(() => {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, b] of buckets) if (b.at < cutoff) buckets.delete(k);
  }, 60_000);
  sweep.unref?.();

  // CLIENT_IP_HEADER names the one header a proxy we trust sets to the connecting client (Render sits behind Cloudflare: cf-connecting-ip). It is read
  // only when set, and only that header: a client cannot choose its own budget key unless the proxy lets it, and Cloudflare overwrites this one.
  const ipOf = (req) => {
    if (cfg.clientIpHeader) {
      const v = String(req.headers[cfg.clientIpHeader] || '').split(',')[0].trim();
      if (v) return v;
    }
    if (cfg.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return req.socket.remoteAddress || '';
  };
  const keyOk = (k) => {
    if (!k || !cfg.internalKeys.length) return false;
    const h = crypto.createHash('sha256').update(String(k)).digest();
    return cfg.internalKeys.some((x) => crypto.timingSafeEqual(x, h));
  };
  const isInternal = (req) => keyOk(req.headers['x-tacit-key']);
  // Takes `cost` units from the client's bucket. Returns 0 when allowed, else the seconds until it would be.
  const spend = (req, internal, cost) => {
    const cap = internal ? cfg.internalBudget : cfg.budget;
    const id = crypto.createHash('sha256').update(idKey).update(internal ? 'internal' : ipOf(req)).digest('hex').slice(0, 24);
    const now = Date.now();
    const b = buckets.get(id) || { tokens: cap, at: now };
    b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 60_000) * cap);
    b.at = now;
    buckets.set(id, b);
    if (b.tokens >= cost) { b.tokens -= cost; return 0; }
    return Math.max(1, Math.ceil(((cost - b.tokens) / cap) * 60));
  };

  const cors = (req, res) => {
    const origin = req.headers.origin;
    if (origin && (cfg.anyOrigin || cfg.origins.has(origin))) {
      res.setHeader('access-control-allow-origin', cfg.anyOrigin ? '*' : origin);
      res.setHeader('vary', 'Origin');
    }
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, x-tacit-key');
    res.setHeader('access-control-max-age', '86400');
    res.setHeader('x-content-type-options', 'nosniff');
  };
  const send = (res, status, body, type = 'application/json', extra = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const readBody = (req, limit) => new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
  const once = (key, make) => {
    if (inflight.has(key)) return inflight.get(key);
    const p = make().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
  const cached = (key, ms, make) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ms) return Promise.resolve(hit.value);
    return once(key, () => make().then((value) => { cache.set(key, { at: Date.now(), value }); return value; }));
  };

  const ethCall = async (payload, timeout = cfg.timeoutMs) => {
    const r = await cfg.fetchImpl(cfg.ethUpstream, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    return r.json();
  };
  const head = () => cached('eth:head', cfg.headMs, async () => {
    const r = await ethCall({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }, 5000);
    return { number: num(r.result), at: Date.now() };
  });

  // One JSON-RPC request in: either a refusal (an error object) or its cost. getLogs spans are checked here so a client
  // that asks too wide learns it from a normal JSON-RPC error and narrows, exactly as it does with the public nodes.
  const vet = async (r, internal) => {
    if (!r || typeof r !== 'object' || typeof r.method !== 'string' || !Array.isArray(r.params ?? [])) return { err: rpcError(r?.id, -32600, 'invalid request') };
    // Our own relays send through the same URL they read from (viem's one transport), so a holder of an internal key may send when the
    // operator has said so (INTERNAL_SENDS=1). Nobody else can: a visitor's page never sends through us.
    if (r.method === 'eth_sendRawTransaction' && cfg.internalSends && internal) return { cost: 5 };
    if (!(r.method in READ_METHODS)) return { err: rpcError(r.id, -32601, 'method not available here') };
    let cost = READ_METHODS[r.method];
    const p = r.params || [];
    if ((r.method === 'eth_getBlockByNumber' || r.method === 'eth_getBlockByHash') && p[1] === true) cost = FULL_TX_COST;
    if (r.method === 'eth_getLogs') {
      const f = p[0] || {};
      if (f.blockHash == null) {
        let from = f.fromBlock === 'earliest' ? 0 : num(f.fromBlock), to = num(f.toBlock);
        if (from == null || to == null) {
          // a tag (latest, safe, …) or nothing: the chain head stands for it; head unknown ⇒ the node's own cap decides
          const h = (await head().catch(() => null))?.number ?? null;
          if (from == null) from = h;
          if (to == null) to = h;
        }
        if (from != null && to != null && to - from + 1 > cfg.logsMaxSpan) return { err: rpcError(r.id, -32602, `query exceeds max block range ${cfg.logsMaxSpan}`) };
      }
    }
    return { cost };
  };

  async function handleEth(req, res, internal) {
    let body;
    try { body = JSON.parse(await readBody(req, cfg.maxBody)); } catch (e) {
      return send(res, e.code === 413 ? 413 : 400, rpcError(null, e.code === 413 ? -32600 : -32700, e.code === 413 ? 'request too large' : 'parse error'));
    }
    const batch = Array.isArray(body);
    const reqs = batch ? body : [body];
    if (!reqs.length || reqs.length > cfg.maxBatch) return send(res, 400, rpcError(null, -32600, `batch must hold 1 to ${cfg.maxBatch} requests`));

    const out = new Array(reqs.length);
    const forward = [];
    let cost = 0;
    for (let i = 0; i < reqs.length; i++) {
      const v = await vet(reqs[i], internal);
      if (v.err) { out[i] = v.err; counters.refused++; } else { cost += v.cost; forward.push(i); }
    }
    if (forward.length) {
      const wait = spend(req, internal, cost);
      if (wait) {
        counters.limited++;
        return send(res, 429, batch ? reqs.map((r) => rpcError(r?.id, -32005, `rate limit exceeded; retry in ${wait}s`)) : rpcError(reqs[0]?.id, -32005, `rate limit exceeded; retry in ${wait}s`), 'application/json', { 'retry-after': String(wait) });
      }
      try {
        // Our own ids go upstream so answers can be matched back whatever order the node returns them in.
        const up = await ethCall(forward.map((i, n) => ({ jsonrpc: '2.0', id: n, method: reqs[i].method, params: reqs[i].params || [] })));
        const byId = new Map((Array.isArray(up) ? up : [up]).map((x) => [x.id, x]));
        forward.forEach((i, n) => { const x = byId.get(n); out[i] = x ? { ...x, id: reqs[i].id ?? null } : rpcError(reqs[i].id, -32603, 'no answer'); });
      } catch {
        counters.upstreamErrors++;
        forward.forEach((i) => { out[i] = rpcError(reqs[i].id, -32603, 'node unavailable'); });
        return send(res, 502, batch ? out : out[0]);
      }
    }
    counters.requests += reqs.length;
    return send(res, 200, batch ? out : out[0]);
  }

  // ── a pruned bitcoind behind the esplora paths that it can answer truthfully ───────────────────────────────────────────────────────
  const btcRpc = async (method, params = []) => {
    const r = await cfg.fetchImpl(cfg.btcRpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(cfg.btcRpcAuth).toString('base64') },
      body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }), signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const j = await r.json().catch(() => ({ error: { code: -32603, message: 'bad answer' } }));
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
    return j.result;
  };
  // A node that is still syncing, or whose newest block is hours old, must not answer a tip: the header relay would read a stale one as the chain's.
  const btcFresh = () => cached('btc:fresh', 10_000, async () => {
    const i = await btcRpc('getblockchaininfo');
    return { ok: !i.initialblockdownload && Date.now() / 1000 - i.time < 3 * 3600, blocks: i.blocks, headers: i.headers, progress: i.verificationprogress };
  });
  const FEE_TARGETS = [1, 2, 3, 4, 6, 10, 20, 144, 1008];
  async function handleBtcShim(req, res, internal, path) {
    const text = (body, status = 200) => send(res, status, String(body), 'text/plain');
    if (req.method === 'POST') {
      if (path !== '/tx' || !cfg.allowBroadcast) return send(res, 403, { error: 'read-only' });
      let hex;
      try { hex = (await readBody(req, cfg.maxTxBody)).trim(); } catch { return send(res, 413, { error: 'request too large' }); }
      if (!/^[0-9a-f]{120,}$/i.test(hex) || hex.length % 2) return text('invalid transaction hex', 400);
      const wait = spend(req, internal, 5);
      if (wait) { counters.limited++; return send(res, 429, { error: 'rate limit exceeded' }, 'application/json', { 'retry-after': String(wait) }); }
      try { const txid = await btcRpc('sendrawtransaction', [hex]); counters.requests++; return text(txid); }
      catch (e) { if (e.code !== undefined && e.code !== -32603) return text(`sendrawtransaction RPC error ${e.code}: ${e.message}`, 400); counters.upstreamErrors++; return text('node unavailable', 502); }
    }
    const m = path.match(/^\/(blocks\/tip\/(height|hash)|block-height\/(\d+)|block\/([0-9a-f]{64})\/(header|raw|status)|tx\/([0-9a-f]{64})\/(hex|raw)|fee-estimates)$/);
    if (!ESPLORA_GET.some((re) => re.test(path))) { counters.refused++; return send(res, 404, { error: 'not available here' }); }
    if (!m) { counters.refused++; return send(res, 501, { error: 'not provided by this node (pruned: no history index)' }); }
    const wait = spend(req, internal, m[5] === 'raw' || m[7] === 'raw' ? 3 : m[1] === 'fee-estimates' ? 3 : 1);
    if (wait) { counters.limited++; return send(res, 429, { error: 'rate limit exceeded' }, 'application/json', { 'retry-after': String(wait) }); }
    try {
      if (!(await btcFresh()).ok) return send(res, 503, { error: 'node is syncing' }, 'application/json', { 'retry-after': '60' });
      counters.requests++;
      if (m[2] === 'height') return text(await cached('btc:tip:h', cfg.tipMs, () => btcRpc('getblockcount')));
      if (m[2] === 'hash') return text(await cached('btc:tip:x', cfg.tipMs, () => btcRpc('getbestblockhash')));
      if (m[3] !== undefined) return text(await btcRpc('getblockhash', [Number(m[3])]));
      if (m[4] && m[5] === 'header') return text(await btcRpc('getblockheader', [m[4], false]));
      if (m[4] && m[5] === 'status') {
        const h = await btcRpc('getblockheader', [m[4], true]);
        return send(res, 200, { in_best_chain: h.confirmations >= 0, height: h.height, next_best: h.nextblockhash ?? null });
      }
      if (m[4] && m[5] === 'raw') return send(res, 200, Buffer.from(await btcRpc('getblock', [m[4], 0]), 'hex'), 'application/octet-stream');
      if (m[6]) {
        const hexTx = await btcRpc('getrawtransaction', [m[6], false]);
        return m[7] === 'hex' ? text(hexTx) : send(res, 200, Buffer.from(hexTx, 'hex'), 'application/octet-stream');
      }
      if (m[1] === 'fee-estimates') {
        const fe = await cached('btc:fees', 20_000, async () => {
          const out = {};
          for (const t of FEE_TARGETS) { try { const r = await btcRpc('estimatesmartfee', [t]); if (r.feerate > 0) out[String(t)] = Number((r.feerate * 1e5).toFixed(3)); } catch { /* a target the node has no estimate for is left out, as esplora does */ } }
          return out;
        });
        return send(res, 200, fe);
      }
    } catch (e) {
      // -5 (no such block/transaction) and -8 (height out of range) are real answers; anything else is the node being unwell
      if (e.code === -5 || e.code === -8) return send(res, 404, 'Not found', 'text/plain');
      counters.upstreamErrors++; return send(res, 502, { error: 'node unavailable' });
    }
    return send(res, 404, { error: 'not available here' });
  }

  async function handleBtc(req, res, internal, path, search) {
    if (!cfg.btcUpstream && cfg.btcRpcUrl) return handleBtcShim(req, res, internal, path);
    const isTx = path === '/tx';
    if (req.method === 'POST') {
      if (!isTx || !cfg.allowBroadcast) return send(res, 403, { error: 'read-only' });
      let hex;
      try { hex = (await readBody(req, cfg.maxTxBody)).trim(); } catch { return send(res, 413, { error: 'request too large' }); }
      if (!/^[0-9a-f]{120,}$/i.test(hex) || hex.length % 2) return send(res, 400, 'invalid transaction hex', 'text/plain');
      const wait = spend(req, internal, 5);
      if (wait) { counters.limited++; return send(res, 429, { error: 'rate limit exceeded' }, 'application/json', { 'retry-after': String(wait) }); }
      try {
        const r = await cfg.fetchImpl(cfg.btcUpstream + '/tx', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: hex, signal: AbortSignal.timeout(cfg.timeoutMs) });
        counters.requests++;
        return send(res, r.status, await r.text(), 'text/plain');
      } catch { counters.upstreamErrors++; return send(res, 502, 'node unavailable', 'text/plain'); }
    }
    if (!ESPLORA_GET.some((re) => re.test(path))) { counters.refused++; return send(res, 404, { error: 'not available here' }); }
    // A query string is never forwarded: esplora reads take none, and one more place for a client to tuck a parameter we did not vet.
    void search;
    const cost = /\/(txs|raw)(\/|$)|^\/blocks/.test(path) ? 3 : 1;
    const wait = spend(req, internal, cost);
    if (wait) { counters.limited++; return send(res, 429, { error: 'rate limit exceeded' }, 'application/json', { 'retry-after': String(wait) }); }
    const ttl = /^\/blocks\/tip\//.test(path) ? cfg.tipMs : path === '/fee-estimates' ? 20_000 : 0;
    try {
      const get = async () => {
        const r = await cfg.fetchImpl(cfg.btcUpstream + path, { signal: AbortSignal.timeout(cfg.timeoutMs) });
        return { status: r.status, type: r.headers.get('content-type') || 'text/plain', body: Buffer.from(await r.arrayBuffer()) };
      };
      const got = ttl ? await cached('btc:' + path, ttl, get) : await once('btc:' + path, get);
      counters.requests++;
      return send(res, got.status, got.body, got.type);
    } catch { counters.upstreamErrors++; return send(res, 502, { error: 'node unavailable' }); }
  }

  async function handleHealth(res) {
    const out = { ok: true, counters: { ...counters } };
    if (cfg.ethUpstream) {
      try {
        const r = await ethCall({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }, 5000);
        const ts = num(r.result?.timestamp);
        out.eth = { head: num(r.result?.number), ageSec: ts == null ? null : Math.max(0, Math.round(Date.now() / 1000 - ts)) };
        if (out.eth.ageSec == null || out.eth.ageSec > 120) out.ok = false;
      } catch { out.eth = { error: 'unreachable' }; out.ok = false; }
    }
    if (!cfg.btcUpstream && cfg.btcRpcUrl) {
      try { const b = await btcFresh(); out.btc = { tip: b.blocks, syncing: !b.ok, ...(b.ok ? {} : { headers: b.headers, progress: Number(b.progress.toFixed(4)) }) }; if (!b.ok) out.ok = false; }
      catch { out.btc = { error: 'unreachable' }; out.ok = false; }
    } else if (cfg.btcUpstream) {
      try {
        const r = await cfg.fetchImpl(cfg.btcUpstream + '/blocks/tip/height', { signal: AbortSignal.timeout(5000) });
        out.btc = { tip: r.ok ? Number(await r.text()) : null };
        if (!r.ok) out.ok = false;
      } catch { out.btc = { error: 'unreachable' }; out.ok = false; }
    }
    return send(res, out.ok ? 200 : 503, out);
  }

  const server = http.createServer(async (req, res) => {
    cors(req, res);
    try {
      const origin = req.headers.origin;
      if (origin && !cfg.anyOrigin && !cfg.origins.has(origin)) return send(res, 403, { error: 'origin not allowed' });
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const url = new URL(req.url, 'http://x');
      let path = url.pathname;
      if (path === '/health' && req.method === 'GET') return await handleHealth(res);
      // Off unless WHOAMI=1: tells the CALLER how the proxy chain in front of us presents it (its own address and headers, nobody else's), to pick CLIENT_IP_HEADER.
      if (path === '/whoami' && cfg.whoami) return send(res, 200, { remote: req.socket.remoteAddress, xff: req.headers['x-forwarded-for'] ?? null, cf: req.headers['cf-connecting-ip'] ?? null, trueClient: req.headers['true-client-ip'] ?? null, realIp: req.headers['x-real-ip'] ?? null });
      let internal = isInternal(req);
      // Our own services (cast, the prover host, the relays) can set a URL and not a header: /k/<secret>/eth and /k/<secret>/btc/api/…
      const km = path.match(/^\/k\/([A-Za-z0-9_-]{16,128})(\/.*)$/);
      if (km) { if (!keyOk(km[1])) return send(res, 403, { error: 'bad key' }); internal = true; path = km[2]; }
      if (path === '/eth' && req.method === 'POST' && cfg.ethUpstream) return await handleEth(req, res, internal);
      if (path.startsWith('/btc/api/') && (cfg.btcUpstream || cfg.btcRpcUrl)) return await handleBtc(req, res, internal, path.slice('/btc/api'.length), url.search);
      return send(res, 404, { error: 'not found' });
    } catch { try { send(res, 500, { error: 'error' }); } catch { /* already sent */ } }
  });
  server.requestTimeout = 60_000;
  server.on('close', () => clearInterval(sweep));
  return { server, counters, cfg };
}

// `node gateway.mjs` — configuration is the environment only (Docker passes it).
if (import.meta.url === `file://${process.argv[1]}`) {
  const e = process.env;
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const { server } = makeGateway({
    ethUpstream: e.ETH_UPSTREAM || '', btcUpstream: (e.BTC_ESPLORA_UPSTREAM || '').replace(/\/$/, ''), btcRpcUrl: e.BTC_RPC_URL || '', btcRpcAuth: e.BTC_RPC_AUTH || '',
    origins: list(e.ALLOW_ORIGINS || 'https://tacit.finance,https://www.tacit.finance'),
    internalKeys: list(e.INTERNAL_KEYS), trustProxy: e.TRUST_PROXY === '1', clientIpHeader: e.CLIENT_IP_HEADER || '', whoami: e.WHOAMI === '1', allowBroadcast: e.ALLOW_BROADCAST === '1', internalSends: e.INTERNAL_SENDS === '1',
    budgetPerMin: Number(e.BUDGET_PER_MIN) || undefined, internalBudgetPerMin: Number(e.INTERNAL_BUDGET_PER_MIN) || undefined,
    logsMaxSpan: Number(e.LOGS_MAX_SPAN) || undefined,
  });
  server.listen(Number(e.PORT) || 8080, '0.0.0.0', () => console.log(`gateway up (eth ${e.ETH_UPSTREAM ? 'on' : 'off'}, btc ${e.BTC_ESPLORA_UPSTREAM ? 'esplora' : e.BTC_RPC_URL ? 'pruned-rpc' : 'off'})`));
}
