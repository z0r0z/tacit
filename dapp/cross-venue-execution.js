// Cross-venue execution binding.
//
// The router returns quotes; this module turns a selected quote into a signed taker intent and, for the
// cross-chain orderbook venue, revalidates the live book before mutating it into adaptor-swap fills.
// It is still dapp-side orchestration: no contract call, no proof generation. The goal is to bind
// "what the user saw" to "what execution attempts".

import { signSchnorr, verifySchnorr } from './bulletproofs.js';
import { sha256, concatBytes, hexToBytes, bytesToHex } from './vendor/tacit-deps.min.js';
import { VENUE_KINDS } from './cross-venue-router.js';

const enc = new TextEncoder();
const DOMAIN_PLAN = enc.encode('tacit-cross-venue-route-plan-v1');
const DOMAIN_INTENT = enc.encode('tacit-cross-venue-route-intent-v1');
const ZERO32 = '0x' + '00'.repeat(32);
const MAX_U64 = (1n << 64n) - 1n;
const lc = (h) => String(h == null ? '' : h).toLowerCase().replace(/^0x/, '');
const hx = (b) => '0x' + bytesToHex(b);
const _big = (x) => (typeof x === 'bigint' ? x : BigInt(x));

function b32(x, name) {
  const h = String(x || '').replace(/^0x/, '');
  if (h.length !== 64) throw new Error(`route: ${name} must be bytes32`);
  return hexToBytes(h);
}
function pub33(x) {
  const h = String(x || '').replace(/^0x/, '');
  if (h.length !== 66) throw new Error('route: takerPubkey must be compressed secp pubkey');
  const b = hexToBytes(h);
  if (b[0] !== 2 && b[0] !== 3) throw new Error('route: takerPubkey must be compressed secp pubkey');
  return b;
}
function sig64(x) {
  const h = String(x || '').replace(/^0x/, '');
  if (h.length !== 128) throw new Error('route: signature must be 64 bytes');
  return hexToBytes(h);
}
function u64(n, name) {
  const v = _big(n);
  if (v < 0n || v > MAX_U64) throw new Error(`route: ${name} out of u64 range`);
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 7; i >= 0; --i) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

function canon(x) {
  if (typeof x === 'bigint') return x.toString();
  if (x == null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') return x;
  if (Array.isArray(x)) return x.map(canon);
  const out = {};
  for (const k of Object.keys(x).sort()) {
    const v = x[k];
    if (typeof v === 'function' || v === undefined) continue;
    out[k] = canon(v);
  }
  return out;
}

export function routePlanHash(quote) {
  return hx(sha256(concatBytes(DOMAIN_PLAN, enc.encode(JSON.stringify(canon(quote))))));
}

export function buildRouteIntentMsg({
  chainBinding = ZERO32,
  routeHash,
  takerPubkey,
  minOut,
  deadline,
  nonce,
}) {
  return sha256(concatBytes(
    DOMAIN_INTENT,
    b32(chainBinding, 'chainBinding'),
    b32(routeHash, 'routeHash'),
    pub33(takerPubkey),
    u64(minOut, 'minOut'),
    u64(deadline, 'deadline'),
    b32(nonce, 'nonce'),
  ));
}

export function signRouteIntent(intent, takerPrivkey32) {
  return hx(signSchnorr(
    buildRouteIntentMsg(intent),
    takerPrivkey32 instanceof Uint8Array ? takerPrivkey32 : hexToBytes(String(takerPrivkey32).replace(/^0x/, '')),
  ));
}

export function verifyRouteIntent({ signature, ...intent }) {
  try { return verifySchnorr(sig64(signature), buildRouteIntentMsg(intent), pub33(intent.takerPubkey).subarray(1)); }
  catch { return false; }
}

export function assertRouteIntent(quote, routeIntent, { nowTs = Infinity } = {}) {
  if (!routeIntent) return null;
  const expectedHash = routePlanHash(quote);
  if (lc(routeIntent.routeHash) !== lc(expectedHash)) throw new Error('route: intent hash mismatch');
  if (_big(routeIntent.minOut) > _big(quote.amountOut)) throw new Error('route: minOut exceeds quote');
  if (routeIntent.deadline != null && nowTs > Number(routeIntent.deadline)) throw new Error('route: intent expired');
  if (!verifyRouteIntent(routeIntent)) throw new Error('route: invalid taker intent');
  return expectedHash;
}

function sameFills(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) {
    if (lc(a[i].offerId) !== lc(b[i].offerId)) return false;
    if (_big(a[i].payAmount) !== _big(b[i].payAmount)) return false;
    if (_big(a[i].receiveAmount) !== _big(b[i].receiveAmount)) return false;
    if (lc(a[i].giveAsset) !== lc(b[i].giveAsset) || lc(a[i].wantAsset) !== lc(b[i].wantAsset)) return false;
    if (a[i].giveLane !== b[i].giveLane || a[i].wantLane !== b[i].wantLane) return false;
  }
  return true;
}

