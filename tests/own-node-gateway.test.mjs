// own-nodes/gateway.mjs, the read-only front door of our own Ethereum and Bitcoin nodes, against stub nodes on real sockets.
// What it pins: only the read methods get through (no sends, no admin/debug/txpool/trace), a batch is vetted item by item and
// answered in order, a getLogs wider than the cap is refused with the JSON-RPC error a client narrows on, the browser's
// text/plain body works and CORS is answered only to the allowed origins (on errors too), the per-visitor budget limits one
// client and not another, an internal key lifts it, identical reads in flight share one upstream call, only the esplora read
// paths pass (and POST /tx only when broadcast is on), and a request leaves no trace in the process output.
//
// Run: node --test tests/own-node-gateway.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeGateway } from '../own-nodes/gateway.mjs';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const body = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)); });

// stub Ethereum node: counts what it is asked, answers a few methods, sleeps on demand
const eth = { calls: [], delay: 0, head: 26_000_000 };
const ethNode = http.createServer(async (req, res) => {
  const p = JSON.parse(await body(req));
  const one = async (r) => {
    eth.calls.push(r.method);
    if (eth.delay) await new Promise((x) => setTimeout(x, eth.delay));
    const result = r.method === 'eth_blockNumber' ? '0x' + eth.head.toString(16)
      : r.method === 'eth_getBlockByNumber' ? { number: '0x' + eth.head.toString(16), timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) }
      : r.method === 'eth_chainId' ? '0x1' : '0x0';
    return { jsonrpc: '2.0', id: r.id, result };
  };
  const out = Array.isArray(p) ? (await Promise.all(p.map(one))).reverse() : await one(p);   // a batch comes back in reverse: ids must match it up
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
});
// stub esplora
const btc = { calls: [], broadcasts: [] };
const btcNode = http.createServer(async (req, res) => {
  btc.calls.push(req.method + ' ' + req.url);
  if (req.method === 'POST') { btc.broadcasts.push(await body(req)); res.writeHead(400, { 'content-type': 'text/plain' }); return res.end('sendrawtransaction RPC error: bad-txns-inputs-missingorspent'); }
  if (req.url === '/blocks/tip/height') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('900000'); }
  await new Promise((x) => setTimeout(x, 30));
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
});
const KEY = 'k3y-0123456789abcdef-xyz';
const ethPort = await listen(ethNode), btcPort = await listen(btcNode);

const start = async (o = {}) => {
  const g = makeGateway({ ethUpstream: `http://127.0.0.1:${ethPort}`, btcUpstream: `http://127.0.0.1:${btcPort}`, origins: ['https://tacit.finance'], ...o });
  const port = await listen(g.server);
  const base = `http://127.0.0.1:${port}`;
  return { g, base, stop: () => g.server.close() };
};
const rpc = (base, payload, headers = {}, type = 'application/json') => fetch(base + '/eth', { method: 'POST', headers: { 'content-type': type, origin: 'https://tacit.finance', ...headers }, body: JSON.stringify(payload) });
const one = (method, params = [], id = 1) => ({ jsonrpc: '2.0', id, method, params });

test('read methods pass; sends, admin, debug, txpool and trace do not', async () => {
  const { base, stop } = await start();
  try {
    for (const m of ['eth_chainId', 'eth_getBalance', 'eth_call', 'eth_getProof', 'eth_getTransactionReceipt']) {
      const j = await (await rpc(base, one(m))).json();
      assert.equal(j.error, undefined, m + ' should pass');
    }
    eth.calls.length = 0;
    for (const m of ['eth_sendRawTransaction', 'eth_sendTransaction', 'admin_peers', 'debug_traceTransaction', 'txpool_content', 'trace_block', 'web3_clientVersion', 'personal_listAccounts', 'eth_accounts', 'eth_sign']) {
      const j = await (await rpc(base, one(m, [], 7))).json();
      assert.equal(j.error?.code, -32601, m + ' must be refused');
      assert.equal(j.id, 7);
    }
    assert.deepEqual(eth.calls, [], 'a refused method never reaches the node');
  } finally { stop(); }
});

