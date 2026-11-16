// GET /farm/program and GET /farm/health: the launch farms' emission schedule and a solvency verdict, read straight from the
// FarmManager on chain. Public and cached, so a dapp or a status page can poll them without an RPC key.
//
// One upstream read serves every caller. An answer past its few seconds is still served at once (up to two minutes old) while the next is read
// behind it, and the next is read ahead of time while callers keep asking, so nobody waits for the chain. When the chain cannot be read the last
// good answer is served (marked stale) until it is two minutes old and then a plain 503: a dashboard that keeps showing a two-hour-old treasury is
// worse than one that says it cannot tell.
import { makeRpc, readFarmRaw, buildProgram, publicProgram, farmHealth, FARM_MANAGER_MAINNET, FARM_RPCS_MAINNET } from '../../worker-relay/src/lib/farm-health.js';
import { sampleOf, foldSample, summaries, historyPlan, applyHistory, noteFailed, scrub } from '../../worker-relay/src/lib/pool-activity.js';
import { stateReader, changesBetween, makeGate, makeArchiveRpc, ARCHIVE_RPCS_MAINNET } from '../../worker-relay/src/lib/pool-history.js';

const FARM_POOL_MAINNET = '0x000000000Ed1eabD231Be41d93b719056F7febFC';      // the confidential pool (the manager names it too: a read of the program carries it as `pool`)

export const FARM_TTL_MS = 15000;     // an answer this young is served as it is
export const FARM_STALE_MS = 120000;   // one this old is the last good answer: served at once while the next is read behind it, and marked stale if that read fails
export const FARM_WARM_MS = 45000;     // while callers are asking, the next answer is read this often, so none of them waits for the chain (a slow node cost one 26 s)
export const FARM_IDLE_MS = 600000;    // and the reading stops when nobody has asked for this long

const cache = new Map(); // network -> { at, value, failed }
const inflight = new Map();
const warmers = new Map(); // network -> { timer, asked }
let loader = load;

export function _resetFarmCache() { cache.clear(); inflight.clear(); for (const w of warmers.values()) clearInterval(w.timer); warmers.clear(); loader = load; }
export function _setFarmLoader(fn) { loader = fn; }

async function load(network, env) {
  const manager = env.FARM_MANAGER_ADDR || FARM_MANAGER_MAINNET;
  const raw = await readFarmRaw(makeRpc(FARM_RPCS_MAINNET), manager);
  const program = raw.codeMissing ? raw : buildProgram(raw, { network });
  return { program, health: farmHealth(program), updatedAt: new Date().toISOString(), pool: raw.pool };
}

// One read at a time per network, shared by everyone who asks while it runs.
function refresh(network, env) {
  let p = inflight.get(network);
  if (!p) {
    p = loader(network, env).then((value) => { cache.set(network, { at: Date.now(), value }); return value; }).finally(() => inflight.delete(network));
    inflight.set(network, p);
  }
  return p;
}

// While the page is being asked for, read the next answer before the last one runs out. Stops itself when the asking stops.
function keepWarm(network, env) {
  let w = warmers.get(network);
  if (w) { w.asked = Date.now(); return; }
  if (typeof setInterval !== 'function') return;
  const warmMs = Number(env?.FARM_WARM_MS) || FARM_WARM_MS, idleMs = Number(env?.FARM_IDLE_MS) || FARM_IDLE_MS;   // settable, so a deployment (or a test) can set the cadence
  w = { asked: Date.now(), timer: null };
  w.timer = setInterval(() => {
    if (Date.now() - w.asked > idleMs) { clearInterval(w.timer); if (warmers.get(network) === w) warmers.delete(network); return; }
    const hit = cache.get(network);
    if (!hit || Date.now() - hit.at >= warmMs * 0.9) refresh(network, env).catch(() => {});
  }, warmMs);
  w.timer?.unref?.();
  warmers.set(network, w);
}

// `swr`: serve an answer past its few seconds at once and read the next behind it (the dapp's /farm/program). /farm/health does not: a verdict on the
// farm's solvency waits for a fresh read and fails closed when there is none.
async function current(network, env, swr) {
  keepWarm(network, env);
  const hit = cache.get(network), age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < FARM_TTL_MS) return { value: hit.value, stale: false };
  if (swr && hit && age < FARM_STALE_MS) {
    // A good answer is in hand: it is served now and the next is read behind it. If that read fails the answer is marked stale until one succeeds.
    refresh(network, env).catch(() => { hit.failed = true; });
    return { value: hit.value, stale: !!hit.failed };
  }
  try { return { value: await refresh(network, env), stale: false }; }
  catch (e) {
    if (hit && Date.now() - hit.at < FARM_STALE_MS) return { value: hit.value, stale: true };
    return { error: e?.message || String(e) };
  }
}

// `json(obj, status, headers)` is the worker's own response helper, passed in so this module stays free of its internals.
export async function handleFarm(kind, url, env, cors, json) {
  const network = url.searchParams.get('network') === 'signet' ? 'signet' : 'mainnet';
  const noStore = { ...cors, 'Cache-Control': 'no-store' };
  if (network !== 'mainnet') return json({ error: 'no farm program on this network' }, 404, noStore);
  const health = kind === 'health';
  const r = await current(network, env, !health);
  if (r.error) {
    const body = health
      ? { status: 'critical', checks: [{ name: 'rpc', status: 'critical', detail: `farm state unreadable: ${r.error}` }] }
      : { error: 'farm program unavailable', detail: r.error };
    return json(body, 503, { ...noStore, 'Retry-After': '15' });
  }
  const { program, health: h, updatedAt } = r.value;
  const headers = { ...cors, 'Cache-Control': 'public, max-age=15', ...(r.stale ? { 'X-Farm-Stale': '1' } : {}) };
  if (health) return json({ ...h, stale: r.stale, updatedAt }, 200, headers);
  if (program.codeMissing) return json({ error: 'farm program unavailable', detail: `no contract code at ${program.manager}` }, 503, noStore);
  const body = publicProgram(program), by = await activitySummaries(env).catch(() => null);
  // each pool carries how often its state has changed, when the tick has a record of it (a pool with none is as it was before)
  if (by) body.pools = (body.pools || []).map((p) => { const a = by[String(p.poolId).toLowerCase()]; return a ? { ...p, activity: a } : p; });
  return json({ ...body, stale: r.stale, updatedAt }, 200, headers);
}

