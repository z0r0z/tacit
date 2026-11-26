// Moves TAC the forward side has already taken in swaps whose inputs were priced as stuck (long or pool-exit) onto the
// reverse side's dedicated address, where the reverse bridge can sell it back into pool TAC. It never scans or spends
// arbitrary stock at the main address: a candidate is exactly the first note output of the take transaction of one
// completed forward swap, and the transfer spends only that note.
//
// The first candidate after a restart is a dry run: it is logged with its outpoint and amount, then sent on a later tick.
// A broadcast error is not retried automatically, because the failure may be after the reveal was accepted; the record
// says what to inspect. Confirmed moves are `done`; the reverse side then counts the note in its ordinary inventory scan.

export const STUCK_CLASSES = new Set(['long', 'pool-exit']);

export function stuckRecycleCandidates(records) {
  const out = [];
  for (const rec of records || []) {
    if (!rec || rec.phase !== 'done' || !STUCK_CLASSES.has(rec.lineageClass)) continue;
    const txid = (rec.take && rec.take.txid) || rec.takenBy || null;
    if (!/^[0-9a-f]{64}$/.test(String(txid || ''))) continue;
    let amount;
    try { amount = BigInt(rec.offer && rec.offer.btc && rec.offer.btc.value); } catch { continue; }
    if (amount > 0n) out.push({ swapId: String(rec.id), txid, vout: 0, amount });
  }
  return out.sort((a, b) => (a.swapId < b.swapId ? -1 : 1));
}

// Runs `fn` with tacit.js's singleton wallet set to the wanted key, serialized by `lock`, and restores whatever was there.
// The reverse inventory scan and the main-key transfer use the same lock so neither reads or signs as the other key.
export function makeTacitWalletSwitch({ tacit, lock = (fn) => fn() }) {
  return async function withWallet(priv, pub, fn) {
    return lock(async () => {
      const oldPriv = tacit.wallet.priv, oldPub = tacit.wallet.pub;
      tacit.wallet.priv = priv; tacit.wallet.pub = pub;
      try { return await fn(); } finally { tacit.wallet.priv = oldPriv; tacit.wallet.pub = oldPub; }
    });
  };
}

// Tracks recycled value through reverse sales. A sale is attributed only when the inputs are all tracked recycled notes.
// One tracked input with a partial sale is followed through the lock's change output (`<lock txid>:1`); mixed partial sales are
// left as exposure rather than guessed, because Tacit outputs do not say which input funded which part of the lock.
export function applyReverseSalesToRecycling(state, revs) {
  state.labels ||= {}; state.recovered ||= {}; state.processedReverse ||= {};
  const sorted = (revs || []).filter((x) => x && x.id).sort((a, b) => Number(a.updated || a.created || 0) - Number(b.updated || b.created || 0) || String(a.id).localeCompare(String(b.id)));
  const out = [];
  for (const x of sorted) {
    if (state.processedReverse[x.id] || x.phase !== 'done') continue;
    state.processedReverse[x.id] = true;
    const inputs = Array.isArray(x.noteInputs) ? x.noteInputs : [];
    const tracked = inputs.map((i) => ({ key: `${i.txid}:${Number(i.vout)}`, label: state.labels[`${i.txid}:${Number(i.vout)}`] })).filter((x) => x.label);
    if (!tracked.length || tracked.length !== inputs.length) continue;
    const sale = BigInt(x.amount || 0), total = tracked.reduce((s, x) => s + BigInt(x.label.amount), 0n);
    if (!(sale > 0n && sale <= total)) continue;
    if (tracked.length === 1) {
      const one = tracked[0], amount = BigInt(one.label.amount), sold = sale < amount ? sale : amount;
      state.recovered[one.label.swapId] = String((state.recovered[one.label.swapId] ? BigInt(state.recovered[one.label.swapId]) : 0n) + sold);
      delete state.labels[one.key];
      if (amount > sale && x.lock && /^[0-9a-f]{64}$/.test(String(x.lock.txid || ''))) {
        state.labels[`${x.lock.txid}:1`] = { swapId: one.label.swapId, amount: String(amount - sale) };
      }
      out.push({ reverseSwapId: x.id, swapId: one.label.swapId, sold: String(sold), partial: amount > sale });
      continue;
    }
    if (sale === total) {
      for (const one of tracked) {
        const amount = BigInt(one.label.amount);
        state.recovered[one.label.swapId] = String((state.recovered[one.label.swapId] ? BigInt(state.recovered[one.label.swapId]) : 0n) + amount);
        delete state.labels[one.key];
        out.push({ reverseSwapId: x.id, swapId: one.label.swapId, sold: String(amount), partial: false });
      }
    }
  }
  return out;
}

