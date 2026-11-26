// Moving the sats a pair provider takes back into what it sells. A BTC -> ETH swap ends with the provider's take of the user's lock, paid to its MAIN address;
// the ETH -> BTC side locks from its REVERSE address (lib/reverse.mjs). This moves the take coins from the one to the other, so what the forward side earns backs
// the reverse side without a hand on it (tools/fastbridge-lp-reverse-topup.mjs is the same move, one coin at a time, by hand).
//
// What it touches, and nothing else:
//   - only coins that a take of this provider's own finished swaps paid to the main address, read by the take's transaction id (the main address is never listed:
//     explorers refuse an address with that many outputs), each a plain P2WPKH output of the main key, confirmed, unspent, of minCoin..maxCoin sats (a coin of
//     note size is never one: a Tacit note rides on a dust output)
//   - never a coin that a swap under way names anywhere in its record, never one an earlier move of this module is still spending
//   - one output: the reverse address of the same key (derived, never typed). The transaction signals replacement (RBF) and is replaced at a higher rate if it
//     waits too long, with the same inputs and the same single output
//   - the fee rate is the median of two or more explorers that agree within a factor of 4; above `maxFeeRate` it waits. A batch is several coins in one
//     transaction, at least `minBatchSats`, with a fee of at most `maxFeeShareBps` of it; at most `maxPerTickSats` per move and `maxPerDaySats` per UTC day
//   - the first look after a start only says what it would move (a dry run), and FB_LP_RECYCLE=off stops it
//
//   const r = makeRecycler({ cfg, btc, fwd, rev, mainSpk, reverseSpk, sign, load, save, fetchImpl, bases, now, log, alert })
//   await r.step()        one look: a move, a wait, or nothing to do (returns what it did)

export const DUST = 546;
const TX_OVERHEAD_VB = 11, P2WPKH_IN_VB = 68, P2WPKH_OUT_VB = 31;
export const vsizeOf = (inputs) => TX_OVERHEAD_VB + P2WPKH_IN_VB * inputs + P2WPKH_OUT_VB;
const DAY = 86400;
const isTxid = (t) => /^[0-9a-f]{64}$/.test(String(t || ''));
const FWD_TERMINAL = new Set(['done', 'refunded', 'rejected', 'aborted', 'lost']);
const REV_TERMINAL = new Set(['done', 'refunded', 'counter-took', 'aborted']);

export const RECYCLE_DEFAULTS = Object.freeze({
  enabled: true, everySecs: 600, minCoin: 10_000, maxCoin: 5_000_000, minBatchSats: 150_000, maxInputs: 20, maxFeeShareBps: 50,
  maxPerTickSats: 3_000_000, maxPerDaySats: 10_000_000, maxFeeRate: 25, feeTarget: '6', minAnswers: 2, keepSats: 0, bumpSecs: 6 * 3600, maxBumps: 2, readsPerTick: 30,
});

const int = (name, v, min, max) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`recycle.${name} must be a whole number from ${min} to ${max} (got "${v}")`); return n; };

// The settings, from the config's `recycle` block and FB_LP_RECYCLE (on / off). A value that is set and not valid stops the process (it does not start on a guess).
export function recycleConfig(C = {}, env = process.env) {
  const r = { ...RECYCLE_DEFAULTS, ...((C && typeof C.recycle === 'object' && C.recycle) || {}) };
  if (C && C.recycle === false) r.enabled = false;
  const sw = env.FB_LP_RECYCLE != null ? String(env.FB_LP_RECYCLE).trim().toLowerCase() : '';
  if (sw) { if (sw !== 'on' && sw !== 'off') throw new Error(`FB_LP_RECYCLE must be on or off (got "${env.FB_LP_RECYCLE}")`); r.enabled = sw === 'on'; }
  const out = {
    enabled: r.enabled !== false, everySecs: int('everySecs', r.everySecs, 60, 86400), minCoin: int('minCoin', r.minCoin, 5_000, 1e9), maxCoin: int('maxCoin', r.maxCoin, 10_000, 21e14),
    minBatchSats: int('minBatchSats', r.minBatchSats, 10_000, 21e14), maxInputs: int('maxInputs', r.maxInputs, 1, 100), maxFeeShareBps: int('maxFeeShareBps', r.maxFeeShareBps, 1, 1000),
    maxPerTickSats: int('maxPerTickSats', r.maxPerTickSats, 10_000, 21e14), maxPerDaySats: int('maxPerDaySats', r.maxPerDaySats, 10_000, 21e14), maxFeeRate: int('maxFeeRate', r.maxFeeRate, 1, 1000),
    feeTarget: String(r.feeTarget), minAnswers: int('minAnswers', r.minAnswers, 2, 10), keepSats: int('keepSats', r.keepSats, 0, 21e14), bumpSecs: int('bumpSecs', r.bumpSecs, 600, 7 * DAY),
    maxBumps: int('maxBumps', r.maxBumps, 0, 10), readsPerTick: int('readsPerTick', r.readsPerTick, 1, 500),
  };
  if (out.minCoin > out.maxCoin) throw new Error('recycle.minCoin must not be over recycle.maxCoin');
  return out;
}

