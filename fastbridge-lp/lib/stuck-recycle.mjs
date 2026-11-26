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

export function makeStuckRecycler({
  tacit, withWallet, mainPriv, mainPub, reversePubHex, assetIdHex, swaps, store, btc,
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
        changed = true;
        if (typeof swaps.get === 'function' && typeof swaps.put === 'function') {
          const rec = await swaps.get(sid).catch(() => null);
          if (rec && !rec.stuckRecoveredAt) await swaps.put({ ...rec, stuckRecoveredAt: now(), stuckRecycleTxid: r.revealTxid });
        }
        log({ level: 'info', msg: 'stuck recycle: the moved note is confirmed at the reverse address', id: sid, txid: r.revealTxid, amount: r.amount });
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
