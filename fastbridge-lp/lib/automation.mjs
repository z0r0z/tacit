// A pair provider's upkeep, one look at a time: what it holds against its target, the lean of its price (lib/skew.mjs), the accounting of each finished swap
// (lib/stats.mjs), the move of take coins to the reverse address (lib/recycle.mjs), the merge of small ETH notes (lib/notes.mjs) and, past the target, the
// buyback sends (lib/buyback.mjs). Every action is logged; a failure is alerted, at most once an hour for each kind. The daemon (server.mjs) wires the reads
// and the sends; nothing here holds a key.
//
//   const a = makeAutomation({ cfg, kv, rate, fwd, rev, fwdQuote, revQuote, ethFree, ethNotes, btcSats, txFee, relayFee, quiet, gate, merge, sendBuyback,
//                              readBought, balanceAt, recycler, feeAtMin, now, log, alert })
//   await a.tick()      a.skew()      a.info() -> the fields /info adds

import { emptyStats, addSwap, addVolume, addCost, sampleCapacity, forwardEntry, reverseEntry, statsView, satsToEth, ethToSats } from './stats.mjs';
import { skewBps } from './skew.mjs';
import { noteReport, planMerge } from './notes.mjs';
import { planBuyback, attributeBuys } from './buyback.mjs';

const DAY = 86400;
const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };
const err = (e) => String((e && e.message) || e).slice(0, 200);

