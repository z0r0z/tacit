// A world for the fast bridge machines: a simulated Bitcoin and pool on one virtual clock, a user and an LP with their
// wallets, a quote, the transport between them, and both machines over durable-looking stores (every record goes
// through JSON). Used by the machine tests and the LP service tests. Needs Node 22.

import { makeBtcWallet } from '../../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx, tacitKit } from '../../dapp/adaptor-btc-tx.js';
import { makeBitcoinLocker } from '../../dapp/fastbridge-bl.js';
import { makeEthereumLocker } from '../../dapp/fastbridge-el.js';
import { bigintToBytes32 } from '../../dapp/bulletproofs.js';
import { bytesToHex } from '../../dapp/vendor/tacit-deps.min.js';
import { tacit, te, scalar, etchNote } from './btc-sim.mjs';
import { makeClock, makeBitcoinSim, makeEvmSim, makeEvmParty, partyKeys, pool, sha256, ASSET } from './chain-sim.mjs';

export const VALUE = 5000n;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
export const memStore = () => {
  const m = new Map();
  return { m, get: async (id) => (m.has(id) ? JSON.parse(m.get(id)) : null), put: async (r) => { m.set(r.id, JSON.stringify(r)); }, list: async () => [...m.values()].map((v) => JSON.parse(v)) };
};

export function world({ lpConfs = 1, lp: lpPolicyOver = {}, user: userPolicyOver = {}, funds = 1, lpNowSkew = 0, userCounter = null } = {}) {
  const clock = makeClock();
  const btc = makeBitcoinSim(clock), evm = makeEvmSim(clock);
  const kit = tacitKit(tacit);
  const wallet = (name) => makeBtcWallet({ priv: bigintToBytes32(scalar(name + '/btc-wallet')), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 });
  const uW = wallet('user'), lW = wallet('lp');
  const uKeys = partyKeys('user'), lKeys = partyKeys('lp');
  const uEvm = makeEvmParty({ evm, keys: uKeys, clock }), lEvm = makeEvmParty({ evm, keys: lKeys, clock });
  for (let i = 0; i < funds; i++) lEvm.fund(VALUE, 'inv' + i);

  // the user's Bitcoin note
  const r0 = scalar('user/note');
  const etch = etchNote({ ticker: 'TP', value: VALUE, r: r0, script: uW.prims.p2wpkhScript(uW.wallet.pub), signerD: scalar('etcher') });
  btc.addConfirmed(etch);
  const note = { txid: etch.txid, vout: 0, value: 546, amount: VALUE, blinding: r0 };
  let coinN = 0;
  const sats = () => [{ txid: bytesToHex(sha256(te('coin/' + coinN++))), vout: 0, value: 200_000 }];

  const uBtc = btc.adapter({ prims: uW.prims, builder: makeAdaptorBtcTx({ prims: uW.prims, kit }), sats });
  const lBtc = btc.adapter({ prims: lW.prims, builder: makeAdaptorBtcTx({ prims: lW.prims, kit }), sats });
  const base = { now: evm.now, lockPosition: evm.lockPosition, jobStatus: evm.jobStatus, submit: evm.submit, lockSpent: evm.lockSpentFn, findClaim: evm.findClaim, lockNullifier: pool.nullifier };
  const uEvmCtx = { now: evm.now, lockPosition: evm.lockPosition, recipient: uEvm.recipient, claimOp: uEvm.claimOp, submit: evm.submit, claimStatus: evm.jobStatus };
  const lEvmCtx = { ...base, now: async () => clock.now() + lpNowSkew, lockOp: lEvm.lockOp, refundOp: lEvm.refundOp, refundKey: lEvm.refundKey };

  const quotes = new Map();
  const quote = { id: 'q1', btcAsset: bytesToHex(etch.asset), btcValue: VALUE, evmAsset: ASSET, evmAmount: VALUE, validUntil: clock.now() + 3600 };
  quotes.set(quote.id, quote);
  const lpOffers = new Map();
  const w = { clock, btc, evm, etch, note, quote, quotes, uW, lW, uKeys, lKeys, lBtc, lEvm, lEvmCtx, uEvmCtx, lpUp: true, lpOffers, userStore: memStore(), lpStore: memStore() };
  const toLp = { sendOffer: async (msg) => { if (!w.lpUp) throw new Error('the liquidity provider is unreachable'); return w.lp_.receive(msg); }, getEvmOffer: async (id) => lpOffers.get(id) || null };
  const toUser = { publishEvmOffer: async (id, o) => { lpOffers.set(id, o); } };
  const userPolicy = { csvBlocks: 144, minClaimSecs: 3600, offerWaitSecs: 2 * 3600, maxEvmWindowSecs: 6 * 3600, ...userPolicyOver };
  const lpPolicy = { minCsv: 72, minConfsFor: () => lpConfs, evmWindowSecs: 4 * 3600, minClaimSecs: 3600, claimSlackSecs: 7200, minAmount: 1000, maxAmount: 1_000_000, roundSecs: 600, ...lpPolicyOver };
  w.userBl = makeBitcoinLocker({ seed: uKeys.seed, now: clock.now, policy: userPolicy, store: w.userStore, btc: uBtc, evm: uEvmCtx, counter: userCounter ? userCounter(w) : toLp });
  w.makeLp = () => makeEthereumLocker({ seed: lKeys.seed, now: clock.now, policy: lpPolicy, store: w.lpStore, quotes: { get: async (id) => quotes.get(id) || null }, btc: lBtc, evm: lEvmCtx, counter: toUser });
  w.lp_ = w.makeLp();
  w.restartLp = () => { w.lp_ = w.makeLp(); };
  w.user = async () => (await w.userStore.list())[0];
  w.lp = async () => (await w.lpStore.list())[0];
  w.userOnline = true; w.lpOnline = true;
  w.start = () => w.userBl.start({ asset: etch.asset, amount: VALUE, notes: [note], counterClaimPub: lW.wallet.pub, evmAsset: ASSET, evmAmount: VALUE, quoteId: quote.id });
  // the LP's turn; a test that runs the LP as a service replaces it
  w.lpTick = async () => { for (const r of await w.lpStore.list()) await w.lp_.step(r); };
  w.step = async () => {
    if (w.userOnline) for (const r of await w.userStore.list()) await w.userBl.step(r);
    if (w.lpOnline) await w.lpTick();
    evm.process();
  };
  // one tick is a minute; a block is found every ten
  let ticks = 0;
  w.run = async (until, max = 2000) => {
    for (let i = 0; i < max; i++) {
      if (await until()) return i;
      await w.step();
      clock.advance(60); ticks++;
      if (ticks % 10 === 0) btc.mine(1, { advance: false });
    }
    throw new Error('did not finish: user ' + JSON.stringify(await w.user()).slice(0, 400) + ' lp ' + JSON.stringify(await w.lp()).slice(0, 400));
  };
  w.noteOf = async (txid, vout) => btc.resolveNote(txid, vout);
  w.poolHolds = (leaf) => evm.notes.leaves.some((l) => bytesToHex(l) === strip(leaf));
  return w;
}

