
export const TAKE_VB = 750;
export const takeSatsAt = (feeRate) => 546 + Math.ceil(TAKE_VB * feeRate * 2);
const FEE_WARM_MS = 30000;

import { makeEthereumLocker } from './fastbridge-el.js';
import { isSats } from './adaptor-xswap.js';
import { deriveLock } from './adaptor-btc-lock.js';
import { secp, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';

const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

export function makeQuoter({ store, now, params }) {
  const p = params;
  const min = BigInt(p.minAmount), max = BigInt(p.maxAmount), flat = BigInt(p.flatFee ?? 0), bps = BigInt(p.feeBps ?? 0);
  // `rate` is { num, den } (what the provider's side pays for one unit of what it takes), or a function that gives that now (dapp/fastbridge-rate.js feed.rate):
  // a price that moves with the market. A function that has none (its sources are down or disagree) means no quote, and the page is told to ask again.
  const rateNow = () => {
    const r = typeof p.rate === 'function' ? p.rate() : p.rate;
    if (typeof p.rate === 'function' && !r) throw Object.assign(new Error('the provider has no price for this pair right now'), { status: 503, retry: true });
    return { num: BigInt(r?.num ?? 1), den: BigInt(r?.den ?? 1) };
  };

  function price(amount) {
    const a = BigInt(amount);
    if (a < min || a > max) throw Object.assign(new Error(`the amount must be between ${min} and ${max}`), { status: 400 });
    const { num, den } = rateNow();
    const fee = (a * bps) / 10000n + flat;
    const out = ((a - fee) * num) / den;
    if (a <= fee || out <= 0n) throw Object.assign(new Error('the amount does not cover the fee'), { status: 400 });
    return { btcValue: a, evmAmount: out, fee };
  }

  async function quote(amount) {
    const { btcValue, evmAmount } = price(amount);
    const q = {
      id: randomHex(16), btcAsset: p.btcAsset, btcValue: String(btcValue), evmAsset: p.evmAsset, evmAmount: String(evmAmount),
      claimPub: p.claimPub, csvBlocks: p.csvBlocks, evmWindowSecs: p.evmWindowSecs, minConfs: p.minConfsFor(btcValue),
      takeSats: p.takeSats ? await p.takeSats() : 0, created: now(), validUntil: now() + (p.validSecs ?? 600),
    };
    // a provider that takes the fee of its take from a second output of the lock's own script says so; a page that does not know the word locks as it always did
    if (p.takeInLock === true && q.takeSats > 0) q.takeInLock = true;
    await store.put(q);
    return q;
  }
  function maxAmountFor(outAvail) {
    const out = BigInt(outAvail);
    const fits = (a) => { try { return price(a).evmAmount <= out; } catch { return false; } };
    if (!fits(min)) return 0n;
    let lo = min, hi = max;
    while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (fits(mid)) lo = mid; else hi = mid - 1n; }
    return lo;
  }
  const get = async (id) => (/^[0-9a-f]{32}$/.test(String(id)) ? store.get(id) : null);
  return { price, quote, get, maxAmountFor };
}

const TERMINAL = new Set(['done', 'refunded', 'rejected', 'aborted', 'lost']);
const DAY = 86400;
const isId = (v) => /^[0-9a-f]{32}$/.test(String(v));
const cannotTake = () => Object.assign(new Error('the provider cannot take that amount right now'), { status: 400 });

