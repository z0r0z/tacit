// How often each confidential pool's state changes, kept from the farm program's own reads (worker/src/farm-program.js, the 5-minute tick) and filled in from old blocks.
//
// A deposit into a pool is proved against the pool's exact reserves and shares, so any trade, add or remove that lands while it is proved ends that proof. How likely that is
// follows from how often the pool changes, which a page cannot see without reading old blocks from nodes that charge dearly for it. So the server keeps a log: at each tick
// the program says each pool's reserves and shares at one block, and a state that differs from the last one read is a change, kept with the time and the block.
//
// The log is one JSON document ({ v: 1, pools: { <poolId>: { first, fb, last: { t, b, s }, ev: [[t, b, kind], ...], bf: { at, ok } } } }): `first` is when this pool's unbroken record starts
// (and `fb` the block it starts at), `last` the state as last read (`s` is "reserveA:reserveB:shares"), `ev` the changes, oldest first, `bf` the last time the record was filled in from old
// blocks (pool-history.js) and whether that worked. A change is told to the tick, not to the block: two trades between ticks are one change, so the count is a floor.
//
// A record that starts empty (the service has just started, or the pool is new to the log), or has a gap in it (the service was off, or its reads failed, for longer than GAP_MS), would
// say nothing of the time before its first reading. The chain has that time: historyPlan() says, for each pool, what to read from old blocks (a whole new record's window, the gap's blocks,
// or the window before a live record that is shorter than it), and applyHistory() puts what was read into the record. A pool whose old blocks could not be read keeps what it had, marked in
// `bf` so the read is tried again later, not at every tick (noteFailed()).
export const KEEP_MS = 48 * 3600e3, MAX_EVENTS = 400, GAP_MS = 20 * 60e3;
export const WINDOW_BLOCKS = 7200, BLOCK_MS = 12_000, SLACK_BLOCKS = 100, MARGIN_BLOCKS = 20, RETRY_MS = 30 * 60e3;      // a day of blocks; a record within SLACK_BLOCKS of that is long enough

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

const isLive = (cur, t) => !!(cur && cur.last && t - cur.last.t <= GAP_MS && t >= cur.last.t);

// The log with one more reading folded in: `sample` as sampleOf() gives it, read at time `t` (ms) from block `block`.
export function foldSample(log, sample, { t, block }) {
  const out = { v: 1, pools: { ...readLog(log).pools } };
  for (const { poolId, state } of sample) {
    if (!state) continue;                                     // not read this time: its record stays as it was
    const cur = out.pools[poolId];
    const keep = (cur ? cur.ev : []).filter(([et]) => t - et <= KEEP_MS);
    if (!isLive(cur, t)) { out.pools[poolId] = { first: t, fb: block, last: { t, b: block, s: state }, ev: [] }; continue; }      // a new record: what came before it is not counted into it
    let ev = keep;
    if (cur.last.s !== state) {
      const [, , before] = cur.last.s.split(':'), [, , after] = state.split(':');
      ev = [...keep, [t, block, before !== after ? 'liquidity' : 'trade']].slice(-MAX_EVENTS);
    }
    out.pools[poolId] = { ...cur, last: { t, b: block, s: state }, ev };
  }
  return out;
}

// The block a record starts at: the one it says, or for a record made before blocks were kept, worked out from its times (the margin is then taken off by the caller, since a change
// between a block a little too early and the real one is lost, where one a little too late would be counted twice).
const firstBlockOf = (rec) => (Number.isFinite(rec.fb) ? { b: rec.fb, exact: true } : { b: Math.round(rec.last.b - (rec.last.t - rec.first) / BLOCK_MS), exact: false });

// What each pool's record needs from old blocks, from the log as it was BEFORE this tick's reading was folded in and the reading itself (`head` the block it was read at):
//   { poolId, mode: 'new',     from, to, toState }              no record (or a gap longer than the window): the window before the reading
//   { poolId, mode: 'gap',     from, fromState, to, toState }   a record broken by a gap within the window: the blocks of the gap, joined to the record
//   { poolId, mode: 'prepend', from, to }                       a live record shorter than the window, not yet filled in (or the last try failed long enough ago): the window before it
// Blocks are for changesBetween() (pool-history.js): the changes in (from, to].
export function historyPlan(log, sample, { t, head }) {
  const pools = readLog(log).pools, floor = head - WINDOW_BLOCKS, out = [];
  if (!(head > 0)) return out;
  for (const { poolId, state } of sample) {
    if (!state) continue;
    const rec = pools[poolId];
    if (!rec || !rec.last) { out.push({ poolId, mode: 'new', from: floor, to: head, toState: state }); continue; }
    if (!isLive(rec, t)) {
      if (rec.last.b >= floor && rec.last.b < head) out.push({ poolId, mode: 'gap', from: rec.last.b, fromState: rec.last.s, to: head, toState: state });
      else out.push({ poolId, mode: 'new', from: floor, to: head, toState: state });
      continue;
    }
    const f = firstBlockOf(rec), tried = rec.bf && (rec.bf.ok || t - rec.bf.at <= RETRY_MS);
    if (!tried && f.b > floor + SLACK_BLOCKS) out.push({ poolId, mode: 'prepend', from: floor, to: f.exact ? f.b : f.b - MARGIN_BLOCKS });
  }
  return out;
}

// The log with what was read for one pool of the plan put into its record. `logBefore` is the log before the reading was folded in (a gap joins the record it broke), `logAfter` the
// log after; `result` is changesBetween()'s answer. Times are worked out from blocks (a block is BLOCK_MS, counted back from `head` at `t`).
export function applyHistory(logBefore, logAfter, plan, result, { t, head }) {
  const out = { v: 1, pools: { ...readLog(logAfter).pools } };
  const post = out.pools[plan.poolId];
  if (!post) return out;
  const timeOf = (b) => t - (head - b) * BLOCK_MS, bf = { at: t, ok: true };
  const evs = result.events.map(({ block, kind }) => [timeOf(block), block, kind]);
  let rec;
  if (plan.mode === 'new') rec = { first: timeOf(result.from), fb: result.from, last: post.last, ev: evs, bf };
  else if (plan.mode === 'gap') {
    const cur = readLog(logBefore).pools[plan.poolId] || { first: post.first, ev: [] };
    rec = { first: cur.first, ...(cur.fb != null ? { fb: cur.fb } : {}), last: post.last, ev: [...cur.ev, ...evs], ...(cur.bf ? { bf: cur.bf } : {}) };      // before its first reading is still to be filled in
  } else rec = { ...post, first: timeOf(result.from), fb: result.from, ev: [...evs, ...post.ev], bf };
  rec.ev = rec.ev.filter(([et]) => t - et <= KEEP_MS).slice(-MAX_EVENTS);
  out.pools[plan.poolId] = rec;
  return out;
}

// The log with a failed read of old blocks noted on the pool's record, so it is tried again after RETRY_MS and not at the next tick.
export function noteFailed(logAfter, plan, { t }) {
  const out = { v: 1, pools: { ...readLog(logAfter).pools } };
  if (out.pools[plan.poolId]) out.pools[plan.poolId] = { ...out.pools[plan.poolId], bf: { at: t, ok: false } };
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