test('eth_sendRawTransaction: refused for everyone unless INTERNAL_SENDS is on, and then only for the holder of an internal key', async () => {
  const tx = one('eth_sendRawTransaction', ['0x02' + 'ab'.repeat(100)], 3);
  const off = await start({ internalKeys: [KEY] });
  try {
    eth.calls.length = 0;
    assert.equal((await (await rpc(off.base, tx, { 'x-tacit-key': KEY })).json()).error.code, -32601, 'off: even a key holder is refused');
    assert.deepEqual(eth.calls, []);
  } finally { off.stop(); }
  const on = await start({ internalKeys: [KEY], internalSends: true });
  try {
    eth.calls.length = 0;
    assert.equal((await (await rpc(on.base, tx)).json()).error.code, -32601, 'on: a visitor is still refused');
    assert.equal((await (await rpc(on.base, tx, { 'x-tacit-key': 'k3y-not-ours-0123456789' })).json()).error.code, -32601, 'a wrong key is a visitor');
    assert.deepEqual(eth.calls, []);
    const sent = await (await rpc(on.base, tx, { 'x-tacit-key': KEY })).json();
    assert.equal(sent.error, undefined); assert.equal(sent.id, 3);
    assert.deepEqual(eth.calls, ['eth_sendRawTransaction'], 'the key holder reaches the node');
    const viaUrl = await (await fetch(on.base + `/k/${KEY}/eth`, { method: 'POST', body: JSON.stringify(tx) })).json();
    assert.equal(viaUrl.error, undefined, 'the URL form is the same key');
  } finally { on.stop(); }
});

test('a batch is vetted item by item and answered in the order it came, whatever order the node answers in', async () => {
  const { base, stop } = await start();
  try {
    eth.calls.length = 0;
    const j = await (await rpc(base, [one('eth_chainId', [], 'a'), one('admin_peers', [], 'b'), one('eth_blockNumber', [], 'c')])).json();
    assert.deepEqual(j.map((x) => x.id), ['a', 'b', 'c']);
    assert.equal(j[0].result, '0x1');
    assert.equal(j[1].error.code, -32601);
    assert.equal(j[2].result, '0x' + eth.head.toString(16), 'the node answered this one in reverse; the id match puts it back');
    assert.deepEqual(eth.calls.sort(), ['eth_blockNumber', 'eth_chainId']);
    const big = await rpc(base, Array.from({ length: 21 }, (_, i) => one('eth_chainId', [], i)));
    assert.equal(big.status, 400, 'over the batch cap');
  } finally { stop(); }
});

test('getLogs wider than the cap is refused with the range error; the cap, a block hash and a short range pass', async () => {
  const { base, stop } = await start({ logsMaxSpan: 50_000 });
  try {
    const hex = (n) => '0x' + n.toString(16);
    const wide = await (await rpc(base, one('eth_getLogs', [{ fromBlock: hex(1), toBlock: hex(50_001) }]))).json();
    assert.equal(wide.error.code, -32602); assert.match(wide.error.message, /max block range 50000/);
    const ok = await (await rpc(base, one('eth_getLogs', [{ fromBlock: hex(1), toBlock: hex(50_000) }]))).json();
    assert.equal(ok.error, undefined, 'exactly the cap passes');
    const tag = await (await rpc(base, one('eth_getLogs', [{ fromBlock: hex(eth.head - 100), toBlock: 'latest' }]))).json();
    assert.equal(tag.error, undefined, 'latest is the head, so this is 101 blocks');
    const far = await (await rpc(base, one('eth_getLogs', [{ fromBlock: 'earliest', toBlock: 'latest' }]))).json();
    assert.equal(far.error?.code, -32602, 'earliest to latest is the whole chain');
    const byHash = await (await rpc(base, one('eth_getLogs', [{ blockHash: '0x' + '11'.repeat(32) }]))).json();
    assert.equal(byHash.error, undefined);
  } finally { stop(); }
});

