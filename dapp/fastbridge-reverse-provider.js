// A provider's reverse side: TAC it holds on Bitcoin sold for TAC in the pool (Ethereum -> Bitcoin), the swap of the fast bridge with the seats exchanged.
// The provider is the BITCOIN locker (dapp/fastbridge-bl.js): it holds t, locks a Bitcoin note first, then claims the user's pool lock; the user is the
// Ethereum locker (dapp/fastbridge-el.js). The machines are the ones of the other direction, unchanged (tests/fastbridge-reverse.test.mjs).
//
// What differs is the transport and the money. The provider never calls the user: the user asks for a quote, asks it to start, FETCHES the provider's lock
// offer when the lock is confirmed, locks its pool note, and POSTS the pool offer back, which the machine then reads. What the provider puts at stake is
// its Bitcoin TAC, and it locks first, so a user that never completes ties up a note until the timelock opens: that is bounded here, not priced. The
// notes come from a Bitcoin address of their own, funded on purpose (the daemon derives it from the key and refuses to share the other direction's),
// so the most a stream of requests can tie up is what was put there: `maxOpen` locks, and at most `maxLocked` of TAC between them.
//
//   const rv = makeReverseService({ seed, btc, evm, swaps, quotes, offers, evmOffers, inventory, config, now, log, alert })
//   rv.handle({ method, path, body })      the routes below, for the HTTP API and the mailbox alike
//   rv.start()  rv.tick()                  recover after a restart; step the open swaps
//
//   GET  /reverse/info                          terms, and what can be sent now
//   POST /reverse/quote   { amount, claimPub }  amount = the pool TAC the user locks; claimPub = the Bitcoin key the user will take the note with
//   POST /reverse/start   { quoteId }           the provider locks (and broadcasts) its Bitcoin note: -> { swapId }
//   GET  /reverse/swap/<swapId>                 { phase, why }
//   GET  /reverse/swap/<swapId>/offer           the provider's lock offer, once its lock is confirmed (404 before)
//   POST /reverse/swap/<swapId>/evm-offer { evmOffer }   the user's pool lock offer, checked before it is kept
//
//   seed, btc, evm   the machine's secrets; the DEDICATED Bitcoin chain (its wallet, coins and notes); the pool side
//   swaps, quotes, offers, evmOffers   stores ({ get, put, list }, records with an `id`): swaps hold only this direction's records
//   inventory        { notes() } -> the confirmed TAC notes at the dedicated address, [{ txid, vout, value, amount, blinding }]
//   config           { quote: { btcAsset, evmAsset, minAmount, maxAmount, feeBps, flatFee, validSecs }, csvBlocks, evmWindowSecs, maxOpen, maxLocked,
//                      minConfsFor(value), anyTac, alertSecs, refreshSecs, policy: { minClaimSecs, offerWaitSecs, maxEvmWindowSecs } }

import { makeBitcoinLocker } from './fastbridge-bl.js';
import { makeWatchdog } from './fastbridge-watch.js';
import { pickNotes } from './fastbridge-client.js';
import { feeOf } from './fastbridge-price.js';
import { takeSatsAt } from './fastbridge-provider.js';
import * as X from './adaptor-xswap.js';
import { secp, bytesToHex, hexToBytes } from './vendor/tacit-deps.min.js';

const TERMINAL = new Set(['done', 'refunded', 'counter-took']);
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const isId = (v) => /^[0-9a-f]{32}$/.test(String(v));
const isSwapId = (v) => /^[0-9a-f]{72}$/.test(String(v));
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const key = (n) => `${n.txid}:${n.vout}`;
const reply = (body, status = 200) => ({ status, body });
const no = (why, retry = false) => reply({ ok: false, retry, why });
const MAX_INPUTS = 6, MAX_OFFER_BYTES = 12000, FAILURE_MEMORY_SECS = 10;

