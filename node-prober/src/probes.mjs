// The probes: what is asked of an operator's node, and how the answer is judged. A probe is a question whose right answer is known from our own
// node and public references (the expected value needs two sources that agree, our node counting as one; where they do not agree the probe has no
// verdict and is never held against the operator), put in the wire format the pages use, at random times, about random data.
//
// A probe returns { probe, role, answered, ok, hard, fresh?, ms, note? }:
//   answered  the node gave an answer at all (counts for uptime)
//   ok        true / false, or null when there is no verdict
//   hard      the node contradicted our node AND the references on a settled fact, or made up something that does not exist
//   fresh     the node's head was within a block or two of the references' (heads only)
import { sha256, bytesToHex } from '../../dapp/vendor/tacit-deps.min.js';

export const DEPLOY_BLOCK = 25_998_736;
export const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const DEPOSIT = '0x00000000219ab540356cBB839Cbe05303d7705Fa';   // a balance that moves every block, state at any old block is a check of an archive
const OLD_ADDR = '1Q2TWHE3GMdB6BZKafqwxXtWAWgFt5Jvm3';          // the block-170 recipient: spent and unspent outputs, several pages
const hex = (n) => '0x' + n.toString(16);
const num = (h) => (typeof h === 'string' && /^0x[0-9a-f]+$/i.test(h) ? parseInt(h, 16) : null);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const digest = (v) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(v)))).slice(0, 24);
const randHex = (rnd, n) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
const between = (rnd, lo, hi) => lo + Math.floor(rnd() * Math.max(1, hi - lo + 1));

