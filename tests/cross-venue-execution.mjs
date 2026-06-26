#!/usr/bin/env node
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { modN } from '../dapp/bulletproofs.js';
import { makeCrossChainAssets } from '../dapp/cross-chain-asset-resolver.js';
import { makeCrossChainOrderbook, signOrderOffer } from '../dapp/cross-chain-orderbook.js';
import { makeConfidentialRouter } from '../dapp/confidential-router.js';
import { makeConfidentialRelay } from '../dapp/confidential-relay.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialRoute } from '../dapp/confidential-route.js';
import { makeConfidentialSettler } from '../worker/src/confidential-settle.js';
import { LANES, VENUE_KINDS, makeConstantProductVenue, makeCrossVenueRouter, makeOrderbookVenue } from '../dapp/cross-venue-router.js';
import {
  buildBitcoinAmmRouteRequest,
  buildConfidentialAmmRouteJob,
  buildConfidentialAmmRouteOp,
  buildPublicEvmSwapRouteTx,
  executeOrderbookRoute,
  routePlanHash,
  signRouteIntent,
  submitConfidentialAmmRoute,
  verifyRouteIntent,
} from '../dapp/cross-venue-execution.js';

const sha256 = (b) => createHash('sha256').update(Buffer.from(b)).digest();
const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sc = (tag) => modN(BigInt('0x' + createHash('sha256').update(tag).digest('hex'))) || 1n;
const priv = (last) => Uint8Array.from({ length: 32 }, (_, i) => i === 31 ? last : 1);
const pub = (p) => '0x' + Buffer.from(secp.getPublicKey(p, true)).toString('hex');
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const noSleep = () => Promise.resolve();

const TAC = '0x' + 'aa'.repeat(32);
const TETH = '0x' + 'bb'.repeat(32);
const MID = '0x' + 'cc'.repeat(32);
const CB = '0x' + '12'.repeat(32);
const BOOK = '0x' + '34'.repeat(32);
const ROUTER = '0x4444444444444444444444444444444444444444';
const USER = '0x5555555555555555555555555555555555555555';
const TOKEN_TAC = '0x1111111111111111111111111111111111111111';
const TOKEN_TETH = '0x2222222222222222222222222222222222222222';

function resolver() {
  const X = makeCrossChainAssets({ sha256 });
  X.ingestBitcoin({ assetIdHex: TAC, ticker: 'TAC', decimals: 8 });
  X.ingestEvm({ assetIdHex: TAC, ticker: 'TAC', decimals: 8, canonicalErc20: '0x' + '11'.repeat(20) }, 1);
  X.ingestBitcoin({ assetIdHex: TETH, ticker: 'tETH', decimals: 8 });
  X.ingestEvm({ assetIdHex: TETH, ticker: 'tETH', decimals: 8, canonicalErc20: '0x' + '22'.repeat(20) }, 1);
  return X;
}

function signedOffer({ makerPriv, giveAmount, wantAmount, nonceByte }) {
  const offer = {
    chainBinding: CB,
    bookId: BOOK,
    makerPubkey: pub(makerPriv),
    giveAsset: TAC,
    giveAmount,
    giveLane: LANES.BITCOIN,
    wantAsset: TETH,
    wantAmount,
    wantLane: LANES.ETHEREUM,
    expiry: 1000,
    minFill: 1n,
    nonce: '0x' + nonceByte.toString(16).padStart(2, '0').repeat(32),
  };
  return { ...offer, signature: signOrderOffer(offer, makerPriv) };
}

function freshStore() {
  const jobs = new Map(); let pending = [];
  return {
    getPending: async () => pending.slice(),
    putPending: async (ids) => { pending = ids.slice(); },
    getJob: async (id) => (jobs.has(id) ? JSON.parse(JSON.stringify(jobs.get(id))) : null),
    putJob: async (id, job) => { jobs.set(id, JSON.parse(JSON.stringify(job))); },
  };
}

function mockFetch(q) {
  return async (urlStr, opts = {}) => {
    const url = new URL(urlStr, 'http://relay.test');
    const reply = (status, obj) => ({ ok: status >= 200 && status < 300, status, statusText: String(status), text: async () => JSON.stringify(obj) });
    if (url.pathname === '/confidential/submit' && opts.method === 'POST') {
      const b = JSON.parse(opts.body);
      try { return reply(200, { ok: true, ...(await q.submitJob({ type: b.type, op: b.op, memos: b.memos, mode: b.mode })) }); }
      catch (e) { return reply(400, { error: String(e.message) }); }
    }
    if (url.pathname === '/confidential/status') {
      const st = await q.jobStatus(url.searchParams.get('id'));
      return st ? reply(200, st) : reply(404, { error: 'unknown job' });
    }
    return reply(404, { error: 'no route' });
  };
}

