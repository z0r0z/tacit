// The Activity journal: what this browser has set going (relay jobs, Ethereum and Bitcoin transactions, pool ops), kept in localStorage
// so another tab, or another page of the site, reads the same list. The front page writes it and follows each entry to its end; this
// module is what any page needs to read it: the key, when an entry has ended, the names of the relay's jobs, and how many are still going.
// No DOM, no network.

export const ACT_KEY = 'tacit-lite-activity-v1', ACT_MAX = 20;

export const JOB_LABEL = {
  wrap: 'Shield', wraptransfer: 'Shield and send', wrapswap: 'Shield and swap', wraplp: 'Shield and add liquidity', wrapcdpmint: 'Shield and borrow',
  transfer: 'Private transfer', batchtransfer: 'Private transfers', unwrap: 'Withdraw', sendunwrap: 'Withdraw', swap: 'Private swap', route: 'Private swap',
  lp: 'Add liquidity', lpremove: 'Take out liquidity', lpbond: 'Bond liquidity', farmbond: 'Join a private farm', farmharvest: 'Harvest farm rewards',
  farmunbond: 'Unbond from a farm', otc: 'Private trade', bid: 'Private bid', cbtcmint: 'Mint cBTC', cdpmint: 'Borrow cUSD', cdpclose: 'Repay a loan',
  cdptopup: 'Top up a loan', cdpliquidate: 'Liquidate a loan', stealthlock: 'Send privately', stealthlockbatch: 'Send privately',
  stealthclaim: 'Claim a private payment', stealthrefund: 'Take back a private send', bridgemint: 'Bridge in', bridgestealthmint: 'Bridge in',
  bridgeburn: 'Bridge out', fastlane: 'Cross-chain move', adaptorlock: 'Atomic swap', adaptorclaim: 'Atomic swap claim', adaptorrefund: 'Atomic swap refund',
};

// the statuses each kind of entry ends in
export const ENDS = { job: ['settled', 'proven', 'failed', 'unknown'], tx: ['confirmed', 'failed', 'stale'], btc: ['confirmed', 'stale'], op: ['settled', 'failed', 'unknown'] };
export const ended = (it) => ENDS[it.kind]?.includes(it.status) ?? true;

export function readActivity() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(ACT_KEY)); } catch {}
  // an entry the page cannot show is dropped, and an op without its steps gets none, so one odd entry never stops the list opening
  return { items: [].concat(Array.isArray(v?.items) ? v.items : []).filter((x) => x && typeof x === 'object' && x.id && ENDS[x.kind]).map((x) => (x.kind === 'op' && !Array.isArray(x.steps) ? { ...x, steps: [] } : x)), cleared: Number(v?.cleared) || 0 };
}
// the entries shown (a step nested in another is shown inside it)
export const listed = (items) => items.filter((x) => !x.in);

// A settled op that burned for a bridge to Bitcoin is not done until the Bitcoin step has landed: its row in the bridge journal says where it is.
const BR = new Map();
export function actBridge(it) {
  if (it.kind !== 'op' || it.status !== 'settled' || !it.hash || !it.pub) return null;
  try {
    const key = `tacit-crossout-bridge-v1:mainnet:${it.pub}`, raw = localStorage.getItem(key) || '';
    let list = BR.get(key);
    if (!list || list.raw !== raw) { let v = null; try { v = JSON.parse(raw || '[]'); } catch {} list = { raw, v: Array.isArray(v) ? v : [] }; BR.set(key, list); }
    const h = String(it.hash).replace(/^0x/, '').toLowerCase();
    return list.v.find((r) => String(r?.settle?.txHash || '').replace(/^0x/, '').toLowerCase() === h) || null;
  } catch { return null; }
}
export const actOpen = (it) => { const b = actBridge(it); return !!b && b.stage !== 'minted'; };
export const actDone = (it) => ended(it) && !actOpen(it);

// what the Activity chip shows: how many entries there are, and how many are still going
export function activityCount(items = readActivity().items) {
  const top = listed(items);
  return { total: top.length, live: top.filter((x) => !actDone(x)).length };
}

// another tab's write (the journal, or a bridge's): `fn` is called, and the returned function stops it
export function onActivity(fn) {
  const h = (e) => { if (!e.key || e.key === ACT_KEY || e.key.startsWith('tacit-crossout-bridge-v1:')) fn(); };
  addEventListener('storage', h);
  return () => removeEventListener('storage', h);
}

// ── writing it: a page that sets things going keeps the journal, and follows each entry to its end ──

