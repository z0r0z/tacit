// The weld stats reading: what is read, from where, and how each figure is counted. The stats page runs it in the
// browser and the API runs the same reading for its shared snapshot, so both say the same thing. Public data only.
//
// Logs come from the chains' own RPCs, each endpoint asked for as wide a range as it serves. The one thing an RPC can't
// answer, a contract's transaction list (attestations, ETH moved in and out), comes from keyless explorers that allow
// each caller only a few requests an hour, so they are taken in turn and asked as little as possible. Everything read
// that is final is kept (`keep`, returned with each reading and handed back to the next), so a later reading asks only
// for what is new.

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
};
export const SEL = {
  tipHeight: '0x1fd4827a', blockHeight: '0x59a53331', nextLeafIndex: '0x0be4f422', crossOuts: '0xa6f8c9d6', consumed: '0x281d8cc9',
  attestedTip: '0x182f6171', totalSupply: '0x18160ddd', lockVBtc: '0x7cea1c1a', minted: '0xe2c2a40c', escrowTotal: '0xe06e89c9',
  attest: '0x0b36171c', anchorTip: '0x89fa7909', totalAllocated: '0x45f7f249', totalClaimed: '0xd54ad2a1',
  lockSpent: '0x993ed045', lockRedeemed: '0xb5229671', outstandingCusd: '0xa42542c0',
};
// `final`: how deep a block must be before what was read up to it is kept rather than read again (about a quarter of an
// hour on each chain, so neither a reorg nor an endpoint or explorer running behind leaves anything out for good).
export const CHAINS = {
  1: { rpc: ['https://mainnet.gateway.tenderly.co', 'https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com', 'https://eth.drpc.org'], bs: 'https://eth.blockscout.com', final: 75, slot: 12 },
  8453: { rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'], bs: 'https://base.blockscout.com', final: 450, slot: 2 },
  4663: { rpc: ['https://rpc.mainnet.chain.robinhood.com'], bs: null, final: 3600, slot: 0.25 },
};
export const API = 'https://api.tacit.finance';
const ESPLORA = ['https://mempool.space/api', 'https://blockstream.info/api'];
const TX_FINAL = 300;       // an explorer's transaction lists run a little behind the chain; an hour back is re-read
const BOARD_MAX = 500;      // the points API lists at most this many accounts

// ── words and numbers ────────────────────────────────────────────────────────────────────────────────────────
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

// A reading as JSON and back: amounts are bigints, written as { $n: "…" }.
export const toJson = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? { $n: x.toString() } : x));
export const fromJson = (s) => JSON.parse(s, (_, x) => (x && typeof x === 'object' && '$n' in x ? BigInt(x.$n) : x));

// Only what the figures use is kept of each log and transaction: a log's data where a figure reads it, else the count
// or amount it is read for.
function slimLog(l) {
  const t = (l.topics || []).map(lc), t0 = t[0], ts = l.blockTimestamp ?? l.timeStamp;
  const out = { b: num(l.blockNumber), i: num(l.logIndex || 0), h: lc(l.transactionHash), a: lc(l.address), t, ts: ts == null || ts === '' ? null : num(ts) };
  if (t0 === TOPIC.leaves || t0 === TOPIC.spent) out.n = arrayLen(l.data, 0);
  else if (t0 === TOPIC.transact) { out.x = I256(W(l.data, 5)).toString(); out.f = W(l.data, 7).toString(); }
  else if (t0 !== TOPIC.locks) out.d = l.data;
  return out;
}
// `c` is an internal transfer's call type (a transaction sent to the contract is always a call).
const slimTx = (t, internal) => ({
  h: lc(t.hash || t.transactionHash), b: Number(t.blockNumber), ts: Number(t.timeStamp), f: lc(t.from), t: lc(t.to), v: String(t.value || '0'),
  e: String(t.isError ?? '0'), m: lc(t.methodId || String(t.input || '').slice(0, 10)), c: internal ? t.callType || t.type || 'call' : 'call', ix: t.index ?? t.traceId ?? '',
});