// ── 1. taker route intent signs exactly the selected quote ──
{
  const ob = makeCrossChainOrderbook({ resolver: resolver(), chainBinding: CB, bookId: BOOK });
  ob.postSigned(signedOffer({ makerPriv: priv(2), giveAmount: 100n, wantAmount: 10n, nonceByte: 1 }));
  const router = makeCrossVenueRouter({ venues: [makeOrderbookVenue({ orderbook: ob })] });
  const quote = router.bestExactIn({ assetIn: TETH, laneIn: LANES.ETHEREUM, assetOut: TAC, laneOut: LANES.BITCOIN, amountIn: 10n, nowTs: 100 });
  const takerPriv = priv(9);
  const intent = {
    chainBinding: CB,
    routeHash: routePlanHash(quote),
    takerPubkey: pub(takerPriv),
    minOut: quote.amountOut,
    deadline: 500,
    nonce: '0x' + '77'.repeat(32),
  };
  const signed = { ...intent, signature: signRouteIntent(intent, takerPriv) };
  assert.equal(verifyRouteIntent(signed), true, 'route intent verifies');
  assert.equal(verifyRouteIntent({ ...signed, minOut: signed.minOut + 1n }), false, 'minOut tamper rejected');
  ok('taker route intent binds selected quote hash, minOut, deadline, nonce, chainBinding, and taker key');
}

// ── 2. execution revalidates the live orderbook and mutates only the quoted fills ──
{
  const ob = makeCrossChainOrderbook({ resolver: resolver(), chainBinding: CB, bookId: BOOK });
  ob.postSigned(signedOffer({ makerPriv: priv(2), giveAmount: 100n, wantAmount: 10n, nonceByte: 2 }));
  ob.postSigned(signedOffer({ makerPriv: priv(3), giveAmount: 90n, wantAmount: 10n, nonceByte: 3 }));
  const router = makeCrossVenueRouter({ venues: [makeOrderbookVenue({ orderbook: ob })] });
  const quote = router.bestExactIn({ assetIn: TETH, laneIn: LANES.ETHEREUM, assetOut: TAC, laneOut: LANES.BITCOIN, amountIn: 15n, nowTs: 100 });
  assert.equal(quote.amountOut, 145n, 'quote sweeps two offers');
  const takerPriv = priv(8);
  const intent = {
    chainBinding: CB, routeHash: routePlanHash(quote), takerPubkey: pub(takerPriv),
    minOut: 140n, deadline: 500, nonce: '0x' + '88'.repeat(32),
  };
  const res = executeOrderbookRoute({
    orderbook: ob,
    quote,
    taker: 'T',
    routeIntent: { ...intent, signature: signRouteIntent(intent, takerPriv) },
    tSecrets: [sc('t1'), sc('t2')],
    deadlines: { nearDeadline: 200, farDeadline: 300 },
    nowTs: 100,
  });
  assert.equal(res.fills.length, 2, 'two adaptor fill contexts returned');
  assert.equal(res.fills[0].legs.initiator.amount, 10n, 'first fill taker pays 10 tETH');
  assert.equal(res.fills[1].legs.initiator.amount, 5n, 'second fill taker pays 5 tETH');
  assert.equal(ob.book(100).length, 1, 'partially used second offer remains live');
  ok('orderbook route execution revalidates then returns adaptor fill artifacts');
}

// ── 3. stale plans fail before mutation ──
{
  const ob = makeCrossChainOrderbook({ resolver: resolver(), chainBinding: CB, bookId: BOOK });
  const id = ob.postSigned(signedOffer({ makerPriv: priv(4), giveAmount: 100n, wantAmount: 10n, nonceByte: 4 }));
  const router = makeCrossVenueRouter({ venues: [makeOrderbookVenue({ orderbook: ob })] });
  const quote = router.bestExactIn({ assetIn: TETH, laneIn: LANES.ETHEREUM, assetOut: TAC, laneOut: LANES.BITCOIN, amountIn: 10n, nowTs: 100 });
  ob.cancel(id, ob.get(id).maker);
  assert.throws(() => executeOrderbookRoute({
    orderbook: ob,
    quote,
    taker: 'T',
    tSecrets: [sc('t')],
    deadlines: { nearDeadline: 200, farDeadline: 300 },
    nowTs: 100,
  }), /stale orderbook quote/, 'cancelled offer invalidates prior quote');
  ok('stale orderbook route is rejected before any fill mutates state');
}

