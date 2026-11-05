// The user's side of a fast bridge swap, for a page or a script: the LP's terms and quote, the notes to lock, the Bitcoin
// locker (fastbridge-bl.js) over a store, the words for where each swap is, and the recovery of a lock from the key.
//
//   const fb = makeFastBridgeClient({ lp, btc, evm, store, seed, pins })
//   lp      the LP's base URL, or an object with the calls of fastbridge-http.js (info, quote, sendOffer, getEvmOffer)
//   btc     the Bitcoin locker's Bitcoin context (fastbridge-btc.js)      evm   the pool side (fastbridge-evm.js)
//   store   { get(id), put(rec), list() }                                  seed  32 bytes, the swap seed from the key
//   pins    { claimPub?, btcAsset, evmAsset }: what the page expects of the LP; a quote that differs is refused
//   policy  { csvBlocks, minCsv, maxCsv, minClaimSecs, offerWaitSecs, maxEvmWindowSecs, warnFeeBps, maxFeeBps, quoteMarginSecs }

import { makeBitcoinLocker } from './fastbridge-bl.js';
import { makeHttpCounter } from './fastbridge-http.js';
import * as X from './adaptor-xswap.js';
import { bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';

const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const isHex = (h, n) => new RegExp(`^[0-9a-f]{${n}}$`).test(strip(h));
const big = (v, what) => { try { const b = BigInt(v); if (b < 0n) throw 0; return b; } catch { throw new Error(`the provider's ${what} is not a number`); } };
const TERMINAL = new Set(['done', 'refunded', 'counter-took']);
const MAX_INPUTS = 6;

export const DEFAULT_POLICY = {
  csvBlocks: 144, minCsv: 72, maxCsv: 288, maxTakeSats: 30000, minClaimSecs: 3600, offerWaitSecs: 2 * 3600, maxEvmWindowSecs: 6 * 3600,
  // a fee over warnFeeBps is quoted, flagged `highFee`, for a page to say so plainly (a provider prices as it likes); one over maxFeeBps is not quoted
  warnFeeBps: 500, maxFeeBps: 9000, quoteMarginSecs: 120,
};

export function makeFastBridgeClient({ lp, btc, evm, store, seed, pins = {}, policy: policyIn = {}, provider = null, now = () => Math.floor(Date.now() / 1000) }) {
  const policy = { ...DEFAULT_POLICY, ...policyIn };
  const counter = typeof lp === 'string' ? makeHttpCounter({ base: lp }) : lp;
  const bl = makeBitcoinLocker({ seed, now, policy, store, btc, evm, counter });
  const pinned = (a) => (pins[a] ? strip(pins[a]) : null);

  // The provider's terms, checked for shape and against what the page pinned.
  async function terms() {
    const i = await counter.info();
    if (!i || !isHex(i.claimPub, 66) || !isHex(i.btcAsset, 64) || !isHex(i.evmAsset, 64)) throw new Error('the provider\'s terms are not readable');
    const t = {
      claimPub: strip(i.claimPub), btcAsset: strip(i.btcAsset), evmAsset: strip(i.evmAsset), minAmount: big(i.minAmount, 'minimum'), maxAmount: big(i.maxAmount, 'maximum'),
      feeBps: Number(i.feeBps) || 0, flatFee: big(i.flatFee ?? 0, 'flat fee'), csvBlocks: Number(i.csvBlocks), evmWindowSecs: Number(i.evmWindowSecs),
      available: i.available == null ? null : big(i.available, 'capacity'),
    };
    for (const k of ['claimPub', 'btcAsset', 'evmAsset']) if (pinned(k) && pinned(k) !== t[k]) throw new Error(`the provider's ${k === 'claimPub' ? 'key' : 'asset'} is not the one this page expects`);
    return t;
  }

  // A quote for an amount of base units, checked before the user sees it: the same provider and assets, a timelock in range,
  // a fee within the limit, and time enough left to use it.
  async function quote(amount) {
    const q = await counter.quote(amount);
    if (!q || typeof q.id !== 'string' || !isHex(q.claimPub, 66) || !isHex(q.btcAsset, 64) || !isHex(q.evmAsset, 64)) throw new Error('the provider\'s quote is not readable');
    for (const k of ['claimPub', 'btcAsset', 'evmAsset']) if (pinned(k) && pinned(k) !== strip(q[k])) throw new Error(`the provider's ${k === 'claimPub' ? 'key' : 'asset'} is not the one this page expects`);
    const btcValue = big(q.btcValue, 'amount'), evmAmount = big(q.evmAmount, 'payout');
    if (btcValue !== BigInt(amount)) throw new Error('the quote is for a different amount');
    if (evmAmount <= 0n || evmAmount > btcValue) throw new Error('the quote\'s payout is out of range');
    const csvBlocks = Number(q.csvBlocks);
    if (!Number.isInteger(csvBlocks) || csvBlocks < policy.minCsv || csvBlocks > policy.maxCsv) throw new Error('the quote\'s timelock is out of range');
    const fee = btcValue - evmAmount;
    if (fee * 10000n > btcValue * BigInt(policy.maxFeeBps)) throw new Error('the quote\'s fee is above the limit this page accepts');
    const highFee = fee * 10000n > btcValue * BigInt(policy.warnFeeBps);
    if (!(Number(q.validUntil) > now() + policy.quoteMarginSecs)) throw new Error('the quote expires too soon to use');
    // the provider's take fee, which the lock pays it on Bitcoin: none, or from dust to the most this page pays
    const takeSats = Number(q.takeSats ?? 0);
    if (!Number.isInteger(takeSats) || (takeSats !== 0 && (takeSats < 546 || takeSats > policy.maxTakeSats))) throw new Error('the quote\'s Bitcoin fee is out of range');
    return { ...q, claimPub: strip(q.claimPub), btcAsset: strip(q.btcAsset), evmAsset: strip(q.evmAsset), btcValue, evmAmount, fee, csvBlocks, takeSats, highFee };
  }

  // Notes to lock for `amount`: the smallest single note that covers it, else the largest first until covered.
  function pickNotes(notes, amount) {
    const want = BigInt(amount), have = notes.map((n) => ({ ...n, amount: BigInt(n.amount) })).filter((n) => n.amount > 0n);
    const one = have.filter((n) => n.amount >= want).sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0))[0];
    if (one) return { notes: [one], change: one.amount - want };
    const picked = []; let sum = 0n;
    for (const n of have.sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0))) {
      if (picked.length >= MAX_INPUTS) break;
      picked.push(n); sum += n.amount;
      if (sum >= want) return { notes: picked, change: sum - want };
    }
    return null;
  }

  const outpointsOf = (ns) => new Set(ns.map((n) => `${n.txid}:${n.vout}`));

  // The notes a swap still holds are not offered to another: a second lock built from one would double-spend the first.
  async function freeNotes(notes) {
    const held = new Set();
    for (const r of await store.list()) if (!TERMINAL.has(r.phase) && r.role === 'bl') for (const i of r.noteInputs || []) held.add(`${i.txid}:${i.vout}`);
    return held.size ? notes.filter((n) => !held.has(`${n.txid}:${n.vout}`)) : notes;
  }

  // What the lock for a quote would cost on Bitcoin, and whether the address can pay it: the lock is built and signed as it would be,
  // and neither stored nor sent. { fee, take, total } in sats, or { short: true, need, have } when the address lacks the sats.
  async function cost({ quote: q, notes }) {
    const pick = pickNotes(await freeNotes(notes), q.btcValue);
    if (!pick) return { short: false, noNotes: true };
    const take = Number(q.takeSats ?? 0);
    policy.csvBlocks = q.csvBlocks;
    try {
      const { pair } = await bl.build({ asset: hexToBytes(q.btcAsset), amount: q.btcValue, notes: pick.notes, counterClaimPub: hexToBytes(q.claimPub), evmAsset: q.evmAsset, evmAmount: q.evmAmount, quoteId: q.id, takeSats: take, avoid: outpointsOf(notes) });
      const fee = pair.commitFee + pair.revealFee;
      return { short: false, fee, take, total: fee + take };
    } catch (e) {
      const m = /not enough sats to fund the commit \(need (\d+), have (\d+)\)/.exec(String((e && e.message) || e));
      if (m) return { short: true, need: Number(m[1]), have: Number(m[2]), take };
      throw e;
    }
  }

  // Builds and stores the lock for a checked quote; nothing is sent until the first step.
  async function start({ quote: q, notes: all }) {
    if (!(Number(q.validUntil) > now() + policy.quoteMarginSecs)) throw new Error('the quote expired');
    const notes = await freeNotes(all);
    const pick = pickNotes(notes, q.btcValue);
    if (!pick) throw new Error(notes.length < all.length ? 'fastbridge: this note is already part of a swap' : 'these notes do not cover the amount');
    if (await store.get(bytesToHex(X.swapIdOf(pick.notes[0].txid, pick.notes[0].vout)))) throw new Error('fastbridge: this note is already part of a swap');
    // the provider holds the payout before anything is locked: a provider that cannot is found out while the TAC is still in hand
    if (counter.reserve) {
      const r = await counter.reserve({ quoteId: q.id });
      if (!r || r.ok === false) throw new Error(`the provider cannot hold that amount${r && r.why ? `: ${r.why}` : ''}`);
    }
    policy.csvBlocks = q.csvBlocks;
    const rec = await bl.start({
      asset: hexToBytes(q.btcAsset), amount: q.btcValue, notes: pick.notes, counterClaimPub: hexToBytes(q.claimPub),
      evmAsset: q.evmAsset, evmAmount: q.evmAmount, quoteId: q.id, takeSats: q.takeSats ?? 0, avoid: outpointsOf(all),
    });
    // the provider is kept with the swap, so it is carried on with the one it began with
    if (provider) { rec.provider = provider; await store.put(rec); }
    return rec;
  }

  async function tick() {
    const out = [];
    for (const rec of await store.list()) out.push(TERMINAL.has(rec.phase) ? rec : await bl.step(rec));
    return out.map(describe);
  }

  // Calls tick() on a timer while the page is open; one pass at a time. Returns stop().
  function run({ everyMs = 15000, onChange = () => {} } = {}) {
    let busy = false, stopped = false, timer = null;
    const pass = async () => {
      if (busy || stopped) return;
      busy = true;
      try { onChange(await tick()); } catch { /* the next pass tries again */ } finally { busy = false; }
    };
    pass();
    timer = setInterval(pass, everyMs);
    return () => { stopped = true; clearInterval(timer); };
  }

  const records = async () => (await store.list()).sort((a, b) => b.created - a.created).map(describe);

  // The Bitcoin locks this key made that the store does not hold (a new browser, cleared data): found from the lock
  // transactions in the address's history and kept as swaps that take the note back on the timelock.
  async function recover({ pages = 4 } = {}) {
    const known = new Set((await store.list()).map((r) => r.id)), found = [];
    for (const tx of await btc.history(btc.address, pages)) {
      if (!tx.vin || tx.vin.length < 2 || !tx.status?.confirmed) continue;
      let swapId;
      try { swapId = X.swapIdFromLockTx(tx); } catch { continue; }
      const id = bytesToHex(swapId);
      if (known.has(id)) continue;
      const lock = X.recoverBtcLock({ prims: btc.prims, seed, swapId, lockerXonly: btc.wallet.xonly, outputs: tx.vout });
      if (!lock) continue;
      const rec = {
        v: 1, role: 'bl', id, phase: 'refund-wait', why: 'found from the key', created: now(), updated: now(), quoteId: null,
        asset: pinned('btcAsset') || '', amount: String(lock.value), evmAsset: pinned('evmAsset') || '', evmAmount: '0',
        counterClaimPub: lock.claimerPub, csvBlocks: lock.csvBlocks, lock: { txid: tx.txid, vout: lock.vout, value: tx.vout[lock.vout].value },
        noteInputs: tx.vin.slice(1).map((i) => ({ txid: i.txid, vout: i.vout })), recovered: true,
      };
      await store.put(rec);
      known.add(id); found.push(rec);
    }
    return found.map(describe);
  }

  return { terms, quote, pickNotes, cost, start, tick, run, records, recover, describe, step: (rec) => bl.step(rec) };
}

