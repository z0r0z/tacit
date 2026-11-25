// The world of the split tests (tests/fastbridge-pair-split.test.mjs): the simulated Bitcoin and pool of tests/lib/chain-sim.mjs on one virtual clock, SEVERAL providers that
// sell pool ETH for sats (each its own keys, wallet, pool notes and service, priced from one live rate feed), and a user's pair client over them. The sim's pool asset stands
// in for ETH. A test names the providers' terms and, per provider, what it does (`w.ctl[name]`): `down` (unreachable), `refuseReserve` (cannot hold its quote), `stallOffers`
// (answers quotes and holds but not the extension or the offer). Needs Node 22.
import { makeBtcWallet } from '../../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx } from '../../dapp/adaptor-btc-tx.js';
import { makeLpService } from '../../dapp/fastbridge-provider.js';
import { makeCounter } from '../../dapp/fastbridge-http.js';
import { termsOf } from '../../dapp/fastbridge-client.js';
import { makePairClient, SATS_ASSET } from '../../dapp/fastbridge-pair.js';
import { makeRateFeed } from '../../dapp/fastbridge-rate.js';
import { bigintToBytes32 } from '../../dapp/bulletproofs.js';
import { bytesToHex } from '../../dapp/vendor/tacit-deps.min.js';
import { te, scalar } from './btc-sim.mjs';
import { makeClock, makeBitcoinSim, makeEvmSim, makeEvmParty, partyKeys, pool, sha256, ASSET } from './chain-sim.mjs';
import { memStore } from './fastbridge-world.mjs';

export const SATS = 100_000n;
const DEFAULT = [
  { name: 'Alpha', feeBps: 30, flatFee: 500, minAmount: 20_000, maxAmount: 150_000 },
  { name: 'Bravo', feeBps: 30, flatFee: 500, minAmount: 20_000, maxAmount: 150_000 },
  { name: 'Charlie', feeBps: 30, flatFee: 500, minAmount: 20_000, maxAmount: 150_000 },
];

