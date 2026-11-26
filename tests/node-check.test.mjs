// tools/node-check.mjs: the check an own-node box has to pass before anything points at it. A good stub node (which also stands in for
// the public references) passes every role; then a stub broken in the ways real nodes break (behind, no old proofs, receipts pruned
// before the pool's deploy block, no CORS, admin API open, Bitcoin history pruned, bitcoind pruned) must fail exactly the role it breaks.
//
// Run: node --test tests/node-check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runChecks } from '../tools/node-check.mjs';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)); });
const HEAD = 26_000_000, BTC_TIP = 900_000;
const OLD_TX = 'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16';
const FROM = HEAD - 600_000;   // the pool's deploy block: about as far back as the real one is

const ethStub = (b = {}) => http.createServer(async (req, res) => {
  const cors = b.noCors ? {} : { 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const r = JSON.parse(await readBody(req));
  const ans = (q) => {
    const n = (x) => parseInt(x, 16);
    const head = HEAD - (b.lag || 0);
    switch (q.method) {
      case 'eth_chainId': return { result: b.chain || '0x1' };
      case 'eth_blockNumber': return { result: '0x' + head.toString(16) };
      case 'eth_getBalance': if (b.light && q.params[1] !== 'latest' && head - n(q.params[1]) > 32) return { error: { code: -32001, message: 'state unavailable' } }; return { result: '0x' + (10n ** 18n + BigInt(q.params[1] === 'latest' ? head : n(q.params[1]))).toString(16) };
      case 'eth_getLogs': {
        const { fromBlock, toBlock } = q.params[0];
        if (b.light && n(toBlock) - n(fromBlock) + 1 > 512) return { error: { code: -32602, message: 'log queries accept at most 512 blocks' } };
        if (b.prunedReceipts && n(fromBlock) < head - 20_000) return { result: [] };
        const k = Math.max(0, Math.floor((n(toBlock) - n(fromBlock)) / 10_000));
        return { result: Array.from({ length: k }, (_, i) => ({ transactionHash: '0x' + (n(fromBlock) + i).toString(16).padStart(64, '0') })) };
      }
      case 'eth_getProof': return (b.noOldProofs || b.light) && n(q.params[2]) < head - (b.light ? 32 : 200) ? { error: { code: -32000, message: 'distance to target block exceeds maximum proof window' } } : { result: { accountProof: ['0x01', '0x02'], storageHash: '0x' + '22'.repeat(32) } };
      case 'admin_nodeInfo': case 'txpool_content': return b.adminOpen ? { result: {} } : { error: { code: -32601, message: 'method not found' } };
      case 'debug_traceBlockByNumber': return b.adminOpen ? { result: [] } : { error: { code: -32601, message: 'method not found' } };
      default: return { error: { code: -32601, message: 'method not found' } };
    }
  };
  res.writeHead(200, { 'content-type': 'application/json', ...cors });
  res.end(JSON.stringify(Array.isArray(r) ? r.map((q) => ({ jsonrpc: '2.0', id: q.id, ...ans(q) })) : { jsonrpc: '2.0', id: r.id, ...ans(r) }));
});

const btcStub = (b = {}) => http.createServer(async (req, res) => {
  const cors = b.noCors ? {} : { 'access-control-allow-origin': req.headers.origin || '*' };
  const ok = (body, type = 'application/json') => { res.writeHead(200, { 'content-type': type, ...cors }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const u = req.url;
  if (req.method === 'POST') { await readBody(req); res.writeHead(400, { 'content-type': 'text/plain', ...cors }); return res.end('sendrawtransaction RPC error -22: TX decode failed'); }
  if (u === '/blocks/tip/height') return ok(String(BTC_TIP - (b.lag || 0)), 'text/plain');
  if (u.startsWith('/block-height/')) return ok('00'.repeat(31) + (b.badHash ? 'ff' : '01'), 'text/plain');
  if (u === `/tx/${OLD_TX}`) { if (b.pruned) { res.writeHead(404, cors); return res.end('Transaction not found'); } return ok({ txid: OLD_TX, status: { confirmed: true, block_height: 170 } }); }
  if (u === `/tx/${OLD_TX}/hex`) return ok('01000000' + 'ab'.repeat(200), 'text/plain');
  if (u.includes('/txs/chain/')) return ok([{ txid: 'bb'.repeat(32) }]);
  if (u.endsWith('/txs/chain')) return ok(Array.from({ length: 25 }, (_, i) => ({ txid: i.toString(16).padStart(64, 'a') })));
  if (u.endsWith('/utxo')) return ok([]);
  if (u === '/fee-estimates') return ok({ 1: 1.2, 2: 1.1 });
  if (u === '/mempool/recent') return ok([{ txid: 'cc'.repeat(32) }]);
  res.writeHead(404, cors); res.end();
});

const bitcoindStub = (b = {}) => http.createServer(async (req, res) => {
  const q = JSON.parse(await readBody(req));
  const result = q.method === 'getblockchaininfo' ? { chain: 'main', blocks: BTC_TIP, initialblockdownload: false, verificationprogress: 0.99999, pruned: !!b.pruned, bestblockhash: '11'.repeat(32) }
    : { tx: [{ vin: [{ coinbase: '00' }] }, { vin: [{ txid: 'aa'.repeat(32), prevout: b.noPrevout ? undefined : { scriptPubKey: { hex: '0014' } } }] }] };
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result, error: null, id: 1 }));
});

