// The world of the pair tests (tests/fastbridge-pair.test.mjs, tests/swap-atomic-engine.test.mjs): the simulated Bitcoin and pool of tests/lib/chain-sim.mjs on one virtual
// clock, a provider that sells pool ETH for sats and one that sells sats for pool ETH (both priced from a live rate feed), a user's pair client over them, and what is needed to run
// swaps to their end. The sim's pool asset stands in for ETH. Needs Node 22.
import assert from 'node:assert/strict';
import { makeBtcWallet } from '../../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx } from '../../dapp/adaptor-btc-tx.js';
import { makeLpService } from '../../dapp/fastbridge-provider.js';
import { makeReverseService } from '../../dapp/fastbridge-reverse-provider.js';
import { makeCounter } from '../../dapp/fastbridge-http.js';
import { termsOf } from '../../dapp/fastbridge-client.js';
import { makePairClient, SATS_ASSET, rateOf, describeFwd } from '../../dapp/fastbridge-pair.js';
import { makeRateFeed } from '../../dapp/fastbridge-rate.js';
import * as X from '../../dapp/adaptor-xswap.js';
import { bigintToBytes32 } from '../../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes } from '../../dapp/vendor/tacit-deps.min.js';
import { te, scalar, fetched } from './btc-sim.mjs';
import { makeClock, makeBitcoinSim, makeEvmSim, makeEvmParty, partyKeys, pool, sha256, ASSET } from './chain-sim.mjs';
import { memStore } from './fastbridge-world.mjs';

export const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
export const SATS = 100_000n;
export const UNITS = 3_600_000n;                                         // 0.036 ETH in pool units

