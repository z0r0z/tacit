
export const TAKE_VB = 750;
export const takeSatsAt = (feeRate) => 546 + Math.ceil(TAKE_VB * feeRate * 2);
const FEE_WARM_MS = 30000;

import { riskConfig, riskFee, riskBps, isTac, makeRiskScreen } from './fastbridge-risk.js';
import { makeWatchdog } from './fastbridge-watch.js';
import { makeEthereumLocker, confValue } from './fastbridge-el.js';
import { isSats } from './adaptor-xswap.js';
import { deriveLock } from './adaptor-btc-lock.js';
import { secp, sha256, hmac, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';

const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const te = new TextEncoder();

// A quote whose id carries its own terms: a version, when it was made and until when it stands, the fee of the take, the two amounts and a nonce, then a MAC over
// those and this side's fixed terms under a key of its seed. Such a quote is stored only once it holds something (a hold, a lock seen for it), and is read back
// from its id until then; a quote id of 32 hex digits is one stored when it was given (as every quote was before), and is read from the store.
export const SEALED_QUOTE = /^01[0-9a-f]{120}$/;
const LEGACY_QUOTE = /^[0-9a-f]{32}$/;
export const isQuoteId = (v) => LEGACY_QUOTE.test(String(v)) || SEALED_QUOTE.test(String(v));
const WIDTHS = [8, 8, 8, 16, 32];                                     // created, validUntil, takeSats, btcValue, evmAmount (hex digits)

// `macKey`: the key a quote's id is sealed with (makeLpService derives it from the seed); without one every quote is stored when it is given
export function makeQuoter({ store, now, params, macKey = null }) {
  const p = params;
  const risk = p.riskPricing == null ? null : riskConfig(p.riskPricing);
  if (risk && (!isTac(p.btcAsset) || !isTac(p.evmAsset) || (p.rate != null && (typeof p.rate === 'function' || BigInt(p.rate.num ?? 1) !== 1n || BigInt(p.rate.den ?? 1) !== 1n)) || typeof p.flatFee === 'function')) throw new Error('risk pricing requires fixed TAC/TAC terms');
  const min = BigInt(p.minAmount), max = BigInt(p.maxAmount), bps = BigInt(p.feeBps ?? 0);
  // `rate` is { num, den } (what the provider's side pays for one unit of what it takes), or a function that gives that now (dapp/fastbridge-rate.js feed.rate):
  // a price that moves with the market. A function that has none (its sources are down or disagree) means no quote, and the page is told to ask again.
  // the flat part of the fee: a number, or a function that gives it now (a provider whose flat part follows its own costs); read per quote, so a quote given keeps what it was priced at
  if (risk && (bps < 0n || bps + BigInt(riskBps(risk)) > BigInt(risk.maxTotalBps))) throw new Error('risk pricing exceeds configured ceiling');
  const flatNow = () => BigInt((typeof p.flatFee === 'function' ? p.flatFee() : p.flatFee) ?? 0);
  const rateNow = () => {
    const r = typeof p.rate === 'function' ? p.rate() : p.rate;
    if (typeof p.rate === 'function' && !r) throw Object.assign(new Error('the provider has no price for this pair right now'), { status: 503, retry: true });
    return { num: BigInt(r?.num ?? 1), den: BigInt(r?.den ?? 1) };
  };

  function price(amount, riskClass) {
    const a = BigInt(amount);
    if (a < min || a > max) throw Object.assign(new Error(`the amount must be between ${min} and ${max}`), { status: 400 });
    const { num, den } = rateNow();
    const fee = risk ? riskFee(a, bps, flatNow(), risk, riskClass) : (a * bps) / 10000n + flatNow();
    const out = ((a - fee) * num) / den;
    if (a <= fee || out <= 0n) throw Object.assign(new Error('the amount does not cover the fee'), { status: 400 });
    return { btcValue: a, evmAmount: out, fee };
  }

  const inLock = (takeSats) => p.takeInLock === true && Number(takeSats) > 0;
  const macOf = (body) => bytesToHex(hmac(sha256, macKey, te.encode(['tacit-fastbridge-quote-v1', body, p.claimPub, p.btcAsset, p.evmAsset, p.csvBlocks, p.evmWindowSecs].join('|')))).slice(0, 32);
  const sealedId = (q) => {
    const parts = [q.created, q.validUntil, q.takeSats, q.btcValue, q.evmAmount].map((v, i) => BigInt(v).toString(16).padStart(WIDTHS[i], '0'));
    if (parts.some((h, i) => h.length !== WIDTHS[i])) return null;
    const body = '01' + parts.join('') + randomHex(8);
    return body + macOf(body);
  };
  // the quote a sealed id stands for, with this side's fixed terms as they are now; null for an id this key did not seal
  function unseal(id) {
    if (!macKey || !SEALED_QUOTE.test(String(id))) return null;
    const body = id.slice(0, 90), mac = macOf(body);
    let diff = 0;
    for (let i = 0; i < 32; i++) diff |= mac.charCodeAt(i) ^ id.charCodeAt(90 + i);
    if (diff) return null;
    let at = 2;
    const [created, validUntil, takeSats, btcValue, evmAmount] = WIDTHS.map((w) => { const v = BigInt('0x' + body.slice(at, at + w)); at += w; return v; });
    const q = {
      id, btcAsset: p.btcAsset, btcValue: String(btcValue), evmAsset: p.evmAsset, evmAmount: String(evmAmount), claimPub: p.claimPub, csvBlocks: p.csvBlocks,
      evmWindowSecs: p.evmWindowSecs, minConfs: p.minConfsFor(btcValue), takeSats: Number(takeSats), created: Number(created), validUntil: Number(validUntil),
    };
    if (inLock(q.takeSats)) q.takeInLock = true;
    q.legVouts = 1;      // (as the quote given says)
    return q;
  }

  async function quote(amount, riskClass) {
    const { btcValue, evmAmount } = price(amount, riskClass);
    const q = {
      id: randomHex(16), btcAsset: p.btcAsset, btcValue: String(btcValue), evmAsset: p.evmAsset, evmAmount: String(evmAmount),
      claimPub: p.claimPub, csvBlocks: p.csvBlocks, evmWindowSecs: p.evmWindowSecs, minConfs: p.minConfsFor(btcValue),
      takeSats: p.takeSats ? await p.takeSats() : 0, created: now(), validUntil: now() + (p.validSecs ?? 600),
    };
    // a provider that takes the fee of its take from a second output of the lock's own script says so; a page that does not know the word locks as it always did
    if (inLock(q.takeSats)) q.takeInLock = true;
    // this side answers a lock at any output of a transaction that holds several (the swap id names the output: adaptor-xswap.js legSwapId), and weighs its confirmations by
    // the total the transaction locks (fastbridge-el.js confValue): a page splits a swap across providers only among those that say so
    q.legVouts = 1;
    // (sealed, it costs this side nothing to give: nothing is stored until it is used)
    const sealed = macKey ? sealedId(q) : null;
    if (sealed) { q.id = sealed; return q; }
    await store.put(q);
    return q;
  }
  function maxAmountFor(outAvail) {
    const out = BigInt(outAvail);
    const fits = (a) => { try { return price(a, risk ? 'clean' : undefined).evmAmount <= out; } catch { return false; } };
    if (!fits(min)) return 0n;
    let lo = min, hi = max;
    while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (fits(mid)) lo = mid; else hi = mid - 1n; }
    return lo;
  }
  // a stored quote (one given before quotes were sealed, or a sealed one kept for what it holds) as it was kept; a sealed one not stored, from its id
  const get = async (id) => {
    if (LEGACY_QUOTE.test(String(id))) return store.get(id);
    const q = unseal(id);
    return q ? (await store.get(id)) || q : null;
  };
  return { price, quote, get, maxAmountFor, flat: flatNow, sealed: (id) => !!unseal(id) };
}

