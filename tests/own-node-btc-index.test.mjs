// own-nodes/btc-index.mjs behind own-nodes/gateway.mjs (ELECTRUM_URL): esplora's read paths from an unpruned bitcoind + electrs, against a stub
// bitcoind (JSON-RPC, batches) and a stub electrs (the Electrum protocol on a real socket). What it pins: a real esplora transaction comes out in
// esplora's shape from bitcoind's JSON; addresses decode to their scripts (and to electrs' scripthash); history pages, utxo and stats match
// esplora's rules; outspends find the spender, in a block or the mempool, and an output that is gone with no spender indexed is a 503, not
// "unspent"; what this node cannot serve is 501; the node's errors are esplora's 404s; electrs down is a 502 and /health counts the index's lag.
//
// Run: node --test tests/own-node-btc-index.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { makeGateway } from '../own-nodes/gateway.mjs';
import { esploraTx, addressScript, electrumHash, makeBtcIndex, makeElectrum } from '../own-nodes/btc-index.mjs';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const body = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)); });

test('a real esplora transaction comes back in esplora\'s shape from bitcoind\'s verbosity-2 JSON (the *_asm fields left out)', () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/esplora-tx-json-2026-10-19.json', import.meta.url)));
  const TYPE = { p2pkh: 'pubkeyhash', p2sh: 'scripthash', v0_p2wpkh: 'witness_v0_keyhash', v0_p2wsh: 'witness_v0_scripthash', v1_p2tr: 'witness_v1_taproot', op_return: 'nulldata' };
  const btc = (s) => Number((s / 1e8).toFixed(8));
  const sp = (o) => ({ hex: o.scriptpubkey, type: TYPE[o.scriptpubkey_type] || 'nonstandard', ...(o.scriptpubkey_address ? { address: o.scriptpubkey_address } : {}) });
  const noAsm = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k.endsWith('_asm') ? undefined : v)));
  for (const k of Object.keys(fx)) {
    const e = typeof fx[k].json === 'string' ? JSON.parse(fx[k].json) : fx[k].json;
    // what bitcoind says for the same transaction (getrawtransaction <txid> 2)
    const v = {
      txid: e.txid, hash: e.txid, version: e.version, size: e.size, vsize: Math.ceil(e.weight / 4), weight: e.weight, locktime: e.locktime,
      vin: e.vin.map((i) => ({ txid: i.txid, vout: i.vout, scriptSig: { asm: '', hex: i.scriptsig }, txinwitness: i.witness, prevout: { generated: false, height: 1, value: btc(i.prevout.value), scriptPubKey: sp(i.prevout) }, sequence: i.sequence })),
      vout: e.vout.map((o, n) => ({ value: btc(o.value), n, scriptPubKey: sp(o) })),
      fee: btc(e.fee), hex: fx[k].hex, blockhash: e.status.block_hash, confirmations: 10, blocktime: e.status.block_time,
    };
    assert.deepEqual(esploraTx(v, e.status), noAsm(e), k);
  }
});

