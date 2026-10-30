// What the vault page reads from and sends to the chain: a pool of Ethereum's public nodes (and, when the connected wallet has its own, that one too), the
// calls of a vault and its two tokens as Multicall3 batches, and the calldata of what a person does there. Nothing here is kept: every figure comes from the
// contracts, so a vault is the same from any browser.
import { _internal, MULTICALL3 } from '/evm-trade-venues.js?cb=10858cc2';
import { bodyType } from '../rpc-body.js';

// The nodes the page's reads ask, in order (one that answers is kept until it fails). ARCHIVE are the ones that still hold the state of blocks hours old, which the
// price feed needs for eth_getProof (a node that has pruned it answers with an error); HISTORY are the nodes asked for the headers of those blocks.
export const RPCS = [
  'https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://rpc.mevblocker.io', 'https://eth-mainnet.public.blastapi.io',
  'https://ethereum-json-rpc.stakely.io', 'https://eth.rpc.blxrbdn.com', 'https://1rpc.io/eth', 'https://mainnet.gateway.tenderly.co',
];
export const ARCHIVE = ['https://eth.drpc.org', 'https://rpc.mevblocker.io', 'https://1.rpc.thirdweb.com', 'https://eth-mainnet.public.blastapi.io'];
export const HISTORY = [...new Set([...ARCHIVE, ...RPCS])];
export const WAD = 10n ** 18n;

// ── a pool of nodes ──
// A source is a URL, or { id, send(method, params, ms), usable?(method), prefer?, last?, timeout? } for a node that is not one (the connected wallet's). A call goes
// to the first source that is not resting. A source that fails rests (seconds for a rate limit, minutes for a method it does not serve), so the next call does not
// queue behind it, and it is asked again when its rest is over. `spread` starts each call at the next source, so that no node takes all the traffic; `prefer` sources
// are asked first and `last` ones only when the others have failed. When every source is resting a call waits for the first to return, up to `patience`. A revert is
// the contract's answer and ends the call. `check(result)` throws or returns false for a reply that is no good (a node's error dressed as a result, a header that does
// not rebuild to its hash): that source rests for the method and the next is asked. `skip` leaves out that many of the sources first in line, for a retry.
const BUSY = 'The public Ethereum nodes are busy. Wait a minute, then try again.';
const LIMITED = /rate.?limit|too many|\b429\b|compute units|capacity|exceeded|upgrade|quota|throttl|slow down|try again later/i;
const UNSERVED = /not (supported|available|whitelisted|allowed|enabled)|unsupported|unauthori[sz]ed|forbidden|payment required|\b40[123]\b|invalid params|historical state|archive|missing trie|origin required|auth check|disabled/i;
const REST = { limited: 15e3, slow: 20e3, down: 20e3, unserved: 300e3, bad: 120e3 };
const kindOf = (e) => {
  const m = String(e?.message || ''), http = e?.status, code = e?.code;
  if (e?.bad) return 'bad';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.timedOut) return 'slow';
  if (http === 429 || code === 429 || LIMITED.test(m)) return 'limited';
  if ([401, 402, 403, 405].includes(http) || [401, 402, 403, -32601, -32602].includes(code) || UNSERVED.test(m)) return 'unserved';
  return 'down';
};
const reverted = (e) => !!e && (e.revert === true || e.code === 3 || /revert/i.test(e.message || ''));
// A node that wraps its own error in a successful reply ({ code, message }) has not answered.
const dressed = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.code === 'number' && typeof v.message === 'string' && Object.keys(v).length <= 3;
const timed = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(Object.assign(new Error('the node did not answer in time'), { timedOut: true })), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });

