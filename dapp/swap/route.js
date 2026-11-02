// The swap page's routes that the trade page's venues (evm-trade-venues.js) do not make:
//
//   - any ERC-20 into TAC in ONE transaction, through zRouter: zQuoter finds the best pool for the token against WETH (Uniswap, Sushi,
//     Curve, zAMM), that leg buys an exact amount of WETH and delivers it straight to PrecisionRoute, and PrecisionRoute's
//     `routeFromWETH` unwraps it and buys TAC from the Precision pool. The WETH leg is exact-out because PrecisionRoute's checkpoint
//     commits to the exact calldata it will run (amount included) and refuses any other balance change; whatever of the token the
//     leg does not need stays with its owner.
//   - ETH to and from tacUSD and tacBTC in the Tacit pool's public door (TacitPublicAmm), the same reserves its private swaps use.
//   - a Tacit asset (TAC, tacUSD, tacBTC) out to any ERC-20 in ONE transaction: the pool (or Precision) pays its ETH to zRouter, which wraps it,
//     and zQuoter's swap of that WETH pays the wallet. zRouter keeps what a call pays to it for the next leg, which is what lets one leg feed another.
//   - any ERC-20 into tacUSD or tacBTC in ONE transaction: zQuoter buys an exact amount of WETH for zRouter, and an snwap hands that WETH to
//     TacitAmmRoute (the snwap executor), which unwraps it and swaps the ETH through TacitPublicAmm to the recipient. zRouter's own `execute` would
//     reach TacitPublicAmm only if its owner trusted it, which this does not need. The route is offered when `ammRouteLive` finds TacitAmmRoute
//     deployed (a read, so the page switches it on by itself once it is).
//
// How the token reaches zRouter, best first: an EIP-2612 permit signed for free (USDC, wstETH, TAC, tacUSD, tacBTC and most new tokens;
// DAI's own permit), a Permit2 signature where the token already allows Permit2, else an approval of the exact amount.
//
// The page passes `ethCall(to, data, block?, { from, value, gas })`, `keccak256(bytes) -> bytes` and the trade venues. The one import is the guard
// that reads what zQuoter returns against what was asked: its bytes run as the sender.

import { checkZRouterCall, decodeZRouterCall } from '../zrouter-guard.js';
// The card's check of a zQuoter answer: the guard's, taking zRouter's own choice of SushiSwap's pool or the hookless zAMM (a deadline of type(uint256).max, which runs with a
// window of its own of 30 minutes from when it runs) as the deadline asked. The least the swap pays is still held to what was asked, and the swap is simulated before it is sent.
export const checkRoute = (callData, want) => checkZRouterCall(callData, { sentinel: true, ...want });

export const ZERO = '0x0000000000000000000000000000000000000000';
export const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
export const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
export const CUSD = '0x23cACFFAc2674514A6d4F6cD420B4cc2aC921564';
export const CBTC = '0xdf1d99148bEb7a9AFf1d95C49B3d22b7ed90D696';
export const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
export const ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4';
export const ZQUOTER = '0x000000bd2DB80567c23E353ca95a251c573cBf9B';
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const PRECISION_ROUTE = '0x0000007Be74558A1F8c9045301c6F44C8eD0c9eB';
export const PRECISION_GUARD = '0x00000057B53fB5feEdedaf7066e1f1C7002b1961';
export const TACIT_AMM = '0x00000000E36C7EC997CC59DCda9E03673B448119';
// contracts/src/TacitAmmRoute.sol (WETH → ETH → TacitPublicAmm for an snwap), at the address CreateX gives its init code under an open salt (the /tasks job
// `amm-route` deploys it there from any wallet).
export const TACIT_AMM_ROUTE = '0x00000065e3e51af95d330fb6932cA3E87912c554';
export const CONF_ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992';
// The Tacit pool's asset ids: tETH's shared id, and each canonical token's ASSET_ID().
export const POOL_ID = {
  [ZERO]: '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34',
  [TAC]: '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b',
  [CUSD]: '0x8f4490dd3728b0ee904d7a67c11b37ffd463a5c7f08b79810006995ee8a9679d',
  [CBTC]: '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8',
};
export const AMM_FEE = 30n;                  // the founded tier of each Tacit pool pair
export const UNIT = 10n ** 10n;              // the pool takes 18-decimal amounts in steps of 1e10 (8 decimals inside)

