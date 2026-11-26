#!/usr/bin/env node
// The fast bridge liquidity provider. One process: it answers quotes and offers over HTTP, and advances every open swap
// (checks the user's Bitcoin lock against the chain, makes its pool note ready, locks it, publishes the offer, reads t from
// the user's claim and takes the Bitcoin lock, or refunds after the deadline).
//
//   FB_LP_KEY=<64 hex>        the LP's key: its Bitcoin wallet, its pool identity, the root of its swap seed. Env only.
//   FB_LP_CONFIG=<path>       the config file (README.md). Default ./fastbridge-lp/config.json
//   FB_LP_ALERT_WEBHOOK=<url> optional: alerts are POSTed there as JSON as well as logged
//   FB_LP_AUTO_SHIELD=on      a pair provider shields the ETH sent to its pool account (FB_LP_SHIELD_RESERVE_ETH, _MIN_ETH, _EVERY_SECS; FB_LP_ALERT_LOW_ETH, _LOW_SATS: lib/shield.mjs, lib/refill-watch.mjs)
//   FB_LP_TRACE_RPCS=<urls>   the nodes that trace a transaction (comma separated, an own archive node first): how a claim sent through another contract is read
//   PORT, FB_LP_DATA_DIR, FB_LP_NAME, FB_LP_BOARDS, FB_LP_MIN_AMOUNT, FB_LP_MAX_AMOUNT, FB_LP_FEE_BPS, FB_LP_FLAT_FEE   optional: set over the config (lib/env-config.mjs)
//   node fastbridge-lp/server.mjs [--dry-run]     (Node 22; run from the repository root)
//
// --dry-run answers /info and /quote and checks offers against the chain, but sends nothing and advances no swap.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeLineageClassScreen, normalizeLineageFees } from '../dapp/fastbridge-lineage-pricing.js';
process.on('unhandledRejection', (e) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'unhandled rejection', error: String((e && e.message) || e).slice(0, 200) })));

const DRY = process.argv.includes('--dry-run');
const cfgPath = resolve(process.env.FB_LP_CONFIG || 'fastbridge-lp/config.json');
const { applyEnv } = await import('./lib/env-config.mjs');
const pairLib = await import('./lib/pair.mjs');
let C, lineageFees = null;
try {
  C = applyEnv(JSON.parse(readFileSync(cfgPath, 'utf8'))); if (pairLib.isPair(C)) C = pairLib.pairConfig(C);
  if (pairLib.isPair(C) && C.quote && C.quote.lineageFees) throw new Error('quote.lineageFees is for a TAC provider, not a BTC-ETH pair provider');
  lineageFees = normalizeLineageFees(C.quote && C.quote.lineageFees);
} catch (e) { console.error(String((e && e.message) || e)); process.exit(1); }
// BTC-ETH pair mode (lib/pair.mjs): a provider of Bitcoin for ETH and ETH for Bitcoin, priced from a feed of ETH per BTC, with a key of its own
const PAIR = pairLib.isPair(C);
const keyHex = String(process.env.FB_LP_KEY || '').trim().replace(/^0x/, '');
if (!/^[0-9a-f]{64}$/i.test(keyHex)) { console.error('FB_LP_KEY must be 64 hex characters (set it in the environment)'); process.exit(1); }
const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

