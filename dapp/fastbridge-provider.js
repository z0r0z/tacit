// The provider side of a fast bridge, for a page or a process: what it quotes, what it can take, and the handler of the
// requests a user's client makes. It runs the Ethereum-locker machine (fastbridge-el.js) over a store and advances every open
// swap on a tick. Chain access (btc, evm) and storage are injected: the daemon wires the real adapters, a page wires the
// ones its key opens, the tests wire simulated ones. A request is { method, path, body } and an answer { status, body }, so
// the same handler serves HTTP (fastbridge-lp/) and a mailbox (fastbridge-mailbox.js).
//
//   GET  /health            200 while the last tick succeeded
//   GET  /info              the LP's Bitcoin claim key, the asset pair, limits, windows and what it can take now
//   POST /quote   { amount }              a price: what the user pays on Bitcoin and receives in the pool (holds nothing)
//   POST /reserve { quoteId }             holds the payout for the swap while the user builds and sends its lock (minutes)
//   POST /extend  { quoteId, txid }       once the lock is on the network: holds it through its confirmation
//   POST /offer   { quoteId, offer }      the user's Bitcoin lock offer; answers { ok } or { ok: false, retry, why }
//   GET  /swap/:id          { phase, why }
//   GET  /swap/:id/offer    the pool lock's offer once the lock is made
//
// What the LP can take is what its pool wallet holds, less what is already promised (a reservation, or a swap whose
// lock is not yet made). A quote only checks that; the reservation is what holds it, so a user comparing providers holds
// nothing at any of them. Each quote names the fee of the take (`takeSats`), which the user's lock pays to the LP's
// address, so an LP needs no Bitcoin of its own.

// The take is a commit and a reveal of about this many vbytes in all; it is priced at twice the rate of the quote, and pays
// for the dust its note keeps.
export const TAKE_VB = 750;
export const takeSatsAt = (feeRate) => 546 + Math.ceil(TAKE_VB * feeRate * 2);

import { makeEthereumLocker } from './fastbridge-el.js';

// ── prices ──
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

export function makeQuoter({ store, now, params }) {
  const p = params;
  const min = BigInt(p.minAmount), max = BigInt(p.maxAmount), flat = BigInt(p.flatFee ?? 0), bps = BigInt(p.feeBps ?? 0);
  const num = BigInt(p.rate?.num ?? 1), den = BigInt(p.rate?.den ?? 1);

  function price(amount) {
    const a = BigInt(amount);
    if (a < min || a > max) throw Object.assign(new Error(`the amount must be between ${min} and ${max}`), { status: 400 });
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
    await store.put(q);
    return q;
  }
  // The largest amount to quote whose payout is at most `outAvail` (0 when not even the least fits).
  function maxAmountFor(outAvail) {
    const out = BigInt(outAvail);
    const fits = (a) => { try { return price(a).evmAmount <= out; } catch { return false; } };
    if (!fits(min)) return 0n;
    let lo = min, hi = max;
    while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (fits(mid)) lo = mid; else hi = mid - 1n; }
    return lo;
  }
  // the form the Ethereum locker checks an offer against
  const get = async (id) => (/^[0-9a-f]{32}$/.test(String(id)) ? store.get(id) : null);
  return { price, quote, get, maxAmountFor };
}

// ── the service ──
const TERMINAL = new Set(['done', 'refunded', 'rejected', 'aborted', 'lost']);
const DAY = 86400;
const isId = (v) => /^[0-9a-f]{32}$/.test(String(v));
const cannotTake = () => Object.assign(new Error('the provider cannot take that amount right now'), { status: 400 });

