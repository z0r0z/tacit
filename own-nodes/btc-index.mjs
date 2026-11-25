// Esplora's read paths from an UNPRUNED bitcoind (txindex=1) plus a light address index (romanz/electrs, the Electrum protocol), for the
// gateway (gateway.mjs, ELECTRUM_URL). The pages speak esplora; Blockstream's esplora index is ~1 TB more disk, this one is tens of GB.
//
// Where each answer comes from:
//   transactions, their status, hex/raw, blocks, headers, tip, fees, mempool  bitcoind (getrawtransaction verbosity 2 carries prevouts and the fee)
//   address/scripthash history, utxo, stats                                 electrs (history, listunspent) + bitcoind for the transactions themselves
//   outspend(s)                                                              bitcoind gettxout (unspent?) and, for a spent output, the spender found in
//                                                                            the history of the output's own script (electrs)
//   merkle-proof                                                             electrs blockchain.transaction.get_merkle (esplora's own shape)
// Not provided (501, the pages keep the public explorers behind us): /mempool/recent, /block/<hash>/txs, an address whose history is longer than
// historyMax (its stats would cost a lookup per transaction). The *_asm fields are left out (nothing of ours reads them).
//
// Privacy as in gateway.mjs: no log of any request. Kept in memory, with nothing about who asked: block facts by hash/height, confirmed transactions
// (LRU), and an address's history for a few seconds so that paging through it does not ask electrs again for every page.
import net from 'node:net';
import crypto from 'node:crypto';

const HEX64 = /^[0-9a-f]{64}$/;
const sats = (btc) => Math.round(Number(btc) * 1e8);
const rev = (hex) => hex.match(/../g).reverse().join('');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

// ── addresses -> scriptPubKey (mainnet), no dependencies ──────────────────────────────────────────────────────────────────────────────
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const polymod = (v) => { let c = 1; for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3][i]; } return c >>> 0; };
const convert = (data, from, to, pad) => { let acc = 0, bits = 0; const out = []; for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >>> bits) & ((1 << to) - 1)); } } if (pad && bits) out.push((acc << (to - bits)) & ((1 << to) - 1)); else if (!pad && (bits >= from || ((acc << (to - bits)) & ((1 << to) - 1)))) return null; return out; };
function segwitScript(addr) {
  const a = addr.toLowerCase();
  if (addr !== a && addr !== addr.toUpperCase()) return null;
  const pos = a.lastIndexOf('1');
  if (a.slice(0, pos) !== 'bc' || a.length > 90) return null;
  const data = [...a.slice(pos + 1)].map((ch) => B32.indexOf(ch));
  if (data.length < 7 || data.some((x) => x < 0)) return null;
  const chk = polymod([...[...'bc'].map((ch) => ch.charCodeAt(0) >> 5), 0, ...[...'bc'].map((ch) => ch.charCodeAt(0) & 31), ...data]);
  const ver = data[0];
  if (chk !== (ver === 0 ? 1 : 0x2bc830a3)) return null;
  const prog = convert(data.slice(1, -6), 5, 8, false);
  if (!prog || prog.length < 2 || prog.length > 40 || ver > 16 || (ver === 0 && prog.length !== 20 && prog.length !== 32)) return null;
  return (ver === 0 ? '00' : (0x50 + ver).toString(16)) + prog.length.toString(16).padStart(2, '0') + Buffer.from(prog).toString('hex');
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Script(addr) {
  let n = 0n;
  for (const ch of addr) { const i = B58.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const bytes = Buffer.concat([Buffer.alloc(addr.match(/^1*/)[0].length), Buffer.from(hex, 'hex')]);
  if (bytes.length !== 25) return null;
  const body = bytes.subarray(0, 21);
  if (!sha256(sha256(body)).subarray(0, 4).equals(bytes.subarray(21))) return null;
  const h = body.subarray(1).toString('hex');
  return body[0] === 0x00 ? `76a914${h}88ac` : body[0] === 0x05 ? `a914${h}87` : null;
}
export const addressScript = (addr) => (/^bc1/i.test(addr) ? segwitScript(addr) : base58Script(addr));
export const electrumHash = (scriptHex) => rev(sha256(Buffer.from(scriptHex, 'hex')).toString('hex'));

// ── an Electrum protocol client: one connection, newline-delimited JSON-RPC, answers matched by id ─────────────────────────────────────
export function makeElectrum(url, { timeoutMs = 30_000 } = {}) {
  const u = new URL(url);
  let sock = null, buf = '', id = 0;
  const pending = new Map();
  const fail = (err) => { for (const [, p] of pending) { clearTimeout(p.t); p.reject(err); } pending.clear(); };
  const connect = () => new Promise((resolve, reject) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port) });
    s.setEncoding('utf8');
    s.once('connect', () => { sock = s; resolve(s); });
    s.once('error', (e) => { if (sock !== s) reject(e); });
    s.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let j; try { j = JSON.parse(line); } catch { continue; }
        for (const m of Array.isArray(j) ? j : [j]) { const p = pending.get(m.id); if (!p) continue; pending.delete(m.id); clearTimeout(p.t); m.error ? p.reject(Object.assign(new Error(String(m.error.message || m.error)), { electrum: true })) : p.resolve(m.result); }
      }
    });
    s.on('close', () => { if (sock === s) { sock = null; buf = ''; fail(new Error('electrum connection closed')); } });
  });
  let opening = null;
  const ready = async () => {
    if (sock) return sock;
    opening ||= connect().then(async (s) => { opening = null; await send('server.version', ['tacit-gateway', '1.4']).catch(() => {}); return s; }, (e) => { opening = null; throw e; });
    return opening;
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    const t = setTimeout(() => { pending.delete(n); reject(new Error('electrum timeout')); }, timeoutMs);
    pending.set(n, { resolve, reject, t });
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  return {
    call: async (method, params = []) => { await ready(); return send(method, params); },
    close: () => { if (sock) sock.destroy(); },
  };
}