export function revalidateOrderbookQuote(orderbook, quote, { nowTs = Infinity } = {}) {
  if (!quote || quote.kind !== VENUE_KINDS.CROSS_CHAIN_ORDERBOOK || quote.plan?.type !== 'orderbook-sweep') {
    throw new Error('route: quote is not a cross-chain orderbook sweep');
  }
  const fresh = orderbook.quoteExactIn({
    giveAsset: quote.assetIn,
    wantAsset: quote.assetOut,
    amountIn: quote.amountIn,
    giveLane: quote.laneIn,
    wantLane: quote.laneOut,
    nowTs,
    requireFullFill: quote.unusedIn === 0n,
  });
  if (!fresh || _big(fresh.amountOut) !== _big(quote.amountOut) || !sameFills(fresh.fills, quote.plan.fills)) {
    throw new Error('route: stale orderbook quote');
  }
  return fresh;
}

export function executeOrderbookRoute({
  orderbook,
  quote,
  taker,
  routeIntent = null,
  tSecrets,
  deadlines,
  nowTs = Infinity,
}) {
  assertRouteIntent(quote, routeIntent, { nowTs });
  const fresh = revalidateOrderbookQuote(orderbook, quote, { nowTs });
  if (!Array.isArray(tSecrets) || tSecrets.length !== quote.plan.fills.length) {
    throw new Error('route: one adaptor secret required per fill');
  }
  const out = [];
  for (let i = 0; i < quote.plan.fills.length; ++i) {
    const f = quote.plan.fills[i];
    const dl = Array.isArray(deadlines) ? deadlines[i] : deadlines;
    if (!dl) throw new Error('route: deadlines required');
    out.push(orderbook.fill(f.offerId, {
      taker,
      takeGive: f.receiveAmount,
      t: tSecrets[i],
      nearDeadline: dl.nearDeadline,
      farDeadline: dl.farDeadline,
      nowTs,
    }));
  }
  return { fills: out, fresh };
}

function requireEthereumConstantProduct(quote, kind) {
  if (!quote || quote.kind !== kind || !['constant-product-swap', 'constant-product-route'].includes(quote.plan?.type)) {
    throw new Error(`route: quote is not a ${kind} constant-product swap`);
  }
  if (quote.laneIn !== 'ethereum' || quote.laneOut !== 'ethereum') {
    throw new Error('route: public/confidential EVM swap must stay on ethereum lane');
  }
}

function requireSingleHopConstantProduct(quote, kind) {
  requireEthereumConstantProduct(quote, kind);
  if (quote.plan.type !== 'constant-product-swap') {
    throw new Error(`route: ${kind} transaction builder only supports one-hop swaps`);
  }
}

