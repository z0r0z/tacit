// How crowded the Tacit chain's private side is, served at GET /tacit-chain/anonymity: the chain is a shielded pool for TAC, and its leader's
// public GET /state already says how many notes it holds, how many are spent and how much TAC they hold. This keeps one reading an hour
// for a week so the answer can also say how much the pool grew in the last day and week, and caches the leader's answer so a busy page
// costs the leader one read a minute.
//
// What it is not: a spend names no note, so no one outside can say which notes are spent. `notes` is every note the chain has made (the
// set a spend hides among), `spent` how many have been spent, `unspent` the difference (notes still holding value). Nothing here narrows that.

export const HOUR_MS = 3600000;
const KEEP_MS = 8 * 24 * HOUR_MS;

const nat = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : null);

// A /state answer reduced to what is served, or null when it is not a usable chain state.
export function reading(s) {
  const notes = nat(s?.leaves), spent = nat(s?.nullifiers), spends = nat(s?.spends), height = nat(s?.height);
  if (notes == null || spent == null || spent > notes || height == null) return null;
  const tac = (x) => (/^\d+$/.test(String(x ?? '')) ? String(x) : null);
  return { notes, spent, spends: spends ?? 0, height, pool: tac(s.pool), shares: tac(s.shares), pending: nat(s.pending) ?? 0 };
}

export function makeChainAnonymity({ read, storage, key = 'chainanon:v1', now = Date.now, ttlMs = 60000 }) {
  // read(): the leader's /state JSON (rejects when it is down). storage: { get(key), put(key, string) }.
  let cached = null, running = null;

  async function load() {
    try { const s = JSON.parse(await storage.get(key)); if (s && Array.isArray(s.hist)) return s; } catch { }
    return { hist: [], last: null };
  }

  const growth = (hist, cur, at, ms) => {
    // the oldest reading no older than the window, so a short history reports its true span instead of a full window's worth
    const from = hist.find((h) => at - h.at <= ms);
    if (!from || from.at >= at) return null;
    return { secs: Math.round((at - from.at) / 1000), notes: cur.notes - from.notes, spent: cur.spent - from.spent, spends: cur.spends - from.spends };
  };

  function view(cur, hist, at, stale) {
    return {
      asOf: at, height: cur.height, stale: !!stale,
      notes: cur.notes, spent: cur.spent, unspent: cur.notes - cur.spent, spends: cur.spends, pending: cur.pending,
      pool: cur.pool, shares: cur.shares, poolDecimals: 8,
      d1: growth(hist, cur, at, 24 * HOUR_MS), d7: growth(hist, cur, at, 7 * 24 * HOUR_MS),
    };
  }

  async function refresh() {
    const st = await load(), at = now();
    let cur = null;
    try { cur = reading(await read()); } catch { }
    if (!cur) {
      if (!st.last) throw new Error('chain leader not answering');
      return view(st.last.cur, st.hist, st.last.at, true);   // down: the last good counts, marked stale
    }
    const prev = st.hist[st.hist.length - 1];
    // the chain only grows: a reading below the last one is a restarted or rebuilding leader, so start the history again
    if (prev && (cur.notes < prev.notes || cur.spent < prev.spent || cur.spends < prev.spends)) st.hist = [];
    const tail = st.hist[st.hist.length - 1];
    if (!tail || at - tail.at >= HOUR_MS) st.hist.push({ at, notes: cur.notes, spent: cur.spent, spends: cur.spends });
    st.hist = st.hist.filter((h) => at - h.at <= KEEP_MS);
    st.last = { at, cur };
    try { await storage.put(key, JSON.stringify(st)); } catch { }
    return view(cur, st.hist, at, false);
  }

  // One read at a time; an answer is reused for ttlMs.
  async function summary() {
    if (cached && now() - cached.at < ttlMs) return cached.v;
    running ||= refresh().then((v) => { cached = { at: now(), v }; return v; }).finally(() => { running = null; });
    return running;
  }

  return { summary };
}
