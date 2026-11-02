// The LP as a service: the Ethereum-locker machine over a durable store, a tick that advances every open swap, and the
// handler of the HTTP API a user's page talks to. Chain access (btc, evm) is injected: server.mjs wires the real
// adapters, the tests wire the simulated ones.
//
//   GET  /health            200 while the last tick succeeded
//   GET  /info              the LP's Bitcoin claim key, the asset pair, limits and windows
//   POST /quote  { amount } a quote: what the user pays on Bitcoin and receives in the pool
//   POST /offer  { quoteId, offer }   the user's Bitcoin lock offer; answers { ok } or { ok: false, retry, why }
//   GET  /swap/:id          { phase, why }
//   GET  /swap/:id/offer    the pool lock's offer once the lock is made

import { makeEthereumLocker } from '../../dapp/fastbridge-el.js';
import { makeQuoter } from './pricing.mjs';

const TERMINAL = new Set(['done', 'refunded', 'rejected', 'aborted', 'lost']);

export function makeLpService({ seed, btc, evm, swaps, quoteStore, config, now = () => Math.floor(Date.now() / 1000), log = () => {}, alert = () => {} }) {
  const quoter = makeQuoter({ store: quoteStore, now, params: { ...config.quote, claimPub: config.claimPub, csvBlocks: config.csvBlocks, evmWindowSecs: config.policy.evmWindowSecs, minConfsFor: config.policy.minConfsFor } });
  const published = new Map();
  const counter = { publishEvmOffer: async (id, offer) => { published.set(id, offer); } };
  const el = makeEthereumLocker({ seed, now, store: swaps, quotes: { get: quoter.get }, btc, evm, counter, policy: config.policy });
  const health = { ok: true, lastTick: 0, lastError: null };
  const reported = new Set(), lastAlert = new Map();

  // notes already given to a stored lock stay reserved after a restart
  async function start() { for (const rec of await swaps.list()) if (evm.reserve) evm.reserve(rec); }

  async function tick() {
    try {
      const recs = await swaps.list();
      // a record the store cannot read is a swap nobody is advancing: say so once, loudly
      for (const p of (swaps.problems && swaps.problems()) || []) if (!reported.has(p.id)) { reported.add(p.id); alert({ level: 'alert', msg: 'a swap record cannot be read', id: p.id, error: p.error }); }
      for (const rec of recs) {
        if (TERMINAL.has(rec.phase)) continue;
        const before = rec.phase;
        let next;
        try { next = await el.step(rec); } catch (e) { log({ level: 'error', msg: 'swap step threw', id: rec.id, error: String((e && e.message) || e).slice(0, 200) }); continue; }
        if (next.phase !== before) log({ level: 'info', msg: 'swap', id: next.id, from: before, to: next.phase, why: next.why });
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
      health.ok = true; health.lastError = null;
    } catch (e) { health.ok = false; health.lastError = String((e && e.message) || e).slice(0, 200); log({ level: 'error', msg: 'tick failed', error: health.lastError }); }
    health.lastTick = now();
  }

  const offerOf = async (id) => published.get(id) || (await swaps.get(id))?.evmOffer || null;

  // A request in, { status, body } out. The HTTP layer owns the limits per client; nothing here reads the address.
  async function handle({ method, path, body }) {
    try {
      if (method === 'GET' && path === '/health') return { status: health.ok ? 200 : 503, body: { ok: health.ok, lastTick: health.lastTick, error: health.lastError } };
      if (method === 'GET' && path === '/info') {
        const q = config.quote;
        return { status: 200, body: { v: 1, claimPub: config.claimPub, btcAsset: q.btcAsset, evmAsset: q.evmAsset, minAmount: String(q.minAmount), maxAmount: String(q.maxAmount), feeBps: q.feeBps, flatFee: String(q.flatFee ?? 0), csvBlocks: config.csvBlocks, evmWindowSecs: config.policy.evmWindowSecs, minClaimSecs: config.policy.minClaimSecs } };
      }
      if (method === 'POST' && path === '/quote') {
        if (!body || !/^\d+$/.test(String(body.amount))) return { status: 400, body: { error: 'amount must be a whole number' } };
        return { status: 200, body: await quoter.quote(body.amount) };
      }
      if (method === 'POST' && path === '/offer') {
        if (!body || typeof body.quoteId !== 'string' || !body.offer || typeof body.offer !== 'object') return { status: 400, body: { error: 'quoteId and offer are required' } };
        const r = await el.receive({ quoteId: body.quoteId, offer: body.offer });
        return { status: 200, body: r.ok ? { ok: true, phase: r.rec.phase } : { ok: false, retry: !!r.retry, why: r.why } };
      }
      const m = /^\/swap\/([0-9a-f]{72})(\/offer)?$/.exec(path);
      if (method === 'GET' && m) {
        if (m[2]) { const o = await offerOf(m[1]); return o ? { status: 200, body: o } : { status: 404, body: { error: 'no offer yet' } }; }
        const rec = await swaps.get(m[1]);
        return rec ? { status: 200, body: { phase: rec.phase, why: rec.why || null } } : { status: 404, body: { error: 'unknown swap' } };
      }
      return { status: 404, body: { error: 'not found' } };
    } catch (e) {
      return { status: e.status || 500, body: { error: e.status ? String(e.message) : 'the service could not answer' } };
    }
  }

  return { el, quoter, start, tick, handle, health, offerOf };
}