// ── esplora shapes from bitcoind's JSON ──────────────────────────────────────────────────────────────────────────────────────────────────
const TYPES = { pubkeyhash: 'p2pkh', scripthash: 'p2sh', witness_v0_keyhash: 'v0_p2wpkh', witness_v0_scripthash: 'v0_p2wsh', witness_v1_taproot: 'v1_p2tr', nulldata: 'op_return', pubkey: 'p2pk' };
const spk = (s) => {
  const o = { scriptpubkey: s.hex, scriptpubkey_type: s.hex === '' ? 'empty' : TYPES[s.type] || 'unknown' };
  if (s.address) o.scriptpubkey_address = s.address;
  return o;
};
const COINBASE_TXID = '0'.repeat(64);
export function esploraTx(v, status) {
  return {
    txid: v.txid, version: v.version, locktime: v.locktime,
    vin: v.vin.map((i) => (i.coinbase !== undefined
      ? { txid: COINBASE_TXID, vout: 0xffffffff, prevout: null, scriptsig: i.coinbase, witness: i.txinwitness || [], is_coinbase: true, sequence: i.sequence }
      : { txid: i.txid, vout: i.vout, prevout: i.prevout ? { ...spk(i.prevout.scriptPubKey), value: sats(i.prevout.value) } : null, scriptsig: i.scriptSig?.hex ?? '', witness: i.txinwitness || [], is_coinbase: false, sequence: i.sequence })),
    vout: v.vout.map((o) => ({ ...spk(o.scriptPubKey), value: sats(o.value) })),
    size: v.size, weight: v.weight, fee: v.fee === undefined ? 0 : sats(v.fee),
    status,
  };
}

export class Answer extends Error { constructor(status, body) { super(typeof body === 'string' ? body : 'answer'); this.status = status; this.body = body; } }
const notFound = (what) => new Answer(404, what);
const notHere = (why) => new Answer(501, { error: `not provided by this node: ${why}` });

// What a read costs in the gateway's budget units (a plain read is 1)
export function costOf(path) {
  if (/^\/(address|scripthash)\/[^/]+$/.test(path)) return 10;
  if (/^\/(address|scripthash)\/[^/]+\/txs/.test(path)) return 5;
  if (/\/outspends$|^\/mempool\/txids$|^\/blocks/.test(path)) return 5;
  if (/\/utxo$|\/raw$|^\/fee-estimates$|^\/v1\/fees|^\/mempool$/.test(path)) return 3;
  return 1;
}

