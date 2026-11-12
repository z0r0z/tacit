
import { ETH_LOG_NODES } from '../../eth-nodes.js';
import { bodyType } from '../../rpc-body.js';

export const A = {
  pool: '0x000000000Ed1eabD231Be41d93b719056F7febFC',
  engine: '0x000000003f608BDdF0ca45934003ffb9DbDF70DB',
  relay: '0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0',
  tac: '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279',
  tacbtc: '0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696',
  tacusd: '0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564',
  airdrop: '0x4b4cb98D0C836c2783Ac46f0078b904dab533AE8',
  points: '0x000000C918e44A3a443937fA7594eA4f7C95D6b9',
  evmPool: '0x000000c2A20657CE25f2Ba99737933D031AFBEE9',
};
export const ID = { ceth: '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', tac: '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b' };
export const ZERO32 = '0x' + '00'.repeat(32);
const RELAYERS = new Set(['0x68575b073de49a94e3e3acf6f3a0d6e3b66267c7', '0x7a0f0511e1dcf399c2f7bbe8414b6a0d1abc4331']);
const OWN = new Set(['0x006cd14f36f65ecbb29b2519ccbe63a0dc8549f2', '0x4b4cb98d0c836c2783ac46f0078b904dab533ae8']);
const TIMES_MAX = 400;
const FROM = { main: 25998000, evm: { 8453: 51864014, 4663: 73991661 } };
export const TOPIC = {
  wrap: '0xf5d1711d21af6f42622ab6237626933cefc42cc9f0663d81b7c4c7bc5ce99e44',
  leaves: '0x7783fb256f5b4e1d4d8b79583488756286326ae15d9997d4098ce5432ed2708b',
  spent: '0x576d91547505afce99e7ebe2baf1a0948b5915598105a55f40ba72fea86e875e',
  locks: '0x18df91ea83f965ece7a17fbab444175c3b2fd487524b95576215d8113d0b8662',
  asset: '0x2dcb7e1d588ab99cccaa0e9a2f69798e1e9ca87a30856228f895c2f6b34a905b',
  posted: '0x0c008a699968f2a24063b7eb14d9239b2430c502fda280245345c78cbc47b7c1',
  cdpMinted: '0x232c7d098ca44092999087e6ee530a2171f95f9ecb1caa363f6dcf448fb7dd57',
  cdpClosed: '0xc0ede5b75ee32986e50a2a39fa32dbf5e8eff1c91a46cd127591edebd91b4db9',
  cdpLiquidated: '0x28d08a2db16236ca56b1223ba30ba49824b860a3e7eb8c5a1c1224697aa3ebd1',
  claimed: '0x4ec90e965519d92681267467f775ada5bd214aa92c0dc93d90a5e880ce9ed026',
  transact: '0xdf0ed29e998ac2f2ff0f0516cb9c1b95af189e00d55af3764b95bdd2a835e53a',
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
};
export const SEL = {
  tipHeight: '0x1fd4827a', blockHeight: '0x59a53331', nextLeafIndex: '0x0be4f422', crossOuts: '0xa6f8c9d6', consumed: '0x281d8cc9',
  attestedTip: '0x182f6171', totalSupply: '0x18160ddd', lockVBtc: '0x7cea1c1a', minted: '0xe2c2a40c', escrowTotal: '0xe06e89c9',
  attest: '0x0b36171c', anchorTip: '0x89fa7909', totalAllocated: '0x45f7f249', totalClaimed: '0xd54ad2a1',
  lockSpent: '0x993ed045', lockRedeemed: '0xb5229671', outstandingCusd: '0xa42542c0',
};
export const CHAINS = {
  1: { rpc: ETH_LOG_NODES, bs: 'https://eth.blockscout.com', final: 75, slot: 12 },
  8453: { rpc: ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org'], bs: 'https://base.blockscout.com', final: 450, slot: 2 },
  4663: { rpc: ['https://rpc.mainnet.chain.robinhood.com'], bs: null, final: 3600, slot: 0.1 },
};
export const API = 'https://api.tacit.finance';
const ESPLORA = ['https://mempool.space/api', 'https://blockstream.info/api'];
const TX_FINAL = 300;
const BOARD_MAX = 500;
const TIMED_MAX = 300;

const strip = (h) => String(h || '').replace(/^0x/, '');
export const W = (hex, i) => BigInt('0x' + (strip(hex).slice(i * 64, i * 64 + 64) || '0'));
const I256 = (w) => (w >> 255n ? w - (1n << 256n) : w);
const num = (x) => Number(BigInt(x));
export const lc = (s) => String(s || '').toLowerCase();
const word32 = (h) => strip(h).padStart(64, '0');
const arrayLen = (data, at) => Number(W(data, Number(W(data, at)) / 32));
function abiString(data, at) {
  const off = Number(W(data, at)) / 32, len = Number(W(data, off)), hex = strip(data).slice((off + 1) * 64, (off + 1) * 64 + len * 2);
  return new TextDecoder().decode(Uint8Array.from(hex.match(/../g) || [], (b) => parseInt(b, 16)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const toJson = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? { $n: x.toString() } : x));
const revive = (x) => {
  if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) { const v = x[i]; if (v && typeof v === 'object') x[i] = revive(v); } return x; }
  if ('$n' in x) return BigInt(x.$n);
  for (const k in x) { const v = x[k]; if (v && typeof v === 'object') x[k] = revive(v); }
  return x;
};
export const fromJson = (s) => { const v = JSON.parse(s); return v && typeof v === 'object' ? revive(v) : v; };