const { makeFileStorage } = await import('./lib/storage.mjs');
const { loadTacit } = await import('../worker-relay/src/lib/btc-pool-transparent.js');
const { secp, sha256, keccak_256, hmac } = await import('../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const { makeConfidentialPoolUx } = await import('../dapp/confidential-pool-ux.js');
const { setActiveNetwork } = await import('../dapp/confidential-deployments.js');
const { makeBtcWallet } = await import('../dapp/bitcoin-taproot-wallet.js');
const { makeAdaptorBtcTx, tacitKit } = await import('../dapp/adaptor-btc-tx.js');
const { makeFastBridgeEvm, makeTxTracer, makeNodeQuorum, TRACE_NODES, AGREE_NODES } = await import('../dapp/fastbridge-evm.js');
const { makeFileStore, makeFileLogStore, makeMemoryStore } = await import('./lib/store.mjs');
const { makeNodeBtcChain } = await import('./lib/btc-chain.mjs');
const { makeLpService } = await import('./lib/service.mjs');
const { makeHttpServer } = await import('./lib/http.mjs');
const { makeAlert } = await import('./lib/alert.mjs');
const { makeSerial } = await import('./lib/serial.mjs');

const network = C.network || 'mainnet';
setActiveNetwork(network);
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const key = hexToBytes(keyHex);
const hmacSha256 = (k, m) => hmac(sha256, k, m);
const seed = hmacSha256(key, new TextEncoder().encode('tacit-fastbridge-lp-seed'));

// The reverse side reads its notes with the wallet module, which reads Bitcoin from the public explorers unless told it is a headless host: and the explorers throttle this
// host's shared address (every read of the reverse address failed "rate limited" on Render). Such a host sets these before the module loads (the module's own setting for it,
// as the hosted watchtower does) and reads through the Tacit API's chain proxy first. Only when the reverse side is on: nothing else here reads through the module.
if (C.reverse && C.reverse.enabled === true) { globalThis.__TACIT_WORKER_BASE__ = process.env.TACIT_WORKER_BASE || 'https://api.tacit.finance'; globalThis.__TACIT_CHAIN_VIA_WORKER__ = true; }
// The live pool: a note that came out of the Bitcoin shielded pool is told from the pool service, as a page tells it. Without this the validator
// asks a replay's (empty) exit set, and every such note, which the fast bridge exists to move, reads as not valid.
const tacit = await loadTacit(network, { livePool: true });
// loading the note validator gives this process a browser-like window with a localStorage of its own and a location at
// localhost. The wallet module keeps its scan checkpoints in localStorage, so a file stands in for it; and it is built
// with no location, because a localhost page makes the deployment config point the relay at the page itself.
globalThis.localStorage = makeFileStorage(resolve(C.dataDir || 'fastbridge-lp/data', 'wallet-cache.json'));
const savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
delete globalThis.location;
const { prims } = makeBtcWallet({ priv: key, hrp: network === 'mainnet' ? 'bc' : 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
const builder = makeAdaptorBtcTx({ prims, kit: tacitKit(tacit) });
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: (u, o) => fetch(u, o), network, logStore: makeFileLogStore(resolve(C.dataDir || 'fastbridge-lp/data', 'logs')) });
if (savedLocation) Object.defineProperty(globalThis, 'location', savedLocation);
// What the relay will not send (its free settles for the day are used up, it is held, it is busy) this process sends from its own account, the
// Ethereum address of the key, which holds the ETH for it. The settle is tried first, so one the pool would refuse costs nothing.
const acct = ux.account(key);
// The address is sent from by the settles below and by the refill: they take turns, one send at a time, so two begun together never read one nonce.
const turn = makeSerial();
const selfSettle = (x) => turn(async () => {
  if (!x || !x.publicValues || !x.proof) throw new Error('there is no proof to send');
  await ux.rpc('eth_call', [{ from: acct.address, to: ux.cfg.pool, data: ux.settleCalldata(x) }, 'latest']);
  return ux.settleFromAccount({ settlerPriv: key, publicValues: x.publicValues, proof: x.proof, memos: x.memos || [] });
});
const alert = makeAlert({ log, webhook: process.env.FB_LP_ALERT_WEBHOOK || null, name: C.name || undefined });
// the nodes asked for a transaction's trace, to read a claim settled through a contract other than the pool or its relayer (README `traceRpcs`). The pool keeps no
// record of a claim's kernel apart from the call that carried it, so a claim sent through a contract in a form of its own is read only from a trace, and a public node
// may refuse a transaction made costly to trace. Until the pool records claims, a node of the operator's own that keeps state and traces (an archive node, first in
// FB_LP_TRACE_RPCS) is what reads every claim; a claim no node traced is alerted with its transaction (onUnread below).
const traceNodes = String(process.env.FB_LP_TRACE_RPCS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!traceNodes.length) traceNodes.push(...(Array.isArray(C.traceRpcs) && C.traceRpcs.length ? C.traceRpcs : TRACE_NODES));
// the nodes that must agree (two or more, all that answer alike) before a swap is taken as claimed, refunded or lost (README `agreeRpcs`)
const agreeNodes = String(process.env.FB_LP_AGREE_RPCS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!agreeNodes.length) agreeNodes.push(...(Array.isArray(C.agreeRpcs) && C.agreeRpcs.length ? C.agreeRpcs : AGREE_NODES));
if (agreeNodes.length < 2) { console.error('agreeRpcs (FB_LP_AGREE_RPCS) must name two Ethereum nodes or more'); process.exit(1); }
if (traceNodes.length < 2) log({ level: 'warn', msg: 'traceRpcs names one node: a claim read from a trace is taken only once two nodes trace it alike' });
const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256, walletPriv: key, seed, asset: C.evmAsset, poolAddress: C.poolAddress, policy: { minClaimSecs: C.policy.minClaimSecs }, selfSettle, ownAccount: { address: acct.address }, selfRetryMs: 60000, log, trace: makeTxTracer({ nodes: traceNodes, pool: C.poolAddress }), quorum: makeNodeQuorum({ nodes: agreeNodes }), onUnread: (o) => alert(o) });
// What the provider's Bitcoin transactions pay. A pair provider's are each on a swap's clock (its lock a user waits on, its take, its refund), so they go out for
// the next block (`btcFeeTarget`, the explorers' estimate for that many blocks: '1') and never under `btcMinFeeRate` sat/vB (2), as the page's locks do
// (dapp/fast/pair-wire.js); the fee comes out of the provider's spread, and a lock that still misses a block is bumped from its change (fastbridge-bl.js
// bumpLock). The TAC provider keeps its three-block estimate unless its config says otherwise: its quotes ask the user for the fee of its take.
const btcFees = { feeTarget: String(C.btcFeeTarget ?? (PAIR ? '1' : '3')), minFeeRate: Number(C.btcMinFeeRate ?? (PAIR ? 2 : 1)) };
const btc = makeNodeBtcChain({
  bases: C.btcBases, tacit, prims, builder, pool: ux.pool, ethGetStorageAt: (to, slot, tag) => ux.rpc('eth_getStorageAt', [to, slot, tag]),
  poolAddress: C.poolAddress, binding: ux.chainBindingHex(), keccak256: keccak_256, secp, log, ...btcFees,
});