// rpc(method, params) and rpcBatch([[method, params], ...]) -> results (an error object in place of a failed item) reach bitcoind; electrum.call reaches electrs.
export function makeBtcIndex({ rpc, rpcBatch, electrum, historyMax = 300, spenderMax = 500, txCacheMax = 2000, nowMs = () => Date.now() }) {
  const lru = new Map();
  const remember = (k, v) => { lru.delete(k); lru.set(k, v); if (lru.size > txCacheMax) lru.delete(lru.keys().next().value); return v; };
  const recall = (k) => { if (!lru.has(k)) return undefined; const v = lru.get(k); lru.delete(k); lru.set(k, v); return v; };
  const blocks = new Map();   // hash -> { height, time }, for blocks with 6+ confirmations
  const histories = new Map(); // electrum scripthash -> { at, value }, a few seconds

  const tryRpc = async (method, params) => { try { return await rpc(method, params); } catch (e) { if (e.code === -5 || e.code === -8) throw notFound(method === 'getrawtransaction' ? 'Transaction not found' : 'Block not found'); throw e; } };
  const blockOf = async (hash) => {
    if (blocks.has(hash)) return blocks.get(hash);
    const h = await tryRpc('getblockheader', [hash, true]);
    const b = { height: h.height, time: h.time, confirmations: h.confirmations, next: h.nextblockhash ?? null, header: h };
    if (h.confirmations >= 6) blocks.set(hash, b);
    if (blocks.size > 20_000) blocks.delete(blocks.keys().next().value);
    return b;
  };
  const statusOf = async (v) => {
    if (!v.blockhash || !(v.confirmations > 0)) return { confirmed: false };
    const b = await blockOf(v.blockhash);
    return { confirmed: true, block_height: b.height, block_hash: v.blockhash, block_time: v.blocktime ?? b.time };
  };
  // confirmed transactions are cached once 6 deep (their answer no longer changes); the rest are read every time
  const txJson = async (txid, v = null) => {
    const hit = recall('tx:' + txid);
    if (hit) return hit;
    v ||= await tryRpc('getrawtransaction', [txid, 2]);
    const t = esploraTx(v, await statusOf(v));
    return v.confirmations >= 6 ? remember('tx:' + txid, t) : t;
  };
  const txsJson = async (txids) => {
    const out = new Array(txids.length), need = [];
    txids.forEach((id, i) => { const hit = recall('tx:' + id); if (hit) out[i] = hit; else need.push(i); });
    for (let k = 0; k < need.length; k += 50) {
      const part = need.slice(k, k + 50);
      const got = await rpcBatch(part.map((i) => ['getrawtransaction', [txids[i], 2]]));
      for (let n = 0; n < part.length; n++) {
        if (!got[n] || got[n].error) throw new Error('a transaction in this history is not readable');
        out[part[n]] = await txJson(txids[part[n]], got[n]);
      }
    }
    return out;
  };

  const scriptOf = (kind, id) => {
    if (kind === 'scripthash') { if (!HEX64.test(id)) throw new Answer(400, 'Invalid scripthash'); return { sh: rev(id) }; }
    const s = addressScript(id);
    if (!s) throw new Answer(400, 'Invalid Bitcoin address');
    return { sh: electrumHash(s), script: s };
  };
  // [{ tx_hash, height }]: confirmed newest first, then mempool (height 0, or -1 with an unconfirmed parent)
  const history = async (sh) => {
    const hit = histories.get(sh);
    if (hit && nowMs() - hit.at < 5000) return hit.value;
    let h;
    try { h = await electrum.call('blockchain.scripthash.get_history', [sh]); } catch (e) { if (e.electrum) throw notHere('this history is too long for the index'); throw e; }
    const value = { chain: h.filter((x) => x.height > 0).reverse(), mempool: h.filter((x) => x.height <= 0).reverse() };
    histories.set(sh, { at: nowMs(), value });
    if (histories.size > 500) histories.delete(histories.keys().next().value);
    return value;
  };
  const blockAt = async (height) => {
    const hash = await rpc('getblockhash', [height]);
    const b = await blockOf(hash);
    return { block_height: height, block_hash: hash, block_time: b.time };
  };

  async function addressStats(kind, id) {
    const { sh, script } = scriptOf(kind, id);
    const h = await history(sh);
    if (h.chain.length + h.mempool.length > historyMax) throw notHere('this address has a long history; read its stats elsewhere');
    const own = script ?? null;
    const stats = async (list) => {
      const s = { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: list.length };
      const txs = await txsJson(list.map((x) => x.tx_hash));
      // a scripthash names no script: it is the script whose electrum hash it is, so the outputs that pay it are found by that hash
      const mine = own ? (hex) => hex === own : (hex) => electrumHash(hex) === sh;
      for (const t of txs) {
        for (const o of t.vout) if (mine(o.scriptpubkey)) { s.funded_txo_count++; s.funded_txo_sum += o.value; }
        for (const i of t.vin) if (i.prevout && mine(i.prevout.scriptpubkey)) { s.spent_txo_count++; s.spent_txo_sum += i.prevout.value; }
      }
      return s;
    };
    return { [kind]: id, chain_stats: await stats(h.chain), mempool_stats: await stats(h.mempool) };
  }

  async function outspend(txid, n, v) {
    const out = v.vout[n];
    if (!out) throw notFound('Output not found');
    const unspent = await rpc('gettxout', [txid, n, true]);
    if (unspent) return { spent: false };
    if (out.scriptPubKey.type === 'nulldata') return { spent: false };
    if (!v.blockhash && !(await rpc('getmempoolentry', [txid]).catch(() => null))) throw notFound('Transaction not found');
    const fundHeight = v.blockhash ? (await blockOf(v.blockhash)).height : 0;
    const h = await history(electrumHash(out.scriptPubKey.hex));
    const cands = [...h.chain].reverse().filter((x) => x.height >= fundHeight && x.tx_hash !== txid).concat(h.mempool.filter((x) => x.tx_hash !== txid));
    if (cands.length > spenderMax) throw notHere('the spender sits in a long history');
    for (let k = 0; k < cands.length; k += 50) {
      const part = cands.slice(k, k + 50);
      const got = await rpcBatch(part.map((c) => ['getrawtransaction', [c.tx_hash, 1]]));
      for (let m = 0; m < part.length; m++) {
        const s = got[m];
        if (!s || s.error) continue;
        const vin = s.vin.findIndex((i) => i.txid === txid && i.vout === n);
        if (vin >= 0) return { spent: true, txid: s.txid, vin, status: await statusOf(s) };
      }
    }
    // gone from the UTXO set but no spender in the index yet: electrs is a block behind bitcoind. Say so rather than "unspent".
    throw new Answer(503, { error: 'index catching up' });
  }

  // GET path -> { status, type, body }; throws Answer for the esplora error answers
  async function serve(path) {
    let m;
    const json = (body) => ({ status: 200, type: 'application/json', body: JSON.stringify(body) });
    const text = (body) => ({ status: 200, type: 'text/plain', body: String(body) });
    if (path === '/blocks/tip/height') return text(await rpc('getblockcount'));
    if (path === '/blocks/tip/hash') return text(await rpc('getbestblockhash'));
    if ((m = path.match(/^\/block-height\/(\d+)$/))) return text(await tryRpc('getblockhash', [Number(m[1])]));
    if ((m = path.match(/^\/tx\/([0-9a-f]{64})$/))) return json(await txJson(m[1]));
    if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/hex$/))) return text(await tryRpc('getrawtransaction', [m[1], 0]));
    if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/raw$/))) return { status: 200, type: 'application/octet-stream', body: Buffer.from(await tryRpc('getrawtransaction', [m[1], 0]), 'hex') };
    if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/status$/))) return json(await statusOf(await tryRpc('getrawtransaction', [m[1], 1])));
    if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/))) return json(await outspend(m[1], Number(m[2]), await tryRpc('getrawtransaction', [m[1], 1])));
    if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/outspends$/))) {
      const v = await tryRpc('getrawtransaction', [m[1], 1]);
      const out = [];
      for (let n = 0; n < v.vout.length; n++) out.push(await outspend(m[1], n, v));
      return json(out);
    }
    if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/merkle-proof$/))) {
      const v = await tryRpc('getrawtransaction', [m[1], 1]);
      if (!v.blockhash) throw notFound('Transaction not confirmed');
      return json(await electrum.call('blockchain.transaction.get_merkle', [m[1], (await blockOf(v.blockhash)).height]));
    }
    if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/merkleblock-proof$/))) return text(await tryRpc('gettxoutproof', [[m[1]]]));
    if ((m = path.match(/^\/block\/([0-9a-f]{64})$/))) return json(await blockJson(m[1]));
    if ((m = path.match(/^\/block\/([0-9a-f]{64})\/header$/))) return text(await tryRpc('getblockheader', [m[1], false]));
    if ((m = path.match(/^\/block\/([0-9a-f]{64})\/status$/))) { const h = await tryRpc('getblockheader', [m[1], true]); return json({ in_best_chain: h.confirmations >= 0, height: h.height, next_best: h.nextblockhash ?? null }); }
    if ((m = path.match(/^\/block\/([0-9a-f]{64})\/raw$/))) return { status: 200, type: 'application/octet-stream', body: Buffer.from(await tryRpc('getblock', [m[1], 0]), 'hex') };
    if ((m = path.match(/^\/block\/([0-9a-f]{64})\/txids$/))) return json((await tryRpc('getblock', [m[1], 1])).tx);
    if ((m = path.match(/^\/block\/([0-9a-f]{64})\/txid\/(\d+)$/))) { const t = (await tryRpc('getblock', [m[1], 1])).tx[Number(m[2])]; if (!t) throw notFound('Transaction index out of range'); return text(t); }
    if ((m = path.match(/^\/blocks(?:\/(\d+))?$/))) {
      const top = m[1] !== undefined ? Math.min(Number(m[1]), await rpc('getblockcount')) : await rpc('getblockcount');
      const out = [];
      for (let h = top; h >= 0 && h > top - 10; h--) out.push(await blockJson(await rpc('getblockhash', [h])));
      return json(out);
    }
    if ((m = path.match(/^\/(address|scripthash)\/([A-Za-z0-9]+)$/))) return json(await addressStats(m[1], m[2]));
    if ((m = path.match(/^\/(address|scripthash)\/([A-Za-z0-9]+)\/txs(?:\/(chain|mempool)(?:\/([0-9a-f]{64}))?)?$/))) {
      const h = await history(scriptOf(m[1], m[2]).sh);
      const [, , , part, last] = m;
      let ids;
      if (part === 'mempool') ids = h.mempool.slice(0, 50);
      else if (part === 'chain') { const from = last ? h.chain.findIndex((x) => x.tx_hash === last) + 1 : 0; ids = last && from === 0 ? [] : h.chain.slice(from, from + 25); }
      else ids = [...h.mempool.slice(0, 50), ...h.chain.slice(0, 25)];
      return json(await txsJson(ids.map((x) => x.tx_hash)));
    }
    if ((m = path.match(/^\/(address|scripthash)\/([A-Za-z0-9]+)\/utxo$/))) {
      let u;
      try { u = await electrum.call('blockchain.scripthash.listunspent', [scriptOf(m[1], m[2]).sh]); } catch (e) { if (e.electrum) throw notHere('this history is too long for the index'); throw e; }
      const out = [];
      for (const x of u) out.push({ txid: x.tx_hash, vout: x.tx_pos, status: x.height > 0 ? { confirmed: true, ...(await blockAt(x.height)) } : { confirmed: false }, value: x.value });
      return json(out);
    }
    if (path === '/v1/fees/recommended') {
      const est = async (t) => { try { const r = await rpc('estimatesmartfee', [t]); return r.feerate > 0 ? r.feerate * 1e5 : null; } catch { return null; } };
      const min = Math.max(1, Math.ceil(((await rpc('getmempoolinfo')).mempoolminfee || 0) * 1e5));
      // mempool.space's shape and its habits: whole sat/vB, never under 1, each tier at least the slower one
      const [f1, f3, f6, f144] = await Promise.all([1, 3, 6, 144].map(est));
      const economy = Math.max(min, Math.ceil(f144 ?? min)), hour = Math.max(economy, Math.ceil(f6 ?? economy)), half = Math.max(hour, Math.ceil(f3 ?? hour)), fastest = Math.max(half, Math.ceil(f1 ?? half));
      return json({ fastestFee: fastest, halfHourFee: half, hourFee: hour, economyFee: economy, minimumFee: min });
    }
    if (path === '/mempool') {
      const i = await rpc('getmempoolinfo');
      return json({ count: i.size, vsize: i.bytes, total_fee: sats(i.total_fee ?? 0), fee_histogram: await electrum.call('mempool.get_fee_histogram', []) });
    }
    if (path === '/mempool/txids') return json(await rpc('getrawmempool', [false]));
    throw notHere('this read');
  }
  async function blockJson(hash) {
    const hit = recall('block:' + hash);
    if (hit) return hit;
    const b = await tryRpc('getblock', [hash, 1]);
    const j = { id: b.hash, height: b.height, version: b.version, timestamp: b.time, tx_count: b.nTx, size: b.size, weight: b.weight, merkle_root: b.merkleroot, previousblockhash: b.previousblockhash ?? null, mediantime: b.mediantime, nonce: b.nonce, bits: parseInt(b.bits, 16), difficulty: b.difficulty };
    return b.confirmations >= 6 ? remember('block:' + hash, j) : j;
  }
  // how far electrs is behind bitcoind (blocks); null when electrs does not answer
  const indexTip = async () => { try { return (await electrum.call('blockchain.headers.subscribe', [])).height; } catch { return null; } };
  return { serve, indexTip, costOf };
}