export function multiWorld({ providers = DEFAULT, market = 35.6, confs = 1, userSats = [1_000_000], policy = {}, fwdPolicy = {} } = {}) {
  const clock = makeClock(), btc = makeBitcoinSim(clock), evm = makeEvmSim(clock);
  const wallet = (name) => makeBtcWallet({ priv: bigintToBytes32(scalar(name + '/btc-wallet')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 });
  const uW = wallet('user'), uKeys = partyKeys('user'), uEvm = makeEvmParty({ evm, keys: uKeys, clock });
  const coinsOf = (tag, values) => values.map((v, i) => ({ txid: bytesToHex(sha256(te(`${tag}/${i}`))), vout: 0, value: v }));
  const uCoins = coinsOf('user', userSats);
  const unspent = (cs) => () => cs.filter((c) => !btc.spends.has(`${c.txid}:${c.vout}`));
  const uBtc = btc.adapter({ prims: uW.prims, builder: makeAdaptorBtcTx({ prims: uW.prims }), sats: unspent(uCoins) });
  const base = { now: evm.now, lockPosition: evm.lockPosition, jobStatus: evm.jobStatus, submit: evm.submit, lockSpent: evm.lockSpentFn, findClaim: evm.findClaim, lockNullifier: pool.nullifier };
  const uEvmCtx = { ...base, recipient: uEvm.recipient, claimOp: uEvm.claimOp, claimStatus: evm.jobStatus, lockOp: uEvm.lockOp, refundOp: uEvm.refundOp, refundKey: uEvm.refundKey, available: uEvm.available, findOwnLocks: uEvm.findOwnLocks };
  const mk = { value: market };
  const feedOf = () => makeRateFeed({ sources: [async () => mk.value, async () => mk.value], now: clock.now, maxAgeSecs: 3600 });
  const providerFeed = feedOf(), clientFeed = feedOf();

  const w = { clock, btc, evm, uW, uKeys, uEvm, uBtc, uCoins, mk, ctl: {}, p: {}, mems: new Map(), calls: [], providerFeed, clientFeed };
  for (const spec of providers) {
    const lW = wallet('lp-' + spec.name), lKeys = partyKeys('lp-' + spec.name), lEvm = makeEvmParty({ evm, keys: lKeys, clock });
    const lBtc = btc.adapter({ prims: lW.prims, builder: makeAdaptorBtcTx({ prims: lW.prims }), sats: unspent([]) });
    lBtc.resolveNote = async () => { throw new Error('a lock of sats has no note'); }; lBtc.crossLaneBlocked = async () => { throw new Error('a lock of sats has no note'); };
    const lEvmCtx = { ...base, lockOp: lEvm.lockOp, refundOp: lEvm.refundOp, refundKey: lEvm.refundKey, available: lEvm.available };
    const store = memStore();
    const svc = makeLpService({
      seed: lKeys.seed, btc: lBtc, evm: lEvmCtx, swaps: store, quoteStore: memStore(), now: clock.now,
      config: {
        claimPub: bytesToHex(lW.wallet.pub), csvBlocks: spec.csvBlocks ?? 144,
        quote: { btcAsset: SATS_ASSET, evmAsset: ASSET, minAmount: spec.minAmount, maxAmount: spec.maxAmount, feeBps: spec.feeBps, flatFee: spec.flatFee, validSecs: 600, rate: () => providerFeed.rate() },
        policy: { minCsv: 72, minConfsFor: spec.minConfsFor || (() => confs), evmWindowSecs: 4 * 3600, minClaimSecs: 3600, claimSlackSecs: 7200, roundSecs: 600, refundMarginSecs: 600, maxOfferAgeSecs: 3600, minAmount: spec.minAmount, maxAmount: spec.maxAmount, ...fwdPolicy },
      },
    });
    const claimPub = bytesToHex(lW.wallet.pub);
    w.p[spec.name] = { name: spec.name, svc, lEvm, lBtc, store, claimPub, ref: { kind: 'http', base: 'http://' + spec.name, claimPub } };
    w.ctl[spec.name] = { down: false, refuseReserve: false, stallOffers: false };
    // an old provider: its quote does not say it answers a lock at any output
    if (spec.old) { const was = svc.handle; svc.handle = async (a) => { const r = await was(a); if (a.path === '/quote' && r.body) delete r.body.legVouts; return r; }; }
  }
  const byRef = (ref) => Object.values(w.p).find((p) => p.claimPub === ref.claimPub);
  w.discover = async () => {
    const out = [];
    for (const p of Object.values(w.p)) {
      const f = await p.svc.handle({ method: 'GET', path: '/info' });
      out.push({ id: p.claimPub, name: p.name, ref: p.ref, http: true, assets: { btcAsset: f.body.btcAsset, evmAsset: f.body.evmAsset }, terms: termsOf(f.body) });
    }
    return out;
  };
  const memNamed = (n) => { if (!w.mems.has(n)) w.mems.set(n, memStore()); return w.mems.get(n); };
  w.makePair = (over = {}) => makePairClient({
    btc: uBtc, evm: uEvmCtx, seed: uKeys.seed, now: clock.now, ethAsset: ASSET, feed: clientFeed, discover: w.discover, policy,
    counterFor: (ref) => makeCounter(async (method, path, body) => {
      const p = byRef(ref), c = w.ctl[p.name];
      w.calls.push({ name: p.name, method, path, body });
      if (c.down || (c.stallOffers && /^\/(offer|extend)/.test(path))) throw new Error('the provider is unreachable');
      if (c.refuseReserve && path === '/reserve') return { status: 200, body: { ok: false, why: 'no room' } };
      const r = await p.svc.handle({ method, path, body });
      return { status: r.status, body: r.body };
    }),
    reverseCallFor: () => async () => { throw new Error('not used'); },
    stores: { fwd: memNamed('fwd'), index: memNamed('index'), swaps: (id) => memNamed('swaps:' + id), quotes: (id) => memNamed('quotes:' + id) }, ...over,
  });
  w.pair = w.makePair();
  let ticks = 0;
  w.step = async () => {
    await providerFeed.refresh().catch(() => {}); await clientFeed.refresh().catch(() => {});
    for (const p of Object.values(w.p)) if (!w.ctl[p.name].down) await p.svc.tick();
    await w.pair.pump(); evm.process();
  };
  w.run = async (until, max = 3000) => {
    for (let i = 0; i < max; i++) {
      if (await until()) return i;
      await w.step();
      clock.advance(60); ticks++;
      if (ticks % 10 === 0) btc.mine(1, { advance: false });
    }
    throw new Error('did not finish: ' + JSON.stringify((await w.pair.records()).map((r) => [r.id.slice(0, 14), r.state, r.title])));
  };
  w.ready = async () => { await providerFeed.refresh(); await clientFeed.refresh(); };
  // a pool note of exactly what the provider pays for `sats`, which is what its lock is made from
  w.fund = (name, sats, tag = 'inv') => { const p = w.p[name]; p.lEvm.fund(p.svc.quoter.price(sats).evmAmount, `${tag}-${sats}-${Math.random()}`); };
  w.fundAll = (shares) => { for (const [name, sats] of Object.entries(shares)) w.fund(name, BigInt(sats)); };
  return w;
}
