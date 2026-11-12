import { ZROUTER, SNWAP_EXECUTORS } from '/zrouter-guard.js';

const ETH = '0x0000000000000000000000000000000000000000', SENT = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', ZFI = 'https://api.zfi.wei.is';
const lc = (s) => String(s || '').toLowerCase();
const strip = (h) => String(h || '').replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => lc(strip(a)).padStart(64, '0');
const bytes = (h) => { const s = strip(h); return word(s.length / 2) + s.padEnd(Math.ceil(s.length / 64) * 64, '0'); };
const big = (v) => (/^\d+$/.test(String(v ?? '')) && BigInt(v) > 0n ? BigInt(v) : null);
const tok = (a) => (lc(a) === ETH ? SENT : a);
const fwdOf = (name) => Object.keys(SNWAP_EXECUTORS).find((a) => SNWAP_EXECUTORS[a] === name);
const json = async (url, signal, init) => { const r = await fetch(url, { signal, ...init }); return r.ok ? r.json() : null; };
const post = (url, body, signal) => json(url, signal, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const SOLVERS = [
  { id: '0x', name: '0x', fwd: fwdOf('0x'),
    price: (q, s) => json(`${ZFI}/0x/swap/allowance-holder/price?${new URLSearchParams({ chainId: '1', sellToken: tok(q.tokenIn), buyToken: tok(q.tokenOut), taker: fwdOf('0x'), sellAmount: String(q.amountIn) })}`, s)
      .then((j) => ({ out: big(j?.buyAmount) })),
    firm: (q, _c, s) => json(`${ZFI}/0x/swap/allowance-holder/quote?${new URLSearchParams({ chainId: '1', sellToken: tok(q.tokenIn), buyToken: tok(q.tokenOut), taker: fwdOf('0x'), slippageBps: String(q.slippageBps), sellAmount: String(q.amountIn) })}`, s)
      .then((j) => j?.transaction?.to && { router: j.transaction.to, data: j.transaction.data, out: big(j.buyAmount) }) },
  { id: 'paraswap', name: 'ParaSwap', fwd: fwdOf('ParaSwap'),
    price: (q, s) => json(`https://api.paraswap.io/prices?${new URLSearchParams({ srcToken: tok(q.tokenIn), destToken: tok(q.tokenOut), amount: String(q.amountIn), srcDecimals: String(q.decIn), destDecimals: String(q.decOut), side: 'SELL', network: '1', version: '6.2' })}`, s)
      .then((j) => ({ out: big(j?.priceRoute?.destAmount), ctx: j?.priceRoute })),
    firm: async (q, route, s) => {
      const fresh = await json(`https://api.paraswap.io/prices?${new URLSearchParams({ srcToken: tok(q.tokenIn), destToken: tok(q.tokenOut), amount: String(q.amountIn), srcDecimals: String(q.decIn), destDecimals: String(q.decOut), side: 'SELL', network: '1', version: '6.2' })}`, s).then((j) => j?.priceRoute).catch(() => null);
      const pr = fresh?.destAmount ? fresh : route;
      return post('https://api.paraswap.io/transactions/1?ignoreChecks=true', { srcToken: tok(q.tokenIn), destToken: tok(q.tokenOut), srcAmount: String(q.amountIn), srcDecimals: pr.srcDecimals, destDecimals: pr.destDecimals, priceRoute: pr, userAddress: fwdOf('ParaSwap'), partner: 'tacit', slippage: q.slippageBps }, s)
        .then((j) => j?.to && { router: j.to, data: j.data, out: big(pr.destAmount) });
    } },
  { id: 'kyber', name: 'KyberSwap', fwd: fwdOf('KyberSwap'),
    price: (q, s) => json(`https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?${new URLSearchParams({ tokenIn: tok(q.tokenIn), tokenOut: tok(q.tokenOut), amountIn: String(q.amountIn) })}`, s)
      .then((j) => ({ out: big(j?.data?.routeSummary?.amountOut), ctx: j?.data?.routeSummary })),
    firm: (q, summary, s) => post('https://aggregator-api.kyberswap.com/ethereum/api/v1/route/build', { routeSummary: summary, sender: fwdOf('KyberSwap'), recipient: fwdOf('KyberSwap'), slippageTolerance: q.slippageBps }, s)
      .then((j) => j?.data?.routerAddress && { router: j.data.routerAddress, data: j.data.data, out: big(j.data.amountOut) }) },
  { id: '1inch', name: '1inch', fwd: fwdOf('1inch'),
    price: (q, s) => json(`${ZFI}/1inch/swap/v6.0/1/quote?${new URLSearchParams({ src: tok(q.tokenIn), dst: tok(q.tokenOut), amount: String(q.amountIn) })}`, s)
      .then((j) => ({ out: big(j?.dstAmount) })),
    firm: (q, _c, s) => json(`${ZFI}/1inch/swap/v6.0/1/swap?${new URLSearchParams({ src: tok(q.tokenIn), dst: tok(q.tokenOut), amount: String(q.amountIn), from: fwdOf('1inch'), slippage: String(Number(q.slippageBps) / 100), disableEstimate: 'true' })}`, s)
      .then((j) => j?.tx?.to && { router: j.tx.to, data: j.tx.data, out: big(j.dstAmount) }) },
  { id: 'okx', name: 'OKX', fwd: fwdOf('OKX'),
    price: (q, s) => json(`${ZFI}/okx/dex/aggregator/quote?${new URLSearchParams({ chainIndex: '1', fromTokenAddress: tok(q.tokenIn), toTokenAddress: tok(q.tokenOut), amount: String(q.amountIn), swapMode: 'exactIn' })}`, s)
      .then((j) => ({ out: j?.code === '0' ? big(j.data?.[0]?.toTokenAmount) : null })),
    firm: (q, _c, s) => json(`${ZFI}/okx/dex/aggregator/swap?${new URLSearchParams({ chainIndex: '1', fromTokenAddress: tok(q.tokenIn), toTokenAddress: tok(q.tokenOut), amount: String(q.amountIn), slippagePercent: String(Number(q.slippageBps) / 100), userWalletAddress: fwdOf('OKX'), swapMode: 'exactIn' })}`, s)
      .then((j) => { const d = j?.code === '0' ? j.data?.[0] : null; return d?.tx?.to && { router: d.tx.to, data: d.tx.data, out: big(d.routerResult?.toTokenAmount) }; }) },
];
export const solverOf = (id) => SOLVERS.find((v) => v.id === id) || null;

const timed = async (ms, f) => { const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms); try { return await f(ac.signal); } catch { return null; } finally { clearTimeout(t); } };

export const priceOf = (v, q, ms = 3500) => timed(ms, (s) => v.price(q, s)).then((p) => (p?.out ? { id: v.id, name: v.name, fwd: v.fwd, out: p.out, ctx: p.ctx } : null));
export const prices = async (q, ms = 3500) => (await Promise.all(SOLVERS.map((v) => priceOf(v, q, ms)))).filter(Boolean);
export const firm = (id, q, ctx, ms = 10000) => { const v = solverOf(id); return v ? timed(ms, (s) => v.firm(q, ctx, s)) : Promise.resolve(null); };

export function snwapCall({ tokenIn, tokenOut, amountIn, to, minOut, fwd, router, data }) {
  const ethIn = lc(tokenIn) === ETH;
  const inner = '54d61b9c' + addr(router) + addr(tokenIn) + addr(tokenOut) + addr(to) + word(5 * 32) + bytes(data);
  const call = '0x5f3bd1c8' + addr(tokenIn) + word(ethIn ? 0n : amountIn) + addr(to) + addr(tokenOut) + word(minOut) + addr(fwd) + word(7 * 32) + bytes(inner);
  return { to: ZROUTER, data: call, value: ethIn ? BigInt(amountIn) : 0n };
}