// ── 4. public EVM AMM quotes can become ConfidentialRouter txs with explicit asset scaling ──
{
  const venue = makeConstantProductVenue({
    id: 'public-evm',
    kind: VENUE_KINDS.EVM_PUBLIC_AMM,
    lane: LANES.ETHEREUM,
    pools: [{ id: 'pub', assetA: TAC, assetB: TETH, reserveA: 1000n, reserveB: 100n, feeBps: 30 }],
  });
  const router = makeCrossVenueRouter({ venues: [venue] });
  const quote = router.bestExactIn({ assetIn: TAC, laneIn: LANES.ETHEREUM, assetOut: TETH, laneOut: LANES.ETHEREUM, amountIn: 100n });
  const takerPriv = priv(7);
  const intent = {
    chainBinding: CB,
    routeHash: routePlanHash(quote),
    takerPubkey: pub(takerPriv),
    minOut: quote.amountOut - 1n,
    deadline: 500,
    nonce: '0x' + '99'.repeat(32),
  };
  const rc = makeConfidentialRouter({
    secp,
    keccak256: keccak_256,
    sha256,
    cfg: { chainId: 11155111, router: ROUTER },
  });
  const built = buildPublicEvmSwapRouteTx({
    quote,
    routerClient: rc,
    assetMap: {
      [TAC.toLowerCase()]: { token: TOKEN_TAC, unitScale: 10n },
      [TETH.toLowerCase()]: { token: TOKEN_TETH, unitScale: 100n },
    },
    priv: '0x' + Buffer.from(takerPriv).toString('hex'),
    to: USER,
    permit2Nonce: 5,
    expiration: 1800000000,
    deadline: 1700000000,
    routeIntent: { ...intent, signature: signRouteIntent(intent, takerPriv) },
    nowTs: 100,
  });
  assert.equal(built.tx.to, ROUTER.toLowerCase());
  assert.equal(built.tx.value, 0n);
  assert.ok(built.tx.calldata.startsWith('0xa02962d7'), 'swapPublicWithPermit2 selector');
  assert.equal(built.amountIn, 1000n, 'input scaled into token units');
  assert.equal(built.minAmountOut, (quote.amountOut - 1n) * 100n, 'minOut scaled into output token units');
  assert.equal(built.tokenIn, TOKEN_TAC);
  ok('public EVM AMM quote builds a ConfidentialRouter Permit2 swap tx with route-intent minOut');
}