const TERMINAL = new Set(['done', 'refunded', 'rejected', 'aborted', 'lost']);
const DAY = 86400;
const isId = isQuoteId;
const cannotTake = () => Object.assign(new Error('the provider cannot take that amount right now'), { status: 400 });

export function makeLpService({ seed, btc, evm, swaps, quoteStore, config, now = () => Math.floor(Date.now() / 1000), log = () => {}, alert = () => {} }) {
  // a lock of plain sats pays no coin to the provider for its take: the take's fee comes out of the lock itself (dapp/adaptor-btc-tx.js claimSats)
  const sats = isSats(config.quote.btcAsset);
  const risk = config.quote.riskPricing == null ? null : riskConfig(config.quote.riskPricing);
  if (risk && typeof config.policy.riskLineage !== 'function') throw new Error('risk pricing requires a lineage reader');
  // Construct the screen from the same fee settings as the quoter, not a caller-supplied fee rule.
  const riskScreen = risk ? makeRiskScreen(config.policy.riskLineage, risk, config.quote.feeBps ?? 0, config.quote.flatFee ?? 0) : null;
  const takeSats = btc.feeRate && !sats ? async () => takeSatsAt(await btc.feeRate()) : null;
  const seedBytes = seed instanceof Uint8Array ? seed : hexToBytes(String(seed).replace(/^0x/, ''));
  const quoter = makeQuoter({ store: quoteStore, now, macKey: hmac(sha256, seedBytes, te.encode('tacit-fastbridge-quote-mac-v1')), params: { ...config.quote, ...(risk ? { riskPricing: risk } : {}), claimPub: config.claimPub, csvBlocks: config.csvBlocks, evmWindowSecs: config.policy.evmWindowSecs, minConfsFor: config.policy.minConfsFor, takeSats } });
  // `perClient`: the reservations with no lock named yet that one client address holds at once (`perBoard` for the requests that come through a board,
  // which name no address); a new one past that lets go of the client's oldest, so a user who asks again is answered and one address holds a few at most
  const hold = { reserveSecs: 300, extendSecs: 7200, maxUnbackedShare: 0.5, perClient: 2, perBoard: 4, ...(config.reserve || {}) };
  let holdSeq = 0;
  const refreshSecs = config.inventory?.refreshSecs ?? 60;
  const reservations = new Map();
  // the transactions looked at for quotes whose hold is gone (/extend), and the explorer reads all of those may make
  const lateLooks = new Map();
  const pending = new Map();
  const published = new Map();
  const checking = new Map();
  const offerBudgetMs = config.offerBudgetMs ?? 8000;
  // A budget of reads, refilled at `cap` a `perSecs` on this side's clock: for the explorer reads a request makes when nothing held already pays for them
  const budget = (cap, perSecs) => { let n = cap, at = null; return () => { const t = now(); if (at != null) n = Math.min(cap, n + ((t - at) * cap) / perSecs); at = t; if (n < 1) return false; n -= 1; return true; }; };
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const lateRead = budget(hold.lateReads ?? 30, 60);
  // An offer for a lock that is not the one /extend named for its quote costs explorer reads that nothing held pays for: those share a budget, and a transaction
  // found missing is not looked for again for `offerMissSecs`. (An offer through a board comes with no address, so no per-address bucket stands in front of it.)
  const offerRead = budget(config.offerReads ?? 30, 60), offerMisses = new Map(), offerMissSecs = config.offerMissSecs ?? 30;
  const counter = { publishEvmOffer: async (id, offer) => { published.set(id, offer); } };
  const graceSecs = Number(config.quote?.graceSecs) || 0;
  // A quote priced from the market (`quote.rate` a function) is not answered at its old price for long after its time: past `graceSecs` (and any hold) an offer
  // is answered only for a lock this side saw before the quote ran out (named to /extend in time, or confirmed in a block by then), up to `lateSecs` after it, and
  // only while the price today pays no more than `lateMoveBps` over the quote's. A fixed price (the TAC provider's) keeps its grace as it was.
  const priced = typeof config.quote?.rate === 'function';
  const lateSecs = Number(config.quote?.lateSecs ?? 21600), lateMoveBps = BigInt(config.quote?.lateMoveBps ?? 100);
  const marketHolds = (q) => BigInt(q.evmAmount) * 10000n <= quoter.price(q.btcValue).evmAmount * (10000n + lateMoveBps);
  async function seenInTime(q, offer) {
    const txid = offer && offer.btc && String(offer.btc.txid || '').toLowerCase(), by = q.validUntil + graceSecs;
    if (!txid) return false;
    if (q.seenTxid === txid && q.seenAt <= by) return true;
    if (!btc.status || !btc.blockTime) return false;
    const st = await btc.status(txid);
    return st.confirmations > 0 && (await btc.blockTime(st.height)) <= by;
  }
  const quotes = {
    get: async (id, { offer = null } = {}) => {
      const q = await quoter.get(id);
      if (!q) return q;
      const r = reservations.get(id);
      const until = Math.max(q.validUntil + graceSecs, r ? r.until : 0);
      if (!priced) return until > q.validUntil ? { ...q, validUntil: until } : q;
      const t = now();
      if (t <= q.validUntil) return q;
      if (t <= q.validUntil + graceSecs) return { ...q, validUntil: until };
      // (a price that cannot be read now is a reason to ask again, not to refuse: the error is the caller's retry)
      if (t <= until && marketHolds(q)) return { ...q, validUntil: until };
      if (t <= q.validUntil + lateSecs && (await seenInTime(q, offer)) && marketHolds(q)) return { ...q, validUntil: t };
      return q;
    },
  };
  // (an early record waits for its confirmations no longer than an extended reservation holds the payout)
  const el = makeEthereumLocker({ seed, now, store: swaps, quotes, btc, evm, counter, policy: { earlyConfirmWaitSecs: hold.extendSecs, ...config.policy, ...(riskScreen ? { screen: async (inputs, quote) => {
    const refusal = await riskScreen(inputs, quote);
    return refusal || (config.policy.screen ? await config.policy.screen(inputs, quote) : null);
  } } : {}) } });
  const health = { ok: true, lastTick: 0, lastError: null };
  const reported = new Set(), lastAlert = new Map(), unreadSince = new Map();

  let chain = Promise.resolve();
  const exclusive = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

  const inv = { at: -Infinity, held: null, p: null };
  function readInventory(maxAge = refreshSecs) {
    if (now() - inv.at < maxAge) return Promise.resolve(inv);
    if (inv.p) return inv.p;
    inv.p = (async () => {
      try {
        if (evm.available) inv.held = await evm.available();
        inv.at = now();
      } finally { inv.p = null; }
      return inv;
    })();
    return inv.p;
  }
  let owed = null;
  const stale = () => { inv.at = -Infinity; owed = null; };

  // what the open swaps promise, read from their records again when one changes (stale) or after `owedSecs`, not for every quote and every /info
  async function owedBySwaps() {
    if (owed && now() - owed.at < (config.owedSecs ?? 15)) return owed;
    let sum = 0n, count = 0;
    for (const rec of await swaps.list()) {
      if (TERMINAL.has(rec.phase)) continue;
      count++;
      if (!rec.lock && (rec.phase === 'accepted' || rec.phase === 'locking')) sum += BigInt(rec.offer.evm.amount);
    }
    owed = { at: now(), sum, count };
    return owed;
  }
  async function promised() {
    const t = now();
    let { sum, count } = await owedBySwaps();
    for (const [id, r] of reservations) {
      if (r.until <= t) reservations.delete(id);
      else { sum += r.amount; count++; }
    }
    for (const [id, h] of pending) {
      if (h.until <= t) pending.delete(id);
      else { sum += h.amount; count++; }
    }
    return { sum, count };
  }
  async function lockable() {
    if (!evm.ready) return;
    const r = await evm.ready().catch(() => ({ ok: true }));
    if (!r.ok) throw Object.assign(new Error(`the provider cannot lock right now (${r.why})`), { status: 503, retry: true });
  }
  async function capacity(payout) {
    await lockable();
    const i = await readInventory(), p = await promised();
    if (i.held != null && payout > i.held - p.sum) throw cannotTake();
  }
  async function unbackedFits(payout) {
    const i = await readInventory();
    if (i.held == null) return true;
    let unbacked = 0n;
    // (a hold for a lock of sats that has not confirmed is not yet backed by it: such a lock can still be replaced by a payment elsewhere)
    for (const r of reservations.values()) if ((!r.txid || (sats && !lockTimes.has(r.txid))) && r.until > now()) unbacked += r.amount;
    return unbacked === 0n || unbacked + payout <= (i.held * BigInt(Math.round(hold.maxUnbackedShare * 100))) / 100n;
  }
  async function availableAmount() {
    try {
      if (evm.ready && !(await evm.ready()).ok) return 0n;
      const i = await readInventory(), p = await promised();
      if (i.held == null) return null;
      return quoter.maxAmountFor(i.held > p.sum ? i.held - p.sum : 0n);
    } catch { return null; }
  }
  // the output a quote's lock pays: { T, lockerXonly } from the user, this side's claim key, the quote's timelock (hex scriptPubKey, or null without the terms)
  const hex64 = (h) => /^[0-9a-f]{64}$/.test(String(h || '').replace(/^0x/, '').toLowerCase());
  const lockSpkOf = (lock, q) => {
    if (!lock || !q || !btc.prims || !btc.wallet || !hex64(lock.lockerXonly) || !/^0[23][0-9a-f]{64}$/i.test(String(lock.T || '').replace(/^0x/, ''))) return null;
    const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
    return bytesToHex(deriveLock({ prims: btc.prims, claimerPub: btc.wallet.pub, T: secp.ProjectivePoint.fromHex(strip(lock.T)), lockerXonly: hexToBytes(strip(lock.lockerXonly)), csvBlocks: Number(q.csvBlocks) }).spk);
  };
  // A quote is stored with what it holds. A sealed one that holds nothing (no hold, no lock seen for it) is not kept: its id gives it back.
  const keep = async (id, also = {}) => {
    const q = await quoter.get(id), r = reservations.get(id);
    if (!q) return;
    const rec = { ...q, reservedUntil: r ? r.until : 0, reservedTxid: r ? r.txid : null, ...also };
    if (quoter.sealed(id) && !(rec.reservedUntil > now()) && !rec.seenTxid) { if (quoteStore.del) await quoteStore.del(id); return; }
    await quoteStore.put(rec);
  };

  async function start() {
    const open = await swaps.list(), used = new Set(open.map((r) => r.quoteId)), txids = new Set(open.map((r) => r.lockTxid).filter(Boolean));
    for (const rec of open) if (evm.reserve) evm.reserve(rec);
    for (const q of (await quoteStore.list()).sort((a, b) => (a.created || 0) - (b.created || 0))) {
      if (!(q.reservedUntil > now()) || used.has(q.id)) continue;
      if (q.reservedTxid && txids.has(q.reservedTxid)) { await quoteStore.put({ ...q, reservedUntil: 0, reservedTxid: null }); continue; }
      if (q.reservedTxid) txids.add(q.reservedTxid);
      reservations.set(q.id, { amount: BigInt(q.evmAmount), until: q.reservedUntil, txid: q.reservedTxid || null });
    }
    await dropDeadHolds().catch(() => {});
  }

  const lockTimes = new Map();
  async function dropDeadHolds() {
    const maxAge = config.policy.holdAgeSecs ?? config.policy.maxOfferAgeSecs ?? 3600;
    const gone = [];
    for (const [id, r] of reservations) {
      if (!r.txid || !btc.status || !btc.blockTime) continue;
      let at = lockTimes.get(r.txid);
      if (at == null) {
        try { const st = await btc.status(r.txid); if (st.confirmations > 0) { at = await btc.blockTime(st.height); lockTimes.set(r.txid, at); } } catch { continue; }
      }
      if (at != null && now() - at > maxAge) gone.push(id);
    }
    for (const id of gone) { reservations.delete(id); await keep(id); }
    if (gone.length) { stale(); log({ level: 'info', msg: 'holds for locks too old to answer were let go', count: gone.length }); }
    return gone.length;
  }
  const held = async () => (await promised()).sum;
  const free = async () => { const i = await readInventory(), p = await promised(); return i.held == null ? null : i.held > p.sum ? i.held - p.sum : 0n; };

  let lastPrune = 0, quotesHeld = null;
  const maxQuotes = Number(config.policy?.maxQuotes) || 20000;
  async function prune() {
    const full = quotesHeld !== null && quotesHeld >= maxQuotes;
    if (!quoteStore.del || now() - lastPrune < (full ? 300 : 3600)) return;
    lastPrune = now();
    for (const [id, r] of reservations) if (r.until <= now()) reservations.delete(id);
    const used = new Set((await swaps.list()).map((r) => r.quoteId));
    // a quote no swap uses is of no use once the longest an offer is answered after it has passed: that is kept for a day when the store is not full
    const dead = full ? Math.max(graceSecs, lateSecs) + 3600 : 2 * DAY;
    let kept = 0;
    // (a sealed quote that holds nothing now is not kept at all: its id gives it back, and the store holds only what it must)
    const idle = (q) => quoter.sealed(q.id) && !q.seenTxid && !reservations.has(q.id);
    for (const q of await quoteStore.list()) { if ((idle(q) || q.validUntil + dead < now()) && !used.has(q.id) && !reservations.has(q.id)) await quoteStore.del(q.id); else kept++; }
    quotesHeld = kept;
  }

  let feeWarned = false;
  const warmUp = () => {
    if (btc.feeRate) btc.feeRate(FEE_WARM_MS).then(() => { feeWarned = false; }, (e) => { if (!feeWarned) log({ level: 'warn', msg: 'no fee estimate', error: String((e && e.message) || e).slice(0, 300) }); feeWarned = true; });
    readInventory(refreshSecs / 2).catch(() => {});
  };

  let lockableSaid = true;
  async function sayLockable() {
    if (!evm.ready) return;
    const r = await evm.ready().catch(() => ({ ok: true }));
    if (r.ok !== lockableSaid) { lockableSaid = r.ok; alert({ level: r.ok ? 'info' : 'alert', msg: r.ok ? 'the provider can lock again' : 'the provider is not taking bridges', why: r.ok ? null : r.why }); }
  }

  let capacitySaid = -Infinity, lowSaid = -Infinity, lowEthSaid = -Infinity;
  async function sayCapacity() {
    if (now() - capacitySaid < 300) return;
    capacitySaid = now();
    const i = await readInventory(), p = await promised();
    log({ level: 'info', msg: 'capacity', held: i.held == null ? null : String(i.held), promised: String(p.sum), open: p.count, holds: reservations.size });
    if (config.lowFree != null && i.held != null) {
      const free = i.held > p.sum ? i.held - p.sum : 0n;
      if (free < BigInt(config.lowFree) && now() - lowSaid >= (config.alertSecs ?? 3600)) {
        lowSaid = now();
        alert({ level: 'warn', msg: 'the provider is running out of private TAC to lend', free: String(free), held: String(i.held), promised: String(p.sum) });
      }
    }
    // the ETH of the account that sends its own settles, in wei (`lowEth`): said before it is short, and again each alertSecs while it stays low. The
    // relay not sending settles costs about 0.0002 ETH for each one this account sends, and when it is out the provider stops taking bridges
    if (config.lowEth != null && evm.ownEth) {
      const eth = await evm.ownEth().catch(() => null);
      if (eth != null && eth < BigInt(config.lowEth) && now() - lowEthSaid >= (config.alertSecs ?? 3600)) {
        lowEthSaid = now();
        alert({ level: 'warn', msg: 'the provider is running low on ETH for the settles it sends itself', eth: String(eth) });
      }
    }
  }

  // the watchdog (fastbridge-watch.js): a swap whose step has not moved for longer than it takes is read afresh and said. 'offered' waits on the user's claim, which
  // may rightly never come (the lock is refunded at its deadline): it is read afresh after half an hour, and alerted on only when its reads fail.
  const WATCH_EL = { locking: 600, locked: 300, offered: 1800, taking: 2400, refunding: 900 };
  const watchdog = makeWatchdog({
    now, log, alert,
    budget: (r) => (r.phase === 'accepted' ? (Number(r.lockConfs || 0) >= Math.max(1, Number(config.policy.minConfsFor(confValue(r)))) ? 600 : null) : WATCH_EL[r.phase] ?? null),
    keyOf: (r) => JSON.stringify([r.phase, Number(r.lockConfs || 0), !!(r.lock && r.lock.jobId), !!r.evmOffer, r.take ? r.take.txid : null, !!r.refund]),
    quiet: (r) => r.phase === 'offered' && !r.lastError && !r.unread,
    forget: () => { if (evm.forget) evm.forget(); },
    kick: (r) => el.poke(r),
  });
  async function tick() {
    warmUp();
    sayLockable().catch(() => {});
    sayCapacity().catch(() => {});
    try {
      await dropDeadHolds().catch(() => {});
      const recs = await swaps.list();
      for (const p of (swaps.problems && swaps.problems()) || []) if (!reported.has(p.id)) { reported.add(p.id); alert({ level: 'alert', msg: 'a swap record cannot be read', id: p.id, error: p.error }); }
      for (const rec of recs) {
        if (TERMINAL.has(rec.phase)) continue;
        const before = rec.phase, hadLock = !!rec.lock, unreadBefore = rec.unread || 0;
        let next;
        try { next = await el.step(rec); } catch (e) { log({ level: 'error', msg: 'swap step threw', id: rec.id, error: String((e && e.message) || e).slice(0, 200) }); continue; }
        if (next.phase !== before) log({ level: 'info', msg: 'swap', id: next.id, from: before, to: next.phase, why: next.why });
        if (next.phase !== before || (!hadLock && next.lock)) stale();
        if (next.phase === 'lost') alert({ level: 'alert', msg: 'a lock was claimed without revealing t', id: next.id });
        else if (next.unread && next.unread !== unreadBefore && (next.unread === 1 || next.unread % 8 === 0)) alert({ level: 'alert', msg: 'a pool lock was spent and its claim reads without t so far: read again until the Bitcoin lock\'s refund nears', id: next.id, lockTxid: next.lockTxid, looks: next.unread });
        // The pool lock was spent and the claim that spent it cannot be read (a settle sent in a way this side cannot read yet): t is in that claim, and the user's
        // Bitcoin lock must be taken with it before the user's refund opens. Said after a few minutes (the events may only be late), and again every quarter hour.
        if (/lock is spent, and the settle that spent it is not found/.test(next.lastError || '')) {
          const t = now(), since = unreadSince.get(next.id) ?? t;
          unreadSince.set(next.id, since);
          if (t - since >= 600 && t - (lastAlert.get(next.id + '|unread') ?? -Infinity) >= 900) {
            lastAlert.set(next.id + '|unread', t);
            alert({ level: 'alert', msg: 'a pool lock was spent and the claim that spent it cannot be read: the Bitcoin lock must be taken before its refund opens', id: next.id, lockNu: next.lock && next.lock.lockNu, lockTxid: next.lockTxid, refundOpensAtHeight: next.lockHeight != null ? next.lockHeight + next.csvBlocks - 1 : null });
          }
        } else unreadSince.delete(next.id);
        // The Ethereum nodes have not agreed on this swap for ten minutes (too few answer, or they differ): it waits and is read again, and nothing ends on one
        // node's word. Said again every quarter hour while it lasts: the nodes the provider reads (agreeRpcs) may need looking at.
        if (next.nodesSince != null && now() - next.nodesSince >= 600 && now() - (lastAlert.get(next.id + '|nodes') ?? -Infinity) >= 900) {
          lastAlert.set(next.id + '|nodes', now());
          alert({ level: 'alert', msg: 'the Ethereum nodes have not agreed on a swap for a while: it waits and is read again', id: next.id, phase: next.phase, since: next.nodesSince, error: next.lastError || null });
        }
        if (next.lastError && next.lastError !== rec.lastError) log({ level: 'warn', msg: 'swap step failed', id: next.id, phase: next.phase, error: next.lastError });
        if (!TERMINAL.has(next.phase)) await watchdog.look(next);
        if (next.phase === 'taking' || next.phase === 'refunding') {
          const every = config.alertSecs ?? 3600, key = next.id + '|' + next.phase, t = now();
          if (t - (next.phaseAt || next.created) > every && t - (lastAlert.get(key) ?? -Infinity) >= every) {
            lastAlert.set(key, t);
            alert({ level: 'alert', msg: 'a swap has waited long in ' + next.phase, id: next.id, error: next.lastError || null });
          }
        }
      }
      await prune().catch(() => {});
      health.ok = true; health.lastError = null;
    } catch (e) { health.ok = false; health.lastError = String((e && e.message) || e).slice(0, 200); log({ level: 'error', msg: 'tick failed', error: health.lastError }); }
    health.lastTick = now();
  }

  async function lockStands(rec) {
    try { const st = await btc.status(rec.lockTxid); return st.confirmations >= Math.max(1, Number(config.policy.minConfsFor(confValue(rec)))); } catch { return true; }
  }
  const offerOf = async (id) => published.get(id) || (await swaps.get(id))?.evmOffer || null;
  const reply = (body, status = 200) => ({ status, body });
  const no = (why, retry = false) => reply({ ok: false, retry, why });

  async function judgeOffer(body, q, sid, early = false) {
    let held = false;
    try {
      if (q && !(await swaps.get(sid))) {
        const have = reservations.get(q.id);
        if (have && have.until > now() && (!have.swapId || have.swapId === sid)) have.swapId = sid;
        else {
          try { await exclusive(async () => { await capacity(BigInt(q.evmAmount)); pending.set(sid, { amount: BigInt(q.evmAmount), until: now() + hold.reserveSecs }); held = true; }); } catch (e) { if (e.status) return { ok: false, retry: !!e.retry, why: e.message }; throw e; }
        }
      }
      const r = await el.receive({ quoteId: body.quoteId, offer: body.offer, early });
      const res = q ? reservations.get(q.id) : null;
      if (r.ok && res && res.swapId === sid && reservations.delete(q.id)) await keep(q.id);
      if (r.ok) stale();
      return r.ok ? { ok: true, phase: r.rec.phase } : { ok: false, retry: !!r.retry, why: r.why };
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 160);
      log({ level: 'error', msg: 'an offer could not be checked', id: sid, error: msg });
      return { ok: false, retry: true, why: `the lock could not be checked now: ${msg}` };
    } finally { if (held) pending.delete(sid); }
  }

  // A lock of plain sats named to /extend with its whole offer (the one the user sends once the lock is confirmed): taken as an early offer, checked against the
  // transaction as the explorers' mempool shows it, so this side's pool lock is built and proved while the block is awaited (fastbridge-el.js preStep). Nothing is
  // locked before the confirmations, and the record waits no longer for them than a reservation is held (earlyConfirmWaitSecs). Not awaited: the extension's
  // answer does not wait on it, and an offer that is not taken here is judged as always when it is sent.
  function takeEarly(body, q) {
    const offer = body && body.offer, sid = String((offer && offer.swapId) || '').toLowerCase().replace(/^0x/, '');
    if (!sats || config.early === false || !offer || typeof offer !== 'object' || !/^[0-9a-f]{72}$/.test(sid) || !q || JSON.stringify(offer).length > 12000) return;
    if (!offer.btc || String(offer.btc.txid || '').toLowerCase() !== String(body.txid)) return;
    judgeOffer({ quoteId: body.quoteId, offer }, q, sid, true).then((r) => { if (r && r.ok) log({ level: 'info', msg: 'early offer taken: the pool lock is built while the lock is confirmed', id: sid.slice(0, 80) }); }, () => {});
  }

  // a whole number of base units, written plainly: a decimal string with no leading zeros, or a safe integer
  const amountOk = (a) => (typeof a === 'string' && /^(0|[1-9]\d{0,29})$/.test(a)) || (Number.isSafeInteger(a) && a >= 0);

  async function handle({ method, path, body, client = null }) {
    try {
      if (method === 'GET' && path === '/health') return reply({ ok: health.ok, lastTick: health.lastTick, error: health.lastError }, health.ok ? 200 : 503);
      if (method === 'GET' && path === '/info') {
        const q = config.quote, a = await availableAmount();
        return reply({ v: 1, claimPub: config.claimPub, btcAsset: q.btcAsset, evmAsset: q.evmAsset, minAmount: String(q.minAmount), maxAmount: String(q.maxAmount), available: a == null ? null : String(a), feeBps: risk ? Number(q.feeBps ?? 0) + riskBps(risk) : q.feeBps, flatFee: String(quoter.flat() + (risk ? 1n : 0n)), csvBlocks: config.csvBlocks, evmWindowSecs: config.policy.evmWindowSecs, minClaimSecs: config.policy.minClaimSecs, reserveSecs: hold.reserveSecs, anyTac: config.anyTac !== false, ...(risk ? { riskPricing: risk } : {}) });
      }
      if (method === 'POST' && path === '/quote') {
        if (!body || !amountOk(body.amount)) return reply({ error: 'amount must be a whole number' }, 400);
        return reply(await exclusive(async () => { await capacity(quoter.price(body.amount, body.riskClass).evmAmount); const made = await quoter.quote(body.amount, body.riskClass); if (quotesHeld !== null && !quoter.sealed(made.id)) quotesHeld++; return made; }));
      }
      if (method === 'POST' && path === '/reserve') {
        if (!body || !isId(body.quoteId)) return reply({ error: 'quoteId is required' }, 400);
        return await exclusive(async () => {
          const q = await quoter.get(body.quoteId), have = reservations.get(body.quoteId);
          if (!q) return no('unknown quote');
          if (have && have.until > now()) return reply({ ok: true, until: have.until });
          if (now() > q.validUntil) return no('quote expired');
          if (quotesHeld !== null && quotesHeld >= maxQuotes) return no('the provider holds too many open quotes just now: ask again shortly', true);
          // the client's oldest holds past its allowance make room for this one, and are kept if this one cannot be made
          const who = client ? `ip:${client}` : 'board', cap = Number(client ? hold.perClient : hold.perBoard) || 0;
          const mine = [...reservations].filter(([, r]) => r.who === who && !r.txid && r.until > now()).sort((a, b) => a[1].seq - b[1].seq);
          const out = cap > 0 ? mine.slice(0, Math.max(0, mine.length - cap + 1)) : [];
          for (const [id] of out) reservations.delete(id);
          try { await capacity(BigInt(q.evmAmount)); if (!(await unbackedFits(BigInt(q.evmAmount)))) throw cannotTake(); } catch (e) {
            for (const [id, r] of out) reservations.set(id, r);
            if (e.status) return no(e.message);
            throw e;
          }
          const until = now() + hold.reserveSecs;
          reservations.set(q.id, { amount: BigInt(q.evmAmount), until, txid: null, who, seq: ++holdSeq });
          for (const [id] of out) await keep(id);
          if (quotesHeld !== null && !(await quoteStore.get(q.id))) quotesHeld++;
          await keep(q.id);
          return reply({ ok: true, until });
        });
      }
      if (method === 'POST' && path === '/extend') {
        if (!body || !isId(body.quoteId) || !/^[0-9a-f]{64}$/.test(String(body.txid))) return reply({ error: 'quoteId and txid are required' }, 400);
        const held = reservations.get(body.quoteId), live = !!held && held.until > now();
        if (live && held.txid === body.txid) return reply({ ok: true, until: held.until });
        if (live && held.txid) return no('this reservation is held for another transaction');
        if (live) {
          // each transaction looked at is a read from the explorers, so a reservation looks at a few, not at any number
          if ((held.looks = (held.looks || 0) + 1) > (hold.maxLooks ?? 20)) return no('this reservation has looked at enough transactions');
        } else {
          // The hold is gone (let go for a newer one of the same client, or run out), and a lock may already pay this quote: while the quote and its grace
          // stand, a transaction that pays this quote's own lock stands for the hold, so letting go of holds nobody has locked for never turns away one that has
          const q = await quoter.get(body.quoteId);
          if (!q || now() > q.validUntil + graceSecs || !body.lock) return no('no reservation');
          if (q.seenTxid && q.seenTxid !== body.txid) return no('this reservation is held for another transaction');
          if (q.seenTxid !== body.txid) {
            const n = (lateLooks.get(body.quoteId) || 0) + 1;
            if (lateLooks.size >= 4096 && !lateLooks.has(body.quoteId)) for (const [k] of lateLooks) { lateLooks.delete(k); if (lateLooks.size < 2048) break; }
            lateLooks.set(body.quoteId, n);
            if (n > (hold.maxLateLooks ?? 4)) return no('this reservation has looked at enough transactions');
            if (!lateRead()) return no('the provider is busy just now', true);
          }
        }
        const tx = await btc.fetchTx(body.txid).catch(() => null);
        return await exclusive(async () => {
          const r0 = reservations.get(body.quoteId), r = r0 && r0.until > now() ? r0 : null;
          if (r && r.txid && r.txid !== body.txid) return no('this reservation is held for another transaction');
          if (r && r.txid === body.txid) return reply({ ok: true, until: r.until });
          if (!r) {
            const q = await quoter.get(body.quoteId);
            if (!q || now() > q.validUntil + graceSecs || !body.lock) return no('no reservation');
          }
          if (!tx) return no('the lock transaction is not visible yet', true);
          // a lock of a note spends the note as its second input (the first is its commit); a lock of plain sats is an ordinary transaction
          if (!tx.vin || tx.vin.length < (sats ? 1 : 2)) return no('that is not a lock transaction');
          const q = await quoter.get(body.quoteId), take = Number((q && q.takeSats) || 0);
          if (take > 0 && btc.prims && btc.wallet) {
            const own = [...btc.prims.p2wpkhScript(btc.wallet.pub)].map((b) => b.toString(16).padStart(2, '0')).join('');
            // the fee of the take is paid to this address, or locked with the lock: an output of the lock's own script (the one the extension names)
            let inLock = null;
            if (!sats) { try { inLock = lockSpkOf(body.lock, q); } catch { inLock = null; } }
            const pays = (tx.vout || []).some((o) => { const s = String(o.scriptpubkey || '').toLowerCase(); return (s === own || (inLock && s === inLock)) && o.value >= take; });
            if (!pays) return no('that transaction does not pay the fee of the take');
          }
          // a hold of up to two hours is for a lock, so the transaction must pay the quoted amount to the lock of this quote: the Taproot output its terms make
          // (`lock`: the adaptor point and the refund key, with this side's claim key and the quote's timelock); any other output would hold the payout for nothing.
          // A lock that stands for a hold that is gone is checked so for a note too (its value is the note's, so only its script)
          if (sats || !r) {
            let spk = null;
            try { spk = lockSpkOf(body.lock, q); } catch { spk = null; }
            if (!spk) return no('that transaction does not pay the quoted amount to a Taproot lock: the extension names no lock');
            if (!(tx.vout || []).some((o) => String(o.scriptpubkey || '').toLowerCase() === spk && q && (!sats || o.value === Number(q.btcValue)))) return no('that transaction does not pay the quoted amount to a Taproot lock of this quote');
          }
          for (const [id, other] of reservations) if (id !== body.quoteId && other.txid === body.txid) return no('that transaction already holds another reservation');
          for (const rec of await swaps.list()) if (rec.lockTxid === body.txid) return no('that transaction is already a swap');
          if (!r) {
            // the lock is seen in time whatever comes of the hold (a late offer is weighed by this), and holds the payout as a reservation would while there is room
            await keep(body.quoteId, { seenTxid: body.txid, seenAt: q.seenTxid === body.txid ? q.seenAt : now() });
            try { await capacity(BigInt(q.evmAmount)); if (!(await unbackedFits(BigInt(q.evmAmount)))) throw cannotTake(); } catch (e) { if (e.status) return no(e.message, !!e.retry); throw e; }
            const until = now() + hold.extendSecs;
            reservations.set(body.quoteId, { amount: BigInt(q.evmAmount), until, txid: body.txid, who: 'lock', seq: ++holdSeq });
            stale();
            await keep(body.quoteId, { seenTxid: body.txid, seenAt: q.seenTxid === body.txid ? q.seenAt : now() });
            takeEarly(body, q);
            return reply({ ok: true, until });
          }
          r.txid = body.txid; r.until = Math.max(r.until, now() + hold.extendSecs);
          // when the lock was first seen: a late offer for it is weighed by this (quotes.get)
          await keep(body.quoteId, { seenTxid: body.txid, seenAt: now() });
          takeEarly(body, q);
          return reply({ ok: true, until: r.until });
        });
      }
      if (method === 'POST' && path === '/offer') {
        if (!body || typeof body.quoteId !== 'string' || !body.offer || typeof body.offer !== 'object') return reply({ error: 'quoteId and offer are required' }, 400);
        const q = isId(body.quoteId) ? await quoter.get(body.quoteId) : null;
        const sid = String(body.offer.swapId || '').toLowerCase().replace(/^0x/, '');
        const said = (r) => { log({ level: r.ok ? 'info' : 'warn', msg: r.ok ? 'offer accepted' : 'offer declined', id: sid.slice(0, 80), ...(r.ok ? {} : { retry: !!r.retry, why: String(r.why || '').slice(0, 200) }) }); return r; };
        if (!/^[0-9a-f]{72}$/.test(sid)) return reply(said(await judgeOffer(body, q, sid)));
        for (const [k, c] of checking) if (c.done && now() - c.at > 600) checking.delete(k);
        let c = checking.get(sid);
        const txid = String((body.offer.btc && body.offer.btc.txid) || '').toLowerCase();
        if (!c && q && !(await swaps.get(sid))) {
          const r = reservations.get(q.id), named = (r && r.until > now() && r.txid) || q.seenTxid || null;
          if (txid !== named) {
            for (const [k, until] of offerMisses) if (until <= now()) offerMisses.delete(k);
            if ((offerMisses.get(txid) || 0) > now()) return reply({ ok: false, retry: true, why: 'the lock transaction is not visible yet' });
            if (!offerRead()) return reply({ ok: false, retry: true, why: 'the provider is busy just now: ask again shortly' });
          }
        }
        if (!c) {
          c = { done: false, at: now() };
          c.p = judgeOffer(body, q, sid).then((r) => {
            c.done = true; c.at = now();
            if (!r.ok && r.retry && /not on the chain|not visible/.test(String(r.why || '')) && offerMisses.size < 4096) offerMisses.set(txid, now() + offerMissSecs);
            return said(r);
          });
          checking.set(sid, c);
        }
        const r = await Promise.race([c.p, sleepMs(offerBudgetMs).then(() => null)]);
        if (r === null) return reply({ ok: false, retry: true, why: 'the lock is still being checked: ask again in a few seconds' });
        checking.delete(sid);
        return reply(r);
      }
      const m = /^\/swap\/([0-9a-f]{72})(\/offer)?$/.exec(path);
      if (method === 'GET' && m) {
        if (m[2]) {
          const rec = await swaps.get(m[1]);
          if (rec && (rec.phase === 'locked' || rec.phase === 'offered') && !(await lockStands(rec))) return reply({ error: 'no offer yet' }, 404);
          const o = await offerOf(m[1]);
          return o ? reply(o) : reply({ error: 'no offer yet' }, 404);
        }
        const rec = await swaps.get(m[1]);
        return rec ? reply({ phase: rec.phase, why: rec.why || null }) : reply({ error: 'unknown swap' }, 404);
      }
      return reply({ error: 'not found' }, 404);
    } catch (e) {
      if (!e.status) log({ level: 'error', msg: 'a request failed', path, error: String((e && e.message) || e).slice(0, 160) });
      return reply({ error: e.status ? String(e.message) : 'the service could not answer' }, e.status || 500);
    }
  }

  return { el, quoter, start, tick, handle, health, offerOf, reservations, availableAmount, held, free, dropDeadHolds };
}