function requireBitcoinConstantProduct(quote) {
  if (!quote || quote.kind !== VENUE_KINDS.BTC_AMM || !['constant-product-swap', 'constant-product-route'].includes(quote.plan?.type)) {
    throw new Error('route: quote is not a btc-amm constant-product swap');
  }
  if (quote.laneIn !== 'bitcoin' || quote.laneOut !== 'bitcoin') {
    throw new Error('route: Bitcoin AMM swap must stay on bitcoin lane');
  }
}

function constantProductHops(quote) {
  if (quote.plan?.type === 'constant-product-route') return quote.plan.hops || [];
  if (quote.plan?.type === 'constant-product-swap') {
    return [{
      venueId: quote.venueId,
      kind: quote.kind,
      laneIn: quote.laneIn,
      laneOut: quote.laneOut,
      assetIn: quote.assetIn,
      assetOut: quote.assetOut,
      amountIn: quote.usedIn ?? quote.amountIn,
      amountOut: quote.amountOut,
      poolId: quote.plan.poolId,
      direction: quote.plan.direction,
      feeBps: quote.plan.feeBps,
      assetA: quote.plan.assetA,
      assetB: quote.plan.assetB,
      reserveAPre: quote.plan.reserveAPre,
      reserveBPre: quote.plan.reserveBPre,
    }];
  }
  return [];
}

function assetMeta(assetMap, assetId, label) {
  const m = assetMap?.[lc(assetId)] || assetMap?.[String(assetId)] || assetMap?.['0x' + lc(assetId)];
  if (!m) throw new Error(`route: missing ${label} asset metadata`);
  if (!m.token) throw new Error(`route: missing ${label} token address`);
  return { token: String(m.token).toLowerCase(), unitScale: _big(m.unitScale ?? m.scale ?? 1n) };
}

function scaleAmount(amount, unitScale, label) {
  if (unitScale <= 0n) throw new Error(`route: ${label} unitScale must be positive`);
  return _big(amount) * unitScale;
}

export function buildPublicEvmSwapRouteTx({
  quote,
  routerClient,
  assetMap,
  priv,
  to,
  permit2Nonce,
  expiration,
  sigDeadline,
  deadline,
  routeIntent = null,
  nowTs = Infinity,
  minOut = null,
}) {
  requireSingleHopConstantProduct(quote, VENUE_KINDS.EVM_PUBLIC_AMM);
  assertRouteIntent(quote, routeIntent, { nowTs });
  if (!routerClient || typeof routerClient.buildSwapPublicWithPermit2 !== 'function') {
    throw new Error('route: routerClient.buildSwapPublicWithPermit2 required');
  }
  const aIn = assetMeta(assetMap, quote.assetIn, 'input');
  const aOut = assetMeta(assetMap, quote.assetOut, 'output');
  const minSystemOut = minOut == null
    ? (routeIntent?.minOut == null ? quote.amountOut : routeIntent.minOut)
    : minOut;
  const tx = routerClient.buildSwapPublicWithPermit2({
    priv,
    tokenIn: aIn.token,
    tokenOut: aOut.token,
    feeBps: quote.plan.feeBps,
    amountIn: scaleAmount(quote.usedIn ?? quote.amountIn, aIn.unitScale, 'input'),
    minAmountOut: scaleAmount(minSystemOut, aOut.unitScale, 'output'),
    deadline,
    to,
    permit2Nonce,
    expiration,
    sigDeadline: sigDeadline ?? deadline,
  });
  return {
    kind: VENUE_KINDS.EVM_PUBLIC_AMM,
    routeHash: routePlanHash(quote),
    quote,
    tokenIn: aIn.token,
    tokenOut: aOut.token,
    amountIn: scaleAmount(quote.usedIn ?? quote.amountIn, aIn.unitScale, 'input'),
    minAmountOut: scaleAmount(minSystemOut, aOut.unitScale, 'output'),
    tx,
  };
}

function btcDirection(d) {
  if (d === 'A_TO_B' || d === 0) return 0;
  if (d === 'B_TO_A' || d === 1) return 1;
  throw new Error('route: bad Bitcoin AMM hop direction');
}

