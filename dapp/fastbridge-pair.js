// Bitcoin for ETH and ETH for Bitcoin, the user's side, both directions behind one object: the swap tile's lane calls this and nothing else.
//
//   b2e   the user pays plain sats and takes private pool ETH. The user is the BITCOIN locker (dapp/fastbridge-bl.js): it holds t, locks sats first (one ordinary
//         transaction, dapp/adaptor-btc-tx.js lockSats), the provider locks pool ETH, the user claims it, the provider takes the sats.
//   e2b   the user pays private pool ETH and takes plain sats. The user is the ETHEREUM locker (dapp/fastbridge-el.js through dapp/fastbridge-reverse-client.js):
//         the provider locks sats first, the user locks pool ETH once that lock is confirmed, the provider claims it, the user takes the sats.
//
// Both sides are in 8-place units: satoshis, and pool ETH units (1 unit = 1e-8 ETH = 1e10 wei), so the price (ETH per BTC) is also the number of units a satoshi buys.
//
// What this adds to the TAC bridge's clients is the PRICE: the two sides are different assets, so a quote is judged against the market (dapp/fastbridge-rate.js)
// and not against the amount sent. A quote worse than `maxWorseBps` under the market is `blocked` (and one is blocked when the market cannot be read at all: a page that
// cannot tell cannot say a price is fair). Providers are found by their ads (an ad whose btcAsset is X.SATS_ASSET and evmAsset the pool's ETH).
//
//   const pair = makePairClient({ btc, evm, seed, stores, discover, counterFor, reverseCallFor, feed, policy, now, tend })
//   await pair.providers()  await pair.reference()  await pair.balances()  await pair.quote({ dir, amount })  await pair.start(q)  await pair.pump()  await pair.records()  await pair.recover()
//
//   btc, evm          the user's Bitcoin chain (dapp/fastbridge-btc.js; for e2b it also reads the provider's lock) and pool side (dapp/fastbridge-evm.js, asset ETH)
//   stores            { fwd, index, swaps(id), quotes(id) }: fwd holds the b2e swaps; index the providers an e2b swap was asked of ({ id, name, ref }); swaps(id) and quotes(id)
//                     are those providers' stores (each { get, put, list })
//   discover()        -> [{ id, name, ref, terms, reverse? }] as dapp/fast/discover.js gives them
//   counterFor(ref)   -> the b2e counter (dapp/fastbridge-http.js makeCounter over a transport)   reverseCallFor(ref) -> a (method, path, body) transport for e2b
//   feed              dapp/fastbridge-rate.js makeRateFeed: { refresh(), current() }
//   tend(work, passive)   runs `work` (a pass that steps the swaps) when this page is the one that tends the key's swaps (one tab at a time), else `passive` (the records only). Default: always work