export function makeStuckRecycler({
  tacit, withWallet, mainPriv, mainPub, reversePubHex, assetIdHex, swaps, reverseSwaps = null, store, btc,
  now = () => Math.floor(Date.now() / 1000), log = () => {}, alert = () => {}, maxPerTick = 1,
}) {
  const idOf = (c) => c.swapId;
  async function load() {
    const r = await store.get('state');
    return { bySwap: {}, ...(r && typeof r === 'object' ? r : {}) };
  }
  const save = (state) => store.put({ ...state, id: 'state' });

  async function findNote(c) {
    return withWallet(mainPriv, mainPub, async () => {
      try { if (typeof tacit.invalidateHoldingsCache === 'function') tacit.invalidateHoldingsCache(); } catch { /* the scan below is forced where supported */ }
      const holdings = await tacit.scanHoldings(true);
      const entry = holdings instanceof Map ? holdings.get(assetIdHex) : null;
      const notes = (entry && entry.utxos) || [];
      const note = notes.find((x) => x.utxo && x.utxo.txid === c.txid && x.utxo.vout === c.vout);
      if (!note) return { note: null };
      if (note.stealthTweakedSk) return { note: null, why: 'the take output is stealth-tweaked, not a plain note at the main address' };
      if (!note.utxo.status || !note.utxo.status.confirmed) return { note: null, why: 'the take output is not confirmed yet' };
      if (BigInt(note.amount) !== c.amount) return { note: null, why: `the take output holds ${note.amount}, not ${c.amount}` };
      return { note };
    });
  }

  async function send(c, note) {
    return withWallet(mainPriv, mainPub, async () => tacit.buildAndBroadcastCXferMulti({
      assetIdHex,
      recipients: [{ pubHex: reversePubHex, amount: BigInt(note.amount) }],
      forceUtxos: [note],
    }));
  }

  async function tick() {
    const state = await load();
    let changed = false, started = 0;
    // finish watches first: once the move is confirmed, the reverse side's own inventory scan can sell the note
    for (const [sid, r] of Object.entries(state.bySwap)) {
      if (r.status !== 'sent') continue;
      const st = await btc.status(r.revealTxid).catch(() => null);
      if (st && st.confirmations > 0) {
        state.bySwap[sid] = { ...r, status: 'done', confirmedAt: now() };
        state.labels ||= {}; state.labels[`${r.revealTxid}:0`] = { swapId: sid, amount: String(r.amount) };
        changed = true;
        if (typeof swaps.get === 'function' && typeof swaps.put === 'function') {
          const rec = await swaps.get(sid).catch(() => null);
          if (rec && rec.stuckInventoryAt == null && rec.stuckRecoveredAt == null) await swaps.put({ ...rec, stuckInventoryAt: now(), stuckRecycleTxid: r.revealTxid });
        }
        log({ level: 'info', msg: 'stuck recycle: the moved note is confirmed at the reverse address', id: sid, txid: r.revealTxid, amount: r.amount });
      }
    }
    // A note in reverse inventory is saleable but not yet recovered. Completed reverse sales are attributed only when
    // every input is a tracked recycled note; partial mixed sales are conservatively left as exposure.
    if (reverseSwaps && typeof reverseSwaps.list === 'function' && typeof swaps.get === 'function' && typeof swaps.put === 'function') {
      const revs = await reverseSwaps.list().catch(() => []);
      const sales = applyReverseSalesToRecycling(state, revs);
      if (sales.length) changed = true;
      for (const sale of sales) {
        const sid = sale.swapId, rec = await swaps.get(sid).catch(() => null), sr = state.bySwap[sid];
        if (!rec || rec.stuckRecoveredAt != null || !sr) continue;
        const recovered = BigInt(state.recovered[sid] || 0), original = BigInt(sr.amount || rec.offer && rec.offer.btc && rec.offer.btc.value || 0);
        if (recovered >= original && original > 0n) {
          await swaps.put({ ...rec, stuckRecoveredAt: now(), stuckRecycleTxid: sr.revealTxid, stuckReverseSwapId: sale.reverseSwapId });
          log({ level: 'info', msg: 'stuck recycle: the recycled note was sold through the reverse side', id: sid, reverseSwapId: sale.reverseSwapId, amount: String(original) });
        }
      }
    }
    const candidates = stuckRecycleCandidates(await swaps.list());
    for (const c of candidates) {
      if (started >= maxPerTick) break;
      const sid = idOf(c), old = state.bySwap[sid];
      if (old && ['sent', 'done', 'error'].includes(old.status)) continue;
      const got = await findNote(c).catch((e) => ({ error: e }));
      if (got.error) {
        state.bySwap[sid] = { status: 'error', error: String((got.error && got.error.message) || got.error).slice(0, 200), at: now(), amount: String(c.amount), txid: c.txid, vout: c.vout };
        changed = true;
        alert({ level: 'alert', msg: 'stuck recycle: the notes at the main address could not be read', id: sid, error: state.bySwap[sid].error });
        continue;
      }
      if (!got.note) continue;      // not confirmed yet, already moved by hand, or not scanned yet: look again later
      if (!old || old.status !== 'dry') {
        state.bySwap[sid] = { status: 'dry', at: now(), amount: String(c.amount), txid: c.txid, vout: c.vout };
        changed = true;
        log({ level: 'info', msg: 'stuck recycle: dry run, a later tick moves this take output to the reverse address', id: sid, outpoint: `${c.txid}:${c.vout}`, amount: String(c.amount) });
        continue;
      }
      try {
        const r = await send(c, got.note);
        state.bySwap[sid] = { status: 'sent', at: now(), amount: String(c.amount), txid: c.txid, vout: c.vout, commitTxid: r.commitTxid, revealTxid: r.revealTxid };
        started++; changed = true;
        log({ level: 'info', msg: 'stuck recycle: moving the take output to the reverse address', id: sid, txid: r.revealTxid, amount: String(c.amount) });
      } catch (e) {
        state.bySwap[sid] = { status: 'error', at: now(), amount: String(c.amount), txid: c.txid, vout: c.vout, error: String((e && e.message) || e).slice(0, 200) };
        changed = true;
        alert({ level: 'alert', msg: 'stuck recycle: a move failed and is not retried automatically: check whether the reveal reached the chain', id: sid, error: state.bySwap[sid].error });
      }
    }
    if (changed) await save(state);
    return { state, started };
  }

  async function info() {
    const state = await load(), counts = {};
    for (const r of Object.values(state.bySwap)) counts[r.status] = (counts[r.status] || 0) + 1;
    return { enabled: true, ...counts };
  }

  return { tick, info };
}