const urlSource = (url, doFetch) => {
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  return {
    id: url.replace(/^https?:\/\//, ''),
    signalled: true,                             // it times itself out (the others are timed by the pool)
    async send(method, params, ms) {
      const r = await doFetch(url, { method: 'POST', headers: { 'content-type': bodyType(url) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
      let j;
      try { j = await r.json(); } catch { throw Object.assign(new Error(`${host} answered ${r.status}`), { status: r.status }); }
      if (j?.error) throw Object.assign(new Error(j.error.message || `${host} refused`), { code: j.error.code, status: r.status, revert: j.error.code === 3 || /revert/i.test(j.error.message || ''), data: typeof j.error.data === 'string' ? j.error.data : null });
      if (j?.result === undefined) throw Object.assign(new Error(`${host} sent no result`), { status: r.status });
      return j.result;
    },
  };
};

export function makeRpc(sources = RPCS, { spread = false, timeout = 12e3, patience = 30e3, onWait = null, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const pool = sources.map((s) => (typeof s === 'string' ? urlSource(s, fetchImpl) : s));
  const rests = new Map();                       // id (the node) or id|method (the node, for a method it does not serve) → when it may be asked again
  const strikes = new Map();                     // id → failures in a row, which lengthen a rest
  let turn = 0;
  const restOf = (s, method) => Math.max(rests.get(s.id) || 0, rests.get(`${s.id}|${method}`) || 0);
  const rest = (s, method, kind, ms) => {
    const n = Math.min((strikes.get(s.id) || 0) + 1, 4);
    strikes.set(s.id, n);
    const base = Math.max(1e3, ms ?? REST[kind]);
    const wait = kind === 'unserved' || kind === 'bad' ? base : Math.min(base * 2 ** (n - 1), 120e3);
    rests.set(kind === 'unserved' || kind === 'bad' ? `${s.id}|${method}` : s.id, now() + wait);
  };
  return async function rpc(method, params, { check = null, skip = 0 } = {}) {
    const t0 = now();
    let last = null, onlyLimited = true;
    for (;;) {
      const usable = pool.filter((s) => !s.usable || s.usable(method));
      const t = now();
      const live = usable.filter((s) => restOf(s, method) <= t);
      if (!live.length) {
        if (!usable.length) break;
        const wake = Math.min(...usable.map((s) => restOf(s, method)));
        if (wake - t0 > patience) break;
        onWait?.(wake - t);
        await sleep(Math.max(50, wake - t) + 25);
        continue;
      }
      const first = live.filter((s) => s.prefer), mid = live.filter((s) => !s.prefer && !s.last), tail = live.filter((s) => s.last && !s.prefer);
      if (spread && mid.length > 1) mid.push(...mid.splice(0, turn++ % mid.length));
      const all = [...first, ...mid, ...tail];
      const order = skip > 0 && all.length > 1 ? all.slice(Math.min(skip, all.length - 1)) : all;     // `skip`: not the first ones, which an earlier answer came from
      for (const s of order) {
        try {
          const ms = s.timeout || (order.length === 1 ? Math.max(timeout, 30e3) : timeout);       // the last source left gets longer
          const v = await (s.signalled ? s.send(method, params, ms) : timed(s.send(method, params), ms));
          if (dressed(v)) throw Object.assign(new Error(v.message), { code: v.code });
          if (check) {
            let ok;
            try { ok = check(v); } catch (e) { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { bad: true }); }
            if (ok === false) throw Object.assign(new Error(`${s.id} sent a reply that is no good`), { bad: true });
          }
          strikes.delete(s.id);
          return v;
        } catch (e) {
          if (reverted(e) && !e.bad) throw Object.assign(e, { revert: true, data: typeof e.data === 'string' ? e.data : null });
          last = e;
          const kind = kindOf(e);
          if (kind !== 'limited') onlyLimited = false;
          rest(s, method, kind, e?.rest);
        }
      }
      if (now() - t0 > patience) break;
    }
    throw onlyLimited && last ? new Error(BUSY) : last || new Error('no RPC answered');
  };
}

// ── calldata ──
const strip = (h) => String(h).replace(/^0x/, '');
export const word = (v) => BigInt(v).toString(16).padStart(64, '0');
export const addrWord = (a) => strip(a).toLowerCase().padStart(64, '0');
export const wordAt = (hex, i) => BigInt('0x' + (strip(hex).slice(i * 64, (i + 1) * 64) || '0'));
const addrAt = (hex, i) => '0x' + strip(hex).slice(i * 64 + 24, (i + 1) * 64);

// The governed terms the owner can announce a change to, in the contract's order (depth, mint, liquidation, bonus, owner window, auction, minimum debt).
export const TERM_IDS = [0, 1, 2, 3, 4, 5, 6];
// How long after its time an announcement can still be carried out.
export const QUEUE_EXPIRY = 14 * 86400;
export const SEL = {
  TAC: '0x19f68523', SYNTH: '0xe1eddde3', MINT_RATIO_BPS: '0x347bbf43', LIQ_RATIO_BPS: '0x3473b38c', OWNER_WINDOW: '0x89c90a65', AUCTION_DURATION: '0xa271e525',
  MIN_DEBT: '0xa1034103', REDEMPTION_FEE_BPS: '0xcc1d2090', DEPTH_BPS: '0x418be017',
  totalDebt: '0xfc7b9c18', debtCeiling: '0xe1c84ea4', depthCeiling: '0x16275096', borrowFeeBps: '0xb76b0aa7', valueOf: '0x195168b6', liquidationPrice: '0xb6fc2d5f', offerPrice: '0x3bf19e29',
  vaults: '0xa622ee7c', recovered: '0x0015aa6c', onOffer: '0x6a76229f', pausedUntil: '0xda748b10', auctionTime: '0x155f586d', queuedParam: '0x01641934', pendingOracleEta: '0xf1c99189', pendingMinterEta: '0x294ac4e2',
  deposit: '0xb6b55f25', withdraw: '0x2e1a7d4d', borrow: '0x0ecbcdab', repay: '0x22867d78', cancel: '0x4c33fe94', permitTac: '0x1de38e64', permitSynth: '0xba8c86f1', multicall: '0xac9650d8',
  balanceOf: '0x70a08231', allowance: '0xdd62ed3e', approve: '0x095ea7b3', nonces: '0x7ecebe00', name: '0x06fdde03', symbol: '0x95d89b41', timestamp: '0x0f28c97d',
  ORACLE: '0x38013f02', ETH_USD: '0x6260f55b', FEED_MAX_STALENESS: '0xf5d48317', spot: '0x6f265b93', latestRoundData: '0xfeaf968c', decimals: '0x313ce567',
};
export const encDeposit = (amount) => SEL.deposit + word(amount);
export const encWithdraw = (amount) => SEL.withdraw + word(amount);
export const encBorrow = (amount, maxFeeBps) => SEL.borrow + word(amount) + word(maxFeeBps);
export const encRepay = (owner, amount) => SEL.repay + addrWord(owner) + word(amount);
export const encCancel = (owner) => SEL.cancel + addrWord(owner);
export const encApprove = (spender, amount) => SEL.approve + addrWord(spender) + word(amount);
// The vault's own permit calls (TAC's for a deposit, the synth's for a repayment): the permit applies to the vault as spender.
export const encPermit = (which, { value, deadline, v, r, s }) => SEL[which] + word(value) + word(deadline) + word(v) + strip(r).padStart(64, '0') + strip(s).padStart(64, '0');
// Multicallable.multicall(bytes[]): each call runs as the sender, so a permit and what it unlocks are one transaction.
export function encMulticall(datas) {
  let head = '', tail = '', off = datas.length * 32;
  for (const d of datas) {
    const h = strip(d), body = word(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64, '0');
    head += word(off); tail += body; off += body.length / 2;
  }
  return SEL.multicall + word(32) + word(datas.length) + head + tail;
}

// ── reading ──
export function makeReader(rpc) {
  const ethCall = (to, data, o = {}) => rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}) }, 'latest']);
  // `calls` are [name, to, data] (the lists below) or { to, data }.
  const batch = async (calls) => {
    const list = calls.map((c) => (Array.isArray(c) ? { to: c[1], data: c[2] } : c));
    return list.length ? _internal.decAggregate3(await ethCall(MULTICALL3, _internal.encAggregate3(list)), list.length) : [];
  };
  return { ethCall, batch };
}