function bitcoinHop(h) {
  const direction = btcDirection(h.direction);
  return {
    poolId: h.poolId,
    direction,
    feeBps: Number(h.feeBps),
    R_A_pre: _big(h.reserveAPre),
    R_B_pre: _big(h.reserveBPre),
    deltaANetMag: direction === 0 ? _big(h.amountIn) : _big(h.amountOut),
    deltaBNetMag: direction === 0 ? _big(h.amountOut) : _big(h.amountIn),
  };
}

export function buildBitcoinAmmRouteRequest({
  quote,
  routeIntent = null,
  nowTs = Infinity,
  minOut = null,
  expiryHeight = 0,
  recipientPubHex = null,
}) {
  requireBitcoinConstantProduct(quote);
  assertRouteIntent(quote, routeIntent, { nowTs });
  const minSystemOut = minOut == null
    ? (routeIntent?.minOut == null ? quote.amountOut : routeIntent.minOut)
    : minOut;
  if (_big(minSystemOut) > _big(quote.amountOut)) throw new Error('route: minOut exceeds quote');
  const hops = constantProductHops(quote).map(bitcoinHop);
  if (!hops.length) throw new Error('route: Bitcoin AMM quote has no hops');
  const first = hops[0];
  const common = {
    kind: VENUE_KINDS.BTC_AMM,
    lane: 'bitcoin',
    status: 'ready-for-bitcoin-amm-broadcast-request',
    routeHash: routePlanHash(quote),
    quote,
    minOut: _big(minSystemOut),
    expiryHeight,
    recipientPubHex,
  };
  if (hops.length === 1) {
    return {
      ...common,
      opcode: 'T_SWAP_VAR',
      builder: 'buildAndBroadcastSwapVarSelfFulfill',
      swap: first,
      args: {
        poolReserves: {
          pool_id_hex: first.poolId,
          reserve_a: first.R_A_pre,
          reserve_b: first.R_B_pre,
          fee_bps: first.feeBps,
        },
        direction: first.direction,
        deltaIn: quote.usedIn ?? quote.amountIn,
        minOut: _big(minSystemOut),
        expiryHeight,
        receiveAssetIdHex: quote.assetOut,
        recipientPubHex,
      },
    };
  }
  return {
    ...common,
    opcode: 'T_SWAP_ROUTE',
    builder: 'buildAndBroadcastSwapRoute',
    hops,
    deltaOutLast: _big(quote.amountOut),
    args: {
      traderOutputAssetIdHex: quote.assetOut,
      minOut: _big(minSystemOut),
      expiryHeight,
      recipientPubHex,
    },
  };
}

export function buildConfidentialAmmRouteJob({
  quote,
  routeIntent = null,
  nowTs = Infinity,
  takerCommitment = null,
  memo = null,
}) {
  requireEthereumConstantProduct(quote, VENUE_KINDS.EVM_CONFIDENTIAL_AMM);
  assertRouteIntent(quote, routeIntent, { nowTs });
  const hops = constantProductHops(quote);
  if (!hops.length) throw new Error('route: confidential AMM quote has no hops');
  return {
    kind: VENUE_KINDS.EVM_CONFIDENTIAL_AMM,
    status: 'needs-confidential-settle-proof',
    routeHash: routePlanHash(quote),
    minOut: routeIntent?.minOut ?? quote.amountOut,
    quote,
    route: {
      hops: hops.map((h) => ({
        poolId: h.poolId,
        venueId: h.venueId,
        assetIn: h.assetIn,
        assetOut: h.assetOut,
        amountIn: h.amountIn,
        amountOut: h.amountOut,
        minAmountOut: routeIntent?.minOut ?? quote.amountOut,
        feeBps: h.feeBps,
        direction: h.direction,
        reserveAPre: h.reserveAPre,
        reserveBPre: h.reserveBPre,
      })),
    },
    swap: {
      poolId: hops[0].poolId,
      assetIn: quote.assetIn,
      assetOut: quote.assetOut,
      amountIn: quote.usedIn ?? quote.amountIn,
      minAmountOut: routeIntent?.minOut ?? quote.amountOut,
      feeBps: hops[0].feeBps,
      direction: hops[0].direction,
      reserveAPre: hops[0].reserveAPre,
      reserveBPre: hops[0].reserveBPre,
      takerCommitment,
      memo,
    },
  };
}