test('addresses decode to their scripts, and to the electrum scripthash; a bad checksum or another network is refused', () => {
  assert.equal(addressScript('bc1qz0urr5r0u8ezuc8j80w2nmwuheujzj4nd6pm9n'), '001413f831d06fe1f22e60f23bdca9eddcbe79214ab3');
  assert.equal(addressScript('bc1px4a8y2rah849ru2v4wfq6curcfljary3nxrpzkqjfakdslhul4zs97ge8y'), '5120357a72287db9ea51f14cab920d6383c27f2e8c9199861158124f6cd87efcfd45');
  assert.equal(addressScript('BC1QZ0URR5R0U8EZUC8J80W2NMWUHEUJZJ4ND6PM9N'), '001413f831d06fe1f22e60f23bdca9eddcbe79214ab3');
  assert.equal(addressScript('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac');
  assert.equal(addressScript('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), 'a914b472a266d0bd89c13706a4132ccfb16f7c3b9fcb87');
  assert.equal(electrumHash(addressScript('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')), '8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161', 'the Electrum protocol docs\' example');
  for (const bad of ['bc1qz0urr5r0u8ezuc8j80w2nmwuheujzj4nd6pm9m', 'tb1qz0urr5r0u8ezuc8j80w2nmwuheujzj4nd6pm9n', 'bc1Qz0urr5r0u8ezuc8j80w2nmwuheujzj4nd6pm9n', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
    'bc1pz0urr5r0u8ezuc8j80w2nmwuheujzj4nd6pm9n']) assert.equal(addressScript(bad), null, bad);
});

// ── a small chain: 30 confirmed transactions to one address, each spending the one before it, and one in the mempool spending the last ──
const ADDR = 'bc1qz0urr5r0u8ezuc8j80w2nmwuheujzj4nd6pm9n', S = '001413f831d06fe1f22e60f23bdca9eddcbe79214ab3', SH = electrumHash(S);
const TIP = 200;
const id = (k) => k.toString(16).padStart(2, '0').repeat(32);
const bh = (h) => h.toString(16).padStart(64, '0');
const out = (v) => ({ value: v / 1e8, scriptPubKey: { hex: S, type: 'witness_v0_keyhash', address: ADDR } });
const TXS = new Map();
for (let k = 1; k <= 31; k++) {
  const prev = k === 1 ? { txid: 'ee'.repeat(32), vout: 0, prevout: { value: 0.00002, scriptPubKey: { hex: '0014' + 'ee'.repeat(20), type: 'witness_v0_keyhash', address: 'bc1qother' } } } : { txid: id(k - 1), vout: 0, prevout: out(1000) };
  TXS.set(id(k), { txid: id(k), version: 2, locktime: 0, size: 200, weight: 600, vin: [{ ...prev, scriptSig: { hex: '' }, txinwitness: ['ab'], sequence: 4294967293 }], vout: [{ ...out(1000), n: 0 }], fee: 0.000005,
    ...(k <= 30 ? { blockhash: bh(99 + k), confirmations: TIP - (99 + k) + 1, blocktime: 1_700_000_000 + k } : {}) });
}
const bd = { calls: [], ibd: false };
const bdNode = http.createServer(async (req, res) => {
  const q = JSON.parse(await body(req));
  const one = (r) => {
    bd.calls.push(r.method);
    const p = r.params || [];
    const ok = (result) => ({ result, error: null, id: r.id });
    const err = (code, message) => ({ result: null, error: { code, message }, id: r.id });
    switch (r.method) {
      case 'getblockchaininfo': return ok({ chain: 'main', blocks: TIP, headers: TIP, initialblockdownload: bd.ibd, time: Math.floor(Date.now() / 1000) - 60, verificationprogress: 1 });
      case 'getblockcount': return ok(TIP);
      case 'getbestblockhash': return ok(bh(TIP));
      case 'getblockhash': return p[0] > TIP ? err(-8, 'Block height out of range') : ok(bh(p[0]));
      case 'getblockheader': { const h = parseInt(p[0], 16); if (!(h <= TIP)) return err(-5, 'Block not found'); return ok(p[1] === false ? '00'.repeat(80) : { hash: p[0], height: h, time: 1_700_000_000 + h, confirmations: TIP - h + 1, ...(h < TIP ? { nextblockhash: bh(h + 1) } : {}) }); }
      case 'getblock': { const h = parseInt(p[0], 16); if (!(h <= TIP)) return err(-5, 'Block not found'); return ok({ hash: p[0], height: h, version: 0x20000000, time: 1_700_000_000 + h, mediantime: 1_700_000_000 + h - 600, nonce: 7, bits: '17034219', difficulty: 1.5, nTx: 2, size: 1000, weight: 4000, merkleroot: 'cd'.repeat(32), previousblockhash: bh(h - 1), confirmations: TIP - h + 1, tx: [id(1), id(2)] }); }
      case 'getrawtransaction': { const t = TXS.get(p[0]); if (!t) return err(-5, 'No such mempool or blockchain transaction'); if (p[1] === 0 || p[1] === false) return ok('0200000001' + 'ab'.repeat(60)); if (p[1] === 1) { const { fee, ...v1 } = t; return ok({ ...v1, vin: v1.vin.map(({ prevout, ...i }) => i) }); } return ok(t); }
      case 'gettxout': return ok(p[0] === id(31) && p[1] === 0 ? { value: 0.00001 } : null);
      case 'getmempoolentry': return p[0] === id(31) ? ok({ vsize: 150 }) : err(-5, 'Transaction not in mempool');
      case 'estimatesmartfee': return ok({ 1: { feerate: 0.0000412 }, 3: { feerate: 0.00003 }, 6: { feerate: 0.000021 }, 144: { feerate: 0.000001 } }[p[0]] || { feerate: 0.00001 });
      case 'getmempoolinfo': return ok({ size: 4200, bytes: 1_500_000, total_fee: 0.05, mempoolminfee: 0.000001 });
      case 'getrawmempool': return ok([id(31)]);
      default: return err(-32601, 'Method not found');
    }
  };
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(q) ? q.map(one).reverse() : one(q)));
});
const ex = { calls: [], indexTip: TIP, sockets: new Set() };
const exNode = net.createServer((s) => {
  ex.sockets.add(s); s.on('close', () => ex.sockets.delete(s));
  let buf = '';
  s.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const r = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      ex.calls.push(r.method);
      const p = r.params || [];
      let result = null, error = null;
      if (r.method === 'server.version') result = ['stub', '1.4'];
      else if (r.method === 'blockchain.scripthash.get_history') { if (p[0] === SH) result = [...Array(30)].map((_, k) => ({ tx_hash: id(k + 1), height: 100 + k })).concat([{ tx_hash: id(31), height: 0, fee: 500 }]); else if (p[0] === 'f'.repeat(64)) error = { code: 1, message: 'too many txs' }; else result = []; }
      else if (r.method === 'blockchain.scripthash.listunspent') result = p[0] === SH ? [{ tx_hash: id(31), tx_pos: 0, height: 0, value: 1000 }, { tx_hash: id(5), tx_pos: 1, height: 104, value: 77 }] : [];
      else if (r.method === 'blockchain.transaction.get_merkle') result = { block_height: p[1], merkle: ['aa'.repeat(32)], pos: 3 };
      else if (r.method === 'blockchain.headers.subscribe') result = { height: ex.indexTip, hex: '' };
      else if (r.method === 'mempool.get_fee_histogram') result = [[2, 100000], [1, 200000]];
      else error = { code: -32601, message: 'unknown method' };
      s.write(JSON.stringify(error ? { jsonrpc: '2.0', id: r.id, error } : { jsonrpc: '2.0', id: r.id, result }) + '\n');
    }
  });
});
const bdPort = await listen(bdNode), exPort = await listen(exNode);
const start = async (o = {}) => {
  const g = makeGateway({ btcRpcUrl: `http://127.0.0.1:${bdPort}`, btcRpcAuth: 'tacit:pw', electrumUrl: `tcp://127.0.0.1:${exPort}`, origins: ['https://tacit.finance'], ...o });
  const port = await listen(g.server);
  return { base: `http://127.0.0.1:${port}/btc/api`, root: `http://127.0.0.1:${port}`, stop: () => g.server.close() };
};
const get = async (u) => { const r = await fetch(u); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* text */ } return { status: r.status, text: t, json: j, type: r.headers.get('content-type') }; };

