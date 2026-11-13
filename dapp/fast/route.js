// The fast bridge as a way for TAC to come in from Bitcoin, for a page that has its own form (the front page's Bridge tab): for a note of
// a size, whether a provider takes it and what it costs, the bridge itself, and the bridges under way. No DOM. The provider list, the
// key's session and the clock are passed in, so the rule runs without a wallet.
//
//   const fr = makeFastRoute({ discover, open, ownId })
//   discover()      -> [{ id, name, ref, terms }]  the providers there are (fast/wire.js discoverProviders)
//   open()          -> the key's session (fast/wire.js openFast): quoteAll, start, cost, records, run
//   ownId()         -> the key's own provider id (its Bitcoin public key), which is not one to bridge with, or null
//
//   fr.offer(units)         -> { ok: true, quotes, quote, provider, minutes } | { ok: false, why, min, max }
//                              why: 'none' (no provider online), 'size' (none takes that amount now), 'dear' (every quote is dearer than
//                              the page accepts), 'busy' (the providers did not answer), 'error'
//   fr.cost(offer, note)    -> { fee, take, total, have, short, need } what the lock costs on Bitcoin, and whether the address can pay it
//   fr.fit(offer, note)     -> the offer led by the first of its providers that takes this note, with its `cost`; { ok: false, why:
//                              'lineage' } when every one of them turns the note's history away
//   fr.start(offer, note)   -> the bridge, begun with that note and the best provider that will hold the payout
//   fr.records()            -> the bridges, newest first, in words (fastbridge-client.js describe)
//   fr.run(onChange)        -> stop(): the steps taken while the page is open

import { fmtTac, highFee, highTake, lineageText } from './fmt.js';

// What a provider takes now: its most, or less when it says so.
export const capOf = (t) => (t.available != null && t.available < t.maxAmount ? t.available : t.maxAmount);
export const takes = (t, units) => units >= t.minAmount && units <= capOf(t);

// About how long a bridge takes from the press: a Bitcoin block a confirmation, then the pool's settle.
export const minutesFor = (confs = 1) => 10 * Math.max(1, Number(confs) || 1) + 5;

export function makeFastRoute({ discover, open, ownId = () => null, refreshMs = 30000, now = () => Date.now() }) {
  let list = null, at = -Infinity, reading = null, empties = 0;
  async function providers(force = false) {
    if (!force && list && now() - at < refreshMs) return list;
    if (reading) return reading;
    reading = (async () => {
      // one empty read may be a board that did not answer, so the list read stands; a second in a row is the providers gone
      try { const ps = await discover(); empties = ps.length ? 0 : empties + 1; if (ps.length || !list || empties >= 2) list = ps; at = now(); } catch { at = now(); if (!list) list = []; }
      return list;
    })().finally(() => { reading = null; });
    return reading;
  }
  const others = (ps) => { const me = ownId(); return ps.filter((p) => !me || p.id !== me); };

  async function offer(units) {
    const u = BigInt(units), ps = others(await providers());
    if (!ps.length) return { ok: false, why: 'none' };
    const takers = ps.filter((p) => takes(p.terms, u));
    const min = ps.reduce((a, p) => (a == null || p.terms.minAmount < a ? p.terms.minAmount : a), null);
    const max = ps.reduce((a, p) => { const c = capOf(p.terms); return a == null || c > a ? c : a; }, null);
    if (!takers.length) return { ok: false, why: 'size', min, max };
    let r;
    try { r = await (await open()).quoteAll(takers, u); } catch (e) { return { ok: false, why: 'error', error: e, min, max }; }
    if (!r.quotes.length) {
      const dear = r.failed.length > 0 && r.failed.every((f) => /fee is above the limit/.test(String((f.error && f.error.message) || '')));
      return { ok: false, why: dear ? 'dear' : r.failed.length ? 'busy' : 'size', min, max, error: r.failed[0] && r.failed[0].error };
    }
    // a quote with a high fee is not a reason to leave the regular bridge: the fast page quotes it, with a warning, for whoever wants it
    const fair = r.quotes.filter((x) => !highFee(x.quote) && !highTake(x.quote));
    if (!fair.length) return { ok: false, why: 'dear', min, max };
    const best = fair[0];
    return { ok: true, quotes: fair, quote: best.quote, provider: best.provider, minutes: minutesFor(best.quote.minConfs), min, max };
  }

  async function cost(o, note) {
    const s = await open();
    if (typeof s.cost !== 'function') return null;
    return s.cost({ quote: o.quote, provider: o.provider, only: [{ txid: note.txid, vout: note.vout }] });
  }
  // A provider that screens TAC's history turns some notes away, which only pricing the lock for the note tells: the offer comes back led
  // by the first provider that takes it, so what the form names is who pays. A cost that could not be read for another reason is left out.
  async function fit(o, note) {
    const s = await open();
    if (typeof s.cost !== 'function') return o;
    const only = [{ txid: note.txid, vout: note.vout }];
    for (let i = 0; i < o.quotes.length; i++) {
      const x = o.quotes[i], led = { ...o, quotes: o.quotes.slice(i), quote: x.quote, provider: x.provider, minutes: minutesFor(x.quote.minConfs) };
      try { return { ...led, cost: await s.cost({ quote: x.quote, provider: x.provider, only }) }; }
      catch (e) { if (!e || e.code !== 'lineage') return { ...led, cost: null }; }
    }
    return { ok: false, why: 'lineage', min: o.min, max: o.max };
  }
  async function start(o, note) {
    const s = await open();
    return s.start({ quotes: o.quotes, only: [{ txid: note.txid, vout: note.vout }] });
  }
  // which providers could take a lock for this much of the key's TAC: 'all', 'any' (only one that takes any TAC) or 'none' (fast/wire.js reach)
  async function reach(units) { const s = await open(); return typeof s.reach === 'function' ? s.reach(BigInt(units)) : 'all'; }
  async function records() { return (await open()).records(); }
  // `onFail(error)`: the session could not be opened, so nothing is being taken on (the caller may ask again)
  function run(onChange, onFail = () => {}) {
    let stop = () => {}, gone = false;
    open().then((s) => { if (!gone) stop = s.run({ onChange }); }).catch((e) => { if (!gone) onFail(e); });
    return () => { gone = true; stop(); };
  }

  return { offer, cost, fit, start, records, run, providers, reach };
}