const prunedStub = (b = {}) => http.createServer(async (req, res) => {
  const q = JSON.parse(await readBody(req));
  const ok = (result) => ({ result, error: null });
  const bad = (code, message) => ({ result: null, error: { code, message } });
  const out = {
    getblockchaininfo: () => ok({ chain: 'main', blocks: BTC_TIP, initialblockdownload: !!b.ibd, verificationprogress: b.ibd ? 0.4 : 0.99999, pruned: b.pruned === false ? false : true, pruneheight: BTC_TIP - (b.keep ?? 20_000), bestblockhash: '11'.repeat(32) }),
    getblockhash: () => ok('00'.repeat(31) + (b.badHash ? 'ff' : '01')),
    getblock: () => ok({ tx: [{ vin: [{ coinbase: '00' }] }, { vin: [{ txid: 'aa'.repeat(32), prevout: b.noPrevout ? undefined : { scriptPubKey: { hex: '0014' } } }] }] }),
    estimatesmartfee: () => ok(b.noFees ? { errors: ['Insufficient data'], blocks: 0 } : { feerate: 0.00002, blocks: 2 }),
    getmempoolinfo: () => ok({ loaded: b.mempoolNotLoaded ? false : true, size: 5000 }),
    testmempoolaccept: () => (b.acceptsGarbage ? ok([{ allowed: true }]) : bad(-22, 'TX decode failed')),
  }[q.method];
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...(out ? out() : bad(-32601, 'Method not found')), id: q.id }));
});

const servers = [];
const up = async (s) => { servers.push(s); return `http://127.0.0.1:${await listen(s)}`; };
const refEth = await up(ethStub()), refBtc = await up(btcStub());
const refs = { ethRefs: [refEth], btcRefs: [refBtc], fromBlock: FROM, timeoutMs: 5000 };
const run = async ({ eth, btc, rpc } = {}) => runChecks({ ...refs, eth: eth && (await up(ethStub(eth))), btc: btc && (await up(btcStub(btc))), btcRpc: rpc && (await up(bitcoindStub(rpc))).replace('http://', 'http://u:p@'), broadcastPath: true });
const runPruned = async (rpc) => runChecks({ ...refs, btcRpc: (await up(prunedStub(rpc))).replace('http://', 'http://u:p@'), btcPruned: true });
const verdicts = (r) => Object.fromEntries(r.summary.map((s) => [s.role, s.verdict]));
const failed = (r) => r.checks.filter((c) => c.status === 'fail').map((c) => c.id);