function slimLog(l) {
  const t = (l.topics || []).map(lc), t0 = t[0], ts = l.blockTimestamp ?? l.timeStamp;
  const out = { b: num(l.blockNumber), i: num(l.logIndex || 0), h: lc(l.transactionHash), a: lc(l.address), t, ts: ts == null || ts === '' ? null : num(ts) || null };
  if (t0 === TOPIC.leaves || t0 === TOPIC.spent) out.n = arrayLen(l.data, 0);
  else if (t0 === TOPIC.transact) { out.x = I256(W(l.data, 5)).toString(); out.f = W(l.data, 7).toString(); }
  else if (t0 !== TOPIC.locks) out.d = l.data;
  return out;
}
const slimTx = (t, internal) => ({
  h: lc(t.hash || t.transactionHash), b: Number(t.blockNumber), ts: Number(t.timeStamp), f: lc(t.from), t: lc(t.to), v: String(t.value || '0'),
  e: String(t.isError ?? '0'), m: lc(t.methodId || String(t.input || '').slice(0, 10)), c: internal ? t.callType || t.type || 'call' : 'call', ix: t.index ?? t.traceId ?? '',
});

export function makeStatsReader({ fetchImpl = (...a) => fetch(...a), gapMs = 200, getApi = null, logBudget = 12 } = {}) {
  const COOL = 60e3;
  const eps = Object.fromEntries(Object.entries(CHAINS).map(([c, x]) => [c, x.rpc.map((url) => ({ url, cool: 0, span: Infinity }))]));
  const byHealth = (chain) => { const now = Date.now(), e = eps[chain]; return [...e.filter((x) => x.cool <= now), ...e.filter((x) => x.cool > now)]; };
  async function post(url, body, ms = 20e3) {
    let r;
    try {
      r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': bodyType(url) }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    } catch (e) {
      throw Object.assign(new Error((e && e.message) || String(e)), { kind: 'transport', timeout: !!e && (e.name === 'TimeoutError' || e.name === 'AbortError') });
    }
    let j = null;
    try { j = await r.json(); } catch { }
    if (j && !Array.isArray(j) && j.error) {
      const msg = String(j.error.message || 'rpc error') + (typeof j.error.data === 'string' ? `: ${j.error.data}` : '');
      throw Object.assign(new Error(msg), { kind: r.status === 429 || /rate limit|too many requests|usage limit/i.test(msg) ? 'busy' : 'rpc' });
    }
    if (!r.ok || j == null) throw Object.assign(new Error(`rpc ${r.status}`), { kind: r.status === 429 ? 'busy' : 'http' });
    return j;
  }
  async function rpc(chain, method, params, found = false) {
    let last = null;
    for (const ep of byHealth(chain)) {
      try {
        const { result } = await post(ep.url, { jsonrpc: '2.0', id: 1, method, params });
        if (found && result == null) throw Object.assign(new Error('not found'), { kind: 'rpc' });
        return result;
      } catch (e) { last = e; if (e.kind !== 'rpc') ep.cool = Date.now() + COOL; }
    }
    throw last || new Error('no RPC answered');
  }
  async function batch(chain, reqs) {
    for (const ep of byHealth(chain)) {
      try {
        const j = await post(ep.url, reqs.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params })), 30e3);
        if (!Array.isArray(j)) throw new Error('no batch');
        const by = new Map(j.map((x) => [x.id, x]));
        return reqs.map((_, i) => by.get(i)?.result ?? null);
      } catch { }
    }
    return reqs.map(() => null);
  }
  async function calls(chain, list) {
    const got = await batch(chain, list.map(([to, data]) => ['eth_call', [{ to, data }, 'latest']]));
    const out = [];
    for (let i = 0; i < list.length; i++) out.push(got[i] ?? (await rpc(chain, 'eth_call', [{ to: list[i][0], data: list[i][1] }, 'latest'])));
    return out;
  }
  function narrower(e, span) {
    if (e.kind === 'transport') return e.timeout && span > 2000 ? { span: Math.floor(span / 2) } : null;
    if (e.kind !== 'rpc') return null;
    const cap = e.message.match(/(?:max(?:imum)?\b\D{0,24}|\bover\s+|\bup to\s+|limited to\s+(?:a\s+)?|\bonly\s+)([\d,]{2,})/i);
    if (cap) { const n = Number(cap[1].replace(/,/g, '')); return n < span ? { span: n, cap: n } : null; }
    return /too (large|wide|big|many)|exceed|more than|response size|narrow the/i.test(e.message) && span > 1 ? { span: Math.floor(span / 2) } : null;
  }
  async function getLogs(chain, address, from, to, budget = 12, topics = null) {
    const out = [];
    const refused = new Set();
    let asked = 0;
    for (let start = from, last = null; start <= to;) {
      let got = null;
      const now = Date.now();
      const order = eps[chain].filter((e) => !refused.has(e)).map((e, i) => [e, i]).sort(([a, i], [b, j]) => (a.cool > now) - (b.cool > now) || (a.span < b.span) - (a.span > b.span) || i - j).map(([e]) => e);
      for (const ep of order) {
        let span = Math.min(to - start + 1, ep.span);
        while (!got) {
          if (++asked > budget) throw Object.assign(new Error('too many requests to read these logs from RPC'), { kind: 'budget', partial: { logs: out, end: start - 1 } });
          if (asked > 12 && gapMs) await sleep(gapMs);
          const end = start + span - 1;
          try {
            const { result } = await post(ep.url, { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address, ...(topics ? { topics } : {}), fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) }] }, 25e3);
            got = { logs: Array.isArray(result) ? result : [], end };
          } catch (e) {
            last = e;
            const n = narrower(e, span);
            if (!n) { if (e.kind !== 'rpc') ep.cool = Date.now() + COOL; else refused.add(ep); break; }
            if (n.cap) ep.span = Math.min(ep.span, n.cap);
            span = n.span;
          }
        }
        if (got) break;
      }
      if (!got) throw Object.assign(last || new Error('no RPC served these logs'), { partial: { logs: out, end: start - 1 } });
      out.push(...got.logs);
      start = got.end + 1;
    }
    return out;
  }

  const EXPLORERS = {
    1: ['https://eth.blockscout.com/api', 'https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api'],
    8453: ['https://base.blockscout.com/api', 'https://api.routescan.io/v2/network/mainnet/evm/8453/etherscan/api'],
  };
  const turn = {}, aside = new Map();
  let chain_ = Promise.resolve();
  function slot(fn) {
    const p = chain_.then(fn);
    chain_ = p.catch(() => {}).then(() => sleep(gapMs));
    return p;
  }
  async function getJson(url) {
    for (let i = 0; ; i++) {
      const r = await slot(() => fetchImpl(url, { signal: AbortSignal.timeout(30e3) }).then(async (res) => ({ status: res.status, body: await res.text() })));
      let j = null;
      try { j = JSON.parse(r.body); } catch { }
      const busy = r.status === 429 || /too many requests|rate limit/i.test(`${j?.message || ''} ${typeof j?.result === 'string' ? j.result : ''}`);
      if (!busy && j && (Array.isArray(j.result) || /no (records|transactions) found/i.test(`${j.message} ${j.result}`))) return Array.isArray(j.result) ? j.result : [];
      if (busy || i >= 1) throw new Error(busy ? 'explorer busy' : `explorer answered ${r.status}`);
      await sleep(1500);
    }
  }
  async function listed(chain, query, blockOf, keyOf, from) {
    const bases = EXPLORERS[chain], first = (turn[chain] = ((turn[chain] ?? -1) + 1) % bases.length), now = Date.now();
    const order = bases.map((_, i) => bases[(first + i) % bases.length]).sort((a, b) => ((aside.get(a) || 0) > now) - ((aside.get(b) || 0) > now));
    let last = null;
    for (const base of order) {
      try {
        const out = [], seen = new Set();
        for (let block = from, i = 0; i < 60; i++) {
          const items = await getJson(`${base}?${query(block)}`);
          let added = 0;
          for (const x of items) { const k = keyOf(x); if (!seen.has(k)) { seen.add(k); out.push(x); added++; } }
          if (items.length < 1000 || !added) break;
          block = blockOf(items.at(-1));
        }
        return out;
      } catch (e) { last = e; aside.set(base, Date.now() + 10 * 60e3); }
    }
    throw last || new Error('no explorer answered');
  }
  const bsLogs = (chain, address, from) => listed(chain, (b) => `module=logs&action=getLogs&address=${address}&fromBlock=${b}&toBlock=latest&page=1&offset=1000`,
    (l) => num(l.blockNumber), (l) => `${lc(l.transactionHash)}:${num(l.logIndex || 0)}`, from);
  const bsTxs = (chain, address, action, from) => listed(chain, (b) => `module=account&action=${action}&address=${address}&startblock=${b}&endblock=999999999&sort=asc&page=1&offset=1000`,
    (t) => Number(t.blockNumber), (t) => { const s = slimTx(t, true); return `${s.h}:${s.ix}:${s.f}:${s.t}:${s.v}`; }, from);

  async function esplora(path) {
    let last = null;
    for (const base of ESPLORA) {
      try { const r = await fetchImpl(base + path, { signal: AbortSignal.timeout(15e3) }); if (r.ok) return r.text(); last = new Error(`esplora ${r.status}`); } catch (e) { last = e; }
    }
    throw last;
  }
  const api = getApi || ((path) => fetchImpl(API + path, { signal: AbortSignal.timeout(15e3) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`API ${r.status}`)))));

  async function read(keep = {}, { onPart = () => {} } = {}) {
    const k = { v: 2, logs: { ...(keep.v === 2 ? keep.logs : {}) }, txs: { ...(keep.v === 2 ? keep.txs : {}) }, senders: { ...(keep.v === 2 ? keep.senders : {}) } };
    const heads = {};
    const head = (chain) => (heads[chain] ||= rpc(chain, 'eth_blockNumber', []).then((h) => Number(BigInt(h))));

    async function logsOf(name, chain, addresses, from, topics = null) {
      const to = await head(chain), final = CHAINS[chain].final, kept = k.logs[name], start = kept ? kept.to + 1 : from;
      let fresh = [];
      if (start <= to) {
        try { fresh = await getLogs(chain, addresses.length === 1 ? addresses[0] : addresses, start, to, logBudget, topics); }
        catch (e) {
          try {
            if (!CHAINS[chain].bs) throw e;
            fresh = [];
            for (const a of addresses) fresh.push(...(await bsLogs(chain, a, start)).filter((l) => num(l.blockNumber) <= to
              && (!topics || topics.every((t, i) => t == null || String(l.topics[i] || '').toLowerCase() === String(t).toLowerCase()))));
          } catch (e2) {
            const upto = Math.min(e.partial ? e.partial.end : start - 1, to - final);
            if (upto >= start) k.logs[name] = { to: upto, items: [...(kept ? kept.items : []), ...e.partial.logs.map(slimLog).filter((l) => l.b <= upto).sort((x, y) => x.b - y.b || x.i - y.i)] };
            throw e2;
          }
        }
      }
      let all = [...(kept ? kept.items : []), ...fresh.map(slimLog).sort((x, y) => x.b - y.b || x.i - y.i)];
      all = await timed(all, chain);
      if (to - final >= start - 1) k.logs[name] = { to: to - final, items: all.filter((l) => l.b <= to - final) };
      return all;
    }
    async function txsOf(name, action) {
      const to = await head(1), kept = k.txs[name], start = kept ? kept.to + 1 : 0;
      const fresh = (await bsTxs(1, A.pool, action, start)).map((t) => slimTx(t, action === 'txlistinternal'));
      const all = [...(kept ? kept.items : []), ...fresh];
      if (to - TX_FINAL >= start - 1) k.txs[name] = { to: to - TX_FINAL, items: all.filter((t) => t.b <= to - TX_FINAL) };
      return all;
    }
    async function timed(items, chain) {
      const missing = [...new Set(items.filter((l) => !l.ts).map((l) => l.b))];
      if (!missing.length) return items;
      const at = new Map();
      for (let i = 0; missing.length <= TIMED_MAX && i < missing.length; i += 50) {
        const part = missing.slice(i, i + 50);
        const blocks = await batch(chain, part.map((b) => ['eth_getBlockByNumber', ['0x' + b.toString(16), false]]));
        part.forEach((b, j) => { const t = blocks[j]?.timestamp ? num(blocks[j].timestamp) : 0; if (t) at.set(b, t); });
      }
      let ref = null;
      if (missing.some((b) => !at.has(b))) {
        const blk = await rpc(chain, 'eth_getBlockByNumber', ['latest', false]).catch(() => null);
        if (blk) ref = [num(blk.number), num(blk.timestamp)];
      }
      return items.map((l) => (l.ts ? l : { ...l, ts: at.get(l.b) ?? (ref ? ref[1] - (ref[0] - l.b) * CHAINS[chain].slot : null) }));
    }
    const once = (fn) => { let p = null; return () => (p ||= fn()); };
    const main = once(() => logsOf('1', 1, [A.pool, A.engine, A.airdrop, A.evmPool], FROM.main));
    const tacMints = once(() => logsOf('tacmint', 1, [A.tac], FROM.main, [TOPIC.transfer, ZERO32]));
    const poolTxs = once(() => txsOf('txlist', 'txlist'));
    const internal = once(() => txsOf('internal', 'txlistinternal'));
    const of = (address, topic) => (ls) => ls.filter((l) => l.a === lc(address) && (!topic || l.t[0] === topic));

    async function senders(hashes) {
      const todo = hashes.filter((h) => !k.senders[h]), missed = [];
      for (let i = 0; i < todo.length; i += 50) {
        const part = todo.slice(i, i + 50), got = await batch(1, part.map((h) => ['eth_getTransactionByHash', [h]]));
        part.forEach((h, j) => { if (got[j]?.from) k.senders[h] = lc(got[j].from); else missed.push(h); });
      }
      for (let i = 0; i < missed.length; i += 5) {
        await Promise.all(missed.slice(i, i + 5).map((h) => rpc(1, 'eth_getTransactionByHash', [h], true).then((t) => { if (t?.from) k.senders[h] = lc(t.from); }).catch(() => {})));
      }
      return hashes.map((h) => k.senders[h] || null);
    }

    async function readEth() {
      const [pool, held, direct, int_] = await Promise.all([main().then(of(A.pool, TOPIC.wrap)), rpc(1, 'eth_getBalance', [A.pool, 'latest']).then(BigInt), poolTxs(), internal()]);
      const eth = pool.filter((l) => l.t[2] === ID.ceth);
      const moved = (t) => t.e === '0' && BigInt(t.v) > 0n && t.c === 'call';
      const ins = [...direct, ...int_].filter((t) => moved(t) && t.t === lc(A.pool));
      const outs = int_.filter((t) => moved(t) && t.f === lc(A.pool));
      const sent = await senders([...new Set(eth.map((l) => l.h))]);
      const listed = new Set(ins.map((t) => t.h));
      const unlisted = eth.filter((l) => l.ts && !listed.has(l.h));
      return {
        inWei: eth.reduce((s, l) => s + W(l.d, 0), 0n), held, outWei: outs.reduce((s, t) => s + BigInt(t.v), 0n), deposits: eth.length,
        lastAt: eth.length ? eth.at(-1).ts : null, wallets: new Set(sent.filter(Boolean)).size, unread: sent.filter((s) => !s).length,
        series: {
          ins: eth.map((l) => [l.ts, W(l.d, 0)]),
          flows: [...ins.map((t) => [t.ts, BigInt(t.v)]), ...unlisted.map((l) => [l.ts, W(l.d, 0)]), ...outs.map((t) => [t.ts, -BigInt(t.v)])],
        },
      };
    }

    async function readDevices() {
      const src = {
        1: () => main().then(of(A.evmPool, TOPIC.transact)),
        8453: () => logsOf('8453', 8453, [A.evmPool], FROM.evm[8453]).then(of(A.evmPool, TOPIC.transact)),
        4663: () => logsOf('4663', 4663, [A.evmPool], FROM.evm[4663]).then(of(A.evmPool, TOPIC.transact)),
      };
      return Promise.all([1, 8453, 4663].map(async (chain) => {
        const [bal, ls] = await Promise.all([rpc(chain, 'eth_getBalance', [A.evmPool, 'latest']).then(BigInt).catch(() => null), src[chain]().catch(() => null)]);
        let dep = 0n, wd = 0n, nd = 0, nw = 0;
        const ins = [], flows = [];
        for (const l of ls || []) {
          const x = BigInt(l.x), f = BigInt(l.f);
          if (x > 0n) { dep += x; nd++; ins.push([l.ts, x]); } else if (x < 0n) { wd -= x; nw++; }
          wd += f;
          flows.push([l.ts, x - f]);
        }
        const dated = (xs) => xs.filter(([t]) => t != null);
        return {
          chain, bal, dep: ls ? dep : null, wd: ls ? wd : null, nd, nw, moves: ls ? ls.length : null,
          lastAt: ins.length ? ins.at(-1)[0] : null, series: { ins: dated(ins), flows: dated(flows) },
        };
      }));
    }

    async function readBtc() {
      const [ls, [tacbtc, tacusd, outstanding]] = await Promise.all([main().then(of(A.engine)), calls(1, [[A.tacbtc, SEL.totalSupply], [A.tacusd, SEL.totalSupply], [A.engine, SEL.outstandingCusd]])]);
      const [posted, minted, closed, liquidated] = [TOPIC.posted, TOPIC.cdpMinted, TOPIC.cdpClosed, TOPIC.cdpLiquidated].map((t) => ls.filter((l) => l.t[0] === t));
      const outpoints = [...new Set(posted.map((l) => l.t[1]))];
      const per = [[A.pool, SEL.lockVBtc], [A.pool, SEL.minted], [A.pool, SEL.lockSpent], [A.pool, SEL.lockRedeemed], [A.engine, SEL.escrowTotal]];
      const reads = outpoints.length ? await calls(1, outpoints.flatMap((o) => per.map(([to, sel]) => [to, sel + word32(o)]))) : [];
      let locked = 0n, nLocked = 0, mint = 0n, nMint = 0, bonds = 0n, nBonds = 0, waiting = 0, redeemed = 0, unlocked = 0;
      outpoints.forEach((_, i) => {
        const [v, m, spent, red, b] = reads.slice(i * per.length, (i + 1) * per.length).map((x) => BigInt(x));
        if (red) redeemed++;
        else if (spent) unlocked++;
        else if (v > 0n) { locked += v; nLocked++; }
        else if (b > 0n) waiting++;
        if (m) { mint += v; nMint++; }
        if (b > 0n) { bonds += b; nBonds++; }
      });
      const sum = (xs) => xs.reduce((s, l) => s + W(l.d, 0), 0n);
      return { locked, nLocked, redeemed, unlocked, waiting, mint, nMint, bonds, nBonds, borrowed: sum(minted), repaid: sum(closed), liq: sum(liquidated),
        out: BigInt(outstanding), open: minted.length - closed.length - liquidated.length, tacbtc: BigInt(tacbtc), tacusd: BigInt(tacusd) };
    }

    async function readTac() {
      const [ls, claims, [supply]] = await Promise.all([main().then(of(A.pool)), main().then(of(A.airdrop, TOPIC.claimed)), calls(1, [[A.tac, SEL.totalSupply]])]);
      const meta = new Map();
      for (const l of ls.filter((x) => x.t[0] === TOPIC.asset)) {
        try { meta.set(l.t[1], { symbol: abiString(l.d, 2), decimals: Number(W(l.d, 3)), token: '0x' + strip(l.t[2]).slice(24) }); } catch { }
      }
      const unnamed = [...meta.values()].filter((m) => !m.symbol && !/^0x0{40}$/.test(m.token));
      const names = unnamed.length ? await batch(1, unnamed.map((m) => ['eth_call', [{ to: m.token, data: '0x95d89b41' }, 'latest']])) : [];
      unnamed.forEach((m, i) => { try { if (names[i] && names[i] !== '0x') m.symbol = abiString(names[i], 0); } catch { } });
      const byAsset = new Map();
      for (const l of ls.filter((x) => x.t[0] === TOPIC.wrap)) { const g = byAsset.get(l.t[2]) || { n: 0, v: 0n }; g.n++; g.v += W(l.d, 0); byAsset.set(l.t[2], g); }
      const others = [...byAsset].filter(([id]) => id !== ID.tac && id !== ID.ceth).map(([id, g]) => ({ ...g, m: meta.get(id) || null }));
      const mints = await tacMints().catch(() => null);
      let outTimes = [];
      const tacOut = mints && (() => {
        const to = (l) => '0x' + strip(l.t[2]).slice(24);
        const out = mints.filter((l) => l.a === lc(A.tac) && l.t[0] === TOPIC.transfer && l.t[1] === ZERO32 && !RELAYERS.has(to(l)) && !OWN.has(to(l)));
        outTimes = out.map((l) => l.ts).filter(Boolean);
        return { n: out.length, v: out.reduce((s, l) => s + W(l.d, 0), 0n), who: new Set(out.map(to)).size };
      })();
      const newest = (xs) => xs.sort((a, b) => a - b).slice(-TIMES_MAX);
      const times = { out: newest(outTimes), in: newest(ls.filter((l) => l.t[0] === TOPIC.wrap && l.t[2] === ID.tac).map((l) => l.ts).filter(Boolean)) };
      return { supply: BigInt(supply), tacIn: byAsset.get(ID.tac) || { n: 0, v: 0n }, tacOut, times, claims: claims.length, claimed: claims.reduce((s, l) => s + W(l.d, 0), 0n),
        claimers: new Set(claims.map((l) => l.t[2])).size, others };
    }

    async function readPoints() {
      const [board, [allocated, claimed]] = await Promise.all([api(`/leaderboard?limit=${BOARD_MAX}`), calls(1, [[A.points, SEL.totalAllocated], [A.points, SEL.totalClaimed]])]);
      const list = Array.isArray(board) ? board : [];
      return { participants: list.length, full: list.length >= BOARD_MAX, points: list.reduce((s, x) => s + (Number(x.points) || 0), 0), allocated: BigInt(allocated), claimed: BigInt(claimed) };
    }

    async function readLink() {
      const [[tipHex, attestedHash, anchorHash, crossOuts, consumed, leaves], status, btcTip, pt, pl] = await Promise.all([
        calls(1, [[A.relay, SEL.tipHeight], [A.pool, SEL.attestedTip], [A.relay, SEL.anchorTip], [A.pool, SEL.crossOuts], [A.pool, SEL.consumed], [A.pool, SEL.nextLeafIndex]]),
        api('/reflection/status?network=mainnet').catch(() => null),
        esplora('/blocks/tip/height').then(Number).catch(() => null),
        poolTxs(), main().then(of(A.pool)),
      ]);
      const [attestedHeight, anchorHeight] = (await calls(1, [[A.relay, SEL.blockHeight + word32(attestedHash)], [A.relay, SEL.blockHeight + word32(anchorHash)]])).map((h) => Number(BigInt(h)));
      const attests = pt.filter((t) => t.e === '0' && t.m === SEL.attest);
      const settles = new Map();
      for (const l of pl.filter((x) => x.t[0] === TOPIC.leaves || x.t[0] === TOPIC.spent || x.t[0] === TOPIC.locks)) if (!settles.has(l.h)) settles.set(l.h, l.ts);
      const last = attests.at(-1);
      return {
        tip: Number(BigInt(tipHex)), btcTip, attestedHeight, anchorHeight, attests: attests.length, lastAttest: last ? { hash: last.h, timeStamp: last.ts } : null,
        settles: settles.size, notes: Number(BigInt(leaves)), spent: pl.filter((x) => x.t[0] === TOPIC.spent).reduce((s, l) => s + l.n, 0),
        crossOuts: Number(BigInt(crossOuts)), consumed: Number(BigInt(consumed)), status,
        times: { settles: [...settles.values()], attests: attests.map((t) => t.ts) },
      };
    }

    const parts = { eth: readEth, dev: readDevices, btc: readBtc, tac: readTac, pts: readPoints, link: readLink };
    const reading = { at: Date.now(), errors: {} };
    await Promise.all(Object.entries(parts).map(([name, fn]) => fn().then(
      (v) => { reading[name] = v; onPart(name, v); },
      (e) => { reading[name] = null; reading.errors[name] = (e && e.message) || String(e); onPart(name, null, e); },
    )));
    reading.block = await head(1).catch(() => null);
    reading.partial = Object.keys(reading.errors).length > 0;
    return { reading, keep: k };
  }

  return { read, rpc, calls, getLogs };
}