// How often each pool's state changes (worker-relay/src/lib/pool-activity.js). The 5-minute tick reads the program afresh and folds what it says of each pool into a log in the
// shared store, so the record is the same across restarts and across the services that run this; the program's answer then carries each pool's summary. A deposit is proved against a
// pool's exact state and any change while it is proved ends that proof, so a page can say how likely that is from this, which it cannot read from the chain itself without old blocks.
const ACT_KEY = 'farm:activity:v1', ACT_LEASE = 'farm:activity:lease', ACT_READ_MS = 60000;
let act = { at: 0, by: null, reading: null };
const actStore = (env) => env?.CONFIDENTIAL_KV || env?.REGISTRY_KV || null;
export function _resetFarmActivity() { act = { at: 0, by: null, reading: null }; }

// The summaries, read from the store at most once a minute by a process, and the last read kept if the store cannot be reached.
async function activitySummaries(env) {
  const kv = actStore(env);
  if (!kv || env.FARM_ACTIVITY === '0') return null;
  if (act.by && Date.now() - act.at < ACT_READ_MS) return act.by;
  act.reading ||= Promise.resolve(kv.get(ACT_KEY))
    .then((raw) => { act.by = raw ? summaries(raw) : {}; act.at = Date.now(); return act.by; }, () => act.by)
    .finally(() => { act.reading = null; });
  return act.reading;
}

// One tick: the program read afresh (it serves whoever is asking too), one reading folded into the log. One service does it per tick (a lease in the shared store, a little under
// the tick), so two services running this do not write over each other. Returns the log it wrote, or null when it did nothing.
// What the log has not seen is read from old blocks (worker-relay/src/lib/pool-history.js): a record that starts empty, or has a gap in it, or is shorter than a day, is filled in from the
// chain, so the hour and day counts are whole from the first tick after a start and not a day later. `history` is for a test: `stateAt(poolId)` in place of the archive nodes.
export async function farmActivityTick(env, now = () => Date.now(), history = {}) {
  const kv = actStore(env);
  if (!kv || env.FARM_ACTIVITY === '0') return null;
  if (await kv.get(ACT_LEASE)) return null;
  await kv.put(ACT_LEASE, String(now()), { expirationTtl: 240 });
  const value = await refresh('mainnet', env), { program } = value;
  if (!program || program.codeMissing) return null;
  const pub = publicProgram(program), t = now(), head = Number(pub.block) || 0, sample = sampleOf(pub), before = await kv.get(ACT_KEY);
  let log = foldSample(before, sample, { t, block: head });
  if (env.FARM_ACTIVITY_BACKFILL !== '0') log = await fillFromHistory(env, { before, log, sample, t, head, pool: value.pool }, history);
  await kv.put(ACT_KEY, JSON.stringify(log), { expirationTtl: 7 * 86400 });
  act = { at: now(), by: summaries(log), reading: null };
  return log;
}

// Each pool that needs old blocks is searched for its changes (a few reads at once across all of them, and no longer than HISTORY_MS in all). A pool whose search fails (a node that does
// not serve old state, the reads over their budget, the time up) keeps its record as it was, marked so that it is tried again in half an hour and not at the next tick.
const HISTORY_MS = 100_000;
let archive = { key: '', rpc: null };
function archiveRpc(env) {
  const named = String(env.FARM_ARCHIVE_RPCS || '').split(',').map((x) => x.trim()).filter(Boolean), urls = named.length ? named : ARCHIVE_RPCS_MAINNET, key = urls.join(',');
  if (archive.key !== key) archive = { key, rpc: makeArchiveRpc(urls) };      // kept between ticks: a node that limited one tick is still resting at the next
  return archive.rpc;
}
async function fillFromHistory(env, { before, log, sample, t, head, pool }, { stateAt = null, deadlineMs = HISTORY_MS } = {}) {
  const plans = historyPlan(before, sample, { t, head });
  if (!plans.length) return log;
  const rpc = stateAt ? null : archiveRpc(env), addr = pool || env.POOL_ADDR || FARM_POOL_MAINNET;
  const gate = makeGate(3), deadline = Date.now() + deadlineMs;
  const got = await Promise.allSettled(plans.map((plan) => changesBetween({
    stateAt: stateAt ? stateAt(plan.poolId) : stateReader(rpc, addr, plan.poolId), from: plan.from, to: plan.to, fromState: plan.fromState, toState: plan.toState, gate, deadline,
  })));
  let out = log;
  plans.forEach((plan, i) => {
    if (got[i].status === 'fulfilled') out = applyHistory(before, out, plan, got[i].value, { t, head });
    else { out = noteFailed(out, plan, { t, err: got[i].reason }); console.warn(`[farm-activity] old blocks for ${plan.poolId.slice(0, 10)} (${plan.mode}) not read: ${scrub(got[i].reason)}`); }
  });
  return out;
}