test('a good node passes every role', async () => {
  const r = await run({ eth: {}, btc: {}, rpc: {} });
  assert.equal(r.ok, true, JSON.stringify(failed(r)));
  assert.deepEqual(verdicts(r), { 'eth-reads': 'PASS', 'eth-proofs': 'PASS', 'eth-wide-logs': 'PASS', 'eth-browser': 'PASS', 'btc-reads': 'PASS', 'btc-browser': 'PASS', 'btc-tweak-index': 'PASS' });
});

test('Ethereum: behind, wrong chain, no old proofs, pruned receipts, no CORS, open admin API each fail the role they break and no other', async () => {
  const behind = await run({ eth: { lag: 20 } });
  assert.equal(behind.ok, false); assert.deepEqual(failed(behind), ['head in step']); assert.equal(verdicts(behind)['eth-reads'], 'FAIL');
  const chain = await run({ eth: { chain: '0x5' } });
  assert.ok(failed(chain).includes('chain id'));
  const proofs = await run({ eth: { noOldProofs: true } });
  assert.deepEqual(failed(proofs), ['eth_getProof 2,400 blocks back']); assert.deepEqual([verdicts(proofs)['eth-proofs'], verdicts(proofs)['eth-reads']], ['FAIL', 'PASS']);
  const pruned = await run({ eth: { prunedReceipts: true } });
  assert.equal(verdicts(pruned)['eth-wide-logs'], 'FAIL'); assert.equal(verdicts(pruned)['eth-reads'], 'PASS', 'recent logs still fine');
  const cors = await run({ eth: { noCors: true } });
  assert.equal(verdicts(cors)['eth-browser'], 'FAIL'); assert.equal(verdicts(cors)['eth-reads'], 'PASS');
  const open = await run({ eth: { adminOpen: true } });
  assert.deepEqual(failed(open), ['no admin/debug/txpool API (tracing only on the keyed path)']);
});

test('Bitcoin: behind, wrong history, pruned history, no CORS fail; a node whose answers differ from the public ones fails the hash check', async () => {
  const lag = await run({ btc: { lag: 5 } });
  assert.ok(failed(lag).includes('tip in step'));
  const bad = await run({ btc: { badHash: true } });
  assert.deepEqual(failed(bad), ['block hash 10 back']);
  const pruned = await run({ btc: { pruned: true } });
  assert.ok(failed(pruned).includes('a block-170 transaction (history is not pruned)'));
  const cors = await run({ btc: { noCors: true } });
  assert.equal(verdicts(cors)['btc-browser'], 'FAIL'); assert.equal(verdicts(cors)['btc-reads'], 'PASS');
});

test('bitcoind: a pruned node, or one without prevouts in getblock, cannot feed the tweak index', async () => {
  const pruned = await run({ rpc: { pruned: true } });
  assert.deepEqual(failed(pruned), ['unpruned (undo data for every block)']);
  const nop = await run({ rpc: { noPrevout: true } });
  assert.deepEqual(failed(nop), ['getblock verbosity 3 carries prevouts']);
  const down = await runChecks({ btcRpc: 'http://u:secret@127.0.0.1:1', timeoutMs: 2000 });
  assert.equal(down.ok, false); assert.ok(!JSON.stringify(down).includes('secret'), 'the password never reaches the output');
});

test('a reference that does not answer makes a role UNVERIFIED, never PASS', async () => {
  const dead = http.createServer(); const url = await up(dead); await new Promise((r) => dead.close(r));
  const r = await runChecks({ eth: await up(ethStub()), ethRefs: [url], fromBlock: FROM, timeoutMs: 3000 });
  assert.equal(r.ok, true, 'nothing failed');
  assert.equal(verdicts(r)['eth-reads'], 'UNVERIFIED'); assert.equal(verdicts(r)['eth-wide-logs'], 'UNVERIFIED');
});

test('light client: judged on what it can serve (state 32 blocks, logs 512), and what it cannot is NOT PROVIDED rather than failed', async () => {
  const r = await runChecks({ ...refs, light: true, eth: await up(ethStub({ light: true })) });
  assert.equal(r.ok, true, JSON.stringify(failed(r)));
  assert.deepEqual(verdicts(r), { 'eth-reads': 'PASS', 'eth-proofs': 'NOT PROVIDED', 'eth-proofs-head': 'PASS', 'eth-wide-logs': 'NOT PROVIDED', 'eth-browser': 'PASS' });
  const names = r.checks.map((c) => c.id);
  assert.ok(names.includes('old state (16 blocks back)') && names.includes('logs, last 501 blocks'));
});