// ── what a form says of an offer: plain text and rows, for the Bridge tab (which draws them) ──

const sats = (v) => `${Number(v).toLocaleString('en-US')} sats`;
const pct = (fee, of) => (of > 0n ? `${(Number((BigInt(fee) * 1000000n) / BigInt(of)) / 10000).toFixed(2)}%` : '');

// the address lacks the sats for the Bitcoin fee
export const shortText = (c) => `This key’s Bitcoin address holds ${sats(c.have || 0)} for fees, short of the ${sats(c.need || 0)} this needs. Add some from Receive on the Bitcoin tab.`;

// the receipt rows ([name, value, class, hover]) and the press's label for an offer that can be had
export function shown(o) {
  const q = o.quote, c = o.cost;
  return {
    out: fmtTac(q.evmAmount), go: 'Bridge fast', fast: true, warn: !!(c && c.short), line: c && c.short ? shortText(c) : '',
    rc: [['Arrives', `${fmtTac(q.evmAmount)} private TAC on Ethereum`], ['Provider fee', `${fmtTac(q.fee)} TAC (${pct(q.fee, q.btcValue)})`, '', (o.provider && o.provider.name) || ''],
      ['Bitcoin fee', c && c.total ? `≈ ${sats(c.total)}` : 'in sats', '', c && c.take ? `${sats(c.take)} of it is the provider’s take` : ''],
      ['Time', `about ${o.minutes} minutes`], ['If it stalls', 'the lock returns to your address after about a day']],
  };
}

// why the fast bridge is not offered, when providers are online and none takes this note: one row of the regular receipt (null when there is nothing to say)
export function whyRow(o) {
  if (!o || o.ok || o.why === 'none' || o.why === 'error') return null;
  const size = o.min != null && o.max != null && BigInt(o.max) >= BigInt(o.min) ? `providers take ${fmtTac(o.min)} to ${fmtTac(o.max)} TAC now` : 'the providers have no room right now';
  return ['Fast bridge', o.why === 'size' ? size : o.why === 'dear' ? 'the providers’ fee is over 5% at this size; the fast page can still bridge it'
    : o.why === 'lineage' ? 'the providers online do not take this note’s history' : 'the providers did not answer'];
}

// the first press of the bridge: what it does, what it costs and what happens if the provider stops
export function confirmText(o, amt) {
  const who = (o.provider && o.provider.name) || 'the provider', c = o.cost;
  return `Bridging ${amt} locks it on Bitcoin until ${who} has paid you ${fmtTac(o.quote.evmAmount)} private TAC in the pool, in about ${o.minutes} minutes${c && c.total ? `, for about ${sats(c.total)} in Bitcoin fees` : ''}. If it does not, the lock returns to your address after about a day. Press again to bridge.`;
}

// a failure of the bridge, in the page's words
export function failMessage(e) {
  const m = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e || ''), x = /need (\d+), have (\d+)/.exec(m);
  return x ? shortText({ need: Number(x[1]), have: Number(x[2]) })
    : e && e.code === 'lineage' ? lineageText(e)
    : e && e.code === 'lineage_unread' ? 'Could not read this TAC’s history just now, so nothing was locked. Try again.'
    : /already part of a swap/.test(m) ? 'This note is already in a bridge.'
    : /cannot hold that amount|cannot take/.test(m) ? 'The provider cannot take that amount right now. Use the regular bridge, or try again.'
    : m.slice(0, 200) || 'Something went wrong. Try again.';
}