test('transactions, their status, hex, outspends: a spender in a block, one in the mempool, an unspent output, an unknown transaction', async () => {
  const { base, stop } = await start();
  try {
    const t = (await get(`${base}/tx/${id(30)}`)).json;
    assert.equal(t.txid, id(30)); assert.equal(t.fee, 500); assert.equal(t.vout[0].value, 1000); assert.equal(t.vout[0].scriptpubkey_type, 'v0_p2wpkh');
    assert.deepEqual(t.vin[0].prevout, { scriptpubkey: S, scriptpubkey_type: 'v0_p2wpkh', scriptpubkey_address: ADDR, value: 1000 });
    assert.deepEqual(t.status, { confirmed: true, block_height: 129, block_hash: bh(129), block_time: 1_700_000_030 });
    assert.deepEqual((await get(`${base}/tx/${id(31)}/status`)).json, { confirmed: false });
    assert.match((await get(`${base}/tx/${id(3)}/hex`)).text, /^0200000001/);
    assert.deepEqual((await get(`${base}/tx/${id(29)}/outspend/0`)).json, { spent: true, txid: id(30), vin: 0, status: { confirmed: true, block_height: 129, block_hash: bh(129), block_time: 1_700_000_030 } });
    assert.deepEqual((await get(`${base}/tx/${id(30)}/outspends`)).json, [{ spent: true, txid: id(31), vin: 0, status: { confirmed: false } }]);
    assert.deepEqual((await get(`${base}/tx/${id(31)}/outspend/0`)).json, { spent: false });
    assert.equal((await get(`${base}/tx/${id(31)}/outspend/5`)).status, 404);
    const nf = await get(`${base}/tx/${'99'.repeat(32)}`);
    assert.equal(nf.status, 404); assert.equal(nf.text, 'Transaction not found');
    assert.deepEqual((await get(`${base}/tx/${id(10)}/merkle-proof`)).json, { block_height: 109, merkle: ['aa'.repeat(32)], pos: 3 });
  } finally { stop(); }
});

