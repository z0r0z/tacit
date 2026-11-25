
import { makeBitcoinLocker } from './fastbridge-bl.js';
import { makeHttpCounter } from './fastbridge-http.js';
import * as X from './adaptor-xswap.js';
import { feeOf, noWorse } from './fastbridge-price.js';

export { noWorse };
import { bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';

const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const isHex = (h, n) => new RegExp(`^[0-9a-f]{${n}}$`).test(strip(h));
const big = (v, what) => { try { const b = BigInt(v); if (b < 0n) throw 0; return b; } catch { throw new Error(`the provider's ${what} is not a number`); } };
const TERMINAL = new Set(['done', 'refunded', 'counter-took']);
const locked = (name, fn) => (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request ? navigator.locks.request(name, fn) : fn());
const MAX_INPUTS = 6;

export const DEFAULT_POLICY = {
  csvBlocks: 144, minCsv: 72, maxCsv: 288, maxTakeSats: 30000, minClaimSecs: 3600, offerWaitSecs: 2 * 3600, maxEvmWindowSecs: 6 * 3600,
  warnFeeBps: 500, maxFeeBps: 9000, quoteMarginSecs: 120,
};

export const TAKE_VB = 750, TAKE_DUST = 546, TAKE_FLAG = 2;
export const fairTakeAt = (feeRate) => TAKE_DUST + Math.ceil(TAKE_VB * feeRate * 2);
// A take up to this many times its cost at the current rate is a fair one; a quote that asks more is ranked below every quote with a fair take.
export const TAKE_FAIR = 1.25;
// The last fee rate each Bitcoin reader gave, so a quote read while the rate cannot be is still judged against a rate.
const lastRates = new WeakMap();


// The notes a lock for `amount` spends from `notes`: the smallest one that covers it, else the largest ones together (up to MAX_INPUTS), with
// what is left over returning to the key as change. null when they do not cover it.
export function pickNotes(notes, amount) {
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
    if (!q || typeof q.id !== 'string' || q.id.length > 128 || !isHex(q.claimPub, 66) || !isHex(q.btcAsset, 64) || !isHex(q.evmAsset, 64)) throw new Error('the provider\'s quote is not readable');
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
    // the take is judged at the rate read now, else at the last one read; with no rate at all it cannot be judged, and is ranked after the takes that can
    let highTake = false, takeAbove = false, takeUnjudged = false;
    if (takeSats > 0) {
      let rate = null;
      if (btc && typeof btc.feeRate === 'function') {
        try { rate = Number(await btc.feeRate()); if (Number.isFinite(rate) && rate > 0 && btc && typeof btc === 'object') lastRates.set(btc, rate); else rate = null; } catch { }
      }
      if (rate == null && btc && typeof btc === 'object') rate = lastRates.get(btc) ?? null;
      if (rate == null) takeUnjudged = true;
      else { const fair = fairTakeAt(rate); highTake = takeSats > TAKE_FLAG * fair; takeAbove = takeSats > TAKE_FAIR * fair; }
    }
    return { ...q, claimPub: strip(q.claimPub), btcAsset: strip(q.btcAsset), evmAsset: strip(q.evmAsset), btcValue, evmAmount, fee, csvBlocks, takeSats, takeInLock: takeSats > 0 && q.takeInLock === true, highFee, highTake, takeAbove, takeUnjudged };
  }

  const outpointsOf = (ns) => new Set(ns.map((n) => `${n.txid}:${n.vout}`));

  async function freeNotes(notes) {
    const held = new Set();
    for (const r of await store.list()) if (!TERMINAL.has(r.phase) && r.role === 'bl') for (const i of r.noteInputs || []) held.add(`${i.txid}:${i.vout}`);
    return held.size ? notes.filter((n) => !held.has(`${n.txid}:${n.vout}`)) : notes;
  }

  // `avoid` (a Set of "txid:vout") are coins this lock must not fund itself from: by default the notes given, which carry TAC. A part of a split
  // bridge names more: every note of the key, and the fee coins the parts before it spent.
  async function cost({ quote: q, notes, avoid = null }) {
    const pick = pickNotes(await freeNotes(notes), q.btcValue);
    if (!pick) return { short: false, noNotes: true };
    const take = Number(q.takeSats ?? 0);
    policy.csvBlocks = q.csvBlocks;
    try {
      const { rec, pair } = await bl.build({ asset: hexToBytes(q.btcAsset), amount: q.btcValue, notes: pick.notes, counterClaimPub: hexToBytes(q.claimPub), evmAsset: q.evmAsset, evmAmount: q.evmAmount, quoteId: q.id, takeSats: take, takeInLock: q.takeInLock === true, avoid: avoid || outpointsOf(notes) });
      const fee = pair.commitFee + pair.revealFee;
      return { short: false, fee, take, total: fee + take, coins: rec.feeInputs, ...(q.takeInLock === true && take > 0 ? { takeInLock: true } : {}) };
    } catch (e) {
      const m = /not enough sats to fund the commit \(need (\d+), have (\d+)\)/.exec(String((e && e.message) || e));
      if (m) return { short: true, need: Number(m[1]), have: Number(m[2]), take };
      throw e;
    }
  }

  // The provider is asked to hold the payout of a quote before any Bitcoin is locked, so one that cannot is found out while the TAC is in hand
  // (a provider with no reserve call holds nothing).
  async function reserve(q) {
    if (!counter.reserve) return;
    const r = await counter.reserve({ quoteId: q.id });
    if (!r || r.ok === false) throw new Error(`the provider cannot hold that amount${r && r.why ? `: ${r.why}` : ''}`);
  }
  // `avoid`: coins the lock must not fund itself from (see `cost`). `reserved`: the payout is already held (the parts of a split bridge are all held
  // before the first lock). `meta.sweep`: { id, part, of }, kept with the swap so the page can say which part of a split bridge it is.
  async function start({ quote: q, notes: all, avoid = null, reserved = false, meta = null }) {
    if (!(Number(q.validUntil) > now() + policy.quoteMarginSecs)) throw new Error('the quote expired');
    const notes = await freeNotes(all);
    const pick = pickNotes(notes, q.btcValue);
    if (!pick) throw new Error(notes.length < all.length ? 'fastbridge: this note is already part of a swap' : 'these notes do not cover the amount');
    const swapId = bytesToHex(X.swapIdOf(pick.notes[0].txid, pick.notes[0].vout));
    // One start of a note at a time across this browser's tabs: a second tab that presses the same note waits here, then finds the first one's record.
    return locked(`tacit-fast-start:${swapId}`, async () => {
      if (await store.get(swapId)) throw new Error('fastbridge: this note is already part of a swap');
      if (!reserved) await reserve(q);
      policy.csvBlocks = q.csvBlocks;
      const rec = await bl.start({
        asset: hexToBytes(q.btcAsset), amount: q.btcValue, notes: pick.notes, counterClaimPub: hexToBytes(q.claimPub),
        evmAsset: q.evmAsset, evmAmount: q.evmAmount, quoteId: q.id, takeSats: q.takeSats ?? 0, takeInLock: q.takeInLock === true, avoid: avoid || outpointsOf(all), validUntil: Number(q.validUntil) || null, csvBlocks: q.csvBlocks,
      });
      if (provider || (meta && meta.sweep)) {
        if (provider) rec.provider = provider;
        if (meta && meta.sweep) rec.sweep = meta.sweep;
        await store.put(rec);
      }
      return bl.step(rec);
    });
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

  async function recover({ pages = 12 } = {}) {
    const known = new Set((await store.list()).map((r) => r.id)), found = [];
    for (const tx of await btc.history(btc.address, pages)) {
      if (!tx.vin || !tx.vin.length || !tx.status?.confirmed) continue;
      // A lock of a Tacit note spends the note as its second input (the first is its commit); a lock of plain sats has no commit and is named
      // by its first input. Either is found only when the hint opens under this key and the output it names is in the transaction.
      for (const sats of [false, true]) {
        if (!sats && tx.vin.length < 2) continue;
        let swapId;
        try { swapId = X.swapIdFromLockTx(tx, { sats }); } catch { continue; }
        const id = bytesToHex(swapId);
        if (known.has(id)) continue;
        const lock = X.recoverBtcLock({ prims: btc.prims, seed, swapId, lockerXonly: btc.wallet.xonly, outputs: tx.vout });
        if (!lock) continue;
        // a take locked with the lock (an output of the lock's own script besides the lock) is found with it, so the refund brings it home too
        const lockSpk = String(tx.vout[lock.vout].scriptpubkey || '').toLowerCase();
        const takeAt = sats ? -1 : tx.vout.findIndex((o, k) => k !== lock.vout && String(o.scriptpubkey || '').toLowerCase() === lockSpk && o.value > 546);
        const rec = {
          ...(takeAt >= 0 ? { takeInLock: true, takeVout: takeAt, takeValue: tx.vout[takeAt].value } : {}),
          v: 1, role: 'bl', id, phase: 'refund-wait', why: 'found from the key', created: now(), updated: now(), quoteId: null,
          asset: sats ? X.SATS_ASSET : pinned('btcAsset') || '', amount: String(lock.value), evmAsset: pinned('evmAsset') || '', evmAmount: '0',
          counterClaimPub: lock.claimerPub, csvBlocks: lock.csvBlocks, lock: { txid: tx.txid, vout: lock.vout, value: tx.vout[lock.vout].value },
          noteInputs: sats ? [] : tx.vin.slice(1).map((i) => ({ txid: i.txid, vout: i.vout })),
          ...(sats ? { feeInputs: tx.vin.map((i) => ({ txid: i.txid, vout: i.vout })) } : {}), recovered: true,
        };
        await store.put(rec);
        known.add(id); found.push(rec);
        break;
      }
    }
    return found.map((r) => describe(r, now));
  }

  return { terms, quote, pickNotes, freeNotes, cost, reserve, start, tick, run, records, recover, describe, step: (rec) => bl.step(rec) };
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

  // Each quote is also checked against the provider's own terms (`aboveTerms`: it keeps more than its ad says) and against the most the holder said
  // it will pay (`maxFeeBps`, a kept want's price: `aboveWant`). Quotes are ranked by what they cost the holder: one with a take above fair or a fee
  // above its word comes after every one without, then the most paid out first.
  async function quoteAll(providers, amount, { timeoutMs = QUOTE_WAIT_MS, maxFeeBps = null } = {}) {
    const got = await Promise.all(providers.map(async (provider) => {
      try {
        const q = await withTimeout(clientFor(provider.ref).quote(amount), timeoutMs);
        let aboveTerms = false;
        // (for one asset on both sides the fee is what is not paid out; a provider that lists no terms is judged as before)
        try { aboveTerms = !!provider.terms && q.btcAsset === q.evmAsset && q.fee > feeOf(provider.terms, q.btcValue); } catch { }
        const aboveWant = Number.isInteger(maxFeeBps) && maxFeeBps >= 0 && q.fee * 10000n > q.btcValue * BigInt(maxFeeBps);
        return { provider, quote: { ...q, aboveTerms, aboveWant } };
      } catch (error) { return { provider, error }; }
    }));
    const worse = (q) => (q.highTake || q.takeAbove || q.takeUnjudged ? 2 : 0) + (q.aboveTerms || q.aboveWant ? 1 : 0);
    const quotes = got.filter((r) => r.quote).sort((a, b) => worse(a.quote) - worse(b.quote) || (a.quote.evmAmount > b.quote.evmAmount ? -1 : a.quote.evmAmount < b.quote.evmAmount ? 1 : 0));
    return { quotes, failed: got.filter((r) => r.error) };
  }
  // `confirmed`: the quote the holder pressed for. Only quotes no worse than it are tried, so a provider that cannot hold its payout is passed over
  // only for one that pays as much on the same terms.
  async function start({ quotes: all, notes, confirmed = null }) {
    const quotes = confirmed ? all.filter((x) => noWorse(x.quote, confirmed)) : all;
    if (confirmed && all.length && !quotes.length) throw Object.assign(new Error('the quote changed'), { code: 'quote-changed' });
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

  // ── a bridge split across providers ──
  // `legs` are the parts, [{ provider, quote, notes }]: each its own provider, its own quote, and notes of its own (the page gives no note to two
  // parts). `notes` is every note of the key: none of them is ever a fee coin. Each part is a whole bridge on its own, with its own lock on Bitcoin
  // and its own refund, so a part that goes wrong costs the others nothing.
  const outpoint = (x) => `${x.txid}:${x.vout}`;
  const margin = { ...DEFAULT_POLICY, ...(policy || {}) }.quoteMarginSecs;
  const clock = now || (() => Math.floor(Date.now() / 1000));

  // What the parts cost on Bitcoin, one after the other as they are locked: a part's lock spends fee coins that the next one cannot, so the second
  // is priced without the first's. { ok: false, at } names the first part whose lock the address cannot pay for.
  async function sweepCost({ legs, notes: all }) {
    const avoid = new Set(all.map(outpoint)), out = [];
    for (let i = 0; i < legs.length; i++) {
      const c = await clientFor(legs[i].provider.ref).cost({ quote: legs[i].quote, notes: legs[i].notes, avoid: new Set(avoid) });
      out.push(c);
      if (c.short || c.noNotes) return { ok: false, at: i, legs: out };
      for (const k of c.coins || []) avoid.add(outpoint(k));
    }
    return { ok: true, legs: out };
  }

  // Every part's payout is held before anything is locked: a provider that cannot hold its share is found out while the TAC is still in hand, and
  // nothing has been sent. Then the parts are locked one at a time. A part that cannot be started after another has been leaves that one under
  // way, and the answer says which were started and which were not (a part started whose Bitcoin send failed is kept, and sent again by the tend).
  async function sweep({ legs, notes: all, id = null }) {
    if (!legs.length) throw new Error('fastbridge: no part to start');
    for (const l of legs) if (!(Number(l.quote.validUntil) > clock() + margin)) throw new Error('the quote expired');
    const sweepId = id || (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10));
    const held = await Promise.allSettled(legs.map((l) => clientFor(l.provider.ref).reserve(l.quote)));
    const no = held.findIndex((h) => h.status === 'rejected');
    if (no >= 0) {
      const why = String((held[no].reason && held[no].reason.message) || held[no].reason || '');
      throw Object.assign(new Error(`${legs[no].provider.name || 'a provider'} cannot hold its part of the bridge${why ? `: ${why.replace(/^the provider cannot hold that amount:?\s*/, '')}` : ''}`), { code: 'sweep-hold', leg: no, provider: legs[no].provider });
    }
    const avoid = new Set(all.map(outpoint)), started = [];
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i], meta = { sweep: { id: sweepId, part: i + 1, of: legs.length } };
      let rec = null, unsent = false;
      try {
        rec = await clientFor(l.provider.ref).start({ quote: l.quote, notes: l.notes, avoid: new Set(avoid), reserved: true, meta });
      } catch (error) {
        // the lock was stored and its send failed: it is the swap's own record now, sent again while the page is open
        rec = (await store.list()).find((r) => r.sweep && r.sweep.id === sweepId && r.sweep.part === i + 1) || null;
        if (!rec) {
          if (!started.length) throw error;
          return { id: sweepId, started, failed: legs.slice(i).map((x, j) => ({ leg: i + j, provider: x.provider, amount: x.quote.btcValue, error: j === 0 ? error : new Error('not started: the part before it could not be') })) };
        }
        unsent = true;
      }
      started.push({ rec, provider: l.provider, leg: i, ...(unsent ? { unsent } : {}) });
      for (const k of rec.feeInputs || []) avoid.add(outpoint(k));
    }
    return { id: sweepId, started, failed: [] };
  }
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
  return { quoteAll, start, cost, sweep, sweepCost, tick, run, records, recover, clientFor };
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
  if (opens == null) return 'Your TAC is safe. The lock comes back to your address when its timelock ends, about a day after it confirmed.';
  const left = opens - now;
  if (left <= 0) return 'Your TAC is safe. Its lock is due back now. Open Tacit signed in with the same wallet and it is sent back to your address.';
  const h = left / 3600;
  const when = h >= 1.5 ? `in about ${Math.round(h)} hours` : h >= 0.75 ? 'in about an hour' : 'within the hour';
  return `Your TAC is safe. The lock comes back to your address ${when}: open the app then and it is sent back.`;
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
  // (a swap that has waited ten minutes or more on Ethereum nodes that do not agree says so)
  if (!ended && rec.nodesSince != null && now - rec.nodesSince >= 600) detail = [detail, 'The Ethereum nodes this page reads have not agreed on this swap for a while, so it is read again until two of them do. Nothing is decided on one node’s word, and a refund still goes out at its time.'].filter(Boolean).join(' ');
  return {
    id: rec.id, phase: rec.phase, title, detail,
    at, steps: STEPS, ended, returned: back, amount: rec.amount, receive: back ? '0' : rec.evmAmount, created: rec.created,
    lockTxid: rec.lock?.txid || null, updated: rec.updated || null, error: waitingOnTimelock ? null : (rec.lastError || null), recovered: !!rec.recovered,
    opens: back && !ended ? opensAt(rec) : null,           // when the lock is due back (seconds), for a bridge that did not go through
    sweep: rec.sweep || null,                              // { id, part, of } for a part of a bridge split across providers
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