// A status only moves forward: a late answer from a slower source does not take an entry back (a settled job is not made pending again).
const RANK = { pending: 0, proving: 1, stale: 1, open: 1.5, sending: 1.5, proven: 2, failed: 2, unknown: 2, settled: 3, confirmed: 3 };
export const OPENISH = ['open', 'sending'];
export const ahead = (next, cur) => next !== cur && (cur == null || cur === 'unknown' || next === 'settled' || next === 'confirmed' || (OPENISH.includes(next) && OPENISH.includes(cur)) || (RANK[next] ?? -1) > (RANK[cur] ?? -1));

// The journal as the page that writes it holds it. `state` is { items, cleared }, read and replaced in place by the page as it likes; `put`
// adds an entry or moves one on, keeps the newest ACT_MAX, and saves (batched; at once when the page is left). What the page does on top:
//   pub()               the open key's public key, recorded on a new entry
//   onTrim()            before old entries are let go
//   onStatus(it, prev)  an entry's status changed (after `end` and the rest are set)
//   onChange(it)        after every put
// `shared`: a page other than the front one, which keeps no list of its own: each read and each put starts from what is stored, and a put is
// written at once, so it never writes back a list another tab has moved on since (the front page merges what such a page writes).
export function makeJournal({ pub = () => null, onTrim = () => {}, onStatus = () => {}, onChange = () => {}, shared = false } = {}) {
  const state = readActivity();
  const fresh = () => { if (shared) Object.assign(state, readActivity()); };
  const get = (id) => { fresh(); return state.items.find((x) => x.id === id); };
  let saving = 0;
  const write = () => { clearTimeout(saving); saving = 0; try { localStorage.setItem(ACT_KEY, JSON.stringify({ items: state.items, cleared: state.cleared })); } catch {} };
  const save = () => { if (shared) return write(); clearTimeout(saving); saving = setTimeout(write, 150); };
  addEventListener('pagehide', () => { if (saving) write(); });
  function trim() {
    onTrim();
    for (let top = listed(state.items); top.length > ACT_MAX; top = listed(state.items)) {
      const gone = top.findLast(actDone) || top.at(-1);
      state.items = state.items.filter((x) => x !== gone && x.in !== gone.id);
    }
  }
  function put(id, patch) {
    let it = get(id);
    const prev = it ? it.status : null;
    if (!it) {
      it = { at: Date.now(), ...patch, pub: patch.pub ?? pub() ?? null, id };
      state.items.unshift(it);
      state.items.sort((a, b) => b.at - a.at);
      trim();
    } else {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined && k !== 'status' && k !== 'label' && k !== 'at') it[k] = v;
      if (patch.status && ahead(patch.status, it.status)) it.status = patch.status;
    }
    if (it.status !== prev) {
      it.up = Date.now();
      (it.ts ||= {})[it.status] ??= it.up;                // when each state was first seen: what a bar of how far along it is reads
      if (ended(it) && ['failed', 'stale', 'unknown'].includes(prev) && !it.sent) it.flip = true;
      it.end = ended(it) ? it.end || Date.now() : null;
      if (it.status === 'proving') it.prov = true;
      onStatus(it, prev);
    }
    save(); onChange(it);
    return it;
  }
  return { state, get, put, trim, save, write };
}