test('address: history pages newest first (mempool, then 25 confirmed), the next page from the last txid, utxo with status, stats from the history', async () => {
  const { base, stop } = await start();
  try {
    const p1 = (await get(`${base}/address/${ADDR}/txs`)).json;
    assert.deepEqual(p1.map((t) => t.txid), [id(31), ...[...Array(25)].map((_, i) => id(30 - i))]);
    const c1 = (await get(`${base}/address/${ADDR}/txs/chain`)).json;
    assert.equal(c1.length, 25); assert.equal(c1[0].txid, id(30));
    const c2 = (await get(`${base}/address/${ADDR}/txs/chain/${c1[24].txid}`)).json;
    assert.deepEqual(c2.map((t) => t.txid), [id(5), id(4), id(3), id(2), id(1)]);
    assert.deepEqual((await get(`${base}/address/${ADDR}/txs/chain/${id(1)}`)).json, []);
    assert.deepEqual((await get(`${base}/address/${ADDR}/txs/mempool`)).json.map((t) => t.txid), [id(31)]);
    assert.deepEqual((await get(`${base}/address/${ADDR}/utxo`)).json, [
      { txid: id(31), vout: 0, status: { confirmed: false }, value: 1000 },
      { txid: id(5), vout: 1, status: { confirmed: true, block_height: 104, block_hash: bh(104), block_time: 1_700_000_104 }, value: 77 },
    ]);
    assert.deepEqual((await get(`${base}/address/${ADDR}`)).json, {
      address: ADDR,
      chain_stats: { funded_txo_count: 30, funded_txo_sum: 30000, spent_txo_count: 29, spent_txo_sum: 29000, tx_count: 30 },
      mempool_stats: { funded_txo_count: 1, funded_txo_sum: 1000, spent_txo_count: 1, spent_txo_sum: 1000, tx_count: 1 },
    });
    const plain = (await import('node:crypto')).createHash('sha256').update(Buffer.from(S, 'hex')).digest('hex');   // esplora's scripthash: sha256 of the script, not reversed
    assert.equal((await get(`${base}/scripthash/${plain}/txs/chain`)).json.length, 25);
    assert.equal((await get(`${base}/scripthash/${plain}`)).json.chain_stats.spent_txo_count, 29);
    assert.equal((await get(`${base}/address/bc1qz0urr5r0u8ezuc8j80w2nmwuheujzj4nd6pm9m/txs`)).status, 400, 'bad checksum');
  } finally { stop(); }
});

test('blocks, tip, fees in esplora\'s and mempool.space\'s shapes; the mempool summary', async () => {
  const { base, stop } = await start();
  try {
    assert.equal((await get(`${base}/blocks/tip/height`)).text, String(TIP));
    assert.equal((await get(`${base}/blocks/tip/hash`)).text, bh(TIP));
    assert.equal((await get(`${base}/block-height/150`)).text, bh(150));
    assert.equal((await get(`${base}/block-height/999`)).status, 404);
    assert.deepEqual((await get(`${base}/block/${bh(150)}`)).json, { id: bh(150), height: 150, version: 0x20000000, timestamp: 1_700_000_150, tx_count: 2, size: 1000, weight: 4000, merkle_root: 'cd'.repeat(32), previousblockhash: bh(149), mediantime: 1_699_999_550, nonce: 7, bits: 0x17034219, difficulty: 1.5 });
    assert.deepEqual((await get(`${base}/block/${bh(150)}/txids`)).json, [id(1), id(2)]);
    assert.deepEqual((await get(`${base}/block/${bh(150)}/status`)).json, { in_best_chain: true, height: 150, next_best: bh(151) });
    assert.equal((await get(`${base}/block/${bh(150)}/header`)).text, '00'.repeat(80));
    assert.deepEqual((await get(`${base}/blocks`)).json.map((b) => b.height), [200, 199, 198, 197, 196, 195, 194, 193, 192, 191]);
    assert.deepEqual((await get(`${base}/v1/fees/recommended`)).json, { fastestFee: 5, halfHourFee: 3, hourFee: 3, economyFee: 1, minimumFee: 1 });
    assert.equal((await get(`${base}/fee-estimates`)).json['1'], 4.12);
    assert.deepEqual((await get(`${base}/mempool`)).json, { count: 4200, vsize: 1_500_000, total_fee: 5_000_000, fee_histogram: [[2, 100000], [1, 200000]] });
    assert.deepEqual((await get(`${base}/mempool/txids`)).json, [id(31)]);
  } finally { stop(); }
});