const nameOf = (list, res) => Object.fromEntries(list.map(([k], i) => [k, res[i]]));
const U = (x) => (x == null ? null : wordAt(x, 0));
// An ABI string (a token's symbol).
export function decString(x) {
  if (x == null) return null;
  try { const n = Number(wordAt(x, 1)), h = strip(x).slice(128, 128 + n * 2); return new TextDecoder().decode(Uint8Array.from(h.match(/../g) || [], (b) => parseInt(b, 16))); } catch { return null; }
}

// What a vault never changes: its two tokens and its terms.
export const staticCalls = (vault) => [
  ['tac', vault, SEL.TAC], ['synth', vault, SEL.SYNTH], ['mint', vault, SEL.MINT_RATIO_BPS], ['liq', vault, SEL.LIQ_RATIO_BPS], ['ownerWindow', vault, SEL.OWNER_WINDOW],
  ['auctionDuration', vault, SEL.AUCTION_DURATION], ['minDebt', vault, SEL.MIN_DEBT], ['redemptionFee', vault, SEL.REDEMPTION_FEE_BPS], ['depthBps', vault, SEL.DEPTH_BPS],
  ['oracle', vault, SEL.ORACLE], ['feed', vault, SEL.ETH_USD], ['staleness', vault, SEL.FEED_MAX_STALENESS],
];
export function parseStatic(res) {
  const r = nameOf(staticCalls('0x'), res);
  if (Object.values(r).some((x) => x == null)) return null;
  return {
    tac: addrAt(r.tac, 0), synth: addrAt(r.synth, 0), mint: wordAt(r.mint, 0), liq: wordAt(r.liq, 0), ownerWindow: Number(wordAt(r.ownerWindow, 0)), auctionDuration: Number(wordAt(r.auctionDuration, 0)),
    minDebt: wordAt(r.minDebt, 0), redemptionFee: wordAt(r.redemptionFee, 0), depthBps: wordAt(r.depthBps, 0), oracle: addrAt(r.oracle, 0), feed: addrAt(r.feed, 0), staleness: Number(wordAt(r.staleness, 0)),
  };
}