// Following entries to their end: a relay job by its status, an Ethereum transaction by its receipt, a Bitcoin one until it confirms.
// One follower per entry at a time. What the page supplies:
//   jobStatus(jobId)        the relay's answer ({ status, txHash, error })
//   receipt(hash, chain)    waits for a receipt (null if it never comes); receiptOnce(hash, chain) asks once
//   btcConfirmed(txid)      true once Bitcoin has it in a block
//   live(id)                a job this page is still running itself (its own steps report it, so the relay is not asked)
//   own(id), onOwn(id)      a job proved on this device, which the relay knows nothing of: handed back to the page
//   onSlow(it)              a job still pending after a minute
//   finished(id, hash)      what a confirmed transaction finishes (its `finishes`)
export function makeFollow({ journal, jobStatus, receipt, receiptOnce, btcConfirmed, live = () => false, own = () => false, onOwn = () => {}, onSlow = () => {}, finished = () => {} }) {
  const going = new Map(), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hidden = () => typeof document !== 'undefined' && document.hidden;
  function job(id) {
    if (own(id)) return onOwn(id);
    if (going.has(id)) return;
    const run = (async () => {
      for (;;) {
        const it = journal.get(id);
        if (!it || ended(it)) return;
        const age = Date.now() - it.at;
        if (age > 86400e3) { journal.put(id, { status: 'unknown', err: 'The relay gave no answer for a day.' }); return; }
        if (it.status === 'pending' && age > 60e3) onSlow(it);
        if (!live(id)) {
          const st = await jobStatus(id.slice(4)).catch(() => null);
          if (st?.status && (st.status !== 'unknown' || age > 120e3)) journal.put(id, { status: st.status, hash: st.txHash || undefined, err: st.error || undefined, ahead: st.ahead ?? undefined });
        }
        await sleep(age < 180e3 ? 5000 : age < 1800e3 ? 15000 : 60000);
      }
    })().finally(() => going.delete(id));
    going.set(id, run);
  }
  function tx(id, once = false) {
    const it = journal.get(id);
    if (going.has(id) || !it || (ended(it) && !once)) return;
    const p = (once ? receiptOnce(it.hash, it.chain) : receipt(it.hash, it.chain)).then((r) => {
      if (r) {
        journal.put(id, r.status === '0x1' ? { status: 'confirmed' } : { status: 'failed', err: 'The transaction reverted.' });
        if (r.status === '0x1') for (const f of it.finishes || []) finished(f, it.hash);
      } else if (!once) journal.put(id, { status: 'stale' });
    }).catch(() => {}).finally(() => going.delete(id));
    going.set(id, p);
  }
  function btc(id) {
    if (going.has(id)) return;
    const run = (async () => {
      for (;;) {
        const it = journal.get(id);
        if (!it || ended(it)) return;
        if (Date.now() - it.at > 3 * 86400e3) { journal.put(id, { status: 'stale' }); return; }
        if (await btcConfirmed(it.hash).catch(() => false)) { journal.put(id, { status: 'confirmed' }); return; }
        await sleep(hidden() ? 120e3 : 30e3);
      }
    })().finally(() => going.delete(id));
    going.set(id, run);
  }
  return { job, tx, btc, going };
}

// The relay's own state, for a job in line: busy, held, paused or down (null when it is taking work). Read at most every 15 s.
//   api             the worker's base URL;   base()  the relay's base URL (the deployment's, else the worker's)
//   uxState()       the pool module's own reading, if it has one;   onChange()  the state changed
// How far along a relayed action is, for its bar and its time left: each part's expected seconds (learned in this browser from the actions
// that went through, seeded with the relay's usual pace) set against the time it has had. A relay job waits its turn (and those ahead of it),
// is proved (on Tacit's own machine, or the prover network), then sent; a transaction lands in about a block. A part past its expected
// time is given a little more, never none, so the bar slows near its end rather than stopping, and it is full only once the action ends.
export const PACE_KEY = 'tacit-pace-v1';
const PACE0 = { queue: 8, 'prove:board': 60, 'prove:network': 100, prove: 70, send: 18, tx: 15 };
const laneOf = (lane) => (/^network/.test(String(lane || '')) ? 'network' : lane === 'board' ? 'board' : null);
export function makePace({ storage = globalThis.localStorage } = {}) {
  let P = { ...PACE0 };
  try { P = { ...PACE0, ...JSON.parse(storage?.getItem(PACE_KEY) || '{}') }; } catch { /* the seeds */ }
  const proveOf = (lane) => P[`prove:${laneOf(lane)}`] ?? P.prove;
  const sum = (stages, now) => {
    let spent = 0, left = 0, live = false;
    for (const [e, start, stop] of stages) {
      if (stop) { spent += Math.max(0, (stop - (start || stop)) / 1000); continue; }
      if (!live && start) { live = true; const ran = Math.max(0, (now - start) / 1000); spent += ran; left += Math.max(e * 0.15, e - ran); continue; }
      left += e;
    }
    return { spent, left };
  };
  // a relay job: { status, at, ts: { [status]: first seen }, lane, ahead }
  function job(it, now = Date.now()) {
    const ts = it.ts || {}, prove = proveOf(it.lane), pAt = ts.proving, sAt = ts.proven || ts.sending || ts.open;
    return sum([[P.queue + (it.ahead > 0 ? it.ahead * prove : 0), it.at, pAt || sAt], [prove, pAt || null, sAt], [P.send, sAt || null, it.end]], now);
  }
  const tx = (it, now = Date.now()) => sum([[P.tx, it.at, it.end]], now);
  // what one more relay job would take, for an action whose main job is not asked for yet
  const ahead = (lane = null) => P.queue + proveOf(lane) + P.send;
  const of = ({ spent, left }) => ({ spent, left, pct: Math.min(97, Math.max(3, Math.round((spent / Math.max(1, spent + left)) * 100))) });
  // a job that went through teaches the pace its parts took
  function learn(it) {
    const ts = it.ts || {}, pAt = ts.proving, sAt = ts.proven || ts.sending || ts.open, put = (k, ms) => { const v = ms / 1000; if (v > 0 && v < 1800) P[k] = Math.round((P[k] ?? v) * 0.7 + v * 0.3); };
    if (it.kind !== 'job' || it.status !== 'settled' || !sAt || !it.end) return;
    if (pAt) { put('queue', pAt - it.at); put(`prove:${laneOf(it.lane) || 'board'}`, sAt - pAt); } else put('prove', sAt - it.at);
    put('send', it.end - sAt);
    try { storage?.setItem(PACE_KEY, JSON.stringify(P)); } catch { /* a convenience */ }
  }
  return { job, tx, ahead, of, learn, get: () => ({ ...P }) };
}