export function privateEth(eth, dev) {
  const pools = [
    ...(eth ? [{ id: 'v1', held: eth.held, inWei: eth.inWei, outWei: eth.outWei, deposits: eth.deposits, withdrawals: null, moves: null }] : []),
    ...(dev || []).map((d) => ({ id: d.chain, held: d.bal, inWei: d.dep, outWei: d.wd, deposits: d.nd, withdrawals: d.nw, moves: d.moves })),
  ];
  const sum = (key, ok) => pools.filter((p) => p[ok] != null).reduce((s, p) => s + BigInt(p[key]), 0n);
  const times = [eth?.lastAt, ...(dev || []).map((d) => d.lastAt)].filter(Boolean);
  const series = (key) => [...(eth?.series[key] || []), ...(dev || []).flatMap((d) => d.series?.[key] || [])];
  return {
    pools,
    held: sum('held', 'held'), inWei: sum('inWei', 'inWei'), outWei: sum('outWei', 'outWei'),
    deposits: pools.filter((p) => p.inWei != null).reduce((s, p) => s + p.deposits, 0),
    lastAt: times.length ? Math.max(...times) : null,
    unread: { held: pools.filter((p) => p.held == null).map((p) => p.id), flow: pools.filter((p) => p.inWei == null).map((p) => p.id) },
    series: { ins: series('ins'), flows: series('flows') },
  };
}

export function mergeReadings(older, newer) {
  if (!older) return newer;
  const out = { ...newer, errors: { ...newer.errors }, stale: [...(newer.stale || [])], staleAt: newer.stale?.length ? newer.staleAt ?? null : null };
  for (const name of ['eth', 'dev', 'btc', 'tac', 'pts', 'link']) {
    if (newer[name] == null && older[name] != null) {
      out[name] = older[name];
      out.stale.push(name);
      const at = older.stale?.includes(name) && older.staleAt ? older.staleAt : older.at;
      out.staleAt = out.staleAt == null ? at : Math.min(out.staleAt, at);
    }
  }
  return out;
}
