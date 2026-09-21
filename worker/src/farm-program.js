// GET /farm/program and GET /farm/health: the launch farms' emission schedule and a solvency verdict, read straight from the
// FarmManager on chain. Public and cached, so a dapp or a status page can poll them without an RPC key.
//
// One upstream read serves every caller for a few seconds. When the chain cannot be read the last good answer is served (marked
// stale) for a short grace window and then a plain 503: a dashboard that keeps showing a two-hour-old treasury is worse than
// one that says it cannot tell.
import { makeRpc, readFarmRaw, buildProgram, publicProgram, farmHealth, FARM_MANAGER_MAINNET, FARM_RPCS_MAINNET } from '../../worker-relay/src/lib/farm-health.js';

export const FARM_TTL_MS = 15000;
export const FARM_STALE_MS = 120000;

const cache = new Map(); // network -> { at, value }
const inflight = new Map();

export function _resetFarmCache() { cache.clear(); inflight.clear(); }

async function load(network, env) {
  const manager = env.FARM_MANAGER_ADDR || FARM_MANAGER_MAINNET;
  const raw = await readFarmRaw(makeRpc(FARM_RPCS_MAINNET), manager);
  const program = raw.codeMissing ? raw : buildProgram(raw, { network });
  return { program, health: farmHealth(program), updatedAt: new Date().toISOString() };
}

async function current(network, env) {
  const hit = cache.get(network);
  if (hit && Date.now() - hit.at < FARM_TTL_MS) return { value: hit.value, stale: false };
  let p = inflight.get(network);
  if (!p) {
    p = load(network, env).finally(() => inflight.delete(network));
    inflight.set(network, p);
  }
  try {
    const value = await p;
    cache.set(network, { at: Date.now(), value });
    return { value, stale: false };
  } catch (e) {
    if (hit && Date.now() - hit.at < FARM_STALE_MS) return { value: hit.value, stale: true };
    return { error: e?.message || String(e) };
  }
}

// `json(obj, status, headers)` is the worker's own response helper, passed in so this module stays free of its internals.
export async function handleFarm(kind, url, env, cors, json) {
  const network = url.searchParams.get('network') === 'signet' ? 'signet' : 'mainnet';
  const noStore = { ...cors, 'Cache-Control': 'no-store' };
  if (network !== 'mainnet') return json({ error: 'no farm program on this network' }, 404, noStore);
  const r = await current(network, env);
  const health = kind === 'health';
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
  return json({ ...publicProgram(program), stale: r.stale, updatedAt }, 200, headers);
}