export const WAIT_WHY = {
  held: 'In line. It keeps its place and goes through on its own.',
  paused: 'In line. It keeps its place and goes through on its own.',
  down: 'In line. It keeps its place and goes through on its own.',
  busy: 'In line behind another request.',
};
const RELAY_WHY = { busy: 'busy', held: 'held', paused: 'paused', down: 'down' };
const within = (ms) => (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined);
export function makeRelayState({ api, base = async () => api, uxState = async () => null, onChange = () => {} }) {
  const state = { at: 0, why: null, reading: null };
  async function jobStatus(jobId) {
    const r = await fetch(`${await base()}/confidential/status?id=${encodeURIComponent(jobId)}`, { cache: 'no-store', signal: within(15e3) });
    if (r.status === 404) return { status: 'unknown' };
    if (!r.ok) throw new Error(`relay ${r.status}`);
    return r.json();
  }
  async function read() {
    try {
      const rs = await uxState();
      if (rs) return RELAY_WHY[rs.state ?? rs] ?? null;
    } catch { }
    const r = await fetch(`${api}/confidential/relay`, { cache: 'no-store', signal: within(10e3) });
    if (r.ok) return RELAY_WHY[(await r.json())?.state] ?? null;
    if (r.status !== 404) throw new Error(`relay ${r.status}`);
    const h = await fetch(`${api}/prover-health?network=mainnet`, { cache: 'no-store', signal: within(10e3) }).then((x) => x.json());
    const st = h?.services?.settle, note = String(st?.note || '');
    return !st || Number(st.age_seconds) > 600 ? 'down' : /leaving jobs queued|a page settles itself/i.test(note) ? 'held' : /settle: proving/i.test(note) ? 'busy' : null;
  }
  function now(fresh = false) {
    if (!fresh && Date.now() - state.at < 15e3) return Promise.resolve(state.why);
    if (state.reading) return state.reading;
    const p = state.reading = read().then((why) => {
      const changed = why !== state.why;
      Object.assign(state, { at: Date.now(), why });
      if (changed) onChange();
      return why;
    }, () => { state.at = Date.now(); return null; }).finally(() => { if (state.reading === p) state.reading = null; });
    return p;
  }
  // the last reading, and a fresh one asked for in the background when it is old
  function why() {
    if (Date.now() - state.at < 15e3 || state.reading) return state.why;
    now().catch(() => {});
    return state.why;
  }
  return { state, jobStatus, now, why };
}

// A page other than the front one that sets relay jobs going (the borrow page): each job goes into the shared journal under the name the page
// gives it, moves on as the relay client announces it, and is followed to its end while the page is open; the front page follows it from the
// same journal whenever it is opened. `wait(label)` is what a pool call takes as its waitOpts.
export function makeRunner({ api, base, pub = () => null, btcConfirmed = async () => false }) {
  const journal = makeJournal({ pub, shared: true });
  const relay = makeRelayState({ api, base });
  const follow = makeFollow({ journal, jobStatus: (j) => relay.jobStatus(j), receipt: async () => null, receiptOnce: async () => null, btcConfirmed });
  const named = new Map();
  addEventListener('tacit:job', ({ detail: d }) => {
    if (!d?.jobId || !d.status) return;
    const id = 'job:' + d.jobId;
    journal.put(id, { kind: 'job', type: d.type || null, label: named.get(d.jobId) || JOB_LABEL[d.type] || 'Relayed action', status: d.status, hash: d.txHash || undefined, err: d.error || undefined });
    follow.job(id);
  });
  const wait = (label, timeoutMs = 20 * 60e3) => ({
    timeoutMs, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onJob: (jobId) => { named.set(jobId, label); journal.put('job:' + jobId, { kind: 'job', label, status: 'pending' }); follow.job('job:' + jobId); },
  });
  return { journal, relay, follow, wait };
}