export function makeAutomation({ cfg, kv, rate, fwd, rev = null, fwdQuote, revQuote = async () => null, ethFree, ethNotes = async () => [], btcSats = async () => null, txFee, relayFee = async () => 0n,
  quiet = async () => false, gate = (fn) => fn(), merge = null, sendBuyback = null, readBought = null, balanceAt = null, recycler = null, feeAtMin = {}, now = () => Math.floor(Date.now() / 1000), log = () => {}, alert = () => {} }) {
  let st = null, cur = { skewBps: 0, above: false, eth: null, sats: null, notes: null, at: 0 };
  const due = new Map(), saidAt = new Map();
  const every = (k, secs) => { const t = now(); if (t - (due.get(k) ?? -Infinity) < secs) return false; due.set(k, t); return true; };
  const fail = (k, msg, e) => { const t = now(); if (t - (saidAt.get(k) ?? -Infinity) >= 3600) { saidAt.set(k, t); alert({ level: 'warn', msg, error: err(e) }); } else log({ level: 'warn', msg, error: err(e) }); };

  async function state() {
    if (st) return st;
    const kept = await kv.get('stats').catch(() => null);
    st = kept && kept.v === 1 ? { ...emptyStats(now()), ...kept, buyback: { ...emptyStats(0).buyback, ...(kept.buyback || {}) }, capacity: { ...emptyStats(0).capacity, ...(kept.capacity || {}) } } : emptyStats(now());
    return st;
  }
  const keep = async () => { await kv.put({ id: 'stats', ...st }); };

  // what it holds: the free ETH, the sats at the reverse address, their sum in ETH, and whether both sides are at their target
  async function measure() {
    const r = rate();
    const [eth, sats] = await Promise.all([ethFree().catch(() => null), btcSats().catch(() => null)]);
    cur.eth = eth == null ? null : big(eth); cur.sats = sats == null ? null : big(sats); cur.at = now();
    if (!r) return { r: null };
    const targetSats = ethToSats(cfg.target.btcAsEth, r);
    cur.above = cur.eth != null && cur.sats != null && cur.eth >= cfg.target.eth && cur.sats >= targetSats;
    cur.targetSats = targetSats;
    cur.skewBps = cur.eth != null && cur.sats != null && rev ? skewBps({ ethValueSats: ethToSats(cur.eth, r), btcSats: cur.sats, cfg: cfg.skew, feeAtMinBps: feeAtMin }) : 0;
    if (cur.eth != null) sampleCapacity(st, { eth: cur.eth, sats: cur.sats ?? 0n, valueEth: cur.eth + satsToEth(cur.sats ?? 0n, r) }, now());
    return { r };
  }

  // swaps that ended before the accounting began are not counted (their quotes kept no market rate): `since` is when it began
  async function seed() {
    if (st.seeded) return;
    const FWD = new Set(['done', 'refunded', 'lost', 'rejected', 'aborted']), REV = new Set(['done', 'refunded', 'counter-took', 'aborted']);
    for (const rec of await fwd.list()) if (FWD.has(rec.phase)) st.counted['f:' + rec.id] = 'before';
    if (rev) for (const rec of await rev.list()) if (REV.has(rec.phase)) st.counted['r:' + rec.id] = 'before';
    st.seeded = true; await keep();
  }
  async function account(r) {
    if (!r) return 0;
    await seed();
    let n = 0;
    const owe = !!(cfg.buyback.enabled && cur.above);
    for (const rec of await fwd.list()) {
      if (st.counted['f:' + rec.id]) continue;
      const e = await forwardEntry(rec, rec.quoteId ? await fwdQuote(rec.quoteId).catch(() => null) : null, { txFee, relayFee }).catch((x) => { fail('account', 'stats: a swap could not be counted yet', x); return null; });
      if (!e) continue;
      addSwap(st, e, { rate: r, owe }); n++;
      log({ level: 'info', msg: 'stats: a swap is counted', id: rec.id, dir: 'fwd', end: e.end, feeSats: String(e.feeSats), costSats: String(e.costSats), costEth: String(e.costEth), owed: owe });
      if (e.end === 'lost') alert({ level: 'alert', msg: 'stats: a BTC -> ETH swap ended with nothing received for the ETH locked', id: rec.id, eth: String(e.lossEth) });
    }
    if (rev) for (const rec of await rev.list()) {
      if (st.counted['r:' + rec.id]) continue;
      const e = await reverseEntry(rec, rec.quoteId ? await revQuote(rec.quoteId).catch(() => null) : null, { txFee }).catch((x) => { fail('account', 'stats: a swap could not be counted yet', x); return null; });
      if (!e) continue;
      addSwap(st, e, { rate: r, owe }); n++;
      log({ level: 'info', msg: 'stats: a swap is counted', id: rec.id, dir: 'rev', end: e.end, feeEth: String(e.feeEth), costSats: String(e.costSats), owed: owe });
      if (e.end === 'lost') alert({ level: 'alert', msg: 'stats: an ETH -> BTC swap ended with its Bitcoin lock taken and no claim recorded', id: rec.id, sats: String(e.lossSats) });
    }
    // the Bitcoin moved and the time taken by the swaps counted above that finished (each once; those from before the accounting are not in it)
    let vol = 0;
    for (const [list, tag, ends] of [[await fwd.list(), 'f:', ['done']], [rev ? await rev.list() : [], 'r:', ['done']]]) {
      for (const rec of list) {
        const c = st.counted[tag + rec.id];
        if (c && c !== 'before' && ends.includes(rec.phase)) {
          const quote = rec.quoteId ? await (tag === 'f:' ? fwdQuote(rec.quoteId) : revQuote(rec.quoteId)).catch(() => null) : null;
          if (addVolume(st, { id: tag + rec.id, sats: rec.amount, eth: quote && quote.evmAmount, secs: Number(rec.updated) - Number(rec.created) })) vol++;
        }
      }
    }
    if (vol) await keep();
    return n;
  }

  async function hygiene(r) {
    const notes = await ethNotes().catch(() => null);
    if (!notes) return;
    const cut = await relayFee().catch(() => 0n);
    cur.notes = noteReport(notes, { cutFee: cut, dustUnits: cfg.notes.dustUnits });
    if (!cfg.notes.enabled || !merge) return;
    const day = Math.floor(now() / DAY);
    if (st.mergeDay !== day) { st.mergeDay = day; st.mergesToday = 0; }
    if (st.mergesToday >= cfg.notes.maxPerDay) return;
    const plan = planMerge(notes, { fee: cut, cfg: cfg.notes });
    if (plan.skip) return;
    // in the pool's turn, and only while nothing is under way: the notes merged are none a lock waits on
    await gate(async () => {
      if (!(await quiet())) { log({ level: 'info', msg: 'notes: a merge waits: a swap is under way' }); return; }
      st.mergesToday += 1; await keep();
      log({ level: 'info', msg: 'notes: merging small ETH notes into one, to the provider\'s own key', notes: plan.notes.length, sum: String(plan.sum), fee: String(plan.fee) });
      try {
        const res = await merge({ notes: plan.notes, amount: plan.out, fee: plan.fee });
        if (res && res.fee != null) plan.fee = big(res.fee);
        if (plan.fee > 0n) addCost(st, { eth: plan.fee }, { rate: r });
        alert({ level: 'info', msg: 'notes: small ETH notes merged', notes: plan.notes.length, sum: String(plan.sum), fee: String(plan.fee), tx: (res && res.txHash) || null });
      } catch (e) { fail('merge', 'notes: a merge failed', e); }
      await keep();
    });
  }

  async function buyback(r) {
    const b = st.buyback, c = cfg.buyback;
    if (c.enabled && !b.startedAt) { b.startedAt = now(); alert({ level: 'info', msg: 'buyback: on. Past the target, what the provider nets is sent to TacBuyback', to: c.to }); }
    const day = Math.floor(now() / DAY);
    if (b.day !== day) { b.day = day; b.dayRouted = '0'; }
    // a send that did not finish (a restart, an error): its note gone means it went (counted, said to be checked), still there a while later means it did not
    if (b.pending) {
      const notes = await ethNotes().catch(() => null);
      if (notes) {
        const p = b.pending;
        if (notes.some((n) => String(n.leaf).toLowerCase() === p.leaf)) { if (now() - p.at > 900) { log({ level: 'info', msg: 'buyback: a send that did not finish left its note unspent: it is planned again', amount: p.amount }); b.pending = null; } }
        else if (now() - p.at > 1800) {
          record({ amount: big(p.amount), fee: 0n, txHash: null }, r);
          alert({ level: 'warn', msg: 'buyback: a send that did not finish (a restart or an error) spent its note: counted as sent, check the TacBuyback balance', amount: p.amount });
        }
      }
      return;
    }
    const plan = planBuyback({ owed: big(st.owedEth), ethFree: cur.eth, targetEth: cfg.target.eth, aboveTarget: cur.above, dayRouted: big(b.dayRouted), cfg: c, quiet: true });
    if (plan.skip) { if (c.enabled && big(st.owedEth) > 0n) log({ level: 'info', msg: 'buyback: nothing sent', why: plan.skip, owed: st.owedEth }); return; }
    if (!sendBuyback) return;
    await gate(async () => {
      if (!(await quiet())) { log({ level: 'info', msg: 'buyback: a send waits: a swap is under way' }); return; }
      const notes = await ethNotes();
      const note = notes.filter((n) => big(n.value) >= plan.amount).sort((x, y) => (big(x.value) < big(y.value) ? -1 : 1))[0];
      if (!note) { log({ level: 'info', msg: 'buyback: no single note covers the send: it waits for a merge', amount: String(plan.amount) }); return; }
      b.pending = { leaf: String(note.leaf).toLowerCase(), amount: String(plan.amount), at: now() }; await keep();
      try {
        const res = await sendBuyback({ note, amount: plan.amount, to: c.to });
        record({ amount: plan.amount, fee: big(res && res.fee), txHash: (res && res.txHash) || null, block: res && res.block }, r);
        alert({ level: 'info', msg: 'buyback: ETH sent to TacBuyback', amount: String(plan.amount), fee: String(big(res && res.fee)), tx: (res && res.txHash) || null });
      } catch (e) { b.pending.at = now(); fail('buyback', 'buyback: a send failed: its note is looked at again before any other send', e); }
      await keep();
    });
  }
  function record({ amount, fee, txHash, block = null }, r) {
    const b = st.buyback, got = amount > fee ? amount - fee : 0n;
    // the buys counted as the provider's start after its first send reached the contract
    if (b.fromBlock == null && Number.isInteger(block)) b.fromBlock = block;
    st.owedEth = String(big(st.owedEth) > amount ? big(st.owedEth) - amount : 0n);
    if (fee > 0n) { st.networkCostEth = String(big(st.networkCostEth) + fee); }
    b.routedEth = String(big(b.routedEth) + got); b.feesEth = String(big(b.feesEth) + fee); b.sends += 1; b.dayRouted = String(big(b.dayRouted) + amount);
    b.lastTx = txHash; b.lastAt = now(); b.pending = null;
    b.log = [...(b.log || []), { at: now(), eth: String(got), fee: String(fee), tx: txHash }].slice(-30);
    void r;
  }

  // the TAC the contract bought, the provider's share of each buy, from its Bought events after the provider's first send
  async function scanBuys() {
    const b = st.buyback, pending = big(b.routedEth) - big(b.attributed);
    if (!readBought || !balanceAt || !b.sends || pending <= 0n || b.fromBlock == null) return;
    const got = await readBought(b.fromBlock);
    if (!got) return;
    const res = await attributeBuys({ events: got.events, pending: pending * 10n ** 10n, balanceBefore: (ev) => balanceAt(ev.block - 1) });
    b.tacBought = String(big(b.tacBought) + res.tac);
    b.attributed = String(big(b.attributed) + res.used / 10n ** 10n);
    b.fromBlock = got.toBlock + 1;
    if (res.tac > 0n) log({ level: 'info', msg: 'buyback: TAC bought with the provider\'s ETH', tac: String(res.tac), buys: got.events.length });
  }

  async function tick() {
    await state();
    let r = null;
    try { ({ r } = await measure()); } catch (e) { fail('measure', 'automation: what the provider holds could not be read', e); }
    try { if (await account(r)) await keep(); } catch (e) { fail('account', 'stats: the accounting failed', e); }
    if (recycler && every('recycle', cfg.recycle.everySecs)) {
      try { await recycler.step(); } catch (e) { fail('recycle', 'recycle: a look failed', e); }
    }
    if (every('notes', cfg.notes.everySecs)) { try { await hygiene(r); } catch (e) { fail('notes', 'notes: a look failed', e); } }
    if (every('buyback', cfg.buyback.everySecs)) { try { await buyback(r); } catch (e) { fail('buyback', 'buyback: a look failed', e); } }
    if (every('buys', cfg.buyback.scanSecs)) { try { await scanBuys(); } catch (e) { fail('buys', 'buyback: the buys could not be read', e); } }
    await keep().catch((e) => fail('keep', 'automation: the stats could not be kept', e));
  }

  // a moved take coin's fee is a cost of the provider's own (told by the recycler when the move confirms)
  async function onMoved({ fee }) { await state(); const r = rate(); addCost(st, { sats: fee }, { rate: r }); await keep(); }

  function info() {
    if (!st) return null;
    const b = st.buyback;
    return {
      stats: statsView(st, { notes: cur.notes }),
      target: { eth: String(cfg.target.eth), btcAsEth: String(cfg.target.btcAsEth), sats: cur.targetSats != null ? String(cur.targetSats) : null, reached: cur.above },
      skewBps: cur.skewBps,
      buyback: { on: !!cfg.buyback.enabled, to: cfg.buyback.to, startedAt: b.startedAt || null, owedEth: st.owedEth, routedEth: b.routedEth, feesEth: b.feesEth, sends: b.sends, tacBought: b.tacBought, lastTx: b.lastTx, lastAt: b.lastAt },
    };
  }
  return { tick, info, skew: () => cur.skewBps, onMoved, state };
}
