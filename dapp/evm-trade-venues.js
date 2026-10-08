// Public-TAC Ethereum trading venues: quote + build calldata across every place the ERC20 TAC
// (mainnet 0xA1313eb9f3A445606D9583bcAc3ebeB56a858279) actually trades against ETH, so the market
// page can pick the best one instead of pinning a single route.
//
// Pure module: no DOM, no fetch. The caller injects `ethCall(to, data)` (same shape as
// confidential-pool-ux.js's helper) and, only if it wants the Precision/aggregator route builders
// (which bind a checkpoint to keccak256(routeData)), a `keccak256(bytes) -> bytes` function.
//
// One venue executes per trade — an atomic split across two ETH-in legs isn't safe through the
// zRouter aggregator's `snwap` (it forwards the whole msg.value to whichever executor runs first),
// so `quoteAll` ranks venues and the caller builds the winner.

export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
export const TAC_ERC20 = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
export const TAC_POOL_ASSET_ID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
export const CETH_POOL_ASSET_ID = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';

export const ZROUTER = '0x000000000000FB114709235f1ccBFfb925F600e4';
export const ZQUOTER_V2 = '0x000000bd2DB80567c23E353ca95a251c573cBf9B';
export const PRECISION_ROUTE = '0x0000007Be74558A1F8c9045301c6F44C8eD0c9eB';
export const PRECISION_LENS = '0x000000Bad3a2fa57ed74fa06000573ccddF6B7fB';
export const PRECISION_POLICY = '0x00000045fc7b570Be4d71F67219508ebD295EC6D';
export const PRECISION_GUARD = '0x00000057B53fB5feEdedaf7066e1f1C7002b1961';
export const PRECISION_POOL = '0x0155358241411dB868BA714aE7c83A27087e3D6E'; // TAC/ETH band, 30bps, confirmed token0=ETH/token1=TAC on mainnet
export const TACIT_AMM = '0x00000000E36C7EC997CC59DCda9E03673B448119';
export const TACIT_AMM_TIERS = [30, 5, 100, 1]; // only 30bps is founded today; the rest are probed and allowed to fail
export const TACIT_AMM_UNIT_SCALE = 10n ** 10n; // TacitPublicAmm requires amounts aligned to this (both legs are 18-decimal, 8 in-system-decimal assets)
export const BOARD_V2 = '0x000000dA7bb4B2A9E3e80e9A4D4157E26CA6189b';
export const BOARD_V1 = '0x000000fF3D7A2d373615141d7489Ca66683DbecF';
export const BOARD_VIEW = '0x000000E0b25449F32f7D9259aC449bA88E78dFCE';
export const BOARD_SWAP_BOL = '0x00000087A6dc5071779Ed1F8274A39230768B976';
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

export const VENUES = Object.freeze({
  PRECISION: 'precision',
  TACIT_AMM: 'tacit-amm',
  ZQUOTER: 'zquoter',
});

const SEL = {
  quoteBest: '2adaa389',      // PrecisionPoolLens.quoteBest(c0,c1,sender,tokenIn,amountIn,startIdx,scanLen) -> (pool, out)
  effFee: 'ef66de32',         // PrecisionPoolLens.effFee(pool,sender,tokenIn,amountIn) -> fee
  routable: '9662c498',       // PrecisionPolicy.routable(offset,count,pools[]) -> bool[]
  proute: '5d6498e1',         // PrecisionRoute.route(tokenIn,tokenOut,amountIn,minOut,to,pools[])
  pcheckpoint: '0b7c6c6c',    // PrecisionRoute.checkpoint(fund,routeHash,account)
  guardDeadline: '10c2e3cd',  // zGuard.deadline(deadline,executor)
  snwap: '5f3bd1c8',          // zRouter.snwap(tokenIn,amountIn,recipient,tokenOut,minOut,executor,executorData)
  zMulticall: 'ac9650d8',     // zRouter.multicall(bytes[])
  zPermit: '7ac2ff7b',        // zRouter.permit(token,value,deadline,v,r,s): an EIP-2612 permit to zRouter, as a multicall leg
  agg3: '82ad56cb',           // Multicall3.aggregate3((address,bool,bytes)[])
  tacitQuote: '3bc1414a',     // TacitPublicAmm.quoteSwap(assetIn,assetOut,feeBps,amountIn) -> amountOut
  tacitSwap: 'cfdf9dcc',      // TacitPublicAmm.swapPublic(assetIn,assetOut,feeBps,amountIn,minOut,deadline,to)
  buildBestSwap: 'e7798987',  // zQuoter.buildBestSwap(to,exactOut,tokenIn,tokenOut,amount,slippageBps,deadline)
  boardCandidates: '5f452988', // SBVIEW.candidates(board,isV2,tokenIn,tokenOut,swapBol,cursor,limit) -> Candidate[]
  allowance: 'dd62ed3e',
  approve: '095ea7b3',
  balanceOf: '70a08231',
};

