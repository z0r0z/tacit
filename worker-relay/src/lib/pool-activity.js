// How often each confidential pool's state changes, kept from the farm program's own reads (worker/src/farm-program.js, the 5-minute tick).
//
// A deposit into a pool is proved against the pool's exact reserves and shares, so any trade, add or remove that lands while it is proved ends that proof. How likely that is
// follows from how often the pool changes, which a page cannot see without reading old blocks from nodes that charge dearly for it. So the server keeps a short log: at each tick
// the program says each pool's reserves and shares at one block, and a state that differs from the last one read is a change, kept with the time and the block.
//
// The log is one JSON document ({ v: 1, pools: { <poolId>: { first, last: { t, b, s }, ev: [[t, b, kind], ...] } } }): `first` is when this pool's unbroken record starts, `last` the state
// as last read (`s` is "reserveA:reserveB:shares"), `ev` the changes, oldest first. A change is told to the tick, not to the block: two trades between ticks are one change, so the count is
// a floor. A gap in the record (the server was off, or the reads failed, for longer than GAP_MS) ends it and starts another: what changed in the gap cannot be told from when, so it is
// not counted, and the record claims only the time it has seen.
export const KEEP_MS = 48 * 3600e3, MAX_EVENTS = 400, GAP_MS = 20 * 60e3;

const stateOf = (p) => {
  const r = p && p.reserves;
  return r && r.reserveA != null && r.reserveB != null && r.lpTotalShares != null ? `${r.reserveA}:${r.reserveB}:${r.lpTotalShares}` : null;
};

// The pools of a program document (publicProgram(), the launch pools and the standalone ones alike) as { poolId, state } rows; a pool whose reserves were not read has none.
export function sampleOf(program) {
  return (program && Array.isArray(program.pools) ? program.pools : []).filter((p) => /^0x[0-9a-f]{64}$/i.test(String(p && p.poolId))).map((p) => ({ poolId: String(p.poolId).toLowerCase(), state: stateOf(p) }));
}

export function readLog(raw) {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return v && v.v === 1 && v.pools && typeof v.pools === 'object' ? v : { v: 1, pools: {} };
  } catch { return { v: 1, pools: {} }; }
}

// The log with one more reading folded in: `sample` as sampleOf() gives it, read at time `t` (ms) from block `block`.
export function foldSample(log, sample, { t, block }) {
  const out = { v: 1, pools: { ...readLog(log).pools } };
  for (const { poolId, state } of sample) {
    if (!state) continue;                                     // not read this time: its record stays as it was
    const cur = out.pools[poolId];
    const live = cur && cur.last && t - cur.last.t <= GAP_MS && t >= cur.last.t;
    const keep = (cur ? cur.ev : []).filter(([et]) => t - et <= KEEP_MS);
    if (!live) { out.pools[poolId] = { first: t, last: { t, b: block, s: state }, ev: [] }; continue; }      // a new record: what came before it is not counted into it
    let ev = keep;
    if (cur.last.s !== state) {
      const [, , before] = cur.last.s.split(':'), [, , after] = state.split(':');
      ev = [...keep, [t, block, before !== after ? 'liquidity' : 'trade']].slice(-MAX_EVENTS);
    }
    out.pools[poolId] = { first: cur.first, last: { t, b: block, s: state }, ev };
  }
  return out;
}

// What a page needs of one pool: when it was last read, since when the record is unbroken, how many changes the last hour and the last day held (each counted back from the last
// reading), and when the latest was. null where the pool has no record.
export function summarize(log, poolId) {
  const p = readLog(log).pools[String(poolId).toLowerCase()];
  if (!p || !p.last) return null;
  const at = p.last.t, within = (ms) => p.ev.filter(([et]) => at - et <= ms).length;
  return { at, since: p.first, hour: within(3600e3), day: within(86400e3), lastMoveAt: p.ev.length ? p.ev[p.ev.length - 1][0] : null };
}

export const summaries = (log) => Object.fromEntries(Object.keys(readLog(log).pools).map((id) => [id, summarize(log, id)]).filter(([, s]) => s));