// ── 5. confidential EVM AMM quotes become proof jobs, then native OP_SWAP_ROUTE ops ──
{
  const venue = makeConstantProductVenue({
    id: 'evm-conf',
    kind: VENUE_KINDS.EVM_CONFIDENTIAL_AMM,
    lane: LANES.ETHEREUM,
    pools: [{ id: 'conf', assetA: TAC, assetB: TETH, reserveA: 1000n, reserveB: 100n, feeBps: 30 }],
  });
  const router = makeCrossVenueRouter({ venues: [venue] });
  const quote = router.bestExactIn({ assetIn: TAC, laneIn: LANES.ETHEREUM, assetOut: TETH, laneOut: LANES.ETHEREUM, amountIn: 25n });
  const job = buildConfidentialAmmRouteJob({ quote, takerCommitment: '0x' + 'ab'.repeat(32), memo: '0x1234' });
  assert.equal(job.status, 'needs-confidential-settle-proof');
  assert.equal(job.swap.poolId, 'conf');
  assert.equal(job.swap.amountIn, 25n);
  assert.equal(job.swap.minAmountOut, quote.amountOut);

  const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
  const route = makeConfidentialRoute({ keccak256: keccak_256, pool });
  const owner = '0x' + '00'.repeat(31) + '01';
  const outOwner = '0x' + '00'.repeat(31) + '02';
  const built = buildConfidentialAmmRouteOp({
    job,
    routeBuilder: route,
    chainBinding: CB,
    inNote: { owner, leafIndex: 0, path: pool.zeros },
    rIn: randomScalar(),
    outOwner,
    rOut: randomScalar(),
    deadline: 500,
  });
  assert.equal(built.status, 'ready-for-confidential-settle-proof');
  assert.equal(built.op.asset0, TAC.slice(2).toLowerCase());
  assert.equal(built.op.assetFinal, TETH.slice(2).toLowerCase());
  assert.equal(built.op.amountIn, 25n);
  assert.equal(built.op.minOut, quote.amountOut);

  const tree = new pool.Tree();
  const idx = tree.insert(pool.leaf(built.op.asset0, built.op.in.cx, built.op.in.cy, built.op.in.owner));
  built.op.in.leafIndex = idx;
  built.op.in.path = tree.rootAndPath(idx).path;
  const spendRoot = tree.rootAndPath(idx).root;
  built.op.spendRoot = spendRoot;
  const verified = route.verifyRoute(built.op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });
  assert.equal(verified.swaps.length, 1);
  assert.equal(verified.swaps[0].reserveAPost, 1025n);
  assert.equal(verified.leaves[0], pool.leaf(TETH.slice(2).toLowerCase(), built.op.out.cx, built.op.out.cy, outOwner));
  const guard = {
    sealMemosForOutputs: ({ outputs, ephRand }) => {
      void ephRand();
      return outputs.map(() => '0x' + 'cd'.repeat(68));
    },
    assertOutputsRecoverable: ({ leaves, outputs, memos }) => {
      if (leaves.length !== 1 || outputs.length !== 1 || memos.length !== 1) throw new Error('bad recovery alignment');
    },
  };
  const q = makeConfidentialSettler({ storage: freshStore(), hash: (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex') });
  const relay = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q), guard });
  const submitted = await submitConfidentialAmmRoute({
    relay,
    built,
    verified,
    outputs: [{ ownerPub: '0x02' + 'ab'.repeat(32), value: built.op.amountOut, blinding: 1n, asset: built.op.assetFinal, owner: outOwner }],
    ephRand: () => 9n,
  });
  const claimed = await q.nextJob();
  assert.equal(submitted.status, 'pending');
  assert.equal(claimed.type, 'route');
  assert.equal(claimed.op.assetFinal, built.op.assetFinal);
  assert.equal(claimed.op.spendRoot, spendRoot);
  assert.deepEqual(claimed.memos, ['0x' + 'cd'.repeat(68)]);
  ok('confidential EVM AMM quote normalizes into OP_SWAP_ROUTE and queues as a guarded route settle job');
}

// ── 6. route prove-only mode resolves to publicValues/proof artifacts ──
{
  const built = {
    kind: VENUE_KINDS.EVM_CONFIDENTIAL_AMM,
    status: 'ready-for-confidential-settle-proof',
    op: { asset0: TAC.slice(2), assetFinal: TETH.slice(2), amountIn: 1n, spendRoot: '0x' + '55'.repeat(32) },
  };
  const q = makeConfidentialSettler({ storage: freshStore(), hash: (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex') });
  const relay = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q) });
  const submitted = await submitConfidentialAmmRoute({ relay, built, memos: [], mode: 'prove' });
  const claimed = await q.nextJob();
  assert.equal(claimed.type, 'route');
  assert.equal(claimed.mode, 'prove');
  await q.ackJob(submitted.jobId, { publicValues: '0xpv', proof: '0xpf' });
  const proven = await relay.waitForProof(submitted.jobId, { intervalMs: 0, sleep: noSleep });
  assert.equal(proven.status, 'proven');
  assert.equal(proven.publicValues, '0xpv');
  assert.equal(proven.proof, '0xpf');
  ok('route prove-only mode queues route op and resolves publicValues/proof artifacts');
}