// ── hex / word helpers (mirrors dapp/confidential-router.js's word()/addrWord() convention) ──
const strip0x = (h) => String(h || '').replace(/^0x/, '');
const hexToBytes = (h) => Uint8Array.from((strip0x(h).match(/../g) || []).map((x) => parseInt(x, 16)));
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const word = (v) => (typeof v === 'bigint' ? v : BigInt(v)).toString(16).padStart(64, '0');
const addrWord = (a) => strip0x(a).toLowerCase().padStart(64, '0');
const bytes32Word = (h) => strip0x(h).toLowerCase().padStart(64, '0');
const boolWord = (b) => (b ? '1' : '0').padStart(64, '0');
const padRight64 = (hex) => hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
const decWord = (hex, i) => BigInt('0x' + (strip0x(hex).slice(i * 64, (i + 1) * 64) || '0'));
const decAddrWord = (hex, i) => '0x' + strip0x(hex).slice(i * 64 + 24, i * 64 + 64);

// ── Multicall3.aggregate3 — allowFailure always true, so one reverting probe (e.g. an unfounded
// Tacit AMM tier) doesn't sink the rest of the batch. ──
function encAggregate3(calls) {
  const n = calls.length;
  let head = '', tail = '', off = n * 32;
  for (const c of calls) {
    const d = strip0x(c.data);
    const body = addrWord(c.to) + boolWord(true) + word(96) + word(d.length / 2) + padRight64(d);
    head += word(off);
    tail += body;
    off += body.length / 2;
  }
  return '0x' + SEL.agg3 + word(32) + word(n) + head + tail;
}
function decAggregate3(hex, n) {
  const h = strip0x(hex);
  const out = [];
  for (let i = 0; i < n; i++) {
    const w = 2 + Number(decWord(h, 2 + i)) / 32; // this element's tuple start, as a word offset from word 2
    const ok = decWord(h, w) === 1n;
    const bo = Number(decWord(h, w + 1)) / 32; // offset to the bytes field, relative to the tuple start (word w)
    const lw = w + bo; // word holding the returned bytes' length
    const len = Number(decWord(h, lw));
    out.push(ok && len ? '0x' + h.slice((lw + 1) * 64, (lw + 1) * 64 + len * 2) : null);
  }
  return out;
}

async function batch(ethCall, calls, block) {
  if (!calls.length) return [];
  const raw = await ethCall(MULTICALL3, encAggregate3(calls), block).catch(() => null);
  if (!raw) return calls.map(() => null);
  return decAggregate3(raw, calls.length);
}

// ── Precision band (the deep TAC/ETH venue) ──

function encQuoteBest({ c0, c1, sender, tokenIn, amountIn, scan = 128 }) {
  return '0x' + SEL.quoteBest + addrWord(c0) + addrWord(c1) + addrWord(sender || ZERO_ADDR)
    + addrWord(tokenIn) + word(amountIn) + word(0) + word(scan);
}
function decQuoteBest(raw) {
  if (!raw) return null;
  const h = strip0x(raw);
  if (h.length < 128) return null;
  const pool = decAddrWord(h, 0);
  const amountOut = decWord(h, 1);
  if (amountOut <= 0n || pool === ZERO_ADDR) return null;
  return { pool, amountOut };
}
function encEffFee({ pool, sender, tokenIn, amountIn }) {
  return '0x' + SEL.effFee + addrWord(pool) + addrWord(sender || ZERO_ADDR) + addrWord(tokenIn) + word(amountIn);
}
function encRoutable(pools) {
  return '0x' + SEL.routable + word(32) + word(pools.length) + pools.map(addrWord).join('');
}
function decRoutableAll(raw, n) {
  if (!raw) return true; // fail open on a read error — the route call itself is still the final gate
  const h = strip0x(raw);
  if (h.length < 128 + n * 64) return true;
  for (let i = 0; i < n; i++) if (decWord(h, 2 + i) === 0n) return false;
  return true;
}