export function buildConfidentialAmmRouteOp({
  job,
  routeBuilder,
  chainBinding,
  inNote,
  spendRoot = null,
  rIn,
  outOwner,
  rOut,
  deadline = 0,
}) {
  if (!job || job.kind !== VENUE_KINDS.EVM_CONFIDENTIAL_AMM || job.status !== 'needs-confidential-settle-proof') {
    throw new Error('route: confidential AMM proof job required');
  }
  if (!routeBuilder || typeof routeBuilder.buildRoute !== 'function') {
    throw new Error('route: routeBuilder.buildRoute required');
  }
  const s = job.swap;
  if (s.reserveAPre == null || s.reserveBPre == null) throw new Error('route: confidential AMM job missing reserve snapshot');
  const hops = (job.route?.hops?.length ? job.route.hops : [{
    assetOut: s.assetOut,
    feeBps: s.feeBps,
    reserveAPre: s.reserveAPre,
    reserveBPre: s.reserveBPre,
  }]).map((h) => ({
    assetNext: h.assetOut ?? h.assetNext,
    feeBps: h.feeBps,
    reserveAPre: h.reserveAPre,
    reserveBPre: h.reserveBPre,
  }));
  const op = routeBuilder.buildRoute({
    asset0: s.assetIn,
    chainBinding,
    inNote,
    amountIn: s.amountIn,
    rIn,
    hops,
    minOut: s.minAmountOut,
    outOwner,
    rOut,
    deadline,
  });
  return {
    kind: VENUE_KINDS.EVM_CONFIDENTIAL_AMM,
    status: 'ready-for-confidential-settle-proof',
    routeHash: job.routeHash,
    job,
    op: spendRoot ? { ...op, spendRoot } : op,
  };
}

function routeLeavesFromVerified(verified) {
  if (!verified || !Array.isArray(verified.leaves)) throw new Error('route: verified route leaves required');
  return verified.leaves;
}

function jsonSafe(x) {
  if (typeof x === 'bigint') return x.toString();
  if (Array.isArray(x)) return x.map(jsonSafe);
  if (x && typeof x === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(x)) {
      if (typeof v === 'function' || v === undefined || k === '_r') continue;
      out[k] = jsonSafe(v);
    }
    return out;
  }
  return x;
}

export async function submitConfidentialAmmRoute({
  relay,
  built,
  verified = null,
  leaves = null,
  outputs = null,
  ephRand = null,
  memos = null,
  mode = 'settle',
  wait = false,
  waitOpts = undefined,
}) {
  if (!relay || typeof relay.submitOp !== 'function') throw new Error('route: relay.submitOp required');
  if (!built || built.kind !== VENUE_KINDS.EVM_CONFIDENTIAL_AMM || built.status !== 'ready-for-confidential-settle-proof') {
    throw new Error('route: ready confidential AMM route op required');
  }
  if (!built.op?.spendRoot) throw new Error('route: built route op missing spendRoot');
  const opLeaves = leaves || (verified ? routeLeavesFromVerified(verified) : []);
  const spec = {
    type: 'route',
    op: jsonSafe(built.op),
    leaves: opLeaves,
    ...(outputs ? { outputs, ephRand } : { memos: memos || [] }),
    ...(mode ? { mode } : {}),
  };
  if (!wait) return relay.submitOp(spec);
  if (mode === 'prove') {
    if (typeof relay.prove !== 'function') throw new Error('route: relay.prove required');
    return relay.prove(spec, waitOpts);
  }
  if (typeof relay.settle !== 'function') throw new Error('route: relay.settle required');
  return relay.settle(spec, waitOpts);
}