// The tokens the picker offers before any is pasted. `permit`: the EIP-2612 version, 'dai' for DAI's own permit, null for none. `psym`: the
// name of the same token as a private note in the Tacit pool (tacUSD in public is cUSD in private, tacBTC is cBTC).
export const TOKENS = [
  { sym: 'ETH', name: 'Ether', addr: ZERO, dec: 18, icon: 'eth' },
  { sym: 'TAC', name: 'Tacit', addr: TAC, dec: 18, icon: 'tac', permit: '1' },
  { sym: 'tacUSD', name: 'Tacit USD', psym: 'cUSD', addr: CUSD, dec: 18, icon: 'cusd', permit: '1' },
  { sym: 'tacBTC', name: 'Tacit Bitcoin', psym: 'cBTC', addr: CBTC, dec: 18, icon: 'cbtc', permit: '1' },
  { sym: 'USDC', name: 'USD Coin', addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', dec: 6, icon: 'usdc', permit: '2' },
  { sym: 'USDT', name: 'Tether', addr: '0xdAC17F958D2ee523a2206206994597C13D831ec7', dec: 6, icon: 'usdt', permit: null },
  { sym: 'DAI', name: 'Dai', addr: DAI, dec: 18, icon: 'dai', permit: 'dai' },
  { sym: 'WETH', name: 'Wrapped ether', addr: WETH, dec: 18, icon: 'eth', permit: null },
  { sym: 'wstETH', name: 'Lido wrapped staked ether', addr: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', dec: 18, icon: 'wsteth', permit: '1' },
  { sym: 'WBTC', name: 'Wrapped bitcoin', addr: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', dec: 8, icon: 'btc', permit: null },
];
export const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
export const tacitToken = (a) => [TAC, CUSD, CBTC].some((t) => same(t, a));

// ── encoding ──
const strip = (h) => String(h || '').replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => strip(a).toLowerCase().padStart(64, '0');
const b32 = (h) => strip(h).toLowerCase().padStart(64, '0');
const pad = (h) => h.padEnd(Math.ceil(h.length / 64) * 64, '0');
const wordAt = (h, i) => BigInt('0x' + (strip(h).slice(i * 64, (i + 1) * 64) || '0'));
const bytes = (h) => Uint8Array.from((strip(h).match(/../g) || []).map((x) => parseInt(x, 16)));
const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const utf8 = (s) => new TextEncoder().encode(s);
const dyn = (h) => { const d = strip(h); return word(d.length / 2) + pad(d); };

const SEL = {
  buildBestSwap: 'e7798987', snwap: '5f3bd1c8', multicall: 'ac9650d8', permit: '7ac2ff7b', permitDAI: '230390f4', permit2From: '09d31579', sweep: 'cb019b84',
  guardDeadline: '10c2e3cd', checkpoint: '0b7c6c6c', routeFromWETH: '78fd78b0', wrap: 'ea598cb0', aggregate3: '82ad56cb', ammRoute: '4f987fff', ammRouteAmm: '44a70686',
  quoteSwap: '3bc1414a', swapPublic: 'cfdf9dcc', swapPublicWithPermit: '53c87456',
  balanceOf: '70a08231', allowance: 'dd62ed3e', approve: '095ea7b3', nonces: '7ecebe00', domain: '3644e515', p2allowance: '927da105',
  name: '06fdde03', symbol: '95d89b41', decimals: '313ce567',
};
export const encApprove = (spender, amount) => '0x' + SEL.approve + addr(spender) + word(amount);
const encSnwap = ({ tokenIn = ZERO, amountIn = 0n, recipient, tokenOut = ZERO, minOut = 0n, executor, data }) =>
  '0x' + SEL.snwap + addr(tokenIn) + word(amountIn) + addr(recipient) + addr(tokenOut) + word(minOut) + addr(executor) + word(224) + dyn(data);
export function encMulticall(calls) {
  let head = '', tail = '', off = calls.length * 32;
  for (const c of calls) { const body = dyn(c); head += word(off); tail += body; off += body.length / 2; }
  return '0x' + SEL.multicall + word(32) + word(calls.length) + head + tail;
}
const encRouteFromWeth = ({ pools, amountIn, minOut, to }) =>
  '0x' + SEL.routeFromWETH + word(160) + addr(TAC) + word(amountIn) + word(minOut) + addr(to) + word(pools.length) + pools.map(addr).join('');
const encSwapPublic = ({ assetIn, assetOut, feeBps = AMM_FEE, amountIn, minOut, deadline, to }) =>
  '0x' + SEL.swapPublic + b32(assetIn) + b32(assetOut) + word(feeBps) + word(amountIn) + word(minOut) + word(deadline) + addr(to);
const encAmmRoute = ({ assetOut, minOut, deadline, to }) => '0x' + SEL.ammRoute + b32(assetOut) + word(AMM_FEE) + word(minOut) + word(deadline) + addr(to);

// ── reads ──
// A Multicall3 aggregate3 with every call allowed to fail: a token that lacks a function answers null for it.
const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
async function reads(ethCall, calls) {
  let head = '', tail = '', off = calls.length * 32;
  for (const c of calls) { const body = addr(c.to) + word(1) + word(96) + dyn(c.data); head += word(off); tail += body; off += body.length / 2; }
  const raw = strip(await ethCall(MC3, '0x82ad56cb' + word(32) + word(calls.length) + head + tail));
  const n = Number(wordAt(raw, 1));
  return Array.from({ length: n }, (_, i) => {
    const at = Number(wordAt(raw, 2 + i)) / 32 + 2, ok = wordAt(raw, at) === 1n, len = Number(wordAt(raw, at + 2));
    return ok && len ? '0x' + raw.slice((at + 3) * 64, (at + 3) * 64 + len * 2) : null;
  });
}
const decString = (h) => {
  if (!h) return null;
  const s = strip(h);
  if (s.length === 64) return new TextDecoder().decode(bytes(s.replace(/(00)+$/, ''))) || null;   // a bytes32 name (MKR's kind)
  const len = Number(wordAt(s, 1)); return new TextDecoder().decode(bytes(s.slice(128, 128 + len * 2)));
};

// A token the picker does not list, from its address: its symbol, decimals, and whether its permit is EIP-2612 under the name it reports
// (the domain separator it publishes is recomputed for version 1 and 2; one that matches is the version to sign).
export async function readToken({ ethCall, keccak256, address }) {
  const [sym, dec, name, ds, nonce] = await reads(ethCall, [
    { to: address, data: '0x' + SEL.symbol }, { to: address, data: '0x' + SEL.decimals }, { to: address, data: '0x' + SEL.name },
    { to: address, data: '0x' + SEL.domain }, { to: address, data: '0x' + SEL.nonces + addr(ZERO) },
  ]);
  if (!dec) return null;
  const nm = decString(name) || '', t = { sym: (decString(sym) || '???').slice(0, 12), name: nm.slice(0, 40), addr: address, dec: Number(wordAt(dec, 0)), icon: null, permit: null, custom: true };
  if (t.dec > 36) return null;
  if (ds && nonce && nm) t.permit = ['1', '2'].find((v) => same(domainSeparator({ keccak256, name: nm, version: v, token: address }), '0x' + strip(ds).slice(0, 64))) || null;
  return t;
}
const DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
export function domainSeparator({ keccak256, name, version, token, chainId = 1 }) {
  return hex(keccak256(bytes(b32(hex(keccak256(utf8(DOMAIN_TYPE)))) + b32(hex(keccak256(utf8(name)))) + b32(hex(keccak256(utf8(version)))) + word(chainId) + addr(token))));
}

// What the account holds of the token and has allowed zRouter and Permit2 (and Permit2 has allowed zRouter), and its permit nonce.
export async function readAccess({ ethCall, token, owner, spender = ZROUTER }) {
  if (same(token, ZERO)) return null;
  const [bal, allowed, p2, nonce] = await reads(ethCall, [
    { to: token, data: '0x' + SEL.balanceOf + addr(owner) }, { to: token, data: '0x' + SEL.allowance + addr(owner) + addr(spender) },
    { to: token, data: '0x' + SEL.allowance + addr(owner) + addr(PERMIT2) }, { to: token, data: '0x' + SEL.nonces + addr(owner) },
  ]);
  return { balance: bal ? wordAt(bal, 0) : 0n, allowed: allowed ? wordAt(allowed, 0) : 0n, permit2: p2 ? wordAt(p2, 0) : 0n, nonce: nonce ? wordAt(nonce, 0) : null };
}

// ── zQuoter: the best single pool for `tokenIn` against WETH. → { source, feeBps, amountIn, amountOut, callData, amountLimit } or null ──
export const SOURCES = ['Uniswap v2', 'Sushi', 'zAMM', 'Uniswap v3', 'Uniswap v4', 'Curve', 'Lido', 'WETH', 'Uniswap v4'];
// The quote the screen shows may be asked for several times at once and again within seconds (the page re-quotes when prices, the token list or the contract
// are read), and each ask is a scan of every pool: with `reuse`, an ask for the same recipient, tokens, amount, slippage and deadline within ten seconds shares the
// one in flight or just done, and the deadline of such a quote is rounded up to the minute so that repeated asks are the same ask. What a transaction is built
// from is asked fresh (no `reuse`), so its call data carries its own deadline.
const coarse = (d) => ((BigInt(d) + 59n) / 60n) * 60n;
const ZQ_REUSE_MS = 10_000, zqMemo = new Map();
function zqSwap(args) {
  if (!args.reuse) return zqRead(args);
  const { to, tokenIn, tokenOut, amount, exactOut, slippageBps, deadline } = args, key = [to, exactOut ? 1 : 0, tokenIn, tokenOut, amount, slippageBps, deadline].map((x) => String(x).toLowerCase()).join(':'), t = Date.now();
  const hit = zqMemo.get(key);
  if (hit && t - hit.at < ZQ_REUSE_MS) return hit.p;
  for (const [k, v] of zqMemo) if (t - v.at >= ZQ_REUSE_MS) zqMemo.delete(k);
  const p = zqRead(args);
  zqMemo.set(key, { at: t, p });
  p.catch(() => { if (zqMemo.get(key)?.p === p) zqMemo.delete(key); });
  return p;
}
// zQuoter's best single swap, as one zRouter call: null when no pool trades it (or zQuoter reverts).
async function zqBest({ ethCall, to, tokenIn, tokenOut, amount, exactOut, slippageBps, deadline }) {
  const data = '0x' + SEL.buildBestSwap + addr(to) + word(exactOut ? 1 : 0) + addr(tokenIn) + addr(tokenOut) + word(amount) + word(slippageBps) + word(deadline);
  let raw;
  try { raw = strip(await ethCall(ZQUOTER, data, 'latest', { gas: '0x5F5E100' })); } catch (e) { if (e?.revert || /revert/i.test(e?.message || '')) return null; throw e; }
  if (raw.length < 448) return null;
  const at = Number(wordAt(raw, 4)) / 32, len = Number(wordAt(raw, at));
  return { source: Number(wordAt(raw, 0)), feeBps: wordAt(raw, 1), amountIn: wordAt(raw, 2), amountOut: wordAt(raw, 3), callData: '0x' + raw.slice((at + 1) * 64, (at + 1) * 64 + len * 2), amountLimit: wordAt(raw, 5), msgValue: wordAt(raw, 6) };
}
async function zqRead(args) {
  const q = await zqBest(args);
  return q && q.amountOut > 0n && q.amountIn > 0n && q.msgValue === 0n ? q : null;
}
// ETH → a token, paid to `to`, as one zRouter call that is sent the ETH itself: what a private exit's escrow runs (dapp/swap/private.js).
// It must sell exactly `amount`, be sent exactly that, pay `to`, and pay at least its own limit, or it is not used. → the quote, or null.
export async function quoteEthToToken({ ethCall, to, tokenOut, amount, slippageBps = 50, deadline }) {
  if (same(tokenOut, ZERO) || same(tokenOut, WETH) || tacitToken(tokenOut)) return null;
  const q = await zqBest({ ethCall, to, tokenIn: ZERO, tokenOut, amount, exactOut: false, slippageBps, deadline });
  if (!q || q.amountOut <= 0n || q.amountLimit <= 0n || q.amountIn !== BigInt(amount) || q.msgValue !== BigInt(amount)) return null;
  if (checkRoute(q.callData, { to, tokenIn: ZERO, tokenOut, exactOut: false, amount, maxIn: amount, minOut: q.amountLimit, deadline })) return null;
  return { ...q, name: SOURCES[q.source] || 'a pool', to, tokenOut, deadline };
}
const bestToWeth = ({ ethCall, tokenIn, amount, exactOut, slippageBps, deadline, reuse }) => zqSwap({ ethCall, to: PRECISION_ROUTE, tokenIn, tokenOut: WETH, amount, exactOut, slippageBps, deadline, reuse });

// Any ERC-20 → TAC. `venues.quotePrecision` prices the TAC leg (the Precision pool the lens finds best, which the policy allows).
// Spends at most `amountIn`: the WETH bought is what `amountIn` buys less `slippageBps`, so the leg's own limit (its quote plus the same
// margin) stays inside what was typed. → { kind: 'any', token, amountIn, maxIn, spend, weth, tacOut, pool, hop } or null (no pool for the token).
export async function quoteAnyToTac({ ethCall, venues, token, amountIn, account, slippageBps = 50, deadline, reuse = false }) {
  const slip = BigInt(slippageBps), dl0 = deadline ?? BigInt(Math.floor(Date.now() / 1000) + 1800), dl = reuse ? coarse(dl0) : dl0;
  let weth, hop = null;
  if (same(token, WETH)) weth = amountIn;
  else {
    const fwd = await bestToWeth({ ethCall, tokenIn: token, amount: amountIn, exactOut: false, slippageBps: 0, deadline: dl, reuse });
    if (!fwd) return null;
    weth = (fwd.amountOut * (10000n - slip)) / 10000n;
    for (let i = 0; i < 3 && weth > 0n; i++) {
      hop = await bestToWeth({ ethCall, tokenIn: token, amount: weth, exactOut: true, slippageBps: slip, deadline: dl, reuse });
      if (!hop) return null;
      if (hop.amountLimit <= amountIn) break;
      weth = (weth * amountIn * 9990n) / (hop.amountLimit * 10000n);          // a curve steeper than the margin: ask for a little less
      hop = null;
    }
    if (!hop) return null;
    // The leg must be one swap that buys exactly `weth` of WETH for PrecisionRoute and spends no more than was typed.
    if (checkRoute(hop.callData, { to: PRECISION_ROUTE, tokenIn: token, tokenOut: WETH, exactOut: true, amount: weth, maxIn: amountIn, deadline: dl })) return null;
    if (decodeZRouterCall(hop.callData)[0].limit !== hop.amountLimit) return null;
  }
  if (weth <= 0n) return null;
  const tac = await venues.quotePrecision({ dir: 'ETH_TO_TAC', amountIn: weth, account });
  if (!tac?.pool || !tac.amountOut) return null;
  return { kind: 'any', token, amountIn, maxIn: hop ? hop.amountLimit : weth, spend: hop ? hop.amountIn : weth, weth, tacOut: tac.amountOut, pool: tac.pool, hop: hop && { ...hop, name: SOURCES[hop.source] || 'a pool' }, deadline: dl };
}

// The transaction for a quoteAnyToTac answer. `to` is who receives the TAC (the payer, `account`, unless another address is given). `access` is how the token reaches zRouter:
//   { kind: 'permit', value, deadline, v, r, s }   an EIP-2612 permit to zRouter (rides as zRouter's own permit leg)
//   { kind: 'dai', nonce, expiry, v, r, s }        DAI's permit
//   { kind: 'permit2', nonce, deadline, signature } a Permit2 transfer of `maxIn` into zRouter, the unspent part swept back
//   { kind: 'approved' }                           zRouter already holds an allowance for `maxIn`
// The leg (if any) that lets zRouter take `maxIn` of `token` from the sender, by how the wallet gave access (see buildAnyToTac).
export function accessLegs(access, token, maxIn, who) {
  if (access.kind === 'permit') return ['0x' + SEL.permit + addr(token) + word(access.value) + word(access.deadline) + word(access.v) + b32(access.r) + b32(access.s)];
  if (access.kind === 'dai') return ['0x' + SEL.permitDAI + word(access.nonce) + word(access.expiry) + word(access.v) + b32(access.r) + b32(access.s)];
  if (access.kind === 'permit2') return ['0x' + SEL.permit2From + addr(token) + word(maxIn) + word(access.nonce) + word(access.deadline) + word(160) + dyn(access.signature)];
  if (access.kind === 'approved') return [];
  throw new Error(`${who}: unknown access`);
}
export function buildAnyToTac({ quote, account, to = account, minOut, keccak256, access }) {
  const { token, weth, pool, hop, maxIn, deadline } = quote;
  const route = encRouteFromWeth({ pools: [pool], amountIn: weth, minOut, to });
  const checkpoint = '0x' + SEL.checkpoint + addr(WETH) + b32(hex(keccak256(bytes(route)))) + addr(account);
  const legs = accessLegs(access, token, maxIn, 'buildAnyToTac');
  // Each call to another contract is an snwap with that contract as executor (zRouter's multicall can only call itself).
  legs.push(encSnwap({ recipient: account, executor: PRECISION_GUARD, data: '0x' + SEL.guardDeadline + word(deadline) + addr(ZROUTER) }));
  legs.push(encSnwap({ recipient: account, executor: PRECISION_ROUTE, data: checkpoint }));
  // The WETH arrives at PrecisionRoute between its checkpoint and the call that spends it: bought there (exact-out), or, for WETH itself,
  // sent there from zRouter (Permit2) or pulled from the account by the spending snwap.
  let spendIn = ZERO, spendAmt = 0n;
  if (hop) legs.push(hop.callData);
  else if (access.kind === 'permit2') legs.push('0x' + SEL.sweep + addr(WETH) + word(0) + word(weth) + addr(PRECISION_ROUTE));
  else { spendIn = WETH; spendAmt = weth; }
  legs.push(encSnwap({ tokenIn: spendIn, amountIn: spendAmt, recipient: to, tokenOut: TAC, minOut, executor: PRECISION_ROUTE, data: route }));
  if (access.kind === 'permit2' && hop) legs.push('0x' + SEL.sweep + addr(token) + word(0) + word(0) + addr(account));
  return { to: ZROUTER, data: encMulticall(legs), value: 0n };
}

// ── the Tacit pool's public door: ETH ⇄ tacUSD / tacBTC (and TAC, which the trade venues route) ──
export async function quoteAmm({ ethCall, tokenIn, tokenOut, amountIn }) {
  const a = POOL_ID[tokenIn] || POOL_ID[Object.keys(POOL_ID).find((k) => same(k, tokenIn))], b = POOL_ID[tokenOut] || POOL_ID[Object.keys(POOL_ID).find((k) => same(k, tokenOut))];
  const aligned = amountIn - (amountIn % UNIT);
  if (!a || !b || aligned <= 0n) return null;
  try {
    const out = wordAt(await ethCall(TACIT_AMM, '0x' + SEL.quoteSwap + b32(a) + b32(b) + word(AMM_FEE) + word(aligned)), 0);
    return out > 0n ? { kind: 'amm', tokenIn, tokenOut, assetIn: a, assetOut: b, amountIn: aligned, amountOut: out } : null;
  } catch { return null; }
}
// ETH in rides zRouter's snwap (as the trade page's Tacit route does). A token in goes through the confidential pool's router with the
// token's EIP-2612 permit (`permit`: { v, r, s }, signed to CONF_ROUTER for `amountIn` until `deadline`), else straight to the AMM after an approval.
export function buildAmm({ quote, account, to = account, minOut, deadline, permit = null }) {
  const { tokenIn, tokenOut, assetIn, assetOut, amountIn } = quote;
  if (same(tokenIn, ZERO)) {
    const leg = encSnwap({ amountIn, recipient: to, tokenOut, minOut, executor: TACIT_AMM, data: encSwapPublic({ assetIn, assetOut, amountIn, minOut, deadline, to }) });
    return { to: ZROUTER, data: encMulticall([leg]), value: amountIn, approval: null };
  }
  if (permit) return { to: CONF_ROUTER, value: 0n, approval: null,
    data: '0x' + SEL.swapPublicWithPermit + addr(tokenIn) + addr(tokenOut) + word(AMM_FEE) + word(amountIn) + word(minOut) + word(deadline) + addr(to) + word(permit.v) + b32(permit.r) + b32(permit.s) };
  return { to: TACIT_AMM, value: 0n, data: encSwapPublic({ assetIn, assetOut, amountIn, minOut, deadline, to }), approval: { token: tokenIn, spender: TACIT_AMM, amount: amountIn } };
}

// ── the legs the two routes below are made of ──
const encSweep = (token, to) => '0x' + SEL.sweep + addr(token) + word(0) + word(0) + addr(to);
const guardLeg = (account, deadline) => encSnwap({ recipient: account, executor: PRECISION_GUARD, data: '0x' + SEL.guardDeadline + word(deadline) + addr(ZROUTER) });
// A Multicall3 aggregate3 in which every call has to succeed.
function encAggregate3(calls) {
  let head = '', tail = '', off = calls.length * 32;
  for (const c of calls) { const body = addr(c.to) + word(0) + word(96) + dyn(c.data); head += word(off); tail += body; off += body.length / 2; }
  return '0x' + SEL.aggregate3 + word(32) + word(calls.length) + head + tail;
}

// ── a Tacit asset out to any ERC-20, public, in one transaction ──
// The pool pays its ETH to zRouter itself (a call's output may go there), zRouter wraps it, and zQuoter's exact-in swap of that WETH pays the
// wallet. `quote.leg` is the first sale: Precision (TAC only) or the Tacit pool, whichever pays more ETH.
export async function quoteTacitToToken({ ethCall, venues, tokenIn, tokenOut, amountIn, account, to = account, slippageBps = 50, deadline, reuse = false }) {
  const slip = BigInt(slippageBps), dl0 = deadline ?? BigInt(Math.floor(Date.now() / 1000) + 1800), dl = reuse ? coarse(dl0) : dl0;
  if (!tacitToken(tokenIn) || tacitToken(tokenOut) || same(tokenOut, ZERO)) return null;
  let leg = null;
  if (same(tokenIn, TAC)) {
    const best = ((await venues.route({ dir: 'TAC_TO_ETH', amountIn, account })).r?.ranked || []).find((v) => v.venue === 'precision' || v.venue === 'tacit-amm');
    if (best) leg = { venue: best.venue, quote: best, eth: BigInt(best.amountOut) };
  } else {
    const q = await quoteAmm({ ethCall, tokenIn, tokenOut: ZERO, amountIn });
    if (q) leg = { venue: 'tacit-amm', quote: { assetIn: q.assetIn, assetOut: q.assetOut, feeBps: AMM_FEE, amountIn: q.amountIn, amountOut: q.amountOut }, eth: q.amountOut };
  }
  if (!leg) return null;
  const spend = BigInt(leg.quote.amountIn), floor1 = (leg.eth * (10000n - slip)) / 10000n;
  if (floor1 <= 0n) return null;
  let hop = null, out, val, min = floor1, rest = 0n;
  if (!same(tokenOut, WETH)) {
    hop = await zqSwap({ ethCall, to, tokenIn: WETH, tokenOut, amount: floor1, exactOut: false, slippageBps: slip, deadline: dl, reuse });
    if (!hop || hop.amountLimit <= 0n) return null;
    // The second leg must be one swap that sells exactly the ETH the first leg is sure to pay, pays the recipient, and pays at least what is shown.
    if (checkRoute(hop.callData, { to, tokenIn: WETH, tokenOut, exactOut: false, amount: floor1, maxIn: floor1, minOut: hop.amountLimit, deadline: dl })) return null;
    out = hop.amountOut; min = hop.amountLimit;       // what the ETH the first leg is sure to pay buys; the rest of what it pays goes to the recipient as WETH
    rest = leg.eth - floor1; val = (hop.amountOut * leg.eth) / floor1;       // `val`: the whole sale at that rate, for the price and the comparison with the market
  } else { out = leg.eth; val = out; }
  return { kind: 'out', tokenIn, tokenOut, amountIn: spend, leg, eth: leg.eth, floor1, rest, hop: hop && { ...hop, name: SOURCES[hop.source] || 'a pool' }, out, val, min, to, deadline: dl };
}
// `access` is how the Tacit token reaches zRouter: { kind: 'permit', value, deadline, v, r, s } or { kind: 'approved' } (see buildAnyToTac).
export function buildTacitToToken({ quote, account, to = quote.to, venues, access }) {
  if (!same(to, quote.to)) throw new Error('buildTacitToToken: this quote pays another recipient');
  const { tokenIn, leg, floor1, hop, amountIn, deadline } = quote;
  const legs = accessLegs(access, tokenIn, amountIn, 'buildTacitToToken');
  if (leg.venue === 'precision') legs.push(...venues.precisionLegs({ quote: leg.quote, account, to: ZROUTER, minOut: floor1, deadline }).legs);
  else {
    const { assetIn, assetOut, feeBps } = leg.quote;
    legs.push(guardLeg(account, deadline), encSnwap({
      tokenIn, amountIn, recipient: ZROUTER, tokenOut: ZERO, minOut: floor1, executor: MC3,
      data: encAggregate3([{ to: tokenIn, data: encApprove(TACIT_AMM, amountIn) }, { to: TACIT_AMM, data: encSwapPublic({ assetIn, assetOut, feeBps: feeBps ?? AMM_FEE, amountIn, minOut: floor1, deadline, to: ZROUTER }) }]),
    }));
  }
  legs.push('0x' + SEL.wrap + word(0));
  if (hop) legs.push(hop.callData);
  legs.push(encSweep(WETH, to));       // what the swap did not sell goes to the recipient, as WETH
  return { to: ZROUTER, data: encMulticall(legs), value: 0n };
}

// ── any ERC-20 into tacUSD or tacBTC, public, in one transaction ──
// Whether TacitAmmRoute is deployed at its address and serves TacitPublicAmm: true, false, or null when the node did not say.
export async function ammRouteLive({ ethCall }) {
  try { return same('0x' + String(await ethCall(TACIT_AMM_ROUTE, '0x' + SEL.ammRouteAmm)).slice(-40), TACIT_AMM); } catch (e) {
    return /revert|execution/i.test(`${e?.data?.data || e?.data || ''} ${e?.message || ''}`) ? false : null;
  }
}
export async function quoteTokenToTacit({ ethCall, token, tokenOut, amountIn, account, to = account, slippageBps = 50, deadline, reuse = false }) {
  const slip = BigInt(slippageBps), dl0 = deadline ?? BigInt(Math.floor(Date.now() / 1000) + 1800), dl = reuse ? coarse(dl0) : dl0;
  if (same(token, ZERO) || same(token, WETH) || tacitToken(token) || !(same(tokenOut, CUSD) || same(tokenOut, CBTC))) return null;
  const fwd = await zqSwap({ ethCall, to: ZROUTER, tokenIn: token, tokenOut: WETH, amount: amountIn, exactOut: false, slippageBps: 0n, deadline: dl, reuse });
  if (!fwd) return null;
  // The WETH is bought exactly (the pool takes ETH in steps of 1e10) and for no more than was typed: a curve steeper than the margin asks for a little less.
  // One wei more is bought than is swapped: snwap leaves one wei of zRouter's balance behind when it hands the rest on.
  let weth = (fwd.amountOut * (10000n - slip)) / 10000n, hop = null;
  weth -= weth % UNIT;
  for (let i = 0; i < 3 && weth > 0n; i++) {
    hop = await zqSwap({ ethCall, to: ZROUTER, tokenIn: token, tokenOut: WETH, amount: weth + 1n, exactOut: true, slippageBps: slip, deadline: dl, reuse });
    if (!hop) return null;
    if (hop.amountLimit <= amountIn) break;
    weth = (weth * amountIn * 9990n) / (hop.amountLimit * 10000n); weth -= weth % UNIT;
    hop = null;
  }
  if (!hop || weth <= 0n) return null;
  if (checkRoute(hop.callData, { to: ZROUTER, tokenIn: token, tokenOut: WETH, exactOut: true, amount: weth + 1n, maxIn: amountIn, deadline: dl })) return null;
  if (decodeZRouterCall(hop.callData)[0].limit !== hop.amountLimit) return null;
  const amm = await quoteAmm({ ethCall, tokenIn: ZERO, tokenOut, amountIn: weth });
  if (!amm || amm.amountIn !== weth) return null;
  return { kind: 'in', token, tokenOut, amountIn, maxIn: hop.amountLimit, spend: hop.amountIn, weth, out: amm.amountOut, amm, hop: { ...hop, name: SOURCES[hop.source] || 'a pool' }, to, deadline: dl };
}
// `access` as in buildAnyToTac. The WETH the hop leaves at zRouter is handed on by an snwap to TacitAmmRoute, which unwraps it and swaps it for `to`;
// what zRouter keeps of it (one wei) goes back to the payer.
export function buildTokenToTacit({ quote, account, to = account, minOut, access }) {
  const { token, tokenOut, hop, amm, deadline, maxIn } = quote;
  const legs = accessLegs(access, token, maxIn, 'buildTokenToTacit');
  legs.push(guardLeg(account, deadline), hop.callData,
    encSnwap({ tokenIn: WETH, recipient: to, tokenOut, minOut, executor: TACIT_AMM_ROUTE, data: encAmmRoute({ assetOut: amm.assetOut, minOut, deadline, to }) }), encSweep(WETH, account));
  if (access.kind === 'permit2') legs.push(encSweep(token, account));
  return { to: ZROUTER, data: encMulticall(legs), value: 0n };
}

// ── what the wallet is asked to sign ──
export const permitTyped = ({ token, name, version, owner, spender, value, nonce, deadline }) => ({
  types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
  primaryType: 'Permit', domain: { name, version, chainId: 1, verifyingContract: token },
  message: { owner, spender, value: String(value), nonce: String(nonce), deadline: String(deadline) },
});
export const daiPermitTyped = ({ owner, nonce, expiry }) => ({
  types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    Permit: [{ name: 'holder', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'allowed', type: 'bool' }] },
  primaryType: 'Permit', domain: { name: 'Dai Stablecoin', version: '1', chainId: 1, verifyingContract: DAI },
  message: { holder: owner, spender: ZROUTER, nonce: String(nonce), expiry: String(expiry), allowed: true },
});
export const permit2Typed = ({ token, amount, nonce, deadline, spender = ZROUTER }) => ({
  types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    PermitTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
    TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }] },
  primaryType: 'PermitTransferFrom', domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2 },
  message: { permitted: { token, amount: String(amount) }, spender, nonce: String(nonce), deadline: String(deadline) },
});
// A signature as { v, r, s }.
export function splitSig(sig) {
  const h = strip(sig);
  if (h.length !== 130) throw new Error('The wallet returned a signature of the wrong length.');
  let v = parseInt(h.slice(128, 130), 16); if (v < 27) v += 27;
  return { v, r: '0x' + h.slice(0, 64), s: '0x' + h.slice(64, 128) };
}
// A Permit2 nonce: any unused one will do (Permit2's nonces are a bitmap), so a random one, well away from the low words wallets use.
export const randomNonce = () => { const b = crypto.getRandomValues(new Uint8Array(12)); return BigInt(hex(b)) + (1n << 120n); };

export const _internal = { encSnwap, encRouteFromWeth, encSwapPublic, encAmmRoute, bestToWeth, zqSwap, reads };