function encPrecisionRoute({ tokenIn, tokenOut, amountIn, minOut, to, pools }) {
  return '0x' + SEL.proute + word(192) + addrWord(tokenIn) + addrWord(tokenOut) + word(amountIn)
    + word(minOut) + addrWord(to) + word(pools.length) + pools.map(addrWord).join('');
}
function encPrecisionCheckpoint({ fund, routeDataHex, account, keccak256 }) {
  const routeHash = bytesToHex(keccak256(hexToBytes(routeDataHex)));
  return '0x' + SEL.pcheckpoint + addrWord(fund) + bytes32Word(routeHash) + addrWord(account);
}
function encGuardDeadline(deadline) {
  return '0x' + SEL.guardDeadline + word(deadline) + addrWord(ZROUTER);
}
function encSnwap({ tokenIn, amountIn, recipient, tokenOut, minOut, executor, data }) {
  const d = strip0x(data);
  return '0x' + SEL.snwap + addrWord(tokenIn) + word(amountIn) + addrWord(recipient) + addrWord(tokenOut)
    + word(minOut) + addrWord(executor) + word(224) + word(d.length / 2) + padRight64(d);
}
function encZRouterPermit({ token, value, deadline, v, r, s }) {
  return '0x' + SEL.zPermit + addrWord(token) + word(value) + word(deadline) + word(v) + bytes32Word(r) + bytes32Word(s);
}
function encZRouterMulticall(calls) {
  const n = calls.length;
  let head = '', tail = '', off = n * 32;
  for (const c of calls) {
    const d = strip0x(c);
    const body = word(d.length / 2) + padRight64(d);
    head += word(off);
    tail += body;
    off += body.length / 2;
  }
  return '0x' + SEL.zMulticall + word(32) + word(n) + head + tail;
}

async function quotePrecision({ ethCall, dir, amountIn, account, block }) {
  if (amountIn <= 0n) return null;
  const tokenIn = dir === 'ETH_TO_TAC' ? ZERO_ADDR : TAC_ERC20;
  const tokenOut = dir === 'ETH_TO_TAC' ? TAC_ERC20 : ZERO_ADDR;
  const [c0, c1] = ZERO_ADDR.toLowerCase() < TAC_ERC20.toLowerCase() ? [ZERO_ADDR, TAC_ERC20] : [TAC_ERC20, ZERO_ADDR];
  const [bestRaw] = await batch(ethCall, [{ to: PRECISION_LENS, data: encQuoteBest({ c0, c1, sender: account, tokenIn, amountIn }) }], block);
  const best = decQuoteBest(bestRaw);
  if (!best) return null;
  const [feeRaw, routableRaw] = await batch(ethCall, [
    { to: PRECISION_LENS, data: encEffFee({ pool: best.pool, sender: account, tokenIn, amountIn }) },
    { to: PRECISION_POLICY, data: encRoutable([best.pool]) },
  ], block);
  if (!decRoutableAll(routableRaw, 1)) return null;
  const feeBps = feeRaw ? decWord(feeRaw, 0) : 0n;
  return { venue: VENUES.PRECISION, amountIn, amountOut: best.amountOut, feeBps, pool: best.pool, tokenIn, tokenOut };
}

