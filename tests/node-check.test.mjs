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
      case 'eth_getBalance': return { result: '0x' + (10n ** 18n + BigInt(q.params[1] === 'latest' ? head : n(q.params[1]))).toString(16) };
      case 'eth_getLogs': {
        const { fromBlock, toBlock } = q.params[0];
        if (b.prunedReceipts && n(fromBlock) < head - 20_000) return { result: [] };
        const k = Math.max(0, Math.floor((n(toBlock) - n(fromBlock)) / 10_000));
        return { result: Array.from({ length: k }, (_, i) => ({ transactionHash: '0x' + (n(fromBlock) + i).toString(16).padStart(64, '0') })) };
      }
      case 'eth_getProof': return b.noOldProofs && n(q.params[2]) < head - 200 ? { error: { code: -32000, message: 'distance to target block exceeds maximum proof window' } } : { result: { accountProof: ['0x01', '0x02'], storageHash: '0x' + '22'.repeat(32) } };
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

const servers = [];
const up = async (s) => { servers.push(s); return `http://127.0.0.1:${await listen(s)}`; };
const refEth = await up(ethStub()), refBtc = await up(btcStub());
const refs = { ethRefs: [refEth], btcRefs: [refBtc], fromBlock: FROM, timeoutMs: 5000 };
const run = async ({ eth, btc, rpc } = {}) => runChecks({ ...refs, eth: eth && (await up(ethStub(eth))), btc: btc && (await up(btcStub(btc))), btcRpc: rpc && (await up(bitcoindStub(rpc))).replace('http://', 'http://u:p@'), broadcastPath: true });
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
  assert.deepEqual(failed(open), ['no admin/debug/txpool API']);
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

test.after(() => servers.forEach((s) => s.close()));