// `fwdQuote`, `revConfig`: what a test sets over the forward provider's quote terms and the reverse provider's config (`userSats`: the user's one coin, or a list of coins)
export function pairWorld({ providerMarket = 35.6, clientMarket = 35.6, confs = 1, userSats = 200_000, fwdQuote = {}, fwdPolicy = {}, fwdQuoteStore = null, revConfig = {}, revCoins = [2_000_000] } = {}) {
  const clock = makeClock(), btc = makeBitcoinSim(clock), evm = makeEvmSim(clock);
  const wallet = (name) => makeBtcWallet({ priv: bigintToBytes32(scalar(name + '/btc-wallet')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 });
  const uW = wallet('user'), lW = wallet('lp'), rW = wallet('lp-reverse');
  const uKeys = partyKeys('user'), lKeys = partyKeys('lp');
  const uEvm = makeEvmParty({ evm, keys: uKeys, clock }), lEvm = makeEvmParty({ evm, keys: lKeys, clock });
  // stable coins, gone from the lists once a transaction spends them
  const coinsOf = (tag, values) => values.map((v, i) => ({ txid: bytesToHex(sha256(te(`${tag}/${i}`))), vout: 0, value: v }));
  const uCoins = coinsOf('user', Array.isArray(userSats) ? userSats : userSats ? [userSats] : []), rCoins = coinsOf('reverse', revCoins);
  const unspent = (cs) => () => cs.filter((c) => !btc.spends.has(`${c.txid}:${c.vout}`));
  const uBtc = btc.adapter({ prims: uW.prims, builder: makeAdaptorBtcTx({ prims: uW.prims }), sats: unspent(uCoins) });
  const lBtc = btc.adapter({ prims: lW.prims, builder: makeAdaptorBtcTx({ prims: lW.prims }), sats: unspent([]) });
  const rBtc = btc.adapter({ prims: rW.prims, builder: makeAdaptorBtcTx({ prims: rW.prims }), sats: unspent(rCoins) });
  for (const a of [lBtc, rBtc]) { a.resolveNote = async () => { throw new Error('a lock of sats has no note'); }; a.crossLaneBlocked = async () => { throw new Error('a lock of sats has no note'); }; }

  const base = { now: evm.now, lockPosition: evm.lockPosition, jobStatus: evm.jobStatus, submit: evm.submit, lockSpent: evm.lockSpentFn, findClaim: evm.findClaim, lockNullifier: pool.nullifier };
  const lEvmCtx = { ...base, lockOp: lEvm.lockOp, refundOp: lEvm.refundOp, refundKey: lEvm.refundKey, available: lEvm.available };
  const rBlEvm = { now: evm.now, lockPosition: evm.lockPosition, recipient: lEvm.recipient, claimOp: lEvm.claimOp, submit: evm.submit, claimStatus: evm.jobStatus };
  const uEvmCtx = { ...base, recipient: uEvm.recipient, claimOp: uEvm.claimOp, claimStatus: evm.jobStatus, lockOp: uEvm.lockOp, refundOp: uEvm.refundOp, refundKey: uEvm.refundKey, available: uEvm.available, findOwnLocks: uEvm.findOwnLocks };

  // the market, as the provider reads it and as the user's page does
  const market = { provider: providerMarket, client: clientMarket, providerDown: false };
  const feedOf = (read) => makeRateFeed({ sources: [async () => read(), async () => read()], now: clock.now, maxAgeSecs: 3600 });
  const providerFeed = feedOf(() => { if (market.providerDown) throw new Error('down'); return market.provider; }), clientFeed = feedOf(() => market.client);

  const w = { uEvmCtx, lEvmCtx, lBtc, clock, btc, evm, uW, lW, rW, uKeys, lKeys, uEvm, lEvm, uBtc, rBtc, uCoins, rCoins, market, providerFeed, clientFeed, up: { lp: true, offers: true }, stores: { lp: memStore(), rv: { swaps: memStore(), quotes: memStore(), offers: memStore(), evmOffers: memStore() } } };
  w.fwd = makeLpService({
    seed: lKeys.seed, btc: lBtc, evm: lEvmCtx, swaps: w.stores.lp, quoteStore: fwdQuoteStore || memStore(), now: clock.now,
    config: {
      claimPub: bytesToHex(lW.wallet.pub), csvBlocks: 144,
      quote: { btcAsset: SATS_ASSET, evmAsset: ASSET, minAmount: 20_000, maxAmount: 10_000_000, feeBps: 30, flatFee: 500, validSecs: 600, rate: () => providerFeed.rate(), ...fwdQuote },
      policy: { minCsv: 72, minConfsFor: () => confs, evmWindowSecs: 4 * 3600, minClaimSecs: 3600, claimSlackSecs: 7200, roundSecs: 600, refundMarginSecs: 600, maxOfferAgeSecs: 3600, minAmount: 20_000, maxAmount: 10_000_000, ...fwdPolicy },
    },
  });
  w.rev = makeReverseService({
    seed: lKeys.seed, btc: rBtc, evm: rBlEvm, ...w.stores.rv, now: clock.now,
    inventory: { notes: async () => unspent(rCoins)().map((c) => ({ ...c, amount: BigInt(c.value) })) },
    config: { quote: { btcAsset: SATS_ASSET, evmAsset: ASSET, minAmount: 1_000_000n, maxAmount: 50_000_000n, feeBps: 30, flatFee: 10_000n, validSecs: 600, rate: () => providerFeed.rate() }, csvBlocks: 96, evmWindowSecs: 4 * 3600, maxOpen: 2, minConfsFor: () => confs, refreshSecs: 0, ...revConfig },
  });
  w.provider = { id: 'lp1', name: 'Test provider', ref: { kind: 'http', base: 'http://lp', claimPub: bytesToHex(lW.wallet.pub) } };
  w.discover = async () => {
    const [f, r] = [await w.fwd.handle({ method: 'GET', path: '/info' }), await w.rev.handle({ method: 'GET', path: '/reverse/info' })];
    return [{ ...w.provider, assets: { btcAsset: f.body.btcAsset, evmAsset: f.body.evmAsset }, terms: termsOf(f.body), reverse: { feeBps: r.body.feeBps, flatFee: BigInt(r.body.flatFee), minAmount: BigInt(r.body.minAmount), maxAmount: BigInt(r.body.maxAmount), available: r.body.available == null ? null : BigInt(r.body.available) } }];
  };
  const mems = new Map();
  w.mems = mems;
  const memNamed = (n) => { if (!mems.has(n)) mems.set(n, memStore()); return mems.get(n); };
  w.makePair = (over = {}) => makePairClient({
    btc: uBtc, evm: uEvmCtx, seed: uKeys.seed, now: clock.now, ethAsset: ASSET, feed: clientFeed, discover: w.discover,
    counterFor: () => makeCounter(async (method, path, body) => { if (!w.up.lp || (!w.up.offers && /^\/(offer|extend)/.test(path))) throw new Error('the provider is unreachable'); const r = await w.fwd.handle({ method, path, body }); return { status: r.status, body: r.body }; }),
    reverseCallFor: () => async (method, path, body) => { if (!w.up.lp) throw new Error('the provider is unreachable'); const r = await w.rev.handle({ method, path, body }); return { status: r.status, body: r.body }; },
    stores: { fwd: memNamed('fwd'), index: memNamed('index'), swaps: (id) => memNamed('swaps:' + id), quotes: (id) => memNamed('quotes:' + id) }, ...over,
  });
  w.pair = w.makePair();
  let ticks = 0;
  w.step = async () => {
    await providerFeed.refresh().catch(() => {}); await clientFeed.refresh().catch(() => {});
    if (w.up.lp) { await w.fwd.tick(); await w.rev.tick(); }
    await w.pair.pump(); evm.process();
  };
  w.run = async (until, max = 2000) => {
    for (let i = 0; i < max; i++) {
      if (await until()) return i;
      await w.step();
      clock.advance(60); ticks++;
      if (ticks % 10 === 0) btc.mine(1, { advance: false });
    }
    throw new Error('did not finish: ' + JSON.stringify((await w.pair.records()).map((r) => [r.dir, r.state, r.title])));
  };
  w.first = async () => (await w.pair.records())[0];
  // the market has to be read before the provider can quote, and the pool note has to be there for the payout
  w.ready = async () => { await providerFeed.refresh(); await clientFeed.refresh(); };
  return w;
}