function buildPrecisionSwap({ quote, account, minOut, deadline, keccak256, permit }) {
  const { tokenIn, tokenOut, pool, amountIn } = quote;
  const to = account;
  const routeData = encPrecisionRoute({ tokenIn, tokenOut, amountIn, minOut, to, pools: [pool] });
  const nativeIn = tokenIn === ZERO_ADDR;
  // Every leg here is itself an snwap() call — zRouter.multicall delegatecalls each entry into
  // itself, so "call GUARD.deadline(...)" / "call PROUTE.checkpoint(...)" has to be a value-less
  // snwap (tokenIn=ZERO, amountIn=0) with that contract as the executor, not raw calldata to those
  // contracts directly (zRouter has no such functions of its own to delegatecall into).
  const guardLeg = encSnwap({ tokenIn: ZERO_ADDR, amountIn: 0n, recipient: to, tokenOut: ZERO_ADDR, minOut: 0n, executor: PRECISION_GUARD, data: encGuardDeadline(deadline) });
  const routedLeg = encSnwap({ tokenIn: nativeIn ? ZERO_ADDR : tokenIn, amountIn, recipient: to, tokenOut, minOut, executor: PRECISION_ROUTE, data: routeData });
  if (nativeIn) {
    // Native ETH in: no funding pull needed, no checkpoint required (nothing else can spend msg.value mid-tx).
    return { to: ZROUTER, data: encZRouterMulticall([guardLeg, routedLeg]), value: amountIn, approval: null };
  }
  // TAC in: bind the pulled funds to this exact route (the checkpoint), then let snwap pull TAC from the user. A permit
  // the seller signed for zRouter rides first (zRouter's own permit leg, delegatecalled with the seller as msg.sender),
  // so the sale needs no separate approval.
  const checkpointLeg = encSnwap({ tokenIn: ZERO_ADDR, amountIn: 0n, recipient: to, tokenOut: ZERO_ADDR, minOut: 0n, executor: PRECISION_ROUTE, data: encPrecisionCheckpoint({ fund: tokenIn, routeDataHex: routeData, account, keccak256 }) });
  if (permit) return { to: ZROUTER, data: encZRouterMulticall([encZRouterPermit({ token: tokenIn, ...permit }), guardLeg, checkpointLeg, routedLeg]), value: 0n, approval: null };
  return { to: ZROUTER, data: encZRouterMulticall([guardLeg, checkpointLeg, routedLeg]), value: 0n, approval: { token: tokenIn, spender: ZROUTER, amount: amountIn } };
}

// ── Tacit's own public AMM (TAC/cETH, 30bps founded) ──

function encTacitQuote({ assetIn, assetOut, feeBps, amountIn }) {
  return '0x' + SEL.tacitQuote + bytes32Word(assetIn) + bytes32Word(assetOut) + word(feeBps) + word(amountIn);
}
function encTacitSwap({ assetIn, assetOut, feeBps, amountIn, minOut, deadline, to }) {
  return '0x' + SEL.tacitSwap + bytes32Word(assetIn) + bytes32Word(assetOut) + word(feeBps) + word(amountIn) + word(minOut) + word(deadline) + addrWord(to);
}
function alignDown(amount, scale) { return amount - (amount % scale); }

async function quoteTacitAmm({ ethCall, dir, amountIn, block }) {
  const aligned = alignDown(amountIn, TACIT_AMM_UNIT_SCALE);
  if (aligned <= 0n) return null;
  const assetIn = dir === 'ETH_TO_TAC' ? CETH_POOL_ASSET_ID : TAC_POOL_ASSET_ID;
  const assetOut = dir === 'ETH_TO_TAC' ? TAC_POOL_ASSET_ID : CETH_POOL_ASSET_ID;
  const calls = TACIT_AMM_TIERS.map((fee) => ({ to: TACIT_AMM, data: encTacitQuote({ assetIn, assetOut, feeBps: fee, amountIn: aligned }) }));
  const results = await batch(ethCall, calls, block);
  let best = null;
  results.forEach((raw, i) => {
    if (!raw) return;
    const out = decWord(raw, 0);
    if (out > 0n && (!best || out > best.amountOut)) best = { feeBps: BigInt(TACIT_AMM_TIERS[i]), amountOut: out };
  });
  if (!best) return null;
  return { venue: VENUES.TACIT_AMM, amountIn: aligned, dustIn: amountIn - aligned, amountOut: best.amountOut, feeBps: best.feeBps, assetIn, assetOut };
}