test('what this node cannot serve is 501; what is not an esplora read is 404; only read RPCs reach bitcoind', async () => {
  const { base, stop } = await start();
  try {
    bd.calls.length = 0;
    for (const p of ['/mempool/recent', `/block/${bh(150)}/txs`, `/scripthash/${'f'.repeat(64)}/txs`]) assert.equal((await get(base + p)).status, 501, p);
    assert.equal((await get(base + '/admin')).status, 404);
    await get(`${base}/address/${ADDR}`); await get(`${base}/tx/${id(30)}/outspends`);
    const ok = new Set(['getblockchaininfo', 'getblockcount', 'getbestblockhash', 'getblockhash', 'getblockheader', 'getblock', 'getrawtransaction', 'gettxout', 'getmempoolentry', 'estimatesmartfee', 'getmempoolinfo', 'getrawmempool']);
    assert.ok(bd.calls.every((m) => ok.has(m)), [...new Set(bd.calls)].join());
  } finally { stop(); }
  const ix = makeBtcIndex({ rpc: async () => { throw new Error('x'); }, rpcBatch: async () => [], electrum: { call: async () => [...Array(11)].map((_, k) => ({ tx_hash: id(k + 1), height: 100 + k })) }, historyMax: 10 });
  await assert.rejects(ix.serve(`/address/${ADDR}`), (e) => e.status === 501, 'stats of a history over historyMax');
});

test('an output gone from the UTXO set with no spender indexed yet is 503 (index behind), never "unspent"', async () => {
  const v = { txid: id(7), vout: [{ value: 0.00001, n: 0, scriptPubKey: { hex: S, type: 'witness_v0_keyhash' } }], blockhash: bh(106), confirmations: 95 };
  const rpc = async (m) => (m === 'getrawtransaction' ? v : m === 'gettxout' ? null : m === 'getblockheader' ? { height: 106, time: 1, confirmations: 95 } : null);
  const ix = makeBtcIndex({ rpc, rpcBatch: async (c) => c.map(() => ({ txid: id(9), vin: [{ txid: id(8), vout: 0 }] })), electrum: { call: async () => [{ tx_hash: id(9), height: 110 }] } });
  await assert.rejects(ix.serve(`/tx/${id(7)}/outspend/0`), (e) => e.status === 503);
});

test('syncing bitcoind is 503; electrs down is a 502 for address reads while transactions still answer; /health counts the index\'s lag', async () => {
  bd.ibd = true;
  const a = await start();
  try { assert.equal((await get(`${a.base}/tx/${id(3)}`)).status, 503); } finally { bd.ibd = false; a.stop(); }
  ex.indexTip = TIP - 5;
  const b = await start();
  try {
    const h = await (await fetch(b.root + '/health')).json();
    assert.equal(h.ok, false); assert.equal(h.btc.indexBehind, 5);
  } finally { ex.indexTip = TIP; b.stop(); }
  const dead = net.createServer(); const dp = await listen(dead); await new Promise((r) => dead.close(r));
  const c = await start({ electrumUrl: `tcp://127.0.0.1:${dp}` });
  try {
    assert.equal((await get(`${c.base}/address/${ADDR}/txs`)).status, 502);
    assert.equal((await get(`${c.base}/tx/${id(3)}`)).status, 200);
    const h = await (await fetch(c.root + '/health')).json();
    assert.equal(h.ok, false); assert.equal(h.btc.indexBehind, null);
  } finally { c.stop(); }
});

test('the electrum client survives electrs restarting', async () => {
  const e = makeElectrum(`tcp://127.0.0.1:${exPort}`, { timeoutMs: 2000 });
  try {
    assert.equal((await e.call('blockchain.headers.subscribe')).height, TIP);
    for (const s of ex.sockets) s.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await e.call('blockchain.headers.subscribe')).height, TIP);
  } finally { e.close(); }
});

test('no trace: address and transaction reads write nothing to stdout or stderr', async () => {
  const { base, stop } = await start();
  const w = [process.stdout.write, process.stderr.write]; const seen = [];
  process.stdout.write = (c, ...r) => { seen.push(String(c)); return true; }; process.stderr.write = (c, ...r) => { seen.push(String(c)); return true; };
  try { await get(`${base}/address/${ADDR}/txs`); await get(`${base}/tx/${id(30)}/outspends`); await get(`${base}/address/${ADDR}/utxo`); }
  finally { [process.stdout.write, process.stderr.write] = w; stop(); }
  assert.ok(!seen.some((s) => s.includes(ADDR) || s.includes(id(30))), seen.join('').slice(0, 200));
});

test.after(() => { bdNode.close(); for (const s of ex.sockets) s.destroy(); exNode.close(); });
