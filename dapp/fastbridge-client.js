
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
  warnFeeBps: 500, maxFeeBps: 9000, quoteMarginSecs: 120,
};

export const TAKE_VB = 750, TAKE_DUST = 546, TAKE_FLAG = 2;
export const fairTakeAt = (feeRate) => TAKE_DUST + Math.ceil(TAKE_VB * feeRate * 2);

export function makeFastBridgeClient({ lp, btc, evm, store, seed, pins = {}, policy: policyIn = {}, provider = null, now = () => Math.floor(Date.now() / 1000) }) {
  const policy = { ...DEFAULT_POLICY, ...policyIn };
  const counter = typeof lp === 'string' ? makeHttpCounter({ base: lp }) : lp;
  const bl = makeBitcoinLocker({ seed, now, policy, store, btc, evm, counter });
  const pinned = (a) => (pins[a] ? strip(pins[a]) : null);

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
    const takeSats = Number(q.takeSats ?? 0);
    if (!Number.isInteger(takeSats) || (takeSats !== 0 && (takeSats < 546 || takeSats > policy.maxTakeSats))) throw new Error('the quote\'s Bitcoin fee is out of range');
    let highTake = false;
    if (takeSats > 0 && btc && typeof btc.feeRate === 'function') {
      try { highTake = takeSats > TAKE_FLAG * fairTakeAt(await btc.feeRate()); } catch { }
    }
    return { ...q, claimPub: strip(q.claimPub), btcAsset: strip(q.btcAsset), evmAsset: strip(q.evmAsset), btcValue, evmAmount, fee, csvBlocks, takeSats, highFee, highTake };
  }

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

  async function freeNotes(notes) {
    const held = new Set();
    for (const r of await store.list()) if (!TERMINAL.has(r.phase) && r.role === 'bl') for (const i of r.noteInputs || []) held.add(`${i.txid}:${i.vout}`);
    return held.size ? notes.filter((n) => !held.has(`${n.txid}:${n.vout}`)) : notes;
  }

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

  async function start({ quote: q, notes: all }) {
    if (!(Number(q.validUntil) > now() + policy.quoteMarginSecs)) throw new Error('the quote expired');
    const notes = await freeNotes(all);
    const pick = pickNotes(notes, q.btcValue);
    if (!pick) throw new Error(notes.length < all.length ? 'fastbridge: this note is already part of a swap' : 'these notes do not cover the amount');
    if (await store.get(bytesToHex(X.swapIdOf(pick.notes[0].txid, pick.notes[0].vout)))) throw new Error('fastbridge: this note is already part of a swap');
    if (counter.reserve) {
      const r = await counter.reserve({ quoteId: q.id });
      if (!r || r.ok === false) throw new Error(`the provider cannot hold that amount${r && r.why ? `: ${r.why}` : ''}`);
    }
    policy.csvBlocks = q.csvBlocks;
    const rec = await bl.start({
      asset: hexToBytes(q.btcAsset), amount: q.btcValue, notes: pick.notes, counterClaimPub: hexToBytes(q.claimPub),
      evmAsset: q.evmAsset, evmAmount: q.evmAmount, quoteId: q.id, takeSats: q.takeSats ?? 0, avoid: outpointsOf(all),
    });
    if (provider) { rec.provider = provider; await store.put(rec); }
    return bl.step(rec);
  }

  async function tick() {
    const out = [];
    for (const rec of await store.list()) out.push(TERMINAL.has(rec.phase) ? rec : await bl.step(rec));
    return out.sort((a, b) => b.created - a.created).map((r) => describe(r, now));
  }

  function run({ everyMs = 15000, onChange = () => {} } = {}) {
    let busy = false, stopped = false, timer = null;
    const pass = async () => {
      if (busy || stopped) return;
      busy = true;
      try { onChange(await tick()); } catch { } finally { busy = false; }
    };
    pass();
    timer = setInterval(pass, everyMs);
    return () => { stopped = true; clearInterval(timer); };
  }

  const records = async () => (await store.list()).sort((a, b) => b.created - a.created).map((r) => describe(r, now));

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
    return found.map((r) => describe(r, now));
  }

  return { terms, quote, pickNotes, freeNotes, cost, start, tick, run, records, recover, describe, step: (rec) => bl.step(rec) };
}