function buildTacitAmmSwap({ quote, dir, account, minOut, deadline }) {
  const { assetIn, assetOut, feeBps, amountIn } = quote;
  if (dir === 'ETH_TO_TAC') {
    // Routed through zRouter's snwap so the swap also counts as zRouter volume, same as every other venue here.
    const swapData = encTacitSwap({ assetIn, assetOut, feeBps, amountIn, minOut, deadline, to: account });
    const leg = encSnwap({ tokenIn: ZERO_ADDR, amountIn, recipient: account, tokenOut: TAC_ERC20, minOut, executor: TACIT_AMM, data: swapData });
    return { to: ZROUTER, data: encZRouterMulticall([leg]), value: amountIn, approval: null };
  }
  // TAC -> ETH can't go through snwap (the AMM would try to pull TAC from zRouter's SafeExecutor, not the user):
  // a plain approve + direct call.
  return { to: TACIT_AMM, data: encTacitSwap({ assetIn, assetOut, feeBps, amountIn, minOut, deadline, to: account }), value: 0n, approval: { token: TAC_ERC20, spender: TACIT_AMM, amount: amountIn } };
}

// ── zQuoter (external DEX aggregator) — kept in only as a lazy, long-cached probe. It has no route
// for TAC today (no Uniswap/Sushi/Curve pool exists), so this only starts mattering if one is ever
// seeded. Never put this in a Multicall3 batch: an out-of-gas here reads as success=false (empty
// return), which is indistinguishable from a clean "no route" — always call it raw, with an
// explicit gas limit, so a gas failure surfaces as an error instead of a false negative. ──

const NO_ROUTE_SELECTOR = '6586e129'; // zQuoter.NoRoute() custom error

function encBuildBestSwap({ to, exactOut, tokenIn, tokenOut, amount, slippageBps, deadline }) {
  return '0x' + SEL.buildBestSwap + addrWord(to) + boolWord(exactOut) + addrWord(tokenIn) + addrWord(tokenOut)
    + word(amount) + word(slippageBps) + word(deadline);
}
// Return shape: (Quote{source,feeBps,amountIn,amountOut}, bytes callData, uint256 amountLimit, uint256 msgValue)
function decBuildBestSwap(raw) {
  if (!raw) return null;
  const h = strip0x(raw);
  if (h.length < 448) return null;
  const amountOut = decWord(h, 3);
  if (amountOut <= 0n) return null;
  const callDataOffsetWords = Number(decWord(h, 4)) / 32;
  const callDataLen = Number(decWord(h, callDataOffsetWords));
  const callData = '0x' + h.slice((callDataOffsetWords + 1) * 64, (callDataOffsetWords + 1) * 64 + callDataLen * 2);
  const amountLimit = decWord(h, 5);
  const msgValue = decWord(h, 6);
  return { amountOut, callData, amountLimit, msgValue, feeBps: decWord(h, 1) };
}

async function quoteZQuoter({ ethCall, dir, amountIn, account, slippageBps = 100, deadline, gas = '0x5F5E100' /* 100M */ }) {
  const tokenIn = dir === 'ETH_TO_TAC' ? ZERO_ADDR : TAC_ERC20;
  const tokenOut = dir === 'ETH_TO_TAC' ? TAC_ERC20 : ZERO_ADDR;
  const data = encBuildBestSwap({ to: account || ZERO_ADDR, exactOut: false, tokenIn, tokenOut, amount: amountIn, slippageBps, deadline });
  let raw;
  try {
    raw = await ethCall(ZQUOTER_V2, data, 'latest', { gas });
  } catch (e) {
    // Different RPCs surface a revert's selector in different places (error.data, a nested
    // error.data.data, or hex tacked onto error.message) — check anywhere it could plausibly be.
    const haystack = [e && e.message, e && e.data, e && e.data && e.data.data].filter(Boolean).join(' ');
    if (haystack.includes(NO_ROUTE_SELECTOR)) return { venue: VENUES.ZQUOTER, status: 'no-route' };
    return { venue: VENUES.ZQUOTER, status: 'error', error: e };
  }
  const decoded = decBuildBestSwap(raw);
  if (!decoded) return { venue: VENUES.ZQUOTER, status: 'no-route' };
  return { venue: VENUES.ZQUOTER, status: 'ok', amountIn, amountOut: decoded.amountOut, feeBps: decoded.feeBps, callData: decoded.callData, msgValue: decoded.msgValue };
}

