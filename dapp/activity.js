
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

export const ENDS = { job: ['settled', 'proven', 'failed', 'unknown'], tx: ['confirmed', 'failed', 'stale'], btc: ['confirmed', 'stale'], op: ['settled', 'failed', 'unknown'], chain: ['settled', 'failed', 'unknown'], fast: ['settled', 'failed', 'unknown'] };
export const ended = (it) => ENDS[it.kind]?.includes(it.status) ?? true;

export function readActivity() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(ACT_KEY)); } catch {}
  return { items: [].concat(Array.isArray(v?.items) ? v.items : []).filter((x) => x && typeof x === 'object' && x.id && ENDS[x.kind]).map((x) => (x.kind === 'op' && !Array.isArray(x.steps) ? { ...x, steps: [] } : x)), cleared: Number(v?.cleared) || 0 };
}
export const listed = (items) => items.filter((x) => !x.in);

// The Activity item for a fast bridge record (fastbridge-client.js describe(): the fast route keeps the records in this browser and says where each stands). One for
// each that is under way, or that ended in the last day; a bridge that came back to Bitcoin is a failed one (returned, not done). null for an old ended one.
export function fastItem(r, { fmt = (v) => String(v), now = Date.now() / 1000, pub = null } = {}) {
  if (!r || !r.id || (r.ended && now - r.created > 86400)) return null;
  const status = !r.ended ? 'pending' : r.returned ? 'failed' : 'settled';
  return {
    id: `fast:${r.id}`,
    patch: {
      kind: 'fast', label: `Fast bridge: ${fmt(BigInt(r.amount))} TAC`, status, pub, at: r.created * 1000, fa: r.at, title: r.title, note: r.detail, receive: r.receive,
      lockTxid: r.lockTxid || undefined, err: r.ended && r.returned ? 'The lock came back to your Bitcoin address.' : undefined,
    },
  };
}

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

export function activityCount(items = readActivity().items) {
  const top = listed(items);
  return { total: top.length, live: top.filter((x) => !actDone(x)).length };
}

export function onActivity(fn) {
  const h = (e) => { if (!e.key || e.key === ACT_KEY || e.key.startsWith('tacit-crossout-bridge-v1:')) fn(); };
  addEventListener('storage', h);
  return () => removeEventListener('storage', h);
}

const RANK = { pending: 0, proving: 1, stale: 1, open: 1.5, sending: 1.5, proven: 2, failed: 2, unknown: 2, settled: 3, confirmed: 3 };
export const OPENISH = ['open', 'sending'];
// A proved job ('proven' ranks with 'failed') is the one end that can still turn out dead: its proof was made against a pool that has since moved, so
// sending it reverts. That is a failure, and the row says so rather than offering to send it again.
export const ahead = (next, cur) => next !== cur && (cur == null || cur === 'unknown' || next === 'settled' || next === 'confirmed' || (next === 'failed' && cur === 'proven') || (OPENISH.includes(next) && OPENISH.includes(cur)) || (RANK[next] ?? -1) > (RANK[cur] ?? -1));

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
      (it.ts ||= {})[it.status] ??= it.up;
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