import { makeBitcoinLocker } from './fastbridge-bl.js';
import { makeFastBridgeClient } from './fastbridge-client.js';
import { makeReverseClient, makeReverseCounter } from './fastbridge-reverse-client.js';
import { recordFromLockMemo } from './fastbridge-el.js';
import * as X from './adaptor-xswap.js';
import { bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';

export const SATS_ASSET = X.SATS_ASSET;
export const ETH_ASSET = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';

export const PAIR_POLICY = {
  csvBlocks: 144, minCsv: 72, maxCsv: 288, minClaimSecs: 3600, offerWaitSecs: 2 * 3600, maxEvmWindowSecs: 6 * 3600, quoteMarginSecs: 120,
  askMs: 12000, warnWorseBps: 100, maxWorseBps: 300, referenceFreshSecs: 120,
};
// The confirmations the user wants on a provider's lock of sats before it locks pool ETH against it: more for a larger amount
export const confsForSats = (value) => { const v = BigInt(value); return v >= 100_000_000n ? 6 : v >= 10_000_000n ? 3 : v >= 1_000_000n ? 2 : 1; };

const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const isHex = (h, n) => new RegExp(`^[0-9a-f]{${n}}$`).test(strip(h));
const big = (v, what) => { try { const b = BigInt(v); if (b < 0n) throw 0; return b; } catch { throw new Error(`the provider's ${what} is not a number`); } };
const FWD_DONE = new Set(['done', 'counter-took']);
const FWD_END = new Set(['done', 'refunded', 'counter-took']);
const REV_END = new Set(['done', 'refunded', 'aborted', 'lost']);

// ETH per BTC a quote gives, and how it compares with the market in basis points (negative = worse for the user): a user who pays BTC wants more ETH for it, a user
// who pays ETH wants it to cost less
export const rateOf = (evmAmount, btcValue) => Number(evmAmount) / Number(btcValue);
export const vsMarketBps = (dir, rate, market) => Math.round((dir === 'b2e' ? rate / market - 1 : market / rate - 1) * 10000);

// ── the words ──

const TAKE_VSIZE = 110;                                          // a key-path take of one Taproot lock to one P2WPKH output (99 vB measured, with room)

const STEP_TITLES = {
  b2e: ['Lock your BTC', 'Provider locks ETH', 'You claim the ETH', 'Provider takes BTC'],
  e2b: ['Provider locks BTC', 'You lock your ETH', 'Provider claims ETH', 'You take your BTC'],
};
const KEYS = ['lock', 'match', 'claim', 'take'];
const stepsOf = (dir, at, state) => STEP_TITLES[dir].map((title, i) => ({
  key: KEYS[i], title, state: state === 'done' ? 'done' : state === 'returned' ? (i === 0 && dir === 'b2e' ? 'done' : 'todo') : i < at ? 'done' : i === at && state === 'working' ? 'active' : 'todo',
}));
const FWD_SAYS = {
  built: [0, 'Sending your BTC', 'The lock transaction is being sent.', 900],
  broadcast: [0, 'Waiting for Bitcoin', 'The lock needs a confirmation, about ten minutes.', 800],
  offered: [1, 'The provider is locking ETH for you', 'It locks the ETH in the pool against your lock, then you can claim it.', 300],
  claiming: [2, 'Claiming your ETH', 'Your claim is being settled in the pool.', 120],
  claimed: [3, 'Finishing', 'The ETH is yours in the pool. The provider takes the Bitcoin lock.', 0],
  done: [4, 'Done', 'The ETH is in your private balance.', 0],
  'counter-took': [4, 'Done', 'The ETH is in your private balance. The provider took the Bitcoin lock.', 0],
  'refund-wait': [0, 'Returning your BTC', 'The lock returns to your Bitcoin address when its timelock ends.', null],
  refunded: [4, 'Returned', 'Your BTC came back to your Bitcoin address.', 0],
};
const REV_SAYS = {
  accepted: [0, 'Waiting for the Bitcoin lock', 'The provider’s lock is on Bitcoin and needs its confirmations before your ETH is locked.', 900],
  locking: [1, 'Locking your ETH in the pool', 'Your private ETH is being locked in the pool for the provider.', 300],
  locked: [1, 'Telling the provider', 'Your ETH is locked. The provider is being told.', 240],
  offered: [2, 'Waiting for the provider to claim', 'The provider is claiming the ETH you locked. When it does, your BTC is yours to take.', 240],
  taking: [3, 'Taking your BTC', 'Your BTC is being taken from the lock.', 600],
  done: [4, 'Done', 'The BTC is at your Bitcoin address.', 0],
  refunding: [2, 'Taking your ETH back', 'The provider did not claim in time, so the ETH you locked is coming back to your private balance.', null],
  refunded: [4, 'Returned', 'Your ETH came back to your private balance.', 0],
  aborted: [0, 'Stopped', 'This swap was stopped before anything was lost.', null],
  lost: [0, 'Needs a look', 'The provider claimed with a signature that does not give your BTC. Do not close this page.', null],
};

export function describeFwd(rec, now = () => Math.floor(Date.now() / 1000)) {
  const [at, title, detail, eta] = FWD_SAYS[rec.phase] || [0, rec.phase, '', null];
  const state = FWD_DONE.has(rec.phase) ? 'done' : rec.phase === 'refunded' ? 'returned' : 'working';
  const lockAt = rec.lockAt || rec.confirmedAt || null;
  return {
    id: rec.id, dir: 'b2e', state, title, detail: rec.phase === 'refund-wait' && rec.why ? `${detail} ${String(rec.why).replace(/\.$/, '')}.` : detail,
    pay: BigInt(rec.amount), get: BigInt(rec.evmAmount || 0), steps: stepsOf('b2e', at, state), etaSecs: state === 'working' ? eta : 0, at: rec.created,
    refundAt: state === 'working' && lockAt ? lockAt + rec.csvBlocks * 600 : null, lockTxid: rec.lock ? rec.lock.txid : null, error: rec.lastError || null, provider: rec.providerName || null,
    // the ETH has to be claimed by the pool deadline of the provider's lock; missed, nothing is lost, and the BTC returns at refundAt
    backBy: state === 'working' && rec.evmOffer && Number(rec.evmOffer.deadline) > 0 ? Number(rec.evmOffer.deadline) : null,
  };
}
export function describeRev(rec) {
  const [at, title, detail, eta] = REV_SAYS[rec.phase] || [0, rec.phase, '', null];
  const state = rec.phase === 'done' ? 'done' : rec.phase === 'refunded' ? 'returned' : rec.phase === 'aborted' || rec.phase === 'lost' ? 'stopped' : 'working';
  return {
    id: rec.id, dir: 'e2b', state, title, detail: rec.phase === 'aborted' && rec.why ? `${detail} ${String(rec.why).replace(/\.$/, '')}.` : detail,
    pay: rec.offer ? BigInt(rec.offer.evm.amount) : 0n, get: rec.offer ? BigInt(rec.offer.btc.value) : 0n, steps: stepsOf('e2b', at, state), etaSecs: state === 'working' ? eta : 0, at: rec.created,
    // (once the provider has claimed, the ETH is not coming back: the BTC is taken instead, so no return time is given)
    refundAt: state === 'working' && rec.deadline && rec.phase !== 'taking' ? rec.deadline : null, lockTxid: rec.lockTxid || null, error: rec.lastError || null, provider: rec.providerName || null,
    // the page has to be back by the pool deadline: a claim by the provider then gives the BTC, which must be taken before the provider's own refund opens (at least
    // claimSlackSecs after the deadline, checked when the ETH is locked); with no claim, the ETH comes back after it
    backBy: state === 'working' && rec.deadline ? rec.deadline : null,
  };
}

// the e2b swaps found again from the key are kept as one provider's: they have none to ask, and need none (a recovered swap is past the point where the provider is told anything)
const RECOVERED = { id: 'recovered', name: 'Found from your key', ref: { kind: 'recovered' } };
const noCall = async () => { throw new Error('this swap was found again from the key: it has no provider to ask'); };
const noCounter = () => { const no = async () => { throw new Error('this swap was found again from the key: it has no provider to ask, and needs none to return'); }; return { sendOffer: no, getEvmOffer: no, extend: no, reserve: no, quote: no, info: no }; };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('the provider did not answer in time')), ms))]);

