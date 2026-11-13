
export const TAKE_VB = 750;
export const takeSatsAt = (feeRate) => 546 + Math.ceil(TAKE_VB * feeRate * 2);
const FEE_WARM_MS = 30000;

import { makeEthereumLocker } from './fastbridge-el.js';

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
  const takeSats = btc.feeRate ? async () => takeSatsAt(await btc.feeRate()) : null;
  const quoter = makeQuoter({ store: quoteStore, now, params: { ...config.quote, claimPub: config.claimPub, csvBlocks: config.csvBlocks, evmWindowSecs: config.policy.evmWindowSecs, minConfsFor: config.policy.minConfsFor, takeSats } });
  const hold = { reserveSecs: 300, extendSecs: 7200, maxUnbackedShare: 0.5, ...(config.reserve || {}) };
  const refreshSecs = config.inventory?.refreshSecs ?? 60;
  const reservations = new Map();
  const pending = new Map();
  const published = new Map();
  const checking = new Map();
  const offerBudgetMs = config.offerBudgetMs ?? 8000;
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const counter = { publishEvmOffer: async (id, offer) => { published.set(id, offer); } };
  const graceSecs = Number(config.quote?.graceSecs) || 0;
  const quotes = { get: async (id) => { const q = await quoter.get(id); if (!q) return q; const r = reservations.get(id); const until = Math.max(q.validUntil + graceSecs, r ? r.until : 0); return until > q.validUntil ? { ...q, validUntil: until } : q; } };
  const el = makeEthereumLocker({ seed, now, store: swaps, quotes, btc, evm, counter, policy: config.policy });
  const health = { ok: true, lastTick: 0, lastError: null };
  const reported = new Set(), lastAlert = new Map();

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
    for (const r of reservations.values()) if (!r.txid && r.until > now()) unbacked += r.amount;
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
  const keep = async (id) => {
    const q = await quoter.get(id), r = reservations.get(id);
    if (q) await quoteStore.put({ ...q, reservedUntil: r ? r.until : 0, reservedTxid: r ? r.txid : null });
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

  let lastPrune = 0;
  async function prune() {
    if (!quoteStore.del || now() - lastPrune < 3600) return;
    lastPrune = now();
    for (const [id, r] of reservations) if (r.until <= now()) reservations.delete(id);
    const used = new Set((await swaps.list()).map((r) => r.quoteId));
    for (const q of await quoteStore.list()) if (q.validUntil + 2 * DAY < now() && !used.has(q.id) && !reservations.has(q.id)) await quoteStore.del(q.id);
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

  let capacitySaid = -Infinity, lowSaid = -Infinity;
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
        const before = rec.phase, hadLock = !!rec.lock;
        let next;
        try { next = await el.step(rec); } catch (e) { log({ level: 'error', msg: 'swap step threw', id: rec.id, error: String((e && e.message) || e).slice(0, 200) }); continue; }
        if (next.phase !== before) log({ level: 'info', msg: 'swap', id: next.id, from: before, to: next.phase, why: next.why });
        if (next.phase !== before || (!hadLock && next.lock)) stale();
        if (next.phase === 'lost') alert({ level: 'alert', msg: 'a lock was claimed without revealing t', id: next.id });
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
        if (!reservations.has(body.quoteId)) return no('no reservation');
        const tx = await btc.fetchTx(body.txid).catch(() => null);
        return await exclusive(async () => {
          const r = reservations.get(body.quoteId);
          if (!r || r.until <= now()) return no('no reservation');
          if (r.txid && r.txid !== body.txid) return no('this reservation is held for another transaction');
          if (r.txid === body.txid) return reply({ ok: true, until: r.until });
          if (!tx) return no('the lock transaction is not visible yet', true);
          if (!tx.vin || tx.vin.length < 2) return no('that is not a lock transaction');
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
        const said = (r) => { log({ level: r.ok ? 'info' : 'warn', msg: r.ok ? 'offer accepted' : 'offer declined', id: sid, ...(r.ok ? {} : { retry: !!r.retry, why: String(r.why || '').slice(0, 200) }) }); return r; };
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