test('the same light client judged as a full node FAILS: the profile is not a way to pass', async () => {
  const r = await runChecks({ ...refs, eth: await up(ethStub({ light: true })) });
  assert.equal(r.ok, false);
  for (const id of ['old state (500 blocks back)', 'logs, last 10,000 blocks', 'eth_getProof 2,400 blocks back']) assert.ok(failed(r).includes(id), id + ' should fail: ' + failed(r));
});

test('light profile still fails a node that is behind or whose logs are wrong', async () => {
  const behind = await runChecks({ ...refs, light: true, eth: await up(ethStub({ light: true, lag: 20 })) });
  assert.deepEqual(failed(behind), ['head in step']);
});

test('pruned bitcoind: judged on headers, fees, mempool, broadcast and recent blocks; a full node or a syncing one is not a pruned node', async () => {
  const good = await runPruned({});
  assert.equal(good.ok, true, JSON.stringify(failed(good)));
  assert.deepEqual(verdicts(good), { 'btc-pruned-node': 'PASS' });
  assert.deepEqual(failed(await runPruned({ pruned: false })), ['pruned, with the recent blocks kept']);
  assert.deepEqual(failed(await runPruned({ keep: 100 })), ['pruned, with the recent blocks kept']);
  assert.deepEqual(failed(await runPruned({ ibd: true })), ['mainnet, synced']);
  assert.deepEqual(failed(await runPruned({ badHash: true })), ['block hash 10 back equals the public one']);
  assert.deepEqual(failed(await runPruned({ noPrevout: true })), ['recent block with prevouts (getblock verbosity 3)']);
  assert.deepEqual(failed(await runPruned({ noFees: true })), ['fee estimate']);
  assert.deepEqual(failed(await runPruned({ mempoolNotLoaded: true })), ['mempool loaded']);
  assert.deepEqual(failed(await runPruned({ acceptsGarbage: true })), ["broadcast path answers a malformed transaction with the node's reason"]);
});

// ── the keyed trace path: our gateway at /k/<key>/eth traces; /eth (the visitors' path) does not; public tracers stand as references ──
const POOL = '0x000000000ed1eabd231be41d93b719056f7febfc', PTX = '0x' + '5a'.repeat(32);
const traceStub = (b = {}) => http.createServer(async (req, res) => {
  const r = JSON.parse(await readBody(req));
  const keyed = req.url.startsWith('/k/');
  const ans = (q) => {
    if (q.method === 'eth_blockNumber') return { result: '0x' + HEAD.toString(16) };
    if (q.method === 'eth_getLogs') return b.noPoolTx ? { result: [] } : { result: [{ transactionHash: PTX }] };
    if (q.method === 'debug_traceTransaction' && (keyed || b.visitorTraces) && !b.noTrace) {
      if (typeof q.params[1]?.tracer === 'string' && q.params[1].tracer.includes('enter')) return { result: [{ to: POOL, input: b.otherInput || '0xabcd' }] };
      return { result: { type: 'CALL', to: POOL, input: b.otherInput || '0xabcd', calls: [] } };
    }
    return { error: { code: -32601, message: 'method not available here' } };
  };
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, ...ans(r) }));
});
const refTrace = await up(traceStub({ visitorTraces: true }));   // a public tracer traces for anyone
const runTrace = async (b) => runChecks({ ...refs, ethKey: (await up(traceStub(b))) + '/k/some-secret-key-0123456789/eth', traceRefs: [refTrace] });