export function makeLpService({ seed, btc, evm, swaps, quoteStore, config, now = () => Math.floor(Date.now() / 1000), log = () => {}, alert = () => {} }) {
  const takeSats = btc.feeRate ? async () => takeSatsAt(await btc.feeRate()) : null;
  const quoter = makeQuoter({ store: quoteStore, now, params: { ...config.quote, claimPub: config.claimPub, csvBlocks: config.csvBlocks, evmWindowSecs: config.policy.evmWindowSecs, minConfsFor: config.policy.minConfsFor, takeSats } });
  const hold = { reserveSecs: 300, extendSecs: 7200, maxUnbackedShare: 0.5, ...(config.reserve || {}) };
  const refreshSecs = config.inventory?.refreshSecs ?? 60;
  const reservations = new Map();                       // quote id -> { amount, until, txid, swapId }
  const pending = new Map();                            // swap id -> { amount, until }: an offer being checked, whose payout is held meanwhile
  const published = new Map();
  const checking = new Map();                           // swap id -> { p, done, at }: offers whose checks are under way
  const offerBudgetMs = config.offerBudgetMs ?? 8000;
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const counter = { publishEvmOffer: async (id, offer) => { published.set(id, offer); } };
  // an offer is judged against its quote, which lasts as long as the reservation made for it
  const quotes = { get: async (id) => { const q = await quoter.get(id); const r = reservations.get(id); return q && r && r.until > q.validUntil ? { ...q, validUntil: r.until } : q; } };
  const el = makeEthereumLocker({ seed, now, store: swaps, quotes, btc, evm, counter, policy: config.policy });
  const health = { ok: true, lastTick: 0, lastError: null };
  const reported = new Set(), lastAlert = new Map();

  // capacity-changing requests one at a time, so two of them cannot both be given the same inventory
  let chain = Promise.resolve();
  const exclusive = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

  // ── what can be taken ──
  const inv = { at: -Infinity, held: null, p: null };
  function readInventory() {
    if (inv.p) return inv.p;
    if (now() - inv.at < refreshSecs) return Promise.resolve(inv);
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

  // the payout promised: reservations still running, and swaps whose lock is not made yet
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
  async function capacity(payout) {
    const i = await readInventory(), p = await promised();
    if (i.held != null && payout > i.held - p.sum) throw cannotTake();
  }
  // A reservation with no transaction behind it costs its holder nothing: those together may hold only a share of the pool balance,
  // unless there is just the one, so a request that holds nothing real cannot take all of what the provider could lend.
  async function unbackedFits(payout) {
    const i = await readInventory();
    if (i.held == null) return true;
    let unbacked = 0n;
    for (const r of reservations.values()) if (!r.txid && r.until > now()) unbacked += r.amount;
    return unbacked === 0n || unbacked + payout <= (i.held * BigInt(Math.round(hold.maxUnbackedShare * 100))) / 100n;
  }
  async function availableAmount() {
    try {
      const i = await readInventory(), p = await promised();
      if (i.held == null) return null;
      return quoter.maxAmountFor(i.held > p.sum ? i.held - p.sum : 0n);
    } catch { return null; }
  }
  const keep = async (id) => {
    const q = await quoter.get(id), r = reservations.get(id);
    if (q) await quoteStore.put({ ...q, reservedUntil: r ? r.until : 0, reservedTxid: r ? r.txid : null });
  };

  // reservations still running survive a restart, as do the notes already given to a stored lock
  async function start() {
    const open = await swaps.list(), used = new Set(open.map((r) => r.quoteId)), txids = new Set(open.map((r) => r.lockTxid).filter(Boolean));
    for (const rec of open) if (evm.reserve) evm.reserve(rec);
    for (const q of (await quoteStore.list()).sort((a, b) => (a.created || 0) - (b.created || 0))) {
      if (!(q.reservedUntil > now()) || used.has(q.id)) continue;
      // one lock transaction stands for one hold: a second hold kept for the same transaction (an earlier version took one for every quote
      // a user asked with the same lock) is let go, as is a hold for a lock that is already a swap
      if (q.reservedTxid && txids.has(q.reservedTxid)) { await quoteStore.put({ ...q, reservedUntil: 0, reservedTxid: null }); continue; }
      if (q.reservedTxid) txids.add(q.reservedTxid);
      reservations.set(q.id, { amount: BigInt(q.evmAmount), until: q.reservedUntil, txid: q.reservedTxid || null });
    }
    await dropDeadHolds().catch(() => {});
  }

  // A hold for a lock already on Bitcoin is worth keeping only while that lock's offer can still be answered: once the lock confirmed longer
  // ago than this side answers offers for (maxOfferAgeSecs), no offer for it will be taken, and the hold only keeps others from bridging.
  const lockTimes = new Map();
  async function dropDeadHolds() {
    const maxAge = config.policy.maxOfferAgeSecs ?? 3600;
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
  // what is held against the pool balance now, for the one who provides to see
  const held = async () => (await promised()).sum;

  // quotes that were never used are forgotten after two days
  let lastPrune = 0;
  async function prune() {
    if (!quoteStore.del || now() - lastPrune < 3600) return;
    lastPrune = now();
    for (const [id, r] of reservations) if (r.until <= now()) reservations.delete(id);
    const used = new Set((await swaps.list()).map((r) => r.quoteId));
    for (const q of await quoteStore.list()) if (q.validUntil + 2 * DAY < now() && !used.has(q.id) && !reservations.has(q.id)) await quoteStore.del(q.id);
  }

  async function tick() {
    try {
      await dropDeadHolds().catch(() => {});
      const recs = await swaps.list();
      // a record the store cannot read is a swap nobody is advancing: say so once, loudly
      for (const p of (swaps.problems && swaps.problems()) || []) if (!reported.has(p.id)) { reported.add(p.id); alert({ level: 'alert', msg: 'a swap record cannot be read', id: p.id, error: p.error }); }
      for (const rec of recs) {
        if (TERMINAL.has(rec.phase)) continue;
        const before = rec.phase, hadLock = !!rec.lock;
        let next;
        try { next = await el.step(rec); } catch (e) { log({ level: 'error', msg: 'swap step threw', id: rec.id, error: String((e && e.message) || e).slice(0, 200) }); continue; }
        if (next.phase !== before) log({ level: 'info', msg: 'swap', id: next.id, from: before, to: next.phase, why: next.why });
        if (next.phase !== before || (!hadLock && next.lock)) stale();
        if (next.phase === 'lost') alert({ level: 'alert', msg: 'a lock was claimed without revealing t', id: next.id });
        if (next.lastError && next.lastError !== rec.lastError) log({ level: 'warn', msg: 'swap step failed', id: next.id, phase: next.phase, error: next.lastError });
        // the take must land before the user's timelock opens: a swap held in these phases long is worth a person's attention, again each alertSecs
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

  // whether the user's Bitcoin lock has the confirmations this provider asked for, as the explorers say now; an explorer that cannot answer does not stop a user
  async function lockStands(rec) {
    try { const st = await btc.status(rec.lockTxid); return st.confirmations >= Math.max(1, Number(config.policy.minConfsFor(BigInt(rec.offer.btc.value)))); } catch { return true; }
  }
  const offerOf = async (id) => published.get(id) || (await swaps.get(id))?.evmOffer || null;
  const reply = (body, status = 200) => ({ status, body });
  const no = (why, retry = false) => reply({ ok: false, retry, why });

  // What an offer comes to: held and checked, or declined with a reason. A check that fails for a reason of its own (an explorer or a node that
  // cannot be read, a bug) is logged and answered as one to try again, with its words, and is not a bare 500.
  async function judgeOffer(body, q, sid) {
    let held = false;
    try {
      // An offer whose payout is not held is held now, or declined, before anything is checked of it. The hold is the swap's, kept while the
      // offer is checked, so two offers arriving together cannot both be given what is left for one; a reservation covers the one swap that
      // first uses it, and a second swap on the same quote asks for room of its own.
      if (q && !(await swaps.get(sid))) {
        const have = reservations.get(q.id);
        if (have && have.until > now() && (!have.swapId || have.swapId === sid)) have.swapId = sid;
        else {
          try { await exclusive(async () => { await capacity(BigInt(q.evmAmount)); pending.set(sid, { amount: BigInt(q.evmAmount), until: now() + hold.reserveSecs }); held = true; }); } catch (e) { if (e.status) return { ok: false, retry: false, why: e.message }; throw e; }
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

  // A request in, { status, body } out. The HTTP layer owns the limits per client; nothing here reads the address.
  async function handle({ method, path, body }) {
    try {
      if (method === 'GET' && path === '/health') return reply({ ok: health.ok, lastTick: health.lastTick, error: health.lastError }, health.ok ? 200 : 503);
      if (method === 'GET' && path === '/info') {
        const q = config.quote, a = await availableAmount();
        return reply({ v: 1, claimPub: config.claimPub, btcAsset: q.btcAsset, evmAsset: q.evmAsset, minAmount: String(q.minAmount), maxAmount: String(q.maxAmount), available: a == null ? null : String(a), feeBps: q.feeBps, flatFee: String(q.flatFee ?? 0), csvBlocks: config.csvBlocks, evmWindowSecs: config.policy.evmWindowSecs, minClaimSecs: config.policy.minClaimSecs, reserveSecs: hold.reserveSecs, anyTac: config.anyTac !== false });
      }
      if (method === 'POST' && path === '/quote') {
        if (!body || !/^\d+$/.test(String(body.amount))) return reply({ error: 'amount must be a whole number' }, 400);
        return reply(await exclusive(async () => { await capacity(quoter.price(body.amount).evmAmount); return quoter.quote(body.amount); }));
      }
      if (method === 'POST' && path === '/reserve') {
        if (!body || !isId(body.quoteId)) return reply({ error: 'quoteId is required' }, 400);
        return await exclusive(async () => {
          const q = await quoter.get(body.quoteId), have = reservations.get(body.quoteId);
          if (!q) return no('unknown quote');
          if (have && have.until > now()) return reply({ ok: true, until: have.until });
          if (now() > q.validUntil) return no('quote expired');
          try { await capacity(BigInt(q.evmAmount)); if (!(await unbackedFits(BigInt(q.evmAmount)))) throw cannotTake(); } catch (e) { if (e.status) return no(e.message); throw e; }
          const until = now() + hold.reserveSecs;
          reservations.set(q.id, { amount: BigInt(q.evmAmount), until, txid: null });
          await keep(q.id);
          return reply({ ok: true, until });
        });
      }
      if (method === 'POST' && path === '/extend') {
        if (!body || !isId(body.quoteId) || !/^[0-9a-f]{64}$/.test(String(body.txid))) return reply({ error: 'quoteId and txid are required' }, 400);
        // the transaction is read before the capacity lock is taken: an explorer that is slow must not hold every other request
        if (!reservations.has(body.quoteId)) return no('no reservation');
        const tx = await btc.fetchTx(body.txid).catch(() => null);
        return await exclusive(async () => {
          const r = reservations.get(body.quoteId);
          if (!r || r.until <= now()) return no('no reservation');
          if (r.txid && r.txid !== body.txid) return no('this reservation is held for another transaction');
          // held once: the same transaction asked again is answered with the hold it has, which does not start over
          if (r.txid === body.txid) return reply({ ok: true, until: r.until });
          if (!tx) return no('the lock transaction is not visible yet', true);
          if (!tx.vin || tx.vin.length < 2) return no('that is not a lock transaction');
          // a hold that stands for a lock is one that pays this provider's take, and one transaction stands for one quote
          const q = await quoter.get(body.quoteId), take = Number((q && q.takeSats) || 0);
          if (take > 0 && btc.prims && btc.wallet) {
            const own = [...btc.prims.p2wpkhScript(btc.wallet.pub)].map((b) => b.toString(16).padStart(2, '0')).join('');
            if (!(tx.vout || []).some((o) => String(o.scriptpubkey || '').toLowerCase() === own && o.value >= take)) return no('that transaction does not pay the fee of the take');
          }
          for (const [id, other] of reservations) if (id !== body.quoteId && other.txid === body.txid) return no('that transaction already holds another reservation');
          for (const rec of await swaps.list()) if (rec.lockTxid === body.txid) return no('that transaction is already a swap');
          r.txid = body.txid; r.until = Math.max(r.until, now() + hold.extendSecs);
          await keep(body.quoteId);
          return reply({ ok: true, until: r.until });
        });
      }
      if (method === 'POST' && path === '/offer') {
        if (!body || typeof body.quoteId !== 'string' || !body.offer || typeof body.offer !== 'object') return reply({ error: 'quoteId and offer are required' }, 400);
        const q = isId(body.quoteId) ? await quoter.get(body.quoteId) : null;
        const sid = String(body.offer.swapId || '').toLowerCase().replace(/^0x/, '');
        if (!/^[0-9a-f]{72}$/.test(sid)) return reply(await judgeOffer(body, q, sid));
        // The checks of an offer read the lock and its notes from explorers, which takes as long as they take. The request waits a few
        // seconds for them and is then answered "ask again" while they go on; the same offer asked again joins the checks under way, so a
        // slow check is one check and not one for every try, and a user's client is not left to time out on a provider that is working.
        for (const [k, c] of checking) if (c.done && now() - c.at > 600) checking.delete(k);
        let c = checking.get(sid);
        if (!c) {
          c = { done: false, at: now() };
          c.p = judgeOffer(body, q, sid).then((r) => { c.done = true; c.at = now(); return r; });
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
          // the pre-signature that lets the user claim is given while the user's lock stands: a lock that has fallen under its confirmations
          // (replaced, or reorganised away) is not paid for, and is asked about again when it is back
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

  return { el, quoter, start, tick, handle, health, offerOf, reservations, availableAmount, held, dropDeadHolds };
}