// the price: read now and again every `rate.everySecs`; with none the provider quotes nothing and says so (a provider never prices from a feed it cannot read)
let rateFeed = null;
if (PAIR) {
  rateFeed = pairLib.pairFeed({ call: (to, data) => ux.rpc('eth_call', [{ to, data }, 'latest']), fetchImpl: (u, o) => fetch(u, o), log, C });
  await rateFeed.refresh().catch(() => {});
  setInterval(() => { rateFeed.refresh().catch(() => {}); }, (C.rate?.everySecs ?? 30) * 1000).unref();
  log({ level: 'info', msg: 'pair provider: Bitcoin for ETH', price: rateFeed.current(), sats: { min: C.quote.minAmount, max: C.quote.maxAmount }, reverse: !!(C.reverse && C.reverse.enabled) });
}

// A pair provider's upkeep (lib/automation.mjs, README "Upkeep"): its quotes price from the market moved by the lean of the moment (lib/skew.mjs), and each quote
// keeps the market rate it was priced from (`mkt`), which the accounting of the swap reads. The pool's own sends (a lock's note cut and lock, a merge of small
// notes, a buyback send) take turns, so the upkeep never spends a note a lock is being built from.
const { applySkew } = await import('./lib/skew.mjs');
let leanBps = 0;
const quoteRate = () => { const r = rateFeed && rateFeed.rate(); return r && leanBps ? applySkew(r, leanBps) : r; };
const withMkt = (store) => (PAIR ? { ...store, put: async (rec) => { if (rec && rec.id && !rec.mkt) { const m = rateFeed.rate(); if (m) rec = { ...rec, mkt: { num: String(m.num), den: String(m.den) }, ...(leanBps ? { leanBps } : {}) }; } return store.put(rec); }, get: store.get.bind(store), list: store.list.bind(store), del: store.del ? store.del.bind(store) : undefined, problems: store.problems ? store.problems.bind(store) : () => [] } : store);
const poolTurn = makeSerial();
if (PAIR) for (const k of ['prepare', 'lockOp']) { const f = evm[k]; if (typeof f === 'function') evm[k] = (...a) => poolTurn(() => f(...a)); }