export function makeReverseService({ seed, btc, evm, swaps, quotes, offers, evmOffers, inventory, config, now = () => Math.floor(Date.now() / 1000), log = () => {}, alert = () => {} }) {
  const q = config.quote, min = BigInt(q.minAmount), max = BigInt(q.maxAmount), validSecs = q.validSecs ?? 600;
  const maxOpen = config.maxOpen ?? 2, maxOpenPerKey = config.maxOpenPerKey ?? Infinity, maxLocked = config.maxLocked == null ? null : BigInt(config.maxLocked);
  const refreshSecs = config.refreshSecs ?? 60, alertSecs = config.alertSecs ?? 3600;
  const pol = config.policy || {};
  const lockerPub = bytesToHex(btc.wallet.pub);
  // Plain sats instead of a Tacit note (btcAsset X.SATS_ASSET): the provider sells the sats at its dedicated address for pool ETH. Its inventory is that address's
  // coins (`inventory.notes()` lists them with `amount` = their value), a lock is built from coins picked then (dapp/fastbridge-bl.js buildSats), nothing is paid to
  // the user's key for a take (its fee comes out of the lock), and the price is the rate in `quote.rate` ({ num, den } pool units per satoshi, or a function that
  // gives it: dapp/fastbridge-rate.js). `lockFeeReserve` is what the coins must cover beyond the amount, for the lock's own fee.
  const sats = X.isSats(q.btcAsset);
  const lockFeeReserve = BigInt(config.lockFeeReserve ?? 20_000);
  const takeSats = btc.feeRate && !sats ? async () => takeSatsAt(await btc.feeRate()) : async () => 0;
  const rateNow = () => {
    const r = typeof q.rate === 'function' ? q.rate() : q.rate;
    if (!r) throw Object.assign(new Error('the provider has no price for this pair right now'), { status: 503, retry: true });
    return { num: BigInt(r.num), den: BigInt(r.den) };
  };

  // sendOffer is the machine telling its counterparty the lock is confirmed: here that is keeping the offer for the user to fetch
  const counter = {
    sendOffer: async ({ quoteId, offer }) => { await offers.put({ id: strip(offer.swapId), quoteId, offer }); return { ok: true }; },
    getEvmOffer: async (id) => { const r = await evmOffers.get(id); return r ? r.offer : null; },
  };
  const bl = makeBitcoinLocker({
    seed, now, store: swaps, btc, evm, counter,
    policy: { csvBlocks: config.csvBlocks ?? 96, minClaimSecs: pol.minClaimSecs ?? 3600, offerWaitSecs: pol.offerWaitSecs ?? 2 * 3600, maxEvmWindowSecs: pol.maxEvmWindowSecs ?? 6 * 3600, claimMarginSecs: pol.claimMarginSecs ?? 600 },
  });

  let chain = Promise.resolve();
  const exclusive = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

  // what a pool amount the user locks becomes: the Bitcoin note it gets is that less the provider's fee (a rate on the amount, and a flat part)
  function price(amount) {
    const a = BigInt(amount);
    if (a < min || a > max) throw Object.assign(new Error(`the amount must be between ${min} and ${max}`), { status: 400 });
    const fee = feeOf(q, a);
    let out = a - fee;
    if (sats && out > 0n) { const { num, den } = rateNow(); out = (out * den) / num; }   // the fee is in pool units; what is left buys sats at the rate
    if (a - fee <= 0n || out <= 0n) throw Object.assign(new Error('the amount does not cover the fee'), { status: 400 });
    return { evmAmount: a, btcValue: out, fee };
  }
  // the most a user can send for a Bitcoin note of at most `btcMax`
  function maxInFor(btcMax) {
    const fits = (a) => { try { return price(a).btcValue <= btcMax; } catch { return false; } };
    if (!fits(min)) return 0n;
    let lo = min, hi = max;
    while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (fits(mid)) lo = mid; else hi = mid - 1n; }
    return lo;
  }

  // A read that failed is remembered for a few seconds: /reverse/info and the quote read the notes, so without this a stream of requests while an explorer is
  // down would be a stream of scans of it (one at a time, but without end).
  const inv = { at: -Infinity, notes: [], p: null, failedAt: -Infinity, failure: null };
  function readNotes(maxAge = refreshSecs) {
    if (now() - inv.at < maxAge) return Promise.resolve(inv.notes);
    if (inv.p) return inv.p;
    if (now() - inv.failedAt < FAILURE_MEMORY_SECS) return Promise.reject(inv.failure);
    inv.p = (async () => {
      try { inv.notes = (await inventory.notes()).map((n) => ({ ...n, amount: BigInt(n.amount) })); inv.at = now(); }
      catch (e) { inv.failedAt = now(); inv.failure = e; throw e; }
      finally { inv.p = null; }
      return inv.notes;
    })();
    return inv.p;
  }
  const stale = () => { inv.at = -Infinity; inv.failedAt = -Infinity; };

  // the notes not already in a swap (a note a swap spent is never lent again, whatever the cached list still says), and what the open swaps hold
  async function picture() {
    const recs = await swaps.list(), spent = new Set(), feeCoins = new Set();
    let open = 0, locked = 0n;
    for (const r of recs) {
      for (const i of r.noteInputs || []) spent.add(key(i));
      if (TERMINAL.has(r.phase)) continue;
      open++; locked += BigInt(r.amount);
      for (const c of r.feeInputs || []) feeCoins.add(key(c));
    }
    const all = await readNotes();
    // (a coin a lock of sats was funded from is held by that swap until it ends, whatever the cached list says)
    return { free: all.filter((n) => !spent.has(key(n)) && !(sats && feeCoins.has(key(n)))), all, open, locked, feeCoins };
  }
  // what the free coins can lock: the largest few together, less the lock's own fee
  const satsHeld = (free) => {
    const held = free.map((n) => n.amount).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)).slice(0, MAX_INPUTS).reduce((s, v) => s + v, 0n);
    return held > lockFeeReserve ? held - lockFeeReserve : 0n;
  };
  const roomFor = (p, btcValue) => {
    if (p.open >= maxOpen) return 'the provider has all the sends it takes at once';
    if (maxLocked != null && p.locked + btcValue > maxLocked) return `the provider has all the ${sats ? 'Bitcoin' : 'TAC'} it puts out at once`;
    if (sats ? satsHeld(p.free) < btcValue : !pickNotes(p.free, btcValue)) return `the provider has no ${sats ? '' : 'TAC on '}Bitcoin for that amount right now`;
    return null;
  };
  async function availableAmount() {
    try {
      const p = await picture();
      if (p.open >= maxOpen) return 0n;
      let held = sats ? satsHeld(p.free) : p.free.map((n) => n.amount).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)).slice(0, MAX_INPUTS).reduce((s, v) => s + v, 0n);
      if (maxLocked != null) { const left = maxLocked > p.locked ? maxLocked - p.locked : 0n; if (left < held) held = left; }
      return maxInFor(held);
    } catch { return null; }
  }

  async function info() {
    const p = await picture().catch(() => null), a = await availableAmount();
    return {
      v: 1, direction: 'out', lockerPub, btcAsset: q.btcAsset, evmAsset: q.evmAsset, minAmount: String(min), maxAmount: String(max), available: a == null ? null : String(a),
      feeBps: q.feeBps, flatFee: String(q.flatFee ?? 0), csvBlocks: config.csvBlocks ?? 96, evmWindowSecs: config.evmWindowSecs, minClaimSecs: pol.minClaimSecs ?? 3600,
      maxOpen, open: p ? p.open : null, anyTac: config.anyTac !== false,
    };
  }

  async function quote({ amount, claimPub }) {
    if (!/^[0-9a-f]{66}$/.test(String(claimPub))) throw Object.assign(new Error('claimPub must be a compressed Bitcoin key'), { status: 400 });
    try { secp.ProjectivePoint.fromHex(claimPub); } catch { throw Object.assign(new Error('claimPub is not a point on the curve'), { status: 400 }); }
    const { evmAmount, btcValue } = price(amount);
    const why = roomFor(await picture(), btcValue);
    if (why) throw Object.assign(new Error(why), { status: 503, retry: true });
    const rec = {
      id: randomHex(16), direction: 'out', btcAsset: q.btcAsset, btcValue: String(btcValue), evmAsset: q.evmAsset, evmAmount: String(evmAmount), claimPub: String(claimPub).toLowerCase(),
      lockerPub, lockerXonly: lockerPub.slice(2), csvBlocks: config.csvBlocks ?? 96, evmWindowSecs: config.evmWindowSecs, minConfs: config.minConfsFor ? config.minConfsFor(btcValue) : 1,
      takeSats: await takeSats(), created: now(), validUntil: now() + validSecs,
    };
    await quotes.put(rec);
    return rec;
  }

  // The provider locks: a note of the exact size is not needed (the rest of the note comes back as change once the lock confirms). One at a time, so
  // two starts never pick one note or one fee coin.
  function startSwap({ quoteId }) {
    return exclusive(async () => {
      const rec = isId(quoteId) ? await quotes.get(quoteId) : null;
      if (!rec) return no('unknown quote');
      if (rec.swapId) return reply({ ok: true, swapId: rec.swapId });
      if (now() > rec.validUntil) return no('quote expired');
      const p = await picture(), btcValue = BigInt(rec.btcValue), why = roomFor(p, btcValue);
      if (why) return no(why, true);
      // one key asks for at most `maxOpenPerKey` locks at a time (the pair provider: 1): a start costs the user nothing, and each lock holds this side's coins for its timelock
      let mine = 0;
      for (const r of await swaps.list()) if (!TERMINAL.has(r.phase) && strip(r.counterClaimPub || '') === strip(rec.claimPub)) mine++;
      if (mine >= maxOpenPerKey) return no('this key already has a send under way with this provider: finish it first', true);
      // a lock of sats picks its own coins, from the address's, leaving alone those that open swaps hold; a lock of a note is built from the notes picked here
      const pick = sats ? null : pickNotes(p.free, btcValue);
      const avoid = sats ? new Set(p.feeCoins) : new Set([...p.all.map(key), ...p.feeCoins]);
      let swap;
      try {
        swap = await bl.start({
          asset: hexToBytes(rec.btcAsset), amount: btcValue, notes: pick ? pick.notes : [], counterClaimPub: hexToBytes(rec.claimPub),
          evmAsset: rec.evmAsset, evmAmount: BigInt(rec.evmAmount), quoteId: rec.id, takeSats: Number(rec.takeSats ?? 0), avoid,
        });
      } catch (e) {
        const m = String((e && e.message) || e);
        if (/not enough sats (to fund the commit|for the lock)/.test(m)) { alert({ level: 'warn', msg: 'the reverse side has too few sats at its address to lock', error: m.slice(0, 160) }); return no('the provider cannot pay the Bitcoin fee of the lock right now', true); }
        if (/already part of a swap/.test(m)) return no('that note is already in a swap', true);
        throw e;
      }
      await quotes.put({ ...rec, swapId: swap.id });
      stale();
      log({ level: 'info', msg: 'reverse swap started', id: swap.id, amount: String(btcValue) });
      // the lock is broadcast now; if the explorers do not take it, the next tick sends it again (the record is stored)
      try { await bl.step(swap); } catch (e) { log({ level: 'warn', msg: 'the lock could not be sent yet', id: swap.id, error: String((e && e.message) || e).slice(0, 160) }); }
      return reply({ ok: true, swapId: swap.id });
    });
  }

  // The user's pool offer, kept only if it is the offer this swap is waiting for: so a stranger who learns a swap id cannot post one that sends the swap
  // to its refund. (The machine checks it again before it claims.)
  async function keepEvmOffer(id, body) {
    const swap = await swaps.get(id);
    if (!swap) return reply({ error: 'unknown swap' }, 404);
    if (await evmOffers.get(id)) return reply({ ok: true, kept: true });
    const offer = body && body.evmOffer;
    if (!offer || typeof offer !== 'object' || JSON.stringify(offer).length > MAX_OFFER_BYTES) return no('malformed offer');
    if (!['broadcast', 'offered'].includes(swap.phase)) return no(`this swap is ${swap.phase}`);
    if (!/^[0-9a-f]{64}$/.test(strip(offer.lockLeaf || ''))) return no('malformed offer: lock leaf');
    const position = await evm.lockPosition(offer.lockLeaf);
    if (!position) return no('the lock is not in the pool yet', true);
    const sid = hexToBytes(id), sec = X.deriveSwapSecrets({ seed, swapId: sid }), recipient = await evm.recipient(id);
    const v = X.verifyEvmOffer(offer, {
      mine: { T: sec.T, recipient: bytesToHex(recipient.xonly), rOut: sec.rOut }, expect: { evmAsset: swap.evmAsset, evmAmount: BigInt(swap.evmAmount) },
      inLockSet: true, nowSecs: await evm.now(), minClaimSecs: pol.minClaimSecs ?? 3600,
    });
    if (!v.ok) return no('offer: ' + v.reasons.join('; '));
    // (a deadline counted from the ask, as a lock built ahead has, is taken on the same terms as one counted from the block: time to claim, and not further out
    // than this side accepts; the machine checks both again before it claims)
    if (Number(offer.deadline) - (await evm.now()) > (pol.maxEvmWindowSecs ?? 6 * 3600)) return no('offer: the deadline is further out than this side accepts');
    await evmOffers.put({ id, offer });
    // (the swap is stepped now rather than at the next tick: the claim is built at once; steps of one swap run one at a time, so this and a tick never overlap)
    (async () => {
      for (let i = 0, was = null; i < 4; i++) {
        const r = await bl.step((await swaps.get(id)) || swap), at = r && JSON.stringify([r.phase, !!r.claim, !!(r.claim && r.claim.jobId)]);
        if (!r || !['broadcast', 'offered', 'claiming'].includes(r.phase) || (r.claim && r.claim.jobId) || at === was) break;
        was = at;
      }
    })().catch(() => {});
    return reply({ ok: true });
  }

  // The lock offer as soon as the lock is sent (a lock of plain sats only): the same terms the offer carries once the lock is confirmed, so the user can build and
  // prove its pool lock while the block is awaited. The user checks it against the transaction itself, and locks nothing before the lock has its confirmations.
  async function earlyOffer(id) {
    const s = await swaps.get(id);
    if (!s || !X.isSats(s.asset) || !['broadcast', 'offered'].includes(s.phase) || !s.lock || !/^[0-9a-f]{64}$/.test(String(s.lock.txid || ''))) return reply({ error: 'no offer yet' }, 404);
    const sec = X.deriveSwapSecrets({ seed, swapId: hexToBytes(id) }), recipient = await evm.recipient(id);
    return reply(X.makeBtcLockOffer({
      swapId: hexToBytes(id), asset: s.asset, value: BigInt(s.amount), rLock: null, txid: s.lock.txid, vout: s.lock.vout, csvBlocks: s.csvBlocks, lockerXonly: btc.wallet.xonly, T: sec.T,
      claimerPub: s.counterClaimPub, evm: { asset: s.evmAsset, amount: BigInt(s.evmAmount), recipient: bytesToHex(recipient.xonly), rOut: sec.rOut },
    }));
  }

  async function handle({ method, path, body }) {
    try {
      if (method === 'GET' && path === '/reverse/info') return reply(await info());
      if (method === 'POST' && path === '/reverse/quote') {
        if (!body || !/^\d+$/.test(String(body.amount))) return reply({ error: 'amount must be a whole number' }, 400);
        return reply(await exclusive(() => quote({ amount: body.amount, claimPub: String(body.claimPub || '').toLowerCase() })));
      }
      if (method === 'POST' && path === '/reverse/start') {
        if (!body || !isId(body.quoteId)) return reply({ error: 'quoteId is required' }, 400);
        return await startSwap({ quoteId: body.quoteId });
      }
      const m = /^\/reverse\/swap\/([0-9a-f]{72})(\/offer|\/evm-offer|\/early-offer)?$/.exec(path);
      if (m && isSwapId(m[1])) {
        // (the lock's txid once it is sent: the user's page shows the lock and its confirmation while it waits for the offer, which comes after the block)
        if (method === 'GET' && !m[2]) { const s = await swaps.get(m[1]); return s ? reply({ phase: s.phase, why: s.why || null, lockTxid: s.phase !== 'built' && s.lock && /^[0-9a-f]{64}$/.test(String(s.lock.txid || '')) ? s.lock.txid : null }) : reply({ error: 'unknown swap' }, 404); }
        if (method === 'GET' && m[2] === '/offer') { const o = await offers.get(m[1]); return o ? reply(o.offer) : reply({ error: 'no offer yet' }, 404); }
        if (method === 'GET' && m[2] === '/early-offer') return await earlyOffer(m[1]);
        if (method === 'POST' && m[2] === '/evm-offer') return await keepEvmOffer(m[1], body);
      }
      return reply({ error: 'not found' }, 404);
    } catch (e) {
      if (!e.status) log({ level: 'error', msg: 'a reverse request failed', path, error: String((e && e.message) || e).slice(0, 160) });
      return e.status ? reply({ ok: false, error: String(e.message), retry: !!e.retry }, e.status) : reply({ error: 'the service could not answer' }, 500);
    }
  }

  async function start() { await swaps.list(); stale(); }

  // A quote that started no swap is of no use once it has run out: it is let go `quoteKeepSecs` after (a look every ten minutes at most), and sooner, as soon as it
  // runs out, while more than `maxQuotes` such quotes are kept. One that started a swap stays with it.
  let lastPrune = -Infinity;
  async function pruneQuotes() {
    if (!quotes.del || now() - lastPrune < 600) return 0;
    lastPrune = now();
    const keepSecs = config.quoteKeepSecs ?? 3600, cap = config.maxQuotes ?? 5000;
    const loose = (await quotes.list()).filter((r) => r && !r.swapId);
    let n = 0;
    for (const r of loose) if (Number(r.validUntil) + keepSecs < now() || (loose.length > cap && Number(r.validUntil) < now())) { await quotes.del(r.id); n++; }
    return n;
  }

  // the watchdog (fastbridge-watch.js): a swap whose step has not moved for longer than it takes is read afresh and said. The lock's wait for its block, and the
  // wait for a user who may never lock or take, have no time of their own (the timelock ends them); a user's pool offer that is kept and not acted on has.
  const WATCH_BL = { claiming: 600 };
  const watchdog = makeWatchdog({
    now, log, alert,
    budget: (r) => (r.phase === 'broadcast' ? (r.confirmedAt ? 600 : null) : r.phase === 'offered' ? (r.hasEvmOffer ? 600 : null) : WATCH_BL[r.phase] ?? null),
    keyOf: (r) => JSON.stringify([r.phase, !!r.confirmedAt, !!r.hasEvmOffer, !!(r.claim && r.claim.jobId)]),
    forget: () => { if (evm.forget) evm.forget(); },
    kick: (r) => bl.step(r),
  });
  const lastAlert = new Map();
  async function tick() {
    await pruneQuotes().catch((e) => log({ level: 'warn', msg: 'the reverse quotes could not be pruned', error: String((e && e.message) || e).slice(0, 160) }));
    for (const rec of await swaps.list()) {
      if (TERMINAL.has(rec.phase)) continue;
      const before = rec.phase;
      let next;
      try { next = await bl.step(rec); } catch (e) { log({ level: 'error', msg: 'reverse swap step threw', id: rec.id, error: String((e && e.message) || e).slice(0, 200) }); continue; }
      if (next.phase !== before) {
        stale();
        log({ level: 'info', msg: 'reverse swap', id: next.id, from: before, to: next.phase, why: next.why });
        if (next.phase === 'refund-wait') alert({ level: 'warn', msg: 'a reverse swap is waiting out its timelock to take its Bitcoin note back', id: next.id, why: next.why || null });
      }
      if (next.lastError && next.lastError !== rec.lastError) log({ level: 'warn', msg: 'reverse swap step failed', id: next.id, phase: next.phase, error: next.lastError });
      if (!TERMINAL.has(next.phase)) await watchdog.look({ ...next, hasEvmOffer: next.phase === 'offered' ? !!(await evmOffers.get(next.id).catch(() => null)) : false });
      const every = alertSecs, k = next.id + '|' + next.phase, t = now();
      // (the Ethereum nodes have not agreed on this swap for ten minutes: it waits and is read again; said every quarter hour while it lasts)
      if (next.nodesSince != null && t - next.nodesSince >= 600 && t - (lastAlert.get(next.id + '|nodes') ?? -Infinity) >= 900) {
        lastAlert.set(next.id + '|nodes', t);
        alert({ level: 'alert', msg: 'the Ethereum nodes have not agreed on a reverse swap for a while: it waits and is read again', id: next.id, phase: next.phase, since: next.nodesSince, error: next.lastError || null });
      }
      if ((next.phase === 'claiming' || next.phase === 'claimed') && t - (next.updated || next.created) > every && t - (lastAlert.get(k) ?? -Infinity) >= every) {
        lastAlert.set(k, t);
        alert({ level: 'alert', msg: 'a reverse swap has waited long in ' + next.phase, id: next.id, error: next.lastError || null });
      }
    }
  }

  return { handle, start, tick, bl, info, price, availableAmount };
}