// A wallet's "speed up" and "cancel" send a second transaction at the same nonce, and the first hash never confirms. A
// transaction whose nonce a mined one has taken can never run, so once the sender's nonce has moved past it the transaction
// that took the nonce is found: the same call at a higher fee stands in for it, anything else means it never went in.
export const REPLACED_TEXT = 'It was replaced in your wallet, by a cancel or another transaction, before it was mined.';
// The hash a transaction went in under: what its wallet replaced it with (a speed-up), once that was seen (kept in `map` while the page lives, and
// in the journal's entry for it after a reload), or the hash itself. What goes on to the relay or a record is that one: the first never mined.
export const landedHash = (hash, journal, map) => {
  if (!hash) return hash;
  const k = String(hash).toLowerCase(), it = journal?.get(`tx:1:${k}`);
  return map?.get(k) || (it && it.status === 'confirmed' && it.hash) || hash;
};
export const fingerprint = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0; return `${s.length}:${h.toString(16)}`; };
const hex = (n) => '0x' + n.toString(16);
// One look. `read(method, params)` asks the chain; `seen` is what an earlier look learned of the transaction while it was
// pending: { from, nonce, to, value, data }. Returns { seen } to keep, { found: { hash, same } } once the transaction
// at its nonce is known, or {}.
export async function lookReplaced({ read, hash, seen }) {
  const tx = await read('eth_getTransactionByHash', [hash]).then((x) => x || null, () => undefined);
  if (tx === undefined) return {};
  if (tx) {
    if (tx.blockNumber || seen) return {};
    return { seen: { from: String(tx.from).toLowerCase(), nonce: BigInt(tx.nonce).toString(), to: String(tx.to || '').toLowerCase(), value: BigInt(tx.value || 0).toString(), data: fingerprint(tx.input || '0x') } };
  }
  if (!seen) return {};
  try {
    const nonce = BigInt(seen.nonce), count = (tag) => read('eth_getTransactionCount', [seen.from, tag]).then(BigInt);
    if ((await count('latest')) <= nonce) return {};
    // The block that took the nonce: found from the head back (a node keeps recent state only), then halved.
    const top = Number(await read('eth_blockNumber', []));
    let hi = top, lo = null;
    for (let back = 4; back <= 128; back *= 2) {
      const b = Math.max(0, top - back);
      if ((await count(hex(b))) <= nonce) { lo = b; break; }
      hi = b;
    }
    if (lo == null) return {};
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if ((await count(hex(m))) > nonce) hi = m; else lo = m; }
    const blk = await read('eth_getBlockByNumber', [hex(hi), true]);
    const t = blk?.transactions?.find((x) => String(x.from).toLowerCase() === seen.from && BigInt(x.nonce) === nonce);
    if (!t) return {};
    const same = String(t.hash).toLowerCase() === String(hash).toLowerCase()
      || (String(t.to || '').toLowerCase() === seen.to && BigInt(t.value || 0).toString() === seen.value && fingerprint(t.input || '0x') === seen.data);
    return { found: { hash: t.hash, same } };
  } catch { return {}; }
}

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
    const note = { seen: it.seen, keep: (seen) => journal.put(id, { seen }) };
    const p = (once ? receiptOnce(it.hash, it.chain, note) : receipt(it.hash, it.chain, note)).then((r) => {
      if (r?.replaced) journal.put(id, { status: 'failed', err: REPLACED_TEXT, hash: r.transactionHash, replaced: true });
      else if (r) {
        const hash = r.transactionHash || it.hash;
        journal.put(id, r.status === '0x1' ? { status: 'confirmed', hash } : { status: 'failed', err: 'The transaction reverted.', hash });
        if (r.status === '0x1') for (const f of it.finishes || []) finished(f, hash);
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

export const PACE_KEY = 'tacit-pace-v1';
const PACE0 = { queue: 8, 'prove:board': 60, 'prove:network': 100, prove: 70, send: 18, tx: 15 };
const laneOf = (lane) => (/^network/.test(String(lane || '')) ? 'network' : lane === 'board' ? 'board' : null);
export function makePace({ storage = globalThis.localStorage } = {}) {
  let P = { ...PACE0 };
  try { P = { ...PACE0, ...JSON.parse(storage?.getItem(PACE_KEY) || '{}') }; } catch { }
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
  function job(it, now = Date.now()) {
    const ts = it.ts || {}, prove = proveOf(it.lane), pAt = ts.proving, sAt = ts.proven || ts.sending || ts.open;
    return sum([[P.queue + (it.ahead > 0 ? it.ahead * prove : 0), it.at, pAt || sAt], [prove, pAt || null, sAt], [P.send, sAt || null, it.end]], now);
  }
  const tx = (it, now = Date.now()) => sum([[P.tx, it.at, it.end]], now);
  const ahead = (lane = null) => P.queue + proveOf(lane) + P.send;
  const of = ({ spent, left }) => ({ spent, left, pct: Math.min(97, Math.max(3, Math.round((spent / Math.max(1, spent + left)) * 100))) });
  function learn(it) {
    const ts = it.ts || {}, pAt = ts.proving, sAt = ts.proven || ts.sending || ts.open, put = (k, ms) => { const v = ms / 1000; if (v > 0 && v < 1800) P[k] = Math.round((P[k] ?? v) * 0.7 + v * 0.3); };
    if (it.kind !== 'job' || it.status !== 'settled' || !sAt || !it.end) return;
    if (pAt) { put('queue', pAt - it.at); put(`prove:${laneOf(it.lane) || 'board'}`, sAt - pAt); } else put('prove', sAt - it.at);
    put('send', it.end - sAt);
    try { storage?.setItem(PACE_KEY, JSON.stringify(P)); } catch { }
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
export function makeRelayState({ api, base = async () => api, others = async () => [], uxState = async () => null, onChange = () => {} }) {
  const state = { at: 0, why: null, reading: null };
  async function jobStatus(jobId) {
    const s = String(jobId), i = s.lastIndexOf('@'), at = i > 0 ? s.slice(i + 1) : '', theirs = !!at && (await others()).includes(at);
    const r = await fetch(`${theirs ? at : await base()}/confidential/status?id=${encodeURIComponent(theirs ? s.slice(0, i) : s)}`, { cache: 'no-store', signal: within(15e3) });
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
  function why() {
    if (Date.now() - state.at < 15e3 || state.reading) return state.why;
    now().catch(() => {});
    return state.why;
  }
  return { state, jobStatus, now, why };
}

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