// The flat part of the fee following the provider's own network cost (lib/flatfee.mjs): off unless FB_LP_DYNAMIC_FEE=on. Reads the fee estimate the provider already
// warms and the relay's fee for a pool note, every 30 s; a read that fails keeps the last good one for a while, then the configured flat fees apply.
let flat = null;
if (PAIR && C.feeModel && C.feeModel.dynamic === true) {
  const { makeFlatFee } = await import('./lib/flatfee.mjs');
  const fm = C.feeModel, fwdM = fm.fwd || {}, revM = fm.rev || {}, RC = C.reverse && C.reverse.enabled ? C.reverse : null;
  const got = { feeRate: null, feeAt: -Infinity, relay: null, relayAt: -Infinity };
  const fresh = (t) => Date.now() / 1000 - t <= 1800;
  flat = makeFlatFee({
    dynamic: true, subsidy: fm.subsidy ?? 0.5, subsidyUntil: fm.subsidyUntil ?? null,
    fwd: { flat: C.quote.flatFee, min: fwdM.min ?? '100', max: fwdM.max ?? null, minAmount: C.quote.minAmount, feeBps: C.quote.feeBps },
    rev: RC ? { flat: RC.flatFee, min: revM.min ?? '2000', max: revM.max ?? null, minAmount: RC.minAmount, feeBps: RC.feeBps } : null,
    read: () => (fresh(got.feeAt) && fresh(got.relayAt) ? { feeRate: got.feeRate, relayEth: got.relay, rate: rateFeed.rate() } : null),
  });
  const lookCosts = async () => {
    try { const r = Number(await btc.feeRate(30000)); if (r > 0) { got.feeRate = r; got.feeAt = Date.now() / 1000; } } catch { /* the last good one stands for a while */ }
    try { got.relay = await evm.cutReserve(10n ** 10n); got.relayAt = Date.now() / 1000; } catch { /* as above */ }
    if (flat.update()) log({ level: 'info', msg: 'flat fee follows cost', ...flat.view() });
  };
  setTimeout(lookCosts, 5000).unref(); setInterval(lookCosts, 30000).unref();
  log({ level: 'info', msg: 'dynamic flat fee is on', subsidy: fm.subsidy ?? 0.5, limits: flat.view().limits });
}