export function makeLpService({ seed, btc, evm, swaps, quoteStore, config, now = () => Math.floor(Date.now() / 1000), log = () => {}, alert = () => {} }) {
  // a lock of plain sats pays no coin to the provider for its take: the take's fee comes out of the lock itself (dapp/adaptor-btc-tx.js claimSats)
  const sats = isSats(config.quote.btcAsset);
  const takeSats = btc.feeRate && !sats ? async () => takeSatsAt(await btc.feeRate()) : null;
  const quoter = makeQuoter({ store: quoteStore, now, params: { ...config.quote, claimPub: config.claimPub, csvBlocks: config.csvBlocks, evmWindowSecs: config.policy.evmWindowSecs, minConfsFor: config.policy.minConfsFor, takeSats } });
  // `perClient`: the reservations with no lock named yet that one client address holds at once (`perBoard` for the requests that come through a board,
  // which name no address); a new one past that lets go of the client's oldest, so a user who asks again is answered and one address holds a few at most
  const hold = { reserveSecs: 300, extendSecs: 7200, maxUnbackedShare: 0.5, perClient: 2, perBoard: 4, ...(config.reserve || {}) };
  let holdSeq = 0;
  const refreshSecs = config.inventory?.refreshSecs ?? 60;
  const reservations = new Map();
  const pending = new Map();
  const published = new Map();
  const checking = new Map();
  const offerBudgetMs = config.offerBudgetMs ?? 8000;
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
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
  const el = makeEthereumLocker({ seed, now, store: swaps, quotes, btc, evm, counter, policy: config.policy });
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
  const stale = () => { inv.at = -Infinity; };

  async function promised() {
    const t = now();
    let sum = 0n, count = 0;
    for (const rec of await swaps.list()) {
      if (TERMINAL.has(rec.phase)) continue;
      count++;
      if (!rec.lock && (rec.phase === 'accepted' || rec.phase === 'locking')) sum += BigInt(rec.offer.evm.amount);
    }
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
  const keep = async (id, also = {}) => {
    const q = await quoter.get(id), r = reservations.get(id);
    if (q) await quoteStore.put({ ...q, reservedUntil: r ? r.until : 0, reservedTxid: r ? r.txid : null, ...also });
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
    for (const q of await quoteStore.list()) { if (q.validUntil + dead < now() && !used.has(q.id) && !reservations.has(q.id)) await quoteStore.del(q.id); else kept++; }
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
        if (next.lastError && next.lastError !== rec.lastError) log({ level: 'warn', msg: 'swap step failed', id: next.id, phase: next.phase, error: next.lastError });
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
    try { const st = await btc.status(rec.lockTxid); return st.confirmations >= Math.max(1, Number(config.policy.minConfsFor(BigInt(rec.offer.btc.value)))); } catch { return true; }
  }
  const offerOf = async (id) => published.get(id) || (await swaps.get(id))?.evmOffer || null;
  const reply = (body, status = 200) => ({ status, body });
  const no = (why, retry = false) => reply({ ok: false, retry, why });

  async function judgeOffer(body, q, sid) {
    let held = false;
    try {
      if (q && !(await swaps.get(sid))) {
        const have = reservations.get(q.id);
        if (have && have.until > now() && (!have.swapId || have.swapId === sid)) have.swapId = sid;
        else {
          try { await exclusive(async () => { await capacity(BigInt(q.evmAmount)); pending.set(sid, { amount: BigInt(q.evmAmount), until: now() + hold.reserveSecs }); held = true; }); } catch (e) { if (e.status) return { ok: false, retry: !!e.retry, why: e.message }; throw e; }
        }
      }
      const r = await el.receive({ quoteId: body.quoteId, offer: body.offer });
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

  // a whole number of base units, written plainly: a decimal string with no leading zeros, or a safe integer
  const amountOk = (a) => (typeof a === 'string' && /^(0|[1-9]\d{0,29})$/.test(a)) || (Number.isSafeInteger(a) && a >= 0);

  async function handle({ method, path, body, client = null }) {
    try {
      if (method === 'GET' && path === '/health') return reply({ ok: health.ok, lastTick: health.lastTick, error: health.lastError }, health.ok ? 200 : 503);
      if (method === 'GET' && path === '/info') {
        const q = config.quote, a = await availableAmount();
        return reply({ v: 1, claimPub: config.claimPub, btcAsset: q.btcAsset, evmAsset: q.evmAsset, minAmount: String(q.minAmount), maxAmount: String(q.maxAmount), available: a == null ? null : String(a), feeBps: q.feeBps, flatFee: String(q.flatFee ?? 0), csvBlocks: config.csvBlocks, evmWindowSecs: config.policy.evmWindowSecs, minClaimSecs: config.policy.minClaimSecs, reserveSecs: hold.reserveSecs, anyTac: config.anyTac !== false });
      }
      if (method === 'POST' && path === '/quote') {
        if (!body || !amountOk(body.amount)) return reply({ error: 'amount must be a whole number' }, 400);
        if (quotesHeld !== null && quotesHeld >= maxQuotes) return reply({ error: 'the provider holds too many open quotes just now: ask again shortly' }, 503);
        return reply(await exclusive(async () => { await capacity(quoter.price(body.amount).evmAmount); const made = await quoter.quote(body.amount); if (quotesHeld !== null) quotesHeld++; return made; }));
      }
      if (method === 'POST' && path === '/reserve') {
        if (!body || !isId(body.quoteId)) return reply({ error: 'quoteId is required' }, 400);
        return await exclusive(async () => {
          const q = await quoter.get(body.quoteId), have = reservations.get(body.quoteId);
          if (!q) return no('unknown quote');
          if (have && have.until > now()) return reply({ ok: true, until: have.until });
          if (now() > q.validUntil) return no('quote expired');
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
          await keep(q.id);
          return reply({ ok: true, until });
        });
      }
      if (method === 'POST' && path === '/extend') {
        if (!body || !isId(body.quoteId) || !/^[0-9a-f]{64}$/.test(String(body.txid))) return reply({ error: 'quoteId and txid are required' }, 400);
        const held = reservations.get(body.quoteId);
        if (!held || held.until <= now()) return no('no reservation');
        if (held.txid === body.txid) return reply({ ok: true, until: held.until });
        if (held.txid) return no('this reservation is held for another transaction');
        // each transaction looked at is a read from the explorers, so a reservation looks at a few, not at any number
        if ((held.looks = (held.looks || 0) + 1) > (hold.maxLooks ?? 20)) return no('this reservation has looked at enough transactions');
        const tx = await btc.fetchTx(body.txid).catch(() => null);
        return await exclusive(async () => {
          const r = reservations.get(body.quoteId);
          if (!r || r.until <= now()) return no('no reservation');
          if (r.txid && r.txid !== body.txid) return no('this reservation is held for another transaction');
          if (r.txid === body.txid) return reply({ ok: true, until: r.until });
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
          // (`lock`: the adaptor point and the refund key, with this side's claim key and the quote's timelock); any other output would hold the payout for nothing
          if (sats) {
            let spk = null;
            try { spk = lockSpkOf(body.lock, q); } catch { spk = null; }
            if (!spk) return no('that transaction does not pay the quoted amount to a Taproot lock: the extension names no lock');
            if (!(tx.vout || []).some((o) => String(o.scriptpubkey || '').toLowerCase() === spk && q && o.value === Number(q.btcValue))) return no('that transaction does not pay the quoted amount to a Taproot lock of this quote');
          }
          for (const [id, other] of reservations) if (id !== body.quoteId && other.txid === body.txid) return no('that transaction already holds another reservation');
          for (const rec of await swaps.list()) if (rec.lockTxid === body.txid) return no('that transaction is already a swap');
          r.txid = body.txid; r.until = Math.max(r.until, now() + hold.extendSecs);
          // when the lock was first seen: a late offer for it is weighed by this (quotes.get)
          await keep(body.quoteId, { seenTxid: body.txid, seenAt: now() });
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
        if (!c) {
          c = { done: false, at: now() };
          c.p = judgeOffer(body, q, sid).then((r) => { c.done = true; c.at = now(); return said(r); });
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