export const QUOTE_WAIT_MS = 12000;
export function makeFastBridgeMarket({ btc, evm, store, seed, pins = {}, policy, now, counterFor, makeClient = makeFastBridgeClient }) {
  const clients = new Map();
  const keyOf = (ref) => (ref ? JSON.stringify([ref.kind, ref.claimPub || '', ref.gateway || ref.base || '']) : 'none');
  function clientFor(ref) {
    const k = keyOf(ref);
    if (!clients.has(k)) clients.set(k, makeClient({ lp: counterFor(ref), btc, evm, store, seed, pins: { ...pins, claimPub: ref && ref.claimPub ? ref.claimPub : undefined }, policy, provider: ref, ...(now ? { now } : {}) }));
    return clients.get(k);
  }
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('the provider did not answer in time')), ms))]);

  async function quoteAll(providers, amount, { timeoutMs = QUOTE_WAIT_MS } = {}) {
    const got = await Promise.all(providers.map(async (provider) => {
      try { return { provider, quote: await withTimeout(clientFor(provider.ref).quote(amount), timeoutMs) }; } catch (error) { return { provider, error }; }
    }));
    const quotes = got.filter((r) => r.quote).sort((a, b) => (a.quote.highTake ? 1 : 0) - (b.quote.highTake ? 1 : 0) || (a.quote.evmAmount > b.quote.evmAmount ? -1 : a.quote.evmAmount < b.quote.evmAmount ? 1 : 0));
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
  const cost = ({ quotes, notes }) => clientFor(quotes[0].provider.ref).cost({ quote: quotes[0].quote, notes });
  async function tick() {
    const out = [];
    for (const rec of await store.list()) out.push(TERMINAL.has(rec.phase) ? rec : await clientFor(rec.provider || null).step(rec));
    return out.sort((a, b) => b.created - a.created).map((r) => describe(r, now));
  }
  function run({ everyMs = 15000, onChange = () => {} } = {}) {
    let busy = false, stopped = false;
    const pass = async () => {
      if (busy || stopped) return;
      busy = true;
      try { onChange(await tick()); } catch { } finally { busy = false; }
    };
    pass();
    const timer = setInterval(pass, everyMs);
    return () => { stopped = true; clearInterval(timer); };
  }
  const records = async () => (await store.list()).sort((a, b) => b.created - a.created).map((r) => describe(r, now));
  const recover = (opts) => clientFor(null).recover(opts);
  return { quoteAll, start, cost, tick, run, records, recover, clientFor };
}

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
const REASONS = [
  [/quote expired/i, 'The provider’s quote ran out before your lock was confirmed.'],
  [/unknown quote/i, 'The provider no longer had your quote.'],
  [/cannot lock right now|not taking bridges/i, 'The provider is not taking bridges at the moment.'],
  [/cannot take that amount|no room|nothing left/i, 'The provider no longer had room for this amount.'],
  [/could not be reached|did not answer/i, 'The provider did not answer.'],
  [/could not be checked now|still being checked/i, 'The provider could not check your lock in time.'],
  [/never showed in the pool|no ethereum lock arrived/i, 'The provider did not put the TAC in the pool in time.'],
  [/too little time left/i, 'There was too little time left to claim safely, so it was stopped.'],
  [/did not land before the deadline/i, 'The claim did not go through before its deadline.'],
  [/^offer:/i, 'The provider’s offer did not pass your safety checks, so nothing was claimed.'],
  [/timelock has run/i, 'It was not finished before the lock’s time ran out.'],
];
export function plainWhy(why) {
  const raw = String(why || '').trim();
  if (!raw) return '';
  for (const [re, said] of REASONS) if (re.test(raw)) return said;
  const declined = raw.match(/^the counterparty declined:\s*(.+)$/i);
  const said = declined ? `The provider declined it: ${declined[1]}` : raw;
  return said.charAt(0).toUpperCase() + said.slice(1).replace(/[.\s]*$/, '.');
}
const BTC_BLOCK_SECS = 600;
const opensAt = (rec) => { const t = rec.lockAt || rec.confirmedAt; return t && rec.csvBlocks ? t + (rec.csvBlocks - 1) * BTC_BLOCK_SECS : null; };
function returnLine(opens, now) {
  if (opens == null) return 'Your Bitcoin is safe. The lock comes back to your address when its timelock ends, about a day after it confirmed.';
  const left = opens - now;
  if (left <= 0) return 'Your Bitcoin is safe. Its lock is due back now, and is sent to your address from here while the app is open.';
  const h = left / 3600;
  const when = h >= 1.5 ? `in about ${Math.round(h)} hours` : h >= 0.75 ? 'in about an hour' : 'within the hour';
  return `Your Bitcoin is safe. The lock comes back to your address ${when}: open the app then and it is sent back.`;
}
export function describe(rec, clock = null) {
  const now = typeof clock === 'function' ? clock() : Date.now() / 1000;
  let [at, title, detail] = SAYS[rec.phase] || [0, rec.phase, ''];
  if (rec.phase === 'broadcast' && rec.confirmedAt) {
    at = 1; title = 'The provider is checking your lock';
    detail = rec.offerWhy ? `The lock is confirmed. The provider says: ${String(rec.offerWhy).replace(/\.$/, '')}.` : 'The lock is confirmed. The provider reads it from Bitcoin before it locks TAC for you.';
  }
  const ended = TERMINAL.has(rec.phase), back = rec.phase === 'refund-wait' || rec.phase === 'refunded';
  let waitingOnTimelock = false;
  if (rec.phase === 'refund-wait') {
    const found = /found from the key/.test(rec.why || '') || !!rec.recovered, opens = opensAt(rec);
    waitingOnTimelock = opens != null && opens - now > 0;
    title = found ? 'Returning to Bitcoin' : 'Did not go through';
    detail = [found ? '' : plainWhy(rec.why), returnLine(opens, now)].filter(Boolean).join(' ');
  }
  return {
    id: rec.id, phase: rec.phase, title, detail,
    at, steps: STEPS, ended, returned: back, amount: rec.amount, receive: back ? '0' : rec.evmAmount, created: rec.created,
    lockTxid: rec.lock?.txid || null, error: waitingOnTimelock ? null : (rec.lastError || null), recovered: !!rec.recovered,
  };
}

export const termsOf = (i) => ({
  feeBps: Number(i.feeBps) || 0, flatFee: BigInt(i.flatFee ?? 0), minAmount: BigInt(i.minAmount), maxAmount: BigInt(i.maxAmount),
  available: i.available == null ? null : BigInt(i.available),
  anyTac: i.anyTac === true,
});

export function makeLocalStore(prefix, storage = globalThis.localStorage) {
  return {
    async get(id) { try { const v = storage.getItem(prefix + id); return v ? JSON.parse(v) : null; } catch { return null; } },
    async put(rec) { storage.setItem(prefix + rec.id, JSON.stringify(rec)); },
    async del(id) { try { storage.removeItem(prefix + id); } catch { } },
    async list() {
      const out = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(prefix)) { try { const r = JSON.parse(storage.getItem(k)); if (r && r.id) out.push(r); } catch { } }
      }
      return out;
    },
  };
}