const confs = (C.policy.confs || [['0', 1]]).map(([from, n]) => [BigInt(from), n]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
// TAC with up to 8 places, as the pool's units (8 places) and as the token's wei (18)
const tacUnits = (t) => { const [whole, frac = ''] = String(t).split('.'); return BigInt(whole) * 10n ** 8n + BigInt(frac.padEnd(8, '0').slice(0, 8)); };
const config = {
  claimPub: Buffer.from(prims.wallet.pub).toString('hex'), csvBlocks: C.csvBlocks ?? 144, alertSecs: C.alertSecs ?? 3600, reserve: C.reserve, inventory: C.inventory,
  ...(Array.isArray(C.recoveredSwaps) ? { recoveredSwaps: C.recoveredSwaps } : {}),
  lowFree: (PAIR ? C.lowFreeEth : C.lowFreeTac) != null ? tacUnits(PAIR ? C.lowFreeEth : C.lowFreeTac) : null,    // what is left to lend, an amount with up to 8 places (TAC, or ETH for a pair provider)
  lowEth: C.lowEth != null ? tacUnits(C.lowEth) * 10n ** 10n : null,        // an ETH amount ("0.002") in wei: the units helper reads up to 8 places
  quote: { ...C.quote, btcAsset: C.btcAsset, evmAsset: C.evmAsset, ...(lineageFees ? { lineageFees } : {}), ...(PAIR ? { rate: () => quoteRate() } : {}), ...(flat ? { flatFee: () => flat.fwd() } : {}) },
  anyTac: C.anyTac !== false,
  policy: {
    minCsv: C.policy.minCsv ?? 72, evmWindowSecs: C.policy.evmWindowSecs ?? 4 * 3600, minClaimSecs: C.policy.minClaimSecs ?? 3600, claimSlackSecs: C.policy.claimSlackSecs ?? 7200,
    roundSecs: C.policy.roundSecs ?? 600, refundMarginSecs: C.policy.refundMarginSecs ?? 600, maxOfferAgeSecs: C.policy.maxOfferAgeSecs ?? 3600, holdAgeSecs: C.policy.holdAgeSecs,
    minAmount: C.quote.minAmount, maxAmount: C.quote.maxAmount,
    ...((lineageFees || C.anyTac === false) ? { screen: makeLineageClassScreen((ns) => tacit.bridgeUx().lineage(ns), { refusePoolExit: C.anyTac === false }) } : {}),
    minConfsFor: (v) => confs.reduce((n, [from, c]) => (BigInt(v) >= from ? c : n), confs[0][1]),
  },
};
const data = resolve(C.dataDir || 'fastbridge-lp/data');
// a pair provider with no price quotes nothing: said, and again each alertSecs while it stays so, and once when the price is back
if (PAIR) {
  let priced = true, saidAt = -Infinity;
  setInterval(() => {
    const now = Math.floor(Date.now() / 1000), ok = !!rateFeed.current();
    if (!ok && (priced || now - saidAt >= (C.alertSecs ?? 3600))) { alert({ level: 'alert', msg: 'the provider has no price for Bitcoin against ETH: its sources are down or disagree, so it quotes nothing' }); saidAt = now; }
    if (ok && !priced) alert({ level: 'info', msg: 'the provider has its price again' });
    priced = ok;
  }, 60_000).unref();
}
// a dry run keeps its swaps and quotes in memory, so a later live run starts from nothing it did not choose
const swapStore = DRY ? makeMemoryStore() : makeFileStore(resolve(data, 'swaps'));
const quoteStore = withMkt(DRY ? makeMemoryStore() : makeFileStore(resolve(data, 'quotes')));
const service = makeLpService({ seed, btc, evm, swaps: swapStore, quoteStore, config, log, alert });

log({ level: 'info', msg: 'fast bridge LP', network, dryRun: DRY, bitcoinAddress: btc.address, claimPub: config.claimPub, poolAccount: acct.address, config: cfgPath, data });
await service.start();
let busy = false;
if (!DRY) setInterval(async () => { if (busy) return; busy = true; try { await service.tick(); } finally { busy = false; } }, (C.tickSecs ?? 15) * 1000);

// Keeping the private TAC filled (lib/refill.mjs, README "Keeping it filled"): on unless the config says `"refill": false`. TAC that reaches the
// provider's own address, from anyone, is shielded and lent, so topping it up is sending TAC to the address it prints. When the config also names a
// treasury and what the provider holds free falls under `lowWaterTac`, a chunk is pulled from the treasury (which has approved this key for a limited
// amount, and can take that back with an approval of 0) and shielded. The key can pull nothing the treasury has not approved.
if (C.refill !== false && !DRY) {
  const { makeRefill } = await import('./lib/refill.mjs');
  const rc = C.refill && typeof C.refill === 'object' ? C.refill : {};
  const treasury = rc.treasury == null ? null : String(rc.treasury).toLowerCase();
  if (treasury != null && !/^0x[0-9a-f]{40}$/.test(treasury)) { console.error('refill.treasury must be an Ethereum address'); process.exit(1); }
  const tacMeta = ux.assetByTicker.TAC;
  if (!tacMeta || !tacMeta.underlying) { console.error('this build of the pool module has no TAC token to refill with'); process.exit(1); }
  const token = tacMeta.underlying;
  const wei = (t) => tacUnits(t) * 10n ** 10n;                      // also an ETH amount in its 18 places
  const word = (a) => BigInt(a).toString(16).padStart(64, '0');
  const readNum = async (data) => BigInt(await ux.rpc('eth_call', [{ to: token, data }, 'latest']));
  const stateFile = resolve(data, 'refill.json');
  const { readFileSync: readF, writeFileSync: writeF } = await import('node:fs');
  const minEth = wei(rc.minEth ?? '0');                             // a floor for the ETH it keeps; what it needs follows the gas price (below)
  const REFILL_GAS = 1_500_000n;                                    // a pull, a deposit and a settle sent from this address, with room
  const refill = makeRefill({
    free: () => service.free(),
    publicTac: () => readNum('0x70a08231' + word(acct.address)),
    allowance: async () => (treasury ? readNum('0xdd62ed3e' + word(treasury) + word(acct.address)) : 0n),
    treasuryTac: async () => (treasury ? readNum('0x70a08231' + word(treasury)) : 0n),
    ethOk: async () => {
      const [bal, price] = [BigInt(await ux.rpc('eth_getBalance', [acct.address, 'latest'])), BigInt(await ux.rpc('eth_gasPrice', []))];
      const need = REFILL_GAS * (2n * price + 100000000n);         // at twice the gas price of the moment and a 0.1 gwei tip, as a send reserves
      return bal >= (need > minEth ? need : minEth);
    },
    // its sends take their turn with the provider's own settles (`turn`), so a refill no longer waits for a quiet hour that a busy one never has
    pull: (amount) => turn(async () => {
      const sent = await ux.sendPreparedTx({ walletPriv: key, to: token, calldata: '0x23b872dd' + word(treasury) + word(acct.address) + word(amount), gasLimit: 120000n });
      await ux.waitReceipt(sent.txHash);
    }),
    shield: async (amount) => {
      const sent = await turn(() => ux.routerWrap({ walletPriv: key, amountWei: amount, ticker: 'TAC' }));
      let deposited = false;
      try {
        await ux.waitReceipt(sent.txHash);
        deposited = true;
        // when the relay is not sending settles it only proves, and this address sends the settle
        const state = await ux.relay.state().then((s) => (s && s.state) || null).catch(() => null);
        await ux.submitWrapSettle({ built: sent, depositTx: sent.txHash, ...(state != null && state !== 'ok' ? { selfSettle } : {}) });
      } catch (e) { if (deposited) e.deposited = sent.txHash; throw e; }
    },
    load: async () => { try { return JSON.parse(readF(stateFile, 'utf8')); } catch { return {}; } },
    save: async (s) => writeF(stateFile, JSON.stringify(s)),
    config: { lowWater: wei(rc.lowWaterTac ?? 3000), chunk: wei(rc.chunkTac ?? 5000), minShield: wei(rc.minShieldTac ?? 100), maxPerDay: wei(rc.maxPerDayTac ?? 20000), minIntervalSecs: rc.minIntervalSecs ?? 1800, afterShieldSecs: rc.afterShieldSecs ?? 60 },
    log, alert, address: acct.address,
  });
  log({ level: 'info', msg: 'refill is on: TAC sent to the provider\'s address is shielded and lent', address: acct.address, treasury, lowWaterTac: rc.lowWaterTac ?? 3000, chunkTac: rc.chunkTac ?? 5000, maxPerDayTac: rc.maxPerDayTac ?? 20000 });
  setInterval(() => { refill.step().catch(() => {}); }, (rc.everySecs ?? 60) * 1000).unref();
  // The first wrap of a key reads the asset's Wrap logs to find its next unused index (minutes), and keeps the answer in the wallet cache on the data disk.
  // Reading them a little after start, while nothing is being shielded, leaves the first real shield only the newest blocks. It reserves no index.
  setTimeout(() => { ux.warmWrapLogs({ ticker: 'TAC' }).catch(() => {}); }, (rc.warmSecs ?? 45) * 1000).unref();
}
// The reverse side (Ethereum -> Bitcoin), off unless FB_LP_REVERSE=on (lib/reverse.mjs, README "Selling the other way"). It sells TAC held at a Bitcoin address
// of its own, derived from this key: nothing else of this process, or of anyone who lists from the main address, shares its notes or its coins. The pool side
// is this provider's own, so what users send for it lands where the forward side lends from.
let handle = service.handle;
const { reverseOptions } = await import('./lib/reverse.mjs');
const ropts = PAIR ? pairLib.pairReverseOptions(C, { rate: () => quoteRate() }, flat ? () => flat.rev() : null) : reverseOptions(C);
let rside = null;
if (ropts && DRY) log({ level: 'info', msg: 'dry run: the reverse side is not started' });
else if (ropts) {
  const { reverseKeyOf, reverseSeedOf, makeReverseInventory, routed } = await import('./lib/reverse.mjs');
  const { makeReverseService } = await import('../dapp/fastbridge-reverse-provider.js');
  const rkey = reverseKeyOf(key);
  const { prims: rprims } = makeBtcWallet({ priv: rkey, hrp: network === 'mainnet' ? 'bc' : 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
  if (rprims.wallet.address() === btc.address) { console.error('the reverse address must not be the provider\'s own address'); process.exit(1); }
  const rbtc = makeNodeBtcChain({
    bases: C.btcBases, tacit, prims: rprims, builder: makeAdaptorBtcTx({ prims: rprims, kit: tacitKit(tacit) }), pool: ux.pool, ethGetStorageAt: (to, slot, tag) => ux.rpc('eth_getStorageAt', [to, slot, tag]),
    poolAddress: C.poolAddress, binding: ux.chainBindingHex(), keccak256: keccak_256, secp, log, ...btcFees,
  });
  // the notes are read by the module's scan of the reverse key. The singleton wallet is switched only inside walletTurn,
  // because the stuck-note recycler uses the same module with the main key below.
  const { makeTacitWalletSwitch, makeStuckRecycler } = await import('./lib/stuck-recycle.mjs');
  const walletTurn = makeSerial();
  const withTacitWallet = makeTacitWalletSwitch({ tacit, lock: walletTurn });
  const baseInventory = PAIR ? null : makeReverseInventory({ tacit, asset: C.btcAsset, log });
  const reverseInventory = PAIR ? pairLib.satsInventory(rbtc) : { notes: () => withTacitWallet(rkey, rprims.wallet.pub, () => baseInventory.notes()) };
  const rswaps = makeFileStore(resolve(data, 'reverse/swaps')), rquotes = withMkt(makeFileStore(resolve(data, 'reverse/quotes')));
  const reverse = makeReverseService({
    seed: reverseSeedOf(key), btc: rbtc, evm, inventory: reverseInventory, config: ropts, log, alert,
    swaps: rswaps, quotes: rquotes, offers: makeFileStore(resolve(data, 'reverse/offers')), evmOffers: makeFileStore(resolve(data, 'reverse/evm-offers')),
  });
  rside = { btc: rbtc, prims: rprims, swaps: rswaps, quotes: rquotes };
  await reverse.start();
  let rbusy = false;
  setInterval(async () => { if (rbusy) return; rbusy = true; try { await reverse.tick(); } catch (e) { log({ level: 'error', msg: 'reverse tick failed', error: String((e && e.message) || e).slice(0, 200) }); } finally { rbusy = false; } }, (C.tickSecs ?? 15) * 1000);
  handle = routed(service.handle, reverse.handle);
  log({ level: 'info', msg: 'the reverse side is on: the TAC and the sats at this Bitcoin address are what it sells and what it pays fees from', reverseAddress: rbtc.address, maxOpen: ropts.maxOpen, maxTac: String(ropts.maxLocked), csvBlocks: ropts.csvBlocks, feeBps: ropts.quote.feeBps });

  if (!PAIR) {
    const srEnv = String(process.env.FB_LP_STUCK_RECYCLE || '').trim().toLowerCase();
    if (srEnv && !['on', 'off'].includes(srEnv)) { console.error('FB_LP_STUCK_RECYCLE must be on or off'); process.exit(1); }
    const srCfg = C.stuckRecycle && typeof C.stuckRecycle === 'object' ? C.stuckRecycle : {};
    const srOn = srEnv ? srEnv === 'on' : (C.stuckRecycle !== false && srCfg.enabled !== false);
    if (srOn) {
      const recycler = makeStuckRecycler({
        tacit, withWallet: withTacitWallet, mainPriv: key, mainPub: prims.wallet.pub, reversePubHex: Buffer.from(rprims.wallet.pub).toString('hex'), assetIdHex: C.btcAsset,
        swaps: swapStore, reverseSwaps: rswaps, store: makeFileStore(resolve(data, 'stuck-recycle')), btc, maxPerTick: srCfg.maxPerTick ?? 1, log, alert,
      });
      let sbuzy = false;
      setInterval(async () => { if (sbuzy) return; sbuzy = true; try { await recycler.tick(); } catch (e) { log({ level: 'error', msg: 'stuck recycle tick failed', error: String((e && e.message) || e).slice(0, 200) }); } finally { sbuzy = false; } }, (srCfg.tickSecs ?? 120) * 1000).unref();
      const inner = handle;
      handle = async (req) => {
        const r = await inner(req);
        return req && req.method === 'GET' && req.path === '/info' && r && r.status === 200 && r.body && typeof r.body === 'object'
          ? { ...r, body: { ...r.body, stuckRecycle: await recycler.info().catch(() => ({ enabled: true })) } } : r;
      };
      log({ level: 'info', msg: 'stuck TAC recycling is on: completed long and pool-exit takes are moved to the reverse address', maxPerTick: srCfg.maxPerTick ?? 1, everySecs: srCfg.tickSecs ?? 120 });
    }
  }
}
if (PAIR && !DRY) {
  const { wireAutomation } = await import('./lib/automation-wire.mjs');
  const auto = await wireAutomation({ C, key, prims, btc, tacit, ux, evm, service, swapStore, quoteStore, rside, rateFeed, poolTurn, turn, data, keccak256: keccak_256, log, alert, setLean: (b) => { leanBps = b; } });
  if (auto) handle = auto.wrap(handle);
}
// /info says what the flat fees follow
if (flat) { const inner = handle; handle = async (req) => { const r = await inner(req); return req && req.method === 'GET' && req.path === '/info' && r && r.status === 200 && r.body && typeof r.body === 'object' ? { ...r, body: { ...r.body, feeModel: flat.view() } } : r; }; }
const server = makeHttpServer({ handle, origins: C.origins || [], trustProxy: !!C.trustProxy, clientIp: C.clientIp || null });
server.listen(C.port ?? 8787, () => log({ level: 'info', msg: 'listening', port: C.port ?? 8787 }));

// Boards the LP is on as well: its ad is posted there and the requests left for it are answered, so a user finds it without its URL.
if (C.boards && C.boards.length) {
  if (DRY) log({ level: 'info', msg: 'dry run: no board is joined' });
  else {
    const { makeBoardClient } = await import('../dapp/fastbridge-board-client.js');
    const { gatewayOf, makeMailboxServer, makeAdPublisher } = await import('../dapp/fastbridge-mailbox.js');
    const { signSchnorr } = await import('../dapp/bulletproofs.js');
    const keys = gatewayOf(key);
    for (const url of C.boards) {
      const board = makeBoardClient({ base: url });
      makeMailboxServer({ board, keys, handle, signReply: (d) => signSchnorr(d, key), pollMs: (C.mailboxPollSecs ?? 3) * 1000, log }).start();
      makeAdPublisher({ board, handle, claimPriv: key, claimPub: config.claimPub, keys, name: C.name || null, everySecs: 60, log }).start();
      log({ level: 'info', msg: 'on the board', board: url, gateway: Buffer.from(keys.pub).toString('hex') });
    }
    // bridges waiting for a provider: alerted when a new one appears, so the operator can raise what it takes (or lower its fee, for one that names a price)
    const { checkWant } = await import('../dapp/fastbridge-board.js');
    const { waitingFields } = await import('./lib/wants.mjs');
    const seen = new Set();
    const lookWants = async () => {
      const now = Math.floor(Date.now() / 1000), fresh = [];
      for (const url of C.boards) {
        try {
          for (const w of await makeBoardClient({ base: url }).wants()) {
            try { checkWant(w, now); } catch { continue; }
            if (w.btcAsset.replace(/^0x/, '').toLowerCase() === String(C.btcAsset).toLowerCase() && BigInt(w.amount) > 0n && !seen.has(w.pub)) { seen.add(w.pub); fresh.push({ amount: w.amount, maxFeeBps: w.maxFeeBps == null ? null : w.maxFeeBps }); }
          }
        } catch { /* a board that keeps no wants */ }
      }
      if (fresh.length) alert({ level: 'warn', msg: 'bridges are waiting for a provider', ...waitingFields(fresh, C.quote) });
    };
    lookWants(); setInterval(lookWants, 300000).unref();
  }
}