test('eth-trace: the keyed path traces pool transactions as the public tracers do; the visitors\' path refuses; the key never reaches the output', async () => {
  const good = await runTrace({});
  assert.equal(verdicts(good)['eth-trace'], 'PASS', JSON.stringify(good.checks));
  assert.ok(!JSON.stringify(good).includes('some-secret-key'));
  assert.deepEqual(failed(await runTrace({ otherInput: '0xffff' })), ['a recent pool transaction', 'a pool transaction ~2 days old'], 'different pool calls from the public tracers');
  assert.ok(failed(await runTrace({ noTrace: true })).includes('a recent pool transaction'));
  assert.deepEqual(failed(await runTrace({ visitorTraces: true })), ["the visitors' path refuses tracing"]);
  assert.equal(verdicts(await runTrace({ noPoolTx: true }))['eth-trace'], 'UNVERIFIED', 'nothing to trace is not a pass');
  const noRef = await runChecks({ ...refs, ethKey: (await up(traceStub())) + '/k/some-secret-key-0123456789/eth', traceRefs: ['http://127.0.0.1:1'] });
  assert.equal(verdicts(noRef)['eth-trace'], 'UNVERIFIED');
});

// ── btc-index: bitcoind + electrs behind the gateway, compared read by read with a public esplora ──
const HAL = '1Q2TWHE3GMdB6BZKafqwxXtWAWgFt5Jvm3';
const indexStub = (b = {}) => http.createServer((req, res) => {
  const ok = (body) => { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const u = req.url;
  if (u === `/tx/${OLD_TX}`) return ok({ txid: OLD_TX, fee: b.badFee ? 1 : 0, vout: [{ value: 1e9, scriptpubkey_asm: b.otherAsm ? 'x' : 'y' }], status: { confirmed: true, block_height: 170 } });
  if (u === `/tx/${OLD_TX}/outspends`) return ok([{ spent: true, txid: 'cd'.repeat(32), vin: 0 }, { spent: true, txid: 'ef'.repeat(32), vin: 1 }]);
  if (u === `/tx/${OLD_TX}/merkle-proof`) return ok({ block_height: 170, merkle: ['aa'], pos: 1 });
  if (u === `/address/${HAL}`) return ok({ address: HAL, chain_stats: { tx_count: 26, funded_txo_count: 20, spent_txo_count: b.badStats ? 3 : 19 } });
  if (u === `/address/${HAL}/utxo`) return ok([{ txid: 'ab'.repeat(32), vout: 0, value: 5 }]);
  if (u === `/address/${HAL}/txs/chain`) return ok(Array.from({ length: 25 }, (_, i) => ({ txid: i.toString(16).padStart(64, 'a') })));
  if (u.startsWith(`/address/${HAL}/txs/chain/`)) return ok(b.shortPages ? [] : [{ txid: 'bb'.repeat(32) }]);
  if (u === '/v1/fees/recommended') return ok({ fastestFee: 3, halfHourFee: 2, hourFee: 2, economyFee: 1, minimumFee: 1 });
  if (u === '/mempool') return ok({ count: 1000, vsize: 1, total_fee: 1, fee_histogram: [] });
  res.writeHead(404); res.end();
});
const refIndex = await up(indexStub());
const runIndex = async (b) => runChecks({ timeoutMs: 5000, btc: await up(indexStub(b)), btcRefs: [refIndex], btcIndex: true });

test('btc-index: every read the pages use equals the public esplora\'s (the *_asm fields aside); a wrong fee, stats or a short history fails', async () => {
  const good = await runIndex({});
  assert.equal(verdicts(good)['btc-index'], 'PASS', JSON.stringify(good.checks.filter((c) => c.role === 'btc-index')));
  assert.equal(verdicts(await runIndex({ otherAsm: true }))['btc-index'], 'PASS', 'asm text is not compared');
  const fee = await runIndex({ badFee: true });
  assert.deepEqual(fee.checks.filter((c) => c.role === 'btc-index' && c.status === 'fail').map((c) => c.id), ['a transaction, whole (fee, prevouts, status)']);
  assert.ok(failed(await runIndex({ badStats: true })).includes('address stats'));
  assert.ok(failed(await runIndex({ shortPages: true })).includes('every history page, to the end'));
  assert.ok(good.checks.some((c) => c.id === 'mempool/recent' && c.status === 'skip'), '/mempool/recent is NOT PROVIDED, not failed');
});

test.after(() => servers.forEach((s) => s.close()));