// Several providers: a quote from each, the best first, and each swap carried on with the provider it began with.
//   const market = makeFastBridgeMarket({ btc, evm, store, seed, pins, counterFor })
//   counterFor(ref)   the counter of a provider, from the reference kept with its swaps ({ kind, claimPub, base | boardBase + gateway })
//   market.quoteAll(providers, amount)   -> { quotes: [{ provider, quote }] best payout first, failed: [{ provider, error }] }
//   market.start({ quotes, notes })      the best quote a provider will hold, each asked in turn -> { rec, provider }
//   market.tick() / run() / records() / recover()     as the client's, over the swaps of every provider
export function makeFastBridgeMarket({ btc, evm, store, seed, pins = {}, policy, now, counterFor, makeClient = makeFastBridgeClient }) {
  const clients = new Map();
  const keyOf = (ref) => (ref ? JSON.stringify([ref.kind, ref.claimPub || '', ref.gateway || ref.base || '']) : 'none');
  function clientFor(ref) {
    const k = keyOf(ref);
    if (!clients.has(k)) clients.set(k, makeClient({ lp: counterFor(ref), btc, evm, store, seed, pins: { ...pins, claimPub: ref && ref.claimPub ? ref.claimPub : undefined }, policy, provider: ref, ...(now ? { now } : {}) }));
    return clients.get(k);
  }
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('the provider did not answer in time')), ms))]);

  async function quoteAll(providers, amount, { timeoutMs = 8000 } = {}) {
    const got = await Promise.all(providers.map(async (provider) => {
      try { return { provider, quote: await withTimeout(clientFor(provider.ref).quote(amount), timeoutMs) }; } catch (error) { return { provider, error }; }
    }));
    const quotes = got.filter((r) => r.quote).sort((a, b) => (a.quote.evmAmount > b.quote.evmAmount ? -1 : a.quote.evmAmount < b.quote.evmAmount ? 1 : 0));
    return { quotes, failed: got.filter((r) => r.error) };
  }
  async function start({ quotes, notes }) {
    let last = null;
    for (const { provider, quote } of quotes) {
      try { return { rec: await clientFor(provider.ref).start({ quote, notes }), provider }; } catch (e) {
        last = e;
        if (!/cannot hold that amount/.test(String((e && e.message) || e))) throw e;
      }
    }
    throw last || new Error('the provider cannot hold that amount');
  }
  // the cost of the lock for the best quote (the one tried first)
  const cost = ({ quotes, notes }) => clientFor(quotes[0].provider.ref).cost({ quote: quotes[0].quote, notes });
  async function tick() {
    const out = [];
    for (const rec of await store.list()) out.push(TERMINAL.has(rec.phase) ? rec : await clientFor(rec.provider || null).step(rec));
    return out.map(describe);
  }
  function run({ everyMs = 15000, onChange = () => {} } = {}) {
    let busy = false, stopped = false;
    const pass = async () => {
      if (busy || stopped) return;
      busy = true;
      try { onChange(await tick()); } catch { /* the next pass tries again */ } finally { busy = false; }
    };
    pass();
    const timer = setInterval(pass, everyMs);
    return () => { stopped = true; clearInterval(timer); };
  }
  const records = async () => (await store.list()).sort((a, b) => b.created - a.created).map(describe);
  const recover = (opts) => clientFor(null).recover(opts);
  return { quoteAll, start, cost, tick, run, records, recover, clientFor };
}