// ── 7. confidential AMM multihop quote becomes a multihop OP_SWAP_ROUTE ──
{
  const venue = makeConstantProductVenue({
    id: 'evm-conf',
    kind: VENUE_KINDS.EVM_CONFIDENTIAL_AMM,
    lane: LANES.ETHEREUM,
    pools: [
      { id: 'bad-direct', assetA: TAC, assetB: TETH, reserveA: 1000n, reserveB: 20n, feeBps: 30 },
      { id: 'tac-mid', assetA: TAC, assetB: MID, reserveA: 1000n, reserveB: 1000n, feeBps: 30 },
      { id: 'mid-teth', assetA: MID, assetB: TETH, reserveA: 1000n, reserveB: 1000n, feeBps: 30 },
    ],
  });
  const router = makeCrossVenueRouter({ venues: [venue] });
  const quote = router.bestExactIn({ assetIn: TAC, laneIn: LANES.ETHEREUM, assetOut: TETH, laneOut: LANES.ETHEREUM, amountIn: 100n });
  assert.equal(quote.plan.type, 'constant-product-route');
  const job = buildConfidentialAmmRouteJob({ quote });
  assert.equal(job.route.hops.length, 2);

  const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
  const route = makeConfidentialRoute({ keccak256: keccak_256, pool });
  const owner = '0x' + '00'.repeat(31) + '03';
  const outOwner = '0x' + '00'.repeat(31) + '04';
  const built = buildConfidentialAmmRouteOp({
    job,
    routeBuilder: route,
    chainBinding: CB,
    inNote: { owner, leafIndex: 0, path: pool.zeros },
    rIn: randomScalar(),
    outOwner,
    rOut: randomScalar(),
  });
  assert.equal(built.op.hops.length, 2);
  assert.equal(built.op.hops[0].assetNext, MID.slice(2));
  assert.equal(built.op.hops[1].assetNext, TETH.slice(2));

  const tree = new pool.Tree();
  const idx = tree.insert(pool.leaf(built.op.asset0, built.op.in.cx, built.op.in.cy, built.op.in.owner));
  built.op.in.leafIndex = idx;
  built.op.in.path = tree.rootAndPath(idx).path;
  const spendRoot = tree.rootAndPath(idx).root;
  const verified = route.verifyRoute(built.op, { merkleRootFrom: pool.merkleRootFrom, spendRoot });
  assert.equal(verified.swaps.length, 2);
  assert.equal(verified.leaves.length, 1);
  ok('confidential AMM multihop quote normalizes into a two-hop OP_SWAP_ROUTE');
}

// ── 8. Bitcoin AMM quotes dispatch to native T_SWAP_VAR / T_SWAP_ROUTE builders ──
{
  const direct = makeConstantProductVenue({
    id: 'btc-direct',
    kind: VENUE_KINDS.BTC_AMM,
    lane: LANES.BITCOIN,
    pools: [{ pool_id: 'btc-ab', asset_a: TAC.slice(2), asset_b: TETH.slice(2), reserve_a: '1000', reserve_b: '100', fee_bps: 30 }],
  });
  const q1 = makeCrossVenueRouter({ venues: [direct] })
    .bestExactIn({ assetIn: TAC, laneIn: LANES.BITCOIN, assetOut: TETH, laneOut: LANES.BITCOIN, amountIn: 100n });
  const r1 = buildBitcoinAmmRouteRequest({ quote: q1, minOut: q1.amountOut - 1n, expiryHeight: 123 });
  assert.equal(r1.opcode, 'T_SWAP_VAR');
  assert.equal(r1.builder, 'buildAndBroadcastSwapVarSelfFulfill');
  assert.equal(r1.args.poolReserves.pool_id_hex, 'btc-ab');
  assert.equal(r1.args.direction, 0);
  assert.equal(r1.args.deltaIn, 100n);

  const multi = makeConstantProductVenue({
    id: 'btc-route',
    kind: VENUE_KINDS.BTC_AMM,
    lane: LANES.BITCOIN,
    pools: [
      { pool_id: 'btc-bad-direct', asset_a: TAC.slice(2), asset_b: TETH.slice(2), reserve_a: '1000', reserve_b: '20', fee_bps: 30 },
      { pool_id: 'btc-am', asset_a: TAC.slice(2), asset_b: MID.slice(2), reserve_a: '1000', reserve_b: '1000', fee_bps: 30 },
      { pool_id: 'btc-mb', asset_a: MID.slice(2), asset_b: TETH.slice(2), reserve_a: '1000', reserve_b: '1000', fee_bps: 30 },
    ],
  });
  const q2 = makeCrossVenueRouter({ venues: [multi] })
    .bestExactIn({ assetIn: TAC, laneIn: LANES.BITCOIN, assetOut: TETH, laneOut: LANES.BITCOIN, amountIn: 100n });
  const r2 = buildBitcoinAmmRouteRequest({ quote: q2 });
  assert.equal(q2.plan.type, 'constant-product-route');
  assert.equal(r2.opcode, 'T_SWAP_ROUTE');
  assert.equal(r2.builder, 'buildAndBroadcastSwapRoute');
  assert.equal(r2.hops.length, 2);
  assert.equal(r2.hops[0].poolId, 'btc-am');
  assert.equal(r2.hops[0].deltaANetMag, 100n);
  assert.equal(r2.deltaOutLast, q2.amountOut);
  ok('Bitcoin AMM quote handoff preserves native T_SWAP_VAR/T_SWAP_ROUTE execution boundaries');
}

console.log(`\n${n}/8 cross-venue execution checks passed`);