test('the browser: text/plain body (no preflight), CORS only for allowed origins, on errors too', async () => {
  const { base, stop } = await start();
  try {
    const r = await rpc(base, one('eth_chainId'), {}, 'text/plain;charset=UTF-8');
    assert.equal((await r.json()).result, '0x1');
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://tacit.finance');
    const pre = await fetch(base + '/eth', { method: 'OPTIONS', headers: { origin: 'https://tacit.finance', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    assert.equal(pre.status, 204); assert.match(pre.headers.get('access-control-allow-headers'), /content-type/);
    const bad = await rpc(base, one('eth_chainId'), { origin: 'https://evil.example' });
    assert.equal(bad.status, 403); assert.equal(bad.headers.get('access-control-allow-origin'), null, 'no allow header for a stranger');
    const refused = await rpc(base, one('admin_peers'));
    assert.equal(refused.headers.get('access-control-allow-origin'), 'https://tacit.finance', 'a refusal still carries CORS, or the page sees a network error instead of the reason');
    const noOrigin = await fetch(base + '/eth', { method: 'POST', body: JSON.stringify(one('eth_chainId')) });
    assert.equal(noOrigin.status, 200, 'a server-side caller sends no Origin');
  } finally { stop(); }
  const any = await start({ origins: ['*'] });
  try { assert.equal((await rpc(any.base, one('eth_chainId'), { origin: 'https://anything.example' })).headers.get('access-control-allow-origin'), '*'); } finally { any.stop(); }
});

test('the budget limits one client, not another; an internal key lifts it', async () => {
  const { base, stop } = await start({ budgetPerMin: 30, trustProxy: true, internalKeys: [KEY], internalBudgetPerMin: 100_000 });
  try {
    const as = (ip, extra = {}) => rpc(base, one('eth_call'), { 'x-forwarded-for': ip, ...extra });
    const first = []; for (let i = 0; i < 8; i++) first.push((await as('203.0.113.1')).status);
    assert.deepEqual(first.slice(0, 6), [200, 200, 200, 200, 200, 200], '6 calls of 5 units = the 30');
    const limited = await as('203.0.113.1');
    assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal((await limited.json()).error.code, -32005, 'the code public nodes use, which the page already treats as "try another node"');
    assert.equal((await as('203.0.113.2')).status, 200, 'a different client has its own budget');
    for (let i = 0; i < 20; i++) assert.equal((await as('203.0.113.1', { 'x-tacit-key': KEY })).status, 200);
    assert.equal((await as('203.0.113.1', { 'x-tacit-key': 'wrong' })).status, 429, 'a wrong key is just a client');
    // a caller that can only set a URL (cast, the prover host) puts the secret in the path
    const viaPath = (secret, tail = '/eth') => fetch(base + `/k/${secret}${tail}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.1' }, body: JSON.stringify(one('eth_call')) });
    for (let i = 0; i < 20; i++) assert.equal((await viaPath(KEY)).status, 200, 'the URL form lifts the budget too');
    assert.equal((await viaPath('not-one-of-ours-0123456789')).status, 403, 'a key that is not ours is refused, not treated as a plain client');
    assert.equal((await viaPath('short')).status, 404, 'and a path that is not even key-shaped is just not found');
    assert.equal((await fetch(base + `/k/${KEY}/btc/api/blocks/tip/height`)).status, 200, 'the same prefix opens the Bitcoin side');
    // only the LAST forwarded address counts: a client cannot mint budgets by writing its own header ahead of the proxy's
    assert.equal((await as('9.9.9.9, 203.0.113.1')).status, 429);
  } finally { stop(); }
});

test('CLIENT_IP_HEADER: the budget key is that header alone (a proxy that varies X-Forwarded-For cannot split a client\'s budget, nor a client write itself a new one)', async () => {
  const { base, stop } = await start({ budgetPerMin: 30, trustProxy: true, clientIpHeader: 'CF-Connecting-IP' });
  try {
    const as = (ip, xff) => rpc(base, one('eth_call'), { 'cf-connecting-ip': ip, 'x-forwarded-for': xff });
    const seen = [];
    // same client, a different X-Forwarded-For every time (what a proxy chain with varying edge addresses does): ONE budget
    for (let i = 0; i < 8; i++) seen.push((await as('198.51.100.7', `10.0.0.${i}`)).status);
    assert.deepEqual(seen.slice(0, 6), [200, 200, 200, 200, 200, 200]); assert.equal(seen[6], 429, 'the 7th call of 5 units is over 30');
    assert.equal((await as('198.51.100.8', '10.0.0.1')).status, 200, 'another client has its own');
    // a request without the header falls back to the forwarded address, then to the socket
    assert.equal((await rpc(base, one('eth_call'), { 'x-forwarded-for': '198.51.100.9' })).status, 200);
  } finally { stop(); }
});

test('whoami: off by default, and when on it tells the caller only its own connection facts', async () => {
  const off = await start();
  try { assert.equal((await fetch(off.base + '/whoami')).status, 404); } finally { off.stop(); }
  const on = await start({ whoami: true });
  try {
    const j = await (await fetch(on.base + '/whoami', { headers: { 'x-forwarded-for': '203.0.113.5, 10.1.1.1', 'cf-connecting-ip': '203.0.113.5' } })).json();
    assert.deepEqual(Object.keys(j).sort(), ['cf', 'realIp', 'remote', 'trueClient', 'xff']); assert.equal(j.xff, '203.0.113.5, 10.1.1.1'); assert.equal(j.cf, '203.0.113.5');
  } finally { on.stop(); }
});

test('identical reads in flight share one upstream call; the tip is cached', async () => {
  const { base, stop } = await start();
  try {
    eth.delay = 60; eth.calls.length = 0; btc.calls.length = 0;
    await Promise.all(Array.from({ length: 6 }, () => fetch(base + '/btc/api/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq/utxo', { headers: { origin: 'https://tacit.finance' } })));
    assert.equal(btc.calls.filter((c) => c.includes('/utxo')).length, 1, 'six at once, one upstream read');
    btc.calls.length = 0;
    for (let i = 0; i < 4; i++) await fetch(base + '/btc/api/blocks/tip/height');
    assert.equal(btc.calls.length, 1, 'the tip is read once in its window');
  } finally { eth.delay = 0; stop(); }
});

test('esplora: only read paths pass; no query string reaches the node; POST /tx only with broadcast on', async () => {
  const { base, stop } = await start();
  try {
    const tx = 'ab'.repeat(32);
    for (const p of ['/blocks/tip/height', '/blocks/tip/hash', '/block-height/800000', `/block/${tx}/header`, `/tx/${tx}`, `/tx/${tx}/hex`, `/tx/${tx}/outspend/1`, '/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq/txs/chain', `/scripthash/${tx}/utxo`, '/fee-estimates', '/mempool/recent']) {
      assert.equal((await fetch(base + '/btc/api' + p)).status, 200, p);
    }
    for (const p of ['/', '/admin', `/tx/${tx}/../../x`, '/address/short', '/tx/zz', '/internal/status', `/block/${tx}/evil`, '/v1/anything']) {
      assert.equal((await fetch(base + '/btc/api' + p)).status, 404, p + ' is refused');
    }
    btc.calls.length = 0;
    await fetch(base + `/btc/api/tx/${tx}?x=1&token=2`);
    assert.deepEqual(btc.calls, [`GET /tx/${tx}`], 'the query string is dropped');
    const post = await fetch(base + '/btc/api/tx', { method: 'POST', body: '02000000' + 'ab'.repeat(100) });
    assert.equal(post.status, 403, 'broadcast is off by default');
    assert.deepEqual(btc.broadcasts, []);
  } finally { stop(); }
  const b = await start({ allowBroadcast: true });
  try {
    const hex = '02000000' + 'ab'.repeat(100);
    const r = await fetch(b.base + '/btc/api/tx', { method: 'POST', headers: { origin: 'https://tacit.finance' }, body: hex });
    assert.equal(r.status, 400); assert.match(await r.text(), /bad-txns-inputs-missingorspent/, 'the node\'s own refusal reaches the page unchanged, as with every esplora');
    assert.deepEqual(btc.broadcasts, [hex]);
    assert.equal((await fetch(b.base + '/btc/api/tx', { method: 'POST', body: 'not hex' })).status, 400);
    assert.equal((await fetch(b.base + '/btc/api/block/' + 'ab'.repeat(32), { method: 'POST', body: hex })).status, 403, 'POST is only /tx');
  } finally { b.stop(); }
});

test('a node that is down is a JSON-RPC error with CORS, not a hang or a bare 502 page; /health says so', async () => {
  const dead = http.createServer(); const deadPort = await listen(dead); await new Promise((r) => dead.close(r));
  const { base, stop } = await start({ ethUpstream: `http://127.0.0.1:${deadPort}`, btcUpstream: `http://127.0.0.1:${deadPort}` });
  try {
    const r = await rpc(base, one('eth_chainId', [], 5));
    assert.equal(r.status, 502); assert.equal((await r.json()).error.code, -32603);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://tacit.finance');
    const h = await fetch(base + '/health');
    assert.equal(h.status, 503); assert.equal((await h.json()).ok, false);
    assert.equal((await fetch(base + '/btc/api/blocks/tip/height')).status, 502);
  } finally { stop(); }
  const up = await start();
  try {
    const h = await (await fetch(up.base + '/health')).json();
    assert.equal(h.ok, true); assert.equal(h.eth.head, eth.head); assert.equal(h.btc.tip, 900000);
    assert.deepEqual(Object.keys(h.counters).sort(), ['limited', 'refused', 'requests', 'upstreamErrors'], 'counts only');
  } finally { up.stop(); }
});

test('no trace: a request writes nothing to stdout or stderr, and /health carries no client data', async () => {
  const { base, stop } = await start({ trustProxy: true });
  const out = []; const w1 = process.stdout.write, w2 = process.stderr.write;
  process.stdout.write = (c, ...a) => { out.push(String(c)); return w1.call(process.stdout, c, ...a); };
  process.stderr.write = (c, ...a) => { out.push(String(c)); return w2.call(process.stderr, c, ...a); };
  try {
    const who = '0x' + 'ab'.repeat(20);
    await rpc(base, one('eth_getBalance', [who, 'latest']), { 'x-forwarded-for': '198.51.100.77' });
    await fetch(base + '/btc/api/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq/utxo', { headers: { 'x-forwarded-for': '198.51.100.77' } });
    const health = JSON.stringify(await (await fetch(base + '/health')).json());
    assert.ok(!/198\.51\.100|bc1qar0|abab/.test(health));
  } finally { process.stdout.write = w1; process.stderr.write = w2; stop(); }
  assert.ok(!out.join('').match(/198\.51\.100|bc1qar0|abab|eth_getBalance/), 'nothing about the request was printed');
});


// ── the pruned-bitcoind shim ──────────────────────────────────────────────────────────────────────────────────────────────────────
const bd = { calls: [], authSeen: new Set(), ibd: false, ageSec: 60, pruned: true };
const BLOCK = '00'.repeat(31) + '01', TXID = 'cd'.repeat(32), HDR = '01000000' + 'ee'.repeat(76);
const bdNode = http.createServer(async (req, res) => {
  bd.authSeen.add(req.headers.authorization);
  const q = JSON.parse(await body(req));
  bd.calls.push(q.method);
  const err = (code, message) => ({ result: null, error: { code, message }, id: 1 });
  let out;
  switch (q.method) {
    case 'getblockchaininfo': out = { result: { initialblockdownload: bd.ibd, time: Math.floor(Date.now() / 1000) - bd.ageSec, blocks: 900000, headers: 900000, verificationprogress: bd.ibd ? 0.31 : 0.99999, pruned: bd.pruned }, error: null }; break;
    case 'getblockcount': out = { result: 900000, error: null }; break;
    case 'getbestblockhash': out = { result: BLOCK, error: null }; break;
    case 'getblockhash': out = q.params[0] > 900000 ? err(-8, 'Block height out of range') : { result: BLOCK, error: null }; break;
    case 'getblockheader': out = q.params[0] !== BLOCK ? err(-5, 'Block not found') : q.params[1] === false ? { result: HDR, error: null } : { result: { height: 899990, confirmations: 11, nextblockhash: 'ab'.repeat(32) }, error: null }; break;
    case 'getblock': out = q.params[0] !== BLOCK ? err(-5, 'Block not found') : { result: 'aabbcc', error: null }; break;
    case 'getrawtransaction': out = q.params[0] === TXID ? { result: '0200000001' + 'ab'.repeat(60), error: null } : err(-5, 'No such mempool transaction. Use -txindex or provide a block hash'); break;
    case 'estimatesmartfee': out = q.params[0] === 1008 ? { result: { errors: ['Insufficient data'], blocks: 0 }, error: null } : { result: { feerate: 0.00002 * (q.params[0] === 1 ? 2 : 1), blocks: q.params[0] }, error: null }; break;
    case 'sendrawtransaction': out = q.params[0].startsWith('ff') ? err(-26, 'min relay fee not met') : { result: TXID, error: null }; break;
    default: out = err(-32601, 'Method not found');
  }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...out, id: q.id }));
});
const bdPort = await listen(bdNode);
const startShim = async (o = {}) => {
  const g = makeGateway({ btcRpcUrl: `http://127.0.0.1:${bdPort}`, btcRpcAuth: 'tacit:pw', origins: ['https://tacit.finance'], ...o });
  const port = await listen(g.server);
  return { base: `http://127.0.0.1:${port}`, stop: () => g.server.close() };
};
const txt = async (u, init) => { const r = await fetch(u, init); return [r.status, await r.text()]; };

test('shim: the paths a pruned node can answer return esplora\'s own shapes; the RPC call carries the credentials', async () => {
  const { base, stop } = await startShim();
  try {
    bd.calls.length = 0;
    assert.deepEqual(await txt(base + '/btc/api/blocks/tip/height'), [200, '900000']);
    assert.deepEqual(await txt(base + '/btc/api/blocks/tip/hash'), [200, BLOCK]);
    assert.deepEqual(await txt(base + '/btc/api/block-height/899000'), [200, BLOCK]);
    assert.deepEqual(await txt(base + `/btc/api/block/${BLOCK}/header`), [200, HDR]);
    assert.deepEqual(JSON.parse((await txt(base + `/btc/api/block/${BLOCK}/status`))[1]), { in_best_chain: true, height: 899990, next_best: 'ab'.repeat(32) });
    const raw = await fetch(base + `/btc/api/block/${BLOCK}/raw`);
    assert.equal(raw.headers.get('content-type'), 'application/octet-stream'); assert.deepEqual([...Buffer.from(await raw.arrayBuffer())], [0xaa, 0xbb, 0xcc]);
    assert.match((await txt(base + `/btc/api/tx/${TXID}/hex`))[1], /^0200000001/);
    assert.deepEqual([...bd.authSeen], ['Basic ' + Buffer.from('tacit:pw').toString('base64')]);
    const ok = new Set(['getblockchaininfo', 'getblockcount', 'getbestblockhash', 'getblockhash', 'getblockheader', 'getblock', 'getrawtransaction', 'estimatesmartfee', 'sendrawtransaction']);
    assert.ok(bd.calls.every((m) => ok.has(m)), 'only read RPCs: ' + [...new Set(bd.calls)]);
  } finally { stop(); }
});

test('shim: an unknown block or transaction is a 404, an out-of-range height too, a node that errors is a 502', async () => {
  const { base, stop } = await startShim();
  try {
    assert.equal((await txt(base + `/btc/api/block/${'11'.repeat(32)}/header`))[0], 404);
    assert.equal((await txt(base + '/btc/api/block-height/999999999'))[0], 404, 'the node said height out of range');
    assert.equal((await txt(base + `/btc/api/tx/${'22'.repeat(32)}/hex`))[0], 404, 'not in the mempool and no index: not found, as a pruned node can only say');
  } finally { stop(); }
  const dead = http.createServer(); const dp = await listen(dead); await new Promise((r) => dead.close(r));
  const g = makeGateway({ btcRpcUrl: `http://127.0.0.1:${dp}`, btcRpcAuth: 'x:y' }); const port = await listen(g.server);
  try { assert.equal((await txt(`http://127.0.0.1:${port}/btc/api/blocks/tip/height`))[0], 502); } finally { g.server.close(); }
});

test('shim: fee estimates are sat/vB by target, a target with no estimate is left out, and one round of calls serves many requests', async () => {
  const { base, stop } = await startShim();
  try {
    bd.calls.length = 0;
    const a = JSON.parse((await txt(base + '/btc/api/fee-estimates'))[1]);
    await txt(base + '/btc/api/fee-estimates'); await txt(base + '/btc/api/fee-estimates');
    assert.equal(a['1'], 4, '0.00004 BTC/kvB = 4 sat/vB'); assert.equal(a['2'], 2); assert.equal(a['1008'], undefined);
    assert.equal(bd.calls.filter((m) => m === 'estimatesmartfee').length, 9, 'nine targets, once');
  } finally { stop(); }
});

test('shim: what a pruned node cannot know is 501, never a misleading 404 or an empty list', async () => {
  const { base, stop } = await startShim();
  try {
    for (const p of ['/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq/txs', '/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq/utxo', `/tx/${TXID}`, `/tx/${TXID}/status`, '/mempool/recent', `/block/${BLOCK}/txids`, '/blocks']) {
      assert.equal((await txt(base + '/btc/api' + p))[0], 501, p);
    }
    assert.equal((await txt(base + '/btc/api/admin'))[0], 404, 'and what is not an esplora read at all');
  } finally { stop(); }
});

test('shim: a node that is syncing, or whose newest block is hours old, answers 503 and says so on /health', async () => {
  bd.ibd = true;
  const a = await startShim();
  try {
    const r = await fetch(a.base + '/btc/api/blocks/tip/height'); assert.equal(r.status, 503); assert.equal(r.headers.get('retry-after'), '60');
    const h = await (await fetch(a.base + '/health')).json();
    assert.equal(h.ok, false); assert.equal(h.btc.syncing, true); assert.equal(h.btc.progress, 0.31);
  } finally { bd.ibd = false; a.stop(); }
  bd.ageSec = 5 * 3600;
  const b = await startShim();
  try { assert.equal((await fetch(b.base + '/btc/api/blocks/tip/hash')).status, 503, 'a tip five hours old is not the chain\'s tip'); } finally { bd.ageSec = 60; b.stop(); }
  const c = await startShim();
  try { assert.equal((await fetch(c.base + '/health')).status, 200); } finally { c.stop(); }
});

test('shim: POST /tx is refused unless broadcast is on; then the node\'s refusal reaches the caller in esplora\'s words', async () => {
  const hex = '02000000' + 'ab'.repeat(100);
  const off = await startShim();
  try { assert.equal((await fetch(off.base + '/btc/api/tx', { method: 'POST', body: hex })).status, 403); } finally { off.stop(); }
  const on = await startShim({ allowBroadcast: true });
  try {
    assert.deepEqual(await txt(on.base + '/btc/api/tx', { method: 'POST', body: hex }), [200, TXID]);
    assert.deepEqual(await txt(on.base + '/btc/api/tx', { method: 'POST', body: 'ff' + 'ab'.repeat(100) }), [400, 'sendrawtransaction RPC error -26: min relay fee not met']);
    assert.equal((await fetch(on.base + '/btc/api/tx', { method: 'POST', body: 'zz' })).status, 400);
  } finally { on.stop(); }
});

test.after(() => { ethNode.close(); btcNode.close(); bdNode.close(); });