function buildZQuoterSwap({ quote }) {
  return { to: ZROUTER, data: quote.callData, value: quote.msgValue, approval: null };
}

// ── zSwap order boards — quote-only. A resting-order presence signal, not a priced venue: fill
// recipes (fill plans, Dutch checkpoints) are the most intricate part of zSwap and aren't worth
// porting for TAC's near-zero board depth. Surface a link to fill there instead of executing. ──

function encBoardCandidates({ board, isV2, tokenIn, tokenOut, cursor = 0, limit = 32 }) {
  return '0x' + SEL.boardCandidates + addrWord(board) + boolWord(isV2) + addrWord(tokenIn) + addrWord(tokenOut)
    + addrWord(BOARD_SWAP_BOL) + word(cursor) + word(limit);
}
function decCandidateCount(raw) {
  if (!raw) return 0;
  const h = strip0x(raw);
  if (h.length < 64) return 0;
  // The candidates array is the return's first value, so word0 is its offset — not necessarily 32:
  // read the offset rather than assuming the array's length sits at a fixed word index.
  const arrayWordIdx = Number(decWord(h, 0)) / 32;
  if (h.length < (arrayWordIdx + 1) * 64) return 0;
  return Number(decWord(h, arrayWordIdx));
}

async function quoteBoards({ ethCall, dir, block }) {
  const tokenIn = dir === 'ETH_TO_TAC' ? ZERO_ADDR : TAC_ERC20;
  const tokenOut = dir === 'ETH_TO_TAC' ? TAC_ERC20 : ZERO_ADDR;
  const [v2Raw, v1Raw] = await batch(ethCall, [
    { to: BOARD_VIEW, data: encBoardCandidates({ board: BOARD_V2, isV2: true, tokenIn, tokenOut }) },
    { to: BOARD_VIEW, data: encBoardCandidates({ board: BOARD_V1, isV2: false, tokenIn, tokenOut }) },
  ], block);
  const count = decCandidateCount(v2Raw) + decCandidateCount(v1Raw);
  return { venue: 'boards', restingOrders: count };
}

// zSwap deep link — host is caller-supplied (not hardcoded here) since it names the user's own
// second product's public domain, a call the market page's caller makes explicitly.
export function zswapDeepLink({ host, dir, amount }) {
  if (!host) return null;
  const token = dir === 'ETH_TO_TAC' ? 'ETH' : TAC_ERC20;
  const out = dir === 'ETH_TO_TAC' ? TAC_ERC20 : 'ETH';
  const amt = amount != null ? `&amount=${amount}` : '';
  return `${host.replace(/\/$/, '')}/#token=${token}&out=${out}${amt}`;
}

// ── plain ERC20 (allowance / approve / balanceOf), used for the TAC-in venues' approval step ──
export function encErc20Allowance(owner, spender) { return '0x' + SEL.allowance + addrWord(owner) + addrWord(spender); }
export function encErc20Approve(spender, amount) { return '0x' + SEL.approve + addrWord(spender) + word(amount); }
export function encErc20BalanceOf(account) { return '0x' + SEL.balanceOf + addrWord(account); }
export function decUint256(raw) { return raw ? decWord(raw, 0) : 0n; }

// ── ranking + top-level API ──

function rankQuotes(quotes) {
  return quotes.filter((q) => q && q.amountOut > 0n).sort((a, b) => (a.amountOut === b.amountOut ? 0 : a.amountOut > b.amountOut ? -1 : 1));
}

// zQuoter is a lazy, best-effort probe (see its own comment above) — it has no route for TAC
// today and only matters if a Uniswap/etc. pool is ever seeded. A slow or misbehaving public RPC
// answering its heavy-gas raw call can take 15s+ (observed against 1rpc.io), which would otherwise
// hold back the ENTIRE quote — including the Precision/Tacit AMM venues that are always ready
// within ~1-2s — for a venue that's usually going to say "no route" anyway. Capped independently
// so it can never be the slow part of quoteAll; a timeout is just another "didn't answer in time",
// same as any other zQuoter failure.
const ZQUOTER_BUDGET_MS = 4000;
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(onTimeout()); });
  });
}