export function makeProber({ fetch, refs, rnd = Math.random, timeoutMs = 20_000 }) {
  // refs: { eth: [{url, own}], btc: [{url, own}] }
  const post = async (url, method, params) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), timeoutMs });
    let j; try { j = JSON.parse(r.text); } catch { throw Object.assign(new Error(`answered ${r.status} with no JSON`), { status: r.status }); }
    if (j.error) throw Object.assign(new Error(j.error.message || 'rpc error'), { rpc: true });
    return { result: j.result, ms: r.ms, ip: r.ip };
  };
  const get = async (url, path) => {
    const r = await fetch(url + path, { method: 'GET', headers: { accept: 'application/json, text/plain' }, timeoutMs });
    return { status: r.status, text: r.text, ms: r.ms, ip: r.ip };
  };
  const ethRef = async (method, params, norm = (x) => x) => (await Promise.all(refs.eth.map((r) => post(r.url, method, params).then((x) => ({ own: !!r.own, v: digest(norm(x.result)), raw: norm(x.result) })).catch(() => null)))).filter(Boolean);
  const btcRef = async (path, norm = (x) => x) => (await Promise.all(refs.btc.map((r) => get(r.url, path).then((x) => ({ own: !!r.own, v: digest(norm(x.status === 404 ? null : x.status === 200 ? safeJson(x.text) : undefined)), raw: norm(x.status === 404 ? null : x.status === 200 ? safeJson(x.text) : undefined) })).catch(() => null)))).filter((x) => x && x.raw !== undefined);
  const safeJson = (t) => { try { return JSON.parse(t); } catch { return t.trim(); } };

  // The expected value: the answer two sources share. Our node plus one reference, or two references; a split (no group of two, or two groups of
  // two) is no verdict. `unanimous` on a hard fail: the node must be alone against every source that answered, at least two of them.
  const agreed = (answers) => {
    const groups = new Map();
    for (const a of answers) { const g = groups.get(a.v) || { n: 0, own: false, raw: a.raw, v: a.v }; g.n++; g.own ||= a.own; groups.set(a.v, g); }
    const best = [...groups.values()].sort((x, y) => y.n - x.n);
    if (!best.length || best[0].n < 2 || (best[1] && best[1].n === best[0].n)) return null;
    return { ...best[0], total: answers.length, unanimous: best.length === 1 };
  };
  const judge = (probe, role, mine, exp, extra = {}) => {
    if (!exp) return { probe, role, answered: true, ok: null, hard: false, ms: mine.ms, note: 'the references did not agree', ...extra };
    const got = digest(mine.norm), ok = got === exp.v;
    return { probe, role, answered: true, ok, hard: !ok && exp.unanimous && exp.total >= 2 && !extra.soft, ms: mine.ms, exp: exp.v, got, ...extra };
  };
  const unanswered = (probe, role, e) => ({ probe, role, answered: false, ok: null, hard: false, ms: null, note: String(e?.message || e).slice(0, 80) });
  // an RPC error where the question is about data the node should have is a failure to answer well, not a lie
  const wrap = (probe, role, fn) => async (ep) => { try { return await fn(ep.url); } catch (e) { return e?.rpc ? { probe, role, answered: true, ok: false, hard: false, ms: null, note: String(e.message).slice(0, 80) } : unanswered(probe, role, e); } };

  const quorumHead = async () => median((await ethRef('eth_blockNumber')).map((x) => num(x.raw)).filter((x) => x != null));
  const blockSummary = (b) => (b ? { hash: b.hash, receiptsRoot: b.receiptsRoot, stateRoot: b.stateRoot, parent: b.parentHash, n: b.number } : null);

  const eth = {
    // heads: the head's block hash at depth 12 against the quorum, and the head against the quorum's
    'head': wrap('head', 'eth-reads', async (url) => {
      const qh = await quorumHead(); if (qh == null) return { probe: 'head', role: 'eth-reads', answered: true, ok: null, hard: false, ms: 0, note: 'no reference head' };
      const h = await post(url, 'eth_blockNumber', []); const n = num(h.result);
      const at = hex(qh - 12), b = await post(url, 'eth_getBlockByNumber', [at, false]);
      const exp = agreed(await ethRef('eth_getBlockByNumber', [at, false], blockSummary));
      const fresh = n != null && n >= qh - 2 && n <= qh + 3;
      return judge('head', 'eth-reads', { norm: blockSummary(b.result), ms: h.ms + b.ms }, exp, { fresh, ip: h.ip });
    }),
    'block+receipt': wrap('block+receipt', 'eth-reads', async (url) => {
      const qh = await quorumHead(); if (qh == null) return { probe: 'block+receipt', role: 'eth-reads', answered: true, ok: null, hard: false, ms: 0, note: 'no reference head' };
      const at = hex(between(rnd, qh - 200, qh - 20));
      const b = await post(url, 'eth_getBlockByNumber', [at, false]);
      const exp = agreed(await ethRef('eth_getBlockByNumber', [at, false], blockSummary));
      const r1 = judge('block+receipt', 'eth-reads', { norm: blockSummary(b.result), ms: b.ms }, exp);
      const tx = b.result?.transactions?.[0];
      if (!tx || r1.ok !== true) return r1;
      const norm = (r) => (r ? { blockHash: r.blockHash, status: r.status, gas: r.gasUsed, logs: (r.logs || []).length } : null);
      const rc = await post(url, 'eth_getTransactionReceipt', [tx]);
      return judge('block+receipt', 'eth-reads', { norm: norm(rc.result), ms: b.ms + rc.ms }, agreed(await ethRef('eth_getTransactionReceipt', [tx], norm)));
    }),
    // random 5,000-block windows from the pool's deploy block on: the count and the identity of the pool's events
    'logs': wrap('logs', 'eth-logs', async (url) => {
      const qh = await quorumHead(); if (qh == null) return { probe: 'logs', role: 'eth-logs', answered: true, ok: null, hard: false, ms: 0, note: 'no reference head' };
      const wide = rnd() < 0.3, span = wide ? 9_999 : 4_999;
      const from = between(rnd, DEPLOY_BLOCK, Math.max(DEPLOY_BLOCK, qh - 64 - span));
      const f = { fromBlock: hex(from), toBlock: hex(from + span), address: POOL };
      const norm = (l) => (Array.isArray(l) ? l.map((x) => `${x.blockNumber}:${x.logIndex}:${x.transactionHash}`) : null);
      const m = await post(url, 'eth_getLogs', [f]);
      return judge(wide ? 'logs-wide' : 'logs', 'eth-logs', { norm: norm(m.result), ms: m.ms }, agreed(await ethRef('eth_getLogs', [f], norm)));
    }),
    'proof': wrap('proof', 'eth-proofs', async (url) => {
      const qh = await quorumHead(); if (qh == null) return { probe: 'proof', role: 'eth-proofs', answered: true, ok: null, hard: false, ms: 0, note: 'no reference head' };
      const at = hex(qh - between(rnd, 2000, 9000)), p = [POOL, [], at];
      const norm = (r) => (r ? { storageHash: r.storageHash, codeHash: r.codeHash, nonce: r.nonce } : null);
      const m = await post(url, 'eth_getProof', p);
      return judge('proof', 'eth-proofs', { norm: norm(m.result), ms: m.ms }, agreed(await ethRef('eth_getProof', p, norm)));
    }),
    'archive': wrap('archive', 'eth-archive', async (url) => {
      const qh = await quorumHead(); if (qh == null) return { probe: 'archive', role: 'eth-archive', answered: true, ok: null, hard: false, ms: 0, note: 'no reference head' };
      const at = hex(between(rnd, 1_000_000, qh - 5_000)), p = [DEPOSIT, at];
      const m = await post(url, 'eth_getBalance', p);
      return judge('archive', 'eth-archive', { norm: m.result, ms: m.ms }, agreed(await ethRef('eth_getBalance', p)));
    }),
    // things that do not exist must not be found: a made-up receipt, a block far in the future, events of an address that holds nothing
    'honeypot': wrap('honeypot', 'eth-reads', async (url) => {
      const qh = (await quorumHead()) ?? DEPLOY_BLOCK;
      const pick = Math.floor(rnd() * 3);
      const ask = [['eth_getTransactionReceipt', ['0x' + randHex(rnd, 64)]], ['eth_getBlockByNumber', [hex(qh + 1_000_000 + between(rnd, 0, 99999)), false]], ['eth_getLogs', [{ fromBlock: hex(qh - 50), toBlock: hex(qh - 40), address: '0x' + randHex(rnd, 40) }]]][pick];
      const m = await post(url, ask[0], ask[1]);
      const empty = m.result == null || (Array.isArray(m.result) && m.result.length === 0);
      return { probe: 'honeypot', role: 'eth-reads', answered: true, ok: empty, hard: !empty, ms: m.ms, note: empty ? undefined : 'found what does not exist' };
    }),
  };

  const btcSummary = (t) => (t && typeof t === 'object' ? { txid: t.txid, vin: t.vin?.length, vout: t.vout?.length, bh: t.status?.block_hash, h: t.status?.block_height, fee: t.fee } : t);
  const btcTipHeight = async () => median((await btcRef('/blocks/tip/height', (x) => (typeof x === 'number' ? x : Number(x)))).map((x) => x.raw).filter(Number.isFinite));
  const btc = {
    'tip': wrap('tip', 'btc-esplora', async (url) => {
      const qh = await btcTipHeight(); if (qh == null) return { probe: 'tip', role: 'btc-esplora', answered: true, ok: null, hard: false, ms: 0, note: 'no reference tip' };
      const h = await get(url, '/blocks/tip/height'); const n = Number(h.text);
      const depth = qh - 3, g = await get(url, `/block-height/${depth}`);
      const exp = agreed(await btcRef(`/block-height/${depth}`));
      const fresh = Number.isFinite(n) && n >= qh - 1 && n <= qh + 1;
      return judge('tip', 'btc-esplora', { norm: g.status === 200 ? g.text.trim() : null, ms: h.ms + g.ms }, exp, { fresh, ip: h.ip });
    }),
    'tx': wrap('tx', 'btc-esplora', async (url) => {
      const qh = await btcTipHeight(); if (qh == null) return { probe: 'tx', role: 'btc-esplora', answered: true, ok: null, hard: false, ms: 0, note: 'no reference tip' };
      const height = between(rnd, 170, qh - 6);
      const hr = await btcRef(`/block-height/${height}`); const hash = agreed(hr)?.raw;
      if (!hash) return { probe: 'tx', role: 'btc-esplora', answered: true, ok: null, hard: false, ms: 0, note: 'no agreed block' };
      const ids = agreed(await btcRef(`/block/${hash}/txids`))?.raw;
      if (!Array.isArray(ids) || !ids.length) return { probe: 'tx', role: 'btc-esplora', answered: true, ok: null, hard: false, ms: 0, note: 'no agreed block' };
      const id = ids[between(rnd, 0, ids.length - 1)];
      const m = await get(url, `/tx/${id}`);
      return judge('tx', 'btc-esplora', { norm: m.status === 200 ? btcSummary(safeJson(m.text)) : null, ms: m.ms }, agreed(await btcRef(`/tx/${id}`, btcSummary)));
    }),
    // a full-history index answers for an address with years of spends, not only for what is new
    'address': wrap('address', 'btc-index', async (url) => {
      const norm = (a) => (a && a.chain_stats ? { f: a.chain_stats.funded_txo_count, s: a.chain_stats.spent_txo_count, tx: a.chain_stats.tx_count, fs: a.chain_stats.funded_txo_sum } : a);
      const m = await get(url, `/address/${OLD_ADDR}`);
      return judge('address', 'btc-index', { norm: m.status === 200 ? norm(safeJson(m.text)) : null, ms: m.ms }, agreed(await btcRef(`/address/${OLD_ADDR}`, norm)));
    }),
    'honeypot': wrap('honeypot', 'btc-esplora', async (url) => {
      const qh = (await btcTipHeight()) ?? 900_000;
      const path = rnd() < 0.5 ? `/tx/${randHex(rnd, 64)}` : `/block-height/${qh + 100_000 + between(rnd, 0, 9999)}`;
      const m = await get(url, path);
      const ok = m.status === 404;
      return { probe: 'honeypot', role: 'btc-esplora', answered: true, ok, hard: m.status === 200, ms: m.ms, note: ok ? undefined : m.status === 200 ? 'found what does not exist' : `answered ${m.status}` };
    }),
  };

  // which probes one visit runs for an endpoint: one per role it claims, and a honeypot now and then
  const plan = (ep) => {
    const out = [];
    const probes = ep.kind === 'eth' ? eth : btc;
    const has = (r) => ep.roles.includes(r);
    if (ep.kind === 'eth') {
      if (has('eth-reads')) out.push(rnd() < 0.5 ? 'head' : 'block+receipt');
      if (has('eth-logs')) out.push('logs');
      if (has('eth-proofs')) out.push('proof');
      if (has('eth-archive')) out.push('archive');
    } else {
      if (has('btc-esplora')) out.push(rnd() < 0.5 ? 'tip' : 'tx');
      if (has('btc-index')) out.push('address');
    }
    if (rnd() < 0.3) out.push('honeypot');
    if (!out.some((n) => n === 'head' || n === 'tip') && out.length) out.unshift(ep.kind === 'eth' ? 'head' : 'tip');
    // a head or a made-up question is asked of every endpoint whatever it claims; it counts for the first role the endpoint claims
    const shared = new Set(['head', 'tip', 'honeypot']);
    return out.map((name) => ({ name, run: async () => { const r = await probes[name](ep); return shared.has(name) ? { ...r, role: ep.roles[0] } : r; } }));
  };

  return { eth, btc, plan, agreed };
}