// The fee rate two or more explorers agree on (sat/vB): the median of their estimates for `target` blocks. Too few answers, answers that differ by more than
// a factor of 4, or a median above `cap` is a reason to wait, thrown as such (`wait: true`).
export async function agreedFeeRate({ bases, fetchImpl = (...a) => fetch(...a), target = '6', minAnswers = 2, cap = 25, timeoutMs = 15000 }) {
  const seen = (await Promise.all((bases || []).map(async (b) => {
    try {
      const r = await fetchImpl(String(b).replace(/\/$/, '') + '/fee-estimates', { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return null;
      const f = await r.json(), v = Number(f[target] ?? f['6']);
      return Number.isFinite(v) && v > 0 && v < 5000 ? Math.max(1, v) : null;      // (a node's sub-1 estimate is the 1 sat/vB floor: 0.124 against 1 is not a disagreement)
    } catch { return null; }
  }))).filter((v) => v != null).sort((a, b) => a - b);
  const wait = (why) => Object.assign(new Error(why), { wait: true });
  if (seen.length < minAnswers) throw wait(`${seen.length} explorer${seen.length === 1 ? '' : 's'} gave a fee estimate, ${minAnswers} are needed`);
  if (seen[seen.length - 1] > seen[0] * 4) throw wait(`the explorers' fee estimates disagree (${seen[0]} to ${seen[seen.length - 1]} sat/vB)`);
  const mid = seen.length % 2 ? seen[(seen.length - 1) / 2] : (seen[seen.length / 2 - 1] + seen[seen.length / 2]) / 2;
  const rate = Math.max(1, Math.ceil(mid));
  if (rate > cap) throw wait(`the fee rate is ${rate} sat/vB, over the ${cap} this waits under`);
  return rate;
}

// Every outpoint a record names anywhere ({ txid, vout } at any depth): the coins a swap under way may be spending or waiting on
export function outpointsIn(rec, into = new Set()) {
  const walk = (x, depth) => {
    if (!x || typeof x !== 'object' || depth > 8) return;
    if (Array.isArray(x)) { for (const v of x) walk(v, depth + 1); return; }
    if (isTxid(String(x.txid || '').toLowerCase()) && Number.isInteger(Number(x.vout)) && x.vout !== null && x.vout !== '') into.add(`${String(x.txid).toLowerCase()}:${Number(x.vout)}`);
    for (const v of Object.values(x)) walk(v, depth + 1);
  };
  walk(rec, 0);
  return into;
}
export function busyOutpoints(fwdRecs = [], revRecs = []) {
  const s = new Set();
  for (const r of fwdRecs) if (r && !FWD_TERMINAL.has(r.phase)) outpointsIn(r, s);
  for (const r of revRecs) if (r && !REV_TERMINAL.has(r.phase)) outpointsIn(r, s);
  return s;
}

// The transactions that paid this provider for its finished BTC -> ETH swaps: each finished swap's takes (a take replaced for a higher fee is one more id; only
// the one that confirmed pays anything, and a read of the others finds no coin)
export function takeTxids(fwdRecs = []) {
  const out = new Set();
  for (const r of fwdRecs) {
    if (!r || r.phase !== 'done') continue;
    for (const t of [r.takenBy, r.take && r.take.txid, ...(r.takes || [])]) if (isTxid(t)) out.add(t);
  }
  return [...out];
}

// The coins that may be moved: in range, not named by a swap under way, not being spent by an earlier move
export function eligibleCoins(coins, { cfg, busy = new Set(), spending = new Set() }) {
  const seen = new Set();
  return coins.filter((c) => {
    const k = `${c.txid}:${c.vout}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return Number.isInteger(c.value) && c.value >= cfg.minCoin && c.value <= cfg.maxCoin && !busy.has(k) && !spending.has(k);
  });
}

// What one move would be: the largest coins first (fewest inputs for the sats), the smallest kept back up to `keepSats` (fee coins for the main address),
// within the caps. -> { inputs, sum, fee, out, vsize, rate } or { skip: why }
export function planBatch({ coins, rate, cfg, movedToday = 0 }) {
  const sorted = coins.slice().sort((a, b) => b.value - a.value || (a.txid < b.txid ? -1 : 1));
  let kept = 0;
  while (cfg.keepSats > 0 && sorted.length && kept < cfg.keepSats) kept += sorted.pop().value;
  const room = Math.min(cfg.maxPerTickSats, cfg.maxPerDaySats - movedToday);
  if (room < cfg.minBatchSats) return { skip: `the day's moves have reached ${movedToday} of ${cfg.maxPerDaySats} sats` };
  const inputs = [];
  let sum = 0;
  for (const c of sorted) { if (inputs.length >= cfg.maxInputs) break; if (sum + c.value > room) continue; inputs.push(c); sum += c.value; }
  if (!inputs.length || sum < cfg.minBatchSats) return { skip: `${sum} sats can be moved, under the batch of ${cfg.minBatchSats}` };
  const vsize = vsizeOf(inputs.length), fee = Math.ceil(vsize * rate);
  if (fee * 10000 > sum * cfg.maxFeeShareBps) return { skip: `the fee (${fee} sats at ${rate} sat/vB) would be over ${cfg.maxFeeShareBps / 100}% of the ${sum} sats` };
  if (sum - fee < DUST) return { skip: 'what would arrive is dust' };
  return { inputs, sum, fee, out: sum - fee, vsize, rate };
}

// The transaction of a plan: every input a P2WPKH coin of the main key (its script checked against the main key's), one output to the reverse key's script,
// replaceable. `sign(tx, i, value)` -> the input's witness. -> { tx, out } (the caller serializes and sends)
export function buildRecycleTx({ plan, mainSpk, reverseSpk, sign }) {
  const lc = (h) => String(h || '').toLowerCase();
  if (!/^0014[0-9a-f]{40}$/.test(lc(mainSpk)) || !/^0014[0-9a-f]{40}$/.test(lc(reverseSpk))) throw new Error('recycle: the scripts must be P2WPKH');
  if (lc(mainSpk) === lc(reverseSpk)) throw new Error('recycle: the reverse address must not be the main address');
  if (!plan || !plan.inputs || !plan.inputs.length) throw new Error('recycle: nothing to move');
  for (const c of plan.inputs) if (lc(c.spk) !== lc(mainSpk)) throw new Error('recycle: a coin is not an output of the main key: nothing was signed');
  const sum = plan.inputs.reduce((s, c) => s + c.value, 0);
  if (sum !== plan.sum || plan.out + plan.fee !== sum || plan.out < DUST) throw new Error('recycle: the plan does not add up: nothing was signed');
  const hb = (h) => Uint8Array.from(lc(h).match(/../g).map((x) => parseInt(x, 16)));
  const tx = { version: 2, locktime: 0, inputs: plan.inputs.map((c) => ({ txid: c.txid, vout: c.vout, sequence: 0xfffffffd, witness: [] })), outputs: [{ value: plan.out, script: hb(reverseSpk) }] };
  plan.inputs.forEach((c, i) => { tx.inputs[i].witness = sign(tx, i, c.value); });
  return { tx, out: plan.out };
}

const dayOf = (t) => Math.floor(t / DAY);

// The machine. `btc` is the MAIN chain (lib/btc-chain.mjs: coinsIn, fetchTx, status, outspend, broadcast); `fwd`, `rev` the swap stores; `mainSpk`/`reverseSpk`
// hex scripts; `sign(tx, i, value)`, `serialize(tx)` -> hex and `txidOf(tx)`; `load()`/`save(state)` the kept state; `onMoved(entry)` told of each confirmed move.
export function makeRecycler({ cfg, btc, fwd, rev = null, mainSpk, reverseSpk, sign, serialize, txidOf, load, save, bases, fetchImpl, now = () => Math.floor(Date.now() / 1000), log = () => {}, alert = () => {}, onMoved = () => {}, feeRate = null }) {
  let first = true, failSaid = 0;
  const rateNow = (cap) => (feeRate ? feeRate(cap) : agreedFeeRate({ bases, fetchImpl, target: cfg.feeTarget, minAnswers: cfg.minAnswers, cap }));

  async function settlePending(st) {
    const p = st.pending;
    const s = await btc.status(p.txid).catch(() => null);
    if (s && s.confirmations > 0) {
      st.moved = (st.moved || 0) + p.out; st.fees = (st.fees || 0) + p.fee; st.moves = (st.moves || 0) + 1;
      for (const c of p.inputs) st.drained[c.txid] = 1;
      st.history = [...(st.history || []), { txid: p.txid, sats: p.out, fee: p.fee, inputs: p.inputs.length, at: now() }].slice(-50);
      st.pending = null;
      alert({ level: 'info', msg: 'recycle: take coins moved to the reverse address are confirmed', txid: p.txid, sats: p.out, fee: p.fee });
      try { await onMoved({ txid: p.txid, sats: p.out, fee: p.fee }); } catch { /* the accounting is told again from its own reads */ }
      return 'confirmed';
    }
    // an input spent by another transaction that confirmed: this move cannot land (the coin went elsewhere: said, since only this key can sign for it)
    const by = await btc.outspend(p.inputs[0].txid, p.inputs[0].vout).catch(() => undefined);
    if (by && by !== p.txid && !(p.replaced || []).includes(by)) {
      const bs = await btc.status(by).catch(() => null);
      if (bs && bs.confirmations > 0) { alert({ level: 'alert', msg: 'recycle: a coin of a move was spent by another transaction', txid: p.txid, spentBy: by }); st.pending = null; return 'dropped'; }
    }
    if (by && (p.replaced || []).includes(by)) { const bs = await btc.status(by).catch(() => null); if (bs && bs.confirmations > 0) { p.txid = by; return settlePending(st); } }
    if (!p.sent) {
      try { await btc.broadcast({ revealHex: p.hex }); p.sent = true; log({ level: 'info', msg: 'recycle: the move is sent', txid: p.txid }); } catch (e) { log({ level: 'warn', msg: 'recycle: the move could not be sent yet', txid: p.txid, error: String((e && e.message) || e).slice(0, 160) }); }
      return 'resent';
    }
    if (now() - p.at >= cfg.bumpSecs && (p.bumps || 0) < cfg.maxBumps) {
      let rate;
      try { rate = await rateNow(cfg.maxFeeRate); } catch (e) { return 'waiting'; }
      rate = Math.min(cfg.maxFeeRate, Math.max(rate, Math.ceil(p.rate * 1.5)));
      if (rate <= p.rate) return 'waiting';
      const fee = Math.ceil(vsizeOf(p.inputs.length) * rate), sum = p.inputs.reduce((s, c) => s + c.value, 0);
      if (fee * 10000 > sum * cfg.maxFeeShareBps * 2) return 'waiting';
      const plan = { inputs: p.inputs, sum, fee, out: sum - fee, rate };
      const { tx } = buildRecycleTx({ plan, mainSpk, reverseSpk, sign });
      const hex = serialize(tx), txid = txidOf(tx);
      st.pending = { ...p, txid, hex, fee, out: plan.out, rate, at: now(), bumps: (p.bumps || 0) + 1, sent: false, replaced: [...(p.replaced || []), p.txid] };
      await save(st);
      try { await btc.broadcast({ revealHex: hex }); st.pending.sent = true; } catch (e) { log({ level: 'warn', msg: 'recycle: the replacement could not be sent yet', txid, error: String((e && e.message) || e).slice(0, 160) }); }
      log({ level: 'info', msg: 'recycle: the move waited long and is replaced at a higher rate', txid, was: p.txid, rate });
      return 'bumped';
    }
    return 'waiting';
  }

  async function step() {
    if (!cfg.enabled) return { did: 'off' };
    const st = { drained: {}, ...((await load()) || {}) };
    if (st.day !== dayOf(now())) { st.day = dayOf(now()); st.dayMoved = 0; }
    try {
      if (st.pending) { const r = await settlePending(st); await save(st); if (st.pending) return { did: r, txid: st.pending.txid }; }
      const fwdRecs = await fwd.list(), revRecs = rev ? await rev.list() : [];
      const busy = busyOutpoints(fwdRecs, revRecs);
      // read the takes not known to be spent, newest swaps first, a few each look
      const ids = takeTxids(fwdRecs.slice().sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0))).filter((t) => !st.drained[t]).slice(0, cfg.readsPerTick);
      const coins = [];
      for (const txid of ids) {
        const tx = await btc.fetchTx(txid).catch(() => null);
        if (!tx || !tx.status || !tx.status.confirmed) continue;
        const own = (tx.vout || []).map((o, vout) => ({ o, vout })).filter(({ o }) => String(o.scriptpubkey).toLowerCase() === String(mainSpk).toLowerCase());
        const found = await btc.coinsIn(txid).catch(() => null);
        if (found == null) continue;
        if (!found.length) { st.drained[txid] = 1; continue; }
        for (const c of found) {
          const o = own.find((x) => x.vout === c.vout);
          if (!o || o.o.scriptpubkey_type && o.o.scriptpubkey_type !== 'v0_p2wpkh') continue;
          coins.push({ txid, vout: c.vout, value: c.value, spk: String(o.o.scriptpubkey).toLowerCase() });
        }
      }
      const ok = eligibleCoins(coins, { cfg, busy });
      if (!ok.length) { await save(st); return { did: 'nothing', coins: coins.length }; }
      let rate;
      try { rate = await rateNow(cfg.maxFeeRate); } catch (e) { await save(st); if (e.wait) { log({ level: 'info', msg: 'recycle: waits', why: e.message }); return { did: 'wait', why: e.message }; } throw e; }
      const plan = planBatch({ coins: ok, rate, cfg, movedToday: st.dayMoved || 0 });
      if (plan.skip) { await save(st); log({ level: 'info', msg: 'recycle: nothing moved', why: plan.skip, coins: ok.length }); return { did: 'skip', why: plan.skip }; }
      if (first) {
        first = false; await save(st);
        log({ level: 'info', msg: 'recycle (dry run, first look after start): would move take coins to the reverse address', coins: plan.inputs.length, sats: plan.sum, fee: plan.fee, rate, arrive: plan.out });
        return { did: 'dry', plan };
      }
      const { tx } = buildRecycleTx({ plan, mainSpk, reverseSpk, sign });
      const hex = serialize(tx), txid = txidOf(tx);
      // kept before it is sent: a restart finds it and sends it again, never a second move of the same coins
      st.pending = { txid, hex, inputs: plan.inputs.map(({ txid: t, vout, value, spk }) => ({ txid: t, vout, value, spk })), sum: plan.sum, fee: plan.fee, out: plan.out, rate, at: now(), bumps: 0, sent: false };
      st.dayMoved = (st.dayMoved || 0) + plan.sum;
      await save(st);
      try { await btc.broadcast({ revealHex: hex }); st.pending.sent = true; await save(st); } catch (e) { log({ level: 'warn', msg: 'recycle: the move could not be sent yet: sent again next look', txid, error: String((e && e.message) || e).slice(0, 160) }); }
      alert({ level: 'info', msg: 'recycle: take coins sent to the reverse address', txid, coins: plan.inputs.length, sats: plan.sum, fee: plan.fee, rate });
      failSaid = 0;
      return { did: 'sent', txid, plan };
    } catch (e) {
      const m = String((e && e.message) || e).slice(0, 200);
      if (now() - failSaid >= 3600) { failSaid = now(); alert({ level: 'warn', msg: 'recycle: a look failed', error: m }); } else log({ level: 'warn', msg: 'recycle: a look failed', error: m });
      try { await save(st); } catch { /* the next look reads again */ }
      return { did: 'error', error: m };
    }
  }
  return { step };
}
