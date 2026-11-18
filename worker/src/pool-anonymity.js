// How many deposits each asset has had in the ConfidentialPool, served at GET /pool/anonymity: a suggestion of how crowded an asset's
// private side is, never a true anonymity set.
//
// What the chain shows per asset is the deposit (the pool's Wrap event names the asset and the amount) and the withdrawal; everything
// between is hidden, and every asset's notes share one tree, so per-asset notes and spent notes cannot be counted. This counts the
// public part: deposits per asset in the last 30 days, the last 7, and all time. It reads the rows the public event index
// (confidential-index.js) already stores, from its own stored cursor, so it scans no logs and costs one page read per new page of rows.
//
// Days are block-based (7,200 blocks, about a day): the index keeps block numbers, not timestamps.

export const DAY_BLOCKS = 7200;
export const WINDOW_DAYS = 30;
const KEEP_DAYS = 45;
const CHUNK = 1000;

export function makePoolAnonymity({ index, storage, pool, names = {}, now = () => Date.now(), ttlMs = 60000 }) {
  // index: { fresh(), read({ from, limit }) } (confidential-index.js). storage: { get(key), put(key, string) }.
  // names: assetId (lower-case 0x…) -> ticker, for the assets the page cannot name from their token address (cETH).
  const key = `cpanon:v1:${String(pool).toLowerCase()}`;
  let cached = null, running = null;

  const blank = () => ({ seq: 0, block: 0, assets: {} });
  async function load() {
    try { const s = JSON.parse(await storage.get(key)); if (s && Number.isInteger(s.seq) && s.assets) return s; } catch { }
    return blank();
  }
  const save = (st) => storage.put(key, JSON.stringify(st));

  function add(st, row) {
    const id = String(row.assetId).toLowerCase(), day = Math.floor(row.block / DAY_BLOCKS);
    const a = (st.assets[id] ||= { n: 0, days: {} });
    a.n += 1;
    a.days[day] = (a.days[day] || 0) + 1;
  }

  async function catchUp() {
    let st = await load();
    for (;;) {
      const out = await index.read({ from: st.seq, limit: CHUNK });
      if (out.total < st.seq) { st = blank(); continue; }      // the index was rebuilt behind us: count again from its start
      for (const r of out.entries) if (r.type === 'wrap' && r.assetId) add(st, r);
      st.seq = out.next;
      st.block = out.indexedToBlock;
      st.head = out.headBlock;
      st.synced = !!out.synced;
      if (!out.entries.length || out.next >= out.total) break;
    }
    const day = Math.floor(st.block / DAY_BLOCKS);
    for (const a of Object.values(st.assets)) for (const d of Object.keys(a.days)) if (Number(d) < day - KEEP_DAYS) delete a.days[d];
    await save(st);
    return st;
  }

  function view(st) {
    const day = Math.floor(st.block / DAY_BLOCKS), assets = {};
    for (const [id, a] of Object.entries(st.assets)) {
      let d30 = 0, d7 = 0;
      for (const [d, c] of Object.entries(a.days)) {
        const age = day - Number(d);
        if (age < WINDOW_DAYS) d30 += c;
        if (age < 7) d7 += c;
      }
      assets[id] = { total: a.n, d30, d7, ...(names[id] ? { ticker: names[id] } : {}) };
    }
    return { asOf: st.block, synced: !!st.synced, windowDays: WINDOW_DAYS, dayBlocks: DAY_BLOCKS, assets };
  }

  // One catch-up at a time; an answer is reused for ttlMs. A failed refresh serves the last stored counts.
  async function summary() {
    if (cached && now() - cached.at < ttlMs) return cached.v;
    running ||= (async () => {
      try { await index.fresh(); } catch { }
      const v = view(await catchUp());
      cached = { at: now(), v };
      return v;
    })().finally(() => { running = null; });
    return running;
  }

  return { summary };
}

// The words the page puts beside a count: few deposits make a guess easy, many make it hard. Fixed thresholds on the 30-day count.
export function crowd(d30) {
  return d30 < 10 ? 'low' : d30 < 100 ? 'fair' : 'strong';
}