// What changes: the vault's totals, fees and prices (a view that has no price to give fails, and is null here), the synth's symbol and, for an
// account, its vault and what it holds and has approved.
export function dynamicCalls(V, who) {
  const v = V.addr;
  return [
    ['totalDebt', v, SEL.totalDebt], ['debtCeiling', v, SEL.debtCeiling], ['depthCeiling', v, SEL.depthCeiling], ['feeBps', v, SEL.borrowFeeBps],
    ['pB', v, SEL.valueOf + word(WAD) + word(1)], ['pL', v, SEL.liquidationPrice], ['pO', v, SEL.offerPrice], ['symbol', V.synth, SEL.symbol], ['pausedUntil', v, SEL.pausedUntil], ['auctionTime', v, SEL.auctionTime],
    ...TERM_IDS.map((id) => ['q' + id, v, SEL.queuedParam + word(id)]), ['oracleEta', v, SEL.pendingOracleEta], ['minterEta', V.synth, SEL.pendingMinterEta],
    ['held', V.tac, SEL.balanceOf + addrWord(v)], ['spot', V.oracle, SEL.spot], ['round', V.feed, SEL.latestRoundData], ['feedDec', V.feed, SEL.decimals],
    ...(who ? [
      ['vault', v, SEL.vaults + addrWord(who)], ['recovered', v, SEL.recovered + addrWord(who)], ['onOffer', v, SEL.onOffer + addrWord(who)],
      ['tacBal', V.tac, SEL.balanceOf + addrWord(who)], ['tacAllow', V.tac, SEL.allowance + addrWord(who) + addrWord(v)],
      ['synBal', V.synth, SEL.balanceOf + addrWord(who)], ['synAllow', V.synth, SEL.allowance + addrWord(who) + addrWord(v)],
    ] : []),
  ];
}
export function parseDynamic(V, who, res) {
  const r = nameOf(dynamicCalls(V, who), res);
  const out = { totalDebt: U(r.totalDebt), debtCeiling: U(r.debtCeiling), depthCeiling: U(r.depthCeiling), feeBps: U(r.feeBps), pB: U(r.pB), pL: U(r.pL), pO: U(r.pO), symbol: decString(r.symbol), pausedUntil: U(r.pausedUntil), auctionTime: r.auctionTime ? Number(wordAt(r.auctionTime, 0)) : null };
  // The changes the owner has announced and not yet made: [{ id, value, eta }], and the time a new oracle may be put in (0 for none).
  out.announced = TERM_IDS.map((id) => (r['q' + id] ? { id, value: wordAt(r['q' + id], 0), eta: Number(wordAt(r['q' + id], 1)) } : null)).filter((a) => a && a.eta > 0);
  out.oracleEta = r.oracleEta ? Number(wordAt(r.oracleEta, 0)) : 0;
  // The time another contract the owner has named may start minting the synth (0 for none).
  out.minterEta = r.minterEta ? Number(wordAt(r.minterEta, 0)) : 0;
  // The TAC deposited in the vault (its balance), the oracle's ETH per TAC now (the thinner of the venues' prices) and the ETH/USD answer the vault
  // converts with: its value, its decimals and when it was last updated.
  out.held = U(r.held); out.spot = U(r.spot);
  out.feed = r.round ? { answer: wordAt(r.round, 1), updatedAt: Number(wordAt(r.round, 3)), decimals: r.feedDec ? Number(wordAt(r.feedDec, 0)) : 8 } : null;
  if (who) {
    out.me = r.vault ? { collateral: wordAt(r.vault, 0), debt: wordAt(r.vault, 1), auctionStart: Number(wordAt(r.vault, 2)) } : null;
    out.recovered = r.recovered == null ? null : wordAt(r.recovered, 0) === 1n;
    out.onOffer = U(r.onOffer);
    out.tacBal = U(r.tacBal); out.tacAllow = U(r.tacAllow); out.synBal = U(r.synBal); out.synAllow = U(r.synAllow);
  }
  return out;
}
export const timestampCall = () => ['ts', MULTICALL3, SEL.timestamp];

// ── what a refused call says ──
// The first four bytes of a revert's data name the contract's error. Prices that are not recorded yet or a feed that is not fresh pause lending.
const ERRORS = {
  '0xfddafdf5': 'limit', '0x22a095d1': 'room', '0x266fe7fc': 'auction', '0x749b5939': 'amount', '0xcd4e6167': 'fee', '0xc149905d': 'paused', '0xa889a81f': 'paused', '0xa0cd3bb2': 'paused', '0xb0171a5d': 'paused',
  '0x71d00de2': 'noauction', '0x53da3010': 'unhealthy', '0xda1dae0c': 'healthy', '0x47db04b6': 'ownerwindow', '0x5419376a': 'paused',
  '0x13be252b': 'access', '0x7939f424': 'access', '0xf4d678b8': 'balance',
};
export const refusal = (e) => ERRORS[String(e?.data || '').slice(0, 10).toLowerCase()] || null;