// `getApi(path)` answers the relay's own reads (the points board, the reflection's status); the API passes its own, the
// page asks api.tacit.finance.
export function makeStatsReader({ fetchImpl = (...a) => fetch(...a), gapMs = 200, getApi = null } = {}) {
  // ── RPC: an endpoint that doesn't answer goes to the back of its chain's list for a minute ────────────────────
  const COOL = 60e3;
  const eps = Object.fromEntries(Object.entries(CHAINS).map(([c, x]) => [c, x.rpc.map((url) => ({ url, cool: 0, span: Infinity }))]));
  const byHealth = (chain) => { const now = Date.now(), e = eps[chain]; return [...e.filter((x) => x.cool <= now), ...e.filter((x) => x.cool > now)]; };
  async function post(url, body, ms = 20e3) {
    let r;
    try {
      r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    } catch (e) {
      throw Object.assign(new Error((e && e.message) || String(e)), { kind: 'transport', timeout: !!e && (e.name === 'TimeoutError' || e.name === 'AbortError') });
    }
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (j && !Array.isArray(j) && j.error) {
      const msg = String(j.error.message || 'rpc error');
      throw Object.assign(new Error(msg), { kind: r.status === 429 || /rate limit|too many requests|usage limit/i.test(msg) ? 'busy' : 'rpc' });
    }
    if (!r.ok || j == null) throw Object.assign(new Error(`rpc ${r.status}`), { kind: r.status === 429 ? 'busy' : 'http' });
    return j;
  }
  // The first endpoint's answer, or with `found` the first that isn't empty (a node may not serve older transactions).
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
  // Many requests in one where a node takes a batch; a request no node answers reads as null.
  async function batch(chain, reqs) {
    for (const ep of byHealth(chain)) {
      try {
        const j = await post(ep.url, reqs.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params })), 30e3);
        if (!Array.isArray(j)) throw new Error('no batch');
        const by = new Map(j.map((x) => [x.id, x]));
        return reqs.map((_, i) => by.get(i)?.result ?? null);
      } catch { /* the next node */ }
    }
    return reqs.map(() => null);
  }
  // Many reads in one request where a node takes a batch and answers every one, else one by one.
  async function calls(chain, list) {
    const got = await batch(chain, list.map(([to, data]) => ['eth_call', [{ to, data }, 'latest']]));
    const out = [];
    for (let i = 0; i < list.length; i++) out.push(got[i] ?? (await rpc(chain, 'eth_call', [{ to: list[i][0], data: list[i][1] }, 'latest'])));
    return out;
  }
  // eth_getLogs over [from, to], each endpoint asked for the whole remaining range first. One that won't serve a range
  // that wide names its cap ("max range: 800"), kept for the reading, or says the answer is too large, and the range
  // halves until it fits. Past `budget` requests it gives up, for the caller to ask the explorer instead.
  function narrower(e, span) {
    if (e.kind === 'transport') return e.timeout && span > 2000 ? { span: Math.floor(span / 2) } : null;
    if (e.kind !== 'rpc') return null;
    const cap = e.message.match(/(?:max(?:imum)?\b\D{0,24}|\bover\s+|\bup to\s+|limited to\s+(?:a\s+)?)([\d,]{2,})/i);
    if (cap) { const n = Number(cap[1].replace(/,/g, '')); return n < span ? { span: n, cap: n } : null; }
    return /too (large|wide|big|many)|exceed|more than|response size/i.test(e.message) && span > 1 ? { span: Math.floor(span / 2) } : null;
  }
  async function getLogs(chain, address, from, to, budget = 12) {
    const out = [];
    let asked = 0;
    for (let start = from, last = null; start <= to;) {
      let got = null;
      const now = Date.now();
      const order = eps[chain].map((e, i) => [e, i]).sort(([a, i], [b, j]) => (a.cool > now) - (b.cool > now) || (a.span < b.span) - (a.span > b.span) || i - j).map(([e]) => e);
      for (const ep of order) {
        let span = Math.min(to - start + 1, ep.span);
        while (!got) {
          if (++asked > budget) throw Object.assign(new Error('too many requests to read these logs from RPC'), { kind: 'budget' });
          const end = start + span - 1;
          try {
            const { result } = await post(ep.url, { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address, fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) }] }, 25e3);
            got = { logs: Array.isArray(result) ? result : [], end };
          } catch (e) {
            last = e;
            const n = narrower(e, span);
            if (!n) { if (e.kind !== 'rpc') ep.cool = Date.now() + COOL; break; }
            if (n.cap) ep.span = Math.min(ep.span, n.cap);
            span = n.span;
          }
        }
        if (got) break;
      }
      if (!got) throw last || new Error('no RPC served these logs');
      out.push(...got.logs);
      start = got.end + 1;
    }
    return out;
  }

  // ── explorers: Blockscout and Routescan, both keyless and Etherscan-compatible, taken in turn so neither carries
  // every request. One that is busy or down is set aside for ten minutes and its request goes to the other. Requests go
  // one at a time, a little apart. ──
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
      try { j = JSON.parse(r.body); } catch { /* not JSON */ }
      const busy = r.status === 429 || /too many requests|rate limit/i.test(`${j?.message || ''} ${typeof j?.result === 'string' ? j.result : ''}`);
      if (!busy && j && (Array.isArray(j.result) || /no (records|transactions) found/i.test(`${j.message} ${j.result}`))) return Array.isArray(j.result) ? j.result : [];
      if (busy || i >= 1) throw new Error(busy ? 'explorer busy' : `explorer answered ${r.status}`);
      await sleep(1500);
    }
  }
  // Every item a query lists from `from`, a thousand at a time, all from one explorer: each page resumes at the block the
  // last one ended in, so no block is split across pages unseen.
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

  // ── the reading ───────────────────────────────────────────────────────────────────────────────────────────────
  // `keep` is what an earlier reading kept (or {}); `onPart(name, value)` hears each part as it is read. Returns the
  // reading (each part, or null with its error in `errors`) and what to keep for the next one.
  async function read(keep = {}, { onPart = () => {} } = {}) {
    const k = { v: 2, logs: { ...(keep.v === 2 ? keep.logs : {}) }, txs: { ...(keep.v === 2 ? keep.txs : {}) }, senders: { ...(keep.v === 2 ? keep.senders : {}) } };
    const heads = {};
    const head = (chain) => (heads[chain] ||= rpc(chain, 'eth_blockNumber', []).then((h) => Number(BigInt(h))));

    // Logs from `from` of the given contracts, new ones read and final ones kept. RPC first; where it would take too many
    // requests (a first reading on a chain whose nodes serve short ranges), the explorer, one contract at a time.
    async function logsOf(name, chain, addresses, from) {
      const to = await head(chain), final = CHAINS[chain].final, kept = k.logs[name], start = kept ? kept.to + 1 : from;
      let fresh = [];
      if (start <= to) {
        try { fresh = await getLogs(chain, addresses.length === 1 ? addresses[0] : addresses, start, to); }
        catch (e) {
          if (!CHAINS[chain].bs) throw e;
          for (const a of addresses) fresh.push(...(await bsLogs(chain, a, start)).filter((l) => num(l.blockNumber) <= to));
        }
      }
      let all = [...(kept ? kept.items : []), ...fresh.map(slimLog).sort((x, y) => x.b - y.b || x.i - y.i)];
      if (chain === 1) all = await timed(all);
      if (to - final >= start - 1) k.logs[name] = { to: to - final, items: all.filter((l) => l.b <= to - final) };
      return all;
    }
    // A contract's transactions (or internal transfers) from the explorer, new ones read and those an hour deep kept.
    async function txsOf(name, action) {
      const to = await head(1), kept = k.txs[name], start = kept ? kept.to + 1 : 0;
      const fresh = (await bsTxs(1, A.pool, action, start)).map((t) => slimTx(t, action === 'txlistinternal'));
      const all = [...(kept ? kept.items : []), ...fresh];
      if (to - TX_FINAL >= start - 1) k.txs[name] = { to: to - TX_FINAL, items: all.filter((t) => t.b <= to - TX_FINAL) };
      return all;
    }
    // A log without its block's time (not every node gives it) is placed by its block's distance from the head.
    async function timed(items) {
      if (!items.some((l) => l.ts == null)) return items;
      const blk = await rpc(1, 'eth_getBlockByNumber', ['latest', false]);
      const hb = num(blk.number), ht = num(blk.timestamp);
      return items.map((l) => (l.ts == null ? { ...l, ts: ht - (hb - l.b) * CHAINS[1].slot } : l));
    }
    const once = (fn) => { let p = null; return () => (p ||= fn()); };
    const main = once(() => logsOf('1', 1, [A.pool, A.engine, A.airdrop, A.evmPool], FROM.main));
    const poolTxs = once(() => txsOf('txlist', 'txlist'));
    const internal = once(() => txsOf('internal', 'txlistinternal'));
    const of = (address, topic) => (ls) => ls.filter((l) => l.a === lc(address) && (!topic || l.t[0] === topic));

    // The sender of each deposit: one batch, then each one it missed asked node by node; a sender never changes.
    async function senders(hashes) {
      const todo = hashes.filter((h) => !k.senders[h]);
      const got = todo.length ? await batch(1, todo.map((h) => ['eth_getTransactionByHash', [h]])) : [];
      for (let i = 0; i < todo.length; i++) {
        const from = got[i]?.from || (await rpc(1, 'eth_getTransactionByHash', [todo[i]], true).then((t) => t.from).catch(() => null));
        if (from) k.senders[todo[i]] = lc(from);
      }
      return hashes.map((h) => k.senders[h] || null);
    }

    async function readEth() {
      const [pool, held, direct, int_] = await Promise.all([main().then(of(A.pool, TOPIC.wrap)), rpc(1, 'eth_getBalance', [A.pool, 'latest']).then(BigInt), poolTxs(), internal()]);
      const eth = pool.filter((l) => l.t[2] === ID.ceth);
      // Every ETH movement in and out, deposits or not (a public swap also brings ETH in). A delegatecall frame repeats its
      // caller's value without moving any ETH, so only calls count.
      const moved = (t) => t.e === '0' && BigInt(t.v) > 0n && t.c === 'call';
      const ins = [...direct, ...int_].filter((t) => moved(t) && t.t === lc(A.pool));
      const outs = int_.filter((t) => moved(t) && t.f === lc(A.pool));
      const sent = await senders([...new Set(eth.map((l) => l.h))]);
      return {
        inWei: eth.reduce((s, l) => s + W(l.d, 0), 0n), held, outWei: outs.reduce((s, t) => s + BigInt(t.v), 0n), deposits: eth.length,
        lastAt: eth.length ? eth.at(-1).ts : null, wallets: new Set(sent.filter(Boolean)).size, unread: sent.filter((s) => !s).length,
        series: {
          ins: eth.map((l) => [l.ts, W(l.d, 0)]),
          flows: [...ins.map((t) => [t.ts, BigInt(t.v)]), ...outs.map((t) => [t.ts, -BigInt(t.v)])],
        },
      };
    }

    async function readDevices() {
      const src = {
        1: () => main().then(of(A.evmPool, TOPIC.transact)),
        8453: () => logsOf('8453', 8453, [A.evmPool], FROM.evm[8453]).then(of(A.evmPool, TOPIC.transact)),
        4663: () => logsOf('4663', 4663, [A.evmPool], FROM.evm[4663]).then(of(A.evmPool, TOPIC.transact)),
      };
      return Promise.all(Object.keys(CHAINS).map(Number).map(async (chain) => {
        const [bal, ls] = await Promise.all([rpc(chain, 'eth_getBalance', [A.evmPool, 'latest']).then(BigInt).catch(() => null), src[chain]().catch(() => null)]);
        // Out is what the pool paid: each withdrawal, and each relayer fee, which it pays on top.
        let dep = 0n, wd = 0n, nd = 0, nw = 0;
        for (const l of ls || []) { const x = BigInt(l.x); if (x > 0n) { dep += x; nd++; } else if (x < 0n) { wd -= x; nw++; } wd += BigInt(l.f); }
        return { chain, bal, dep: ls ? dep : null, wd: ls ? wd : null, nd, nw, moves: ls ? ls.length : null };
      }));
    }

    async function readBtc() {
      const [ls, [tacbtc, tacusd, outstanding]] = await Promise.all([main().then(of(A.engine)), calls(1, [[A.tacbtc, SEL.totalSupply], [A.tacusd, SEL.totalSupply], [A.engine, SEL.outstandingCusd]])]);
      const [posted, minted, closed, liquidated] = [TOPIC.posted, TOPIC.cdpMinted, TOPIC.cdpClosed, TOPIC.cdpLiquidated].map((t) => ls.filter((l) => l.t[0] === t));
      // Each lock, found by its bond: its proven sats, whether cBTC was minted on it, whether it has since been spent on
      // Bitcoin or redeemed, and the bond it holds now.
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
        try { meta.set(l.t[1], { symbol: abiString(l.d, 2), decimals: Number(W(l.d, 3)), token: '0x' + strip(l.t[2]).slice(24) }); } catch { /* skip */ }
      }
      // An asset registered with no symbol is named by its token's own symbol().
      const unnamed = [...meta.values()].filter((m) => !m.symbol && !/^0x0{40}$/.test(m.token));
      const names = unnamed.length ? await batch(1, unnamed.map((m) => ['eth_call', [{ to: m.token, data: '0x95d89b41' }, 'latest']])) : [];
      unnamed.forEach((m, i) => { try { if (names[i] && names[i] !== '0x') m.symbol = abiString(names[i], 0); } catch { /* keep none */ } });
      const byAsset = new Map();
      for (const l of ls.filter((x) => x.t[0] === TOPIC.wrap)) { const g = byAsset.get(l.t[2]) || { n: 0, v: 0n }; g.n++; g.v += W(l.d, 0); byAsset.set(l.t[2], g); }
      const others = [...byAsset].filter(([id]) => id !== ID.tac && id !== ID.ceth).map(([id, g]) => ({ ...g, m: meta.get(id) || null }));
      return { supply: BigInt(supply), tacIn: byAsset.get(ID.tac) || { n: 0, v: 0n }, claims: claims.length, claimed: claims.reduce((s, l) => s + W(l.d, 0), 0n),
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
      // A settle is a transaction that inserted or spent notes, whoever sent it to the pool.
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

// A newer reading over an older one: each part the newer one couldn't read is carried over from the older, which says
// which parts and how old the oldest of them is.
export function mergeReadings(older, newer) {
  if (!older) return newer;
  const out = { ...newer, errors: { ...newer.errors }, stale: [], staleAt: null };
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
