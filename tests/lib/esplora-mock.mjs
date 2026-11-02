// An esplora-shaped HTTP server over the Bitcoin simulator (chain-sim.mjs), so the LP's explorer adapter
// (fastbridge-lp/lib/btc-chain.mjs) runs against the same chain the machine tests use. Raw transactions posted to it
// are decoded and handed to the simulator; a reveal posted before its commit is refused as a node would refuse it.
// Needs Node 22.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const dsha = (b) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest();

// A segwit (or legacy) transaction in hex -> { txid, inputs, outputs } in the shape the simulator keeps.
export function decodeRawTx(hex) {
  const b = Buffer.from(hex, 'hex');
  let p = 0;
  const take = (n) => { const s = b.subarray(p, p + n); p += n; return s; };
  const varint = () => {
    const f = b[p++];
    if (f < 0xfd) return f;
    if (f === 0xfd) { const v = b.readUInt16LE(p); p += 2; return v; }
    if (f === 0xfe) { const v = b.readUInt32LE(p); p += 4; return v; }
    throw new Error('varint too large');
  };
  const version = take(4);
  const segwit = b[p] === 0 && b[p + 1] === 1;
  if (segwit) take(2);
  const bodyStart = p;
  const inputs = [];
  for (let i = varint(); i > 0; i--) {
    const txid = Buffer.from(take(32)).reverse().toString('hex'), vout = take(4).readUInt32LE(0);
    take(varint());
    inputs.push({ txid, vout, sequence: take(4).readUInt32LE(0), witness: [] });
  }
  const outputs = [];
  for (let i = varint(); i > 0; i--) {
    const value = Number(take(8).readBigUInt64LE(0));
    outputs.push({ value, script: Uint8Array.from(take(varint())) });
  }
  const bodyEnd = p;
  if (segwit) for (const i of inputs) for (let n = varint(); n > 0; n--) i.witness.push(Uint8Array.from(take(varint())));
  const locktime = take(4);
  if (p !== b.length) throw new Error('trailing bytes after the transaction');
  const txid = Buffer.from(dsha(Buffer.concat([version, b.subarray(bodyStart, bodyEnd), locktime]))).reverse().toString('hex');
  return { txid, inputs, outputs };
}

// `sim` is makeBitcoinSim(...); `addressUtxos(addr)` gives the plain coins an address holds.
export function startEsploraMock({ sim, addressUtxos = () => [], feeEstimates = { 1: 9, 3: 4, 6: 2 }, fail = null } = {}) {
  const commits = new Set();
  const state = { down: false, rejectRevealTimes: 0, posted: [], gets: [], posts: 0 };
  const send = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const missing = (res) => send(res, 400, 'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}', 'text/plain');

  async function postTx(req, res) {
    const chunks = []; for await (const c of req) chunks.push(c);
    state.posts++;
    let tx;
    try { tx = decodeRawTx(Buffer.concat(chunks).toString('utf8').trim()); } catch (e) { return send(res, 400, `TX decode failed: ${e.message}`, 'text/plain'); }
    if (sim.txs.has(tx.txid)) return send(res, 400, 'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}', 'text/plain');
    if (commits.has(tx.txid)) return send(res, 400, 'sendrawtransaction RPC error: {"code":-26,"message":"txn-already-in-mempool"}', 'text/plain');
    if (!tx.inputs.some((i) => commits.has(i.txid))) {
      // a transaction that spends something the simulator tracks, with no commit behind it, is a reveal sent too early
      if (tx.inputs.some((i) => sim.txs.has(i.txid))) return missing(res);
      commits.add(tx.txid); state.posted.push({ kind: 'commit', txid: tx.txid });
      return send(res, 200, tx.txid, 'text/plain');
    }
    if (state.rejectRevealTimes > 0) { state.rejectRevealTimes--; return missing(res); }
    try { await sim.broadcast({ revealTxid: tx.txid, revealTx: { inputs: tx.inputs, outputs: tx.outputs } }); } catch (e) { return send(res, 400, `sendrawtransaction RPC error: ${e.message}`, 'text/plain'); }
    state.posted.push({ kind: 'reveal', txid: tx.txid });
    return send(res, 200, tx.txid, 'text/plain');
  }

  async function get(path, res) {
    let m;
    if ((m = /^\/tx\/([0-9a-f]{64})$/.exec(path))) { const tx = await sim.fetchTx(m[1]); return tx ? send(res, 200, tx) : send(res, 404, 'Transaction not found', 'text/plain'); }
    if ((m = /^\/tx\/([0-9a-f]{64})\/status$/.exec(path))) {
      const s = await sim.status(m[1]);
      return send(res, 200, s.confirmations ? { confirmed: true, block_height: s.height, block_time: await sim.blockTime(s.height) } : { confirmed: false });
    }
    if ((m = /^\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/.exec(path))) {
      const by = await sim.outspend(m[1], Number(m[2]));
      return send(res, 200, by ? { spent: true, txid: by, vin: 0, status: { confirmed: true } } : { spent: false });
    }
    if (path === '/blocks/tip/height') return send(res, 200, String(sim.tip), 'text/plain');
    // a block's id carries its height, so /block/<id> needs no table
    if ((m = /^\/block-height\/(\d+)$/.exec(path))) return sim.blockTimes.has(Number(m[1])) ? send(res, 200, 'b'.repeat(60) + m[1], 'text/plain') : send(res, 404, 'Block not found', 'text/plain');
    if ((m = /^\/block\/b{60}(\d+)$/.exec(path))) return send(res, 200, { height: Number(m[1]), timestamp: await sim.blockTime(Number(m[1])) });
    if ((m = /^\/address\/([0-9a-z]+)\/utxo$/.exec(path))) return send(res, 200, addressUtxos(m[1]));
    if (path === '/fee-estimates') return send(res, 200, feeEstimates);
    return send(res, 404, 'not found', 'text/plain');
  }

  const server = createServer(async (req, res) => {
    try {
      if (state.down) return req.socket.destroy();
      const path = new URL(req.url, 'http://x').pathname;
      if (req.method === 'POST' && path === '/tx') return await postTx(req, res);
      if (req.method !== 'GET') return send(res, 405, 'method not allowed', 'text/plain');
      state.gets.push(path);
      if (fail && fail(path)) return send(res, 500, 'internal error', 'text/plain');
      return await get(path, res);
    } catch (e) { send(res, 500, String((e && e.message) || e), 'text/plain'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}`, state,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}