// `ethAsset` is the pool's asset for ETH (a test's pool has a stand-in)
export function makePairClient({ btc, evm, seed, stores, discover, counterFor, reverseCallFor, feed, policy: policyIn = {}, now = () => Math.floor(Date.now() / 1000), tend = (work) => work(), ethAsset = ETH_ASSET }) {
  const policy = { ...PAIR_POLICY, ...policyIn };
  const ETH = strip(ethAsset);
  const isPairProvider = (p) => !!p && !!p.assets && strip(p.assets.btcAsset || '') === SATS_ASSET && strip(p.assets.evmAsset || '') === ETH;
  const claimPubHex = () => bytesToHex(btc.wallet.pub);

  // ── what is going on in the market ──
  async function reference() {
    let c = feed.current();
    if (!c || now() - c.at > policy.referenceFreshSecs) { try { await feed.refresh(); } catch { /* read again next time */ } c = feed.current(); }
    return c ? { ethPerBtc: c.ethPerBtc, at: c.at, source: `${c.n} source${c.n === 1 ? '' : 's'}` } : null;
  }
  async function providers() {
    const all = (await discover()).filter(isPairProvider);
    return all.map((p) => ({
      id: p.id, name: p.name || 'Provider', ref: p.ref, dirs: ['b2e', ...(p.reverse ? ['e2b'] : [])],
      minSats: BigInt(p.terms.minAmount), maxSats: BigInt(p.terms.maxAmount), b2e: { min: BigInt(p.terms.minAmount), max: BigInt(p.terms.maxAmount), available: p.terms.available == null ? null : BigInt(p.terms.available) },
      e2b: p.reverse ? { min: BigInt(p.reverse.minAmount), max: BigInt(p.reverse.maxAmount), available: p.reverse.available == null ? null : BigInt(p.reverse.available) } : null,
    }));
  }
  // `sats` and `eth` are what can be put into a swap (confirmed coins; notes less the relay fee to cut one); `ethHeld` is what the key holds, `pendingSats` what has reached
  // the address and is waiting for a block
  async function balances() {
    const [coins, eth, ethHeld] = await Promise.all([
      (btc.satsCoins ? btc.satsCoins() : btc.satsUtxos().then((cs) => ({ coins: cs, pending: 0 }))).catch(() => null),
      evm.available ? Promise.resolve(evm.available()).then((v) => BigInt(v), () => null) : null,
      evm.heldFree ? Promise.resolve(evm.heldFree()).then((v) => BigInt(v), () => null) : null,
    ]);
    return { sats: coins ? coins.coins.reduce((s, c) => s + BigInt(c.value), 0n) : null, eth, ethHeld, pendingSats: coins ? BigInt(coins.pending || 0) : 0n };
  }

  // ── b2e: the user locks sats ──
  const fwdBl = new Map();
  const blFor = (ref) => {
    const k = ref ? JSON.stringify([ref.kind, ref.claimPub || '', ref.gateway || ref.base || '']) : 'none';
    if (!fwdBl.has(k)) fwdBl.set(k, makeBitcoinLocker({ seed, now, store: stores.fwd, btc, evm, policy, counter: ref ? counterFor(ref) : noCounter() }));
    return fwdBl.get(k);
  };
  const TERMINAL_COINS = new Set(['done', 'refunded', 'counter-took']);
  const heldCoins = async () => {
    const held = new Set();
    for (const r of await stores.fwd.list()) if (!TERMINAL_COINS.has(r.phase)) for (const i of r.feeInputs || []) held.add(`${i.txid}:${i.vout}`);
    return held;
  };

  async function quoteFwd(p, sats) {
    const counter = counterFor(p.ref);
    const r = await withTimeout(counter.quote(sats), policy.askMs);
    if (!r || typeof r.id !== 'string' || !isHex(r.claimPub || '', 66) || !isHex(r.btcAsset || '', 64) || !isHex(r.evmAsset || '', 64)) throw new Error('the provider\'s quote is not readable');
    if (strip(r.btcAsset) !== SATS_ASSET || strip(r.evmAsset) !== ETH) throw new Error('the provider\'s quote is not for Bitcoin and ETH');
    if (p.ref && p.ref.claimPub && strip(p.ref.claimPub) !== strip(r.claimPub)) throw new Error('the provider\'s key is not the one it advertised');
    const btcValue = big(r.btcValue, 'amount'), evmAmount = big(r.evmAmount, 'payout');
    if (btcValue !== sats) throw new Error('the quote is for a different amount');
    if (evmAmount <= 0n) throw new Error('the quote\'s payout is out of range');
    const csvBlocks = Number(r.csvBlocks);
    if (!Number.isInteger(csvBlocks) || csvBlocks < policy.minCsv || csvBlocks > policy.maxCsv) throw new Error('the quote\'s timelock is out of range');
    if (!(Number(r.validUntil) > now() + policy.quoteMarginSecs)) throw new Error('the quote expires too soon to use');
    if (Number(r.takeSats ?? 0) !== 0) throw new Error('the quote asks for a payment that a lock of bitcoin does not make');
    return { p, r: { ...r, claimPub: strip(r.claimPub), btcAsset: SATS_ASSET, evmAsset: ETH, btcValue, evmAmount, csvBlocks }, pay: btcValue, get: evmAmount };
  }
  // what the lock would cost on Bitcoin (nothing is stored or sent) and whether the address can pay it
  async function lockCost(q) {
    const bl = blFor(q.p.ref);
    policy.csvBlocks = q.r.csvBlocks;
    try {
      const { pair } = await bl.build({ asset: hexToBytes(SATS_ASSET), amount: q.r.btcValue, counterClaimPub: hexToBytes(q.r.claimPub), evmAsset: q.r.evmAsset, evmAmount: q.r.evmAmount, quoteId: q.r.id, avoid: await heldCoins() });
      return { fee: pair.revealFee, short: null };
    } catch (e) {
      const m = /not enough sats for the lock \(need (\d+), have (\d+)\)/.exec(String((e && e.message) || e));
      if (m) return { fee: null, short: { need: BigInt(m[1]), have: BigInt(m[2]) } };
      throw e;
    }
  }
  async function startFwd(q) {
    const r = q.ref.r, bl = blFor(q.ref.p.ref);
    const held = await counterFor(q.ref.p.ref).reserve({ quoteId: r.id });
    if (!held || held.ok === false) throw new Error(`the provider cannot hold that amount${held && held.why ? `: ${held.why}` : ''}`);
    policy.csvBlocks = r.csvBlocks;
    const rec = await bl.start({ asset: hexToBytes(SATS_ASSET), amount: r.btcValue, counterClaimPub: hexToBytes(r.claimPub), evmAsset: r.evmAsset, evmAmount: r.evmAmount, quoteId: r.id, avoid: await heldCoins() });
    rec.provider = q.ref.p.ref; rec.providerName = q.ref.p.name;
    await stores.fwd.put(rec);
    await bl.step(rec).catch(() => {});                 // the lock is stored: a send that fails is tried again by the next pass
    return { id: rec.id };
  }

  // ── e2b: the provider locks sats first ──
  const revClients = new Map();
  const revFor = (p) => {
    if (!revClients.has(p.id)) {
      revClients.set(p.id, makeReverseClient({
        lp: makeReverseCounter(p.ref && p.ref.kind === 'recovered' ? noCall : reverseCallFor(p.ref)), btc, evm, seed, now, store: stores.swaps(p.id), quoteStore: stores.quotes(p.id),
        pins: { btcAsset: SATS_ASSET, evmAsset: ETH }, confsOf: confsForSats,
        // the two sides are different units: the price is judged against the market (below), so here only that the payout is something and the fee is not the amount
        valueCheck: () => ({ fee: 0n, highFee: false }),
        admit: (o) => lockInUse(p.id, o),
      }));
    }
    return revClients.get(p.id);
  };
  // The e2b swaps are kept a store per provider, so what one Bitcoin lock already answers is looked up across all of them: a lock (or a swap id) that a swap of
  // any provider answers is not answered again, so one lock of sats never has two locks of ETH against it.
  async function lockInUse(pid, { id, offer }) {
    const txid = strip((offer && offer.btc && offer.btc.txid) || ''), vout = offer && offer.btc ? Number(offer.btc.vout) : -1;
    const ids = new Set([pid, RECOVERED.id, ...(await revProviders()).map((p) => p.id)]);
    for (const q of ids) {
      for (const r of await stores.swaps(q).list()) {
        if (r.id === id && q !== pid) return 'this swap is already answered for another provider';
        if (r.id !== id && strip(r.lockTxid || '') === txid && Number(r.lockVout) === vout) return 'this Bitcoin lock is already answered by another swap';
      }
    }
    return null;
  }
  async function quoteRev(p, units) {
    const q = await withTimeout(revFor(p).quote(units), policy.askMs);
    return { p, r: q, pay: q.evmAmount, get: q.btcValue };
  }

  // ── the quote the lane shows ──
  async function quote({ dir, amount }) {
    if (dir !== 'b2e' && dir !== 'e2b') throw new Error('the direction is not one this page makes');
    const want = BigInt(amount);
    if (want <= 0n) throw new Error('enter an amount');
    const market = await reference();
    const all = await providers();
    const eligible = all.filter((p) => (dir === 'b2e' ? p.b2e : p.e2b) && want >= (dir === 'b2e' ? p.b2e : p.e2b).min && want <= (dir === 'b2e' ? p.b2e : p.e2b).max);
    if (!all.length) throw new Error('no provider is offering Bitcoin for ETH right now');
    if (!eligible.length) throw new Error('no provider takes that amount');
    const got = await Promise.all(eligible.map(async (p) => { try { return await (dir === 'b2e' ? quoteFwd(p, want) : quoteRev(p, want)); } catch (error) { return { p, error }; } }));
    const good = got.filter((g) => !g.error).sort((a, b) => (a.get > b.get ? -1 : a.get < b.get ? 1 : 0));
    if (!good.length) throw new Error(String((got[0] && got[0].error && got[0].error.message) || 'no provider could quote that amount'));
    const best = good[0], rate = rateOf(dir === 'b2e' ? best.get : best.pay, dir === 'b2e' ? best.pay : best.get);
    const warnings = [];
    let blocked = null, versus = null;
    if (market) {
      versus = vsMarketBps(dir, rate, market.ethPerBtc);
      if (versus < -policy.maxWorseBps) blocked = `the provider quotes ${(-versus / 100).toFixed(1)}% under the market`;
      else if (versus < -policy.warnWorseBps) warnings.push(`this is ${(-versus / 100).toFixed(1)}% worse than the market price`);
    } else blocked = 'the market price could not be read, so this quote cannot be checked';
    // `short` is a Bitcoin address that cannot pay the amount and the fee of the lock: not a price that is wrong, so it is not `blocked` (the page offers to add sats), and `start` still refuses it
    let networkFeeSats = null, short = null;
    if (dir === 'b2e') {
      const c = await lockCost(best).catch(() => null);
      if (c && c.short) { short = c.short; networkFeeSats = Number(c.short.need - best.pay); }
      else if (c) networkFeeSats = c.fee;
    }
    // e2b: the user takes the sats from the provider's lock with a transaction that pays its own fee out of the lock (a rate above the estimate, as fastbridge-el.js sets it), so what
    // arrives is the lock less that fee
    let takeFeeSats = null;
    if (dir === 'e2b') {
      try {
        const feeFor = btc.prims && btc.prims.feeFor;
        if (typeof feeFor === 'function') takeFeeSats = Number(feeFor(TAKE_VSIZE, Math.ceil((await btc.feeRate()) * (policy.takeFeeFactor ?? 1.5))));
      } catch { takeFeeSats = null; }
    }
    return {
      dir, provider: { id: best.p.id, name: best.p.name }, pay: best.pay, get: best.get, takeFeeSats, rate, market: market ? market.ethPerBtc : null, vsMarketBps: versus,
      feeBps: versus == null ? 0 : Math.max(0, -versus), etaSecs: dir === 'b2e' ? 1500 : 1800, networkFeeSats, expiresAt: Number(best.r.validUntil), warnings, blocked, short, ref: best,
    };
  }

  async function start(q) {
    if (q.blocked) throw new Error(q.blocked);
    if (q.short) throw new Error(`your Bitcoin address holds ${q.short.have} sats and this needs ${q.short.need}, the amount and the network fee`);
    if (!(q.expiresAt > now() + policy.quoteMarginSecs)) throw new Error('the quote expired: ask again');
    if (q.dir === 'b2e') {
      const b = await balances();
      if (b.sats != null && b.sats < q.pay) throw new Error('your Bitcoin address does not hold that many sats');
      return startFwd(q);
    }
    // a note of exactly the amount is locked as it is: what `available` keeps back for a cut is not needed then (evm.covers)
    if (evm.covers) { if (!(await evm.covers(q.pay))) throw new Error('your private ETH does not cover that amount'); }
    else { const b = await balances(); if (b.eth != null && b.eth < q.pay) throw new Error('your private ETH does not cover that amount'); }
    const a = await revFor(q.ref.p).start({ quote: q.ref.r });
    const index = stores.index;
    if (!(await index.get(q.ref.p.id))) await index.put({ id: q.ref.p.id, name: q.ref.p.name, ref: q.ref.p.ref });
    return { id: a.swapId };
  }

  // ── the swaps ──
  const newest = (a, b) => (b.at || 0) - (a.at || 0);
  // a swap the user asked a provider to lock for, before it has locked: kept in the quote store only
  async function asked(p) {
    const out = [];
    const swaps = stores.swaps(p.id);
    for (const q of await stores.quotes(p.id).list()) {
      if (!q.swapId || (q.settled && !q.gaveUp) || (await swaps.get(q.swapId))) continue;
      if (q.gaveUp && now() - (q.startedAt || 0) > 7 * 86400) continue;
      out.push({
        id: q.swapId, dir: 'e2b', state: q.gaveUp ? 'stopped' : 'working', title: q.gaveUp ? 'Stopped' : 'Asking the provider',
        detail: q.gaveUp ? `${String(q.gaveUp).replace(/\.$/, '')}. Nothing of yours was locked.` : 'The provider is being asked to lock its Bitcoin. Your ETH is not locked until it has.',
        pay: BigInt(q.evmAmount ?? 0), get: BigInt(q.btcValue ?? 0), steps: stepsOf('e2b', 0, q.gaveUp ? 'returned' : 'working'), etaSecs: q.gaveUp ? 0 : 900, at: q.startedAt || 0, refundAt: null, lockTxid: null, error: null, provider: p.name,
      });
    }
    return out;
  }
  const revProviders = async () => (await stores.index.list()).filter((p) => p && typeof p.id === 'string' && p.ref);
  async function view(step) {
    const out = [];
    for (const rec of await stores.fwd.list()) {
      let r = rec;
      if (step && !FWD_END.has(rec.phase)) { try { r = await blFor(rec.provider || null).step(rec); } catch { /* the next pass */ } }
      out.push(describeFwd(r, now));
    }
    for (const p of await revProviders()) {
      // the reverse client words its swaps for TAC, so a pass is taken through it and the swaps are then described here from their own records
      if (step) { try { await revFor(p).pump(); } catch { /* a provider that cannot be reached: the next pass tries again */ } }
      try { out.push(...(await stores.swaps(p.id).list()).map((r) => describeRev({ ...r, providerName: p.name }))); } catch { /* a store that cannot be read shows nothing */ }
      try { out.push(...(await asked(p))); } catch { /* none */ }
    }
    return out.sort(newest);
  }
  const records = () => view(false);
  const pump = () => tend(() => view(true), () => view(false));
  async function recover() {
    const c = makeFastBridgeClient({ lp: noCounter(), btc, evm, store: stores.fwd, seed, pins: { btcAsset: SATS_ASSET, evmAsset: ETH }, policy, now });
    return (await c.recover()).length + (await recoverRev());
  }
  // e2b: each pool lock of this key carries a memo sealed to it (dapp/fastbridge-evm.js makeOwnLockFinder): a lock no record here holds is made a record again, and its
  // next step reads what became of it (the provider's claim gives t and the BTC is taken; with no claim by the deadline, the ETH is refunded)
  async function recoverRev() {
    if (typeof evm.findOwnLocks !== 'function') return 0;
    const found = await evm.findOwnLocks();
    const known = new Set();
    for (const p of [...(await revProviders()), RECOVERED]) for (const r of await stores.swaps(p.id).list()) known.add(r.id);
    let n = 0;
    for (const m of found) {
      const id = strip(m.swapId);
      if (known.has(id)) continue;
      const rec = recordFromLockMemo({ memo: m, seed, refundXonly: (await evm.refundKey(id)).xonly, claimerPub: btc.wallet.pub, btcAsset: SATS_ASSET, evmAsset: ETH, lockNullifier: evm.lockNullifier, now: now() });
      if (!rec) continue;
      await stores.swaps(RECOVERED.id).put(rec);
      known.add(id); n++;
    }
    if (n && !(await stores.index.get(RECOVERED.id))) await stores.index.put(RECOVERED);
    return n;
  }

  // whether a lock of `amount` pool units can be made now (an exact note needs no cut), for a page that shows it before the start refuses
  const covers = async (amount) => (evm.covers ? evm.covers(BigInt(amount)) : (await balances()).eth >= BigInt(amount));
  return { providers, reference, balances, covers, quote, start, pump, records, recover, address: () => ({ btc: btc.address }), claimPub: claimPubHex };
}