// Where a swap is, in words and as a position among the four steps (lock on Bitcoin, lock in the pool, claim, done).
const STEPS = ['Lock on Bitcoin', 'Lock in the pool', 'Claim', 'Done'];
const SAYS = {
  built: [0, 'Locking on Bitcoin', 'The lock transaction is being sent.'],
  broadcast: [0, 'Waiting for Bitcoin', 'The lock needs one confirmation, about ten minutes.'],
  offered: [1, 'Waiting for the pool lock', 'The provider is locking TAC in the pool for you.'],
  claiming: [2, 'Claiming in the pool', 'Your claim is being settled.'],
  claimed: [2, 'Finishing', 'The TAC is yours in the pool. The provider takes the Bitcoin lock.'],
  done: [3, 'Done', 'The TAC is in your private balance.'],
  'refund-wait': [0, 'Returning to Bitcoin', 'The lock returns to your Bitcoin address when its timelock ends.'],
  refunded: [3, 'Returned', 'The lock came back to your Bitcoin address.'],
  'counter-took': [3, 'Done', 'The TAC is in your private balance. The provider took the Bitcoin lock.'],
};
export function describe(rec) {
  let [at, title, detail] = SAYS[rec.phase] || [0, rec.phase, ''];
  // the lock has confirmed and the provider has been asked: it is reading the lock from Bitcoin, which can take a minute, and says so
  if (rec.phase === 'broadcast' && rec.confirmedAt) {
    at = 1; title = 'The provider is checking your lock';
    detail = rec.offerWhy ? `The lock is confirmed. The provider says: ${String(rec.offerWhy).replace(/\.$/, '')}.` : 'The lock is confirmed. The provider reads it from Bitcoin before it locks TAC for you.';
  }
  const ended = TERMINAL.has(rec.phase), back = rec.phase === 'refund-wait' || rec.phase === 'refunded';
  return {
    id: rec.id, phase: rec.phase, title, detail: rec.phase === 'refund-wait' && rec.why && !/found from the key/.test(rec.why) ? `${detail} (${rec.why})` : detail,
    at, steps: STEPS, ended, returned: back, amount: rec.amount, receive: rec.evmAmount, created: rec.created,
    lockTxid: rec.lock?.txid || null, error: rec.lastError || null, recovered: !!rec.recovered,
  };
}

// A provider's terms from what it says of itself (its /info, or its ad): amounts as BigInt, what it can take now when it says.
export const termsOf = (i) => ({
  feeBps: Number(i.feeBps) || 0, flatFee: BigInt(i.flatFee ?? 0), minAmount: BigInt(i.minAmount), maxAmount: BigInt(i.maxAmount),
  available: i.available == null ? null : BigInt(i.available),
});

// Swaps kept in the page's localStorage under a prefix, one entry each.
export function makeLocalStore(prefix, storage = globalThis.localStorage) {
  return {
    async get(id) { try { const v = storage.getItem(prefix + id); return v ? JSON.parse(v) : null; } catch { return null; } },
    async put(rec) { storage.setItem(prefix + rec.id, JSON.stringify(rec)); },
    async del(id) { try { storage.removeItem(prefix + id); } catch { /* nothing kept */ } },
    async list() {
      const out = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(prefix)) { try { const r = JSON.parse(storage.getItem(k)); if (r && r.id) out.push(r); } catch { /* an entry that is not a swap */ } }
      }
      return out;
    },
  };
}