export function makeEvmTradeVenues({ ethCall, keccak256 } = {}) {
  if (typeof ethCall !== 'function') throw new Error('makeEvmTradeVenues: ethCall(to, data, block?) required');

  async function quoteAll({ dir, amountIn, account, block = 'latest', includeZQuoter = true, deadline }) {
    if (dir !== 'ETH_TO_TAC' && dir !== 'TAC_TO_ETH') throw new Error('dir must be ETH_TO_TAC or TAC_TO_ETH');
    if (typeof amountIn !== 'bigint' || amountIn <= 0n) throw new Error('amountIn must be a positive bigint');
    const dl = deadline ?? BigInt(Math.floor(Date.now() / 1000) + 1800);
    const zquoterPromise = includeZQuoter
      ? withTimeout(
          quoteZQuoter({ ethCall, dir, amountIn, account, deadline: dl }).catch(() => ({ venue: VENUES.ZQUOTER, status: 'error' })),
          ZQUOTER_BUDGET_MS,
          () => ({ venue: VENUES.ZQUOTER, status: 'timeout' }),
        )
      : Promise.resolve(null);
    const [precision, tacitAmm, boards, zquoter] = await Promise.all([
      quotePrecision({ ethCall, dir, amountIn, account, block }).catch(() => null),
      quoteTacitAmm({ ethCall, dir, amountIn, block }).catch(() => null),
      quoteBoards({ ethCall, dir, block }).catch(() => ({ venue: 'boards', restingOrders: 0 })),
      zquoterPromise,
    ]);
    const ranked = rankQuotes([precision, tacitAmm, zquoter && zquoter.status === 'ok' ? zquoter : null]);
    return { dir, amountIn, ranked, best: ranked[0] || null, precision, tacitAmm, boards, zquoter };
  }

  // `permit` ({ value, deadline, v, r, s }, an EIP-2612 permit over TAC to zRouter) is used by the TAC-in Precision
  // route in place of an approval; the other routes return `approval` whatever is passed.
  // `minOut` is the floor a caller has already shown the user; without one it is the quote less `slippageBps`.
  function build({ quote, dir, account, slippageBps = 50, minOut: reviewedMinOut = null, deadline, permit }) {
    if (!quote || !quote.venue) throw new Error('build: a ranked quote is required');
    const dl = deadline ?? BigInt(Math.floor(Date.now() / 1000) + 1800);
    const minOut = reviewedMinOut != null ? BigInt(reviewedMinOut) : (quote.amountOut * BigInt(10000 - slippageBps)) / 10000n;
    if (minOut > quote.amountOut) throw new Error('build: minOut is above what the quote pays');
    if (quote.venue === VENUES.PRECISION) {
      if (typeof keccak256 !== 'function' && quote.tokenIn !== ZERO_ADDR) throw new Error('build: keccak256 required for a TAC-in Precision route');
      return buildPrecisionSwap({ quote, account, minOut, deadline: dl, keccak256, permit: quote.tokenIn === ZERO_ADDR ? null : permit });
    }
    if (quote.venue === VENUES.TACIT_AMM) return buildTacitAmmSwap({ quote, dir, account, minOut, deadline: dl });
    if (quote.venue === VENUES.ZQUOTER) return buildZQuoterSwap({ quote });
    throw new Error(`build: unknown venue ${quote.venue}`);
  }

  return {
    quoteAll,
    build,
    quotePrecision: (args) => quotePrecision({ ethCall, ...args }),
    quoteTacitAmm: (args) => quoteTacitAmm({ ethCall, ...args }),
    quoteBoards: (args) => quoteBoards({ ethCall, ...args }),
    quoteZQuoter: (args) => quoteZQuoter({ ethCall, ...args }),
  };
}

export const _internal = { alignDown, encAggregate3, decAggregate3, encSnwap, encZRouterMulticall, encZRouterPermit, encPrecisionRoute, encGuardDeadline, encTacitQuote, encTacitSwap, encBuildBestSwap, decBuildBestSwap, decQuoteBest, decCandidateCount };
